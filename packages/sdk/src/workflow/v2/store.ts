import type { Pool, PoolClient } from "pg";
import {
    MESSAGE_SENT, parseDiagnostics, parseWorkflowIr, RECEIVE_RECEIVED, REQUEST_DECLINED, REQUEST_RESPONDED, WAIT_ELAPSED, WAIT_MAX_SECONDS,
    WORKFLOW_V2_API_VERSION, WORKFLOW_V2_REQUEST_IR_VERSION, type WorkflowCompileResult, type WorkflowDiagnostic, type WorkflowIR,
} from "./compiler.js";
import {
    assertJsonValue, canonicalJson, isJsonObject, isStorableText, jsonbSafeText, jsonbSafeValue, jsonSha256, kindValueSha256, parseStoredJson, sha256Hex,
    utf8ByteLength, WorkflowJsonError, type JsonValue,
} from "./json.js";
import { decideRequestAuthority, decideTypedInputAuthority, TYPED_INPUT_REFUSALS, type AuthoritySession, type TypedInputAuthority } from "./authority.js";
import { schemaSetFor, WorkflowSchemaSet, type SchemaProblem } from "./schema.js";
import {
    INTAKE_MAX_HELD, INTAKE_PROCESSING_OUTCOMES, INTAKE_REFUSED_RECIPIENT_EVENT, INTAKE_REFUSED_WORKFLOW_EVENT, intakeBoundItem, intakeClientMessageId,
    intakeEnvelopeSha256, intakeExchangeId, intakeId, intakeItemBytes, intakeItemFitsAlone, intakeObject, intakeTextWithinCap, IntakeShapeError,
    parseIntakeEnvelope, type IntakeEnvelope, type IntakeProcessingOutcome,
} from "./intake.js";

/**
 * PostgreSQL persistence for workflow v2 (tables from migrations 0085 and 0087 to 0094).
 *
 * Every definition mutation runs in one transaction that first locks the
 * definition row (or creates it with INSERT ... ON CONFLICT, which waits for
 * a concurrent creator and then reports the conflict). Every run mutation
 * locks the run row first. Command idempotency is a stored receipt per
 * (workflow, operation id) with the request hash: the same request returns
 * the original receipt, a different request with the same id conflicts.
 */

export type WorkflowActor =
    | { kind: "agent"; sessionId: string }
    | { kind: "user"; provider: string; subject: string }
    | { kind: "system"; name: string };

export type WorkflowDefinitionState = "draft" | "published" | "deleted";
export type WorkflowRunStatus = "admitted" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type WorkflowRunMode = "live" | "test";
/** A run that has not ended: it can still be cancelled, deleted, recovered and finish its admitted work. */
export const ACTIVE_RUN_STATUSES: readonly WorkflowRunStatus[] = ["admitted", "running", "paused"];
/** A run that may admit a new node execution (a paused run admits none). */
export const ADMITTING_RUN_STATUSES: readonly WorkflowRunStatus[] = ["admitted", "running"];

/** A run whose controller has not begun it: admitted, or paused before it began. */
export function runNotBegun(run: { status: WorkflowRunStatus; pausedFrom: "admitted" | "running" | null }): boolean {
    return run.status === "admitted" || (run.status === "paused" && run.pausedFrom === "admitted");
}

/** Open KV limits (design D07: proposed defaults, enforced on every update). */
export const WORKFLOW_V2_KV_LIMITS = { maxKeys: 1_000, maxKeyLength: 128, maxValueBytes: 256 * 1024, maxTotalBytes: 1024 * 1024 } as const;

export class WorkflowStoreError extends Error {
    constructor(readonly code: string, message: string, readonly details: JsonValue = null) {
        super(message);
        this.name = "WorkflowStoreError";
    }
}

export interface WorkflowRunReceipt {
    runId: string;
    mode: WorkflowRunMode;
    controllerInstanceId: string;
    revision: number;
    irSha256: string;
}

export interface WorkflowDefinitionReceipt {
    workflowSessionId: string;
    operation: string;
    state: WorkflowDefinitionState;
    revision: number;
    yamlSha256: string;
    valid: boolean;
    irSha256: string | null;
    diagnostics: WorkflowDiagnostic[];
    publishedRevision: number | null;
    run: WorkflowRunReceipt | null;
}

export interface StoredOperation<T> {
    receipt: T;
    replayed: boolean;
}

/** The receipt of an operation that is stored inside another transaction (recover). */
export interface OperationReceiptInput {
    operationId: string;
    kind: string;
    requestSha256: string;
    value: JsonValue;
}

export interface WorkflowDefinitionRow {
    workflowSessionId: string;
    parentSessionId: string | null;
    apiVersion: string;
    semver: string | null;
    state: WorkflowDefinitionState;
    currentRevision: number;
    publishedRevision: number | null;
    publishedYamlSha256: string | null;
    publishedIrSha256: string | null;
    notifyParent: boolean;
    createdAt: Date;
    updatedAt: Date;
    publishedAt: Date | null;
}

export interface WorkflowRevisionRow {
    workflowSessionId: string;
    revision: number;
    yaml: string;
    yamlSha256: string;
    valid: boolean;
    diagnostics: WorkflowDiagnostic[];
    name: string | null;
    semver: string | null;
    irSha256: string | null;
    actor: JsonValue;
    createdAt: Date;
}

export interface WorkflowRunRow {
    runId: string;
    workflowSessionId: string;
    mode: WorkflowRunMode;
    revision: number;
    yamlSha256: string;
    irSha256: string;
    inputs: JsonValue;
    controllerInstanceId: string;
    status: WorkflowRunStatus;
    testAgentMode: "mocked" | "real" | null;
    terminalNodeId: string | null;
    terminalOutcome: string | null;
    terminalOutput: JsonValue;
    terminalError: JsonValue;
    createdAt: Date;
    updatedAt: Date;
    finishedAt: Date | null;
    /** The current open KV map and its revision (each revision is also kept immutably). */
    kv: JsonValue;
    kvRevision: number;
    /** While paused: the status a resume returns to. */
    pausedFrom: "admitted" | "running" | null;
}

export type NodeResultKind = "business" | "runtime_error";

export interface WorkflowNodeExecutionRow {
    nodeExecutionId: string;
    runId: string;
    scopeId: string;
    nodeId: string;
    ordinal: number;
    nodeType: string;
    predecessorId: string | null;
    arrivalRoute: string | null;
    input: JsonValue;
    inputSha256: string;
    state: "pending" | "completed";
    outcome: string | null;
    resultKind: NodeResultKind | null;
    output: JsonValue;
    error: JsonValue;
    hasOutput: boolean;
    winner: string | null;
    effectAttempts: number;
    /** The KV revision pinned when this node execution was admitted (null before migration 0087). */
    kvRevision: number | null;
    /** A wait state's absolute deadline, fixed at its admission (migration 0088); null for other states. */
    deadlineAt: Date | null;
    /** What a receive state accepts, resolved when it was admitted (migration 0089); null for other states. */
    receive: { contract: string; from: string | null; correlation: JsonValue } | null;
    enteredAt: Date;
    completedAt: Date | null;
}

/**
 * One typed input a sender gave a run (migrations 0089, 0090), as it is now.
 * Times are the stored values, exactly (ISO 8601 UTC with microseconds).
 */
export interface WorkflowInboxMessage {
    messageId: string;
    /** The durable order in which receive states claim messages. */
    seq: number;
    workflowSessionId: string;
    runId: string;
    senderSessionId: string;
    operationId: string;
    contract: string;
    correlation: JsonValue;
    payload: JsonValue;
    acceptedAt: string;
    expiresAt: string;
    /** The receive state's node execution that took it; null while unclaimed. */
    consumedBy: string | null;
    consumedAt: string | null;
}

/**
 * The receipt of an accepted input (send_workflow_input), stored with the
 * input when it is accepted and returned unchanged to every repeat of the
 * request. It names the request it accepted (requestSha256, payloadSha256)
 * and records what happened in the acceptance's transaction: claimedBy is
 * the receive state that took the input then, or null. What happens to the
 * input later is the inbox read view's, not the receipt's.
 */
export interface WorkflowInputReceipt {
    workflowSessionId: string;
    runId: string;
    messageId: string;
    senderSessionId: string;
    operationId: string;
    contract: string;
    requestSha256: string;
    payloadSha256: string;
    /** The store's clock reading that decided the acceptance (ISO 8601 UTC, microseconds). */
    acceptedAt: string;
    expiresAt: string;
    claimedBy: { nodeExecutionId: string; stateId: string } | null;
}

/** Bounds on a run's inbox, checked when an input is accepted. */
export interface WorkflowInboxLimits {
    /** Unclaimed, unexpired messages a run may hold. */
    maxUnconsumed: number;
    /** Of those, from one sender. */
    maxUnconsumedPerSender: number;
    /** Inputs one sender may give one workflow in the rate window. */
    maxPerSenderPerWindow: number;
    windowSeconds: number;
}

/** How long an unclaimed input stays eligible for a receive state: the default and the most (seconds). A send state's message takes the default. */
export const WORKFLOW_V2_INPUT_TTL_SECONDS = 86_400;

/**
 * The hash of a typed-input request (send_workflow_input, and a send state's
 * message given as typed input): the run it is given to, its contract, its
 * canonical correlation and payload, and its ttl. A workflow accepts one
 * request per (sender, operation id); another request under the same id is
 * OPERATION_CONFLICT.
 */
export function typedInputRequestSha256(request: { runId: string; contract: string; correlationText: string; payloadText: string; ttlSeconds: number }): string {
    return jsonSha256({ kind: "input", runId: request.runId, contract: request.contract, correlation: request.correlationText,
        payload: request.payloadText, ttlSeconds: request.ttlSeconds });
}

export interface SessionEventRecord {
    eventType: string;
    data: { [key: string]: JsonValue };
}

/**
 * Session-row effects of a store transition: transcript events and the
 * session row's state, written in the same transaction as the transition
 * and only when this call made it, so each is recorded exactly once.
 */
export interface SessionProjection {
    sessionId: string;
    events?: SessionEventRecord[];
    update?: { state?: string; lastError?: string | null; orchestrationId?: string; title?: string; titleLocked?: boolean; touch?: boolean };
}

export interface NodeResultInput {
    outcome: string;
    resultKind: NodeResultKind;
    /** Canonical JSON text of the business output or the runtime error envelope. */
    valueText: string;
    winner: string;
}

type Row = Record<string, unknown>;

function str(row: Row, column: string): string {
    const value = row[column];
    if (typeof value !== "string") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Column ${column} is not text.`);
    return value;
}
function strOrNull(row: Row, column: string): string | null {
    const value = row[column];
    if (value === null || value === undefined) return null;
    return str(row, column);
}
/** A session row with its owner (session_owners, users), as the catalog reads it: an owner needs both provider and subject. */
function authoritySessionFrom(row: Row): AuthoritySession {
    const provider = strOrNull(row, "owner_provider");
    const subject = strOrNull(row, "owner_subject");
    return {
        deleted: row.deleted_at !== null, isSystem: row.is_system === true, sessionKind: strOrNull(row, "session_kind"),
        parentSessionId: strOrNull(row, "parent_session_id"), owner: provider && subject ? { provider, subject } : null,
    };
}
function int(row: Row, column: string): number {
    const value = row[column];
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Column ${column} is not an integer.`);
    return parsed;
}
function intOrNull(row: Row, column: string): number | null {
    return row[column] === null || row[column] === undefined ? null : int(row, column);
}
function bool(row: Row, column: string): boolean {
    const value = row[column];
    if (typeof value !== "boolean") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Column ${column} is not boolean.`);
    return value;
}
function date(row: Row, column: string): Date {
    const value = row[column];
    if (!(value instanceof Date)) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Column ${column} is not a timestamp.`);
    return value;
}
function dateOrNull(row: Row, column: string): Date | null {
    return row[column] === null || row[column] === undefined ? null : date(row, column);
}
function jsonOrNull(row: Row, column: string): JsonValue {
    const text = strOrNull(row, column);
    return text === null ? null : parseStoredJson(text, column);
}

function definitionFrom(row: Row): WorkflowDefinitionRow {
    const state = str(row, "state");
    if (state !== "draft" && state !== "published" && state !== "deleted") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Unknown definition state ${state}.`);
    return {
        workflowSessionId: str(row, "workflow_session_id"), parentSessionId: strOrNull(row, "parent_session_id"),
        apiVersion: str(row, "api_version"), semver: strOrNull(row, "semver"), state,
        currentRevision: int(row, "current_revision"), publishedRevision: intOrNull(row, "published_revision"),
        publishedYamlSha256: strOrNull(row, "published_yaml_sha256"), publishedIrSha256: strOrNull(row, "published_ir_sha256"),
        notifyParent: bool(row, "notify_parent"), createdAt: date(row, "created_at"), updatedAt: date(row, "updated_at"),
        publishedAt: dateOrNull(row, "published_at"),
    };
}

function revisionFrom(row: Row): WorkflowRevisionRow {
    return {
        workflowSessionId: str(row, "workflow_session_id"), revision: int(row, "revision"), yaml: str(row, "yaml"),
        yamlSha256: str(row, "yaml_sha256"), valid: bool(row, "valid"),
        diagnostics: parseDiagnostics(parseStoredJson(str(row, "diagnostics"), "diagnostics")),
        name: strOrNull(row, "name"), semver: strOrNull(row, "semver"), irSha256: strOrNull(row, "ir_sha256"),
        actor: parseStoredJson(str(row, "actor"), "actor"), createdAt: date(row, "created_at"),
    };
}

const RUN_STATUSES: readonly WorkflowRunStatus[] = ["admitted", "running", "paused", "completed", "failed", "cancelled"];
function isRunStatus(value: string): value is WorkflowRunStatus {
    return (RUN_STATUSES as readonly string[]).includes(value);
}

function runFrom(row: Row): WorkflowRunRow {
    const mode = str(row, "mode");
    const status = str(row, "status");
    const testAgentMode = strOrNull(row, "test_agent_mode");
    if (mode !== "live" && mode !== "test") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Unknown run mode ${mode}.`);
    if (!isRunStatus(status)) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Unknown run status ${status}.`);
    if (testAgentMode !== null && testAgentMode !== "mocked" && testAgentMode !== "real") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Unknown test agent mode ${testAgentMode}.`);
    return {
        runId: str(row, "run_id"), workflowSessionId: str(row, "workflow_session_id"), mode,
        revision: int(row, "revision"), yamlSha256: str(row, "yaml_sha256"), irSha256: str(row, "ir_sha256"),
        inputs: parseStoredJson(str(row, "inputs"), "inputs"), controllerInstanceId: str(row, "controller_instance_id"),
        status, testAgentMode,
        terminalNodeId: strOrNull(row, "terminal_node_id"), terminalOutcome: strOrNull(row, "terminal_outcome"),
        terminalOutput: jsonOrNull(row, "terminal_output"), terminalError: jsonOrNull(row, "terminal_error"),
        createdAt: date(row, "created_at"), updatedAt: date(row, "updated_at"), finishedAt: dateOrNull(row, "finished_at"),
        kv: parseStoredJson(str(row, "kv"), "kv"), kvRevision: int(row, "kv_revision"), pausedFrom: pausedFromOf(row),
    };
}

function pausedFromOf(row: Row): "admitted" | "running" | null {
    const value = strOrNull(row, "paused_from");
    if (value !== null && value !== "admitted" && value !== "running") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Unknown paused_from ${value}.`);
    return value;
}

function nodeFrom(row: Row): WorkflowNodeExecutionRow {
    const state = str(row, "state");
    const resultKind = strOrNull(row, "result_kind");
    if (state !== "pending" && state !== "completed") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Unknown node state ${state}.`);
    if (resultKind !== null && resultKind !== "business" && resultKind !== "runtime_error") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Unknown result kind ${resultKind}.`);
    return {
        nodeExecutionId: str(row, "node_execution_id"), runId: str(row, "run_id"), scopeId: str(row, "scope_id"),
        nodeId: str(row, "node_id"), ordinal: int(row, "ordinal"), nodeType: str(row, "node_type"),
        predecessorId: strOrNull(row, "predecessor_id"), arrivalRoute: strOrNull(row, "arrival_route"),
        input: parseStoredJson(str(row, "input"), "input"), inputSha256: str(row, "input_sha256"), state,
        outcome: strOrNull(row, "outcome"), resultKind, output: jsonOrNull(row, "output"), error: jsonOrNull(row, "error"),
        hasOutput: row.output !== null && row.output !== undefined,
        winner: strOrNull(row, "winner"), effectAttempts: int(row, "effect_attempts"), kvRevision: intOrNull(row, "kv_revision"),
        deadlineAt: dateOrNull(row, "deadline_at"),
        receive: receiveOf(row),
        enteredAt: date(row, "entered_at"), completedAt: dateOrNull(row, "completed_at"),
    };
}

function receiveOf(row: Row): WorkflowNodeExecutionRow["receive"] {
    const contract = strOrNull(row, "receive_contract");
    if (contract === null) return null;
    return { contract, from: strOrNull(row, "receive_from"), correlation: parseStoredJson(str(row, "receive_correlation"), "receive_correlation") };
}

/** A timestamp column as exact ISO 8601 UTC text with microseconds (a JavaScript Date keeps only milliseconds). */
function isoUtc(column: string): string {
    return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** The inbox columns inboxFrom reads, with exact times. */
const INBOX_COLUMNS = `message_id, seq, workflow_session_id, run_id, sender_session_id, operation_id, contract, correlation, payload, consumed_by,
    ${isoUtc("accepted_at")} AS accepted_at_iso, ${isoUtc("expires_at")} AS expires_at_iso, ${isoUtc("consumed_at")} AS consumed_at_iso`;

function inboxFrom(row: Row): WorkflowInboxMessage {
    return {
        messageId: str(row, "message_id"), seq: int(row, "seq"), workflowSessionId: str(row, "workflow_session_id"), runId: str(row, "run_id"),
        senderSessionId: str(row, "sender_session_id"), operationId: str(row, "operation_id"), contract: str(row, "contract"),
        correlation: parseStoredJson(str(row, "correlation"), "correlation"), payload: parseStoredJson(str(row, "payload"), "payload"),
        acceptedAt: str(row, "accepted_at_iso"), expiresAt: str(row, "expires_at_iso"),
        consumedBy: strOrNull(row, "consumed_by"), consumedAt: strOrNull(row, "consumed_at_iso"),
    };
}

/** A stored input receipt, with its declared shape. */
export function parseInputReceipt(value: JsonValue): WorkflowInputReceipt {
    const invalid = () => new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "Stored input receipt has an invalid shape.");
    if (!isJsonObject(value)) throw invalid();
    const text = (key: string): string => {
        const item = value[key];
        if (typeof item !== "string") throw invalid();
        return item;
    };
    let claimedBy: WorkflowInputReceipt["claimedBy"] = null;
    const claim = value.claimedBy;
    if (claim !== null) {
        if (!isJsonObject(claim)) throw invalid();
        const { nodeExecutionId, stateId } = claim;
        if (typeof nodeExecutionId !== "string" || typeof stateId !== "string") throw invalid();
        claimedBy = { nodeExecutionId, stateId };
    }
    return {
        workflowSessionId: text("workflowSessionId"), runId: text("runId"), messageId: text("messageId"), senderSessionId: text("senderSessionId"),
        operationId: text("operationId"), contract: text("contract"), requestSha256: text("requestSha256"), payloadSha256: text("payloadSha256"),
        acceptedAt: text("acceptedAt"), expiresAt: text("expiresAt"), claimedBy,
    };
}

/**
 * Why a send state may not send to its recipient: unavailable (missing or
 * deleted; at a delivery attempt also an agent session whose orchestration
 * ended), or forbidden (the authority rule).
 */
export type RecipientRefusal = "unavailable" | "forbidden";

/**
 * What the admission decided a send state's recipient is, under the session
 * locks: an agent session (its message goes to the session's message queue)
 * or a workflow (typed input for one of its receive states).
 */
export type RecipientKind = "agent" | "workflow";

/**
 * What a send state sends, resolved when it is entered. The admission
 * decides the recipient under the session locks (store.enterNode).
 */
export interface SendSpecInput {
    recipient: string;
    contract: string;
    /** Canonical JSON of the payload, already checked against the contract's schema. */
    payloadText: string;
    /** Canonical JSON of the correlation object ({} without one); a workflow recipient's receive states match it. */
    correlationText: string;
    /** What the admission (or a delivery attempt) records instead when the recipient may not be sent to, by refusal. */
    refused: Readonly<Record<RecipientRefusal, { result: NodeResultInput; projection?: SessionProjection }>>;
}

/**
 * What a request state requests, resolved when it is entered (IR 7; no
 * runtime enters one yet, design workflow-messaging-request.md 8.4): a send
 * state's spec, plus its deadline's seconds (frozen at admission, from 1 to
 * WAIT_MAX_SECONDS) and the name of the schema a response must satisfy in
 * the run's pinned definition, which the admission checks is the one its
 * state's contract declares (WORKFLOW_STORE_CORRUPT otherwise). The
 * admission decides the responder under the session locks as a send's
 * recipient; a workflow responder is not supported yet and fails the state
 * with `workflowRecipient`.
 */
export interface RequestSpecInput extends SendSpecInput {
    timeoutSeconds: number;
    responseSchema: string;
    workflowRecipient: { result: NodeResultInput; projection?: SessionProjection };
}

/**
 * A request's status, derived from its node execution (the node's
 * compare-and-swap is the one decision): pending; responded or declined
 * (a response record exists); timed_out; cancelled (a cancel, a deletion, a
 * recover or the run's end); failed (unavailable, forbidden, delivery_failed,
 * unsupported_contract or invalid_input). Never stored.
 */
export type WorkflowRequestStatus = "pending" | "responded" | "declined" | "timed_out" | "cancelled" | "failed";

/** The receipt of the response or declined refusal that decided a request; stored once with its record. */
export interface WorkflowRequestReceipt {
    exchangeId: string;
    workflowSessionId: string;
    runId: string;
    stateId: string;
    responderSessionId: string;
    operationId: string;
    kind: "response" | "decline";
    /** sha256 of the canonical JSON of {kind, value}: a response and a decline never have the same identity. */
    resultSha256: string;
    /** The one reading of the store's clock that decided it (ISO 8601 UTC with microseconds). */
    decidedAt: string;
}

/** A request as it is now: its immutable record, its derived status, its response, its wake intent and its bindings. */
export interface WorkflowRequestView {
    exchangeId: string;
    workflowSessionId: string;
    runId: string;
    stateId: string;
    responderSessionId: string;
    contract: string;
    requestSha256: string;
    responseSchema: string;
    deadlineAt: string;
    createdAt: string;
    status: WorkflowRequestStatus;
    /** The runtime error code of a failed request; null otherwise. */
    failure: string | null;
    response: {
        kind: "response" | "decline"; value: JsonValue; resultSha256: string; operationId: string; actorSessionId: string; decidedAt: string;
        receipt: WorkflowRequestReceipt;
    } | null;
    wake: { state: "pending" | "leased" | "dispatched" | "moot" | "abandoned"; attempts: number; settledAt: string | null } | null;
    /** The operations bound to this request. */
    operations: number;
}

/**
 * What a response call got (store.respondToRequest). A refusal that writes
 * nothing (REQUEST_NOT_FOUND, RESPONSE_INVALID, OPERATION_LIMIT) is thrown
 * instead. `status` is the request's status as this operation's binding
 * records it; `currentStatus` is the request's status now.
 */
export type WorkflowRequestCallResult =
    | { kind: "accepted"; replayed: boolean; receipt: WorkflowRequestReceipt; status: "responded" | "declined" }
    | { kind: "refused"; replayed: boolean; code: "REQUEST_EXPIRED" | "REQUEST_CLOSED" | "RESPONSE_CONFLICT" | "OPERATION_CONFLICT";
        status: WorkflowRequestStatus; currentStatus: WorkflowRequestStatus };

/** A response's largest canonical JSON, in UTF-8 bytes (the send payload bound). */
export const WORKFLOW_V2_MAX_RESPONSE_BYTES = 16 * 1024;
/** The operations one request binds at most; a new operation beyond them is refused (OPERATION_LIMIT) and nothing is written. */
export const WORKFLOW_V2_MAX_REQUEST_OPERATIONS = 50;
/** The framework's strict decline schema: a reason of 1 to 2,000 characters and nothing else. */
export const WORKFLOW_V2_DECLINE_SCHEMA: JsonValue = {
    type: "object", additionalProperties: false, required: ["reason"],
    properties: { reason: { type: "string", minLength: 1, maxLength: 2_000 } },
};
const REQUEST_FAILURE_CODES: readonly string[] = ["unavailable", "forbidden", "delivery_failed", "unsupported_contract", "invalid_input"];

let declineSchemas: WorkflowSchemaSet | null = null;
function declineProblems(value: JsonValue): SchemaProblem[] {
    declineSchemas ??= new WorkflowSchemaSet({ decline: WORKFLOW_V2_DECLINE_SCHEMA });
    return declineSchemas.validate("decline", value);
}

/**
 * A workflow recipient's acceptance of a send state's message as typed
 * input (store.acceptInput): its inbox message, the recipient run, the exact
 * accepted and expiry times, and the receive state that took it in that
 * acceptance (null when none waited for it then).
 */
export interface WorkflowSendInputAcceptance {
    messageId: string;
    runId: string;
    acceptedAt: string;
    expiresAt: string;
    claimedBy: { nodeExecutionId: string; stateId: string } | null;
}

/**
 * The receipt of a delivered message, stored once with it and passed on as
 * its send state's output. It says the recipient accepted the message, not
 * that the recipient read it: an agent session's queue accepted it (at least
 * once; clientMessageId is the one every attempt carried, and more than one
 * attempt means the session may have received it more than once), or a
 * workflow's inbox accepted it as typed input once per exchange (`input`).
 * attempts counts the attempts begun when the delivery was recorded.
 */
export interface WorkflowSendReceipt {
    exchangeId: string;
    workflowSessionId: string;
    runId: string;
    nodeExecutionId: string;
    stateId: string;
    recipientSessionId: string;
    recipientKind: RecipientKind;
    contract: string;
    payloadSha256: string;
    /** An agent recipient: the client message id every attempt carried; a workflow recipient: null. */
    clientMessageId: string | null;
    /** A workflow recipient: its inbox's acceptance; an agent recipient: null. */
    input: WorkflowSendInputAcceptance | null;
    attempts: number;
    /** The store's clock reading that recorded the delivery (ISO 8601 UTC, microseconds). */
    deliveredAt: string;
}

/**
 * A send state's message in the outbox (migrations 0091, 0092), or a request
 * state's (migration 0093, mode request), as it is now. Times are the stored
 * values, exactly (ISO 8601 UTC with microseconds). Only a send's message is
 * delivered by a send orchestration (beginDelivery, recordDelivery and
 * failDelivery refuse a request's).
 */
export interface WorkflowOutboxMessage {
    /** The message's stable identity: its send state's node execution id. */
    exchangeId: string;
    nodeExecutionId: string;
    workflowSessionId: string;
    runId: string;
    mode: "send" | "request";
    recipientSessionId: string;
    /** What the admission decided the recipient is (rows before migration 0092: agent). */
    recipientKind: RecipientKind;
    contract: string;
    payload: JsonValue;
    payloadSha256: string;
    /** The correlation object the state resolved ({} for rows before migration 0092). */
    correlation: JsonValue;
    /** pending until a delivery is recorded (delivered), or none will be (failed). */
    state: "pending" | "delivered" | "failed";
    /** Delivery attempts begun (store.beginDelivery). */
    attempts: number;
    createdAt: string;
    lastAttemptAt: string | null;
    decidedAt: string | null;
    receipt: WorkflowSendReceipt | null;
    /** Why no delivery will be recorded (a runtime error envelope); null otherwise. */
    error: JsonValue;
}

/** The outbox columns outboxFrom reads, with exact times. */
const OUTBOX_COLUMNS = `exchange_id, node_execution_id, workflow_session_id, run_id, mode, recipient_session_id, recipient_kind, contract, payload,
    payload_sha256, correlation, state, attempts, receipt, error, ${isoUtc("created_at")} AS created_at_iso,
    ${isoUtc("last_attempt_at")} AS last_attempt_at_iso, ${isoUtc("decided_at")} AS decided_at_iso`;

function outboxFrom(row: Row): WorkflowOutboxMessage {
    const state = str(row, "state");
    if (state !== "pending" && state !== "delivered" && state !== "failed") return corrupt(`Unknown outbox state ${state}.`);
    const mode = str(row, "mode");
    if (mode !== "send" && mode !== "request") return corrupt(`Unknown outbox mode ${mode}.`);
    const kind = strOrNull(row, "recipient_kind") ?? "agent";
    if (kind !== "agent" && kind !== "workflow") return corrupt(`Unknown outbox recipient kind ${kind}.`);
    const correlation = strOrNull(row, "correlation");
    const receipt = strOrNull(row, "receipt");
    return {
        exchangeId: str(row, "exchange_id"), nodeExecutionId: str(row, "node_execution_id"), workflowSessionId: str(row, "workflow_session_id"),
        runId: str(row, "run_id"), mode, recipientSessionId: str(row, "recipient_session_id"), recipientKind: kind, contract: str(row, "contract"),
        payload: parseStoredJson(str(row, "payload"), "payload"), payloadSha256: str(row, "payload_sha256"),
        correlation: correlation === null ? {} : parseStoredJson(correlation, "correlation"),
        state, attempts: int(row, "attempts"), createdAt: str(row, "created_at_iso"),
        lastAttemptAt: strOrNull(row, "last_attempt_at_iso"), decidedAt: strOrNull(row, "decided_at_iso"),
        receipt: receipt === null ? null : parseSendReceipt(parseStoredJson(receipt, "receipt")),
        error: jsonOrNull(row, "error"),
    };
}

/**
 * A stored send receipt, with its declared shape. A receipt written before
 * workflow recipients (no recipientKind) is an agent recipient's.
 */
export function parseSendReceipt(value: JsonValue): WorkflowSendReceipt {
    const invalid = () => new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "Stored send receipt has an invalid shape.");
    if (!isJsonObject(value)) throw invalid();
    const textOf = (item: JsonValue | undefined): string => {
        if (typeof item !== "string") throw invalid();
        return item;
    };
    const text = (key: string): string => textOf(value[key]);
    const attempts = value.attempts;
    if (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 1) throw invalid();
    const kind = value.recipientKind === undefined ? "agent" : value.recipientKind;
    if (kind !== "agent" && kind !== "workflow") throw invalid();
    let input: WorkflowSendInputAcceptance | null = null;
    if (value.input !== undefined && value.input !== null) {
        const accepted = value.input;
        if (!isJsonObject(accepted)) throw invalid();
        let claimedBy: WorkflowSendInputAcceptance["claimedBy"] = null;
        if (accepted.claimedBy !== null) {
            const claim = accepted.claimedBy;
            if (!isJsonObject(claim)) throw invalid();
            claimedBy = { nodeExecutionId: textOf(claim.nodeExecutionId), stateId: textOf(claim.stateId) };
        }
        input = { messageId: textOf(accepted.messageId), runId: textOf(accepted.runId), acceptedAt: textOf(accepted.acceptedAt),
            expiresAt: textOf(accepted.expiresAt), claimedBy };
    }
    const clientMessageId = value.clientMessageId === null ? null : text("clientMessageId");
    if ((kind === "agent") !== (clientMessageId !== null) || (kind === "workflow") !== (input !== null)) throw invalid();
    return {
        exchangeId: text("exchangeId"), workflowSessionId: text("workflowSessionId"), runId: text("runId"), nodeExecutionId: text("nodeExecutionId"),
        stateId: text("stateId"), recipientSessionId: text("recipientSessionId"), recipientKind: kind, contract: text("contract"),
        payloadSha256: text("payloadSha256"), clientMessageId, input, attempts, deliveredAt: text("deliveredAt"),
    };
}

// ─── Durable recipient intake (migration 0094; design workflow-durable-intake.md 3, 4, 5.1, 5.2, 5.6, 5.7) ──

/** An intake row's state: holding until one final state (design 5.1). */
export type WorkflowIntakeState = "holding" | "admitted" | "cancelled" | "refused_full" | "refused_size";
/** An admitted row's processing: bound until its invocation ends, then one final value (design 5.5). */
export type WorkflowIntakeProcessing = "bound" | IntakeProcessingOutcome;
/** The final states a refusal writes (design 5.6). */
export type WorkflowIntakeRefusal = "refused_full" | "refused_size";

const INTAKE_STATES: readonly WorkflowIntakeState[] = ["holding", "admitted", "cancelled", "refused_full", "refused_size"];
const INTAKE_PROCESSING: readonly WorkflowIntakeProcessing[] = ["bound", ...INTAKE_PROCESSING_OUTCOMES];

function isIntakeState(value: string): value is WorkflowIntakeState {
    return (INTAKE_STATES as readonly string[]).includes(value);
}
function isIntakeProcessing(value: string): value is WorkflowIntakeProcessing {
    return (INTAKE_PROCESSING as readonly string[]).includes(value);
}

/** One exchange's intake row (migration 0094), as stored. Times are exact (ISO 8601 UTC with microseconds). */
export interface WorkflowIntakeRow {
    exchangeId: string;
    recipientSessionId: string;
    workflowSessionId: string;
    runId: string;
    envelopeSha256: string;
    /** The canonical text, written once by the claim that inserted the row; null only on a row that claim inserted refused. */
    text: string | null;
    textSha256: string;
    claimId: string;
    state: WorkflowIntakeState;
    /** The invocation an admitted row is bound to; null otherwise. */
    invocationId: string | null;
    /** An admitted row's processing; null otherwise. */
    processing: WorkflowIntakeProcessing | null;
    cancelRequested: boolean;
    duplicates: number;
    conflicts: number;
    createdAt: string;
    updatedAt: string;
    admittedAt: string | null;
    settledAt: string | null;
    reason: string | null;
}

const INTAKE_COLUMNS = `exchange_id, recipient_session_id, workflow_session_id, run_id, envelope_sha256, text, text_sha256, claim_id, state,
    invocation_id, processing, cancel_requested, duplicates, conflicts, ${isoUtc("created_at")} AS created_at_iso,
    ${isoUtc("updated_at")} AS updated_at_iso, ${isoUtc("admitted_at")} AS admitted_at_iso, ${isoUtc("settled_at")} AS settled_at_iso, reason`;

function intakeFrom(row: Row): WorkflowIntakeRow {
    const state = str(row, "state");
    if (!isIntakeState(state)) return corrupt(`Unknown intake state ${state}.`);
    const processing = strOrNull(row, "processing");
    if (processing !== null && !isIntakeProcessing(processing)) return corrupt(`Unknown intake processing ${processing}.`);
    return {
        exchangeId: str(row, "exchange_id"), recipientSessionId: str(row, "recipient_session_id"), workflowSessionId: str(row, "workflow_session_id"),
        runId: str(row, "run_id"), envelopeSha256: str(row, "envelope_sha256"), text: strOrNull(row, "text"), textSha256: str(row, "text_sha256"),
        claimId: str(row, "claim_id"), state, invocationId: strOrNull(row, "invocation_id"), processing,
        cancelRequested: bool(row, "cancel_requested"), duplicates: int(row, "duplicates"), conflicts: int(row, "conflicts"),
        createdAt: str(row, "created_at_iso"), updatedAt: str(row, "updated_at_iso"), admittedAt: strOrNull(row, "admitted_at_iso"),
        settledAt: strOrNull(row, "settled_at_iso"), reason: strOrNull(row, "reason"),
    };
}

/** What the claim renders an item from (design section 3): the immutable outbox row and its send state, as the sender renders it. */
export interface WorkflowIntakeRenderSource {
    workflowSessionId: string;
    runId: string;
    nodeExecutionId: string;
    stateId: string;
    contract: string;
    correlation: JsonValue;
    payload: JsonValue;
}

/**
 * The sender's own renderer, given by the caller (runtime.ts
 * workflowSendPrompt and workflowSendClientMessageId): the store does not
 * import the runtime.
 */
export type WorkflowIntakeRender = (source: WorkflowIntakeRenderSource) => { text: string; clientMessageId: string };

/** An accepted claim's item (design section 3), built only from the canonical render and the stored row. */
export interface WorkflowIntakeItem {
    exchangeId: string;
    claimId: string;
    text: string;
    textSha256: string;
    clientMessageId: string;
    /** The exact UTF-8 bytes of the item's JSON as an invocation carries it (intakeItemBytes); it always fits one invocation alone. */
    itemBytes: number;
}

/**
 * A claim's result (design 5.2). `inserted` is true only for the call that
 * inserted the row; a repeated call of the same claim gets the row's state
 * again and writes nothing (an accepted one returns the stored text).
 */
export type WorkflowIntakeClaimResult =
    | { result: "accepted"; inserted: boolean; item: WorkflowIntakeItem }
    | { result: "admitted" | "cancelled"; inserted: false }
    | { result: WorkflowIntakeRefusal; inserted: boolean }
    | { result: "duplicate" | "conflict"; state: WorkflowIntakeState }
    | { result: "unverified"; reason: string };

/** A bound item's stored text (design 5.5): the bind returns these in the caller's order. */
export interface WorkflowIntakeBoundText {
    exchangeId: string;
    claimId: string;
    text: string;
    textSha256: string;
}

/** A broken intake invariant (design 5.2): the execution fails with the exchange, and nothing is written. */
function intakeBroken(exchangeId: string, message: string): never {
    throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Intake of exchange ${exchangeId}: ${message}`, { exchangeId });
}

/** An exchange's outbox row as a claim or a refusal reads it under its lock, with its send state's id. */
interface IntakeOutboxRow {
    exchangeId: string;
    nodeExecutionId: string;
    workflowSessionId: string;
    runId: string;
    mode: string;
    recipientSessionId: string;
    /** Rows before migration 0092 have none: an agent session. */
    recipientKind: string;
    contract: string;
    payloadText: string;
    payloadSha256: string;
    correlationText: string | null;
    intakeMode: string | null;
    stateId: string;
}

/** The render source of an outbox row: the message as the sender renders it (outboxFrom's payload and correlation, the state's id). */
function intakeRenderSource(outbox: IntakeOutboxRow): WorkflowIntakeRenderSource {
    return {
        workflowSessionId: outbox.workflowSessionId, runId: outbox.runId, nodeExecutionId: outbox.nodeExecutionId, stateId: outbox.stateId,
        contract: outbox.contract, correlation: outbox.correlationText === null ? {} : parseStoredJson(outbox.correlationText, "correlation"),
        payload: parseStoredJson(outbox.payloadText, "payload"),
    };
}

/**
 * Why an envelope does not verify against its outbox row (design sections 3
 * and 4), or null when it does: the row is a send to an agent session in
 * durable mode, and names the envelope's workflow, run, recipient (the
 * claiming session), contract and payload hash; and the envelope's hash is
 * its fields' hash. A row with no mode or in legacy_window mode never
 * verifies, whatever else matches.
 */
function intakeMismatch(outbox: IntakeOutboxRow, envelope: IntakeEnvelope, recipientSessionId: string): string | null {
    if (outbox.mode !== "send") return "the exchange is not a send state's message";
    if (outbox.intakeMode !== "durable") return "the exchange is not in durable intake mode";
    if (outbox.recipientKind !== "agent") return "the exchange is not to an agent session";
    if (outbox.recipientSessionId !== recipientSessionId || envelope.recipientSessionId !== recipientSessionId) {
        return "the envelope names another recipient";
    }
    if (outbox.workflowSessionId !== envelope.workflowSessionId || outbox.runId !== envelope.runId || outbox.contract !== envelope.contract
        || outbox.payloadSha256 !== envelope.payloadSha256) {
        return "the envelope does not name its message";
    }
    if (intakeEnvelopeSha256(envelope) !== envelope.envelopeSha256) return "the envelope's hash is not the hash of its fields";
    return null;
}

/** The item of a holding row, from its stored text: a repeated accepted claim returns what the first one stored (design 5.2). */
function heldIntakeItem(row: WorkflowIntakeRow, clientMessageId: string): WorkflowIntakeItem {
    if (row.text === null || sha256Hex(row.text) !== row.textSha256) return intakeBroken(row.exchangeId, "its stored text does not match its hash");
    const itemBytes = intakeItemBytes(intakeBoundItem({ exchangeId: row.exchangeId, claimId: row.claimId, textSha256: row.textSha256, clientMessageId },
        row.text));
    return { exchangeId: row.exchangeId, claimId: row.claimId, text: row.text, textSha256: row.textSha256, clientMessageId, itemBytes };
}

/** Only the holder settles (design 5.2, I3): the row is the recipient's, under the caller's claim. */
function assertIntakeHolder(row: WorkflowIntakeRow, recipientSessionId: string, claimId: string): void {
    if (row.recipientSessionId !== recipientSessionId) intakeBroken(row.exchangeId, "it belongs to another recipient");
    if (row.claimId !== claimId) intakeBroken(row.exchangeId, `it is held under claim ${row.claimId}, not ${claimId}`);
}

/** The claims a bind or an end names: 1 to INTAKE_MAX_HELD distinct exchanges, each with its claim (and, for an end, its cancel flag). */
function intakeBatch(raw: unknown, path: string, withCancelFlag: boolean): Array<{ exchangeId: string; claimId: string; cancelRequested: boolean }> {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > INTAKE_MAX_HELD) {
        throw new IntakeShapeError(path, `is not a list of 1 to ${INTAKE_MAX_HELD} items`);
    }
    const keys = withCancelFlag ? ["exchangeId", "claimId", "cancelRequested"] : ["exchangeId", "claimId"];
    const seen = new Set<string>();
    return raw.map((item: unknown, index: number) => {
        const value = intakeObject(item, `${path}[${index}]`, keys);
        const exchangeId = intakeExchangeId(value.exchangeId, `${path}[${index}].exchangeId`);
        if (seen.has(exchangeId)) throw new IntakeShapeError(`${path}[${index}].exchangeId`, "names an exchange twice");
        seen.add(exchangeId);
        const cancelRequested = withCancelFlag ? value.cancelRequested : false;
        if (typeof cancelRequested !== "boolean") throw new IntakeShapeError(`${path}[${index}].cancelRequested`, "is not a boolean");
        return { exchangeId, claimId: intakeId(value.claimId, `${path}[${index}].claimId`), cancelRequested };
    });
}

/** The renderer's result, checked: a storable text and a client message id an item may keep. */
function renderedIntake(render: WorkflowIntakeRender, source: WorkflowIntakeRenderSource): { text: string; clientMessageId: string } {
    const rendered: unknown = render(source);
    const text = isJsonObject(rendered) ? rendered.text : undefined;
    if (!isJsonObject(rendered) || typeof text !== "string" || text.length === 0 || !isStorableText(text)) {
        throw new WorkflowStoreError("WORKFLOW_INTAKE_RENDER_INVALID", `The renderer gave no storable text for exchange ${source.nodeExecutionId}.`);
    }
    return { text, clientMessageId: intakeClientMessageId(rendered.clientMessageId, "render.clientMessageId") };
}

/** A request's immutable record (migration 0093), with exact times. */
interface WorkflowRequestRecord {
    exchangeId: string;
    workflowSessionId: string;
    runId: string;
    responderSessionId: string;
    contract: string;
    requestSha256: string;
    responseSchema: string;
    deadlineAt: string;
    createdAt: string;
}

const REQUEST_COLUMNS = `exchange_id, workflow_session_id, run_id, responder_session_id, contract, request_sha256, response_schema,
    ${isoUtc("deadline_at")} AS deadline_at_iso, ${isoUtc("created_at")} AS created_at_iso`;

function requestFrom(row: Row): WorkflowRequestRecord {
    return {
        exchangeId: str(row, "exchange_id"), workflowSessionId: str(row, "workflow_session_id"), runId: str(row, "run_id"),
        responderSessionId: str(row, "responder_session_id"), contract: str(row, "contract"), requestSha256: str(row, "request_sha256"),
        responseSchema: str(row, "response_schema"), deadlineAt: str(row, "deadline_at_iso"), createdAt: str(row, "created_at_iso"),
    };
}

/** A response record from requestStateSql's response columns, checked against its own receipt. */
function responseFrom(row: Row): NonNullable<WorkflowRequestView["response"]> {
    const kind = str(row, "kind");
    if (kind !== "response" && kind !== "decline") return corrupt(`Unknown request response kind ${kind}.`);
    const receipt = parseRequestReceipt(parseStoredJson(str(row, "receipt"), "receipt"));
    const response: NonNullable<WorkflowRequestView["response"]> = {
        kind, value: parseStoredJson(str(row, "value"), "value"), resultSha256: str(row, "result_sha256"), operationId: str(row, "operation_id"),
        actorSessionId: str(row, "actor_session_id"), decidedAt: str(row, "decided_at_iso"), receipt,
    };
    if (receipt.exchangeId !== str(row, "exchange_id") || receipt.kind !== kind || receipt.resultSha256 !== response.resultSha256
        || receipt.operationId !== response.operationId || receipt.decidedAt !== response.decidedAt) {
        return corrupt(`The response record of request ${receipt.exchangeId} does not match its receipt.`);
    }
    return response;
}

/** A stored request receipt, with its declared shape. */
export function parseRequestReceipt(value: JsonValue): WorkflowRequestReceipt {
    const invalid = () => new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "Stored request receipt has an invalid shape.");
    if (!isJsonObject(value)) throw invalid();
    const text = (key: string): string => {
        const item = value[key];
        if (typeof item !== "string") throw invalid();
        return item;
    };
    const kind = value.kind;
    if (kind !== "response" && kind !== "decline") throw invalid();
    return {
        exchangeId: text("exchangeId"), workflowSessionId: text("workflowSessionId"), runId: text("runId"), stateId: text("stateId"),
        responderSessionId: text("responderSessionId"), operationId: text("operationId"), kind, resultSha256: text("resultSha256"),
        decidedAt: text("decidedAt"),
    };
}

/**
 * A request's status from its node execution and its response record: the
 * only mapping there is. Any other combination (an unknown outcome, a
 * responded or declined node without its record or with the other kind, a
 * record on any other node) is store corruption, never a default status.
 */
function requestStatusOf(exchangeId: string, node: WorkflowNodeExecutionRow, response: { kind: "response" | "decline" } | null)
    : { status: WorkflowRequestStatus; failure: string | null } {
    if (node.state === "pending") {
        if (response === null) return { status: "pending", failure: null };
    } else if (node.resultKind === "business") {
        if (node.winner === "response" && node.outcome === REQUEST_RESPONDED && response?.kind === "response") return { status: "responded", failure: null };
        if (node.winner === "response" && node.outcome === REQUEST_DECLINED && response?.kind === "decline") return { status: "declined", failure: null };
    } else if (node.resultKind === "runtime_error" && response === null) {
        if (node.outcome === "timed_out") return { status: "timed_out", failure: null };
        if (node.outcome === "cancelled") return { status: "cancelled", failure: null };
        if (node.outcome !== null && REQUEST_FAILURE_CODES.includes(node.outcome)) return { status: "failed", failure: node.outcome };
    }
    return corrupt(`Request ${exchangeId} is in no request status: its state is ${node.state}${node.outcome ? ` (${node.outcome})` : ""}`
        + ` and it has ${response === null ? "no response record" : `a ${response.kind} record`}.`);
}

function requestStatusText(row: Row, column: string): WorkflowRequestStatus {
    const status = str(row, column);
    if (status !== "pending" && status !== "responded" && status !== "declined" && status !== "timed_out" && status !== "cancelled" && status !== "failed") {
        return corrupt(`Unknown request status ${status}.`);
    }
    return status;
}

/** A request's committed state as one statement reads it (WorkflowStore.requestStateSql), checked whole by requestStateFrom. */
interface WorkflowRequestState {
    node: WorkflowNodeExecutionRow;
    response: NonNullable<WorkflowRequestView["response"]> | null;
    status: WorkflowRequestStatus;
    failure: string | null;
    wake: WorkflowRequestView["wake"];
    operations: number;
}

/**
 * A request's committed state from one statement, checked whole (design
 * workflow-messaging-request.md Q1, Q5, Q7): the record's node execution,
 * run and workflow; its message intent's identity; the status mapping
 * (requestStatusOf); and, for a response, its canonical value and identity,
 * the node's result and completion time, its receipt's requester, run,
 * state and responder, its one winning binding and its wake intent (its
 * run, its run's controller and its time). A
 * request with no response has no wake intent and no winning binding. Any
 * other combination is store corruption, on inspection and on every
 * response path, a known operation's replay included. Nothing here checks a
 * business schema or a deadline.
 */
function requestStateFrom(request: WorkflowRequestRecord, row: Row | undefined): WorkflowRequestState {
    const id = request.exchangeId;
    if (!row) return corrupt(`Request ${id} has no node execution.`);
    const node = nodeFrom(row);
    if (node.runId !== request.runId || str(row, "run_workflow_session_id") !== request.workflowSessionId || node.nodeType !== "messaging") {
        return corrupt(`Request ${id} does not belong to its node execution's run and workflow.`);
    }
    if (strOrNull(row, "o_node_execution_id") !== id || strOrNull(row, "o_workflow_session_id") !== request.workflowSessionId
        || strOrNull(row, "o_run_id") !== request.runId || strOrNull(row, "o_mode") !== "request"
        || strOrNull(row, "o_recipient_session_id") !== request.responderSessionId || strOrNull(row, "o_recipient_kind") !== "agent"
        || strOrNull(row, "o_contract") !== request.contract || strOrNull(row, "o_payload_sha256") !== request.requestSha256) {
        return corrupt(`Request ${id} does not match its message intent.`);
    }
    const response = row.r_exchange_id === null || row.r_exchange_id === undefined ? null : responseFrom({
        exchange_id: row.r_exchange_id, kind: row.r_kind, value: row.r_value, result_sha256: row.r_result_sha256, operation_id: row.r_operation_id,
        actor_session_id: row.r_actor_session_id, decided_at_iso: row.r_decided_at_iso, receipt: row.r_receipt,
    });
    const { status, failure } = requestStatusOf(id, node, response);
    let wake: WorkflowRequestView["wake"] = null;
    if (row.w_exchange_id !== null && row.w_exchange_id !== undefined) {
        const state = str(row, "w_state");
        if (state !== "pending" && state !== "leased" && state !== "dispatched" && state !== "moot" && state !== "abandoned") {
            return corrupt(`Unknown wake state ${state}.`);
        }
        wake = { state, attempts: int(row, "w_attempts"), settledAt: strOrNull(row, "w_settled_at_iso") };
    }
    const winningBindings = int(row, "decided_count");
    if (response === null) {
        if (wake !== null || winningBindings !== 0) return corrupt(`Request ${id} has a wake intent or a winning binding but no response.`);
    } else {
        const valueText = str(row, "r_value");
        const { receipt } = response;
        if (canonicalJson(response.value) !== valueText || kindValueSha256(response.kind, valueText) !== response.resultSha256) {
            return corrupt(`The response of request ${id} is not the canonical value its identity names.`);
        }
        if (strOrNull(row, "output") !== valueText || row.r_node_time !== true) {
            return corrupt(`The node execution of request ${id} does not hold its response at its decision time.`);
        }
        if (response.actorSessionId !== request.responderSessionId || receipt.workflowSessionId !== request.workflowSessionId
            || receipt.runId !== request.runId || receipt.stateId !== node.nodeId || receipt.responderSessionId !== request.responderSessionId) {
            return corrupt(`The response of request ${id} does not name its requester, run, state and responder.`);
        }
        if (winningBindings !== 1 || strOrNull(row, "b_outcome") !== "decided" || strOrNull(row, "b_actor_session_id") !== response.actorSessionId
            || strOrNull(row, "b_result_sha256") !== response.resultSha256 || strOrNull(row, "b_status") !== status || row.b_time !== true) {
            return corrupt(`The response of request ${id} has no one winning binding.`);
        }
        if (wake === null || strOrNull(row, "w_run_id") !== request.runId || row.w_time !== true
            || strOrNull(row, "w_controller_instance_id") !== str(row, "run_controller_instance_id")) {
            return corrupt(`The response of request ${id} has no wake intent of its own.`);
        }
    }
    return { node, response, status, failure, wake, operations: int(row, "op_count") };
}

/**
 * A known operation's binding, checked against the request's committed state
 * before any answer comes from it (design Q5, Q7). Every binding is the
 * frozen responder's. A decided binding is the decision's own operation; a
 * same or a conflict binding was bound after the decision: each names the
 * decision's status, and the decision's result identity (decided, same) or
 * another one (conflict). An expired binding was bound while the request was
 * pending; a closed one names the request's final status. Anything else is
 * store corruption, so a corrupt binding never answers with success or with
 * the decision's receipt. No business schema and no deadline is checked again.
 */
function assertKnownBinding(request: WorkflowRequestRecord, operationId: string, binding: Row, current: WorkflowRequestState): void {
    const outcome = str(binding, "outcome");
    const status = requestStatusText(binding, "status");
    const resultSha256 = str(binding, "result_sha256");
    const decision = current.response;
    const afterDecision = outcome === "decided" || outcome === "same" || outcome === "conflict";
    const consistent = str(binding, "actor_session_id") === request.responderSessionId && (afterDecision
        ? decision !== null && status === current.status && (status === "responded" || status === "declined")
            && (resultSha256 === decision.resultSha256) === (outcome !== "conflict")
            && (operationId === decision.operationId) === (outcome === "decided")
        : outcome === "expired" ? status === "pending"
        : outcome === "closed" ? status === current.status && status !== "pending" && status !== "responded" && status !== "declined"
        : false);
    if (!consistent) corrupt(`Operation ${operationId} of request ${request.exchangeId} does not match the request's state.`);
}

/** A response call's value as JSON (any JSON value: null, false, arrays, NUL and lone surrogates included), or RESPONSE_INVALID. */
function responseValueOf(raw: unknown, kind: "response" | "decline"): JsonValue {
    try {
        assertJsonValue(raw, `$.${kind}`);
        return raw;
    } catch (error) {
        if (error instanceof WorkflowJsonError) throw new WorkflowStoreError("RESPONSE_INVALID", error.message, [{ path: error.path, message: error.message }]);
        throw error;
    }
}

/** A revision row's IR, verified against its stored hash (and the pinned one, when given). */
function revisionIrFrom(row: Row | undefined, revision: number, expectedIrSha256: string | undefined, options: { maxIrVersion?: number }): WorkflowIR {
    const text = row ? strOrNull(row, "ir") : null;
    const stored = row ? strOrNull(row, "ir_sha256") : null;
    if (!text || !stored) throw new WorkflowStoreError("DEFINITION_INVALID", `Revision ${revision} has no compiled IR.`);
    if (sha256Hex(text) !== stored || (expectedIrSha256 && stored !== expectedIrSha256)) {
        throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Revision ${revision} IR does not match its pinned hash.`);
    }
    return parseWorkflowIr(parseStoredJson(text, "ir"), options);
}

/**
 * The response schema that request state `stateId` of a pinned IR declares
 * through `contract`: the state is a request state of that contract, and the
 * contract declares a response whose schema the IR has. Anything else is a
 * request spec or record that does not belong to its definition
 * (WORKFLOW_STORE_CORRUPT), never a reason to use another schema of it.
 */
function declaredResponseSchema(ir: WorkflowIR, stateId: string, contract: string, what: string): string {
    const node = Object.hasOwn(ir.nodes, stateId) ? ir.nodes[stateId] : undefined;
    const declared = ir.contracts !== undefined && Object.hasOwn(ir.contracts, contract) ? ir.contracts[contract].response?.schema : undefined;
    if (node === undefined || node.type !== "messaging" || node.mode !== "request" || node.contract !== contract
        || declared === undefined || !Object.hasOwn(ir.schemaDefs, declared)) {
        return corrupt(`${what}: state ${stateId} of its pinned definition is not a request state of contract ${contract} that declares a response.`);
    }
    return declared;
}

/** True for a string that a stored row could hold as an id (PostgreSQL TEXT has no NUL and no lone surrogate). */
function storableId(value: unknown): value is string {
    return typeof value === "string" && isStorableText(value);
}

/** Diagnostics as plain JSON (for error details). */
export function diagnosticsJson(diagnostics: WorkflowDiagnostic[]): JsonValue {
    return diagnostics.map(item => ({
        severity: item.severity, code: item.code, path: item.path, message: item.message,
        ...(item.line !== undefined ? { line: item.line } : {}),
    }));
}

function corrupt(message: string): never {
    throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", message);
}

/** The error of a send's message that no delivery will be recorded for, because its state was decided first. */
function undeliveredErrorText(outcome: string | null, attempts: number): string {
    return canonicalJson({ code: "cancelled", message: jsonbSafeText(
        `The send state was decided (${outcome ?? "the workflow was deleted"}) before a delivery was recorded; `
        + `${attempts} delivery attempts had begun.`, 4_000), details: { attempts } });
}

function parseRunReceipt(value: JsonValue): WorkflowRunReceipt | null {
    if (value === null) return null;
    if (!isJsonObject(value) || typeof value.runId !== "string" || (value.mode !== "live" && value.mode !== "test")
        || typeof value.controllerInstanceId !== "string" || typeof value.revision !== "number" || typeof value.irSha256 !== "string") {
        return corrupt("Stored run receipt has an invalid shape.");
    }
    return { runId: value.runId, mode: value.mode, controllerInstanceId: value.controllerInstanceId, revision: value.revision, irSha256: value.irSha256 };
}

/** Read a stored definition receipt back with its declared shape. */
export function parseDefinitionReceipt(value: JsonValue): WorkflowDefinitionReceipt {
    if (!isJsonObject(value) || typeof value.workflowSessionId !== "string" || typeof value.operation !== "string"
        || (value.state !== "draft" && value.state !== "published" && value.state !== "deleted")
        || typeof value.revision !== "number" || typeof value.yamlSha256 !== "string" || typeof value.valid !== "boolean"
        || (value.irSha256 !== null && typeof value.irSha256 !== "string")
        || (value.publishedRevision !== null && typeof value.publishedRevision !== "number")
        || !Object.hasOwn(value, "diagnostics") || !Object.hasOwn(value, "run")) {
        return corrupt("Stored definition receipt has an invalid shape.");
    }
    return {
        workflowSessionId: value.workflowSessionId, operation: value.operation, state: value.state, revision: value.revision,
        yamlSha256: value.yamlSha256, valid: value.valid, irSha256: value.irSha256, diagnostics: parseDiagnostics(value.diagnostics),
        publishedRevision: value.publishedRevision, run: parseRunReceipt(value.run),
    };
}

/** Deterministic node execution identity from its history-selected coordinates. */
export function nodeExecutionIdFor(runId: string, scopeId: string, nodeId: string, ordinal: number): string {
    return `nx-${sha256Hex(canonicalJson([runId, scopeId, nodeId, ordinal])).slice(0, 40)}`;
}

export class WorkflowStore {
    private readonly t: {
        definitions: string; revisions: string; operations: string; runs: string; nodes: string; kvRevisions: string; inbox: string; outbox: string;
        requests: string; requestResponses: string; requestOperations: string; responseWakes: string; intake: string;
        sessions: string; sessionOwners: string; users: string; recordEvents: string; updateSession: string; softDeleteSession: string;
    };

    constructor(private readonly pool: Pool, readonly schema: string) {
        const s = `"${schema}"`;
        this.t = {
            definitions: `${s}.workflow_definitions`, revisions: `${s}.workflow_revisions`,
            operations: `${s}.workflow_operations`, runs: `${s}.workflow_runs`, nodes: `${s}.workflow_node_executions`,
            kvRevisions: `${s}.workflow_kv_revisions`, inbox: `${s}.workflow_inbox`, outbox: `${s}.workflow_outbox`,
            requests: `${s}.workflow_requests`, requestResponses: `${s}.workflow_request_responses`,
            requestOperations: `${s}.workflow_request_operations`, responseWakes: `${s}.workflow_response_wakes`, intake: `${s}.workflow_intake`,
            sessions: `${s}.sessions`, sessionOwners: `${s}.session_owners`, users: `${s}.users`,
            recordEvents: `${s}.cms_record_events`, updateSession: `${s}.cms_update_session`,
            softDeleteSession: `${s}.cms_soft_delete_session`,
        };
    }

    /**
     * Lock the workflow's session row. Every v2 transaction takes its locks in
     * one order (session, definition, run, node) and re-checks deletion here,
     * so it serializes with deletion (whose trigger ends v2 work in the same
     * transaction as the soft delete). False when the row is deleted or absent.
     */
    private async lockLiveSession(client: PoolClient, workflowSessionId: string): Promise<boolean> {
        const { rows } = await client.query(
            `SELECT deleted_at FROM ${this.t.sessions} WHERE session_id = $1 FOR NO KEY UPDATE`, [workflowSessionId]);
        return Boolean(rows[0]) && rows[0].deleted_at === null;
    }

    /**
     * Lock the workflow's session row and a typed-input sender's, then decide
     * the sender's authority (authority.ts) on what this transaction reads
     * after both locks are held: an input's acceptance and a receive's
     * admission decide here, not on an earlier read. The session rows are
     * locked in ascending session id order, before any definition, run or
     * node row: the workflow's FOR NO KEY UPDATE (as lockLiveSession), the
     * sender's FOR SHARE. A soft delete of the sender (an update of its row)
     * that committed before the lock is read; one that did not waits until
     * this transaction ends. So each deletion of the sender takes effect
     * wholly before or wholly after this decision: the lock is its
     * linearization point. Only rows that the locks found count (a session
     * created after its lock was missing is missing here too). Both sessions
     * and their owners are then read in one statement, so the decision sees
     * one committed state of session_owners and users: an owner is assigned
     * once (first assignment wins), and only the merge of a placeholder user
     * into its real user re-points owners, in one transaction. The
     * definition's parent is never updated. PostgreSQL detects a lock cycle
     * with a writer that locks both rows in another order and aborts one
     * transaction: an admission is then retried by its activity, and a send
     * may be repeated with its operation id.
     */
    private async lockInputSessions(client: PoolClient, workflowSessionId: string, senderSessionId: string)
        : Promise<{ live: boolean; authority: TypedInputAuthority }> {
        const locked = await this.lockSessionPair(client, workflowSessionId, senderSessionId);
        return {
            live: locked.workflow !== null && !locked.workflow.deleted,
            authority: decideTypedInputAuthority({ workflow: locked.workflow, definition: locked.definition, sender: locked.other, senderSessionId }),
        };
    }

    /**
     * The locks and reads of lockInputSessions, without a rule applied: the
     * workflow's session row FOR NO KEY UPDATE and the other session's FOR
     * SHARE, in ascending session id order before any definition, run or
     * node row; then both sessions with their owners in one statement, and
     * the workflow's definition parent. A row the locks did not find is null.
     */
    private async lockSessionPair(client: PoolClient, workflowSessionId: string, otherSessionId: string)
        : Promise<{ workflow: AuthoritySession | null; other: AuthoritySession | null; definition: { parentSessionId: string | null } | null }> {
        const locked = new Set<string>();
        for (const sessionId of [...new Set([workflowSessionId, otherSessionId])].sort()) {
            const { rows } = await client.query(
                `SELECT 1 FROM ${this.t.sessions} WHERE session_id = $1 FOR ${sessionId === workflowSessionId ? "NO KEY UPDATE" : "SHARE"}`, [sessionId]);
            if (rows[0]) locked.add(sessionId);
        }
        const { rows } = await client.query(
            `SELECT s.session_id, s.deleted_at, s.is_system, s.session_kind, s.parent_session_id,
                    u.provider AS owner_provider, u.subject AS owner_subject
               FROM ${this.t.sessions} s
               LEFT JOIN ${this.t.sessionOwners} so ON so.session_id = s.session_id
               LEFT JOIN ${this.t.users} u ON u.user_id = so.user_id
              WHERE s.session_id = ANY($1::text[])`, [[...locked]]);
        const found = new Map<string, AuthoritySession>(rows.map(row => [str(row, "session_id"), authoritySessionFrom(row)] as [string, AuthoritySession]));
        const { rows: definitions } = await client.query(
            `SELECT parent_session_id FROM ${this.t.definitions} WHERE workflow_session_id = $1`, [workflowSessionId]);
        return {
            workflow: found.get(workflowSessionId) ?? null,
            other: found.get(otherSessionId) ?? null,
            definition: definitions[0] ? { parentSessionId: strOrNull(definitions[0], "parent_session_id") } : null,
        };
    }

    /**
     * Whether a send state may send to its recipient, and what the recipient
     * is, after lockInputSessions locked both session rows and decided the
     * recipient by the rule a sender is decided by (authority.ts: the
     * workflow's trusted parent, or a session of the same user; a missing or
     * deleted session is unavailable). A refusal of that rule stands. A
     * workflow session is a workflow recipient (typed input for one of its
     * receive states); every other session is an agent recipient. No session
     * state is read here: an idle session, or one whose turn completed, still
     * takes messages, and whether an agent session's orchestration has ended
     * is the runtime's to say when a delivery is attempted (beginDelivery).
     */
    private async recipientDecision(client: PoolClient, authority: TypedInputAuthority, recipientSessionId: string)
        : Promise<{ refusal: RecipientRefusal; kind: null } | { refusal: null; kind: RecipientKind }> {
        if (authority !== "allowed") return { refusal: authority, kind: null };
        const { rows } = await client.query(`SELECT session_kind FROM ${this.t.sessions} WHERE session_id = $1`, [recipientSessionId]);
        if (!rows[0]) return { refusal: "unavailable", kind: null };
        return { refusal: null, kind: str(rows[0], "session_kind") === "workflow" ? "workflow" : "agent" };
    }

    /**
     * The send-state guard of acceptInput (`sendExchangeId`): the input is
     * the message of that send, and the send is still undecided. This runs
     * in acceptInput's transaction after lockInputSessions locked the
     * sending workflow's session row, and every write that decides a send
     * state or its message (a cancel or other end of its run, a deletion, a
     * delivery or its failure) takes that row first. So the send is read here
     * as one committed state, and such a decision commits wholly before this
     * acceptance (SEND_DECIDED: nothing is stored) or wholly after it (it
     * then finds this acceptance, sendAcceptanceIn).
     */
    private async requireUndecidedSend(client: PoolClient, input: {
        workflowSessionId: string; senderSessionId: string; operationId: string; contract: string; correlationText: string;
        payloadText: string; ttlSeconds: number; sendExchangeId: string;
    }): Promise<void> {
        const { rows } = await client.query(
            `SELECT sent.state AS message_state, sent.workflow_session_id, sent.recipient_session_id, sent.recipient_kind,
                    sent.contract, sent.payload_sha256, sent.correlation, node.state AS node_state, node.outcome
               FROM ${this.t.outbox} sent JOIN ${this.t.nodes} node ON node.node_execution_id = sent.node_execution_id
              WHERE sent.exchange_id = $1`, [input.sendExchangeId]);
        const row = rows[0];
        if (!row || input.operationId !== input.sendExchangeId || str(row, "workflow_session_id") !== input.senderSessionId
            || str(row, "recipient_session_id") !== input.workflowSessionId || strOrNull(row, "recipient_kind") !== "workflow"
            || str(row, "contract") !== input.contract || str(row, "payload_sha256") !== sha256Hex(input.payloadText)
            || (strOrNull(row, "correlation") ?? "{}") !== input.correlationText || input.ttlSeconds !== WORKFLOW_V2_INPUT_TTL_SECONDS) {
            throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Input ${input.operationId} is not the message of send ${input.sendExchangeId}.`);
        }
        const messageState = str(row, "message_state");
        const nodeState = str(row, "node_state");
        if (messageState !== "pending" || nodeState !== "pending") {
            const outcome = strOrNull(row, "outcome");
            throw new WorkflowStoreError("SEND_DECIDED", `The send was decided (${outcome ?? `its message ${messageState}`}) before its recipient `
                + "accepted the message; nothing was stored.", { messageState, nodeState, outcome });
        }
    }

    /**
     * A workflow recipient's acceptance of a send state's message, read in
     * the caller's transaction after it locked the sending workflow's
     * session row (so no acceptance of the message commits until that
     * transaction ends; see requireUndecidedSend). The input the recipient
     * stored under the exchange's coordinates (recipient, sending workflow,
     * operation id = exchange id) is the message's acceptance only when its
     * content is the message's: the same contract, correlation and payload
     * text, the request hash they give with the run that accepted it and the
     * send's ttl, and a stored receipt that names all of these. Any other
     * input under those coordinates ("other") is not this message's
     * acceptance and is never recorded as its delivery. The acceptance is
     * returned as stored: its run, and its accepted and expiry times.
     */
    private async sendAcceptanceIn(client: PoolClient, message: WorkflowOutboxMessage)
        : Promise<{ kind: "none" } | { kind: "other"; reason: string } | { kind: "accepted"; input: WorkflowSendInputAcceptance }> {
        const { rows: sent } = await client.query(`SELECT payload, correlation FROM ${this.t.outbox} WHERE exchange_id = $1`, [message.exchangeId]);
        if (!sent[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Send ${message.exchangeId} has no outbox message.`);
        const payloadText = str(sent[0], "payload");
        const correlationText = strOrNull(sent[0], "correlation") ?? "{}";
        const { rows } = await client.query(
            `SELECT message_id, run_id, contract, correlation, payload, request_sha256, receipt FROM ${this.t.inbox}
              WHERE workflow_session_id = $1 AND sender_session_id = $2 AND operation_id = $3`,
            [message.recipientSessionId, message.workflowSessionId, message.exchangeId]);
        const row = rows[0];
        if (!row) return { kind: "none" };
        const runId = str(row, "run_id");
        const requestSha256 = typedInputRequestSha256({ runId, contract: message.contract, correlationText, payloadText,
            ttlSeconds: WORKFLOW_V2_INPUT_TTL_SECONDS });
        if (strOrNull(row, "contract") !== message.contract || strOrNull(row, "correlation") !== correlationText
            || strOrNull(row, "payload") !== payloadText || strOrNull(row, "request_sha256") !== requestSha256) {
            return { kind: "other", reason: "the recipient holds another input under this message's id" };
        }
        const receiptText = strOrNull(row, "receipt");
        if (receiptText === null) return { kind: "other", reason: "the input under this message's id has no stored receipt" };
        const receipt = parseInputReceipt(parseStoredJson(receiptText, "receipt"));
        if (receipt.workflowSessionId !== message.recipientSessionId || receipt.senderSessionId !== message.workflowSessionId
            || receipt.operationId !== message.exchangeId || receipt.messageId !== str(row, "message_id") || receipt.runId !== runId
            || receipt.contract !== message.contract || receipt.requestSha256 !== requestSha256 || receipt.payloadSha256 !== message.payloadSha256) {
            return { kind: "other", reason: "the stored receipt under this message's id names another request" };
        }
        return { kind: "accepted", input: { messageId: receipt.messageId, runId, acceptedAt: receipt.acceptedAt, expiresAt: receipt.expiresAt,
            claimedBy: receipt.claimedBy } };
    }

    /**
     * Record a send state's delivery in the caller's transaction, which holds
     * the sending workflow's session lock and the pending message row: the
     * message from pending to delivered with its receipt, and, when the
     * workflow is live and the state still pending, the state from pending
     * to sent with the receipt as its output and the projection's events.
     * One reading of the store's clock is the receipt's deliveredAt and the
     * state's completed_at. A state decided first keeps its result.
     */
    private async deliverIn(client: PoolClient, workflowSessionId: string, live: boolean, message: WorkflowOutboxMessage,
        delivery: { stateId: string; clientMessageId: string | null; input: WorkflowSendInputAcceptance | null },
        projection?: (receipt: WorkflowSendReceipt) => SessionProjection)
        : Promise<{ won: boolean; node: WorkflowNodeExecutionRow; message: WorkflowOutboxMessage }> {
        const nodeExecutionId = message.nodeExecutionId;
        const { rows: clock } = await client.query(`WITH c AS (SELECT clock_timestamp() AS at) SELECT at::text AS at, ${isoUtc("at")} AS iso FROM c`);
        const receipt: WorkflowSendReceipt = {
            exchangeId: message.exchangeId, workflowSessionId, runId: message.runId, nodeExecutionId, stateId: delivery.stateId,
            recipientSessionId: message.recipientSessionId, recipientKind: message.recipientKind, contract: message.contract,
            payloadSha256: message.payloadSha256, clientMessageId: delivery.clientMessageId, input: delivery.input,
            attempts: Math.max(message.attempts, 1), deliveredAt: str(clock[0], "iso"),
        };
        const receiptText = canonicalJson(receipt);
        const { rows: delivered } = await client.query(
            `UPDATE ${this.t.outbox} SET state = 'delivered', decided_at = $2::timestamptz, receipt = $3
              WHERE node_execution_id = $1 AND state = 'pending' RETURNING ${OUTBOX_COLUMNS}`,
            [nodeExecutionId, str(clock[0], "at"), receiptText]);
        if (!delivered[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Send ${nodeExecutionId} changed under its locks.`);
        const { rows: completed } = live ? await client.query(
            `UPDATE ${this.t.nodes}
                SET state = 'completed', outcome = $2, result_kind = 'business', output = $3, error = NULL, winner = 'delivery',
                    completed_at = $4::timestamptz
              WHERE node_execution_id = $1 AND state = 'pending' RETURNING *`,
            [nodeExecutionId, MESSAGE_SENT, receiptText, str(clock[0], "at")]) : { rows: [] };
        if (completed[0] && projection) await this.project(client, projection(receipt));
        return { won: Boolean(completed[0]), node: completed[0] ? nodeFrom(completed[0]) : await this.nodeIn(client, nodeExecutionId),
            message: outboxFrom(delivered[0]) };
    }

    /**
     * The pending messages to workflow recipients of a run that ends, decided
     * in its finishing transaction (which holds the workflow's session lock,
     * after its pending states ended): the recipient's acceptance of the
     * message, when there is one, is its delivery (the state keeps the result
     * the end gave it); otherwise none will be recorded, since the recipient
     * now refuses a fresh input for it (requireUndecidedSend), and the message
     * fails. A message to an agent session stays pending: an attempt may be
     * queuing it, and records it if so.
     */
    private async decidePendingSendsIn(client: PoolClient, workflowSessionId: string, runId: string): Promise<void> {
        const { rows } = await client.query(
            `SELECT ${OUTBOX_COLUMNS} FROM ${this.t.outbox}
              WHERE run_id = $1 AND mode = 'send' AND state = 'pending' AND recipient_kind = 'workflow' ORDER BY exchange_id FOR UPDATE`, [runId]);
        for (const row of rows) {
            const message = outboxFrom(row);
            const node = await this.nodeIn(client, message.nodeExecutionId);
            const accepted = await this.sendAcceptanceIn(client, message);
            if (accepted.kind === "accepted") {
                await this.deliverIn(client, workflowSessionId, true, message, { stateId: node.nodeId, clientMessageId: null, input: accepted.input });
                continue;
            }
            await client.query(
                `UPDATE ${this.t.outbox} SET state = 'failed', decided_at = clock_timestamp(), error = $2
                  WHERE node_execution_id = $1 AND state = 'pending'`,
                [message.nodeExecutionId, undeliveredErrorText(node.outcome, message.attempts)]);
        }
    }

    private async nodeIn(client: PoolClient, nodeExecutionId: string): Promise<WorkflowNodeExecutionRow> {
        const { rows } = await client.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id = $1`, [nodeExecutionId]);
        if (!rows[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Node execution ${nodeExecutionId} is missing.`);
        return nodeFrom(rows[0]);
    }

    private async requireLiveSession(client: PoolClient, workflowSessionId: string): Promise<void> {
        if (!await this.lockLiveSession(client, workflowSessionId)) {
            throw new WorkflowStoreError("WORKFLOW_DELETED", `Workflow session ${workflowSessionId} was deleted or does not exist.`);
        }
    }

    /** The workflow that owns a run (an immutable column, read before any lock). */
    private async workflowOfRun(client: PoolClient, runId: string): Promise<string> {
        const { rows } = await client.query(`SELECT workflow_session_id FROM ${this.t.runs} WHERE run_id = $1`, [runId]);
        if (!rows[0]) throw new WorkflowStoreError("RUN_NOT_FOUND", `Workflow run ${runId} does not exist.`);
        return str(rows[0], "workflow_session_id");
    }

    /** The workflow that owns a node execution (immutable columns, read before any lock). */
    private async workflowOfNode(client: PoolClient, nodeExecutionId: string): Promise<string> {
        const { rows } = await client.query(
            `SELECT run.workflow_session_id FROM ${this.t.nodes} node JOIN ${this.t.runs} run ON run.run_id = node.run_id
              WHERE node.node_execution_id = $1`, [nodeExecutionId]);
        if (!rows[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Node execution ${nodeExecutionId} does not exist.`);
        return str(rows[0], "workflow_session_id");
    }

    private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        let released = false;
        try {
            await client.query("BEGIN");
            const result = await work(client);
            await client.query("COMMIT");
            return result;
        } catch (error) {
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                // A connection that cannot roll back is destroyed, not returned to the pool.
                released = true;
                client.release(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
            }
            throw error;
        } finally {
            if (!released) client.release();
        }
    }

    private async project(client: PoolClient, projection: SessionProjection | undefined): Promise<void> {
        if (!projection) return;
        const events = (projection.events ?? []).map(event => ({ eventType: event.eventType, data: jsonbSafeValue(event.data) }));
        if (events.length > 0) {
            await client.query(`SELECT ${this.t.recordEvents}($1, $2, $3)`, [projection.sessionId, JSON.stringify(events), null]);
        }
        const update = projection.update;
        if (update) {
            const updates: Record<string, string | boolean | null> = {};
            if (update.state !== undefined) updates.state = update.state;
            if (update.title !== undefined) updates.title = jsonbSafeText(update.title, 200);
            if (update.titleLocked !== undefined) updates.titleLocked = update.titleLocked;
            if (update.lastError !== undefined) updates.lastError = update.lastError === null ? null : jsonbSafeText(update.lastError, 4_000);
            if (update.orchestrationId !== undefined) updates.orchestrationId = update.orchestrationId;
            if (update.touch) updates.lastActiveAt = new Date().toISOString();
            if (Object.keys(updates).length > 0) {
                await client.query(`SELECT ${this.t.updateSession}($1, $2)`, [projection.sessionId, JSON.stringify(updates)]);
            }
        }
    }

    private async lockDefinition(client: PoolClient, workflowSessionId: string): Promise<WorkflowDefinitionRow> {
        const { rows } = await client.query(`SELECT * FROM ${this.t.definitions} WHERE workflow_session_id = $1 FOR UPDATE`, [workflowSessionId]);
        if (!rows[0]) throw new WorkflowStoreError("WORKFLOW_NOT_FOUND", `Workflow ${workflowSessionId} has no v2 definition.`);
        return definitionFrom(rows[0]);
    }

    /**
     * A stored receipt for this operation, or null. Throws OPERATION_CONFLICT
     * for a different request with the same id. A receipt keeps the request
     * digest it was written with; `requestSha256` may list the digests of
     * every fingerprint version that describes this same request
     * (WORKFLOW_V2_CREATE_FINGERPRINT in service.ts).
     */
    private async priorReceipt(client: PoolClient, workflowSessionId: string, operationId: string, kind: string, requestSha256: string | readonly string[]): Promise<WorkflowDefinitionReceipt | null> {
        const accepted: readonly string[] = typeof requestSha256 === "string" ? [requestSha256] : requestSha256;
        const { rows } = await client.query(
            `SELECT kind, request_sha256, receipt FROM ${this.t.operations} WHERE workflow_session_id = $1 AND operation_id = $2`,
            [workflowSessionId, operationId],
        );
        if (!rows[0]) return null;
        if (str(rows[0], "kind") !== kind || !accepted.includes(str(rows[0], "request_sha256"))) {
            throw new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${operationId} was already used for a different request.`,
                { operationId, storedKind: str(rows[0], "kind") });
        }
        return parseDefinitionReceipt(parseStoredJson(str(rows[0], "receipt"), "receipt"));
    }

    private async recordReceipt(client: PoolClient, workflowSessionId: string, operationId: string, kind: string, requestSha256: string, receipt: unknown): Promise<void> {
        await client.query(
            `INSERT INTO ${this.t.operations} (workflow_session_id, operation_id, kind, request_sha256, receipt) VALUES ($1, $2, $3, $4, $5)`,
            [workflowSessionId, operationId, kind, requestSha256, canonicalJson(receipt)],
        );
    }

    /**
     * The stored receipt of an operation that is not a definition change
     * (recover), or null. Throws OPERATION_CONFLICT when the id was used for a
     * different request.
     */
    async readOperationReceipt(workflowSessionId: string, operationId: string, kind: string, requestSha256: string): Promise<JsonValue | null> {
        const { rows } = await this.pool.query(
            `SELECT kind, request_sha256, receipt FROM ${this.t.operations} WHERE workflow_session_id = $1 AND operation_id = $2`,
            [workflowSessionId, operationId],
        );
        if (!rows[0]) return null;
        if (str(rows[0], "kind") !== kind || str(rows[0], "request_sha256") !== requestSha256) {
            throw new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${operationId} was already used for a different request.`,
                { operationId, storedKind: str(rows[0], "kind") });
        }
        return parseStoredJson(str(rows[0], "receipt"), "receipt");
    }

    /**
     * Store an operation's receipt once. When the same id was stored first
     * (a concurrent repeat of the request), that receipt is returned instead.
     */
    async recordOperationReceipt(workflowSessionId: string, operationId: string, kind: string, requestSha256: string, receipt: JsonValue)
        : Promise<StoredOperation<JsonValue>> {
        const { rows } = await this.pool.query(
            `INSERT INTO ${this.t.operations} (workflow_session_id, operation_id, kind, request_sha256, receipt) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (workflow_session_id, operation_id) DO NOTHING RETURNING operation_id`,
            [workflowSessionId, operationId, kind, requestSha256, canonicalJson(receipt)],
        );
        if (rows[0]) return { receipt, replayed: false };
        const stored = await this.readOperationReceipt(workflowSessionId, operationId, kind, requestSha256);
        if (stored === null) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Operation ${operationId} has no stored receipt.`);
        return { receipt: stored, replayed: true };
    }

    /**
     * Inside a transaction: store an operation's receipt, or throw
     * OPERATION_CONFLICT (which rolls the transaction back) when the id
     * already has one; the caller then reads that receipt.
     */
    private async insertReceiptOnce(client: PoolClient, workflowSessionId: string, receipt: OperationReceiptInput): Promise<void> {
        const { rows } = await client.query(
            `INSERT INTO ${this.t.operations} (workflow_session_id, operation_id, kind, request_sha256, receipt) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (workflow_session_id, operation_id) DO NOTHING RETURNING operation_id`,
            [workflowSessionId, receipt.operationId, receipt.kind, receipt.requestSha256, canonicalJson(receipt.value)]);
        if (!rows[0]) {
            throw new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${receipt.operationId} already has a receipt.`,
                { operationId: receipt.operationId });
        }
    }

    /**
     * The intent of a recover that dispatches a run its controller never
     * began (admitted, or paused before it began), stored before the
     * dispatch: its receipt and its projection in one transaction, only
     * while the run is still not begun and its session is live. The caller
     * starts the controller after this commits, and a repeat of the request
     * starts it again (duroxide ignores a second start of an instance), so
     * the stored receipt never disagrees with the dispatch its request made.
     */
    async recordRecoverDispatch(input: { runId: string; receipt: OperationReceiptInput; projection: SessionProjection })
        : Promise<{ recorded: boolean; run: WorkflowRunRow }> {
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfRun(client, input.runId));
            const run = await this.lockRun(client, input.runId);
            if (!live || !runNotBegun(run)) return { recorded: false, run };
            await this.insertReceiptOnce(client, run.workflowSessionId, input.receipt);
            await this.project(client, input.projection);
            return { recorded: true, run };
        });
    }

    private async insertRevision(client: PoolClient, workflowSessionId: string, revision: number, yaml: string, compiled: WorkflowCompileResult, actor: WorkflowActor): Promise<void> {
        await client.query(
            `INSERT INTO ${this.t.revisions}
                (workflow_session_id, revision, yaml, yaml_sha256, valid, diagnostics, name, semver, ir, ir_sha256, actor)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [workflowSessionId, revision, yaml, compiled.yamlSha256, compiled.valid, canonicalJson(compiled.diagnostics),
                compiled.name, compiled.version, compiled.ir ? canonicalJson(compiled.ir) : null, compiled.irSha256,
                canonicalJson(actor)],
        );
    }

    private async readRevisionRow(client: PoolClient, workflowSessionId: string, revision: number): Promise<WorkflowRevisionRow> {
        const { rows } = await client.query(`SELECT * FROM ${this.t.revisions} WHERE workflow_session_id = $1 AND revision = $2`, [workflowSessionId, revision]);
        if (!rows[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Revision ${revision} of ${workflowSessionId} is missing.`);
        return revisionFrom(rows[0]);
    }

    private async insertRun(client: PoolClient, definition: WorkflowDefinitionRow, revision: WorkflowRevisionRow, start: RunAdmission, operationId: string): Promise<WorkflowRunReceipt> {
        if (!revision.valid || !revision.irSha256) throw new WorkflowStoreError("DEFINITION_INVALID", "Only a valid revision can run.");
        if (start.mode === "live") {
            const { rows } = await client.query(
                `SELECT run_id FROM ${this.t.runs} WHERE workflow_session_id = $1 AND mode = 'live'`, [definition.workflowSessionId]);
            if (rows[0]) {
                throw new WorkflowStoreError("LIVE_RUN_EXISTS", "This workflow already has its live run; a new live run needs a new workflow child.",
                    { runId: str(rows[0], "run_id") });
            }
        }
        await client.query(
            `INSERT INTO ${this.t.runs}
                (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, test_agent_mode, start_operation_id, kv, kv_revision)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'admitted', $9, $10, $11, 1)`,
            [start.runId, definition.workflowSessionId, start.mode, revision.revision, revision.yamlSha256, revision.irSha256,
                start.inputsText, start.controllerInstanceId, start.mode === "test" ? start.testAgentMode : null, operationId, start.kvText],
        );
        await client.query(`INSERT INTO ${this.t.kvRevisions} (run_id, revision, kv, operation_id) VALUES ($1, 1, $2, $3)`,
            [start.runId, start.kvText, operationId]);
        if (start.mode === "live") {
            await client.query(`SELECT ${this.t.updateSession}($1, $2)`,
                [definition.workflowSessionId, JSON.stringify({ orchestrationId: start.controllerInstanceId })]);
        }
        return { runId: start.runId, mode: start.mode, controllerInstanceId: start.controllerInstanceId, revision: revision.revision, irSha256: revision.irSha256 };
    }

    private receiptFor(operation: string, definition: WorkflowDefinitionRow, revision: WorkflowRevisionRow, run: WorkflowRunReceipt | null): WorkflowDefinitionReceipt {
        return {
            workflowSessionId: definition.workflowSessionId, operation, state: definition.state, revision: revision.revision,
            yamlSha256: revision.yamlSha256, valid: revision.valid, irSha256: revision.irSha256, diagnostics: revision.diagnostics,
            publishedRevision: definition.publishedRevision, run,
        };
    }

    /**
     * Create the definition with revision 1, optionally publishing it and
     * admitting its live run in the same transaction.
     */
    async createDefinition(input: {
        workflowSessionId: string;
        parentSessionId: string | null;
        notifyParent: boolean;
        yaml: string;
        compiled: WorkflowCompileResult;
        actor: WorkflowActor;
        operationId: string;
        requestSha256: string;
        /** Digests a stored receipt of this same request may carry (earlier fingerprint versions); default: requestSha256. */
        acceptedRequestSha256?: readonly string[];
        publish: boolean;
        start: RunAdmission | null;
        /** Session title, written with the definition under the session lock. */
        title: string;
    }): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
        if ((input.publish || input.start) && !input.compiled.valid) {
            throw new WorkflowStoreError("DEFINITION_INVALID", "An invalid definition can be saved as a draft but not published or started.",
                { diagnostics: diagnosticsJson(input.compiled.diagnostics) });
        }
        if (input.start && !input.publish) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "Starting a live run requires publication.");
        return this.transaction(async client => {
            await this.requireLiveSession(client, input.workflowSessionId);
            const created = await client.query(
                `INSERT INTO ${this.t.definitions}
                    (workflow_session_id, parent_session_id, api_version, semver, state, current_revision, notify_parent)
                 VALUES ($1, $2, $3, $4, 'draft', 1, $5)
                 ON CONFLICT (workflow_session_id) DO NOTHING
                 RETURNING workflow_session_id`,
                [input.workflowSessionId, input.parentSessionId, WORKFLOW_V2_API_VERSION, input.compiled.version, input.notifyParent],
            );
            if (!created.rows[0]) {
                await this.lockDefinition(client, input.workflowSessionId);
                const prior = await this.priorReceipt(client, input.workflowSessionId, input.operationId, "create", input.acceptedRequestSha256 ?? input.requestSha256);
                if (prior) return { receipt: prior, replayed: true };
                throw new WorkflowStoreError("WORKFLOW_EXISTS", `Workflow ${input.workflowSessionId} already exists with a different creation request.`);
            }
            await this.insertRevision(client, input.workflowSessionId, 1, input.yaml, input.compiled, input.actor);
            let definition = await this.lockDefinition(client, input.workflowSessionId);
            let run: WorkflowRunReceipt | null = null;
            if (input.publish) {
                const { rows } = await client.query(
                    `UPDATE ${this.t.definitions}
                        SET state = 'published', published_revision = 1, published_yaml_sha256 = $2, published_ir_sha256 = $3,
                            published_at = now(), updated_at = now()
                      WHERE workflow_session_id = $1 RETURNING *`,
                    [input.workflowSessionId, input.compiled.yamlSha256, input.compiled.irSha256],
                );
                definition = definitionFrom(rows[0]);
            }
            const revision = await this.readRevisionRow(client, input.workflowSessionId, 1);
            if (input.start) run = await this.insertRun(client, definition, revision, input.start, input.operationId);
            await this.project(client, { sessionId: input.workflowSessionId, update: { title: input.title, titleLocked: true } });
            const receipt = this.receiptFor("create", definition, revision, run);
            await this.recordReceipt(client, input.workflowSessionId, input.operationId, "create", input.requestSha256, receipt);
            return { receipt, replayed: false };
        });
    }

    /** Replace a draft's YAML at the expected revision (one semantic version per workflow child). */
    async replaceDraft(input: {
        workflowSessionId: string;
        expectedRevision: number;
        yaml: string;
        compiled: WorkflowCompileResult;
        declaredSemver: string | null;
        actor: WorkflowActor;
        operationId: string;
        requestSha256: string;
        title: string;
    }): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
        return this.transaction(async client => {
            await this.requireLiveSession(client, input.workflowSessionId);
            const definition = await this.lockDefinition(client, input.workflowSessionId);
            const prior = await this.priorReceipt(client, input.workflowSessionId, input.operationId, "replace_definition", input.requestSha256);
            if (prior) return { receipt: prior, replayed: true };
            assertNotDeleted(definition);
            if (definition.state === "published") {
                throw new WorkflowStoreError("DEFINITION_IMMUTABLE", "A published definition cannot change; create a new workflow child for a new version.",
                    { publishedRevision: definition.publishedRevision });
            }
            if (definition.currentRevision !== input.expectedRevision) {
                throw new WorkflowStoreError("REVISION_CONFLICT", `The draft is at revision ${definition.currentRevision}, not ${input.expectedRevision}.`,
                    { currentRevision: definition.currentRevision });
            }
            if (definition.semver && input.declaredSemver && definition.semver !== input.declaredSemver) {
                throw new WorkflowStoreError("SEMVER_IMMUTABLE", `This workflow child is version ${definition.semver}; a new version needs a new workflow child.`,
                    { semver: definition.semver });
            }
            const nextRevision = definition.currentRevision + 1;
            await this.insertRevision(client, input.workflowSessionId, nextRevision, input.yaml, input.compiled, input.actor);
            const { rows } = await client.query(
                `UPDATE ${this.t.definitions}
                    SET current_revision = $2, semver = COALESCE(semver, $3), updated_at = now()
                  WHERE workflow_session_id = $1 RETURNING *`,
                [input.workflowSessionId, nextRevision, input.declaredSemver],
            );
            const updated = definitionFrom(rows[0]);
            await this.project(client, { sessionId: input.workflowSessionId, update: { title: input.title, titleLocked: true } });
            const receipt = this.receiptFor("replace_definition", updated, await this.readRevisionRow(client, input.workflowSessionId, nextRevision), null);
            await this.recordReceipt(client, input.workflowSessionId, input.operationId, "replace_definition", input.requestSha256, receipt);
            return { receipt, replayed: false };
        });
    }

    /** Publish the exact reviewed draft revision; optionally admit its live run atomically. */
    async publish(input: {
        workflowSessionId: string;
        expectedRevision: number;
        definitionHash: string;
        operationId: string;
        requestSha256: string;
        start: RunAdmission | null;
    }): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
        const kind = input.start ? "publish_and_start" : "publish";
        return this.transaction(async client => {
            await this.requireLiveSession(client, input.workflowSessionId);
            const definition = await this.lockDefinition(client, input.workflowSessionId);
            const prior = await this.priorReceipt(client, input.workflowSessionId, input.operationId, kind, input.requestSha256);
            if (prior) return { receipt: prior, replayed: true };
            assertNotDeleted(definition);
            if (definition.state === "published") {
                throw new WorkflowStoreError("DEFINITION_IMMUTABLE", "This workflow is already published.", { publishedRevision: definition.publishedRevision });
            }
            if (definition.currentRevision !== input.expectedRevision) {
                throw new WorkflowStoreError("REVISION_CONFLICT", `The draft is at revision ${definition.currentRevision}, not ${input.expectedRevision}.`,
                    { currentRevision: definition.currentRevision });
            }
            const revision = await this.readRevisionRow(client, input.workflowSessionId, input.expectedRevision);
            if (!revision.valid || !revision.irSha256) {
                throw new WorkflowStoreError("DEFINITION_INVALID", "Revision has compile errors; fix them before publishing.",
                    { diagnostics: diagnosticsJson(revision.diagnostics) });
            }
            if (revision.yamlSha256 !== input.definitionHash) {
                throw new WorkflowStoreError("DEFINITION_HASH_MISMATCH", "The definition hash does not match the reviewed revision.",
                    { revision: revision.revision, yamlSha256: revision.yamlSha256 });
            }
            const { rows } = await client.query(
                `UPDATE ${this.t.definitions}
                    SET state = 'published', published_revision = $2, published_yaml_sha256 = $3, published_ir_sha256 = $4,
                        published_at = now(), updated_at = now()
                  WHERE workflow_session_id = $1 RETURNING *`,
                [input.workflowSessionId, revision.revision, revision.yamlSha256, revision.irSha256],
            );
            const published = definitionFrom(rows[0]);
            const run = input.start ? await this.insertRun(client, published, revision, input.start, input.operationId) : null;
            const receipt = this.receiptFor(kind, published, revision, run);
            await this.recordReceipt(client, input.workflowSessionId, input.operationId, kind, input.requestSha256, receipt);
            return { receipt, replayed: false };
        });
    }

    /** Admit the live run of a published definition. */
    async startLive(input: {
        workflowSessionId: string;
        definitionHash: string;
        operationId: string;
        requestSha256: string;
        start: RunAdmission;
    }): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
        return this.transaction(async client => {
            await this.requireLiveSession(client, input.workflowSessionId);
            const definition = await this.lockDefinition(client, input.workflowSessionId);
            const prior = await this.priorReceipt(client, input.workflowSessionId, input.operationId, "start", input.requestSha256);
            if (prior) return { receipt: prior, replayed: true };
            assertNotDeleted(definition);
            if (definition.state !== "published" || definition.publishedRevision === null) {
                throw new WorkflowStoreError("NOT_PUBLISHED", "Publish the exact reviewed revision before starting its live run.");
            }
            if (definition.publishedYamlSha256 !== input.definitionHash) {
                throw new WorkflowStoreError("DEFINITION_HASH_MISMATCH", "The definition hash does not match the published revision.",
                    { publishedRevision: definition.publishedRevision, yamlSha256: definition.publishedYamlSha256 });
            }
            const revision = await this.readRevisionRow(client, input.workflowSessionId, definition.publishedRevision);
            const run = await this.insertRun(client, definition, revision, input.start, input.operationId);
            const receipt = this.receiptFor("start", definition, revision, run);
            await this.recordReceipt(client, input.workflowSessionId, input.operationId, "start", input.requestSha256, receipt);
            return { receipt, replayed: false };
        });
    }

    /** The open KV map of a run at one revision (immutable). */
    async readKv(runId: string, revision: number): Promise<JsonValue> {
        const { rows } = await this.pool.query(`SELECT kv FROM ${this.t.kvRevisions} WHERE run_id = $1 AND revision = $2`, [runId, revision]);
        if (!rows[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Run ${runId} has no KV revision ${revision}.`);
        return parseStoredJson(str(rows[0], "kv"), "kv");
    }

    /** A stored run-command receipt (set_vars, pause, resume, cancel), when the request matches. */
    private async priorRunCommand(client: PoolClient, workflowSessionId: string, operationId: string, kind: string, requestSha256: string): Promise<WorkflowRunCommandReceipt | null> {
        const { rows } = await client.query(
            `SELECT kind, request_sha256, receipt FROM ${this.t.operations} WHERE workflow_session_id = $1 AND operation_id = $2`,
            [workflowSessionId, operationId]);
        if (!rows[0]) return null;
        if (str(rows[0], "kind") !== kind || str(rows[0], "request_sha256") !== requestSha256) {
            throw new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${operationId} was already used for a different request.`,
                { operationId, storedKind: str(rows[0], "kind") });
        }
        return parseRunCommandReceipt(parseStoredJson(str(rows[0], "receipt"), "receipt"));
    }

    /**
     * Apply one atomic set/delete batch to a run's open KV at the expected
     * revision. The result is a new immutable revision; a node admitted later
     * pins it, one already admitted keeps its own. Limits apply to the whole
     * resulting map; nothing is applied when any limit or the revision fails.
     */
    async setRunVars(input: {
        workflowSessionId: string;
        runId: string;
        set: { [key: string]: JsonValue };
        delete: string[];
        expectedRevision: number;
        operationId: string;
        requestSha256: string;
        actor: WorkflowActor;
    }): Promise<StoredOperation<WorkflowRunCommandReceipt>> {
        return this.transaction(async client => {
            if (!await this.lockLiveSession(client, input.workflowSessionId)) throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow was deleted.");
            await this.lockDefinition(client, input.workflowSessionId);
            const prior = await this.priorRunCommand(client, input.workflowSessionId, input.operationId, "set_vars", input.requestSha256);
            if (prior) return { receipt: prior, replayed: true };
            const run = await this.lockRun(client, input.runId);
            if (run.workflowSessionId !== input.workflowSessionId) throw new WorkflowStoreError("RUN_NOT_FOUND", `Run ${input.runId} is not a run of this workflow.`);
            if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
                throw new WorkflowStoreError("RUN_ENDED", `Run ${run.runId} has ended (${run.status}); its KV no longer changes.`, { status: run.status });
            }
            if (run.kvRevision !== input.expectedRevision) {
                throw new WorkflowStoreError("KV_REVISION_CONFLICT", `The run's KV is at revision ${run.kvRevision}, not ${input.expectedRevision}.`,
                    { kvRevision: run.kvRevision });
            }
            const current: { [key: string]: JsonValue } = isJsonObject(run.kv) ? run.kv : {};
            const replaced = new Set([...input.delete, ...Object.keys(input.set)]);
            // fromEntries defines own properties, so any valid key ("__proto__"
            // included) stays plain data; assignment would call the prototype setter.
            const next: { [key: string]: JsonValue } = Object.fromEntries([
                ...Object.entries(current).filter(([key]) => !replaced.has(key)),
                ...Object.entries(input.set),
            ]);
            const kvText = checkedKvText(next);
            const revision = run.kvRevision + 1;
            await client.query(`UPDATE ${this.t.runs} SET kv = $2, kv_revision = $3, updated_at = now() WHERE run_id = $1`, [run.runId, kvText, revision]);
            await client.query(`INSERT INTO ${this.t.kvRevisions} (run_id, revision, kv, operation_id) VALUES ($1, $2, $3, $4)`,
                [run.runId, revision, kvText, input.operationId]);
            await this.project(client, { sessionId: input.workflowSessionId, events: [{ eventType: "workflow.vars_set", data: {
                runId: run.runId, kvRevision: revision, set: Object.keys(input.set), deleted: input.delete, actor: actorJson(input.actor),
            } }], update: { touch: true } });
            const receipt: WorkflowRunCommandReceipt = { workflowSessionId: input.workflowSessionId, operation: "set_vars", runId: run.runId, status: run.status, kvRevision: revision };
            await this.recordReceipt(client, input.workflowSessionId, input.operationId, "set_vars", input.requestSha256, receipt);
            return { receipt, replayed: false };
        });
    }

    /**
     * Pause or resume a run. A paused run admits no new node execution; work
     * already admitted finishes and its result is kept, and a cancel, a
     * deletion and KV updates still apply. Resume returns to the status the
     * run was paused from.
     */
    async setRunPaused(input: {
        workflowSessionId: string;
        runId: string;
        pause: boolean;
        operationId: string;
        requestSha256: string;
        actor: WorkflowActor;
        reason: string | null;
    }): Promise<StoredOperation<WorkflowRunCommandReceipt>> {
        const kind = input.pause ? "pause" : "resume";
        return this.transaction(async client => {
            if (!await this.lockLiveSession(client, input.workflowSessionId)) throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow was deleted.");
            await this.lockDefinition(client, input.workflowSessionId);
            const prior = await this.priorRunCommand(client, input.workflowSessionId, input.operationId, kind, input.requestSha256);
            if (prior) return { receipt: prior, replayed: true };
            const run = await this.lockRun(client, input.runId);
            if (run.workflowSessionId !== input.workflowSessionId) throw new WorkflowStoreError("RUN_NOT_FOUND", `Run ${input.runId} is not a run of this workflow.`);
            if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
                throw new WorkflowStoreError("RUN_ENDED", `Run ${run.runId} has ended (${run.status}).`, { status: run.status });
            }
            let rows: Row[];
            if (input.pause) {
                if (run.status === "paused") throw new WorkflowStoreError("RUN_ALREADY_PAUSED", `Run ${run.runId} is already paused.`);
                ({ rows } = await client.query(
                    `UPDATE ${this.t.runs} SET status = 'paused', paused_from = status, updated_at = now() WHERE run_id = $1 RETURNING *`, [run.runId]));
            } else {
                if (run.status !== "paused") throw new WorkflowStoreError("RUN_NOT_PAUSED", `Run ${run.runId} is not paused (${run.status}).`, { status: run.status });
                ({ rows } = await client.query(
                    `UPDATE ${this.t.runs} SET status = paused_from, paused_from = NULL, updated_at = now() WHERE run_id = $1 RETURNING *`, [run.runId]));
            }
            const updated = runFrom(rows[0]);
            await this.project(client, { sessionId: input.workflowSessionId, events: [{
                eventType: input.pause ? "workflow.paused" : "workflow.resumed",
                data: { runId: run.runId, actor: actorJson(input.actor), ...(input.reason ? { reason: jsonbSafeText(input.reason, 500) } : {}) },
            }], update: { state: updated.status === "paused" ? "waiting" : updated.status === "admitted" ? "pending" : "running", touch: true } });
            const receipt: WorkflowRunCommandReceipt = { workflowSessionId: input.workflowSessionId, operation: kind, runId: run.runId, status: updated.status, kvRevision: updated.kvRevision };
            await this.recordReceipt(client, input.workflowSessionId, input.operationId, kind, input.requestSha256, receipt);
            return { receipt, replayed: false };
        });
    }

    /**
     * Record that a cancel command was accepted for a run. A run that has not
     * begun (admitted, or paused before its controller began it) is ended
     * here, at once, as cancelled, with this request's operation id in its
     * terminal error: its controller may not exist yet, and duroxide drops a
     * queue message sent to an instance that has not started, so a command
     * could be lost. The run end, its projection and the receipt commit in
     * one transaction. A controller that starts later finds the run ended at
     * begin (begin and this transaction both lock the session row, then the
     * run row). A run that has begun is returned as it is: its controller,
     * which began it, applies the command, and the caller sends it while the
     * run is active, on a replay too (a crash after this receipt and before
     * the send must not lose it).
     *
     * The receipt is the accept-time result: the run's status and KV revision
     * when the cancel was accepted. It is stored once and never rewritten; a
     * repeat returns it as stored, and read_workflow shows the run as it is
     * now. A repeat of a cancel accepted by an earlier build, for a run that
     * still has not begun (its command may have been dropped), ends the run
     * now, as that accepted cancel requires; its receipt stays as stored.
     */
    async recordRunCancelRequest(input: {
        workflowSessionId: string;
        runId: string;
        operationId: string;
        requestSha256: string;
        reason: string;
        requestedBy: string | null;
    }): Promise<StoredOperation<WorkflowRunCommandReceipt> & { run: WorkflowRunRow }> {
        return this.transaction(async client => {
            if (!await this.lockLiveSession(client, input.workflowSessionId)) throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow was deleted.");
            await this.lockDefinition(client, input.workflowSessionId);
            const prior = await this.priorRunCommand(client, input.workflowSessionId, input.operationId, "cancel", input.requestSha256);
            const run = await this.lockRun(client, input.runId);
            if (run.workflowSessionId !== input.workflowSessionId) throw new WorkflowStoreError("RUN_NOT_FOUND", `Run ${input.runId} is not a run of this workflow.`);
            if (prior) {
                // The request hash names the run, so the stored receipt is this run's.
                const current = runNotBegun(run) ? await this.cancelBeforeBegin(client, run, input, true) : run;
                return { receipt: prior, replayed: true, run: current };
            }
            const current = runNotBegun(run) ? await this.cancelBeforeBegin(client, run, input, false) : run;
            const receipt: WorkflowRunCommandReceipt = { workflowSessionId: input.workflowSessionId, operation: "cancel", runId: run.runId, status: current.status, kvRevision: current.kvRevision };
            await this.recordReceipt(client, input.workflowSessionId, input.operationId, "cancel", input.requestSha256, receipt);
            return { receipt, replayed: false, run: current };
        });
    }

    /**
     * End a run that has not begun as cancelled, inside the caller's
     * transaction (which holds the session and run locks), with its
     * projection. `repaired` marks a repeat of a cancel accepted earlier
     * whose command did not end the run.
     */
    private async cancelBeforeBegin(client: PoolClient, run: WorkflowRunRow,
        input: { workflowSessionId: string; operationId: string; reason: string; requestedBy: string | null; command?: "cancel" | "done"; attributedFrom?: string },
        repaired: boolean): Promise<WorkflowRunRow> {
        const command = input.command ?? "cancel";
        const marks: { [key: string]: JsonValue } = { beforeBegin: true, operationId: input.operationId };
        if (repaired) marks.repaired = true;
        // requestedBy was not recorded with the request; it is attributed from the entry point named here.
        if (input.attributedFrom !== undefined) marks.attributedFrom = input.attributedFrom;
        const { rows } = await client.query(
            `UPDATE ${this.t.runs}
                SET status = 'cancelled', terminal_node_id = NULL, terminal_outcome = NULL, terminal_output = NULL, terminal_error = $2,
                    paused_from = NULL, updated_at = now(), finished_at = now()
              WHERE run_id = $1 RETURNING *`,
            [run.runId, canonicalJson({ code: "cancelled", message: jsonbSafeText(input.reason, 4_000), details: {
                command, requestedBy: input.requestedBy, ...marks,
            } })]);
        // No node execution exists before begin; one that did would lose to the cancel, as when the controller cancels.
        await client.query(
            `UPDATE ${this.t.nodes}
                SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error', error = $2, output = NULL,
                    winner = 'cancel', completed_at = now()
              WHERE run_id = $1 AND state = 'pending'`,
            [run.runId, canonicalJson({ code: "cancelled", message: "The workflow run was cancelled." })]);
        await this.project(client, { sessionId: input.workflowSessionId, events: [{ eventType: "workflow.cancelled", data: {
            runId: run.runId, reason: jsonbSafeText(input.reason, 500), command, ...marks,
        } }], update: { state: "cancelled", lastError: jsonbSafeText(input.reason, 500), touch: true } });
        return runFrom(rows[0]);
    }

    /**
     * Apply a lifecycle command (cancel, done or delete) that a parent's
     * durable session sent to its v2 workflow child, once per operation id,
     * in one transaction under the session, definition and run locks:
     * - delete soft-deletes the child here, whatever its run is doing: the
     *   deletion trigger (migrations 0086, 0087) tombstones the definition
     *   and ends an active run in this same transaction (its pending nodes
     *   lose to the deletion, and a running script's liveness check stops
     *   it); a run that already ended keeps its result. A delete never waits
     *   in a queue, where a run that ended first would leave it unapplied;
     * - cancel or done of a live run that has not begun ends it here, as
     *   update_workflow cancel does (done is cancel with its "Stopped" reason);
     * - cancel or done of a run that has begun is for its controller (which
     *   began it): the receipt says "queued", and the caller queues it; a run
     *   that ends first makes it moot (the first run end stands);
     * - cancel or done with no active run has nothing to apply ("none").
     * The receipt (kind session-<command>) records how it was applied and the
     * run as it was accepted; it is stored once and never rewritten. A repeat
     * returns it; a repeat of an accepted delete whose child is still live
     * (an earlier head queued deletes) deletes the child now.
     */
    async recordSessionCommand(input: {
        workflowSessionId: string;
        operationId: string;
        requestSha256: string;
        command: "cancel" | "done" | "delete";
        reason: string;
        requestedBy: string;
    }): Promise<{ receipt: WorkflowSessionCommandReceipt; replayed: boolean; run: WorkflowRunRow | null }> {
        return this.transaction(async client => {
            if (!await this.lockLiveSession(client, input.workflowSessionId)) throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow was deleted.");
            await this.lockDefinition(client, input.workflowSessionId);
            const kind = `session-${input.command}`;
            const { rows: priorRows } = await client.query(
                `SELECT kind, request_sha256, receipt FROM ${this.t.operations} WHERE workflow_session_id = $1 AND operation_id = $2`,
                [input.workflowSessionId, input.operationId]);
            if (priorRows[0] && (str(priorRows[0], "kind") !== kind || str(priorRows[0], "request_sha256") !== input.requestSha256)) {
                throw new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${input.operationId} was already used for a different request.`,
                    { operationId: input.operationId, storedKind: str(priorRows[0], "kind") });
            }
            const { rows: liveRows } = await client.query(
                `SELECT * FROM ${this.t.runs} WHERE workflow_session_id = $1 AND mode = 'live' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
                [input.workflowSessionId]);
            let run = liveRows[0] ? runFrom(liveRows[0]) : null;
            // Locks held: the session row (the soft delete updates it), the definition and the run, which the trigger updates.
            const softDelete = async (): Promise<void> => {
                await client.query(`SELECT ${this.t.softDeleteSession}($1)`, [input.workflowSessionId]);
                if (run) run = runFrom((await client.query(`SELECT * FROM ${this.t.runs} WHERE run_id = $1`, [run.runId])).rows[0]);
            };
            if (priorRows[0]) {
                const prior = parseSessionCommandReceipt(parseStoredJson(str(priorRows[0], "receipt"), "receipt"));
                // An accepted delete holds whatever the run did since; the session is live here, so it was not applied yet.
                if (prior.command === "delete") await softDelete();
                return { receipt: prior, replayed: true, run };
            }
            const begun = run !== null && ACTIVE_RUN_STATUSES.includes(run.status) && !runNotBegun(run);
            let applied: WorkflowSessionCommandReceipt["applied"];
            let status: string | null = run?.status ?? null;
            if (input.command === "delete") {
                await softDelete();
                applied = "store";
                status = "deleted";
            } else if (begun) {
                applied = "queued";
            } else if (run !== null && runNotBegun(run)) {
                run = await this.cancelBeforeBegin(client, run, { ...input, command: input.command }, false);
                applied = "store";
                status = run.status;
            } else {
                applied = "none";
            }
            const receipt: WorkflowSessionCommandReceipt = { workflowSessionId: input.workflowSessionId, command: input.command, applied, runId: run?.runId ?? null, status };
            await this.recordReceipt(client, input.workflowSessionId, input.operationId, kind, input.requestSha256, receipt);
            return { receipt, replayed: false, run };
        });
    }

    /** A session row's kind and parent, and whether it is deleted (cms_get_session hides deleted rows). */
    async readSessionLink(sessionId: string): Promise<{ sessionKind: string | null; parentSessionId: string | null; deleted: boolean } | null> {
        const { rows } = await this.pool.query(
            `SELECT session_kind, parent_session_id, deleted_at FROM ${this.t.sessions} WHERE session_id = $1`, [sessionId]);
        if (!rows[0]) return null;
        return { sessionKind: strOrNull(rows[0], "session_kind"), parentSessionId: strOrNull(rows[0], "parent_session_id"), deleted: rows[0].deleted_at !== null };
    }

    /** Record transcript events outside a transition (notifications, cleanup requests). */
    async recordSessionEvents(sessionId: string, events: SessionEventRecord[]): Promise<void> {
        if (events.length === 0) return;
        const safe = events.map(event => ({ eventType: event.eventType, data: jsonbSafeValue(event.data) }));
        await this.pool.query(`SELECT ${this.t.recordEvents}($1, $2, $3)`, [sessionId, JSON.stringify(safe), null]);
    }

    async readDefinition(workflowSessionId: string): Promise<WorkflowDefinitionRow | null> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.definitions} WHERE workflow_session_id = $1`, [workflowSessionId]);
        return rows[0] ? definitionFrom(rows[0]) : null;
    }

    async readRevision(workflowSessionId: string, revision: number): Promise<WorkflowRevisionRow | null> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.revisions} WHERE workflow_session_id = $1 AND revision = $2`, [workflowSessionId, revision]);
        return rows[0] ? revisionFrom(rows[0]) : null;
    }

    /**
     * A revision's name and version as plain columns, without parsing its IR
     * or diagnostics, so a run can end and report itself even when its IR
     * cannot be read.
     */
    async readRevisionLabel(workflowSessionId: string, revision: number): Promise<{ name: string | null; semver: string | null } | null> {
        const { rows } = await this.pool.query(
            `SELECT name, semver FROM ${this.t.revisions} WHERE workflow_session_id = $1 AND revision = $2`, [workflowSessionId, revision]);
        return rows[0] ? { name: strOrNull(rows[0], "name"), semver: strOrNull(rows[0], "semver") } : null;
    }

    /**
     * The IR of a valid revision, verified against its stored hash. IR 7 (request states) is read only when the caller
     * asks for it (parseWorkflowIr's maxIrVersion); the runtime does not.
     */
    async readRevisionIr(workflowSessionId: string, revision: number, expectedIrSha256?: string, options: { maxIrVersion?: number } = {}): Promise<WorkflowIR> {
        const { rows } = await this.pool.query(
            `SELECT ir, ir_sha256 FROM ${this.t.revisions} WHERE workflow_session_id = $1 AND revision = $2`, [workflowSessionId, revision]);
        return revisionIrFrom(rows[0], revision, expectedIrSha256, options);
    }

    /** readRevisionIr in the caller's transaction (a second connection is never needed while its locks are held). */
    private async revisionIrIn(client: PoolClient, workflowSessionId: string, revision: number, expectedIrSha256: string, options: { maxIrVersion?: number })
        : Promise<WorkflowIR> {
        const { rows } = await client.query(
            `SELECT ir, ir_sha256 FROM ${this.t.revisions} WHERE workflow_session_id = $1 AND revision = $2`, [workflowSessionId, revision]);
        return revisionIrFrom(rows[0], revision, expectedIrSha256, options);
    }

    async listRuns(workflowSessionId: string): Promise<WorkflowRunRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.runs} WHERE workflow_session_id = $1 ORDER BY created_at, run_id`, [workflowSessionId]);
        return rows.map(runFrom);
    }

    async readRun(runId: string): Promise<WorkflowRunRow | null> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.runs} WHERE run_id = $1`, [runId]);
        return rows[0] ? runFrom(rows[0]) : null;
    }

    private async lockRun(client: PoolClient, runId: string): Promise<WorkflowRunRow> {
        const { rows } = await client.query(`SELECT * FROM ${this.t.runs} WHERE run_id = $1 FOR UPDATE`, [runId]);
        if (!rows[0]) throw new WorkflowStoreError("RUN_NOT_FOUND", `Workflow run ${runId} does not exist.`);
        return runFrom(rows[0]);
    }

    /**
     * admitted -> running. Returns whether this call made the transition.
     * A cancel accepted for this run before it began still wins: an earlier
     * build queued that cancel for a controller that may not have existed,
     * and duroxide drops such a message, so a recover or a late dispatch
     * could begin the run. Begin ends it instead (as the accepted cancel
     * requires) and admits nothing. This build ends such a run when it
     * accepts the cancel, so only earlier builds' receipts reach this.
     *
     * Those receipts record no requester, and they stay as stored. Under
     * migration assumption M1 (docs/formal/workflow-v2/README.md) such a
     * receipt was written through the update_workflow tool, which admits
     * only the workflow's parent; M1 rests on the code paths of the builds
     * that wrote these receipts (ae02665a to 183bb0b0), not on the receipt's
     * bytes. The run's terminal error records the parent as requestedBy with
     * attributedFrom "update_workflow": an attributed value, not a recorded
     * one. A receipt written any other way (a test, direct SQL) is attributed
     * the same way, and the parent is then not told of that cancel.
     */
    async beginRun(runId: string, projection?: SessionProjection): Promise<{ run: WorkflowRunRow; transitioned: boolean }> {
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfRun(client, runId));
            const run = await this.lockRun(client, runId);
            if (!live) return { run, transitioned: false };
            if (runNotBegun(run)) {
                const { rows: accepted } = await client.query(
                    `SELECT operation_id FROM ${this.t.operations}
                      WHERE workflow_session_id = $1 AND kind = 'cancel' AND (receipt::jsonb ->> 'runId') = $2
                      ORDER BY created_at, operation_id LIMIT 1`, [run.workflowSessionId, runId]);
                if (accepted[0]) {
                    const { rows: definitions } = await client.query(
                        `SELECT parent_session_id FROM ${this.t.definitions} WHERE workflow_session_id = $1`, [run.workflowSessionId]);
                    const ended = await this.cancelBeforeBegin(client, run, { workflowSessionId: run.workflowSessionId,
                        operationId: str(accepted[0], "operation_id"), reason: "Cancelled before it began",
                        requestedBy: definitions[0] ? strOrNull(definitions[0], "parent_session_id") : null, attributedFrom: "update_workflow" }, true);
                    return { run: ended, transitioned: false };
                }
            }
            // A run paused before its controller began has begun now; it stays paused.
            if (run.status === "paused" && run.pausedFrom === "admitted") {
                const { rows } = await client.query(
                    `UPDATE ${this.t.runs} SET paused_from = 'running', updated_at = now() WHERE run_id = $1 RETURNING *`, [runId]);
                // The session row shows a paused workflow as waiting (the session statuses have no "paused").
                await this.project(client, projection ? { ...projection, update: { ...projection.update, state: "waiting" } } : undefined);
                return { run: runFrom(rows[0]), transitioned: true };
            }
            if (run.status !== "admitted") return { run, transitioned: false };
            const { rows } = await client.query(
                `UPDATE ${this.t.runs} SET status = 'running', updated_at = now() WHERE run_id = $1 RETURNING *`, [runId]);
            await this.project(client, projection);
            return { run: runFrom(rows[0]), transitioned: true };
        });
    }

    /**
     * Admit one node execution of an active run. Idempotent: the identity is
     * derived from the history-selected (run, scope, node, ordinal), and a
     * retry must name the same predecessor and route, and the same input
     * when it was evaluated with the same KV revision. A retry returns the
     * stored row, with its original entered_at and deadline_at.
     *
     * The admission pins the KV revision current at its commit: set_vars
     * locks this run row too, so each set_vars commits before or after the
     * admission. An admission whose input was evaluated with an earlier
     * revision is refused (kv_changed), and the caller evaluates it again.
     *
     * The admission is accepted when its insert runs: after the session and
     * run locks and the live, status and KV guards. Its entered_at is one
     * reading of the store's clock taken then (clock_timestamp(), read once
     * in the inserting statement), and a wait's seconds count from that same
     * reading. now() would be the transaction's start, before any lock wait,
     * and a delay before the transaction does not count either. The insert
     * and its events run between that reading and the commit; the seconds
     * are not counted from the commit.
     *
     * A receive state takes, in this same transaction, the first message the
     * run already accepted that it accepts (contract, sender, correlation)
     * and that has not expired at its deciding reading, in the run's durable
     * order; it is admitted completed (received) with that message as its
     * output, and the message is claimed by it. Otherwise it is admitted
     * pending, with its wait's deadline when it races one, and a later input
     * can claim it (acceptInput). Its deciding reading of the store's clock
     * is taken once after the locks and guards; selection, entered_at,
     * completed_at, the deadline and consumed_at all use it exactly.
     *
     * A receive that names a sender locks the workflow's and the sender's
     * session rows (lockInputSessions) and decides there whether that
     * sender may give this workflow input: a sender deleted before this
     * transaction, missing, or without authority fails the receive at once
     * with the refusal the receive carries (no spec, deadline or claim). A
     * retry of a committed admission returns it as stored, whatever
     * happened to its sender since.
     *
     * A send state locks the workflow's and its recipient's session rows the
     * same way and decides there whether it may send to that recipient, and
     * whether the recipient is an agent session or a workflow
     * (recipientDecision): a recipient deleted before this transaction,
     * missing or not allowed fails the state at once with the refusal it
     * carries, and nothing is stored. Otherwise it is admitted pending and
     * its message's outbox row (the intent: the recipient and its kind, the
     * contract, payload and correlation, with the node execution's id as its
     * stable exchange id) is written in this same transaction, before any
     * delivery.
     */
    async enterNode(input: {
        runId: string;
        nodeExecutionId: string;
        scopeId: string;
        nodeId: string;
        ordinal: number;
        nodeType: string;
        predecessorId: string | null;
        arrivalRoute: string | null;
        inputText: string;
        /** The KV revision the input was evaluated with; pinned on the node execution. */
        kvRevision: number;
        /**
         * A wait state's seconds: its deadline is the admission's accepted-entry
         * reading of the store's clock (its entered_at) plus these seconds.
         * Null for other states and for one that failed at admission.
         * A receive state that races a wait has them too.
         */
        waitSeconds: number | null;
        /**
         * What a receive state accepts (null for other states and for one
         * that failed at admission). A receive with a sender (from) also
         * carries what the admission records instead when that sender, as
         * decided under the session locks (lockInputSessions), is not
         * available or may not give this workflow input: an immediate result
         * and its projection, by refusal.
         */
        receive?: {
            contract: string;
            from: string | null;
            correlationText: string;
            refused: Readonly<Record<Exclude<TypedInputAuthority, "allowed">, { result: NodeResultInput; projection?: SessionProjection }>> | null;
        } | null;
        /** What a send state sends (null for other states and for one that failed at admission). */
        send?: SendSpecInput | null;
        /**
         * What a request state requests (null for other states and for one
         * that failed at admission). No runtime passes one yet (design
         * workflow-messaging-request.md 8.4). Its deadline is the admission's
         * accepted-entry reading plus its seconds, as a wait's; waitSeconds
         * is null with it.
         */
        request?: RequestSpecInput | null;
        immediate: NodeResultInput | null;
        projection?: SessionProjection;
    }): Promise<{ admitted: true; inserted: boolean; node: WorkflowNodeExecutionRow }
        | { admitted: false; reason: "inactive" | "kv_changed"; run: WorkflowRunRow }> {
        const inputSha256 = sha256Hex(input.inputText);
        return this.transaction(async client => {
            const workflowSessionId = await this.workflowOfRun(client, input.runId);
            const sender = input.receive?.from ?? null;
            const other = sender ?? input.send?.recipient ?? input.request?.recipient ?? null;
            const decided = other === null ? null : await this.lockInputSessions(client, workflowSessionId, other);
            const live = decided === null ? await this.lockLiveSession(client, workflowSessionId) : decided.live;
            const senderAuthority = decided === null || sender === null ? null : decided.authority;
            const run = await this.lockRun(client, input.runId);
            const existing = await client.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id = $1`, [input.nodeExecutionId]);
            if (existing.rows[0]) {
                const node = nodeFrom(existing.rows[0]);
                // An input evaluated with another KV revision may differ; the stored admission stands.
                const sameBasis = node.kvRevision === input.kvRevision;
                if (node.runId !== input.runId || node.scopeId !== input.scopeId || node.nodeId !== input.nodeId || node.ordinal !== input.ordinal
                    || node.predecessorId !== input.predecessorId || node.arrivalRoute !== input.arrivalRoute || (sameBasis && node.inputSha256 !== inputSha256)) {
                    throw new WorkflowStoreError("NONDETERMINISTIC_ADMISSION", `Node execution ${input.nodeExecutionId} was admitted with different coordinates.`);
                }
                return { admitted: true as const, inserted: false, node };
            }
            // A paused run admits nothing new; a deleted or ended one admits nothing at all.
            if (!live || !ADMITTING_RUN_STATUSES.includes(run.status)) return { admitted: false as const, reason: "inactive" as const, run };
            if (run.kvRevision !== input.kvRevision) return { admitted: false as const, reason: "kv_changed" as const, run };
            let immediate = input.immediate;
            let receive = input.receive ?? null;
            let send = input.send ?? null;
            let request = input.request ?? null;
            // A receive spec belongs to a receive state admitted without an
            // immediate result, and has refusals exactly when it names a sender;
            // a send spec belongs to a send state admitted without one, and a
            // request spec to a request state admitted without one.
            if ((receive !== null || send !== null || request !== null) !== (input.nodeType === "messaging" && immediate === null)
                || [receive, send, request].filter(spec => spec !== null).length > 1
                || (receive !== null && (receive.from === null) !== (receive.refused === null))) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has an invalid messaging spec.`);
            }
            if (request !== null && !(Number.isSafeInteger(request.timeoutSeconds) && request.timeoutSeconds >= 1 && request.timeoutSeconds <= WAIT_MAX_SECONDS)) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has an invalid request deadline.`);
            }
            // A request's record freezes the response schema that its state's contract declares in the run's pinned
            // definition, never another schema of that definition.
            if (request !== null) {
                const ir = await this.revisionIrIn(client, run.workflowSessionId, run.revision, run.irSha256, { maxIrVersion: WORKFLOW_V2_REQUEST_IR_VERSION });
                if (declaredResponseSchema(ir, input.nodeId, request.contract, `Node execution ${input.nodeExecutionId}`) !== request.responseSchema) {
                    throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has a request spec whose response `
                        + `schema ${request.responseSchema} is not the one contract ${request.contract} declares.`);
                }
            }
            // A wait admitted pending has a whole number of seconds; a receive may
            // race a wait (then it has them too); nothing else has any.
            const waits = input.nodeType === "wait" && immediate === null;
            const mayWait = waits || receive !== null;
            if ((waits && input.waitSeconds === null) || (!mayWait && input.waitSeconds !== null)
                || (input.waitSeconds !== null && !(Number.isSafeInteger(input.waitSeconds) && input.waitSeconds >= 1))) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has invalid wait seconds.`);
            }
            // The receive's sender, decided under the session locks: one that
            // was deleted, is missing or may not send fails the receive now,
            // with no spec, no deadline and no claim. A sender deleted after
            // this transaction does not change the admission it committed.
            let waitSeconds = input.waitSeconds;
            let projection = input.projection;
            if (receive !== null && senderAuthority !== null && senderAuthority !== "allowed") {
                if (receive.refused === null) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has an invalid receive spec.`);
                const refusal = receive.refused[senderAuthority];
                immediate = refusal.result;
                projection = refusal.projection;
                receive = null;
                waitSeconds = null;
            }
            // The send's recipient, decided under the session locks the same way:
            // one that may not be sent to fails the state now, and nothing is stored.
            let recipientKind: RecipientKind | null = null;
            if (send !== null) {
                if (decided === null) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has an invalid messaging spec.`);
                const recipient = await this.recipientDecision(client, decided.authority, send.recipient);
                if (recipient.refusal !== null) {
                    immediate = send.refused[recipient.refusal].result;
                    projection = send.refused[recipient.refusal].projection;
                    send = null;
                } else recipientKind = recipient.kind;
            }
            // A request's responder, decided the same way; a workflow responder is
            // not supported yet. One admitted pending has its deadline as a wait has.
            if (request !== null) {
                if (decided === null) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has an invalid messaging spec.`);
                const responder = await this.recipientDecision(client, decided.authority, request.recipient);
                if (responder.refusal !== null) {
                    immediate = request.refused[responder.refusal].result;
                    projection = request.refused[responder.refusal].projection;
                    request = null;
                } else if (responder.kind === "workflow") {
                    immediate = request.workflowRecipient.result;
                    projection = request.workflowRecipient.projection;
                    request = null;
                } else waitSeconds = request.timeoutSeconds;
            }
            // A receive decides at one reading of the store's clock, taken here,
            // after the locks and guards, and kept as exact SQL text (a
            // JavaScript Date keeps only milliseconds): the first message the
            // run accepted that it takes must be unexpired at that reading,
            // and the reading is its entered_at (and completed_at when it
            // takes one, or the start of its wait's seconds).
            let decidedAt: string | null = null;
            let claim: { messageId: string; payloadText: string; contract: string; senderSessionId: string } | null = null;
            if (receive) {
                const { rows: clock } = await client.query(`SELECT clock_timestamp()::text AS at`);
                decidedAt = str(clock[0], "at");
                const { rows: messages } = await client.query(
                    `SELECT message_id, payload, contract, sender_session_id FROM ${this.t.inbox}
                      WHERE run_id = $1 AND consumed_by IS NULL AND contract = $2 AND ($3::text IS NULL OR sender_session_id = $3)
                        AND correlation = $4 AND expires_at > $5::timestamptz
                      ORDER BY seq LIMIT 1 FOR UPDATE`,
                    [input.runId, receive.contract, receive.from, receive.correlationText, decidedAt]);
                claim = messages[0] ? {
                    messageId: str(messages[0], "message_id"), payloadText: str(messages[0], "payload"),
                    contract: str(messages[0], "contract"), senderSessionId: str(messages[0], "sender_session_id"),
                } : null;
            }
            const result: NodeResultInput | null = immediate
                ?? (claim ? { outcome: RECEIVE_RECEIVED, resultKind: "business", valueText: claim.payloadText, winner: "message" } : null);
            // The accepted-entry clock reading: the CTE is evaluated once per
            // statement, so entered_at, an immediate result's completed_at and
            // a wait's deadline_at share it exactly. A receive passes its
            // deciding reading instead; every other state reads the clock here.
            const { rows } = await client.query(
                `WITH accepted AS (SELECT COALESCE($22::timestamptz, clock_timestamp()) AS at)
                 INSERT INTO ${this.t.nodes}
                    (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, predecessor_id, arrival_route, input, input_sha256,
                     state, outcome, result_kind, output, error, winner, entered_at, completed_at, kv_revision, deadline_at,
                     receive_contract, receive_from, receive_correlation)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                         (SELECT at FROM accepted), CASE WHEN $11 = 'completed' THEN (SELECT at FROM accepted) END, $17,
                         (SELECT at FROM accepted) + $18::integer * interval '1 second', $19, $20, $21)
                 RETURNING *`,
                [input.nodeExecutionId, input.runId, input.scopeId, input.nodeId, input.ordinal, input.nodeType, input.predecessorId,
                    input.arrivalRoute, input.inputText, inputSha256, result ? "completed" : "pending",
                    result?.outcome ?? null, result?.resultKind ?? null,
                    result?.resultKind === "business" ? result.valueText : null,
                    result?.resultKind === "runtime_error" ? result.valueText : null,
                    result?.winner ?? null, input.kvRevision, claim ? null : waitSeconds,
                    receive?.contract ?? null, receive?.from ?? null, receive?.correlationText ?? null, decidedAt],
            );
            const node = nodeFrom(rows[0]);
            // A send admitted pending: its message's intent, before any delivery.
            if (send !== null) {
                if (recipientKind === null) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has no recipient decision.`);
                await client.query(
                    `INSERT INTO ${this.t.outbox}
                        (exchange_id, node_execution_id, workflow_session_id, run_id, mode, recipient_session_id, recipient_kind, contract, payload,
                         payload_sha256, correlation, created_at)
                     SELECT $1, $1, $2, $3, 'send', $4, $5, $6, $7, $8, $9, entered_at FROM ${this.t.nodes} WHERE node_execution_id = $1`,
                    [node.nodeExecutionId, workflowSessionId, input.runId, send.recipient, recipientKind, send.contract, send.payloadText,
                        sha256Hex(send.payloadText), send.correlationText]);
            }
            // A request admitted pending: its message's intent (outbox, mode request) and its immutable request record,
            // with the node's deadline and entry time, before any delivery.
            if (request !== null) {
                await client.query(
                    `INSERT INTO ${this.t.outbox}
                        (exchange_id, node_execution_id, workflow_session_id, run_id, mode, recipient_session_id, recipient_kind, contract, payload,
                         payload_sha256, correlation, created_at)
                     SELECT $1, $1, $2, $3, 'request', $4, 'agent', $5, $6, $7, $8, entered_at FROM ${this.t.nodes} WHERE node_execution_id = $1`,
                    [node.nodeExecutionId, workflowSessionId, input.runId, request.recipient, request.contract, request.payloadText,
                        sha256Hex(request.payloadText), request.correlationText]);
                const { rows: recorded } = await client.query(
                    `INSERT INTO ${this.t.requests}
                        (exchange_id, workflow_session_id, run_id, responder_session_id, contract, request_sha256, response_schema, deadline_at, created_at)
                     SELECT $1, $2, $3, $4, $5, $6, $7, deadline_at, entered_at FROM ${this.t.nodes}
                      WHERE node_execution_id = $1 AND deadline_at IS NOT NULL RETURNING exchange_id`,
                    [node.nodeExecutionId, workflowSessionId, input.runId, request.recipient, request.contract, sha256Hex(request.payloadText),
                        request.responseSchema]);
                if (!recorded[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Request ${node.nodeExecutionId} was admitted without its deadline.`);
            }
            if (claim) {
                const { rows: claimed } = await client.query(
                    `UPDATE ${this.t.inbox} SET consumed_by = $2, consumed_at = $3::timestamptz WHERE message_id = $1 AND consumed_by IS NULL RETURNING message_id`,
                    [claim.messageId, node.nodeExecutionId, decidedAt]);
                if (!claimed[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Message ${claim.messageId} was claimed under its lock.`);
                if (projection) {
                    projection = { ...projection, events: [...(projection.events ?? []), { eventType: "workflow.state_completed", data: {
                        runId: node.runId, nodeExecutionId: node.nodeExecutionId, stateId: node.nodeId, step: node.ordinal,
                        outcome: RECEIVE_RECEIVED, resultKind: "business", messageId: claim.messageId, contract: claim.contract,
                        senderSessionId: claim.senderSessionId, outputPreview: jsonbSafeText(claim.payloadText, 1_000),
                    } }] };
                }
            }
            await this.project(client, projection);
            return { admitted: true as const, inserted: true, node };
        });
    }

    async readNodeExecution(nodeExecutionId: string): Promise<WorkflowNodeExecutionRow | null> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id = $1`, [nodeExecutionId]);
        return rows[0] ? nodeFrom(rows[0]) : null;
    }

    async listNodeExecutions(runId: string, limit = 500): Promise<WorkflowNodeExecutionRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.nodes} WHERE run_id = $1 ORDER BY entered_at, node_execution_id LIMIT $2`, [runId, limit]);
        return rows.map(nodeFrom);
    }

    /**
     * The entry boundary of a script. In one transaction under the session,
     * run and node locks: count the attempt of a pending node execution of an
     * active run of a live workflow, and start the script while the locks are
     * held (`start` runs synchronously inside the transaction). A deletion or
     * cancellation therefore commits either first, and the script never
     * starts, or after the script started, and the running script's liveness
     * check stops it. No script starts after a deletion or cancellation commits.
     */
    async enterScript(nodeExecutionId: string, start: (attempt: number) => void): Promise<{ entered: boolean; attempt: number }> {
        return this.transaction(async client => {
            const workflowSessionId = await this.workflowOfNode(client, nodeExecutionId);
            if (!await this.lockLiveSession(client, workflowSessionId)) return { entered: false, attempt: 0 };
            const { rows: nodes } = await client.query(`SELECT run_id FROM ${this.t.nodes} WHERE node_execution_id = $1`, [nodeExecutionId]);
            const run = await this.lockRun(client, str(nodes[0], "run_id"));
            if (!ACTIVE_RUN_STATUSES.includes(run.status)) return { entered: false, attempt: 0 };
            const { rows } = await client.query(
                `UPDATE ${this.t.nodes} SET effect_attempts = effect_attempts + 1
                  WHERE node_execution_id = $1 AND state = 'pending' RETURNING effect_attempts`, [nodeExecutionId]);
            if (!rows[0]) return { entered: false, attempt: 0 };
            const attempt = int(rows[0], "effect_attempts");
            start(attempt);
            return { entered: true, attempt };
        });
    }

    /** Whether a run has a node execution that still awaits its result. */
    async hasPendingNodes(runId: string): Promise<boolean> {
        const { rows } = await this.pool.query(
            `SELECT EXISTS (SELECT 1 FROM ${this.t.nodes} WHERE run_id = $1 AND state = 'pending') AS pending`, [runId]);
        return rows[0]?.pending === true;
    }

    /** Whether a node execution still awaits its result (a running script's liveness check). */
    async isNodePending(nodeExecutionId: string): Promise<boolean> {
        const { rows } = await this.pool.query(`SELECT state FROM ${this.t.nodes} WHERE node_execution_id = $1`, [nodeExecutionId]);
        return rows[0]?.state === "pending";
    }

    /**
     * The single terminal compare-and-swap for a node execution. Returns the
     * stored winner: this result when it won, otherwise the earlier one.
     */
    async completeNode(nodeExecutionId: string, result: NodeResultInput, projection?: SessionProjection): Promise<{ won: boolean; node: WorkflowNodeExecutionRow }> {
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfNode(client, nodeExecutionId));
            const { rows } = live ? await client.query(
                `UPDATE ${this.t.nodes}
                    SET state = 'completed', outcome = $2, result_kind = $3,
                        output = CASE WHEN $3 = 'business' THEN $4 END,
                        error = CASE WHEN $3 = 'runtime_error' THEN $4 END,
                        winner = $5, completed_at = now()
                  WHERE node_execution_id = $1 AND state = 'pending'
                  RETURNING *`,
                [nodeExecutionId, result.outcome, result.resultKind, result.valueText, result.winner],
            ) : { rows: [] };
            if (rows[0]) {
                await this.project(client, projection);
                return { won: true, node: nodeFrom(rows[0]) };
            }
            const stored = await client.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id = $1`, [nodeExecutionId]);
            if (!stored.rows[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Node execution ${nodeExecutionId} does not exist.`);
            return { won: false, node: nodeFrom(stored.rows[0]) };
        });
    }

    /**
     * Elapse a pending wait state, or a receive state's wait, once the
     * store's clock reached its deadline: the terminal compare-and-swap with
     * outcome elapsed, the value it was given as its output and completed_at
     * at or after deadline_at. A message accepted before the deadline claimed
     * the receive in its own transaction first, so it is decided then.
     * One reading of the store's clock, taken after the session lock, both
     * decides and is stored (a CTE is evaluated once per statement), so a lock
     * wait makes the elapse late, never early. Before the deadline it changes
     * nothing and reports the milliseconds left (at least 1). A result stored
     * first, a cancellation or a deletion, is kept (decided).
     */
    async elapseWait(nodeExecutionId: string, projection?: SessionProjection): Promise<
        { result: "elapsed" | "decided"; node: WorkflowNodeExecutionRow } | { result: "not_due"; remainingMs: number; node: WorkflowNodeExecutionRow }> {
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfNode(client, nodeExecutionId));
            if (live) {
                const { rows } = await client.query(
                    `WITH decided AS (SELECT clock_timestamp() AS at)
                     UPDATE ${this.t.nodes}
                        SET state = 'completed', outcome = $2, result_kind = 'business', output = input, error = NULL,
                            winner = 'controller', completed_at = (SELECT at FROM decided)
                      WHERE node_execution_id = $1 AND state = 'pending' AND node_type IN ('wait', 'messaging') AND deadline_at <= (SELECT at FROM decided)
                      RETURNING *`,
                    [nodeExecutionId, WAIT_ELAPSED],
                );
                if (rows[0]) {
                    await this.project(client, projection);
                    return { result: "elapsed" as const, node: nodeFrom(rows[0]) };
                }
            }
            const { rows } = await client.query(
                `SELECT *, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (deadline_at - clock_timestamp())) * 1000))::bigint AS remaining_ms
                   FROM ${this.t.nodes} WHERE node_execution_id = $1`, [nodeExecutionId]);
            if (!rows[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Node execution ${nodeExecutionId} does not exist.`);
            const node = nodeFrom(rows[0]);
            // The deletion that made the session not live also decided its pending work (migration 0086 trigger).
            if (node.state === "completed" || !live) return { result: "decided" as const, node };
            if ((node.nodeType !== "wait" && node.nodeType !== "messaging") || node.deadlineAt === null) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${nodeExecutionId} is not a pending wait with a deadline.`);
            }
            return { result: "not_due" as const, remainingMs: int(rows[0], "remaining_ms"), node };
        });
    }

    /**
     * Accept one typed input for a run, once per (workflow, sender, operation
     * id), in one transaction under the session and run locks (the order an
     * admission takes them). A fresh input is accepted only when its sender
     * may give this workflow input as this transaction decides it, under the
     * workflow's and the sender's session locks (lockInputSessions): a
     * sender deleted before then is refused (FORBIDDEN), and nothing is
     * stored or recorded. One reading of the store's clock, taken after
     * the locks and kept as exact SQL text (a JavaScript Date keeps only
     * milliseconds), decides everything here: the inbox bounds, the input's
     * accepted_at and expires_at, and whether a waiting receive takes it.
     * The earliest receive state of the run that waits for it (same
     * contract, from no sender or this sender, same correlation) and whose
     * wait's deadline is after that reading takes it in this transaction,
     * with that reading as its completed_at and the input's consumed_at: an
     * input accepted before the deadline wins even if the controller elapses
     * the wait later; one accepted at or after it is late for that receive.
     * An input no receive takes now stays unclaimed, in the run's durable
     * order, until a receive takes it or it expires; a wait that elapses
     * first does not discard it. A paused run accepts input and a receive
     * may take it; the run admits nothing until it is resumed.
     *
     * The acceptance's receipt is stored with the input and never rewritten:
     * a repeat of the request returns it as stored, whatever happened to the
     * input since (listInbox shows that); another request with the id is
     * refused. Whether a repeat is answered at all is the caller's policy
     * (sendWorkflowInputV2 checks its sender first); this does not decide it
     * again. A deleted workflow takes no input, and a repeat to it is
     * refused too. The inbox bounds are checked before anything is stored.
     *
     * A send state's message given as typed input carries its exchange id
     * (`sendExchangeId`, which only the send's delivery passes): a fresh
     * input is then accepted only when it is that message and the send is
     * still undecided, as this transaction reads it (requireUndecidedSend);
     * a send decided first gets none (SEND_DECIDED). A repeat of an input
     * accepted before is answered as any repeat, also after the send was
     * decided: an acceptance is never taken back.
     */
    async acceptInput(input: {
        workflowSessionId: string;
        runId: string;
        messageId: string;
        senderSessionId: string;
        operationId: string;
        requestSha256: string;
        contract: string;
        correlationText: string;
        payloadText: string;
        ttlSeconds: number;
        limits: WorkflowInboxLimits;
        /** The exchange id of the send state whose message this input is; only the send's delivery passes it. */
        sendExchangeId?: string | null;
    }): Promise<{ receipt: WorkflowInputReceipt; replayed: boolean; run: WorkflowRunRow }> {
        if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1) {
            throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Message ${input.messageId} has an invalid ttl.`);
        }
        return this.transaction(async client => {
            const decided = await this.lockInputSessions(client, input.workflowSessionId, input.senderSessionId);
            if (!decided.live) throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow was deleted.");
            const { rows: priorRows } = await client.query(
                `SELECT run_id, request_sha256, receipt FROM ${this.t.inbox}
                  WHERE workflow_session_id = $1 AND sender_session_id = $2 AND operation_id = $3`,
                [input.workflowSessionId, input.senderSessionId, input.operationId]);
            if (priorRows[0]) {
                if (str(priorRows[0], "request_sha256") !== input.requestSha256) {
                    throw new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${input.operationId} was already used for a different input.`,
                        { operationId: input.operationId });
                }
                const receiptText = strOrNull(priorRows[0], "receipt");
                if (receiptText === null) {
                    throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT",
                        `Input ${input.operationId} was accepted by a pre-release build that stored no receipt; it cannot be repeated.`);
                }
                const { rows: runRows } = await client.query(`SELECT * FROM ${this.t.runs} WHERE run_id = $1`, [str(priorRows[0], "run_id")]);
                if (!runRows[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Input ${input.operationId} names a missing run.`);
                return { receipt: parseInputReceipt(parseStoredJson(receiptText, "receipt")), replayed: true, run: runFrom(runRows[0]) };
            }
            if (decided.authority !== "allowed") throw new WorkflowStoreError("FORBIDDEN", TYPED_INPUT_REFUSALS[decided.authority]);
            if (input.sendExchangeId) await this.requireUndecidedSend(client, { ...input, sendExchangeId: input.sendExchangeId });
            const run = await this.lockRun(client, input.runId);
            if (run.workflowSessionId !== input.workflowSessionId) throw new WorkflowStoreError("RUN_NOT_FOUND", `Run ${input.runId} is not a run of this workflow.`);
            if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
                throw new WorkflowStoreError("RUN_ENDED", `Run ${run.runId} has ended (${run.status}); it takes no input.`, { status: run.status });
            }
            const { rows: clock } = await client.query(`SELECT clock_timestamp()::text AS at`);
            const at = str(clock[0], "at");
            const { rows: counts } = await client.query(
                `SELECT
                    (count(*) FILTER (WHERE run_id = $1 AND consumed_by IS NULL AND expires_at > $4::timestamptz))::int AS unconsumed,
                    (count(*) FILTER (WHERE run_id = $1 AND consumed_by IS NULL AND expires_at > $4::timestamptz AND sender_session_id = $3))::int AS sender_unconsumed,
                    (count(*) FILTER (WHERE sender_session_id = $3 AND accepted_at > $4::timestamptz - $5::integer * interval '1 second'))::int AS sender_recent
                   FROM ${this.t.inbox} WHERE workflow_session_id = $2`,
                [run.runId, input.workflowSessionId, input.senderSessionId, at, input.limits.windowSeconds]);
            const count = counts[0] ?? {};
            if (int(count, "unconsumed") >= input.limits.maxUnconsumed || int(count, "sender_unconsumed") >= input.limits.maxUnconsumedPerSender) {
                throw new WorkflowStoreError("INBOX_FULL", `Run ${run.runId} holds as many unclaimed inputs as it may (${input.limits.maxUnconsumed}, `
                    + `${input.limits.maxUnconsumedPerSender} per sender); nothing was stored.`,
                    { unconsumed: int(count, "unconsumed"), senderUnconsumed: int(count, "sender_unconsumed") });
            }
            if (int(count, "sender_recent") >= input.limits.maxPerSenderPerWindow) {
                throw new WorkflowStoreError("INBOX_RATE_LIMITED", `This sender gave this workflow ${input.limits.maxPerSenderPerWindow} inputs in the last `
                    + `${input.limits.windowSeconds} s; nothing was stored.`, { windowSeconds: input.limits.windowSeconds });
            }
            const { rows: inserted } = await client.query(
                `INSERT INTO ${this.t.inbox}
                    (message_id, workflow_session_id, run_id, sender_session_id, operation_id, request_sha256, contract, correlation, payload,
                     accepted_at, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $10::timestamptz + $11::integer * interval '1 second')
                 RETURNING ${isoUtc("accepted_at")} AS accepted_at_iso, ${isoUtc("expires_at")} AS expires_at_iso`,
                [input.messageId, input.workflowSessionId, run.runId, input.senderSessionId, input.operationId, input.requestSha256,
                    input.contract, input.correlationText, input.payloadText, at, input.ttlSeconds]);
            const { rows: waiting } = await client.query(
                `SELECT node_execution_id FROM ${this.t.nodes}
                  WHERE run_id = $1 AND state = 'pending' AND node_type = 'messaging' AND receive_contract = $2
                    AND (receive_from IS NULL OR receive_from = $3) AND receive_correlation = $4
                    AND (deadline_at IS NULL OR deadline_at > $5::timestamptz)
                  ORDER BY entered_at, node_execution_id LIMIT 1 FOR UPDATE`,
                [run.runId, input.contract, input.senderSessionId, input.correlationText, at]);
            let claimed: WorkflowNodeExecutionRow | null = null;
            if (waiting[0]) {
                const { rows: completed } = await client.query(
                    `UPDATE ${this.t.nodes}
                        SET state = 'completed', outcome = $2, result_kind = 'business', output = $3, error = NULL, winner = 'message',
                            completed_at = $4::timestamptz
                      WHERE node_execution_id = $1 AND state = 'pending' RETURNING *`,
                    [str(waiting[0], "node_execution_id"), RECEIVE_RECEIVED, input.payloadText, at]);
                if (!completed[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "A pending receive changed under its lock.");
                claimed = nodeFrom(completed[0]);
                await client.query(`UPDATE ${this.t.inbox} SET consumed_by = $2, consumed_at = $3::timestamptz WHERE message_id = $1`,
                    [input.messageId, claimed.nodeExecutionId, at]);
            }
            const receipt: WorkflowInputReceipt = {
                workflowSessionId: input.workflowSessionId, runId: run.runId, messageId: input.messageId, senderSessionId: input.senderSessionId,
                operationId: input.operationId, contract: input.contract, requestSha256: input.requestSha256, payloadSha256: sha256Hex(input.payloadText),
                acceptedAt: str(inserted[0], "accepted_at_iso"), expiresAt: str(inserted[0], "expires_at_iso"),
                claimedBy: claimed ? { nodeExecutionId: claimed.nodeExecutionId, stateId: claimed.nodeId } : null,
            };
            await client.query(`UPDATE ${this.t.inbox} SET receipt = $2 WHERE message_id = $1`, [input.messageId, canonicalJson(receipt)]);
            const events: SessionEventRecord[] = [{ eventType: "workflow.input_accepted", data: {
                runId: run.runId, messageId: input.messageId, contract: input.contract, senderSessionId: input.senderSessionId,
                claimedBy: claimed ? claimed.nodeExecutionId : null,
            } }];
            if (claimed) {
                events.push({ eventType: "workflow.state_completed", data: {
                    runId: run.runId, nodeExecutionId: claimed.nodeExecutionId, stateId: claimed.nodeId, step: claimed.ordinal,
                    outcome: RECEIVE_RECEIVED, resultKind: "business", messageId: input.messageId, contract: input.contract,
                    senderSessionId: input.senderSessionId, outputPreview: jsonbSafeText(input.payloadText, 1_000),
                } });
            }
            await this.project(client, { sessionId: input.workflowSessionId, events, update: { touch: true } });
            return { receipt, replayed: false, run };
        });
    }

    /** A run's inbox, oldest first: unclaimed messages and the ones receive states took (bounded), as they are now. */
    async listInbox(runId: string, limit = 100): Promise<WorkflowInboxMessage[]> {
        const { rows } = await this.pool.query(`SELECT ${INBOX_COLUMNS} FROM ${this.t.inbox} WHERE run_id = $1 ORDER BY seq LIMIT $2`, [runId, limit]);
        return rows.map(inboxFrom);
    }

    /** Node executions of a run whose stored result is the run's cancellation. */
    async listCancelledNodeIds(runId: string): Promise<string[]> {
        const { rows } = await this.pool.query(
            `SELECT node_execution_id FROM ${this.t.nodes} WHERE run_id = $1 AND winner = 'cancel' ORDER BY node_execution_id`, [runId]);
        return rows.map(row => str(row, "node_execution_id"));
    }

    /** The completed node executions among the exact history-selected ids. */
    async readCompletedNodes(runId: string, nodeExecutionIds: string[]): Promise<WorkflowNodeExecutionRow[]> {
        if (nodeExecutionIds.length === 0) return [];
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.nodes} WHERE run_id = $1 AND node_execution_id = ANY($2::text[]) AND state = 'completed'`,
            [runId, nodeExecutionIds]);
        return rows.map(nodeFrom);
    }

    /** A run's sent messages, oldest first (bounded), as they are now. */
    async listOutbox(runId: string, limit = 100): Promise<WorkflowOutboxMessage[]> {
        const { rows } = await this.pool.query(
            `SELECT ${OUTBOX_COLUMNS} FROM ${this.t.outbox} WHERE run_id = $1 ORDER BY created_at, exchange_id LIMIT $2`, [runId, Math.min(Math.max(limit, 1), 500)]);
        return rows.map(outboxFrom);
    }

    /** The outbox message of a send state's node execution, or null. */
    async readOutboxMessage(nodeExecutionId: string): Promise<WorkflowOutboxMessage | null> {
        const { rows } = await this.pool.query(`SELECT ${OUTBOX_COLUMNS} FROM ${this.t.outbox} WHERE node_execution_id = $1`, [nodeExecutionId]);
        return rows[0] ? outboxFrom(rows[0]) : null;
    }

    /** A request as it is now (its derived status, response, wake intent and bindings), or null for no such request. */
    async readRequest(exchangeId: string): Promise<WorkflowRequestView | null> {
        const { rows } = await this.pool.query(`SELECT ${REQUEST_COLUMNS} FROM ${this.t.requests} WHERE exchange_id = $1`, [exchangeId]);
        return rows[0] ? this.requestView(requestFrom(rows[0])) : null;
    }

    /** A run's requests, oldest first (bounded), as they are now. */
    async listRequests(runId: string, limit = 100): Promise<WorkflowRequestView[]> {
        const { rows } = await this.pool.query(
            `SELECT ${REQUEST_COLUMNS} FROM ${this.t.requests} WHERE run_id = $1 ORDER BY created_at, exchange_id LIMIT $2`,
            [runId, Math.min(Math.max(limit, 1), 500)]);
        const views: WorkflowRequestView[] = [];
        for (const row of rows) views.push(await this.requestView(requestFrom(row)));
        return views;
    }

    private async requestView(request: WorkflowRequestRecord): Promise<WorkflowRequestView> {
        // One statement, so the node, its run, its message, its response record, its wake intent and the bindings are one
        // committed state; requestStateFrom checks it whole.
        const { rows } = await this.pool.query(this.requestStateSql(), [request.exchangeId]);
        const state = requestStateFrom(request, rows[0]);
        return { ...request, stateId: state.node.nodeId, status: state.status, failure: state.failure, response: state.response, wake: state.wake,
            operations: state.operations };
    }

    /** A request's committed state, read in the caller's transaction under its locks and checked whole (requestStateFrom). */
    private async requestStateIn(client: PoolClient, request: WorkflowRequestRecord): Promise<WorkflowRequestState> {
        const { rows } = await client.query(this.requestStateSql(), [request.exchangeId]);
        return requestStateFrom(request, rows[0]);
    }

    /** The one statement requestStateFrom reads: a request's node, run, message, response, wake intent and bindings. */
    private requestStateSql(): string {
        return `SELECT node.*,
                    run.workflow_session_id AS run_workflow_session_id, run.controller_instance_id AS run_controller_instance_id,
                    ob.node_execution_id AS o_node_execution_id, ob.workflow_session_id AS o_workflow_session_id, ob.run_id AS o_run_id,
                    ob.mode AS o_mode, ob.recipient_session_id AS o_recipient_session_id, ob.recipient_kind AS o_recipient_kind,
                    ob.contract AS o_contract, ob.payload_sha256 AS o_payload_sha256,
                    resp.exchange_id AS r_exchange_id, resp.kind AS r_kind, resp.value AS r_value, resp.result_sha256 AS r_result_sha256,
                    resp.operation_id AS r_operation_id, resp.actor_session_id AS r_actor_session_id,
                    ${isoUtc("resp.decided_at")} AS r_decided_at_iso, resp.receipt AS r_receipt,
                    (node.completed_at IS NOT DISTINCT FROM resp.decided_at) AS r_node_time,
                    wake.exchange_id AS w_exchange_id, wake.state AS w_state, wake.attempts AS w_attempts,
                    ${isoUtc("wake.settled_at")} AS w_settled_at_iso, wake.run_id AS w_run_id, wake.controller_instance_id AS w_controller_instance_id,
                    (wake.created_at IS NOT DISTINCT FROM resp.decided_at) AS w_time,
                    win.actor_session_id AS b_actor_session_id, win.result_sha256 AS b_result_sha256, win.outcome AS b_outcome,
                    win.status AS b_status, (win.first_at IS NOT DISTINCT FROM resp.decided_at) AS b_time,
                    (SELECT count(*)::int FROM ${this.t.requestOperations} op WHERE op.exchange_id = node.node_execution_id) AS op_count,
                    (SELECT count(*)::int FROM ${this.t.requestOperations} op
                      WHERE op.exchange_id = node.node_execution_id AND op.outcome = 'decided') AS decided_count
               FROM ${this.t.nodes} node
               JOIN ${this.t.runs} run ON run.run_id = node.run_id
               LEFT JOIN ${this.t.outbox} ob ON ob.exchange_id = node.node_execution_id
               LEFT JOIN ${this.t.requestResponses} resp ON resp.exchange_id = node.node_execution_id
               LEFT JOIN ${this.t.responseWakes} wake ON wake.exchange_id = node.node_execution_id
               LEFT JOIN ${this.t.requestOperations} win ON win.exchange_id = resp.exchange_id AND win.operation_id = resp.operation_id
              WHERE node.node_execution_id = $1`;
    }

    /**
     * A response call to a request state, in one transaction (design
     * workflow-messaging-request.md sections 4 to 7). No runtime calls this
     * yet: the respond tool and the request's delivery are gated (8.4). The
     * actor is the caller's authenticated session (the respond tool's host),
     * never a field of the call. In order:
     *
     * 1. The request rule. The request's immutable record is read, then the
     *    requester's and the actor's session rows are locked (lockSessionPair:
     *    the requester's FOR NO KEY UPDATE, the actor's FOR SHARE, ascending
     *    session id) before any run or node row, and decideRequestAuthority
     *    decides on what they show: only the frozen responder, live and still
     *    related to the requester (a soft-deleted requester's kept rows
     *    count). An unknown request and every refusal are the same
     *    REQUEST_NOT_FOUND, with nothing written and nothing diagnosed: an
     *    id no row can hold, the operation id and the call are looked at
     *    only after this rule allowed the actor.
     * 2. The operation id (WORKFLOW_COMMAND_INVALID) and the call: exactly
     *    one of response or decline, by presence (a response of null is a
     *    response), a JSON value whose canonical text is at most
     *    WORKFLOW_V2_MAX_RESPONSE_BYTES (RESPONSE_INVALID). Its result
     *    identity is the sha256 of the canonical JSON of {kind, value},
     *    hashed from the value's canonical text (kindValueSha256), so a value
     *    at the full JSON depth keeps its identity.
     * 3. A known operation decides alone: its binding, once it agrees with
     *    the request's committed state (assertKnownBinding; a binding that
     *    does not is WORKFLOW_STORE_CORRUPT), returns the outcome it got for
     *    the same result identity (the winner's receipt, or the refusal),
     *    and another result is OPERATION_CONFLICT; the binding never
     *    changes, and a repeat counts in last_at and count.
     * 4. A soft-deleted requester gets read-only answers: no new decision
     *    (REQUEST_CLOSED), no binding, no counter and no session touch.
     * 5. The schema: the record's response schema must be the one its
     *    state's contract declares in the run's pinned definition
     *    (WORKFLOW_STORE_CORRUPT otherwise, nothing written); a response
     *    against it, a decline against WORKFLOW_V2_DECLINE_SCHEMA
     *    (RESPONSE_INVALID, field errors, nothing written).
     * 6. A new operation once WORKFLOW_V2_MAX_REQUEST_OPERATIONS are bound is
     *    OPERATION_LIMIT, nothing written; known operations stay replayable.
     * 7. One reading of the store's clock, after the run and node locks,
     *    decides by the request's state and binds the operation: pending
     *    with the reading before the deadline (exact SQL comparison; equal
     *    is late) decides the node (responded or declined, winner response,
     *    completed at that reading) with the response record, its receipt,
     *    the wake intent and the requester's events; pending at or after the
     *    deadline is REQUEST_EXPIRED and decides nothing (only the
     *    controller's elapse decides timed_out); a decided request returns
     *    the winner's receipt for the same result and RESPONSE_CONFLICT for
     *    another; a closed one is REQUEST_CLOSED with its status.
     *
     * Every answer from step 3 on reads the request's committed state checked
     * whole (requestStateFrom); a contradiction is WORKFLOW_STORE_CORRUPT and
     * nothing is written. A decision before the deadline may commit after it.
     * Every write that decides a request's node takes the requester's session
     * row first, so the node read here under that lock is one committed state.
     */
    async respondToRequest(input: { exchangeId: string; actorSessionId: string; operationId: string; call: { response?: unknown; decline?: unknown } })
        : Promise<WorkflowRequestCallResult> {
        const notFound = () => new WorkflowStoreError("REQUEST_NOT_FOUND", "No such request is open to this session.");
        // An id that no stored row can hold names no request and no session: the same refusal, before any statement.
        if (!storableId(input.exchangeId) || !storableId(input.actorSessionId)) throw notFound();
        return this.transaction(async client => {
            const { rows: found } = await client.query(`SELECT ${REQUEST_COLUMNS} FROM ${this.t.requests} WHERE exchange_id = $1`, [input.exchangeId]);
            if (!found[0]) throw notFound();
            const request = requestFrom(found[0]);
            // 1. The request rule, on the session rows as these locks find them.
            const locked = await this.lockSessionPair(client, request.workflowSessionId, input.actorSessionId);
            if (decideRequestAuthority({
                requester: locked.workflow, definition: locked.definition, actor: locked.other,
                actorSessionId: input.actorSessionId, responderSessionId: request.responderSessionId,
            }) !== "allowed") throw notFound();
            const requesterLive = locked.workflow !== null && !locked.workflow.deleted;

            // 2. The operation id and the call, for the responder only.
            const operationId: unknown = input.operationId;
            if (typeof operationId !== "string" || !operationId.trim() || operationId.length > 256 || !isStorableText(operationId)) {
                throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "operation_id must be 1-256 characters of valid Unicode text without NUL characters.");
            }
            const call: unknown = input.call;
            const kinds = isJsonObject(call) ? (["response", "decline"] as const).filter(name => Object.hasOwn(call, name)) : [];
            if (!isJsonObject(call) || kinds.length !== 1) {
                throw new WorkflowStoreError("RESPONSE_INVALID", "A response call gives exactly one of response or decline.");
            }
            const kind = kinds[0];
            const value = responseValueOf(call[kind], kind);
            const valueText = canonicalJson(value);
            if (utf8ByteLength(valueText) > WORKFLOW_V2_MAX_RESPONSE_BYTES) {
                throw new WorkflowStoreError("RESPONSE_INVALID", `A ${kind} must be at most ${WORKFLOW_V2_MAX_RESPONSE_BYTES} bytes of canonical JSON.`);
            }
            const resultSha256 = kindValueSha256(kind, valueText);

            // 3. A known operation decides alone, once its binding agrees with the request's state.
            const { rows: known } = await client.query(
                `SELECT actor_session_id, result_sha256, outcome, status FROM ${this.t.requestOperations}
                  WHERE exchange_id = $1 AND operation_id = $2 FOR UPDATE`,
                [request.exchangeId, operationId]);
            if (known[0]) {
                if (requesterLive) {
                    await client.query(
                        `UPDATE ${this.t.requestOperations} SET last_at = clock_timestamp(), count = count + 1 WHERE exchange_id = $1 AND operation_id = $2`,
                        [request.exchangeId, operationId]);
                }
                const current = await this.requestStateIn(client, request);
                assertKnownBinding(request, operationId, known[0], current);
                const recorded = requestStatusText(known[0], "status");
                if (str(known[0], "result_sha256") !== resultSha256) {
                    return { kind: "refused" as const, replayed: true, code: "OPERATION_CONFLICT" as const, status: recorded, currentStatus: current.status };
                }
                const outcome = str(known[0], "outcome");
                if (outcome === "decided" || outcome === "same") {
                    if (current.response === null || (current.status !== "responded" && current.status !== "declined")) {
                        return corrupt(`Request ${request.exchangeId} has a ${outcome} operation but no decision.`);
                    }
                    return { kind: "accepted" as const, replayed: true, receipt: current.response.receipt, status: current.status };
                }
                const code = outcome === "expired" ? "REQUEST_EXPIRED" as const : outcome === "closed" ? "REQUEST_CLOSED" as const
                    : outcome === "conflict" ? "RESPONSE_CONFLICT" as const : corrupt(`Unknown request operation outcome ${outcome}.`);
                return { kind: "refused" as const, replayed: true, code, status: recorded, currentStatus: current.status };
            }

            // 4. A deleted requester: read-only, no new decision.
            if (!requesterLive) {
                const current = await this.requestStateIn(client, request);
                return { kind: "refused" as const, replayed: false, code: "REQUEST_CLOSED" as const, status: current.status, currentStatus: current.status };
            }

            // 5. The schema of the response (the one its state's contract declares in the run's pinned definition) or of a decline.
            const run = await this.lockRun(client, request.runId);
            const ir = await this.revisionIrIn(client, run.workflowSessionId, run.revision, run.irSha256, { maxIrVersion: WORKFLOW_V2_REQUEST_IR_VERSION });
            const { nodeId: stateId } = await this.nodeIn(client, request.exchangeId);
            if (declaredResponseSchema(ir, stateId, request.contract, `Request ${request.exchangeId}`) !== request.responseSchema) {
                return corrupt(`Request ${request.exchangeId} froze response schema ${request.responseSchema}, which contract ${request.contract} does not declare.`);
            }
            const problems = kind === "response" ? schemaSetFor(run.irSha256, ir.schemaDefs).validate(request.responseSchema, value) : declineProblems(value);
            if (problems.length > 0) {
                throw new WorkflowStoreError("RESPONSE_INVALID", kind === "response"
                    ? `The response does not match the response schema of contract ${request.contract}.`
                    : "A decline is { reason: <1 to 2,000 characters> } and nothing else.",
                    problems.map(problem => ({ path: problem.path, message: problem.message })));
            }

            // 6. The bound on operations.
            const { rows: bound } = await client.query(
                `SELECT count(*)::int AS n FROM ${this.t.requestOperations} WHERE exchange_id = $1`, [request.exchangeId]);
            if (int(bound[0], "n") >= WORKFLOW_V2_MAX_REQUEST_OPERATIONS) {
                throw new WorkflowStoreError("OPERATION_LIMIT", `This request has bound ${WORKFLOW_V2_MAX_REQUEST_OPERATIONS} operations; `
                    + "repeat one of them, or stop: a new one is not taken.", { limit: WORKFLOW_V2_MAX_REQUEST_OPERATIONS });
            }

            // 7. One reading of the store's clock decides, after the run and node locks.
            const { rows: nodeRows } = await client.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id = $1 FOR UPDATE`, [request.exchangeId]);
            if (!nodeRows[0]) return corrupt(`Request ${request.exchangeId} has no node execution.`);
            const { rows: clock } = await client.query(
                `WITH reading AS (SELECT clock_timestamp() AS at) SELECT at::text AS at, ${isoUtc("at")} AS at_iso FROM reading`);
            const at = str(clock[0], "at");
            const atIso = str(clock[0], "at_iso");
            const bind = async (outcome: "decided" | "same" | "expired" | "closed" | "conflict", status: WorkflowRequestStatus): Promise<void> => {
                await client.query(
                    `INSERT INTO ${this.t.requestOperations} (exchange_id, operation_id, actor_session_id, result_sha256, outcome, status, first_at, last_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz)`,
                    [request.exchangeId, operationId, input.actorSessionId, resultSha256, outcome, status, at]);
            };
            const current = await this.requestStateIn(client, request);
            if (current.status === "pending") {
                if (!ACTIVE_RUN_STATUSES.includes(run.status)) return corrupt(`Request ${request.exchangeId} is pending in an ended run.`);
                const { rows: early } = await client.query(
                    `SELECT $1::timestamptz < deadline_at AS in_time FROM ${this.t.requests} WHERE exchange_id = $2`, [at, request.exchangeId]);
                if (!bool(early[0], "in_time")) {
                    await bind("expired", "pending");
                    return { kind: "refused" as const, replayed: false, code: "REQUEST_EXPIRED" as const, status: "pending" as const, currentStatus: "pending" as const };
                }
                const outcome = kind === "response" ? REQUEST_RESPONDED : REQUEST_DECLINED;
                const status = kind === "response" ? "responded" as const : "declined" as const;
                const { rows: completed } = await client.query(
                    `UPDATE ${this.t.nodes}
                        SET state = 'completed', outcome = $2, result_kind = 'business', output = $3, error = NULL, winner = 'response',
                            completed_at = $4::timestamptz
                      WHERE node_execution_id = $1 AND state = 'pending' RETURNING *`,
                    [request.exchangeId, outcome, valueText, at]);
                if (!completed[0]) return corrupt(`Request ${request.exchangeId} changed under its lock.`);
                const decided = nodeFrom(completed[0]);
                const receipt: WorkflowRequestReceipt = {
                    exchangeId: request.exchangeId, workflowSessionId: request.workflowSessionId, runId: request.runId, stateId: decided.nodeId,
                    responderSessionId: request.responderSessionId, operationId, kind, resultSha256, decidedAt: atIso,
                };
                await client.query(
                    `INSERT INTO ${this.t.requestResponses} (exchange_id, kind, value, result_sha256, operation_id, actor_session_id, decided_at, receipt)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)`,
                    [request.exchangeId, kind, valueText, resultSha256, operationId, input.actorSessionId, at, canonicalJson(receipt)]);
                await bind("decided", status);
                await client.query(
                    `INSERT INTO ${this.t.responseWakes} (exchange_id, run_id, controller_instance_id, next_attempt_at, created_at)
                     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz)`,
                    [request.exchangeId, run.runId, run.controllerInstanceId, at]);
                await this.project(client, { sessionId: request.workflowSessionId, update: { touch: true }, events: [{ eventType: "workflow.state_completed", data: {
                    runId: run.runId, nodeExecutionId: decided.nodeExecutionId, stateId: decided.nodeId, step: decided.ordinal, outcome,
                    resultKind: "business", exchangeId: request.exchangeId, responderSessionId: request.responderSessionId,
                    operationId, outputPreview: jsonbSafeText(valueText, 1_000),
                } }] });
                return { kind: "accepted" as const, replayed: false, receipt, status };
            }
            if (current.status === "responded" || current.status === "declined") {
                if (current.response === null) return corrupt(`Request ${request.exchangeId} was decided without its record.`);
                if (current.response.resultSha256 === resultSha256) {
                    await bind("same", current.status);
                    return { kind: "accepted" as const, replayed: true, receipt: current.response.receipt, status: current.status };
                }
                await bind("conflict", current.status);
                return { kind: "refused" as const, replayed: false, code: "RESPONSE_CONFLICT" as const, status: current.status, currentStatus: current.status };
            }
            await bind("closed", current.status);
            return { kind: "refused" as const, replayed: false, code: "REQUEST_CLOSED" as const, status: current.status, currentStatus: current.status };
        });
    }

    /**
     * Begin one delivery attempt of a send state's message, in one
     * transaction under the session locks the admission took (the workflow's
     * and the recipient's, lockInputSessions). In this order:
     * - a message no longer pending is returned as stored ("decided": a
     *   delivery was recorded, or none will be);
     * - a workflow recipient's acceptance of the message (sendAcceptanceIn),
     *   made by an earlier attempt that did not record it, is recorded as the
     *   delivery ("delivered"), whatever happened since to the state (it
     *   keeps a result decided first) or to the recipient; no attempt is
     *   counted;
     * - when the state is no longer pending (a cancel or a deletion decided
     *   it), nothing is delivered ("decided"), and the message becomes failed
     *   with the reason, since no delivery will be recorded for it;
     * - the recipient is decided again on what this transaction reads
     *   (recipientDecision): one deleted or no longer allowed since the state
     *   was entered fails the state with the refusal it carries, and the
     *   message with it ("refused");
     * - when the caller found an agent recipient's session orchestration
     *   ended just before this transaction (`ended`), the state fails with
     *   that result and the message with it ("refused"): a message queued for
     *   it would not be processed, and a send never starts a session again;
     * - otherwise the attempt is counted and the message returned for
     *   delivery ("deliver").
     * The delivery itself (an agent session queue's acceptance, or a
     * workflow inbox's) is outside this transaction; recordDelivery records
     * it. A message refused here was not delivered in this attempt; an
     * earlier counted attempt may have queued it for an agent session.
     */
    async beginDelivery(nodeExecutionId: string, refusals: {
        refused: SendSpecInput["refused"];
        ended: { result: NodeResultInput; projection?: SessionProjection } | null;
        /** How a workflow recipient's earlier acceptance is recorded (as recordDelivery records a delivery). */
        delivered: { stateId: string; projection: (receipt: WorkflowSendReceipt) => SessionProjection };
    }): Promise<{ kind: "decided" | "delivered" | "refused" | "deliver"; node: WorkflowNodeExecutionRow; message: WorkflowOutboxMessage }> {
        return this.transaction(async client => {
            const { rows: found } = await client.query(
                `SELECT workflow_session_id, recipient_session_id FROM ${this.t.outbox} WHERE node_execution_id = $1`, [nodeExecutionId]);
            if (!found[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Node execution ${nodeExecutionId} has no outbox message.`);
            const workflowSessionId = str(found[0], "workflow_session_id");
            const decided = await this.lockInputSessions(client, workflowSessionId, str(found[0], "recipient_session_id"));
            const { rows: nodes } = await client.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            const { rows: messages } = await client.query(
                `SELECT ${OUTBOX_COLUMNS} FROM ${this.t.outbox} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            if (!nodes[0] || !messages[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Node execution ${nodeExecutionId} is missing.`);
            const node = nodeFrom(nodes[0]);
            const message = outboxFrom(messages[0]);
            if (message.mode !== "send") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${nodeExecutionId} is not a send state's message.`);
            if (message.state !== "pending") return { kind: "decided" as const, node, message };
            if (message.recipientKind === "workflow") {
                const accepted = await this.sendAcceptanceIn(client, message);
                if (accepted.kind === "accepted") {
                    const recorded = await this.deliverIn(client, workflowSessionId, decided.live, message,
                        { stateId: refusals.delivered.stateId, clientMessageId: null, input: accepted.input }, refusals.delivered.projection);
                    return { kind: "delivered" as const, node: recorded.node, message: recorded.message };
                }
            }
            if (!decided.live || node.state !== "pending") {
                const { rows: abandoned } = await client.query(
                    `UPDATE ${this.t.outbox} SET state = 'failed', decided_at = clock_timestamp(), error = $2
                      WHERE node_execution_id = $1 AND state = 'pending' RETURNING ${OUTBOX_COLUMNS}`,
                    [nodeExecutionId, undeliveredErrorText(node.outcome, message.attempts)]);
                return { kind: "decided" as const, node, message: abandoned[0] ? outboxFrom(abandoned[0]) : message };
            }
            const recipient = await this.recipientDecision(client, decided.authority, message.recipientSessionId);
            const refused = recipient.refusal !== null ? refusals.refused[recipient.refusal]
                : recipient.kind === "agent" ? refusals.ended : null;
            if (refused !== null) {
                const { result, projection } = refused;
                const { rows: completed } = await client.query(
                    `UPDATE ${this.t.nodes}
                        SET state = 'completed', outcome = $2, result_kind = $3,
                            output = CASE WHEN $3 = 'business' THEN $4 END,
                            error = CASE WHEN $3 = 'runtime_error' THEN $4 END,
                            winner = $5, completed_at = now()
                      WHERE node_execution_id = $1 AND state = 'pending' RETURNING *`,
                    [nodeExecutionId, result.outcome, result.resultKind, result.valueText, result.winner]);
                const { rows: failed } = await client.query(
                    `UPDATE ${this.t.outbox} SET state = 'failed', decided_at = clock_timestamp(), error = $2
                      WHERE node_execution_id = $1 AND state = 'pending' RETURNING ${OUTBOX_COLUMNS}`,
                    [nodeExecutionId, result.valueText]);
                if (!completed[0] || !failed[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Send ${nodeExecutionId} changed under its locks.`);
                await this.project(client, projection);
                return { kind: "refused" as const, node: nodeFrom(completed[0]), message: outboxFrom(failed[0]) };
            }
            const { rows: counted } = await client.query(
                `UPDATE ${this.t.outbox} SET attempts = attempts + 1, last_attempt_at = clock_timestamp()
                  WHERE node_execution_id = $1 RETURNING ${OUTBOX_COLUMNS}`, [nodeExecutionId]);
            return { kind: "deliver" as const, node, message: outboxFrom(counted[0]) };
        });
    }

    /**
     * Record a delivery that its recipient accepted (an agent session's
     * queue, or a workflow's inbox as typed input), in one transaction under
     * the workflow's session lock (deliverIn): the message from pending to
     * delivered with its receipt, and its send state from pending to sent
     * with that receipt as its output and the projection's events. A state
     * decided meanwhile (a cancel or a deletion) keeps its result, and the
     * message is recorded as delivered all the same. A workflow recipient's
     * acceptance is recorded as the store holds it, and only when it is this
     * message's (sendAcceptanceIn). A message no longer pending is returned
     * as stored: a repeat after this commit records nothing again.
     */
    async recordDelivery(nodeExecutionId: string,
        delivery: { stateId: string; clientMessageId: string | null; input: WorkflowSendInputAcceptance | null },
        projection: (receipt: WorkflowSendReceipt) => SessionProjection)
        : Promise<{ recorded: boolean; won: boolean; node: WorkflowNodeExecutionRow; message: WorkflowOutboxMessage }> {
        return this.transaction(async client => {
            const workflowSessionId = await this.workflowOfNode(client, nodeExecutionId);
            const live = await this.lockLiveSession(client, workflowSessionId);
            const { rows: messages } = await client.query(
                `SELECT ${OUTBOX_COLUMNS} FROM ${this.t.outbox} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            if (!messages[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Node execution ${nodeExecutionId} has no outbox message.`);
            const message = outboxFrom(messages[0]);
            if (message.mode !== "send") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${nodeExecutionId} is not a send state's message.`);
            if (message.state !== "pending") return { recorded: false, won: false, node: await this.nodeIn(client, nodeExecutionId), message };
            if ((message.recipientKind === "agent") !== (delivery.clientMessageId !== null)
                || (message.recipientKind === "workflow") !== (delivery.input !== null)) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Send ${nodeExecutionId} was delivered as another kind of recipient.`);
            }
            let input = delivery.input;
            if (message.recipientKind === "workflow") {
                const accepted = await this.sendAcceptanceIn(client, message);
                if (accepted.kind !== "accepted" || accepted.input.messageId !== delivery.input?.messageId) {
                    throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Send ${nodeExecutionId} records an input its recipient did not accept for this message.`);
                }
                input = accepted.input;
            }
            const recorded = await this.deliverIn(client, workflowSessionId, live, message,
                { stateId: delivery.stateId, clientMessageId: delivery.clientMessageId, input }, projection);
            return { recorded: true, ...recorded };
        });
    }

    /**
     * No delivery of a send state's message will be recorded by its send
     * orchestration: it ran out of delivery attempts, a refusal ended them,
     * the worker delivers nothing, or the orchestration ended without
     * recording one (the controller's collection finds it ended). In one
     * transaction under the workflow's session lock, either:
     * - a workflow recipient accepted the message after all
     *   (sendAcceptanceIn): that acceptance is recorded as the delivery
     *   (`delivered`, as recordDelivery records one; deliverIn); the
     *   recipient refuses a fresh input for the message once this
     *   transaction decided it (requireUndecidedSend), so the two cannot
     *   both win; or
     * - the message from pending to failed and its state from pending to
     *   the given runtime error.
     * A delivery recorded first, or a state decided first, keeps its result.
     * An agent session's queue gives no such answer: one attempt may have
     * queued the message although its result is unknown.
     */
    async failDelivery(nodeExecutionId: string, result: NodeResultInput, projection: SessionProjection | undefined,
        delivered: { stateId: string; projection: (receipt: WorkflowSendReceipt) => SessionProjection })
        : Promise<{ delivered: boolean; won: boolean; node: WorkflowNodeExecutionRow; message: WorkflowOutboxMessage }> {
        return this.transaction(async client => {
            const workflowSessionId = await this.workflowOfNode(client, nodeExecutionId);
            const live = await this.lockLiveSession(client, workflowSessionId);
            const { rows: pendingRows } = await client.query(
                `SELECT ${OUTBOX_COLUMNS} FROM ${this.t.outbox} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            if (!pendingRows[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Node execution ${nodeExecutionId} has no outbox message.`);
            const pending = outboxFrom(pendingRows[0]);
            if (pending.mode !== "send") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${nodeExecutionId} is not a send state's message.`);
            if (pending.state === "pending" && pending.recipientKind === "workflow") {
                const accepted = await this.sendAcceptanceIn(client, pending);
                if (accepted.kind === "accepted") {
                    const recorded = await this.deliverIn(client, workflowSessionId, live, pending,
                        { stateId: delivered.stateId, clientMessageId: null, input: accepted.input }, delivered.projection);
                    return { delivered: true, ...recorded };
                }
            }
            const { rows: failed } = await client.query(
                `UPDATE ${this.t.outbox} SET state = 'failed', decided_at = clock_timestamp(), error = $2
                  WHERE node_execution_id = $1 AND state = 'pending' RETURNING ${OUTBOX_COLUMNS}`, [nodeExecutionId, result.valueText]);
            const { rows: completed } = live && failed[0] ? await client.query(
                `UPDATE ${this.t.nodes}
                    SET state = 'completed', outcome = $2, result_kind = $3,
                        output = CASE WHEN $3 = 'business' THEN $4 END,
                        error = CASE WHEN $3 = 'runtime_error' THEN $4 END,
                        winner = $5, completed_at = now()
                  WHERE node_execution_id = $1 AND state = 'pending' RETURNING *`,
                [nodeExecutionId, result.outcome, result.resultKind, result.valueText, result.winner]) : { rows: [] };
            if (completed[0]) await this.project(client, projection);
            const node = completed[0] ? nodeFrom(completed[0]) : await this.nodeIn(client, nodeExecutionId);
            return { delivered: false, won: Boolean(completed[0]), node, message: failed[0] ? outboxFrom(failed[0]) : pending };
        });
    }

    // ─── Durable recipient intake (migration 0094; inactive: no runtime calls these yet) ──

    /** One reading of the store's clock, as text that later statements of the transaction read back exactly. */
    private async clockIn(client: PoolClient): Promise<string> {
        const { rows } = await client.query("SELECT clock_timestamp()::text AS at");
        return str(rows[0], "at");
    }

    /** An exchange's outbox row FOR UPDATE, with its intake columns and its send state's id; null when there is none. */
    private async intakeOutboxIn(client: PoolClient, exchangeId: string): Promise<IntakeOutboxRow | null> {
        const { rows } = await client.query(
            `SELECT exchange_id, node_execution_id, workflow_session_id, run_id, mode, recipient_session_id, recipient_kind, contract, payload,
                    payload_sha256, correlation, intake_mode
               FROM ${this.t.outbox} WHERE exchange_id = $1 FOR UPDATE`, [exchangeId]);
        const row = rows[0];
        if (!row) return null;
        const nodeExecutionId = str(row, "node_execution_id");
        return {
            exchangeId: str(row, "exchange_id"), nodeExecutionId, workflowSessionId: str(row, "workflow_session_id"), runId: str(row, "run_id"),
            mode: str(row, "mode"), recipientSessionId: str(row, "recipient_session_id"), recipientKind: strOrNull(row, "recipient_kind") ?? "agent",
            contract: str(row, "contract"), payloadText: str(row, "payload"), payloadSha256: str(row, "payload_sha256"),
            correlationText: strOrNull(row, "correlation"), intakeMode: strOrNull(row, "intake_mode"),
            stateId: (await this.nodeIn(client, nodeExecutionId)).nodeId,
        };
    }

    /**
     * The session pair, then the outbox row, of an exchange to
     * `recipientSessionId`, in beginDelivery's lock order (design 5.6):
     * lockSessionPair (the sending workflow's session row FOR NO KEY UPDATE
     * and the recipient's FOR SHARE, ascending session id), then the outbox
     * row FOR UPDATE. The pair is read from the outbox row's immutable
     * columns before any lock. Null when the exchange has no outbox message
     * or names another recipient: nothing is locked or read for it.
     */
    private async lockIntakeExchange(client: PoolClient, exchangeId: string, recipientSessionId: string)
        : Promise<{ outbox: IntakeOutboxRow; sender: AuthoritySession | null; recipient: AuthoritySession | null } | null> {
        const { rows: found } = await client.query(
            `SELECT workflow_session_id, recipient_session_id FROM ${this.t.outbox} WHERE exchange_id = $1`, [exchangeId]);
        if (!found[0] || str(found[0], "recipient_session_id") !== recipientSessionId) return null;
        const locked = await this.lockSessionPair(client, str(found[0], "workflow_session_id"), recipientSessionId);
        const outbox = await this.intakeOutboxIn(client, exchangeId);
        if (!outbox) return corrupt(`Exchange ${exchangeId} lost its outbox message under its lock.`);
        return { outbox, sender: locked.workflow, recipient: locked.other };
    }

    /** The intake rows of `exchangeIds` and of `invocationId` (when given), FOR UPDATE in exchange id order; a missing named row is broken. */
    private async lockIntakeRows(client: PoolClient, exchangeIds: readonly string[], invocationId: string | null = null)
        : Promise<Map<string, WorkflowIntakeRow>> {
        const { rows } = await client.query(
            `SELECT ${INTAKE_COLUMNS} FROM ${this.t.intake}
              WHERE exchange_id = ANY($1::text[]) OR ($2::text IS NOT NULL AND invocation_id = $2::text)
              ORDER BY exchange_id FOR UPDATE`, [[...exchangeIds], invocationId]);
        const found = new Map<string, WorkflowIntakeRow>();
        for (const row of rows) {
            const intake = intakeFrom(row);
            found.set(intake.exchangeId, intake);
        }
        for (const exchangeId of exchangeIds) if (!found.has(exchangeId)) intakeBroken(exchangeId, "it has no intake row");
        return found;
    }

    /** One locked intake row that must exist. */
    private async lockIntakeRow(client: PoolClient, exchangeId: string): Promise<WorkflowIntakeRow> {
        const row = (await this.lockIntakeRows(client, [exchangeId])).get(exchangeId);
        return row ?? intakeBroken(exchangeId, "it has no intake row");
    }

    /**
     * The refusal transaction's writes (design 5.6), made after
     * lockIntakeExchange locked the session pair and the outbox row, and
     * with the intake row locked or known absent: the row is inserted refused
     * by a claim (its text is not stored, its hash is), or moved from holding
     * to refused by its holder. With the sending workflow live, the outbox row
     * gets its intake outcome, from unset only, and the workflow's session
     * one event and a touch (its row is held FOR NO KEY UPDATE); with it
     * deleted or missing, neither, and nothing is projected on it. The
     * recipient's session gets one event and nothing else: its row is held
     * only FOR SHARE and is never updated or touched. The outbox row's
     * delivery state, attempts and receipt are not changed.
     */
    private async refuseIntakeIn(client: PoolClient, refusal: {
        outbox: IntakeOutboxRow;
        sender: AuthoritySession | null;
        recipient: AuthoritySession | null;
        recipientSessionId: string;
        claimId: string;
        outcome: WorkflowIntakeRefusal;
        /** A claim's new row (its envelope and text hashes), or null for the holder's settle of its holding row. */
        insert: { envelopeSha256: string; textSha256: string } | null;
    }): Promise<void> {
        const { outbox, outcome } = refusal;
        const at = await this.clockIn(client);
        if (refusal.insert) {
            await client.query(
                `INSERT INTO ${this.t.intake} (exchange_id, recipient_session_id, workflow_session_id, run_id, envelope_sha256, text, text_sha256,
                        claim_id, state, created_at, updated_at, settled_at)
                 VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9::timestamptz, $9::timestamptz, $9::timestamptz)`,
                [outbox.exchangeId, refusal.recipientSessionId, outbox.workflowSessionId, outbox.runId, refusal.insert.envelopeSha256,
                    refusal.insert.textSha256, refusal.claimId, outcome, at]);
        } else {
            const { rowCount } = await client.query(
                `UPDATE ${this.t.intake} SET state = $2, settled_at = $3::timestamptz, updated_at = $3::timestamptz
                  WHERE exchange_id = $1 AND state = 'holding' AND claim_id = $4`, [outbox.exchangeId, outcome, at, refusal.claimId]);
            if (rowCount !== 1) intakeBroken(outbox.exchangeId, "it changed under its lock");
        }
        if (refusal.sender !== null && !refusal.sender.deleted) {
            const { rows: annotated } = await client.query(
                `UPDATE ${this.t.outbox} SET intake_outcome = $2, intake_outcome_at = $3::timestamptz
                  WHERE exchange_id = $1 AND intake_outcome IS NULL RETURNING exchange_id`, [outbox.exchangeId, outcome, at]);
            if (!annotated[0]) intakeBroken(outbox.exchangeId, "its message already has an intake outcome");
            await this.project(client, { sessionId: outbox.workflowSessionId, update: { touch: true }, events: [{
                eventType: INTAKE_REFUSED_WORKFLOW_EVENT, data: {
                    runId: outbox.runId, nodeExecutionId: outbox.nodeExecutionId, stateId: outbox.stateId, exchangeId: outbox.exchangeId,
                    recipientSessionId: refusal.recipientSessionId, outcome,
                },
            }] });
        }
        if (refusal.recipient !== null) {
            await this.project(client, { sessionId: refusal.recipientSessionId, events: [{
                eventType: INTAKE_REFUSED_RECIPIENT_EVENT, data: {
                    workflowSessionId: outbox.workflowSessionId, runId: outbox.runId, exchangeId: outbox.exchangeId, outcome,
                },
            }] });
        }
    }

    /**
     * Claim an exchange for its recipient (design 5.2). One transaction:
     * lockIntakeExchange (the session pair, then the outbox row), then the
     * intake row. In this order:
     * - an exchange with no outbox message, or whose message is to another
     *   recipient, is unverified: nothing is locked, written or reported;
     * - an existing row: an envelope other than the row's (its hash differs,
     *   or does not hash its fields) is a conflict, another claim a duplicate,
     *   each counted on the row; the same claim gets the row's state and
     *   nothing is written: holding is accepted again with the stored text
     *   (an earlier call committed and its reply was lost), in either mode;
     * - no row: the message must verify (intakeMismatch), or the claim is
     *   unverified and nothing is written;
     * - then the item is rendered from the outbox row with the caller's
     *   renderer (the sender's own; the store does not import the runtime). A
     *   claim in mode refuse inserts refused_full, and one in mode accept
     *   whose text is over INTAKE_MAX_TEXT_BYTES or whose item would not fit
     *   one invocation alone inserts refused_size, both in the refusal
     *   transaction (refuseIntakeIn); otherwise the row is inserted
     *   holding(claim) with the canonical text, and the item returned with its
     *   exact size.
     */
    async claimWorkflowIntake(input: {
        recipientSessionId: string;
        envelope: IntakeEnvelope;
        claimId: string;
        mode: "accept" | "refuse";
        render: WorkflowIntakeRender;
    }): Promise<WorkflowIntakeClaimResult> {
        const envelope = parseIntakeEnvelope(input.envelope, "envelope");
        const claimId = intakeId(input.claimId, "claimId");
        const recipientSessionId = intakeId(input.recipientSessionId, "recipientSessionId");
        const mode: unknown = input.mode;
        if (mode !== "accept" && mode !== "refuse") throw new IntakeShapeError("mode", "is not accept or refuse");
        if (typeof input.render !== "function") throw new IntakeShapeError("render", "is not a function");
        return this.transaction<WorkflowIntakeClaimResult>(async client => {
            const locked = await this.lockIntakeExchange(client, envelope.exchangeId, recipientSessionId);
            if (!locked) return { result: "unverified", reason: "the exchange has no message to this session" };
            const { outbox } = locked;
            const { rows: existing } = await client.query(
                `SELECT ${INTAKE_COLUMNS} FROM ${this.t.intake} WHERE exchange_id = $1 FOR UPDATE`, [outbox.exchangeId]);
            if (existing[0]) {
                const row = intakeFrom(existing[0]);
                if (row.recipientSessionId !== recipientSessionId) return intakeBroken(row.exchangeId, "its row names another recipient than its message");
                const counter = envelope.envelopeSha256 !== row.envelopeSha256 || intakeEnvelopeSha256(envelope) !== envelope.envelopeSha256
                    ? "conflicts" as const : row.claimId !== claimId ? "duplicates" as const : null;
                if (counter !== null) {
                    await client.query(
                        `UPDATE ${this.t.intake} SET ${counter} = ${counter} + 1, updated_at = clock_timestamp() WHERE exchange_id = $1`, [row.exchangeId]);
                    return { result: counter === "conflicts" ? "conflict" : "duplicate", state: row.state };
                }
                if (row.state === "holding") {
                    const { clientMessageId } = renderedIntake(input.render, intakeRenderSource(outbox));
                    return { result: "accepted", inserted: false, item: heldIntakeItem(row, clientMessageId) };
                }
                if (row.state === "admitted" || row.state === "cancelled") return { result: row.state, inserted: false };
                return { result: row.state, inserted: false };
            }
            const reason = intakeMismatch(outbox, envelope, recipientSessionId);
            if (reason !== null) return { result: "unverified", reason };
            const rendered = renderedIntake(input.render, intakeRenderSource(outbox));
            const textSha256 = sha256Hex(rendered.text);
            const itemBytes = intakeItemBytes(intakeBoundItem(
                { exchangeId: outbox.exchangeId, claimId, textSha256, clientMessageId: rendered.clientMessageId }, rendered.text));
            const refusal: WorkflowIntakeRefusal | null = mode === "refuse" ? "refused_full"
                : intakeTextWithinCap(rendered.text) && intakeItemFitsAlone(itemBytes) ? null : "refused_size";
            if (refusal !== null) {
                await this.refuseIntakeIn(client, { ...locked, recipientSessionId, claimId, outcome: refusal,
                    insert: { envelopeSha256: envelope.envelopeSha256, textSha256 } });
                return { result: refusal, inserted: true };
            }
            const at = await this.clockIn(client);
            await client.query(
                `INSERT INTO ${this.t.intake} (exchange_id, recipient_session_id, workflow_session_id, run_id, envelope_sha256, text, text_sha256,
                        claim_id, state, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'holding', $9::timestamptz, $9::timestamptz)`,
                [outbox.exchangeId, recipientSessionId, outbox.workflowSessionId, outbox.runId, envelope.envelopeSha256, rendered.text, textSha256,
                    claimId, at]);
            return { result: "accepted", inserted: true, item: {
                exchangeId: outbox.exchangeId, claimId, text: rendered.text, textSha256, clientMessageId: rendered.clientMessageId, itemBytes,
            } };
        });
    }

    /**
     * Bind held claims to an invocation (design 5.2, 5.5): the logical
     * admission. Every named row is the recipient's under its claim, and
     * either all are holding (each becomes admitted, bound to the invocation,
     * processing bound) or all are already admitted to this invocation (a
     * replay: nothing is written). Any other row, or a batch found partly
     * bound, is a broken invariant. Returns each row's stored text and hash
     * in the caller's order.
     */
    async bindWorkflowIntake(input: { recipientSessionId: string; invocationId: string; items: ReadonlyArray<{ exchangeId: string; claimId: string }> })
        : Promise<{ bound: boolean; items: WorkflowIntakeBoundText[] }> {
        const recipientSessionId = intakeId(input.recipientSessionId, "recipientSessionId");
        const invocationId = intakeId(input.invocationId, "invocationId");
        const items = intakeBatch(input.items, "items", false);
        return this.transaction<{ bound: boolean; items: WorkflowIntakeBoundText[] }>(async client => {
            const rows = await this.lockIntakeRows(client, items.map(item => item.exchangeId));
            const named = items.map(item => {
                const row = rows.get(item.exchangeId) ?? intakeBroken(item.exchangeId, "it has no intake row");
                assertIntakeHolder(row, recipientSessionId, item.claimId);
                if (row.state !== "holding" && (row.state !== "admitted" || row.invocationId !== invocationId)) {
                    intakeBroken(row.exchangeId, `it is ${row.state}${row.invocationId === null ? "" : ` for invocation ${row.invocationId}`}, `
                        + `not holding or bound to invocation ${invocationId}`);
                }
                return row;
            });
            const holding = named.filter(row => row.state === "holding");
            if (holding.length > 0 && holding.length < named.length) {
                intakeBroken(holding[0].exchangeId, `it is holding while the rest of invocation ${invocationId}'s batch is bound`);
            }
            if (holding.length > 0) {
                const at = await this.clockIn(client);
                const { rowCount } = await client.query(
                    `UPDATE ${this.t.intake}
                        SET state = 'admitted', invocation_id = $2, processing = 'bound', admitted_at = $3::timestamptz, updated_at = $3::timestamptz
                      WHERE exchange_id = ANY($1::text[]) AND state = 'holding'`, [holding.map(row => row.exchangeId), invocationId, at]);
                if (rowCount !== holding.length) return corrupt(`Invocation ${invocationId}'s batch changed under its locks.`);
            }
            return { bound: holding.length > 0, items: named.map(row => {
                if (row.text === null || sha256Hex(row.text) !== row.textSha256) return intakeBroken(row.exchangeId, "its stored text does not match its hash");
                return { exchangeId: row.exchangeId, claimId: row.claimId, text: row.text, textSha256: row.textSha256 };
            }) };
        });
    }

    /**
     * End an invocation (design 5.2, 5.5): its batch's rows, each the
     * recipient's under its claim and bound to it, move together from
     * processing bound to `outcome`, with settled_at, and the items whose
     * cancel flag is set record cancel_requested. A batch already at
     * `outcome` is the same end (a replay; nothing is written). A row of the
     * batch at another value, a batch found partly ended, or a row of the
     * invocation still bound but missing from the batch is a broken
     * invariant. Rows of the invocation that a cancel already settled
     * (cancelUnsentWorkflowIntake) are not part of its batch.
     */
    async endWorkflowIntake(input: {
        recipientSessionId: string;
        invocationId: string;
        outcome: IntakeProcessingOutcome;
        items: ReadonlyArray<{ exchangeId: string; claimId: string; cancelRequested: boolean }>;
    }): Promise<{ ended: boolean }> {
        const recipientSessionId = intakeId(input.recipientSessionId, "recipientSessionId");
        const invocationId = intakeId(input.invocationId, "invocationId");
        const outcome: unknown = input.outcome;
        if (typeof outcome !== "string" || !(INTAKE_PROCESSING_OUTCOMES as readonly string[]).includes(outcome)) {
            throw new IntakeShapeError("outcome", `is not one of ${INTAKE_PROCESSING_OUTCOMES.join(", ")}`);
        }
        const items = intakeBatch(input.items, "items", true);
        return this.transaction<{ ended: boolean }>(async client => {
            const rows = await this.lockIntakeRows(client, items.map(item => item.exchangeId), invocationId);
            const batch = new Set(items.map(item => item.exchangeId));
            let ended = 0;
            for (const item of items) {
                const row = rows.get(item.exchangeId) ?? intakeBroken(item.exchangeId, "it has no intake row");
                assertIntakeHolder(row, recipientSessionId, item.claimId);
                if (row.state !== "admitted" || row.invocationId !== invocationId) intakeBroken(row.exchangeId, `it is not bound to invocation ${invocationId}`);
                if (row.processing === outcome) ended += 1;
                else if (row.processing !== "bound") intakeBroken(row.exchangeId, `its processing is ${row.processing}, not bound or ${outcome}`);
            }
            if (ended > 0 && ended < items.length) intakeBroken(items[0].exchangeId, `invocation ${invocationId}'s batch is partly ended`);
            for (const row of rows.values()) {
                if (row.invocationId === invocationId && row.processing === "bound" && !batch.has(row.exchangeId)) {
                    intakeBroken(row.exchangeId, `it is bound to invocation ${invocationId} but missing from its end`);
                }
            }
            if (ended === items.length) return { ended: false };
            const at = await this.clockIn(client);
            const { rowCount } = await client.query(
                `UPDATE ${this.t.intake}
                    SET processing = $3, settled_at = $4::timestamptz, updated_at = $4::timestamptz,
                        cancel_requested = cancel_requested OR exchange_id = ANY($5::text[])
                  WHERE exchange_id = ANY($1::text[]) AND invocation_id = $2 AND processing = 'bound'`,
                [items.map(item => item.exchangeId), invocationId, outcome, at, items.filter(item => item.cancelRequested).map(item => item.exchangeId)]);
            if (rowCount !== items.length) return corrupt(`Invocation ${invocationId}'s batch changed under its locks.`);
            return { ended: true };
        });
    }

    /** Cancel a held claim (design 5.2): holding(claim) becomes cancelled. Already cancelled under it: the same (nothing written). */
    async cancelHeldWorkflowIntake(input: { recipientSessionId: string; exchangeId: string; claimId: string }): Promise<{ cancelled: boolean }> {
        const recipientSessionId = intakeId(input.recipientSessionId, "recipientSessionId");
        const exchangeId = intakeExchangeId(input.exchangeId, "exchangeId");
        const claimId = intakeId(input.claimId, "claimId");
        return this.transaction<{ cancelled: boolean }>(async client => {
            const row = await this.lockIntakeRow(client, exchangeId);
            assertIntakeHolder(row, recipientSessionId, claimId);
            if (row.state === "cancelled") return { cancelled: false };
            if (row.state !== "holding") return intakeBroken(exchangeId, `it is ${row.state}, not holding`);
            const at = await this.clockIn(client);
            await client.query(
                `UPDATE ${this.t.intake} SET state = 'cancelled', settled_at = $2::timestamptz, updated_at = $2::timestamptz
                  WHERE exchange_id = $1 AND state = 'holding'`, [exchangeId, at]);
            return { cancelled: true };
        });
    }

    /**
     * Cancel an item of an invocation not yet sent (design 5.2, 5.5): admitted
     * to that invocation with processing bound becomes not_dispatched, reason
     * cancelled. Already so: the same (nothing written).
     */
    async cancelUnsentWorkflowIntake(input: { recipientSessionId: string; exchangeId: string; claimId: string; invocationId: string })
        : Promise<{ cancelled: boolean }> {
        const recipientSessionId = intakeId(input.recipientSessionId, "recipientSessionId");
        const exchangeId = intakeExchangeId(input.exchangeId, "exchangeId");
        const claimId = intakeId(input.claimId, "claimId");
        const invocationId = intakeId(input.invocationId, "invocationId");
        return this.transaction<{ cancelled: boolean }>(async client => {
            const row = await this.lockIntakeRow(client, exchangeId);
            assertIntakeHolder(row, recipientSessionId, claimId);
            if (row.state !== "admitted" || row.invocationId !== invocationId) return intakeBroken(exchangeId, `it is not bound to invocation ${invocationId}`);
            if (row.processing === "not_dispatched" && row.reason === "cancelled") return { cancelled: false };
            if (row.processing !== "bound") return intakeBroken(exchangeId, `its processing is ${row.processing}, not bound`);
            const at = await this.clockIn(client);
            await client.query(
                `UPDATE ${this.t.intake} SET processing = 'not_dispatched', reason = 'cancelled', settled_at = $2::timestamptz, updated_at = $2::timestamptz
                  WHERE exchange_id = $1 AND processing = 'bound'`, [exchangeId, at]);
            return { cancelled: true };
        });
    }

    /**
     * Record a cancel of an item whose invocation was possibly sent (design
     * 5.2, 5.5): cancel_requested becomes true; its processing is not changed.
     * Already recorded: the same (nothing written).
     */
    async requestCancelWorkflowIntake(input: { recipientSessionId: string; exchangeId: string; claimId: string; invocationId: string })
        : Promise<{ recorded: boolean }> {
        const recipientSessionId = intakeId(input.recipientSessionId, "recipientSessionId");
        const exchangeId = intakeExchangeId(input.exchangeId, "exchangeId");
        const claimId = intakeId(input.claimId, "claimId");
        const invocationId = intakeId(input.invocationId, "invocationId");
        return this.transaction<{ recorded: boolean }>(async client => {
            const row = await this.lockIntakeRow(client, exchangeId);
            assertIntakeHolder(row, recipientSessionId, claimId);
            if (row.state !== "admitted" || row.invocationId !== invocationId) return intakeBroken(exchangeId, `it is not bound to invocation ${invocationId}`);
            if (row.cancelRequested) return { recorded: false };
            await client.query(
                `UPDATE ${this.t.intake} SET cancel_requested = true, updated_at = clock_timestamp() WHERE exchange_id = $1`, [exchangeId]);
            return { recorded: true };
        });
    }

    /**
     * Refuse a held claim (design 5.2, 5.4, 5.6): holding(claim) becomes
     * `outcome` in the refusal transaction (lockIntakeExchange, then the
     * intake row; refuseIntakeIn). Already refused so under it: the same
     * (nothing written).
     */
    async refuseHeldWorkflowIntake(input: { recipientSessionId: string; exchangeId: string; claimId: string; outcome: WorkflowIntakeRefusal })
        : Promise<{ refused: boolean }> {
        const recipientSessionId = intakeId(input.recipientSessionId, "recipientSessionId");
        const exchangeId = intakeExchangeId(input.exchangeId, "exchangeId");
        const claimId = intakeId(input.claimId, "claimId");
        const outcome: unknown = input.outcome;
        if (outcome !== "refused_full" && outcome !== "refused_size") throw new IntakeShapeError("outcome", "is not refused_full or refused_size");
        return this.transaction<{ refused: boolean }>(async client => {
            const locked = await this.lockIntakeExchange(client, exchangeId, recipientSessionId);
            if (!locked) return intakeBroken(exchangeId, "it has no message to this session");
            const row = await this.lockIntakeRow(client, exchangeId);
            assertIntakeHolder(row, recipientSessionId, claimId);
            if (row.state === outcome) return { refused: false };
            if (row.state !== "holding") return intakeBroken(exchangeId, `it is ${row.state}, not holding`);
            await this.refuseIntakeIn(client, { ...locked, recipientSessionId, claimId, outcome, insert: null });
            return { refused: true };
        });
    }

    /** An exchange's intake row as stored, or null. */
    async readWorkflowIntake(exchangeId: string): Promise<WorkflowIntakeRow | null> {
        if (!storableId(exchangeId)) return null;
        const { rows } = await this.pool.query(`SELECT ${INTAKE_COLUMNS} FROM ${this.t.intake} WHERE exchange_id = $1`, [exchangeId]);
        return rows[0] ? intakeFrom(rows[0]) : null;
    }

    /**
     * End an active run once. Returns the stored run and whether this call
     * ended it; a later call sees the first terminal result. A message that
     * one of its send states sent to a workflow and that is still pending is
     * decided with it (decidePendingSendsIn).
     */
    async finishRun(input: {
        runId: string;
        status: "completed" | "failed" | "cancelled";
        terminalNodeId: string | null;
        terminalOutcome: string | null;
        outputText: string | null;
        errorText: string | null;
        /**
         * Every node execution still pending when the run ends is completed in
         * the same transaction as a cancelled runtime error with this winner,
         * so no result can arrive after the run's terminal state.
         */
        endPending: { winner: "cancel" | "controller"; message: string };
        /** Terminal node execution to complete (first) in the same transaction. */
        terminalNode?: { nodeExecutionId: string; result: NodeResultInput } | null;
        /**
         * An operation receipt (recover) stored in the same transaction when
         * this call ends the run. When the operation id already has a receipt,
         * nothing changes and OPERATION_CONFLICT is thrown; the caller reads
         * that receipt.
         */
        receipt?: OperationReceiptInput | null;
        projection?: SessionProjection;
    }): Promise<{ ended: boolean; run: WorkflowRunRow }> {
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfRun(client, input.runId));
            const run = await this.lockRun(client, input.runId);
            if (!live || !ACTIVE_RUN_STATUSES.includes(run.status)) return { ended: false, run };
            if (input.receipt) await this.insertReceiptOnce(client, run.workflowSessionId, input.receipt);
            const { rows } = await client.query(
                `UPDATE ${this.t.runs}
                    SET status = $2, terminal_node_id = $3, terminal_outcome = $4, terminal_output = $5, terminal_error = $6,
                        paused_from = NULL, updated_at = now(), finished_at = now()
                  WHERE run_id = $1 RETURNING *`,
                [input.runId, input.status, input.terminalNodeId, input.terminalOutcome, input.outputText, input.errorText]);
            if (input.terminalNode) {
                const { result } = input.terminalNode;
                await client.query(
                    `UPDATE ${this.t.nodes}
                        SET state = 'completed', outcome = $2, result_kind = $3,
                            output = CASE WHEN $3 = 'business' THEN $4 END,
                            error = CASE WHEN $3 = 'runtime_error' THEN $4 END,
                            winner = $5, completed_at = now()
                      WHERE node_execution_id = $1 AND run_id = $6 AND state = 'pending'`,
                    [input.terminalNode.nodeExecutionId, result.outcome, result.resultKind, result.valueText, result.winner, input.runId]);
            }
            await client.query(
                `UPDATE ${this.t.nodes}
                    SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error', error = $2, output = NULL,
                        winner = $3, completed_at = now()
                  WHERE run_id = $1 AND state = 'pending'`,
                [input.runId, canonicalJson({ code: "cancelled", message: input.endPending.message }), input.endPending.winner]);
            await this.decidePendingSendsIn(client, run.workflowSessionId, input.runId);
            await this.project(client, input.projection);
            return { ended: true, run: runFrom(rows[0]) };
        });
    }
}

export interface RunAdmission {
    runId: string;
    mode: WorkflowRunMode;
    controllerInstanceId: string;
    inputsText: string;
    /** The initial open KV map as canonical JSON text (revision 1). */
    kvText: string;
    testAgentMode: "mocked" | "real" | null;
}

/** The receipt of a run command (set_vars, pause, resume, cancel). */
export interface WorkflowRunCommandReceipt {
    workflowSessionId: string;
    operation: string;
    runId: string;
    /** The run status after the command (cancel: when it was accepted; the controller applies it). */
    status: WorkflowRunStatus;
    kvRevision: number;
}

/** The receipt of a parent session's lifecycle command to its v2 workflow child (recordSessionCommand). */
export interface WorkflowSessionCommandReceipt {
    workflowSessionId: string;
    command: "cancel" | "done" | "delete";
    /** In the store (the child's run had not begun, or a delete), by the run's controller (queued), or nothing to apply. */
    applied: "store" | "queued" | "none";
    runId: string | null;
    /** The run's status as the command was accepted, after the store applied it; "deleted" for a delete applied in the store. */
    status: string | null;
}

export function parseSessionCommandReceipt(value: JsonValue): WorkflowSessionCommandReceipt {
    const invalid = () => new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "Stored session command receipt has an invalid shape.");
    if (!isJsonObject(value)) throw invalid();
    const { workflowSessionId, command, applied, runId, status } = value;
    if (typeof workflowSessionId !== "string" || (command !== "cancel" && command !== "done" && command !== "delete")
        || (applied !== "store" && applied !== "queued" && applied !== "none")
        || (runId !== null && typeof runId !== "string") || (status !== null && typeof status !== "string")) {
        throw invalid();
    }
    return { workflowSessionId, command, applied, runId, status };
}

function parseRunCommandReceipt(value: JsonValue): WorkflowRunCommandReceipt {
    const invalid = () => new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "Stored run command receipt has an invalid shape.");
    if (!isJsonObject(value)) throw invalid();
    const { workflowSessionId, operation, runId, status, kvRevision } = value;
    if (typeof workflowSessionId !== "string" || typeof operation !== "string" || typeof runId !== "string"
        || typeof status !== "string" || !isRunStatus(status) || typeof kvRevision !== "number") {
        throw invalid();
    }
    return { workflowSessionId, operation, runId, status, kvRevision };
}

function actorJson(actor: WorkflowActor): JsonValue {
    if (actor.kind === "agent") return { kind: "agent", sessionId: actor.sessionId };
    if (actor.kind === "user") return { kind: "user", provider: actor.provider, subject: actor.subject };
    return { kind: "system", name: actor.name };
}

/** A KV key: 1-128 characters of storable text. */
export function isKvKey(key: string): boolean {
    return key.length >= 1 && key.length <= WORKFLOW_V2_KV_LIMITS.maxKeyLength && isStorableText(key);
}

/** The canonical text of a whole KV map within the limits, or KV_LIMIT. */
export function checkedKvText(kv: { [key: string]: JsonValue }): string {
    const keys = Object.keys(kv);
    if (keys.length > WORKFLOW_V2_KV_LIMITS.maxKeys) {
        throw new WorkflowStoreError("KV_LIMIT", `The KV map would hold ${keys.length} keys; the limit is ${WORKFLOW_V2_KV_LIMITS.maxKeys}.`);
    }
    for (const key of keys) {
        if (!isKvKey(key)) throw new WorkflowStoreError("KV_LIMIT", `KV keys are 1-${WORKFLOW_V2_KV_LIMITS.maxKeyLength} characters of valid text.`, { key: jsonbSafeText(key, 200) });
        const bytes = Buffer.byteLength(canonicalJson(kv[key]), "utf8");
        if (bytes > WORKFLOW_V2_KV_LIMITS.maxValueBytes) {
            throw new WorkflowStoreError("KV_LIMIT", `The value of '${jsonbSafeText(key, 200)}' is ${bytes} bytes; the limit is ${WORKFLOW_V2_KV_LIMITS.maxValueBytes}.`);
        }
    }
    const text = canonicalJson(kv);
    const total = Buffer.byteLength(text, "utf8");
    if (total > WORKFLOW_V2_KV_LIMITS.maxTotalBytes) {
        throw new WorkflowStoreError("KV_LIMIT", `The KV map would be ${total} bytes; the limit is ${WORKFLOW_V2_KV_LIMITS.maxTotalBytes}.`);
    }
    return text;
}

function assertNotDeleted(definition: WorkflowDefinitionRow): void {
    if (definition.state === "deleted") throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow was deleted.");
}
