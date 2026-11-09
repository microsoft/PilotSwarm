/**
 * Migration 0111 (release safety): an index on sessions.parent_session_id, built concurrently. A chat's end and a session's
 * deletion run the Workflow triggers of 0107 and 0109, which look up the chat's Workflow sessions by parent_session_id; a
 * Start and spawn_agent count a chat's running children the same way (childBudgetCountSql). On a seeded table each of those
 * reads uses the index, not a scan of every session. The steps run again change nothing.
 */
import { describe, it, expect } from "vitest";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { childBudgetCountSql } from "../../src/child-budget.ts";
import { sessionsParentSessionIndexMigration } from "../../src/migrations/workflow-v2-0111.ts";
import { runMigrations } from "../../src/pg-migrator.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const CMS_LOCK_SEED = 0x63_6D_73;

describe("migration 0111: the lookups by parent_session_id use an index", () => {
    it("is registered after 0110 as autocommit steps; the trigger lookups and the child budget count use it; it is idempotent", { timeout: TIMEOUT }, async () => {
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
            // The lookups of the 0107 and 0109 triggers (workflow_v2 chat-ended): a chat's live Workflow sessions.
            const triggerLookup = await plan(`SELECT session_id FROM ${s}.sessions
                WHERE parent_session_id = 'parent-7' AND session_kind = 'workflow' AND deleted_at IS NULL FOR UPDATE`);
            expect(triggerLookup).toContain(index);
            expect(triggerLookup).not.toMatch(/Seq Scan on sessions/);
            // The shared child budget's count (spawn_agent and a Workflow's Start).
            const budget = await plan(childBudgetCountSql(s).replace("$1", "'parent-7'").replace("$2", "'none'"));
            expect(budget).toContain(index);
            expect(budget).not.toMatch(/Seq Scan on sessions c\b/);

            const list = CMS_MIGRATIONS(env.cmsSchema);
            const at = list.findIndex(item => item.version === "0111");
            expect(list[at - 1].version).toBe("0110");
            expect(list[at]).toEqual({ version: "0111", name: "sessions_parent_session_index", steps: sessionsParentSessionIndexMigration(env.cmsSchema) });
            expect(list[at].steps.join("\n")).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);

            // The steps run again: nothing changes, and the index stays valid.
            for (const step of sessionsParentSessionIndexMigration(env.cmsSchema)) await direct.query(step);
            const valid = await direct.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [env.cmsSchema, index]);
            expect(valid.rows).toEqual([{ indisvalid: true }]);
        } finally {
            await direct.end();
            await catalog.close();
        }
    });

    // Review DS2-004: a concurrent build that failed leaves an invalid index; 0111's first step drops it. That drop needs an
    // exclusive lock on sessions, so a transaction holding sessions makes it fail fast (lock_timeout 5 s), with 0111 left
    // unrecorded, instead of queueing every later reader and writer behind it. Once nothing blocks, the retry drops the
    // leftover, builds the index and records 0111 once.
    it("an invalid leftover index: a blocked drop fails fast and 0111 stays unrecorded; the retry rebuilds it valid", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const direct = new pg.Pool({ connectionString: env.store, max: 3 });
        const s = `"${env.cmsSchema}"`;
        const index = `idx_${env.cmsSchema}_sessions_parent`;
        const entry = CMS_MIGRATIONS(env.cmsSchema).find(item => item.version === "0111");
        const state = async () => (await direct.query(`SELECT i.indisvalid AS valid, i.indisunique AS unique FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
            [env.cmsSchema, index])).rows;
        const recorded = async () => (await direct.query(`SELECT count(*)::int AS n FROM ${s}.schema_migrations WHERE version = '0111'`)).rows[0].n;
        const blocker = await direct.connect();
        try {
            // A failed concurrent build: a unique build over duplicate parents fails and leaves the index invalid; 0111 unrecorded.
            await direct.query(`DROP INDEX ${s}.${index}`);
            await direct.query(`DELETE FROM ${s}.schema_migrations WHERE version = '0111'`);
            await direct.query(`INSERT INTO ${s}.sessions (session_id, parent_session_id) VALUES ('dup-1', 'dup-parent'), ('dup-2', 'dup-parent')`);
            await expect(direct.query(`CREATE UNIQUE INDEX CONCURRENTLY ${index} ON ${s}.sessions(parent_session_id)`)).rejects.toThrow();
            expect(await state()).toEqual([{ valid: false, unique: true }]);

            // A transaction that holds sessions blocks the drop: the step fails within its lock timeout.
            await blocker.query("BEGIN");
            await blocker.query(`SELECT 1 FROM ${s}.sessions LIMIT 1`);
            // Bounded here too: a drop with no lock timeout would wait on the blocker for ever (then it is let go, so the
            // suite's teardown does not wait on it as well).
            const outcome = await Promise.race([
                runMigrations(direct, env.cmsSchema, [entry], CMS_LOCK_SEED).then(() => "applied", error => error),
                new Promise(resolve => setTimeout(() => resolve("still waiting on the lock after 15 s"), 15_000)),
            ]);
            if (typeof outcome === "string") await blocker.query("ROLLBACK");
            expect(outcome).toMatchObject({ code: "55P03" });
            expect(await recorded()).toBe(0);
            expect(await state()).toEqual([{ valid: false, unique: true }]);

            // Nothing blocks: the retry drops the leftover, builds the index valid and records 0111 once.
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
