/**
 * Durable recipient intake (design docs/proposals/workflow-durable-intake.md,
 * revision 3 with amendment 2): the wire-level pieces that the sender, the
 * store's claim and the recipient orchestration (1.0.83) share. The intake
 * is inactive (decision intake-inactive-implementation): no worker sends an
 * envelope, no registered orchestration reads one, and only tests call the
 * store's intake methods.
 *
 * Every size here is in UTF-8 bytes of the exact JSON text that is kept
 * (JSON.stringify of the plain value, escaping included), measured the same
 * way by the claim, which refuses an item that would not fit, and by the
 * orchestration, which selects a batch from those sizes before it binds it.
 */
import { canonicalJson, isJsonObject, isStorableText, sha256Hex, utf8ByteLength } from "./json.js";

/** The largest canonical text of one intake item, as the claim stores it (the session FIFO's item bound, MAX_FIFO_ITEM_BYTES). */
export const INTAKE_MAX_TEXT_BYTES = 60 * 1024;
/** The largest JSON of an invocation's items (design 5.7): one item of the largest size always fits alone. */
export const INTAKE_MAX_INVOCATION_ITEMS_BYTES = 61 * 1024;
/** The largest JSON of a queued envelope (design 5.7). */
export const INTAKE_MAX_ENVELOPE_BYTES = 1024;
/** The longest id (claim, invocation, session, run) that intake keeps. */
export const INTAKE_MAX_ID_LENGTH = 128;
/** At most this many claimed items wait for an invocation, so an invocation binds at most this many (design 5.4, 5.7). */
export const INTAKE_MAX_HELD = 64;
/** The longest client message id an item keeps. */
export const INTAKE_MAX_CLIENT_MESSAGE_ID_LENGTH = 512;

/** How an admitted item's processing ended (design 5.5); `not_dispatched` only when no attempt sent it. */
export const INTAKE_PROCESSING_OUTCOMES = ["completed", "not_dispatched", "interrupted", "failed_indeterminate"] as const;
export type IntakeProcessingOutcome = typeof INTAKE_PROCESSING_OUTCOMES[number];

/** The event a refusal projects on the sending workflow's session when that session is live (design 5.6). */
export const INTAKE_REFUSED_WORKFLOW_EVENT = "workflow.message_refused";
/** The event a refusal records on the recipient's session: an event only, its session row untouched (design 5.6). */
export const INTAKE_REFUSED_RECIPIENT_EVENT = "session.workflow_message_refused";

/** The intake's two activities (design section 8): the claim and the settles, scheduled by orchestration 1.0.83 only. */
export const WORKFLOW_INTAKE_ACTIVITIES = { claim: "claimWorkflowIntake", settle: "settleWorkflowIntake" } as const;

/**
 * The mark an intake activity puts at the start of a thrown failure that no
 * retry can fix: a programming error, or a PostgreSQL error of a class that
 * does not change between attempts. A thrown activity failure reaches the
 * orchestration's history as its message only, so the mark is in the
 * message; the orchestration fails visibly on it, and makes any other thrown
 * failure (an outage, a lost answer) again when it is due (design 5.2, 5.4;
 * review of b92ff04b, P2-2).
 */
export const WORKFLOW_INTAKE_NON_RETRYABLE = "WORKFLOW_INTAKE_NON_RETRYABLE";

const EXCHANGE_ID = /^nx-[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** A carried or queued intake value that does not have its declared shape; `path` names the field. */
export class IntakeShapeError extends Error {
    readonly code = "WORKFLOW_INTAKE_INVALID";
    constructor(readonly path: string, message: string) {
        super(`${path}: ${message}`);
        this.name = "IntakeShapeError";
    }
}

/** The envelope a durable-mode copy carries (design section 3): the exchange it names and the hash over those fields. */
export interface IntakeEnvelope {
    v: 1;
    exchangeId: string;
    workflowSessionId: string;
    runId: string;
    recipientSessionId: string;
    contract: string;
    payloadSha256: string;
    envelopeSha256: string;
}

const ENVELOPE_KEYS = ["v", "exchangeId", "workflowSessionId", "runId", "recipientSessionId", "contract", "payloadSha256", "envelopeSha256"];

/** A plain object with exactly `keys`, or an IntakeShapeError at `path`. */
export function intakeObject(raw: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
    if (!isJsonObject(raw)) throw new IntakeShapeError(path, "is not a plain object");
    const present = Object.keys(raw);
    const extra = present.filter(key => !keys.includes(key));
    if (extra.length > 0) throw new IntakeShapeError(path, `has unknown field ${extra[0]}`);
    const missing = keys.filter(key => !Object.hasOwn(raw, key));
    if (missing.length > 0) throw new IntakeShapeError(`${path}.${missing[0]}`, "is missing");
    return raw;
}

/** A non-empty id of at most INTAKE_MAX_ID_LENGTH characters of storable text. */
export function intakeId(raw: unknown, path: string): string {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > INTAKE_MAX_ID_LENGTH || !isStorableText(raw)) {
        throw new IntakeShapeError(path, `is not an id of 1 to ${INTAKE_MAX_ID_LENGTH} characters`);
    }
    return raw;
}

/** An exchange id: a node execution id (nx- and 40 lowercase hex digits). */
export function intakeExchangeId(raw: unknown, path: string): string {
    if (typeof raw !== "string" || !EXCHANGE_ID.test(raw)) throw new IntakeShapeError(path, "is not an exchange id");
    return raw;
}

/** A client message id: 1 to INTAKE_MAX_CLIENT_MESSAGE_ID_LENGTH characters of storable text. */
export function intakeClientMessageId(raw: unknown, path: string): string {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > INTAKE_MAX_CLIENT_MESSAGE_ID_LENGTH || !isStorableText(raw)) {
        throw new IntakeShapeError(path, `is not a client message id of 1 to ${INTAKE_MAX_CLIENT_MESSAGE_ID_LENGTH} characters`);
    }
    return raw;
}

/** A sha256 digest: 64 lowercase hex digits. */
export function intakeSha256(raw: unknown, path: string): string {
    if (typeof raw !== "string" || !SHA256.test(raw)) throw new IntakeShapeError(path, "is not a sha256 digest");
    return raw;
}

/** An envelope with its declared shape, within INTAKE_MAX_ENVELOPE_BYTES; its hash is the claim's to verify. */
export function parseIntakeEnvelope(raw: unknown, path: string): IntakeEnvelope {
    const value = intakeObject(raw, path, ENVELOPE_KEYS);
    if (value.v !== 1) throw new IntakeShapeError(`${path}.v`, "is not 1");
    const envelope: IntakeEnvelope = {
        v: 1,
        exchangeId: intakeExchangeId(value.exchangeId, `${path}.exchangeId`),
        workflowSessionId: intakeId(value.workflowSessionId, `${path}.workflowSessionId`),
        runId: intakeId(value.runId, `${path}.runId`),
        recipientSessionId: intakeId(value.recipientSessionId, `${path}.recipientSessionId`),
        contract: intakeId(value.contract, `${path}.contract`),
        payloadSha256: intakeSha256(value.payloadSha256, `${path}.payloadSha256`),
        envelopeSha256: intakeSha256(value.envelopeSha256, `${path}.envelopeSha256`),
    };
    if (utf8ByteLength(JSON.stringify(envelope)) > INTAKE_MAX_ENVELOPE_BYTES) {
        throw new IntakeShapeError(path, `is over ${INTAKE_MAX_ENVELOPE_BYTES} bytes`);
    }
    return envelope;
}

/**
 * The hash an envelope carries (design section 3): sha256 of the canonical
 * JSON of every other field (the exchange, its workflow, run, recipient,
 * contract and payload hash, and the version). The sender computes it from
 * the outbox row; the claim recomputes it and admits nothing whose hash is
 * not this one.
 */
export function intakeEnvelopeSha256(fields: Omit<IntakeEnvelope, "envelopeSha256">): string {
    return sha256Hex(canonicalJson({
        v: fields.v, exchangeId: fields.exchangeId, workflowSessionId: fields.workflowSessionId, runId: fields.runId,
        recipientSessionId: fields.recipientSessionId, contract: fields.contract, payloadSha256: fields.payloadSha256,
    }));
}

/**
 * The canonical client message id of an exchange's every copy (design
 * section 3): the sender's own (runtime.ts workflowSendClientMessageId, which
 * the claim's render gives), known from the envelope alone, so a tombstone
 * that names it is latched even while the copy's claim waits.
 */
export function intakeEnvelopeClientMessageId(envelope: Pick<IntakeEnvelope, "workflowSessionId" | "runId" | "exchangeId">): string {
    return `workflow:${envelope.workflowSessionId}:${envelope.runId}:send:${envelope.exchangeId}`;
}

/** What identifies an admitted item, without its text. */
export interface IntakeItemRef {
    exchangeId: string;
    claimId: string;
    textSha256: string;
    clientMessageId: string;
}

/** An admitted item as a bound invocation carries it (design 5.5): this shape, in this key order. */
export interface IntakeBoundItem extends IntakeItemRef {
    text: string;
    /** A tombstone named the item after its invocation was sent; the end settlement records it. */
    cancelRequested: boolean;
}

/** The bound form of an item, its keys in the carried order, with no cancel requested yet. */
export function intakeBoundItem(ref: IntakeItemRef, text: string): IntakeBoundItem {
    return {
        exchangeId: ref.exchangeId, claimId: ref.claimId, textSha256: ref.textSha256, clientMessageId: ref.clientMessageId,
        text, cancelRequested: false,
    };
}

/** The exact UTF-8 bytes of the JSON of one bound item, as the invocation carries it. */
export function intakeItemBytes(item: IntakeBoundItem): number {
    return utf8ByteLength(JSON.stringify(intakeBoundItemOrdered(item)));
}

/** The same item with its keys in the carried order, whatever order it was built in. */
export function intakeBoundItemOrdered(item: IntakeBoundItem): IntakeBoundItem {
    return {
        exchangeId: item.exchangeId, claimId: item.claimId, textSha256: item.textSha256, clientMessageId: item.clientMessageId,
        text: item.text, cancelRequested: item.cancelRequested,
    };
}

/**
 * The exact UTF-8 bytes of the JSON array of items whose own sizes are
 * `sizes`: JSON.stringify of an array is "[", the items joined by ",", "]".
 */
export function intakeItemsBytes(sizes: readonly number[]): number {
    let total = 2;
    for (const size of sizes) total += size;
    return total + Math.max(0, sizes.length - 1);
}

/**
 * Whether an item of `itemBytes` fits an invocation alone. The claim refuses
 * an item that does not, or whose text is over INTAKE_MAX_TEXT_BYTES
 * (refused_size, design 5.7), so every item that is held fits alone, and an
 * invocation is never found too large after its bind.
 */
export function intakeItemFitsAlone(itemBytes: number): boolean {
    return Number.isSafeInteger(itemBytes) && itemBytes > 0 && intakeItemsBytes([itemBytes]) <= INTAKE_MAX_INVOCATION_ITEMS_BYTES;
}

/** Whether a canonical text is within INTAKE_MAX_TEXT_BYTES and storable (no NUL, no lone surrogate). */
export function intakeTextWithinCap(text: string): boolean {
    return isStorableText(text) && utf8ByteLength(text) <= INTAKE_MAX_TEXT_BYTES;
}

/**
 * What a turn attempt of orchestration 1.0.83 carries in its own `intake`
 * field (design 5.5): the bound invocation and its items' canonical texts in
 * batch order. It is never part of the prompt; the worker puts the texts
 * before whatever prompt the attempt finally sends (composeIntakePrompt).
 */
export interface IntakeTurnField {
    invocationId: string;
    items: Array<{ exchangeId: string; clientMessageId: string; text: string }>;
}

/** A turn's `intake` field, checked whole: null when absent; anything else that does not have its shape fails with its path. */
export function parseIntakeTurnField(raw: unknown, path = "intake"): IntakeTurnField | null {
    if (raw === undefined) return null;
    const value = intakeObject(raw, path, ["invocationId", "items"]);
    const invocationId = intakeId(value.invocationId, `${path}.invocationId`);
    const items = value.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > INTAKE_MAX_HELD) {
        throw new IntakeShapeError(`${path}.items`, `is not a list of 1 to ${INTAKE_MAX_HELD} items`);
    }
    return {
        invocationId,
        items: items.map((entry: unknown, index: number) => {
            const itemPath = `${path}.items[${index}]`;
            const item = intakeObject(entry, itemPath, ["exchangeId", "clientMessageId", "text"]);
            const text = item.text;
            if (typeof text !== "string" || !intakeTextWithinCap(text)) throw new IntakeShapeError(`${itemPath}.text`, "is not a text within its cap");
            return {
                exchangeId: intakeExchangeId(item.exchangeId, `${itemPath}.exchangeId`),
                clientMessageId: intakeClientMessageId(item.clientMessageId, `${itemPath}.clientMessageId`),
                text,
            };
        }),
    };
}

/** The prompt the model gets on an attempt that carries an invocation: its items' texts in batch order, then the attempt's own prompt, separated by blank lines. */
export function composeIntakePrompt(prompt: string, field: IntakeTurnField): string {
    return [...field.items.map(item => item.text), prompt].join("\n\n");
}

/**
 * The witness an attempt of invocation `invocationId` returns with a saved
 * result it adopted after its own request had included the items (design
 * 5.5; review W2-WIT4). The attempt lost a racing commit: the winner's result
 * stands, since the winner's run is the one that holds the turn. When the
 * saved witness is exactly the winner's own well-formed one of the same
 * invocation and says not sent, the attempt returns it with `exposed`: the
 * items were possibly seen, by this attempt's request, though not by the run
 * whose result this is. Null for any other saved witness, which is returned
 * as it was saved: none (already possibly sent), one that says sent or
 * exposed, another invocation's or a malformed one (the orchestration fails
 * on those).
 */
export function intakeExposedWitness(saved: unknown, invocationId: string): { invocationId: string; sent: false; exposed: true } | null {
    if (!isJsonObject(saved)) return null;
    const keys = Object.keys(saved);
    if (keys.length !== 2 || !Object.hasOwn(saved, "invocationId") || !Object.hasOwn(saved, "sent")) return null;
    if (saved.invocationId !== invocationId || saved.sent !== false) return null;
    return { invocationId, sent: false, exposed: true };
}
