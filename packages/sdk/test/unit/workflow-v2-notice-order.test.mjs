import test from "node:test";
import assert from "node:assert/strict";
import { registerWorkflowV2, WORKFLOW_V2_ACTIVITIES, WORKFLOW_V2_NOTICE_DELIVERY_WAIT_MS } from "../../dist/workflow/v2/runtime.js";

// Adversarial review WFO-1 (TLC parent.late-message, parent.late-request): a send's message or a request to the parent
// whose delivery attempt began before the run ended is queued before the run's end notice. The notifier activity waits
// (bounded) while such an attempt is in flight; no orchestration code changes.

const PARENT = "parent-1";
const RUN = { runId: "run-1", workflowSessionId: "wf-1", mode: "live", status: "completed", revision: 1, terminalOutcome: "succeeded",
    terminalNodeId: "done", terminalOutput: null, terminalError: null };

/**
 * The notifier activity over a fake store. `lock` is the run's notice lock: by default an in-memory one (an attempt that
 * finds it held gets { locked: false }); `recorded` answers runNoticeRecorded, in order of the calls.
 */
function harness({ inFlight = () => 0, waitMs, delivered, attempted = false, authorized = true, notifyParent = true, recorded = () => false,
    notifyGate = null, lock = null } = {}) {
    const activities = new Map();
    const log = [];
    const timeouts = [];
    let held = false;
    let recordedCalls = 0;
    const store = {
        readRun: async () => RUN,
        readDefinition: async () => ({ parentSessionId: PARENT, notifyParent }),
        runNoticeRecorded: async () => recorded(recordedCalls++),
        runNoticeAttempted: async () => attempted,
        readRevisionLabel: async () => ({ name: "w", semver: "1.0.0" }),
        runDeliveriesInFlight: async (runId, recipient, seconds, timeoutMs) => {
            log.push(["inFlight", runId, recipient, seconds]);
            timeouts.push(timeoutMs);
            return await inFlight();
        },
        withRunNoticeLock: lock ?? (async (runId, work) => {
            if (held) { log.push(["lock-held", runId]); return { locked: false }; }
            held = true;
            log.push(["lock", runId]);
            try { return { locked: true, value: await work() }; }
            finally { held = false; log.push(["unlock", runId]); }
        }),
        recordSessionEvents: async (_id, events) => { log.push(...events.map(event => ["event", event.eventType, event.data])); },
    };
    registerWorkflowV2({
        registerActivity: (name, fn) => activities.set(name, fn),
        registerOrchestrationVersioned: () => {},
    }, {
        store, catalog: {}, enabled: () => true,
        resolveToolBinding: async () => null, openToolExecutor: async () => { throw new Error("no tools"); },
        authorizeParentNotification: async () => authorized,
        notifyParent: async (parent, _prompt, _sender, clientMessageId) => {
            log.push(["notify", parent, clientMessageId]);
            if (notifyGate) await notifyGate;
            return delivered === undefined ? undefined : { delivered };
        },
        deleteSession: async () => {},
        ...(waitMs !== undefined ? { noticeDeliveryWaitMs: waitMs } : {}),
    });
    const notify = () => activities.get(WORKFLOW_V2_ACTIVITIES.notifyParent)({}, { runId: RUN.runId });
    return { notify, log, timeouts };
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
    // Within the notifier activity's 30-second attempt budget (verification of WFO-1).
    assert.equal(WORKFLOW_V2_NOTICE_DELIVERY_WAIT_MS, 15_000);
    const h = harness({ inFlight: () => 1, waitMs: 500 });
    const started = Date.now();
    await h.notify();
    assert.ok(Date.now() - started < 3_000);
    assert.ok(h.log.some(entry => entry[0] === "notify"));
});

test("verification of WFO-1: the deadline is checked before each look, and each look's timeout is within what is left", async () => {
    const h = harness({ inFlight: () => new Promise(resolve => setTimeout(() => resolve(1), 300)), waitMs: 500 });
    const started = Date.now();
    await h.notify();
    assert.ok(Date.now() - started < 2_000);
    assert.ok(h.log.filter(entry => entry[0] === "inFlight").length <= 2, "no look starts after the deadline");
    assert.ok(h.timeouts.every(timeout => Number.isInteger(timeout) && timeout >= 1 && timeout <= 500), JSON.stringify(h.timeouts));
    assert.ok(h.log.some(entry => entry[0] === "notify"));
    // Each look's timeout is at most 2 seconds, however long the wait.
    const long = harness({ inFlight: () => 0, waitMs: 60_000 });
    await long.notify();
    assert.deepEqual(long.timeouts, [2_000]);
});

test("notifications off: no wait for deliveries; the skip is recorded under the run's notice lock", async () => {
    const h = harness({ notifyParent: false, inFlight: () => 1 });
    await h.notify();
    assert.deepEqual(h.log.map(entry => entry[0] === "event" ? `event:${entry[1]}` : entry[0]),
        ["lock", "event:workflow.parent_notification_skipped", "unlock"]);
    assert.deepEqual(h.log[1][2], { runId: "run-1", reason: "notifications are off" });
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

// Adversarial review WFO-4 (TLC parent.skip-after-given): the attempt is recorded before the enqueue, and a retry after
// an attempt that may have queued the notice never records a skip.
const eventsOf = h => h.log.filter(entry => entry[0] === "event");

test("WFO-4: the first attempt records workflow.parent_notifying, with the client message id, before it queues", async () => {
    const h = harness();
    await h.notify();
    const notifying = h.log.findIndex(entry => entry[0] === "event" && entry[1] === "workflow.parent_notifying");
    assert.ok(notifying >= 0 && notifying < h.log.findIndex(entry => entry[0] === "notify"));
    assert.deepEqual(h.log[notifying][2], { runId: "run-1", parentSessionId: PARENT, clientMessageId: "workflow:wf-1:run-1:terminal" });
    assert.deepEqual(eventsOf(h).map(entry => entry[1]), ["workflow.parent_notifying", "workflow.parent_notified"]);
});

test("D-R1 (D-T7): a retry after an attempt that may have queued it records a known refusal as a skip that says so, never as told", async () => {
    for (const [options, reason, queued] of [
        [{ notifyParent: false }, "notifications are off", 0],
        [{ authorized: false }, "parent is gone", 0],
        [{ delivered: false }, "parent is gone", 1],
    ]) {
        const h = harness({ attempted: true, ...options });
        await h.notify();
        assert.deepEqual(eventsOf(h).map(entry => [entry[1], entry[2]]),
            [["workflow.parent_notification_skipped", { runId: "run-1", reason, earlierAttempt: true }]], JSON.stringify(options));
        assert.equal(h.log.filter(entry => entry[0] === "notify").length, queued, JSON.stringify(options));
    }
    // Without an earlier attempt, the same skip does not say so.
    const fresh = harness({ authorized: false });
    await fresh.notify();
    assert.deepEqual(eventsOf(fresh).map(entry => [entry[1], entry[2]]), [["workflow.parent_notification_skipped", { runId: "run-1", reason: "parent is gone" }]]);
});

test("WFO-4: a retry that may tell the parent queues again with the same id, records no second marker, and records the notice as told by this attempt", async () => {
    const h = harness({ attempted: true });
    await h.notify();
    assert.deepEqual(eventsOf(h).map(entry => [entry[1], entry[2]]), [["workflow.parent_notified", { runId: "run-1", parentSessionId: PARENT }]]);
    assert.deepEqual(h.log.filter(entry => entry[0] === "notify"), [["notify", PARENT, "workflow:wf-1:run-1:terminal"]]);
});

// Verification of WFO-4 (D-T8): one attempt at a time per run. The read, the marker, the enqueue and the record run under
// the run's notice lock; an attempt that finds it held records nothing (the holder records).
test("D-T8: two notifiers of one run at once: one queues the notice and records it; the other records nothing", async () => {
    let release;
    const notifyGate = new Promise(resolve => { release = resolve; });
    const h = harness({ notifyGate });
    const first = h.notify();
    await new Promise(resolve => setTimeout(resolve, 20));
    await h.notify();
    assert.ok(h.log.some(entry => entry[0] === "lock-held"), "the second found the lock held");
    release();
    await first;
    assert.equal(h.log.filter(entry => entry[0] === "notify").length, 1);
    assert.deepEqual(eventsOf(h).map(entry => entry[1]), ["workflow.parent_notifying", "workflow.parent_notified"]);
});

test("D-T8: an attempt that gets the lock after another recorded the notice records nothing more", async () => {
    // Recorded when read again under the lock (another attempt held it and recorded meanwhile).
    const h = harness({ recorded: call => call > 0 });
    await h.notify();
    assert.deepEqual(h.log.filter(entry => entry[0] === "notify"), []);
    assert.deepEqual(eventsOf(h), []);
    // A lock held elsewhere (another worker): nothing is queued or recorded, and the activity ends.
    const elsewhere = harness({ lock: async () => ({ locked: false }) });
    assert.equal(await elsewhere.notify(), null);
    assert.deepEqual(elsewhere.log.filter(entry => entry[0] === "notify" || entry[0] === "event"), []);
});
