/**
 * Migration 0089 (workflow session names), on PostgreSQL (and HorizonDB, with the HorizonDB storage set):
 * - A database at 0088 with a row in every renamed table upgrades to 0089: every row is kept, under the new names
 *   (session_workflow_*, session_definition_id / session_revision), and the stored "chat" values say "session".
 * - Both triggers work after the rename: the owner session ending (its Workflows' active runs are cancelled; deleted,
 *   its definitions are deleted by owner-session-deleted and its Workflow sessions with them), and a Workflow
 *   session's own deletion (its definition becomes a tombstone and its active run is cancelled).
 * - 0089 run a second time changes nothing (the catalog snapshot and the rows are the same).
 * - A fresh install of 0001..0089 has the same catalog as the upgraded database, and no table, column, constraint,
 *   function or trigger name says "chat" (an index's own column names keep the names they were built with).
 *
 * Run: npx vitest run test/local/workflow-migration-0089.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { schemaSnapshot, snapshotDifferences } from "../helpers/schema-snapshot.js";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { workflowSessionNamesMigration } from "../../src/migrations/workflow-session-names-0089.ts";
import { runMigrations } from "../../src/pg-migrator.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const CMS_LOCK_SEED = 0x63_6D_73;
const TABLES = ["definitions", "revisions", "operations", "seen", "notes"];

/** Rows at 0088: an owner session with two Workflows (each with an active run and a pending agent node) and one row in
 * every owner-side table; the stored values 0088's code wrote say "chat". */
async function seedAt0088(query, s) {
    await query(`INSERT INTO ${s}.sessions (session_id, state) VALUES ('owner-a', 'running'), ('owner-b', 'running')`);
    for (const [id, owner] of [["wf-a", "owner-a"], ["wf-b", "owner-b"], ["wf-c", "owner-a"]]) {
        await query(`SELECT ${s}.cms_create_workflow_session($1, $2, '{}'::jsonb)`, [id, owner]);
        await query(`INSERT INTO ${s}.workflow_definitions (workflow_session_id, parent_session_id, api_version, state, current_revision,
            chat_definition_id, chat_revision) VALUES ($1, $2, 'pilotswarm.dev/v1', 'draft', 1, 'def-1', 1)`, [id, owner]);
        await query(`INSERT INTO ${s}.workflow_revisions (workflow_session_id, revision, yaml, yaml_sha256, valid, diagnostics, ir, ir_sha256, actor)
            VALUES ($1, 1, 'y', 'ys', TRUE, '[]', '{}', 'is', '{"kind":"agent","sessionId":"owner-a"}')`, [id]);
        await query(`INSERT INTO ${s}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs,
            controller_instance_id, status, start_operation_id) VALUES ($1, $2, 'live', 1, 'ys', 'is', '{}', $3, 'running', 'op')`,
        [`run-${id}`, id, `session-${id}`]);
        await query(`INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input,
            input_sha256, state) VALUES ($1, $2, 'root', 'talk', 1, 'agent', '{}', 'h', 'pending')`, [`nx-${id}`, `run-${id}`]);
        await query(`INSERT INTO ${s}.workflow_agent_invocations (node_execution_id, run_id, workflow_session_id, child_session_id, task,
            outcomes, deadline_at, created_at, end_requested, end_requested_at, end_sent_at, end_child_status)
            VALUES ($1, $2, $3, $4, 't', '[]', now() + interval '1 hour', now(), 'done', now(), now(), $5)`,
        [`nx-${id}`, `run-${id}`, id, `child-${id}`, id === "wf-a" ? "ChatEnded" : "ChatContinues"]);
    }
    await query(`INSERT INTO ${s}.workflow_chat_definitions (definition_id, owner_session_id, name, current_revision, source, created_by)
        VALUES ('def-1', 'owner-a', 'watch', 1, 'chat', '{"kind":"chat","sessionId":"owner-a"}'),
               ('def-2', 'owner-b', 'other', 1, NULL, '{"kind":"user","provider":"p","subject":"s"}')`);
    await query(`UPDATE ${s}.workflow_chat_definitions SET deleted_at = now(), deleted_by = '{"kind":"system","name":"chat-deleted"}'
        WHERE definition_id = 'def-2'`);
    await query(`INSERT INTO ${s}.workflow_chat_revisions (definition_id, revision, yaml, yaml_sha256, valid, diagnostics, ir, ir_sha256, actor)
        VALUES ('def-1', 1, 'y', 'ys', TRUE, '[]', '{}', 'is', '{"kind":"chat","sessionId":"owner-a"}'),
               ('def-2', 1, 'y', 'ys', TRUE, '[]', '{}', 'is', '{"kind":"user","provider":"p","subject":"s"}')`);
    await query(`INSERT INTO ${s}.workflow_chat_operations (owner_session_id, operation_id, kind, request_sha256, receipt)
        VALUES ('owner-a', 'op-1', 'save', 'r', '{}')`);
    await query(`INSERT INTO ${s}.workflow_chat_seen (owner_session_id, definition_id, revision) VALUES ('owner-a', 'def-1', 1)`);
    await query(`INSERT INTO ${s}.workflow_chat_notes (owner_session_id, definition_id, revision, text) VALUES ('owner-a', 'def-1', 1, 'saved')`);
}

const count = async (query, sql) => Number((await query(sql)).rows[0].n);

describe("migration 0089: the owner side's session names", () => {
    it("upgrades a database at 0088: every row kept, both triggers work, a run again changes nothing, a fresh install is the same", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const pool = new pg.Pool({ connectionString: env.store, max: 1 });
        const query = (sql, params) => pool.query(sql, params);
        const tag = randomUUID().replace(/-/g, "").slice(0, 12);
        // Names of one length: main's indexes carry the schema's name, cut at 63 bytes.
        const upgraded = `wf0089_${tag}_u`;
        const fresh = `wf0089_${tag}_f`;
        const s = `"${upgraded}"`;
        try {
            await runMigrations(pool, upgraded, CMS_MIGRATIONS(upgraded).filter(item => item.version <= "0088"), CMS_LOCK_SEED);
            await seedAt0088(query, s);
            const before = {};
            for (const table of TABLES) before[table] = await count(query, `SELECT count(*)::int AS n FROM ${s}.workflow_chat_${table}`);
            expect(Object.values(before).every(n => n > 0)).toBe(true);

            await runMigrations(pool, upgraded, CMS_MIGRATIONS(upgraded).filter(item => item.version <= "0089"), CMS_LOCK_SEED);
            expect((await query(`SELECT version FROM ${s}.schema_migrations WHERE version > '0087' ORDER BY version`)).rows.map(row => row.version))
                .toEqual(["0088", "0089"]);

            // Every row is kept under the new names; the old names are gone.
            for (const table of TABLES) {
                expect(await count(query, `SELECT count(*)::int AS n FROM ${s}.session_workflow_${table}`)).toBe(before[table]);
                expect((await query(`SELECT to_regclass($1) AS r`, [`${upgraded}.workflow_chat_${table}`])).rows[0].r).toBeNull();
            }
            expect((await query(`SELECT session_definition_id AS id, session_revision AS rev FROM ${s}.workflow_definitions WHERE workflow_session_id = 'wf-a'`)).rows)
                .toEqual([{ id: "def-1", rev: 1 }]);
            // The stored values say "session"; others are unchanged.
            expect((await query(`SELECT definition_id, source, created_by, deleted_by FROM ${s}.session_workflow_definitions ORDER BY definition_id`)).rows).toEqual([
                { definition_id: "def-1", source: "session", created_by: '{"kind":"session","sessionId":"owner-a"}', deleted_by: null },
                { definition_id: "def-2", source: null, created_by: '{"kind":"user","provider":"p","subject":"s"}',
                    deleted_by: '{"kind":"system","name":"owner-session-deleted"}' },
            ]);
            expect((await query(`SELECT actor FROM ${s}.session_workflow_revisions ORDER BY definition_id`)).rows.map(row => row.actor))
                .toEqual(['{"kind":"session","sessionId":"owner-a"}', '{"kind":"user","provider":"p","subject":"s"}']);
            expect((await query(`SELECT end_child_status FROM ${s}.workflow_agent_invocations ORDER BY node_execution_id`)).rows.map(row => row.end_child_status))
                .toEqual(["AgentSessionEnded", "AgentSessionContinues", "AgentSessionContinues"]);

            // A run again changes nothing.
            const snapshot = await schemaSnapshot(query, upgraded);
            expect(snapshot.triggers.filter(trigger => trigger.relname === "sessions").map(trigger => trigger.tgname))
                .toEqual(["workflow_owner_session_ended", "workflow_session_deleted"]);
            await query(`BEGIN; ${workflowSessionNamesMigration(upgraded)} COMMIT;`);
            expect(snapshotDifferences(snapshot, await schemaSnapshot(query, upgraded))).toEqual({});
            for (const table of TABLES) expect(await count(query, `SELECT count(*)::int AS n FROM ${s}.session_workflow_${table}`)).toBe(before[table]);

            // A fresh install has the same catalog, and no relation, constraint, function or trigger name says "chat".
            await runMigrations(pool, fresh, CMS_MIGRATIONS(fresh).filter(item => item.version <= "0089"), CMS_LOCK_SEED);
            const catalogOf = ({ data, ...catalog }) => catalog;
            expect(snapshotDifferences(catalogOf(snapshot), catalogOf(await schemaSnapshot(query, fresh)))).toEqual({});
            const named = await query(`
                SELECT relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND relname LIKE '%chat%'
                UNION ALL SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND conname LIKE '%chat%'
                UNION ALL SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND proname LIKE '%chat%'
                UNION ALL SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = $1 AND tgname LIKE '%chat%'
                UNION ALL SELECT attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = $1 AND attname LIKE '%chat%' AND NOT attisdropped AND c.relkind = 'r'`, [fresh]);
            expect(named.rows).toEqual([]);

            // The owner session ending: its Workflows' active runs are cancelled.
            await query(`UPDATE ${s}.sessions SET state = 'completed' WHERE session_id = 'owner-b'`);
            expect((await query(`SELECT status, terminal_error FROM ${s}.workflow_runs WHERE run_id = 'run-wf-b'`)).rows[0]).toMatchObject({
                status: "cancelled", terminal_error: expect.stringContaining("The session that owns this Workflow ended") });
            expect((await query(`SELECT state, winner FROM ${s}.workflow_node_executions WHERE node_execution_id = 'nx-wf-b'`)).rows[0])
                .toEqual({ state: "completed", winner: "delete" });

            // A Workflow session's own deletion: its definition is a tombstone and its active run is cancelled.
            await query(`UPDATE ${s}.sessions SET deleted_at = now() WHERE session_id = 'wf-c'`);
            expect((await query(`SELECT state FROM ${s}.workflow_definitions WHERE workflow_session_id = 'wf-c'`)).rows[0].state).toBe("deleted");
            expect((await query(`SELECT status FROM ${s}.workflow_runs WHERE run_id = 'run-wf-c'`)).rows[0].status).toBe("cancelled");

            // The owner session deleted: its definitions are deleted by owner-session-deleted, and its Workflow sessions with it.
            await query(`UPDATE ${s}.sessions SET deleted_at = now() WHERE session_id = 'owner-a'`);
            expect((await query(`SELECT deleted_by FROM ${s}.session_workflow_definitions WHERE definition_id = 'def-1'`)).rows[0].deleted_by)
                .toBe('{"kind":"system","name":"owner-session-deleted"}');
            expect((await query(`SELECT deleted_at IS NOT NULL AS deleted FROM ${s}.sessions WHERE session_id = 'wf-a'`)).rows[0].deleted).toBe(true);
            expect((await query(`SELECT state FROM ${s}.workflow_definitions WHERE workflow_session_id = 'wf-a'`)).rows[0].state).toBe("deleted");
            expect((await query(`SELECT status FROM ${s}.workflow_runs WHERE run_id = 'run-wf-a'`)).rows[0].status).toBe("cancelled");
        } finally {
            await pool.query(`DROP SCHEMA IF EXISTS "${upgraded}" CASCADE`).catch(() => {});
            await pool.query(`DROP SCHEMA IF EXISTS "${fresh}" CASCADE`).catch(() => {});
            await pool.end();
        }
    });
});
