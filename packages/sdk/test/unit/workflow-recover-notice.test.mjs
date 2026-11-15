import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { recoverWorkflowRun } from "../../dist/workflow/service.js";
import { workflowRunEndRequester } from "../../dist/workflow/runtime.js";

// Adversarial review RT-4: a terminal live run whose end its parent was never told (nor recorded as not told) still
// owes that notice; a recover delivers it, for any terminal run, unless the parent's own command ended the run.

const PARENT = "parent-1";
const completed = { runId: "run-1", workflowSessionId: "wf-1", mode: "live", status: "completed", controllerInstanceId: "ctl-1", controllerVersion: null,
    terminalError: null, revision: 1 };

function fakeHost({ run = completed, controller = "Completed", notifier = "NotFound", noticed = false, receipt = null } = {}) {
    const started = [];
    const store = {
        readRun: async () => run,
        readOperationReceipt: async () => receipt,
        recordOperationReceipt: async (_wf, _op, _kind, _sha, value) => ({ receipt: value, replayed: false }),
        readDefinition: async () => ({ parentSessionId: PARENT }),
        runNoticeRecorded: async () => noticed,
        listOwedAgentInvocations: async () => [],
        // A recover also ends the run's sessions that continued across visits (session: continue); this run has none.
        listAgentInvocations: async () => [],
        recordSessionEvents: async () => {},
        // R2-RT-2: an ended run's session row is put right first (its own test is in workflow-control).
        repairEndedRunSessionRow: async () => ({ repaired: false }),
    };
    const duroxideClient = {
        getStatus: async (instance) => ({ status: instance === "ctl-1" ? controller : instance.startsWith("wfn-") ? notifier : "NotFound" }),
        enqueueEvent: async () => {},
        startOrchestrationVersioned: async (instance, name, input) => { started.push([instance, name, input]); },
    };
    return { host: { store, duroxideClient }, started };
}

const recover = (host, operationId = "recover-1") => recoverWorkflowRun(host, "run-1", { requestedBy: PARENT, operationId });

// Adversarial review R2-RT-2: a recover of an ended run puts its session row right from the run first (the store's own
// check is in workflow-session-row); a run still active is not touched.
test("R2-RT-2: a recover of an ended run asks the store to put its session row right; an active one does not", async () => {
    const { host } = fakeHost({ controller: "Failed" });
    const repaired = [];
    host.store.repairEndedRunSessionRow = async (runId) => { repaired.push(runId); return { repaired: true }; };
    await recover(host);
    assert.deepEqual(repaired, ["run-1"]);
    const active = fakeHost({ run: { ...completed, status: "running" }, controller: "Running" });
    active.host.store.repairEndedRunSessionRow = async (runId) => { repaired.push(runId); return { repaired: true }; };
    await recover(active.host, "recover-2");
    assert.deepEqual(repaired, ["run-1"]);
});

test("a completed run whose controller ended before telling the parent: a recover starts its notifier", async () => {
    const { host, started } = fakeHost();
    const result = await recover(host);
    assert.equal(result.receipt.action, "none");
    assert.deepEqual(started, [["wfn-run-1", "workflow-notify", { runId: "run-1" }]]);
});

test("a notifier that ended without telling: a recover starts one of its own, the same one for a repeat of that recover", async () => {
    const hash = createHash("sha256").update('{"operationId":"recover-2"}').digest("hex").slice(0, 16);
    const { host, started } = fakeHost({ notifier: "Failed" });
    await recover(host, "recover-2");
    assert.deepEqual(started.map(([instance]) => instance), [`wfn-run-1-recover-${hash}`]);
    // The repeat of that recover (its receipt is stored) starts the same instance (duroxide ignores the second start).
    host.store.readOperationReceipt = async () => ({ runId: "run-1", action: "none", status: "completed",
        controller: { status: "Completed", error: null, needsRecovery: false } });
    await recover(host, "recover-2");
    assert.deepEqual(started.map(([instance]) => instance), [`wfn-run-1-recover-${hash}`, `wfn-run-1-recover-${hash}`]);
});

test("nothing is started when the notice was recorded, the notifier or the controller still runs, or the run is not live", async () => {
    for (const options of [{ noticed: true }, { notifier: "Running" }, { controller: "Running" }, { run: { ...completed, mode: "test" } },
        { run: { ...completed, status: "running" }, controller: "Running" }]) {
        const { host, started } = fakeHost(options);
        await recover(host);
        assert.deepEqual(started, [], JSON.stringify(options));
    }
});

test("a run the parent's own cancel or stop ended owes it nothing; another requester's end is told", async () => {
    const byParent = { ...completed, status: "cancelled", terminalError: { code: "cancelled", message: "x", details: { command: "cancel", requestedBy: PARENT } } };
    const stoppedByParent = { ...completed, status: "stopped", terminalError: { code: "stopped", message: "x", details: { actor: { kind: "agent", sessionId: PARENT } } } };
    const byOther = { ...completed, status: "cancelled", terminalError: { code: "cancelled", message: "x", details: { command: "cancel", requestedBy: "other-1" } } };
    for (const run of [byParent, stoppedByParent]) {
        const { host, started } = fakeHost({ run });
        await recover(host);
        assert.deepEqual(started, []);
    }
    const { host, started } = fakeHost({ run: byOther });
    await recover(host);
    assert.equal(started.length, 1);
});

test("workflowRunEndRequester", () => {
    assert.equal(workflowRunEndRequester({ status: "cancelled", terminalError: { details: { requestedBy: "a" } } }), "a");
    assert.equal(workflowRunEndRequester({ status: "stopped", terminalError: { details: { actor: { kind: "agent", sessionId: "b" } } } }), "b");
    assert.equal(workflowRunEndRequester({ status: "stopped", terminalError: { details: { actor: { kind: "user", subject: "c" } } } }), null);
    assert.equal(workflowRunEndRequester({ status: "failed", terminalError: { details: { requestedBy: "a" } } }), null);
    assert.equal(workflowRunEndRequester({ status: "completed", terminalError: null }), null);
});
