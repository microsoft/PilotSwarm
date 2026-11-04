import test from "node:test";
import assert from "node:assert/strict";
import { recoverWorkflowV2Run } from "../../dist/workflow/v2/service.js";
import { endWorkflowV2RunAgents } from "../../dist/workflow/v2/runtime.js";

// Adversarial review RT-3: a recover that ends a run whose controller ended also ends the children of its decided agent
// states, whatever the run's mode and whether or not its parent is told; a later recover ends the ones still owed.

function fakeHost({ mode = "live", parent = "parent-1", childFails = false } = {}) {
    const log = { enqueued: [], started: [], events: [], receipts: [] };
    const active = { runId: "run-1", workflowSessionId: "wf-1", mode, status: "running", controllerInstanceId: "ctl-1", controllerVersion: null,
        terminalError: null, revision: 1 };
    const ended = { ...active, status: "failed", terminalError: { code: "controller_ended", message: "The workflow controller ended (Failed)." } };
    let current = active;
    const invocation = { nodeExecutionId: "nx-1", runId: "run-1", workflowSessionId: "wf-1", childSessionId: "child-1", endSentAt: null, endRequested: null };
    const store = {
        readRun: async () => current,
        readOperationReceipt: async () => null,
        finishRun: async () => { current = ended; return { ended: true, run: ended }; },
        recordOperationReceipt: async (_wf, operationId, _kind, _sha, value) => { log.receipts.push(operationId); return { receipt: value, replayed: false }; },
        readDefinition: async () => ({ parentSessionId: parent }),
        runNoticeRecorded: async () => false,
        listAgentInvocations: async () => [{ ...invocation }],
        readNodeExecution: async () => ({ nodeExecutionId: "nx-1", nodeType: "agent", state: "completed", winner: "controller", outcome: "cancelled", nodeId: "review" }),
        recordAgentEnd: async () => ({ invocation: { ...invocation } }),
        markAgentEndSent: async () => { invocation.endSentAt = "2026-11-04T07:00:00Z"; return { marked: true }; },
        recordSessionEvents: async (_id, events) => { log.events.push(...events.map(event => event.eventType)); },
    };
    const duroxideClient = {
        getStatus: async (instance) => {
            if (instance === "ctl-1") return { status: "Failed" };
            if (instance.startsWith("wfn-")) return { status: "NotFound" };
            if (childFails) throw new Error("the child's status could not be read");
            return { status: "Running" };
        },
        enqueueEvent: async (instance, queue, data) => { log.enqueued.push([instance, queue, JSON.parse(data)]); },
        startOrchestrationVersioned: async (instance) => { log.started.push(instance); },
    };
    return { host: { store, duroxideClient }, log, invocation };
}

test("a recover that ends the run ends its agent children and starts the parent's notification", async () => {
    const { host, log } = fakeHost();
    const result = await recoverWorkflowV2Run(host, "run-1", { requestedBy: "parent-1", operationId: "recover-1" });
    assert.equal(result.receipt.action, "ended");
    assert.deepEqual(log.enqueued, [["session-child-1", "messages", {
        type: "cmd", cmd: "cancel", id: "workflow-agent-end:nx-1", args: { reason: "The workflow state this session ran ended (cancelled)." },
    }]]);
    assert.ok(log.events.includes("workflow.agent_ended"));
    assert.equal(log.started.length, 1);
});

test("a test run's agent children are ended too, though no parent is told", async () => {
    const { host, log } = fakeHost({ mode: "test" });
    await recoverWorkflowV2Run(host, "run-1", { requestedBy: "parent-1", operationId: "recover-1" });
    assert.equal(log.enqueued.length, 1);
    assert.equal(log.started.length, 0);
});

test("a child that cannot be ended yet fails the recover after the notification started; a later recover ends it once", async () => {
    const failing = fakeHost({ childFails: true });
    await assert.rejects(recoverWorkflowV2Run(failing.host, "run-1", { requestedBy: "parent-1", operationId: "recover-1" }), /not ended yet/);
    assert.ok(failing.log.events.includes("workflow.agent_end_failed"));
    assert.equal(failing.log.started.length, 1);
    assert.equal(failing.invocation.endSentAt, null);

    // The same run, the store as it is, a client that works again: the next recover ends the child; one after it sends nothing.
    const { host, log, invocation } = fakeHost();
    host.store.readRun = async () => ({ runId: "run-1", workflowSessionId: "wf-1", mode: "live", status: "failed", controllerInstanceId: "ctl-1",
        controllerVersion: null, terminalError: { code: "controller_ended", message: "x" }, revision: 1 });
    await recoverWorkflowV2Run(host, "run-1", { requestedBy: "parent-1", operationId: "recover-2" });
    assert.equal(log.enqueued.length, 1);
    assert.notEqual(invocation.endSentAt, null);
    await recoverWorkflowV2Run(host, "run-1", { requestedBy: "parent-1", operationId: "recover-3" });
    assert.equal(log.enqueued.length, 1, "an end already sent is not sent again");
});

test("endWorkflowV2RunAgents skips invocations whose end was sent", async () => {
    const { host, log } = fakeHost();
    host.store.listAgentInvocations = async () => [{ nodeExecutionId: "nx-0", runId: "run-1", workflowSessionId: "wf-1", childSessionId: "c0", endSentAt: "x" }];
    await endWorkflowV2RunAgents(host.store, host.duroxideClient, "run-1");
    assert.deepEqual(log.enqueued, []);
});
