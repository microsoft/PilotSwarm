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

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;

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
});
