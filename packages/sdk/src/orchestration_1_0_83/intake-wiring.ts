/**
 * Orchestration 1.0.83 (INACTIVE): the durable intake wired into drain, the
 * pre-dispatch sweep, decide and the turn (design
 * docs/proposals/workflow-durable-intake.md 3, 5.3 to 5.5, 6.1, 6.2 and
 * section 8, amendment 2). The transitions are intake-machine.ts's; this
 * module makes their store writes, applies the answers, and decides what
 * each turn attempt carries and what its outcome does.
 *
 * - Arrival (5.3, 6.2): a dequeued message that carries `workflowIntake`
 *   takes the intake path only, in drain and in the sweep, never the
 *   ordinary path: its envelope's shape is checked (malformed: recorded,
 *   nothing placed), a claim id is drawn, and the claim is made and applied.
 *   Nothing else of the message is read. A newly held item's canonical id
 *   enters the duplicate window.
 * - Tombstones (5.5; review of b92ff04b, P2-1): each one is latched on
 *   every copy it names before anything else is done with it, from the
 *   tombstone's own ids, so neither the bounded cancel set's eviction nor a
 *   stashed prompt that consumes the same id can lose the latch; the writes
 *   it decides are due now on the wake.
 * - The wake (5.4, N2; review of b92ff04b, P2-3): when the intake's due
 *   write is the earliest deadline, drain races the queue for it, for a
 *   moment at least, and each wake makes at most one intake activity call:
 *   a queued message, a command first, waits for one store write at most.
 *   A claim that decides its holder's settle latches it, and the settle is
 *   a later wake's write. Store writes only, never a turn and never an
 *   unpark.
 * - One write at a time (review of 813de112): each write's call is made and
 *   its answer applied against that call before anything else is read or
 *   latched, so an answer acknowledges only what its call named.
 * - Failures: an activity that throws (a store outage after its own
 *   retries, a worker without a workflow store, a lost answer) leaves its
 *   write due again at its doubled retry, and the clock is read only then.
 *   A thrown failure the activity marked WORKFLOW_INTAKE_NON_RETRYABLE (no
 *   retry can fix it), the store's refusal (a broken invariant or a
 *   malformed input), a malformed answer, a write that cannot be routed, a
 *   broken invariant in the transitions and the one fail-stop case fail the
 *   execution visibly: the session is marked failed and nothing more is
 *   dispatched. None of them is ever retried.
 * - Recording: malformed copies, the recorded claim answers (duplicate,
 *   conflict, unverified and the others) and every cancel the intake makes
 *   are best-effort session events (INTAKE_RECORDED_EVENT); the store writes
 *   the rows' counters and the refusals' own events. An intake tombstone is
 *   not consumed: once latched it decides nothing more, and it leaves the
 *   bounded cancel set as any other does.
 * - Turns (5.5, I8, I11): before each turn attempt the session's tombstones
 *   are latched, the next invocation is formed and bound when none exists
 *   (its bind is the admission), and the attempt carries it when the carry
 *   rules say so; the attempt's dispatch (did not run, threw, or its result's
 *   witness) and the way its turn went decide the next step by the
 *   transition table: its turn's retry, parked with a cause, or an end
 *   settled on the wake. A sent invocation rides only its own turn's retry:
 *   the attempt that sent it records the retry marker with the pending
 *   prompt, and only decide's dispatch of that prompt takes it; any other
 *   attempt, one that runs while the prompt is held, starts new and carries
 *   no sent invocation (review D-W2-1). An attempt that sends the key of the
 *   thrown attempt it retries, and so may adopt that attempt's saved result,
 *   carries only what that attempt carried: the invocation its marker names,
 *   or none; nothing is formed for it, and no turn for the intake alone
 *   starts while such a retry is pending (review W2-WIT3). The held retry
 *   keeps its own retry count and thrown-turn key, carried with the marker,
 *   and its dispatch restores them (review O-W2-3); an unanswered arrival is
 *   a flag every continue-as-new carries (review O-W2-5). With nothing else
 *   to dispatch and no timer armed, decide starts a turn for a ready
 *   invocation alone, or for a parked one that a newly claimed item resumes
 *   (not a gate's), on the internal system-turn prompt, with what drain gives
 *   a newly arrived prompt as its system context: the released timer's note
 *   and the buffered child digest (6.2); never during a graceful shutdown.
 *
 * Inactive: no production registry entry, latest version, start, upward
 * continue-as-new, worker capability or tool routes to this code; only
 * tests register 1.0.83 and the turn activities that carry `intake`.
 */
import { routeWorkflowRequestActivity } from "../activity-routing.js";
import { IntakeShapeError, WORKFLOW_INTAKE_ACTIVITIES, WORKFLOW_INTAKE_NON_RETRYABLE, intakeObject } from "../workflow/v2/intake.js";
import {
    IntakeInvariantError,
    applyIntakeAttempt,
    applyIntakeBindFailure,
    applyIntakeBound,
    applyIntakeClaim,
    applyIntakeEndFailure,
    applyIntakeEnded,
    applyIntakeHeldCancelFailure,
    applyIntakeHeldCancelled,
    applyIntakeHolderSettle,
    applyIntakeInvocationCancelFailure,
    applyIntakeInvocationCancelled,
    assertNoIntakeWitness,
    carryIntakeInvocation,
    formIntakeInvocation,
    intakeArrivalClaimCall,
    intakeArrivalEnvelope,
    intakeBindCall,
    intakeCanForm,
    intakeDueWork,
    intakeEndCall,
    intakeInvocationCancelCall,
    intakeOwnTurnStimulus,
    intakeRefuseClaimCall,
    intakeUnclaimedRetryCall,
    latchIntakeCancels,
    type IntakeAttemptEvent,
    type IntakeAttemptStart,
    type IntakeCancelCheck,
    type IntakeClaimCall,
    type IntakeClaimResult,
    type IntakeHolderSettle,
    type IntakeTurnPayload,
} from "./intake-machine.js";
import { intakeAwaitingRetry } from "./intake-state.js";
import { flushPendingChildDigestIntoPrompt, publishStatus } from "./lifecycle.js";
import { INTERNAL_SYSTEM_TURN_PROMPT, touchRecentClientMessageIds, type DurableSessionRuntime } from "./state.js";
import { appendSystemContext } from "./utils.js";

/** Where a copy is handled: drain, the sweep before a prompt's dispatch (design 6.2), or the wake's retry of a waiting copy. */
export type IntakeSource = "drain" | "sweep" | "wake";

/** What became of a dequeued copy (design 2): held, waiting for its claim, settled by its holder (cancelled or refused), or recorded. */
export type IntakeArrival = "held" | "waiting" | "settled" | "recorded";

/** The best-effort diagnostic event of everything the intake records or cancels (design 5.4). */
export const INTAKE_RECORDED_EVENT = "session.workflow_intake_recorded";

/** The execution stops (design 5.4, 9 row 11): a store outage while every waiting entry is taken. */
export class IntakeFailStopError extends Error {
    readonly code = "WORKFLOW_INTAKE_FAIL_STOP";
    constructor(readonly exchangeId: string, message: string) {
        super(message);
        this.name = "IntakeFailStopError";
    }
}

/**
 * A store write failed in a way no retry can fix: its activity marked the
 * failure WORKFLOW_INTAKE_NON_RETRYABLE, or the write cannot be routed. The
 * execution fails visibly; the write is not made again (review of b92ff04b,
 * P2-2, P3-1).
 */
export class IntakeWriteFailedError extends Error {
    readonly code = "WORKFLOW_INTAKE_NON_RETRYABLE";
    constructor(message: string) {
        super(message);
        this.name = "IntakeWriteFailedError";
    }
}

/** The session's tombstones, and those of a cancel message being handled before they join (or are evicted from) the cancel set. */
function cancelCheck(runtime: DurableSessionRuntime, incoming: readonly string[] = []): IntakeCancelCheck {
    const cancelled = runtime.state.cancelledMessageIds;
    return clientMessageId => cancelled.has(clientMessageId) || incoming.includes(clientMessageId);
}

// ─── One store write ─────────────────────────────────────────

type IntakeAnswer = { ok: true; result: unknown } | { ok: false; code: string; message: string };

/** An intake activity's answer: the store's result, or its refusal; anything else is malformed. */
function answerOf(raw: unknown, name: string): IntakeAnswer {
    let value: unknown = raw;
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        } catch {
            throw new IntakeShapeError(name, "is not JSON");
        }
    }
    const ok: unknown = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>).ok : undefined;
    if (ok === true) return { ok: true, result: intakeObject(value, name, ["ok", "result"]).result };
    if (ok === false) {
        const error = intakeObject(intakeObject(value, name, ["ok", "error"]).error, `${name}.error`, ["code", "message"]);
        if (typeof error.code !== "string" || typeof error.message !== "string") throw new IntakeShapeError(`${name}.error`, "is not a code and a message");
        return { ok: false, code: error.code, message: error.message };
    }
    throw new IntakeShapeError(`${name}.ok`, "is not true or false");
}

/** A write's outcome: the store's result, or the activity's failure after its own retries (the write is then due again). */
type IntakeWritten = { answered: true; result: unknown } | { answered: false; failure: string };

/**
 * Make one store write with the workflow-request capability tag (design
 * section 8). A write that cannot be routed fails the execution. Only the
 * activity's own failure is caught, by its message, the only part of it the
 * history keeps: one the activity marked WORKFLOW_INTAKE_NON_RETRYABLE fails
 * the execution; any other (an outage, a lost answer) leaves the write to be
 * made again when due. The store's refusal is a broken invariant.
 */
function* intakeWrite(runtime: DurableSessionRuntime, activity: keyof typeof WORKFLOW_INTAKE_ACTIVITIES, input: Record<string, unknown>)
    : Generator<any, IntakeWritten, any> {
    const name = WORKFLOW_INTAKE_ACTIVITIES[activity];
    let task: unknown;
    try {
        task = routeWorkflowRequestActivity(runtime.ctx.scheduleActivity(name, input));
    } catch (error: any) {
        throw new IntakeWriteFailedError(`${name} cannot be scheduled with the workflow-request capability: ${String(error?.message ?? error)}`);
    }
    let raw: unknown;
    try {
        raw = yield task;
    } catch (error: any) {
        const failure = String(error?.message ?? error);
        if (failure.includes(WORKFLOW_INTAKE_NON_RETRYABLE)) throw new IntakeWriteFailedError(`${name} failed, and no retry can fix it: ${failure}`);
        runtime.ctx.traceInfo(`[intake] ${name} failed; it is made again when due: ${failure}`);
        return { answered: false, failure };
    }
    const answer = answerOf(raw, name);
    if (!answer.ok) throw new IntakeInvariantError(null, `the workflow store refused ${name} (${answer.code}): ${answer.message}`);
    return { answered: true, result: answer.result };
}

/** A settle list's answer names the call's items in order, each with its flag (true: written now; false: already so, a replay). */
function checkListAnswer(raw: unknown, label: string, flag: "cancelled" | "settled", items: ReadonlyArray<{ exchangeId: string }>): void {
    const listed = intakeObject(raw, label, ["items"]).items;
    if (!Array.isArray(listed) || listed.length !== items.length) throw new IntakeShapeError(`${label}.items`, `is not a list of ${items.length} items`);
    listed.forEach((entry: unknown, index: number) => {
        const answered = intakeObject(entry, `${label}.items[${index}]`, ["exchangeId", flag]);
        if (answered.exchangeId !== items[index].exchangeId) {
            throw new IntakeInvariantError(items[index].exchangeId, `the ${label} answer names ${String(answered.exchangeId)} in its place`);
        }
        if (typeof answered[flag] !== "boolean") throw new IntakeShapeError(`${label}.items[${index}].${flag}`, "is not a boolean");
    });
}

// ─── Failing visibly ─────────────────────────────────────────

/**
 * Fail the execution visibly (design 5.2, 9 rows 11 and 15): the session is
 * marked failed with the reason and the error is thrown on, so nothing more
 * is dispatched. Never a retry.
 */
function* failIntake(runtime: DurableSessionRuntime, error: Error): Generator<any, never, any> {
    runtime.ctx.traceInfo(`[intake] the execution fails: ${error.message}`);
    publishStatus(runtime, "failed", { error: error.message, fatal: true });
    yield runtime.manager.updateCmsState(runtime.input.sessionId, "failed", error.message);
    throw error;
}

/** Run an intake step; a broken invariant, a malformed answer, the store's refusal or the fail-stop case fails the execution visibly. */
function* guarded<T>(runtime: DurableSessionRuntime, step: Generator<any, T, any>): Generator<any, T, any> {
    try {
        return yield* step;
    } catch (error) {
        if (error instanceof IntakeInvariantError || error instanceof IntakeShapeError || error instanceof IntakeFailStopError
            || error instanceof IntakeWriteFailedError) {
            return yield* failIntake(runtime, error);
        }
        throw error;
    }
}

/** A best-effort diagnostic event (design 5.4). */
function* recordIntake(runtime: DurableSessionRuntime, data: Record<string, unknown>): Generator<any, void, any> {
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{ eventType: INTAKE_RECORDED_EVENT, data }]);
}

function recordedResult(result: Exclude<IntakeClaimResult, { result: "accepted" }>): Record<string, unknown> {
    if (result.result === "duplicate" || result.result === "conflict") return { outcome: result.result, state: result.state };
    if (result.result === "unverified") return { outcome: "unverified", reason: result.reason };
    return { outcome: result.result };
}

// ─── Arrival and claim (design 5.3, 5.4) ─────────────────────

/**
 * A dequeued message that carries `workflowIntake` (design 3, 5.3): the
 * intake path only. Its envelope's shape is checked (malformed: recorded,
 * nothing placed), a claim id is drawn, and the claim is made and applied
 * (claimCopy). The queued prompt, sender, client ids and the rest of the
 * message are not read.
 */
export function* intakeArrival(runtime: DurableSessionRuntime, raw: unknown, source: "drain" | "sweep"): Generator<any, IntakeArrival, any> {
    return yield* guarded(runtime, arriveCopy(runtime, raw, source));
}

function* arriveCopy(runtime: DurableSessionRuntime, raw: unknown, source: "drain" | "sweep"): Generator<any, IntakeArrival, any> {
    const arrival = intakeArrivalEnvelope(raw);
    if ("malformed" in arrival) {
        runtime.ctx.traceInfo(`[intake] ${source}: refused a malformed envelope (${arrival.malformed.message})`);
        yield* recordIntake(runtime, { outcome: "malformed", source, path: arrival.malformed.path, reason: arrival.malformed.message });
        return "recorded";
    }
    const claimId: string = yield runtime.ctx.newGuid();
    return yield* claimCopy(runtime, intakeArrivalClaimCall(runtime.state.intake, claimId, arrival.envelope), source);
}

/**
 * Make a claim and apply its answer (design 5.3, 5.4): held, its canonical
 * id entering the duplicate window; a holder's settle decided (cancelled or
 * refused), latched as a settling entry and made by a later wake, or written
 * now when every waiting entry was taken so it could not be latched; waiting
 * as an unclaimed entry when the claim failed; claimed again in mode refuse
 * when every waiting entry was taken; or recorded. So a claim is one intake
 * activity call but when the waiting entries are full (review of b92ff04b,
 * P2-3). The one fail-stop case fails the execution.
 */
function* claimCopy(runtime: DurableSessionRuntime, first: IntakeClaimCall, source: IntakeSource): Generator<any, IntakeArrival, any> {
    const { ctx, state } = runtime;
    let call = first;
    for (;;) {
        const written = yield* intakeWrite(runtime, "claim", {
            recipientSessionId: runtime.input.sessionId, envelope: call.envelope, claimId: call.claimId, mode: call.mode,
        });
        const failedAt: number | null = written.answered ? null : yield ctx.utcNow();
        const step = applyIntakeClaim(state.intake, call, written.answered ? { result: written.result } : { failed: true },
            { nowMs: failedAt, isCancelled: cancelCheck(runtime) });
        state.intake = step.state;
        const decision = step.decision;
        switch (decision.kind) {
            case "held":
                touchRecentClientMessageIds(state, [decision.entry.clientMessageId]);
                // A newly claimed item: a resume stimulus of a parked invocation until an attempt that carries it answers it
                // (5.5); carried by continue-as-new until then (review O-W2-5).
                state.intakeArrivalPending = true;
                return "held";
            case "already_placed":
                return "recorded";
            case "recorded":
                yield* recordIntake(runtime, { ...recordedResult(decision.result), exchangeId: call.envelope.exchangeId, claimId: call.claimId, source });
                return "recorded";
            case "settle_holder":
                // Latched: due now, a later wake's write. Not latched: only written now can it be made at all.
                if (!decision.latched) yield* settleHolder(runtime, decision, source);
                return "settled";
            case "unclaimed":
                return "waiting";
            case "claim_refuse":
                call = intakeRefuseClaimCall(call);
                break;
            case "fail_stop":
                throw new IntakeFailStopError(decision.exchangeId, decision.message);
        }
    }
}

/**
 * Write a holder's settle and apply it (design 5.2, 5.6): cancelled as
 * settle cancel_held, refused_full and refused_size as settle refuse (the
 * store's refusal transaction, which writes the refusal's own events).
 * Latched, a failure is due again on the wake; not latched, it stops the
 * execution.
 */
function* settleHolder(runtime: DurableSessionRuntime, settle: Pick<IntakeHolderSettle, "exchangeId" | "claimId" | "outcome" | "latched">,
    source: IntakeSource): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const item = { exchangeId: settle.exchangeId, claimId: settle.claimId };
    const written = yield* intakeWrite(runtime, "settle", settle.outcome === "cancelled"
        ? { op: "cancel_held", recipientSessionId: runtime.input.sessionId, items: [item] }
        : { op: "refuse", recipientSessionId: runtime.input.sessionId, exchangeId: item.exchangeId, claimId: item.claimId, outcome: settle.outcome });
    if (written.answered) {
        if (settle.outcome === "cancelled") checkListAnswer(written.result, "cancel_held", "cancelled", [item]);
        else if (typeof intakeObject(written.result, "refuse", ["refused"]).refused !== "boolean") throw new IntakeShapeError("refuse.refused", "is not a boolean");
    }
    const failedAt: number | null = written.answered ? null : yield ctx.utcNow();
    const step = applyIntakeHolderSettle(state.intake, settle, written.answered, failedAt);
    state.intake = step.state;
    if (step.decision.kind === "fail_stop") throw new IntakeFailStopError(step.decision.exchangeId, step.decision.message);
    if (step.decision.kind === "settled" && settle.outcome === "cancelled") yield* recordIntake(runtime, { outcome: "cancelled", ...item, source });
}

// ─── Tombstones (design 5.5) ─────────────────────────────────

/**
 * Latch every tombstone on each copy in the intake state that it names
 * (latchIntakeCancels): the session's cancel set and `incoming`, the ids of
 * a cancel message being handled. Drain and the sweep call it first thing
 * at each cancel message, before its ids join the bounded cancel set (which
 * may evict them) and before a stashed prompt with the same id consumes
 * them (review of b92ff04b, P2-1). The writes decided are due now on the
 * wake; a latch is never undone.
 */
export function latchIntakeTombstones(runtime: DurableSessionRuntime, incoming: readonly string[] = []): void {
    runtime.state.intake = latchIntakeCancels(runtime.state.intake, cancelCheck(runtime, incoming));
}

// ─── The wake (design 5.4, N2) ───────────────────────────────

/**
 * One wake: the first of the intake's store writes due at `nowMs`, in
 * intakeDueWork's order (claims of waiting copies under their own claim ids
 * and holder settles, oldest first; the latched held cancels as one write;
 * then the invocation's bind, cancel write or end), as at most one intake
 * activity call. Drain races the queue before every wake, so a queued
 * message, a command first, waits for one store write at most (review of
 * b92ff04b, P2-3). A write that fails is due again later. Store writes only:
 * no turn, no unparking.
 */
export function* runIntakeWake(runtime: DurableSessionRuntime, nowMs: number): Generator<any, void, any> {
    yield* guarded(runtime, wakeOnce(runtime, nowMs));
}

function* wakeOnce(runtime: DurableSessionRuntime, nowMs: number): Generator<any, void, any> {
    const work = intakeDueWork(runtime.state.intake, nowMs)[0];
    if (work === undefined) return;
    if (work.kind === "claim") {
        yield* claimCopy(runtime, intakeUnclaimedRetryCall(runtime.state.intake, work.claimId), "wake");
    } else if (work.kind === "holder_settle") {
        yield* settleHolder(runtime, { exchangeId: work.exchangeId, claimId: work.claimId, outcome: work.outcome, latched: true }, "wake");
    } else if (work.kind === "cancel_held") {
        yield* cancelHeld(runtime, work.items);
    } else if (work.kind === "bind") {
        yield* bindInvocation(runtime);
    } else if (work.kind === "cancel_invocation") {
        yield* cancelInvocation(runtime);
    } else {
        yield* endInvocation(runtime);
    }
}

/** The latched held cancels' one write (design 5.5, settle cancel_held), reported with exactly the items it named. */
function* cancelHeld(runtime: DurableSessionRuntime, items: Array<{ exchangeId: string; claimId: string }>): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const named = items.map(item => item.exchangeId);
    const written = yield* intakeWrite(runtime, "settle", { op: "cancel_held", recipientSessionId: runtime.input.sessionId, items });
    if (!written.answered) {
        const failedAt: number = yield ctx.utcNow();
        state.intake = applyIntakeHeldCancelFailure(state.intake, named, failedAt);
        return;
    }
    checkListAnswer(written.result, "cancel_held", "cancelled", items);
    state.intake = applyIntakeHeldCancelled(state.intake, named);
    yield* recordIntake(runtime, { outcome: "cancelled", source: "held", items });
}

/** The invocation's bind (design 5.2, 5.5): the admission, before anything carries it. */
function* bindInvocation(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const call = intakeBindCall(state.intake);
    const written = yield* intakeWrite(runtime, "settle", {
        op: "bind", recipientSessionId: runtime.input.sessionId, invocationId: call.invocationId, items: call.items,
    });
    if (!written.answered) {
        const failedAt: number = yield ctx.utcNow();
        state.intake = applyIntakeBindFailure(state.intake, failedAt).state;
        return;
    }
    state.intake = applyIntakeBound(state.intake, written.result);
}

/** The invocation's cancel write (design 5.5), acknowledged for exactly the items its call named. */
function* cancelInvocation(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const call = intakeInvocationCancelCall(state.intake);
    const op = call.kind === "unsent" ? "cancel_unsent" : "request_cancel";
    const written = yield* intakeWrite(runtime, "settle", {
        op, recipientSessionId: runtime.input.sessionId, invocationId: call.invocationId, items: call.items,
    });
    if (!written.answered) {
        const failedAt: number = yield ctx.utcNow();
        state.intake = applyIntakeInvocationCancelFailure(state.intake, call, failedAt).state;
        return;
    }
    checkListAnswer(written.result, op, "settled", call.items);
    state.intake = applyIntakeInvocationCancelled(state.intake, call);
    yield* recordIntake(runtime, {
        outcome: call.kind === "unsent" ? "cancelled" : "cancel_requested", source: "invocation", invocationId: call.invocationId, items: call.items,
    });
}

/** The invocation's end settlement (design 5.2, 5.5), applied against its call; a cancel latched since it is made first. */
function* endInvocation(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const call = intakeEndCall(state.intake);
    const written = yield* intakeWrite(runtime, "settle", {
        op: "end", recipientSessionId: runtime.input.sessionId, invocationId: call.invocationId, outcome: call.outcome, items: call.items,
    });
    if (!written.answered) {
        const failedAt: number = yield ctx.utcNow();
        state.intake = applyIntakeEndFailure(state.intake, call, failedAt).state;
        return;
    }
    state.intake = applyIntakeEnded(state.intake, call, written.result).state;
}

// ─── Turns: forming, carrying and the attempt's outcome (design 5.5) ──

/**
 * Form the next invocation and bind it (design 5.5): its id drawn first, the
 * held entries moved into it in one synchronous step, then its bind, with no
 * other yield between. A bind that fails leaves it unbound, its bind due on
 * the wake; nothing carries it until it is bound.
 */
function* formAndBind(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const invocationId: string = yield runtime.ctx.newGuid();
    runtime.state.intake = formIntakeInvocation(runtime.state.intake, invocationId);
    yield* bindInvocation(runtime);
}

/**
 * The first step of every turn attempt (processPrompt; design 5.5, 6.1): the
 * session's tombstones are latched, the next invocation is formed and bound
 * when none exists, and the carry rules say whether this attempt carries it.
 * Only decide's dispatch of the pending prompt takes the retry marker, and
 * so carries the sent invocation it names, as its turn's retry; any other
 * attempt starts new with its stimulus, and a sent invocation stays with its
 * held prompt (I8; review D-W2-1). An attempt that sends the key of the
 * thrown attempt it retries carries only what that attempt carried (review
 * W2-WIT3, intakeReusesThrownTurnKey). Returns the payload for the turn's
 * `intake` field, or null when the attempt carries none.
 */
export function* intakeBeforeAttempt(runtime: DurableSessionRuntime): Generator<any, IntakeTurnPayload | null, any> {
    return yield* guarded(runtime, beforeAttempt(runtime));
}

function* beforeAttempt(runtime: DurableSessionRuntime): Generator<any, IntakeTurnPayload | null, any> {
    const { state } = runtime;
    const stimulus = runtime.intakeStimulus ?? "other";
    const pendingDispatch = runtime.intakePendingDispatch === true;
    runtime.intakeStimulus = undefined;
    runtime.intakePendingDispatch = undefined;
    const inFlight = runtime.intakeAttempt;
    if (inFlight) {
        throw new IntakeInvariantError(null, `an attempt starts before the outcome of the attempt that carried invocation ${inFlight.invocationId} is applied`);
    }
    const marker = pendingDispatch ? state.intakeRetryInvocationId : null;
    if (pendingDispatch) state.intakeRetryInvocationId = null;
    const awaiting = intakeAwaitingRetry(state.intake);
    if (marker !== null && awaiting?.invocationId !== marker) {
        throw new IntakeInvariantError(null, `the pending prompt's retry names invocation ${marker}, which awaits no retry`);
    }
    if (awaiting !== null && marker === null && state.intakeRetryInvocationId !== awaiting.invocationId) {
        throw new IntakeInvariantError(null, `invocation ${awaiting.invocationId} awaits its turn's retry, but no pending prompt carries it`);
    }
    if (marker !== null) {
        // Review O-W2-3: the retry runs with its own retry count and thrown-turn key, as its continue-as-new carried them,
        // whatever a turn that ran while it was held did to the session's (a success resets the count): it sends that
        // key again, so a saved result of its thrown attempt is adopted, never run a second time.
        const held = state.intakeRetryAttempt;
        if (held === null) throw new IntakeInvariantError(null, `the retry of invocation ${marker} has no retry count and turn key`);
        state.retryCount = held.retryCount;
        state.thrownTurnKey = held.thrownTurnKey;
        state.intakeRetryAttempt = null;
    }
    latchIntakeTombstones(runtime);
    if (marker === null && intakeReusesThrownTurnKey(state)) {
        // The saved result this attempt may adopt says nothing of any batch
        // its thrown attempt did not carry, and that attempt carried none (it
        // would have left the marker): this one carries none either.
        runtime.intakeAttempt = null;
        return null;
    }
    if (intakeCanForm(state.intake)) yield* formAndBind(runtime);
    const start: IntakeAttemptStart = marker !== null ? { kind: "retry", invocationId: marker } : { kind: "new", stimulus };
    const carried = carryIntakeInvocation(state.intake, start);
    state.intake = carried.state;
    if (carried.carry === null) {
        runtime.intakeAttempt = null;
        return null;
    }
    runtime.intakeAttempt = { invocationId: carried.carry.invocationId, dispatch: null };
    // This attempt answers every item claimed so far: one attempt per arrival (5.5).
    state.intakeArrivalPending = false;
    return carried.carry;
}

/** The attempt that would carry the invocation threw (design 5.5): it possibly sent it. Its turn's handling then notes how the turn went. */
export function noteIntakeThrew(runtime: DurableSessionRuntime): void {
    const record = runtime.intakeAttempt;
    if (record) runtime.intakeAttempt = { invocationId: record.invocationId, dispatch: { ran: true, threw: true } };
}

/**
 * The attempt returned a result (design 5.5): its raw `intakeDispatch`
 * witness is kept for the turn's outcome, where none counts as possibly
 * sent. An attempt that carried no invocation returns no witness: one that
 * does is a broken invariant, and the execution fails visibly.
 */
export function* noteIntakeResult(runtime: DurableSessionRuntime, witness: unknown): Generator<any, void, any> {
    yield* guarded(runtime, noteResult(runtime, witness));
}

function* noteResult(runtime: DurableSessionRuntime, witness: unknown): Generator<any, void, any> {
    const record = runtime.intakeAttempt;
    if (!record) {
        assertNoIntakeWitness(witness);
        return;
    }
    runtime.intakeAttempt = { invocationId: record.invocationId, dispatch: { ran: true, threw: false, witness } };
}

/**
 * The event a returned result notes at the start of its handling (design
 * 5.5, rows 1 to 4 and 8 to 10). An error result's row is noted where it is
 * handled: its retry, exhaustion, a credential or a non-retryable failure.
 */
export function intakeResultEvent(type: string, gated: boolean): IntakeAttemptEvent | null {
    if (type === "error") return null;
    if (type === "stopped" || type === "cancelled") return { kind: "stopped" };
    return gated ? { kind: "gate" } : { kind: "result" };
}

/**
 * How the turn of the attempt that carried the invocation went (the event
 * column of design 5.5's table), applied once per attempt: `sent` is updated
 * from its dispatch, then the first matching row decides. A retry of a sent
 * invocation becomes the pending prompt's retry marker, which every
 * continue-as-new carries with that prompt; an unsent one is ready again and
 * rides the next attempt. An attempt that carried none changes nothing, but
 * for one case: when its turn retries while a sent invocation awaits its own
 * retry, its retry's continue-as-new replaces the held pending prompt
 * (turn.ts retryContinueOverrides), so that retry never runs. The invocation
 * then ends interrupted, and this is recorded (review D-W2-1).
 */
export function* noteIntakeAttempt(runtime: DurableSessionRuntime, event: IntakeAttemptEvent | null): Generator<any, void, any> {
    if (event === null) return;
    yield* guarded(runtime, noteAttempt(runtime, event));
}

function* noteAttempt(runtime: DurableSessionRuntime, event: IntakeAttemptEvent): Generator<any, void, any> {
    const { state } = runtime;
    const record = runtime.intakeAttempt;
    if (!record) {
        const awaiting = intakeAwaitingRetry(state.intake);
        if (event.kind !== "retrying" || awaiting === null) return;
        if (state.intakeRetryInvocationId !== awaiting.invocationId) {
            throw new IntakeInvariantError(null, `invocation ${awaiting.invocationId} awaits its turn's retry, but no pending prompt carries it`);
        }
        state.intake = applyIntakeAttempt(state.intake, awaiting.invocationId, { ran: false }, { kind: "stopped" }).state;
        state.intakeRetryInvocationId = null;
        state.intakeRetryAttempt = null;
        runtime.ctx.traceInfo(`[intake] another turn's retry replaces the prompt held for invocation ${awaiting.invocationId}'s retry; it ends interrupted`);
        yield* recordIntake(runtime, { outcome: "retry_replaced", invocationId: awaiting.invocationId });
        return;
    }
    if (state.intakeRetryInvocationId !== null) {
        throw new IntakeInvariantError(null,
            `the attempt that carried invocation ${record.invocationId} ends while a pending prompt's retry names ${state.intakeRetryInvocationId}`);
    }
    runtime.intakeAttempt = null;
    const step = applyIntakeAttempt(state.intake, record.invocationId, record.dispatch ?? { ran: false }, event);
    state.intake = step.state;
    if (step.decision.next === "retry" && state.intake.invocation?.sent === true) {
        state.intakeRetryInvocationId = record.invocationId;
        // Its count and key are taken from its own continue-as-new, which follows (lifecycle.ts versionedContinueAsNew).
        state.intakeRetryAttempt = null;
    }
}

/**
 * Decide's turn for the intake alone (design 5.5, I11), when nothing else is
 * to be dispatched: the session's tombstones are latched, the next invocation
 * is formed and bound when none exists, and a turn starts for a ready
 * invocation, or for one parked for any cause but a gate that a newly
 * claimed item resumes; the attempt's stimulus is set for it. Never during a
 * graceful shutdown, nor while a thrown turn's retry is pending: that turn
 * would send the thrown attempt's key and could carry nothing (review
 * W2-WIT3). Returns whether decide starts that turn.
 */
export function* intakeOwnTurn(runtime: DurableSessionRuntime): Generator<any, boolean, any> {
    return yield* guarded(runtime, ownTurn(runtime));
}

function* ownTurn(runtime: DurableSessionRuntime): Generator<any, boolean, any> {
    const { state } = runtime;
    if (state.pendingShutdown || intakeReusesThrownTurnKey(state)) return false;
    latchIntakeTombstones(runtime);
    if (intakeCanForm(state.intake)) yield* formAndBind(runtime);
    const stimulus = intakeOwnTurnStimulus(state.intake, state.intakeArrivalPending ? 1 : 0);
    if (stimulus === null) return false;
    runtime.intakeStimulus = stimulus;
    return true;
}

/**
 * Whether decide would start the intake's own turn now (intakeOwnTurn): drain
 * then neither blocks on the queue nor waits for an armed timer, as for
 * queued work. False during a graceful shutdown and while a thrown turn's
 * retry is pending, when decide starts none.
 */
export function intakeWantsTurn(runtime: DurableSessionRuntime): boolean {
    const { state } = runtime;
    if (state.pendingShutdown || intakeReusesThrownTurnKey(state)) return false;
    return intakeCanForm(state.intake) || intakeOwnTurnStimulus(state.intake, state.intakeArrivalPending ? 1 : 0) !== null;
}

/**
 * Whether the next turn attempt sends the key of the thrown attempt it
 * retries (turn.ts, which asks the same; 1.0.81): with snapshots, a retry
 * after a throw, and no sent invocation's retry held for the pending prompt
 * (review D-W2-1); the pending prompt's dispatch asks after taking that
 * marker. Such an attempt adopts the thrown attempt's saved result when that
 * attempt had committed, and so it carries only what that attempt carried
 * (review W2-WIT3).
 */
export function intakeReusesThrownTurnKey(state: DurableSessionRuntime["state"]): boolean {
    return state.blobEnabled && state.retryCount > 0 && state.thrownTurnKey !== null && state.thrownTurnKey !== ""
        && state.intakeRetryInvocationId === null;
}

/**
 * The note drain gives a newly arrived prompt about the timer it releases
 * (queue.ts, the prompt path), here for the timer released for the intake's
 * own turn (releaseTimerForQueuedWork): a wait's or a cron's remaining time,
 * or a cron_at's preserved fire. None for any other timer.
 */
function releasedTimerNote(runtime: DurableSessionRuntime): string | undefined {
    const released = runtime.releasedForQueuedWork;
    if (!released) return undefined;
    const { state } = runtime;
    const timer = released.timer;
    if (timer.type === "wait" && released.savedInterruptedWait) {
        const remainingSec = released.savedInterruptedWait.remainingSec;
        const totalSec = Math.round(timer.originalDurationMs / 1000);
        const elapsedSec = Math.max(0, totalSec - remainingSec);
        return `The above is a message that interrupted your ${totalSec}s timer (reason: "${timer.reason}"). ` +
            `${elapsedSec}s elapsed, ${remainingSec}s remain. ` +
            `Reply to the message. The timer will be automatically resumed after your reply.`;
    }
    if (timer.type === "cron" && released.savedInterruptedCron) {
        const activeCron = state.cronSchedule;
        return `This is an internal recurring schedule, not a new user prompt. ` +
            `There is an active recurring schedule every ${activeCron?.intervalSeconds ?? "?"} seconds for "${activeCron?.reason ?? timer.reason}". ` +
            `The next cron wake-up will keep the original schedule and resume after the remaining ${Math.round(released.savedInterruptedCron.remainingMs / 1000)} seconds unless you explicitly reset cron. ` +
            `Do NOT call wait() just to keep the recurring loop alive. ` +
            `Call cron(action="cancel") only if you need to stop it.`;
    }
    if (timer.type === "cron_at") {
        const activeCronAt = state.cronAtSchedule;
        const scheduledAt = activeCronAt?.nextFireAtMs ? new Date(activeCronAt.nextFireAtMs).toISOString() : "unknown";
        return `This is an internal wall-clock recurring schedule, not a new user prompt. ` +
            `There is an active wall-clock schedule for "${activeCronAt?.reason ?? timer.reason}". ` +
            `The pending scheduled fire (${scheduledAt}) is preserved and will run after this turn completes; ` +
            `if the scheduled time passes while you respond, it will fire immediately afterward unless you explicitly cancel or reset the schedule. ` +
            `Do NOT call wait() just to keep the recurring loop alive. ` +
            `Call cron_at(action="cancel") only if you need to stop it.`;
    }
    return undefined;
}

/**
 * The prompt of decide's turn for the intake alone (design 3, 6.2): the
 * session's internal system-turn prompt, with what drain gives a newly
 * arrived prompt in the turn's system context, never in an item: the note of
 * the timer released for this turn and the buffered child digest, which the
 * turn takes. The items' canonical texts never change.
 */
export function intakeOwnTurnPrompt(runtime: DurableSessionRuntime): string {
    const prompt = appendSystemContext(INTERNAL_SYSTEM_TURN_PROMPT, releasedTimerNote(runtime)) ?? INTERNAL_SYSTEM_TURN_PROMPT;
    return flushPendingChildDigestIntoPrompt(runtime, prompt) ?? prompt;
}
