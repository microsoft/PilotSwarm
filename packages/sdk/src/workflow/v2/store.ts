import type { Pool, PoolClient } from "pg";
import { parseDiagnostics, parseWorkflowIr, WORKFLOW_V2_API_VERSION, type WorkflowCompileResult, type WorkflowDiagnostic, type WorkflowIR } from "./compiler.js";
import { canonicalJson, isJsonObject, jsonbSafeText, jsonbSafeValue, parseStoredJson, sha256Hex, type JsonValue } from "./json.js";

/**
 * PostgreSQL persistence for workflow v2 (tables from migration 0085).
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
export type WorkflowRunStatus = "admitted" | "running" | "completed" | "failed" | "cancelled";
export type WorkflowRunMode = "live" | "test";
export const ACTIVE_RUN_STATUSES: readonly WorkflowRunStatus[] = ["admitted", "running"];

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
    enteredAt: Date;
    completedAt: Date | null;
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

const RUN_STATUSES: readonly WorkflowRunStatus[] = ["admitted", "running", "completed", "failed", "cancelled"];
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
    };
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
        winner: strOrNull(row, "winner"), effectAttempts: int(row, "effect_attempts"),
        enteredAt: date(row, "entered_at"), completedAt: dateOrNull(row, "completed_at"),
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
        definitions: string; revisions: string; operations: string; runs: string; nodes: string;
        sessions: string; recordEvents: string; updateSession: string;
    };

    constructor(private readonly pool: Pool, readonly schema: string) {
        const s = `"${schema}"`;
        this.t = {
            definitions: `${s}.workflow_definitions`, revisions: `${s}.workflow_revisions`,
            operations: `${s}.workflow_operations`, runs: `${s}.workflow_runs`, nodes: `${s}.workflow_node_executions`,
            sessions: `${s}.sessions`, recordEvents: `${s}.cms_record_events`, updateSession: `${s}.cms_update_session`,
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

    /** A stored receipt for this operation, or null. Throws OPERATION_CONFLICT for a different request with the same id. */
    private async priorReceipt(client: PoolClient, workflowSessionId: string, operationId: string, kind: string, requestSha256: string): Promise<WorkflowDefinitionReceipt | null> {
        const { rows } = await client.query(
            `SELECT kind, request_sha256, receipt FROM ${this.t.operations} WHERE workflow_session_id = $1 AND operation_id = $2`,
            [workflowSessionId, operationId],
        );
        if (!rows[0]) return null;
        if (str(rows[0], "kind") !== kind || str(rows[0], "request_sha256") !== requestSha256) {
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
                (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, test_agent_mode, start_operation_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'admitted', $9, $10)`,
            [start.runId, definition.workflowSessionId, start.mode, revision.revision, revision.yamlSha256, revision.irSha256,
                start.inputsText, start.controllerInstanceId, start.mode === "test" ? start.testAgentMode : null, operationId],
        );
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
                const prior = await this.priorReceipt(client, input.workflowSessionId, input.operationId, "create", input.requestSha256);
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

    /** admitted -> running. Returns whether this call made the transition. */
    async beginRun(runId: string, projection?: SessionProjection): Promise<{ run: WorkflowRunRow; transitioned: boolean }> {
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfRun(client, runId));
            const run = await this.lockRun(client, runId);
            if (!live) return { run, transitioned: false };
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
     * retry must name the same predecessor, route and input.
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
        immediate: NodeResultInput | null;
        projection?: SessionProjection;
    }): Promise<{ admitted: true; inserted: boolean; node: WorkflowNodeExecutionRow } | { admitted: false; run: WorkflowRunRow }> {
        const inputSha256 = sha256Hex(input.inputText);
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfRun(client, input.runId));
            const run = await this.lockRun(client, input.runId);
            const existing = await client.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id = $1`, [input.nodeExecutionId]);
            if (existing.rows[0]) {
                const node = nodeFrom(existing.rows[0]);
                if (node.runId !== input.runId || node.scopeId !== input.scopeId || node.nodeId !== input.nodeId || node.ordinal !== input.ordinal
                    || node.predecessorId !== input.predecessorId || node.arrivalRoute !== input.arrivalRoute || node.inputSha256 !== inputSha256) {
                    throw new WorkflowStoreError("NONDETERMINISTIC_ADMISSION", `Node execution ${input.nodeExecutionId} was admitted with different coordinates.`);
                }
                return { admitted: true as const, inserted: false, node };
            }
            if (!live || !ACTIVE_RUN_STATUSES.includes(run.status)) return { admitted: false as const, run };
            const immediate = input.immediate;
            const { rows } = await client.query(
                `INSERT INTO ${this.t.nodes}
                    (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, predecessor_id, arrival_route, input, input_sha256,
                     state, outcome, result_kind, output, error, winner, completed_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CASE WHEN $11 = 'completed' THEN now() END)
                 RETURNING *`,
                [input.nodeExecutionId, input.runId, input.scopeId, input.nodeId, input.ordinal, input.nodeType, input.predecessorId,
                    input.arrivalRoute, input.inputText, inputSha256, immediate ? "completed" : "pending",
                    immediate?.outcome ?? null, immediate?.resultKind ?? null,
                    immediate?.resultKind === "business" ? immediate.valueText : null,
                    immediate?.resultKind === "runtime_error" ? immediate.valueText : null,
                    immediate?.winner ?? null],
            );
            await this.project(client, input.projection);
            return { admitted: true as const, inserted: true, node: nodeFrom(rows[0]) };
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
        projection?: SessionProjection;
    }): Promise<{ ended: boolean; run: WorkflowRunRow }> {
        return this.transaction(async client => {
            const live = await this.lockLiveSession(client, await this.workflowOfRun(client, input.runId));
            const run = await this.lockRun(client, input.runId);
            if (!live || !ACTIVE_RUN_STATUSES.includes(run.status)) return { ended: false, run };
            const { rows } = await client.query(
                `UPDATE ${this.t.runs}
                    SET status = $2, terminal_node_id = $3, terminal_outcome = $4, terminal_output = $5, terminal_error = $6,
                        updated_at = now(), finished_at = now()
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
    testAgentMode: "mocked" | "real" | null;
}

function assertNotDeleted(definition: WorkflowDefinitionRow): void {
    if (definition.state === "deleted") throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow was deleted.");
}
