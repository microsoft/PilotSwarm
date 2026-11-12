import type { Pool, PoolClient, QueryResultRow } from "pg";
import { canonicalJson, isJsonObject, jsonSha256, parseStoredJson, type JsonValue } from "./json.js";
import { parseBranchScope } from "./parallel.js";
import { workflowControllerFeatures } from "./controller-features.js";
import { WorkflowStoreError, type SessionProjection, type WorkflowActor, type WorkflowNodeExecutionRow, type WorkflowRunRow } from "./store.js";

export interface ApprovalCommand {
    operation: "approval_respond";
    operationId: string;
    runId: string;
    approvalId: string;
    contextSha256: string;
    decision: "approved" | "rejected";
    reason: string | null;
}

export function parseApprovalCommand(value: Record<string, unknown>): ApprovalCommand {
    const allowed = new Set(["operation", "operation_id", "run_id", "approval_id", "context_sha256", "decision", "reason", "workflow_id"]);
    const validId = (id: unknown): id is string => typeof id === "string" && id.trim().length > 0 && id.length <= 256;
    if (Object.keys(value).some(key => !allowed.has(key)) || value.operation !== "approval_respond"
        || !validId(value.operation_id) || !validId(value.run_id) || !validId(value.approval_id)
        || typeof value.context_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.context_sha256)
        || (value.decision !== "approved" && value.decision !== "rejected")
        || (value.reason !== undefined && value.reason !== null && (typeof value.reason !== "string" || value.reason.length > 2_000))
        || (value.decision === "rejected" && (typeof value.reason !== "string" || !value.reason.trim()))) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "An approval answer needs its exact approval_id, context_sha256, decision and operation_id; rejection needs a reason.");
    }
    return { operation: "approval_respond", operationId: value.operation_id, runId: value.run_id, approvalId: value.approval_id,
        contextSha256: value.context_sha256, decision: value.decision, reason: typeof value.reason === "string" ? value.reason : null };
}

function text(row: QueryResultRow, key: string): string {
    if (typeof row[key] !== "string") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `An approval has no valid ${key}.`);
    return row[key];
}

function object(value: JsonValue, what: string): { [key: string]: JsonValue } {
    if (!isJsonObject(value)) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `The approval's ${what} is not an object.`);
    return value;
}

const tables = (schema: string) => {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return { sessions: `${s}.sessions`, owners: `${s}.session_owners`, users: `${s}.users`, runs: `${s}.workflow_runs`,
        nodes: `${s}.workflow_node_executions`, approvals: `${s}.workflow_approvals`, definitions: `${s}.workflow_definitions`,
        operations: `${s}.workflow_operations` };
};

/** Called under the Workflow session lock; the same lookup is repeated when consent is accepted. */
export async function approvalOwnerIn(client: PoolClient, schema: string, workflowSessionId: string): Promise<{ provider: string; subject: string; displayName: string | null } | null> {
    const t = tables(schema);
    const { rows } = await client.query(`SELECT u.provider, u.subject, u.display_name FROM ${t.owners} o JOIN ${t.users} u ON u.user_id = o.user_id
        WHERE o.session_id = $1 FOR SHARE OF o`, [workflowSessionId]);
    const row = rows[0];
    if (!row || typeof row.provider !== "string" || !row.provider || typeof row.subject !== "string" || !row.subject) return null;
    return { provider: row.provider, subject: row.subject, displayName: typeof row.display_name === "string" ? row.display_name : null };
}

/** Admission has already pinned the owner and the node's input, clock and deadline, in this transaction. */
export async function recordApprovalIn(client: PoolClient, schema: string, run: WorkflowRunRow, node: WorkflowNodeExecutionRow,
    question: string, owner: { provider: string; subject: string; displayName: string | null }): Promise<void> {
    const t = tables(schema);
    const { rows } = await client.query(
        `SELECT to_char(n.entered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activated_at,
                to_char(n.deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline_at,
                d.session_definition_id, d.session_revision
           FROM ${t.nodes} n JOIN ${t.definitions} d ON d.workflow_session_id = $2 WHERE n.node_execution_id = $1`,
        [node.nodeExecutionId, run.workflowSessionId]);
    const row = rows[0];
    const snapshot = {
        question, input: node.input, workflowSessionId: run.workflowSessionId, runId: run.runId, approvalId: node.nodeExecutionId,
        revision: run.revision, irSha256: run.irSha256,
        source: row.session_definition_id === null ? null : { definitionId: text(row, "session_definition_id"), revision: row.session_revision },
        owner, activatedAt: text(row, "activated_at"), deadlineAt: text(row, "deadline_at"),
    };
    const serialized = canonicalJson(snapshot);
    await client.query(`INSERT INTO ${t.approvals} (node_execution_id, workflow_session_id, run_id, owner_provider, owner_subject, snapshot, context_sha256)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [node.nodeExecutionId, run.workflowSessionId, run.runId, owner.provider, owner.subject, serialized, jsonSha256(snapshot)]);
}

interface ApprovalStoreContext {
    pool: Pool;
    schema: string;
    transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
    project(client: PoolClient, projection: SessionProjection): Promise<void>;
}

/** Consent is row-bound, owner-bound and transactional; controller wake messages carry no authority. */
export class WorkflowApprovalStore {
    private readonly t;
    constructor(private readonly context: ApprovalStoreContext) { this.t = tables(context.schema); }

    private async locked(client: PoolClient, workflowSessionId: string, runId: string, approvalId: string): Promise<{
        live: boolean; run: QueryResultRow; node: QueryResultRow; approval: QueryResultRow;
    }> {
        const { rows: sessions } = await client.query(`SELECT deleted_at FROM ${this.t.sessions} WHERE session_id=$1 FOR NO KEY UPDATE`, [workflowSessionId]);
        const { rows: runs } = await client.query(`SELECT * FROM ${this.t.runs} WHERE run_id=$1 AND workflow_session_id=$2 FOR UPDATE`, [runId, workflowSessionId]);
        const { rows: nodes } = await client.query(`SELECT * FROM ${this.t.nodes} WHERE node_execution_id=$1 AND run_id=$2 FOR UPDATE`, [approvalId, runId]);
        const { rows: approvals } = await client.query(`SELECT * FROM ${this.t.approvals} WHERE node_execution_id=$1 AND run_id=$2 AND workflow_session_id=$3 FOR UPDATE`,
            [approvalId, runId, workflowSessionId]);
        if (!runs[0] || !nodes[0] || !approvals[0]) throw new WorkflowStoreError("APPROVAL_NOT_FOUND", "This approval visit does not exist in this Workflow run.");
        return { live: Boolean(sessions[0]) && sessions[0].deleted_at === null, run: runs[0], node: nodes[0], approval: approvals[0] };
    }

    private async clock(client: PoolClient): Promise<string> {
        const { rows } = await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`);
        return text(rows[0], "at");
    }

    private async timeoutIn(client: PoolClient, workflowSessionId: string, node: QueryResultRow, at: string): Promise<void> {
        const envelope = { code: "timed_out", message: "The approval deadline passed without an accepted answer." };
        await client.query(`UPDATE ${this.t.nodes} SET state='completed', outcome='timed_out', result_kind='runtime_error',
            error=$2, output=NULL, winner='approval_timeout', completed_at=$3::timestamptz WHERE node_execution_id=$1 AND state='pending'`,
            [text(node, "node_execution_id"), canonicalJson(envelope), at]);
        await this.context.project(client, { sessionId: workflowSessionId, events: [{ eventType: "workflow.state_failed",
            data: { runId: text(node, "run_id"), nodeExecutionId: text(node, "node_execution_id"), stateId: text(node, "node_id"),
                outcome: "timed_out", resultKind: "runtime_error", error: envelope } }], update: { touch: true } });
    }

    async respond(workflowSessionId: string, command: ApprovalCommand, actor: WorkflowActor): Promise<{ [key: string]: JsonValue }> {
        if (actor.kind !== "user") throw new WorkflowStoreError("FORBIDDEN", "Only the owner can answer this approval.");
        const requestSha256 = jsonSha256({ ...command, actor });
        const accepted = await this.context.transaction(async client => {
            const { rows: sessions } = await client.query(`SELECT deleted_at FROM ${this.t.sessions} WHERE session_id=$1 FOR NO KEY UPDATE`, [workflowSessionId]);
            if (!sessions[0] || sessions[0].deleted_at !== null) throw new WorkflowStoreError("WORKFLOW_NOT_FOUND", "This Workflow is deleted or unavailable.");
            const owner = await approvalOwnerIn(client, this.context.schema, workflowSessionId);
            if (!owner || owner.provider !== actor.provider || owner.subject !== actor.subject) {
                throw new WorkflowStoreError("FORBIDDEN", "Only the current Workflow owner can answer this approval.");
            }
            const { rows: receipts } = await client.query(`SELECT * FROM ${this.t.operations} WHERE workflow_session_id=$1 AND operation_id=$2 FOR UPDATE`,
                [workflowSessionId, command.operationId]);
            if (receipts[0]) {
                if (receipts[0].kind !== "approval_respond" || receipts[0].request_sha256 !== requestSha256) {
                    throw new WorkflowStoreError("OPERATION_CONFLICT", "This operation_id was used for another request.");
                }
                return { receipt: { ...object(parseStoredJson(text(receipts[0], "receipt"), "approval receipt"), "receipt"), replayed: true } };
            }
            const { run, node, approval } = await this.locked(client, workflowSessionId, command.runId, command.approvalId);
            if (approval.owner_provider !== actor.provider || approval.owner_subject !== actor.subject) {
                throw new WorkflowStoreError("FORBIDDEN", "Only the pinned owner, while still the Workflow's owner, can answer this approval.");
            }
            if (approval.context_sha256 !== command.contextSha256) throw new WorkflowStoreError("APPROVAL_CONTEXT_CHANGED", "This answer names a different proposal. Read the approval again.");
            if (run.mode !== "live" || !workflowControllerFeatures(text(run, "controller_version")).approval || !["admitted", "running", "paused"].includes(text(run, "status"))
                || run.stop_requested_at !== null || node.state !== "pending" || approval.decision !== null) {
                throw new WorkflowStoreError("APPROVAL_CLOSED", "This approval no longer accepts a new answer.");
            }
            const at = await this.clock(client);
            const scope = parseBranchScope(text(node, "scope_id"));
            if (scope !== null) {
                const { rows: parents } = await client.query(`SELECT state, deadline_at IS NOT NULL AND deadline_at <= $2::timestamptz AS past
                    FROM ${this.t.nodes} WHERE node_execution_id=$1`, [scope.parallelNodeExecutionId, at]);
                if (!parents[0] || parents[0].state !== "pending" || parents[0].past === true) {
                    throw new WorkflowStoreError("APPROVAL_CLOSED", "The approval's branch no longer accepts an answer.");
                }
            }
            const { rows: due } = await client.query(`SELECT deadline_at <= $2::timestamptz AS due FROM ${this.t.nodes} WHERE node_execution_id=$1`,
                [command.approvalId, at]);
            if (due[0]?.due !== false) {
                await this.timeoutIn(client, workflowSessionId, node, at);
                return { expired: true as const };
            }
            const decidedBy = { provider: actor.provider, subject: actor.subject, displayName: owner.displayName };
            const output = { decision: command.decision, reason: command.reason, decidedAt: at, decidedBy, contextSha256: command.contextSha256 };
            const receipt = { workflowSessionId, runId: command.runId, approvalId: command.approvalId, operation: "approval_respond",
                ...output, replayed: false };
            await client.query(`UPDATE ${this.t.nodes} SET state='completed', outcome=$2, result_kind='business', output=$3, error=NULL,
                winner='approval_owner', completed_at=$4::timestamptz WHERE node_execution_id=$1 AND state='pending'`,
                [command.approvalId, command.decision, canonicalJson(output), at]);
            await client.query(`UPDATE ${this.t.approvals} SET decision=$2, reason=$3, decided_by=$4, decided_at=$5::timestamptz, operation_id=$6
                WHERE node_execution_id=$1 AND decision IS NULL`, [command.approvalId, command.decision, command.reason, canonicalJson(decidedBy), at, command.operationId]);
            await client.query(`INSERT INTO ${this.t.operations} (workflow_session_id, operation_id, kind, request_sha256, receipt)
                VALUES ($1,$2,'approval_respond',$3,$4)`, [workflowSessionId, command.operationId, requestSha256, canonicalJson(receipt)]);
            await this.context.project(client, { sessionId: workflowSessionId, events: [{ eventType: "workflow.state_completed",
                data: { runId: command.runId, nodeExecutionId: command.approvalId, stateId: text(node, "node_id"), outcome: command.decision,
                    resultKind: "business", approval: true, decidedBy, reason: command.reason, contextSha256: command.contextSha256 } }], update: { touch: true } });
            return { receipt };
        });
        if ("expired" in accepted) throw new WorkflowStoreError("APPROVAL_EXPIRED", "The approval deadline has passed.");
        return accepted.receipt;
    }

    async expire(workflowSessionId: string, runId: string, approvalId: string): Promise<{ remainingMs: number | null }> {
        return this.context.transaction(async client => {
            const { live, node } = await this.locked(client, workflowSessionId, runId, approvalId);
            // A decided row is still a result to collect; no timeout UPDATE is needed for it.
            if (!live || node.state !== "pending") return { remainingMs: null };
            const at = await this.clock(client);
            const { rows } = await client.query(`SELECT deadline_at <= $2::timestamptz AS due,
                GREATEST(1, CEIL(EXTRACT(EPOCH FROM (deadline_at - $2::timestamptz))*1000))::bigint AS remaining_ms
                FROM ${this.t.nodes} WHERE node_execution_id=$1`, [approvalId, at]);
            if (rows[0].due === true) {
                await this.timeoutIn(client, workflowSessionId, node, at);
                return { remainingMs: null };
            }
            return { remainingMs: Number(rows[0].remaining_ms) };
        });
    }

    async readMany(ids: string[]): Promise<Map<string, JsonValue>> {
        if (ids.length === 0) return new Map();
        const { rows } = await this.context.pool.query(`SELECT a.*, n.state, n.outcome,
                to_char(n.deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deadline,
                to_char(n.entered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS activated,
                to_char(a.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided
            FROM ${this.t.approvals} a JOIN ${this.t.nodes} n ON n.node_execution_id=a.node_execution_id WHERE a.node_execution_id=ANY($1::text[])`, [ids]);
        return new Map(rows.map(row => {
            const snapshot = object(parseStoredJson(text(row, "snapshot"), "approval snapshot"), "snapshot");
            const decision = row.decision === null ? null : { decision: text(row, "decision"), reason: row.reason === null ? null : text(row, "reason"),
                decidedAt: text(row, "decided"), decidedBy: parseStoredJson(text(row, "decided_by"), "approval actor") };
            const outcome = row.state === "pending" ? "pending" : row.outcome === "approved" || row.outcome === "rejected" || row.outcome === "timed_out"
                || row.outcome === "cancelled" ? text(row, "outcome") : "failed";
            return [text(row, "node_execution_id"), { approvalId: text(row, "node_execution_id"), question: snapshot.question, context: snapshot.input,
                contextSha256: text(row, "context_sha256"), owner: snapshot.owner, activatedAt: text(row, "activated"), deadlineAt: text(row, "deadline"),
                status: outcome, decision }] as [string, JsonValue];
        }));
    }
}
