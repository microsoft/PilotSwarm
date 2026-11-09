import test from "node:test";
import assert from "node:assert/strict";
import {
    registerWorkflowV2, WORKFLOW_V2_ACTIVITIES, WORKFLOW_V2_COMMAND_READ_BATCH, WORKFLOW_V2_NOTICE_DELIVERY_WAIT_MS, WORKFLOW_V2_NOTICE_KEPT_AS_NOTE,
    WORKFLOW_V2_STORE_RETRY, workflowV2Effect,
} from "../../dist/workflow/v2/runtime.js";

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
function harness({ inFlight = () => 0, waitMs, delivered, notStarted = false, chatDefinition = null, attempted = false, authorized = true,
    notifyParent = true, recorded = () => false, notifyGate = null, lock = null, lockWaitMs } = {}) {
    const activities = new Map();
    const log = [];
    const timeouts = [];
    let held = false;
    let recordedCalls = 0;
    const store = {
        readRun: async () => RUN,
        readDefinition: async () => ({ parentSessionId: PARENT, notifyParent, chatDefinitionId: chatDefinition?.id ?? null,
            chatRevision: chatDefinition?.revision ?? null }),
        // Deployed check DS-2: the chat's notes (a notice kept for a chat that has not started yet).
        chat: { keepNote: async (...args) => { log.push(["note", ...args]); } },
        // R3-PA1: the note and its skip record, one write.
        keepNoticeAsNote: async ({ ownerSessionId, definitionId, revision, text, projection }) => {
            log.push(["note", ownerSessionId, definitionId, revision, text]);
            for (const event of projection.events ?? []) log.push(["event", event.eventType, event.data]);
        },
        // Recorded by this test's choice, or by a notice event any attempt recorded.
        runNoticeRecorded: async () => recorded(recordedCalls++)
            || log.some(entry => entry[0] === "event" && ["workflow.parent_notified", "workflow.parent_notification_skipped"].includes(entry[1])),
        runNoticeAttempted: async () => attempted,
        readRevisionLabel: async () => ({ name: "w", semver: "1.0.0" }),
        runDeliveriesInFlight: async (runId, recipient, seconds, timeoutMs) => {
            log.push(["inFlight", runId, recipient, seconds]);
            timeouts.push(timeoutMs);
            return await inFlight();
        },
        // An in-memory lock: an attempt that finds it held tries again until its wait ends (E3-R1).
        withRunNoticeLock: lock ?? (async (runId, work, wait = {}) => {
            const until = Date.now() + (wait.waitMs ?? 0);
            while (held) {
                log.push(["lock-held", runId]);
                if (Date.now() > until) return { locked: false };
                await new Promise(resolve => setTimeout(resolve, 10));
            }
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
            return delivered === undefined ? undefined : { delivered, ...(notStarted ? { notStarted: true } : {}) };
        },
        deleteSession: async () => {},
        ...(waitMs !== undefined ? { noticeDeliveryWaitMs: waitMs } : {}),
        ...(lockWaitMs !== undefined ? { noticeLockWaitMs: lockWaitMs } : {}),
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

// Deployed check DS-2: a parent chat made without a first message has no session orchestration yet; the run's end is kept
// as a note its first turn reads (the chat is not woken), and the skip says so. An ended parent is still "parent is gone".
test("DS-2: a parent chat that has not started yet keeps the run's end as a note for its first turn", async () => {
    const kept = harness({ delivered: false, notStarted: true, chatDefinition: { id: "def-1", revision: 2 } });
    await kept.notify();
    const notes = kept.log.filter(entry => entry[0] === "note");
    assert.equal(notes.length, 1);
    assert.deepEqual(notes[0].slice(1, 4), [PARENT, "def-1", 2]);
    assert.match(notes[0][4], /run-1/);
    const events = kept.log.filter(entry => entry[0] === "event");
    assert.deepEqual(events.map(entry => entry[1]), ["workflow.parent_notifying", "workflow.parent_notification_skipped"]);
    assert.deepEqual(events[1][2], { runId: "run-1", reason: WORKFLOW_V2_NOTICE_KEPT_AS_NOTE });
    assert.equal(WORKFLOW_V2_NOTICE_KEPT_AS_NOTE, "the chat has not started yet; kept as a note for its first turn");
    // A Workflow that is no copy of a chat definition: the note names the Workflow and its run's revision.
    const plain = harness({ delivered: false, notStarted: true });
    await plain.notify();
    assert.deepEqual(plain.log.find(entry => entry[0] === "note").slice(1, 4), [PARENT, "wf-1", 1]);
    // An ended parent keeps no note.
    const gone = harness({ delivered: false });
    await gone.notify();
    assert.ok(!gone.log.some(entry => entry[0] === "note"));
    assert.equal(gone.log.find(entry => entry[0] === "event" && entry[1] === "workflow.parent_notification_skipped")[2].reason, "parent is gone");
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

// Verification of WFO-4 (D-T8) and of E3 (E3-R1): one attempt at a time per run. The read, the marker, the enqueue and the
// record run under the run's notice lock. An attempt that finds it held waits for it; under it, it reads again whether
// the notice was recorded. Still held after its wait, it fails, so that the activity is tried again: it never ends as if
// the notice were sent.
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
/** A lock another attempt holds while `holder.holds`; this attempt polls it within its wait. */
const heldElsewhere = holder => async (_runId, work, wait = {}) => {
    const until = Date.now() + (wait.waitMs ?? 0);
    while (holder.holds) {
        if (Date.now() > until) return { locked: false };
        await tick(10);
    }
    return { locked: true, value: await work() };
};

test("D-T8, E3-R1: two notifiers of one run at once: the second waits for the lock, then finds the notice recorded", async () => {
    let release;
    const notifyGate = new Promise(resolve => { release = resolve; });
    const h = harness({ notifyGate });
    const first = h.notify();
    await tick(20);
    const second = h.notify();
    await tick(50);
    assert.ok(h.log.some(entry => entry[0] === "lock-held"), "the second waits for the lock");
    release();
    assert.equal(await first, null);
    assert.equal(await second, null);
    assert.equal(h.log.filter(entry => entry[0] === "notify").length, 1);
    assert.deepEqual(eventsOf(h).map(entry => entry[1]), ["workflow.parent_notifying", "workflow.parent_notified"]);
});

test("D-T8: an attempt that gets the lock after another recorded the notice records nothing more", async () => {
    // Recorded when read again under the lock (another attempt held it and recorded meanwhile).
    const h = harness({ recorded: call => call > 0 });
    await h.notify();
    assert.deepEqual(h.log.filter(entry => entry[0] === "notify"), []);
    assert.deepEqual(eventsOf(h), []);
});

test("E3-R1: a lock held by an attempt that then fails: this attempt fails to be tried again, and the retry sends the notice once", async () => {
    const zombie = { holds: true };
    const h = harness({ lock: heldElsewhere(zombie), lockWaitMs: 100 });
    await assert.rejects(h.notify(), /being sent by another attempt; this attempt is tried again/);
    assert.deepEqual(h.log.filter(entry => entry[0] === "notify" || entry[0] === "event"), []);
    // The holder failed before its enqueue; its lock went with its connection. The activity's retry tells the parent.
    zombie.holds = false;
    assert.equal(await h.notify(), null);
    assert.equal(h.log.filter(entry => entry[0] === "notify").length, 1);
    assert.deepEqual(eventsOf(h).map(entry => entry[1]), ["workflow.parent_notifying", "workflow.parent_notified"]);
});

test("E3-R1: a lock held by an attempt that records the notice: this attempt waits, then returns without a second notice", async () => {
    const holder = { holds: true };
    const h = harness({ lock: heldElsewhere(holder) });
    const waiting = h.notify();
    await tick(40);
    // The holder told the parent and recorded it, then let the lock go.
    h.log.push(["event", "workflow.parent_notified", { runId: "run-1", parentSessionId: PARENT }]);
    holder.holds = false;
    assert.equal(await waiting, null);
    assert.equal(h.log.filter(entry => entry[0] === "notify").length, 0);
});

// Review DX-5: the 27 s budget bounds the attempt's voluntary waits (deliveries in flight, then the lock), not the attempt:
// getting a connection, the SQL calls and the send are not timed.
test("E3-R1, DX-5: the voluntary waits (deliveries in flight, the held lock) end within their budget", async () => {
    // A lock that stays held: the attempt fails within its own wait, not later.
    const h = harness({ lock: heldElsewhere({ holds: true }), lockWaitMs: 200 });
    const started = Date.now();
    await assert.rejects(h.notify(), /another attempt/);
    assert.ok(Date.now() - started < 2_000);
});

// Owed D-T9's finding (parent decision store-retry-timeout): duroxide 0.1.32's with_total_timeout is an alias of
// with_timeout, and duroxide-node 0.2.4 applies it after timeoutMs, so a totalTimeoutMs replaced the 30 s per-attempt
// timeout of the store activities. The policy has none: each 1.8.0 attempt is timed out at 30 s, and the notice's waits
// fit in that.
test("the store activities' retry policy times each attempt out at 30 s and sets no total timeout (a duroxide alias of it)", () => {
    assert.equal(WORKFLOW_V2_STORE_RETRY.timeoutMs, 30_000);
    assert.equal(Object.hasOwn(WORKFLOW_V2_STORE_RETRY, "totalTimeoutMs"), false);
    assert.ok(WORKFLOW_V2_NOTICE_DELIVERY_WAIT_MS < WORKFLOW_V2_STORE_RETRY.timeoutMs);
});

// Duroxide review DX-RECORD, V-1: the 1.8.0 effect orchestration stores the script's result and wakes its controller as
// ordinary activities with no attempt timeout (duroxide-node 0.2.4's typed retry policy requires one), retried after an
// error on its own durable timers, as often as the store activities' (5 attempts). DX-2: a read of the command queue takes
// fewer messages in a row than duroxide's 100 per turn.
test("DX-RECORD, V-1, DX-2: the effect's record and wake are timeout-free activities retried on durable timers; a command read takes at most 32 messages", () => {
    const ctx = {
        scheduleActivityTyped: (name, input) => ({ kind: "activity", name, input }),
        scheduleActivityWithRetryTyped: (name, input, policy) => ({ kind: "retry", name, input, policy }),
        scheduleTimer: ms => ({ kind: "timer", ms }),
    };
    const input = { runId: "run-1", nodeExecutionId: "nx-1", controllerInstanceId: "session-wf" };
    /** Drive the generator: `answer(task)` returns { value } or { error }; every task it yielded, in order. */
    const drive = answer => {
        const gen = workflowV2Effect(ctx, input);
        const tasks = [];
        let step = gen.next();
        while (!step.done) {
            tasks.push(step.value);
            const reply = answer(step.value, tasks);
            step = "error" in reply ? gen.throw(reply.error) : gen.next(reply.value);
        }
        return { tasks, result: step.value };
    };
    const ran = { kind: "result", result: { outcome: "ok", resultKind: "business", valueText: "{}", winner: "effect" } };
    // The record fails twice, then is stored; the wake is sent at once.
    let failures = 2;
    const ok = drive(task => (task.kind === "activity" && task.name === WORKFLOW_V2_ACTIVITIES.recordEffectResult && failures-- > 0
        ? { error: new Error("store unavailable") } : { value: task.name === WORKFLOW_V2_ACTIVITIES.runScript ? ran : null }));
    assert.equal(ok.result, null);
    assert.deepEqual(ok.tasks.map(task => task.kind === "timer" ? ["timer", task.ms] : [task.kind, task.name]), [
        ["activity", WORKFLOW_V2_ACTIVITIES.runScript],
        ["activity", WORKFLOW_V2_ACTIVITIES.recordEffectResult], ["timer", 1_000],
        ["activity", WORKFLOW_V2_ACTIVITIES.recordEffectResult], ["timer", 2_000],
        ["activity", WORKFLOW_V2_ACTIVITIES.recordEffectResult],
        ["activity", WORKFLOW_V2_ACTIVITIES.wake],
    ]);
    assert.ok(ok.tasks.every(task => task.kind !== "retry"), "no retry policy, so no attempt timeout");
    assert.deepEqual(ok.tasks[1].input, { ...input, outcome: ran });
    // Every attempt fails: 5 attempts, 4 durable delays, then the last error ends the orchestration.
    assert.throws(() => drive(task => (task.name === WORKFLOW_V2_ACTIVITIES.recordEffectResult ? { error: new Error("store unavailable") }
        : { value: ran })), /store unavailable/);
    let attempts = 0;
    try {
        drive(task => {
            if (task.name !== WORKFLOW_V2_ACTIVITIES.recordEffectResult) return { value: ran };
            attempts += 1;
            return { error: new Error("store unavailable") };
        });
    } catch { /* the last error */ }
    assert.equal(attempts, WORKFLOW_V2_STORE_RETRY.maxAttempts);
    assert.equal(WORKFLOW_V2_COMMAND_READ_BATCH, 32);
});
