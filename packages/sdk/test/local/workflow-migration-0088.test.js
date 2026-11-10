/**
 * Migration 0088 (workflow), the one Workflow migration, on PostgreSQL:
 * - Equivalence: after main's 0001-0087, it leaves the same schema as the 24 migrations it replaced (0088-0111 as PR 270
 *   had them at 01caf109, frozen in test/fixtures/workflow-migration-chain-01caf109.sql). Both run on fresh schemas of the
 *   same database; the catalog snapshots (helpers/schema-snapshot.js: relations, ordered live columns, constraints,
 *   indexes, functions, triggers, views, sequences, types, policies, comments, privileges and seeded rows) are equal.
 * - A fresh create records 0088 once, and its steps run again change nothing.
 * - The lookups by parent_session_id (the chat-ended and deletion triggers, the child budget) use its index.
 * - Review DS2-004: a concurrent build that failed leaves an invalid index. A run again takes no lock on sessions until
 *   its drop of that leftover, which a transaction holding sessions makes fail fast (lock_timeout 5 s) with 0088
 *   unrecorded; once nothing blocks, the retry rebuilds the index valid and records 0088 once.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { schemaSnapshot, snapshotDifferences } from "../helpers/schema-snapshot.js";
import { oldWorkflowChain } from "../helpers/workflow-migration-chain.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { childBudgetCountSql } from "../../src/child-budget.ts";
import { workflowMigration } from "../../src/migrations/workflow-0088.ts";
import { runMigrations } from "../../src/pg-migrator.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const CMS_LOCK_SEED = 0x63_6D_73;
const main = schema => CMS_MIGRATIONS(schema).filter(migration => migration.version <= "0087");

describe("migration 0088: the Workflow schema in one migration", () => {
    it("leaves the same schema as the 24 migrations it replaced; a fresh create records 0088 once and a run again changes nothing", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const pool = new pg.Pool({ connectionString: env.store, max: 1 });
        const tag = randomUUID().replace(/-/g, "").slice(0, 12);
        const chain = `wf0088_${tag}_chain`;
        const fresh = `wf0088_${tag}_fresh`;
        const query = (sql, params) => pool.query(sql, params);
        try {
            const old = oldWorkflowChain(chain);
            expect(old.map(migration => migration.version)).toEqual(Array.from({ length: 24 }, (_, i) => String(88 + i).padStart(4, "0")));
            await runMigrations(pool, chain, [...main(chain), ...old], CMS_LOCK_SEED);
            await runMigrations(pool, fresh, CMS_MIGRATIONS(fresh), CMS_LOCK_SEED);

            const before = await schemaSnapshot(query, fresh);
            expect(snapshotDifferences(await schemaSnapshot(query, chain), before)).toEqual({});
            // Not vacuous: the Workflow tables, functions and both triggers on sessions are there.
            expect(before.relations.filter(relation => relation.relkind === "r" && relation.relname.startsWith("workflow_"))).toHaveLength(23);
            expect(before.triggers.filter(trigger => trigger.relname === "sessions").map(trigger => trigger.tgname))
                .toEqual(["workflow_v2_chat_ended", "workflow_v2_session_deleted"]);
            expect(before.indexes.find(index => index.index === "idx_<schema>_sessions_parent")).toMatchObject({ table: "sessions", indisvalid: true });

            const ledger = await pool.query(`SELECT version, name FROM "${fresh}".schema_migrations WHERE version > '0087' ORDER BY version`);
            expect(ledger.rows).toEqual([{ version: "0088", name: "workflow" }]);
            for (const step of workflowMigration(fresh)) await pool.query(step);
            await runMigrations(pool, fresh, CMS_MIGRATIONS(fresh), CMS_LOCK_SEED);
            expect(snapshotDifferences(before, await schemaSnapshot(query, fresh))).toEqual({});
            expect((await pool.query(`SELECT count(*)::int AS n FROM "${fresh}".schema_migrations WHERE version > '0087'`)).rows[0].n).toBe(1);
        } finally {
            for (const schema of [chain, fresh]) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
            await pool.end();
        }
    });

    it("the trigger lookups and the child budget count by parent_session_id use its index", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const direct = new pg.Pool({ connectionString: env.store, max: 1 });
        const s = `"${env.cmsSchema}"`;
        const index = `idx_${env.cmsSchema}_sessions_parent`;
        try {
            // 20,000 sessions under 500 parents; the chat of interest has 40 children, 10 of them Workflows.
            await direct.query(`INSERT INTO ${s}.sessions (session_id, parent_session_id, session_kind, state)
                SELECT 'child-' || g, 'parent-' || (g % 500), CASE WHEN g % 4 = 0 THEN 'workflow' ELSE 'agent' END, 'running'
                  FROM generate_series(1, 20000) AS g`);
            await direct.query(`ANALYZE ${s}.sessions`);
            const plan = async sql => (await direct.query(`EXPLAIN ${sql}`)).rows.map(row => row["QUERY PLAN"]).join("\n");
            // The chat-ended trigger's lookup: a chat's live Workflow sessions.
            const triggerLookup = await plan(`SELECT session_id FROM ${s}.sessions
                WHERE parent_session_id = 'parent-7' AND session_kind = 'workflow' AND deleted_at IS NULL FOR UPDATE`);
            expect(triggerLookup).toContain(index);
            expect(triggerLookup).not.toMatch(/Seq Scan on sessions/);
            // The shared child budget's count (spawn_agent and a Workflow's Start).
            const budget = await plan(childBudgetCountSql(s).replace("$1", "'parent-7'").replace("$2", "'none'"));
            expect(budget).toContain(index);
            expect(budget).not.toMatch(/Seq Scan on sessions c\b/);
        } finally {
            await direct.end();
            await catalog.close();
        }
    });

    it("an invalid leftover index: a blocked drop fails fast and 0088 stays unrecorded; the retry rebuilds it valid", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const direct = new pg.Pool({ connectionString: env.store, max: 3 });
        const s = `"${env.cmsSchema}"`;
        const index = `idx_${env.cmsSchema}_sessions_parent`;
        const entry = CMS_MIGRATIONS(env.cmsSchema).find(item => item.version === "0088");
        const state = async () => (await direct.query(`SELECT i.indisvalid AS valid, i.indisunique AS unique FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
            [env.cmsSchema, index])).rows;
        const recorded = async () => (await direct.query(`SELECT count(*)::int AS n FROM ${s}.schema_migrations WHERE version = '0088'`)).rows[0].n;
        const blocker = await direct.connect();
        try {
            // A failed concurrent build: a unique build over duplicate parents fails and leaves the index invalid; 0088 unrecorded.
            await direct.query(`DROP INDEX ${s}.${index}`);
            await direct.query(`DELETE FROM ${s}.schema_migrations WHERE version = '0088'`);
            await direct.query(`INSERT INTO ${s}.sessions (session_id, parent_session_id) VALUES ('dup-1', 'dup-parent'), ('dup-2', 'dup-parent')`);
            await expect(direct.query(`CREATE UNIQUE INDEX CONCURRENTLY ${index} ON ${s}.sessions(parent_session_id)`)).rejects.toThrow();
            expect(await state()).toEqual([{ valid: false, unique: true }]);

            // A transaction that holds sessions: the first step (everything but the index) runs past it, since it takes no
            // lock on sessions when sessions already has what it adds; the drop fails within its lock timeout.
            await blocker.query("BEGIN");
            await blocker.query(`SELECT 1 FROM ${s}.sessions LIMIT 1`);
            // Bounded here too: a step with no lock timeout would wait on the blocker for ever (then it is let go, so the
            // suite's teardown does not wait on it as well).
            const outcome = await Promise.race([
                runMigrations(direct, env.cmsSchema, [entry], CMS_LOCK_SEED).then(() => "applied", error => error),
                new Promise(resolve => setTimeout(() => resolve("still waiting on the lock after 15 s"), 15_000)),
            ]);
            if (typeof outcome === "string") await blocker.query("ROLLBACK");
            expect(outcome).toMatchObject({ code: "55P03" });
            expect(await recorded()).toBe(0);
            expect(await state()).toEqual([{ valid: false, unique: true }]);

            // Nothing blocks: the retry drops the leftover, builds the index valid and records 0088 once.
            await blocker.query("COMMIT");
            await runMigrations(direct, env.cmsSchema, [entry], CMS_LOCK_SEED);
            expect(await state()).toEqual([{ valid: true, unique: false }]);
            expect(await recorded()).toBe(1);
        } finally {
            await blocker.query("ROLLBACK").catch(() => {});
            blocker.release();
            await direct.end();
            await catalog.close();
        }
    });
});
