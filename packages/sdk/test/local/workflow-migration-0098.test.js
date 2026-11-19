import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { schemaSnapshot, snapshotDifferences } from "../helpers/schema-snapshot.js";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { workflowDecisionRuntimeMigration } from "../../src/migrations/workflow-decision-runtime-0098.ts";

const getEnv = useSuiteEnv(import.meta.url);
const SEED = 0x63_6d_73;

describe("migration 0098: Workflow Decision runtime constraint", () => {
    it("adds Decision to the released interception CHECK on upgrade and matches fresh creation", { timeout: 240000 }, async () => {
        const pool = new pg.Pool({ connectionString: getEnv().store, max: 1 });
        const tag = randomUUID().replace(/-/g, "").slice(0, 12);
        const upgraded = `wf0098_${tag}_u`, fresh = `wf0098_${tag}_f`;
        const query = (sql, params) => pool.query(sql, params);
        const definition = async schema => (await query(`SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
                    JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.conname='workflow_test_interceptions_operation_check'`, [schema])).rows[0].definition;
        try {
            const earlier = CMS_MIGRATIONS(upgraded).filter(item => item.version < "0098");
            await runMigrations(pool, upgraded, earlier, SEED);
            const old = await definition(upgraded);
            expect(old).toContain("approval");
            expect(old).not.toContain("decision");

            await runMigrations(pool, upgraded, CMS_MIGRATIONS(upgraded).filter(item => item.version <= "0098"), SEED);
            const changed = await definition(upgraded);
            expect(changed).toContain("decision");
            const before = await schemaSnapshot(query, upgraded);
            await query(`BEGIN; ${workflowDecisionRuntimeMigration(upgraded)} COMMIT;`);
            expect(snapshotDifferences(before, await schemaSnapshot(query, upgraded))).toEqual({});

            await runMigrations(pool, fresh, CMS_MIGRATIONS(fresh).filter(item => item.version <= "0098"), SEED);
            const catalog = ({ data, ...rest }) => rest;
            expect(snapshotDifferences(catalog(before), catalog(await schemaSnapshot(query, fresh)))).toEqual({});
        } finally {
            await pool.query(`DROP SCHEMA IF EXISTS "${upgraded}" CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS "${fresh}" CASCADE`);
            await pool.end();
        }
    });
});
