// Regression test for FR-010 + FR-011 (SC-006): the portal and worker image
// builds must use the lockfile-enforcing install mode (`npm ci`) so rebuilds
// from a given source revision are byte-reproducible.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readDockerfile(name) {
  return readFileSync(join(REPO_ROOT, "deploy", name), "utf8");
}

// Strip `# ...` comment lines so we only flag the install verb when it
// appears in an executable RUN line.
function stripComments(src) {
  return src
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

for (const file of ["Dockerfile.portal", "Dockerfile.worker"]) {
  test(`${file} installs deps with npm ci (lockfile-enforcing)`, () => {
    const src = stripComments(readDockerfile(file));
    assert.match(
      src,
      /^\s*RUN\b(?:[^\r\n]*\\\r?\n)*[^\r\n]*\bnpm\s+ci\b/m,
      `${file} must use 'npm ci' (lockfile-enforcing) for byte-reproducible rebuilds`,
    );
    assert.equal(
      /^\s*RUN\b(?:[^\r\n]*\\\r?\n)*[^\r\n]*\bnpm\s+install\b/m.test(src),
      false,
      `${file} must NOT use 'npm install' on dependencies — that drifts from package-lock.json on rebuild`,
    );
  });
}

test("AKS images bake the checked-in deploy catalog, never the private local catalog", () => {
  for (const file of [
    "Dockerfile.portal",
    "Dockerfile.worker",
    "Dockerfile.worker.windows",
  ]) {
    const source = readDockerfile(file);
    assert.match(source, /COPY deploy\/config\/model_providers\.ghcp\.json \.\/\.model_providers\.json/);
    assert.doesNotMatch(source, /COPY \.model_providers\.json/);
  }
});

test("starter image stages every workspace manifest before npm ci", () => {
  const source = readDockerfile("Dockerfile.starter");
  assert.match(source, /COPY packages\/sdk\/package\.json \.\/packages\/sdk\//);
  assert.match(source, /COPY packages\/horizon-store\/package\.json \.\/packages\/horizon-store\//);
  assert.match(source, /COPY packages\/app\/package\.json \.\/packages\/app\//);
  assert.match(stripComments(source), /^\s*RUN\b(?:[^\r\n]*\\\r?\n)*[^\r\n]*\bnpm\s+ci\b/m);
});

for (const file of ["Dockerfile.worker", "Dockerfile.worker.windows"]) {
  test(`${file} bakes worker build provenance into the runtime environment`, () => {
    const src = stripComments(readDockerfile(file));
    for (const name of [
      "PILOTSWARM_SOURCE_COMMIT",
      "PILOTSWARM_BUILD_ID",
      "PILOTSWARM_IMAGE_REF",
    ]) {
      assert.match(src, new RegExp(`ARG\\s+${name}\\b`));
      assert.match(src, new RegExp(`ENV\\s+${name}=\\$\\{${name}\\}`));
    }
  });
}

test("deployment image builder supplies worker build provenance arguments", () => {
  const src = readFileSync(join(REPO_ROOT, "deploy", "scripts", "lib", "build-image.mjs"), "utf8");
  assert.match(src, /PILOTSWARM_SOURCE_COMMIT=.*rev-parse/);
  assert.match(src, /PILOTSWARM_BUILD_ID=\$\{imageTag\}/);
  assert.doesNotMatch(src, /PILOTSWARM_IMAGE_REF=\$\{localTag\}/,
    "the build-time local tag is not the deployed image reference");
});

// Session workspaces: the manifests in gitops/*/components/workspaces and
// gitops/repo-cache name files and programs these images must carry. The
// render tests in workspaces.test.mjs check that the paths exist in the
// source tree; these check that each image copies them.
test("images carry what the session-workspaces manifests name", () => {
  const worker = stripComments(readDockerfile("Dockerfile.worker"));
  assert.match(worker, /COPY packages\/sdk\/examples\/repo-workspaces\/ \.\/packages\/sdk\/examples\/repo-workspaces\//);
  assert.match(worker, /apt-get install[^\n]*\bgit\b[^\n]*\bnfs-common\b/, "git for agents, mount.nfs4 for the attacher");
  assert.match(worker, /chmod u-s \/usr\/sbin\/mount\.nfs/, "no setuid mount.nfs for agent shells");

  const portal = stripComments(readDockerfile("Dockerfile.portal"));
  assert.match(portal, /COPY packages\/sdk\/examples\/repo-workspaces\/plugin\/ \.\/packages\/sdk\/examples\/repo-workspaces\/plugin\//);

  const repoCache = stripComments(readDockerfile("Dockerfile.repo-cache"));
  assert.match(repoCache, /apt-get install[^\n]*\bgit\b[^\n]*\bnfs-kernel-server\b/);
  assert.match(repoCache, /WORKDIR \/app\/packages\/sdk\/examples\/repo-workspaces\n/);
  assert.match(repoCache, /COPY packages\/sdk\/examples\/repo-workspaces\/ \.\//);
});
