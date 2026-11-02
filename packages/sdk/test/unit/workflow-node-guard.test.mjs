/**
 * Node script states run on the worker's own Node under its permission
 * model: files only in the state's scratch folder, no child processes.
 * After Affan Dar's guarded-Node runner tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runScriptNode, workflowNodeArgs, workflowNodeVersionSupported, WORKFLOW_NODE_MIN_VERSION, WORKFLOW_NODE_VERSION_RANGE } from "../../dist/workflow/runner.js";

test("node scripts run with the permission model, limited to their scratch folder", () => {
    assert.deepEqual(workflowNodeArgs("/tmp/s", "/tmp/s/script.mjs"),
        ["--permission", "--allow-fs-read=/tmp/s", "--allow-fs-write=/tmp/s", "/tmp/s/script.mjs"]);
    assert.equal(WORKFLOW_NODE_MIN_VERSION, "24.22.1");
    // The SDK's engines range: ^24.22.1 || >=26.12.1.
    for (const version of ["24.22.1", "v24.22.1", "24.22.2", "24.23.0", "26.12.1", "26.13.0", "27.0.0"]) assert.equal(workflowNodeVersionSupported(version), true, version);
    for (const version of ["24.22.0", "24.21.9", "22.20.0", "25.5.0", "26.1.0", "26.12.0"]) assert.equal(workflowNodeVersionSupported(version), false, version);
});

const nodeRequest = (source, extra = {}) => ({
    sessionId: "guard-test", workflowName: "example",
    node: { id: "run", type: "script", runtime: "node", source, timeoutSeconds: 20, outcomes: ["done"], next: { done: "end" } },
    inputs: { value: 7 }, priorOutput: null, step: 1,
    callTool: async () => ({ value: 9 }),
    ...extra,
});

const nodeGuarded = workflowNodeVersionSupported(process.versions.node);

test("a node script reads its context, uses its scratch folder and calls tools", { skip: !nodeGuarded && `Node ${process.versions.node} is outside ${WORKFLOW_NODE_VERSION_RANGE}` }, async () => {
    const result = await runScriptNode(nodeRequest(`
const fs = require("node:fs");
fs.writeFileSync("scratch.txt", String(context.inputs.value));
const tool = await callTool("allowed", {});
await setResult("done", { scratch: fs.readFileSync("scratch.txt", "utf8"), tool });
`));
    assert.equal(result.outcome, "done");
    assert.deepEqual(result.output, { scratch: "7", tool: { value: 9 } });
});

test("a node script cannot read or write outside its scratch folder or start processes", { skip: !nodeGuarded && `Node ${process.versions.node} is outside ${WORKFLOW_NODE_VERSION_RANGE}` }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "workflow-guard-test-"));
    try {
        const file = path.join(dir, "outside.txt");
        await writeFile(file, "private fixture");
        const result = await runScriptNode(nodeRequest(`
const fs = require("node:fs");
const codes = [];
for (const fn of [
  () => fs.readFileSync(${JSON.stringify(file)}),
  () => fs.writeFileSync(${JSON.stringify(file)}, "changed"),
  () => require("node:child_process").spawnSync(process.execPath, ["-e", "0"]),
]) { try { fn(); codes.push("unexpected success"); } catch (error) { codes.push(error.code); } }
await setResult("done", codes);
`), { executables: { node: "/ignored-node-override" } });
        assert.deepEqual(result.output, ["ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED", "ERR_ACCESS_DENIED"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a node state on a worker below the minimum Node is refused before it runs", { skip: nodeGuarded && "this Node is new enough" }, async () => {
    await assert.rejects(runScriptNode(nodeRequest("await setResult('done', null)")), /needs Node \^24\.22\.1 \|\| >=26\.12\.1/);
});
