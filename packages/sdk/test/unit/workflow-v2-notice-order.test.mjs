import test from "node:test";
import assert from "node:assert/strict";
import { registerWorkflowV2, WORKFLOW_V2_ACTIVITIES, WORKFLOW_V2_NOTICE_DELIVERY_WAIT_MS } from "../../dist/workflow/v2/runtime.js";

// Adversarial review WFO-1 (TLC parent.late-message, parent.late-request): a send's message or a request to the parent
// whose delivery attempt began before the run ended is queued before the run's end notice. The notifier activity waits
// (bounded) while such an attempt is in flight; no orchestration code changes.

const PARENT = "parent-1";
const RUN = { runId: "run-1", workflowSessionId: "wf-1", mode: "live", status: "completed", revision: 1, terminalOutcome: "succeeded",
    terminalNodeId: "done", terminalOutput: null, terminalError: null };

function harness({ inFlight = () => 0, waitMs, delivered } = {}) {
    const activities = new Map();
    const log = [];
    const store = {
        readRun: async () => RUN,
        readDefinition: async () => ({ parentSessionId: PARENT, notifyParent: true }),
        runNoticeRecorded: async () => false,
        runNoticeAttempted: async () => false,
        readRevisionLabel: async () => ({ name: "w", semver: "1.0.0" }),
        runDeliveriesInFlight: async (runId, recipient, seconds) => { log.push(["inFlight", runId, recipient, seconds]); return inFlight(); },
        recordSessionEvents: async (_id, events) => { log.push(...events.map(event => ["event", event.eventType])); },
    };
    registerWorkflowV2({
        registerActivity: (name, fn) => activities.set(name, fn),
        registerOrchestrationVersioned: () => {},
    }, {
        store, catalog: {}, enabled: () => true,
        resolveToolBinding: async () => null, openToolExecutor: async () => { throw new Error("no tools"); },
        authorizeParentNotification: async () => true,
        notifyParent: async (parent, _prompt, _sender, clientMessageId) => {
            log.push(["notify", parent, clientMessageId]);
            return delivered === undefined ? undefined : { delivered };
        },
        deleteSession: async () => {},
        ...(waitMs !== undefined ? { noticeDeliveryWaitMs: waitMs } : {}),
    });
    const notify = () => activities.get(WORKFLOW_V2_ACTIVITIES.notifyParent)({}, { runId: RUN.runId });
    return { notify, log };
}

test("the run's end is queued only after the parent's deliveries in flight are recorded", async () => {
    let checks = 0;
    const h = harness({ inFlight: () => (++checks <= 3 ? 1 : 0) });
    await h.notify();
    const kinds = h.log.map(entry => entry[0]);
    assert.deepEqual(kinds.filter(kind => kind === "inFlight").length, 4);
    assert.ok(kinds.indexOf("notify") > kinds.lastIndexOf("inFlight"), "queued after the last check found none");
    assert.deepEqual(h.log.find(entry => entry[0] === "inFlight"), ["inFlight", "run-1", PARENT, 60]);
});

test("the wait is bounded: a delivery that stays in flight does not hold the notice back for ever", async () => {
    assert.equal(WORKFLOW_V2_NOTICE_DELIVERY_WAIT_MS, 20_000);
    const h = harness({ inFlight: () => 1, waitMs: 500 });
    const started = Date.now();
    await h.notify();
    assert.ok(Date.now() - started < 3_000);
    assert.ok(h.log.some(entry => entry[0] === "notify"));
});

test("nothing in flight: one check, then the notice", async () => {
    const h = harness();
    await h.notify();
    assert.deepEqual(h.log.filter(entry => entry[0] === "inFlight").length, 1);
    assert.deepEqual(h.log.filter(entry => entry[0] === "notify"), [["notify", PARENT, "workflow:wf-1:run-1:terminal"]]);
});

// Adversarial review WFO-3 (TLC parent.notified-lost): a parent whose session ended before the notice was queued was not
// told: the skip is recorded, not parent_notified.
test("WFO-3: a parent whose session had ended is recorded as not told", async () => {
    const gone = harness({ delivered: false });
    await gone.notify();
    const events = gone.log.filter(entry => entry[0] === "event").map(entry => entry[1]);
    assert.ok(events.includes("workflow.parent_notification_skipped"));
    assert.ok(!events.includes("workflow.parent_notified"));
    for (const delivered of [true, undefined]) {
        const told = harness({ delivered });
        await told.notify();
        assert.ok(told.log.some(entry => entry[0] === "event" && entry[1] === "workflow.parent_notified"), String(delivered));
    }
});
