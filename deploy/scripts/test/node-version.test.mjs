import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const nodeVersion = "24.22.1";
const nodeRange = "^24.22.1 || >=26.12.1";
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("the test runtime meets the October 2026 Node security floor", () => {
  assert.match(process.versions.node, /^\d+\.\d+\.\d+$/);
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  const supported24 = major === 24 && (minor > 22 || (minor === 22 && patch >= 1));
  const supported26Plus = major > 26
    || (major === 26 && (minor > 12 || (minor === 12 && patch >= 1)));
  assert.ok(supported24 || supported26Plus,
    `Node ${process.versions.node} is below the security baseline; use ${nodeRange}`);
});

test("workspace manifests and the lockfile require patched Node releases", () => {
  const lock = JSON.parse(read("package-lock.json"));
  for (const workspace of ["", "packages/app", "packages/sdk", "packages/horizon-store"]) {
    const manifest = JSON.parse(read(`${workspace ? `${workspace}/` : ""}package.json`));
    assert.equal(manifest.engines.node, nodeRange, workspace || "root");
    assert.equal(lock.packages[workspace].engines.node, nodeRange, `${workspace || "root"} lockfile`);
  }
});

test("every setup-node step pins the patched LTS instead of a cached major", () => {
  let checked = 0;
  for (const file of readdirSync(new URL(".github/workflows/", root))) {
    if (!/\.ya?ml$/.test(file)) continue;
    const source = read(`.github/workflows/${file}`);
    const setups = [...source.matchAll(/^\s*-?\s*uses:\s*actions\/setup-node@/gm)];
    if (!setups.length) continue;
    const versions = [...source.matchAll(/^\s*node-version:\s*["']?([^\s"']+)["']?\s*$/gm)];
    assert.equal(versions.length, setups.length, `${file}: every setup needs an explicit version`);
    for (const [, version] of versions) {
      assert.equal(version, nodeVersion, file);
      checked++;
    }
  }
  assert.ok(checked > 0, "expected setup-node steps");
});

test("all Node image stages pin the patched Trixie runtime", () => {
  const expectedStages = {
    "Dockerfile.worker": 2,
    "Dockerfile.portal": 2,
    "Dockerfile.starter": 1,
    "Dockerfile.repo-cache": 1,
  };
  for (const [file, count] of Object.entries(expectedStages)) {
    const images = [...read(`deploy/${file}`).matchAll(/^FROM\s+(node:\S+)/gm)];
    assert.equal(images.length, count, file);
    for (const [, image] of images) {
      assert.equal(image, `node:${nodeVersion}-trixie-slim`, file);
    }
  }
});
