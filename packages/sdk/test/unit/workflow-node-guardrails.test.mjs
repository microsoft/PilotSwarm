import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runScriptNode } from "../../dist/workflow/runner.js";

const request = (source, input = null) => ({
    sessionId: "guardrail-test",
    node: { id: "run", source, timeoutSeconds: 10 },
    context: { inputs: { value: 7 }, input },
    callTool: async () => ({ value: 9 }),
});
test("a script reads its context from stdin, uses its scratch folder and calls the authorized broker", async () => {
    const result = await runScriptNode(request(`
const fs = require("node:fs");
fs.writeFileSync("scratch.txt", String(context.inputs.value));
const tool = await callTool("allowed", {});
await setResult("done", {scratch: fs.readFileSync("scratch.txt", "utf8"), tool});
`));
    assert.equal(result.outcome, "done");
    assert.deepEqual(result.output, { scratch: "7", tool: { value: 9 } });
});
test("a script is refused accidental filesystem access outside its scratch folder, and child processes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "workflow-guard-test-"));
    try {
        const file = path.join(dir, "outside.txt");
        await writeFile(file, "private fixture");
        const result = await runScriptNode(request(`
const fs = require("node:fs");
const codes = [];
for (const fn of [
  () => fs.readFileSync(${JSON.stringify(file)}),
  () => fs.writeFileSync(${JSON.stringify(file)}, "changed"),
  () => require("node:child_process").spawnSync(process.execPath, ["-e", "0"])
]) { try { fn(); codes.push("unexpected success"); } catch (error) { codes.push(error.code); } }
await setResult("done", codes);
`));
        assert.deepEqual(result.output, ["ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
test("the documented previous-output binding works and bare input fails explicitly", async () => {
    const previous = { coverage: 84, criticalFindings: 0 };
    const good = await runScriptNode(request("const metrics = context.input; await setResult('done', { ...metrics, approved: metrics.coverage >= 80 });", previous));
    assert.equal(good.exitCode, 0);
    assert.equal(good.outcome, "done");
    assert.deepEqual(good.output, { ...previous, approved: true });

    const bad = await runScriptNode(request("const metrics = input; await setResult('done', metrics);", previous));
    assert.equal(bad.exitCode, 1);
    assert.equal(bad.resultSource, "exit");
    assert.match(bad.stderrTail, /ReferenceError: input is not defined/);
});

// S7-DX stderr guard: the runner keeps the last 16 KiB of a script's stderr, and says when it kept less than was written,
// so a reader that redacts the tail knows its first line may be only the end of a line.
test("the runner says when it kept only the end of a script's stderr", async () => {
    const small = await runScriptNode(request("process.stderr.write('short line\\n'); process.exit(2);"));
    assert.equal(small.exitCode, 2);
    assert.equal(Object.hasOwn(small, "stderrCut"), false);
    const large = await runScriptNode(request(
        "process.stderr.write('token=' + 'x'.repeat(20000) + '\\nlast line\\n', () => process.exit(2));"));
    assert.equal(large.exitCode, 2);
    assert.equal(large.stderrCut, true);
    assert.ok(large.stderrTail.length <= 16 * 1024, String(large.stderrTail.length));
    assert.ok(!large.stderrTail.includes("token="), "the line's start is gone: the tail begins inside the long line");
    assert.match(large.stderrTail, /last line\n$/);
});

// Stage 2.5 (PR 235 1c5b1530): a script runs only on a worker Node in the SDK's engines range.
test("the script Node range is the SDK's engines range, read from package.json", async () => {
    const { workflowNodeVersionSupported, WORKFLOW_NODE_ENGINES } = await import("../../dist/workflow/runner.js");
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    assert.equal(WORKFLOW_NODE_ENGINES, pkg.engines.node);
    for (const ok of ["24.22.1", "24.22.9", "24.23.0", "v24.30.2", "26.12.1", "26.13.0", "27.0.0", "30.1.2"]) {
        assert.equal(workflowNodeVersionSupported(ok), true, ok);
    }
    for (const no of ["24.22.0", "24.21.9", "22.20.0", "25.0.0", "25.9.9", "26.12.0", "26.0.0", "23.99.99", "", "not-a-version", undefined]) {
        assert.equal(workflowNodeVersionSupported(no), false, String(no));
    }
    assert.equal(workflowNodeVersionSupported(process.versions.node), true, "this test worker's own Node is in range");
});
