import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test, { after } from "node:test";

const execute = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = "0123456789abcdef0123456789abcdef01234567";
let archive;

const repository = {
  name: "app-example",
  full_name: "SnisLab/app-example",
  archived: false,
  disabled: false,
};

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  response.setHeader("Content-Type", "application/json");

  if (url.pathname === "/orgs/SnisLab/repos") {
    response.end(JSON.stringify([repository]));
  } else if (url.pathname === "/repos/SnisLab/app-example") {
    response.end(JSON.stringify(repository));
  } else if (url.pathname === "/repos/SnisLab/app-example/releases/latest") {
    response.end(JSON.stringify({ tag_name: "v1.0.0" }));
  } else if (url.pathname === "/repos/SnisLab/app-example/commits/v1.0.0") {
    response.end(JSON.stringify({ sha }));
  } else if (url.pathname === `/repos/SnisLab/app-example/commits/${sha}`) {
    response.end(JSON.stringify({ sha }));
  } else if (url.pathname === "/repos/SnisLab/app-example/commits/v2.0.0") {
    response.end(JSON.stringify({ sha: "ffffffffffffffffffffffffffffffffffffffff" }));
  } else if (url.pathname === `/repos/SnisLab/app-example/tarball/${sha}`) {
    response.setHeader("Content-Type", "application/gzip");
    response.end(archive);
  } else {
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "Not found" }));
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise((resolve) => server.close(resolve)));

async function createArchive({ nestedConfig = false } = {}) {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "ha-app-fixture-"));
  const sourceRoot = path.join(fixtureRoot, "SnisLab-app-example-source");
  await mkdir(path.join(sourceRoot, ".github"), { recursive: true });
  await writeFile(
    path.join(sourceRoot, "config.yaml"),
    [
      'name: "Example"',
      'version: "1.0.0"',
      'slug: "snislab_example"',
      'description: "Example app"',
      "arch:",
      "  - amd64",
      'image: "ghcr.io/snislab/example"',
      "",
    ].join("\n"),
  );
  await writeFile(path.join(sourceRoot, ".github", "ignored.txt"), "ignored\n");
  if (nestedConfig) {
    await mkdir(path.join(sourceRoot, "test"));
    await writeFile(path.join(sourceRoot, "test", "config.yaml"), "name: nested\n");
  }

  const archivePath = path.join(fixtureRoot, "source.tar.gz");
  await execute("tar", ["-czf", archivePath, "-C", fixtureRoot, path.basename(sourceRoot)]);
  const result = await readFile(archivePath);
  await rm(fixtureRoot, { recursive: true, force: true });
  return result;
}

async function createCatalog(metadata = { apps: {} }) {
  const catalog = await mkdtemp(path.join(projectRoot, ".test-tmp-"));
  await mkdir(path.join(catalog, "scripts"));
  await cp(path.join(projectRoot, "scripts", "sync-apps.mjs"), path.join(catalog, "scripts", "sync-apps.mjs"));
  await writeFile(path.join(catalog, ".generated-apps.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return catalog;
}

async function runSync(catalog, event) {
  const environment = {
    ...process.env,
    APP_ORG: "SnisLab",
    APP_CHANNEL: "edge",
    GITHUB_API_URL: apiUrl,
    GITHUB_EVENT_NAME: event ? "repository_dispatch" : "workflow_dispatch",
  };
  if (event) {
    const eventPath = path.join(catalog, "event.json");
    await writeFile(eventPath, JSON.stringify({ client_payload: event }));
    environment.GITHUB_EVENT_PATH = eventPath;
  }
  return execute(process.execPath, [path.join(catalog, "scripts", "sync-apps.mjs")], {
    cwd: catalog,
    env: environment,
  });
}

test("imports a dispatched app release from the repository root", async () => {
  archive = await createArchive();
  const catalog = await createCatalog();
  try {
    await runSync(catalog, {
      repository: "app-example",
      version: "1.0.0",
      tag: "edge",
      sha,
      image: "ghcr.io/snislab/example:edge",
    });

    assert.match(await readFile(path.join(catalog, "example", "config.yaml"), "utf8"), /slug: "snislab_example"/);
    await assert.rejects(readFile(path.join(catalog, "example", ".github", "ignored.txt")), /ENOENT/);
    const metadata = JSON.parse(await readFile(path.join(catalog, ".generated-apps.json"), "utf8"));
    assert.equal(metadata.apps.example.repository, "app-example");
    assert.equal(metadata.apps.example.sha, sha);
  } finally {
    await rm(catalog, { recursive: true, force: true });
  }
});

test("imports an edge app dispatch with the edge image tag", async () => {
  archive = await createArchive();
  const catalog = await createCatalog();
  try {
    await runSync(catalog, {
      repository: "app-example",
      version: "1.0.0",
      tag: "edge",
      sha,
      image: "ghcr.io/snislab/example:edge",
    });

    const metadata = JSON.parse(await readFile(path.join(catalog, ".generated-apps.json"), "utf8"));
    assert.equal(metadata.apps.example.tag, "edge");
    assert.equal(metadata.apps.example.image, "ghcr.io/snislab/example:edge");
  } finally {
    await rm(catalog, { recursive: true, force: true });
  }
});

test("does not bootstrap apps from stable releases", async () => {
  archive = await createArchive();
  const catalog = await createCatalog();
  try {
    await runSync(catalog);
    assert.deepEqual(JSON.parse(await readFile(path.join(catalog, ".generated-apps.json"))), { apps: {} });
  } finally {
    await rm(catalog, { recursive: true, force: true });
  }
});

test("rejects nested app configurations", async () => {
  archive = await createArchive({ nestedConfig: true });
  const catalog = await createCatalog();
  try {
    await assert.rejects(
      runSync(catalog, {
        repository: "app-example",
        version: "1.0.0",
        tag: "edge",
        sha,
        image: "ghcr.io/snislab/example:edge",
      }),
      /exactly one discoverable app configuration/,
    );
  } finally {
    await rm(catalog, { recursive: true, force: true });
  }
});

test("rejects a dispatch whose tag does not resolve to its SHA", async () => {
  archive = await createArchive();
  const catalog = await createCatalog();
  try {
    await assert.rejects(
      runSync(catalog, {
        repository: "app-example",
        version: "1.0.0",
        tag: "edge",
        sha: "ffffffffffffffffffffffffffffffffffffffff",
        image: "ghcr.io/snislab/example:edge",
      }),
      /GitHub request failed \(404\)/,
    );
  } finally {
    await rm(catalog, { recursive: true, force: true });
  }
});

test("rejects a dispatch image that differs from config and version", async () => {
  archive = await createArchive();
  const catalog = await createCatalog();
  try {
    await assert.rejects(
      runSync(catalog, {
        repository: "app-example",
        version: "1.0.0",
        tag: "edge",
        sha,
        image: "ghcr.io/snislab/other:edge",
      }),
      /does not match ghcr.io\/snislab\/example:edge/,
    );
  } finally {
    await rm(catalog, { recursive: true, force: true });
  }
});

test("rejects unsafe generated metadata before synchronization", async () => {
  const catalog = await createCatalog({
    apps: {
      "../outside": {
        repository: "app-outside",
      },
    },
  });
  try {
    await assert.rejects(runSync(catalog), /Unsafe generated app directory/);
  } finally {
    await rm(catalog, { recursive: true, force: true });
  }
});
