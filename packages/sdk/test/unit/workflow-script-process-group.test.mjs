/**
 * Stage 2.4 (PR 235 6e2a1fec): a script leads its own process group. A process it starts that leaves its process tree (a
 * shell's background child, reparented to init when the shell exits) ends when the step is stopped (its timeout here) and
 * when the script's own process ends; a background process that keeps the script's output open no longer holds the step
 * until its timeout. POSIX only.
 *
 * Run: node --test test/unit/workflow-script-process-group.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runScriptNode } from "../../dist/workflow/runner.js";

const posix = process.platform !== "win32";
const request = (source, timeoutSeconds = 10) => ({
    sessionId: "process-group-test", workflowName: "example",
    node: { id: "run", type: "script", runtime: "node", source, timeoutSeconds, outcomes: ["done"], next: { done: "end" } },
    inputs: {}, priorOutput: null, step: 1, guardedNode: false,
    callTool: async () => null,
});
// A killed process that nothing reaps yet (its parent is an init that does not reap, as in some containers) is a zombie: ended.
const zombie = pid => { try { return /^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; } };
const alive = pid => { try { process.kill(pid, 0); return !zombie(pid); } catch (error) { return error.code === "EPERM"; } };
const gone = async pid => { for (let i = 0; i < 50 && alive(pid); i += 1) await new Promise(resolve => setTimeout(resolve, 100)); return !alive(pid); };

/**
 * A script that starts `sleep 300` from a shell that exits at once (so the sleep leaves the tree), and writes its pid.
 * `redirect` is where the sleep's output goes: /dev/null, or (>&2) the script's own stderr, which it then keeps open.
 */
const orphanSource = (pidFile, then, redirect) => `
const { execFileSync } = require("node:child_process");
const pid = execFileSync("sh", ["-c", ${JSON.stringify(`sleep 300 ${redirect} & echo $!`)}],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, pid);
${then}
`;

test("a timed-out step ends what its script started outside its process tree", { skip: !posix }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wf-pgroup-"));
    try {
        const pidFile = path.join(dir, "pid");
        const result = await runScriptNode(request(orphanSource(pidFile, "await new Promise(resolve => setTimeout(resolve, 600_000));", "> /dev/null 2>&1"), 2));
        assert.equal(result.resultSource, "timeout");
        const pid = Number(await readFile(pidFile, "utf8"));
        assert.ok(pid > 1);
        assert.equal(await gone(pid), true, `the orphaned sleep ${pid} still runs`);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a script that ends leaves nothing running, and a leftover holding its output does not hold the step", { skip: !posix }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wf-pgroup-"));
    try {
        const pidFile = path.join(dir, "pid");
        const startedAt = Date.now();
        // The sleep keeps the script's stderr open.
        const result = await runScriptNode(request(orphanSource(pidFile, "await setResult('done', { ok: true });", ">&2"), 30));
        assert.equal(result.outcome, "done");
        assert.deepEqual(result.output, { ok: true });
        assert.ok(Date.now() - startedAt < 15_000, `the step took ${Date.now() - startedAt} ms`);
        const pid = Number(await readFile(pidFile, "utf8"));
        assert.equal(await gone(pid), true, `the leftover sleep ${pid} still runs`);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
