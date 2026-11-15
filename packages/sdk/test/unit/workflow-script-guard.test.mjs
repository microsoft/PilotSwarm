/**
 * Scripts are on by default (owner 2026-11-08T15:45Z, pse/decision/scripts-default-on), so the guard on a script node
 * is what keeps it in its box. Every script node runs on the worker's own Node with the permission model (runner.ts
 * gives it `--permission` with file read and write allowed in its own temp folder only). On the real runner, a script
 * node:
 *   a) cannot read a file outside its folder (one planted under the test's tmp, and /etc/hostname);
 *   b) cannot write outside its folder;
 *   c) cannot start a child process (spawn, spawnSync, exec, execFile, fork);
 *   d) sees only the documented environment variables: none of the worker's DATABASE_URL, keys or tokens.
 * (d) does not depend on the permission model: the runner builds a clean environment for every script.
 *
 * Run: node --test test/unit/workflow-script-guard.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScriptNode } from "../../dist/workflow/runner.js";

// As workflow/runtime.ts runs a script node.
const run = source => runScriptNode({
    sessionId: "guard-test",
    node: { id: "probe", source, timeoutSeconds: 20 },
    callTool: async () => null,
});

test("the runner runs every script on the worker's own Node with the permission model, and has no other mode", () => {
    const runner = readFileSync(new URL("../../src/workflow/runner.ts", import.meta.url), "utf8");
    assert.match(runner, /const executable = process\.execPath;/);
    assert.match(runner, /const args = \["--permission", `--allow-fs-read=\$\{workDir\}`, `--allow-fs-write=\$\{workDir\}`, scriptPath\];/);
    assert.doesNotMatch(runner, /guardedNode|strictJson|executables/);
});

test("a) a script node cannot read a file outside its folder (a planted file, and /etc/hostname)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "script-guard-read-"));
    try {
        const planted = path.join(dir, "secret.txt");
        await writeFile(planted, "planted secret");
        const result = await run(`
const fs = require("node:fs");
const out = [];
for (const file of [${JSON.stringify(planted)}, "/etc/hostname"]) {
  try { fs.readFileSync(file, "utf8"); out.push("read"); } catch (error) { out.push(error.code); }
}
try { await require("node:fs/promises").readFile(${JSON.stringify(planted)}, "utf8"); out.push("read"); } catch (error) { out.push(error.code); }
await setResult("done", out);
`);
        assert.equal(result.outcome, "done", JSON.stringify(result));
        assert.deepEqual(result.output, ["ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("b) a script node cannot write outside its folder", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "script-guard-write-"));
    try {
        const target = path.join(dir, "written.txt");
        await writeFile(target, "original");
        const created = path.join(dir, "created.txt");
        const result = await run(`
const fs = require("node:fs");
const out = [];
for (const write of [() => fs.writeFileSync(${JSON.stringify(target)}, "changed"), () => fs.writeFileSync(${JSON.stringify(created)}, "new"),
  () => fs.mkdirSync(${JSON.stringify(path.join(dir, "made"))})]) {
  try { write(); out.push("written"); } catch (error) { out.push(error.code); }
}
fs.writeFileSync("inside.txt", "ok");
out.push(fs.readFileSync("inside.txt", "utf8"));
await setResult("done", out);
`);
        assert.deepEqual(result.output, ["ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED", "ok"]);
        assert.equal(await readFile(target, "utf8"), "original");
        await assert.rejects(readFile(created, "utf8"), { code: "ENOENT" });
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("c) a script node cannot start a child process", async () => {
    const result = await run(`
const cp = require("node:child_process");
const out = [];
for (const start of [() => cp.spawnSync(process.execPath, ["-e", "0"]), () => cp.spawn(process.execPath, ["-e", "0"]),
  () => cp.execSync("true"), () => cp.execFileSync("/bin/true"), () => cp.fork("-e")]) {
  try { const child = start(); out.push(child && child.error ? child.error.code : "started"); } catch (error) { out.push(error.code); }
}
await setResult("done", out);
`);
    assert.deepEqual(result.output, ["ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED"]);
});

test("d) a script node sees only the documented environment variables, none of the worker's secrets", async () => {
    const planted = {
        DATABASE_URL: "postgres://worker:hunter2@db.invalid/ps", GITHUB_TOKEN: "ghp_plantedtoken", AZURE_OPENAI_API_KEY: "planted-key",
        AZURE_CLIENT_SECRET: "planted-secret", PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgres://cms.invalid/x", AWS_SECRET_ACCESS_KEY: "planted",
    };
    const before = Object.fromEntries(Object.keys(planted).map(key => [key, process.env[key]]));
    Object.assign(process.env, planted);
    try {
        const result = await run(`await setResult("done", Object.keys(process.env).sort());`);
        const documented = new Set(["PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE", "TMPDIR", "TEMP",
            "TMP", "NO_COLOR", "PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE", "PILOTSWARM_WORKFLOW_ENDPOINT", "PILOTSWARM_WORKFLOW_TOKEN",
            "PILOTSWARM_WORKFLOW_SESSION_ID", "PILOTSWARM_WORKFLOW_NODE_ID",
            // On Windows, Node (libuv, src/win/process.c required_vars) copies these from the worker into any explicit
            // environment that lacks them; the runner passes none of them.
            ...(process.platform === "win32" ? ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME"] : [])]);
        const extra = result.output.filter(key => !documented.has(key));
        assert.deepEqual(extra, [], `undocumented variables: ${extra.join(", ")}`);
        for (const key of Object.keys(planted)) assert.ok(!result.output.includes(key), key);
    } finally {
        for (const [key, value] of Object.entries(before)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
