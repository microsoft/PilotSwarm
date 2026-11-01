/**
 * Orchestration 1.0.83 (INACTIVE): the durable intake's store side, wired
 * into drain and the pre-dispatch sweep (design
 * docs/proposals/workflow-durable-intake.md 3, 5.3, 5.4, 6.1, 6.2 and
 * section 8, amendment 2). The transitions are intake-machine.ts's; this
 * module makes their store writes and applies the answers.
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
 *
 * Not wired yet (a later, separately reviewed checkpoint): forming and
 * binding in decide, a turn's carry, attempts and end decision, parking and
 * the turn activities with their dispatch witness. Until then nothing forms
 * an invocation, so the invocation's writes below run only on a state that
 * restored one.
 */
import { routeWorkflowRequestActivity } from "../activity-routing.js";
import { IntakeShapeError, WORKFLOW_INTAKE_ACTIVITIES, WORKFLOW_INTAKE_NON_RETRYABLE, intakeObject } from "../workflow/v2/intake.js";
import {
    IntakeInvariantError,
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
    intakeArrivalClaimCall,
    intakeArrivalEnvelope,
    intakeBindCall,
    intakeDueWork,
    intakeEndCall,
    intakeInvocationCancelCall,
    intakeRefuseClaimCall,
    intakeUnclaimedRetryCall,
    latchIntakeCancels,
    type IntakeCancelCheck,
    type IntakeClaimCall,
    type IntakeClaimResult,
    type IntakeHolderSettle,
} from "./intake-machine.js";
import { publishStatus } from "./lifecycle.js";
import { touchRecentClientMessageIds, type DurableSessionRuntime } from "./state.js";

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
