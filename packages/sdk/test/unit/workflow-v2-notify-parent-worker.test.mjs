import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { workflowParentNotifier } from "../../dist/workflow/parent-delivery.js";

// Adversarial review WFO-3: the worker queues a workflow's message for its parent only while the parent's session
// orchestration runs; for one that ended (or does not exist) it queues nothing and says so. Verification D-T6 runs the
// same delivery on the real runtime (test/local/workflow-v2-notify-parent.test.js).

function client(status) {
    const calls = [];
    return {
        calls,
        async getStatus(instanceId) { calls.push(["getStatus", instanceId]); return { status }; },
        async enqueueEvent(instanceId, queue, data) { calls.push(["enqueueEvent", instanceId, queue, JSON.parse(data)]); },
    };
}

test("the parent delivery reads the parent's orchestration status first, and queues nothing for an ended or missing parent", async () => {
    for (const status of ["NotFound", "Completed", "Failed", "Terminated"]) {
        const fake = client(status);
        const sender = { kind: "system", display: "workflow" };
        assert.deepEqual(await workflowParentNotifier(fake)("parent-1", "ended", sender, "id-1"), { delivered: false }, status);
        assert.deepEqual(fake.calls, [["getStatus", "session-parent-1"]], status);
    }
});

test("the parent delivery queues the prompt, sender and client message id for a running parent", async () => {
    for (const status of ["Running", "Pending", "ContinuedAsNew"]) {
        const fake = client(status);
        const sender = { kind: "system", display: "workflow" };
        assert.deepEqual(await workflowParentNotifier(fake)("parent-1", "ended", sender, "id-1"), { delivered: true }, status);
        assert.deepEqual(fake.calls, [["getStatus", "session-parent-1"],
            ["enqueueEvent", "session-parent-1", "messages", { prompt: "ended", sender, clientMessageIds: ["id-1"] }]], status);
    }
    const fake = client("Running");
    await workflowParentNotifier(fake)("parent-1", "ended", { kind: "system", display: "w" });
    assert.deepEqual(fake.calls[1][3], { prompt: "ended", sender: { kind: "system", display: "w" } }, "no id: none is sent");
});

test("the worker delivers through it, for v1 child workflows and v2 run ends alike", () => {
    const worker = readFileSync(fileURLToPath(new URL("../../src/worker.ts", import.meta.url)), "utf8");
    assert.match(worker, /const notifyWorkflowParent = workflowParentNotifier\(workflowClient\);/);
    assert.equal(worker.match(/notifyParent: notifyWorkflowParent,/g)?.length, 2);
});
