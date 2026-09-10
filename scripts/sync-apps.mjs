import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import YAML from "yaml";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const organization = process.env.APP_ORG ?? process.env.GITHUB_REPOSITORY_OWNER ?? "SnisLab";
const repositoryPrefix = process.env.APP_REPOSITORY_PREFIX ?? "app-";
const apiUrl = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const edgeChannel = process.env.APP_CHANNEL === "edge";
const metadataFile = path.join(root, ".generated-apps.json");
const snisLabImagePattern = /^ghcr\.io\/snislab\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "SnisLab-home-assistant-apps-sync",
};

if (token) {
  headers.Authorization = `Bearer ${token}`;
}

async function githubFetch(endpoint, { allowNotFound = false } = {}) {
  const response = await fetch(`${apiUrl}${endpoint}`, { headers });
  if (allowNotFound && response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status}): ${endpoint}`);
  }
  return response;
}

async function pathExists(filename) {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function sourceName(value) {
  const rawName = String(value ?? "");
  const ownerPrefix = `${organization}/`;
  const name = rawName.startsWith(ownerPrefix) ? rawName.slice(ownerPrefix.length) : rawName;
  if (!name.startsWith(repositoryPrefix) || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid source repository: ${value}`);
  }
  return name;
}

function targetName(repositoryName) {
  const target = repositoryName.slice(repositoryPrefix.length);
  assertTargetName(target);
  return target;
}

function assertTargetName(target) {
  if (!target || !/^[a-z0-9][a-z0-9._-]*$/.test(target)) {
    throw new Error(`Unsafe generated app directory: ${target}`);
  }
  if (path.dirname(path.resolve(root, target)) !== root) {
    throw new Error(`Generated app directory escapes the repository: ${target}`);
  }
}

async function readMetadata() {
  try {
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    if (!metadata?.apps || typeof metadata.apps !== "object" || Array.isArray(metadata.apps)) {
      throw new Error(".generated-apps.json must contain an apps object.");
    }
    for (const [target, source] of Object.entries(metadata.apps)) {
      assertTargetName(target);
      if (source?.repository !== `${repositoryPrefix}${target}`) {
        throw new Error(`${target}: invalid source repository in .generated-apps.json.`);
      }
    }
    return metadata;
  } catch (error) {
    if (error.code === "ENOENT") {
      return { apps: {} };
    }
    throw error;
  }
}

async function findRepositories() {
  const repositories = [];

  for (let page = 1; ; page += 1) {
    const parameters = new URLSearchParams({ type: "all", per_page: "100", page: String(page) });
    const batch = await (await githubFetch(`/orgs/${organization}/repos?${parameters}`)).json();
    repositories.push(
      ...batch.filter(
        (repository) =>
          repository.name.startsWith(repositoryPrefix) &&
          !repository.archived &&
          !repository.disabled,
      ),
    );

    if (batch.length < 100) {
      break;
    }
  }

  return repositories.sort((left, right) => left.name.localeCompare(right.name));
}

async function resolveRef(repositoryName, ref) {
  const endpoint = `/repos/${organization}/${repositoryName}/commits/${encodeURIComponent(ref)}`;
  return (await (await githubFetch(endpoint)).json()).sha;
}

async function latestRelease(repository) {
  const response = await githubFetch(`/repos/${organization}/${repository.name}/releases/latest`, {
    allowNotFound: true,
  });
  if (!response) {
    console.log(`Skipping ${repository.full_name}: no published release found.`);
    return undefined;
  }

  const release = await response.json();
  return {
    repository,
    sha: await resolveRef(repository.name, release.tag_name),
    version: null,
    tag: release.tag_name,
    image: null,
  };
}

async function findAppConfigs(directory, relative = "") {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || (entry.isDirectory() && entry.name === "rootfs")) {
      continue;
    }
    const entryRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await findAppConfigs(path.join(directory, entry.name), entryRelative)));
    } else if (/^config\.(?:json|ya?ml)$/.test(entry.name)) {
      matches.push(entryRelative);
    }
  }
  return matches;
}

async function dispatchedApp() {
  if (process.env.GITHUB_EVENT_NAME !== "repository_dispatch") {
    return undefined;
  }
  if (!process.env.GITHUB_EVENT_PATH) {
    throw new Error("GITHUB_EVENT_PATH is required for repository_dispatch.");
  }

  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const payload = event.client_payload ?? {};
  const repositoryName = sourceName(payload.repository);
  const sha = String(payload.sha ?? "");
  const version = String(payload.version ?? "");
  const tag = String(payload.tag ?? "");

  if (!/^[a-f0-9]{40}$/i.test(sha)) {
    throw new Error("client_payload.sha must be a full commit SHA.");
  }
  if (!version || !tag) {
    throw new Error("client_payload.version and client_payload.tag are required.");
  }
  if (edgeChannel && tag !== "edge") {
    throw new Error("The edge catalog only accepts dispatches with tag edge.");
  }

  const repository = await (await githubFetch(`/repos/${organization}/${repositoryName}`)).json();
  if (repository.archived || repository.disabled) {
    throw new Error(`${repository.full_name} is not an active source repository.`);
  }
  const tagSha = await resolveRef(repositoryName, tag);
  if (tagSha !== sha) {
    throw new Error(`client_payload.tag ${tag} does not resolve to client_payload.sha.`);
  }

  return {
    repository,
    sha,
    version,
    tag,
    image: payload.image ? String(payload.image) : null,
  };
}

async function prepareApp(source, temporaryRoot) {
  const repositoryName = sourceName(source.repository.name);
  const target = targetName(repositoryName);
  const archivePath = path.join(temporaryRoot, `${repositoryName}.tar.gz`);
  const extractionPath = path.join(temporaryRoot, `${repositoryName}-source`);
  const destination = path.join(temporaryRoot, "staging", target);
  const endpoint = `/repos/${organization}/${repositoryName}/tarball/${encodeURIComponent(source.sha)}`;
  const archive = Buffer.from(await (await githubFetch(endpoint)).arrayBuffer());

  await writeFile(archivePath, archive);
  await mkdir(extractionPath);
  await execute("tar", ["-xzf", archivePath, "-C", extractionPath]);

  const archiveEntries = await readdir(extractionPath, { withFileTypes: true });
  const archiveRootEntry = archiveEntries.find((entry) => entry.isDirectory());
  if (!archiveRootEntry) {
    throw new Error(`Downloaded archive for ${source.repository.full_name} is empty.`);
  }

  const archiveRoot = path.join(extractionPath, archiveRootEntry.name);
  const configPath = path.join(archiveRoot, "config.yaml");
  const appConfigs = await findAppConfigs(archiveRoot);
  if (appConfigs.length !== 1 || appConfigs[0] !== "config.yaml") {
    throw new Error(
      `${source.repository.full_name} must contain exactly one discoverable app configuration at config.yaml.`,
    );
  }
  let config;
  try {
    config = YAML.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`${source.repository.full_name} must contain a valid config.yaml in its root: ${error.message}`);
  }

  if (source.version && config.version !== source.version) {
    throw new Error(
      `${source.repository.full_name} config version ${config.version} does not match dispatch version ${source.version}.`,
    );
  }
  if (source.tag && source.tag !== "edge" && ![config.version, `v${config.version}`].includes(source.tag)) {
    throw new Error(`${source.repository.full_name} tag ${source.tag} does not match version ${config.version}.`);
  }
  if (config.image && !snisLabImagePattern.test(config.image)) {
    throw new Error(`${source.repository.full_name} must use a tagless lowercase image below ghcr.io/snislab/.`);
  }
  if (source.image) {
    const imageTag = source.tag === "edge" ? "edge" : config.version;
    const expectedImage = `${config.image}:${imageTag}`;
    if (source.image !== expectedImage) {
      throw new Error(
        `${source.repository.full_name} dispatch image ${source.image} does not match ${expectedImage}.`,
      );
    }
  }

  await cp(archiveRoot, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (filename) => {
      const firstSegment = path.relative(archiveRoot, filename).split(path.sep)[0];
      return firstSegment !== ".git" && firstSegment !== ".github";
    },
  });
  await rm(path.join(destination, ".git"), { recursive: true, force: true });
  await rm(path.join(destination, ".github"), { recursive: true, force: true });

  return {
    target,
    metadata: {
      repository: repositoryName,
      sha: source.sha,
      version: config.version,
      tag: source.tag ?? null,
      image: source.image ?? (config.image ? `${config.image}:${config.version}` : null),
    },
  };
}

async function replaceApp(prepared, currentMetadata, temporaryRoot) {
  const destination = path.join(root, prepared.target);
  if (!Object.hasOwn(currentMetadata.apps, prepared.target) && (await pathExists(destination))) {
    throw new Error(`Refusing to overwrite untracked directory ${prepared.target}.`);
  }

  await rm(destination, { recursive: true, force: true });
  await cp(path.join(temporaryRoot, "staging", prepared.target), destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ha-app-sync-"));

try {
  await mkdir(path.join(temporaryRoot, "staging"));
  const currentMetadata = await readMetadata();
  const dispatched = await dispatchedApp();

  if (dispatched) {
    const prepared = await prepareApp(dispatched, temporaryRoot);
    await replaceApp(prepared, currentMetadata, temporaryRoot);
    currentMetadata.apps[prepared.target] = prepared.metadata;
  } else if (edgeChannel) {
    console.log("The edge catalog is updated by edge repository_dispatch events.");
  } else {
    const repositories = await findRepositories();
    const preparedApps = [];

    for (const repository of repositories) {
      const target = targetName(sourceName(repository.name));
      if (Object.hasOwn(currentMetadata.apps, target)) {
        continue;
      }
      const release = await latestRelease(repository);
      if (release) {
        preparedApps.push(await prepareApp(release, temporaryRoot));
      }
    }

    for (const prepared of preparedApps) {
      await replaceApp(prepared, currentMetadata, temporaryRoot);
      currentMetadata.apps[prepared.target] = prepared.metadata;
    }
  }

  currentMetadata.apps = Object.fromEntries(
    Object.entries(currentMetadata.apps).sort(([left], [right]) => left.localeCompare(right)),
  );
  await writeFile(metadataFile, `${JSON.stringify(currentMetadata, null, 2)}\n`, "utf8");

  console.log(`Synchronized ${dispatched ? 1 : Object.keys(currentMetadata.apps).length} Home Assistant app(s).`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
