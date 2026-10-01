// Static guard against ReferenceError-class bugs in the deploy engine.
//
// Regression coverage for the `desiredAgentPools` scoping bug (regressed in
// cb9c2972): a `let` declared INSIDE the `if (moduleName === "base-infra")`
// block was read by the reconcileAgentPools() preflight AFTER that block
// closed. Because `let` is block-scoped, the out-of-block read throws
// "ReferenceError: desiredAgentPools is not defined" on every base-infra
// deploy. No existing test caught it: the reference lives in deployOne()
// (not an exported helper), the agent-pool unit test only imports the pure
// helpers, and force-module.test.mjs stubs shouldSkipDeploy -> { skip: true }
// so deployOne returns before ever reaching the guard. The failure only
// surfaces at deploy time.
//
// TypeScript's checkJs resolves identifiers with real lexical-scope analysis
// and reports undefined / out-of-scope / use-before-declaration references as
// TS2304 / TS2448 / TS2454 -- statically, without executing the deploy. We run
// tsc over the deploy scripts and fail if ANY name-resolution diagnostic
// appears. Type-shape diagnostics (TS2339 "property does not exist", TS2345
// "not assignable", ...) are intentionally ignored: they are JS/TS inference
// noise unrelated to this bug class, and the deploy scripts are not written to
// pass strict type checking.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(here, ".."); // deploy/scripts
const repoRoot = resolve(here, "..", "..", ".."); // repo root
// Invoke the TypeScript compiler through its JS entrypoint (as the repo's other
// tsc-based checks do) rather than the .cmd/.bin shim, so no shell is spawned.
const tscEntry = join(repoRoot, "node_modules", "typescript", "bin", "tsc");

// The ReferenceError class: undefined name, used-before-declaration, and
// used-before-assignment. These are exactly what a block-scoping mistake like
// desiredAgentPools produces.
const NAME_RESOLUTION_CODES = new Set(["TS2304", "TS2448", "TS2454"]);

function collectDeployScripts(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip this test directory and any nested deps; we guard the deploy
      // engine's production scripts (top-level entrypoints + lib/).
      if (entry.name === "test" || entry.name === "node_modules") continue;
      out.push(...collectDeployScripts(full));
    } else if (entry.name.endsWith(".mjs")) {
      out.push(full);
    }
  }
  return out;
}

test("deploy scripts have no ReferenceError-class (undefined / out-of-scope) names", () => {
  const files = collectDeployScripts(scriptsDir);
  assert.ok(files.length > 0, "expected to find deploy .mjs files to check");

  // Drive tsc via a throwaway tsconfig so the (possibly long) file list and
  // Windows paths never have to survive shell argument quoting.
  const workDir = mkdtempSync(join(tmpdir(), "deploy-scripts-nameres-"));
  const tsconfigPath = join(workDir, "tsconfig.json");
  writeFileSync(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        allowJs: true,
        checkJs: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        skipLibCheck: true,
        noImplicitAny: false,
      },
      files,
    }),
  );

  try {
    const result = spawnSync(process.execPath, [tscEntry, "-p", tsconfigPath], {
      encoding: "utf8",
      cwd: repoRoot,
    });

    const output = `${result.stdout || ""}${result.stderr || ""}`;
    const offenders = output.split(/\r?\n/).filter((line) => {
      const match = line.match(/error (TS\d+):/);
      return match && NAME_RESOLUTION_CODES.has(match[1]);
    });

    assert.equal(
      offenders.length,
      0,
      "Found ReferenceError-class name-resolution errors in the deploy scripts " +
        "(an undefined or out-of-scope variable, e.g. a `let` read outside the " +
        "block it was declared in). Hoist the declaration or fix the reference:\n" +
        offenders.join("\n"),
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
