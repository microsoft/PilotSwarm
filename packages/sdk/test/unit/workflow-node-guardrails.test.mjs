import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runScriptNode } from "../../dist/workflow/runner.js";

const request = source => ({
    sessionId: "guardrail-test", workflowName: "example",
    node: { id: "run", type: "script", runtime: "node", source, timeoutSeconds: 10, outcomes: ["done"], next: { done: "end" } },
    inputs: { value: 7 }, priorOutput: null, step: 1, guardedNode: true,
    callTool: async () => ({ value: 9 }),
});
test("guarded Node reads stdin, uses scratch and calls the authorized broker", async () => {
    const result = await runScriptNode(request(`
const fs = require("node:fs");
fs.writeFileSync("scratch.txt", String(context.inputs.value));
const tool = await callTool("allowed", {});
await setResult("done", {scratch: fs.readFileSync("scratch.txt", "utf8"), tool});
`));
    assert.equal(result.outcome, "done");
    assert.deepEqual(result.output, { scratch: "7", tool: { value: 9 } });
});
test("guarded Node refuses accidental outside-scratch filesystem and child process access", async () => {
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
test("guarded policy refuses non-Node and unverified executable overrides", async () => {
    const r = request("await setResult('done', null)");
    await assert.rejects(runScriptNode({ ...r, node: { ...r.node, runtime: "python" } }), /supported Node/);
    await assert.rejects(runScriptNode(r, { executables: { node: "/not-the-worker-node" } }), /supported Node/);
});
