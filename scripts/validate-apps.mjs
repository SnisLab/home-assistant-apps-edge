import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadataFile = path.join(root, ".generated-apps.json");
const requiredFields = ["name", "version", "slug", "description"];
const snisLabImagePattern = /^ghcr\.io\/snislab\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;

function parseYaml(contents, filename) {
  const document = YAML.parseDocument(contents, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`${filename}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  return document.toJS();
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

const repositoryConfig = parseYaml(
  await readFile(path.join(root, "repository.yaml"), "utf8"),
  "repository.yaml",
);
if (typeof repositoryConfig?.name !== "string" || !repositoryConfig.name.trim()) {
  throw new Error("repository.yaml: name must be a non-empty string.");
}

for (const filename of [
  path.join(".github", "dependabot.yml"),
  path.join(".github", "workflows", "lint.yml"),
  path.join(".github", "workflows", "sync-apps.yml"),
]) {
  parseYaml(await readFile(path.join(root, filename), "utf8"), filename);
}

const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
if (!metadata?.apps || typeof metadata.apps !== "object" || Array.isArray(metadata.apps)) {
  throw new Error(".generated-apps.json must contain an apps object.");
}

const directories = Object.keys(metadata.apps);
if ([...directories].sort().join("\n") !== directories.join("\n")) {
  throw new Error(".generated-apps.json app entries must be sorted.");
}

const rootEntries = await readdir(root, { withFileTypes: true });
const discoveredConfigs = [];
for (const entry of rootEntries) {
  if (
    entry.isDirectory() &&
    !entry.name.startsWith(".") &&
    !["node_modules", "scripts", "test"].includes(entry.name)
  ) {
    for (const config of await findAppConfigs(path.join(root, entry.name), entry.name)) {
      discoveredConfigs.push(config);
    }
  }
}
const expectedConfigs = Object.keys(metadata.apps).map((directory) => path.join(directory, "config.yaml"));
if (discoveredConfigs.sort().join("\n") !== expectedConfigs.sort().join("\n")) {
  throw new Error("Discoverable app configurations do not match .generated-apps.json.");
}

const slugs = new Map();
for (const directory of directories) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(directory)) {
    throw new Error(`Unsafe generated app directory: ${directory}`);
  }

  const source = metadata.apps[directory];
  if (source.repository !== `app-${directory}`) {
    throw new Error(`${directory}: source repository must be app-${directory}.`);
  }
  if (!/^[a-f0-9]{40}$/i.test(source.sha)) {
    throw new Error(`${directory}: source SHA must be a full commit SHA.`);
  }
  if (typeof source.tag !== "string" || !source.tag) {
    throw new Error(`${directory}: source tag must be recorded.`);
  }

  const appRoot = path.join(root, directory);
  const configFilename = path.join(directory, "config.yaml");
  const appConfigs = await findAppConfigs(appRoot);
  if (appConfigs.length !== 1 || appConfigs[0] !== "config.yaml") {
    throw new Error(`${directory}: exactly one discoverable app configuration at config.yaml is required.`);
  }
  const config = parseYaml(await readFile(path.join(appRoot, "config.yaml"), "utf8"), configFilename);

  for (const field of requiredFields) {
    if (typeof config?.[field] !== "string" || !config[field].trim()) {
      throw new Error(`${configFilename}: ${field} must be a non-empty string.`);
    }
  }
  if (config.version !== source.version) {
    throw new Error(`${configFilename}: version does not match .generated-apps.json.`);
  }
  if (source.tag !== "edge" && ![config.version, `v${config.version}`].includes(source.tag)) {
    throw new Error(`${configFilename}: version does not match the source tag.`);
  }
  if (!Array.isArray(config.arch) || config.arch.length === 0 || config.arch.some((arch) => typeof arch !== "string")) {
    throw new Error(`${configFilename}: arch must be a non-empty string array.`);
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(config.slug)) {
    throw new Error(`${configFilename}: slug must be URI-friendly.`);
  }
  if (slugs.has(config.slug)) {
    throw new Error(`${configFilename}: slug duplicates ${slugs.get(config.slug)}.`);
  }
  slugs.set(config.slug, configFilename);

  if (config.image !== undefined) {
    if (typeof config.image !== "string" || !config.image.trim()) {
      throw new Error(`${configFilename}: image must be a non-empty string.`);
    }
    if (!snisLabImagePattern.test(config.image)) {
      throw new Error(`${configFilename}: image must be tagless, lowercase and below ghcr.io/snislab/.`);
    }
    const expectedImageTag = source.tag === "edge" ? "edge" : config.version;
    if (source.image !== `${config.image}:${expectedImageTag}`) {
      throw new Error(`${configFilename}: generated image metadata does not match image and version.`);
    }
  } else {
    const files = await readdir(appRoot);
    const hasGenericDockerfile = files.includes("Dockerfile");
    const hasArchitectureDockerfiles = config.arch.every((arch) => files.includes(`Dockerfile.${arch}`));
    if (!hasGenericDockerfile && !hasArchitectureDockerfiles) {
      throw new Error(`${configFilename}: add image, Dockerfile, or one Dockerfile per architecture.`);
    }
  }
}

console.log(`Validated repository metadata and ${directories.length} app(s).`);
