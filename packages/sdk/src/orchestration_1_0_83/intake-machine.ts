/**
 * Orchestration 1.0.83 (INACTIVE): the durable intake's transitions (design
 * docs/proposals/workflow-durable-intake.md 5.2 to 5.5, 5.7 and 9, amendment
 * 2), as pure functions of the carried intake state (intake-state.ts).
 *
 * Each function takes the state and what one step observed (a claim's or a
 * bind's result, a store write that failed, an attempt's dispatch witness,
 * the orchestration clock) and returns the next state and what the
 * orchestration does next. None yields, reads a clock, does I/O or changes
 * its arguments, so replay rebuilds the same states from the same history.
 * Nothing calls this module yet: the drain, sweep, decide and turn wiring,
 * the claim and settle activities and the turn's `intake` field are a later,
 * separately reviewed slice.
 *
 * - Arrival and claim (5.3, 5.4): an accepted claim becomes a held entry,
 *   unless the exchange is already placed (nothing more), its canonical id
 *   is cancelled (the holder settles it cancelled) or it has no room (the
 *   holder settles it refused). A claim that fails keeps the copy as an
 *   unclaimed entry, retried in place under its own claim id; with every
 *   unclaimed entry taken the copy is claimed again in mode refuse, and only
 *   a failure then stops the execution.
 * - The wake (5.4, N2): the earliest due claim, bind or end settlement, and
 *   the writes due now; it never starts a turn and never unparks.
 * - The invocation (5.5): formed from held entries in arrival order and bound
 *   before any attempt carries it; `sent` is cumulative; the transition table
 *   gives each carrying attempt's next step (its turn's retry, parked with a
 *   cause, or an end with its outcome); a parked one rides only an attempt
 *   that one of its resume stimuli starts; its end is a settlement, retried
 *   as one; a tombstone removes an unsent item or records a cancel on a sent
 *   one.
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
    intakeExchangeId,
    intakeId,
    intakeItemBytes,
    intakeItemFitsAlone,
    intakeObject,
    intakeSha256,
    intakeTextWithinCap,
    parseIntakeEnvelope,
    type IntakeEnvelope,
} from "../workflow/v2/intake.js";
import {
    INTAKE_MAX_HELD_ENTRY_BYTES,
    INTAKE_MAX_UNCLAIMED,
    INTAKE_MAX_UNCLAIMED_ENTRY_BYTES,
    selectIntakeBatch,
    type IntakeHeldEntry,
    type IntakeInvocation,
    type IntakeInvocationItem,
    type IntakeOutcome,
    type IntakeParkCause,
    type IntakeQueueEntry,
    type IntakeRetry,
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

function unclaimedCount(state: IntakeState): number {
    return state.queue.filter(entry => entry.kind === "unclaimed").length;
}

function unclaimedEntry(state: IntakeState, claimId: string): IntakeUnclaimedEntry {
    const entry = state.queue.find((candidate): candidate is IntakeUnclaimedEntry => candidate.kind === "unclaimed" && candidate.claimId === claimId);
    if (entry === undefined) throw new IntakeInvariantError(null, `no unclaimed entry waits under claim ${claimId}`);
    return entry;
}

/** The state with the unclaimed entry of `claimId` replaced in its arrival position, or removed (null). */
function withUnclaimed(state: IntakeState, claimId: string, replacement: IntakeQueueEntry | null): IntakeState {
    const queue: IntakeQueueEntry[] = [];
    for (const entry of state.queue) {
        if (entry.kind !== "unclaimed" || entry.claimId !== claimId) queue.push(entry);
        else if (replacement !== null) queue.push(replacement);
    }
    return { queue, invocation: state.invocation };
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

/** The retry of a waiting unclaimed entry under its own claim id (design 5.4): mode accept while a held entry is free, refuse otherwise. */
export function intakeUnclaimedRetryCall(state: IntakeState, claimId: string): IntakeClaimCall {
    const entry = unclaimedEntry(state, claimId);
    return { claimId: entry.claimId, envelope: entry.envelope, mode: heldCount(state) < INTAKE_MAX_HELD ? "accept" : "refuse", source: "unclaimed" };
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

/** The one fail-stop case (design 5.4, 9 row 11): a store outage with every unclaimed entry taken; the execution fails. */
export interface IntakeFailStop {
    kind: "fail_stop";
    exchangeId: string;
    message: string;
}

/** What the orchestration does after a claim (design 5.3, 5.4). */
export type IntakeClaimDecision =
    /** The item became a held entry: one newly claimed item, a resume stimulus of a parked invocation (5.5). */
    | { kind: "held"; entry: IntakeHeldEntry }
    /** The exchange already has this claim's placement: nothing more happens (I7). */
    | { kind: "already_placed" }
    /** Recorded: nothing is placed, no timer released, no digest taken, no tombstone consumed, no id pending. */
    | { kind: "recorded"; result: Exclude<IntakeClaimResult, { result: "accepted" }> }
    /** A tombstone names the canonical id (arrival step 4): the holder settles its row cancelled, then reports it to applyIntakeHolderSettle. */
    | { kind: "settle_cancelled"; exchangeId: string; claimId: string; clientMessageId: string }
    /**
     * No room: every held entry is taken (refused_full), or the item's held
     * reference would be over its 512-byte cap (refused_size). The holder
     * settles its row refused, then reports it to applyIntakeHolderSettle.
     */
    | { kind: "settle_refused"; exchangeId: string; claimId: string; outcome: "refused_full" | "refused_size" }
    | IntakeUnclaimedDecision
    /** The claim failed with every unclaimed entry taken: claim again in mode refuse (intakeRefuseClaimCall). */
    | { kind: "claim_refuse" }
    | IntakeFailStop;

/** What a claim's handling reads besides its result: the orchestration clock and the session's tombstones. */
export interface IntakeClaimContext {
    nowMs: number;
    isCancelled: IntakeCancelCheck;
}

/** A waiting entry for a copy whose claim or holder settle failed; null when a dequeued copy finds every unclaimed entry taken. */
function keepUnclaimed(state: IntakeState, call: IntakeClaimCall, nowMs: number): IntakeStep<IntakeUnclaimedDecision> | null {
    if (call.source === "unclaimed") {
        const entry = unclaimedEntry(state, call.claimId);
        const retry = intakeRetryAfterFailure(entry.retry, nowMs);
        return { state: withUnclaimed(state, call.claimId, { ...entry, retry }), decision: { kind: "unclaimed", claimId: call.claimId, retry } };
    }
    if (unclaimedCount(state) >= INTAKE_MAX_UNCLAIMED) return null;
    const retry = intakeRetryAfterFailure(null, nowMs);
    const entry: IntakeUnclaimedEntry = { kind: "unclaimed", claimId: call.claimId, envelope: call.envelope, retry };
    // Not reachable: an envelope within its 1 KiB cap and an id within its length always fit the entry's 2 KiB.
    if (jsonBytes(entry) > INTAKE_MAX_UNCLAIMED_ENTRY_BYTES) throw new IntakeInvariantError(call.envelope.exchangeId, "its unclaimed entry is over its cap");
    return { state: { queue: [...state.queue, entry], invocation: state.invocation }, decision: { kind: "unclaimed", claimId: call.claimId, retry } };
}

function failStop(state: IntakeState, call: IntakeClaimCall): IntakeStep<IntakeFailStop> {
    const exchangeId = call.envelope.exchangeId;
    return {
        state,
        decision: {
            kind: "fail_stop", exchangeId,
            message: `The workflow store could not record exchange ${exchangeId} while every unclaimed intake entry is taken (design 5.4).`,
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
 * becomes held keeps its arrival position.
 */
export function applyIntakeClaim(state: IntakeState, call: IntakeClaimCall, outcome: { result: unknown } | { failed: true }, context: IntakeClaimContext)
    : IntakeStep<IntakeClaimDecision> {
    checkCall(state, call);
    if ("failed" in outcome) {
        const kept = keepUnclaimed(state, call, context.nowMs);
        if (kept !== null) return kept;
        return call.mode === "accept" ? { state, decision: { kind: "claim_refuse" } } : failStop(state, call);
    }
    const result = parseIntakeClaimResult(outcome.result, call);
    if (result.result !== "accepted") return { state: dropRetried(state, call), decision: { kind: "recorded", result } };
    const { item } = result;
    const placedUnder = intakePlacementClaim(state, item.exchangeId);
    if (placedUnder !== null) {
        if (placedUnder !== item.claimId) {
            throw new IntakeInvariantError(item.exchangeId, `it is placed under claim ${placedUnder}, but its row holds claim ${item.claimId}`);
        }
        return { state: dropRetried(state, call), decision: { kind: "already_placed" } };
    }
    if (context.isCancelled(item.clientMessageId)) {
        return { state, decision: { kind: "settle_cancelled", exchangeId: item.exchangeId, claimId: item.claimId, clientMessageId: item.clientMessageId } };
    }
    const entry: IntakeHeldEntry = {
        kind: "held", exchangeId: item.exchangeId, claimId: item.claimId, textSha256: item.textSha256, clientMessageId: item.clientMessageId,
        itemBytes: item.itemBytes,
    };
    if (jsonBytes(entry) > INTAKE_MAX_HELD_ENTRY_BYTES) {
        return { state, decision: { kind: "settle_refused", exchangeId: item.exchangeId, claimId: item.claimId, outcome: "refused_size" } };
    }
    if (heldCount(state) >= INTAKE_MAX_HELD) {
        return { state, decision: { kind: "settle_refused", exchangeId: item.exchangeId, claimId: item.claimId, outcome: "refused_full" } };
    }
    const placed = call.source === "unclaimed" ? withUnclaimed(state, call.claimId, entry) : { queue: [...state.queue, entry], invocation: state.invocation };
    return { state: placed, decision: { kind: "held", entry } };
}

/**
 * The holder's settle after a claim (settle_cancelled or settle_refused).
 * Settled: the copy is done, and a retried entry leaves the queue. Not
 * settled (the write failed after its retries): the copy keeps or takes an
 * unclaimed entry under the same claim, whose retry finds its holding row
 * again (accepted) and decides afresh; with every unclaimed entry taken the
 * execution fails (the one fail-stop case).
 */
export function applyIntakeHolderSettle(state: IntakeState, call: IntakeClaimCall, settled: boolean, nowMs: number)
    : IntakeStep<{ kind: "settled" } | IntakeUnclaimedDecision | IntakeFailStop> {
    checkCall(state, call);
    if (settled) return { state: dropRetried(state, call), decision: { kind: "settled" } };
    return keepUnclaimed(state, call, nowMs) ?? failStop(state, call);
}

// ─── The wake (design 5.4, N2) ───────────────────────────────

/**
 * The earliest due time of the intake's store writes, the third deadline of
 * drain's race: an unclaimed entry's claim, the invocation's bind or its end
 * settlement. A write that has no due time yet is due now (0). Null when no
 * write waits: drain then runs exactly as today.
 */
export function intakeDueAtMs(state: IntakeState): number | null {
    const times: number[] = [];
    for (const entry of state.queue) {
        if (entry.kind === "unclaimed") times.push(entry.retry.nextAttemptAtMs);
    }
    const invocation = state.invocation;
    if (invocation !== null && !invocation.bound) times.push(invocation.bindRetry?.nextAttemptAtMs ?? 0);
    else if (invocation !== null && invocation.settle !== null) times.push(invocation.settle.retry?.nextAttemptAtMs ?? 0);
    return times.length === 0 ? null : Math.min(...times);
}

/** A store write the wake makes when due: an unclaimed entry's claim, the invocation's bind, or its end settlement. */
export type IntakeDueWork = { kind: "claim"; claimId: string } | { kind: "bind" } | { kind: "settle" };

/** The writes due at `nowMs`: unclaimed claims oldest first, then the bind or the settlement. Store writes only: no turn, no unparking. */
export function intakeDueWork(state: IntakeState, nowMs: number): IntakeDueWork[] {
    const now = clockMs(nowMs);
    const work: IntakeDueWork[] = [];
    for (const entry of state.queue) {
        if (entry.kind === "unclaimed" && entry.retry.nextAttemptAtMs <= now) work.push({ kind: "claim", claimId: entry.claimId });
    }
    const invocation = state.invocation;
    if (invocation !== null && !invocation.bound) {
        if ((invocation.bindRetry?.nextAttemptAtMs ?? 0) <= now) work.push({ kind: "bind" });
    } else if (invocation !== null && invocation.settle !== null) {
        if ((invocation.settle.retry?.nextAttemptAtMs ?? 0) <= now) work.push({ kind: "settle" });
    }
    return work;
}

// ─── Held entries and the binding (design 5.5, 6.1) ──────────

/** The held entries a tombstone names: decide settles each cancelled before it binds, and none is ever bound. */
export function intakeHeldToCancel(state: IntakeState, isCancelled: IntakeCancelCheck): IntakeHeldEntry[] {
    return state.queue.filter((entry): entry is IntakeHeldEntry => entry.kind === "held" && isCancelled(entry.clientMessageId));
}

/** Held entries their holder settled cancelled leave the queue. A settle that failed leaves its entry held (and unbound) for the next decide. */
export function applyIntakeHeldCancelled(state: IntakeState, exchangeIds: readonly string[]): IntakeState {
    const settled = new Set(exchangeIds);
    for (const exchangeId of settled) {
        if (!state.queue.some(entry => entry.kind === "held" && entry.exchangeId === exchangeId)) {
            throw new IntakeInvariantError(exchangeId, "it was settled cancelled but is not a held entry");
        }
    }
    return { queue: state.queue.filter(entry => entry.kind !== "held" || !settled.has(entry.exchangeId)), invocation: state.invocation };
}

/** Whether decide forms an invocation now: none exists, and a held entry that no tombstone names waits. */
export function intakeCanForm(state: IntakeState, isCancelled: IntakeCancelCheck): boolean {
    return state.invocation === null && state.queue.some(entry => entry.kind === "held" && !isCancelled(entry.clientMessageId));
}

/**
 * Form the next invocation in one synchronous step (design 5.5, C1): the
 * longest arrival-order run of held entries that fits one invocation, those
 * a tombstone names passed over, leaves the queue and becomes its batch,
 * unbound and unsent. Its bind follows in the same pass with no other yield
 * between, so this form, which has no bind retry yet, is never carried.
 */
export function formIntakeInvocation(state: IntakeState, invocationId: string, isCancelled: IntakeCancelCheck): IntakeState {
    if (state.invocation !== null) {
        throw new IntakeInvariantError(null, `invocation ${state.invocation.invocationId} exists; the next one forms only after it ends`);
    }
    const id = intakeId(invocationId, "invocationId");
    const batch = selectIntakeBatch(state.queue.filter(entry => entry.kind !== "held" || !isCancelled(entry.clientMessageId)));
    if (batch.length === 0) throw new IntakeInvariantError(null, "no held entry waits for an invocation");
    const taken = new Set(batch.map(entry => entry.claimId));
    const invocation: IntakeInvocation = {
        invocationId: id,
        items: batch.map((entry): IntakeInvocationItem => ({
            exchangeId: entry.exchangeId, claimId: entry.claimId, textSha256: entry.textSha256, clientMessageId: entry.clientMessageId,
            text: null, cancelRequested: false,
        })),
        itemBytes: batch.map(entry => entry.itemBytes),
        bound: false, sent: false, parked: null, bindRetry: null, settle: null,
    };
    return { queue: state.queue.filter(entry => !taken.has(entry.claimId)), invocation };
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
 * other answer is a broken invariant, and nothing is dispatched.
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
    return { queue: state.queue, invocation: { ...invocation, items, bound: true, bindRetry: null } };
}

/** The bind failed after its retries: the invocation stays unsent and unbound, its bind due on the wake (design 5.5); nothing carries it. */
export function applyIntakeBindFailure(state: IntakeState, nowMs: number): IntakeStep<{ kind: "bind_retry"; retry: IntakeRetry }> {
    const invocation = unboundInvocation(state);
    const retry = intakeRetryAfterFailure(invocation.bindRetry, nowMs);
    return { state: { queue: state.queue, invocation: { ...invocation, bindRetry: retry } }, decision: { kind: "bind_retry", retry } };
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

/** The stimuli that resume an invocation parked for any cause but a gate. */
const RESUME_STIMULI: readonly IntakeStimulus[] = ["message", "timer", "intake_arrival"];

/** A turn attempt about to run: a turn's retry (naming the invocation its earlier attempt carried, or none), or a new turn and its stimulus. */
export type IntakeAttemptStart =
    | { kind: "retry"; invocationId: string | null }
    | { kind: "new"; stimulus: IntakeStimulus };

/** What a carrying attempt sends in its own `intake` field, never inside the prompt (design 5.5). */
export interface IntakeTurnPayload {
    invocationId: string;
    items: Array<{ exchangeId: string; clientMessageId: string; text: string }>;
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
            return { exchangeId: item.exchangeId, clientMessageId: item.clientMessageId, text: item.text };
        }),
    };
}

/**
 * Whether an attempt carries the invocation, and its payload (design 5.5).
 * A sent invocation rides only its own turn's retries (the retry names it).
 * An unsent one rides any attempt when ready; parked for a gate, only the
 * gate's own retry; parked for any other cause, only a new turn that a
 * message, a timer or a newly claimed item starts. Carrying unparks it: the
 * attempt applies the transition table again. An unbound invocation, one
 * whose end is being settled, and an unsent one with an item a tombstone
 * names (its cancel is settled first) ride nothing.
 */
export function carryIntakeInvocation(state: IntakeState, start: IntakeAttemptStart, isCancelled: IntakeCancelCheck)
    : { state: IntakeState; carry: IntakeTurnPayload | null } {
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
    else if (invocation.parked === null) carries = true;
    else if (invocation.parked === "gate") carries = start.kind === "new" && start.stimulus === "gate_retry";
    else carries = start.kind === "new" && RESUME_STIMULI.includes(start.stimulus);
    if (carries && !invocation.sent && invocation.items.some(item => isCancelled(item.clientMessageId))) carries = false;
    if (!carries) return { state, carry: null };
    const next: IntakeInvocation = { ...invocation, parked: null };
    return { state: { queue: state.queue, invocation: next }, carry: intakeTurnPayload(next) };
}

/**
 * Whether decide starts a turn for the invocation alone when nothing else is
 * queued (design 5.5, I11): a ready one starts one (`intake_turn`); one parked
 * for any cause but a gate starts one only for a newly claimed item not yet
 * answered by an attempt (`intake_arrival`); anything else starts none, nor
 * does an unsent one with an item a tombstone names until that cancel is
 * settled (no attempt would carry it).
 */
export function intakeOwnTurnStimulus(state: IntakeState, pendingArrivals: number, isCancelled: IntakeCancelCheck)
    : "intake_turn" | "intake_arrival" | null {
    const invocation = state.invocation;
    if (invocation === null || !invocation.bound || invocation.sent || invocation.settle !== null) return null;
    if (invocation.items.some(item => isCancelled(item.clientMessageId))) return null;
    if (invocation.parked === null) return "intake_turn";
    return invocation.parked !== "gate" && pendingArrivals > 0 ? "intake_arrival" : null;
}

// ─── Attempt results: the transition table (design 5.5) ──────

/** An attempt's `intakeDispatch` witness, or null when it returned none. */
export function intakeDispatchWitness(raw: unknown): { invocationId: string; sent: boolean } | null {
    if (raw === undefined || raw === null) return null;
    const value = intakeObject(raw, "intakeDispatch", ["invocationId", "sent"]);
    const sent = value.sent;
    if (typeof sent !== "boolean") throw new IntakeShapeError("intakeDispatch.sent", "is not a boolean");
    return { invocationId: intakeId(value.invocationId, "intakeDispatch.invocationId"), sent };
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
 * `sent: true`, and never false again; then the first matching row decides.
 * `completed` needs this attempt's own `sent: true`; `not_dispatched` only an
 * invocation no attempt sent. An end records its outcome for the end
 * settlement (intakeEndCall); a witness for another invocation is a broken
 * invariant, and nothing is settled.
 */
export function applyIntakeAttempt(state: IntakeState, invocationId: string, dispatch: IntakeAttemptDispatch, event: IntakeAttemptEvent)
    : IntakeStep<IntakeAttemptNext> {
    const invocation = state.invocation;
    if (invocation === null || invocation.invocationId !== invocationId || !invocation.bound || invocation.settle !== null) {
        throw new IntakeInvariantError(null, `an attempt reported invocation ${invocationId}, which no attempt may carry now`);
    }
    checkAttempt(dispatch, event);
    let witness: { invocationId: string; sent: boolean } | null = null;
    let possiblySent = false;
    if (dispatch.ran) {
        if (dispatch.threw) {
            possiblySent = true;
        } else {
            witness = intakeDispatchWitness(dispatch.witness);
            possiblySent = witness === null || witness.sent;
        }
    }
    if (witness !== null && witness.invocationId !== invocationId) {
        throw new IntakeInvariantError(null, `the attempt that carried invocation ${invocationId} returned a witness for ${witness.invocationId}`);
    }
    const sent = invocation.sent || possiblySent;
    const step = attemptStep(event, sent, witness !== null && witness.sent);
    let next: IntakeInvocation;
    if (step.next === "end") next = { ...invocation, sent, parked: null, settle: { outcome: step.outcome, retry: null } };
    else if (step.next === "parked") next = { ...invocation, sent, parked: step.cause };
    else next = { ...invocation, sent, parked: null };
    return { state: { queue: state.queue, invocation: next }, decision: step };
}

// ─── The end and its settlement (design 5.2, 5.5) ────────────

function endingInvocation(state: IntakeState): IntakeInvocation & { settle: NonNullable<IntakeInvocation["settle"]> } {
    const invocation = state.invocation;
    if (invocation === null || invocation.settle === null) throw new IntakeInvariantError(null, "no invocation waits for its end settlement");
    return { ...invocation, settle: invocation.settle };
}

/**
 * The end settlement's input (design 5.2): the outcome and the batch, every
 * item not cancelled before the send with its cancel flag; empty when every
 * item was (the store then checks and writes nothing).
 */
export function intakeEndCall(state: IntakeState)
    : { invocationId: string; outcome: IntakeOutcome; items: Array<{ exchangeId: string; claimId: string; cancelRequested: boolean }> } {
    const invocation = endingInvocation(state);
    return {
        invocationId: invocation.invocationId, outcome: invocation.settle.outcome,
        items: invocation.items.map(item => ({ exchangeId: item.exchangeId, claimId: item.claimId, cancelRequested: item.cancelRequested })),
    };
}

/** The end was settled (now, or found settled: a replay): the invocation is cleared in the same step; other intake entries are untouched. */
export function applyIntakeEnded(state: IntakeState, raw: unknown): IntakeState {
    endingInvocation(state);
    const value = intakeObject(raw, "end", ["ended"]);
    if (typeof value.ended !== "boolean") throw new IntakeShapeError("end.ended", "is not a boolean");
    return { queue: state.queue, invocation: null };
}

/** The end settlement failed after its retries: it is retried as a settlement on the wake, never as a new attempt (design 5.5). */
export function applyIntakeEndFailure(state: IntakeState, nowMs: number): IntakeStep<{ kind: "settle_retry"; retry: IntakeRetry }> {
    const invocation = endingInvocation(state);
    const retry = intakeRetryAfterFailure(invocation.settle.retry, nowMs);
    return {
        state: { queue: state.queue, invocation: { ...invocation, settle: { outcome: invocation.settle.outcome, retry } } },
        decision: { kind: "settle_retry", retry },
    };
}

// ─── Tombstones on the invocation (design 5.5) ───────────────

/** A cancel to settle for an item of the invocation: `unsent` removes it (not_dispatched, reason cancelled); `requested` records it only. */
export type IntakeInvocationCancel = { kind: "unsent" | "requested"; exchangeId: string; claimId: string; clientMessageId: string };

/**
 * The cancels the invocation's items need: none before its bind (its rows
 * are not yet admitted) or while its end is being settled (its outcome is
 * decided); an unsent item a tombstone names is removed; a sent one records
 * cancel_requested once.
 */
export function intakeInvocationCancels(state: IntakeState, isCancelled: IntakeCancelCheck): IntakeInvocationCancel[] {
    const invocation = state.invocation;
    if (invocation === null || !invocation.bound || invocation.settle !== null) return [];
    const kind: "unsent" | "requested" = invocation.sent ? "requested" : "unsent";
    return invocation.items
        .filter(item => isCancelled(item.clientMessageId) && !(invocation.sent && item.cancelRequested))
        .map((item): IntakeInvocationCancel => ({ kind, exchangeId: item.exchangeId, claimId: item.claimId, clientMessageId: item.clientMessageId }));
}

function itemIndex(invocation: IntakeInvocation, exchangeId: string): number {
    const index = invocation.items.findIndex(item => item.exchangeId === exchangeId);
    if (index < 0) throw new IntakeInvariantError(exchangeId, `it is not an item of invocation ${invocation.invocationId}`);
    return index;
}

/**
 * An unsent item was settled not_dispatched (cancelled): it leaves the batch
 * in the same step. When the last one leaves, the invocation ends
 * not_dispatched with an empty batch, whose end names no exchange.
 */
export function applyIntakeUnsentCancelled(state: IntakeState, exchangeId: string): IntakeState {
    const invocation = state.invocation;
    if (invocation === null || !invocation.bound || invocation.sent || invocation.settle !== null) {
        throw new IntakeInvariantError(exchangeId, "it was cancelled as unsent, but no bound unsent invocation waits");
    }
    const index = itemIndex(invocation, exchangeId);
    const items = invocation.items.filter((_, position) => position !== index);
    const itemBytes = invocation.itemBytes.filter((_, position) => position !== index);
    const next: IntakeInvocation = items.length > 0
        ? { ...invocation, items, itemBytes }
        : { ...invocation, items, itemBytes, parked: null, settle: { outcome: "not_dispatched", retry: null } };
    return { queue: state.queue, invocation: next };
}

/** A cancel of a sent item was recorded (cancel_requested): only its flag changes, and the invocation's outcome stands. */
export function applyIntakeCancelRequested(state: IntakeState, exchangeId: string): IntakeState {
    const invocation = state.invocation;
    if (invocation === null || !invocation.bound || !invocation.sent || invocation.settle !== null) {
        throw new IntakeInvariantError(exchangeId, "its cancel was recorded, but no sent invocation waits");
    }
    const index = itemIndex(invocation, exchangeId);
    const items = invocation.items.map((item, position) => position === index ? { ...item, cancelRequested: true } : item);
    return { queue: state.queue, invocation: { ...invocation, items } };
}
