/**
 * Orchestration 1.0.83 (the latest version; durable intake is off unless the
 * deployment capability is on): the durable intake's transitions (design
 * docs/proposals/workflow-durable-intake.md 5.2 to 5.5, 5.7 and 9, amendment
 * 2), as pure functions of the carried intake state (intake-state.ts).
 *
 * Each function takes the state and what one step observed (a claim's or a
 * bind's result, a store write that failed, an attempt's dispatch witness,
 * the orchestration clock, the session's tombstones) and returns the next
 * state and what the orchestration does next. None yields, reads a clock,
 * does I/O or changes its arguments, so replay rebuilds the same states from
 * the same history. intake-wiring.ts calls it from drain, the pre-dispatch
 * sweep and the wake, one store write at a time, and from decide and the
 * turn: forming and binding, the turn's carry and its `intake` field, and
 * the attempt's outcome.
 *
 * - Arrival and claim (5.3, 5.4): an accepted claim becomes a held entry,
 *   unless the exchange is already placed (nothing more), its canonical id
 *   is cancelled, or it has no room: then its holder's final state
 *   (cancelled, refused_full, refused_size) is decided and latched as a
 *   settling entry before it is written. A claim that fails keeps the copy as
 *   an unclaimed entry, retried in place under its own claim id; with every
 *   unclaimed entry taken the copy is claimed again in mode refuse, and only
 *   a failure then stops the execution.
 * - Cancels (5.5, review INTAKE-MACHINE-01 to 03): latchIntakeCancels turns a
 *   tombstone into carried state the first time it names a copy (an
 *   unclaimed entry, a held entry, an invocation item); from then on the
 *   decision stands whatever later tombstones say (evicted or consumed). A
 *   latched held entry is never bound; a latched unsent item is never
 *   carried and is removed by the invocation's cancel write; a latched sent
 *   item keeps the invocation's outcome and is recorded cancel_requested
 *   before the end names it.
 * - The wake (5.4, N2): the earliest due claim, holder settle, held cancel,
 *   bind, invocation cancel write or end settlement, and the writes due now:
 *   store writes only; it never starts a turn and never unparks.
 * - The invocation (5.5): formed from held entries in arrival order and bound
 *   before any attempt carries it; `sent` is cumulative; the transition table
 *   gives each carrying attempt's next step (its turn's retry, parked with a
 *   cause, or an end with its outcome); a parked one starts no turn of its
 *   own and rides only an attempt that one of its resume stimuli starts, or,
 *   parked for a gate, any attempt (each is checked by the gates again); its
 *   end is a settlement, retried as one, made after its cancel write.
 *
 * A broken invariant (a result for another claim, item or invocation, a text
 * that is not the one claimed) throws IntakeInvariantError: the execution
 * fails with the exchange, and nothing is dispatched for it. A malformed
 * activity result throws IntakeShapeError with its path.
 *
 * Exercised by test/unit/orchestration-intake-machine-1-0-83.test.mjs.
 */
import { createHash } from "node:crypto";
import {
    INTAKE_MAX_HELD,
    IntakeShapeError,
    intakeBoundItem,
    intakeClientMessageId,
    intakeEnvelopeClientMessageId,
    intakeExchangeId,
    intakeId,
    intakeItemBytes,
    intakeItemFitsAlone,
    intakeObject,
    intakeSha256,
    intakeTextWithinCap,
    parseIntakeEnvelope,
    type IntakeEnvelope,
} from "../workflow/intake.js";
import {
    INTAKE_MAX_HELD_ENTRY_BYTES,
    INTAKE_MAX_UNCLAIMED,
    INTAKE_MAX_UNCLAIMED_ENTRY_BYTES,
    intakeHeldEntryCapBytes,
    selectIntakeBatch,
    type IntakeHeldEntry,
    type IntakeHolderOutcome,
    type IntakeInvocation,
    type IntakeInvocationItem,
    type IntakeOutcome,
    type IntakeParkCause,
    type IntakeQueueEntry,
    type IntakeRetry,
    type IntakeSettlingEntry,
    type IntakeState,
    type IntakeUnclaimedEntry,
} from "./intake-state.js";

/** A failed store write is due this long after its first failure, then twice as long each time, up to INTAKE_RETRY_MAX_MS (design 5.4). */
export const INTAKE_RETRY_FIRST_MS = 30_000;
export const INTAKE_RETRY_MAX_MS = 15 * 60_000;

/** A broken intake invariant (design 5.2, 5.5): the execution fails with the exchange, when one is known, and nothing is dispatched for it. */
export class IntakeInvariantError extends Error {
    readonly code = "WORKFLOW_INTAKE_BROKEN";
    constructor(readonly exchangeId: string | null, message: string) {
        super(exchangeId === null ? message : `Intake of exchange ${exchangeId}: ${message}`);
        this.name = "IntakeInvariantError";
    }
}

/** Whether a tombstone names a canonical client id (the session's cancel set). Asking consumes nothing. */
export type IntakeCancelCheck = (clientMessageId: string) => boolean;

/** A next state and what the orchestration does next. */
export interface IntakeStep<D> {
    state: IntakeState;
    decision: D;
}

function sha256Of(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

function jsonBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function clockMs(nowMs: number): number {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new IntakeInvariantError(null, `the orchestration clock read ${String(nowMs)}, not a time in ms`);
    return nowMs;
}

/** The retry after one more failure of a store write (design 5.4): `attempts` counts the failures; due 30 s after the first, doubling to 15 min. */
export function intakeRetryAfterFailure(previous: IntakeRetry | null, nowMs: number): IntakeRetry {
    const attempts = (previous?.attempts ?? 0) + 1;
    const delayMs = Math.min(INTAKE_RETRY_MAX_MS, INTAKE_RETRY_FIRST_MS * 2 ** Math.min(attempts - 1, 16));
    return { attempts, nextAttemptAtMs: clockMs(nowMs) + delayMs };
}

// ─── The queue ───────────────────────────────────────────────

function heldCount(state: IntakeState): number {
    return state.queue.filter(entry => entry.kind === "held").length;
}

/** Copies waiting for a store write before any placement: unclaimed and settling entries share one pool. */
function waitingCount(state: IntakeState): number {
    return state.queue.filter(entry => entry.kind !== "held").length;
}

function unclaimedEntry(state: IntakeState, claimId: string): IntakeUnclaimedEntry {
    const entry = state.queue.find((candidate): candidate is IntakeUnclaimedEntry => candidate.kind === "unclaimed" && candidate.claimId === claimId);
    if (entry === undefined) throw new IntakeInvariantError(null, `no unclaimed entry waits under claim ${claimId}`);
    return entry;
}

/** The state with another queue; everything else carried as it is. */
function withQueue(state: IntakeState, queue: IntakeQueueEntry[]): IntakeState {
    return { ...state, queue };
}

/** The state with another invocation; everything else carried as it is. */
function withInvocation(state: IntakeState, invocation: IntakeInvocation | null): IntakeState {
    return { ...state, invocation };
}

/** The state with the unclaimed entry of `claimId` replaced in its arrival position, or removed (null). */
function withUnclaimed(state: IntakeState, claimId: string, replacement: IntakeQueueEntry | null): IntakeState {
    const queue: IntakeQueueEntry[] = [];
    for (const entry of state.queue) {
        if (entry.kind !== "unclaimed" || entry.claimId !== claimId) queue.push(entry);
        else if (replacement !== null) queue.push(replacement);
    }
    return withQueue(state, queue);
}

function claimInUse(state: IntakeState, claimId: string): boolean {
    return state.queue.some(entry => entry.claimId === claimId) || (state.invocation?.items.some(item => item.claimId === claimId) ?? false);
}

/** The claim under which an exchange is placed (a held entry or an item of the invocation), or null when it has no placement (I7). */
export function intakePlacementClaim(state: IntakeState, exchangeId: string): string | null {
    for (const entry of state.queue) {
        if (entry.kind === "held" && entry.exchangeId === exchangeId) return entry.claimId;
    }
    return state.invocation?.items.find(item => item.exchangeId === exchangeId)?.claimId ?? null;
}

/** The settling entry decided for an exchange, or undefined. */
function settlingFor(state: IntakeState, exchangeId: string): IntakeSettlingEntry | undefined {
    return state.queue.find((entry): entry is IntakeSettlingEntry => entry.kind === "settling" && entry.exchangeId === exchangeId);
}

// ─── Arrival and claim (design 5.2, 5.3, 5.4) ────────────────

/** Arrival step 1 (design 5.3, 5.7): a message's `workflowIntake` value as an envelope, or why it is malformed (refused and recorded; nothing placed). */
export function intakeArrivalEnvelope(raw: unknown): { envelope: IntakeEnvelope } | { malformed: IntakeShapeError } {
    try {
        return { envelope: parseIntakeEnvelope(raw, "workflowIntake") };
    } catch (error) {
        if (error instanceof IntakeShapeError) return { malformed: error };
        throw error;
    }
}

export type IntakeClaimMode = "accept" | "refuse";

/** One claim (design 5.2): a copy's claim id and envelope, its mode, and whether it is a dequeued copy's or a waiting unclaimed entry's retry. */
export interface IntakeClaimCall {
    claimId: string;
    envelope: IntakeEnvelope;
    mode: IntakeClaimMode;
    source: "arrival" | "unclaimed";
}

/** A dequeued copy's claim (arrival step 3), in mode accept, under the claim id the orchestration just drew (ctx.newGuid). */
export function intakeArrivalClaimCall(state: IntakeState, claimId: string, envelope: IntakeEnvelope): IntakeClaimCall {
    const id = intakeId(claimId, "claimId");
    const checked = parseIntakeEnvelope(envelope, "envelope");
    if (claimInUse(state, id)) throw new IntakeInvariantError(checked.exchangeId, `claim ${id} is already in use`);
    return { claimId: id, envelope: checked, mode: "accept", source: "arrival" };
}

/** A dequeued copy whose claim failed with every unclaimed entry taken is claimed again, same claim id, in mode refuse (design 5.4). */
export function intakeRefuseClaimCall(call: IntakeClaimCall): IntakeClaimCall {
    if (call.source !== "arrival" || call.mode !== "accept") {
        throw new IntakeInvariantError(call.envelope.exchangeId, "only a dequeued copy's failed claim in mode accept is claimed again in mode refuse");
    }
    return { claimId: call.claimId, envelope: call.envelope, mode: "refuse", source: "arrival" };
}

/**
 * The retry of a waiting unclaimed entry under its own claim id (design 5.4):
 * mode accept while a held entry is free, refuse otherwise; always accept for
 * a copy whose cancel is latched, so a new row is held only to be settled
 * cancelled, never refused instead.
 */
export function intakeUnclaimedRetryCall(state: IntakeState, claimId: string): IntakeClaimCall {
    const entry = unclaimedEntry(state, claimId);
    const mode: IntakeClaimMode = entry.cancel || heldCount(state) < INTAKE_MAX_HELD ? "accept" : "refuse";
    return { claimId: entry.claimId, envelope: entry.envelope, mode, source: "unclaimed" };
}

function checkCall(state: IntakeState, call: IntakeClaimCall): void {
    if (call.source === "unclaimed") {
        const entry = unclaimedEntry(state, call.claimId);
        if (entry.envelope.exchangeId !== call.envelope.exchangeId || entry.envelope.envelopeSha256 !== call.envelope.envelopeSha256) {
            throw new IntakeInvariantError(call.envelope.exchangeId, `claim ${call.claimId} is retried with another envelope than its entry's`);
        }
    } else if (claimInUse(state, call.claimId)) {
        throw new IntakeInvariantError(call.envelope.exchangeId, `claim ${call.claimId} is already in use`);
    }
}

/** An accepted claim's item (the store's WorkflowIntakeItem): the canonical text, its hash and its exact bound size. */
export interface IntakeClaimedItem {
    exchangeId: string;
    claimId: string;
    text: string;
    textSha256: string;
    clientMessageId: string;
    itemBytes: number;
}

export type IntakeRowState = "holding" | "admitted" | "cancelled" | "refused_full" | "refused_size";

const ROW_STATES: readonly IntakeRowState[] = ["holding", "admitted", "cancelled", "refused_full", "refused_size"];

/** A claim's result as its activity returns it (the store's WorkflowIntakeClaimResult, design 5.2). */
export type IntakeClaimResult =
    | { result: "accepted"; inserted: boolean; item: IntakeClaimedItem }
    | { result: "admitted" | "cancelled"; inserted: false }
    | { result: "refused_full" | "refused_size"; inserted: boolean }
    | { result: "duplicate" | "conflict"; state: IntakeRowState }
    | { result: "unverified"; reason: string };

function claimedItemOf(raw: unknown, path: string): IntakeClaimedItem {
    const value = intakeObject(raw, path, ["exchangeId", "claimId", "text", "textSha256", "clientMessageId", "itemBytes"]);
    const text = value.text;
    if (typeof text !== "string") throw new IntakeShapeError(`${path}.text`, "is not a text");
    const itemBytes = value.itemBytes;
    if (typeof itemBytes !== "number" || !Number.isSafeInteger(itemBytes)) throw new IntakeShapeError(`${path}.itemBytes`, "is not an integer");
    const item: IntakeClaimedItem = {
        exchangeId: intakeExchangeId(value.exchangeId, `${path}.exchangeId`), claimId: intakeId(value.claimId, `${path}.claimId`),
        text, textSha256: intakeSha256(value.textSha256, `${path}.textSha256`),
        clientMessageId: intakeClientMessageId(value.clientMessageId, `${path}.clientMessageId`), itemBytes,
    };
    if (!intakeTextWithinCap(item.text)) throw new IntakeInvariantError(item.exchangeId, "the claim accepted a text over its cap");
    if (sha256Of(item.text) !== item.textSha256) throw new IntakeInvariantError(item.exchangeId, "the claimed text does not match its hash");
    const measured = intakeItemBytes(intakeBoundItem(item, item.text));
    if (item.itemBytes !== measured) throw new IntakeInvariantError(item.exchangeId, `the claim measured ${item.itemBytes} bytes for an item of ${measured}`);
    if (!intakeItemFitsAlone(measured)) throw new IntakeInvariantError(item.exchangeId, "the claim accepted an item that does not fit one invocation alone");
    return item;
}

/**
 * A claim activity's result, checked against its call: an accepted item is
 * the call's exchange under the call's claim, its text has its hash and its
 * measured size; a call in mode refuse inserts only refused_full, one in mode
 * accept never inserts it.
 */
export function parseIntakeClaimResult(raw: unknown, call: IntakeClaimCall): IntakeClaimResult {
    const path = "claim";
    const exchangeId = call.envelope.exchangeId;
    const kind: unknown = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>).result : undefined;
    const insertedOf = (value: Record<string, unknown>): boolean => {
        const inserted = value.inserted;
        if (typeof inserted !== "boolean") throw new IntakeShapeError(`${path}.inserted`, "is not a boolean");
        return inserted;
    };
    if (kind === "accepted") {
        const value = intakeObject(raw, path, ["result", "inserted", "item"]);
        const inserted = insertedOf(value);
        const item = claimedItemOf(value.item, `${path}.item`);
        if (item.exchangeId !== exchangeId || item.claimId !== call.claimId) {
            throw new IntakeInvariantError(exchangeId, `the claim of ${call.claimId} accepted exchange ${item.exchangeId} under claim ${item.claimId}`);
        }
        // The canonical id every copy carries, which tombstones name and which an unclaimed copy's latch was checked against.
        if (item.clientMessageId !== intakeEnvelopeClientMessageId(call.envelope)) {
            throw new IntakeInvariantError(exchangeId, "the claimed item's client message id is not its exchange's canonical one");
        }
        if (inserted && call.mode === "refuse") throw new IntakeInvariantError(exchangeId, "a claim in mode refuse inserted a holding row");
        return { result: "accepted", inserted, item };
    }
    if (kind === "admitted" || kind === "cancelled") {
        const value = intakeObject(raw, path, ["result", "inserted"]);
        if (value.inserted !== false) throw new IntakeShapeError(`${path}.inserted`, "is not false");
        return { result: kind === "admitted" ? "admitted" : "cancelled", inserted: false };
    }
    if (kind === "refused_full" || kind === "refused_size") {
        const value = intakeObject(raw, path, ["result", "inserted"]);
        const inserted = insertedOf(value);
        const refusal: "refused_full" | "refused_size" = kind === "refused_full" ? "refused_full" : "refused_size";
        if (inserted && (refusal === "refused_full") !== (call.mode === "refuse")) {
            throw new IntakeInvariantError(exchangeId, `a claim in mode ${call.mode} inserted ${refusal}`);
        }
        return { result: refusal, inserted };
    }
    if (kind === "duplicate" || kind === "conflict") {
        const value = intakeObject(raw, path, ["result", "state"]);
        const state = ROW_STATES.find(candidate => candidate === value.state);
        if (state === undefined) throw new IntakeShapeError(`${path}.state`, "is not an intake state");
        return { result: kind === "duplicate" ? "duplicate" : "conflict", state };
    }
    if (kind === "unverified") {
        const value = intakeObject(raw, path, ["result", "reason"]);
        const reason = value.reason;
        if (typeof reason !== "string") throw new IntakeShapeError(`${path}.reason`, "is not a text");
        return { result: "unverified", reason };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new IntakeShapeError(path, "is not a plain object");
    throw new IntakeShapeError(`${path}.result`, "is not a claim result");
}

/** The claim failed: the copy waits as an unclaimed entry under its claim (design 5.4). */
export interface IntakeUnclaimedDecision {
    kind: "unclaimed";
    claimId: string;
    retry: IntakeRetry;
}

/** The one fail-stop case (design 5.4, 9 row 11): a store outage with every waiting entry taken; the execution fails. */
export interface IntakeFailStop {
    kind: "fail_stop";
    exchangeId: string;
    message: string;
}

/**
 * The holder's final state of a claimed copy it does not place, decided once
 * (design 5.2, 5.4, 5.6): a tombstone named the copy (cancelled), every held
 * entry is taken (refused_full), or its held reference would be over its
 * 512-byte cap (refused_size). `latched` when a settling entry carries the
 * decision, which is always so but for a dequeued copy that found every
 * waiting entry taken: then a failed write is retried on the wake, never
 * decided again; not latched, a failed write stops the execution.
 */
export interface IntakeHolderSettle {
    kind: "settle_holder";
    exchangeId: string;
    claimId: string;
    outcome: IntakeHolderOutcome;
    latched: boolean;
}

/** What the orchestration does after a claim (design 5.3, 5.4). */
export type IntakeClaimDecision =
    /** The item became a held entry: one newly claimed item, a resume stimulus of a parked invocation (5.5). */
    | { kind: "held"; entry: IntakeHeldEntry }
    /** The exchange already has this claim's placement: nothing more happens (I7). */
    | { kind: "already_placed" }
    /** Recorded: nothing is placed, no timer released, no digest taken, no tombstone consumed, no id pending. */
    | { kind: "recorded"; result: Exclude<IntakeClaimResult, { result: "accepted" }> }
    /** Write the holder's settle (cancelled: settle cancel_held; refused: settle refuse), then report it to applyIntakeHolderSettle. */
    | IntakeHolderSettle
    | IntakeUnclaimedDecision
    /** The claim failed with every waiting entry taken: claim again in mode refuse (intakeRefuseClaimCall). */
    | { kind: "claim_refuse" }
    | IntakeFailStop;

/**
 * What a claim's handling reads besides its result: the orchestration clock,
 * read only when the claim failed (null for a result: arrival and the sweep
 * yield no clock read for it, design 6.2 and section 8), and the session's
 * tombstones.
 */
export interface IntakeClaimContext {
    nowMs: number | null;
    isCancelled: IntakeCancelCheck;
}

/** The time a failed claim was observed; a failure reported without one is a broken invariant. */
function failedAtMs(context: IntakeClaimContext, exchangeId: string): number {
    if (context.nowMs === null) throw new IntakeInvariantError(exchangeId, "a failed claim was reported without the time it failed");
    return context.nowMs;
}

/**
 * A waiting entry for a copy whose claim failed, its cancel latched when a
 * tombstone names its canonical id now (or did before); null when a dequeued
 * copy finds every waiting entry taken.
 */
function keepUnclaimed(state: IntakeState, call: IntakeClaimCall, context: IntakeClaimContext): IntakeStep<IntakeUnclaimedDecision> | null {
    const cancelled = context.isCancelled(intakeEnvelopeClientMessageId(call.envelope));
    if (call.source === "unclaimed") {
        const entry = unclaimedEntry(state, call.claimId);
        const retry = intakeRetryAfterFailure(entry.retry, failedAtMs(context, call.envelope.exchangeId));
        const kept: IntakeUnclaimedEntry = { ...entry, retry, cancel: entry.cancel || cancelled };
        return { state: withUnclaimed(state, call.claimId, kept), decision: { kind: "unclaimed", claimId: call.claimId, retry } };
    }
    if (waitingCount(state) >= INTAKE_MAX_UNCLAIMED) return null;
    const retry = intakeRetryAfterFailure(null, failedAtMs(context, call.envelope.exchangeId));
    const entry: IntakeUnclaimedEntry = { kind: "unclaimed", claimId: call.claimId, envelope: call.envelope, retry, cancel: cancelled };
    // Not reachable: an envelope within its 1 KiB cap and an id within its length always fit the entry's 2 KiB.
    if (jsonBytes(entry) > INTAKE_MAX_UNCLAIMED_ENTRY_BYTES) throw new IntakeInvariantError(call.envelope.exchangeId, "its unclaimed entry is over its cap");
    return { state: withQueue(state, [...state.queue, entry]), decision: { kind: "unclaimed", claimId: call.claimId, retry } };
}

function failStop(state: IntakeState, exchangeId: string): IntakeStep<IntakeFailStop> {
    return {
        state,
        decision: {
            kind: "fail_stop", exchangeId,
            message: `The workflow store could not record exchange ${exchangeId} while every waiting intake entry is taken (design 5.4).`,
        },
    };
}

/** The queue without a retried entry once its claim is answered; a dequeued copy has none. */
function dropRetried(state: IntakeState, call: IntakeClaimCall): IntakeState {
    return call.source === "unclaimed" ? withUnclaimed(state, call.claimId, null) : state;
}

/**
 * Apply a claim's outcome (design 5.2 to 5.4): `{ failed: true }` when the
 * activity threw after its retries, or its result. An accepted item is placed
 * only when the exchange has no placement (I7), whatever the call's mode: a
 * call in mode refuse answered accepted found its own earlier holding row,
 * and the holder refuses it only when it has no room. A retried entry that
 * becomes held keeps its arrival position. A copy that a tombstone names now,
 * or whose message (its exchange and canonical client id) has a cancel
 * latched on a waiting copy, is settled cancelled; that decision and a
 * refusal are latched as a settling entry before the write. A waiting copy's
 * envelope is not verified until its claim is answered, so a latch passes
 * only between copies of one message, never by exchange alone.
 */
export function applyIntakeClaim(state: IntakeState, call: IntakeClaimCall, outcome: { result: unknown } | { failed: true }, context: IntakeClaimContext)
    : IntakeStep<IntakeClaimDecision> {
    checkCall(state, call);
    if ("failed" in outcome) {
        const kept = keepUnclaimed(state, call, context);
        if (kept !== null) return kept;
        return call.mode === "accept" ? { state, decision: { kind: "claim_refuse" } } : failStop(state, call.envelope.exchangeId);
    }
    const result = parseIntakeClaimResult(outcome.result, call);
    // A retried copy whose cancel was latched passes it on to the other copies of its own message when it leaves.
    const exchangeId = call.envelope.exchangeId;
    const canonical = intakeEnvelopeClientMessageId(call.envelope);
    const ownLatch = call.source === "unclaimed" && unclaimedEntry(state, call.claimId).cancel;
    const passOn = (next: IntakeState): IntakeState => (ownLatch
        ? latchCopies(next, (clientMessageId, copyExchangeId) => copyExchangeId === exchangeId && clientMessageId === canonical) : next);
    if (result.result !== "accepted") return { state: passOn(dropRetried(state, call)), decision: { kind: "recorded", result } };
    const { item } = result;
    const decidedUnder = intakePlacementClaim(state, item.exchangeId) ?? settlingFor(state, item.exchangeId)?.claimId ?? null;
    if (decidedUnder !== null) {
        if (decidedUnder !== item.claimId) {
            throw new IntakeInvariantError(item.exchangeId, `it is placed or settling under claim ${decidedUnder}, but its row holds claim ${item.claimId}`);
        }
        return { state: passOn(dropRetried(state, call)), decision: { kind: "already_placed" } };
    }
    // The item's client id is its exchange's canonical one (parseIntakeClaimResult): only a waiting copy of the same message counts.
    const inherited = state.queue.some(entry => entry.kind === "unclaimed" && entry.cancel && entry.envelope.exchangeId === item.exchangeId
        && intakeEnvelopeClientMessageId(entry.envelope) === item.clientMessageId);
    const entry: IntakeHeldEntry = {
        kind: "held", exchangeId: item.exchangeId, claimId: item.claimId, textSha256: item.textSha256, clientMessageId: item.clientMessageId,
        itemBytes: item.itemBytes, cancel: false,
    };
    const decided: IntakeHolderOutcome | null = inherited || context.isCancelled(item.clientMessageId) ? "cancelled"
        : intakeHeldEntryCapBytes(entry) > INTAKE_MAX_HELD_ENTRY_BYTES ? "refused_size"
            : heldCount(state) >= INTAKE_MAX_HELD ? "refused_full" : null;
    if (decided === null) {
        const placed = call.source === "unclaimed" ? withUnclaimed(state, call.claimId, entry) : withQueue(state, [...state.queue, entry]);
        return { state: placed, decision: { kind: "held", entry } };
    }
    const settling: IntakeSettlingEntry = { kind: "settling", exchangeId: item.exchangeId, claimId: item.claimId, outcome: decided, retry: null };
    const settle = (latched: boolean): IntakeHolderSettle => ({
        kind: "settle_holder", exchangeId: settling.exchangeId, claimId: settling.claimId, outcome: settling.outcome, latched,
    });
    // Latched before the write: in the copy's own waiting entry, else in a free one.
    if (call.source === "unclaimed") return { state: withUnclaimed(state, call.claimId, settling), decision: settle(true) };
    if (waitingCount(state) < INTAKE_MAX_UNCLAIMED) return { state: withQueue(state, [...state.queue, settling]), decision: settle(true) };
    return { state, decision: settle(false) };
}

/**
 * The holder's settle was written (`settled`) or failed after its retries,
 * at `nowMs` (read only for a failure; null when it was written). Latched:
 * settled, its settling entry leaves; failed, it stays with its due time on
 * the wake, the same decision under the same claim. Not latched (the copy
 * found every waiting entry taken): failed, the execution stops (the one
 * fail-stop case).
 */
export function applyIntakeHolderSettle(state: IntakeState, settle: Pick<IntakeHolderSettle, "exchangeId" | "claimId" | "latched">, settled: boolean,
    nowMs: number | null): IntakeStep<{ kind: "settled" } | { kind: "settle_retry"; retry: IntakeRetry } | IntakeFailStop> {
    const entry = settlingFor(state, settle.exchangeId);
    if (!settle.latched) {
        if (entry !== undefined) throw new IntakeInvariantError(settle.exchangeId, "its holder settle is latched");
        return settled ? { state, decision: { kind: "settled" } } : failStop(state, settle.exchangeId);
    }
    if (entry === undefined || entry.claimId !== settle.claimId) {
        throw new IntakeInvariantError(settle.exchangeId, `no holder settle is latched under claim ${settle.claimId}`);
    }
    if (settled) return { state: withQueue(state, state.queue.filter(candidate => candidate !== entry)), decision: { kind: "settled" } };
    if (nowMs === null) throw new IntakeInvariantError(settle.exchangeId, "a failed holder settle was reported without the time it failed");
    const retry = intakeRetryAfterFailure(entry.retry, nowMs);
    const queue: IntakeQueueEntry[] = state.queue.map(candidate => (candidate === entry ? { ...entry, retry } : candidate));
    return { state: withQueue(state, queue), decision: { kind: "settle_retry", retry } };
}

// ─── Cancels: a tombstone latched once (design 5.5, review INTAKE-MACHINE-01, 03) ──

/**
 * Latch the cancel of every copy in the state that `names` picks, by its
 * canonical client message id (an unclaimed copy's is its envelope's) and its
 * exchange: an unclaimed entry's cancel, a held entry's cancel (written with
 * the other latched held cancels: due now unless their write is waiting for
 * its retry), and an invocation item's cancelRequested, with the
 * invocation's cancel write due now once it is bound (before its bind the
 * cancel waits for it; its rows are not admitted yet). An unsent invocation
 * that is ending was never dispatched: nothing is latched on it. Returns
 * `state` itself when nothing is newly latched.
 */
function latchCopies(state: IntakeState, names: (clientMessageId: string, exchangeId: string) => boolean): IntakeState {
    const queue: IntakeQueueEntry[] = state.queue.map((entry): IntakeQueueEntry => {
        if (entry.kind === "unclaimed" && !entry.cancel && names(intakeEnvelopeClientMessageId(entry.envelope), entry.envelope.exchangeId)) {
            return { ...entry, cancel: true };
        }
        if (entry.kind === "held" && !entry.cancel && names(entry.clientMessageId, entry.exchangeId)) return { ...entry, cancel: true };
        return entry;
    });
    let invocation = state.invocation;
    if (invocation !== null && !(invocation.bound && !invocation.sent && invocation.settle !== null)) {
        const current = invocation;
        const named = new Set(current.items.filter(item => !item.cancelRequested && names(item.clientMessageId, item.exchangeId)).map(item => item.exchangeId));
        if (named.size > 0) {
            invocation = {
                ...current,
                items: current.items.map(item => (named.has(item.exchangeId) ? { ...item, cancelRequested: true } : item)),
                cancelWrite: current.bound ? current.cancelWrite ?? { retry: null } : null,
            };
        }
    }
    const queueChanged = queue.some((entry, index) => entry !== state.queue[index]);
    return queueChanged || invocation !== state.invocation ? { ...state, queue, invocation } : state;
}

/**
 * Latch every tombstone that names a copy in the intake state, the first time
 * it does (latchCopies). A latch is never undone: the write it decided is
 * made whatever later tombstones say, so the session may consume or evict a
 * tombstone once it is latched. Drain latches at each tombstone and decide
 * before it forms, binds or carries anything. Returns `state` itself when
 * nothing is newly latched.
 */
export function latchIntakeCancels(state: IntakeState, isCancelled: IntakeCancelCheck): IntakeState {
    return latchCopies(state, clientMessageId => isCancelled(clientMessageId));
}

// ─── The wake (design 5.4, N2) ───────────────────────────────

/** The invocation's one pending store write, in order: its bind, then its cancel write, then its end; null when none waits. */
function invocationWrite(invocation: IntakeInvocation | null): { kind: "bind" | "cancel_invocation" | "settle"; dueAtMs: number } | null {
    if (invocation === null) return null;
    if (!invocation.bound) return { kind: "bind", dueAtMs: invocation.bindRetry?.nextAttemptAtMs ?? 0 };
    if (invocation.cancelWrite !== null) return { kind: "cancel_invocation", dueAtMs: invocation.cancelWrite.retry?.nextAttemptAtMs ?? 0 };
    if (invocation.settle !== null) return { kind: "settle", dueAtMs: invocation.settle.retry?.nextAttemptAtMs ?? 0 };
    return null;
}

/**
 * The earliest due time of the intake's store writes, the third deadline of
 * drain's race: an unclaimed entry's claim, a settling entry's holder settle,
 * the latched held cancels' write, and the invocation's bind, cancel write or
 * end (the end waits for the cancel write). A write that has no due time yet
 * is due now (0). Null when no write waits: drain then runs exactly as today.
 * A cancel needs no other stimulus to be made (review INTAKE-MACHINE-02).
 */
export function intakeDueAtMs(state: IntakeState): number | null {
    const times: number[] = [];
    for (const entry of state.queue) {
        if (entry.kind === "unclaimed") times.push(entry.retry.nextAttemptAtMs);
        else if (entry.kind === "settling") times.push(entry.retry?.nextAttemptAtMs ?? 0);
    }
    if (state.queue.some(entry => entry.kind === "held" && entry.cancel)) times.push(state.heldCancelRetry?.nextAttemptAtMs ?? 0);
    const write = invocationWrite(state.invocation);
    if (write !== null) times.push(write.dueAtMs);
    return times.length === 0 ? null : Math.min(...times);
}

/**
 * A store write the wake makes when due: an unclaimed entry's claim
 * (intakeUnclaimedRetryCall), a settling entry's holder settle, the latched
 * held cancels as one write (settle cancel_held), the invocation's bind
 * (intakeBindCall), its cancel write (intakeInvocationCancelCall) or its end
 * (intakeEndCall).
 */
export type IntakeDueWork =
    | { kind: "claim"; claimId: string }
    | { kind: "holder_settle"; exchangeId: string; claimId: string; outcome: IntakeHolderOutcome }
    | { kind: "cancel_held"; items: Array<{ exchangeId: string; claimId: string }> }
    | { kind: "bind" }
    | { kind: "cancel_invocation" }
    | { kind: "settle" };

/**
 * The writes due at `nowMs`, in order: unclaimed claims and holder settles
 * oldest first, then the latched held cancels together, then the invocation's
 * write. Store writes only: no turn, no unparking. Each is reported back as
 * made or failed (its retry then doubles); a failure never drops a latch.
 */
export function intakeDueWork(state: IntakeState, nowMs: number): IntakeDueWork[] {
    const now = clockMs(nowMs);
    const work: IntakeDueWork[] = [];
    const heldCancels: Array<{ exchangeId: string; claimId: string }> = [];
    for (const entry of state.queue) {
        if (entry.kind === "unclaimed") {
            if (entry.retry.nextAttemptAtMs <= now) work.push({ kind: "claim", claimId: entry.claimId });
        } else if (entry.kind === "settling") {
            if ((entry.retry?.nextAttemptAtMs ?? 0) <= now) {
                work.push({ kind: "holder_settle", exchangeId: entry.exchangeId, claimId: entry.claimId, outcome: entry.outcome });
            }
        } else if (entry.cancel) {
            heldCancels.push({ exchangeId: entry.exchangeId, claimId: entry.claimId });
        }
    }
    if (heldCancels.length > 0 && (state.heldCancelRetry?.nextAttemptAtMs ?? 0) <= now) work.push({ kind: "cancel_held", items: heldCancels });
    const write = invocationWrite(state.invocation);
    if (write !== null && write.dueAtMs <= now) {
        if (write.kind === "bind") work.push({ kind: "bind" });
        else if (write.kind === "cancel_invocation") work.push({ kind: "cancel_invocation" });
        else work.push({ kind: "settle" });
    }
    return work;
}

// ─── Held entries and the binding (design 5.5, 6.1) ──────────

/** The held entries named (at least one), each of whose cancel must be latched. */
function latchedHeld(state: IntakeState, exchangeIds: readonly string[]): Set<string> {
    if (exchangeIds.length === 0) throw new IntakeInvariantError(null, "a held cancel write is reported that names no entry");
    const named = new Set(exchangeIds);
    for (const exchangeId of named) {
        if (!state.queue.some(entry => entry.kind === "held" && entry.exchangeId === exchangeId && entry.cancel)) {
            throw new IntakeInvariantError(exchangeId, "its cancel was written, but it is not a held entry whose cancel is latched");
        }
    }
    return named;
}

/**
 * The latched cancels of these held entries were written (settle
 * cancel_held): they leave the queue, and any other latched held cancel is
 * due now.
 */
export function applyIntakeHeldCancelled(state: IntakeState, exchangeIds: readonly string[]): IntakeState {
    const done = latchedHeld(state, exchangeIds);
    return { ...state, queue: state.queue.filter(entry => entry.kind !== "held" || !done.has(entry.exchangeId)), heldCancelRetry: null };
}

/**
 * The latched held cancels' write failed after its retries (or committed and
 * its answer was lost): each stays latched, never bound, and the write is due
 * again on the wake at its doubled retry; a repeated cancel of a cancelled
 * row is the same result.
 */
export function applyIntakeHeldCancelFailure(state: IntakeState, exchangeIds: readonly string[], nowMs: number): IntakeState {
    latchedHeld(state, exchangeIds);
    return { ...state, heldCancelRetry: intakeRetryAfterFailure(state.heldCancelRetry, nowMs) };
}

/** Whether decide forms an invocation now: none exists, and a held entry whose cancel is not latched waits. */
export function intakeCanForm(state: IntakeState): boolean {
    return state.invocation === null && state.queue.some(entry => entry.kind === "held" && !entry.cancel);
}

/**
 * Form the next invocation in one synchronous step (design 5.5, C1): the
 * longest arrival-order run of held entries that fits one invocation, those
 * whose cancel is latched passed over (decide latches the session's
 * tombstones first, latchIntakeCancels), leaves the queue and becomes its
 * batch, unbound and unsent. Its bind follows in the same pass with no other
 * yield between, so this form, which has no bind retry yet, is never carried.
 */
export function formIntakeInvocation(state: IntakeState, invocationId: string): IntakeState {
    if (state.invocation !== null) {
        throw new IntakeInvariantError(null, `invocation ${state.invocation.invocationId} exists; the next one forms only after it ends`);
    }
    const id = intakeId(invocationId, "invocationId");
    const batch = selectIntakeBatch(state.queue);
    if (batch.length === 0) throw new IntakeInvariantError(null, "no held entry waits for an invocation");
    const taken = new Set(batch.map(entry => entry.claimId));
    const invocation: IntakeInvocation = {
        invocationId: id,
        items: batch.map((entry): IntakeInvocationItem => ({
            exchangeId: entry.exchangeId, claimId: entry.claimId, textSha256: entry.textSha256, clientMessageId: entry.clientMessageId,
            text: null, cancelRequested: false,
        })),
        itemBytes: batch.map(entry => entry.itemBytes),
        bound: false, sent: false, parked: null, bindRetry: null, settle: null, cancelWrite: null,
    };
    return { ...state, queue: state.queue.filter(entry => !taken.has(entry.claimId)), invocation };
}

function unboundInvocation(state: IntakeState): IntakeInvocation {
    const invocation = state.invocation;
    if (invocation === null || invocation.bound) throw new IntakeInvariantError(null, "no invocation waits for its bind");
    return invocation;
}

/** The bind's input (design 5.2): the invocation and its claims in batch order. */
export function intakeBindCall(state: IntakeState): { invocationId: string; items: Array<{ exchangeId: string; claimId: string }> } {
    const invocation = unboundInvocation(state);
    return { invocationId: invocation.invocationId, items: invocation.items.map(item => ({ exchangeId: item.exchangeId, claimId: item.claimId })) };
}

/**
 * The bind returned: the claims are admitted to the invocation (bound now, or
 * found bound with the same membership: a replay). Each item takes the text
 * its row stored, which must be the one its claim hashed and measured; any
 * other answer is a broken invariant, and nothing is dispatched. A cancel
 * latched before the bind now has its cancel write due.
 */
export function applyIntakeBound(state: IntakeState, raw: unknown): IntakeState {
    const invocation = unboundInvocation(state);
    const value = intakeObject(raw, "bind", ["bound", "items"]);
    if (typeof value.bound !== "boolean") throw new IntakeShapeError("bind.bound", "is not a boolean");
    const rawItems = value.items;
    if (!Array.isArray(rawItems)) throw new IntakeShapeError("bind.items", "is not a list");
    if (rawItems.length !== invocation.items.length) {
        throw new IntakeInvariantError(invocation.items[0]?.exchangeId ?? null,
            `the bind of invocation ${invocation.invocationId} returned ${rawItems.length} items for its ${invocation.items.length}`);
    }
    const items = invocation.items.map((item, index): IntakeInvocationItem => {
        const path = `bind.items[${index}]`;
        const bound = intakeObject(rawItems[index], path, ["exchangeId", "claimId", "text", "textSha256"]);
        if (bound.exchangeId !== item.exchangeId || bound.claimId !== item.claimId) {
            throw new IntakeInvariantError(item.exchangeId, `the bind returned ${String(bound.exchangeId)} under claim ${String(bound.claimId)} in its place`);
        }
        const text = bound.text;
        if (typeof text !== "string") throw new IntakeShapeError(`${path}.text`, "is not a text");
        if (bound.textSha256 !== item.textSha256) throw new IntakeInvariantError(item.exchangeId, "its stored text hash is not its claim's");
        if (sha256Of(text) !== item.textSha256) throw new IntakeInvariantError(item.exchangeId, "its stored text does not match its hash");
        if (intakeItemBytes(intakeBoundItem(item, text)) !== invocation.itemBytes[index]) {
            throw new IntakeInvariantError(item.exchangeId, "its bound size is not the size measured at its claim");
        }
        return { ...item, text };
    });
    const cancelWrite = items.some(item => item.cancelRequested) ? { retry: null } : null;
    return withInvocation(state, { ...invocation, items, bound: true, bindRetry: null, cancelWrite });
}

/** The bind failed after its retries: the invocation stays unsent and unbound, its bind due on the wake (design 5.5); nothing carries it. */
export function applyIntakeBindFailure(state: IntakeState, nowMs: number): IntakeStep<{ kind: "bind_retry"; retry: IntakeRetry }> {
    const invocation = unboundInvocation(state);
    const retry = intakeRetryAfterFailure(invocation.bindRetry, nowMs);
    return { state: withInvocation(state, { ...invocation, bindRetry: retry }), decision: { kind: "bind_retry", retry } };
}

// ─── Who carries it (design 5.5) ─────────────────────────────

/**
 * What starts a new turn (design 5.5): a message admitted from a person or a
 * session (a prompt, an answer, a child update), a timer that runs a turn
 * (cron, cron_at, wait), a newly claimed intake item (one attempt per
 * arrival), a gate's own retry (budget or workspace), the turn decide starts
 * for a ready invocation alone, or anything else.
 */
export type IntakeStimulus = "message" | "timer" | "intake_arrival" | "gate_retry" | "intake_turn" | "other";

/** The stimuli that resume an invocation parked for any cause but a gate (one parked for a gate rides every attempt). */
const RESUME_STIMULI: readonly IntakeStimulus[] = ["message", "timer", "intake_arrival"];

/** A turn attempt about to run: a turn's retry (naming the invocation its earlier attempt carried, or none), or a new turn and its stimulus. */
export type IntakeAttemptStart =
    | { kind: "retry"; invocationId: string | null }
    | { kind: "new"; stimulus: IntakeStimulus };

/**
 * What a carrying attempt sends in its own `intake` field, never inside the
 * prompt (design 5.5): the invocation and its items, each with its claim, in
 * batch order. The attempt's id and its retry flag are added by the attempt
 * that carries it (exposure protocol revision 2, section 2; intake-wiring.ts).
 */
export interface IntakeTurnPayload {
    invocationId: string;
    items: Array<{ exchangeId: string; claimId: string; clientMessageId: string; text: string }>;
}

/** The payload of a bound invocation, its items in batch order. */
export function intakeTurnPayload(invocation: IntakeInvocation): IntakeTurnPayload {
    if (!invocation.bound || invocation.items.length === 0) {
        throw new IntakeInvariantError(null, `invocation ${invocation.invocationId} is not a bound batch an attempt can carry`);
    }
    return {
        invocationId: invocation.invocationId,
        items: invocation.items.map(item => {
            if (item.text === null) throw new IntakeInvariantError(item.exchangeId, "it has no bound text");
            return { exchangeId: item.exchangeId, claimId: item.claimId, clientMessageId: item.clientMessageId, text: item.text };
        }),
    };
}

/**
 * Whether an attempt carries the invocation, and its payload (design 5.5).
 * A sent invocation rides only its own turn's retries (the retry names it).
 * An unsent one rides any attempt when ready; parked for a gate, any attempt
 * as well, since every attempt is checked by the gates again (as the gates'
 * held prompts ride every attempt), though it starts no turn of its own
 * (intakeOwnTurnStimulus; the gate row of the design's 5.5 resume table,
 * decision A1); parked for any other cause, only a new turn that a
 * message, a timer or a newly claimed item starts. Carrying unparks it: the
 * attempt applies the transition table again. An unbound invocation, one
 * whose end is being settled, and an unsent one with a latched cancel (its
 * cancel write removes the item first) ride nothing, whatever the session's
 * tombstones say now.
 */
export function carryIntakeInvocation(state: IntakeState, start: IntakeAttemptStart): { state: IntakeState; carry: IntakeTurnPayload | null } {
    const invocation = state.invocation;
    const named = start.kind === "retry" ? start.invocationId : null;
    if (invocation === null || !invocation.bound || invocation.settle !== null) {
        if (named !== null) throw new IntakeInvariantError(null, `a turn's retry names invocation ${named}, which no attempt may carry now`);
        return { state, carry: null };
    }
    if (named !== null && named !== invocation.invocationId) {
        throw new IntakeInvariantError(null, `a turn's retry names invocation ${named}, not ${invocation.invocationId}`);
    }
    let carries: boolean;
    if (named !== null) carries = true;
    else if (invocation.sent) carries = false;
    else if (invocation.parked === null || invocation.parked === "gate") carries = true;
    else carries = start.kind === "new" && RESUME_STIMULI.includes(start.stimulus);
    if (carries && !invocation.sent && invocation.items.some(item => item.cancelRequested)) carries = false;
    if (!carries) return { state, carry: null };
    const next: IntakeInvocation = { ...invocation, parked: null };
    return { state: withInvocation(state, next), carry: intakeTurnPayload(next) };
}

/**
 * Whether decide starts a turn for the invocation alone when nothing else is
 * queued (design 5.5, I11): a ready one starts one (`intake_turn`); one parked
 * for any cause but a gate starts one only for a newly claimed item not yet
 * answered by an attempt (`intake_arrival`); anything else starts none, nor
 * does an unsent one with a latched cancel until its cancel write removes the
 * item (no attempt would carry it).
 */
export function intakeOwnTurnStimulus(state: IntakeState, pendingArrivals: number): "intake_turn" | "intake_arrival" | null {
    const invocation = state.invocation;
    if (invocation === null || !invocation.bound || invocation.sent || invocation.settle !== null) return null;
    if (invocation.items.some(item => item.cancelRequested)) return null;
    if (invocation.parked === null) return "intake_turn";
    return invocation.parked !== "gate" && pendingArrivals > 0 ? "intake_arrival" : null;
}

// ─── Attempt results: the transition table (design 5.5) ──────

/**
 * An attempt's `intakeDispatch` witness, or null when it returned none.
 * `exposed`, present only as `true` beside `sent: false`, says the items were
 * possibly seen by another request of the same attempt, though not by the
 * run whose result this is: one that lost a racing commit (review W2-WIT4),
 * or an earlier run before a recovery (review of c1bda7a2, W1). `refused`,
 * present only beside `sent: false` and never with `exposed`, says the store
 * refused the items to the run, which ran without them (exposure protocol
 * revision 2, section 4): `exposed`, they were possibly seen under another
 * attempt; `settled`, the attempt's payload was stale.
 */
export function intakeDispatchWitness(raw: unknown)
    : { invocationId: string; sent: boolean; exposed: boolean; refused: "exposed" | "settled" | null } | null {
    if (raw === undefined || raw === null) return null;
    const exposed = typeof raw === "object" && raw !== null && Object.hasOwn(raw, "exposed");
    const refused = typeof raw === "object" && raw !== null && Object.hasOwn(raw, "refused");
    if (exposed && refused) throw new IntakeShapeError("intakeDispatch", "says both exposed and refused");
    const value = intakeObject(raw, "intakeDispatch",
        exposed ? ["invocationId", "sent", "exposed"] : refused ? ["invocationId", "sent", "refused"] : ["invocationId", "sent"]);
    const sent = value.sent;
    if (typeof sent !== "boolean") throw new IntakeShapeError("intakeDispatch.sent", "is not a boolean");
    if (exposed && (value.exposed !== true || sent)) throw new IntakeShapeError("intakeDispatch.exposed", "is not true beside sent false");
    const reason = value.refused;
    if (refused && ((reason !== "exposed" && reason !== "settled") || sent)) {
        throw new IntakeShapeError("intakeDispatch.refused", "is not exposed or settled beside sent false");
    }
    return {
        invocationId: intakeId(value.invocationId, "intakeDispatch.invocationId"), sent, exposed,
        refused: refused ? reason as "exposed" | "settled" : null,
    };
}

/** An attempt that carried no invocation returns no witness: one would name another invocation, a broken invariant (design 5.5). */
export function assertNoIntakeWitness(raw: unknown): void {
    const witness = intakeDispatchWitness(raw);
    if (witness !== null) throw new IntakeInvariantError(null, `an attempt that carried no invocation returned a witness for ${witness.invocationId}`);
}

/**
 * What the attempt that would carry the invocation reported: it did not run
 * (its turn ended first: a hydration give-up, a stopped or failed turn; `sent`
 * is not updated), it threw (possibly sent), or it returned a result whose raw
 * `intakeDispatch` is `witness` (none counts as possibly sent).
 */
export type IntakeAttemptDispatch =
    | { ran: false }
    | { ran: true; threw: true }
    | { ran: true; threw: false; witness: unknown };

/** How the turn went on, the event column of design 5.5's table. */
export type IntakeAttemptEvent =
    /** Rows 1, 2: a stopped or cancelled result (or the turn stopped before the attempt). */
    | { kind: "stopped" }
    /** Rows 3, 4: a gate refusal, budget or workspace. */
    | { kind: "gate" }
    /** Row 5: a throw or an error result, and the turn retries. */
    | { kind: "retrying" }
    /** Rows 6, 7: retries exhausted, a credential failure or a non-retryable error. */
    | { kind: "failed"; cause: "exhausted" | "credential" | "non_retryable" }
    /** Rows 8 to 10: any other result. */
    | { kind: "result" }
    /** Rows 11, 12: a hydration give-up before the attempt. */
    | { kind: "hydration" };

/** The invocation's next step: its turn's retry carries it (the retry names it), it is parked with a cause, or it ends with an outcome. */
export type IntakeAttemptNext =
    | { next: "retry" }
    | { next: "parked"; cause: IntakeParkCause }
    | { next: "end"; outcome: IntakeOutcome };

function checkAttempt(dispatch: IntakeAttemptDispatch, event: IntakeAttemptEvent): void {
    const allowed: readonly string[] = !dispatch.ran ? ["stopped", "failed", "hydration"]
        : dispatch.threw ? ["retrying", "failed"]
            : ["stopped", "gate", "retrying", "failed", "result"];
    if (!allowed.includes(event.kind)) {
        const what = !dispatch.ran ? "did not run" : dispatch.threw ? "threw" : "returned a result";
        throw new IntakeInvariantError(null, `an attempt that ${what} does not end its turn with ${event.kind}`);
    }
}

/** The first matching row of the table, with `sent` already updated from the attempt. */
function attemptStep(event: IntakeAttemptEvent, sent: boolean, thisAttemptSent: boolean): IntakeAttemptNext {
    if (event.kind === "retrying") return { next: "retry" };
    if (event.kind === "result") {
        if (thisAttemptSent) return { next: "end", outcome: "completed" };
        return sent ? { next: "end", outcome: "interrupted" } : { next: "parked", cause: "not_sent" };
    }
    if (event.kind === "failed") return sent ? { next: "end", outcome: "failed_indeterminate" } : { next: "parked", cause: event.cause };
    if (sent) return { next: "end", outcome: "interrupted" };
    if (event.kind === "stopped") return { next: "end", outcome: "not_dispatched" };
    return { next: "parked", cause: event.kind === "gate" ? "gate" : "hydration" };
}

/**
 * Apply the attempt that carried invocation `invocationId` (design 5.5): `sent`
 * first becomes true when the attempt threw, returned no witness or a witness
 * that says `sent: true` or `exposed` (an attempt that lost a racing commit
 * after its own request; review W2-WIT4), and never false again; then the
 * first matching row decides. `completed` needs the returned run's own
 * `sent: true`, which `exposed` never gives; `not_dispatched` only an
 * invocation no attempt sent. An end records its outcome for the end
 * settlement (intakeEndCall); a witness for another invocation is a broken
 * invariant, and nothing is settled.
 *
 * A store refusal (exposure protocol revision 2, section 5): `exposed`, the
 * items were possibly seen under another attempt, so the invocation is sent
 * and ends now, interrupted, or failed_indeterminate after a failure; it is
 * never parked or put on a retry, and the turn goes on by its own rules
 * without it. `settled` cannot be the answer to the attempt that carries a
 * bound invocation not ended: a broken invariant, and nothing is settled.
 */
export function applyIntakeAttempt(state: IntakeState, invocationId: string, dispatch: IntakeAttemptDispatch, event: IntakeAttemptEvent)
    : IntakeStep<IntakeAttemptNext> {
    const invocation = state.invocation;
    if (invocation === null || invocation.invocationId !== invocationId || !invocation.bound || invocation.settle !== null) {
        throw new IntakeInvariantError(null, `an attempt reported invocation ${invocationId}, which no attempt may carry now`);
    }
    checkAttempt(dispatch, event);
    let witness: ReturnType<typeof intakeDispatchWitness> = null;
    let possiblySent = false;
    if (dispatch.ran) {
        if (dispatch.threw) {
            possiblySent = true;
        } else {
            witness = intakeDispatchWitness(dispatch.witness);
            possiblySent = witness === null || witness.sent || witness.exposed || witness.refused === "exposed";
        }
    }
    if (witness !== null && witness.invocationId !== invocationId) {
        throw new IntakeInvariantError(null, `the attempt that carried invocation ${invocationId} returned a witness for ${witness.invocationId}`);
    }
    if (witness?.refused === "settled") {
        throw new IntakeInvariantError(null, `the store refused invocation ${invocationId} to the attempt that carried it as settled, but it is bound and not ended`);
    }
    const sent = invocation.sent || possiblySent;
    const step: IntakeAttemptNext = witness?.refused === "exposed"
        ? { next: "end", outcome: event.kind === "failed" ? "failed_indeterminate" : "interrupted" }
        : attemptStep(event, sent, witness !== null && witness.sent);
    let next: IntakeInvocation;
    if (step.next === "end") next = { ...invocation, sent, parked: null, settle: { outcome: step.outcome, retry: null } };
    else if (step.next === "parked") next = { ...invocation, sent, parked: step.cause };
    else next = { ...invocation, sent, parked: null };
    return { state: withInvocation(state, next), decision: step };
}

// ─── The end and its settlement (design 5.2, 5.5) ────────────

/** The invocation whose end is decided, its cancel write made: an end names a cancel only once the store recorded it. */
function endingInvocation(state: IntakeState): IntakeInvocation & { settle: NonNullable<IntakeInvocation["settle"]> } {
    const invocation = state.invocation;
    if (invocation === null || invocation.settle === null) throw new IntakeInvariantError(null, "no invocation waits for its end settlement");
    if (invocation.cancelWrite !== null) {
        throw new IntakeInvariantError(null, `invocation ${invocation.invocationId}'s cancel write is pending; its end is made after it`);
    }
    return { ...invocation, settle: invocation.settle };
}

/** An end settlement's input, and what its answer or failure is reported against: the batch and its flags when the call was made. */
export interface IntakeEndCall {
    invocationId: string;
    outcome: IntakeOutcome;
    items: Array<{ exchangeId: string; claimId: string; cancelRequested: boolean }>;
}

/**
 * The end settlement's input (design 5.2): the outcome and the batch, every
 * item not cancelled before the send with its cancel flag; empty when every
 * item was (the store then checks and writes nothing). Made only after the
 * invocation's cancel write, so a replay of an end that committed names only
 * cancels the store recorded (review INTAKE-MACHINE-03).
 */
export function intakeEndCall(state: IntakeState): IntakeEndCall {
    const invocation = endingInvocation(state);
    return {
        invocationId: invocation.invocationId, outcome: invocation.settle.outcome,
        items: invocation.items.map(item => ({ exchangeId: item.exchangeId, claimId: item.claimId, cancelRequested: item.cancelRequested })),
    };
}

/**
 * The invocation an end's answer or failure is reported for, checked against
 * its call: the same invocation, outcome and batch, and every flag the call
 * set still set (a latch is never cleared). A flag set since the call is a
 * cancel latched while the end was in flight (review of 813de112): its
 * cancel write is pending, or was made since.
 */
function answeredEnd(state: IntakeState, call: IntakeEndCall): IntakeInvocation & { settle: NonNullable<IntakeInvocation["settle"]> } {
    const invocation = state.invocation;
    if (invocation === null || invocation.settle === null) throw new IntakeInvariantError(null, "no invocation waits for its end settlement");
    if (invocation.invocationId !== call.invocationId || invocation.settle.outcome !== call.outcome) {
        throw new IntakeInvariantError(null,
            `the end reported is invocation ${call.invocationId}'s ${call.outcome}, not invocation ${invocation.invocationId}'s ${invocation.settle.outcome}`);
    }
    const sameBatch = invocation.items.length === call.items.length && invocation.items.every((item, index) => {
        const named = call.items[index];
        return item.exchangeId === named.exchangeId && item.claimId === named.claimId && (item.cancelRequested || !named.cancelRequested);
    });
    if (!sameBatch) throw new IntakeInvariantError(null, `the end reported for invocation ${invocation.invocationId} names another batch than its own`);
    return { ...invocation, settle: invocation.settle };
}

/**
 * The end `call` was settled (now, or found settled: a replay). The
 * invocation is cleared in the same step; other intake entries are
 * untouched. When a cancel was latched on an item after the call and its
 * write is still pending, the end that committed did not name it: the answer
 * is kept as the decision, and the end stays pending, made again after that
 * write with the item's flag set, which the store answers as the same end
 * (design 5.2); it is never refused or lost (review of 813de112).
 *
 * The answer names an `outcome` only when the store applied another one
 * (exposure protocol revision 2, section 6): the items were possibly seen,
 * so a requested not_dispatched was applied interrupted. The call is checked
 * first, as it was made; then only that one change is accepted, and the
 * outcome applied is the one kept (the invocation possibly sent): a later
 * cancel is then recorded as requested, and the end made again names it.
 */
export function applyIntakeEnded(state: IntakeState, call: IntakeEndCall, raw: unknown)
    : IntakeStep<{ kind: "ended" | "end_after_cancel"; ended: boolean; applied: IntakeOutcome }> {
    const invocation = answeredEnd(state, call);
    const coerced = typeof raw === "object" && raw !== null && Object.hasOwn(raw, "outcome");
    const value = intakeObject(raw, "end", coerced ? ["ended", "outcome"] : ["ended"]);
    if (typeof value.ended !== "boolean") throw new IntakeShapeError("end.ended", "is not a boolean");
    let applied: IntakeOutcome = call.outcome;
    if (coerced) {
        if (value.outcome !== "interrupted" || call.outcome !== "not_dispatched") {
            throw new IntakeInvariantError(null,
                `the end of invocation ${call.invocationId} asked for ${call.outcome}, but the store applied ${String(value.outcome)}`);
        }
        applied = "interrupted";
    }
    if (invocation.cancelWrite !== null) {
        return {
            state: withInvocation(state, { ...invocation, sent: invocation.sent || coerced, settle: { outcome: applied, retry: null } }),
            decision: { kind: "end_after_cancel", ended: value.ended, applied },
        };
    }
    return { state: withInvocation(state, null), decision: { kind: "ended", ended: value.ended, applied } };
}

/**
 * The end `call` failed after its retries: it is retried as a settlement on
 * the wake, never as a new attempt (design 5.5); a cancel write latched since
 * the call is made first.
 */
export function applyIntakeEndFailure(state: IntakeState, call: IntakeEndCall, nowMs: number): IntakeStep<{ kind: "settle_retry"; retry: IntakeRetry }> {
    const invocation = answeredEnd(state, call);
    const retry = intakeRetryAfterFailure(invocation.settle.retry, nowMs);
    return {
        state: withInvocation(state, { ...invocation, settle: { outcome: invocation.settle.outcome, retry } }),
        decision: { kind: "settle_retry", retry },
    };
}

// ─── The invocation's cancel write (design 5.5, review INTAKE-MACHINE-01 to 03) ──

function cancellingInvocation(state: IntakeState): IntakeInvocation & { cancelWrite: NonNullable<IntakeInvocation["cancelWrite"]> } {
    const invocation = state.invocation;
    if (invocation === null || invocation.cancelWrite === null) throw new IntakeInvariantError(null, "no invocation's cancel write is pending");
    return { ...invocation, cancelWrite: invocation.cancelWrite };
}

/** The invocation's cancel write, and what its answer or failure is reported against: the items latched when the call was made. */
export interface IntakeInvocationCancelCall {
    kind: "unsent" | "requested";
    invocationId: string;
    items: Array<{ exchangeId: string; claimId: string }>;
}

/**
 * The cancel write's input: every latched item. Unsent, each is settled
 * not_dispatched (cancelled) and leaves the batch (settle cancel_unsent);
 * sent, ending or not, each records cancel_requested and the outcome stands
 * (settle request_cancel). Each settle is the same result when repeated, so
 * the whole list is written again after a failure or a lost answer.
 */
export function intakeInvocationCancelCall(state: IntakeState): IntakeInvocationCancelCall {
    const invocation = cancellingInvocation(state);
    return {
        kind: invocation.sent ? "requested" : "unsent", invocationId: invocation.invocationId,
        items: invocation.items.filter(item => item.cancelRequested).map(item => ({ exchangeId: item.exchangeId, claimId: item.claimId })),
    };
}

/**
 * The invocation a cancel write's answer or failure is reported for, checked
 * against its call: the same invocation and kind, and every item the call
 * named still in the batch under its claim, its cancel latched.
 */
function answeredCancel(state: IntakeState, call: IntakeInvocationCancelCall)
    : IntakeInvocation & { cancelWrite: NonNullable<IntakeInvocation["cancelWrite"]> } {
    const invocation = cancellingInvocation(state);
    const kind = invocation.sent ? "requested" : "unsent";
    if (invocation.invocationId !== call.invocationId || kind !== call.kind) {
        throw new IntakeInvariantError(null, `the cancel write reported is invocation ${call.invocationId}'s (${call.kind}), not invocation ${
            invocation.invocationId}'s (${kind})`);
    }
    if (call.items.length === 0) throw new IntakeInvariantError(null, `a cancel write of invocation ${invocation.invocationId} is reported that names no item`);
    for (const named of call.items) {
        const item = invocation.items.find(candidate => candidate.exchangeId === named.exchangeId);
        if (item === undefined || item.claimId !== named.claimId || !item.cancelRequested) {
            throw new IntakeInvariantError(named.exchangeId, `its cancel was written for invocation ${invocation.invocationId}, but it is not an item of it whose cancel is latched`);
        }
    }
    return invocation;
}

/**
 * The cancel write `call` was made. Only the items it named are acknowledged
 * (review of 813de112): an item latched since the call stays latched, and
 * the write is due again now for it. Unsent: the named items leave the batch
 * with their sizes, in the same step; when none is left the invocation ends
 * not_dispatched with an empty batch, whose end names no exchange. Sent: the
 * cancels are recorded; the items keep their flags for the end to name.
 *
 * `exposed` (exposure protocol revision 2, sections 5 and 6) names the items
 * of an unsent write that the store found possibly seen under another
 * attempt: it recorded their cancels as requested. They keep their flags;
 * the others named leave the batch as before; the invocation is then
 * possibly sent and ends interrupted, never carried or parked again. Only
 * an unsent write's named item may be answered so.
 */
export function applyIntakeInvocationCancelled(state: IntakeState, call: IntakeInvocationCancelCall, exposed: ReadonlySet<string> = new Set())
    : IntakeState {
    const invocation = answeredCancel(state, call);
    const written = new Set(call.items.map(item => item.exchangeId));
    for (const exchangeId of exposed) {
        if (call.kind !== "unsent" || !written.has(exchangeId)) {
            throw new IntakeInvariantError(exchangeId, `its cancel was answered as possibly seen, but invocation ${invocation.invocationId}'s write did not cancel it unsent`);
        }
    }
    const cancelWrite: IntakeInvocation["cancelWrite"] = invocation.items.some(item => item.cancelRequested && !written.has(item.exchangeId))
        ? { retry: null } : null;
    if (invocation.sent) return withInvocation(state, { ...invocation, cancelWrite });
    const keep = invocation.items.map(item => !written.has(item.exchangeId) || exposed.has(item.exchangeId));
    const items = invocation.items.filter((_, index) => keep[index]);
    const itemBytes = invocation.itemBytes.filter((_, index) => keep[index]);
    if (exposed.size > 0) {
        return withInvocation(state, {
            ...invocation, items, itemBytes, sent: true, parked: null, cancelWrite, settle: { outcome: "interrupted", retry: null },
        });
    }
    const next: IntakeInvocation = items.length > 0
        ? { ...invocation, items, itemBytes, cancelWrite }
        : { ...invocation, items, itemBytes, cancelWrite: null, parked: null, settle: { outcome: "not_dispatched", retry: null } };
    return withInvocation(state, next);
}

/**
 * The cancel write `call` failed after its retries (or committed and its
 * answer was lost): the latches stay, due again on the wake; an unsent batch
 * with a latched item is still never carried, and an end waits for the
 * write.
 */
export function applyIntakeInvocationCancelFailure(state: IntakeState, call: IntakeInvocationCancelCall, nowMs: number)
    : IntakeStep<{ kind: "cancel_retry"; retry: IntakeRetry }> {
    const invocation = answeredCancel(state, call);
    const retry = intakeRetryAfterFailure(invocation.cancelWrite.retry, nowMs);
    return { state: withInvocation(state, { ...invocation, cancelWrite: { retry } }), decision: { kind: "cancel_retry", retry } };
}
