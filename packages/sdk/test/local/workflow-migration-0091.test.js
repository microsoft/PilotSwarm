import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { schemaSnapshot, snapshotDifferences } from "../helpers/schema-snapshot.js";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { workflowApprovalsMigration } from "../../src/migrations/workflow-approvals-0091.ts";

const getEnv = useSuiteEnv(import.meta.url);
const SEED = 0x63_6d_73;

describe("migration 0091: immutable owner approvals", () => {
    for (const priorOrdinal of [false, true]) {
        it(`upgrades the old interception CHECK, reruns, and matches fresh creation (prior ordinal ${priorOrdinal})`, { timeout: 240000 }, async () => {
            const pool = new pg.Pool({ connectionString: getEnv().store, max: 1 });
            const tag = randomUUID().replace(/-/g, "").slice(0, 12);
            const upgraded = `wf0091_${tag}_u`, fresh = `wf0091_${tag}_f`;
            const query = (sql, params) => pool.query(sql, params);
            try {
                const earlier = CMS_MIGRATIONS(upgraded).filter(item => item.version < "0091");
                if (priorOrdinal && !earlier.some(item => item.version === "0090")) earlier.push({ version: "0090", name: "unrelated_ordinal_fixture", sql: "SELECT 1;" });
                await runMigrations(pool, upgraded, earlier, SEED);
                const old = await query(`SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
                    JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.conname='workflow_test_interceptions_operation_check'`, [upgraded]);
                expect(old.rows[0].definition).not.toContain("'approval'");
                await runMigrations(pool, upgraded, CMS_MIGRATIONS(upgraded), SEED);
                const changed = await query(`SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
                    JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.conname='workflow_test_interceptions_operation_check'`, [upgraded]);
                expect(changed.rows[0].definition).toContain("'approval'");
                expect((await query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='workflow_approvals'`,
                    [upgraded])).rows.map(row => row.column_name)).toEqual(expect.arrayContaining(["node_execution_id", "snapshot", "context_sha256", "decided_by", "operation_id"]));
                const before = await schemaSnapshot(query, upgraded);
                await query(`BEGIN; ${workflowApprovalsMigration(upgraded)} COMMIT;`);
                expect(snapshotDifferences(before, await schemaSnapshot(query, upgraded))).toEqual({});
                await runMigrations(pool, fresh, CMS_MIGRATIONS(fresh), SEED);
                const catalog = ({ data, ...rest }) => rest;
                expect(snapshotDifferences(catalog(before), catalog(await schemaSnapshot(query, fresh)))).toEqual({});
            } finally {
                await pool.query(`DROP SCHEMA IF EXISTS "${upgraded}" CASCADE`);
                await pool.query(`DROP SCHEMA IF EXISTS "${fresh}" CASCADE`);
                await pool.end();
            }
        });
    }
});
