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
 *
 * Pure: no yields, no I/O, no clock. Exercised by
 * test/unit/orchestration-intake-1-0-83.test.mjs.
 */
import { createHash } from "node:crypto";
import type { OrchestrationInput } from "../types.js";
import { isStorableText } from "../workflow/v2/json.js";
import {
    INTAKE_MAX_INVOCATION_ITEMS_BYTES,
    IntakeShapeError,
    intakeBoundItem,
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

/** At most this many messages wait for a claim the store could not take (design 5.4, 5.7). */
export const INTAKE_MAX_UNCLAIMED = 8;
export const INTAKE_MAX_UNCLAIMED_ENTRY_BYTES = 2 * 1024;
/** At most this many claimed items wait for an invocation (design 5.4, 5.7). */
export const INTAKE_MAX_HELD = 64;
export const INTAKE_MAX_HELD_ENTRY_BYTES = 512;
/** The invocation's fields other than its items (design 5.7). */
export const INTAKE_MAX_INVOCATION_FIELDS_BYTES = 1024;
/** The longest client message id an item keeps. */
export const INTAKE_MAX_CLIENT_MESSAGE_ID_LENGTH = 512;
/** The carried form's version. */
export const INTAKE_STATE_FORMAT = 1;

/** How an invocation's processing ended (design 5.5); `not_dispatched` only when no attempt sent it. */
export type IntakeOutcome = "completed" | "not_dispatched" | "interrupted" | "failed_indeterminate";
/** Why an unsent invocation is parked; it resumes only on that cause's stimuli (design 5.5). */
export type IntakeParkCause = "gate" | "credential" | "non_retryable" | "exhausted" | "not_sent" | "hydration";

const OUTCOMES: readonly IntakeOutcome[] = ["completed", "not_dispatched", "interrupted", "failed_indeterminate"];
const PARK_CAUSES: readonly IntakeParkCause[] = ["gate", "credential", "non_retryable", "exhausted", "not_sent", "hydration"];

/** A store write that failed and waits for its due time on the intake wake (design 5.4, N2). */
export interface IntakeRetry {
    attempts: number;
    /** Due time in ms of the orchestration clock (ctx.utcNow). */
    nextAttemptAtMs: number;
}

/** A message whose claim the store could not take; only its envelope is kept, never the queued prompt. */
export interface IntakeUnclaimedEntry {
    kind: "unclaimed";
    claimId: string;
    envelope: IntakeEnvelope;
    retry: IntakeRetry;
}

/**
 * A claimed item waiting for an invocation: a reference, not its text (the
 * claim stored the text in the item's row). `itemBytes` is the exact size of
 * its bound form, measured when it was claimed, so a batch is chosen before
 * its bind and never found too large after it (condition C1).
 */
export interface IntakeHeldEntry {
    kind: "held";
    exchangeId: string;
    claimId: string;
    textSha256: string;
    clientMessageId: string;
    itemBytes: number;
}

export type IntakeQueueEntry = IntakeUnclaimedEntry | IntakeHeldEntry;

/** An invocation's item: its reference, its text once bound (null before), and whether a tombstone named it after a send. */
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
    /** In arrival order; never grows, and does not change after its first send. */
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
    if (typeof raw !== "string" || raw.length === 0 || raw.length > INTAKE_MAX_CLIENT_MESSAGE_ID_LENGTH || !isStorableText(raw)) {
        throw new IntakeShapeError(path, `is not a client message id of 1 to ${INTAKE_MAX_CLIENT_MESSAGE_ID_LENGTH} characters`);
    }
    return raw;
}

function retryOf(raw: unknown, path: string): IntakeRetry {
    const value = intakeObject(raw, path, ["attempts", "nextAttemptAtMs"]);
    return { attempts: integerOf(value.attempts, `${path}.attempts`, 1), nextAttemptAtMs: integerOf(value.nextAttemptAtMs, `${path}.nextAttemptAtMs`, 0) };
}

function entryOf(raw: unknown, path: string): IntakeQueueEntry {
    const kind = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).kind : undefined;
    if (kind === "unclaimed") {
        const value = intakeObject(raw, path, ["kind", "claimId", "envelope", "retry"]);
        const entry: IntakeUnclaimedEntry = {
            kind: "unclaimed", claimId: intakeId(value.claimId, `${path}.claimId`), envelope: parseIntakeEnvelope(value.envelope, `${path}.envelope`),
            retry: retryOf(value.retry, `${path}.retry`),
        };
        if (bytes(entry) > INTAKE_MAX_UNCLAIMED_ENTRY_BYTES) throw new IntakeShapeError(path, `is over ${INTAKE_MAX_UNCLAIMED_ENTRY_BYTES} bytes`);
        return entry;
    }
    if (kind === "held") {
        const value = intakeObject(raw, path, ["kind", "exchangeId", "claimId", "textSha256", "clientMessageId", "itemBytes"]);
        const entry: IntakeHeldEntry = {
            kind: "held", exchangeId: intakeExchangeId(value.exchangeId, `${path}.exchangeId`), claimId: intakeId(value.claimId, `${path}.claimId`),
            textSha256: intakeSha256(value.textSha256, `${path}.textSha256`),
            clientMessageId: clientMessageIdOf(value.clientMessageId, `${path}.clientMessageId`),
            itemBytes: integerOf(value.itemBytes, `${path}.itemBytes`, 1),
        };
        if (!intakeItemFitsAlone(entry.itemBytes)) throw new IntakeShapeError(`${path}.itemBytes`, "is over what one invocation holds");
        if (bytes(entry) > INTAKE_MAX_HELD_ENTRY_BYTES) throw new IntakeShapeError(path, `is over ${INTAKE_MAX_HELD_ENTRY_BYTES} bytes`);
        return entry;
    }
    throw new IntakeShapeError(`${path}.kind`, "is not unclaimed or held");
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
    const value = intakeObject(raw, path, ["invocationId", "items", "itemBytes", "bound", "sent", "parked", "bindRetry", "settle"]);
    const rawItems = value.items;
    const rawSizes = value.itemBytes;
    if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > INTAKE_MAX_HELD) {
        throw invalid("items", `is not a list of 1 to ${INTAKE_MAX_HELD} items`);
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
    };
    // Only the states an invocation passes through (design 5.5).
    if (!invocation.bound) {
        if (invocation.bindRetry === null) throw invalid("bindRetry", "is missing on an invocation that is not bound");
        if (invocation.sent || invocation.parked !== null || invocation.settle !== null) {
            throw invalid("bound", "is false on an invocation that was sent, parked or ended");
        }
    } else if (invocation.bindRetry !== null) {
        throw invalid("bindRetry", "is present on a bound invocation");
    }
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
        if (item.cancelRequested && !invocation.sent) throw invalid(`items[${index}].cancelRequested`, "is set on an invocation that was not sent");
    });
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
    const unclaimed = queue.filter(entry => entry.kind === "unclaimed").length;
    if (unclaimed > INTAKE_MAX_UNCLAIMED) throw new IntakeShapeError(`${path}.queue`, `has more than ${INTAKE_MAX_UNCLAIMED} unclaimed entries`);
    if (queue.length - unclaimed > INTAKE_MAX_HELD) throw new IntakeShapeError(`${path}.queue`, `has more than ${INTAKE_MAX_HELD} held entries`);
    // One claim id per claim, and one placement per exchange (I7): a held entry or an invocation item. An unclaimed copy of
    // a placed exchange may still wait: its claim will find the exchange held (duplicate).
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
 * and never found too large after it. Each held entry fits alone, so a queue
 * with a held entry always gives at least one.
 */
export function selectIntakeBatch(queue: readonly IntakeQueueEntry[]): IntakeHeldEntry[] {
    const batch: IntakeHeldEntry[] = [];
    const sizes: number[] = [];
    for (const entry of queue) {
        if (entry.kind !== "held") continue;
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
