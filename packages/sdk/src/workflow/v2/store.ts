import type { Pool, PoolClient } from "pg";
import { parseDiagnostics, parseWorkflowIr, RECEIVE_RECEIVED, WAIT_ELAPSED, WORKFLOW_V2_API_VERSION, type WorkflowCompileResult, type WorkflowDiagnostic, type WorkflowIR } from "./compiler.js";
import { canonicalJson, isJsonObject, isStorableText, jsonbSafeText, jsonbSafeValue, parseStoredJson, sha256Hex, type JsonValue } from "./json.js";

/**
 * PostgreSQL persistence for workflow v2 (tables from migrations 0085 and 0087 to 0089).
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
        definitions: string; revisions: string; operations: string; runs: string; nodes: string; kvRevisions: string; inbox: string;
        sessions: string; recordEvents: string; updateSession: string; softDeleteSession: string;
    };

    constructor(private readonly pool: Pool, readonly schema: string) {
        const s = `"${schema}"`;
        this.t = {
            definitions: `${s}.workflow_definitions`, revisions: `${s}.workflow_revisions`,
            operations: `${s}.workflow_operations`, runs: `${s}.workflow_runs`, nodes: `${s}.workflow_node_executions`,
            kvRevisions: `${s}.workflow_kv_revisions`, inbox: `${s}.workflow_inbox`,
            sessions: `${s}.sessions`, recordEvents: `${s}.cms_record_events`, updateSession: `${s}.cms_update_session`,
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

    /** The IR of a valid revision, verified against its stored hash. */
    async readRevisionIr(workflowSessionId: string, revision: number, expectedIrSha256?: string): Promise<WorkflowIR> {
        const { rows } = await this.pool.query(
            `SELECT ir, ir_sha256 FROM ${this.t.revisions} WHERE workflow_session_id = $1 AND revision = $2`, [workflowSessionId, revision]);
        const text = rows[0] ? strOrNull(rows[0], "ir") : null;
        const stored = rows[0] ? strOrNull(rows[0], "ir_sha256") : null;
        if (!text || !stored) throw new WorkflowStoreError("DEFINITION_INVALID", `Revision ${revision} has no compiled IR.`);
        if (sha256Hex(text) !== stored || (expectedIrSha256 && stored !== expectedIrSha256)) {
            throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Revision ${revision} IR does not match its pinned hash.`);
        }
        return parseWorkflowIr(parseStoredJson(text, "ir"));
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
        /** What a receive state accepts (null for other states and for one that failed at admission). */
        receive?: { contract: string; from: string | null; correlationText: string } | null;
        immediate: NodeResultInput | null;
        projection?: SessionProjection;
    }): Promise<{ admitted: true; inserted: boolean; node: WorkflowNodeExecutionRow }
        | { admitted: false; reason: "inactive" | "kv_changed"; run: WorkflowRunRow }> {
        const inputSha256 = sha256Hex(input.inputText);
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfRun(client, input.runId));
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
            const immediate = input.immediate;
            const receive = input.receive ?? null;
            // A receive spec belongs to a receive state admitted without an immediate result.
            if ((receive !== null) !== (input.nodeType === "messaging" && immediate === null)) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has an invalid receive spec.`);
            }
            // A wait admitted pending has a whole number of seconds; a receive may
            // race a wait (then it has them too); nothing else has any.
            const waits = input.nodeType === "wait" && immediate === null;
            const mayWait = waits || receive !== null;
            if ((waits && input.waitSeconds === null) || (!mayWait && input.waitSeconds !== null)
                || (input.waitSeconds !== null && !(Number.isSafeInteger(input.waitSeconds) && input.waitSeconds >= 1))) {
                throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Node execution ${input.nodeExecutionId} has invalid wait seconds.`);
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
                    result?.winner ?? null, input.kvRevision, claim ? null : input.waitSeconds,
                    receive?.contract ?? null, receive?.from ?? null, receive?.correlationText ?? null, decidedAt],
            );
            const node = nodeFrom(rows[0]);
            let projection = input.projection;
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
     * admission takes them). One reading of the store's clock, taken after
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
     * refused. A deleted workflow takes no input, and a repeat to it is
     * refused too. The inbox bounds are checked before anything is stored.
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
    }): Promise<{ receipt: WorkflowInputReceipt; replayed: boolean; run: WorkflowRunRow }> {
        if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1) {
            throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Message ${input.messageId} has an invalid ttl.`);
        }
        return this.transaction(async client => {
            if (!await this.lockLiveSession(client, input.workflowSessionId)) throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow was deleted.");
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

    /**
     * End an active run once. Returns the stored run and whether this call
     * ended it; a later call sees the first terminal result.
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
