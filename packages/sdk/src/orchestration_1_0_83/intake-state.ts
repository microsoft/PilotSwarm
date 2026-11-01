/**
 * Orchestration 1.0.83 (INACTIVE): the durable intake state that every
 * continue-as-new carries (design docs/proposals/workflow-durable-intake.md
 * 5.4, 5.5 and 5.7, amendment 2). Intake writes no KV: its queue and its one
 * invocation are orchestration state, rebuilt by replay within an execution
 * and carried in the continue-as-new input across executions.
 *
 * - An absent carried state is empty: an input from 1.0.82 or earlier, or a
 *   session that has had no intake item. A present state that does not
 *   validate fails the execution with the field's path: it is never read as
 *   empty, and nothing in it is dropped or trimmed.
 * - The carried form of an empty state is absent, so a session with no
 *   intake continues as new with exactly the input 1.0.82 builds.
 * - Sizes are in UTF-8 bytes of the exact JSON carried. The caps bound a
 *   design budget (110 KiB in all); what the installed runtime and provider
 *   accept for a whole continue-as-new input is a qualification obligation
 *   before activation, not something this module proves.
 * - A decided store write is latched in this state before it is made (review
 *   INTAKE-MACHINE-01): a settling entry, a held entry's cancel, the
 *   invocation's cancel write. A latch is never re-decided from tombstones,
 *   survives continue-as-new, and is retried on the wake until made.
 *
 * Pure: no yields, no I/O, no clock. Exercised by
 * test/unit/orchestration-intake-1-0-83.test.mjs.
 */
import { createHash } from "node:crypto";
import type { OrchestrationInput } from "../types.js";
import {
    INTAKE_MAX_CLIENT_MESSAGE_ID_LENGTH,
    INTAKE_MAX_HELD,
    INTAKE_MAX_INVOCATION_ITEMS_BYTES,
    IntakeShapeError,
    intakeBoundItem,
    intakeClientMessageId,
    intakeExchangeId,
    intakeId,
    intakeItemBytes,
    intakeItemFitsAlone,
    intakeItemsBytes,
    intakeObject,
    intakeSha256,
    parseIntakeEnvelope,
    type IntakeEnvelope,
} from "../workflow/v2/intake.js";

export { IntakeShapeError };

/** At most this many copies wait for a store write before any placement: unclaimed and settling entries together (design 5.4, 5.7). */
export const INTAKE_MAX_UNCLAIMED = 8;
export const INTAKE_MAX_UNCLAIMED_ENTRY_BYTES = 2 * 1024;
/** At most this many claimed items wait for an invocation (design 5.4, 5.7); shared with the store's bind. */
export { INTAKE_MAX_HELD };
/** A held entry's cap, its cancel latch at its largest included, so a later cancel always fits. */
export const INTAKE_MAX_HELD_ENTRY_BYTES = 512;
/** The invocation's fields other than its items (design 5.7). */
export const INTAKE_MAX_INVOCATION_FIELDS_BYTES = 1024;
/** The longest client message id an item keeps; shared with the store's claim. */
export { INTAKE_MAX_CLIENT_MESSAGE_ID_LENGTH };
/** The carried form's version. */
export const INTAKE_STATE_FORMAT = 1;

/** How an invocation's processing ended (design 5.5); `not_dispatched` only when no attempt sent it. */
export type IntakeOutcome = "completed" | "not_dispatched" | "interrupted" | "failed_indeterminate";
/** Why an unsent invocation is parked; it resumes only on that cause's stimuli (design 5.5). */
export type IntakeParkCause = "gate" | "credential" | "non_retryable" | "exhausted" | "not_sent" | "hydration";
/** The final state a holder writes for a claimed copy it does not place (design 5.2, 5.6). */
export type IntakeHolderOutcome = "cancelled" | "refused_full" | "refused_size";

const OUTCOMES: readonly IntakeOutcome[] = ["completed", "not_dispatched", "interrupted", "failed_indeterminate"];
const PARK_CAUSES: readonly IntakeParkCause[] = ["gate", "credential", "non_retryable", "exhausted", "not_sent", "hydration"];
const HOLDER_OUTCOMES: readonly IntakeHolderOutcome[] = ["cancelled", "refused_full", "refused_size"];

/** A store write that failed and waits for its due time on the intake wake (design 5.4, N2). */
export interface IntakeRetry {
    attempts: number;
    /** Due time in ms of the orchestration clock (ctx.utcNow). */
    nextAttemptAtMs: number;
}

/** A decided store write, latched until it is made: due now (no retry yet), or at its retry. */
export interface IntakeLatch {
    retry: IntakeRetry | null;
}

/** The largest latch, for caps that must hold whatever a latch's retry becomes. */
export const INTAKE_LARGEST_LATCH: IntakeLatch = { retry: { attempts: Number.MAX_SAFE_INTEGER, nextAttemptAtMs: Number.MAX_SAFE_INTEGER } };

/**
 * A message whose claim the store could not take; only its envelope is kept,
 * never the queued prompt. `cancel` latches a tombstone that named its
 * canonical id while it waited: once claimed it is settled cancelled, whatever
 * the tombstones say then.
 */
export interface IntakeUnclaimedEntry {
    kind: "unclaimed";
    claimId: string;
    envelope: IntakeEnvelope;
    retry: IntakeRetry;
    cancel: boolean;
}

/**
 * A claimed copy with no placement whose holder decided its final state
 * (cancelled, or refused for room or size): latched before the write, then
 * written, and retried on the wake until made; never claimed or decided again.
 */
export interface IntakeSettlingEntry {
    kind: "settling";
    exchangeId: string;
    claimId: string;
    outcome: IntakeHolderOutcome;
    retry: IntakeRetry | null;
}

/**
 * A claimed item waiting for an invocation: a reference, not its text (the
 * claim stored the text in the item's row). `itemBytes` is the exact size of
 * its bound form, measured when it was claimed, so a batch is chosen before
 * its bind and never found too large after it (condition C1). `cancel`
 * latches a tombstone that named it: it is never bound, and its cancel is
 * written, and retried on the wake, until made.
 */
export interface IntakeHeldEntry {
    kind: "held";
    exchangeId: string;
    claimId: string;
    textSha256: string;
    clientMessageId: string;
    itemBytes: number;
    cancel: IntakeLatch | null;
}

export type IntakeQueueEntry = IntakeUnclaimedEntry | IntakeSettlingEntry | IntakeHeldEntry;

/**
 * An invocation's item: its reference, its text once bound (null before), and
 * whether a tombstone named it (latched, never cleared): an unsent item is
 * removed by the invocation's cancel write (not_dispatched, cancelled); a sent
 * one keeps its outcome, its cancel_requested recorded by that write and
 * named by the end.
 */
export interface IntakeInvocationItem {
    exchangeId: string;
    claimId: string;
    textSha256: string;
    clientMessageId: string;
    text: string | null;
    cancelRequested: boolean;
}

/** The logical turn invocation that carries a fixed batch of admitted items (design 5.5). */
export interface IntakeInvocation {
    invocationId: string;
    /** In arrival order; never grows, and does not change after its first send. Empty only once every item was cancelled unsent. */
    items: IntakeInvocationItem[];
    /** The items' bound sizes as measured at their claims, in the same order. */
    itemBytes: number[];
    /** The store bound the claims to this invocation (the admission). */
    bound: boolean;
    /** Cumulative: some attempt sent it, or may have; never false again once true. */
    sent: boolean;
    /** An unsent invocation that starts no turn until one of its cause's stimuli. */
    parked: IntakeParkCause | null;
    /** A bind that could not be made yet; only before the bind. */
    bindRetry: IntakeRetry | null;
    /** An end decided but not yet settled in the store; no turn carries it. */
    settle: { outcome: IntakeOutcome; retry: IntakeRetry | null } | null;
    /** The store write of its items' latched cancels, pending until made; made before its end. Only once bound. */
    cancelWrite: IntakeLatch | null;
}

export interface IntakeState {
    queue: IntakeQueueEntry[];
    invocation: IntakeInvocation | null;
}

/** The continue-as-new input as 1.0.83 writes and reads it: OrchestrationInput with the carried intake. */
export type IntakeCarryingInput = OrchestrationInput & { intake?: unknown };

/** The carried form: what a continue-as-new input holds under `intake`. */
export interface CarriedIntakeState {
    v: typeof INTAKE_STATE_FORMAT;
    queue: IntakeQueueEntry[];
    invocation: IntakeInvocation | null;
}

export function emptyIntakeState(): IntakeState {
    return { queue: [], invocation: null };
}

function bytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function integerOf(raw: unknown, path: string, min: number): number {
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min) throw new IntakeShapeError(path, `is not an integer of at least ${min}`);
    return raw;
}

function booleanOf(raw: unknown, path: string): boolean {
    if (typeof raw !== "boolean") throw new IntakeShapeError(path, "is not a boolean");
    return raw;
}

function clientMessageIdOf(raw: unknown, path: string): string {
    return intakeClientMessageId(raw, path);
}

function retryOf(raw: unknown, path: string): IntakeRetry {
    const value = intakeObject(raw, path, ["attempts", "nextAttemptAtMs"]);
    return { attempts: integerOf(value.attempts, `${path}.attempts`, 1), nextAttemptAtMs: integerOf(value.nextAttemptAtMs, `${path}.nextAttemptAtMs`, 0) };
}

function latchOf(raw: unknown, path: string): IntakeLatch {
    const value = intakeObject(raw, path, ["retry"]);
    return { retry: value.retry === null ? null : retryOf(value.retry, `${path}.retry`) };
}

/** A held entry's size against its cap: its JSON with its cancel latch at its largest, so a later cancel never takes it over the cap. */
export function intakeHeldEntryCapBytes(entry: IntakeHeldEntry): number {
    return bytes({ ...entry, cancel: INTAKE_LARGEST_LATCH });
}

function entryOf(raw: unknown, path: string): IntakeQueueEntry {
    const kind = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).kind : undefined;
    if (kind === "unclaimed") {
        const value = intakeObject(raw, path, ["kind", "claimId", "envelope", "retry", "cancel"]);
        const entry: IntakeUnclaimedEntry = {
            kind: "unclaimed", claimId: intakeId(value.claimId, `${path}.claimId`), envelope: parseIntakeEnvelope(value.envelope, `${path}.envelope`),
            retry: retryOf(value.retry, `${path}.retry`), cancel: booleanOf(value.cancel, `${path}.cancel`),
        };
        if (bytes(entry) > INTAKE_MAX_UNCLAIMED_ENTRY_BYTES) throw new IntakeShapeError(path, `is over ${INTAKE_MAX_UNCLAIMED_ENTRY_BYTES} bytes`);
        return entry;
    }
    if (kind === "settling") {
        const value = intakeObject(raw, path, ["kind", "exchangeId", "claimId", "outcome", "retry"]);
        const outcome = HOLDER_OUTCOMES.find(item => item === value.outcome);
        if (outcome === undefined) throw new IntakeShapeError(`${path}.outcome`, "is not cancelled, refused_full or refused_size");
        const entry: IntakeSettlingEntry = {
            kind: "settling", exchangeId: intakeExchangeId(value.exchangeId, `${path}.exchangeId`), claimId: intakeId(value.claimId, `${path}.claimId`),
            outcome, retry: value.retry === null ? null : retryOf(value.retry, `${path}.retry`),
        };
        if (bytes(entry) > INTAKE_MAX_UNCLAIMED_ENTRY_BYTES) throw new IntakeShapeError(path, `is over ${INTAKE_MAX_UNCLAIMED_ENTRY_BYTES} bytes`);
        return entry;
    }
    if (kind === "held") {
        const value = intakeObject(raw, path, ["kind", "exchangeId", "claimId", "textSha256", "clientMessageId", "itemBytes", "cancel"]);
        const entry: IntakeHeldEntry = {
            kind: "held", exchangeId: intakeExchangeId(value.exchangeId, `${path}.exchangeId`), claimId: intakeId(value.claimId, `${path}.claimId`),
            textSha256: intakeSha256(value.textSha256, `${path}.textSha256`),
            clientMessageId: clientMessageIdOf(value.clientMessageId, `${path}.clientMessageId`),
            itemBytes: integerOf(value.itemBytes, `${path}.itemBytes`, 1),
            cancel: value.cancel === null ? null : latchOf(value.cancel, `${path}.cancel`),
        };
        if (!intakeItemFitsAlone(entry.itemBytes)) throw new IntakeShapeError(`${path}.itemBytes`, "is over what one invocation holds");
        if (intakeHeldEntryCapBytes(entry) > INTAKE_MAX_HELD_ENTRY_BYTES) throw new IntakeShapeError(path, `is over ${INTAKE_MAX_HELD_ENTRY_BYTES} bytes`);
        return entry;
    }
    throw new IntakeShapeError(`${path}.kind`, "is not unclaimed, settling or held");
}

function itemOf(raw: unknown, path: string): IntakeInvocationItem {
    const value = intakeObject(raw, path, ["exchangeId", "claimId", "textSha256", "clientMessageId", "text", "cancelRequested"]);
    const rawText = value.text;
    let text: string | null;
    if (rawText === null) text = null;
    else if (typeof rawText === "string") text = rawText;
    else throw new IntakeShapeError(`${path}.text`, "is not a text or null");
    return {
        exchangeId: intakeExchangeId(value.exchangeId, `${path}.exchangeId`), claimId: intakeId(value.claimId, `${path}.claimId`),
        textSha256: intakeSha256(value.textSha256, `${path}.textSha256`),
        clientMessageId: clientMessageIdOf(value.clientMessageId, `${path}.clientMessageId`),
        text, cancelRequested: booleanOf(value.cancelRequested, `${path}.cancelRequested`),
    };
}

function invocationOf(raw: unknown, path: string): IntakeInvocation {
    const invalid = (field: string, message: string) => new IntakeShapeError(`${path}.${field}`, message);
    const value = intakeObject(raw, path, ["invocationId", "items", "itemBytes", "bound", "sent", "parked", "bindRetry", "settle", "cancelWrite"]);
    const rawItems = value.items;
    const rawSizes = value.itemBytes;
    if (!Array.isArray(rawItems) || rawItems.length > INTAKE_MAX_HELD) {
        throw invalid("items", `is not a list of at most ${INTAKE_MAX_HELD} items`);
    }
    if (!Array.isArray(rawSizes) || rawSizes.length !== rawItems.length) throw invalid("itemBytes", "is not one size per item");
    const items = rawItems.map((item: unknown, index: number) => itemOf(item, `${path}.items[${index}]`));
    const itemBytes = rawSizes.map((size: unknown, index: number) => integerOf(size, `${path}.itemBytes[${index}]`, 1));
    if (intakeItemsBytes(itemBytes) > INTAKE_MAX_INVOCATION_ITEMS_BYTES) {
        throw invalid("itemBytes", `adds up to more than ${INTAKE_MAX_INVOCATION_ITEMS_BYTES} bytes`);
    }
    const rawParked = value.parked;
    let parked: IntakeParkCause | null = null;
    if (rawParked !== null) {
        const cause = PARK_CAUSES.find(item => item === rawParked);
        if (cause === undefined) throw invalid("parked", "is not a park cause or null");
        parked = cause;
    }
    let settle: IntakeInvocation["settle"] = null;
    if (value.settle !== null) {
        const rawSettle = intakeObject(value.settle, `${path}.settle`, ["outcome", "retry"]);
        const outcome = OUTCOMES.find(item => item === rawSettle.outcome);
        if (outcome === undefined) throw invalid("settle.outcome", "is not an outcome");
        settle = { outcome, retry: rawSettle.retry === null ? null : retryOf(rawSettle.retry, `${path}.settle.retry`) };
    }
    const invocation: IntakeInvocation = {
        invocationId: intakeId(value.invocationId, `${path}.invocationId`), items, itemBytes,
        bound: booleanOf(value.bound, `${path}.bound`), sent: booleanOf(value.sent, `${path}.sent`), parked,
        bindRetry: value.bindRetry === null ? null : retryOf(value.bindRetry, `${path}.bindRetry`), settle,
        cancelWrite: value.cancelWrite === null ? null : latchOf(value.cancelWrite, `${path}.cancelWrite`),
    };
    // Only the states an invocation passes through (design 5.5). Its batch is empty only when every item was cancelled
    // before its send: it then ends not_dispatched, and its end names no exchange.
    if (invocation.items.length === 0
        && !(invocation.bound && !invocation.sent && invocation.settle !== null && invocation.settle.outcome === "not_dispatched")) {
        throw invalid("items", "is empty on an invocation that is not ending with every item cancelled before its send");
    }
    if (!invocation.bound) {
        if (invocation.bindRetry === null) throw invalid("bindRetry", "is missing on an invocation that is not bound");
        if (invocation.sent || invocation.parked !== null || invocation.settle !== null) {
            throw invalid("bound", "is false on an invocation that was sent, parked or ended");
        }
        // Its rows are not admitted yet: a latched cancel waits for the bind.
        if (invocation.cancelWrite !== null) throw invalid("cancelWrite", "is pending on an invocation that is not bound");
    } else if (invocation.bindRetry !== null) {
        throw invalid("bindRetry", "is present on a bound invocation");
    }
    const unsentEnding = invocation.bound && !invocation.sent && invocation.settle !== null;
    invocation.items.forEach((item, index) => {
        const text = item.text;
        if (!invocation.bound) {
            if (text !== null) throw invalid(`items[${index}].text`, "is present before the bind");
        } else {
            if (text === null) throw invalid(`items[${index}].text`, "is missing on a bound invocation");
            if (createHash("sha256").update(text, "utf8").digest("hex") !== item.textSha256) throw invalid(`items[${index}].text`, "does not match its hash");
            if (intakeItemBytes(intakeBoundItem(item, text)) !== invocation.itemBytes[index]) {
                throw invalid(`itemBytes[${index}]`, "is not the size measured at its claim");
            }
        }
        // A latched cancel: before the bind it waits; bound and unsent, the cancel write that removes it is pending; sent, it
        // stays (its cancel_requested recorded or pending). An unsent invocation that ends was never dispatched: none is latched.
        if (item.cancelRequested && unsentEnding) throw invalid(`items[${index}].cancelRequested`, "is latched on an unsent invocation that is ending");
        if (item.cancelRequested && invocation.bound && !invocation.sent && invocation.cancelWrite === null) {
            throw invalid(`items[${index}].cancelRequested`, "is latched on an unsent invocation with no cancel write pending");
        }
    });
    if (invocation.cancelWrite !== null && !invocation.items.some(item => item.cancelRequested)) {
        throw invalid("cancelWrite", "is pending with no latched cancel");
    }
    if (invocation.parked !== null && (invocation.sent || invocation.settle !== null)) throw invalid("parked", "is set on an invocation that was sent or ended");
    if (invocation.settle !== null && (invocation.settle.outcome === "not_dispatched") === invocation.sent) {
        throw invalid("settle.outcome", invocation.sent ? "is not_dispatched for an invocation that was sent" : "is not not_dispatched for an invocation never sent");
    }
    const exchanges = new Set<string>();
    const claims = new Set<string>();
    invocation.items.forEach((item, index) => {
        if (exchanges.has(item.exchangeId)) throw invalid(`items[${index}].exchangeId`, "is in the batch twice");
        if (claims.has(item.claimId)) throw invalid(`items[${index}].claimId`, "is in the batch twice");
        exchanges.add(item.exchangeId);
        claims.add(item.claimId);
    });
    if (bytes({ ...invocation, items: [] }) > INTAKE_MAX_INVOCATION_FIELDS_BYTES) {
        throw new IntakeShapeError(path, `has more than ${INTAKE_MAX_INVOCATION_FIELDS_BYTES} bytes besides its items`);
    }
    return invocation;
}

/**
 * The intake state that `raw` (an input's `intake` field) carries, checked
 * whole: absent is empty; anything else must be a carried state that
 * validates, or the execution fails with the field's path.
 */
export function restoreIntakeState(raw: unknown, path = "$.intake"): IntakeState {
    if (raw === undefined) return emptyIntakeState();
    const value = intakeObject(raw, path, ["v", "queue", "invocation"]);
    if (value.v !== INTAKE_STATE_FORMAT) throw new IntakeShapeError(`${path}.v`, `is not ${INTAKE_STATE_FORMAT}`);
    const rawQueue = value.queue;
    if (!Array.isArray(rawQueue)) throw new IntakeShapeError(`${path}.queue`, "is not a list");
    const queue = rawQueue.map((entry: unknown, index: number) => entryOf(entry, `${path}.queue[${index}]`));
    const invocation = value.invocation === null ? null : invocationOf(value.invocation, `${path}.invocation`);
    const waiting = queue.filter(entry => entry.kind !== "held").length;
    if (waiting > INTAKE_MAX_UNCLAIMED) throw new IntakeShapeError(`${path}.queue`, `has more than ${INTAKE_MAX_UNCLAIMED} unclaimed or settling entries`);
    if (queue.length - waiting > INTAKE_MAX_HELD) throw new IntakeShapeError(`${path}.queue`, `has more than ${INTAKE_MAX_HELD} held entries`);
    // One claim id per claim, and one placement per exchange (I7): a held entry or an invocation item. A settling copy has
    // none and is decided once: its exchange is neither placed nor settling twice. An unclaimed copy of a placed or
    // settling exchange may still wait: its claim will find the exchange's row under the other claim (duplicate).
    const claims = new Set<string>(invocation?.items.map(item => item.claimId) ?? []);
    const placed = new Set<string>(invocation?.items.map(item => item.exchangeId) ?? []);
    queue.forEach((entry, index) => {
        if (claims.has(entry.claimId)) throw new IntakeShapeError(`${path}.queue[${index}].claimId`, "is used twice");
        claims.add(entry.claimId);
        if (entry.kind === "held") {
            if (placed.has(entry.exchangeId)) throw new IntakeShapeError(`${path}.queue[${index}].exchangeId`, "is placed twice");
            placed.add(entry.exchangeId);
        }
    });
    const settling = new Set<string>();
    queue.forEach((entry, index) => {
        if (entry.kind !== "settling") return;
        if (placed.has(entry.exchangeId) || settling.has(entry.exchangeId)) {
            throw new IntakeShapeError(`${path}.queue[${index}].exchangeId`, "is settling while it is placed or settling already");
        }
        settling.add(entry.exchangeId);
    });
    if (queue.length === 0 && invocation === null) throw new IntakeShapeError(path, "is carried but empty");
    return { queue, invocation };
}

/** Nothing waits and no invocation exists. */
export function intakeStateIsEmpty(state: IntakeState): boolean {
    return state.queue.length === 0 && state.invocation === null;
}

/**
 * The carried form of `state` for a continue-as-new input, or undefined when
 * it is empty. The state is checked whole first (a state that would not
 * restore is never written), and the form is a copy that shares nothing
 * with `state`.
 */
export function carryIntakeState(state: IntakeState): CarriedIntakeState | undefined {
    if (intakeStateIsEmpty(state)) return undefined;
    const restored = restoreIntakeState(JSON.parse(JSON.stringify({ v: INTAKE_STATE_FORMAT, queue: state.queue, invocation: state.invocation })));
    const carried: CarriedIntakeState = { v: INTAKE_STATE_FORMAT, queue: restored.queue, invocation: restored.invocation };
    return carried;
}

/** The exact UTF-8 bytes of the carried form (0 when nothing is carried). */
export function carriedIntakeBytes(state: IntakeState): number {
    const carried = carryIntakeState(state);
    return carried === undefined ? 0 : bytes(carried);
}

/**
 * The batch for the next invocation (design 5.5, condition C1): the longest
 * arrival-order run of held entries whose bound items fit one invocation,
 * from the sizes measured at their claims, so it is chosen before its bind
 * and never found too large after it. A held entry whose cancel is latched is
 * passed over: it is never bound. Each held entry fits alone, so a queue with
 * a held entry that is not cancelled always gives at least one.
 */
export function selectIntakeBatch(queue: readonly IntakeQueueEntry[]): IntakeHeldEntry[] {
    const batch: IntakeHeldEntry[] = [];
    const sizes: number[] = [];
    for (const entry of queue) {
        if (entry.kind !== "held" || entry.cancel !== null) continue;
        if (intakeItemsBytes([...sizes, entry.itemBytes]) > INTAKE_MAX_INVOCATION_ITEMS_BYTES) break;
        batch.push(entry);
        sizes.push(entry.itemBytes);
    }
    return batch;
}

/** An orchestration version ("1.0.83") as numbers; null for anything else. */
function versionNumbers(version: string): number[] | null {
    if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
    return version.split(".").map(Number);
}

/**
 * 1.0.83's continue-as-new floor (design section 8): it never targets a
 * version older than its own, nor one it cannot read (it fails closed, unlike
 * the workspace gate). Throws, failing the execution, instead of moving down.
 */
export function assertIntakeContinueAsNewTarget(currentVersion: string, latestVersion: string): void {
    const current = versionNumbers(currentVersion);
    const latest = versionNumbers(latestVersion);
    if (current === null || latest === null) {
        throw new Error(`orchestration ${currentVersion} does not continue as new to ${latestVersion}: not a version it can read`);
    }
    for (let index = 0; index < 3; index += 1) {
        if (latest[index] > current[index]) return;
        if (latest[index] < current[index]) throw new Error(`orchestration ${currentVersion} does not continue as new to the older ${latestVersion}`);
    }
}
