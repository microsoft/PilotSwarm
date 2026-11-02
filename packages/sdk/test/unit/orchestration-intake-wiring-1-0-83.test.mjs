/**
 * Orchestration 1.0.83, inactive: the durable intake wired into drain, the
 * pre-dispatch sweep, the wake, decide and the turn (intake-wiring.ts;
 * design docs/proposals/workflow-durable-intake.md 3, 5.3 to 5.5, 6.2 and
 * section 8, amendment 2). The real drain and decide generators are driven
 * against a fake durable context: every operation they yield is recorded
 * and answered by the test, as duroxide would answer it from history.
 *
 * - An enveloped copy takes the intake path only, in drain and in the sweep:
 *   claimed under a new claim id with the workflow-request capability tag,
 *   held, its canonical id in the duplicate window; never queued, never a
 *   child update; the sweep and a successful claim read no clock.
 * - A claim that fails waits as an unclaimed entry; drain races its due time
 *   (one clock read, one timer) and the wake retries it under the same claim
 *   id. With every waiting entry taken, the copy is claimed in mode refuse,
 *   and only that failing stops the execution.
 * - A tombstone is latched first, from its own ids, before the bounded cancel
 *   set evicts them or a stashed prompt consumes them (review of b92ff04b,
 *   P2-1), in drain and in the sweep, on a held and on an unclaimed copy
 *   (the formal trace of cancel-order r2); its held cancel is written on the
 *   wake, with no other stimulus.
 * - Drain races the queue before every wake, and a wake makes at most one
 *   intake activity call; a holder settle a claim decides is latched and
 *   made by a later wake: a queued command waits for one store write at most
 *   (P2-3). A failed write is due again at its doubled retry.
 * - The store's refusal, a malformed answer, a failure the activity marked
 *   as one no retry can fix, a write that cannot be routed and a broken
 *   invariant fail the execution visibly (the session is marked failed);
 *   none is retried (P2-2, P3-1). An unmarked failure is retried.
 * - An end whose answer was lost, then a late cancel: the cancel is recorded
 *   first, and the end made again with its flag.
 * - Turns (5.5): an invocation is formed and bound before the attempt that
 *   carries it, in the turn's own `intake` field of runTurnV5 with the
 *   workflow-request tag; the attempt's witness and outcome decide by the
 *   transition table; a sent invocation rides only its pending prompt's
 *   dispatch, never a turn that runs while that prompt is held, and ends
 *   interrupted only when another turn's retry replaces the prompt (review
 *   D-W2-1); a gate's park rides the next attempt but starts no turn; decide
 *   starts a turn for a ready invocation alone, and one per newly claimed
 *   item for a parked one.
 * - The retry of a thrown turn sends the thrown attempt's key, so it may
 *   adopt that attempt's saved result: it carries only what that attempt
 *   carried (the invocation its marker names, or none), nothing is formed
 *   for it, and decide starts no turn for the intake alone before it (review
 *   W2-WIT3). An adopted witness that says exposed (its attempt sent before
 *   it lost a racing commit) makes the invocation sent, never completed
 *   (W2-WIT4).
 * - Decision A1: a gate's park rides any otherwise eligible attempt, which
 *   the gates check again; a workspace retry command's wake carries it, and
 *   a refusal parks it again, unsent, with no turn of its own.
 * - Reviews O-W2-3 and O-W2-5: a held retry keeps its own retry count and
 *   thrown-turn key through interposed turns and continue-as-new; an
 *   unanswered arrival is carried by continue-as-new.
 * - The formal delta of 84840d8d (S1 to S5): every marker-setting path, the
 *   connection-closed retries and the lossy handoff included, continues as
 *   new before any dispatch, with the retry's own count and key; the lossy
 *   handoff's count 0 draws a new key (as 1.0.82 does); a dispatch without
 *   the held count and key fails visibly; a hydration give-up after a
 *   restored retry ends the invocation interrupted with nothing sent; an
 *   interposed turn's exhaustion or non-retryable failure changes only the
 *   session's own state, and a replacement clears the marker and the held
 *   record; an arrival flag with nothing to answer starts no turn and is
 *   consumed by the next carrying attempt. Q-W2-7 (pre-existing): a turn
 *   interposed before a thrown turn's retry sends the thrown turn's key and
 *   carries nothing.
 * - Decide's turn for the intake alone takes what drain gives a newly
 *   arrived prompt: the released timer's note and the buffered child digest,
 *   in its system context; the released wait resumes after it (6.2).
 * - Exposure protocol revision 2: each carrying attempt records its own
 *   attempt id in its scheduled input, and only the invocation's own retry
 *   says sentBefore; an attempt refused as possibly seen elsewhere ends its
 *   invocation (interrupted, or failed_indeterminate after a failure), never
 *   parked or retried, and the turn goes on without it; a refusal as settled
 *   fails the execution visibly; an unsent cancel answered exposed makes the
 *   invocation sent and ends it interrupted, the item's cancel named; an end
 *   asked as not_dispatched may be answered applied interrupted, and no
 *   other change is accepted.
 *
 * Run: node --test test/unit/orchestration-intake-wiring-1-0-83.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { INTERNAL_SYSTEM_TURN_PROMPT, createInitialState, deriveOptions } from "../../dist/orchestration_1_0_83/state.js";
import { appendToFifo, decide, drain } from "../../dist/orchestration_1_0_83/queue.js";
import { runLoop } from "../../dist/orchestration_1_0_83/runtime.js";
import { INTAKE_RECORDED_EVENT, intakeWantsTurn, runIntakeWake } from "../../dist/orchestration_1_0_83/intake-wiring.js";
import { intakeDueAtMs } from "../../dist/orchestration_1_0_83/intake-machine.js";
import { COPILOT_CONNECTION_CLOSED_MAX_RETRIES } from "../../dist/orchestration_1_0_83/utils.js";
import { TURN_CONTROL_CAPABILITY, WORKFLOW_REQUEST_CAPABILITY } from "../../dist/activity-routing.js";
import { createSessionProxy, registerActivities } from "../../dist/session-proxy.js";
import {
    INTAKE_MAX_TEXT_BYTES, IntakeShapeError, WORKFLOW_INTAKE_ACTIVITIES, composeIntakePrompt, intakeBoundItem, intakeEnvelopeClientMessageId,
    intakeItemBytes, parseIntakeTurnField,
} from "../../dist/workflow/v2/intake.js";

// ─── Fixtures ────────────────────────────────────────────────

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

const SESSION = "44444444-4444-4444-8444-444444444444";
const WF = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const NOW = 1_000_000;

const exchange = n => `nx-${sha256(`exchange-${n}`).slice(0, 40)}`;

function envelope(n) {
    return {
        v: 1, exchangeId: exchange(n), workflowSessionId: WF, runId: RUN, recipientSessionId: SESSION, contract: "Note@1",
        payloadSha256: sha256(`payload-${n}`), envelopeSha256: sha256(`envelope-${n}`),
    };
}

const canonical = n => intakeEnvelopeClientMessageId(envelope(n));
const textOf = n => `[SYSTEM: A workflow sent you a typed message.]\n{"n":${n}}`;

/** An accepted claim's item for exchange n under `claimId`, as the store returns it. */
function item(n, claimId) {
    const text = textOf(n);
    const ref = { exchangeId: exchange(n), claimId, textSha256: sha256(text), clientMessageId: canonical(n) };
    return { ...ref, text, itemBytes: intakeItemBytes(intakeBoundItem(ref, text)) };
}

/** A queued copy of exchange n: the legacy fields the intake path never reads, and the envelope. */
const copy = (n, extra = {}) => ({ prompt: `legacy text ${n}`, clientMessageIds: [`plain-${n}`], workflowIntake: envelope(n), ...extra });

const ok = result => ({ value: { ok: true, result } });
const accepted = (n, claimId, inserted = true) => ok({ result: "accepted", inserted, item: item(n, claimId) });
const outage = () => ({ throw: new Error("the workflow store is unavailable") });

/** A runtime of 1.0.83 with a fake durable context (a Map for KV), restored from `input` fields as a continue-as-new would. */
function makeRuntime(extraInput = {}) {
    const kv = new Map();
    const explicit = {
        getValue: key => kv.get(key),
        setValue: (key, value) => { kv.set(key, value); },
        clearValue: key => { kv.delete(key); },
        utcNow: () => ({ op: "utcNow" }),
        newGuid: () => ({ op: "newGuid" }),
        dequeueEvent: queue => ({ op: "dequeue", queue }),
        scheduleTimer: ms => ({ op: "timer", ms }),
        race: (...tasks) => ({ op: "race", tasks }),
        scheduleActivity: (name, input) => ({ op: "untagged", name, input, withTag: tag => ({ op: "activity", name, input, tag }) }),
        // A session activity (the turn, a hydrate): its name, input, affinity and, when routed, its tag.
        scheduleActivityOnSession: (name, input, affinity) => ({
            op: "session", name, input, affinity, withTag: tag => ({ op: "session", name, input, affinity, tag }),
        }),
        continueAsNewVersioned: (canInput, version) => ({ op: "continueAsNew", canInput, version }),
        traceInfo: () => {},
    };
    // A Proxy, so a context method the code calls that this test does not know is a no-op, not a crash in another place.
    const ctx = new Proxy(explicit, { get: (target, prop) => (prop in target ? target[prop] : () => undefined) });
    const input = { sessionId: SESSION, config: {}, ...extraInput };
    const options = deriveOptions(input);
    const named = {
        recordSessionEvent: (sessionId, events) => ({ op: "record", sessionId, events }),
        updateCmsState: (sessionId, status, message) => ({ op: "cms", sessionId, status, message }),
        loadKnowledgeIndex: () => ({ op: "knowledge" }),
    };
    // Any other manager activity is recorded by its name.
    const manager = new Proxy(named, {
        get: (target, prop) => (prop in target ? target[prop] : typeof prop === "symbol" ? undefined
            : (...args) => ({ op: "manager", method: prop, args })),
    });
    return {
        kv, ctx, input, options, state: createInitialState(input, options), versions: { currentVersion: "1.0.83", latestVersion: "1.0.83" },
        // The session proxy 1.0.83 builds: its turns go to runTurnV5 with the workflow-request tag.
        session: createSessionProxy(ctx, SESSION, "affinity", {}, "workflow-intake-v1"),
        manager,
    };
}

/**
 * Drive a generator to its end, answering each yielded operation with
 * `respond(op)`: `{ value }` is sent back, `{ throw }` thrown in, `{ stop }`
 * returns it. The operations are pushed to `ops` as they come, so a test can
 * read them after a throw. A drive of more than `maxSteps` operations fails.
 */
function drive(generator, respond, ops = [], maxSteps = 5_000) {
    let step = generator.next();
    while (!step.done) {
        const op = step.value;
        ops.push(op);
        assert.ok(ops.length <= maxSteps, "the drive does not end");
        const reply = respond(op) ?? {};
        if (reply.stop) {
            generator.return(undefined);
            return { ops, result: undefined };
        }
        step = Object.hasOwn(reply, "throw") ? generator.throw(reply.throw) : generator.next(reply.value);
    }
    return { ops, result: step.value };
}

/**
 * An answer for each kind of operation: queued messages for the dequeues and
 * races (a race with no message left is won by its timer, unless `onRace`
 * answers the n-th race itself), drawn ids, clock reads, and the intake
 * activities' answers by `activity(op)`.
 */
function responder({ messages = [], guids = [], clocks = [], activity = () => assert.fail("no activity expected"), afterSweep, onRace } = {}) {
    const queue = [...messages];
    const ids = [...guids];
    const times = [...clocks];
    let races = 0;
    return op => {
        if (afterSweep?.(op)) return { stop: true };
        switch (op.op) {
            case "dequeue":
                assert.ok(queue.length > 0, "a blocking dequeue with no message left");
                return { value: queue.shift() };
            case "race": {
                races += 1;
                const chosen = onRace?.(op, races);
                if (chosen !== undefined) return chosen;
                return { value: queue.length > 0 ? { index: 0, value: queue.shift() } : { index: 1 } };
            }
            case "newGuid":
                assert.ok(ids.length > 0, "an unexpected id");
                return { value: ids.shift() };
            case "utcNow":
                assert.ok(times.length > 0, "an unexpected clock read");
                return { value: times.shift() };
            case "activity":
                assert.equal(op.tag, WORKFLOW_REQUEST_CAPABILITY, `${op.name} is routed with the workflow-request tag`);
                return activity(op);
            case "record":
            case "cms":
            case "knowledge":
                return { value: undefined };
            default:
                return assert.fail(`unexpected ${JSON.stringify(op)}`);
        }
    };
}

const kinds = ops => ops.map(op => (op.op === "activity" ? `${op.name}:${op.input.op ?? op.input.mode}` : op.op));
const fifoItems = runtime => [...runtime.kv.entries()].filter(([key]) => key.startsWith("fifo.")).flatMap(([, value]) => JSON.parse(value));
const EMPTY_INTAKE = { queue: [], invocation: null, heldCancelRetry: null };

/** A carried intake state, as a continue-as-new input holds it. */
const carried = ({ queue = [], invocation = null, heldCancelRetry = null } = {}) => ({ v: 1, queue, invocation, heldCancelRetry });
const unclaimedEntry = (n, nextAttemptAtMs, cancel = false) => ({
    kind: "unclaimed", claimId: `claim-u${n}`, envelope: envelope(n), retry: { attempts: 1, nextAttemptAtMs }, cancel,
});

// ─── Turn fixtures ───────────────────────────────────────────

/** A carried held entry of exchange n under `claim-n`. */
function heldEntry(n, cancel = false) {
    const claimed = item(n, `claim-${n}`);
    return {
        kind: "held", exchangeId: claimed.exchangeId, claimId: claimed.claimId, textSha256: claimed.textSha256,
        clientMessageId: claimed.clientMessageId, itemBytes: claimed.itemBytes, cancel,
    };
}

/** The store's bind answer for exchanges `ns` under `claim-n`. */
const bindAnswer = ns => ok({
    bound: true,
    items: ns.map(n => {
        const claimed = item(n, `claim-${n}`);
        return { exchangeId: claimed.exchangeId, claimId: claimed.claimId, text: claimed.text, textSha256: claimed.textSha256 };
    }),
});

/** A carried bound invocation `inv-1` of exchanges `ns`: ready unless `fields` say otherwise. */
function boundInvocation(ns, fields = {}) {
    const claimed = ns.map(n => item(n, `claim-${n}`));
    return {
        invocationId: "inv-1",
        items: claimed.map(entry => ({
            exchangeId: entry.exchangeId, claimId: entry.claimId, textSha256: entry.textSha256, clientMessageId: entry.clientMessageId,
            text: entry.text, cancelRequested: false,
        })),
        itemBytes: claimed.map(entry => entry.itemBytes), bound: true, sent: false, parked: null, bindRetry: null, settle: null, cancelWrite: null,
        ...fields,
    };
}

/** The batch a turn of invocation `invocationId` carries for exchanges `ns`, under `claim-n` (its attempt's id and retry flag aside). */
const payloadOf = (ns, invocationId = "inv-1") => ({
    invocationId, items: ns.map(n => ({ exchangeId: exchange(n), claimId: `claim-${n}`, clientMessageId: canonical(n), text: textOf(n) })),
});
/** The whole `intake` field a turn carries (exposure protocol revision 2, section 2): the batch, the attempt's id and its retry flag. */
const fieldOf = (ns, { invocationId = "inv-1", attemptId = "att-1", sentBefore = false } = {}) => {
    const { items } = payloadOf(ns, invocationId);
    return { invocationId, attemptId, sentBefore, items };
};

/** A turn's result, with the attempt's witness when one is given. */
const turnResult = (result, witness) => ({ value: { ...result, ...(witness ? { intakeDispatch: witness } : {}) } });
const completed = witness => turnResult({ type: "completed", content: "done" }, witness);
const sentBy = (invocationId = "inv-1") => ({ invocationId, sent: true });
const notSentBy = (invocationId = "inv-1") => ({ invocationId, sent: false });

const isTurn = op => op?.op === "session" && op.name.startsWith("runTurn");
const turnsOf = ops => ops.filter(isTurn);

/**
 * A carrying turn's attempt (exposure protocol revision 2, section 2): its
 * `intake` field is checked whole (the batch, a drawn attempt id and a retry
 * flag, nothing else), then the attempt's id and flag are moved to
 * `input.intakeAttempt`, so the comparisons read the batch alone and a test
 * of the attempt reads them there. The recorded operation is the same object.
 */
function takeIntakeAttempt(op) {
    const field = op.input.intake;
    if (field === undefined || Object.hasOwn(op.input, "intakeAttempt")) return;
    assert.deepEqual(Object.keys(field), ["invocationId", "attemptId", "sentBefore", "items"]);
    assert.equal(typeof field.attemptId, "string");
    assert.ok(field.attemptId.length > 0);
    assert.equal(typeof field.sentBefore, "boolean");
    op.input.intakeAttempt = { attemptId: field.attemptId, sentBefore: field.sentBefore };
    op.input.intake = { invocationId: field.invocationId, items: field.items };
}

/**
 * An answer for every operation a turn yields: queued messages for the
 * dequeues and races (a race with none left is won by its timer, unless
 * `onRace` answers it), drawn ids (`guids`, then generated), a clock that
 * moves 1 ms each read, the intake activities by `activity(op)`, the turn
 * by `turn(op)`, any other session activity by `sessionActivity(op)`, an
 * empty child listing, and nothing for events, CMS updates, timers and the
 * other manager activities. A continue-as-new, a blocking dequeue with no
 * message left (the session waits for its next message), or an operation
 * `stop` picks, stops the drive.
 */
function turnResponder({
    messages = [], guids = [], activity = () => assert.fail("no intake activity expected"), turn = () => assert.fail("no turn expected"),
    sessionActivity = () => ({ value: undefined }), onRace, stop,
} = {}) {
    const queue = [...messages];
    const ids = [...guids];
    let clock = NOW;
    let generated = 0;
    let races = 0;
    return op => {
        if (stop?.(op)) return { stop: true };
        switch (op?.op) {
            case "dequeue":
                if (queue.length === 0) return { stop: true };
                return { value: queue.shift() };
            case "race": {
                races += 1;
                const chosen = onRace?.(op, races);
                if (chosen !== undefined) return chosen;
                return { value: queue.length > 0 ? { index: 0, value: queue.shift() } : { index: 1 } };
            }
            case "newGuid":
                generated += 1;
                return { value: ids.length > 0 ? ids.shift() : `guid-${generated}` };
            case "utcNow":
                clock += 1;
                return { value: clock };
            case "activity":
                assert.equal(op.tag, WORKFLOW_REQUEST_CAPABILITY, `${op.name} is routed with the workflow-request tag`);
                return activity(op);
            case "session":
                if (!isTurn(op)) return sessionActivity(op);
                takeIntakeAttempt(op);
                return turn(op);
            case "manager":
                return { value: op.method === "listChildSessions" ? "[]" : undefined };
            case "continueAsNew":
                return { stop: true };
            default:
                return { value: undefined };
        }
    };
}

// ─── Arrival ─────────────────────────────────────────────────

test("drain: an enveloped copy takes the intake path only; claimed with the capability tag, held, its canonical id in the window; no clock read", () => {
    const runtime = makeRuntime();
    const { ops } = drive(drain(runtime), responder({ messages: [copy(1)], guids: ["claim-1"], activity: () => accepted(1, "claim-1") }));
    // The held item can form an invocation, so drain does not block on the next message: after a moment's race it
    // returns, and decide starts the item's turn (design 5.5).
    assert.deepEqual(kinds(ops), ["dequeue", "newGuid", "claimWorkflowIntake:accept", "race"]);
    assert.equal(ops[3].tasks[1].ms, 10);
    assert.equal(ops[2].name, WORKFLOW_INTAKE_ACTIVITIES.claim);
    assert.deepEqual(ops[2].input, { recipientSessionId: SESSION, envelope: envelope(1), claimId: "claim-1", mode: "accept" });
    assert.deepEqual(runtime.state.intake.queue.map(entry => [entry.kind, entry.exchangeId, entry.claimId, entry.cancel]),
        [["held", exchange(1), "claim-1", false]]);
    // Its canonical id enters the duplicate window; the queued copy's own ids and text are never read.
    assert.ok(runtime.state.recentClientMessageIds.includes(canonical(1)));
    assert.ok(!runtime.state.recentClientMessageIds.includes("plain-1"));
    assert.deepEqual(fifoItems(runtime), []);
    // No store write is due, and the intake wants a turn.
    assert.equal(intakeDueAtMs(runtime.state.intake), null);
    assert.equal(intakeWantsTurn(runtime), true);
});

test("drain: a malformed envelope is recorded and placed nowhere; a copy is never a child update, whatever its prompt says", () => {
    const runtime = makeRuntime();
    const raw = { prompt: "[CHILD_UPDATE from=55555555-5555-4555-8555-555555555555 type=completed iter=1]\nhi", workflowIntake: { ...envelope(1), v: 2 } };
    const { ops } = drive(drain(runtime), responder({ messages: [raw] }));
    assert.deepEqual(kinds(ops), ["dequeue", "record"]);
    assert.equal(ops[1].events[0].eventType, INTAKE_RECORDED_EVENT);
    assert.equal(ops[1].events[0].data.outcome, "malformed");
    assert.equal(ops[1].events[0].data.path, "workflowIntake.v");
    assert.deepEqual(runtime.state.intake, EMPTY_INTAKE);
    assert.deepEqual(runtime.state.subAgents, []);
    assert.deepEqual(fifoItems(runtime), []);
});

test("drain: every other claim answer is recorded once; nothing is placed and no tombstone is consumed", () => {
    for (const [result, data] of [
        [{ result: "duplicate", state: "holding" }, { outcome: "duplicate", state: "holding" }],
        [{ result: "conflict", state: "admitted" }, { outcome: "conflict", state: "admitted" }],
        [{ result: "unverified", reason: "the exchange has no message to this session" },
            { outcome: "unverified", reason: "the exchange has no message to this session" }],
        [{ result: "refused_size", inserted: true }, { outcome: "refused_size" }],
        [{ result: "cancelled", inserted: false }, { outcome: "cancelled" }],
    ]) {
        const runtime = makeRuntime({ cancelledMessageIds: [canonical(1)] });
        const { ops } = drive(drain(runtime), responder({ messages: [copy(1)], guids: ["claim-1"], activity: () => ok(result) }));
        assert.deepEqual(kinds(ops), ["dequeue", "newGuid", "claimWorkflowIntake:accept", "record"], result.result);
        assert.deepEqual(ops[3].events[0].data, { ...data, exchangeId: exchange(1), claimId: "claim-1", source: "drain" }, result.result);
        assert.deepEqual(runtime.state.intake, EMPTY_INTAKE, result.result);
        assert.ok(runtime.state.cancelledMessageIds.has(canonical(1)), result.result);
        assert.ok(!runtime.state.recentClientMessageIds.includes(canonical(1)), result.result);
    }
});

test("drain: a copy a tombstone names is claimed and its cancel latched; the next wake, after a race, settles it; the decision holds until made", () => {
    const runtime = makeRuntime({ cancelledMessageIds: [canonical(1)] });
    const { ops } = drive(drain(runtime), responder({
        messages: [copy(1)], guids: ["claim-1"], clocks: [NOW],
        activity: op => (op.name === WORKFLOW_INTAKE_ACTIVITIES.claim ? accepted(1, "claim-1")
            : ok({ items: [{ exchangeId: exchange(1), cancelled: true }] })),
    }));
    assert.deepEqual(kinds(ops), ["dequeue", "newGuid", "claimWorkflowIntake:accept", "utcNow", "race", "settleWorkflowIntake:cancel_held", "record"]);
    // The settle is the next wake's one write, after a moment's race the queue could have won.
    assert.deepEqual(ops[4].tasks.map(task => task.op), ["dequeue", "timer"]);
    assert.equal(ops[4].tasks[1].ms, 10);
    assert.deepEqual(ops[5].input, { op: "cancel_held", recipientSessionId: SESSION, items: [{ exchangeId: exchange(1), claimId: "claim-1" }] });
    assert.deepEqual(ops[6].events[0].data, { outcome: "cancelled", exchangeId: exchange(1), claimId: "claim-1", source: "wake" });
    assert.deepEqual(runtime.state.intake, EMPTY_INTAKE);

    // The settle fails: the settling entry keeps the decision, due at its retry, whatever the tombstones say later.
    const failing = makeRuntime({ cancelledMessageIds: [canonical(1)] });
    let races = 0;
    const failed = drive(drain(failing), responder({
        messages: [copy(1)], guids: ["claim-1"], clocks: [NOW, NOW + 1_000, NOW + 2_000],
        activity: op => (op.name === WORKFLOW_INTAKE_ACTIVITIES.claim ? accepted(1, "claim-1") : outage()),
        // Stop when drain races the settle's next due time.
        afterSweep: op => op.op === "race" && ++races === 2,
    }));
    assert.deepEqual(kinds(failed.ops), [
        "dequeue", "newGuid", "claimWorkflowIntake:accept", "utcNow", "race", "settleWorkflowIntake:cancel_held", "utcNow", "utcNow", "race",
    ]);
    assert.deepEqual(failing.state.intake.queue, [{
        kind: "settling", exchangeId: exchange(1), claimId: "claim-1", outcome: "cancelled", retry: { attempts: 1, nextAttemptAtMs: NOW + 31_000 },
    }]);
    assert.equal(failed.ops[8].tasks[1].ms, 29_000);
});

test("drain: a failed claim waits; drain races its due time and the wake claims it again under the same claim id", () => {
    const runtime = makeRuntime();
    let claims = 0;
    const { ops } = drive(drain(runtime), responder({
        messages: [copy(1)], guids: ["claim-1"], clocks: [NOW, NOW + 1_000],
        activity: () => (++claims === 1 ? outage() : accepted(1, "claim-1", false)),
    }));
    // The failure reads the clock once; the race reads it once and arms one timer for the remaining time. Held, the item
    // wants a turn: drain returns after a moment's race.
    assert.deepEqual(kinds(ops), ["dequeue", "newGuid", "claimWorkflowIntake:accept", "utcNow", "utcNow", "race", "claimWorkflowIntake:accept", "race"]);
    assert.deepEqual(ops[5].tasks.map(task => task.op), ["dequeue", "timer"]);
    assert.equal(ops[5].tasks[1].ms, 29_000);
    assert.deepEqual(ops[6].input, ops[2].input);
    assert.deepEqual(runtime.state.intake.queue.map(entry => [entry.kind, entry.claimId]), [["held", "claim-1"]]);
    assert.equal(intakeDueAtMs(runtime.state.intake), null);
});

test("drain: a message that wins the race is handled first; the waiting claim stays due", () => {
    const runtime = makeRuntime({ intake: carried({ queue: [unclaimedEntry(1, NOW + 60_000)] }) });
    let clockReads = 0;
    const { ops } = drive(drain(runtime), responder({
        messages: [copy(2)], guids: ["claim-2"], clocks: [NOW],
        activity: () => accepted(2, "claim-2"),
        // Stop when drain reads the clock again to race the waiting claim's due time.
        afterSweep: op => op.op === "utcNow" && ++clockReads === 2,
    }));
    assert.deepEqual(kinds(ops), ["utcNow", "race", "newGuid", "claimWorkflowIntake:accept", "utcNow"]);
    assert.equal(ops[1].tasks[1].ms, 60_000);
    assert.deepEqual(runtime.state.intake.queue.map(entry => [entry.kind, entry.claimId]), [["unclaimed", "claim-u1"], ["held", "claim-2"]]);
    assert.equal(intakeDueAtMs(runtime.state.intake), NOW + 60_000);
});

test("with every waiting entry taken, a failed claim is claimed again in mode refuse; only that failing stops the execution, visibly", () => {
    const runtime = makeRuntime({ intake: carried({ queue: range(1, 8).map(n => unclaimedEntry(n, NOW + 60_000)) }) });
    const ops = [];
    assert.throws(() => drive(drain(runtime), responder({
        messages: [copy(9)], guids: ["claim-9"], clocks: [NOW, NOW + 1, NOW + 2], activity: outage,
    }), ops), error => error.code === "WORKFLOW_INTAKE_FAIL_STOP" && error.exchangeId === exchange(9));
    assert.deepEqual(kinds(ops), ["utcNow", "race", "newGuid", "claimWorkflowIntake:accept", "utcNow", "claimWorkflowIntake:refuse", "utcNow", "cms"]);
    assert.deepEqual(ops[5].input, { ...ops[3].input, mode: "refuse" });
    assert.equal(ops[7].status, "failed");
    assert.match(ops[7].message, /every waiting intake entry is taken/);

    // The refuse claim answered (a new row refused_full): recorded, and the execution goes on with its 8 waiting copies.
    const answered = makeRuntime({ intake: carried({ queue: range(1, 8).map(n => unclaimedEntry(n, NOW + 60_000)) }) });
    let calls = 0;
    let races = 0;
    const refused = drive(drain(answered), responder({
        messages: [copy(9)], guids: ["claim-9"], clocks: [NOW, NOW + 1, NOW + 2],
        activity: () => (++calls === 1 ? outage() : ok({ result: "refused_full", inserted: true })),
        afterSweep: op => op.op === "race" && ++races === 2,
    }));
    assert.deepEqual(kinds(refused.ops), [
        "utcNow", "race", "newGuid", "claimWorkflowIntake:accept", "utcNow", "claimWorkflowIntake:refuse", "record", "utcNow", "race",
    ]);
    assert.deepEqual(refused.ops[6].events[0].data, { outcome: "refused_full", exchangeId: exchange(9), claimId: "claim-9", source: "drain" });
    assert.deepEqual(answered.state.intake.queue.map(entry => entry.claimId), range(1, 8).map(n => `claim-u${n}`));
});

test("the store's refusal, a malformed answer or a broken invariant fails the execution visibly and is never retried", () => {
    for (const [name, answer, check] of [
        ["refusal", { value: { ok: false, error: { code: "WORKFLOW_STORE_CORRUPT", message: "its row is under another recipient" } } },
            error => error.code === "WORKFLOW_INTAKE_BROKEN" && /refused claimWorkflowIntake \(WORKFLOW_STORE_CORRUPT\)/.test(error.message)],
        ["malformed answer", { value: { ok: "yes" } }, error => error.code === "WORKFLOW_INTAKE_INVALID" && error.path === "claimWorkflowIntake.ok"],
        ["not JSON", { value: "{" }, error => error.code === "WORKFLOW_INTAKE_INVALID"],
        ["another claim's item", ok({ result: "accepted", inserted: true, item: item(1, "claim-9") }), error => error.code === "WORKFLOW_INTAKE_BROKEN"],
    ]) {
        const runtime = makeRuntime();
        const ops = [];
        assert.throws(() => drive(drain(runtime), responder({ messages: [copy(1)], guids: ["claim-1"], activity: () => answer }), ops), check, name);
        assert.deepEqual(kinds(ops), ["dequeue", "newGuid", "claimWorkflowIntake:accept", "cms"], name);
        assert.equal(ops[3].status, "failed", name);
        assert.deepEqual(runtime.state.intake, EMPTY_INTAKE, name);
    }
});

// ─── Tombstones and the wake ─────────────────────────────────

test("a tombstone is latched at once; its held cancel is written on the wake, after a race, with no other stimulus, and recorded", () => {
    const runtime = makeRuntime();
    drive(drain(runtime), responder({ messages: [copy(1)], guids: ["claim-1"], activity: () => accepted(1, "claim-1") }));
    const { ops } = drive(drain(runtime), responder({
        messages: [{ cancelPending: [canonical(1)] }], clocks: [NOW],
        activity: () => ok({ items: [{ exchangeId: exchange(1), cancelled: true }] }),
    }));
    // The held item wants a turn, so drain races the queue instead of blocking on it (design 5.5); the tombstone wins.
    assert.deepEqual(kinds(ops), ["race", "utcNow", "race", "settleWorkflowIntake:cancel_held", "record"]);
    assert.deepEqual(ops[3].input, { op: "cancel_held", recipientSessionId: SESSION, items: [{ exchangeId: exchange(1), claimId: "claim-1" }] });
    assert.deepEqual(ops[4].events[0].data, { outcome: "cancelled", source: "held", items: [{ exchangeId: exchange(1), claimId: "claim-1" }] });
    assert.deepEqual(runtime.state.intake, EMPTY_INTAKE);
    // The tombstone is not consumed: it leaves the bounded cancel set as any other does.
    assert.ok(runtime.state.cancelledMessageIds.has(canonical(1)));

    // The write fails: the latch stays, and the write is due 30 s after the failure, raced by drain.
    const failing = makeRuntime();
    drive(drain(failing), responder({ messages: [copy(1)], guids: ["claim-1"], activity: () => accepted(1, "claim-1") }));
    let races = 0;
    const failed = drive(drain(failing), responder({
        messages: [{ cancelPending: [canonical(1)] }], clocks: [NOW, NOW + 500, NOW + 1_000], activity: outage,
        afterSweep: op => op.op === "race" && ++races === 3,
    }));
    assert.deepEqual(kinds(failed.ops), ["race", "utcNow", "race", "settleWorkflowIntake:cancel_held", "utcNow", "utcNow", "race"]);
    assert.equal(failing.state.intake.queue[0].cancel, true);
    assert.deepEqual(failing.state.intake.heldCancelRetry, { attempts: 1, nextAttemptAtMs: NOW + 500 + 30_000 });
    assert.equal(failed.ops[6].tasks[1].ms, 29_500);
});

test("the wake makes the due writes in order, one intake activity call per wake, each after a race: claims and holder settles oldest first, the held cancels, then the invocation's end", () => {
    const four = item(4, "claim-4");
    const invocation = {
        invocationId: "inv-1",
        items: [{ exchangeId: four.exchangeId, claimId: four.claimId, textSha256: four.textSha256, clientMessageId: four.clientMessageId, text: four.text, cancelRequested: false }],
        itemBytes: [four.itemBytes], bound: true, sent: true, parked: null, bindRetry: null,
        settle: { outcome: "completed", retry: { attempts: 1, nextAttemptAtMs: NOW } }, cancelWrite: null,
    };
    const three = item(3, "claim-3");
    const held = { kind: "held", exchangeId: three.exchangeId, claimId: three.claimId, textSha256: three.textSha256, clientMessageId: three.clientMessageId,
        itemBytes: three.itemBytes, cancel: true };
    const runtime = makeRuntime({
        intake: carried({
            queue: [
                unclaimedEntry(1, NOW),
                { kind: "settling", exchangeId: exchange(2), claimId: "claim-s2", outcome: "cancelled", retry: { attempts: 1, nextAttemptAtMs: NOW } },
                held,
            ],
            invocation, heldCancelRetry: { attempts: 2, nextAttemptAtMs: NOW },
        }),
    });
    const answers = {
        claim: () => accepted(1, "claim-u1", false),
        cancel_held: op => ok({ items: op.input.items.map(entry => ({ exchangeId: entry.exchangeId, cancelled: true })) }),
        end: () => ok({ ended: true }),
    };
    const { ops } = drive(drain(runtime), responder({
        clocks: [NOW, NOW + 1, NOW + 2, NOW + 3], activity: op => (op.name === WORKFLOW_INTAKE_ACTIVITIES.claim ? answers.claim() : answers[op.input.op](op)),
    }));
    assert.deepEqual(kinds(ops), [
        "utcNow", "race", "claimWorkflowIntake:accept",
        "utcNow", "race", "settleWorkflowIntake:cancel_held", "record",
        "utcNow", "race", "settleWorkflowIntake:cancel_held", "record",
        "utcNow", "race", "settleWorkflowIntake:end",
        // The end cleared the invocation, so the held item can form the next one: drain races the queue and returns.
        "race",
    ]);
    assert.equal(ops[2].input.claimId, "claim-u1");
    assert.deepEqual(ops[5].input.items, [{ exchangeId: exchange(2), claimId: "claim-s2" }]);
    assert.deepEqual(ops[9].input.items, [{ exchangeId: exchange(3), claimId: "claim-3" }]);
    assert.deepEqual(ops[13].input, {
        op: "end", recipientSessionId: SESSION, invocationId: "inv-1", outcome: "completed",
        items: [{ exchangeId: exchange(4), claimId: "claim-4", cancelRequested: false }],
    });
    assert.deepEqual(runtime.state.intake.queue.map(entry => [entry.kind, entry.claimId]), [["held", "claim-u1"]]);
    assert.equal(runtime.state.intake.invocation, null);
    assert.equal(runtime.state.intake.heldCancelRetry, null);
});

test("the wake writes a bound invocation's latched cancels for exactly the items its call named; an answer naming other items fails the execution visibly", () => {
    const items = [1, 2].map(n => item(n, `claim-${n}`));
    const invocation = {
        invocationId: "inv-1",
        items: items.map((entry, index) => ({
            exchangeId: entry.exchangeId, claimId: entry.claimId, textSha256: entry.textSha256, clientMessageId: entry.clientMessageId,
            text: entry.text, cancelRequested: index === 0,
        })),
        itemBytes: items.map(entry => entry.itemBytes), bound: true, sent: false, parked: null, bindRetry: null, settle: null,
        cancelWrite: { retry: null },
    };
    const runtime = makeRuntime({ intake: carried({ invocation }) });
    const { ops } = drive(runIntakeWake(runtime, NOW), responder({
        activity: op => ok({ items: op.input.items.map(entry => ({ exchangeId: entry.exchangeId, settled: true })) }),
    }));
    assert.deepEqual(kinds(ops), ["settleWorkflowIntake:cancel_unsent", "record"]);
    assert.deepEqual(ops[0].input, { op: "cancel_unsent", recipientSessionId: SESSION, invocationId: "inv-1", items: [{ exchangeId: exchange(1), claimId: "claim-1" }] });
    assert.deepEqual(runtime.state.intake.invocation.items.map(entry => entry.exchangeId), [exchange(2)]);
    assert.equal(runtime.state.intake.invocation.cancelWrite, null);
    // An answer that names other items is a broken invariant: the execution fails visibly.
    const wrong = makeRuntime({ intake: carried({ invocation }) });
    const wrongOps = [];
    assert.throws(() => drive(runIntakeWake(wrong, NOW), responder({ activity: () => ok({ items: [{ exchangeId: exchange(2), settled: true }] }) }), wrongOps),
        error => error.code === "WORKFLOW_INTAKE_BROKEN");
    assert.deepEqual(kinds(wrongOps), ["settleWorkflowIntake:cancel_unsent", "cms"]);
});

test("exposure r2: an unsent invocation's cancel answered exposed is recorded as requested; the invocation is possibly sent, ends interrupted with the item's flag, and is never carried again", () => {
    const invocation = boundInvocation([1, 2]);
    invocation.items[0].cancelRequested = true;
    invocation.cancelWrite = { retry: null };
    const runtime = makeRuntime({ intake: carried({ invocation }) });
    const writes = [];
    const { ops } = drive(runIntakeWake(runtime, NOW), responder({
        activity: op => {
            writes.push(op.input);
            return op.input.op === "cancel_unsent" ? ok({ items: [{ exchangeId: exchange(1), exposed: true }] }) : assert.fail(`unexpected ${op.input.op}`);
        },
    }));
    assert.deepEqual(kinds(ops), ["settleWorkflowIntake:cancel_unsent", "record"]);
    const recorded = ops.find(op => op.op === "record").events[0];
    assert.deepEqual(recorded, { eventType: INTAKE_RECORDED_EVENT, data: {
        outcome: "cancelled", source: "invocation", invocationId: "inv-1", items: [{ exchangeId: exchange(1), claimId: "claim-1" }], exposed: [exchange(1)],
    } });
    const after = runtime.state.intake.invocation;
    assert.equal(after.sent, true);
    assert.deepEqual(after.settle, { outcome: "interrupted", retry: null });
    assert.deepEqual(after.items.map(entry => [entry.exchangeId, entry.cancelRequested]), [[exchange(1), true], [exchange(2), false]]);
    assert.equal(intakeWantsTurn(runtime), false);
    // The next wake ends it interrupted, naming the item's cancel.
    const next = drive(runIntakeWake(runtime, NOW + 1), responder({ activity: op => (writes.push(op.input), ok({ ended: true })) }));
    assert.deepEqual(kinds(next.ops), ["settleWorkflowIntake:end"]);
    assert.deepEqual(writes.at(-1), {
        op: "end", recipientSessionId: SESSION, invocationId: "inv-1", outcome: "interrupted",
        items: [{ exchangeId: exchange(1), claimId: "claim-1", cancelRequested: true }, { exchangeId: exchange(2), claimId: "claim-2", cancelRequested: false }],
    });
    assert.equal(runtime.state.intake.invocation, null);
    // An answer exposed for an item the write did not name, or on a sent invocation's request_cancel, fails visibly. The sent
    // invocation is a legitimate one: possibly sent and ending interrupted, its latched cancel's write (request_cancel) due
    // before its end.
    for (const [sent, answer] of [
        [false, ok({ items: [{ exchangeId: exchange(1), exposed: false }] })],
        [true, ok({ items: [{ exchangeId: exchange(1), exposed: true }] })],
    ]) {
        const restored = sent ? { ...invocation, sent: true, settle: { outcome: "interrupted", retry: null } } : invocation;
        const wrong = makeRuntime({ intake: carried({ invocation: restored }) });
        const wrongOps = [];
        assert.throws(() => drive(runIntakeWake(wrong, NOW), responder({ activity: () => answer }), wrongOps),
            error => error.code === "WORKFLOW_INTAKE_INVALID" || error.code === "WORKFLOW_INTAKE_BROKEN", JSON.stringify([sent, answer]));
        assert.equal(kinds(wrongOps)[0], sent ? "settleWorkflowIntake:request_cancel" : "settleWorkflowIntake:cancel_unsent", JSON.stringify([sent, answer]));
        assert.equal(wrongOps.at(-1).op, "cms");
    }
});

test("exposure r2: an end asked as not_dispatched and answered as applied interrupted is accepted after its call is checked; any other applied outcome fails visibly", () => {
    const ending = boundInvocation([1], { settle: { outcome: "not_dispatched", retry: null } });
    const runtime = makeRuntime({ intake: carried({ invocation: ending }) });
    const { ops } = drive(runIntakeWake(runtime, NOW), responder({ activity: () => ok({ ended: true, outcome: "interrupted" }) }));
    assert.deepEqual(kinds(ops), ["settleWorkflowIntake:end", "record"]);
    assert.equal(ops[0].input.outcome, "not_dispatched");
    assert.deepEqual(ops[1].events[0].data, { outcome: "end_applied", invocationId: "inv-1", requested: "not_dispatched", applied: "interrupted" });
    assert.equal(runtime.state.intake.invocation, null);
    for (const [invocation, answer] of [
        [ending, ok({ ended: true, outcome: "completed" })],
        [boundInvocation([1], { sent: true, settle: { outcome: "interrupted", retry: null } }), ok({ ended: true, outcome: "interrupted" })],
        [ending, ok({ ended: true, outcome: "interrupted", extra: 1 })],
    ]) {
        const wrong = makeRuntime({ intake: carried({ invocation }) });
        const wrongOps = [];
        assert.throws(() => drive(runIntakeWake(wrong, NOW), responder({ activity: () => answer }), wrongOps),
            error => error.code === "WORKFLOW_INTAKE_BROKEN" || error.code === "WORKFLOW_INTAKE_INVALID", JSON.stringify(answer));
        assert.equal(wrongOps.at(-1).op, "cms");
        assert.notEqual(wrong.state.intake.invocation, null);
    }
});

// ─── The sweep ───────────────────────────────────────────────

test("the sweep before a prompt's dispatch claims an enveloped copy (no clock read) and latches a tombstone; its write waits for drain's wake", () => {
    const runtime = makeRuntime();
    appendToFifo(runtime, [{ kind: "prompt", prompt: "hello", bootstrap: false, clientMessageIds: ["p-1"] }]);
    let races = 0;
    const { ops } = drive(decide(runtime), responder({
        messages: [copy(1), { cancelPending: [canonical(1)] }], guids: ["claim-1"], activity: () => accepted(1, "claim-1"),
        // The sweep ends when its third race is won by the timer; stop at the prompt's turn that follows.
        afterSweep: op => {
            if (races >= 3) return true;
            if (op.op === "race") races += 1;
            return false;
        },
    }));
    assert.deepEqual(kinds(ops).slice(0, 5), ["race", "newGuid", "claimWorkflowIntake:accept", "race", "race"]);
    assert.ok(!kinds(ops).slice(0, 5).includes("utcNow"));
    assert.deepEqual(runtime.state.intake.queue.map(entry => [entry.kind, entry.claimId, entry.cancel]), [["held", "claim-1", true]]);
    assert.equal(intakeDueAtMs(runtime.state.intake), 0);
    // The prompt itself was not touched by the copy: it is dispatched as before.
    assert.deepEqual(fifoItems(runtime), []);
});

// ─── Review of b92ff04b: corrective regressions ──────────────

test("P2-1: a tombstone is latched before a stashed ordinary prompt with the same id consumes it, in drain and in the sweep", () => {
    // Drain, one pass: an ordinary prompt carrying the copy's canonical id is stashed first (nothing is cancelled and its id
    // is in no window yet), then the copy is claimed and held (the intake path never consults the window), then the tombstone.
    const runtime = makeRuntime();
    let reads = 0;
    const { ops } = drive(drain(runtime), responder({
        messages: [{ prompt: "ordinary words", clientMessageIds: [canonical(1)] }, copy(1), { cancelPending: [canonical(1)] }],
        guids: ["claim-1"], activity: () => accepted(1, "claim-1"),
        afterSweep: op => op.op === "utcNow" && ++reads === 1,
    }));
    assert.deepEqual(kinds(ops), ["dequeue", "race", "newGuid", "claimWorkflowIntake:accept", "race", "record", "utcNow"]);
    // The stashed prompt was dropped and consumed the tombstone ...
    assert.equal(ops[5].events[0].eventType, "pending_messages.cancelled");
    assert.deepEqual(ops[5].events[0].data.clientMessageIds, [canonical(1)]);
    assert.ok(!runtime.state.cancelledMessageIds.has(canonical(1)));
    // ... after the held copy was latched; its cancel write is due now.
    assert.deepEqual(runtime.state.intake.queue.map(entry => [entry.kind, entry.claimId, entry.cancel]), [["held", "claim-1", true]]);
    assert.equal(intakeDueAtMs(runtime.state.intake), 0);

    // The sweep before a prompt's dispatch, the same order.
    const swept = makeRuntime();
    appendToFifo(swept, [{ kind: "prompt", prompt: "hello", bootstrap: false, clientMessageIds: ["p-1"] }]);
    let races = 0;
    const sweep = drive(decide(swept), responder({
        messages: [{ prompt: "ordinary words", clientMessageIds: [canonical(1)] }, copy(1), { cancelPending: [canonical(1)] }],
        guids: ["claim-1"], activity: () => accepted(1, "claim-1"),
        afterSweep: op => {
            if (races >= 4) return true;
            if (op.op === "race") races += 1;
            return false;
        },
    }));
    assert.deepEqual(kinds(sweep.ops).slice(0, 7), ["race", "race", "newGuid", "claimWorkflowIntake:accept", "race", "record", "race"]);
    assert.equal(sweep.ops[5].events[0].eventType, "pending_messages.cancelled");
    assert.ok(!swept.state.cancelledMessageIds.has(canonical(1)));
    assert.deepEqual(swept.state.intake.queue.map(entry => [entry.kind, entry.claimId, entry.cancel]), [["held", "claim-1", true]]);
});

test("P2-1: a tombstone is latched before the bounded cancel set evicts it, even in a message of more than 200 ids", () => {
    const runtime = makeRuntime();
    drive(drain(runtime), responder({ messages: [copy(1)], guids: ["claim-1"], activity: () => accepted(1, "claim-1") }));
    let reads = 0;
    drive(drain(runtime), responder({
        messages: [{ cancelPending: [canonical(1), ...range(1, 200).map(n => `other-${n}`)] }],
        afterSweep: op => op.op === "utcNow" && ++reads === 1,
    }));
    assert.equal(runtime.state.cancelledMessageIds.size, 200);
    assert.ok(!runtime.state.cancelledMessageIds.has(canonical(1)));
    assert.equal(runtime.state.intake.queue[0].cancel, true);
    assert.equal(intakeDueAtMs(runtime.state.intake), 0);
});

test("P2-2: a failure the activity marked as one no retry can fix fails the execution visibly; an unmarked one is made again when due", () => {
    // A thrown activity failure reaches the orchestration as an error carrying its message, nothing more.
    const marked = makeRuntime();
    const ops = [];
    assert.throws(() => drive(drain(marked), responder({
        messages: [copy(1)], guids: ["claim-1"],
        activity: () => ({ throw: new Error("WORKFLOW_INTAKE_NON_RETRYABLE: Cannot read properties of undefined (reading 'rows')") }),
    }), ops), error => error.code === "WORKFLOW_INTAKE_NON_RETRYABLE" && /no retry can fix it/.test(error.message));
    assert.deepEqual(kinds(ops), ["dequeue", "newGuid", "claimWorkflowIntake:accept", "cms"]);
    assert.equal(ops[3].status, "failed");
    assert.deepEqual(marked.state.intake, EMPTY_INTAKE);

    const unmarked = makeRuntime();
    const waited = drive(drain(unmarked), responder({
        messages: [copy(1)], guids: ["claim-1"], clocks: [NOW, NOW + 1],
        activity: () => ({ throw: new Error("Connection terminated unexpectedly") }),
        afterSweep: op => op.op === "race",
    }));
    assert.deepEqual(kinds(waited.ops), ["dequeue", "newGuid", "claimWorkflowIntake:accept", "utcNow", "utcNow", "race"]);
    assert.deepEqual(unmarked.state.intake.queue.map(entry => [entry.kind, entry.claimId, entry.retry]),
        [["unclaimed", "claim-1", { attempts: 1, nextAttemptAtMs: NOW + 30_000 }]]);
});

test("P2-3: a queued command is handled before each intake write; every intake activity call follows a race the queue could win", () => {
    // Three waiting copies whose claims are due and fail; a command waits before the first wake, another after it.
    const runtime = makeRuntime({ intake: carried({ queue: range(1, 3).map(n => unclaimedEntry(n, NOW)) }) });
    const command = id => ({ type: "cmd", cmd: "get_info", id });
    let racesSeen = 0;
    const { ops } = drive(drain(runtime), responder({
        clocks: range(0, 20).map(n => NOW + n), activity: outage,
        onRace: (_op, n) => (n === 1 ? { value: { index: 0, value: command("c-1") } }
            : n === 3 ? { value: { index: 0, value: command("c-2") } } : undefined),
        afterSweep: op => op.op === "race" && ++racesSeen === 6,
    }));
    const k = kinds(ops);
    const handled = id => ops.findIndex(op => op.op === "record" && op.events[0].eventType === "session.command_received" && op.events[0].data.id === id);
    const claims = k.flatMap((kind, index) => (kind === "claimWorkflowIntake:accept" ? [index] : []));
    assert.equal(claims.length, 3);
    assert.ok(handled("c-1") >= 0 && handled("c-1") < claims[0]);
    assert.ok(claims[0] < handled("c-2") && handled("c-2") < claims[1]);
    // One intake activity call per wake, each right after a race: a queued message waits for one store write at most.
    for (const index of claims) assert.equal(k[index - 1], "race");
    assert.deepEqual(runtime.state.intake.queue.map(entry => entry.retry.attempts), [2, 2, 2]);
});

test("an end whose answer was lost, then a late cancel: the cancel is recorded first, then the end is made again with its flag and clears", () => {
    const four = item(4, "claim-4");
    const invocation = {
        invocationId: "inv-1",
        items: [{ exchangeId: four.exchangeId, claimId: four.claimId, textSha256: four.textSha256, clientMessageId: four.clientMessageId, text: four.text, cancelRequested: false }],
        itemBytes: [four.itemBytes], bound: true, sent: true, parked: null, bindRetry: null,
        settle: { outcome: "completed", retry: null }, cancelWrite: null,
    };
    const runtime = makeRuntime({ intake: carried({ invocation }) });
    let ends = 0;
    const { ops } = drive(drain(runtime), responder({
        clocks: range(0, 10).map(n => NOW + n),
        // The end commits but its answer is lost; the replay finds it ended (the same end).
        activity: op => (op.input.op === "end" ? (++ends === 1 ? outage() : ok({ ended: false }))
            : ok({ items: op.input.items.map(entry => ({ exchangeId: entry.exchangeId, settled: true })) })),
        // The tombstone arrives while the end waits for its retry.
        onRace: (_op, n) => (n === 2 ? { value: { index: 0, value: { cancelPending: [canonical(4)] } } } : undefined),
    }));
    const writes = ops.filter(op => op.op === "activity").map(op => [op.input.op, op.input.items]);
    assert.deepEqual(writes, [
        ["end", [{ exchangeId: exchange(4), claimId: "claim-4", cancelRequested: false }]],
        ["request_cancel", [{ exchangeId: exchange(4), claimId: "claim-4" }]],
        ["end", [{ exchangeId: exchange(4), claimId: "claim-4", cancelRequested: true }]],
    ]);
    assert.equal(runtime.state.intake.invocation, null);
});

test("P3-1: an intake write that cannot be routed with the capability tag fails the execution visibly", () => {
    const runtime = makeRuntime();
    const base = runtime.ctx;
    runtime.ctx = new Proxy({}, { get: (_target, prop) => (prop === "scheduleActivity" ? (name, input) => ({ op: "untagged", name, input }) : base[prop]) });
    const ops = [];
    assert.throws(() => drive(drain(runtime), responder({ messages: [copy(1)], guids: ["claim-1"] }), ops),
        error => error.code === "WORKFLOW_INTAKE_NON_RETRYABLE" && /cannot be scheduled with the workflow-request capability/.test(error.message));
    assert.deepEqual(kinds(ops), ["dequeue", "newGuid", "cms"]);
    assert.equal(ops[2].status, "failed");
});

// ─── Review of 22a66ef7 and the cancel-order r2 trace ────────

test("an unclaimed copy, then an ordinary prompt with its id stashed, then the tombstone: the copy is latched before the stash consumes the tombstone (drain)", () => {
    // The formal cancel-order r2 trace: the claim fails, so the copy waits unclaimed (no row, its id in no window); an ordinary
    // prompt with the same id is stashed; the tombstone is added and consumed by that prompt.
    const runtime = makeRuntime();
    let claims = 0;
    const { ops } = drive(drain(runtime), responder({
        messages: [copy(1), { prompt: "ordinary words", clientMessageIds: [canonical(1)] }, { cancelPending: [canonical(1)] }],
        guids: ["claim-1"], clocks: range(0, 9).map(n => NOW + n),
        activity: op => (op.name === WORKFLOW_INTAKE_ACTIVITIES.claim ? (++claims === 1 ? outage() : accepted(1, "claim-1"))
            : ok({ items: [{ exchangeId: exchange(1), cancelled: true }] })),
    }));
    assert.deepEqual(kinds(ops), [
        "dequeue", "newGuid", "claimWorkflowIntake:accept", "utcNow",
        "utcNow", "race",
        "utcNow", "race", "record",
        "utcNow", "race", "claimWorkflowIntake:accept",
        "utcNow", "race", "settleWorkflowIntake:cancel_held", "record",
    ]);
    // The stashed prompt was dropped and consumed the tombstone ...
    assert.equal(ops[8].events[0].eventType, "pending_messages.cancelled");
    assert.ok(!runtime.state.cancelledMessageIds.has(canonical(1)));
    // ... after the unclaimed copy was latched: its claim, made again in mode accept, settles it cancelled on a later wake.
    assert.deepEqual(ops[11].input, ops[2].input);
    assert.deepEqual(ops[15].events[0].data, { outcome: "cancelled", exchangeId: exchange(1), claimId: "claim-1", source: "wake" });
    assert.deepEqual(runtime.state.intake, EMPTY_INTAKE);
    assert.deepEqual(fifoItems(runtime), []);
});

test("the same in the sweep before a prompt's dispatch: the unclaimed copy is latched before the stashed prompt consumes the tombstone", () => {
    const runtime = makeRuntime();
    appendToFifo(runtime, [{ kind: "prompt", prompt: "hello", bootstrap: false, clientMessageIds: ["p-1"] }]);
    let races = 0;
    const { ops } = drive(decide(runtime), responder({
        messages: [copy(1), { prompt: "ordinary words", clientMessageIds: [canonical(1)] }, { cancelPending: [canonical(1)] }],
        guids: ["claim-1"], clocks: [NOW], activity: outage,
        afterSweep: op => {
            if (races >= 4) return true;
            if (op.op === "race") races += 1;
            return false;
        },
    }));
    assert.deepEqual(kinds(ops).slice(0, 8), ["race", "newGuid", "claimWorkflowIntake:accept", "utcNow", "race", "race", "record", "race"]);
    assert.equal(ops[6].events[0].eventType, "pending_messages.cancelled");
    assert.ok(!runtime.state.cancelledMessageIds.has(canonical(1)));
    assert.deepEqual(runtime.state.intake.queue.map(entry => [entry.kind, entry.claimId, entry.cancel]), [["unclaimed", "claim-1", true]]);
});

test("a tombstone of more than 200 ids in the sweep is latched before the bounded cancel set evicts it", () => {
    const runtime = makeRuntime();
    appendToFifo(runtime, [{ kind: "prompt", prompt: "hello", bootstrap: false, clientMessageIds: ["p-1"] }]);
    let races = 0;
    const { ops } = drive(decide(runtime), responder({
        messages: [copy(1), { cancelPending: [canonical(1), ...range(1, 200).map(n => `other-${n}`)] }],
        guids: ["claim-1"], activity: () => accepted(1, "claim-1"),
        afterSweep: op => {
            if (races >= 3) return true;
            if (op.op === "race") races += 1;
            return false;
        },
    }));
    assert.deepEqual(kinds(ops).slice(0, 5), ["race", "newGuid", "claimWorkflowIntake:accept", "race", "race"]);
    assert.equal(runtime.state.cancelledMessageIds.size, 200);
    assert.ok(!runtime.state.cancelledMessageIds.has(canonical(1)));
    assert.deepEqual(runtime.state.intake.queue.map(entry => [entry.kind, entry.claimId, entry.cancel]), [["held", "claim-1", true]]);
    assert.equal(intakeDueAtMs(runtime.state.intake), 0);
});

// ─── The turn's intake field, its routing and its registration ──

test("a turn's intake field is checked whole: absent is none; its items keep batch order; anything malformed fails with its path", () => {
    assert.equal(parseIntakeTurnField(undefined), null);
    const field = fieldOf([1, 2]);
    assert.deepEqual(parseIntakeTurnField(JSON.parse(JSON.stringify(field))), field);
    assert.deepEqual(parseIntakeTurnField({ ...field, sentBefore: true }), { ...field, sentBefore: true });
    const first = field.items[0];
    const withItems = items => ({ ...field, items });
    for (const [raw, path] of [
        [null, "intake"],
        [{ ...field, extra: 1 }, "intake"],
        [{ invocationId: "inv-1", items: field.items }, "intake.attemptId"],
        [{ ...field, invocationId: "" }, "intake.invocationId"],
        [{ ...field, attemptId: "" }, "intake.attemptId"],
        [{ ...field, attemptId: 7 }, "intake.attemptId"],
        [{ ...field, sentBefore: "true" }, "intake.sentBefore"],
        [withItems([]), "intake.items"],
        [withItems({}), "intake.items"],
        [withItems(payloadOf(range(1, 65)).items), "intake.items"],
        [withItems([{ ...first, extra: true }]), "intake.items[0]"],
        [withItems([{ exchangeId: first.exchangeId, clientMessageId: first.clientMessageId, text: first.text }]), "intake.items[0].claimId"],
        [withItems([{ ...first, text: 5 }]), "intake.items[0].text"],
        [withItems([{ ...first, text: "x".repeat(INTAKE_MAX_TEXT_BYTES + 1) }]), "intake.items[0].text"],
        [withItems([{ ...first, exchangeId: "nx-1" }]), "intake.items[0].exchangeId"],
        [withItems([first, { ...field.items[1], exchangeId: first.exchangeId }]), "intake.items[1].exchangeId"],
        [withItems([{ ...first, claimId: "" }]), "intake.items[0].claimId"],
        [withItems([{ ...first, clientMessageId: "" }]), "intake.items[0].clientMessageId"],
    ]) {
        assert.throws(() => parseIntakeTurnField(raw), error => error.code === "WORKFLOW_INTAKE_INVALID" && error.path === path, path);
    }
    // The model gets the items' texts in batch order, then the attempt's own prompt.
    assert.equal(composeIntakePrompt("the prompt", field), `${textOf(1)}\n\n${textOf(2)}\n\nthe prompt`);
});

test("1.0.83's turns run as runTurnV5 / runTurnEpochV5 with only the workflow-request tag and the intake field; turn-control-v1 is unchanged", () => {
    const { ctx } = makeRuntime();
    const intake = fieldOf([1]);
    const proxy = createSessionProxy(ctx, SESSION, "affinity", { model: "m" }, "workflow-intake-v1");
    const plain = proxy.runTurn("work", false, 3, { intake });
    assert.deepEqual([plain.name, plain.tag, plain.affinity], ["runTurnV5", WORKFLOW_REQUEST_CAPABILITY, "affinity"]);
    assert.deepEqual(plain.input.intake, intake);
    const epoch = proxy.runTurn("work", true, 0, { epochStart: true });
    assert.deepEqual([epoch.name, epoch.tag], ["runTurnEpochV5", WORKFLOW_REQUEST_CAPABILITY]);
    assert.equal(Object.hasOwn(epoch.input, "intake"), false);
    // A workspace session's turns as well, with their carried steers.
    const workspace = createSessionProxy(ctx, SESSION, "affinity", { workspace: { schema: 1, root: "a", folder: "repo-x" } }, "workflow-intake-v1")
        .runTurn("work", false, 4, { workspaceRevision: 1, carriedSteers: [{ seq: 5, text: "steer" }], intake });
    assert.deepEqual([workspace.name, workspace.tag], ["runTurnV5", WORKFLOW_REQUEST_CAPABILITY]);
    assert.deepEqual(workspace.input.carriedSteers, [{ seq: 5, text: "steer" }]);
    assert.deepEqual(workspace.input.intake, intake);
    // turn-control-v1 ignores the field: its V4 turns keep their names, tag and input.
    const v4 = createSessionProxy(ctx, SESSION, "affinity", { model: "m" }, "turn-control-v1").runTurn("work", false, 3, { intake });
    assert.deepEqual([v4.name, v4.tag], ["runTurnV4", TURN_CONTROL_CAPABILITY]);
    assert.equal(Object.hasOwn(v4.input, "intake"), false);
});

test("only a test registers 1.0.83's turn activities: without the test option registerActivities registers no V5 name", () => {
    const registered = testOptions => {
        const names = [];
        const catalog = { getSession: async sessionId => ({ sessionId, owner: null, parentSessionId: null }) };
        registerActivities({ registerActivity: name => names.push(name) }, {}, null, undefined, catalog, undefined, undefined, undefined,
            undefined, [], null, [], [], undefined, undefined, undefined, testOptions);
        return names;
    };
    const plain = registered(undefined);
    const tested = registered({ workflowIntakeTurns: true });
    for (const name of ["runTurn", "runTurnV3", "runTurnV4", "runTurnEpochV4"]) assert.ok(plain.includes(name) && tested.includes(name), name);
    assert.ok(!plain.includes("runTurnV5") && !plain.includes("runTurnEpochV5"));
    assert.deepEqual(tested.filter(name => !plain.includes(name)), ["runTurnV5", "runTurnEpochV5"]);
});

// ─── Turns (design 5.5) ──────────────────────────────────────

/** The store's answers to a turn test's writes: the bind of exchanges `bind` under `claim-n`, and every end. */
const storeAnswers = (bind = [1]) => op => {
    if (op.input.op === "bind") return bindAnswer(bind);
    if (op.input.op === "end") return ok({ ended: true });
    return assert.fail(`unexpected ${op.name} ${JSON.stringify(op.input)}`);
};

const endOf = ops => ops.find(op => op.op === "activity" && op.input.op === "end");

/** An owed retry (ordinary retry ownership, review Q-W2-7) of the turn whose prompt was "retry words": its whole contract. */
const owedRetry = (fields = {}) => ({
    prompt: "retry words", bootstrap: false, requiredTool: null, cycleOrigin: null, clientMessageIds: [], sender: null, attachments: [],
    retryCount: 1, thrownTurnKey: null, fresh: false, ...fields,
});

/**
 * A runtime restored from a turn's retry continue-as-new: the sent invocation `inv-1` of exchange 1, its marker, the
 * owed retry that takes it (with the thrown key `thrownTurnKey`, if any), and an agent wait.
 */
function heldRetryRuntime({ thrownTurnKey = null, retryCount = 1, ...extraInput } = {}) {
    const runtime = makeRuntime({
        intake: carried({ invocation: boundInvocation([1], { sent: true }) }), intakeRetryInvocationId: "inv-1",
        ownedRetry: owedRetry({ retryCount, thrownTurnKey }),
        waitingForAgentIds: ["agent-1"], subAgents: [{ orchId: "agent-1", sessionId: "child-1", task: "helper", status: "running" }],
        ...extraInput,
    });
    // A wait's fire queued before the agent wait's poll, whose timer is armed.
    appendToFifo(runtime, [{ kind: "timer", timer: { type: "wait", deadlineMs: NOW, originalDurationMs: 60_000, reason: "nap" }, firedAtMs: NOW }]);
    runtime.state.activeTimer = { deadlineMs: NOW + 30_000, originalDurationMs: 30_000, reason: "waiting for 1 agent(s)", type: "agent-poll", agentIds: ["agent-1"] };
    return runtime;
}

test("decide forms and binds an invocation, then starts a turn for it alone: runTurnV5 with the workflow-request tag and the intake field; sent, it ends completed, settled on the wake", () => {
    const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }) });
    const { ops } = drive(runLoop(runtime), turnResponder({ guids: ["inv-1"], activity: storeAnswers([1]), turn: () => completed(sentBy()) }));
    const k = kinds(ops);
    const bind = k.indexOf("settleWorkflowIntake:bind");
    const turns = turnsOf(ops);
    assert.equal(turns.length, 1);
    const turn = ops.indexOf(turns[0]);
    // The invocation's id is drawn and its bind made before the turn that carries it.
    assert.ok(k.indexOf("newGuid") >= 0 && k.indexOf("newGuid") < bind && bind < turn);
    assert.deepEqual(ops[bind].input, { op: "bind", recipientSessionId: SESSION, invocationId: "inv-1", items: [{ exchangeId: exchange(1), claimId: "claim-1" }] });
    assert.deepEqual([turns[0].name, turns[0].tag], ["runTurnV5", WORKFLOW_REQUEST_CAPABILITY]);
    assert.deepEqual(turns[0].input.intake, payloadOf([1]));
    assert.equal(turns[0].input.prompt, INTERNAL_SYSTEM_TURN_PROMPT);
    assert.equal(turns[0].input.bootstrap, true);
    // Sent and completed: its end is settled on the wake, after the turn.
    const end = endOf(ops);
    assert.ok(ops.indexOf(end) > turn);
    assert.deepEqual(end.input, {
        op: "end", recipientSessionId: SESSION, invocationId: "inv-1", outcome: "completed",
        items: [{ exchangeId: exchange(1), claimId: "claim-1", cancelRequested: false }],
    });
    assert.deepEqual(runtime.state.intake, EMPTY_INTAKE);
    // The run loop continues as new with nothing of the intake to carry.
    const can = ops.at(-1);
    assert.equal(can.op, "continueAsNew");
    assert.equal(Object.hasOwn(can.canInput, "intake"), false);
    assert.equal(Object.hasOwn(can.canInput, "intakeRetryInvocationId"), false);
});

test("an attempt that sends and errors keeps its invocation for its own retry: the retry's continue-as-new carries the marker, and the pending prompt's dispatch carries the invocation", () => {
    const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }) });
    const first = drive(runLoop(runtime), turnResponder({
        guids: ["inv-1"], activity: storeAnswers([1]), turn: () => turnResult({ type: "error", message: "the model call failed" }, sentBy()),
    }));
    const can = first.ops.at(-1);
    assert.equal(can.op, "continueAsNew");
    assert.equal(can.canInput.intakeRetryInvocationId, "inv-1");
    // The retry is owed whole, apart from the pending prompt (review Q-W2-7); an error result keeps no thrown key.
    assert.deepEqual(can.canInput.ownedRetry, owedRetry({ prompt: INTERNAL_SYSTEM_TURN_PROMPT }));
    assert.equal(can.canInput.intake.invocation.sent, true);
    assert.equal(can.canInput.intake.invocation.settle, null);
    assert.equal(Object.hasOwn(can.canInput, "prompt"), false);
    assert.equal(can.canInput.retryCount, 0);

    const retried = makeRuntime(can.canInput);
    assert.equal(retried.state.intakeRetryInvocationId, "inv-1");
    const second = drive(runLoop(retried), turnResponder({ activity: storeAnswers([1]), turn: () => completed(sentBy()) }));
    const turns = turnsOf(second.ops);
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0].input.intake, payloadOf([1]));
    assert.equal(turns[0].input.retryCount, 1);
    assert.equal(endOf(second.ops).input.outcome, "completed");
    assert.equal(retried.state.intakeRetryInvocationId, null);
    assert.equal(retried.state.ownedRetry, null);
    assert.equal(retried.state.intake.invocation, null);
});

test("Q-W2-7: after a retry's continue-as-new, the owed retry goes first, held by no agent wait: it carries the sent invocation; the wait is kept, and the queued fire and the wait's poll run after it", () => {
    const runtime = heldRetryRuntime();
    const seen = [];
    const { ops } = drive(runLoop(runtime), turnResponder({
        activity: storeAnswers([1]),
        turn: op => {
            const fifo = fifoItems(runtime).map(entry => (entry.kind === "timer" ? entry.timer.type : entry.kind)).sort();
            seen.push({
                prompt: op.input.prompt, intake: op.input.intake ?? null, marker: runtime.state.intakeRetryInvocationId,
                waiting: runtime.state.waitingForAgentIds, owed: runtime.state.ownedRetry, timer: runtime.state.activeTimer?.type ?? null, fifo,
            });
            return op.input.intake ? completed(sentBy()) : completed();
        },
    }));
    const turns = turnsOf(ops);
    assert.ok(turns.length >= 2);
    // The owed retry first, with its own prompt: it takes the marker and carries the invocation. The agent wait is kept;
    // its armed poll is queued after the retry with the wait's fire, and nothing else is released or lost.
    assert.deepEqual(seen[0], {
        prompt: "retry words", intake: payloadOf([1]), marker: null, waiting: ["agent-1"], owed: null, timer: null, fifo: ["agent-poll", "wait"],
    });
    assert.equal(endOf(ops).input.outcome, "completed");
    assert.ok(ops.indexOf(endOf(ops)) < ops.indexOf(turns[1]));
    // Then the queued fire's turn, which carries nothing; no later turn is the retry again or merges into it.
    assert.match(turns[1].input.prompt, /second wait is now complete/);
    for (const turn of turns.slice(1)) {
        assert.equal(Object.hasOwn(turn.input, "intake"), false);
        assert.doesNotMatch(turn.input.prompt, /retry words/);
    }
    assert.deepEqual(runtime.state.intake, EMPTY_INTAKE);
});

test("Q-W2-7: a queued tool action runs first and starts no turn; the owed retry then runs with its own prompt and flag, and the workspace's continuation runs after it with its own", () => {
    const runtime = makeRuntime({
        intake: carried({ invocation: boundInvocation([1], { sent: true }) }), intakeRetryInvocationId: "inv-1", ownedRetry: owedRetry(),
        // A workspace change that the failed attempt had accepted (an error result keeps it): the retry's input carries it.
        pendingToolActions: [{ type: "set_workspace", workspace: { root: "a", folder: "repo-x" }, path: "/w/repo-x" }],
    });
    const { ops } = drive(runLoop(runtime), turnResponder({
        activity: storeAnswers([1]), turn: op => (op.input.intake ? completed(sentBy()) : completed()),
    }));
    const turns = turnsOf(ops);
    assert.equal(turns.length, 2);
    const changed = ops.findIndex(op => op.op === "record" && op.events[0].eventType === "session.workspace_changed");
    assert.ok(changed >= 0 && changed < ops.indexOf(turns[0]));
    // The owed retry: its own prompt, never merged with the continuation, and not a bootstrap turn; it carries the invocation.
    assert.deepEqual([turns[0].name, turns[0].tag], ["runTurnV5", WORKFLOW_REQUEST_CAPABILITY]);
    assert.deepEqual(turns[0].input.intake, payloadOf([1]));
    assert.equal(turns[0].input.prompt, "retry words");
    assert.notEqual(turns[0].input.bootstrap, true);
    // The continuation keeps its own bootstrap flag and carries nothing.
    assert.equal(turns[1].input.bootstrap, true);
    assert.doesNotMatch(turns[1].input.prompt, /retry words/);
    assert.equal(Object.hasOwn(turns[1].input, "intake"), false);
    assert.equal(endOf(ops).input.outcome, "completed");
});

test("Q-W2-7: when the owed retry fails again while a follow-up is pending, its own retry is owed next from that attempt's exact arguments, the follow-up keeps its own fields, and the invocation awaits that retry", () => {
    // A whole user sender (provider and subject): the only kind of user sender a turn ever has.
    const sender = { kind: "user", provider: "test", subject: "ann", display: "Ann" };
    const runtime = makeRuntime({
        intake: carried({ invocation: boundInvocation([1], { sent: true }) }), intakeRetryInvocationId: "inv-1",
        ownedRetry: owedRetry({ requiredTool: "report", clientMessageIds: ["cm-p"], sender }),
        prompt: "U: a child's summary", clientMessageIds: ["cm-u"], sender: { kind: "agent", display: "child" }, bootstrapPrompt: true,
        sourceOrchestrationVersion: "1.0.83",
    });
    const seen = [];
    const { ops } = drive(runLoop(runtime), turnResponder({
        activity: storeAnswers([1]),
        turn: op => {
            seen.push(op.input);
            return turnResult({ type: "error", message: "the model call failed" }, sentBy());
        },
    }));
    // Only the owed retry ran; the follow-up waits behind it.
    assert.equal(seen.length, 1);
    assert.equal(seen[0].prompt, "retry words");
    assert.deepEqual(seen[0].intake, payloadOf([1]));
    assert.equal(seen[0].requiredTool, "report");
    assert.deepEqual(seen[0].clientMessageIds, ["cm-p"]);
    assert.deepEqual(seen[0].sender, sender);
    assert.equal(seen[0].retryCount, 1);
    const can = ops.at(-1);
    assert.equal(can.op, "continueAsNew");
    assert.equal(can.canInput.intakeRetryInvocationId, "inv-1");
    assert.deepEqual(can.canInput.ownedRetry, owedRetry({ requiredTool: "report", clientMessageIds: ["cm-p"], sender, retryCount: 2 }));
    assert.equal(can.canInput.prompt, "U: a child's summary");
    assert.deepEqual(can.canInput.clientMessageIds, ["cm-u"]);
    assert.deepEqual(can.canInput.sender, { kind: "agent", display: "child" });
    assert.equal(can.canInput.bootstrapPrompt, true);
    assert.equal(Object.hasOwn(can.canInput, "requiredTool"), false);
    assert.equal(can.canInput.intake.invocation.sent, true);
    assert.equal(can.canInput.intake.invocation.settle, null);
    assert.equal(ops.some(op => op.op === "record" && op.events[0].eventType === INTAKE_RECORDED_EVENT), false);
});

test("Q-W2-7: with a turn's retry owed, an attempt that is not its dispatch is a broken invariant: the execution fails visibly and no turn runs", () => {
    const runtime = heldRetryRuntime();
    // A lost owed retry (a broken invariant): the queued fire's turn would otherwise run while the marker is set.
    runtime.state.ownedRetry = null;
    const ops = [];
    assert.throws(() => drive(runLoop(runtime), turnResponder({ activity: storeAnswers([1]), turn: () => assert.fail("no turn runs") }), ops),
        error => error.code === "WORKFLOW_INTAKE_BROKEN" && /an attempt starts before the owed retry/.test(error.message));
    assert.equal(turnsOf(ops).length, 0);
    assert.equal(ops.find(op => op.op === "cms").status, "failed");
    assert.equal(endOf(ops), undefined);
});

test("Q-W2-7: only the owed retry's dispatch sends its thrown key, with its own count; the turns after it draw keys of their own", () => {
    const runtime = heldRetryRuntime({ blobEnabled: true, thrownTurnKey: "key-A" });
    const seen = [];
    drive(runLoop(runtime), turnResponder({
        activity: storeAnswers([1]),
        turn: op => {
            seen.push({
                turnKey: op.input.snapshot?.turnKey ?? null, held: runtime.state.thrownTurnKey, carries: Boolean(op.input.intake),
                retryCount: op.input.retryCount ?? 0,
            });
            return op.input.intake ? completed(sentBy()) : completed();
        },
    }));
    assert.ok(seen.length >= 2);
    // The retry's dispatch sends the thrown attempt's key again with its own count, so a saved result is adopted, not
    // run twice; the session holds no key once the attempt has chosen it.
    assert.deepEqual(seen[0], { turnKey: "key-A", held: null, carries: true, retryCount: 1 });
    // Every later turn draws a key of its own, under the count the retry's success reset.
    for (const later of seen.slice(1)) {
        assert.match(later.turnKey, /^guid-/);
        assert.equal(later.retryCount, 0);
        assert.equal(later.carries, false);
    }
});

test("Q-W2-7: the owed retry that sends its thrown attempt's key takes only that attempt's prompt; a model notice and a system note queued while it waited ride the next turn that runs; an owed retry with no key takes them", () => {
    const NOTICE = "Runtime model for this turn is m2. If asked what model you are using, answer this value.";
    const NOTE = "A pending system note.";
    for (const [label, thrownTurnKey] of [["with its key", "key-A"], ["without a key", null]]) {
        // As a set_model while the retry waits leaves the session (lifecycle.ts): the owed retry, the model notice and the
        // command's continuation prompt; and a pending system note.
        const runtime = makeRuntime({
            blobEnabled: true, ownedRetry: owedRetry({ thrownTurnKey }),
            prompt: "Continue on m2.", bootstrapPrompt: true, runtimeModelNotice: NOTICE, systemPrompt: NOTE,
        });
        const seen = [];
        drive(runLoop(runtime), turnResponder({
            turn: op => {
                seen.push({ prompt: op.input.prompt, turnKey: op.input.snapshot?.turnKey ?? null, retryCount: op.input.retryCount ?? 0 });
                return completed();
            },
            stop: op => isTurn(op) && seen.length >= 2,
        }));
        assert.equal(seen.length, 2, label);
        const [retry, next] = seen;
        assert.equal(retry.retryCount, 1, label);
        assert.ok(next.prompt.startsWith("Continue on m2."), label);
        if (thrownTurnKey !== null) {
            // It may adopt the thrown attempt's saved turn: it sends that attempt's prompt alone, and the notes wait for the
            // next turn, which runs the model.
            assert.equal(retry.turnKey, "key-A", label);
            assert.equal(retry.prompt, "retry words", label);
            assert.ok(next.prompt.includes(NOTICE) && next.prompt.includes(NOTE), label);
        } else {
            // With no key it never adopts: it runs the model and takes the notes, as any other turn does.
            assert.notEqual(retry.turnKey, "key-A", label);
            assert.ok(retry.prompt.startsWith("retry words") && retry.prompt.includes(NOTICE) && retry.prompt.includes(NOTE), label);
            assert.ok(!next.prompt.includes(NOTICE) && !next.prompt.includes(NOTE), label);
        }
        // Delivered once either way.
        assert.equal(runtime.state.runtimeModelNotice, undefined, label);
        assert.equal(runtime.state.pendingSystemPrompt, undefined, label);
    }
});

test("Q-W2-7: an ordinary continue-as-new before the owed retry's dispatch carries it whole, apart from the session's count and key; the next execution's dispatch sends its key with its count", () => {
    const runtime = heldRetryRuntime({ blobEnabled: true, thrownTurnKey: "key-A" });
    // The execution reaches its iteration cap before the dispatch.
    runtime.state.loopIteration = 10;
    const { ops } = drive(runLoop(runtime), turnResponder({ turn: () => assert.fail("no turn runs before the cap") }));
    const can = ops.at(-1);
    assert.equal(can.op, "continueAsNew");
    assert.equal(can.canInput.retryCount, 0);
    assert.equal(Object.hasOwn(can.canInput, "thrownTurnKey"), false);
    assert.equal(can.canInput.intakeRetryInvocationId, "inv-1");
    assert.deepEqual(can.canInput.ownedRetry, owedRetry({ thrownTurnKey: "key-A" }));
    // The next execution's dispatch sends the key again, with its count, whatever the agent wait it restores.
    const next = makeRuntime(can.canInput);
    const seen = [];
    drive(runLoop(next), turnResponder({
        activity: storeAnswers([1]),
        turn: op => {
            seen.push({ turnKey: op.input.snapshot?.turnKey ?? null, retryCount: op.input.retryCount ?? 0, intake: op.input.intake ?? null });
            return completed(sentBy());
        },
        stop: op => isTurn(op) && seen.length >= 1,
    }));
    assert.deepEqual(seen, [{ turnKey: "key-A", retryCount: 1, intake: payloadOf([1]) }]);
});

test("Q-W2-7: while a retry is owed, drain never waits for an armed timer: it sweeps the queue at once, a command first, then yields; a cron keeps its remaining time, and an agent wait is kept with its poll queued after the retry", () => {
    const command = id => ({ type: "cmd", cmd: "get_info", id });
    for (const [label, extra, timer] of [
        ["cron", { cronSchedule: { intervalSeconds: 1800, reason: "digest" } },
            { deadlineMs: NOW + 1_800_000, originalDurationMs: 1_800_000, reason: "digest", type: "cron" }],
        ["agent wait", { waitingForAgentIds: ["agent-1"], subAgents: [{ orchId: "agent-1", sessionId: "child-1", task: "helper", status: "running" }] },
            { deadlineMs: NOW + 30_000, originalDurationMs: 30_000, reason: "waiting for 1 agent(s)", type: "agent-poll", agentIds: ["agent-1"] }],
    ]) {
        const runtime = makeRuntime({ ownedRetry: owedRetry(), ...extra });
        runtime.state.activeTimer = timer;
        const { ops } = drive(drain(runtime), responder({ messages: [command("c-1")], clocks: range(0, 20).map(n => NOW + n) }));
        // Every race is the sweep's moment: none waits for the armed timer, and the queue's command is handled in it.
        const races = ops.filter(op => op.op === "race");
        assert.equal(races.length, 2, label);
        for (const race of races) assert.equal(race.tasks[1].ms, 10, label);
        assert.ok(ops.some(op => op.op === "record" && op.events[0].eventType === "session.command_received" && op.events[0].data.id === "c-1"), label);
        // The retry is still owed, and decide sends it next; the armed timer is released for it, nothing lost.
        assert.deepEqual(runtime.state.ownedRetry, owedRetry(), label);
        assert.equal(runtime.state.activeTimer, null, label);
        if (timer.type === "cron") {
            assert.equal(runtime.state.interruptedCronTimer.remainingMs, 1_800_000, label);
            assert.deepEqual(fifoItems(runtime), [], label);
        } else {
            assert.deepEqual(runtime.state.waitingForAgentIds, ["agent-1"], label);
            assert.deepEqual(fifoItems(runtime).map(entry => [entry.kind, entry.timer?.type]), [["timer", "agent-poll"]], label);
        }
    }
    // During a graceful shutdown the owed retry waits: drain races the shutdown's poll as before.
    const stopping = makeRuntime({ ownedRetry: owedRetry() });
    stopping.state.pendingShutdown = { mode: "done", reason: "done", startedAtMs: NOW, deadlineAtMs: NOW + 60_000, targetAgentIds: ["agent-1"], commandId: "d-1" };
    stopping.state.activeTimer = { deadlineMs: NOW + 5_000, originalDurationMs: 5_000, reason: "shutting down", type: "agent-poll", agentIds: ["agent-1"] };
    const { ops } = drive(drain(stopping), responder({ clocks: range(0, 20).map(n => NOW + n), afterSweep: op => op.op === "race" }));
    assert.equal(ops.at(-1).tasks[1].ms, 5_000);
});

test("review O-W2-5: an arrival that resumes a parked invocation is carried by a continue-as-new that comes before its turn", () => {
    const runtime = makeRuntime({ intake: carried({ invocation: boundInvocation([1], { parked: "credential" }) }) });
    // A fired hold-window timer queued before the copy arrives: decide runs it first, and it starts no turn.
    appendToFifo(runtime, [{ kind: "timer", timer: { type: "idle", deadlineMs: NOW, originalDurationMs: 1_000, reason: "idle timeout" }, firedAtMs: NOW }]);
    // The execution's last loop before its iteration cap.
    runtime.state.loopIteration = 9;
    const first = drive(runLoop(runtime), turnResponder({
        messages: [copy(2)], guids: ["claim-2"],
        activity: op => (op.name === WORKFLOW_INTAKE_ACTIVITIES.claim ? accepted(2, "claim-2") : assert.fail(`unexpected ${op.name}`)),
        turn: () => assert.fail("no turn runs before the cap"),
    }));
    const can = first.ops.at(-1);
    assert.equal(can.op, "continueAsNew");
    assert.equal(can.canInput.intakeArrivalPending, true);
    assert.deepEqual(can.canInput.intake.queue.map(entry => [entry.kind, entry.claimId]), [["held", "claim-2"]]);
    // The next execution starts the arrival's one turn for the parked invocation; the new item waits for the next invocation.
    const next = makeRuntime(can.canInput);
    assert.equal(next.state.intakeArrivalPending, true);
    const { ops } = drive(runLoop(next), turnResponder({
        activity: storeAnswers([2]),
        turn: op => completed({ invocationId: op.input.intake.invocationId, sent: true }),
    }));
    const turns = turnsOf(ops);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0].input.intake, payloadOf([1]));
    assert.deepEqual(turns[1].input.intake, payloadOf([2], turns[1].input.intake.invocationId));
    assert.equal(next.state.intakeArrivalPending, false);
    assert.deepEqual(next.state.intake, EMPTY_INTAKE);
});

// ─── Formal delta of 84840d8d: S1 to S5 ──────────────────────

/** Ids for one execution's draws, unique across the executions of a test. */
const drawsOf = execution => range(1, 12).map(n => `x${execution}-${n}`);

test("formal S1, S2: each connection-closed retry continues as new before any dispatch, with the marker and the owed retry's count and thrown key; the lossy handoff's is fresh (count 0, no key), so its dispatch draws a new key (as 1.0.82 does) and carries the same invocation", () => {
    let runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }), blobEnabled: true });
    let firstKey = null;
    let invocationId = null;
    for (let attempt = 1; attempt <= COPILOT_CONNECTION_CLOSED_MAX_RETRIES + 1; attempt += 1) {
        const seen = [];
        const { ops } = drive(runLoop(runtime), turnResponder({
            guids: drawsOf(attempt), activity: storeAnswers([1]),
            turn: op => {
                seen.push({ turnKey: op.input.snapshot?.turnKey ?? null, retryCount: op.input.retryCount ?? 0, intake: op.input.intake ?? null });
                return { throw: new Error("Connection is closed") };
            },
        }));
        // One attempt per execution: the marker is set and its continue-as-new follows, with no dispatch between them.
        assert.equal(seen.length, 1, `attempt ${attempt}`);
        invocationId ??= seen[0].intake?.invocationId ?? null;
        assert.ok(invocationId !== null);
        assert.deepEqual(seen[0].intake, payloadOf([1], invocationId), `attempt ${attempt}`);
        assert.equal(seen[0].retryCount, attempt - 1, `attempt ${attempt}`);
        firstKey ??= seen[0].turnKey;
        assert.match(firstKey, /^x1-/);
        assert.equal(seen[0].turnKey, firstKey, `attempt ${attempt} sends the first attempt's key`);
        const can = ops.at(-1);
        assert.equal(can.op, "continueAsNew", `attempt ${attempt}`);
        assert.equal(can.canInput.intakeRetryInvocationId, invocationId, `attempt ${attempt}`);
        assert.equal(can.canInput.intake.invocation.sent, true, `attempt ${attempt}`);
        const lossy = attempt > COPILOT_CONNECTION_CLOSED_MAX_RETRIES;
        assert.equal(can.canInput.retryCount, 0, `attempt ${attempt}`);
        assert.equal(Object.hasOwn(can.canInput, "thrownTurnKey"), false, `attempt ${attempt}`);
        const owed = can.canInput.ownedRetry;
        assert.deepEqual([owed.retryCount, owed.thrownTurnKey, owed.fresh], lossy ? [0, null, true] : [attempt, firstKey, false], `attempt ${attempt}`);
        assert.equal(ops.some(op => op.op === "record" && op.events[0].eventType === "session.lossy_handoff"), lossy, `attempt ${attempt}`);
        runtime = makeRuntime(can.canInput);
    }
    // The handoff's dispatch: count 0, so no key reuse; it carries the invocation, which its result completes.
    const seen = [];
    const { ops } = drive(runLoop(runtime), turnResponder({
        guids: drawsOf(9), activity: storeAnswers([1]),
        turn: op => {
            seen.push({ turnKey: op.input.snapshot?.turnKey ?? null, retryCount: op.input.retryCount ?? 0, intake: op.input.intake ?? null });
            return completed({ invocationId, sent: true });
        },
    }));
    assert.equal(seen.length, 1);
    assert.notEqual(seen[0].turnKey, firstKey);
    assert.match(seen[0].turnKey, /^x9-/);
    assert.equal(seen[0].retryCount, 0);
    assert.deepEqual(seen[0].intake, payloadOf([1], invocationId));
    assert.equal(endOf(ops).input.outcome, "completed");
    assert.equal(runtime.state.intakeRetryInvocationId, null);
    assert.equal(runtime.state.ownedRetry, null);
});

test("formal S1: a marker restored without its owed retry, or a dispatch that loses it, fails the execution visibly; no turn runs", () => {
    // Restore refuses the marker alone: nothing would take it.
    assert.throws(() => makeRuntime({ intake: carried({ invocation: boundInvocation([1], { sent: true }) }), intakeRetryInvocationId: "inv-1" }),
        error => error instanceof IntakeShapeError && error.path === "$.ownedRetry");
    // A continue-as-new that would carry the marker without an owed retry fails before it yields anything.
    const runtime = heldRetryRuntime();
    runtime.state.ownedRetry = null;
    const ops = [];
    runtime.state.loopIteration = 10;
    assert.throws(() => drive(runLoop(runtime), turnResponder({ turn: () => assert.fail("no turn runs") }), ops),
        error => error?.name === "IntakeInvariantError" && /no retry is owed/.test(error.message));
    assert.equal(turnsOf(ops).length, 0);
    assert.equal(ops.some(op => op.op === "continueAsNew"), false);
});

test("formal S3: a hydration give-up before the dispatch of a restored retry ends its sent invocation interrupted; no turn runs and nothing is sent", () => {
    const runtime = makeRuntime({
        intake: carried({ invocation: boundInvocation([1], { sent: true }) }), intakeRetryInvocationId: "inv-1",
        ownedRetry: owedRetry({ thrownTurnKey: "key-A" }), blobEnabled: true, needsHydration: true,
    });
    const { ops } = drive(runLoop(runtime), turnResponder({
        activity: storeAnswers([1]),
        sessionActivity: op => (op.name === "hydrateSession" ? { throw: new Error("the session store is unreachable") } : { value: undefined }),
        turn: () => assert.fail("no turn runs"),
    }));
    assert.equal(turnsOf(ops).length, 0);
    assert.equal(ops.filter(op => op.op === "session" && op.name === "hydrateSession").length, 3);
    const end = endOf(ops);
    assert.deepEqual([end.input.invocationId, end.input.outcome], ["inv-1", "interrupted"]);
    assert.equal(runtime.state.intakeRetryInvocationId, null);
    assert.equal(runtime.state.ownedRetry, null);
    assert.deepEqual(runtime.state.intake, EMPTY_INTAKE);
});

test("formal S4 (Q-W2-7): no turn runs between a retry's continue-as-new and the owed retry's dispatch; that retry's own exhaustion or non-retryable failure ends its sent invocation failed_indeterminate, and leaves no marker, owed retry or key", () => {
    for (const [label, held, failure] of [
        // The owed retry is the turn's third attempt: its error exhausts the retries.
        ["exhausted", 2, { type: "error", message: "the model call failed" }],
        ["non-retryable", 1, { type: "error", message: 'Required tool "lookup" is not available in this session.', retryable: false }],
    ]) {
        const runtime = heldRetryRuntime({ blobEnabled: true, thrownTurnKey: "key-A", retryCount: held });
        const seen = [];
        const { ops } = drive(runLoop(runtime), turnResponder({
            activity: storeAnswers([1]),
            turn: op => {
                seen.push({ turnKey: op.input.snapshot?.turnKey ?? null, retryCount: op.input.retryCount ?? 0, intake: op.input.intake ?? null });
                return op.input.intake ? turnResult(failure, sentBy()) : completed();
            },
            stop: op => isTurn(op) && seen.length >= 1,
        }));
        // The owed retry ran first, with its own count and key, and carried the invocation.
        assert.deepEqual(seen, [{ turnKey: "key-A", retryCount: held, intake: payloadOf([1]) }], label);
        assert.equal(endOf(ops).input.outcome, "failed_indeterminate", label);
        assert.equal(ops.some(op => op.op === "record" && op.events[0].eventType === INTAKE_RECORDED_EVENT), false, label);
        assert.deepEqual(
            [runtime.state.intakeRetryInvocationId, runtime.state.ownedRetry, runtime.state.thrownTurnKey, runtime.state.retryCount],
            [null, null, null, 0], label);
    }
});

test("formal S5: an arrival flag with nothing to answer starts no turn and changes no other turn; the next carrying attempt consumes it", () => {
    const stale = makeRuntime({ intakeArrivalPending: true });
    assert.equal(intakeWantsTurn(stale), false);
    const first = drive(runLoop(stale), turnResponder({ messages: [{ prompt: "hello", clientMessageIds: ["person-1"] }], turn: () => completed() }));
    assert.equal(first.ops[0].op, "dequeue");
    assert.equal(turnsOf(first.ops).length, 1);
    assert.equal(Object.hasOwn(turnsOf(first.ops)[0].input, "intake"), false);
    assert.equal(stale.state.intakeArrivalPending, true);
    // With an item held, the attempt that carries its invocation takes the flag: one turn, and none for the flag.
    const held = makeRuntime({ intakeArrivalPending: true, intake: carried({ queue: [heldEntry(1)] }) });
    const second = drive(runLoop(held), turnResponder({ guids: ["inv-1"], activity: storeAnswers([1]), turn: () => completed(sentBy()) }));
    assert.equal(turnsOf(second.ops).length, 1);
    assert.deepEqual(turnsOf(second.ops)[0].input.intake, payloadOf([1]));
    assert.equal(held.state.intakeArrivalPending, false);
    assert.equal(endOf(second.ops).input.outcome, "completed");
    assert.deepEqual(held.state.intake, EMPTY_INTAKE);
});

test("an attempt that carried no invocation and returns a witness is a broken invariant: the execution fails visibly", () => {
    const runtime = makeRuntime({ prompt: "hello" });
    const ops = [];
    assert.throws(() => drive(runLoop(runtime), turnResponder({ turn: () => completed(sentBy("inv-9")) }), ops),
        error => error.code === "WORKFLOW_INTAKE_BROKEN");
    assert.equal(turnsOf(ops).length, 1);
    assert.equal(Object.hasOwn(turnsOf(ops)[0].input, "intake"), false);
    assert.equal(ops.find(op => op.op === "cms").status, "failed");
});

test("a carrying attempt whose result (an adopted saved one included) names another invocation, or has a malformed witness, fails the execution visibly; nothing is settled", () => {
    for (const [witness, code] of [[{ invocationId: "inv-9", sent: true }, "WORKFLOW_INTAKE_BROKEN"], ["not a witness", "WORKFLOW_INTAKE_INVALID"]]) {
        const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }) });
        const ops = [];
        assert.throws(() => drive(runLoop(runtime), turnResponder({ guids: ["inv-1"], activity: storeAnswers([1]), turn: () => completed(witness) }), ops),
            error => error.code === code, JSON.stringify(witness));
        assert.equal(turnsOf(ops).length, 1);
        assert.equal(ops.find(op => op.op === "cms").status, "failed");
        assert.equal(endOf(ops), undefined);
    }
});

test("a turn stopped before its send ends the invocation it carried not_dispatched", () => {
    const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }) });
    const { ops } = drive(runLoop(runtime), turnResponder({
        guids: ["inv-1"], activity: storeAnswers([1]), turn: () => turnResult({ type: "stopped", reason: "Stopped by user" }, notSentBy()),
    }));
    assert.equal(turnsOf(ops).length, 1);
    assert.equal(endOf(ops).input.outcome, "not_dispatched");
    assert.deepEqual(runtime.state.intake, EMPTY_INTAKE);
});

test("a gate refusal before the send parks the invocation, which starts no turn of its own; a message that ends the gate's wait carries it", () => {
    const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }) });
    let turnsRun = 0;
    let delivered = false;
    const { ops } = drive(runLoop(runtime), turnResponder({
        guids: ["inv-1"], activity: storeAnswers([1]),
        turn: () => (++turnsRun === 1
            ? turnResult({ type: "wait", seconds: 60, reason: "provider budget paused", gate: "budget" }, notSentBy())
            : completed(sentBy())),
        // The person's message arrives while the budget wait is armed and the invocation is parked for it.
        onRace: () => {
            if (delivered || runtime.state.intake.invocation?.parked !== "gate") return undefined;
            delivered = true;
            return { value: { index: 0, value: { prompt: "hello" } } };
        },
    }));
    assert.ok(delivered);
    const turns = turnsOf(ops);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0].input.intake, payloadOf([1]));
    assert.deepEqual(turns[1].input.intake, payloadOf([1]));
    assert.match(turns[1].input.prompt, /^hello/);
    assert.equal(endOf(ops).input.outcome, "completed");
    assert.deepEqual(runtime.state.intake, EMPTY_INTAKE);
});

test("decision A1: a workspace refusal parks the invocation unsent; a retry_workspace command ends the wait, and the pending prompt's dispatch carries the same invocation", () => {
    const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }) });
    let turnsRun = 0;
    let commanded = false;
    const { ops } = drive(runLoop(runtime), turnResponder({
        guids: ["inv-1"], activity: storeAnswers([1]),
        turn: () => (++turnsRun === 1
            ? turnResult({ type: "wait", seconds: 30, reason: "workspace unavailable: held elsewhere", gate: "workspace",
                code: "WORKSPACE_IN_USE", workerNodeId: "worker-a" }, notSentBy())
            : completed(sentBy())),
        // The person asks to retry the workspace while its wait is armed and the invocation is parked for it.
        onRace: () => {
            if (commanded || runtime.state.intake.invocation?.parked !== "gate" || runtime.state.activeTimer?.type !== "workspace_retry") {
                return undefined;
            }
            commanded = true;
            return { value: { index: 0, value: { type: "cmd", cmd: "retry_workspace", id: "retry-1" } } };
        },
    }));
    assert.ok(commanded);
    const turns = turnsOf(ops);
    assert.equal(turns.length, 2);
    // The refused attempt sent nothing; the invocation stayed unsent and parked for the gate, and started no turn of its own.
    assert.deepEqual(turns[0].input.intake, payloadOf([1]));
    // The command's wake is the pending prompt's dispatch: the gates are checked again, and it carries the same invocation.
    assert.deepEqual(turns[1].input.intake, payloadOf([1]));
    assert.ok(turns[1].input.prompt.startsWith(INTERNAL_SYSTEM_TURN_PROMPT), turns[1].input.prompt);
    assert.ok(turns[1].input.prompt.includes("Retrying the workspace"), turns[1].input.prompt);
    const ends = ops.filter(op => op.op === "activity" && op.input.op === "end").map(op => [op.input.invocationId, op.input.outcome]);
    assert.deepEqual(ends, [["inv-1", "completed"]]);
    assert.deepEqual(runtime.state.intake, EMPTY_INTAKE);
});

test("decision A1: an attempt that ends a gate's wait and is refused again parks the invocation again, unsent; it starts no turn of its own", () => {
    const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }) });
    let turnsRun = 0;
    let delivered = false;
    const { ops } = drive(runLoop(runtime), turnResponder({
        guids: ["inv-1"], activity: storeAnswers([1]),
        // Both attempts are refused by the budget gate before any send.
        turn: () => {
            turnsRun += 1;
            return turnResult({ type: "wait", seconds: 60, reason: "provider budget paused", gate: "budget" }, notSentBy());
        },
        onRace: () => {
            if (delivered || runtime.state.intake.invocation?.parked !== "gate") return undefined;
            delivered = true;
            return { value: { index: 0, value: { prompt: "hello" } } };
        },
        // Stop at drain's race for the budget wait that the second refusal armed.
        stop: op => turnsRun >= 2 && op?.op === "race",
    }));
    assert.ok(delivered);
    const turns = turnsOf(ops);
    assert.equal(turns.length, 2);
    // The message's turn carried the gate-parked invocation, and the gate refused it before any send.
    assert.deepEqual(turns[1].input.intake, payloadOf([1]));
    assert.match(turns[1].input.prompt, /^hello/);
    // Parked for the gate again, unsent and not ended; it wants no turn of its own, and drain waits for the gate's timer.
    assert.equal(runtime.state.intake.invocation.parked, "gate");
    assert.equal(runtime.state.intake.invocation.sent, false);
    assert.equal(endOf(ops), undefined);
    assert.equal(intakeWantsTurn(runtime), false);
    assert.equal(runtime.state.activeTimer?.type, "wait");
});

test("a hydration give-up before the attempt that would carry an unsent invocation parks it, and no turn runs", () => {
    const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }), needsHydration: true, blobEnabled: true });
    const { ops } = drive(runLoop(runtime), turnResponder({
        guids: ["inv-1"], activity: storeAnswers([1]),
        sessionActivity: op => (op.name === "hydrateSession" ? { throw: new Error("the session store is unreachable") } : { value: undefined }),
    }));
    assert.equal(turnsOf(ops).length, 0);
    assert.equal(ops.filter(op => op.op === "session" && op.name === "hydrateSession").length, 3);
    assert.equal(runtime.state.intake.invocation.parked, "hydration");
    assert.equal(runtime.state.intake.invocation.sent, false);
    assert.equal(runtime.intakeAttempt, null);
});

test("a parked invocation (not a gate's) starts no turn on its own, and one per newly claimed item; that item waits for the next invocation", () => {
    const runtime = makeRuntime({ intake: carried({ invocation: boundInvocation([1], { parked: "credential" }) }) });
    const { ops } = drive(runLoop(runtime), turnResponder({
        messages: [copy(2)], guids: ["claim-2"],
        activity: op => (op.name === WORKFLOW_INTAKE_ACTIVITIES.claim ? accepted(2, "claim-2") : storeAnswers([2])(op)),
        turn: op => completed({ invocationId: op.input.intake.invocationId, sent: true }),
    }));
    // Nothing is due and nothing starts a turn: drain blocks on the queue until the copy arrives.
    assert.equal(ops[0].op, "dequeue");
    const turns = turnsOf(ops);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0].input.intake, payloadOf([1]));
    const next = turns[1].input.intake.invocationId;
    assert.notEqual(next, "inv-1");
    assert.deepEqual(turns[1].input.intake, payloadOf([2], next));
    const ends = ops.filter(op => op.op === "activity" && op.input.op === "end").map(op => [op.input.invocationId, op.input.outcome]);
    assert.deepEqual(ends, [["inv-1", "completed"], [next, "completed"]]);
    assert.deepEqual(runtime.state.intake, EMPTY_INTAKE);
});

// ─── 6.2: decide's turn for the intake alone takes the timer note and the digest ──

test("6.2: decide's turn for the intake alone takes the released wait's note and the buffered child digest in its system context; the wait resumes after it", () => {
    const runtime = makeRuntime({
        intake: carried({ queue: [heldEntry(1)] }),
        subAgents: [{ orchId: "agent-1", sessionId: "child-1", task: "helper", status: "running" }],
        pendingChildDigest: { startedAtMs: NOW, updates: [{ sessionId: "child-1", updateType: "completed", content: "child result" }] },
    });
    runtime.state.activeTimer = { deadlineMs: NOW + 60_000, originalDurationMs: 120_000, reason: "nap", type: "wait" };
    const seen = [];
    const { ops } = drive(runLoop(runtime), turnResponder({
        guids: ["inv-1"], activity: storeAnswers([1]),
        turn: op => {
            seen.push({ prompt: op.input.prompt, intake: op.input.intake ?? null, digest: runtime.state.pendingChildDigest });
            return op.input.intake ? completed(sentBy()) : completed();
        },
        stop: op => isTurn(op) && seen.length >= 2,
    }));
    assert.equal(seen.length, 2);
    // The intake's own turn: its items in their own field; its prompt the internal one, with the note of the wait it
    // released (120 s, 60 s left) and the digest it took in its system context. The digest is no longer buffered.
    assert.deepEqual(seen[0].intake, payloadOf([1]));
    assert.ok(seen[0].prompt.startsWith(INTERNAL_SYSTEM_TURN_PROMPT), seen[0].prompt);
    assert.ok(seen[0].prompt.includes('interrupted your 120s timer (reason: "nap"). 60s elapsed, 60s remain.'), seen[0].prompt);
    assert.ok(seen[0].prompt.includes("Buffered child updates arrived"), seen[0].prompt);
    assert.ok(seen[0].prompt.includes("child result"), seen[0].prompt);
    assert.equal(seen[0].digest, null);
    // Its end is settled on the wake; the released wait resumed with its remaining 60 s and wakes the next turn.
    assert.equal(endOf(ops).input.outcome, "completed");
    assert.ok(ops.indexOf(endOf(ops)) < ops.indexOf(turnsOf(ops)[1]));
    assert.equal(seen[1].intake, null);
    assert.match(seen[1].prompt, /^The 60 second wait is now complete\./);
});

// ─── Review of 009109e2: W2-WIT3 and W2-WIT4 ────────────────

test("W2-WIT3: the owed retry of a thrown turn that carried nothing sends that attempt's key and carries nothing; the held item is formed after it and rides the next attempt", () => {
    const runtime = makeRuntime({
        intake: carried({ queue: [heldEntry(1)] }), ownedRetry: owedRetry({ thrownTurnKey: "key-T" }), blobEnabled: true,
    });
    // While that retry is owed, decide starts no turn for the intake alone, and drain releases no timer for one.
    assert.equal(intakeWantsTurn(runtime), false);
    const seen = [];
    const { ops } = drive(runLoop(runtime), turnResponder({
        activity: storeAnswers([1]),
        turn: op => {
            seen.push({ prompt: op.input.prompt, turnKey: op.input.snapshot?.turnKey ?? null, intake: op.input.intake ?? null });
            // The retry may adopt the thrown attempt's saved result, which has no witness: that attempt carried nothing.
            return op.input.intake ? completed({ invocationId: op.input.intake.invocationId, sent: true }) : completed();
        },
        stop: op => isTurn(op) && seen.length >= 2,
    }));
    assert.equal(seen.length, 2);
    assert.match(seen[0].prompt, /^retry words/);
    assert.equal(seen[0].turnKey, "key-T");
    assert.equal(seen[0].intake, null);
    // No invocation was formed or bound for the retry; the next attempt, under a key of its own, carries the item.
    const bind = kinds(ops).indexOf("settleWorkflowIntake:bind");
    assert.ok(bind > ops.indexOf(turnsOf(ops)[0]));
    assert.notEqual(seen[1].turnKey, "key-T");
    assert.ok(seen[1].intake !== null);
    assert.deepEqual(seen[1].intake, payloadOf([1], seen[1].intake.invocationId));
    assert.equal(endOf(ops).input.outcome, "completed");
});

test("W2-WIT3 / Q-W2-7: with an agent wait and a queued fire, a thrown turn's owed retry goes first under that attempt's key and carries nothing; the fire's turn then runs under a key of its own and carries the newly formed invocation", () => {
    // Q-W2-7: before the owed retry existed, the fire's turn ran first and sent the thrown key itself (1.0.81 and 1.0.82
    // reuse a key on a retry count and a thrown key alone), so it could adopt the retry's saved turn.
    const runtime = makeRuntime({
        intake: carried({ queue: [heldEntry(1)] }), ownedRetry: owedRetry({ thrownTurnKey: "key-T" }), blobEnabled: true,
        waitingForAgentIds: ["agent-1"], subAgents: [{ orchId: "agent-1", sessionId: "child-1", task: "helper", status: "running" }],
    });
    appendToFifo(runtime, [{ kind: "timer", timer: { type: "wait", deadlineMs: NOW, originalDurationMs: 60_000, reason: "nap" }, firedAtMs: NOW }]);
    runtime.state.activeTimer = { deadlineMs: NOW + 30_000, originalDurationMs: 30_000, reason: "waiting for 1 agent(s)", type: "agent-poll", agentIds: ["agent-1"] };
    const seen = [];
    const { ops } = drive(runLoop(runtime), turnResponder({
        activity: storeAnswers([1]),
        turn: op => {
            seen.push({
                prompt: op.input.prompt, turnKey: op.input.snapshot?.turnKey ?? null, intake: op.input.intake ?? null, retryCount: op.input.retryCount ?? 0,
            });
            return op.input.intake ? completed({ invocationId: op.input.intake.invocationId, sent: true }) : completed();
        },
        stop: op => isTurn(op) && seen.length >= 2,
    }));
    assert.equal(seen.length, 2);
    // The owed retry first, under the thrown attempt's key and with its count: whatever it adopts, it carried no batch.
    assert.match(seen[0].prompt, /^retry words/);
    assert.equal(seen[0].turnKey, "key-T");
    assert.equal(seen[0].retryCount, 1);
    assert.equal(seen[0].intake, null);
    // Then the queued fire's turn, under a new key and the count the retry's success reset: it carries the invocation
    // formed after the retry.
    assert.match(seen[1].prompt, /second wait is now complete/);
    assert.notEqual(seen[1].turnKey, "key-T");
    assert.equal(seen[1].retryCount, 0);
    assert.ok(seen[1].intake !== null);
    assert.deepEqual(seen[1].intake, payloadOf([1], seen[1].intake.invocationId));
    const bind = kinds(ops).indexOf("settleWorkflowIntake:bind");
    assert.ok(bind > ops.indexOf(turnsOf(ops)[0]));
    assert.equal(endOf(ops).input.outcome, "completed");
});

test("W2-WIT3: a thrown attempt that carried an invocation: its retry sends that attempt's key and carries that invocation, so a saved result it adopts is that invocation's own", () => {
    const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }), blobEnabled: true });
    const first = drive(runLoop(runtime), turnResponder({
        activity: storeAnswers([1]), turn: () => ({ throw: new Error("the turn end failed after the save") }),
    }));
    const thrown = turnsOf(first.ops)[0];
    const key = thrown.input.snapshot.turnKey;
    const invocationId = thrown.input.intake.invocationId;
    const can = first.ops.at(-1);
    assert.equal(can.op, "continueAsNew");
    assert.equal(Object.hasOwn(can.canInput, "thrownTurnKey"), false);
    assert.equal(can.canInput.ownedRetry.thrownTurnKey, key);
    assert.equal(can.canInput.intakeRetryInvocationId, invocationId);

    const retried = makeRuntime(can.canInput);
    const seen = [];
    const second = drive(runLoop(retried), turnResponder({
        activity: storeAnswers([1]),
        turn: op => {
            seen.push({ turnKey: op.input.snapshot?.turnKey ?? null, intake: op.input.intake ?? null });
            return completed({ invocationId, sent: true });
        },
        stop: op => isTurn(op) && seen.length >= 1,
    }));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { turnKey: key, intake: payloadOf([1], invocationId) });
    assert.equal(endOf(second.ops).input.outcome, "completed");
});

test("W2-WIT4: a carrying attempt whose adopted witness says exposed (it sent, then lost a racing commit) leaves the invocation sent: never completed, never parked unsent", () => {
    const exposed = { invocationId: "inv-1", sent: false, exposed: true };
    for (const [result, outcome] of [
        [{ type: "completed", content: "winner output" }, "interrupted"],
        [{ type: "error", message: 'Required tool "lookup" is not available in this session.', retryable: false }, "failed_indeterminate"],
    ]) {
        const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }) });
        const { ops } = drive(runLoop(runtime), turnResponder({
            guids: ["inv-1"], activity: storeAnswers([1]), turn: () => turnResult(result, exposed),
        }));
        assert.equal(turnsOf(ops).length, 1, result.type);
        assert.equal(endOf(ops).input.outcome, outcome, result.type);
    }
    // The same winner's witness without the loser's send parks the invocation unsent: the winner's own run never sent it.
    const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }) });
    drive(runLoop(runtime), turnResponder({
        guids: ["inv-1"], activity: storeAnswers([1]), turn: () => completed(notSentBy()),
    }));
    assert.equal(runtime.state.intake.invocation.parked, "not_sent");
    assert.equal(runtime.state.intake.invocation.sent, false);
});

// ─── Exposure protocol revision 2 (sections 2 and 5) ─────────

test("exposure r2: each carrying attempt records its own attempt id in its scheduled input; only the invocation's own retry says sentBefore", () => {
    const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }) });
    const first = drive(runLoop(runtime), turnResponder({
        guids: ["inv-1", "att-1"], activity: storeAnswers([1]), turn: () => turnResult({ type: "error", message: "the model call failed" }, sentBy()),
    }));
    const [failed] = turnsOf(first.ops);
    assert.deepEqual(failed.input.intakeAttempt, { attemptId: "att-1", sentBefore: false });
    // The attempt's id was drawn after the bind, before the turn: one recorded id for this carrying activity.
    const k = kinds(first.ops);
    assert.ok(k.indexOf("settleWorkflowIntake:bind") < first.ops.indexOf(failed));
    const can = first.ops.at(-1);
    assert.equal(can.canInput.intakeRetryInvocationId, "inv-1");
    // The retry takes the marker: a new id of its own, and sentBefore.
    const retried = makeRuntime(can.canInput);
    const second = drive(runLoop(retried), turnResponder({ guids: ["att-2"], activity: storeAnswers([1]), turn: () => completed(sentBy()) }));
    assert.deepEqual(turnsOf(second.ops)[0].input.intakeAttempt, { attemptId: "att-2", sentBefore: true });
    // A gate's park is carried by a new attempt: a new id, and no sentBefore.
    const gated = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }) });
    let turnsRun = 0;
    let delivered = false;
    const third = drive(runLoop(gated), turnResponder({
        guids: ["inv-1"], activity: storeAnswers([1]),
        turn: () => (++turnsRun === 1 ? turnResult({ type: "wait", seconds: 60, reason: "provider budget paused", gate: "budget" }, notSentBy()) : completed(sentBy())),
        onRace: () => {
            if (delivered || gated.state.intake.invocation?.parked !== "gate") return undefined;
            delivered = true;
            return { value: { index: 0, value: { prompt: "hello" } } };
        },
    }));
    const attempts = turnsOf(third.ops).map(turn => turn.input.intakeAttempt);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map(attempt => attempt.sentBefore), [false, false]);
    assert.notEqual(attempts[0].attemptId, attempts[1].attemptId);
});

test("exposure r2: a carrying attempt refused as possibly seen under another attempt ends its invocation, interrupted or failed_indeterminate after a failure; it is never parked or put on a retry, and the turn goes on without it", () => {
    const refused = { invocationId: "inv-1", sent: false, refused: "exposed" };
    for (const [result, outcome] of [
        [{ type: "completed", content: "answered without it" }, "interrupted"],
        [{ type: "stopped", reason: "Stopped by user" }, "interrupted"],
        [{ type: "error", message: 'Required tool "lookup" is not available in this session.', retryable: false }, "failed_indeterminate"],
    ]) {
        const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }) });
        const { ops } = drive(runLoop(runtime), turnResponder({ guids: ["inv-1"], activity: storeAnswers([1]), turn: () => turnResult(result, refused) }));
        assert.equal(turnsOf(ops).length, 1, result.type);
        assert.equal(endOf(ops).input.outcome, outcome, result.type);
        assert.deepEqual(runtime.state.intake, EMPTY_INTAKE, result.type);
    }
    // A retryable error: the invocation ends interrupted (its end due on the wake), and the turn's retry carries no marker.
    const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }) });
    const { ops } = drive(runLoop(runtime), turnResponder({
        guids: ["inv-1"], activity: storeAnswers([1]), turn: () => turnResult({ type: "error", message: "the model call failed" }, refused),
    }));
    const can = ops.at(-1);
    assert.equal(can.op, "continueAsNew");
    assert.equal(Object.hasOwn(can.canInput, "intakeRetryInvocationId"), false);
    // The retry is owed with its own count (review Q-W2-7); the session's count stays 0.
    assert.equal(can.canInput.ownedRetry.retryCount, 1);
    assert.equal(can.canInput.ownedRetry.thrownTurnKey, null);
    assert.equal(can.canInput.retryCount, 0);
    assert.deepEqual(can.canInput.intake.invocation.settle, { outcome: "interrupted", retry: null });
    assert.equal(can.canInput.intake.invocation.sent, true);
    // The retry runs the turn's own prompt, without the invocation, whose end is made on the wake.
    const retried = makeRuntime(can.canInput);
    const second = drive(runLoop(retried), turnResponder({ activity: storeAnswers([1]), turn: () => completed() }));
    assert.equal(endOf(second.ops).input.outcome, "interrupted");
    assert.equal(turnsOf(second.ops).length, 1);
    assert.equal(Object.hasOwn(turnsOf(second.ops)[0].input, "intake"), false);
    assert.deepEqual(retried.state.intake, EMPTY_INTAKE);
});

test("exposure r2: a carrying attempt refused as settled cannot be accepted while its invocation is bound and not ended: the execution fails visibly, nothing is settled", () => {
    const runtime = makeRuntime({ intake: carried({ queue: [heldEntry(1)] }) });
    const ops = [];
    assert.throws(() => drive(runLoop(runtime), turnResponder({
        guids: ["inv-1"], activity: storeAnswers([1]), turn: () => completed({ invocationId: "inv-1", sent: false, refused: "settled" }),
    }), ops), error => error.code === "WORKFLOW_INTAKE_BROKEN");
    assert.equal(turnsOf(ops).length, 1);
    assert.equal(ops.find(op => op.op === "cms").status, "failed");
    assert.equal(endOf(ops), undefined);
});

/**
 * runLoop at its history-size check (every third loop iteration): `stats`
 * answers the stats read; a continue-as-new is answered; any other operation
 * means the loop went on, and the drive stops there.
 */
function historyCheck(stats, versions = {}) {
    const runtime = makeRuntime();
    Object.assign(runtime.versions, versions);
    runtime.state.loopIteration = 2;
    const ops = [];
    const respond = op => {
        if (op.op === "manager" && op.method === "getOrchestrationStats") return stats;
        if (op.op === "continueAsNew") return { value: undefined };
        return { stop: true };
    };
    return { ops, run: () => drive(runLoop(runtime), respond, ops) };
}

test("the history-size continue-as-new: a large history continues as new, a failed stats read is tolerated, and the continue-as-new's own refusal fails the execution", () => {
    const LARGE = { value: { historySizeBytes: 900 * 1024 } };
    const big = historyCheck(LARGE);
    const continued = big.run();
    assert.deepEqual(big.ops.map(op => op.method ?? op.op), ["getOrchestrationStats", "continueAsNew"]);
    assert.equal(big.ops[1].version, "1.0.83");
    assert.equal(continued.result, "");

    // A failed stats read is only traced: no continue-as-new, and the loop goes on.
    const failed = historyCheck({ throw: new Error("the stats read failed") });
    failed.run();
    assert.equal(failed.ops[0].method, "getOrchestrationStats");
    assert.ok(failed.ops.length >= 2);
    assert.ok(!failed.ops.some(op => op.op === "continueAsNew"));

    // The floor refuses an older target: the execution fails, as at every other continue-as-new, instead of the refusal
    // being traced as a failed stats read while the loop goes on.
    const older = historyCheck(LARGE, { latestVersion: "1.0.82" });
    assert.throws(() => older.run(), /does not continue as new to the older 1\.0\.82/);
    assert.deepEqual(older.ops.map(op => op.method ?? op.op), ["getOrchestrationStats"]);
});
