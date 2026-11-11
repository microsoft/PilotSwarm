/**
 * Session-owned Workflow Definitions (Workflow Simplified stage 2.1; migration 0088; spec "definitions", "editing", "tools";
 * the coordinator's 2.1 readings Q1–Q10 and F2–F4).
 *
 * A definition belongs to one session and is named in it; each save is an immutable revision with its author and the revision
 * it was based on. Every check and its write is one transaction under the same locks (Q3):
 * - save: the session row (FOR NO KEY UPDATE: saves only on a live session, Q7), then the definition row (FOR UPDATE); the guard
 *   names the definition and its revision (Q1): a stale save, or one on a deleted definition, is refused and writes
 *   nothing; a first save of a name relies on the live (session, name) key;
 * - delete (a person's, Q8): the session row (FOR SHARE), then the definition row (FOR UPDATE); refused while one of its
 *   Workflows is active (R6);
 * - Start (WorkflowStore.createDefinition with a session pin, requireSessionStartLocked): the session row (FOR SHARE: live), the
 *   definition row (FOR SHARE: not deleted), the revision (valid, the YAML being stored), before the Workflow's own rows.
 * An owner session that ends ends its Workflows (migration 0088's trigger, R5 and F2).
 *
 * Stage 2.3 (migration 0088; P2, P5, P6, E2-7): a package's definition attached to a session is a locked definition named
 * `<package>/<name>` (attachPackage). Each package version attached is a revision recording the package and its card; a save
 * to a locked definition is refused (DEFINITION_LOCKED), and a person makes an editable copy instead (a first save of the
 * package's YAML under its own name).
 */
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Hex, type JsonValue } from "./json.js";
import type { WorkflowCompileResult, WorkflowDiagnostic, WorkflowIR } from "./compiler.js";
import { WorkflowStoreError, revisionIrFrom } from "./store.js";
import { packageVersionIsNewer } from "./session-packages.js";
import { childBudgetCountSql, childBudgetWords } from "../child-budget.js";

/** Stage 2.2: the ended tests a definition keeps (older ended ones are deleted; their rows and runs stay). */
export const WORKFLOW_DEFINITION_TESTS_KEPT = 5;

/** Who saved a revision or deleted a definition: the session (its own tool), a person, or the system (an import). */
export type SessionDefinitionActor =
    | { kind: "session"; sessionId: string }
    | { kind: "user"; provider: string; subject: string; display?: string | null }
    | { kind: "system"; name: string };

/**
 * Formal L1 (stage 2 review): where a Make a copy came from: the locked definition, the revision copied and its package
 * version. Kept with the copy's creation record (created_by), so no column is needed.
 */
export interface SessionCopiedFrom {
    definitionId: string;
    name: string;
    revision: number;
    package: { packageId: string; packageName: string; semver: string; sha256: string } | null;
}

export interface SessionDefinitionRow {
    definitionId: string;
    ownerSessionId: string;
    name: string;
    currentRevision: number;
    /** 'imported' (a stage 1 import; no migration makes one now), 'package' (2.3), 'copy' (a Make a copy, L1), or null (the session's or a person's first save). */
    source: string | null;
    /** L1: a copy's source (source 'copy'); null for any other definition. */
    copiedFrom: SessionCopiedFrom | null;
    /** Stage 2.3: a package's definition, read-only here (E2-7); `packageName` is its package. */
    locked: boolean;
    packageName: string | null;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
}

export interface SessionRevisionSummary {
    /** Stage 2.2: the newest agent test of this revision, when one ran (added by the list, session-definitions.ts). */
    lastTest?: { testId: string; verdict: "passed" | "failed" | "running"; at: string } | null;
    definitionId: string;
    revision: number;
    valid: boolean;
    semver: string | null;
    yamlSha256: string;
    irSha256: string | null;
    basedOn: number | null;
    actor: SessionDefinitionActor;
    imported: boolean;
    createdAt: string;
    errorCount: number;
    /** Stage 2.3: the package version this revision is (a locked definition's), with its card's digest; null for the session's own. */
    package: SessionRevisionPackage | null;
}

/** The package version a locked definition's revision is (P5): its id, version and content hash, and its card's digest. */
export interface SessionRevisionPackage {
    packageId: string;
    packageName: string;
    semver: string;
    sha256: string;
    cardDigest: string;
}

export interface SessionRevisionRow extends SessionRevisionSummary {
    yaml: string;
    diagnostics: WorkflowDiagnostic[];
    /** Stage 2.3: a package revision's card, as the registry exported it (package-card.ts WorkflowCard); null otherwise. */
    card: JsonValue | null;
}

/** Stage 2.3: what attaching a package version to a session did (attachPackage). */
export interface SessionAttachReceipt {
    operation: "attach";
    definitionId: string;
    name: string;
    revision: number;
    /** A new definition (the first version attached to this session). */
    created: boolean;
    /** A new revision was added (false: that package version was already the newest revision). */
    changed: boolean;
    package: SessionRevisionPackage;
    attachedAt: string;
}

export interface SessionSaveReceipt {
    operation: "save";
    definitionId: string;
    name: string;
    revision: number;
    basedOn: number | null;
    created: boolean;
    valid: boolean;
    semver: string | null;
    yamlSha256: string;
    irSha256: string | null;
    diagnostics: WorkflowDiagnostic[];
    savedAt: string;
}

export interface SessionDeleteReceipt {
    operation: "delete";
    definitionId: string;
    name: string;
    deletedAt: string;
}

/** A Workflow started from a session definition: its session, the revision it pins and its live run's status (null: none). */
export interface SessionWorkflowRow {
    workflowSessionId: string;
    definitionId: string;
    revision: number;
    runStatus: string | null;
    createdAt: string;
}

/**
 * Stage 2.2: one agent test of a revision (its test bench, definition-test.ts), as the definition's list shows it: the test bench
 * session (the test's id), its definition and revision, its test run and that run's state, and when it was started and
 * ended. `verdict`: passed (the run completed with outcome succeeded), failed (it ended any other way), running.
 */
export interface DefinitionTestRow {
    testId: string;
    definitionId: string;
    revision: number;
    runId: string | null;
    status: string | null;
    outcome: string | null;
    verdict: "passed" | "failed" | "running";
    startedAt: string;
    endedAt: string | null;
}

export interface SessionNoteRow {
    noteId: number;
    definitionId: string;
    revision: number;
    text: string;
    createdAt: string;
}

export interface StoredSessionOperation<T> {
    receipt: T;
    replayed: boolean;
}

/** The statuses of a live run that make its Workflow active (WorkflowStore ACTIVE_RUN_STATUSES). */
const ACTIVE = ["admitted", "running", "paused"];
/** The session states after which it is no longer live (Q7: its definitions are read-only; F2: its Workflows end). */
export const OWNER_SESSION_ENDED_STATES: readonly string[] = ["completed", "cancelled", "failed"];
/** The most revisions one definition keeps (as a Workflow's own definition, WORKFLOW_REVISION_LIMITS). */
export const SESSION_DEFINITION_MAX_REVISIONS = 1_000;

type Row = Record<string, unknown>;
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));
const parse = <T>(text: unknown, fallback: T): T => {
    if (typeof text !== "string") return fallback;
    try { return JSON.parse(text) as T; } catch { return fallback; }
};

/** L1: a copy's source, as its creation record keeps it; null when it has none or it is not well formed. */
function copiedFromOf(createdBy: unknown): SessionCopiedFrom | null {
    const record = parse<Row>(typeof createdBy === "string" ? createdBy : null, {});
    const from = record && typeof record === "object" ? (record as Row).copiedFrom as Row | undefined : undefined;
    if (!from || typeof from !== "object" || typeof from.definitionId !== "string" || typeof from.name !== "string"
        || !Number.isSafeInteger(from.revision)) return null;
    const pkg = from.package as Row | null | undefined;
    return {
        definitionId: from.definitionId, name: from.name, revision: Number(from.revision),
        package: pkg && typeof pkg === "object" && typeof pkg.packageId === "string" && typeof pkg.packageName === "string"
            && typeof pkg.semver === "string" && typeof pkg.sha256 === "string"
            ? { packageId: pkg.packageId, packageName: pkg.packageName, semver: pkg.semver, sha256: pkg.sha256 } : null,
    };
}

function definitionFrom(row: Row): SessionDefinitionRow {
    return {
        definitionId: String(row.definition_id), ownerSessionId: String(row.owner_session_id), name: String(row.name),
        currentRevision: Number(row.current_revision), source: row.source === null || row.source === undefined ? null : String(row.source),
        copiedFrom: row.source === "copy" ? copiedFromOf(row.created_by) : null,
        locked: row.locked === true, packageName: row.package_name === null || row.package_name === undefined ? null : String(row.package_name),
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), deletedAt: isoOrNull(row.deleted_at),
    };
}

function packageFrom(row: Row, packageName: string | null): SessionRevisionPackage | null {
    if (row.package_id === null || row.package_id === undefined) return null;
    return { packageId: String(row.package_id), packageName: packageName ?? "", semver: String(row.package_semver ?? ""),
        sha256: String(row.package_sha256 ?? ""), cardDigest: String(row.card_digest ?? "") };
}

function summaryFrom(row: Row): SessionRevisionSummary {
    const diagnostics = parse<WorkflowDiagnostic[]>(row.diagnostics, []);
    return {
        definitionId: String(row.definition_id), revision: Number(row.revision), valid: row.valid === true,
        semver: row.semver === null || row.semver === undefined ? null : String(row.semver), yamlSha256: String(row.yaml_sha256),
        irSha256: row.ir_sha256 === null || row.ir_sha256 === undefined ? null : String(row.ir_sha256),
        basedOn: row.based_on === null || row.based_on === undefined ? null : Number(row.based_on),
        actor: parse<SessionDefinitionActor>(row.actor, { kind: "system", name: "unknown" }), imported: row.imported === true,
        createdAt: iso(row.created_at), errorCount: Array.isArray(diagnostics) ? diagnostics.filter(item => item?.severity !== "warning").length : 0,
        package: packageFrom(row, row.package_name === null || row.package_name === undefined ? null : String(row.package_name)),
    };
}

/** E2-7: a package's definition is read-only in the session; the words say how to change it. */
export function lockedRefusal(definition: Pick<SessionDefinitionRow, "definitionId" | "name" | "packageName">): WorkflowStoreError {
    return new WorkflowStoreError("DEFINITION_LOCKED", `${definition.name} comes from the package ${definition.packageName ?? "it was published in"} and is `
        + "locked: it cannot be changed here. Make a copy of it (in the Workflow tab) and change the copy. Nothing was saved.",
    { definitionId: definition.definitionId, packageName: definition.packageName });
}

/** "the session", a person's name, or "the system", for the stale-save words (E2-3). */
export function sessionActorWords(actor: SessionDefinitionActor): string {
    if (actor.kind === "session") return "the session";
    if (actor.kind === "user") return actor.display?.trim() || actor.subject;
    return actor.name === "imported" ? "the import of stage 1 Workflows" : "the system";
}

export class SessionDefinitionStore {
    private readonly t: { definitions: string; revisions: string; operations: string; seen: string; notes: string; sessions: string; wfDefinitions: string; runs: string };

    constructor(private readonly pool: Pool, readonly schema: string) {
        const s = `"${schema}"`;
        this.t = {
            definitions: `${s}.session_workflow_definitions`, revisions: `${s}.session_workflow_revisions`, operations: `${s}.session_workflow_operations`,
            seen: `${s}.session_workflow_seen`, notes: `${s}.session_workflow_notes`, sessions: `${s}.sessions`,
            wfDefinitions: `${s}.workflow_definitions`, runs: `${s}.workflow_runs`,
        };
    }

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
                released = true;
                client.release(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
            }
            throw error;
        } finally {
            if (!released) client.release();
        }
    }

    /** Lock the session's row (`mode`) and require it live: not deleted, not completed, canceled or failed (Q7). */
    private async lockLiveOwnerSession(client: PoolClient, ownerSessionId: string, mode: "FOR SHARE" | "FOR NO KEY UPDATE"): Promise<void> {
        const { rows } = await client.query(`SELECT state, deleted_at, session_kind FROM ${this.t.sessions} WHERE session_id = $1 ${mode}`, [ownerSessionId]);
        const row = rows[0];
        if (!row || row.deleted_at !== null) throw new WorkflowStoreError("SESSION_NOT_FOUND", "This session does not exist or was deleted.");
        if (row.session_kind === "workflow") throw new WorkflowStoreError("SESSION_NOT_FOUND", "A Workflow does not own Workflow Definitions; its session does.");
        if (OWNER_SESSION_ENDED_STATES.includes(String(row.state))) {
            throw new WorkflowStoreError("SESSION_NOT_LIVE", `This session has ${row.state === "failed" ? "failed" : `been ${row.state === "cancelled" ? "canceled" : row.state}`}: `
                + "its Workflow Definitions can be read, not changed or started.", { state: String(row.state) });
        }
    }

    private async priorOperation<T>(client: PoolClient, ownerSessionId: string, operationId: string, kind: string, requestSha256: string): Promise<T | null> {
        const { rows } = await client.query(`SELECT kind, request_sha256, receipt FROM ${this.t.operations} WHERE owner_session_id = $1 AND operation_id = $2`,
            [ownerSessionId, operationId]);
        if (!rows[0]) return null;
        if (rows[0].kind !== kind || rows[0].request_sha256 !== requestSha256) {
            throw new WorkflowStoreError("OPERATION_CONFLICT", `Operation ${operationId} was used for a different request; use another operation id.`);
        }
        return JSON.parse(String(rows[0].receipt)) as T;
    }

    private async recordOperation(client: PoolClient, ownerSessionId: string, operationId: string, kind: string, requestSha256: string, receipt: unknown): Promise<void> {
        await client.query(`INSERT INTO ${this.t.operations} (owner_session_id, operation_id, kind, request_sha256, receipt) VALUES ($1, $2, $3, $4, $5)`,
            [ownerSessionId, operationId, kind, requestSha256, canonicalJson(receipt)]);
    }

    /**
     * Code check G2: the stored kind and receipt of an operation of this session, whatever its request digest; null when none is
     * stored. spawn_workflow's compatibility path reads its save receipt by operation id before it computes its guard, so an
     * exact repeat is answered from that receipt (its guard, from what the session has seen, has moved since).
     */
    async readStoredOperation<T>(ownerSessionId: string, operationId: string): Promise<{ kind: string; receipt: T } | null> {
        const { rows } = await this.pool.query(`SELECT kind, receipt FROM ${this.t.operations} WHERE owner_session_id = $1 AND operation_id = $2`,
            [ownerSessionId, operationId]);
        if (!rows[0]) return null;
        return { kind: String(rows[0].kind), receipt: JSON.parse(String(rows[0].receipt)) as T };
    }

    /** The stored receipt of an operation of this session, or null (another request with the id is refused, OPERATION_CONFLICT). */
    async readOperation<T>(ownerSessionId: string, operationId: string, kind: string, requestSha256: string): Promise<T | null> {
        const client = await this.pool.connect();
        try {
            return await this.priorOperation<T>(client, ownerSessionId, operationId, kind, requestSha256);
        } finally {
            client.release();
        }
    }

    /** Record an operation's receipt outside a save (a Start, whose own rows are the Workflow's); a replay keeps the first. */
    async recordStandaloneOperation(ownerSessionId: string, operationId: string, kind: string, requestSha256: string, receipt: unknown): Promise<void> {
        await this.pool.query(
            `INSERT INTO ${this.t.operations} (owner_session_id, operation_id, kind, request_sha256, receipt) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (owner_session_id, operation_id) DO NOTHING`,
            [ownerSessionId, operationId, kind, requestSha256, canonicalJson(receipt)]);
    }

    /**
     * Whether the session owns a Workflow Definition (deleted ones too) or a Workflow (a workflow child of any kind): Workflows on
     * demand turn on in such a session (one from before this release).
     */
    async hasWorkflows(ownerSessionId: string): Promise<boolean> {
        const { rows } = await this.pool.query(
            `SELECT EXISTS (SELECT 1 FROM ${this.t.definitions} WHERE owner_session_id = $1)
                 OR EXISTS (SELECT 1 FROM ${this.t.wfDefinitions} WHERE parent_session_id = $1) AS has`, [ownerSessionId]);
        return rows[0]?.has === true;
    }

    /** The session's definitions, oldest first; deleted ones only when asked. */
    async listDefinitions(ownerSessionId: string, options: { includeDeleted?: boolean } = {}): Promise<SessionDefinitionRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.t.definitions} WHERE owner_session_id = $1 ${options.includeDeleted ? "" : "AND deleted_at IS NULL"}
              ORDER BY created_at, definition_id`, [ownerSessionId]);
        return rows.map(definitionFrom);
    }

    async readDefinition(definitionId: string): Promise<SessionDefinitionRow | null> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.definitions} WHERE definition_id = $1`, [definitionId]);
        return rows[0] ? definitionFrom(rows[0]) : null;
    }

    /** The session's live definition of that name, or null. */
    async readDefinitionByName(ownerSessionId: string, name: string): Promise<SessionDefinitionRow | null> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.t.definitions} WHERE owner_session_id = $1 AND name = $2 AND deleted_at IS NULL`,
            [ownerSessionId, name]);
        return rows[0] ? definitionFrom(rows[0]) : null;
    }

    /** A definition's revisions, oldest first, without their YAML. */
    async listRevisions(definitionId: string): Promise<SessionRevisionSummary[]> {
        const { rows } = await this.pool.query(
            `SELECT r.definition_id, r.revision, r.valid, r.semver, r.yaml_sha256, r.ir_sha256, r.based_on, r.actor, r.imported, r.created_at, r.diagnostics,
                    r.package_id, r.package_semver, r.package_sha256, r.card_digest, d.package_name
               FROM ${this.t.revisions} r JOIN ${this.t.definitions} d ON d.definition_id = r.definition_id
              WHERE r.definition_id = $1 ORDER BY r.revision`, [definitionId]);
        return rows.map(summaryFrom);
    }

    /** One revision with its YAML and diagnostics, or null. */
    async readRevision(definitionId: string, revision: number): Promise<SessionRevisionRow | null> {
        const { rows } = await this.pool.query(
            `SELECT r.*, d.package_name FROM ${this.t.revisions} r JOIN ${this.t.definitions} d ON d.definition_id = r.definition_id
              WHERE r.definition_id = $1 AND r.revision = $2`, [definitionId, revision]);
        if (!rows[0]) return null;
        return { ...summaryFrom(rows[0]), yaml: String(rows[0].yaml), diagnostics: parse<WorkflowDiagnostic[]>(rows[0].diagnostics, []),
            card: rows[0].card === null || rows[0].card === undefined ? null : parse<JsonValue | null>(rows[0].card, null) };
    }

    /** The newest valid revision of a definition, or null (Q10: Start's default). */
    async newestValidRevision(definitionId: string): Promise<number | null> {
        const { rows } = await this.pool.query(`SELECT max(revision) AS revision FROM ${this.t.revisions} WHERE definition_id = $1 AND valid`, [definitionId]);
        return rows[0]?.revision === null || rows[0]?.revision === undefined ? null : Number(rows[0].revision);
    }

    /** A valid revision's compiled IR (checked against its stored hash). */
    async readRevisionIr(definitionId: string, revision: number): Promise<WorkflowIR> {
        const { rows } = await this.pool.query(`SELECT ir, ir_sha256 FROM ${this.t.revisions} WHERE definition_id = $1 AND revision = $2`, [definitionId, revision]);
        return revisionIrFrom(rows[0], revision, undefined);
    }

    /** The Workflows started from a definition (or every definition of a session), oldest first, with their live run's status. */
    async listWorkflows(filter: { definitionId?: string; ownerSessionId?: string }): Promise<SessionWorkflowRow[]> {
        const where = filter.definitionId ? "d.session_definition_id = $1" : "d.parent_session_id = $1 AND d.session_definition_id IS NOT NULL";
        const { rows } = await this.pool.query(
            `SELECT d.workflow_session_id, d.session_definition_id, d.session_revision, d.created_at,
                    (SELECT r.status FROM ${this.t.runs} r WHERE r.workflow_session_id = d.workflow_session_id AND r.mode = 'live'
                      ORDER BY r.created_at DESC LIMIT 1) AS run_status
               FROM ${this.t.wfDefinitions} d
               JOIN ${this.t.sessions} s ON s.session_id = d.workflow_session_id AND s.deleted_at IS NULL
              WHERE ${where}
              ORDER BY d.created_at, d.workflow_session_id`, [filter.definitionId ?? filter.ownerSessionId]);
        return rows.map((row: Row) => ({ workflowSessionId: String(row.workflow_session_id), definitionId: String(row.session_definition_id),
            revision: Number(row.session_revision), runStatus: row.run_status === null || row.run_status === undefined ? null : String(row.run_status),
            createdAt: iso(row.created_at) }));
    }

    /**
     * Stage 2.2: a session's agent tests (its test benches: service_kind workflow-test), newest first, each with its newest test
     * run; of one definition when `definitionId` is given. Deleted test benches are not listed.
     */
    async listTests(ownerSessionId: string, definitionId: string | null = null): Promise<DefinitionTestRow[]> {
        const { rows } = await this.pool.query(
            `SELECT s.session_id, s.created_at, s.creation_config, run.run_id, run.status, run.terminal_outcome, run.finished_at
               FROM ${this.t.sessions} s
               LEFT JOIN LATERAL (SELECT r.run_id, r.status, r.terminal_outcome, r.finished_at FROM ${this.t.runs} r
                                   WHERE r.workflow_session_id = s.session_id AND r.mode = 'test' ORDER BY r.created_at DESC LIMIT 1) run ON true
              WHERE s.parent_session_id = $1 AND s.service_kind = 'workflow-test' AND s.deleted_at IS NULL
                AND ($2::text IS NULL OR s.creation_config->'agentTest'->>'definitionId' = $2::text)
              ORDER BY s.created_at DESC, s.session_id`, [ownerSessionId, definitionId]);
        return rows.flatMap((row: Row) => {
            const config = typeof row.creation_config === "string" ? parse<Row>(row.creation_config, {}) : (row.creation_config ?? {}) as Row;
            const bench = config.agentTest && typeof config.agentTest === "object" ? config.agentTest as Row : null;
            const revision = Number(bench?.revision);
            if (!bench || typeof bench.definitionId !== "string" || !Number.isSafeInteger(revision)) return [];
            const status = row.status === null || row.status === undefined ? null : String(row.status);
            const outcome = row.terminal_outcome === null || row.terminal_outcome === undefined ? null : String(row.terminal_outcome);
            const verdict: DefinitionTestRow["verdict"] = status === null || ACTIVE.includes(status) ? "running"
                : status === "completed" && outcome === "succeeded" ? "passed" : "failed";
            return [{ testId: String(row.session_id), definitionId: bench.definitionId, revision, runId: row.run_id === null || row.run_id === undefined
                ? null : String(row.run_id), status, outcome, verdict, startedAt: iso(row.created_at), endedAt: isoOrNull(row.finished_at) }];
        });
    }

    /**
     * Stage 2.2: retire a definition's older agent tests: the test benches beyond the newest `keep` whose test ended are
     * deleted (the catalog's soft delete; their rows and runs stay). Returns the ids retired.
     */
    async retireTests(ownerSessionId: string, definitionId: string, keep: number): Promise<string[]> {
        // S2RT-F8: the newest `keep` ENDED tests stay; a running test is never retired and does not take an ended one's place.
        const ended = (await this.listTests(ownerSessionId, definitionId)).filter(test => test.verdict !== "running");
        const old = ended.slice(Math.max(0, keep));
        for (const test of old) await this.pool.query(`SELECT "${this.schema}".cms_soft_delete_session($1)`, [test.testId]);
        return old.map(test => test.testId);
    }

    /**
     * S2RT-F8: retention again when a test ends (its run finished, was canceled, or was ended elsewhere): the bench's own
     * session and definition, from its creation record. Repeat-safe, and safe when two tests end at once (a retired test is
     * soft-deleted once; a running one is never retired). Nothing for a session that is not a test bench.
     */
    async retireTestsAfterEnd(benchSessionId: string, keep: number = WORKFLOW_DEFINITION_TESTS_KEPT): Promise<string[]> {
        const { rows } = await this.pool.query(
            `SELECT parent_session_id, creation_config -> 'agentTest' ->> 'definitionId' AS definition_id FROM ${this.t.sessions}
              WHERE session_id = $1 AND service_kind = 'workflow-test'`, [benchSessionId]);
        const row = rows[0];
        if (!row?.parent_session_id || !row?.definition_id) return [];
        return this.retireTests(String(row.parent_session_id), String(row.definition_id), keep);
    }

    /**
     * Stage 2.4 (PR 235 2b893906): the session's running children, the budget spawn_agent and Start share: its sub-agents
     * that are running and its Workflows whose live run is active. Not its system sessions or service sessions (an agent's
     * test benches, stage 2.2).
     */
    async runningChildren(ownerSessionId: string, excludeSessionId = ""): Promise<number> {
        // S2RT-F3: the shared budget's count (child-budget.ts), the same as spawn_agent's. `excludeSessionId`: a Workflow whose
        // own claim is its reservation (review PRA-F2: a resumed Start is not counted against itself).
        const { rows } = await this.pool.query(childBudgetCountSql(`"${this.schema}"`), [ownerSessionId, excludeSessionId]);
        return Number(rows[0]?.n ?? 0);
    }

    /**
     * S2RT-F3: in a Start's claim transaction, lock the session's row exclusively, then refuse when its budget is full (the
     * claimed Workflow is not counted: its claim is its reservation). The same lock and count as spawn_agent's creation.
     * Lock-order check O1: the session must still be live under that lock (lockLiveOwnerSession), so a claim that waited behind the
     * session's deletion or end is refused and rolled back, and leaves no Workflow session, as a test bench's admission is
     * (requireBenchLiveLocked).
     */
    async requireChildBudgetLocked(client: PoolClient, ownerSessionId: string, workflowSessionId: string, max: number): Promise<void> {
        await this.lockLiveOwnerSession(client, ownerSessionId, "FOR NO KEY UPDATE");
        const { rows } = await client.query(childBudgetCountSql(`"${this.schema}"`), [ownerSessionId, workflowSessionId]);
        const count = Number(rows[0]?.n ?? 0);
        if (count >= max) {
            throw new WorkflowStoreError("CHILD_LIMIT", `${childBudgetWords(count, max)} Nothing was started.`, { running: count, max });
        }
    }

    /**
     * S2RT-F4: a session's nesting level from its stored lineage (0 the root, 1 its child, 2 a grandchild), as spawn_agent
     * counts it; at most 16 levels are followed.
     */
    async nestingLevel(sessionId: string): Promise<number> {
        const { rows } = await this.pool.query(
            `WITH RECURSIVE up(session_id, parent_session_id, depth) AS (
                 SELECT session_id, parent_session_id, 0 FROM ${this.t.sessions} WHERE session_id = $1
                 UNION ALL
                 SELECT p.session_id, p.parent_session_id, up.depth + 1 FROM ${this.t.sessions} p JOIN up ON p.session_id = up.parent_session_id
                  WHERE up.depth < 16)
             SELECT max(depth)::int AS level FROM up`, [sessionId]);
        return Number(rows[0]?.level ?? 0);
    }

    /** The newest revision of a definition the session itself has seen (its saves and reads), or null (Q2). */
    async seenRevision(ownerSessionId: string, definitionId: string): Promise<number | null> {
        const { rows } = await this.pool.query(`SELECT revision FROM ${this.t.seen} WHERE owner_session_id = $1 AND definition_id = $2`, [ownerSessionId, definitionId]);
        return rows[0] ? Number(rows[0].revision) : null;
    }

    /** The session has seen these revisions (a read or list of its own): each kept at its highest. */
    async markSeen(ownerSessionId: string, seen: Array<{ definitionId: string; revision: number }>): Promise<void> {
        for (const item of seen) {
            if (!(item.revision >= 1)) continue;
            await this.pool.query(
                `INSERT INTO ${this.t.seen} (owner_session_id, definition_id, revision) VALUES ($1, $2, $3)
                 ON CONFLICT (owner_session_id, definition_id) DO UPDATE SET revision = GREATEST(${this.t.seen}.revision, EXCLUDED.revision), updated_at = now()`,
                [ownerSessionId, item.definitionId, item.revision]);
        }
    }

    /**
     * Save a revision (spec E2-1..E2-6; Q1, Q3, Q7). `expected` null: the first save of `name` in this session (refused,
     * DEFINITION_EXISTS, when the session already has one). Otherwise the save names the definition and the revision it was
     * based on: a definition of another session or name is not found, a deleted one is refused (DEFINITION_DELETED), and a
     * newer revision saved meanwhile refuses it (REVISION_STALE, with who saved it and when). A revision that is not valid
     * is saved with its diagnostics (E2-5). `seenBySession`: the session's own save (it has seen what it saved). `noteBy`: a
     * person's save leaves a note naming them for the session's next turn (E2-4); it never starts a turn. A repeated operation is answered from its receipt.
     */
    async save(input: {
        ownerSessionId: string;
        name: string;
        yaml: string;
        compiled: WorkflowCompileResult;
        expected: { definitionId: string; revision: number } | null;
        actor: SessionDefinitionActor;
        operationId: string;
        requestSha256: string;
        seenBySession: boolean;
        /** A person's save: their name for the note the session reads ("Affan Dar saved hn-top-watch revision 6."). */
        noteBy?: string | null;
        /** L1: a first save that is a Make a copy: the definition is source 'copy', and its creation record names its source. */
        copiedFrom?: SessionCopiedFrom | null;
    }): Promise<StoredSessionOperation<SessionSaveReceipt>> {
        return this.transaction(async client => {
            const prior = await this.priorOperation<SessionSaveReceipt>(client, input.ownerSessionId, input.operationId, "save", input.requestSha256);
            if (prior) return { receipt: prior, replayed: true };
            await this.lockLiveOwnerSession(client, input.ownerSessionId, "FOR NO KEY UPDATE");
            // Formal L3 (the 2.1 save has the same shape): a concurrent repeat stored its receipt while this one waited.
            const stored = await this.priorOperation<SessionSaveReceipt>(client, input.ownerSessionId, input.operationId, "save", input.requestSha256);
            if (stored) return { receipt: stored, replayed: true };
            let definition: SessionDefinitionRow;
            let created = false;
            if (input.expected === null) {
                const copied = input.copiedFrom ?? null;
                const { rows } = await client.query(
                    `INSERT INTO ${this.t.definitions} (definition_id, owner_session_id, name, current_revision, source, created_by)
                     VALUES ($1, $2, $3, 0, $4, $5) ON CONFLICT DO NOTHING RETURNING *`,
                    [randomUUID(), input.ownerSessionId, input.name, copied ? "copy" : null,
                        canonicalJson(copied ? { ...input.actor, copiedFrom: copied } as unknown as JsonValue : input.actor)]);
                if (!rows[0]) {
                    const existing = await client.query(`SELECT * FROM ${this.t.definitions} WHERE owner_session_id = $1 AND name = $2 AND deleted_at IS NULL`,
                        [input.ownerSessionId, input.name]);
                    const found = existing.rows[0] ? definitionFrom(existing.rows[0]) : null;
                    throw new WorkflowStoreError("DEFINITION_EXISTS", `This session already has ${input.name}${found ? ` (revision ${found.currentRevision})` : ""}. `
                        + "Read it, then save with its definition id and revision.",
                        found ? { definitionId: found.definitionId, currentRevision: found.currentRevision } : null);
                }
                definition = definitionFrom(rows[0]);
                created = true;
            } else {
                const { rows } = await client.query(`SELECT * FROM ${this.t.definitions} WHERE definition_id = $1 FOR UPDATE`, [input.expected.definitionId]);
                const found = rows[0] ? definitionFrom(rows[0]) : null;
                if (!found || found.ownerSessionId !== input.ownerSessionId) {
                    throw new WorkflowStoreError("DEFINITION_NOT_FOUND", `This session has no Workflow Definition ${input.expected.definitionId}.`);
                }
                if (found.deletedAt !== null) {
                    throw new WorkflowStoreError("DEFINITION_DELETED", `${found.name} was deleted. Nothing was saved.`,
                        { definitionId: found.definitionId, deletedAt: found.deletedAt });
                }
                // DS-1: a locked definition is refused as locked, whatever name the save gives.
                if (found.locked) throw lockedRefusal(found);
                if (found.name !== input.name) {
                    throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `Definition ${found.definitionId} is ${found.name}, not ${input.name}.`);
                }
                if (found.currentRevision !== input.expected.revision) {
                    const latest = await client.query(`SELECT actor, created_at FROM ${this.t.revisions} WHERE definition_id = $1 AND revision = $2`,
                        [found.definitionId, found.currentRevision]);
                    const by = latest.rows[0] ? parse<SessionDefinitionActor>(latest.rows[0].actor, { kind: "system", name: "unknown" }) : { kind: "system", name: "unknown" } as SessionDefinitionActor;
                    const at = latest.rows[0] ? iso(latest.rows[0].created_at) : null;
                    throw new WorkflowStoreError("REVISION_STALE",
                        `Revision ${found.currentRevision} was saved by ${sessionActorWords(by)}${at ? ` at ${at}` : ""}. Reload to edit it. Nothing was saved.`,
                        { definitionId: found.definitionId, currentRevision: found.currentRevision, expectedRevision: input.expected.revision,
                            savedBy: by as unknown as JsonValue, savedAt: at });
                }
                if (found.currentRevision >= SESSION_DEFINITION_MAX_REVISIONS) {
                    throw new WorkflowStoreError("REVISION_LIMIT", `${found.name} has ${found.currentRevision} revisions, the most one definition keeps.`);
                }
                definition = found;
            }
            const revision = definition.currentRevision + 1;
            const basedOn = definition.currentRevision === 0 ? null : definition.currentRevision;
            const { rows: saved } = await client.query(
                `INSERT INTO ${this.t.revisions} (definition_id, revision, yaml, yaml_sha256, valid, diagnostics, semver, ir, ir_sha256, based_on, actor)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING created_at`,
                [definition.definitionId, revision, input.yaml, input.compiled.yamlSha256, input.compiled.valid, canonicalJson(input.compiled.diagnostics),
                    input.compiled.version, input.compiled.ir ? canonicalJson(input.compiled.ir) : null, input.compiled.irSha256, basedOn, canonicalJson(input.actor)]);
            await client.query(`UPDATE ${this.t.definitions} SET current_revision = $2, updated_at = now() WHERE definition_id = $1`, [definition.definitionId, revision]);
            if (input.seenBySession) {
                await client.query(
                    `INSERT INTO ${this.t.seen} (owner_session_id, definition_id, revision) VALUES ($1, $2, $3)
                     ON CONFLICT (owner_session_id, definition_id) DO UPDATE SET revision = GREATEST(${this.t.seen}.revision, EXCLUDED.revision), updated_at = now()`,
                    [input.ownerSessionId, definition.definitionId, revision]);
            }
            if (typeof input.noteBy === "string" && input.noteBy.trim()) {
                await client.query(`INSERT INTO ${this.t.notes} (owner_session_id, definition_id, revision, text) VALUES ($1, $2, $3, $4)`,
                    [input.ownerSessionId, definition.definitionId, revision, `${input.noteBy.trim()} saved ${definition.name} revision ${revision}.`]);
            }
            const receipt: SessionSaveReceipt = {
                operation: "save", definitionId: definition.definitionId, name: definition.name, revision, basedOn, created,
                valid: input.compiled.valid, semver: input.compiled.version, yamlSha256: input.compiled.yamlSha256, irSha256: input.compiled.irSha256,
                diagnostics: input.compiled.diagnostics, savedAt: iso(saved[0].created_at),
            };
            await this.recordOperation(client, input.ownerSessionId, input.operationId, "save", input.requestSha256, receipt);
            return { receipt, replayed: false };
        });
    }

    /**
     * Stage 2.3 (P2, P5, P6): attach a package version of a Workflow Definition to the session, as its locked definition
     * `name` (`<package>/<name>`). The first attach makes the definition at revision 1; a later one with another package
     * version adds a revision (the next Workflow starts it; running ones keep theirs, R1, P6); the same version again adds
     * nothing. `compiled` must be valid (the package was checked when it was published; the caller refuses a definition this
     * host cannot run). `workflowRef`: the session is the coordinating session made for it (P2): its session row records the
     * reference once. Under the session's lock, as a save is (Q3, Q7). A repeated operation is answered from its receipt.
     */
    async attachPackage(input: {
        ownerSessionId: string;
        name: string;
        yaml: string;
        compiled: WorkflowCompileResult;
        package: SessionRevisionPackage;
        card: JsonValue;
        actor: SessionDefinitionActor;
        operationId: string;
        requestSha256: string;
        seenBySession: boolean;
        workflowRef?: string | null;
        /** S2SF-F6 / L4: an existing definition takes only the same package's strictly greater version (PACKAGE_NOT_NEWER). */
        newerOnly?: boolean;
    }): Promise<StoredSessionOperation<SessionAttachReceipt>> {
        if (!input.compiled.valid || !input.compiled.ir || !input.compiled.irSha256) {
            throw new WorkflowStoreError("DEFINITION_INVALID", `${input.name} is not a valid Workflow Definition here. Nothing was attached.`);
        }
        return this.transaction(async client => {
            const prior = await this.priorOperation<SessionAttachReceipt>(client, input.ownerSessionId, input.operationId, "attach", input.requestSha256);
            if (prior) return { receipt: prior, replayed: true };
            await this.lockLiveOwnerSession(client, input.ownerSessionId, "FOR NO KEY UPDATE");
            // Formal L3: the same operation running at the same time stored its receipt while this one waited for the session.
            const stored = await this.priorOperation<SessionAttachReceipt>(client, input.ownerSessionId, input.operationId, "attach", input.requestSha256);
            if (stored) return { receipt: stored, replayed: true };
            const live = async () => {
                const { rows } = await client.query(`SELECT * FROM ${this.t.definitions} WHERE owner_session_id = $1 AND name = $2 AND deleted_at IS NULL FOR UPDATE`,
                    [input.ownerSessionId, input.name]);
                return rows[0] ? definitionFrom(rows[0]) : null;
            };
            let definition = await live();
            let created = false;
            if (!definition) {
                const { rows } = await client.query(
                    `INSERT INTO ${this.t.definitions} (definition_id, owner_session_id, name, current_revision, source, created_by, locked, package_name)
                     VALUES ($1, $2, $3, 0, 'package', $4, TRUE, $5) ON CONFLICT DO NOTHING RETURNING *`,
                    [randomUUID(), input.ownerSessionId, input.name, canonicalJson(input.actor), input.package.packageName]);
                definition = rows[0] ? definitionFrom(rows[0]) : await live();
                created = Boolean(rows[0]);
            }
            if (!definition) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `${input.name} could not be attached. Nothing was attached.`);
            if (!definition.locked) {
                throw new WorkflowStoreError("DEFINITION_EXISTS", `This session has its own definition named ${input.name}. Nothing was attached.`,
                    { definitionId: definition.definitionId });
            }
            let changed = true;
            if (definition.currentRevision > 0) {
                const { rows } = await client.query(`SELECT package_id, package_semver, package_sha256 FROM ${this.t.revisions} WHERE definition_id = $1 AND revision = $2`,
                    [definition.definitionId, definition.currentRevision]);
                if (rows[0]?.package_id === input.package.packageId && rows[0]?.package_sha256 === input.package.sha256) changed = false;
                else if (input.newerOnly) {
                    const attached = { packageId: String(rows[0]?.package_id ?? ""), semver: String(rows[0]?.package_semver ?? "") };
                    if (!packageVersionIsNewer(attached, input.package)) {
                        throw new WorkflowStoreError("PACKAGE_NOT_NEWER", attached.packageId !== input.package.packageId
                            ? `The ${input.name} you can use now is another package of that name, not the one this session has (${attached.semver}). `
                                + "Nothing was attached; its Workflows start the version it has."
                            : `The package's active version is ${input.package.semver}, not newer than the ${attached.semver} this session has. `
                                + `Nothing was attached; its Workflows start ${attached.semver}.`,
                        { definitionId: definition.definitionId, attached: attached.semver, active: input.package.semver });
                    }
                }
            }
            let revision = definition.currentRevision;
            let attachedAt = new Date().toISOString();
            if (changed) {
                if (definition.currentRevision >= SESSION_DEFINITION_MAX_REVISIONS) {
                    throw new WorkflowStoreError("REVISION_LIMIT", `${definition.name} has ${definition.currentRevision} revisions, the most one definition keeps.`);
                }
                revision = definition.currentRevision + 1;
                const { rows: saved } = await client.query(
                    `INSERT INTO ${this.t.revisions} (definition_id, revision, yaml, yaml_sha256, valid, diagnostics, semver, ir, ir_sha256, based_on, actor,
                                                     package_id, package_semver, package_sha256, card, card_digest)
                     VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING created_at`,
                    [definition.definitionId, revision, input.yaml, input.compiled.yamlSha256, canonicalJson(input.compiled.diagnostics), input.compiled.version,
                        canonicalJson(input.compiled.ir), input.compiled.irSha256, definition.currentRevision === 0 ? null : definition.currentRevision,
                        canonicalJson(input.actor), input.package.packageId, input.package.semver, input.package.sha256, canonicalJson(input.card),
                        input.package.cardDigest]);
                attachedAt = iso(saved[0].created_at);
                await client.query(`UPDATE ${this.t.definitions} SET current_revision = $2, updated_at = now() WHERE definition_id = $1`,
                    [definition.definitionId, revision]);
            }
            if (input.seenBySession) {
                await client.query(
                    `INSERT INTO ${this.t.seen} (owner_session_id, definition_id, revision) VALUES ($1, $2, $3)
                     ON CONFLICT (owner_session_id, definition_id) DO UPDATE SET revision = GREATEST(${this.t.seen}.revision, EXCLUDED.revision), updated_at = now()`,
                    [input.ownerSessionId, definition.definitionId, revision]);
            }
            if (input.workflowRef) {
                await client.query(`UPDATE ${this.t.sessions} SET workflow_ref = $2 WHERE session_id = $1 AND workflow_ref IS NULL`,
                    [input.ownerSessionId, input.workflowRef]);
            }
            const receipt: SessionAttachReceipt = { operation: "attach", definitionId: definition.definitionId, name: definition.name, revision, created, changed,
                package: { ...input.package }, attachedAt };
            await this.recordOperation(client, input.ownerSessionId, input.operationId, "attach", input.requestSha256, receipt);
            return { receipt, replayed: false };
        });
    }

    /**
     * Delete a definition (a person's, Q8). Refused while one of its Workflows is active (R6: DEFINITION_IN_USE, naming
     * them); its revisions stay, so a finished Workflow keeps its pinned copy. A repeated operation is answered from its
     * receipt.
     */
    async deleteDefinition(input: { ownerSessionId: string; definitionId: string; actor: SessionDefinitionActor; operationId: string; requestSha256: string })
        : Promise<StoredSessionOperation<SessionDeleteReceipt>> {
        return this.transaction(async client => {
            const prior = await this.priorOperation<SessionDeleteReceipt>(client, input.ownerSessionId, input.operationId, "delete", input.requestSha256);
            if (prior) return { receipt: prior, replayed: true };
            await this.lockLiveOwnerSession(client, input.ownerSessionId, "FOR SHARE");
            const { rows } = await client.query(`SELECT * FROM ${this.t.definitions} WHERE definition_id = $1 FOR UPDATE`, [input.definitionId]);
            const found = rows[0] ? definitionFrom(rows[0]) : null;
            if (!found || found.ownerSessionId !== input.ownerSessionId) {
                throw new WorkflowStoreError("DEFINITION_NOT_FOUND", `This session has no Workflow Definition ${input.definitionId}.`);
            }
            if (found.deletedAt !== null) throw new WorkflowStoreError("DEFINITION_DELETED", `${found.name} was already deleted.`, { definitionId: found.definitionId });
            const active = await client.query(
                `SELECT d.workflow_session_id, s.title FROM ${this.t.wfDefinitions} d
                   JOIN ${this.t.runs} r ON r.workflow_session_id = d.workflow_session_id AND r.mode = 'live' AND r.status = ANY($2::text[])
                   JOIN ${this.t.sessions} s ON s.session_id = d.workflow_session_id AND s.deleted_at IS NULL
                  WHERE d.session_definition_id = $1 ORDER BY d.created_at`, [input.definitionId, ACTIVE]);
            if (active.rows.length) {
                const ids = active.rows.map((row: Row) => String(row.workflow_session_id));
                throw new WorkflowStoreError("DEFINITION_IN_USE",
                    `${found.name} has ${ids.length === 1 ? "a Workflow" : `${ids.length} Workflows`} still running. Stop ${ids.length === 1 ? "it" : "them"} first, then delete it.`,
                    { definitionId: found.definitionId, workflowSessionIds: ids });
            }
            const { rows: deleted } = await client.query(
                `UPDATE ${this.t.definitions} SET deleted_at = now(), deleted_by = $2, updated_at = now() WHERE definition_id = $1 RETURNING deleted_at`,
                [input.definitionId, canonicalJson(input.actor)]);
            // S2RT-F6: its hidden tests end with it (their reports stay): their bench sessions in id order, then their active test
            // runs in id order, then their pending nodes, their runs and their sessions, as the owner-session-ended trigger does.
            await endDefinitionTests(client, this.schema, input.ownerSessionId, input.definitionId);
            const receipt: SessionDeleteReceipt = { operation: "delete", definitionId: found.definitionId, name: found.name, deletedAt: iso(deleted[0].deleted_at) };
            await this.recordOperation(client, input.ownerSessionId, input.operationId, "delete", input.requestSha256, receipt);
            return { receipt, replayed: false };
        });
    }

    /**
     * Deployed check DS-2: keep `text` (a Workflow's end notice) as a note `ownerSessionId`'s next turn reads, as a person's
     * save note is read (E2-4, F3). Once: the same text for the same session and definition is kept once (a retried notice
     * runs under its run's notice lock, so its look and its write are not raced by another attempt of that notice).
     */
    async keepNote(ownerSessionId: string, definitionId: string, revision: number, text: string): Promise<void> {
        await this.keepNoteIn(this.pool, ownerSessionId, definitionId, revision, text);
    }

    /** keepNote on `client`, inside its caller's transaction (review R3-PA1: a run's end kept as a note and its skip record). */
    async keepNoteIn(client: Pick<PoolClient, "query">, ownerSessionId: string, definitionId: string, revision: number, text: string): Promise<void> {
        await client.query(
            `INSERT INTO ${this.t.notes} (owner_session_id, definition_id, revision, text)
             SELECT $1::text, $2::text, $3::int, $4::text WHERE NOT EXISTS (
                 SELECT 1 FROM ${this.t.notes} WHERE owner_session_id = $1::text AND definition_id = $2::text AND text = $4::text)`,
            [ownerSessionId, definitionId, revision, text]);
    }

    /** A person's save notes the session has not read with a turn that succeeded (E2-4, F3), oldest first. */
    async pendingNotes(ownerSessionId: string): Promise<SessionNoteRow[]> {
        const { rows } = await this.pool.query(
            `SELECT note_id, definition_id, revision, text, created_at FROM ${this.t.notes}
              WHERE owner_session_id = $1 AND consumed_at IS NULL ORDER BY note_id LIMIT 50`, [ownerSessionId]);
        return rows.map((row: Row) => ({ noteId: Number(row.note_id), definitionId: String(row.definition_id), revision: Number(row.revision),
            text: String(row.text), createdAt: iso(row.created_at) }));
    }

    /** The notes a turn that succeeded read are consumed (F3); a note already consumed stays as it was. */
    async consumeNotes(ownerSessionId: string, noteIds: readonly number[]): Promise<void> {
        if (!noteIds.length) return;
        await this.pool.query(`UPDATE ${this.t.notes} SET consumed_at = now() WHERE owner_session_id = $1 AND note_id = ANY($2::bigint[]) AND consumed_at IS NULL`,
            [ownerSessionId, [...noteIds]]);
    }
}

/**
 * Start's checks (Q3), in the transaction that stores the Workflow's definition and admits its run, before the Workflow's
 * own rows are locked: the session is live (its row FOR SHARE, which a session's completion, cancel, failure or deletion waits
 * for, and whose trigger then ends the run: R4, R5, F2), the definition is the session's and not deleted (its row FOR SHARE,
 * which a delete waits for: R6), and the revision exists, is valid and is the YAML being stored (R1, E2-5).
 */
export async function requireSessionStartLocked(client: PoolClient, schema: string,
    pin: { ownerSessionId: string; definitionId: string; revision: number }, yamlSha256: string): Promise<void> {
    const s = `"${schema}"`;
    const session = await client.query(`SELECT state, deleted_at FROM ${s}.sessions WHERE session_id = $1 FOR SHARE`, [pin.ownerSessionId]);
    if (!session.rows[0] || session.rows[0].deleted_at !== null) throw new WorkflowStoreError("SESSION_NOT_FOUND", "This session does not exist or was deleted. Nothing was started.");
    if (OWNER_SESSION_ENDED_STATES.includes(String(session.rows[0].state))) {
        throw new WorkflowStoreError("SESSION_NOT_LIVE", "This session has ended: its Workflow Definitions cannot be started. Nothing was started.",
            { state: String(session.rows[0].state) });
    }
    const definition = await client.query(`SELECT owner_session_id, name, deleted_at FROM ${s}.session_workflow_definitions WHERE definition_id = $1 FOR SHARE`,
        [pin.definitionId]);
    const row = definition.rows[0];
    if (!row || row.owner_session_id !== pin.ownerSessionId) throw new WorkflowStoreError("DEFINITION_NOT_FOUND", `This session has no Workflow Definition ${pin.definitionId}.`);
    if (row.deleted_at !== null) throw new WorkflowStoreError("DEFINITION_DELETED", `${row.name} was deleted. Nothing was started.`, { definitionId: pin.definitionId });
    const revision = await client.query(`SELECT valid, yaml_sha256 FROM ${s}.session_workflow_revisions WHERE definition_id = $1 AND revision = $2`,
        [pin.definitionId, pin.revision]);
    if (!revision.rows[0]) throw new WorkflowStoreError("REVISION_NOT_FOUND", `${row.name} has no revision ${pin.revision}.`);
    if (revision.rows[0].valid !== true) {
        throw new WorkflowStoreError("DEFINITION_INVALID", `Revision ${pin.revision} of ${row.name} is not valid, so it cannot start. Save a fixed revision first.`);
    }
    if (revision.rows[0].yaml_sha256 !== yamlSha256) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Revision ${pin.revision} of ${row.name} is not this YAML.`);
}

/** S2RT-F6: the definition's active hidden tests end, in the runtime's lock order (session, run, node). */
async function endDefinitionTests(client: PoolClient, schema: string, ownerSessionId: string, definitionId: string): Promise<void> {
    const s = `"${schema}"`;
    const envelope = canonicalJson({ code: "cancelled", message: "The definition this test ran was deleted, so the test was canceled." });
    const benches = `SELECT session_id FROM ${s}.sessions WHERE parent_session_id = $1 AND service_kind = 'workflow-test' AND deleted_at IS NULL
                        AND creation_config -> 'agentTest' ->> 'definitionId' = $2`;
    await client.query(`${benches} ORDER BY session_id FOR NO KEY UPDATE`, [ownerSessionId, definitionId]);
    const active = `SELECT run_id FROM ${s}.workflow_runs WHERE workflow_session_id IN (${benches}) AND mode = 'test'
                      AND status IN ('admitted', 'running', 'paused')`;
    await client.query(`${active} ORDER BY run_id FOR UPDATE`, [ownerSessionId, definitionId]);
    await client.query(
        `UPDATE ${s}.workflow_node_executions SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error', error = $3, output = NULL,
                winner = 'delete', completed_at = now()
          WHERE run_id IN (${active}) AND state = 'pending'`, [ownerSessionId, definitionId, envelope]);
    const { rows } = await client.query(
        `UPDATE ${s}.workflow_runs SET status = 'cancelled', paused_from = NULL, terminal_error = $3, updated_at = now(), finished_at = now()
          WHERE run_id IN (${active}) RETURNING workflow_session_id`, [ownerSessionId, definitionId, envelope]);
    if (rows.length) {
        await client.query(`UPDATE ${s}.sessions SET state = 'cancelled', updated_at = now() WHERE session_id = ANY($1::text[]) AND deleted_at IS NULL`,
            [rows.map((row: Row) => String(row.workflow_session_id))]);
    }
}

/**
 * S2RT-F6: a hidden test bench of the session's definition is made and its test admitted only while the session is live and the
 * definition is not deleted, checked under their locks (the session FOR SHARE, then the definition FOR SHARE: the order of a
 * Start, before the bench's own rows). A session that ended or was deleted, or a definition deleted, makes nothing.
 */
export async function requireBenchLiveLocked(client: PoolClient, schema: string, bench: { ownerSessionId: string; definitionId: string }): Promise<void> {
    const s = `"${schema}"`;
    const session = await client.query(`SELECT state, deleted_at FROM ${s}.sessions WHERE session_id = $1 FOR SHARE`, [bench.ownerSessionId]);
    if (!session.rows[0] || session.rows[0].deleted_at !== null) throw new WorkflowStoreError("SESSION_NOT_FOUND", "This session does not exist or was deleted. Nothing was tested.");
    if (OWNER_SESSION_ENDED_STATES.includes(String(session.rows[0].state))) {
        throw new WorkflowStoreError("SESSION_NOT_LIVE", "This session has ended: its Workflow Definitions cannot be tested. Nothing was tested.",
            { state: String(session.rows[0].state) });
    }
    const definition = await client.query(`SELECT owner_session_id, name, deleted_at FROM ${s}.session_workflow_definitions WHERE definition_id = $1 FOR SHARE`,
        [bench.definitionId]);
    const row = definition.rows[0];
    if (!row || row.owner_session_id !== bench.ownerSessionId) throw new WorkflowStoreError("DEFINITION_NOT_FOUND", `This session has no Workflow Definition ${bench.definitionId}.`);
    if (row.deleted_at !== null) throw new WorkflowStoreError("DEFINITION_DELETED", `${row.name} was deleted. Nothing was tested.`, { definitionId: bench.definitionId });
}

/** The digest a stored save's request is recognized by (its definition, revision guard, YAML and author kind). */
export function sessionSaveRequestSha256(input: { name: string; yamlSha256: string; expected: { definitionId: string; revision: number } | null }): string {
    return sha256Hex(canonicalJson({ kind: "save", name: input.name, yamlSha256: input.yamlSha256, expected: input.expected }));
}
