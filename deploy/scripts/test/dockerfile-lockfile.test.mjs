// Regression test for FR-010 + FR-011 (SC-006): the portal and worker image
// builds must use the lockfile-enforcing install mode (`npm ci`) so rebuilds
// from a given source revision are byte-reproducible, and their final stages
// must include the runtime modules their entrypoints require.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

function staticRelativeModules(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(tree.parseDiagnostics.length, 0, `${file} must parse before checking its imports`);
  return tree.statements
    .filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    .map((node) => node.moduleSpecifier)
    .filter((node) => node && ts.isStringLiteral(node) && /^\.{1,2}\//.test(node.text))
    .map((node) => posix.normalize(posix.join(posix.dirname(file), node.text)));
}

// Model the local-source COPY forms used by these images. Build-stage copies
// do not prove a source module is shipped in the final runtime stage.
function runtimeSourceCopies(dockerfile) {
  let workdir = "/";
  let copies = [];
  for (const rawLine of stripComments(dockerfile).replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^FROM\s/i.test(line)) {
      workdir = "/";
      copies = [];
      continue;
    }
    const workdirMatch = line.match(/^WORKDIR\s+(\S+)\s*$/i);
    if (workdirMatch) {
      assert.ok(!workdirMatch[1].includes("$"), "resolve variable WORKDIR before extending this test");
      workdir = posix.resolve(workdir, workdirMatch[1]);
      continue;
    }
    const copy = line.match(/^COPY\s+(.+)$/i);
    if (!copy) continue;
    let args = copy[1].trim();
    let fromStage = false;
    while (args.startsWith("--")) {
      const flag = args.match(/^--(from|chown|chmod)=(\S+)\s+/);
      assert.ok(flag, `unsupported COPY option: ${args}`);
      if (flag[1] === "from") fromStage = true;
      args = args.slice(flag[0].length);
    }
    if (fromStage) continue;
    const paths = args.startsWith("[") ? JSON.parse(args) : args.split(/\s+/);
    assert.ok(Array.isArray(paths) && paths.length >= 2, `invalid COPY: ${line}`);
    for (const path of paths) {
      assert.equal(typeof path, "string");
      assert.doesNotMatch(path, /[\s"'$*?\[\]]/, `extend COPY parsing for ${path}`);
    }
    const destination = paths.pop();
    assert.ok(paths.length === 1 || destination.endsWith("/"), `multiple COPY sources need a directory: ${line}`);
    for (const source of paths) {
      const directory = statSync(join(REPO_ROOT, source)).isDirectory();
      copies.push({
        source: posix.normalize(source).replace(/\/$/, ""),
        directory,
        target: posix.resolve(workdir, destination,
          !directory && destination.endsWith("/") ? posix.basename(source) : ""),
      });
    }
  }
  return copies;
}

function isSourceCopied(copies, file) {
  return copies.some((copy) => {
    if (!copy.directory) return copy.source === file && copy.target === `/app/${file}`;
    if (!file.startsWith(`${copy.source}/`)) return false;
    return posix.join(copy.target, file.slice(copy.source.length + 1)) === `/app/${file}`;
  });
}

test("runtime import discovery includes static re-exports but not comments or dynamic imports", () => {
  assert.deepEqual(staticRelativeModules("web/server.js", `
    // import "./comment.js";
    /* export * from "./comment-export.js"; */
    import "node:fs";
    import "./side-effect.js";
    import value from "./default.js";
    import {
      named
    } from "./named.js";
    import * as namespace from "../shared.js";
    export { other } from "./re-export.js";
    export * from "./all.js";
    const text = 'import "./string.js"';
    const lazy = import("./dynamic.js");
  `), [
    "web/side-effect.js", "web/default.js", "web/named.js", "shared.js",
    "web/re-export.js", "web/all.js",
  ]);
});

test("runtime COPY coverage respects the final stage, destinations and directory boundaries", () => {
  const copies = runtimeSourceCopies(`
FROM node AS build
WORKDIR /app
COPY packages/app/web/ ./packages/app/web/
FROM node
WORKDIR /app
COPY --chown=node:node packages/app/web/auth/ ./packages/app/web/auth/
COPY ["packages/app/web/config.js", "./wrong/config.js"]
COPY packages/app/web/server.js \\
     packages/app/web/runtime.js ./packages/app/web/
`);
  assert.equal(isSourceCopied(copies, "packages/app/web/auth/index.js"), true);
  assert.equal(isSourceCopied(copies, "packages/app/web/server.js"), true);
  assert.equal(isSourceCopied(copies, "packages/app/web/runtime.js"), true);
  assert.equal(isSourceCopied(copies, "packages/app/web/authz.js"), false);
  assert.equal(isSourceCopied(copies, "packages/app/web/config.js"), false);
  assert.equal(isSourceCopied(copies, "packages/app/web/portal-paths.js"), false);
});

for (const [image, entrypoints] of [
  ["Dockerfile.portal", ["server.js", "config.js", "runtime.js", "auth.js", "authz.js"]
    .map((name) => `packages/app/web/${name}`)],
  ["Dockerfile.worker", ["packages/sdk/examples/worker.js"]],
]) {
  for (const entrypoint of entrypoints) {
    test(`${image} ships ${entrypoint} and its static relative modules`, () => {
      const copies = runtimeSourceCopies(readDockerfile(image));
      const modules = [entrypoint, ...staticRelativeModules(entrypoint, readFileSync(join(REPO_ROOT, entrypoint), "utf8"))];
      for (const file of modules) {
        assert.ok(statSync(join(REPO_ROOT, file)).isFile(), `${entrypoint} requires source file ${file}`);
        assert.ok(isSourceCopied(copies, file), `${image} does not copy ${file} to /app/${file} (required by ${entrypoint})`);
      }
    });
  }
}

test("portal runtime coverage detects the omitted helper despite the broad build-stage COPY", () => {
  const dockerfile = readDockerfile("Dockerfile.portal");
  const copies = runtimeSourceCopies(dockerfile);
  const helper = "packages/app/web/portal-paths.js";
  assert.equal(isSourceCopied(copies, helper), true);
  const withoutHelper = runtimeSourceCopies(dockerfile.replace(`${helper} `, ""));
  assert.equal(isSourceCopied(withoutHelper, helper), false);
  const modules = staticRelativeModules("packages/app/web/server.js",
    readFileSync(join(REPO_ROOT, "packages/app/web/server.js"), "utf8"));
  assert.deepEqual(modules.filter((file) => !isSourceCopied(withoutHelper, file)), [helper]);
});

for (const file of ["Dockerfile.portal", "Dockerfile.worker"]) {
  test(`${file} installs deps with npm ci (lockfile-enforcing)`, () => {
    const src = stripComments(readDockerfile(file));
    assert.match(
      src,
      /RUN\s+npm\s+ci\b/,
      `${file} must use 'npm ci' (lockfile-enforcing) for byte-reproducible rebuilds`,
    );
    assert.equal(
      /RUN\s+npm\s+install\b/.test(src),
      false,
      `${file} must NOT use 'npm install' on dependencies — that drifts from package-lock.json on rebuild`,
    );
  });
}

test("AKS images bake the checked-in deploy catalog, never the private local catalog", () => {
  for (const file of ["Dockerfile.portal", "Dockerfile.worker"]) {
    const source = readDockerfile(file);
    assert.match(source, /COPY deploy\/config\/model_providers\.ghcp\.json \.\/\.model_providers\.json/);
    assert.doesNotMatch(source, /COPY \.model_providers\.json/);
  }
});

test("AKS application images build generated artifacts inside Docker", () => {
  const portal = readDockerfile("Dockerfile.portal");
  const worker = readDockerfile("Dockerfile.worker");

  for (const [name, source] of [["portal", portal], ["worker", worker]]) {
    assert.match(source, /FROM node:24-trixie-slim AS build/);
    assert.match(source, /rm -rf[\s\S]*packages\/sdk\/dist[\s\S]*packages\/horizon-store\/dist/);
    assert.match(source, /npm run build --workspace=packages\/sdk/);
    assert.match(source, /--workspace=pilotswarm-horizon-store/);
    assert.doesNotMatch(source, /^COPY packages\/sdk\/dist\//m, `${name} must not require host SDK output`);
    assert.doesNotMatch(source, /^COPY packages\/horizon-store\/dist\//m, `${name} must not require host Horizon Store output`);
    assert.match(source, /COPY --from=build \/app\/packages\/sdk\/dist\//);
    assert.match(source, /COPY --from=build \/app\/packages\/horizon-store\/dist\//);
  }

  assert.match(portal, /--workspace=pilotswarm(?:\s|\\)/);
  assert.match(portal, /rm -rf[\s\S]*packages\/app\/web\/dist[\s\S]*packages\/app\/mcp\/dist/);
  assert.doesNotMatch(portal, /^COPY packages\/app\/mcp\/dist\//m);
  assert.doesNotMatch(portal, /^COPY packages\/app\/web\/dist\//m);
  assert.match(portal, /COPY --from=build \/app\/packages\/app\/mcp\/dist\//);
  assert.match(portal, /COPY --from=build \/app\/packages\/app\/web\/dist\//);
});

test("starter image stages every workspace manifest before npm ci", () => {
  const source = readDockerfile("Dockerfile.starter");
  assert.match(source, /COPY packages\/sdk\/package\.json \.\/packages\/sdk\//);
  assert.match(source, /COPY packages\/horizon-store\/package\.json \.\/packages\/horizon-store\//);
  assert.match(source, /COPY packages\/app\/package\.json \.\/packages\/app\//);
  assert.match(stripComments(source), /RUN\s+npm\s+ci\b/);
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
  // The portal component sets PORTAL_CANVAS_COMMANDS_RUNNER=local; without
  // git in the image every canvas command fails with "git is not installed".
  assert.match(portal, /apt-get install(?:[^\r\n]*\\\r?\n)*[^\r\n]*\bgit\b/, "git for canvas commands");

  const repoCache = stripComments(readDockerfile("Dockerfile.repo-cache"));
  assert.match(repoCache, /apt-get install[^\n]*\bgit\b[^\n]*\bnfs-kernel-server\b/);
  assert.match(repoCache, /WORKDIR \/app\/packages\/sdk\/examples\/repo-workspaces\r?\n/);
  assert.match(repoCache, /COPY packages\/sdk\/examples\/repo-workspaces\/ \.\//);
});
