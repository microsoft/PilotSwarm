/**
 * Orchestration 1.0.83, inactive: the durable intake's store side wired into
 * drain, the pre-dispatch sweep and the wake (intake-wiring.ts; design
 * docs/proposals/workflow-durable-intake.md 3, 5.3, 5.4, 6.2 and section 8,
 * amendment 2). The real drain and decide generators are driven against a
 * fake durable context: every operation they yield is recorded and answered
 * by the test, as duroxide would answer it from history.
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
 *   P2-1); its held cancel is written on the wake, with no other stimulus.
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
 *
 * Run: node --test test/unit/orchestration-intake-wiring-1-0-83.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createInitialState, deriveOptions } from "../../dist/orchestration_1_0_83/state.js";
import { appendToFifo, decide, drain } from "../../dist/orchestration_1_0_83/queue.js";
import { INTAKE_RECORDED_EVENT, runIntakeWake } from "../../dist/orchestration_1_0_83/intake-wiring.js";
import { intakeDueAtMs } from "../../dist/orchestration_1_0_83/intake-machine.js";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../dist/activity-routing.js";
import {
    WORKFLOW_INTAKE_ACTIVITIES, intakeBoundItem, intakeEnvelopeClientMessageId, intakeItemBytes,
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
        traceInfo: () => {},
    };
    // A Proxy, so a context method the code calls that this test does not know is a no-op, not a crash in another place.
    const ctx = new Proxy(explicit, { get: (target, prop) => (prop in target ? target[prop] : () => undefined) });
    const input = { sessionId: SESSION, config: {}, ...extraInput };
    const options = deriveOptions(input);
    return {
        kv, ctx, input, options, state: createInitialState(input, options), versions: { currentVersion: "1.0.83", latestVersion: "1.0.83" },
        session: { runTurn: () => ({ op: "runTurn" }) },
        manager: {
            recordSessionEvent: (sessionId, events) => ({ op: "record", sessionId, events }),
            updateCmsState: (sessionId, status, message) => ({ op: "cms", sessionId, status, message }),
            loadKnowledgeIndex: () => ({ op: "knowledge" }),
        },
    };
}

/**
 * Drive a generator to its end, answering each yielded operation with
 * `respond(op)`: `{ value }` is sent back, `{ throw }` thrown in, `{ stop }`
 * returns it. The operations are pushed to `ops` as they come, so a test can
 * read them after a throw.
 */
function drive(generator, respond, ops = []) {
    let step = generator.next();
    while (!step.done) {
        const op = step.value;
        ops.push(op);
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

// ─── Arrival ─────────────────────────────────────────────────

test("drain: an enveloped copy takes the intake path only; claimed with the capability tag, held, its canonical id in the window; no clock read", () => {
    const runtime = makeRuntime();
    const { ops } = drive(drain(runtime), responder({ messages: [copy(1)], guids: ["claim-1"], activity: () => accepted(1, "claim-1") }));
    assert.deepEqual(kinds(ops), ["dequeue", "newGuid", "claimWorkflowIntake:accept"]);
    assert.equal(ops[2].name, WORKFLOW_INTAKE_ACTIVITIES.claim);
    assert.deepEqual(ops[2].input, { recipientSessionId: SESSION, envelope: envelope(1), claimId: "claim-1", mode: "accept" });
    assert.deepEqual(runtime.state.intake.queue.map(entry => [entry.kind, entry.exchangeId, entry.claimId, entry.cancel]),
        [["held", exchange(1), "claim-1", false]]);
    // Its canonical id enters the duplicate window; the queued copy's own ids and text are never read.
    assert.ok(runtime.state.recentClientMessageIds.includes(canonical(1)));
    assert.ok(!runtime.state.recentClientMessageIds.includes("plain-1"));
    assert.deepEqual(fifoItems(runtime), []);
    // Nothing is due: drain blocks on the next message as before.
    assert.equal(intakeDueAtMs(runtime.state.intake), null);
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
    // The failure reads the clock once; the race reads it once and arms one timer for the remaining time.
    assert.deepEqual(kinds(ops), ["dequeue", "newGuid", "claimWorkflowIntake:accept", "utcNow", "utcNow", "race", "claimWorkflowIntake:accept"]);
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
    assert.deepEqual(kinds(ops), ["dequeue", "utcNow", "race", "settleWorkflowIntake:cancel_held", "record"]);
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
        afterSweep: op => op.op === "race" && ++races === 2,
    }));
    assert.deepEqual(kinds(failed.ops), ["dequeue", "utcNow", "race", "settleWorkflowIntake:cancel_held", "utcNow", "utcNow", "race"]);
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
