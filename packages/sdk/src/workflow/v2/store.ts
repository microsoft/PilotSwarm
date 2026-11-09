import type { Pool, PoolClient } from "pg";
import {
    AGENT_REPORTED_ERROR_CODES, MESSAGE_SENT, parseDiagnostics, parseWorkflowIr, RECEIVE_RECEIVED, REQUEST_DECLINED, REQUEST_RESPONDED, WAIT_ELAPSED, WAIT_MAX_SECONDS,
    WORKFLOW_V2_API_VERSION, WORKFLOW_V2_MAX_YAML_BYTES, WORKFLOW_V2_MILESTONE_IR_VERSION, type WorkflowCompileResult, type WorkflowDiagnostic, type WorkflowIR,
    type WorkflowIRClockWait, type WorkflowIRNode,
} from "./compiler.js";
import { computeCronAtNextFire } from "../../cron-at.js";
import {
    assertJsonValue, canonicalJson, isJsonObject, isStorableText, jsonbSafeText, jsonbSafeValue, jsonSha256, kindValueSha256, parseStoredJson, sha256Hex,
    utf8ByteLength, WORKFLOW_PAYLOAD_MAX_BYTES, WorkflowJsonError, type JsonValue,
} from "./json.js";
import { decideRequestAuthority, decideTypedInputAuthority, TYPED_INPUT_REFUSALS, type AuthoritySession, type TypedInputAuthority } from "./authority.js";
import {
    redactErrorThenClip, redactThenClip, redactWorkflowErrorText, redactWorkflowErrorValue, redactWorkflowEventData, redactWorkflowSecrets,
    type WorkflowErrorRedaction,
} from "./redact.js";
import { schemaSetFor, WorkflowSchemaSet, type SchemaProblem } from "./schema.js";
import {
    INTAKE_MAX_HELD, INTAKE_MAX_ID_LENGTH, INTAKE_PROCESSING_OUTCOMES, INTAKE_REFUSED_RECIPIENT_EVENT, INTAKE_REFUSED_WORKFLOW_EVENT, intakeBoundItem,
    intakeClientMessageId, intakeEnvelopeSha256, intakeExchangeId, intakeId, intakeItemBytes, intakeItemFitsAlone, intakeObject, intakeSha256,
    intakeTextWithinCap, IntakeShapeError, parseIntakeEnvelope, type IntakeEnvelope, type IntakeProcessingOutcome,
} from "./intake.js";
import {
    BRANCH_CANCEL_WINNERS, BRANCH_CANCEL_WINNER_VALUES, branchCancelError, branchCancelReasonOf, branchScopeIds, branchScopeNameList, branchScopeNames,
    parallelBlockedResult, parallelBranchEnd, parallelJoinedOutput,
    parallelBranchStates, parallelSuccesses, parallelTimeoutResult, parallelVerdict, parseBranchScope, type BranchCancelReason, type ParallelBranchState,
    type ParallelCommit,
} from "./parallel.js";
import { ChatDefinitionStore, requireBenchLiveLocked, requireChatStartLocked } from "./chat-definition-store.js";
import { workflowAgentChatContinues } from "./agent-ids.js";

/**
 * PostgreSQL persistence for workflow v2 (tables from migrations 0089 and 0091 to 0100).
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

/**
 * UXP-AD-01: a run's latest control action that names who took it (WorkflowStore.readLastRunControl). `displayName`: a
 * person's name from the users table, when it has one; null otherwise and for any other actor. `reason`: as stored (its
 * secrets hidden, at most 500 characters), null when none.
 */
export interface WorkflowRunControl {
    operation: "pause" | "resume" | "stop" | "cancel" | "set_vars";
    actor: WorkflowActor;
    displayName: string | null;
    at: Date;
    reason: string | null;
}

export type WorkflowDefinitionState = "draft" | "published" | "deleted";
/** `stopped` (migration 0100): a run that ended by a graceful stop (requestRunStop, finishStoppedRun); only controller 1.9.0 stops a run. */
export type WorkflowRunStatus = "admitted" | "running" | "paused" | "completed" | "failed" | "cancelled" | "stopped";
export type WorkflowRunMode = "live" | "test";
/** A run that has not ended: it can still be cancelled, deleted, recovered and finish its admitted work. */
export const ACTIVE_RUN_STATUSES: readonly WorkflowRunStatus[] = ["admitted", "running", "paused"];
/** A run that may admit a new node execution (a paused run admits none). */
export const ADMITTING_RUN_STATUSES: readonly WorkflowRunStatus[] = ["admitted", "running"];

/**
 * The winners of a node execution that a run's end, or a cut, cancelled: a lifecycle command (cancel), the workflow's
 * deletion (delete, the deletion trigger), a graceful stop, a failFast cut, or the run deadline.
 */
export type CancelledNodeWinner = "cancel" | "delete" | "stop" | "fail_fast" | "deadline";

/** A run whose controller has not begun it: admitted, or paused before it began. */
export function runNotBegun(run: { status: WorkflowRunStatus; pausedFrom: "admitted" | "running" | null }): boolean {
    return run.status === "admitted" || (run.status === "paused" && run.pausedFrom === "admitted");
}

/**
 * S7-DX2: the lifecycle command whose acceptance ended a begun run in the store (endRunForCommandIn), as its terminal error
 * records it: the command (cancel or done), who asked and the accepted operation. Null for any other end (a cancel before
 * the run began, a deletion, a finish, a failure, a stop, the run deadline) and for an active run.
 */
export function commandEndOf(run: Pick<WorkflowRunRow, "status" | "terminalError">): { command: "cancel" | "done"; requestedBy: string | null; operationId: string | null } | null {
    if (run.status !== "cancelled" || !isJsonObject(run.terminalError) || !isJsonObject(run.terminalError.details)) return null;
    const details = run.terminalError.details;
    if (details.accepted !== true || (details.command !== "cancel" && details.command !== "done")) return null;
    return { command: details.command, requestedBy: typeof details.requestedBy === "string" ? details.requestedBy : null,
        operationId: typeof details.operationId === "string" ? details.operationId : null };
}

/** The end the workflow session's deletion gives a run it ends (migrations 0090 and 0091, workflow_v2_on_session_deleted). */
export const WORKFLOW_V2_SESSION_DELETED_MESSAGE = "The workflow session was deleted.";

/**
 * Review R3-GR1: whether a run's stored end is its workflow's deletion: the deletion trigger's end, or a delete command's.
 * A run that a cancel, a done, its own terminal, a failure or its deadline ended first keeps that end, also when its
 * workflow was deleted afterwards (whatever ended the run first decides who is told).
 */
export function runEndedByDeletion(run: Pick<WorkflowRunRow, "status" | "terminalError">): boolean {
    if (run.status !== "cancelled" || !isJsonObject(run.terminalError)) return false;
    const error = run.terminalError;
    // Review DRR-5: the stored command decides first: a cancel, a done or an end before begin is not a deletion, whatever
    // its reason says (a person's reason can be the deletion's own words). The deletion trigger's end is recognised only
    // in its exact shape (migrations 0090 and 0091): its code and message, and nothing else.
    if (error.details !== undefined) return isJsonObject(error.details) && error.details.command === "delete";
    const keys = Object.keys(error);
    return keys.length === 2 && error.code === "cancelled" && error.message === WORKFLOW_V2_SESSION_DELETED_MESSAGE;
}

/** Open KV limits (design D07: proposed defaults, enforced on every update). */
export const WORKFLOW_V2_KV_LIMITS = { maxKeys: 1_000, maxKeyLength: 128, maxValueBytes: 256 * 1024, maxTotalBytes: 1024 * 1024 } as const;

/** of-06: the refusal of a test of a workflow that is not a draft (code TEST_NEEDS_DRAFT). */
export const WORKFLOW_V2_TEST_NEEDS_DRAFT_MESSAGE = "Only a draft can be tested, and this workflow is published. "
    + "To test a change, create a new workflow as a draft.";

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
    /**
     * What each named agent state of the published revision was resolved to at publication (migration 0103): state id ->
     * { name, package, version, packageId }; null when there is none.
     */
    publishedAgentPins: JsonValue;
    /**
     * Stage 2.1 (migration 0107): the chat definition and revision this Workflow is a copy of; null for a Workflow that is
     * not one (its chat was deleted, or it has no name). A pinned Workflow takes none of the stage 1 definition operations
     * (requireNotChatPinned).
     */
    chatDefinitionId: string | null;
    chatRevision: number | null;
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
    /** The controller version the run was admitted for (migration 0100); null for a run admitted before it. */
    controllerVersion: string | null;
    /** The run's accepted stop (migration 0100), written once; null when none was requested. */
    stop: WorkflowRunStop | null;
    /**
     * A test run's virtual clock (migration 0102): it starts at WORKFLOW_V2_TEST_EPOCH and moves only by advanceTestClock;
     * a test run's deadlines are counted from it. Null for a live run.
     */
    virtualNow: Date | null;
    /** The scenario a test run was started for (migration 0103); null for a live run and a test run without one. */
    testScenario: string | null;
    /**
     * The run's deadline (migration 0104; limits.timeoutSeconds, controller 1.9.0): the run's clock when it began (a test
     * run's virtual clock) plus those seconds; null for a run without one. It is not paused with the run.
     */
    deadlineAt: Date | null;
    /**
     * A real-agent test run's agent pins (migration 0105; design 05, R18): what its named agent states were pinned to when
     * the test was admitted, as a publication pins them, for a tested revision that is not the published one (a test of the
     * published revision uses the publication's pins). Null for every other run.
     */
    testAgentPins: JsonValue;
    /**
     * OF-S2-7: the agent nodes' models chosen at start (migration 0110; agent-models.ts), as stored: the text of an object of
     * agent node ids to { model, reasoningEffort?, contextTier? }, read with readStoredAgentModels where it is used (a spawn,
     * Run again, a read). Kept as text (DEV at fed7e7ac): a stored value that does not parse never makes reading the run fail.
     * Null for a run started without any (each node uses the chat's).
     */
    agentModels: string | null;
}

/**
 * An accepted graceful stop (requestRunStop): the run admits no new node
 * execution, and the work it admitted may settle until `deadlineAt` (the
 * store's clock at the stop plus `graceSeconds`); then whatever is still
 * pending is cancelled and the run ends stopped (finishStoppedRun).
 */
export interface WorkflowRunStop {
    requestedAt: Date;
    deadlineAt: Date;
    operationId: string;
    reason: string | null;
    actor: JsonValue;
    graceSeconds: number;
}

/** The longest grace a stop may give a run's admitted work to settle (design D03: a configured bound). */
export const WORKFLOW_V2_STOP_MAX_GRACE_SECONDS = 3_600;

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
    /** The KV revision pinned when this node execution was admitted (null before migration 0091). */
    kvRevision: number | null;
    /** A wait state's absolute deadline, fixed at its admission (migration 0092); null for other states. */
    deadlineAt: Date | null;
    /** What a receive state accepts, resolved when it was admitted (migration 0093); null for other states. */
    receive: { contract: string; from: string | null; correlation: JsonValue } | null;
    enteredAt: Date;
    completedAt: Date | null;
}

/**
 * One typed input a sender gave a run (migrations 0093, 0094), as it is now.
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

/** What a parallel state's join or its own time limit decided (IR 9), for the state's events: its result, its branches, the successes that counted, and the work cancelled with it. */
export interface ParallelSettled {
    result: NodeResultInput;
    total: number;
    succeeded: number;
    cancelled: string[];
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
        publishedAt: dateOrNull(row, "published_at"), publishedAgentPins: jsonOrNull(row, "published_agent_pins"),
        chatDefinitionId: strOrNull(row, "chat_definition_id"), chatRevision: intOrNull(row, "chat_revision"),
    };
}

/** The refusal of a stage 1 definition operation on a Workflow that is a copy of a chat revision (requireNotChatPinned). */
export const PINNED_TO_CHAT_REVISION = "PINNED_TO_CHAT_REVISION";

/**
 * Code check G1 (stage 2.1, R1/R4/R6): a Workflow that is a copy of a chat revision (a stage 1 child migration 0107
 * pinned, or one a Start made) takes none of the stage 1 definition operations (replace_definition, publish,
 * publish_and_start, start). Its copy never changes, and it is started only by a chat Start, which checks the chat, the
 * definition and the revision under their locks (requireChatStartLocked). Checked in the store, under the definition's
 * lock, so no caller can skip it; a stored receipt of the same operation is answered before it.
 */
function requireNotChatPinned(definition: WorkflowDefinitionRow, operation: string): void {
    if (definition.chatDefinitionId === null) return;
    const revision = definition.chatRevision !== null ? `revision ${definition.chatRevision}` : "a revision";
    throw new WorkflowStoreError(PINNED_TO_CHAT_REVISION,
        `This Workflow is a copy of ${revision} of its chat's Workflow Definition: ${operation} does not change, publish or start it. `
        + "To change it, save a new revision with workflow_definition save (or YAML and Save in the Workflow tab), then Start that revision. "
        + "Nothing was changed.",
        { definitionId: definition.chatDefinitionId, revision: definition.chatRevision, operation });
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

const RUN_STATUSES: readonly WorkflowRunStatus[] = ["admitted", "running", "paused", "completed", "failed", "cancelled", "stopped"];
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
        terminalOutput: jsonOrNull(row, "terminal_output"), terminalError: redactWorkflowErrorValue(jsonOrNull(row, "terminal_error")),
        createdAt: date(row, "created_at"), updatedAt: date(row, "updated_at"), finishedAt: dateOrNull(row, "finished_at"),
        kv: parseStoredJson(str(row, "kv"), "kv"), kvRevision: int(row, "kv_revision"), pausedFrom: pausedFromOf(row),
        controllerVersion: strOrNull(row, "controller_version"), stop: stopOf(row), virtualNow: dateOrNull(row, "virtual_now"),
        testScenario: strOrNull(row, "test_scenario"), deadlineAt: dateOrNull(row, "deadline_at"),
        testAgentPins: jsonOrNull(row, "test_agent_pins"),
        // A schema before migration 0110 has no column: no choices. The text as stored: parsed where it is used.
        agentModels: Object.hasOwn(row, "agent_models") ? strOrNull(row, "agent_models") : null,
    };
}

/** A run's stop columns (migration 0100): all null, or an accepted stop with its stored request. */
function stopOf(row: Row): WorkflowRunStop | null {
    const requestedAt = dateOrNull(row, "stop_requested_at");
    const deadlineAt = dateOrNull(row, "stop_deadline_at");
    const request = jsonOrNull(row, "stop_request");
    if (requestedAt === null && deadlineAt === null && request === null) return null;
    const corrupt = () => new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "Stored run stop has an invalid shape.");
    if (requestedAt === null || deadlineAt === null || !isJsonObject(request)) throw corrupt();
    const { operationId, reason, actor, graceSeconds } = request;
    if (typeof operationId !== "string" || (reason !== null && typeof reason !== "string") || !isJsonObject(actor)
        || typeof graceSeconds !== "number" || !Number.isSafeInteger(graceSeconds) || graceSeconds < 0) throw corrupt();
    // R3-SF-2: read with its secrets hidden, a reason stored before they were hidden ahead of its cut included.
    return { requestedAt, deadlineAt, operationId, reason: reason === null ? null : redactWorkflowSecrets(reason), actor, graceSeconds };
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
        // SF-6: a stored error is read with its secrets hidden, so no reader (the read model, a notification) shows them.
        // R3-SF-3, S6-SF2: only a parallel state's own decided error (its controller-written report) keeps its branches'
        // business outputs; any other error of that shape, a mocked one included, is hidden like every error.
        outcome: strOrNull(row, "outcome"), resultKind, output: jsonOrNull(row, "output"),
        error: redactWorkflowErrorValue(jsonOrNull(row, "error"), { parallelReport: str(row, "node_type") === "parallel" && strOrNull(row, "winner") === "controller" }),
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

// ─── Agent states (IR 8, migration 0101) ──

/**
 * An agent state's task: its inline prompt, or the named agent definition it
 * runs. A run of a published revision that pinned the exact package revision
 * (R18) also carries that revision's package id and content hash, and its
 * child runs that revision even after the package is republished.
 */
export type WorkflowAgentTask =
    | { source: "prompt"; prompt: string }
    | { source: "agent"; name: string; package: string | null; version: string | null; packageId?: string; revision?: string };

/**
 * What an agent state admitted pending records (enterNode): its child agent
 * session's stable id, the workflow's controlling parent agent, its task,
 * its business outcomes and output schema (the ones its pinned definition
 * declares for the state) and its outer deadline's seconds.
 */
export interface AgentSpecInput {
    childSessionId: string;
    controllingSessionId: string | null;
    task: WorkflowAgentTask;
    outcomes: string[];
    outputSchema: string | null;
    timeoutSeconds: number;
}

/** An agent state's invocation record (workflow_agent_invocations). */
export interface WorkflowAgentInvocation {
    nodeExecutionId: string;
    runId: string;
    workflowSessionId: string;
    childSessionId: string;
    controllingSessionId: string | null;
    task: WorkflowAgentTask;
    outcomes: string[];
    outputSchema: string | null;
    deadlineAt: Date;
    createdAt: Date;
    spawnAttempts: number;
    spawnedAt: Date | null;
    endRequested: "done" | "cancel" | null;
    endRequestedAt: Date | null;
    /** When the end command was handed to the child's queue, or found unneeded; null while it is owed. */
    endSentAt: Date | null;
    /** The child session orchestration's status when the end was sent or found unneeded. */
    endChildStatus: string | null;
}

/** The receipt of the complete_workflow_node operation that decided an agent state. */
export interface WorkflowAgentCompletionReceipt {
    nodeExecutionId: string;
    workflowSessionId: string;
    runId: string;
    stateId: string;
    childSessionId: string;
    operationId: string;
    kind: "result" | "error";
    /** The business outcome, or the reported runtime error code. */
    outcome: string;
    resultSha256: string;
    /** The store's reading that decided it, ISO 8601 with microseconds. */
    decidedAt: string;
}

/** Refusals of a complete_workflow_node operation (the state's record is unchanged unless noted). */
export type WorkflowAgentCompletionRefusal =
    /** Field errors; the state stays pending (attemptsLeft more invalid completions are taken). */
    | "OUTPUT_INVALID"
    /** The invalid completion that spent the correction budget: the state failed invalid_output. */
    | "OUTPUT_ATTEMPTS_EXHAUSTED"
    /** At or after the deadline: only the controller decides the state now (timed_out). */
    | "NODE_EXPIRED"
    /** The state was decided by something else (its deadline, a cancel, a stop, a deletion). */
    | "NODE_CLOSED"
    /** The state was completed with another result. */
    | "COMPLETION_CONFLICT"
    /** The operation id was used for another result. */
    | "OPERATION_CONFLICT";

export type WorkflowAgentCompletionResult =
    | { kind: "accepted"; replayed: boolean; receipt: WorkflowAgentCompletionReceipt; controllerInstanceId: string }
    | { kind: "refused"; replayed: boolean; code: WorkflowAgentCompletionRefusal; problems: JsonValue; attemptsLeft: number | null;
        state: { status: "pending" | "completed"; outcome: string | null; winner: string | null }; controllerInstanceId: string };

/**
 * A session's workflow lineage (readWorkflowLineage), read from the session
 * rows themselves (deleted ones included) and the agent states' immutable
 * invocation records: host-derived, never from a caller's claim.
 */
export interface WorkflowLineage {
    sessionId: string;
    /** Its distance from the root (0 for a root); null when its lineage is cyclic, has a missing parent, or is deeper than any allowed. */
    level: number | null;
    /**
     * The nearest of the session and its ancestors that is an agent state's
     * child (distance 0: the session itself), with that state's workflow and
     * controlling parent agent; null for a session outside every agent
     * state's subtree.
     */
    agentRoot: { childSessionId: string; nodeExecutionId: string; workflowSessionId: string; controllingSessionId: string | null; distance: number } | null;
}

/** The longest lineage readWorkflowLineage follows. */
export const WORKFLOW_V2_LINEAGE_MAX_DEPTH = 32;

/** Invalid completions an agent state takes before the one that fails it invalid_output (its correction budget). */
export const WORKFLOW_V2_AGENT_MAX_INVALID_COMPLETIONS = 3;
/** The longest message of an agent's reported runtime error. */
export const WORKFLOW_V2_AGENT_ERROR_MESSAGE_MAX = 2_000;
/** Reminders an agent state's child gets at most (owner decision Q2: one per stall); its deadline still applies. */
export const WORKFLOW_V2_AGENT_MAX_REMINDERS = 3;
/** The workflow session's record of a step's reminder (recordAgentReminder). */
export const WORKFLOW_AGENT_REMINDED_EVENT = "workflow.agent_reminded";

/** The answer of recordAgentReminder: remind the child now (the n-th reminder of its step), or why not. */
export type WorkflowAgentReminderRecord =
    | { recorded: true; n: number; max: number; stateId: string; nodeExecutionId: string; repeat: boolean; cycle?: string }
    | { recorded: false; reason: "not_a_step" | "decided" | "expired" | "sub_agents" | "spent" | "no_visit" };

/**
 * The visit a turn of a chat that continues works for (review RT-1..RT-3, the turn-to-visit fence; readTurnVisit):
 * `nodeExecutionId` (null: the chat has no recorded visit prompt), whether that visit is still open (pending), and
 * whether it was inherited from an earlier turn's prompt (a turn a timer or a sub-agent's update started).
 */
export interface WorkflowTurnVisit {
    nodeExecutionId: string | null;
    open: boolean;
    inherited: boolean;
}

/** The node execution a workflow agent visit's prompt id names (`workflow:<wf>:<run>:agent:<nx>`), or null. Pure. */
export function workflowVisitOfPromptId(clientMessageId: unknown): string | null {
    if (typeof clientMessageId !== "string" || !clientMessageId.startsWith("workflow:")) return null;
    const at = clientMessageId.lastIndexOf(":agent:");
    const id = at > 0 ? clientMessageId.slice(at + ":agent:".length) : "";
    return /^nx-[0-9a-f]{1,64}$/.test(id) ? id : null;
}

/** The visit a continued chat's turn Stop names (`workflow-cycle-stop:<nx>`, with `:sent` after a late send), or null. Pure. */
export function workflowVisitOfStopRequestId(requestId: unknown): string | null {
    if (typeof requestId !== "string") return null;
    const found = /^workflow-cycle-stop:(nx-[0-9a-f]{1,64})(?::sent)?$/.exec(requestId);
    return found ? found[1] : null;
}

/**
 * The too_late outcome of a Stop that is not a turn's (the turn-to-visit fence; formal deviation D3): the one insert both
 * live admission (recordStopNotForTurn) and turn end with a visit fence (the CMS catalog's turnEnd; review RT-D2) use.
 * Once only: a Stop that already has an outcome keeps it (NOT EXISTS). The caller holds the session row's lock.
 * `sessionEvents` is the CMS session_events table, qualified. Returns whether this call recorded it.
 */
export async function insertStopNotForTurn(client: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> },
    sessionEvents: string, sessionId: string, seq: number, turn: number): Promise<boolean> {
    const { rows } = await client.query(
        `INSERT INTO ${sessionEvents} (session_id, event_type, data)
         SELECT $1, 'session.control_outcome', jsonb_build_object('seq', $2::bigint, 'turn', $3::int, 'outcome', 'too_late')
          WHERE EXISTS (SELECT 1 FROM ${sessionEvents} s WHERE s.session_id = $1 AND s.seq = $2 AND s.event_type = 'user.stop')
            AND NOT EXISTS (SELECT 1 FROM ${sessionEvents} o
                             WHERE o.session_id = $1 AND o.event_type = 'session.control_outcome' AND (o.data->>'seq')::bigint = $2)
         RETURNING seq`, [sessionId, seq, turn]);
    return rows.length > 0;
}
/** The largest details value of an agent's reported runtime error, in UTF-8 bytes of canonical JSON. */
export const WORKFLOW_V2_AGENT_ERROR_DETAILS_MAX_BYTES = 16 * 1024;

function agentTaskOf(value: JsonValue): WorkflowAgentTask {
    const corrupt = () => new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "Stored agent task has an invalid shape.");
    if (!isJsonObject(value)) throw corrupt();
    if (value.source === "prompt" && typeof value.prompt === "string" && Object.keys(value).length === 2) return { source: "prompt", prompt: value.prompt };
    if (value.source === "agent" && typeof value.name === "string" && (value.package === null || typeof value.package === "string")
        && (value.version === null || typeof value.version === "string") && Object.keys(value).length === 4) {
        return { source: "agent", name: value.name, package: value.package, version: value.version };
    }
    // A pinned package revision (R18): its package id and content hash, both or neither.
    if (value.source === "agent" && typeof value.name === "string" && (value.package === null || typeof value.package === "string")
        && (value.version === null || typeof value.version === "string") && typeof value.packageId === "string" && value.packageId.length > 0
        && typeof value.revision === "string" && value.revision.length > 0 && Object.keys(value).length === 6) {
        return { source: "agent", name: value.name, package: value.package, version: value.version, packageId: value.packageId, revision: value.revision };
    }
    throw corrupt();
}

function agentInvocationFrom(row: Row): WorkflowAgentInvocation {
    const outcomes = parseStoredJson(str(row, "outcomes"), "outcomes");
    const end = strOrNull(row, "end_requested");
    if (!Array.isArray(outcomes) || !outcomes.every(item => typeof item === "string") || (end !== null && end !== "done" && end !== "cancel")) {
        throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "Stored agent invocation has an invalid shape.");
    }
    return {
        nodeExecutionId: str(row, "node_execution_id"), runId: str(row, "run_id"), workflowSessionId: str(row, "workflow_session_id"),
        childSessionId: str(row, "child_session_id"), controllingSessionId: strOrNull(row, "controlling_session_id"),
        task: agentTaskOf(parseStoredJson(str(row, "task"), "task")), outcomes: outcomes as string[], outputSchema: strOrNull(row, "output_schema"),
        deadlineAt: date(row, "deadline_at"), createdAt: date(row, "created_at"), spawnAttempts: int(row, "spawn_attempts"),
        spawnedAt: dateOrNull(row, "spawned_at"), endRequested: end, endRequestedAt: dateOrNull(row, "end_requested_at"),
        endSentAt: dateOrNull(row, "end_sent_at"), endChildStatus: strOrNull(row, "end_child_status"),
    };
}

function agentReceiptOf(value: JsonValue): WorkflowAgentCompletionReceipt {
    const corrupt = () => new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "Stored agent completion receipt has an invalid shape.");
    if (!isJsonObject(value)) throw corrupt();
    const { nodeExecutionId, workflowSessionId, runId, stateId, childSessionId, operationId, kind, outcome, resultSha256, decidedAt } = value;
    if ([nodeExecutionId, workflowSessionId, runId, stateId, childSessionId, operationId, outcome, resultSha256, decidedAt].some(item => typeof item !== "string")
        || (kind !== "result" && kind !== "error")) throw corrupt();
    return { nodeExecutionId, workflowSessionId, runId, stateId, childSessionId, operationId, kind, outcome, resultSha256, decidedAt } as WorkflowAgentCompletionReceipt;
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
/** Leases of one response wake (each lease is one attempt) before a dispatch pass abandons it (design workflow-messaging-request.md 5). */
export const WORKFLOW_V2_WAKE_MAX_ATTEMPTS = 100;
/** How long one lease of a response wake lasts; a holder that has not settled it by then may lose it to another pass. */
export const WORKFLOW_V2_WAKE_LEASE_MS = 30_000;
/** The framework's strict decline schema: a reason of 1 to 2,000 characters and nothing else. */
export const WORKFLOW_V2_DECLINE_SCHEMA: JsonValue = {
    type: "object", additionalProperties: false, required: ["reason"],
    properties: { reason: { type: "string", minLength: 1, maxLength: 2_000 } },
};
const REQUEST_FAILURE_CODES: readonly string[] = ["unavailable", "forbidden", "delivery_failed", "unsupported_contract", "invalid_input"];

/**
 * Where a test run's virtual clock starts (migration 0102; design 05): after any real time, so no decision by the store's
 * clock ever finds a test run's deadline due. Only advanceTestClock moves it.
 */
export const WORKFLOW_V2_TEST_EPOCH = "9000-01-01T00:00:00.000Z";
/** The most seconds one advance of a test run's virtual clock moves it. */
export const WORKFLOW_V2_TEST_ADVANCE_MAX_SECONDS = 30 * 86_400;
/** The most intercepted effects one test run records; a script that reaches more fails its call. */
export const WORKFLOW_V2_TEST_MAX_INTERCEPTIONS = 1_000;
/** The operations a test run intercepts (design 05): a script's tool call, an agent state's agent, a send's delivery, a request. */
export const WORKFLOW_V2_TEST_OPERATIONS = ["tool.call", "agent", "send", "request"] as const;
export type WorkflowTestOperation = typeof WORKFLOW_V2_TEST_OPERATIONS[number];
export type WorkflowTestResponseKind = "success" | "error" | "cancel";

/** The stable id of an intercepted effect: `<node execution>/<operation>`, or `<node execution>/call-<n>` for a script's n-th tool call. */
export function workflowTestInterceptionId(nodeExecutionId: string, operation: Exclude<WorkflowTestOperation, "tool.call"> | { call: number }): string {
    return typeof operation === "string" ? `${nodeExecutionId}/${operation}` : `${nodeExecutionId}/call-${operation.call}`;
}

/**
 * An intercepted effect of a test run (migration 0102): what was reached (its operation, tool and arguments, and the schema
 * a response must match) and, once answered, the response (by the parent or a fixture). An answered record never changes.
 */
export interface WorkflowTestInterception {
    interceptionId: string;
    seq: number;
    runId: string;
    nodeExecutionId: string;
    operation: WorkflowTestOperation;
    tool: string | null;
    arguments: JsonValue;
    argumentsSha256: string;
    responseSchema: string | null;
    state: "awaiting_parent" | "responded";
    response: {
        kind: WorkflowTestResponseKind;
        value: JsonValue;
        sha256: string;
        disposition: "parent" | "fixture";
        operationId: string | null;
        respondedBy: JsonValue;
        respondedAt: Date;
    } | null;
    /** The test run's virtual clock when the effect was reached. */
    virtualAt: Date;
    createdAt: Date;
}

function interceptionFrom(row: Row): WorkflowTestInterception {
    const operation = str(row, "operation");
    const state = str(row, "state");
    const corrupt = () => new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Test interception ${String(row.interception_id)} has an invalid shape.`);
    if (!(WORKFLOW_V2_TEST_OPERATIONS as readonly string[]).includes(operation) || (state !== "awaiting_parent" && state !== "responded")) throw corrupt();
    const seq = Number(row.seq);
    if (!Number.isSafeInteger(seq)) throw corrupt();
    let response: WorkflowTestInterception["response"] = null;
    if (state === "responded") {
        const kind = str(row, "response_kind");
        const disposition = str(row, "disposition");
        if ((kind !== "success" && kind !== "error" && kind !== "cancel") || (disposition !== "parent" && disposition !== "fixture")) throw corrupt();
        response = {
            kind, value: parseStoredJson(str(row, "response"), "response"), sha256: str(row, "response_sha256"), disposition,
            operationId: strOrNull(row, "response_operation_id"), respondedBy: jsonOrNull(row, "responded_by"), respondedAt: date(row, "responded_at"),
        };
    }
    return {
        interceptionId: str(row, "interception_id"), seq, runId: str(row, "run_id"), nodeExecutionId: str(row, "node_execution_id"),
        operation: operation as WorkflowTestOperation, tool: strOrNull(row, "tool"), arguments: parseStoredJson(str(row, "arguments"), "arguments"),
        argumentsSha256: str(row, "arguments_sha256"), responseSchema: strOrNull(row, "response_schema"), state, response,
        virtualAt: date(row, "virtual_at"), createdAt: date(row, "created_at"),
    };
}

/** The receipt of a test run's clock advance (advanceTestClock): the virtual times before and after, and what became due. */
export interface WorkflowTestAdvanceReceipt {
    workflowSessionId: string;
    runId: string;
    operation: "test_advance";
    seconds: number;
    from: string;
    virtualNow: string;
    decided: Array<{ nodeExecutionId: string; stateId: string; outcome: string }>;
}

function parseTestAdvanceReceipt(value: JsonValue): WorkflowTestAdvanceReceipt {
    if (!isJsonObject(value) || value.operation !== "test_advance" || typeof value.workflowSessionId !== "string" || typeof value.runId !== "string"
        || typeof value.seconds !== "number" || typeof value.from !== "string" || typeof value.virtualNow !== "string" || !Array.isArray(value.decided)) {
        throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "Stored test clock receipt has an invalid shape.");
    }
    return value as unknown as WorkflowTestAdvanceReceipt;
}

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
    /**
     * Durable recipient intake (design workflow-durable-intake.md section 4):
     * "durable" when the exchange was delivered in durable intake mode, every
     * copy carrying the intake envelope. Written only then, and frozen with
     * the receipt; a receipt without it reads as "legacy_window".
     */
    intake?: "durable" | "legacy_window";
}

/**
 * A send state's message in the outbox (migrations 0095, 0096), or a request
 * state's (migration 0097, mode request), as it is now. Times are the stored
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
    /** What the admission decided the recipient is (rows before migration 0096: agent). */
    recipientKind: RecipientKind;
    contract: string;
    payload: JsonValue;
    payloadSha256: string;
    /** The correlation object the state resolved ({} for rows before migration 0096). */
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
        error: redactWorkflowErrorValue(jsonOrNull(row, "error")),
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
    // Durable intake: only on an agent recipient's receipt; absent reads as legacy_window (and is kept absent).
    const rawIntake = value.intake;
    let intake: "durable" | "legacy_window" | undefined;
    if (rawIntake !== undefined) {
        if (rawIntake !== "durable" && rawIntake !== "legacy_window") throw invalid();
        if (kind !== "agent") throw invalid();
        intake = rawIntake;
    }
    return {
        exchangeId: text("exchangeId"), workflowSessionId: text("workflowSessionId"), runId: text("runId"), nodeExecutionId: text("nodeExecutionId"),
        stateId: text("stateId"), recipientSessionId: text("recipientSessionId"), recipientKind: kind, contract: text("contract"),
        payloadSha256: text("payloadSha256"), clientMessageId, input, attempts, deliveredAt: text("deliveredAt"),
        ...(intake !== undefined ? { intake } : {}),
    };
}

// ─── Durable recipient intake (migration 0098; design workflow-durable-intake.md 3, 4, 5.1, 5.2, 5.6, 5.7) ──

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

/** One exchange's intake row (migration 0098), as stored. Times are exact (ISO 8601 UTC with microseconds). */
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
    /** Rows before migration 0096 have none: an agent session. */
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

/**
 * The claims a bind or an end names: distinct exchanges, each with its claim
 * (and, for an end, its cancel flag); 1 to INTAKE_MAX_HELD of them, or none
 * for an end (`allowEmpty`) whose invocation's members were all cancelled
 * before it was sent. A bind always names at least one.
 */
function intakeBatch(raw: unknown, path: string, withCancelFlag: boolean, allowEmpty = false)
    : Array<{ exchangeId: string; claimId: string; cancelRequested: boolean }> {
    const least = allowEmpty ? 0 : 1;
    if (!Array.isArray(raw) || raw.length < least || raw.length > INTAKE_MAX_HELD) {
        throw new IntakeShapeError(path, `is not a list of ${least} to ${INTAKE_MAX_HELD} items`);
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

/** An invocation's record (migration 0098), written once by its first bind: its recipient and complete membership. */
interface IntakeInvocationRecord {
    recipientSessionId: string;
    /** Each member exchange with its claim, in the first bind's order. */
    members: Array<{ exchangeId: string; claimId: string }>;
    /** The canonical JSON of `members`, as stored: a later bind of the invocation must name exactly this. */
    membersText: string;
}

/** The canonical JSON of an invocation's members, in bind order. */
function intakeMembersText(items: ReadonlyArray<{ exchangeId: string; claimId: string }>): string {
    return canonicalJson(items.map(item => ({ exchangeId: item.exchangeId, claimId: item.claimId })));
}

function intakeInvocationFrom(invocationId: string, row: Row): IntakeInvocationRecord {
    const membersText = str(row, "members");
    const invalid = (): never => corrupt(`Intake invocation ${invocationId} has an invalid membership.`);
    const parsed = parseStoredJson(membersText, "members");
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length !== int(row, "member_count")) return invalid();
    const members = parsed.map(member => {
        if (!isJsonObject(member) || Object.keys(member).length !== 2) return invalid();
        const { exchangeId, claimId } = member;
        if (typeof exchangeId !== "string" || typeof claimId !== "string") return invalid();
        return { exchangeId, claimId };
    });
    if (intakeMembersText(members) !== membersText || new Set(members.map(member => member.exchangeId)).size !== members.length) return invalid();
    return { recipientSessionId: str(row, "recipient_session_id"), members, membersText };
}

/** The claim an invocation holds an exchange under, or a broken invariant when the exchange is not one of its members. */
function intakeMemberClaim(invocation: IntakeInvocationRecord, invocationId: string, exchangeId: string): string {
    const member = invocation.members.find(item => item.exchangeId === exchangeId);
    return member ? member.claimId : intakeBroken(exchangeId, `it is not a member of invocation ${invocationId}`);
}

/**
 * An admission's answer (migration 0099; exposure protocol revision 2,
 * section 3): allowed, or refused. `exposed`: the items were possibly seen
 * under another attempt, and this one may not include them. `settled`: the
 * invocation ended, or a named item was cancelled before any exposure; the
 * payload is stale, which is never evidence of exposure.
 */
export type WorkflowIntakeAdmission = { allowed: true } | { allowed: false; reason: "exposed" | "settled" };

/** An invocation's exposure record (migration 0099), as stored: the first admission that let an attempt include its items. */
export interface WorkflowIntakeExposure {
    invocationId: string;
    recipientSessionId: string;
    /** The admitted attempt's id, as the orchestration recorded it in the attempt's scheduled input. */
    attemptId: string;
    exposedAt: string;
}

/** The items an admission names: 1 to INTAKE_MAX_HELD distinct exchanges, each with its claim and the hash of the exact text to be sent. */
function intakeAdmissionBatch(raw: unknown, path: string): Array<{ exchangeId: string; claimId: string; textSha256: string }> {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > INTAKE_MAX_HELD) {
        throw new IntakeShapeError(path, `is not a list of 1 to ${INTAKE_MAX_HELD} items`);
    }
    const seen = new Set<string>();
    return raw.map((item: unknown, index: number) => {
        const value = intakeObject(item, `${path}[${index}]`, ["exchangeId", "claimId", "textSha256"]);
        const exchangeId = intakeExchangeId(value.exchangeId, `${path}[${index}].exchangeId`);
        if (seen.has(exchangeId)) throw new IntakeShapeError(`${path}[${index}].exchangeId`, "names an exchange twice");
        seen.add(exchangeId);
        return {
            exchangeId, claimId: intakeId(value.claimId, `${path}[${index}].claimId`),
            textSha256: intakeSha256(value.textSha256, `${path}[${index}].textSha256`),
        };
    });
}

/** A request's immutable record (migration 0097), with exact times. */
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
export function revisionIrFrom(row: Row | undefined, revision: number, expectedIrSha256: string | undefined, options: { maxIrVersion?: number }): WorkflowIR {
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

/**
 * A definition's YAML is stored only up to WORKFLOW_V2_MAX_YAML_BYTES (adversarial review R2-SF-5): a larger one is refused
 * before any write, so a draft is never saved with it (the service refuses it before it is read).
 */
function requireStoredYamlWithinLimit(yaml: string): void {
    if (typeof yaml === "string" && Buffer.byteLength(yaml, "utf8") > WORKFLOW_V2_MAX_YAML_BYTES) {
        throw new WorkflowStoreError("WORKFLOW_YAML_TOO_LARGE", `Workflow YAML must be at most ${WORKFLOW_V2_MAX_YAML_BYTES.toLocaleString("en-US")} bytes `
            + "(256 KiB). Nothing was saved.");
    }
}

/** Diagnostics as plain JSON (for error details). */
export function diagnosticsJson(diagnostics: WorkflowDiagnostic[]): JsonValue {
    return diagnostics.map(item => ({
        severity: item.severity, code: item.code, path: item.path, message: item.message,
        ...(item.line !== undefined ? { line: item.line } : {}),
    }));
}

/** A definition with compile errors is saved only as a draft: publishing or starting it is DEFINITION_INVALID. */
export function requirePublishable(compiled: Pick<WorkflowCompileResult, "valid" | "diagnostics">, publish: boolean): void {
    if (publish && !compiled.valid) {
        throw new WorkflowStoreError("DEFINITION_INVALID", "An invalid definition can be saved as a draft but not published or started.",
            { diagnostics: diagnosticsJson(compiled.diagnostics) });
    }
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

/**
 * A result's text as it is stored (SF-6 verification): a runtime error's has its secrets hidden before it is written,
 * so the node's and the outbox message's error columns never hold them; a business result's is stored as it is.
 * `options.parallelReport` only from the controller's parallel decision (settleParallelIn; R3-SF-3, S6-SF2).
 */
function storedResultText(result: Pick<NodeResultInput, "resultKind" | "valueText">, options: WorkflowErrorRedaction = {}): string {
    return result.resultKind === "runtime_error" ? redactWorkflowErrorText(result.valueText, canonicalJson, options) : result.valueText;
}

/**
 * The most revisions one workflow keeps, and the most YAML its revisions hold together (re-check S-SF-F5 of adversarial
 * review R2-SF-5): a draft past either is refused (WORKFLOW_REVISION_LIMIT), and the workflow keeps its revisions.
 */
export const WORKFLOW_V2_REVISION_LIMITS = Object.freeze({ maxRevisions: 1_000, maxYamlBytes: 64 * 1024 * 1024 });

export class WorkflowStore {
    /** The revision limits this store applies (WORKFLOW_V2_REVISION_LIMITS); a test may lower them. */
    revisionLimits: { maxRevisions: number; maxYamlBytes: number } = WORKFLOW_V2_REVISION_LIMITS;
    private chatStore: ChatDefinitionStore | null = null;

    /** Stage 2.1: the chat-owned Workflow Definitions (migration 0107), on this store's pool and schema. */
    get chat(): ChatDefinitionStore {
        if (!this.chatStore) this.chatStore = new ChatDefinitionStore(this.pool, this.schema);
        return this.chatStore;
    }
    private readonly t: {
        definitions: string; revisions: string; operations: string; runs: string; nodes: string; kvRevisions: string; inbox: string; outbox: string;
        requests: string; requestResponses: string; requestOperations: string; responseWakes: string; intake: string; intakeInvocations: string;
        intakeExposures: string; agentInvocations: string; agentCompletions: string; testInterceptions: string;
        sessions: string; sessionOwners: string; users: string; sessionEvents: string; recordEvents: string; updateSession: string; softDeleteSession: string;
    };

    /**
     * `noticeLockPool`: where the run notice lock takes its connection (E3-R2): a small pool of its own, so the store
     * calls made while it is held never wait for the connection the lock holds. Unset, the store's pool.
     */
    constructor(private readonly pool: Pool, readonly schema: string,
        private readonly options: { noticeLockPool?: () => Promise<Pool> } = {}) {
        const s = `"${schema}"`;
        this.t = {
            definitions: `${s}.workflow_definitions`, revisions: `${s}.workflow_revisions`,
            operations: `${s}.workflow_operations`, runs: `${s}.workflow_runs`, nodes: `${s}.workflow_node_executions`,
            kvRevisions: `${s}.workflow_kv_revisions`, inbox: `${s}.workflow_inbox`, outbox: `${s}.workflow_outbox`,
            requests: `${s}.workflow_requests`, requestResponses: `${s}.workflow_request_responses`,
            requestOperations: `${s}.workflow_request_operations`, responseWakes: `${s}.workflow_response_wakes`, intake: `${s}.workflow_intake`,
            intakeInvocations: `${s}.workflow_intake_invocations`, intakeExposures: `${s}.workflow_intake_exposures`,
            agentInvocations: `${s}.workflow_agent_invocations`, agentCompletions: `${s}.workflow_agent_completions`,
            testInterceptions: `${s}.workflow_test_interceptions`,
            sessions: `${s}.sessions`, sessionOwners: `${s}.session_owners`, users: `${s}.users`, sessionEvents: `${s}.session_events`,
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
     * locked before any definition, run or node row, the workflow's own
     * parent chat first, any other pair in ascending session id order
     * (sessionPairLockOrder): the workflow's FOR NO KEY UPDATE (as lockLiveSession), the
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
     * SHARE (its own parent chat first, else ascending session id order:
     * sessionPairLockOrder) before any definition, run or node row; then both sessions with their owners in one statement, and
     * the workflow's definition parent. A row the locks did not find is null.
     */
    private async lockSessionPair(client: PoolClient, workflowSessionId: string, otherSessionId: string)
        : Promise<{ workflow: AuthoritySession | null; other: AuthoritySession | null; definition: { parentSessionId: string | null } | null }> {
        const locked = new Set<string>();
        // S2RT-F2: a Workflow and its own parent chat are locked chat first, as the chat-ended trigger (0109) and a Start lock
        // them; any other pair in ascending id order. The parent is read unlocked: a session's parent never changes.
        const parentRow = await client.query(`SELECT parent_session_id FROM ${this.t.sessions} WHERE session_id = $1`, [workflowSessionId]);
        const parentId = parentRow.rows[0]?.parent_session_id ?? null;
        for (const sessionId of sessionPairLockOrder(workflowSessionId, otherSessionId, parentId === null ? null : String(parentId))) {
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
        delivery: { stateId: string; clientMessageId: string | null; input: WorkflowSendInputAcceptance | null; intake?: "durable" },
        projection?: (receipt: WorkflowSendReceipt) => SessionProjection)
        : Promise<{ won: boolean; node: WorkflowNodeExecutionRow; message: WorkflowOutboxMessage }> {
        const nodeExecutionId = message.nodeExecutionId;
        const { rows: clock } = await client.query(`WITH c AS (SELECT clock_timestamp() AS at) SELECT at::text AS at, ${isoUtc("at")} AS iso FROM c`);
        const receipt: WorkflowSendReceipt = {
            exchangeId: message.exchangeId, workflowSessionId, runId: message.runId, nodeExecutionId, stateId: delivery.stateId,
            recipientSessionId: message.recipientSessionId, recipientKind: message.recipientKind, contract: message.contract,
            payloadSha256: message.payloadSha256, clientMessageId: delivery.clientMessageId, input: delivery.input,
            attempts: Math.max(message.attempts, 1), deliveredAt: str(clock[0], "iso"),
            ...(delivery.intake === "durable" ? { intake: "durable" as const } : {}),
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
    private async decidePendingSendsIn(client: PoolClient, workflowSessionId: string, runId: string, onlyNodes: string[] | null = null): Promise<void> {
        // `onlyNodes`: only the messages of these node executions (a parallel state's cancelled branches); null: every one of the run.
        const { rows } = await client.query(
            `SELECT ${OUTBOX_COLUMNS} FROM ${this.t.outbox}
              WHERE run_id = $1 AND mode = 'send' AND state = 'pending' AND recipient_kind = 'workflow'
                AND ($2::text[] IS NULL OR node_execution_id = ANY($2::text[]))
              ORDER BY exchange_id FOR UPDATE`, [runId, onlyNodes]);
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

    /**
     * Run `work` in one transaction at READ COMMITTED, stated in its BEGIN
     * rather than inherited from the session, role or database default.
     * Every transaction here takes its locks and then reads, and relies on
     * each statement after a lock wait seeing what the lock's previous holder
     * committed: READ COMMITTED takes a snapshot per statement, while an
     * inherited REPEATABLE READ would keep the snapshot of the first
     * statement, taken before the wait (a request's durable expiry and an
     * invocation's serialization depend on this). A server that refuses the
     * level fails the transaction; nothing falls back to another level.
     */
    private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        let released = false;
        try {
            await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
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

    /**
     * Apply a session projection: record its events, then update the session row. `owner` is the run the projection
     * reports, when it reports one (review B1): once the workflow has a live run, the row's state and lastError are that
     * run's, so a test run's projection (a draft's test, admitted before publication, that begins, pauses or ends after
     * the live run was admitted) records its events and leaves both alone. The caller holds the workflow's session lock
     * (lockLiveSession), as every live admission does, so the live run read here is the one the row follows.
     */
    private async project(client: PoolClient, projection: SessionProjection | undefined, owner?: Pick<WorkflowRunRow, "mode" | "workflowSessionId">)
        : Promise<void> {
        if (!projection) return;
        // SF-6: the secrets in an event's error fields are hidden before it is stored.
        const events = (projection.events ?? []).map(event => ({ eventType: event.eventType, data: jsonbSafeValue(redactWorkflowEventData(event.data)) }));
        await this.withCompletedAt(client, events);
        if (events.length > 0) {
            await client.query(`SELECT ${this.t.recordEvents}($1, $2, $3)`, [projection.sessionId, JSON.stringify(events), null]);
        }
        let update = projection.update;
        if (update && owner?.mode === "test" && (update.state !== undefined || update.lastError !== undefined)) {
            const { rows: live } = await client.query(
                `SELECT 1 FROM ${this.t.runs} WHERE workflow_session_id = $1 AND mode = 'live' LIMIT 1`, [owner.workflowSessionId]);
            if (live.length > 0) update = { ...update, state: undefined, lastError: undefined };
        }
        if (update) {
            const updates: Record<string, string | boolean | null> = {};
            if (update.state !== undefined) updates.state = update.state;
            if (update.title !== undefined) updates.title = jsonbSafeText(update.title, 200);
            if (update.titleLocked !== undefined) updates.titleLocked = update.titleLocked;
            if (update.lastError !== undefined) updates.lastError = update.lastError === null ? null : jsonbSafeText(redactWorkflowSecrets(update.lastError), 4_000);
            if (update.orchestrationId !== undefined) updates.orchestrationId = update.orchestrationId;
            if (update.touch) updates.lastActiveAt = new Date().toISOString();
            if (Object.keys(updates).length > 0) {
                await client.query(`SELECT ${this.t.updateSession}($1, $2)`, [projection.sessionId, JSON.stringify(updates)]);
            }
        }
    }

    /**
     * Adversarial review R3-UI-1 (S6-UI2): each state's end event (workflow.state_completed, workflow.state_failed) carries
     * `completedAt`, its node's completed_at as stored in this transaction: the completion clock read after the session
     * lock, which orders ends as the read model's rows do. The event's own time is its transaction's start, which is not
     * that order, so a reader orders an end it knows only from its event by this field. Every writer of these events
     * projects them here (completion, elapse, the parallel decision, cancellation, delivery, a test answer or advance), so
     * none is missed; an event that gives its own, or whose node has no end recorded, is left as it is. In place.
     */
    private async withCompletedAt(client: PoolClient, events: Array<{ eventType: string; data: JsonValue }>): Promise<void> {
        const ended: Array<{ event: { eventType: string; data: JsonValue }; data: { [key: string]: JsonValue }; id: string }> = [];
        for (const event of events) {
            if (event.eventType !== "workflow.state_completed" && event.eventType !== "workflow.state_failed") continue;
            const data = event.data;
            if (!isJsonObject(data) || typeof data.nodeExecutionId !== "string" || data.completedAt !== undefined) continue;
            ended.push({ event, data, id: data.nodeExecutionId });
        }
        if (ended.length === 0) return;
        const { rows } = await client.query(
            `SELECT node_execution_id, completed_at FROM ${this.t.nodes} WHERE node_execution_id = ANY($1::text[]) AND completed_at IS NOT NULL`,
            [[...new Set(ended.map(item => item.id))]]);
        const at = new Map<string, string>();
        for (const row of rows as Row[]) at.set(str(row, "node_execution_id"), date(row, "completed_at").toISOString());
        for (const item of ended) {
            const completedAt = at.get(item.id);
            if (completedAt !== undefined) item.event.data = { ...item.data, completedAt };
        }
    }

    private async lockDefinition(client: PoolClient, workflowSessionId: string): Promise<WorkflowDefinitionRow> {
        const { rows } = await client.query(`SELECT * FROM ${this.t.definitions} WHERE workflow_session_id = $1 FOR UPDATE`, [workflowSessionId]);
        if (!rows[0]) throw new WorkflowStoreError("WORKFLOW_NOT_FOUND", `Workflow ${workflowSessionId} has no definition.`);
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
            await this.project(client, input.projection, run);
            return { recorded: true, run };
        });
    }

    /**
     * Re-check S-SF-F5: a workflow has room for one more revision of `yaml` only below its limits (revisionLimits): at most
     * maxRevisions revisions, and at most maxYamlBytes of YAML in all of them. Otherwise WORKFLOW_REVISION_LIMIT: nothing is
     * written, and the draft keeps its revisions. In the caller's transaction, under the definition's lock.
     */
    private async requireRevisionRoom(client: PoolClient, workflowSessionId: string, yaml: string): Promise<void> {
        const { maxRevisions, maxYamlBytes } = this.revisionLimits;
        const { rows } = await client.query(
            `SELECT count(*)::bigint AS revisions, COALESCE(SUM(octet_length(yaml)), 0)::bigint AS bytes
               FROM ${this.t.revisions} WHERE workflow_session_id = $1`, [workflowSessionId]);
        const revisions = int(rows[0], "revisions");
        const bytes = int(rows[0], "bytes");
        const adding = Buffer.byteLength(yaml, "utf8");
        if (revisions + 1 > maxRevisions || bytes + adding > maxYamlBytes) {
            throw new WorkflowStoreError("WORKFLOW_REVISION_LIMIT",
                `This workflow has ${revisions.toLocaleString("en-US")} revisions with ${bytes.toLocaleString("en-US")} bytes of YAML; a workflow keeps at most `
                + `${maxRevisions.toLocaleString("en-US")} revisions and ${maxYamlBytes.toLocaleString("en-US")} bytes of YAML. Nothing was saved: `
                + "the draft keeps its revisions. Start a new workflow to go on.",
                { revisions, yamlBytes: bytes, maxRevisions, maxYamlBytes });
        }
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
        // A run admitted without a controller version records none and names no column of migration 0100, so a schema
        // before it (an upgrade test's populated one) admits it as before. Only a test run names the columns of 0102: its
        // virtual clock, which starts at the test epoch, and its fixtures.
        const versioned = typeof start.controllerVersion === "string";
        const test = start.mode === "test";
        const extra: Array<[string, unknown]> = [
            ...(versioned ? [["controller_version", start.controllerVersion] as [string, unknown]] : []),
            ...(test ? [["virtual_now", WORKFLOW_V2_TEST_EPOCH] as [string, unknown], ["test_fixtures", start.fixturesText ?? "[]"] as [string, unknown]] : []),
            ...(test && typeof start.testScenario === "string" ? [["test_scenario", start.testScenario] as [string, unknown]] : []),
            ...(test && typeof start.testAgentPinsText === "string" ? [["test_agent_pins", start.testAgentPinsText] as [string, unknown]] : []),
            // OF-S2-7 (migration 0110): named only by a run started with agent node models.
            ...(typeof start.agentModelsText === "string" ? [["agent_models", start.agentModelsText] as [string, unknown]] : []),
        ];
        await client.query(
            `INSERT INTO ${this.t.runs}
                (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, test_agent_mode, start_operation_id, kv, kv_revision
                 ${extra.map(([column]) => `, ${column}`).join("")})
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'admitted', $9, $10, $11, 1 ${extra.map((_, index) => `, $${12 + index}`).join("")})`,
            [start.runId, definition.workflowSessionId, start.mode, revision.revision, revision.yamlSha256, revision.irSha256,
                start.inputsText, start.controllerInstanceId, test ? start.testAgentMode : null, operationId, start.kvText,
                ...extra.map(([, value]) => value)],
        );
        await client.query(`INSERT INTO ${this.t.kvRevisions} (run_id, revision, kv, operation_id) VALUES ($1, 1, $2, $3)`,
            [start.runId, start.kvText, operationId]);
        if (start.mode === "live") {
            // Review B1: the row follows its live run from its admission. A draft's test may have left it terminal, with
            // that test's error; the live run starts pending with none. Every caller returns a replayed receipt before
            // this, so a repeated start never resets the row of a live run that has ended.
            await client.query(`SELECT ${this.t.updateSession}($1, $2)`,
                [definition.workflowSessionId, JSON.stringify({ orchestrationId: start.controllerInstanceId, state: "pending", lastError: null })]);
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
     * SEMVER_REUSED (owner revision dump 2, 2026-11-06): one name and version, one definition, among the Workflows of one
     * session. Refused when another live Workflow of `parentSessionId` has the same metadata.name and version with other
     * YAML, that is neither this YAML hash nor (both valid) this IR hash:
     * - a Workflow with a definition: its published revision, or its current draft revision;
     * - a Workflow claimed but whose definition is not stored yet (being created): the name, version and hashes its claim
     *   recorded (`creation_config.workflowV2`).
     * Run on `client` inside the transaction that writes, after lockWorkflowVersion: two writers of one session and
     * name are serialized, and the later one sees the earlier one's committed claim or revision (READ COMMITTED).
     */
    async requireVersionFree(input: {
        parentSessionId: string;
        workflowSessionId: string;
        name: string;
        semver: string;
        yamlSha256: string;
        irSha256: string | null;
        /** The text after the refusal's reason: what was not saved. */
        nothingSaved: string;
    }, client?: PoolClient): Promise<void> {
        const sql =
            `SELECT workflow_session_id, state, revision FROM (
                SELECT d.workflow_session_id, d.state, r.revision, d.created_at
                  FROM ${this.t.definitions} d
                  JOIN ${this.t.revisions} r
                    ON r.workflow_session_id = d.workflow_session_id AND r.revision = COALESCE(d.published_revision, d.current_revision)
                  JOIN ${this.t.sessions} s ON s.session_id = d.workflow_session_id
                 WHERE d.parent_session_id = $1 AND d.workflow_session_id <> $2 AND d.state <> 'deleted' AND s.deleted_at IS NULL
                   AND r.name = $3 AND r.semver = $4 AND r.yaml_sha256 <> $5
                   AND (r.ir_sha256 IS NULL OR $6::text IS NULL OR r.ir_sha256 <> $6::text)
                UNION ALL
                SELECT s.session_id, 'claimed', NULL, s.created_at
                  FROM ${this.t.sessions} s
                 WHERE s.parent_session_id = $1 AND s.session_id <> $2 AND s.session_kind = 'workflow' AND s.deleted_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM ${this.t.definitions} d WHERE d.workflow_session_id = s.session_id)
                   AND s.creation_config -> 'workflowV2' ->> 'name' = $3 AND s.creation_config -> 'workflowV2' ->> 'version' = $4
                   AND s.creation_config -> 'workflowV2' ->> 'yamlSha256' <> $5
                   AND (s.creation_config -> 'workflowV2' ->> 'irSha256' IS NULL OR $6::text IS NULL
                        OR s.creation_config -> 'workflowV2' ->> 'irSha256' <> $6::text)
              ) found
              ORDER BY created_at DESC, workflow_session_id
              LIMIT 1`;
        const params = [input.parentSessionId, input.workflowSessionId, input.name, input.semver, input.yamlSha256, input.irSha256];
        const { rows } = client ? await client.query(sql, params) : await this.pool.query(sql, params);
        if (!rows[0]) return;
        const workflowId = str(rows[0], "workflow_session_id");
        const state = str(rows[0], "state");
        const revision = rows[0].revision === null || rows[0].revision === undefined ? null : int(rows[0], "revision");
        const label = `${input.name} ${input.semver}`;
        const what = state === "published"
            ? `${label} is already Workflow ${workflowId} of this session (published, revision ${revision}) with other YAML. `
                + "A published version never changes: raise metadata.version and spawn the change as a draft."
            : state === "claimed"
                ? `${label} is being created as Workflow ${workflowId} of this session with other YAML. Raise metadata.version, `
                    + "or wait for it and change it as a draft."
                : `${label} is already Workflow ${workflowId} of this session (a draft, revision ${revision}) with other YAML. `
                    + "To change that draft, use update_workflow replace_definition on it; for a new definition, raise metadata.version.";
        throw new WorkflowStoreError("SEMVER_REUSED", `${what} ${input.nothingSaved}`,
            { name: input.name, version: input.semver, workflowId, state, revision });
    }

    /**
     * Serialize the writers of one session's Workflows of one name (SEMVER_REUSED): a transaction-level advisory lock on
     * (schema, session, name), held until `client`'s transaction ends. Writers of other names or sessions do not wait.
     */
    async lockWorkflowVersion(client: PoolClient, parentSessionId: string, name: string): Promise<void> {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [`${this.schema}:workflow-version:${JSON.stringify([parentSessionId, name])}`]);
    }

    /** lockWorkflowVersion, then requireVersionFree on the same client: the check a claim or a draft's replacement runs. */
    async requireVersionFreeLocked(client: PoolClient, input: Parameters<WorkflowStore["requireVersionFree"]>[0]): Promise<void> {
        await this.lockWorkflowVersion(client, input.parentSessionId, input.name);
        await this.requireVersionFree(input, client);
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
        /** The published revision's agent pins as canonical JSON (migration 0103); null or absent when there are none. */
        agentPinsText?: string | null;
        /**
         * Review SDK3-F3: the version check (requireVersionFreeLocked) for a definition stored on a claim this request did
         * not make now (a resumed creation, its claim from an earlier attempt or an earlier build): run in this transaction
         * once the definition row is new, before its revision. A replay of a stored creation is answered from its receipt
         * first and is not checked.
         */
        versionGuard?: Parameters<WorkflowStore["requireVersionFree"]>[0] | null;
        /** Stage 2.1: the chat revision this Workflow starts (chat-definition-store.ts, requireChatStartLocked). */
        chatPin?: { ownerSessionId: string; definitionId: string; revision: number } | null;
    }): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
        requireStoredYamlWithinLimit(input.yaml);
        requirePublishable(input.compiled, input.publish || Boolean(input.start));
        if (input.start && !input.publish) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "Starting a live run requires publication.");
        return this.transaction(async client => {
            if (input.chatPin) {
                // Stage 2.1 (Q3): a replay of a stored Start is answered first (its chat may have ended since); otherwise the
                // chat, the definition and the revision are checked under their locks, before this Workflow's own rows.
                const replay = await this.priorReceipt(client, input.workflowSessionId, input.operationId, "create", input.acceptedRequestSha256 ?? input.requestSha256);
                if (replay) return { receipt: replay, replayed: true };
                await requireChatStartLocked(client, this.schema, input.chatPin, input.compiled.yamlSha256);
            }
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
            if (input.versionGuard) await this.requireVersionFreeLocked(client, input.versionGuard);
            if (input.chatPin) {
                await client.query(`UPDATE ${this.t.definitions} SET chat_definition_id = $2, chat_revision = $3 WHERE workflow_session_id = $1`,
                    [input.workflowSessionId, input.chatPin.definitionId, input.chatPin.revision]);
            }
            await this.insertRevision(client, input.workflowSessionId, 1, input.yaml, input.compiled, input.actor);
            let definition = await this.lockDefinition(client, input.workflowSessionId);
            let run: WorkflowRunReceipt | null = null;
            if (input.publish) {
                // The pins name the column of migration 0103 only when there are any.
                const pinned = typeof input.agentPinsText === "string";
                const { rows } = await client.query(
                    `UPDATE ${this.t.definitions}
                        SET state = 'published', published_revision = 1, published_yaml_sha256 = $2, published_ir_sha256 = $3,
                            published_at = now(), updated_at = now() ${pinned ? ", published_agent_pins = $4" : ""}
                      WHERE workflow_session_id = $1 RETURNING *`,
                    [input.workflowSessionId, input.compiled.yamlSha256, input.compiled.irSha256, ...(pinned ? [input.agentPinsText] : [])],
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
        /** SEMVER_REUSED (requireVersionFree): refuse a replacement whose name and version another Workflow of the parent has with other YAML. */
        refuseVersionReuse?: boolean;
    }): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
        requireStoredYamlWithinLimit(input.yaml);
        return this.transaction(async client => {
            await this.requireLiveSession(client, input.workflowSessionId);
            const definition = await this.lockDefinition(client, input.workflowSessionId);
            const prior = await this.priorReceipt(client, input.workflowSessionId, input.operationId, "replace_definition", input.requestSha256);
            if (prior) return { receipt: prior, replayed: true };
            assertNotDeleted(definition);
            requireNotChatPinned(definition, "replace_definition");
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
            if (input.refuseVersionReuse === true && definition.parentSessionId && input.compiled.name && input.compiled.version) {
                await this.requireVersionFreeLocked(client, {
                    parentSessionId: definition.parentSessionId, workflowSessionId: input.workflowSessionId, name: input.compiled.name,
                    semver: input.compiled.version, yamlSha256: input.compiled.yamlSha256, irSha256: input.compiled.irSha256,
                    nothingSaved: "Nothing was saved: the draft keeps its revision.",
                });
            }
            await this.requireRevisionRoom(client, input.workflowSessionId, input.yaml);
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
        /** The published revision's agent pins as canonical JSON (migration 0103); null or absent when there are none. */
        agentPinsText?: string | null;
        /** With start: whether the parent is told when the live run ends (batch 7, n-1); absent leaves it as it is. */
        notifyParent?: boolean;
    }): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
        const kind = input.start ? "publish_and_start" : "publish";
        return this.transaction(async client => {
            await this.requireLiveSession(client, input.workflowSessionId);
            const definition = await this.lockDefinition(client, input.workflowSessionId);
            const prior = await this.priorReceipt(client, input.workflowSessionId, input.operationId, kind, input.requestSha256);
            if (prior) return { receipt: prior, replayed: true };
            assertNotDeleted(definition);
            requireNotChatPinned(definition, kind);
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
            const pinned = typeof input.agentPinsText === "string";
            const { rows } = await client.query(
                `UPDATE ${this.t.definitions}
                    SET state = 'published', published_revision = $2, published_yaml_sha256 = $3, published_ir_sha256 = $4,
                        published_at = now(), updated_at = now() ${pinned ? ", published_agent_pins = $5" : ""}
                  WHERE workflow_session_id = $1 RETURNING *`,
                [input.workflowSessionId, revision.revision, revision.yamlSha256, revision.irSha256, ...(pinned ? [input.agentPinsText] : [])],
            );
            const published = definitionFrom(rows[0]);
            const run = input.start ? await this.insertRun(client, published, revision, input.start, input.operationId) : null;
            if (run) await this.setNotifyParent(client, published, input.notifyParent);
            const receipt = this.receiptFor(kind, published, revision, run);
            await this.recordReceipt(client, input.workflowSessionId, input.operationId, kind, input.requestSha256, receipt);
            return { receipt, replayed: false };
        });
    }

    /**
     * Set whether the parent is told when the workflow's live run ends (definitions.notify_parent; batch 7, n-1), in the
     * transaction that admits that run, so the run's end reads what its start said. Nothing when it is absent or unchanged.
     */
    private async setNotifyParent(client: PoolClient, definition: WorkflowDefinitionRow, notifyParent: boolean | undefined): Promise<void> {
        if (typeof notifyParent !== "boolean" || definition.notifyParent === notifyParent) return;
        await client.query(`UPDATE ${this.t.definitions} SET notify_parent = $2, updated_at = now() WHERE workflow_session_id = $1`,
            [definition.workflowSessionId, notifyParent]);
    }

    /** Admit the live run of a published definition. */
    async startLive(input: {
        workflowSessionId: string;
        definitionHash: string;
        operationId: string;
        requestSha256: string;
        start: RunAdmission;
        /** Whether the parent is told when this live run ends (batch 7, n-1); absent leaves it as it is. */
        notifyParent?: boolean;
    }): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
        return this.transaction(async client => {
            await this.requireLiveSession(client, input.workflowSessionId);
            const definition = await this.lockDefinition(client, input.workflowSessionId);
            const prior = await this.priorReceipt(client, input.workflowSessionId, input.operationId, "start", input.requestSha256);
            if (prior) return { receipt: prior, replayed: true };
            assertNotDeleted(definition);
            requireNotChatPinned(definition, "start");
            if (definition.state !== "published" || definition.publishedRevision === null) {
                throw new WorkflowStoreError("NOT_PUBLISHED", "Publish the exact reviewed revision before starting its live run.");
            }
            if (definition.publishedYamlSha256 !== input.definitionHash) {
                throw new WorkflowStoreError("DEFINITION_HASH_MISMATCH", "The definition hash does not match the published revision.",
                    { publishedRevision: definition.publishedRevision, yamlSha256: definition.publishedYamlSha256 });
            }
            const revision = await this.readRevisionRow(client, input.workflowSessionId, definition.publishedRevision);
            const run = await this.insertRun(client, definition, revision, input.start, input.operationId);
            await this.setNotifyParent(client, definition, input.notifyParent);
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
     * run was paused from. A stopping run (requestRunStop) is neither paused
     * nor resumed: RUN_STOPPING.
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
            // A stopping run admits nothing either way (migration 0100); its stop decides how it ends.
            if (run.stop !== null) {
                throw new WorkflowStoreError("RUN_STOPPING", `Run ${run.runId} is stopping, until ${run.stop.deadlineAt.toISOString()}; it cannot be ${kind}d.`,
                    { deadlineAt: run.stop.deadlineAt.toISOString() });
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
                data: { runId: run.runId, actor: actorJson(input.actor), ...(input.reason ? { reason: redactThenClip(input.reason, 500) } : {}) },
            }], update: { state: updated.status === "paused" ? "waiting" : updated.status === "admitted" ? "pending" : "running", touch: true } }, run);
            const receipt: WorkflowRunCommandReceipt = { workflowSessionId: input.workflowSessionId, operation: kind, runId: run.runId, status: updated.status, kvRevision: updated.kvRevision };
            await this.recordReceipt(client, input.workflowSessionId, input.operationId, kind, input.requestSha256, receipt);
            return { receipt, replayed: false };
        });
    }

    /**
     * Accept a graceful stop of a run (design 02 run lifecycle, D03;
     * migration 0100), once per operation id, in one transaction under the
     * session, definition and run locks. The run must be active and admitted
     * for a controller version that runs a stop (`stoppableVersions`:
     * controller 1.9.0; a run admitted for another version, or before 0100,
     * is refused with RUN_STOP_UNSUPPORTED and can be cancelled), and must
     * not be stopping already. The stop is written once: one reading of the
     * store's clock is its requested time, and that reading plus
     * `graceSeconds` its deadline. From then on the run admits no new node
     * execution (enterNode refuses "stopping", paused or not); its admitted
     * work may settle until the deadline, and its controller ends it
     * (finishStoppedRun). Resume and pause refuse a stopping run; a cancel,
     * a deletion and KV updates still apply, and the first run end stands.
     * The receipt is the run as the stop was accepted; a repeat returns it,
     * whatever happened since.
     */
    async requestRunStop(input: {
        workflowSessionId: string;
        runId: string;
        operationId: string;
        requestSha256: string;
        actor: WorkflowActor;
        reason: string | null;
        graceSeconds: number;
        stoppableVersions: readonly string[];
    }): Promise<StoredOperation<WorkflowRunCommandReceipt> & { run: WorkflowRunRow }> {
        if (!Number.isSafeInteger(input.graceSeconds) || input.graceSeconds < 0 || input.graceSeconds > WORKFLOW_V2_STOP_MAX_GRACE_SECONDS) {
            throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `grace_seconds must be an integer from 0 to ${WORKFLOW_V2_STOP_MAX_GRACE_SECONDS}.`);
        }
        return this.transaction(async client => {
            if (!await this.lockLiveSession(client, input.workflowSessionId)) throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow was deleted.");
            await this.lockDefinition(client, input.workflowSessionId);
            const prior = await this.priorRunCommand(client, input.workflowSessionId, input.operationId, "stop", input.requestSha256);
            const run = await this.lockRun(client, input.runId);
            if (run.workflowSessionId !== input.workflowSessionId) throw new WorkflowStoreError("RUN_NOT_FOUND", `Run ${input.runId} is not a run of this workflow.`);
            // The request hash names the run, so the stored receipt is this run's.
            if (prior) return { receipt: prior, replayed: true, run };
            if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
                throw new WorkflowStoreError("RUN_ENDED", `Run ${run.runId} has ended (${run.status}).`, { status: run.status });
            }
            if (run.controllerVersion === null || !input.stoppableVersions.includes(run.controllerVersion)) {
                throw new WorkflowStoreError("RUN_STOP_UNSUPPORTED",
                    `Run ${run.runId} runs on workflow controller ${run.controllerVersion ?? "1.8.0 or earlier"}, which cannot stop a run gracefully; cancel it instead.`,
                    { controllerVersion: run.controllerVersion });
            }
            if (run.stop !== null) {
                throw new WorkflowStoreError("RUN_ALREADY_STOPPING", `Run ${run.runId} is already stopping, until ${run.stop.deadlineAt.toISOString()}.`,
                    { deadlineAt: run.stop.deadlineAt.toISOString() });
            }
            // SF-6 verification: the stop's reason is kept with its secrets hidden, hidden before it is cut (R3-SF-2).
            const request = canonicalJson({ operationId: input.operationId, reason: input.reason === null ? null : redactThenClip(input.reason, 500),
                actor: actorJson(input.actor), graceSeconds: input.graceSeconds });
            // One reading of the store's clock is the stop's time; its deadline counts the grace from it.
            const { rows } = await client.query(
                `WITH stopped AS (SELECT clock_timestamp() AS at)
                 UPDATE ${this.t.runs}
                    SET stop_requested_at = (SELECT at FROM stopped), stop_deadline_at = (SELECT at FROM stopped) + $2::integer * interval '1 second',
                        stop_request = $3, updated_at = now()
                  WHERE run_id = $1 RETURNING *`,
                [run.runId, input.graceSeconds, request]);
            const updated = runFrom(rows[0]);
            await this.project(client, { sessionId: input.workflowSessionId, events: [{ eventType: "workflow.stop_requested", data: {
                runId: run.runId, actor: actorJson(input.actor), graceSeconds: input.graceSeconds, deadlineAt: updated.stop!.deadlineAt.toISOString(),
                ...(input.reason ? { reason: redactThenClip(input.reason, 500) } : {}),
            } }], update: { touch: true } });
            const receipt: WorkflowRunCommandReceipt = { workflowSessionId: input.workflowSessionId, operation: "stop", runId: run.runId, status: updated.status, kvRevision: updated.kvRevision };
            await this.recordReceipt(client, input.workflowSessionId, input.operationId, "stop", input.requestSha256, receipt);
            return { receipt, replayed: false, run: updated };
        });
    }

    /**
     * Record that a cancel command was accepted for a run, and end the run
     * here, at once, as cancelled, when it is active (durable lifecycle
     * intent, S7-DX2): the first run-ending commit decides the run, and a
     * command never waits in the controller's queue, where duroxide can drop
     * it. A run that has not begun (admitted, or paused before its controller
     * began it) ends as before (cancelBeforeBegin): its controller may not
     * exist yet, and a controller that starts later finds the run ended at
     * begin. A begun run (running, paused, or stopping) ends as the
     * controller's cancel activity ends it (endRunForCommandIn): its pending
     * work is cancelled, so no further state is admitted; the caller then
     * wakes the controller, which finds the run ended and does its post-end
     * work (it stops the cancelled effects, ends agent children and tells the
     * parent). The run end, its projection and the receipt commit in one
     * transaction, under the session and run locks. A run that already ended
     * is left as it is: the receipt records its status.
     *
     * The receipt is the accept-time result: the run's status and KV revision
     * after the cancel was accepted. It is stored once and never rewritten; a
     * repeat returns it as stored, and read_workflow shows the run as it is
     * now. A repeat of a cancel accepted by an earlier build, for a run that
     * is still active (its command was only queued, and may have been
     * dropped), ends the run now, as that accepted cancel requires; its
     * receipt stays as stored.
     */
    async recordRunCancelRequest(input: {
        workflowSessionId: string;
        runId: string;
        operationId: string;
        requestSha256: string;
        reason: string;
        requestedBy: string | null;
        /** UXP-AD-01: who cancelled, kept with the run's workflow.cancelled event (readLastRunControl). */
        actor?: WorkflowActor;
    }): Promise<StoredOperation<WorkflowRunCommandReceipt> & { run: WorkflowRunRow }> {
        return this.transaction(async client => {
            if (!await this.lockLiveSession(client, input.workflowSessionId)) throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow was deleted.");
            await this.lockDefinition(client, input.workflowSessionId);
            const prior = await this.priorRunCommand(client, input.workflowSessionId, input.operationId, "cancel", input.requestSha256);
            const run = await this.lockRun(client, input.runId);
            if (run.workflowSessionId !== input.workflowSessionId) throw new WorkflowStoreError("RUN_NOT_FOUND", `Run ${input.runId} is not a run of this workflow.`);
            const end = (repaired: boolean): Promise<WorkflowRunRow> => !ACTIVE_RUN_STATUSES.includes(run.status) ? Promise.resolve(run)
                : runNotBegun(run) ? this.cancelBeforeBegin(client, run, input, repaired)
                    : this.endRunForCommandIn(client, run, { command: "cancel", reason: input.reason, requestedBy: input.requestedBy,
                        operationId: input.operationId, repaired, ...(input.actor ? { actor: input.actor } : {}) });
            if (prior) {
                // The request hash names the run, so the stored receipt is this run's.
                return { receipt: prior, replayed: true, run: await end(true) };
            }
            const current = await end(false);
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
        input: { workflowSessionId: string; operationId: string; reason: string; requestedBy: string | null; command?: "cancel" | "done"; attributedFrom?: string;
            actor?: WorkflowActor },
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
            // SF-6 verification: the reason is a person's or an agent's text; its secrets are hidden before it is stored.
            [run.runId, redactWorkflowErrorText(canonicalJson({ code: "cancelled", message: redactThenClip(input.reason, 4_000), details: {
                command, requestedBy: input.requestedBy, ...marks,
            } }), canonicalJson)]);
        // No node execution exists before begin; one that did would lose to the cancel, as when the controller cancels.
        await client.query(
            `UPDATE ${this.t.nodes}
                SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error', error = $2, output = NULL,
                    winner = 'cancel', completed_at = now()
              WHERE run_id = $1 AND state = 'pending'`,
            [run.runId, canonicalJson({ code: "cancelled", message: "The workflow run was cancelled." })]);
        await this.project(client, { sessionId: input.workflowSessionId, events: [{ eventType: "workflow.cancelled", data: {
            runId: run.runId, reason: redactThenClip(input.reason, 500), command, ...marks, ...(input.actor ? { actor: actorJson(input.actor) } : {}),
        } }], update: { state: "cancelled", lastError: redactThenClip(input.reason, 500), touch: true } }, run);
        return runFrom(rows[0]);
    }

    /**
     * Apply a lifecycle command (cancel, done or delete) that a parent's
     * durable session sent to its v2 workflow child, or that an operator sent
     * (the management API, the agent manager; no requester), once per
     * operation id, in one transaction under the session, definition and run
     * locks:
     * - delete soft-deletes the child here, whatever its run is doing: the
     *   deletion trigger (migrations 0090, 0091) tombstones the definition
     *   and ends an active run in this same transaction (its pending nodes
     *   lose to the deletion, and a running script's liveness check stops
     *   it); a run that already ended keeps its result. A delete never waits
     *   in a queue, where a run that ended first would leave it unapplied;
     * - cancel or done of a live active run ends it here, as update_workflow
     *   cancel does (done is cancel with its "Stopped" reason): a run that has
     *   not begun as before, a begun one (running, paused or stopping) as its
     *   controller's cancel activity would (S7-DX2; `wake` then says the
     *   caller queues the command for the controller, which finds the run
     *   ended and does its post-end work); the first run end stands;
     * - a receipt an older build stored as "queued" (for its controller) whose
     *   run is still active is applied when its request is repeated;
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
        /** The parent session that sent it; null for an operator's command (the management API, the agent manager). */
        requestedBy: string | null;
    }): Promise<{ receipt: WorkflowSessionCommandReceipt; replayed: boolean; run: WorkflowRunRow | null; wake: boolean }> {
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
            // UXP-AD-01: a parent's command names it as the cancel's actor (an operator's, with no requester, names none).
            const actor: WorkflowActor | undefined = input.requestedBy ? { kind: "agent", sessionId: input.requestedBy } : undefined;
            /** End a begun active run for this cancel or done (S7-DX2); the controller is then woken. */
            const endBegun = async (current: WorkflowRunRow, command: "cancel" | "done", repaired: boolean): Promise<WorkflowRunRow> =>
                this.endRunForCommandIn(client, current, { command, reason: input.reason, requestedBy: input.requestedBy, operationId: input.operationId, repaired,
                    ...(actor ? { actor } : {}) });
            if (priorRows[0]) {
                const prior = parseSessionCommandReceipt(parseStoredJson(str(priorRows[0], "receipt"), "receipt"));
                // An accepted delete holds whatever the run did since; the session is live here, so it was not applied yet.
                if (prior.command === "delete") await softDelete();
                // A cancel or done an older build accepted for the run's controller (only queued): applied now, if its run is
                // still active (S7-DX2). Its receipt stays as stored.
                if (prior.applied === "queued" && prior.command !== "delete" && run !== null && prior.runId === run.runId
                    && ACTIVE_RUN_STATUSES.includes(run.status) && !runNotBegun(run)) {
                    run = await endBegun(run, prior.command, true);
                }
                // A repeat of an end applied here wakes the controller again (its earlier wake may have been lost).
                const wake = run !== null && prior.command !== "delete" && commandEndOf(run)?.operationId === input.operationId;
                return { receipt: prior, replayed: true, run, wake };
            }
            const begun = run !== null && ACTIVE_RUN_STATUSES.includes(run.status) && !runNotBegun(run);
            let applied: WorkflowSessionCommandReceipt["applied"];
            let status: string | null = run?.status ?? null;
            let wake = false;
            if (input.command === "delete") {
                await softDelete();
                applied = "store";
                status = "deleted";
            } else if (begun && run !== null) {
                run = await endBegun(run, input.command, false);
                applied = "store";
                status = run.status;
                wake = true;
            } else if (run !== null && runNotBegun(run)) {
                run = await this.cancelBeforeBegin(client, run, { ...input, command: input.command, ...(actor ? { actor } : {}) }, false);
                applied = "store";
                status = run.status;
            } else {
                applied = "none";
            }
            const receipt: WorkflowSessionCommandReceipt = { workflowSessionId: input.workflowSessionId, command: input.command, applied, runId: run?.runId ?? null, status };
            await this.recordReceipt(client, input.workflowSessionId, input.operationId, kind, input.requestSha256, receipt);
            return { receipt, replayed: false, run, wake };
        });
    }

    /** A session row's kind and parent, and whether it is deleted (cms_get_session hides deleted rows). */
    async readSessionLink(sessionId: string): Promise<{ sessionKind: string | null; parentSessionId: string | null; deleted: boolean } | null> {
        const { rows } = await this.pool.query(
            `SELECT session_kind, parent_session_id, deleted_at FROM ${this.t.sessions} WHERE session_id = $1`, [sessionId]);
        if (!rows[0]) return null;
        return { sessionKind: strOrNull(rows[0], "session_kind"), parentSessionId: strOrNull(rows[0], "parent_session_id"), deleted: rows[0].deleted_at !== null };
    }

    /**
     * Whether a run's end was told to its parent, or recorded as not told (workflow.parent_notified or
     * workflow.parent_notification_skipped for the run): until then the run owes its parent that notice (adversarial
     * review RT-4). Every event of the workflow session is looked at, not only its first page.
     */
    async runNoticeRecorded(workflowSessionId: string, runId: string): Promise<boolean> {
        const { rows } = await this.pool.query(
            `SELECT 1 FROM ${this.t.sessionEvents}
              WHERE session_id = $1 AND event_type IN ('workflow.parent_notified', 'workflow.parent_notification_skipped') AND data->>'runId' = $2
              LIMIT 1`, [workflowSessionId, runId]);
        return rows.length > 0;
    }

    /**
     * Whether an earlier attempt to tell the parent of a run's end may have queued the notice: it records
     * workflow.parent_notifying just before the enqueue (adversarial review WFO-4).
     */
    async runNoticeAttempted(workflowSessionId: string, runId: string): Promise<boolean> {
        const { rows } = await this.pool.query(
            `SELECT 1 FROM ${this.t.sessionEvents}
              WHERE session_id = $1 AND event_type = 'workflow.parent_notifying' AND data->>'runId' = $2 LIMIT 1`, [workflowSessionId, runId]);
        return rows.length > 0;
    }

    /**
     * How many of a run's sends and requests to `recipientSessionId` (an agent session) may still queue their message,
     * with a delivery attempt begun (counted under the session locks) within the last `withinSeconds` (adversarial
     * review WFO-1 and its verification): one that is not recorded yet (a run's end leaves a message to an agent session
     * pending, decidePendingSendsIn), and one failed at or after its last attempt began (its enqueue may still be
     * running). A delivered one, an older attempt, and one failed before its last attempt began are not counted.
     * `timeoutMs` is the statement's timeout on the server.
     */
    async runDeliveriesInFlight(runId: string, recipientSessionId: string, withinSeconds: number, timeoutMs = 5_000): Promise<number> {
        const timeout = Math.max(1, Math.min(60_000, Math.floor(timeoutMs)));
        return await this.transaction(async client => {
            await client.query(`SET LOCAL statement_timeout = ${timeout}`);
            const { rows } = await client.query(
                `SELECT count(*)::int AS n FROM ${this.t.outbox}
                  WHERE run_id = $1 AND recipient_session_id = $2 AND attempts > 0
                    AND COALESCE(recipient_kind, 'agent') = 'agent'
                    AND last_attempt_at > clock_timestamp() - make_interval(secs => $3)
                    AND (state = 'pending' OR (state = 'failed' AND decided_at >= last_attempt_at))`, [runId, recipientSessionId, withinSeconds]);
            return Number(rows[0]?.n ?? 0);
        });
    }

    /**
     * Run `work` while this attempt holds the run's notice lock (adversarial review WFO-4 and its verification): a
     * session-level advisory lock on the schema and the run id, held on a connection of its own for the whole of
     * `work`, taken from the notice lock's own pool (E3-R2). An attempt that finds it held tries again every `pollMs`
     * for up to `waitMs` (E3-R1); still held, this returns `{ locked: false }` without running `work`. A process that
     * dies while it holds the lock loses its connection, and the lock with it. A connection that cannot unlock is
     * closed, not returned to its pool, so the lock never outlives `work`.
     */
    async withRunNoticeLock<T>(runId: string, work: () => Promise<T>, wait: { waitMs?: number; pollMs?: number } = {})
        : Promise<{ locked: true; value: T } | { locked: false }> {
        return this.withSessionAdvisoryLock(`${this.schema}:workflow-run-notice:${runId}`, work, wait);
    }

    /**
     * Run `work` while this attempt holds a continued chat's end lock (chat: continue; review RT-1, formal t3): the look
     * at the chat, the end command and the mark that it was sent are one critical section, so the lookers that may
     * meet (the spawn's after-send and decided-path retries, the run's cleanup and its detached retry, a recover) send
     * the end once. The same lock as withRunNoticeLock, on the chat's id: `{ locked: false }` when another looker holds
     * it past `waitMs`.
     */
    async withChatEndLock<T>(childSessionId: string, work: () => Promise<T>, wait: { waitMs?: number; pollMs?: number } = {})
        : Promise<{ locked: true; value: T } | { locked: false }> {
        return this.withSessionAdvisoryLock(`${this.schema}:workflow-chat-end:${childSessionId}`, work, wait);
    }

    /** withRunNoticeLock's and withChatEndLock's lock: a session-level advisory lock on `key`, as described there. */
    private async withSessionAdvisoryLock<T>(key: string, work: () => Promise<T>, wait: { waitMs?: number; pollMs?: number })
        : Promise<{ locked: true; value: T } | { locked: false }> {
        const pool = this.options.noticeLockPool ? await this.options.noticeLockPool() : this.pool;
        const client = await pool.connect();
        let broken: Error | undefined;
        try {
            const until = Date.now() + Math.max(0, wait.waitMs ?? 0);
            const pollMs = Math.max(10, wait.pollMs ?? 500);
            for (;;) {
                let locked: boolean;
                try {
                    const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [key]);
                    locked = rows[0]?.locked === true;
                } catch (error) {
                    broken = error instanceof Error ? error : new Error(String(error));
                    throw error;
                }
                if (locked) break;
                if (Date.now() + pollMs > until) return { locked: false };
                await new Promise(resolve => setTimeout(resolve, pollMs));
            }
            try {
                return { locked: true, value: await work() };
            } finally {
                try {
                    await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
                } catch (error) {
                    broken = error instanceof Error ? error : new Error(String(error));
                }
            }
        } finally {
            client.release(broken);
        }
    }

    /** Record transcript events outside a transition (notifications, cleanup requests). */
    /**
     * Put a workflow session's row back to its live run's end (adversarial review R2-RT-2), for recover: a status read
     * before that fix wrote "failed" over it when the controller orchestration failed after the end was stored (its
     * notice to the parent never got through). The row gets the state the run's end writes (completed, failed, or
     * cancelled for a cancelled or stopped run) and an error from it: none for a completed run, the stored error for a
     * failed one, the error's message for a cancelled or stopped one. Under the session and run locks. A deleted session,
     * a run still active, a test run, or a row that already says so changes nothing. Returns whether the row changed.
     */
    async repairEndedRunSessionRow(runId: string): Promise<{ repaired: boolean }> {
        return this.transaction(async client => {
            const workflowSessionId = await this.workflowOfRun(client, runId);
            const live = await this.lockLiveSession(client, workflowSessionId);
            const run = await this.lockRun(client, runId);
            if (!live || run.mode !== "live" || ACTIVE_RUN_STATUSES.includes(run.status)) return { repaired: false };
            const state = run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : "cancelled";
            const { rows } = await client.query(`SELECT state FROM ${this.t.sessions} WHERE session_id = $1`, [workflowSessionId]);
            if (!rows[0] || rows[0].state === state) return { repaired: false };
            const error = run.terminalError;
            const lastError = state === "completed" || error === null ? null
                : state === "failed" ? jsonbSafeText(canonicalJson(error), 2_000)
                    : isJsonObject(error) && typeof error.message === "string" ? jsonbSafeText(error.message, 500) : null;
            await this.project(client, { sessionId: workflowSessionId, update: { state, lastError, touch: true } }, run);
            return { repaired: true };
        });
    }

    /**
     * A workflow's controller orchestration failed while its run had not ended (re-check R2-RT2-RC1 and its re-check
     * R2-RC2-RT2-1): its session row says failed. Decided under the session lock from the row as it is now, never from a
     * status read's older snapshot; a deleted session, or a row that already says the run ended, is left alone.
     * - A v2 workflow (its creation names workflowV2, or it has a v2 definition): only while its live run has not ended
     *   (its end, or recover's repair, owns the row); without a live run (a draft, or only test runs) nothing is written.
     *   The row says failed with `message`, or that the controller failed before the run ended.
     * - A legacy (version 1) workflow, identified by its stored admission (workflowAdmission) and no v2 identity at all:
     *   its row is its run's, so it says failed, with `message` when there is one (else its last error stays), as a status
     *   read wrote it before RC1. A missing live run alone never makes a workflow legacy.
     * Returns whether the row changed, and which kind of workflow it was.
     */
    async recordControllerFailed(input: { workflowSessionId: string; message: string | null }): Promise<{ written: boolean; kind?: "v2" | "legacy" }> {
        return this.transaction(async client => {
            if (!await this.lockLiveSession(client, input.workflowSessionId)) return { written: false };
            const { rows: session } = await client.query(
                `SELECT state, session_kind, COALESCE(creation_config ? 'workflowAdmission', false) AS admitted,
                        COALESCE(creation_config ? 'workflowV2', false) AS v2
                   FROM ${this.t.sessions} WHERE session_id = $1`, [input.workflowSessionId]);
            const row = session[0];
            if (!row || row.session_kind !== "workflow") return { written: false };
            const state = row.state;
            if (state === "failed" || state === "completed" || state === "cancelled") return { written: false };
            const { rows: definition } = await client.query(`SELECT 1 FROM ${this.t.definitions} WHERE workflow_session_id = $1`, [input.workflowSessionId]);
            const v2 = row.v2 === true || definition.length > 0;
            if (!v2) {
                if (row.admitted !== true) return { written: false };
                const updates: Record<string, string | null> = { state: "failed", waitReason: null, lastActiveAt: new Date().toISOString() };
                if (input.message) updates.lastError = jsonbSafeText(redactWorkflowSecrets(input.message), 4_000);
                await client.query(`SELECT ${this.t.updateSession}($1, $2)`, [input.workflowSessionId, JSON.stringify(updates)]);
                return { written: true, kind: "legacy" as const };
            }
            const { rows: live } = await client.query(
                `SELECT status FROM ${this.t.runs} WHERE workflow_session_id = $1 AND mode = 'live' ORDER BY created_at DESC LIMIT 1`, [input.workflowSessionId]);
            if (!live[0] || !ACTIVE_RUN_STATUSES.includes(str(live[0], "status") as WorkflowRunStatus)) return { written: false, kind: "v2" as const };
            await this.project(client, { sessionId: input.workflowSessionId, update: {
                state: "failed", lastError: input.message ?? "The workflow controller failed before the run ended.", touch: true } });
            return { written: true, kind: "v2" as const };
        });
    }

    /**
     * Review R3-PA1 (formal parent.r3-told-twice): a run's end notice kept as a note for a parent chat that has not
     * started (deployed check DS-2) and its skip record, in one transaction. A failure between the two wrote neither,
     * so a retry never finds the note without its skip and tells the parent a second time.
     */
    async keepNoticeAsNote(input: { ownerSessionId: string; definitionId: string; revision: number; text: string; projection: SessionProjection })
        : Promise<void> {
        await this.transaction(async client => {
            await this.chat.keepNoteIn(client, input.ownerSessionId, input.definitionId, input.revision, input.text);
            await this.project(client, input.projection);
        });
    }

    async recordSessionEvents(sessionId: string, events: SessionEventRecord[]): Promise<void> {
        if (events.length === 0) return;
        // SF-6: the secrets in an event's error fields are hidden before it is stored.
        const safe = events.map(event => ({ eventType: event.eventType, data: jsonbSafeValue(redactWorkflowEventData(event.data)) }));
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

    /**
     * A revision's IR version, read from its stored IR without parsing it
     * (so a build reads it whatever version it runs; null for a revision
     * that does not exist or has no compiled IR). Hosts use it to refuse a
     * revision they do not run before anything is written.
     */
    async readRevisionIrVersion(workflowSessionId: string, revision: number): Promise<number | null> {
        const { rows } = await this.pool.query(
            `SELECT CASE WHEN ir IS NULL THEN NULL ELSE ir::jsonb ->> 'irVersion' END AS ir_version FROM ${this.t.revisions}
              WHERE workflow_session_id = $1 AND revision = $2`, [workflowSessionId, revision]);
        const value = rows[0]?.ir_version;
        if (value === null || value === undefined) return null;
        const irVersion = Number(value);
        if (!Number.isSafeInteger(irVersion) || irVersion < 1) {
            throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Revision ${revision} of workflow ${workflowSessionId} has an invalid IR version.`);
        }
        return irVersion;
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

    /**
     * UXP-AD-01: a run's latest control action that names who took it: the newest of its Workflow's workflow.paused,
     * workflow.resumed, workflow.vars_set, workflow.stop_requested and workflow.cancelled events (a cancel command's; a
     * "done" is no control action) whose data names an actor, with the reason as it was stored and, for a person, the
     * display name the users table has for them. Null when the run has none. A read of the projected events; it changes
     * nothing, and an actor of another shape is not shown.
     */
    async readLastRunControl(workflowSessionId: string, runId: string): Promise<WorkflowRunControl | null> {
        const { rows } = await this.pool.query(
            `SELECT e.event_type, e.data, e.created_at, u.display_name
               FROM ${this.t.sessionEvents} e
               LEFT JOIN ${this.t.users} u ON e.data #>> '{actor,kind}' = 'user'
                    AND u.provider = e.data #>> '{actor,provider}' AND u.subject = e.data #>> '{actor,subject}'
              WHERE e.session_id = $1 AND e.event_type = ANY($2::text[]) AND e.data ->> 'runId' = $3
                AND jsonb_typeof(e.data -> 'actor') = 'object'
                AND (e.event_type <> 'workflow.cancelled' OR COALESCE(e.data ->> 'command', 'cancel') = 'cancel')
              ORDER BY e.seq DESC
              LIMIT 1`,
            [workflowSessionId, Object.keys(RUN_CONTROL_EVENTS), runId]);
        const row = rows[0];
        if (!row) return null;
        const data = isJsonObject(row.data) ? row.data : {};
        const actor = storedActor(data.actor);
        const operation = RUN_CONTROL_EVENTS[str(row, "event_type")];
        if (!actor || !operation) return null;
        const displayName = actor.kind === "user" && typeof row.display_name === "string" && row.display_name.trim()
            ? jsonbSafeText(row.display_name.trim(), 200) : null;
        return { operation, actor, displayName, at: new Date(row.created_at), reason: typeof data.reason === "string" ? data.reason : null };
    }

    /**
     * Lock one run's row FOR UPDATE.
     *
     * The lock-order rule (stage 2 review S2RT-F2; lock-order check O2): every writer of a Workflow's runs or nodes holds
     * that Workflow's session row first (lockLiveSession, lockSessionPair, or the chat-ended trigger of migration 0109,
     * which locks the chat's Workflow sessions in id order before their runs). The global order is: a chat's row, its
     * definition's row, the Workflow session rows (a chat before its own Workflows, otherwise ascending id), the Workflow's
     * definition row, its run rows (in id order), its node rows. The cascades of 0109 and 0090 change nodes and runs
     * without ordering them among themselves; that is safe only because the session row they hold serializes every other
     * writer of those rows. A new path that writes runs or nodes without the Workflow's session row reopens S2RT-F2.
     */
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
    /**
     * `options.deadlineSeconds` (controller 1.9.0; a definition with limits.timeoutSeconds): the transition that begins the
     * run also writes its deadline (migration 0104): the run's clock now (a test run's virtual clock) plus those seconds.
     */
    async beginRun(runId: string, projection?: SessionProjection, options: { deadlineSeconds?: number | null } = {})
        : Promise<{ run: WorkflowRunRow; transitioned: boolean }> {
        const deadlineSeconds = options.deadlineSeconds ?? null;
        if (deadlineSeconds !== null && !(Number.isSafeInteger(deadlineSeconds) && deadlineSeconds >= 1)) {
            throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Run ${runId} has an invalid deadline of ${String(deadlineSeconds)} seconds.`);
        }
        // Named only with a deadline, so a schema before migration 0104 begins every other run as before.
        const deadline = deadlineSeconds === null ? "" : ", deadline_at = COALESCE(virtual_now, clock_timestamp()) + $2::integer * interval '1 second'";
        const deadlineParams = deadlineSeconds === null ? [] : [deadlineSeconds];
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
                    const parent = definitions[0] ? strOrNull(definitions[0], "parent_session_id") : null;
                    // RLR-F7: the cancel this applies is the parent's (attributed as requestedBy is, never to a person), so its
                    // event names the parent as its actor and read_workflow's lastControl shows it.
                    const ended = await this.cancelBeforeBegin(client, run, { workflowSessionId: run.workflowSessionId,
                        operationId: str(accepted[0], "operation_id"), reason: "Cancelled before it began",
                        requestedBy: parent, attributedFrom: "update_workflow", ...(parent ? { actor: { kind: "agent", sessionId: parent } } : {}) }, true);
                    return { run: ended, transitioned: false };
                }
            }
            // A run paused before its controller began has begun now; it stays paused.
            if (run.status === "paused" && run.pausedFrom === "admitted") {
                const { rows } = await client.query(
                    `UPDATE ${this.t.runs} SET paused_from = 'running', updated_at = now() ${deadline} WHERE run_id = $1 RETURNING *`, [runId, ...deadlineParams]);
                // The session row shows a paused workflow as waiting (the session statuses have no "paused").
                await this.project(client, projection ? { ...projection, update: { ...projection.update, state: "waiting" } } : undefined, run);
                return { run: runFrom(rows[0]), transitioned: true };
            }
            if (run.status !== "admitted") return { run, transitioned: false };
            const { rows } = await client.query(
                `UPDATE ${this.t.runs} SET status = 'running', updated_at = now() ${deadline} WHERE run_id = $1 RETURNING *`, [runId, ...deadlineParams]);
            await this.project(client, projection, run);
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
         * Stage 2.4: a clock wait's time (IR 10), instead of waitSeconds: its deadline is the next time it names after the
         * admission's accepted-entry reading of the store's clock (a test run's virtual clock), DST-safe (cron-at.ts).
         */
        waitAt?: WorkflowIRClockWait | null;
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
        /**
         * What an agent state records (null for other states and for one that
         * failed at admission).
         * Its deadline is the admission's accepted-entry reading plus its
         * seconds, as a wait's; waitSeconds is null with it.
         */
        agent?: AgentSpecInput | null;
        /**
         * A test run's intercepted effect (migration 0102; design 05): an
         * agent, send or request state admitted pending without its live
         * record (no child session, outbox message or request record); its
         * interception record is written in this transaction, awaiting the
         * parent. An agent's or a request's deadline is waitSeconds, counted
         * from the run's virtual clock as every deadline of a test run is.
         * Only a test run's admission passes one; null otherwise and for a
         * state that failed at admission.
         */
        intercept?: { operation: "agent" | "send" | "request"; argumentsText: string; responseSchema: string | null } | null;
        immediate: NodeResultInput | null;
        projection?: SessionProjection;
    }): Promise<{ admitted: true; inserted: boolean; node: WorkflowNodeExecutionRow }
        | { admitted: false; reason: "inactive" | "kv_changed" | "stopping" | "expired" | "cut"; run: WorkflowRunRow }> {
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
            // A run past its deadline (migration 0104) admits nothing, stopping or paused or not: its controller ends it.
            if (live && ACTIVE_RUN_STATUSES.includes(run.status) && run.deadlineAt !== null && await this.runExpiredIn(client, run.runId)) {
                return { admitted: false as const, reason: "expired" as const, run };
            }
            // A run with an accepted stop admits nothing new (migration 0100), paused or not: its admitted work settles,
            // then it ends stopped. A paused run admits nothing new; a deleted or ended one admits nothing at all.
            if (live && ACTIVE_RUN_STATUSES.includes(run.status) && run.stop !== null) return { admitted: false as const, reason: "stopping" as const, run };
            if (!live || !ADMITTING_RUN_STATUSES.includes(run.status)) return { admitted: false as const, reason: "inactive" as const, run };
            if (run.kvRevision !== input.kvRevision) return { admitted: false as const, reason: "kv_changed" as const, run };
            // IR 9: a branch of a parallel state already decided (its join or its own time limit; the run lock orders this
            // with that decision) admits nothing more, and once the state's time limit passed (by the run's clock) a branch
            // admits only its terminal: work that starts then can no longer count, and a terminal records the end of work
            // stored before (J1b). Its controller ends the branch when it is refused.
            const branchScope = parseBranchScope(input.scopeId);
            if (branchScope !== null) {
                const { rows: parents } = await client.query(
                    `SELECT parallel.state, parallel.deadline_at IS NOT NULL AND parallel.deadline_at <= COALESCE(run.virtual_now, clock_timestamp()) AS past
                       FROM ${this.t.nodes} AS parallel JOIN ${this.t.runs} AS run ON run.run_id = parallel.run_id
                      WHERE parallel.node_execution_id = $1`, [branchScope.parallelNodeExecutionId]);
                if (parents[0] && (str(parents[0], "state") === "completed" || (parents[0].past === true && input.nodeType !== "terminal"))) {
                    return { admitted: false as const, reason: "cut" as const, run };
                }
            }
            let immediate = input.immediate;
            let receive = input.receive ?? null;
            let send = input.send ?? null;
            let request = input.request ?? null;
            // A test run's interception replaces the live record of its agent, send or request state (migration 0102), and
            // every deadline of a test run is counted from its virtual clock.
            const intercept = input.intercept ?? null;
            if (intercept !== null && (run.mode !== "test" || immediate !== null || input.nodeType !== (intercept.operation === "agent" ? "agent" : "messaging"))) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has an invalid test interception.`);
            }
            if (run.mode === "test" && run.virtualNow === null) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Test run ${run.runId} has no virtual clock.`);
            }
            // A test run's agent state is intercepted in agent mode mocked, and has a child (an agent spec) only in agent mode
            // real (design 05; migration 0105).
            if (run.mode === "test" && ((intercept?.operation === "agent" && run.testAgentMode !== "mocked")
                || (input.agent != null && run.testAgentMode !== "real"))) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Agent state ${input.nodeExecutionId} does not match test run ${run.runId}'s agent mode.`);
            }
            // A receive spec belongs to a receive state admitted without an
            // immediate result, and has refusals exactly when it names a sender;
            // a send spec belongs to a send state admitted without one, and a
            // request spec to a request state admitted without one (unless a test run intercepts it).
            if ((receive !== null || send !== null || request !== null) !== (input.nodeType === "messaging" && immediate === null && intercept === null)
                || [receive, send, request].filter(spec => spec !== null).length > 1
                || (receive !== null && (receive.from === null) !== (receive.refused === null))) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has an invalid messaging spec.`);
            }
            if (request !== null && !(Number.isSafeInteger(request.timeoutSeconds) && request.timeoutSeconds >= 1 && request.timeoutSeconds <= WAIT_MAX_SECONDS)) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has an invalid request deadline.`);
            }
            // An agent spec belongs to an agent state admitted without an immediate result; its deadline is a whole number
            // of seconds, and its output contract is the one its state declares in the run's pinned definition.
            const agent = input.agent ?? null;
            if ((agent !== null) !== (input.nodeType === "agent" && immediate === null && intercept === null)
                || (agent !== null && !(Number.isSafeInteger(agent.timeoutSeconds) && agent.timeoutSeconds >= 1 && agent.timeoutSeconds <= WAIT_MAX_SECONDS))
                || (agent !== null && !storableId(agent.childSessionId))) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has an invalid agent spec.`);
            }
            if (agent !== null) {
                const ir = await this.revisionIrIn(client, run.workflowSessionId, run.revision, run.irSha256, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
                const declared = ir.nodes[input.nodeId];
                if (declared?.type !== "agent" || declared.outputSchema !== agent.outputSchema
                    || canonicalJson([...declared.outcomes].sort()) !== canonicalJson([...agent.outcomes].sort())) {
                    throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has an agent spec whose output contract `
                        + `is not the one its state declares.`);
                }
            }
            // A request's record freezes the response schema that its state's contract declares in the run's pinned
            // definition, never another schema of that definition.
            if (request !== null) {
                const ir = await this.revisionIrIn(client, run.workflowSessionId, run.revision, run.irSha256, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
                if (declaredResponseSchema(ir, input.nodeId, request.contract, `Node execution ${input.nodeExecutionId}`) !== request.responseSchema) {
                    throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has a request spec whose response `
                        + `schema ${request.responseSchema} is not the one contract ${request.contract} declares.`);
                }
            }
            // A wait admitted pending has a whole number of seconds; a receive may
            // race a wait (then it has them too); an intercepted agent or request has its deadline's; a parallel state may
            // have its own time limit (IR 9); nothing else has any.
            const waitAt = input.waitAt ?? null;
            const waits = input.nodeType === "wait" && immediate === null;
            const deadlined = intercept !== null && intercept.operation !== "send";
            const mayWait = waits || receive !== null || deadlined || (input.nodeType === "parallel" && immediate === null);
            if ((waitAt !== null && (!waits || input.waitSeconds !== null))
                || (((waits && waitAt === null) || deadlined) && input.waitSeconds === null) || (!mayWait && input.waitSeconds !== null)
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
            // An agent state admitted pending has its outer deadline as a wait has.
            if (agent !== null) waitSeconds = agent.timeoutSeconds;
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
            // Stage 2.4: a clock wait's deadline, decided once from the accepted-entry reading (a test run's virtual clock):
            // the next time its schedule names after it, DST-safe.
            let clockDeadline: string | null = null;
            if (waitAt !== null && result === null) {
                let base: string;
                if (run.mode === "test" && run.virtualNow !== null) base = run.virtualNow.toISOString();
                else {
                    const { rows: clock } = await client.query(`SELECT clock_timestamp()::text AS at`);
                    decidedAt = str(clock[0], "at");
                    base = decidedAt;
                }
                const baseMs = Date.parse(base);
                if (!Number.isFinite(baseMs)) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `The store's clock reading ${base} could not be read.`);
                clockDeadline = new Date(computeCronAtNextFire(waitAt, baseMs).nextFireAtMs).toISOString();
            }
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
                         COALESCE($24::timestamptz, COALESCE($23::timestamptz, (SELECT at FROM accepted)) + $18::integer * interval '1 second'), $19, $20, $21)
                 RETURNING *`,
                [input.nodeExecutionId, input.runId, input.scopeId, input.nodeId, input.ordinal, input.nodeType, input.predecessorId,
                    input.arrivalRoute, input.inputText, inputSha256, result ? "completed" : "pending",
                    result?.outcome ?? null, result?.resultKind ?? null,
                    result?.resultKind === "business" ? storedResultText(result) : null,
                    result?.resultKind === "runtime_error" ? storedResultText(result) : null,
                    result?.winner ?? null, input.kvRevision, claim ? null : waitSeconds,
                    receive?.contract ?? null, receive?.from ?? null, receive?.correlationText ?? null, decidedAt,
                    run.mode === "test" && run.virtualNow !== null ? run.virtualNow.toISOString() : null, clockDeadline],
            );
            const node = nodeFrom(rows[0]);
            // A test run's intercepted effect: its record, awaiting the parent, at the run's virtual time.
            if (intercept !== null && node.state === "pending") {
                await client.query(
                    `INSERT INTO ${this.t.testInterceptions}
                        (interception_id, run_id, node_execution_id, operation, tool, arguments, arguments_sha256, response_schema, state, virtual_at, created_at)
                     SELECT $1, $2, $3, $4, NULL, $5, $6, $7, 'awaiting_parent', virtual_now, clock_timestamp() FROM ${this.t.runs} WHERE run_id = $2`,
                    [workflowTestInterceptionId(node.nodeExecutionId, intercept.operation), input.runId, node.nodeExecutionId, intercept.operation,
                        intercept.argumentsText, sha256Hex(intercept.argumentsText), intercept.responseSchema]);
            }
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
            // An agent state admitted pending: its invocation record, with the node's deadline and entry time, before any spawn.
            if (agent !== null) {
                const { rows: recorded } = await client.query(
                    `INSERT INTO ${this.t.agentInvocations}
                        (node_execution_id, run_id, workflow_session_id, child_session_id, controlling_session_id, task, outcomes, output_schema,
                         deadline_at, created_at)
                     SELECT $1, $2, $3, $4, $5, $6, $7, $8, deadline_at, entered_at FROM ${this.t.nodes}
                      WHERE node_execution_id = $1 AND deadline_at IS NOT NULL RETURNING node_execution_id`,
                    [node.nodeExecutionId, input.runId, workflowSessionId, agent.childSessionId, agent.controllingSessionId,
                        canonicalJson(agent.task), canonicalJson(agent.outcomes), agent.outputSchema]);
                if (!recorded[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Agent state ${node.nodeExecutionId} was admitted without its deadline.`);
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

    // ─── Read pages (design 04 read_workflow "bounded history pagination"; R01) ───
    //
    // Each page lists a run's rows newest first in one stable order (an immutable key, then a unique id, so rows written
    // at the same instant keep their order). A page starts strictly after the last row of the previous page (its exact
    // key), so no row is listed twice. The pages are separate reads, not one snapshot: over a stable result set (no row
    // added below a position already passed, none removed) following them lists each row exactly once. A row committed
    // later is listed by a later read (one whose key sorts below a position already passed, because its transaction read
    // the clock or took its sequence earlier, by a new pass only). Each page reads at most `limit + 1` rows (the extra one
    // only says whether more follow). Open rows (still running or still waiting) are read apart, at most `limit + 1`, so
    // a run's current state is listed on every read whatever the pages passed.

    /** One page of a run's node executions, newest first by entry time, then by id; with each one's exact entry time. */
    async pageNodeExecutions(runId: string, limit: number, after: { enteredAt: string; nodeExecutionId: string } | null)
        : Promise<{ rows: Array<{ node: WorkflowNodeExecutionRow; enteredAt: string }>; more: boolean }> {
        const { rows } = await this.pool.query(
            `SELECT *, ${isoUtc("entered_at")} AS entered_at_key FROM ${this.t.nodes}
              WHERE run_id = $1 AND ($2::timestamptz IS NULL OR (entered_at, node_execution_id) < ($2::timestamptz, $3::text))
              ORDER BY entered_at DESC, node_execution_id DESC LIMIT $4`,
            [runId, after?.enteredAt ?? null, after?.nodeExecutionId ?? null, limit + 1]);
        return { rows: rows.slice(0, limit).map(row => ({ node: nodeFrom(row), enteredAt: str(row, "entered_at_key") })), more: rows.length > limit };
    }

    /** A run's node executions still pending (its current states, however long ago they were entered), oldest first. */
    async listOpenNodeExecutions(runId: string, limit: number): Promise<{ rows: WorkflowNodeExecutionRow[]; more: boolean }> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.nodes} WHERE run_id = $1 AND state = 'pending' ORDER BY entered_at, node_execution_id LIMIT $2`, [runId, limit + 1]);
        return { rows: rows.slice(0, limit).map(nodeFrom), more: rows.length > limit };
    }

    /** The node executions of a run among `nodeExecutionIds` (as many as the ids given; unknown ids are left out). */
    async listNodeExecutionsByIds(runId: string, nodeExecutionIds: readonly string[]): Promise<WorkflowNodeExecutionRow[]> {
        if (nodeExecutionIds.length === 0) return [];
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.nodes} WHERE run_id = $1 AND node_execution_id = ANY($2::text[])`, [runId, [...new Set(nodeExecutionIds)]]);
        return rows.map(nodeFrom);
    }

    /** One page of a run's typed input inbox, newest first by its sequence. */
    async pageInbox(runId: string, limit: number, afterSeq: string | null): Promise<{ rows: WorkflowInboxMessage[]; more: boolean }> {
        const { rows } = await this.pool.query(
            `SELECT ${INBOX_COLUMNS} FROM ${this.t.inbox} WHERE run_id = $1 AND ($2::bigint IS NULL OR seq < $2::bigint) ORDER BY seq DESC LIMIT $3`,
            [runId, afterSeq, limit + 1]);
        return { rows: rows.slice(0, limit).map(inboxFrom), more: rows.length > limit };
    }

    /** A run's typed input that no receive state has taken and that has not expired (its current input), oldest first. */
    async listOpenInbox(runId: string, limit: number): Promise<{ rows: WorkflowInboxMessage[]; more: boolean }> {
        const { rows } = await this.pool.query(
            `SELECT ${INBOX_COLUMNS} FROM ${this.t.inbox} WHERE run_id = $1 AND consumed_by IS NULL AND expires_at > now() ORDER BY seq LIMIT $2`,
            [runId, limit + 1]);
        return { rows: rows.slice(0, limit).map(inboxFrom), more: rows.length > limit };
    }

    /** One page of a run's sent messages, newest first by creation time, then by exchange id. */
    async pageOutbox(runId: string, limit: number, after: { createdAt: string; exchangeId: string } | null)
        : Promise<{ rows: WorkflowOutboxMessage[]; more: boolean }> {
        const { rows } = await this.pool.query(
            `SELECT ${OUTBOX_COLUMNS} FROM ${this.t.outbox}
              WHERE run_id = $1 AND ($2::timestamptz IS NULL OR (created_at, exchange_id) < ($2::timestamptz, $3::text))
              ORDER BY created_at DESC, exchange_id DESC LIMIT $4`,
            [runId, after?.createdAt ?? null, after?.exchangeId ?? null, limit + 1]);
        return { rows: rows.slice(0, limit).map(outboxFrom), more: rows.length > limit };
    }

    /** A run's sent messages whose delivery is still pending, oldest first. */
    async listOpenOutbox(runId: string, limit: number): Promise<{ rows: WorkflowOutboxMessage[]; more: boolean }> {
        const { rows } = await this.pool.query(
            `SELECT ${OUTBOX_COLUMNS} FROM ${this.t.outbox} WHERE run_id = $1 AND state = 'pending' ORDER BY created_at, exchange_id LIMIT $2`,
            [runId, limit + 1]);
        return { rows: rows.slice(0, limit).map(outboxFrom), more: rows.length > limit };
    }

    /** One page of a test run's intercepted effects, newest first by the order they were reached. */
    async pageInterceptions(runId: string, limit: number, afterSeq: string | null): Promise<{ rows: WorkflowTestInterception[]; more: boolean }> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.testInterceptions} WHERE run_id = $1 AND ($2::bigint IS NULL OR seq < $2::bigint) ORDER BY seq DESC LIMIT $3`,
            [runId, afterSeq, limit + 1]);
        return { rows: rows.slice(0, limit).map(interceptionFrom), more: rows.length > limit };
    }

    /** A test run's intercepted effects that still wait for an answer, oldest first. */
    async listOpenInterceptions(runId: string, limit: number): Promise<{ rows: WorkflowTestInterception[]; more: boolean }> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.testInterceptions} WHERE run_id = $1 AND state = 'awaiting_parent' ORDER BY seq LIMIT $2`, [runId, limit + 1]);
        return { rows: rows.slice(0, limit).map(interceptionFrom), more: rows.length > limit };
    }

    /**
     * A test run's coverage over all its node executions (design 05; bounded by its graph, not by its history): the
     * states it entered, each route taken (from the predecessor's state, by its label, to the state) with how often, and
     * each state's outcomes.
     */
    async testCoverage(runId: string): Promise<{ entered: string[]; routes: Array<{ from: string; route: string; to: string; count: number }>;
        outcomes: Array<{ stateId: string; outcome: string }> }> {
        const [entered, routes, outcomes] = await Promise.all([
            this.pool.query(`SELECT DISTINCT node_id FROM ${this.t.nodes} WHERE run_id = $1`, [runId]),
            this.pool.query(
                `SELECT p.node_id AS from_id, n.arrival_route AS route, n.node_id AS to_id, count(*)::int AS n
                   FROM ${this.t.nodes} n JOIN ${this.t.nodes} p ON p.node_execution_id = n.predecessor_id AND p.run_id = n.run_id
                  WHERE n.run_id = $1 AND n.arrival_route IS NOT NULL GROUP BY p.node_id, n.arrival_route, n.node_id`, [runId]),
            this.pool.query(`SELECT DISTINCT node_id, outcome FROM ${this.t.nodes} WHERE run_id = $1 AND outcome IS NOT NULL`, [runId]),
        ]);
        return {
            entered: entered.rows.map(row => str(row, "node_id")),
            routes: routes.rows.map(row => ({ from: str(row, "from_id"), route: str(row, "route"), to: str(row, "to_id"), count: int(row, "n") })),
            outcomes: outcomes.rows.map(row => ({ stateId: str(row, "node_id"), outcome: str(row, "outcome") })),
        };
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

    /**
     * Whether a run has work that still awaits its result: a pending node execution other than a parallel state's own
     * (IR 8), which waits on its branches' node executions and is not work.
     */
    async hasPendingNodes(runId: string): Promise<boolean> {
        const { rows } = await this.pool.query(
            `SELECT EXISTS (SELECT 1 FROM ${this.t.nodes} WHERE run_id = $1 AND state = 'pending' AND node_type <> 'parallel') AS pending`, [runId]);
        return rows[0]?.pending === true;
    }

    /** Whether a node execution still awaits its result (a running script's liveness check). */
    async isNodePending(nodeExecutionId: string): Promise<boolean> {
        const { rows } = await this.pool.query(`SELECT state FROM ${this.t.nodes} WHERE node_execution_id = $1`, [nodeExecutionId]);
        return rows[0]?.state === "pending";
    }

    /**
     * The single terminal compare-and-swap for a node execution. Returns the
     * stored winner: this result when it won, otherwise the earlier one. Its
     * completed_at is the store's clock read after the session lock (not the
     * transaction's start), so the results of one workflow are stamped in the
     * order they commit: a parallel state's join of the first k and its time
     * limit read that order (IR 9; owner decision join-k-of-n, J1b).
     */
    async completeNode(nodeExecutionId: string, result: NodeResultInput, projection?: SessionProjection): Promise<{ won: boolean; node: WorkflowNodeExecutionRow }> {
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfNode(client, nodeExecutionId));
            const { rows } = live ? await client.query(
                `UPDATE ${this.t.nodes}
                    SET state = 'completed', outcome = $2, result_kind = $3,
                        output = CASE WHEN $3 = 'business' THEN $4 END,
                        error = CASE WHEN $3 = 'runtime_error' THEN $4 END,
                        winner = $5, completed_at = clock_timestamp()
                  WHERE node_execution_id = $1 AND state = 'pending'
                  RETURNING *`,
                [nodeExecutionId, result.outcome, result.resultKind, storedResultText(result), result.winner],
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
                      WHERE node_execution_id = $1 AND state = 'pending' AND (node_type = 'wait' OR (node_type = 'messaging' AND receive_contract IS NOT NULL))
                        AND deadline_at <= (SELECT at FROM decided)
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
            // The deletion that made the session not live also decided its pending work (migration 0090 trigger).
            if (node.state === "completed" || !live) return { result: "decided" as const, node };
            // A request's deadline is elapsed only by elapseRequest (its outcome is timed_out, never elapsed).
            if ((node.nodeType !== "wait" && (node.nodeType !== "messaging" || node.receive === null)) || node.deadlineAt === null) {
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
    /**
     * The node executions of a run decided by a cancel (winner `cancel`), or by another such end (a stop's: `stop`; a
     * parallel state's failFast cancellation of its other branches: `fail_fast`).
     */
    async listCancelledNodeIds(runId: string, winner: CancelledNodeWinner | readonly CancelledNodeWinner[] = "cancel"): Promise<string[]> {
        const winners = typeof winner === "string" ? [winner] : [...winner];
        const { rows } = await this.pool.query(
            `SELECT node_execution_id FROM ${this.t.nodes} WHERE run_id = $1 AND winner = ANY($2::text[]) ORDER BY node_execution_id`, [runId, winners]);
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

    /**
     * The intake outcomes of the run's outbox messages `exchangeIds` that have
     * one, by exchange id (migration 0098; design 5.6): the recipient's intake
     * refused the message after its delivery was recorded. Only the messages
     * named are read (the caller names the bounded page it shows), and none
     * when none are named. Read apart from the message, whose state,
     * attempts and receipt stay as the delivery recorded them.
     */
    async listOutboxIntakeOutcomes(runId: string, exchangeIds: readonly string[])
        : Promise<Map<string, { intakeOutcome: WorkflowIntakeRefusal; intakeOutcomeAt: string }>> {
        const outcomes = new Map<string, { intakeOutcome: WorkflowIntakeRefusal; intakeOutcomeAt: string }>();
        if (exchangeIds.length === 0) return outcomes;
        const { rows } = await this.pool.query(
            `SELECT exchange_id, intake_outcome, ${isoUtc("intake_outcome_at")} AS intake_outcome_at_iso FROM ${this.t.outbox}
              WHERE run_id = $1 AND exchange_id = ANY($2::text[]) AND intake_outcome IS NOT NULL`, [runId, [...exchangeIds]]);
        for (const row of rows) {
            const outcome = str(row, "intake_outcome");
            if (outcome !== "refused_full" && outcome !== "refused_size") return corrupt(`Unknown intake outcome ${outcome}.`);
            outcomes.set(str(row, "exchange_id"), { intakeOutcome: outcome, intakeOutcomeAt: str(row, "intake_outcome_at_iso") });
        }
        return outcomes;
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
     *    another; a closed one is REQUEST_CLOSED with its status. Expiry is
     *    durable: once an operation of the pending request is bound expired,
     *    every later new operation is REQUEST_EXPIRED too, whatever its own
     *    reading, because clock_timestamp() can step back. Every expired
     *    binding is written under this node lock, so the first one is the
     *    request's expiry point, and the decision window is not reopened.
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
            const ir = await this.revisionIrIn(client, run.workflowSessionId, run.revision, run.irSha256, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
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
                // In time: the one reading is before the deadline, and no earlier operation found the request expired (durable
                // expiry, step 7: the store's clock is not monotonic).
                const { rows: early } = await client.query(
                    `SELECT $1::timestamptz < deadline_at
                            AND NOT EXISTS (SELECT 1 FROM ${this.t.requestOperations} WHERE exchange_id = $2 AND outcome = 'expired') AS in_time
                       FROM ${this.t.requests} WHERE exchange_id = $2`, [at, request.exchangeId]);
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

    // ─── Request runtime: deadline, observation, delivery and wakes (controller 1.9.0) ──

    /**
     * Elapse a pending request (design workflow-messaging-request.md 4.3;
     * decision request-durable-expiry-semantics): the deadline's terminal
     * compare-and-swap, the only producer of timed_out (`result`, a runtime
     * error the controller decides). Under the requester's session lock
     * (FOR NO KEY UPDATE, which every producer that decides a request takes
     * first), then the node's: one reading of the store's clock decides, and
     * is stored as the node's completed_at. The request elapses when that
     * reading is at or after its deadline, or when an operation of it was
     * already bound expired (durable expiry: the clock can step back, and a
     * committed expired binding is the request's expiry point). Otherwise it
     * changes nothing and reports the milliseconds left (at least 1). A result
     * stored first, and a deleted requester's (whose deletion decided it), is
     * kept ("decided").
     */
    async elapseRequest(nodeExecutionId: string, result: NodeResultInput, projection?: SessionProjection): Promise<
        { result: "elapsed" | "decided"; node: WorkflowNodeExecutionRow } | { result: "not_due"; remainingMs: number; node: WorkflowNodeExecutionRow }> {
        if (result.resultKind !== "runtime_error" || result.outcome !== "timed_out" || result.winner !== "controller") {
            throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Request ${nodeExecutionId} elapses only as timed_out, decided by the controller.`);
        }
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfNode(client, nodeExecutionId));
            const { rows: requests } = await client.query(`SELECT exchange_id FROM ${this.t.requests} WHERE exchange_id = $1`, [nodeExecutionId]);
            if (!requests[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${nodeExecutionId} is not a request.`);
            if (live) {
                const { rows } = await client.query(
                    `WITH decided AS (SELECT clock_timestamp() AS at)
                     UPDATE ${this.t.nodes}
                        SET state = 'completed', outcome = $2, result_kind = 'runtime_error', output = NULL, error = $3,
                            winner = 'controller', completed_at = (SELECT at FROM decided)
                      WHERE node_execution_id = $1 AND state = 'pending' AND node_type = 'messaging'
                        AND (deadline_at <= (SELECT at FROM decided)
                             OR EXISTS (SELECT 1 FROM ${this.t.requestOperations} WHERE exchange_id = $1 AND outcome = 'expired'))
                      RETURNING *`,
                    [nodeExecutionId, result.outcome, storedResultText(result)]);
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
            if (node.state === "completed" || !live) return { result: "decided" as const, node };
            if (node.nodeType !== "messaging" || node.deadlineAt === null) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Request ${nodeExecutionId} is not pending with a deadline.`);
            }
            return { result: "not_due" as const, remainingMs: int(rows[0], "remaining_ms"), node };
        });
    }

    /**
     * Observe a pending request's responder (design 4.4; decision
     * request-durable-expiry-semantics), as the controller does once per
     * backstop period while the request waits. Under the session locks a
     * response takes (lockSessionPair: the requester's row FOR NO KEY UPDATE,
     * the responder's FOR SHARE, in ascending session id), then the node's,
     * the responder is decided on the rows as they are now: missing or
     * deleted fails the request unavailable, no longer allowed by the
     * typed-input rule fails it forbidden, and `ended` (its session
     * orchestration found in a terminal status by the caller just before)
     * fails it with that result. One reading of the store's clock decides,
     * and only while it is before the deadline and no operation was bound
     * expired: at or after either, only the elapse decides ("expired"). A
     * result stored first, and a deleted requester's, are kept ("decided");
     * a live, allowed responder changes nothing ("live").
     */
    async observeRequestResponder(nodeExecutionId: string, results: {
        refused: SendSpecInput["refused"];
        ended: { result: NodeResultInput; projection?: SessionProjection } | null;
    }): Promise<{ result: "failed" | "decided" | "live" | "expired"; node: WorkflowNodeExecutionRow }> {
        return this.transaction(async client => {
            const { rows: found } = await client.query(`SELECT ${REQUEST_COLUMNS} FROM ${this.t.requests} WHERE exchange_id = $1`, [nodeExecutionId]);
            if (!found[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${nodeExecutionId} is not a request.`);
            const request = requestFrom(found[0]);
            const locked = await this.lockSessionPair(client, request.workflowSessionId, request.responderSessionId);
            const { rows: nodes } = await client.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            if (!nodes[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Request ${nodeExecutionId} has no node execution.`);
            const node = nodeFrom(nodes[0]);
            if (locked.workflow === null || locked.workflow.deleted || node.state !== "pending") return { result: "decided" as const, node };
            const authority = decideTypedInputAuthority({
                workflow: locked.workflow, definition: locked.definition, sender: locked.other, senderSessionId: request.responderSessionId,
            });
            const decision = authority !== "allowed" ? results.refused[authority] : results.ended;
            if (decision === null) return { result: "live" as const, node };
            const { result, projection } = decision;
            const { rows: completed } = await client.query(
                `WITH decided AS (SELECT clock_timestamp() AS at)
                 UPDATE ${this.t.nodes}
                    SET state = 'completed', outcome = $2, result_kind = $3,
                        output = CASE WHEN $3 = 'business' THEN $4 END,
                        error = CASE WHEN $3 = 'runtime_error' THEN $4 END,
                        winner = $5, completed_at = (SELECT at FROM decided)
                  WHERE node_execution_id = $1 AND state = 'pending' AND deadline_at > (SELECT at FROM decided)
                    AND NOT EXISTS (SELECT 1 FROM ${this.t.requestOperations} WHERE exchange_id = $1 AND outcome = 'expired')
                  RETURNING *`,
                [nodeExecutionId, result.outcome, result.resultKind, storedResultText(result), result.winner]);
            if (!completed[0]) return { result: "expired" as const, node };
            await this.project(client, projection);
            return { result: "failed" as const, node: nodeFrom(completed[0]) };
        });
    }

    /**
     * Begin one delivery attempt of a request state's request (design 4.4,
     * 8.3, 8.5), in one transaction under the session locks its admission
     * took (lockInputSessions: the requester's and the responder's), in this
     * order: a message no longer pending is returned as stored ("decided");
     * a request decided meanwhile (a response from an earlier attempt's
     * prompt, the deadline, the run's end, a deletion) gets no delivery, and
     * its message fails with the reason ("decided"); the responder is decided
     * again on what this transaction reads: one deleted or no longer allowed
     * fails the request with the refusal it carries, and its message with it
     * ("refused"), as do `ended` (the responder's session orchestration found
     * ended just before) and `unsupported` (the responder found without the
     * response capability: an agent session at the intake version or later
     * whose tools include the response tool); otherwise the attempt is
     * counted and the message returned for delivery ("deliver"). A responder
     * is always an agent session (its admission refuses a workflow).
     */
    async beginRequestDelivery(nodeExecutionId: string, refusals: {
        refused: SendSpecInput["refused"];
        ended: { result: NodeResultInput; projection?: SessionProjection } | null;
        unsupported: { result: NodeResultInput; projection?: SessionProjection } | null;
    }): Promise<{ kind: "decided" | "refused" | "deliver"; node: WorkflowNodeExecutionRow; message: WorkflowOutboxMessage }> {
        return this.transaction(async client => {
            const { rows: found } = await client.query(
                `SELECT workflow_session_id, recipient_session_id FROM ${this.t.outbox} WHERE node_execution_id = $1`, [nodeExecutionId]);
            if (!found[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Node execution ${nodeExecutionId} has no outbox message.`);
            const decided = await this.lockInputSessions(client, str(found[0], "workflow_session_id"), str(found[0], "recipient_session_id"));
            const { rows: nodes } = await client.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            const { rows: messages } = await client.query(
                `SELECT ${OUTBOX_COLUMNS} FROM ${this.t.outbox} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            if (!nodes[0] || !messages[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Node execution ${nodeExecutionId} is missing.`);
            const node = nodeFrom(nodes[0]);
            const message = outboxFrom(messages[0]);
            if (message.mode !== "request" || message.recipientKind !== "agent") {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${nodeExecutionId} is not a request to an agent session.`);
            }
            if (message.state !== "pending") return { kind: "decided" as const, node, message };
            if (!decided.live || node.state !== "pending") {
                const { rows: abandoned } = await client.query(
                    `UPDATE ${this.t.outbox} SET state = 'failed', decided_at = clock_timestamp(), error = $2
                      WHERE node_execution_id = $1 AND state = 'pending' RETURNING ${OUTBOX_COLUMNS}`,
                    [nodeExecutionId, undeliveredErrorText(node.outcome, message.attempts)]);
                return { kind: "decided" as const, node, message: abandoned[0] ? outboxFrom(abandoned[0]) : message };
            }
            const responder = await this.recipientDecision(client, decided.authority, message.recipientSessionId);
            if (responder.refusal === null && responder.kind !== "agent") {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Request ${nodeExecutionId} has a workflow responder.`);
            }
            const refused = responder.refusal !== null ? refusals.refused[responder.refusal] : refusals.ended ?? refusals.unsupported;
            if (refused !== null) {
                const { result, projection } = refused;
                const { rows: completed } = await client.query(
                    `UPDATE ${this.t.nodes}
                        SET state = 'completed', outcome = $2, result_kind = $3,
                            output = CASE WHEN $3 = 'business' THEN $4 END,
                            error = CASE WHEN $3 = 'runtime_error' THEN $4 END,
                            winner = $5, completed_at = clock_timestamp()
                      WHERE node_execution_id = $1 AND state = 'pending' RETURNING *`,
                    [nodeExecutionId, result.outcome, result.resultKind, storedResultText(result), result.winner]);
                const { rows: failed } = await client.query(
                    `UPDATE ${this.t.outbox} SET state = 'failed', decided_at = clock_timestamp(), error = $2
                      WHERE node_execution_id = $1 AND state = 'pending' RETURNING ${OUTBOX_COLUMNS}`,
                    [nodeExecutionId, storedResultText(result)]);
                if (!completed[0] || !failed[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Request ${nodeExecutionId} changed under its locks.`);
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
     * Record a request's delivery that its responder's session queue
     * accepted, under the requester's session lock: the message from pending
     * to delivered with its receipt, and the projection's events. The request
     * stays pending: only a response, its deadline, an observation, its
     * delivery's failure or the run's end decides it. A response may have
     * decided it first (it reached the responder through an earlier attempt);
     * the record then marks only the message. A message no longer pending is
     * returned as stored: a repeat after this commit records nothing again.
     */
    async recordRequestDelivery(nodeExecutionId: string, delivery: { stateId: string; clientMessageId: string },
        projection: (receipt: WorkflowSendReceipt) => SessionProjection)
        : Promise<{ recorded: boolean; node: WorkflowNodeExecutionRow; message: WorkflowOutboxMessage }> {
        return this.transaction(async client => {
            const workflowSessionId = await this.workflowOfNode(client, nodeExecutionId);
            const live = await this.lockLiveSession(client, workflowSessionId);
            const { rows: messages } = await client.query(
                `SELECT ${OUTBOX_COLUMNS} FROM ${this.t.outbox} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            if (!messages[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Node execution ${nodeExecutionId} has no outbox message.`);
            const message = outboxFrom(messages[0]);
            if (message.mode !== "request" || message.recipientKind !== "agent") {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${nodeExecutionId} is not a request to an agent session.`);
            }
            if (message.state !== "pending") return { recorded: false, node: await this.nodeIn(client, nodeExecutionId), message };
            const { rows: clock } = await client.query(`WITH c AS (SELECT clock_timestamp() AS at) SELECT at::text AS at, ${isoUtc("at")} AS iso FROM c`);
            const receipt: WorkflowSendReceipt = {
                exchangeId: message.exchangeId, workflowSessionId, runId: message.runId, nodeExecutionId, stateId: delivery.stateId,
                recipientSessionId: message.recipientSessionId, recipientKind: "agent", contract: message.contract,
                payloadSha256: message.payloadSha256, clientMessageId: delivery.clientMessageId, input: null,
                attempts: Math.max(message.attempts, 1), deliveredAt: str(clock[0], "iso"),
            };
            const { rows: delivered } = await client.query(
                `UPDATE ${this.t.outbox} SET state = 'delivered', decided_at = $2::timestamptz, receipt = $3
                  WHERE node_execution_id = $1 AND state = 'pending' RETURNING ${OUTBOX_COLUMNS}`,
                [nodeExecutionId, str(clock[0], "at"), canonicalJson(receipt)]);
            if (!delivered[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Request ${nodeExecutionId} changed under its locks.`);
            if (live) await this.project(client, projection(receipt));
            return { recorded: true, node: await this.nodeIn(client, nodeExecutionId), message: outboxFrom(delivered[0]) };
        });
    }

    /**
     * No delivery of a request will be recorded by its delivery
     * orchestration (its attempts ran out, the worker delivers nothing, or
     * the orchestration ended without recording one), under the requester's
     * session lock: the message from pending to failed, and the request from
     * pending to the given runtime error (delivery_failed). A delivery
     * recorded first keeps the message, and a request decided first (a
     * response, its deadline, an observation, the run's end) keeps its
     * result.
     */
    async failRequestDelivery(nodeExecutionId: string, result: NodeResultInput, projection?: SessionProjection)
        : Promise<{ won: boolean; node: WorkflowNodeExecutionRow; message: WorkflowOutboxMessage }> {
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfNode(client, nodeExecutionId));
            const { rows: pendingRows } = await client.query(
                `SELECT ${OUTBOX_COLUMNS} FROM ${this.t.outbox} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            if (!pendingRows[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Node execution ${nodeExecutionId} has no outbox message.`);
            const pending = outboxFrom(pendingRows[0]);
            if (pending.mode !== "request") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${nodeExecutionId} is not a request.`);
            const { rows: failed } = await client.query(
                `UPDATE ${this.t.outbox} SET state = 'failed', decided_at = clock_timestamp(), error = $2
                  WHERE node_execution_id = $1 AND state = 'pending' RETURNING ${OUTBOX_COLUMNS}`, [nodeExecutionId, storedResultText(result)]);
            const { rows: completed } = live && failed[0] ? await client.query(
                `UPDATE ${this.t.nodes}
                    SET state = 'completed', outcome = $2, result_kind = $3,
                        output = CASE WHEN $3 = 'business' THEN $4 END,
                        error = CASE WHEN $3 = 'runtime_error' THEN $4 END,
                        winner = $5, completed_at = clock_timestamp()
                  WHERE node_execution_id = $1 AND state = 'pending' RETURNING *`,
                [nodeExecutionId, result.outcome, result.resultKind, storedResultText(result), result.winner]) : { rows: [] };
            if (completed[0]) await this.project(client, projection);
            const node = completed[0] ? nodeFrom(completed[0]) : await this.nodeIn(client, nodeExecutionId);
            return { won: Boolean(completed[0]), node, message: failed[0] ? outboxFrom(failed[0]) : pending };
        });
    }

    /**
     * Lease due response wakes (design 5): one statement locks up to `limit`
     * due rows (FOR UPDATE SKIP LOCKED) with fewer than
     * WORKFLOW_V2_WAKE_MAX_ATTEMPTS attempts, and sets each leased with a new
     * random token, one more attempt and a lease that ends
     * WORKFLOW_V2_WAKE_LEASE_MS after its reading. A row is due when it is
     * pending with its next attempt at or before the reading, or leased with
     * its lease ended (an expired holder). `exchangeId` leases that one row
     * only (the responding worker's immediate try). Leasing touches no
     * session.
     */
    async leaseResponseWakes(input: { limit: number; exchangeId?: string })
        : Promise<Array<{ exchangeId: string; runId: string; controllerInstanceId: string; leaseToken: string; attempts: number }>> {
        const limit = Math.max(1, Math.min(input.limit, 100));
        const { rows } = await this.pool.query(
            `WITH lease_reading AS (SELECT clock_timestamp() AS at),
                  due AS (
                    SELECT exchange_id FROM ${this.t.responseWakes}
                     WHERE attempts < $1 AND ($3::text IS NULL OR exchange_id = $3)
                       AND ((state = 'pending' AND next_attempt_at <= (SELECT at FROM lease_reading))
                            OR (state = 'leased' AND lease_until <= (SELECT at FROM lease_reading)))
                     ORDER BY next_attempt_at, exchange_id
                     LIMIT $2 FOR UPDATE SKIP LOCKED)
             UPDATE ${this.t.responseWakes} wake
                SET state = 'leased', lease_token = gen_random_uuid()::text, attempts = wake.attempts + 1,
                    lease_until = (SELECT at FROM lease_reading) + $4::integer * interval '1 millisecond'
               FROM due WHERE wake.exchange_id = due.exchange_id
             RETURNING wake.exchange_id, wake.run_id, wake.controller_instance_id, wake.lease_token, wake.attempts`,
            [WORKFLOW_V2_WAKE_MAX_ATTEMPTS, limit, input.exchangeId ?? null, WORKFLOW_V2_WAKE_LEASE_MS]);
        return rows.map(row => ({
            exchangeId: str(row, "exchange_id"), runId: str(row, "run_id"), controllerInstanceId: str(row, "controller_instance_id"),
            leaseToken: str(row, "lease_token"), attempts: int(row, "attempts"),
        }));
    }

    /**
     * Settle one leased response wake (design 5), by its holder only: every
     * update has the condition exchange_id, lease_token and state leased, so
     * a stale holder (its lease reclaimed, or the row settled) changes
     * nothing (`settled` false). `dispatched`: the enqueue of the wake on the
     * controller's command queue returned. `moot`: a successful read found the
     * run ended or the controller in a terminal status. `retry`: the enqueue
     * failed, or the lifecycle read failed or knew nothing (a missing instance
     * included); the row is pending again with its next attempt after a
     * backoff of 1 s doubling to 60 s, and the error kept (at most 1,000
     * characters). A settled row never changes.
     */
    async settleResponseWake(exchangeId: string, leaseToken: string, outcome: { kind: "dispatched" | "moot" } | { kind: "retry"; error: string })
        : Promise<{ settled: boolean }> {
        if (outcome.kind === "retry") {
            const { rowCount } = await this.pool.query(
                `UPDATE ${this.t.responseWakes}
                    SET state = 'pending', lease_token = NULL, lease_until = NULL, last_error = $3,
                        next_attempt_at = clock_timestamp() + LEAST(60000, 1000 * power(2, GREATEST(attempts - 1, 0)))::integer * interval '1 millisecond'
                  WHERE exchange_id = $1 AND lease_token = $2 AND state = 'leased'`,
                // E2bH-SF6-1: the enqueue's error is kept with its secrets hidden.
                [exchangeId, leaseToken, jsonbSafeText(redactWorkflowSecrets(outcome.error), 1_000)]);
            return { settled: (rowCount ?? 0) > 0 };
        }
        const { rowCount } = await this.pool.query(
            `UPDATE ${this.t.responseWakes}
                SET state = $3, lease_token = NULL, lease_until = NULL, settled_at = clock_timestamp()
              WHERE exchange_id = $1 AND lease_token = $2 AND state = 'leased'`,
            [exchangeId, leaseToken, outcome.kind]);
        return { settled: (rowCount ?? 0) > 0 };
    }

    /**
     * Abandon the due response wakes that used every attempt (design 5;
     * decision request-durable-expiry-semantics F3: the dispatch was not
     * confirmed within the attempt budget, which does not mean no hint
     * reached the controller). Each in its own transaction, in the
     * source-before-wake order: the requester's session row FOR NO KEY
     * UPDATE, then the wake row FOR UPDATE with the condition that it is
     * still unsettled with every attempt used; then abandoned and settled,
     * and, only for a live requester, one workflow.response_wake_abandoned
     * event on it. A deleted requester gets no event and no session touch. No
     * other path abandons a wake, so there is at most one event. The
     * response stays accepted, and the controller's backstop still collects
     * its node.
     */
    async abandonResponseWakes(limit: number): Promise<string[]> {
        const { rows: candidates } = await this.pool.query(
            `SELECT wake.exchange_id, request.workflow_session_id FROM ${this.t.responseWakes} wake
               JOIN ${this.t.requests} request ON request.exchange_id = wake.exchange_id
              WHERE wake.attempts >= $1
                AND ((wake.state = 'pending' AND wake.next_attempt_at <= clock_timestamp())
                     OR (wake.state = 'leased' AND wake.lease_until <= clock_timestamp()))
              ORDER BY wake.next_attempt_at, wake.exchange_id LIMIT $2`,
            [WORKFLOW_V2_WAKE_MAX_ATTEMPTS, Math.max(1, Math.min(limit, 100))]);
        const abandoned: string[] = [];
        for (const candidate of candidates) {
            const exchangeId = str(candidate, "exchange_id");
            const done = await this.transaction(async client => {
                const live = await this.lockLiveSession(client, str(candidate, "workflow_session_id"));
                const { rows } = await client.query(
                    `UPDATE ${this.t.responseWakes}
                        SET state = 'abandoned', lease_token = NULL, lease_until = NULL, settled_at = clock_timestamp()
                      WHERE exchange_id = $1 AND attempts >= $2 AND state IN ('pending', 'leased')
                        AND ((state = 'pending' AND next_attempt_at <= clock_timestamp()) OR (state = 'leased' AND lease_until <= clock_timestamp()))
                      RETURNING run_id, attempts, last_error`,
                    [exchangeId, WORKFLOW_V2_WAKE_MAX_ATTEMPTS]);
                if (!rows[0]) return false;
                if (live) {
                    await this.project(client, { sessionId: str(candidate, "workflow_session_id"), events: [{ eventType: "workflow.response_wake_abandoned", data: {
                        runId: str(rows[0], "run_id"), exchangeId, attempts: int(rows[0], "attempts"), lastError: strOrNull(rows[0], "last_error"),
                        note: "The wake's dispatch was not confirmed within its attempts; the response stands, and the run's backstop collects it.",
                    } }] });
                }
                return true;
            });
            if (done) abandoned.push(exchangeId);
        }
        return abandoned;
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
     *
     * Durable recipient intake (design workflow-durable-intake.md section
     * 4): an intake-capable caller passes `intake`, and the count is one
     * statement that also decides the message's intake mode on its first
     * count: `durable` with a new attempt token when `intake.durable` (the
     * deployment capability is on and the recipient was observed at 1.0.83
     * or later), otherwise `legacy_window`; a mode is never decided later,
     * and every count of a durable message sets a new token, whatever
     * `intake.durable` says now. `durable` in the answer says the copies of
     * this attempt carry the intake envelope. Without `intake` the count is
     * the one a build without the intake makes: it leaves the mode unset,
     * and the outbox's fence refuses it on a durable message.
     */
    async beginDelivery(nodeExecutionId: string, refusals: {
        refused: SendSpecInput["refused"];
        ended: { result: NodeResultInput; projection?: SessionProjection } | null;
        /** How a workflow recipient's earlier acceptance is recorded (as recordDelivery records a delivery). */
        delivered: { stateId: string; projection: (receipt: WorkflowSendReceipt) => SessionProjection };
    }, intake?: { durable: boolean; attemptToken: string })
        : Promise<{ kind: "decided" | "delivered" | "refused" | "deliver"; node: WorkflowNodeExecutionRow; message: WorkflowOutboxMessage; durable?: boolean }> {
        const attemptToken = intake === undefined ? null : intakeId(intake.attemptToken, "attemptToken");
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
                            winner = $5, completed_at = clock_timestamp()
                      WHERE node_execution_id = $1 AND state = 'pending' RETURNING *`,
                    [nodeExecutionId, result.outcome, result.resultKind, storedResultText(result), result.winner]);
                const { rows: failed } = await client.query(
                    `UPDATE ${this.t.outbox} SET state = 'failed', decided_at = clock_timestamp(), error = $2
                      WHERE node_execution_id = $1 AND state = 'pending' RETURNING ${OUTBOX_COLUMNS}`,
                    [nodeExecutionId, storedResultText(result)]);
                if (!completed[0] || !failed[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Send ${nodeExecutionId} changed under its locks.`);
                await this.project(client, projection);
                return { kind: "refused" as const, node: nodeFrom(completed[0]), message: outboxFrom(failed[0]) };
            }
            if (intake === undefined || attemptToken === null) {
                const { rows: counted } = await client.query(
                    `UPDATE ${this.t.outbox} SET attempts = attempts + 1, last_attempt_at = clock_timestamp()
                      WHERE node_execution_id = $1 RETURNING ${OUTBOX_COLUMNS}`, [nodeExecutionId]);
                return { kind: "deliver" as const, node, message: outboxFrom(counted[0]) };
            }
            const { rows: counted } = await client.query(
                `UPDATE ${this.t.outbox}
                    SET attempts = attempts + 1, last_attempt_at = clock_timestamp(),
                        intake_mode = CASE WHEN attempts = 0 AND intake_mode IS NULL
                                           THEN CASE WHEN $2::boolean THEN 'durable' ELSE 'legacy_window' END
                                           ELSE intake_mode END,
                        attempt_token = CASE WHEN (attempts = 0 AND intake_mode IS NULL AND $2::boolean)
                                                  OR intake_mode IS NOT DISTINCT FROM 'durable'
                                             THEN $3 ELSE attempt_token END
                  WHERE node_execution_id = $1 RETURNING ${OUTBOX_COLUMNS}, intake_mode`, [nodeExecutionId, intake.durable === true, attemptToken]);
            return { kind: "deliver" as const, node, message: outboxFrom(counted[0]), durable: strOrNull(counted[0], "intake_mode") === "durable" };
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
     * as stored: a repeat after this commit records nothing again. A delivery
     * in durable intake mode (`intake`, design workflow-durable-intake.md
     * section 4) is recorded only on a message whose count made it durable,
     * and its receipt says so.
     */
    async recordDelivery(nodeExecutionId: string,
        delivery: { stateId: string; clientMessageId: string | null; input: WorkflowSendInputAcceptance | null; intake?: "durable" },
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
            if (delivery.intake === "durable") {
                // Durable intake (design section 4): only a message its count made durable is delivered so.
                const { rows: modes } = await client.query(`SELECT intake_mode FROM ${this.t.outbox} WHERE node_execution_id = $1`, [nodeExecutionId]);
                if (message.recipientKind !== "agent" || strOrNull(modes[0], "intake_mode") !== "durable") {
                    throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Send ${nodeExecutionId} was delivered in durable intake mode, but its message is not durable.`);
                }
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
                { stateId: delivery.stateId, clientMessageId: delivery.clientMessageId, input, ...(delivery.intake === "durable" ? { intake: "durable" as const } : {}) },
                projection);
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
                  WHERE node_execution_id = $1 AND state = 'pending' RETURNING ${OUTBOX_COLUMNS}`, [nodeExecutionId, storedResultText(result)]);
            const { rows: completed } = live && failed[0] ? await client.query(
                `UPDATE ${this.t.nodes}
                    SET state = 'completed', outcome = $2, result_kind = $3,
                        output = CASE WHEN $3 = 'business' THEN $4 END,
                        error = CASE WHEN $3 = 'runtime_error' THEN $4 END,
                        winner = $5, completed_at = clock_timestamp()
                  WHERE node_execution_id = $1 AND state = 'pending' RETURNING *`,
                [nodeExecutionId, result.outcome, result.resultKind, storedResultText(result), result.winner]) : { rows: [] };
            if (completed[0]) await this.project(client, projection);
            const node = completed[0] ? nodeFrom(completed[0]) : await this.nodeIn(client, nodeExecutionId);
            return { delivered: false, won: Boolean(completed[0]), node, message: failed[0] ? outboxFrom(failed[0]) : pending };
        });
    }

    // ─── Durable recipient intake (migrations 0098 and 0099; called only while the deployment capability is on) ──

    /** One reading of the store's clock, as text that later statements of the transaction read back exactly. */
    private async clockIn(client: PoolClient): Promise<string> {
        const { rows } = await client.query("SELECT clock_timestamp()::text AS at");
        return str(rows[0], "at");
    }

    /**
     * Serialize every write that names an invocation (its binds, its end and
     * its cancels) on the invocation's identity, then read its record as
     * committed: a transaction-scoped advisory lock on the schema and the
     * invocation id, taken before any intake row. The lock exists before the
     * first bind commits the invocation's row, so two first binds of one
     * invocation, and an end or a cancel racing its first bind, wait for each
     * other instead of each finding no invocation; each later statement of
     * the transaction reads what the previous holder committed. Null when the
     * invocation was never bound.
     */
    private async lockIntakeInvocation(client: PoolClient, invocationId: string): Promise<IntakeInvocationRecord | null> {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${this.schema}:workflow-intake-invocation:${invocationId}`]);
        const { rows } = await client.query(
            `SELECT recipient_session_id, members, member_count FROM ${this.t.intakeInvocations} WHERE invocation_id = $1`, [invocationId]);
        return rows[0] ? intakeInvocationFrom(invocationId, rows[0]) : null;
    }

    /**
     * lockIntakeInvocation for a write that needs the invocation bound, and
     * the recipient's; otherwise a broken invariant, named by `exchangeId`
     * (or by the invocation, for an end that names no exchange).
     */
    private async lockBoundIntakeInvocation(client: PoolClient, invocationId: string, recipientSessionId: string, exchangeId: string | null)
        : Promise<IntakeInvocationRecord> {
        const broken = (message: string): never => exchangeId !== null ? intakeBroken(exchangeId, message)
            : corrupt(`Intake invocation ${invocationId}: ${message}`);
        const invocation = await this.lockIntakeInvocation(client, invocationId);
        if (invocation === null) return broken(`invocation ${invocationId} was never bound`);
        if (invocation.recipientSessionId !== recipientSessionId) return broken(`invocation ${invocationId} belongs to another recipient`);
        return invocation;
    }

    /**
     * The invocation's exposure record (migration 0099), read under its lock
     * (only an admission holding that lock inserts one): its attempt id, or
     * null when no admission let an attempt include its items. A record of
     * another recipient, or without a valid attempt id, is corrupt.
     */
    private async intakeExposureIn(client: PoolClient, invocationId: string, recipientSessionId: string): Promise<{ attemptId: string } | null> {
        const { rows } = await client.query(
            `SELECT recipient_session_id, attempt_id FROM ${this.t.intakeExposures} WHERE invocation_id = $1`, [invocationId]);
        if (!rows[0]) return null;
        const attemptId = str(rows[0], "attempt_id");
        if (str(rows[0], "recipient_session_id") !== recipientSessionId || attemptId.length === 0 || attemptId.length > INTAKE_MAX_ID_LENGTH
            || !isStorableText(attemptId)) {
            return corrupt(`Intake invocation ${invocationId}'s exposure record is not its recipient's, or has no valid attempt id.`);
        }
        return { attemptId };
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
     * admission. Under the invocation's lock (lockIntakeInvocation), its
     * first bind stores its complete membership once (each exchange with its
     * claim, in this order) and admits every named row, each holding under its
     * claim, to it with processing bound. A later bind of the invocation is a
     * replay only when it names exactly that membership, in that order, for
     * the same recipient, and every member is still admitted to it; it writes
     * nothing. Anything else (another or a partial membership, a row in
     * another state or invocation, another claim or recipient) is a broken
     * invariant and writes nothing, so an invocation never grows or changes
     * after its first bind. Returns each row's stored text and hash in the
     * membership's order.
     */
    async bindWorkflowIntake(input: { recipientSessionId: string; invocationId: string; items: ReadonlyArray<{ exchangeId: string; claimId: string }> })
        : Promise<{ bound: boolean; items: WorkflowIntakeBoundText[] }> {
        const recipientSessionId = intakeId(input.recipientSessionId, "recipientSessionId");
        const invocationId = intakeId(input.invocationId, "invocationId");
        const items = intakeBatch(input.items, "items", false);
        const membersText = intakeMembersText(items);
        return this.transaction<{ bound: boolean; items: WorkflowIntakeBoundText[] }>(async client => {
            const invocation = await this.lockIntakeInvocation(client, invocationId);
            if (invocation !== null) {
                if (invocation.recipientSessionId !== recipientSessionId) {
                    return intakeBroken(items[0].exchangeId, `invocation ${invocationId} belongs to another recipient`);
                }
                if (invocation.membersText !== membersText) {
                    return intakeBroken(items[0].exchangeId, `invocation ${invocationId} was bound with another membership, which never changes`);
                }
            }
            const rows = await this.lockIntakeRows(client, items.map(item => item.exchangeId), invocationId);
            const named = new Set(items.map(item => item.exchangeId));
            for (const row of rows.values()) {
                if (row.invocationId === invocationId && !named.has(row.exchangeId)) {
                    intakeBroken(row.exchangeId, `it is bound to invocation ${invocationId} but is not one of its members`);
                }
            }
            const texts: WorkflowIntakeBoundText[] = items.map(item => {
                const row = rows.get(item.exchangeId) ?? intakeBroken(item.exchangeId, "it has no intake row");
                assertIntakeHolder(row, recipientSessionId, item.claimId);
                const expected = invocation === null ? row.state === "holding" : row.state === "admitted" && row.invocationId === invocationId;
                if (!expected) {
                    intakeBroken(row.exchangeId, `it is ${row.state}${row.invocationId === null ? "" : ` for invocation ${row.invocationId}`}, `
                        + `not ${invocation === null ? "holding" : `bound to invocation ${invocationId}`}`);
                }
                const text = row.text;
                if (text === null || sha256Hex(text) !== row.textSha256) return intakeBroken(row.exchangeId, "its stored text does not match its hash");
                return { exchangeId: row.exchangeId, claimId: row.claimId, text, textSha256: row.textSha256 };
            });
            if (invocation === null) {
                const at = await this.clockIn(client);
                await client.query(
                    `INSERT INTO ${this.t.intakeInvocations} (invocation_id, recipient_session_id, members, member_count, created_at)
                     VALUES ($1, $2, $3, $4, $5::timestamptz)`, [invocationId, recipientSessionId, membersText, items.length, at]);
                const { rowCount } = await client.query(
                    `UPDATE ${this.t.intake}
                        SET state = 'admitted', invocation_id = $2, processing = 'bound', admitted_at = $3::timestamptz, updated_at = $3::timestamptz
                      WHERE exchange_id = ANY($1::text[]) AND state = 'holding'`, [items.map(item => item.exchangeId), invocationId, at]);
                if (rowCount !== items.length) return corrupt(`Invocation ${invocationId}'s batch changed under its locks.`);
            }
            return { bound: invocation === null, items: texts };
        });
    }

    /**
     * Admit an attempt's include of an invocation's items in a model request
     * (migration 0099; exposure protocol revision 2, section 3): the durable
     * record that the items were possibly seen, made before any request may
     * include them, and never evidence that a request was sent or completed.
     * In one READ COMMITTED transaction, under the invocation's lock
     * (lockBoundIntakeInvocation) and its member rows' (FOR UPDATE, in
     * exchange order); no outbox or session lock is taken:
     *
     * - The invocation is the recipient's; every row bound to it is a member
     *   under its member claim; each named item is a member under its claim.
     * - The members an unsent cancel settled (not_dispatched, reason
     *   cancelled) are set aside first. A named one makes the payload stale:
     *   refused `settled`, never silently left out. So does any other member
     *   whose processing is no longer bound: the invocation ended.
     * - The named items must then be exactly the remaining members, in member
     *   order; a duplicate, a reordering, an omission or an extra is a broken
     *   invariant. Each named hash must be its row's stored hash, the hash of
     *   its stored text: the caller hashes the exact text it would send.
     * - With no exposure recorded, this attempt's is inserted, at the store's
     *   clock: allowed. Recorded under the same attempt id (a redelivery of
     *   the attempt, a repeat of this call, a recovery re-run): allowed, with
     *   nothing written; duplicate requests are possible, never exactly once.
     *   Recorded under another attempt id: allowed only for the invocation's
     *   own retry (`sentBefore`, set by the orchestration's producer of that
     *   retry alone), otherwise refused `exposed`.
     *
     * A broken invariant or a malformed input throws and writes nothing.
     */
    async exposeWorkflowIntake(input: {
        recipientSessionId: string;
        invocationId: string;
        attemptId: string;
        sentBefore: boolean;
        items: ReadonlyArray<{ exchangeId: string; claimId: string; textSha256: string }>;
    }): Promise<WorkflowIntakeAdmission> {
        const recipientSessionId = intakeId(input.recipientSessionId, "recipientSessionId");
        const invocationId = intakeId(input.invocationId, "invocationId");
        const attemptId = intakeId(input.attemptId, "attemptId");
        const sentBefore: unknown = input.sentBefore;
        if (typeof sentBefore !== "boolean") throw new IntakeShapeError("sentBefore", "is not a boolean");
        const items = intakeAdmissionBatch(input.items, "items");
        return this.transaction<WorkflowIntakeAdmission>(async client => {
            const invocation = await this.lockBoundIntakeInvocation(client, invocationId, recipientSessionId, items[0].exchangeId);
            const memberClaims = new Map<string, string>(invocation.members.map(member => [member.exchangeId, member.claimId] as [string, string]));
            const rows = await this.lockIntakeRows(client, invocation.members.map(member => member.exchangeId), invocationId);
            for (const row of rows.values()) {
                const claimId = memberClaims.get(row.exchangeId);
                if (claimId === undefined) intakeBroken(row.exchangeId, `it is bound to invocation ${invocationId} but is not one of its members`);
                assertIntakeHolder(row, recipientSessionId, claimId);
                if (row.state !== "admitted" || row.invocationId !== invocationId) {
                    intakeBroken(row.exchangeId, `it is a member of invocation ${invocationId} but is not bound to it`);
                }
            }
            for (const item of items) {
                const claimId = memberClaims.get(item.exchangeId);
                if (claimId === undefined) intakeBroken(item.exchangeId, `it is not a member of invocation ${invocationId}`);
                if (claimId !== item.claimId) intakeBroken(item.exchangeId, `it is a member of invocation ${invocationId} under claim ${claimId}, not ${item.claimId}`);
            }
            const named = new Set(items.map(item => item.exchangeId));
            const active: WorkflowIntakeRow[] = [];
            let stale = false;
            for (const member of invocation.members) {
                const row = rows.get(member.exchangeId) ?? intakeBroken(member.exchangeId, "it has no intake row");
                if (row.processing === "not_dispatched" && row.reason === "cancelled") {
                    if (named.has(row.exchangeId)) stale = true;
                    continue;
                }
                if (row.processing !== "bound") stale = true;
                active.push(row);
            }
            if (stale) return { allowed: false, reason: "settled" };
            if (active.length !== items.length || active.some((row, index) => row.exchangeId !== items[index].exchangeId)) {
                return intakeBroken(items[0].exchangeId, `the admission does not name invocation ${invocationId}'s active batch in its order`);
            }
            for (let index = 0; index < active.length; index += 1) {
                const row = active[index];
                if (row.text === null || sha256Hex(row.text) !== row.textSha256) intakeBroken(row.exchangeId, "its stored text does not match its hash");
                if (items[index].textSha256 !== row.textSha256) intakeBroken(row.exchangeId, "the text to be sent is not its stored text");
            }
            const exposure = await this.intakeExposureIn(client, invocationId, recipientSessionId);
            if (exposure === null) {
                await client.query(
                    `INSERT INTO ${this.t.intakeExposures} (invocation_id, recipient_session_id, attempt_id, exposed_at)
                     VALUES ($1, $2, $3, clock_timestamp())`, [invocationId, recipientSessionId, attemptId]);
                return { allowed: true };
            }
            if (exposure.attemptId === attemptId || sentBefore) return { allowed: true };
            return { allowed: false, reason: "exposed" };
        });
    }

    /**
     * End an invocation (design 5.2, 5.5). Under the invocation's lock, the
     * batch is checked against its complete membership: every member is the
     * recipient's row under its member claim and admitted to it, no other row
     * names it, and the batch names every member except those an unsent
     * cancel settled (not_dispatched, reason cancelled), which it must not
     * name. The batch's rows move together from processing bound to
     * `outcome`, with settled_at, and the items whose cancel flag is set
     * record cancel_requested. A batch already at `outcome` is the same end
     * (a replay; nothing is written) when every cancel it names was recorded.
     * A member left out (bound or ended), a non-member or a cancelled member
     * named, a batch partly ended or at another value, or a replay naming an
     * unrecorded cancel is a broken invariant and writes nothing.
     *
     * When every member was cancelled before the send, the batch is empty
     * (only an end may name no exchange; a bind never does): the call checks
     * the same way that the invocation was bound for this recipient and that
     * each of its members is a cancelled-unsent row, and writes nothing, its
     * retries alike. `ended` is true only for the call that settled rows.
     *
     * Possible exposure (migration 0099; exposure protocol revision 2,
     * section 6): with an exposure recorded, a requested `not_dispatched` is
     * applied as `interrupted`, the outcome computed under the lock before
     * the first update, and the one a replay compares with; the answer then
     * names it (`outcome`), and only then. No other outcome changes. An empty
     * batch beside an exposure record is a broken invariant: an admission
     * refuses a payload whose items were all cancelled.
     */
    async endWorkflowIntake(input: {
        recipientSessionId: string;
        invocationId: string;
        outcome: IntakeProcessingOutcome;
        items: ReadonlyArray<{ exchangeId: string; claimId: string; cancelRequested: boolean }>;
    }): Promise<{ ended: boolean; outcome?: "interrupted" }> {
        const recipientSessionId = intakeId(input.recipientSessionId, "recipientSessionId");
        const invocationId = intakeId(input.invocationId, "invocationId");
        const requested: unknown = input.outcome;
        if (typeof requested !== "string" || !(INTAKE_PROCESSING_OUTCOMES as readonly string[]).includes(requested)) {
            throw new IntakeShapeError("outcome", `is not one of ${INTAKE_PROCESSING_OUTCOMES.join(", ")}`);
        }
        const items = intakeBatch(input.items, "items", true, true);
        return this.transaction<{ ended: boolean; outcome?: "interrupted" }>(async client => {
            const invocation = await this.lockBoundIntakeInvocation(client, invocationId, recipientSessionId, items[0]?.exchangeId ?? null);
            const memberClaims = new Map<string, string>(invocation.members.map(member => [member.exchangeId, member.claimId] as [string, string]));
            const rows = await this.lockIntakeRows(client, invocation.members.map(member => member.exchangeId), invocationId);
            const exposed = await this.intakeExposureIn(client, invocationId, recipientSessionId) !== null;
            const outcome: IntakeProcessingOutcome = requested === "not_dispatched" && exposed ? "interrupted" : requested as IntakeProcessingOutcome;
            const answer = (ended: boolean) => (outcome !== requested ? { ended, outcome: "interrupted" as const } : { ended });
            if (items.length === 0 && exposed) {
                return corrupt(`Intake invocation ${invocationId}: an end names no item, but its items were possibly sent.`);
            }
            for (const row of rows.values()) {
                const claimId = memberClaims.get(row.exchangeId);
                if (claimId === undefined) intakeBroken(row.exchangeId, `it is bound to invocation ${invocationId} but is not one of its members`);
                assertIntakeHolder(row, recipientSessionId, claimId);
                if (row.state !== "admitted" || row.invocationId !== invocationId) {
                    intakeBroken(row.exchangeId, `it is a member of invocation ${invocationId} but is not bound to it`);
                }
            }
            const named = new Map<string, { exchangeId: string; claimId: string; cancelRequested: boolean }>(
                items.map(item => [item.exchangeId, item] as [string, { exchangeId: string; claimId: string; cancelRequested: boolean }]));
            for (const item of items) {
                const claimId = memberClaims.get(item.exchangeId);
                if (claimId === undefined) intakeBroken(item.exchangeId, `it is not a member of invocation ${invocationId}`);
                if (claimId !== item.claimId) intakeBroken(item.exchangeId, `it is a member of invocation ${invocationId} under claim ${claimId}, not ${item.claimId}`);
            }
            let ended = 0;
            for (const member of invocation.members) {
                const row = rows.get(member.exchangeId) ?? intakeBroken(member.exchangeId, "it has no intake row");
                const item = named.get(member.exchangeId);
                if (row.processing === "not_dispatched" && row.reason === "cancelled") {
                    if (item !== undefined) intakeBroken(row.exchangeId, `it was cancelled before invocation ${invocationId} was sent; its end does not name it`);
                    continue;
                }
                if (item === undefined) intakeBroken(row.exchangeId, `it is a member of invocation ${invocationId} but missing from its end`);
                if (row.processing === outcome) {
                    ended += 1;
                    if (item.cancelRequested && !row.cancelRequested) intakeBroken(row.exchangeId, "its end names a cancel that the ended row did not record");
                } else if (row.processing !== "bound") {
                    intakeBroken(row.exchangeId, `its processing is ${row.processing}, not bound or ${outcome}`);
                }
            }
            if (ended > 0 && ended < items.length) intakeBroken(items[0].exchangeId, `invocation ${invocationId}'s end is partly applied`);
            if (ended === items.length) return answer(false);
            const at = await this.clockIn(client);
            const { rowCount } = await client.query(
                `UPDATE ${this.t.intake}
                    SET processing = $3, settled_at = $4::timestamptz, updated_at = $4::timestamptz,
                        cancel_requested = cancel_requested OR exchange_id = ANY($5::text[])
                  WHERE exchange_id = ANY($1::text[]) AND invocation_id = $2 AND processing = 'bound'`,
                [items.map(item => item.exchangeId), invocationId, outcome, at, items.filter(item => item.cancelRequested).map(item => item.exchangeId)]);
            if (rowCount !== items.length) return corrupt(`Invocation ${invocationId}'s batch changed under its locks.`);
            return answer(true);
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
     * Cancel an item of an invocation not yet sent (design 5.2, 5.5): under
     * the invocation's lock, a member admitted to it under its member claim
     * with processing bound becomes not_dispatched, reason cancelled, and the
     * invocation's end no longer names it. Already so: the same (nothing
     * written), answered before any exposure is read, so an item cancelled
     * before an exposure stays settled (exposure protocol revision 2, section
     * 6). With an exposure recorded (migration 0099), the items were possibly
     * seen: the cancel is recorded as requested, once (cancel_requested, as
     * requestCancelWorkflowIntake records it), whatever the row's processing,
     * a final one included and kept, and the answer says `exposed`.
     */
    async cancelUnsentWorkflowIntake(input: { recipientSessionId: string; exchangeId: string; claimId: string; invocationId: string })
        : Promise<{ cancelled: boolean; exposed?: true }> {
        const recipientSessionId = intakeId(input.recipientSessionId, "recipientSessionId");
        const exchangeId = intakeExchangeId(input.exchangeId, "exchangeId");
        const claimId = intakeId(input.claimId, "claimId");
        const invocationId = intakeId(input.invocationId, "invocationId");
        return this.transaction<{ cancelled: boolean; exposed?: true }>(async client => {
            const invocation = await this.lockBoundIntakeInvocation(client, invocationId, recipientSessionId, exchangeId);
            if (intakeMemberClaim(invocation, invocationId, exchangeId) !== claimId) {
                return intakeBroken(exchangeId, `it is a member of invocation ${invocationId} under another claim than ${claimId}`);
            }
            const row = await this.lockIntakeRow(client, exchangeId);
            assertIntakeHolder(row, recipientSessionId, claimId);
            if (row.state !== "admitted" || row.invocationId !== invocationId) return intakeBroken(exchangeId, `it is not bound to invocation ${invocationId}`);
            if (row.processing === "not_dispatched" && row.reason === "cancelled") return { cancelled: false };
            if (await this.intakeExposureIn(client, invocationId, recipientSessionId) !== null) {
                if (!row.cancelRequested) {
                    await client.query(
                        `UPDATE ${this.t.intake} SET cancel_requested = true, updated_at = clock_timestamp() WHERE exchange_id = $1`, [exchangeId]);
                }
                return { cancelled: false, exposed: true };
            }
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
     * 5.2, 5.5): under the invocation's lock, a member admitted to it under
     * its member claim records cancel_requested; its processing is not
     * changed. Already recorded: the same (nothing written).
     */
    async requestCancelWorkflowIntake(input: { recipientSessionId: string; exchangeId: string; claimId: string; invocationId: string })
        : Promise<{ recorded: boolean }> {
        const recipientSessionId = intakeId(input.recipientSessionId, "recipientSessionId");
        const exchangeId = intakeExchangeId(input.exchangeId, "exchangeId");
        const claimId = intakeId(input.claimId, "claimId");
        const invocationId = intakeId(input.invocationId, "invocationId");
        return this.transaction<{ recorded: boolean }>(async client => {
            const invocation = await this.lockBoundIntakeInvocation(client, invocationId, recipientSessionId, exchangeId);
            if (intakeMemberClaim(invocation, invocationId, exchangeId) !== claimId) {
                return intakeBroken(exchangeId, `it is a member of invocation ${invocationId} under another claim than ${claimId}`);
            }
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

    /** An invocation's exposure record as stored (migration 0099), or null when no admission let an attempt include its items. */
    async readWorkflowIntakeExposure(invocationId: string): Promise<WorkflowIntakeExposure | null> {
        if (!storableId(invocationId)) return null;
        const { rows } = await this.pool.query(
            `SELECT invocation_id, recipient_session_id, attempt_id, ${isoUtc("exposed_at")} AS exposed_at_iso
               FROM ${this.t.intakeExposures} WHERE invocation_id = $1`, [invocationId]);
        const row = rows[0];
        return row ? {
            invocationId: str(row, "invocation_id"), recipientSessionId: str(row, "recipient_session_id"), attemptId: str(row, "attempt_id"),
            exposedAt: str(row, "exposed_at_iso"),
        } : null;
    }

    /**
     * A session's workflow lineage (design 03 human-input denial and depth;
     * R13, R16): one recursive read of the session rows from the session up
     * (soft-deleted rows included, so a deleted ancestor still counts), with
     * the agent state invocation, if any, of each. Null when the session row
     * does not exist. A schema without the invocation table (migration 0101
     * not applied yet) has no agent states, so no session is in one's subtree.
     */
    async readWorkflowLineage(sessionId: string): Promise<WorkflowLineage | null> {
        if (!storableId(sessionId)) return null;
        const lineageSql = (withInvocations: boolean) => `
            WITH RECURSIVE lineage AS (
                SELECT session_id, parent_session_id, 0 AS distance FROM ${this.t.sessions} WHERE session_id = $1
                UNION ALL
                SELECT parent.session_id, parent.parent_session_id, lineage.distance + 1
                  FROM ${this.t.sessions} parent JOIN lineage ON parent.session_id = lineage.parent_session_id
                 WHERE lineage.distance < ${WORKFLOW_V2_LINEAGE_MAX_DEPTH}
            )
            SELECT lineage.session_id, lineage.parent_session_id, lineage.distance,
                   ${withInvocations ? "invocation.node_execution_id, invocation.workflow_session_id, invocation.controlling_session_id"
                       : "NULL::text AS node_execution_id, NULL::text AS workflow_session_id, NULL::text AS controlling_session_id"}
              FROM lineage
              ${withInvocations ? `LEFT JOIN LATERAL (
                  -- One row per lineage session (review RT-4): a chat that continues has one invocation per visit (0106), and
                  -- a join of them all repeated the session (read as a cycle). Its open visit, else its newest.
                  SELECT i.node_execution_id, i.workflow_session_id, i.controlling_session_id
                    FROM ${this.t.agentInvocations} i LEFT JOIN ${this.t.nodes} n ON n.node_execution_id = i.node_execution_id
                   WHERE i.child_session_id = lineage.session_id
                   ORDER BY COALESCE(n.state = 'pending', false) DESC, n.ordinal DESC NULLS LAST, i.created_at DESC, i.node_execution_id DESC
                   LIMIT 1) invocation ON true` : ""}
             ORDER BY lineage.distance`;
        let rows: Row[];
        try {
            ({ rows } = await this.pool.query(lineageSql(true), [sessionId]));
        } catch (error) {
            if ((error as { code?: unknown })?.code !== "42P01") throw error;
            ({ rows } = await this.pool.query(lineageSql(false), [sessionId]));
        }
        if (!rows[0]) return null;
        const seen = new Set<string>();
        let cyclic = false;
        let agentRoot: WorkflowLineage["agentRoot"] = null;
        for (const row of rows) {
            const id = str(row, "session_id");
            if (seen.has(id)) { cyclic = true; break; }
            seen.add(id);
            const nodeExecutionId = strOrNull(row, "node_execution_id");
            if (agentRoot === null && nodeExecutionId !== null) {
                agentRoot = { childSessionId: id, nodeExecutionId, workflowSessionId: str(row, "workflow_session_id"),
                    controllingSessionId: strOrNull(row, "controlling_session_id"), distance: int(row, "distance") };
            }
        }
        const top = rows[rows.length - 1];
        const level = !cyclic && strOrNull(top, "parent_session_id") === null ? int(top, "distance") : null;
        return { sessionId, level, agentRoot };
    }

    // ─── Agent states (IR 8, migration 0101) ──

    /**
     * FU-17: the tools an agent state limits its agent to (`tools`), for the session of a turn in that state's subtree: the
     * names ([] for none), or null when the state sets no limit. Read from the state's run's own revision (its IR checked
     * against the run's hash), so a later revision never changes a running visit's limit. A visit that does not exist, or
     * a state that is not an agent state, has none.
     */
    async readAgentToolLimit(nodeExecutionId: string): Promise<string[] | null> {
        const { rows } = await this.pool.query(
            `SELECT n.node_id, r.workflow_session_id, r.revision, r.ir_sha256 FROM ${this.t.nodes} n JOIN ${this.t.runs} r ON r.run_id = n.run_id
              WHERE n.node_execution_id = $1`, [nodeExecutionId]);
        if (!rows[0]) return null;
        const ir = await this.readRevisionIr(str(rows[0], "workflow_session_id"), int(rows[0], "revision"), str(rows[0], "ir_sha256"),
            { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
        const node = ir.nodes[str(rows[0], "node_id")];
        return node?.type === "agent" && Array.isArray(node.tools) ? [...node.tools] : null;
    }

    async readAgentInvocation(nodeExecutionId: string): Promise<WorkflowAgentInvocation | null> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.agentInvocations} WHERE node_execution_id = $1`, [nodeExecutionId]);
        return rows[0] ? agentInvocationFrom(rows[0]) : null;
    }

    /**
     * The newest invocation whose child agent session is `childSessionId` (a chat that continues has one per visit), or
     * null. Newest by the visit's ordinal (review PRR-3: the database clock can step back between two visits), then time.
     */
    async readAgentInvocationByChild(childSessionId: string): Promise<WorkflowAgentInvocation | null> {
        if (!storableId(childSessionId)) return null;
        const { rows } = await this.pool.query(
            `SELECT i.* FROM ${this.t.agentInvocations} i LEFT JOIN ${this.t.nodes} n ON n.node_execution_id = i.node_execution_id
              WHERE i.child_session_id = $1 ORDER BY n.ordinal DESC NULLS LAST, i.created_at DESC, i.node_execution_id DESC LIMIT 1`, [childSessionId]);
        return rows[0] ? agentInvocationFrom(rows[0]) : null;
    }

    /**
     * G1 residual: whether an end (done or cancel) was asked of session `sessionId` (its session.end_requested mark,
     * session-end-mark.ts), whether or not the session has ended yet.
     */
    async sessionEndRequested(sessionId: string): Promise<boolean> {
        if (!storableId(sessionId)) return false;
        const { rows } = await this.pool.query(
            `SELECT 1 FROM ${this.t.sessionEvents} WHERE session_id = $1 AND event_type = 'session.end_requested' LIMIT 1`, [sessionId]);
        return rows.length > 0;
    }

    /**
     * Review DRR-2: the first end asked of session `sessionId` (its earliest session.end_requested mark): the command
     * (done, or cancel for anything else), the mark's own id, and who asked (null: a person through the management API).
     * Null when no end was asked.
     */
    async readSessionEndMark(sessionId: string): Promise<{ cmd: "done" | "cancel"; id: string; requestedBy: string | null } | null> {
        if (!storableId(sessionId)) return null;
        const { rows } = await this.pool.query(
            `SELECT seq, data FROM ${this.t.sessionEvents} WHERE session_id = $1 AND event_type = 'session.end_requested' ORDER BY seq LIMIT 1`, [sessionId]);
        if (!rows[0]) return null;
        const data = rows[0].data && typeof rows[0].data === "object" ? rows[0].data as Record<string, unknown> : {};
        return {
            cmd: data.cmd === "done" ? "done" : "cancel",
            id: typeof data.id === "string" && data.id ? data.id : `seq-${rows[0].seq}`,
            requestedBy: typeof data.requestedBy === "string" && data.requestedBy ? data.requestedBy : null,
        };
    }

    /** Whether session `sessionId` has a row that was deleted (false: no row, or a row not deleted). */
    async isSessionDeleted(sessionId: string): Promise<boolean> {
        if (!storableId(sessionId)) return false;
        const { rows } = await this.pool.query(`SELECT deleted_at IS NOT NULL AS deleted FROM ${this.t.sessions} WHERE session_id = $1`, [sessionId]);
        return rows[0] ? bool(rows[0], "deleted") : false;
    }

    /**
     * The turn visit of a chat that continues (the turn-to-visit fence; review RT-2, RT-3): the visit whose prompt the
     * turn received. `promptClientMessageIds` are the turn's prompt ids: among the visits they name that are this chat's,
     * the open one, else the newest. A turn whose prompt names none of them (a timer, a sub-agent's update) inherits the
     * visit of this chat's newest recorded prompt that names one. Null when the session is not a chat that continues (no
     * invocation, or a visit's own chat: chat: new is untouched).
     */
    async readTurnVisit(childSessionId: string, promptClientMessageIds: readonly string[]): Promise<WorkflowTurnVisit | null> {
        if (!storableId(childSessionId)) return null;
        const { rows: any } = await this.pool.query(
            `SELECT node_execution_id FROM ${this.t.agentInvocations} WHERE child_session_id = $1 ORDER BY created_at DESC, node_execution_id DESC LIMIT 1`,
            [childSessionId]);
        if (!any[0] || !workflowAgentChatContinues({ nodeExecutionId: str(any[0], "node_execution_id"), childSessionId })) return null;
        const visitsOf = async (ids: readonly string[]): Promise<{ id: string; open: boolean } | null> => {
            if (ids.length === 0) return null;
            const { rows } = await this.pool.query(
                `SELECT i.node_execution_id, n.state FROM ${this.t.agentInvocations} i JOIN ${this.t.nodes} n ON n.node_execution_id = i.node_execution_id
                  WHERE i.child_session_id = $1 AND i.node_execution_id = ANY($2::text[])
                  ORDER BY (n.state = 'pending') DESC, n.ordinal DESC, i.created_at DESC, i.node_execution_id DESC LIMIT 1`, [childSessionId, [...new Set(ids)]]);
            return rows[0] ? { id: str(rows[0], "node_execution_id"), open: str(rows[0], "state") === "pending" } : null;
        };
        const own = await visitsOf(promptClientMessageIds.map(workflowVisitOfPromptId).filter((id): id is string => id !== null));
        if (own) return { nodeExecutionId: own.id, open: own.open, inherited: false };
        // Inherited: the newest recorded prompt of this chat that names a visit.
        const { rows: prompts } = await this.pool.query(
            `SELECT e.data->'clientMessageIds' AS ids FROM ${this.t.sessionEvents} e
              WHERE e.session_id = $1 AND e.event_type IN ('user.message', 'system.message')
                AND jsonb_typeof(e.data->'clientMessageIds') = 'array'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.data->'clientMessageIds') x(id) WHERE x.id LIKE 'workflow:%:agent:%')
              ORDER BY e.seq DESC LIMIT 1`, [childSessionId]);
        const named = Array.isArray(prompts[0]?.ids) ? (prompts[0].ids as unknown[]).map(workflowVisitOfPromptId).filter((id): id is string => id !== null) : [];
        const inherited = await visitsOf(named);
        return inherited ? { nodeExecutionId: inherited.id, open: inherited.open, inherited: true } : { nodeExecutionId: null, open: false, inherited: true };
    }

    /** The request id of each turn control (a session event at `seq`) of session `sessionId`: seq -> requestId (null: none). */
    async readControlRequestIds(sessionId: string, seqs: readonly number[]): Promise<Map<number, string | null>> {
        const wanted = [...new Set(seqs.filter(seq => Number.isSafeInteger(seq) && seq > 0))];
        const found = new Map<number, string | null>();
        if (!storableId(sessionId) || wanted.length === 0) return found;
        const { rows } = await this.pool.query(
            `SELECT seq, data->>'requestId' AS request_id FROM ${this.t.sessionEvents}
              WHERE session_id = $1 AND seq = ANY($2::bigint[]) AND event_type IN ('user.steer', 'user.stop')`, [sessionId, wanted]);
        for (const row of rows) found.set(Number(row.seq), strOrNull(row, "request_id"));
        return found;
    }

    /**
     * A Stop of a continued chat's turn that names another visit (the turn-to-visit fence; formal deviation D3): its outcome
     * is recorded now as too_late, under the session row's lock as turn end takes it, so it is no longer open on the turn.
     * Left open, a turn that then fails would be ended as stopped by it (cms_turn_end), and its crash retry would not run.
     * Once only: a Stop that already has an outcome keeps it. Returns whether this call recorded it.
     */
    async recordStopNotForTurn(sessionId: string, seq: number, turn: number): Promise<{ recorded: boolean }> {
        if (!storableId(sessionId) || !Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(turn) || turn < 0) return { recorded: false };
        return this.transaction(async client => {
            await client.query(`SELECT 1 FROM ${this.t.sessions} WHERE session_id = $1 FOR UPDATE`, [sessionId]);
            return { recorded: await insertStopNotForTurn(client, this.t.sessionEvents, sessionId, seq, turn) };
        });
    }

    /**
     * Whether any visit of chat `childSessionId` began a spawn attempt (review RT-1, t2): such an attempt may still create
     * the chat, so a run's end that finds no chat leaves its end owed. beginAgentSpawn records each attempt in the
     * transaction that checks its node is pending, under the workflow session's lock, and a run's end decides its pending
     * nodes under that lock: no attempt here after the run ended means no chat is created later.
     */
    async chatHasSpawnAttempt(childSessionId: string): Promise<boolean> {
        if (!storableId(childSessionId)) return false;
        const { rows } = await this.pool.query(
            `SELECT EXISTS (SELECT 1 FROM ${this.t.agentInvocations} WHERE child_session_id = $1 AND spawn_attempts > 0) AS attempted`, [childSessionId]);
        return bool(rows[0], "attempted");
    }

    /**
     * The visits of a run's state `stateId` before visit `beforeNodeExecutionId` (every visit, when null), in the order
     * they were admitted (their ordinals; review PRR-3: not the database clock, which can step back): how many there are, and the last of them (null when none). A state that continues its chat
     * (owner decision agent-node-continue-20261106) numbers a visit's cycle and finds its previous visit, and chooses a
     * new visit's chat, from this. Counted in the store, not read and capped (review RT-5): a run may admit up to
     * WORKFLOW_V2_MAX_NODE_EXECUTIONS visits.
     */
    async readAgentVisitsBefore(runId: string, stateId: string, beforeNodeExecutionId: string | null)
        : Promise<{ count: number; previous: WorkflowAgentInvocation | null }> {
        const { rows } = await this.pool.query(
            `SELECT count(*) OVER () AS visits, i.* FROM ${this.t.agentInvocations} i
               JOIN ${this.t.nodes} n ON n.node_execution_id = i.node_execution_id
              WHERE i.run_id = $1 AND n.node_id = $2
                AND ($3::text IS NULL OR (n.ordinal, i.created_at, i.node_execution_id) <
                     (SELECT bn.ordinal, b.created_at, b.node_execution_id FROM ${this.t.agentInvocations} b
                        JOIN ${this.t.nodes} bn ON bn.node_execution_id = b.node_execution_id WHERE b.node_execution_id = $3))
              ORDER BY n.ordinal DESC, i.created_at DESC, i.node_execution_id DESC LIMIT 1`, [runId, stateId, beforeNodeExecutionId]);
        return rows[0] ? { count: int(rows[0], "visits"), previous: agentInvocationFrom(rows[0]) } : { count: 0, previous: null };
    }

    /**
     * The invocations of a run's state `stateId`, oldest first (its visits), at most `limit`: for a reader. The runtime
     * numbers and chooses with readAgentVisitsBefore, which has no cap.
     */
    async listAgentInvocationsOfState(runId: string, stateId: string, limit = 1_000): Promise<WorkflowAgentInvocation[]> {
        const { rows } = await this.pool.query(
            `SELECT i.* FROM ${this.t.agentInvocations} i JOIN ${this.t.nodes} n ON n.node_execution_id = i.node_execution_id
              WHERE i.run_id = $1 AND n.node_id = $2 ORDER BY n.ordinal, i.created_at, i.node_execution_id LIMIT $3`, [runId, stateId, limit]);
        return rows.map(agentInvocationFrom);
    }

    /**
     * The invocation a completion by `childSessionId` binds to (owner decision agent-node-continue-20261106; formal
     * cmp.ac-bind-current): a visit's own chat binds to its one invocation, and a node execution id it gives is ignored (as
     * at e696f2c6; review RT-8); a chat that continues across a state's visits binds ONLY by the node execution id it gives, which must be one
     * of that chat's visits. Never by "the newest": a late answer of a visit that ended must not decide the next one (it
     * binds to its own, decided visit and is refused there). Null: not a workflow agent state's chat. A continued chat's
     * call without the id, or with one that is not its own, is refused in words, nothing written.
     */
    private async agentInvocationOfCompletion(client: PoolClient, childSessionId: string, nodeExecutionId: string | undefined,
        turnVisit: string | null | undefined = undefined): Promise<Row | null> {
        const columns = "node_execution_id, workflow_session_id, run_id";
        const { rows } = await client.query(
            `SELECT ${columns} FROM ${this.t.agentInvocations} WHERE child_session_id = $1 ORDER BY created_at DESC, node_execution_id DESC LIMIT 1`,
            [childSessionId]);
        if (!rows[0]) return null;
        const newest = str(rows[0], "node_execution_id");
        const named = nodeExecutionId === undefined ? null : jsonbSafeText(nodeExecutionId, 200);
        // A visit's own chat (chat: new) binds to its one invocation, exactly as at e696f2c6 (review RT-8): a node execution
        // id it gives is ignored, as the tool wrapper there dropped it.
        if (!workflowAgentChatContinues({ nodeExecutionId: newest, childSessionId })) return rows[0];
        // A turn of a continued chat that received no cycle prompt (null: none recorded in the chat yet) completes none
        // (formal deviation D1, as its reminder: no_visit).
        if (turnVisit === null) {
            throw new WorkflowStoreError("AGENT_NODE_NOT_FOUND", "This turn received no cycle prompt, so it finishes no cycle; "
                + "complete a cycle in the turn that received its prompt.");
        }
        if (nodeExecutionId === undefined) {
            throw new WorkflowStoreError("AGENT_NODE_NOT_FOUND", "This agent session continues across the visits of its workflow state, so a completion must "
                + "name the cycle it finishes: give node_execution_id, the id in this cycle's prompt.");
        }
        const { rows: own } = !storableId(nodeExecutionId) ? { rows: [] as Row[] } : await client.query(
            `SELECT ${columns} FROM ${this.t.agentInvocations} WHERE child_session_id = $1 AND node_execution_id = $2`, [childSessionId, nodeExecutionId]);
        if (!own[0]) {
            throw new WorkflowStoreError("AGENT_NODE_NOT_FOUND", `node_execution_id ${named} is not a cycle of this chat; give the id in this cycle's prompt.`);
        }
        // The turn-to-visit fence (review RT-3): a turn completes only the visit whose prompt it received.
        if (typeof turnVisit === "string" && nodeExecutionId !== turnVisit) {
            throw new WorkflowStoreError("AGENT_NODE_NOT_FOUND", `This turn works on cycle ${turnVisit}, not ${named}; `
                + `give node_execution_id ${turnVisit}, the id in the prompt this turn received.`);
        }
        return own[0];
    }

    /**
     * The gate of a step's reminder (owner decision Q2: remind when nothing is pending): the turn `turn` of the agent state's
     * own child `childSessionId` ended with nothing pending, and the child is about to be reminded inside that turn. In one
     * transaction, with the locks of a completion in its order (completeAgentNode: the workflow's session, the run, the
     * invocation, the node), so a completion, an expiry and a run's end serialize with it, then one reading of the
     * store's clock: the step must be open (the workflow not deleted, the run active, the node pending, no end requested,
     * that reading before its deadline, no completion bound expired), the child must have no sub-agent at work (a child
     * session row pending, running, waiting or asking), and fewer than `max` reminders may be recorded for the step. The
     * reminder is recorded (workflow.agent_reminded on the workflow session) in the same transaction, before the child is
     * reminded, so the count is durable; it is the decision to remind, which a Stop may still keep from being sent. The
     * same turn records once: an attempt of it that runs again (an activity retry) reminds again under its recorded
     * number, and counts nothing more, after the same checks (a closed step or a sub-agent at work refuses it too).
     * Every refusal records nothing.
     */
    async recordAgentReminder(input: { childSessionId: string; turn: number; max?: number; visit?: string | null }): Promise<WorkflowAgentReminderRecord> {
        if (!storableId(input.childSessionId) || !Number.isSafeInteger(input.turn) || input.turn < 0) return { recorded: false, reason: "not_a_step" };
        const max = input.max ?? WORKFLOW_V2_AGENT_MAX_REMINDERS;
        return this.transaction(async client => {
            // A chat that continues across a state's visits (owner decision agent-node-continue-20261106) is reminded only of
            // its turn's own visit (`visit`: the visit whose prompt the reminded turn received; review RT-3), checked below
            // like any step, never of the chat's open or newest visit: a turn with no visit of its own gets no reminder.
            // A visit's own chat (chat: new) is reminded of its one invocation, as before.
            const { rows: newest } = await client.query(
                `SELECT node_execution_id, workflow_session_id, run_id FROM ${this.t.agentInvocations}
                  WHERE child_session_id = $1 ORDER BY created_at DESC, node_execution_id DESC LIMIT 1`, [input.childSessionId]);
            if (!newest[0]) return { recorded: false, reason: "not_a_step" } as const;
            const continued = workflowAgentChatContinues({ nodeExecutionId: str(newest[0], "node_execution_id"), childSessionId: input.childSessionId });
            let found = newest;
            if (continued) {
                if (typeof input.visit !== "string" || !storableId(input.visit)) return { recorded: false, reason: "no_visit" } as const;
                ({ rows: found } = await client.query(
                    `SELECT node_execution_id, workflow_session_id, run_id FROM ${this.t.agentInvocations} WHERE child_session_id = $1 AND node_execution_id = $2`,
                    [input.childSessionId, input.visit]));
                if (!found[0]) return { recorded: false, reason: "no_visit" } as const;
            }
            const nodeExecutionId = str(found[0], "node_execution_id");
            const cycle = continued ? { cycle: nodeExecutionId } : {};
            const workflowSessionId = str(found[0], "workflow_session_id");
            const live = await this.lockLiveSession(client, workflowSessionId);
            const run = await this.lockRun(client, str(found[0], "run_id"));
            const { rows: locked } = await client.query(`SELECT * FROM ${this.t.agentInvocations} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            const invocation = agentInvocationFrom(locked[0]);
            const { rows: nodeRows } = await client.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            if (!nodeRows[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Agent state ${nodeExecutionId} has no node execution.`);
            const node = nodeFrom(nodeRows[0]);
            if (!live || !ACTIVE_RUN_STATUSES.includes(run.status) || node.state !== "pending" || invocation.endRequested !== null) {
                return { recorded: false, reason: "decided" } as const;
            }
            // One reading of the store's clock, after the locks: a wait for them may have crossed the deadline.
            const { rows: clock } = await client.query(
                `SELECT clock_timestamp() < deadline_at
                        AND NOT EXISTS (SELECT 1 FROM ${this.t.agentCompletions} WHERE node_execution_id = $1 AND outcome = 'expired') AS in_time
                   FROM ${this.t.agentInvocations} WHERE node_execution_id = $1`, [nodeExecutionId]);
            if (!bool(clock[0], "in_time")) return { recorded: false, reason: "expired" } as const;
            const { rows: recorded } = await client.query(
                `SELECT data FROM ${this.t.sessionEvents} WHERE session_id = $1 AND event_type = $2 AND data->>'nodeExecutionId' = $3 ORDER BY seq`,
                [workflowSessionId, WORKFLOW_AGENT_REMINDED_EVENT, nodeExecutionId]);
            const reminders = recorded.map(row => (row.data && typeof row.data === "object" ? row.data as Record<string, unknown> : {}))
                .map(data => ({ n: Number(data.n), turn: Number(data.turn) }))
                .filter(item => Number.isSafeInteger(item.n));
            // A sub-agent at work refuses a repeat of a recorded turn too (review D5): its number is kept for accounting only.
            const busy = await client.query(
                `SELECT 1 FROM ${this.t.sessions} WHERE parent_session_id = $1 AND deleted_at IS NULL
                    AND state IN ('pending', 'running', 'waiting', 'input_required') LIMIT 1`, [input.childSessionId]);
            if (busy.rows.length > 0) return { recorded: false, reason: "sub_agents" } as const;
            const same = reminders.find(item => item.turn === input.turn);
            if (same) return { recorded: true, n: same.n, max, stateId: node.nodeId, nodeExecutionId, repeat: true, ...cycle } as const;
            if (reminders.length >= max) return { recorded: false, reason: "spent" } as const;
            const n = reminders.reduce((highest, item) => Math.max(highest, item.n), 0) + 1;
            await client.query(`SELECT ${this.t.recordEvents}($1, $2, $3)`, [workflowSessionId, JSON.stringify([{
                eventType: WORKFLOW_AGENT_REMINDED_EVENT,
                data: { runId: invocation.runId, nodeExecutionId, stateId: node.nodeId, childSessionId: input.childSessionId, turn: input.turn, n, max },
            }]), null]);
            return { recorded: true, n, max, stateId: node.nodeId, nodeExecutionId, repeat: false, ...cycle } as const;
        });
    }

    async listAgentInvocations(runId: string, limit = 200): Promise<WorkflowAgentInvocation[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.agentInvocations} WHERE run_id = $1 ORDER BY created_at, node_execution_id LIMIT $2`, [runId, limit]);
        return rows.map(agentInvocationFrom);
    }

    /**
     * One page of a run's agent invocations whose end command is still owed (end_sent_at IS NULL), or was marked sent
     * when the child did not exist yet after a spawn attempt began (end_child_status NotFound, spawn_attempts above 0:
     * the attempt may have created it since; adversarial review WFO-2), in node execution id order after
     * `afterNodeExecutionId` (RT-5: a run's cleanup read only its first 200 invocations, ended or not, so a later child
     * was never ended). Keyed by id, so a page never repeats or skips one.
     */
    async listOwedAgentInvocations(runId: string, afterNodeExecutionId: string | null, limit = 200): Promise<WorkflowAgentInvocation[]> {
        const { rows } = await this.pool.query(
            `SELECT i.* FROM ${this.t.agentInvocations} i
              WHERE i.run_id = $1 AND (i.end_sent_at IS NULL OR (i.end_child_status = 'NotFound' AND (i.spawn_attempts > 0
                    -- A continued chat's end is owed on its newest visit when any of its visits began a spawn (review RT-1).
                    OR EXISTS (SELECT 1 FROM ${this.t.agentInvocations} o WHERE o.child_session_id = i.child_session_id AND o.spawn_attempts > 0))))
                AND ($2::text IS NULL OR i.node_execution_id > $2)
              ORDER BY i.node_execution_id LIMIT $3`, [runId, afterNodeExecutionId, limit]);
        return rows.map(agentInvocationFrom);
    }

    /** The agent invocations of a run's node executions among `nodeExecutionIds` (as many as the ids given). */
    async listAgentInvocationsFor(runId: string, nodeExecutionIds: readonly string[]): Promise<WorkflowAgentInvocation[]> {
        if (nodeExecutionIds.length === 0) return [];
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.agentInvocations} WHERE run_id = $1 AND node_execution_id = ANY($2::text[])`, [runId, [...new Set(nodeExecutionIds)]]);
        return rows.map(agentInvocationFrom);
    }

    /**
     * Begin one spawn attempt of an agent state's child, under the session
     * lock and the invocation's: a state decided meanwhile is not spawned
     * ("decided"), a child already recorded as spawned is not spawned again
     * ("spawned"); otherwise the attempt is counted ("spawn"). The child's id
     * is stable, so an attempt that crashed after creating it finds the same
     * session; the spawner must not create a second one.
     */
    async beginAgentSpawn(nodeExecutionId: string): Promise<{ action: "spawn" | "spawned" | "decided"; invocation: WorkflowAgentInvocation; node: WorkflowNodeExecutionRow }> {
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfNode(client, nodeExecutionId));
            const { rows: locked } = await client.query(`SELECT * FROM ${this.t.agentInvocations} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            if (!locked[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${nodeExecutionId} is not an agent state.`);
            const node = await this.nodeIn(client, nodeExecutionId);
            const invocation = agentInvocationFrom(locked[0]);
            if (!live || node.state !== "pending") return { action: "decided" as const, invocation, node };
            if (invocation.spawnedAt !== null) return { action: "spawned" as const, invocation, node };
            const { rows } = await client.query(
                `UPDATE ${this.t.agentInvocations} SET spawn_attempts = spawn_attempts + 1 WHERE node_execution_id = $1 RETURNING *`, [nodeExecutionId]);
            return { action: "spawn" as const, invocation: agentInvocationFrom(rows[0]), node };
        });
    }

    /** Record that the child of an agent state was created and given its task (once; a repeat changes nothing). */
    async recordAgentSpawned(nodeExecutionId: string, projection?: (invocation: WorkflowAgentInvocation) => SessionProjection)
        : Promise<{ recorded: boolean; invocation: WorkflowAgentInvocation }> {
        return this.transaction(async client => {
            await this.lockLiveSession(client, await this.workflowOfNode(client, nodeExecutionId));
            const { rows } = await client.query(
                `UPDATE ${this.t.agentInvocations} SET spawned_at = clock_timestamp() WHERE node_execution_id = $1 AND spawned_at IS NULL RETURNING *`,
                [nodeExecutionId]);
            if (rows[0]) {
                const invocation = agentInvocationFrom(rows[0]);
                if (projection) await this.project(client, projection(invocation));
                return { recorded: true, invocation };
            }
            const { rows: stored } = await client.query(`SELECT * FROM ${this.t.agentInvocations} WHERE node_execution_id = $1`, [nodeExecutionId]);
            if (!stored[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${nodeExecutionId} is not an agent state.`);
            return { recorded: false, invocation: agentInvocationFrom(stored[0]) };
        });
    }

    /**
     * Record what the workflow asked of an agent state's child once the state
     * was decided (done after the agent's typed completion, cancel after
     * anything else), once: the first request stands. The caller sends the
     * command (at least once) whatever this returns.
     */
    async recordAgentEnd(nodeExecutionId: string, end: "done" | "cancel"): Promise<{ recorded: boolean; invocation: WorkflowAgentInvocation }> {
        const { rows } = await this.pool.query(
            `UPDATE ${this.t.agentInvocations} SET end_requested = $2, end_requested_at = clock_timestamp()
              WHERE node_execution_id = $1 AND end_requested IS NULL RETURNING *`, [nodeExecutionId, end]);
        if (rows[0]) return { recorded: true, invocation: agentInvocationFrom(rows[0]) };
        const invocation = await this.readAgentInvocation(nodeExecutionId);
        if (!invocation) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${nodeExecutionId} is not an agent state.`);
        return { recorded: false, invocation };
    }

    /** Record that an agent state's end command was handed to its child's queue, or was not needed (the child's status), once. */
    /**
     * An end that was marked sent while the child did not exist (end_child_status NotFound), sent again once a spawn
     * attempt created it (adversarial review WFO-2): the child's status is recorded, so the invocation is owed no more.
     * Only from NotFound to another status; `remarked` false otherwise.
     */
    async remarkAgentEndSent(nodeExecutionId: string, childStatus: string): Promise<{ remarked: boolean }> {
        if (childStatus === "NotFound") return { remarked: false };
        const { rows } = await this.pool.query(
            `UPDATE ${this.t.agentInvocations} SET end_sent_at = clock_timestamp(), end_child_status = $2
              WHERE node_execution_id = $1 AND end_sent_at IS NOT NULL AND end_child_status = 'NotFound' RETURNING node_execution_id`,
            [nodeExecutionId, jsonbSafeText(childStatus, 100)]);
        return { remarked: rows.length > 0 };
    }

    /**
     * A chat that continues across a state's visits (owner decision agent-node-continue-20261106) was ended: its newest
     * visit `nodeExecutionId`, whose end is recorded, is marked with `childStatus` (the runtime's ChatEnded), once;
     * `marked` false when it was already. Its sent time is kept when it had one.
     */
    async markContinuedChatEnded(nodeExecutionId: string, childStatus: string): Promise<{ marked: boolean }> {
        const { rows } = await this.pool.query(
            `UPDATE ${this.t.agentInvocations} SET end_sent_at = coalesce(end_sent_at, clock_timestamp()), end_child_status = $2
              WHERE node_execution_id = $1 AND end_requested IS NOT NULL AND end_child_status IS DISTINCT FROM $2 RETURNING node_execution_id`,
            [nodeExecutionId, jsonbSafeText(childStatus, 100)]);
        return { marked: rows.length > 0 };
    }

    async markAgentEndSent(nodeExecutionId: string, childStatus: string): Promise<{ marked: boolean; invocation: WorkflowAgentInvocation }> {
        const { rows } = await this.pool.query(
            `UPDATE ${this.t.agentInvocations} SET end_sent_at = clock_timestamp(), end_child_status = $2
              WHERE node_execution_id = $1 AND end_requested IS NOT NULL AND end_sent_at IS NULL RETURNING *`,
            [nodeExecutionId, jsonbSafeText(childStatus, 100)]);
        if (rows[0]) return { marked: true, invocation: agentInvocationFrom(rows[0]) };
        const invocation = await this.readAgentInvocation(nodeExecutionId);
        if (!invocation || invocation.endRequested === null) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Agent state ${nodeExecutionId} has no end to send.`);
        return { marked: false, invocation };
    }

    /**
     * Elapse an agent state at its outer deadline (timed_out, decided by the
     * controller), as elapseRequest does for a request: one reading of the
     * store's clock, taken after the session lock, decides and is stored; at
     * or after the deadline, or once a completion was bound expired (durable
     * expiry: the store's clock is not monotonic), the state is decided now.
     * Before that it reports the time left; a result stored first is kept.
     */
    async elapseAgentNode(nodeExecutionId: string, result: NodeResultInput, projection?: SessionProjection): Promise<
        { result: "elapsed" | "decided"; node: WorkflowNodeExecutionRow } | { result: "not_due"; remainingMs: number; node: WorkflowNodeExecutionRow }> {
        if (result.resultKind !== "runtime_error" || result.outcome !== "timed_out" || result.winner !== "controller") {
            throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Agent state ${nodeExecutionId} elapses only as timed_out, decided by the controller.`);
        }
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfNode(client, nodeExecutionId));
            const { rows: invocations } = await client.query(`SELECT node_execution_id FROM ${this.t.agentInvocations} WHERE node_execution_id = $1`, [nodeExecutionId]);
            if (!invocations[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${nodeExecutionId} is not an agent state.`);
            if (live) {
                const { rows } = await client.query(
                    `WITH decided AS (SELECT clock_timestamp() AS at)
                     UPDATE ${this.t.nodes}
                        SET state = 'completed', outcome = $2, result_kind = 'runtime_error', output = NULL, error = $3,
                            winner = 'controller', completed_at = (SELECT at FROM decided)
                      WHERE node_execution_id = $1 AND state = 'pending' AND node_type = 'agent'
                        AND (deadline_at <= (SELECT at FROM decided)
                             OR EXISTS (SELECT 1 FROM ${this.t.agentCompletions} WHERE node_execution_id = $1 AND outcome = 'expired'))
                      RETURNING *`,
                    [nodeExecutionId, result.outcome, storedResultText(result)]);
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
            if (node.state === "completed" || !live) return { result: "decided" as const, node };
            if (node.nodeType !== "agent" || node.deadlineAt === null) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Agent state ${nodeExecutionId} is not pending with a deadline.`);
            }
            return { result: "not_due" as const, remainingMs: int(rows[0], "remaining_ms"), node };
        });
    }

    /**
     * The typed completion of an agent state by its own child session
     * (complete_workflow_node; design 03 agent node, D05), in one transaction.
     * The caller is the child session the tool's host names, never a field
     * of the call; it finds its state by the invocation's child id (none:
     * AGENT_NODE_NOT_FOUND, nothing written). In order:
     *
     * 1. The call's shape (COMPLETION_INVALID, nothing written): an object
     *    with exactly one of `outcome` (a string; `output`, a JSON value,
     *    defaults to null) or `error` ({code, message, details?}); and the
     *    operation id. Its result identity is the sha256 of the canonical
     *    JSON of {kind, value} (kindValueSha256).
     * 2. The session, run and invocation locks, then a known operation
     *    decides alone: the same result identity gets what it got before
     *    (the deciding receipt, or its refusal), another one is
     *    OPERATION_CONFLICT. A deleted workflow gets NODE_CLOSED, unbound.
     * 3. One reading of the store's clock, after the node's lock. A decided
     *    state: the deciding result again is accepted (bound `same`), another
     *    result of the agent is COMPLETION_CONFLICT, any other winner is
     *    NODE_CLOSED. A pending state at or after its deadline, or with an
     *    operation bound expired before, is NODE_EXPIRED (durable expiry).
     * 4. The result is checked: an outcome the state declares with an output
     *    that satisfies its output schema in the pinned definition (at most
     *    WORKFLOW_PAYLOAD_MAX_BYTES), or an error whose code the agent may
     *    report (needs_input, execution_failed) with a message of 1 to
     *    WORKFLOW_V2_AGENT_ERROR_MESSAGE_MAX characters and optional details
     *    of at most WORKFLOW_V2_AGENT_ERROR_DETAILS_MAX_BYTES. A failed check
     *    is bound `invalid` with its field errors and decides nothing
     *    (OUTPUT_INVALID), until the WORKFLOW_V2_AGENT_MAX_INVALID_COMPLETIONS
     *    one, which fails the state invalid_output (OUTPUT_ATTEMPTS_EXHAUSTED).
     * 5. A valid result decides the state (winner agent, completed at the
     *    reading), with its receipt and events; final chat is never a result.
     *
     * The caller wakes the run's controller after the commit (a hint; its
     * backstop collection finds the result too).
     */
    async completeAgentNode(input: { childSessionId: string; operationId: string; call: unknown; nodeExecutionId?: string; turnVisit?: string | null })
        : Promise<WorkflowAgentCompletionResult> {
        const notFound = () => new WorkflowStoreError("AGENT_NODE_NOT_FOUND", "This session is not running a workflow agent state.");
        if (!storableId(input.childSessionId)) throw notFound();
        // 1. The call's shape and the operation id.
        const operationId: unknown = input.operationId;
        if (typeof operationId !== "string" || !operationId.trim() || operationId.length > 256 || !isStorableText(operationId)) {
            throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "operation_id must be 1-256 characters of valid Unicode text without NUL characters.");
        }
        const shape = (message: string) => new WorkflowStoreError("COMPLETION_INVALID", message);
        const call: unknown = input.call;
        if (!isJsonObject(call)) throw shape("A completion is { outcome, output } or { error: { code, message, details? } }.");
        const kinds = (["outcome", "error"] as const).filter(name => Object.hasOwn(call, name));
        if (kinds.length !== 1) throw shape("A completion gives exactly one of outcome (with output) or error.");
        let kind: "result" | "error";
        let value: JsonValue;
        try {
            if (kinds[0] === "outcome") {
                const extra = Object.keys(call).filter(key => key !== "outcome" && key !== "output");
                if (typeof call.outcome !== "string" || extra.length > 0) throw shape("outcome must be a string, given with output only.");
                const output = Object.hasOwn(call, "output") ? call.output : null;
                assertJsonValue(output, "output");
                kind = "result";
                value = { outcome: call.outcome, output };
            } else {
                const error = call.error;
                if (Object.keys(call).length !== 1 || !isJsonObject(error)) throw shape("error must be { code, message, details? }.");
                const extra = Object.keys(error).filter(key => key !== "code" && key !== "message" && key !== "details");
                if (typeof error.code !== "string" || typeof error.message !== "string" || extra.length > 0) {
                    throw shape("error must be { code, message, details? }, with a string code and message.");
                }
                const details = Object.hasOwn(error, "details") ? error.details : null;
                assertJsonValue(details, "error.details");
                kind = "error";
                value = { code: error.code, message: error.message, details };
            }
        } catch (error) {
            if (error instanceof WorkflowJsonError) throw shape(error.message);
            throw error;
        }
        const valueText = canonicalJson(value);
        const resultSha256 = kindValueSha256(kind, valueText);
        return this.transaction(async client => {
            // turnVisit: absent (no fence: a caller outside a turn), null (a turn with no cycle prompt), or the turn's visit.
            const found = await this.agentInvocationOfCompletion(client, input.childSessionId, input.nodeExecutionId,
                typeof input.turnVisit === "string" || input.turnVisit === null ? input.turnVisit : undefined);
            if (!found) throw notFound();
            const nodeExecutionId = str(found, "node_execution_id");
            // 2. The locks, then a known operation decides alone.
            const live = await this.lockLiveSession(client, str(found, "workflow_session_id"));
            const run = await this.lockRun(client, str(found, "run_id"));
            const { rows: locked } = await client.query(`SELECT * FROM ${this.t.agentInvocations} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            const invocation = agentInvocationFrom(locked[0]);
            const { rows: nodeRows } = await client.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            if (!nodeRows[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Agent state ${nodeExecutionId} has no node execution.`);
            const node = nodeFrom(nodeRows[0]);
            const state = { status: node.state, outcome: node.outcome, winner: node.winner };
            const controllerInstanceId = run.controllerInstanceId;
            const refused = (code: WorkflowAgentCompletionRefusal, replayed: boolean, problems: JsonValue = null, attemptsLeft: number | null = null) =>
                ({ kind: "refused" as const, replayed, code, problems, attemptsLeft, state, controllerInstanceId });
            const decidedReceipt = async (): Promise<{ receipt: WorkflowAgentCompletionReceipt; resultSha256: string } | null> => {
                const { rows } = await client.query(
                    `SELECT receipt, result_sha256 FROM ${this.t.agentCompletions} WHERE node_execution_id = $1 AND outcome = 'decided'`, [nodeExecutionId]);
                return rows[0] ? { receipt: agentReceiptOf(parseStoredJson(str(rows[0], "receipt"), "receipt")), resultSha256: str(rows[0], "result_sha256") } : null;
            };
            const { rows: known } = await client.query(
                `SELECT result_sha256, outcome, problems FROM ${this.t.agentCompletions} WHERE node_execution_id = $1 AND operation_id = $2`,
                [nodeExecutionId, operationId]);
            if (known[0]) {
                if (str(known[0], "result_sha256") !== resultSha256) return refused("OPERATION_CONFLICT", true);
                const outcome = str(known[0], "outcome");
                if (outcome === "decided" || outcome === "same") {
                    const decided = await decidedReceipt();
                    if (decided === null) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Agent state ${nodeExecutionId} has a ${outcome} operation but no decision.`);
                    return { kind: "accepted" as const, replayed: true, receipt: decided.receipt, controllerInstanceId };
                }
                if (outcome === "invalid") {
                    const stored = jsonOrNull(known[0], "problems");
                    const code = isJsonObject(stored) && stored.code === "OUTPUT_ATTEMPTS_EXHAUSTED" ? "OUTPUT_ATTEMPTS_EXHAUSTED" as const : "OUTPUT_INVALID" as const;
                    return refused(code, true, isJsonObject(stored) ? stored.problems ?? null : null);
                }
                return refused(outcome === "expired" ? "NODE_EXPIRED" : outcome === "closed" ? "NODE_CLOSED" : "COMPLETION_CONFLICT", true);
            }
            if (!live) return refused("NODE_CLOSED", false);

            // 3. One reading of the store's clock decides by the state's record.
            const { rows: clock } = await client.query(
                `WITH reading AS (SELECT clock_timestamp() AS at) SELECT at::text AS at, ${isoUtc("at")} AS at_iso FROM reading`);
            const at = str(clock[0], "at");
            const atIso = str(clock[0], "at_iso");
            const bind = async (outcome: "decided" | "same" | "invalid" | "expired" | "closed" | "conflict", problems: JsonValue = null,
                receipt: WorkflowAgentCompletionReceipt | null = null): Promise<void> => {
                await client.query(
                    `INSERT INTO ${this.t.agentCompletions} (node_execution_id, operation_id, result_sha256, outcome, problems, receipt, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
                    [nodeExecutionId, operationId, resultSha256, outcome, problems === null ? null : canonicalJson(problems),
                        receipt === null ? null : canonicalJson(receipt), at]);
            };
            if (node.state === "completed") {
                // Decided by a completion of the agent: the same result again is that completion; another is a conflict. Any other
                // decision (its deadline, a cancel, a stop, a deletion, the correction budget spent) closed the state.
                const decided = node.winner === "agent" ? await decidedReceipt() : null;
                if (decided !== null) {
                    if (decided.resultSha256 === resultSha256) {
                        await bind("same");
                        return { kind: "accepted" as const, replayed: true, receipt: decided.receipt, controllerInstanceId };
                    }
                    await bind("conflict");
                    return refused("COMPLETION_CONFLICT", false);
                }
                await bind("closed");
                return refused("NODE_CLOSED", false);
            }
            if (!ACTIVE_RUN_STATUSES.includes(run.status)) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Agent state ${nodeExecutionId} is pending in an ended run.`);
            const { rows: early } = await client.query(
                `SELECT $1::timestamptz < deadline_at
                        AND NOT EXISTS (SELECT 1 FROM ${this.t.agentCompletions} WHERE node_execution_id = $2 AND outcome = 'expired') AS in_time
                   FROM ${this.t.agentInvocations} WHERE node_execution_id = $2`, [at, nodeExecutionId]);
            if (!bool(early[0], "in_time")) {
                await bind("expired");
                return refused("NODE_EXPIRED", false);
            }

            // 4. The result against the state's contract in the run's pinned definition.
            const ir = await this.revisionIrIn(client, run.workflowSessionId, run.revision, run.irSha256, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
            const declared = ir.nodes[node.nodeId];
            if (declared?.type !== "agent" || declared.outputSchema !== invocation.outputSchema) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Agent state ${nodeExecutionId} froze an output contract its state does not declare.`);
            }
            const problems: SchemaProblem[] = [];
            let resultText = "";
            if (kind === "result") {
                const { outcome, output } = value as { outcome: string; output: JsonValue };
                if (!invocation.outcomes.includes(outcome)) {
                    problems.push({ path: "outcome", message: `outcome must be one of ${invocation.outcomes.join(", ")}.` });
                }
                if (invocation.outputSchema !== null) problems.push(...schemaSetFor(run.irSha256, ir.schemaDefs).validate(invocation.outputSchema, output));
                resultText = canonicalJson(output);
                if (utf8ByteLength(resultText) > WORKFLOW_PAYLOAD_MAX_BYTES) {
                    problems.push({ path: "output", message: `output is larger than ${WORKFLOW_PAYLOAD_MAX_BYTES} bytes; store large data as an artifact and give its reference.` });
                }
            } else {
                const { code, message, details } = value as { code: string; message: string; details: JsonValue };
                if (!(AGENT_REPORTED_ERROR_CODES as readonly string[]).includes(code)) {
                    problems.push({ path: "error.code", message: `error.code must be one of ${AGENT_REPORTED_ERROR_CODES.join(", ")}.` });
                }
                if (!message.trim() || message.length > WORKFLOW_V2_AGENT_ERROR_MESSAGE_MAX || !isStorableText(message)) {
                    problems.push({ path: "error.message", message: `error.message must be 1 to ${WORKFLOW_V2_AGENT_ERROR_MESSAGE_MAX} characters of text.` });
                }
                if (utf8ByteLength(canonicalJson(details)) > WORKFLOW_V2_AGENT_ERROR_DETAILS_MAX_BYTES) {
                    problems.push({ path: "error.details", message: `error.details must be at most ${WORKFLOW_V2_AGENT_ERROR_DETAILS_MAX_BYTES} bytes of JSON.` });
                }
                resultText = canonicalJson({ code, message: message.trim(), ...(details !== null ? { details } : {}) });
            }
            if (problems.length > 0) {
                const fields = problems.map(problem => ({ path: problem.path, message: problem.message }));
                const { rows: invalid } = await client.query(
                    `SELECT count(*)::int AS n FROM ${this.t.agentCompletions} WHERE node_execution_id = $1 AND outcome = 'invalid'`, [nodeExecutionId]);
                const used = int(invalid[0], "n") + 1;
                if (used < WORKFLOW_V2_AGENT_MAX_INVALID_COMPLETIONS) {
                    await bind("invalid", { code: "OUTPUT_INVALID", problems: fields });
                    return refused("OUTPUT_INVALID", false, fields, WORKFLOW_V2_AGENT_MAX_INVALID_COMPLETIONS - used);
                }
                // The correction budget is spent: the state fails invalid_output (its agent decided it).
                const errorText = canonicalJson({ code: "invalid_output",
                    message: `The agent gave ${used} completions that did not match the state's contract.`, details: { problems: fields } });
                const { rows: failed } = await client.query(
                    `UPDATE ${this.t.nodes}
                        SET state = 'completed', outcome = 'invalid_output', result_kind = 'runtime_error', output = NULL, error = $2, winner = 'agent',
                            completed_at = $3::timestamptz
                      WHERE node_execution_id = $1 AND state = 'pending' RETURNING *`, [nodeExecutionId, errorText, at]);
                if (!failed[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Agent state ${nodeExecutionId} changed under its lock.`);
                await bind("invalid", { code: "OUTPUT_ATTEMPTS_EXHAUSTED", problems: fields });
                await this.project(client, { sessionId: run.workflowSessionId, update: { touch: true }, events: [{ eventType: "workflow.state_failed", data: {
                    runId: run.runId, nodeExecutionId, stateId: node.nodeId, step: node.ordinal, outcome: "invalid_output", resultKind: "runtime_error",
                    childSessionId: invocation.childSessionId, error: redactErrorThenClip(errorText, 2_000),
                } }] });
                return { ...refused("OUTPUT_ATTEMPTS_EXHAUSTED", false, fields, 0),
                    state: { status: "completed" as const, outcome: "invalid_output", winner: "agent" } };
            }

            // 5. The result decides the state. An agent's error is stored with its secrets hidden (SF-6 verification); the
            // operation's hash stays the hash of what the agent sent, so its repeat is still recognized.
            const outcome = kind === "result" ? (value as { outcome: string }).outcome : (value as { code: string }).code;
            const resultKind: NodeResultKind = kind === "result" ? "business" : "runtime_error";
            const storedText = storedResultText({ resultKind, valueText: resultText });
            const { rows: completed } = await client.query(
                `UPDATE ${this.t.nodes}
                    SET state = 'completed', outcome = $2, result_kind = $3,
                        output = CASE WHEN $3 = 'business' THEN $4 END, error = CASE WHEN $3 = 'runtime_error' THEN $4 END,
                        winner = 'agent', completed_at = $5::timestamptz
                  WHERE node_execution_id = $1 AND state = 'pending' RETURNING *`,
                [nodeExecutionId, outcome, resultKind, storedText, at]);
            if (!completed[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Agent state ${nodeExecutionId} changed under its lock.`);
            const receipt: WorkflowAgentCompletionReceipt = {
                nodeExecutionId, workflowSessionId: run.workflowSessionId, runId: run.runId, stateId: node.nodeId, childSessionId: invocation.childSessionId,
                operationId, kind, outcome, resultSha256, decidedAt: atIso,
            };
            await bind("decided", null, receipt);
            await this.project(client, { sessionId: run.workflowSessionId, update: { touch: true }, events: [{
                eventType: resultKind === "business" ? "workflow.state_completed" : "workflow.state_failed", data: {
                    runId: run.runId, nodeExecutionId, stateId: node.nodeId, step: node.ordinal, outcome, resultKind,
                    childSessionId: invocation.childSessionId, operationId,
                    ...(resultKind === "business" ? { outputPreview: jsonbSafeText(storedText, 1_000) } : { error: jsonbSafeText(storedText, 2_000) }),
                } }] });
            return { kind: "accepted" as const, replayed: false, receipt, controllerInstanceId };
        });
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
            return { ended: true, run: await this.endRunIn(client, run, input) };
        });
    }

    /**
     * finishRun's end of `run`, in the caller's transaction, which holds the session and run locks and found the run live
     * and active: the run's terminal columns, its terminal node, its pending node executions and its pending sends to
     * workflows, and the projection. Returns the ended run.
     */
    private async endRunIn(client: PoolClient, run: WorkflowRunRow, input: {
        status: "completed" | "failed" | "cancelled";
        terminalNodeId: string | null;
        terminalOutcome: string | null;
        outputText: string | null;
        errorText: string | null;
        endPending: { winner: "cancel" | "controller"; message: string };
        terminalNode?: { nodeExecutionId: string; result: NodeResultInput } | null;
        projection?: SessionProjection;
    }): Promise<WorkflowRunRow> {
        const { rows } = await client.query(
            `UPDATE ${this.t.runs}
                SET status = $2, terminal_node_id = $3, terminal_outcome = $4, terminal_output = $5, terminal_error = $6,
                    paused_from = NULL, updated_at = now(), finished_at = now()
              WHERE run_id = $1 RETURNING *`,
            [run.runId, input.status, input.terminalNodeId, input.terminalOutcome, input.outputText,
                input.errorText === null ? null : redactWorkflowErrorText(input.errorText, canonicalJson)]);
        if (input.terminalNode) {
            const { result } = input.terminalNode;
            await client.query(
                `UPDATE ${this.t.nodes}
                    SET state = 'completed', outcome = $2, result_kind = $3,
                        output = CASE WHEN $3 = 'business' THEN $4 END,
                        error = CASE WHEN $3 = 'runtime_error' THEN $4 END,
                        winner = $5, completed_at = now()
                  WHERE node_execution_id = $1 AND run_id = $6 AND state = 'pending'`,
                [input.terminalNode.nodeExecutionId, result.outcome, result.resultKind, storedResultText(result), result.winner, run.runId]);
        }
        await client.query(
            `UPDATE ${this.t.nodes}
                SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error', error = $2, output = NULL,
                    winner = $3, completed_at = now()
              WHERE run_id = $1 AND state = 'pending'`,
            [run.runId, canonicalJson({ code: "cancelled", message: input.endPending.message }), input.endPending.winner]);
        await this.decidePendingSendsIn(client, run.workflowSessionId, run.runId);
        await this.project(client, input.projection, run);
        return runFrom(rows[0]);
    }

    /**
     * S7-DX2 (durable lifecycle intent): end a begun active run for an accepted cancel or done, in the caller's transaction
     * under the session and run locks, exactly as the controller's cancel activity ends it (finishRun's end: cancelled,
     * every pending node execution cancelled with winner cancel, pending sends decided, workflow.cancelled). Its terminal
     * error records the command, who asked (so the parent is not told of its own command) and the operation that was
     * accepted. The controller then finds the run ended at its next store call and does its post-end work (observeEnd).
     * `repaired` marks a cancel or done an older build accepted and only queued, applied when its request is repeated.
     */
    private async endRunForCommandIn(client: PoolClient, run: WorkflowRunRow,
        input: { command: "cancel" | "done"; reason: string; requestedBy: string | null; operationId: string; repaired?: boolean; actor?: WorkflowActor })
        : Promise<WorkflowRunRow> {
        const marks: { [key: string]: JsonValue } = { accepted: true, operationId: input.operationId, ...(input.repaired ? { repaired: true } : {}) };
        return this.endRunIn(client, run, {
            status: "cancelled", terminalNodeId: null, terminalOutcome: null, outputText: null,
            // SF-6 verification: the reason is a person's or an agent's text; its secrets are hidden before it is stored.
            errorText: canonicalJson({ code: "cancelled", message: redactThenClip(input.reason, 4_000), details: {
                command: input.command, requestedBy: input.requestedBy, ...marks,
            } }),
            endPending: { winner: "cancel", message: "The workflow run was cancelled." },
            projection: { sessionId: run.workflowSessionId, events: [{ eventType: "workflow.cancelled", data: {
                runId: run.runId, reason: redactThenClip(input.reason, 500), command: input.command, ...marks,
                ...(input.actor ? { actor: actorJson(input.actor) } : {}),
            } }], update: { state: "cancelled", lastError: redactThenClip(input.reason, 500), touch: true } },
        });
    }
    /**
     * End a stopping run stopped (migration 0100; its controller, 1.9.0,
     * asks): in one transaction under the session and run locks, with one
     * reading of the store's clock, kept as exact SQL text, deciding. When no
     * work of the run is pending (a parallel state's own node execution waits
     * on its branches and is not work), or that reading is at or after
     * the stop's deadline, the run ends stopped: every node execution still
     * pending is cancelled with winner `stop` (the grace expired when work was
     * still pending), a message
     * one of its send states sent to a workflow and still pending is decided
     * with it (decidePendingSendsIn), and the run's terminal error records
     * the stop (code stopped, its request, whether the grace expired, and
     * which node executions it cancelled), with the projection
     * `projection` builds. Before the deadline, with work still pending, it
     * changes nothing and reports the milliseconds left (at least 1). A run
     * that has ended, or whose session was deleted, is returned as it is
     * (inactive): the first run end stands.
     */
    async finishStoppedRun(input: {
        runId: string;
        projection: (ended: { run: WorkflowRunRow; graceExpired: boolean; cancelled: string[] }) => SessionProjection;
    }): Promise<{ result: "ended"; run: WorkflowRunRow; graceExpired: boolean; cancelled: string[] }
        | { result: "not_due"; remainingMs: number }
        | { result: "inactive"; run: WorkflowRunRow }> {
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfRun(client, input.runId));
            const run = await this.lockRun(client, input.runId);
            if (!live || !ACTIVE_RUN_STATUSES.includes(run.status)) return { result: "inactive" as const, run };
            if (run.stop === null) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Run ${run.runId} has no stop to finish.`);
            const { rows: clock } = await client.query(
                `SELECT reading.at::text AS at, reading.at >= run.stop_deadline_at AS due,
                        GREATEST(1, CEIL(EXTRACT(EPOCH FROM (run.stop_deadline_at - reading.at)) * 1000))::bigint AS remaining_ms
                   FROM (SELECT clock_timestamp() AS at) AS reading, ${this.t.runs} AS run WHERE run.run_id = $1`, [run.runId]);
            const at = str(clock[0], "at");
            // A parallel state (IR 8) waits on its branches' node executions, not on work of its own: it neither holds the
            // stop past their settling nor counts as an expired grace; it is cancelled with what is pending when the run ends.
            const { rows: pendingRows } = await client.query(
                `SELECT node_execution_id, node_type FROM ${this.t.nodes} WHERE run_id = $1 AND state = 'pending' ORDER BY node_execution_id FOR UPDATE`, [run.runId]);
            const cancelled = pendingRows.map(row => str(row, "node_execution_id"));
            const working = pendingRows.filter(row => str(row, "node_type") !== "parallel").length;
            if (working > 0 && clock[0].due !== true) return { result: "not_due" as const, remainingMs: int(clock[0], "remaining_ms") };
            const graceExpired = working > 0;
            if (cancelled.length > 0) {
                await client.query(
                    `UPDATE ${this.t.nodes}
                        SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error',
                            error = CASE WHEN node_type = 'parallel' THEN $4 ELSE $2 END, output = NULL,
                            winner = 'stop', completed_at = $3::timestamptz
                      WHERE run_id = $1 AND state = 'pending'`,
                    [run.runId, canonicalJson({ code: "cancelled", message: "The run's stop ended its grace period before this state finished." }), at,
                        canonicalJson({ code: "cancelled", message: "The run stopped before this parallel state joined its branches." })]);
            }
            const stop = run.stop;
            // SF-6 verification: the stop's reason is stored with its secrets hidden.
            const errorText = redactWorkflowErrorText(canonicalJson({ code: "stopped", message: redactThenClip(stop.reason ?? "Stopped", 4_000), details: {
                operationId: stop.operationId, actor: stop.actor, graceSeconds: stop.graceSeconds,
                requestedAt: stop.requestedAt.toISOString(), deadlineAt: stop.deadlineAt.toISOString(),
                graceExpired, cancelledCount: cancelled.length, cancelled: cancelled.slice(0, 100),
            } }), canonicalJson);
            const { rows } = await client.query(
                `UPDATE ${this.t.runs}
                    SET status = 'stopped', terminal_node_id = NULL, terminal_outcome = NULL, terminal_output = NULL, terminal_error = $2,
                        paused_from = NULL, updated_at = now(), finished_at = $3::timestamptz
                  WHERE run_id = $1 RETURNING *`,
                [run.runId, errorText, at]);
            await this.decidePendingSendsIn(client, run.workflowSessionId, run.runId);
            const ended = { run: runFrom(rows[0]), graceExpired, cancelled };
            await this.project(client, input.projection(ended), run);
            return { result: "ended" as const, ...ended };
        });
    }

    /**
     * Whether a run's deadline (migration 0104) has passed by its own clock: a
     * test run's virtual clock, else the store's clock. Only a run with a
     * deadline is asked (a schema before migration 0104 has no such column).
     */
    private async runExpiredIn(client: PoolClient, runId: string): Promise<boolean> {
        const { rows } = await client.query(
            `SELECT deadline_at IS NOT NULL AND deadline_at <= COALESCE(virtual_now, clock_timestamp()) AS expired FROM ${this.t.runs} WHERE run_id = $1`, [runId]);
        return rows[0]?.expired === true;
    }

    /** runExpiredIn outside a transaction (controller 1.9.0's collection reports it). False for a run without a deadline. */
    async isRunExpired(run: Pick<WorkflowRunRow, "runId" | "deadlineAt">): Promise<boolean> {
        if (run.deadlineAt === null) return false;
        const { rows } = await this.pool.query(
            `SELECT deadline_at IS NOT NULL AND deadline_at <= COALESCE(virtual_now, clock_timestamp()) AS expired FROM ${this.t.runs} WHERE run_id = $1`, [run.runId]);
        return rows[0]?.expired === true;
    }

    /**
     * End a run whose deadline passed (migration 0104; limits.timeoutSeconds,
     * onExceeded expired; its controller, 1.9.0, asks): in one transaction
     * under the session and run locks, with one reading of the run's clock (a
     * test run's virtual clock, else the store's clock) deciding. At or after
     * the deadline the run ends failed with timed_out, paused or stopping or
     * not: every node execution still pending is cancelled with winner
     * `deadline`, a message one of its send states sent to a workflow and
     * still pending is decided with it (decidePendingSendsIn), and the run's
     * terminal error records the deadline (its seconds, the time, and which
     * node executions it cancelled), with the projection `projection`
     * builds. Before the deadline it changes nothing and reports the
     * milliseconds left by that clock (at least 1). A run that has ended, or
     * whose session was deleted, is returned as it is (inactive): the first
     * run end stands.
     */
    async expireRun(input: {
        runId: string;
        timeoutSeconds: number;
        projection: (ended: { run: WorkflowRunRow; cancelled: string[] }) => SessionProjection;
    }): Promise<{ result: "ended"; run: WorkflowRunRow; cancelled: string[] }
        | { result: "not_due"; remainingMs: number }
        | { result: "inactive"; run: WorkflowRunRow }> {
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfRun(client, input.runId));
            const run = await this.lockRun(client, input.runId);
            if (!live || !ACTIVE_RUN_STATUSES.includes(run.status)) return { result: "inactive" as const, run };
            if (run.deadlineAt === null) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Run ${run.runId} has no deadline to expire.`);
            const { rows: clock } = await client.query(
                `SELECT reading.at >= run.deadline_at AS due,
                        GREATEST(1, CEIL(EXTRACT(EPOCH FROM (run.deadline_at - reading.at)) * 1000))::bigint AS remaining_ms
                   FROM ${this.t.runs} AS run, LATERAL (SELECT COALESCE(run.virtual_now, clock_timestamp()) AS at) AS reading
                  WHERE run.run_id = $1`, [run.runId]);
            if (clock[0].due !== true) return { result: "not_due" as const, remainingMs: int(clock[0], "remaining_ms") };
            const { rows: pendingRows } = await client.query(
                `SELECT node_execution_id FROM ${this.t.nodes} WHERE run_id = $1 AND state = 'pending' ORDER BY node_execution_id FOR UPDATE`, [run.runId]);
            const cancelled = pendingRows.map(row => str(row, "node_execution_id"));
            if (cancelled.length > 0) {
                await client.query(
                    `UPDATE ${this.t.nodes}
                        SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error', error = $2, output = NULL,
                            winner = 'deadline', completed_at = clock_timestamp()
                      WHERE run_id = $1 AND state = 'pending'`,
                    [run.runId, canonicalJson({ code: "cancelled", message: "The run reached its deadline before this state finished." })]);
            }
            const errorText = canonicalJson({ code: "timed_out", message: `The run reached its deadline (limits.timeoutSeconds ${input.timeoutSeconds}) before it ended.`,
                details: { limit: "timeoutSeconds", timeoutSeconds: input.timeoutSeconds, onExceeded: "expired", deadlineAt: run.deadlineAt.toISOString(),
                    stopping: run.stop !== null, paused: run.status === "paused", cancelledCount: cancelled.length, cancelled: cancelled.slice(0, 100) } });
            const { rows } = await client.query(
                `UPDATE ${this.t.runs}
                    SET status = 'failed', terminal_node_id = NULL, terminal_outcome = NULL, terminal_output = NULL, terminal_error = $2,
                        paused_from = NULL, updated_at = now(), finished_at = clock_timestamp()
                  WHERE run_id = $1 RETURNING *`,
                [run.runId, errorText]);
            await this.decidePendingSendsIn(client, run.workflowSessionId, run.runId);
            const ended = { run: runFrom(rows[0]), cancelled };
            await this.project(client, input.projection(ended), run);
            return { result: "ended" as const, ...ended };
        });
    }

    /**
     * Cancel the other branches of a parallel state whose failFast policy
     * met a branch that did not succeed (controller 1.9.0; IR 8): in one
     * transaction under the session and run locks, every node execution of
     * these branch scopes still pending is decided cancelled (winner
     * `fail_fast`), and a message one of their send states sent to a workflow
     * and still pending is decided with it (decidePendingSendsIn). IR 9: with
     * `reason` join, the branches still running when a join of the first k
     * had its successes (winner `join`); with `reason` timeout, those the
     * state's own time limit cut (winner `join_timeout`; elapseParallelNode
     * already decided their work). A terminal is never cancelled (as in
     * cancelBranchWorkIn): it records the end of work stored before, and its
     * branch's end decides it. A result that won its node's
     * compare-and-swap first stands. Returns every node execution of these
     * scopes that any of these cancellations decided, this call's and an
     * earlier one's, with why, so a retry still asks their effects to stop;
     * and every agent state of these scopes decided otherwise whose child's
     * end is still owed (review R3-PS1), with this call's reason.
     * A run that has ended, or whose session was deleted, changes nothing
     * here: its end decided what was pending.
     */
    async cancelBranchScopes(input: { runId: string; scopeIds: string[]; reason?: BranchCancelReason;
        projection?: (cancelled: string[], scopeIds: string[], names: string[] | null) => SessionProjection })
        : Promise<{ active: boolean; cancelled: Array<{ nodeExecutionId: string; nodeType: string; reason: BranchCancelReason }> }> {
        const reason = input.reason ?? "failFast";
        // Review NB-R1: the branches' names, read before and outside the cut's transaction; never its cause to fail.
        const names = await this.branchNamesBefore(input.runId, input.scopeIds);
        return this.transaction(async client => {
            const workflowSessionId = await this.workflowOfRun(client, input.runId);
            const live = await this.lockLiveSession(client, workflowSessionId);
            const run = await this.lockRun(client, input.runId);
            const active = live && ACTIVE_RUN_STATUSES.includes(run.status);
            if (active && input.scopeIds.length > 0) {
                const { rows: decided } = await client.query(
                    `UPDATE ${this.t.nodes}
                        SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error', error = $3, output = NULL,
                            winner = $4, completed_at = clock_timestamp()
                      WHERE run_id = $1 AND scope_id = ANY($2::text[]) AND state = 'pending' AND node_type <> 'terminal'
                      RETURNING node_execution_id, scope_id`,
                    [input.runId, input.scopeIds, canonicalJson(branchCancelError(reason)), BRANCH_CANCEL_WINNERS[reason]]);
                const now = decided.map(row => str(row, "node_execution_id")).sort();
                if (now.length > 0) {
                    await this.decidePendingSendsIn(client, workflowSessionId, input.runId, now);
                    // The branches whose work this cancelled, in the order named (J1d): a branch that had already ended is not one.
                    // IR 11: named branches by their names too.
                    const cut = new Set(decided.map(row => str(row, "scope_id")));
                    const scopes = input.scopeIds.filter(scopeId => cut.has(scopeId));
                    await this.project(client, input.projection?.(now, scopes, branchScopeNameList(scopes, names)));
                }
            }
            // Review R3-PS1: also the cut scopes' agent states decided otherwise (by their agent, their own time limit) whose
            // child's end is still owed (as listOwedAgentInvocations reads it): the cut drops their cursors, so no collection
            // would end their children; the caller ends them with the cancelled ones (and owes the branch while it cannot).
            const { rows } = await client.query(
                `SELECT n.node_execution_id, n.node_type, n.winner FROM ${this.t.nodes} n
                  WHERE n.run_id = $1 AND n.scope_id = ANY($2::text[])
                    AND (n.winner = ANY($3::text[])
                      OR (n.node_type = 'agent' AND n.state = 'completed' AND EXISTS (SELECT 1 FROM ${this.t.agentInvocations} i
                            WHERE i.node_execution_id = n.node_execution_id
                              AND (i.end_sent_at IS NULL OR (i.end_child_status = 'NotFound' AND i.spawn_attempts > 0)))))
                  ORDER BY n.node_execution_id`,
                [input.runId, input.scopeIds, BRANCH_CANCEL_WINNER_VALUES]);
            return { active, cancelled: rows.map(row => {
                const winner = strOrNull(row, "winner");
                return { nodeExecutionId: str(row, "node_execution_id"), nodeType: str(row, "node_type"),
                    reason: winner !== null && BRANCH_CANCEL_WINNER_VALUES.includes(winner) ? branchCancelReasonOf(winner) : reason };
            }) };
        });
    }

    /**
     * A parallel state's own time limit (IR 9; controller 1.9.0; owner
     * decision join-k-of-n with formal questions Q1 to Q3 and finding H1), as
     * elapseWait is a wait's: in one transaction under the session and run
     * locks (an admission's order, so no branch state is admitted between
     * this reading and what it decides), one reading of the store's clock
     * decides. Before the deadline it changes nothing and reports the
     * milliseconds left (at least 1). At or after it, while the state is
     * pending, the store's one count decides (settleParallelIn): with k
     * successes committed by the deadline, admitted or not, the join is due
     * (join_due: nothing is decided, and the work its branches still run is
     * cancelled, because it can no longer count; its controller admits the
     * winners' terminals and joins). With fewer, the state is decided blocked
     * when k could no longer happen by then (Q3; its report says timedOut),
     * else timed_out with its report; the work its branches still run is
     * cancelled either way (winner join_timeout). A join, a run end or a
     * deletion that decided the state first is kept (decided). `projection`
     * gives the state's own events from what was decided; it is required, so
     * no caller in the product decides the state without its event (JK-09).
     * Store tests in plain JavaScript may leave it out to check a decision
     * alone.
     */
    async elapseParallelNode(nodeExecutionId: string, projection: (decided: ParallelSettled) => SessionProjection): Promise<
        { result: "elapsed" | "join_due"; node: WorkflowNodeExecutionRow; cancelled: string[] } | { result: "decided"; node: WorkflowNodeExecutionRow }
        | { result: "not_due"; remainingMs: number; node: WorkflowNodeExecutionRow }> {
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfNode(client, nodeExecutionId));
            const { rows: found } = await client.query(`SELECT run_id FROM ${this.t.nodes} WHERE node_execution_id = $1`, [nodeExecutionId]);
            if (!found[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Node execution ${nodeExecutionId} does not exist.`);
            const run = await this.lockRun(client, str(found[0], "run_id"));
            const { rows } = await client.query(
                `SELECT *, deadline_at <= clock_timestamp() AS due,
                        GREATEST(1, CEIL(EXTRACT(EPOCH FROM (deadline_at - clock_timestamp())) * 1000))::bigint AS remaining_ms
                   FROM ${this.t.nodes} WHERE node_execution_id = $1 FOR UPDATE`, [nodeExecutionId]);
            const node = nodeFrom(rows[0]);
            if (node.nodeType !== "parallel") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${nodeExecutionId} is not a parallel state.`);
            // The deletion that made the session not live also decided its pending work (migration 0090 trigger).
            if (node.state === "completed" || !live) return { result: "decided" as const, node };
            if (node.deadlineAt === null) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Parallel state ${nodeExecutionId} has no time limit.`);
            }
            if (rows[0].due !== true) return { result: "not_due" as const, remainingMs: int(rows[0], "remaining_ms"), node };
            const settled = await this.settleParallelIn(client, run, node, { timeLimit: true, notStarted: new Set() });
            // Review NB-R2: a named fork of a stopping run is held: its time limit decides nothing; asked again at the stop's
            // deadline, by when the stop has ended the run.
            if (settled.held === true) {
                const { rows: left } = await client.query(
                    `SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (stop_deadline_at - clock_timestamp())) * 1000))::bigint AS remaining_ms
                       FROM ${this.t.runs} WHERE run_id = $1`, [run.runId]);
                return { result: "not_due" as const, remainingMs: int(left[0], "remaining_ms"), node };
            }
            if (settled.decided === null) return { result: "join_due" as const, node: settled.node, cancelled: settled.cancelled };
            await this.project(client, projection?.(settled.decided));
            return { result: "elapsed" as const, node: settled.node, cancelled: settled.cancelled };
        });
    }

    /**
     * Decide the join of a parallel state of IR 9 (a join of the first k, or
     * a join with its own time limit; controller 1.9.0), which its controller
     * asks for whenever a branch ends: in one transaction under the session
     * and run locks and the state's row, the store's one count decides, the
     * same count its time limit uses (settleParallelIn; formal finding H1).
     * Joined when k successes committed by the deadline (every branch for a
     * join of all) were each admitted and decided at their terminal: the
     * output is `joined`'s for `[{ index, output }]` of the first k in commit
     * order (completed_at, ties by branch index), or for every branch's
     * output in index order; the branches still running are cancelled for the
     * join. Blocked when k can no longer happen and either failFast holds (the
     * others are cancelled at once) or every branch ended (`notStarted`: the
     * branches its controller will never start). Past the deadline: joined
     * as above, else join due (the work still running is cancelled; wait),
     * else blocked (Q3, timedOut) or timed_out. Otherwise wait: nothing
     * changes. A state decided first (by its time limit, a run end or a
     * deletion) is reported as stored (decided).
     */
    async decideParallelJoin(input: {
        nodeExecutionId: string;
        notStarted: readonly number[];
        joined: (output: JsonValue) => NodeResultInput;
        /** The state's own events from what was decided; required, as elapseParallelNode's (JK-09). */
        projection: (decided: ParallelSettled) => SessionProjection;
    }): Promise<{ result: "decided" | "won" | "wait"; node: WorkflowNodeExecutionRow; cancelled: string[] }> {
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfNode(client, input.nodeExecutionId));
            const { rows: found } = await client.query(`SELECT run_id FROM ${this.t.nodes} WHERE node_execution_id = $1`, [input.nodeExecutionId]);
            if (!found[0]) throw new WorkflowStoreError("NODE_NOT_FOUND", `Node execution ${input.nodeExecutionId} does not exist.`);
            const run = await this.lockRun(client, str(found[0], "run_id"));
            const { rows } = await client.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id = $1 FOR UPDATE`, [input.nodeExecutionId]);
            const node = nodeFrom(rows[0]);
            if (node.nodeType !== "parallel") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} is not a parallel state.`);
            if (node.state === "completed" || !live) return { result: "decided" as const, node, cancelled: [] };
            const settled = await this.settleParallelIn(client, run, node, { timeLimit: false, notStarted: new Set(input.notStarted), joined: input.joined });
            if (settled.decided === null) return { result: "wait" as const, node: settled.node, cancelled: settled.cancelled };
            await this.project(client, input.projection?.(settled.decided));
            return { result: "won" as const, node: settled.node, cancelled: settled.cancelled };
        });
    }

    /**
     * The store's one count for a parallel state's join and its time limit
     * (IR 9), in the caller's transaction (which holds the session and run
     * locks, and the state's row, pending): every node execution of its
     * branch scopes is read with its place in the store's commit order and
     * whether it was committed at or before the state's deadline
     * (parallelBranchesIn), and parallelVerdict decides. A decision cancels
     * the work its branches still run (never a terminal, which records the
     * end of work stored before), for the join, failFast or the time limit,
     * with their messages to workflows; it reads every branch again for the
     * report, and decides the state by compare-and-swap (a joined state's
     * output is `joined`'s). join_due cancels that work and decides nothing;
     * wait changes nothing.
     */
    private async settleParallelIn(client: PoolClient, run: WorkflowRunRow, node: WorkflowNodeExecutionRow,
        input: { timeLimit: boolean; notStarted: ReadonlySet<number>; joined?: (output: JsonValue) => NodeResultInput })
        : Promise<{ node: WorkflowNodeExecutionRow; cancelled: string[]; decided: ParallelSettled | null; held?: true }> {
        const total = Array.isArray(node.input) ? node.input.length : 0;
        const scopeIds = branchScopeIds(node.nodeExecutionId, total);
        const ir = await this.revisionIrIn(client, run.workflowSessionId, run.revision, run.irSha256, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
        const parallel = ir.nodes[node.nodeId];
        if (parallel?.type !== "parallel") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `State ${node.nodeId} of run ${run.runId} is not a parallel state.`);
        // Review NB-R2 (IR 11, a named fork): after an accepted graceful stop (the caller holds the run's lock) nothing settles
        // the fork, neither its join nor its own time limit: its started branches' work runs to its own deadlines, nothing of
        // theirs is cut, and no report is written; the stop's end cancels the pending fork (finishStoppedRun). A For each
        // keeps its recorded behaviour.
        if (run.stop !== null && parallel.branches !== undefined) return { node, cancelled: [], decided: null, held: true };
        // The run's clock: a test run's virtual clock, else the store's.
        const { rows: clock } = await client.query(
            `SELECT parallel.deadline_at IS NOT NULL AND parallel.deadline_at <= COALESCE(run.virtual_now, clock_timestamp()) AS past
               FROM ${this.t.nodes} AS parallel JOIN ${this.t.runs} AS run ON run.run_id = parallel.run_id
              WHERE parallel.node_execution_id = $1`, [node.nodeExecutionId]);
        const pastDeadline = clock[0]?.past === true;
        if (input.timeLimit && !pastDeadline) {
            throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Parallel state ${node.nodeExecutionId} was timed before its deadline.`);
        }
        const read = () => this.parallelBranchesIn(client, run, node, ir, total, scopeIds, input.notStarted);
        const verdict = parallelVerdict({ join: parallel.join, failFast: parallel.failFast, total, branches: await read(), pastDeadline, timeLimit: input.timeLimit });
        if (verdict.kind === "wait") return { node, cancelled: [], decided: null };
        const reason: BranchCancelReason = verdict.kind === "joined" ? "join" : verdict.kind === "blocked" ? verdict.cancel : "timeout";
        // J1d: only the branches still running are cut. A winner is never one of them: it ends at its terminal (a joined
        // state's winners were decided there; a join due admits their terminals next).
        const winners = new Set(verdict.kind === "joined" ? verdict.winners.map(branch => branch.index) : verdict.kind === "join_due" ? verdict.winners : []);
        const cancelled = await this.cancelBranchWorkIn(client, run, scopeIds.filter((_, index) => !winners.has(index)), reason,
            { nodeExecutionId: node.nodeExecutionId, node: parallel });
        if (verdict.kind === "join_due") return { node, cancelled, decided: null };
        const branches = await read();
        const succeeded = parallelSuccesses(branches).length;
        let result: NodeResultInput;
        if (verdict.kind === "joined") {
            if (input.joined === undefined) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Parallel state ${node.nodeExecutionId} was joined by its time limit.`);
            // IR 11: a named-branch state's output is { <name>: output }.
            result = input.joined(parallelJoinedOutput(parallel, verdict.winners.map(branch => ({ index: branch.index, output: branch.row?.output ?? null }))));
        } else {
            const ends = branches.map(parallelBranchEnd);
            result = verdict.kind === "timed_out" ? parallelTimeoutResult(parallel, total, ends, succeeded)
                : parallelBlockedResult(parallel, total, ends, verdict.timedOut, succeeded);
        }
        const { rows } = await client.query(
            `UPDATE ${this.t.nodes}
                SET state = 'completed', outcome = $2, result_kind = $3,
                    output = CASE WHEN $3 = 'business' THEN $4 END,
                    error = CASE WHEN $3 = 'runtime_error' THEN $4 END,
                    winner = $5, completed_at = clock_timestamp()
              WHERE node_execution_id = $1 AND state = 'pending' RETURNING *`,
            // The controller's own parallel report: its finished branches' business outputs are kept (R3-SF-3, S6-SF2).
            [node.nodeExecutionId, result.outcome, result.resultKind, storedResultText(result, { parallelReport: true }), result.winner]);
        if (!rows[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Parallel state ${node.nodeExecutionId} was decided under its lock.`);
        return { node: nodeFrom(rows[0]), cancelled, decided: { result, total, succeeded, cancelled } };
    }

    /**
     * Every node execution of a parallel state's branch scopes, as
     * parallelBranchStates reads them: each stored result's rank in the
     * store's commit order (completed_at; equal times share a rank) and
     * whether it was committed at or before the state's deadline (always
     * without one, and on a test run's virtual clock, whose deadline every
     * result committed before the advance that reached it precedes).
     */
    private async parallelBranchesIn(client: PoolClient, run: WorkflowRunRow, node: WorkflowNodeExecutionRow, ir: WorkflowIR, total: number,
        scopeIds: string[], notStarted: ReadonlySet<number>): Promise<ParallelBranchState[]> {
        if (scopeIds.length === 0) return [];
        const { rows } = await client.query(
            `SELECT branch.*, dense_rank() OVER (ORDER BY branch.completed_at) AS commit_rank,
                    (parallel.deadline_at IS NULL OR branch.completed_at <= parallel.deadline_at) AS in_time
               FROM ${this.t.nodes} AS branch JOIN ${this.t.nodes} AS parallel ON parallel.node_execution_id = $3
              WHERE branch.run_id = $1 AND branch.scope_id = ANY($2::text[])`, [run.runId, scopeIds, node.nodeExecutionId]);
        const committed = new Map<string, ParallelCommit>();
        for (const row of rows) {
            if (row.completed_at !== null) committed.set(str(row, "node_execution_id"), { rank: Number(row.commit_rank), inTime: row.in_time === true });
        }
        return parallelBranchStates(ir, node.nodeExecutionId, total, rows.map(row => nodeFrom(row)), committed, notStarted);
    }

    /**
     * Cancel the work a parallel state's branches still run, in the caller's
     * transaction, for `reason` (its winner says why): every pending node
     * execution of these scopes except a terminal, with their pending
     * messages to workflows (decidePendingSendsIn); a
     * workflow.branches_cancelled event names them. Returns them.
     */
    /**
     * Review NB-R1: the names of a cancellation's branch scopes, read on their own, before and outside the cancellation's
     * transaction, from the run's pinned IR; each scope's from its own fork (branchScopeNames), never from the first
     * scope's, so the cuts of two forks never mix names (retryOwedCuts asks for several forks' scopes at once). They only
     * label its event: a failure to read them (a stored shape this reader refuses, unreadable JSON, a query that fails) is
     * logged and leaves them out, and never touches the cut.
     */
    private async branchNamesBefore(runId: string, scopeIds: string[]): Promise<Map<string, string>> {
        const forkIds = [...new Set(scopeIds.flatMap(scopeId => {
            const scope = parseBranchScope(scopeId);
            return scope === null ? [] : [scope.parallelNodeExecutionId];
        }))];
        if (forkIds.length === 0) return new Map();
        try {
            return await this.transaction(async client => {
                const { rows } = await client.query(
                    `SELECT node_execution_id, node_id FROM ${this.t.nodes} WHERE run_id = $1 AND node_execution_id = ANY($2::text[])`, [runId, forkIds]);
                if (rows.length === 0) return new Map<string, string>();
                const run = runFrom((await client.query(`SELECT * FROM ${this.t.runs} WHERE run_id = $1`, [runId])).rows[0]);
                const ir = await this.revisionIrIn(client, run.workflowSessionId, run.revision, run.irSha256, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
                return branchScopeNames(scopeIds, new Map(rows.map(row => [str(row, "node_execution_id"), ir.nodes[str(row, "node_id")]])));
            });
        } catch (error) {
            console.warn(`[workflow-v2] run=${runId} forks=${forkIds.join(",")}: the names of the branches to cut were not read, so the cut's event `
                + `names none (the cut goes on): ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
            return new Map();
        }
    }

    private async cancelBranchWorkIn(client: PoolClient, run: WorkflowRunRow, scopeIds: string[], reason: BranchCancelReason,
        fork: { nodeExecutionId: string; node: WorkflowIRNode }): Promise<string[]> {
        if (scopeIds.length === 0) return [];
        const { rows } = await client.query(
            `UPDATE ${this.t.nodes}
                SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error', error = $3, output = NULL,
                    winner = $4, completed_at = clock_timestamp()
              WHERE run_id = $1 AND scope_id = ANY($2::text[]) AND state = 'pending' AND node_type <> 'terminal'
              RETURNING node_execution_id, scope_id`,
            [run.runId, scopeIds, canonicalJson(branchCancelError(reason)), BRANCH_CANCEL_WINNERS[reason]]);
        const cancelled = rows.map(row => str(row, "node_execution_id")).sort();
        if (cancelled.length > 0) {
            await this.decidePendingSendsIn(client, run.workflowSessionId, run.runId, cancelled);
            // J1d: the event names only the branches still running whose work this cut, in index order; a winner, which ended
            // at its terminal, and a branch that had already ended or never started, are not among them.
            const cut = new Set(rows.map(row => str(row, "scope_id")));
            const scopes = scopeIds.filter(scopeId => cut.has(scopeId)).slice(0, 64);
            // IR 11: named branches by their names too (the state's IR node, which settleParallelIn read; each scope's own fork).
            const names = branchScopeNameList(scopes, branchScopeNames(scopes, new Map([[fork.nodeExecutionId, fork.node]])));
            await this.project(client, { sessionId: run.workflowSessionId, events: [{ eventType: "workflow.branches_cancelled", data: {
                runId: run.runId, scopeIds: scopes, cancelledCount: cancelled.length, cancelled: cancelled.slice(0, 64),
                ...(reason !== "failFast" ? { reason } : {}), ...(names !== null ? { branches: names } : {}),
            } }], update: { touch: true } });
        }
        return cancelled;
    }

    // ─── Test runs (migration 0102; design 05 tool-mocked testing) ───

    /**
     * Admit a test run (mode test) of the definition's current revision, once
     * per operation id: exactly the revision and hash the request names,
     * valid, draft or published. It has its own KV, inbox and outbox, runs at
     * controller 1.9.0 under its own controller instance, and its virtual
     * clock starts at WORKFLOW_V2_TEST_EPOCH. Any number of test runs may
     * exist beside the live run, which they never change.
     */
    async startTest(input: {
        workflowSessionId: string;
        expectedRevision: number;
        definitionHash: string;
        operationId: string;
        requestSha256: string;
        start: RunAdmission;
        /** S2RT-F6: a chat's hidden test bench: its chat and definition are checked under their locks before its own rows. */
        bench?: { ownerSessionId: string; definitionId: string } | null;
    }): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
        if (input.start.mode !== "test") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "A test admission must be a test run.");
        return this.transaction(async client => {
            if (input.bench) {
                const prior = await this.priorReceipt(client, input.workflowSessionId, input.operationId, "test", input.requestSha256);
                if (prior) return { receipt: prior, replayed: true };
                await requireBenchLiveLocked(client, this.schema, input.bench);
            }
            await this.requireLiveSession(client, input.workflowSessionId);
            const definition = await this.lockDefinition(client, input.workflowSessionId);
            const prior = await this.priorReceipt(client, input.workflowSessionId, input.operationId, "test", input.requestSha256);
            if (prior) return { receipt: prior, replayed: true };
            assertNotDeleted(definition);
            // of-06 (owner decision): only a draft is tested. A published definition runs live; a change is tested as a new draft.
            if (definition.state !== "draft") {
                throw new WorkflowStoreError("TEST_NEEDS_DRAFT", WORKFLOW_V2_TEST_NEEDS_DRAFT_MESSAGE, { state: definition.state });
            }
            if (definition.currentRevision !== input.expectedRevision) {
                throw new WorkflowStoreError("REVISION_CONFLICT", `The definition is at revision ${definition.currentRevision}, not ${input.expectedRevision}.`,
                    { currentRevision: definition.currentRevision });
            }
            const revision = await this.readRevisionRow(client, input.workflowSessionId, input.expectedRevision);
            if (!revision.valid || !revision.irSha256) {
                throw new WorkflowStoreError("DEFINITION_INVALID", "Revision has compile errors; fix them before testing it.",
                    { diagnostics: diagnosticsJson(revision.diagnostics) });
            }
            if (revision.yamlSha256 !== input.definitionHash) {
                throw new WorkflowStoreError("DEFINITION_HASH_MISMATCH", "The definition hash does not match the revision to test.",
                    { revision: revision.revision, yamlSha256: revision.yamlSha256 });
            }
            const run = await this.insertRun(client, definition, revision, input.start, input.operationId);
            const receipt = this.receiptFor("test", definition, revision, run);
            await this.recordReceipt(client, input.workflowSessionId, input.operationId, "test", input.requestSha256, receipt);
            return { receipt, replayed: false };
        });
    }

    /** A test run's fixtures (migration 0102), as admitted; an empty list for a test run without any. */
    async readTestFixtures(runId: string): Promise<JsonValue> {
        const { rows } = await this.pool.query(`SELECT mode, test_fixtures FROM ${this.t.runs} WHERE run_id = $1`, [runId]);
        if (!rows[0]) throw new WorkflowStoreError("RUN_NOT_FOUND", `Workflow run ${runId} does not exist.`);
        if (str(rows[0], "mode") !== "test") throw new WorkflowStoreError("RUN_NOT_TEST", `Run ${runId} is not a test run.`);
        return jsonOrNull(rows[0], "test_fixtures") ?? [];
    }

    async readInterception(interceptionId: string): Promise<WorkflowTestInterception | null> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.testInterceptions} WHERE interception_id = $1`, [interceptionId]);
        return rows[0] ? interceptionFrom(rows[0]) : null;
    }

    /** A test run's intercepted effects in the order they were reached (bounded). */
    async listInterceptions(runId: string, limit = 200): Promise<WorkflowTestInterception[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.testInterceptions} WHERE run_id = $1 ORDER BY seq LIMIT $2`, [runId, Math.min(Math.max(limit, 1), 1_000)]);
        return rows.map(interceptionFrom);
    }

    /**
     * Record a script's tool call in a test run (design 05): the call's record
     * is written once, by its stable id (the script's n-th call in its node
     * execution); a fixture's response answers it in the same transaction.
     * A repeat (a retried attempt reaching the same call) returns the record
     * as it is; one with other arguments is reported as a mismatch and never
     * answered from the earlier one. The call is refused when the node is no
     * longer pending or the run's limit of interceptions is reached.
     */
    async interceptToolCall(input: {
        runId: string;
        nodeExecutionId: string;
        call: number;
        tool: string;
        argumentsText: string;
        fixture: { kind: WorkflowTestResponseKind; valueText: string } | null;
        projection?: (record: WorkflowTestInterception) => SessionProjection;
    }): Promise<{ record: WorkflowTestInterception; inserted: boolean; mismatch: boolean }> {
        const interceptionId = workflowTestInterceptionId(input.nodeExecutionId, { call: input.call });
        const argumentsSha256 = sha256Hex(input.argumentsText);
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfRun(client, input.runId));
            const run = await this.lockRun(client, input.runId);
            if (run.mode !== "test") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Run ${run.runId} is not a test run.`);
            const { rows: found } = await client.query(`SELECT * FROM ${this.t.testInterceptions} WHERE interception_id = $1`, [interceptionId]);
            if (found[0]) {
                const record = interceptionFrom(found[0]);
                return { record, inserted: false, mismatch: record.argumentsSha256 !== argumentsSha256 || record.tool !== input.tool };
            }
            const { rows: nodes } = await client.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id = $1`, [input.nodeExecutionId]);
            const node = nodes[0] ? nodeFrom(nodes[0]) : null;
            if (!node || node.runId !== run.runId || node.nodeType !== "script") {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} is not a script state of run ${run.runId}.`);
            }
            if (!live || node.state !== "pending" || !ACTIVE_RUN_STATUSES.includes(run.status)) {
                throw new WorkflowStoreError("NODE_CLOSED", `The script's state ${input.nodeExecutionId} was decided; its tool call is not recorded.`);
            }
            const { rows: counted } = await client.query(`SELECT count(*)::int AS n FROM ${this.t.testInterceptions} WHERE run_id = $1`, [run.runId]);
            if (int(counted[0], "n") >= WORKFLOW_V2_TEST_MAX_INTERCEPTIONS) {
                throw new WorkflowStoreError("TEST_INTERCEPTION_LIMIT", `This test run reached its limit of ${WORKFLOW_V2_TEST_MAX_INTERCEPTIONS} intercepted calls.`);
            }
            const fixture = input.fixture;
            const { rows } = await client.query(
                `INSERT INTO ${this.t.testInterceptions}
                    (interception_id, run_id, node_execution_id, operation, tool, arguments, arguments_sha256, response_schema, state,
                     response_kind, response, response_sha256, disposition, virtual_at, created_at, responded_at)
                 SELECT $1, $2, $3, 'tool.call', $4, $5, $6, NULL, $7, $8, $9, $10, $11, virtual_now, clock_timestamp(),
                        CASE WHEN $7 = 'responded' THEN clock_timestamp() END
                   FROM ${this.t.runs} WHERE run_id = $2
                 RETURNING *`,
                [interceptionId, run.runId, input.nodeExecutionId, input.tool, input.argumentsText, argumentsSha256,
                    fixture ? "responded" : "awaiting_parent", fixture?.kind ?? null, fixture?.valueText ?? null,
                    fixture ? testResponseSha256(fixture.kind, fixture.valueText) : null, fixture ? "fixture" : null]);
            const record = interceptionFrom(rows[0]);
            await this.project(client, input.projection?.(record));
            return { record, inserted: true, mismatch: false };
        });
    }

    /**
     * Record a tool call of a real agent in a test run (design 05, agentMode
     * real; R19, R20): a call that the agent state's child, or a session in its
     * subtree, makes through the framework is recorded as that state's next
     * tool call (`<node execution>/call-<n>`) instead of running, and a
     * fixture's response answers it in the same transaction. Only a real-agent
     * test run's pending agent state takes one; a decided state, an ended run
     * or the run's limit of interceptions refuses it, and nothing runs.
     */
    async interceptAgentToolCall(input: {
        runId: string;
        nodeExecutionId: string;
        tool: string;
        argumentsText: string;
        fixture: { kind: WorkflowTestResponseKind; valueText: string } | null;
        projection?: (record: WorkflowTestInterception) => SessionProjection;
    }): Promise<{ record: WorkflowTestInterception }> {
        const argumentsSha256 = sha256Hex(input.argumentsText);
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfRun(client, input.runId));
            const run = await this.lockRun(client, input.runId);
            if (run.mode !== "test" || run.testAgentMode !== "real") {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Run ${run.runId} is not a real-agent test run.`);
            }
            const { rows: nodes } = await client.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id = $1`, [input.nodeExecutionId]);
            const node = nodes[0] ? nodeFrom(nodes[0]) : null;
            if (!node || node.runId !== run.runId || node.nodeType !== "agent") {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} is not an agent state of run ${run.runId}.`);
            }
            if (!live || node.state !== "pending" || !ACTIVE_RUN_STATUSES.includes(run.status)) {
                throw new WorkflowStoreError("NODE_CLOSED", `The agent state ${input.nodeExecutionId} was decided; its tool call is not recorded.`);
            }
            const { rows: counted } = await client.query(
                `SELECT count(*)::int AS n, count(*) FILTER (WHERE node_execution_id = $2 AND operation = 'tool.call')::int AS calls
                   FROM ${this.t.testInterceptions} WHERE run_id = $1`, [run.runId, input.nodeExecutionId]);
            if (int(counted[0], "n") >= WORKFLOW_V2_TEST_MAX_INTERCEPTIONS) {
                throw new WorkflowStoreError("TEST_INTERCEPTION_LIMIT", `This test run reached its limit of ${WORKFLOW_V2_TEST_MAX_INTERCEPTIONS} intercepted calls.`);
            }
            const interceptionId = workflowTestInterceptionId(input.nodeExecutionId, { call: int(counted[0], "calls") + 1 });
            const fixture = input.fixture;
            const { rows } = await client.query(
                `INSERT INTO ${this.t.testInterceptions}
                    (interception_id, run_id, node_execution_id, operation, tool, arguments, arguments_sha256, response_schema, state,
                     response_kind, response, response_sha256, disposition, virtual_at, created_at, responded_at)
                 SELECT $1, $2, $3, 'tool.call', $4, $5, $6, NULL, $7, $8, $9, $10, $11, virtual_now, clock_timestamp(),
                        CASE WHEN $7 = 'responded' THEN clock_timestamp() END
                   FROM ${this.t.runs} WHERE run_id = $2
                 RETURNING *`,
                [interceptionId, run.runId, input.nodeExecutionId, input.tool, input.argumentsText, argumentsSha256,
                    fixture ? "responded" : "awaiting_parent", fixture?.kind ?? null, fixture?.valueText ?? null,
                    fixture ? testResponseSha256(fixture.kind, fixture.valueText) : null, fixture ? "fixture" : null]);
            const record = interceptionFrom(rows[0]);
            await this.project(client, input.projection?.(record));
            return { record };
        });
    }

    /**
     * Answer an intercepted effect of a test run, once (design 05): the same
     * response again is idempotent (replayed), another is TEST_RESPONSE_CONFLICT.
     * An answer to an effect whose state is no longer pending, or of a run
     * that ended, is refused (NODE_CLOSED, RUN_ENDED) and changes nothing.
     * For an agent, send or request, `decide` is the state's result, stored
     * by the node's compare-and-swap in this same transaction.
     */
    async respondInterception(input: {
        workflowSessionId: string;
        runId: string;
        interceptionId: string;
        kind: WorkflowTestResponseKind;
        valueText: string;
        disposition: "parent" | "fixture";
        operationId: string | null;
        actor: WorkflowActor | null;
        decide: NodeResultInput | null;
        projection?: (record: WorkflowTestInterception) => SessionProjection;
    }): Promise<{ replayed: boolean; record: WorkflowTestInterception; node: WorkflowNodeExecutionRow }> {
        if (input.disposition === "parent" && input.actor === null) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "A parent response names its actor.");
        const responseSha256 = testResponseSha256(input.kind, input.valueText);
        return this.transaction(async client => {
            if (!await this.lockLiveSession(client, input.workflowSessionId)) {
                throw new WorkflowStoreError("WORKFLOW_DELETED", `Workflow session ${input.workflowSessionId} was deleted or does not exist.`);
            }
            const run = await this.lockRun(client, input.runId);
            const { rows: found } = await client.query(`SELECT * FROM ${this.t.testInterceptions} WHERE interception_id = $1 FOR UPDATE`, [input.interceptionId]);
            if (!found[0] || run.workflowSessionId !== input.workflowSessionId || str(found[0], "run_id") !== run.runId) {
                throw new WorkflowStoreError("INTERCEPTION_NOT_FOUND", `Interception ${input.interceptionId} is not one of test run ${input.runId}.`);
            }
            const record = interceptionFrom(found[0]);
            const node = await this.nodeIn(client, record.nodeExecutionId);
            if (record.response !== null) {
                if (record.response.sha256 === responseSha256) return { replayed: true, record, node };
                throw new WorkflowStoreError("TEST_RESPONSE_CONFLICT", `Interception ${input.interceptionId} was already answered with another response.`,
                    { responseSha256: record.response.sha256, disposition: record.response.disposition });
            }
            if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
                throw new WorkflowStoreError("RUN_ENDED", `Test run ${run.runId} ended (${run.status}); its open interceptions stay unanswered.`, { status: run.status });
            }
            if (node.state !== "pending") {
                throw new WorkflowStoreError("NODE_CLOSED", `The state of interception ${input.interceptionId} was already decided (${node.outcome}).`,
                    { outcome: node.outcome, winner: node.winner });
            }
            let decided = node;
            if (input.decide !== null) {
                const result = input.decide;
                const { rows: completed } = await client.query(
                    `UPDATE ${this.t.nodes}
                        SET state = 'completed', outcome = $2, result_kind = $3,
                            output = CASE WHEN $3 = 'business' THEN $4 END,
                            error = CASE WHEN $3 = 'runtime_error' THEN $4 END,
                            winner = $5, completed_at = clock_timestamp()
                      WHERE node_execution_id = $1 AND state = 'pending'
                      RETURNING *`,
                    [record.nodeExecutionId, result.outcome, result.resultKind, storedResultText(result), result.winner]);
                if (!completed[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${record.nodeExecutionId} changed under its lock.`);
                decided = nodeFrom(completed[0]);
            }
            // S6-SF2 verification: an error answer that decides the state's runtime error is stored as that error is, with
            // its secrets hidden (unvouched: never a parallel report's exemption). Its sha256 stays the given answer's, so a
            // repeat of it is still recognized. A tool call's answer is what its script receives, and is stored as given.
            const storedResponse = input.kind === "error" && input.decide?.resultKind === "runtime_error"
                ? redactWorkflowErrorText(input.valueText, canonicalJson) : input.valueText;
            const { rows } = await client.query(
                `UPDATE ${this.t.testInterceptions}
                    SET state = 'responded', response_kind = $2, response = $3, response_sha256 = $4, disposition = $5,
                        response_operation_id = $6, responded_by = $7, responded_at = clock_timestamp()
                  WHERE interception_id = $1 AND state = 'awaiting_parent' RETURNING *`,
                [input.interceptionId, input.kind, storedResponse, responseSha256, input.disposition, input.operationId,
                    input.actor === null ? null : canonicalJson(input.actor)]);
            if (!rows[0]) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Interception ${input.interceptionId} changed under its lock.`);
            const answered = interceptionFrom(rows[0]);
            await this.project(client, input.projection?.(answered));
            return { replayed: false, record: answered, node: decided };
        });
    }

    /**
     * Advance a test run's virtual clock (design 05 timer simulation), once
     * per operation id: monotonically, by whole seconds. In the same
     * transaction every pending state of the run whose deadline the new
     * virtual time reached is decided, in deadline order: a wait or a
     * receive's wait elapsed (with the value it was given), an intercepted
     * request or agent timed_out, and (IR 9) a parallel state at its own time
     * limit by the store's one count (settleParallelIn): join due (nothing
     * decided), blocked or timed_out, with its branches' pending work
     * cancelled and not decided again; at one virtual instant a parallel
     * state comes after the other states with its deadline, so their results
     * count toward its join. A result that won first (an injected
     * message, a response, a cancel) stands. Only a test run, while it is
     * active, has a clock to advance.
     */
    async advanceTestClock(input: {
        workflowSessionId: string;
        runId: string;
        seconds: number;
        operationId: string;
        requestSha256: string;
        projection: (advanced: WorkflowTestAdvanceReceipt) => SessionProjection;
    }): Promise<{ receipt: WorkflowTestAdvanceReceipt; replayed: boolean }> {
        if (!Number.isSafeInteger(input.seconds) || input.seconds < 1 || input.seconds > WORKFLOW_V2_TEST_ADVANCE_MAX_SECONDS) {
            throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `seconds must be an integer from 1 to ${WORKFLOW_V2_TEST_ADVANCE_MAX_SECONDS}.`);
        }
        return this.transaction(async client => {
            await this.requireLiveSession(client, input.workflowSessionId);
            const { rows: priorRows } = await client.query(
                `SELECT kind, request_sha256, receipt FROM ${this.t.operations} WHERE workflow_session_id = $1 AND operation_id = $2`,
                [input.workflowSessionId, input.operationId]);
            if (priorRows[0]) {
                if (str(priorRows[0], "kind") !== "test_advance" || str(priorRows[0], "request_sha256") !== input.requestSha256) {
                    throw new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${input.operationId} was already used for a different request.`,
                        { operationId: input.operationId, storedKind: str(priorRows[0], "kind") });
                }
                return { receipt: parseTestAdvanceReceipt(parseStoredJson(str(priorRows[0], "receipt"), "receipt")), replayed: true };
            }
            const run = await this.lockRun(client, input.runId);
            if (run.workflowSessionId !== input.workflowSessionId) throw new WorkflowStoreError("RUN_NOT_FOUND", `Run ${input.runId} is not a run of this workflow.`);
            if (run.mode !== "test" || run.virtualNow === null) throw new WorkflowStoreError("RUN_NOT_TEST", `Run ${run.runId} is not a test run; only a test run has a virtual clock.`);
            if (!ACTIVE_RUN_STATUSES.includes(run.status)) {
                throw new WorkflowStoreError("RUN_ENDED", `Test run ${run.runId} ended (${run.status}).`, { status: run.status });
            }
            const { rows: moved } = await client.query(
                `UPDATE ${this.t.runs} SET virtual_now = virtual_now + $2::integer * interval '1 second', updated_at = now() WHERE run_id = $1
                 RETURNING virtual_now::text AS now_text, ${isoUtc("virtual_now")} AS now_iso,
                           ${isoUtc("(virtual_now - $2::integer * interval '1 second')")} AS from_iso`,
                [run.runId, input.seconds]);
            const nowText = str(moved[0], "now_text");
            // A deadline after the run's own (migration 0104) is never reached: the run expires first, and its controller's
            // expiry cancels what is still pending then.
            const { rows: due } = await client.query(
                `SELECT * FROM ${this.t.nodes}
                  WHERE run_id = $1 AND state = 'pending' AND deadline_at IS NOT NULL
                    AND deadline_at <= LEAST($2::timestamptz, COALESCE($3::timestamptz, $2::timestamptz))
                  ORDER BY deadline_at, node_type = 'parallel', node_execution_id FOR UPDATE`, [run.runId, nowText, run.deadlineAt === null ? null : run.deadlineAt.toISOString()]);
            const decided: WorkflowTestAdvanceReceipt["decided"] = [];
            // IR 9: a parallel state's own time limit cancels its branches' pending work; what it cancelled is not due any more.
            // At one virtual instant its branches' results are decided first (a parallel state sorts after the other states
            // with its deadline): a result at the deadline counts toward its join (owner decision join-k-of-n, J1b (e)).
            const cut = new Set<string>();
            for (const row of due) {
                const node = nodeFrom(row);
                if (cut.has(node.nodeExecutionId)) continue;
                if (node.nodeType === "parallel") {
                    const settled = await this.settleParallelIn(client, run, node, { timeLimit: true, notStarted: new Set() });
                    for (const nodeExecutionId of settled.cancelled) cut.add(nodeExecutionId);
                    // A join due decides nothing: its controller admits the winners' terminals and joins.
                    if (settled.decided !== null) {
                        decided.push({ nodeExecutionId: node.nodeExecutionId, stateId: node.nodeId, outcome: settled.decided.result.outcome });
                    }
                    continue;
                }
                const waits = node.nodeType === "wait" || (node.nodeType === "messaging" && node.receive !== null);
                if (!waits && node.nodeType !== "agent" && node.nodeType !== "messaging") {
                    throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${node.nodeExecutionId} has a deadline but no timer.`);
                }
                const timedOut = canonicalJson({ code: "timed_out", message: node.nodeType === "agent"
                    ? "The agent did not complete the state before its deadline."
                    : "No response or refusal was accepted before the request's deadline." });
                await client.query(
                    `UPDATE ${this.t.nodes}
                        SET state = 'completed', outcome = $2, result_kind = $3,
                            output = CASE WHEN $3 = 'business' THEN input END,
                            error = CASE WHEN $3 = 'runtime_error' THEN $4 END,
                            winner = 'controller', completed_at = clock_timestamp()
                      WHERE node_execution_id = $1 AND state = 'pending'`,
                    [node.nodeExecutionId, waits ? WAIT_ELAPSED : "timed_out", waits ? "business" : "runtime_error", timedOut]);
                decided.push({ nodeExecutionId: node.nodeExecutionId, stateId: node.nodeId, outcome: waits ? WAIT_ELAPSED : "timed_out" });
            }
            const receipt: WorkflowTestAdvanceReceipt = {
                workflowSessionId: input.workflowSessionId, runId: run.runId, operation: "test_advance", seconds: input.seconds,
                from: str(moved[0], "from_iso"), virtualNow: str(moved[0], "now_iso"), decided,
            };
            await this.recordReceipt(client, input.workflowSessionId, input.operationId, "test_advance", input.requestSha256, receipt);
            await this.project(client, input.projection(receipt));
            return { receipt, replayed: false };
        });
    }

    /**
     * The test runs of a workflow that retention may delete (migration 0102;
     * design 05 cleanup): its ended test runs beyond the newest `keep` (by
     * admission), each ended at least `graceSeconds` ago by the store's
     * clock. Never a live run, never an active test run, and never a test run
     * whose agent states had children (agent mode real): their invocation
     * records stay, as a live run's do, because those ordinary sessions'
     * human-input denial and depth are read from them.
     */
    async listPrunableTestRuns(workflowSessionId: string, options: { keep: number; graceSeconds: number }): Promise<WorkflowRunRow[]> {
        if (!Number.isSafeInteger(options.keep) || options.keep < 0 || !Number.isSafeInteger(options.graceSeconds) || options.graceSeconds < 0) {
            throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "Test run retention needs whole, non-negative keep and grace values.");
        }
        const { rows } = await this.pool.query(
            `SELECT * FROM (
                SELECT run.*, row_number() OVER (ORDER BY run.created_at DESC, run.run_id DESC) AS newest
                  FROM ${this.t.runs} AS run
                 WHERE run.workflow_session_id = $1 AND run.mode = 'test' AND run.status IN ('completed', 'failed', 'cancelled', 'stopped')
             ) AS ended
             WHERE ended.newest > $2 AND ended.finished_at <= clock_timestamp() - $3::integer * interval '1 second'
               AND NOT EXISTS (SELECT 1 FROM ${this.t.agentInvocations} AS invocation WHERE invocation.run_id = ended.run_id)
             ORDER BY ended.created_at, ended.run_id`,
            [workflowSessionId, options.keep, options.graceSeconds]);
        return rows.map(runFrom);
    }

    /**
     * Delete one ended test run and the records it owns (migration 0102
     * retention; design 05 cleanup: only test-created scratch): its
     * interceptions, the typed input given to it, its node executions, its
     * KV revisions and its run row, in one transaction under the session and
     * run locks. Nothing is deleted unless it is a test run that ended at
     * least `graceSeconds` ago and owns no live record (an outbox message, a
     * request, which a test run never has, or an agent invocation, which only
     * a real-agent test run has and keeps). Operation receipts and the
     * session's events stay as the audit trail: a repeated test operation
     * still returns its receipt, and the run reads as not found.
     */
    async pruneTestRun(runId: string, options: { graceSeconds: number; projection?: (run: WorkflowRunRow) => SessionProjection }): Promise<
        { pruned: true; run: WorkflowRunRow; deleted: { interceptions: number; inbox: number; nodes: number; kvRevisions: number } }
        | { pruned: false; reason: "not_found" | "not_test" | "active" | "grace" | "live_records" }> {
        return this.transaction(async client => {
            const { rows: found } = await client.query(`SELECT workflow_session_id FROM ${this.t.runs} WHERE run_id = $1`, [runId]);
            // A deleted workflow keeps its runs as they are.
            if (!found[0] || !await this.lockLiveSession(client, str(found[0], "workflow_session_id"))) return { pruned: false as const, reason: "not_found" as const };
            const run = await this.lockRun(client, runId);
            if (run.mode !== "test") return { pruned: false as const, reason: "not_test" as const };
            if (ACTIVE_RUN_STATUSES.includes(run.status) || run.finishedAt === null) return { pruned: false as const, reason: "active" as const };
            const { rows: clock } = await client.query(
                `SELECT finished_at <= clock_timestamp() - $2::integer * interval '1 second' AS due FROM ${this.t.runs} WHERE run_id = $1`,
                [runId, options.graceSeconds]);
            if (clock[0]?.due !== true) return { pruned: false as const, reason: "grace" as const };
            const { rows: live } = await client.query(
                `SELECT (SELECT count(*) FROM ${this.t.outbox} WHERE run_id = $1)
                      + (SELECT count(*) FROM ${this.t.requests} WHERE run_id = $1)
                      + (SELECT count(*) FROM ${this.t.agentInvocations} WHERE run_id = $1) AS n`, [runId]);
            if (int(live[0], "n") > 0) return { pruned: false as const, reason: "live_records" as const };
            const count = async (sql: string): Promise<number> => (await client.query(sql, [runId])).rowCount ?? 0;
            const interceptions = await count(`DELETE FROM ${this.t.testInterceptions} WHERE run_id = $1`);
            const inbox = await count(`DELETE FROM ${this.t.inbox} WHERE run_id = $1`);
            const nodes = await count(`DELETE FROM ${this.t.nodes} WHERE run_id = $1`);
            const kvRevisions = await count(`DELETE FROM ${this.t.kvRevisions} WHERE run_id = $1`);
            await client.query(`DELETE FROM ${this.t.runs} WHERE run_id = $1`, [runId]);
            await this.project(client, options.projection?.(run), run);
            return { pruned: true as const, run, deleted: { interceptions, inbox, nodes, kvRevisions } };
        });
    }
}

/** The identity of a test response: its kind and value (canonical JSON). */
export function testResponseSha256(kind: WorkflowTestResponseKind, valueText: string): string {
    return sha256Hex(canonicalJson({ kind, value: parseStoredJson(valueText, "response") }));
}

export interface RunAdmission {
    runId: string;
    mode: WorkflowRunMode;
    controllerInstanceId: string;
    inputsText: string;
    /** The initial open KV map as canonical JSON text (revision 1). */
    kvText: string;
    testAgentMode: "mocked" | "real" | null;
    /**
     * The controller version this run is admitted for (migration 0100); stored once and never changed. The service always
     * names it; omitted (or null), the run records none, as a run admitted before 0100 (only a store test does that).
     */
    controllerVersion?: string | null;
    /** A test run's fixtures as canonical JSON (migration 0102); only a test admission names them. */
    fixturesText?: string | null;
    /** The scenario a test run is started for (migration 0103); only a test admission names one. */
    testScenario?: string | null;
    /** A real-agent test run's agent pins as canonical JSON (migration 0105); only such a test admission names them. */
    testAgentPinsText?: string | null;
    /** OF-S2-7: the agent nodes' models chosen at start as canonical JSON (migration 0110); only a start that chose any. */
    agentModelsText?: string | null;
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
    /**
     * In the store (since S7-DX2 every cancel, done or delete of an active run), by the run's controller ("queued": only
     * receipts an older build stored), or nothing to apply.
     */
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

/** UXP-AD-01: the events that record a run's control actions, and the operation each records (readLastRunControl). */
const RUN_CONTROL_EVENTS: Readonly<Record<string, WorkflowRunControl["operation"]>> = Object.freeze({
    "workflow.paused": "pause",
    "workflow.resumed": "resume",
    "workflow.stop_requested": "stop",
    "workflow.cancelled": "cancel",
    "workflow.vars_set": "set_vars",
});

/** An actor as actorJson stored it; null for any other shape. */
function storedActor(value: unknown): WorkflowActor | null {
    if (!isJsonObject(value)) return null;
    const text = (key: string) => (typeof value[key] === "string" && value[key] ? value[key] as string : null);
    if (value.kind === "agent" && text("sessionId")) return { kind: "agent", sessionId: text("sessionId")! };
    if (value.kind === "user" && text("provider") && text("subject")) return { kind: "user", provider: text("provider")!, subject: text("subject")! };
    if (value.kind === "system" && text("name")) return { kind: "system", name: text("name")! };
    return null;
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

/**
 * S2RT-F2: the order in which a Workflow's session and another session are locked: its own parent chat first (the order of
 * the chat-ended trigger and of a Start: the chat, then its Workflows), any other session in ascending id order. Pure.
 */
export function sessionPairLockOrder(workflowSessionId: string, otherSessionId: string, parentSessionId: string | null): string[] {
    if (workflowSessionId === otherSessionId) return [workflowSessionId];
    if (parentSessionId !== null && otherSessionId === parentSessionId) return [otherSessionId, workflowSessionId];
    return [workflowSessionId, otherSessionId].sort();
}
