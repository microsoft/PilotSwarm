// Regression guard: internal consumers of the fork-local `pilotswarm-sdk`
// workspace package must reference it with the version spec "*" — the only
// npm-native range the workspace version ALWAYS satisfies, so npm always
// symlinks packages/sdk instead of silently installing a published copy.
//
// Background: an exact pin ("0.5.63") stopped matching the workspace SDK once it
// was released as 0.5.66. npm workspaces only link the local package when the
// requested range is satisfied by the workspace version; on a mismatch npm
// SILENTLY installs the registry copy — which, for this fork, is upstream code
// missing the fork's SDK modules — breaking consumer builds with no install-time
// error. Using "*" makes that drift impossible. npm does NOT support the
// `workspace:` protocol (EUNSUPPORTEDPROTOCOL), so "*" is the correct spec.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
const SDK_PACKAGE = "pilotswarm-sdk";
const REQUIRED_SPEC = "*";
const DEP_BUCKETS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function workspaceManifests() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES_DIR, entry.name, "package.json"))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, json: JSON.parse(readFileSync(path, "utf8")) }));
}

// The SDK package is the workspace source itself; it must not depend on itself.
const manifests = workspaceManifests().filter((m) => m.json.name !== SDK_PACKAGE);

for (const { json } of manifests) {
  for (const bucket of DEP_BUCKETS) {
    const spec = json[bucket]?.[SDK_PACKAGE];
    if (spec === undefined) continue;
    test(`${json.name} ${bucket}.${SDK_PACKAGE} links the workspace ("${REQUIRED_SPEC}")`, () => {
      assert.equal(
        spec,
        REQUIRED_SPEC,
        `${json.name} declares ${bucket}."${SDK_PACKAGE}": "${spec}". Use "${REQUIRED_SPEC}" so npm always ` +
          `links the local packages/sdk workspace. A pinned/ranged spec stops matching when the SDK version ` +
          `is bumped, causing npm to silently install a stale published copy and breaking the build.`,
      );
    });
  }
}

// Guard the guard: if no consumer references the SDK, discovery has silently
// become a no-op (e.g. a rename), so fail loudly rather than pass vacuously.
test(`at least one workspace references ${SDK_PACKAGE}`, () => {
  const refCount = manifests.filter((m) =>
    DEP_BUCKETS.some((bucket) => m.json[bucket]?.[SDK_PACKAGE] !== undefined),
  ).length;
  assert.ok(refCount > 0, `no workspace references ${SDK_PACKAGE}; the version guard is a no-op`);
});
