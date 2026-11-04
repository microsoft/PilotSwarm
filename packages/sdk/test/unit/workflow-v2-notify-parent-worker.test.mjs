import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Adversarial review WFO-3: the worker queues a workflow's message for its parent only while the parent's session
// orchestration runs; for one that ended (or does not exist) it queues nothing and says so.

test("the worker reads the parent's orchestration status before it queues, and reports an ended parent as not delivered", () => {
    const worker = readFileSync(fileURLToPath(new URL("../../src/worker.ts", import.meta.url)), "utf8");
    const body = worker.slice(worker.indexOf("const notifyWorkflowParent = async"), worker.indexOf("registerWorkflowActivities(this.runtime"));
    assert.match(body, /const status = \(await workflowClient\.getStatus\(instanceId\)\)\.status;/);
    assert.match(body, /if \(status === "NotFound" \|\| \["Completed", "Failed", "Terminated"\]\.includes\(status\)\) return \{ delivered: false \};/);
    assert.ok(body.indexOf("getStatus(instanceId)") < body.indexOf("enqueueEvent("), "the status is read before the enqueue");
    assert.match(body, /return \{ delivered: true \};/);
});
