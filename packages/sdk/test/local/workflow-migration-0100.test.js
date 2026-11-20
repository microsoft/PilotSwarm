/** Migration 0100: immutable Workflow Decision provider identity and non-mutating admission. */
import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { schemaSnapshot, snapshotDifferences } from "../helpers/schema-snapshot.js";
import { decisionProviderIdentityMigration } from "../../src/migrations/decision-provider-identity-0100.ts";

const getEnv = useSuiteEnv(import.meta.url);
const SEED = 0x63_6d_73;
const tag = () => randomUUID().replaceAll("-", "").slice(0, 12);

async function rerun(pool, schema) {
    await pool.query(`BEGIN; ${decisionProviderIdentityMigration(schema)} COMMIT;`);
}

describe("migration 0100: Workflow Decision provider identity", () => {
    it("upgrades provider rows, adds run and ledger identity, and matches fresh creation", { timeout: 240_000 }, async () => {
        const pool = new pg.Pool({ connectionString: getEnv().store, max: 1 });
        const id = tag();
        const upgraded = `wf0100_${id}_u`, fresh = `wf0100_${id}_f`;
        const query = (sql, params) => pool.query(sql, params);
        const earlier = schema => CMS_MIGRATIONS(schema).filter(item => item.version < "0100");
        const through = schema => CMS_MIGRATIONS(schema).filter(item => item.version <= "0100");
        try {
            await runMigrations(pool, upgraded, earlier(upgraded), SEED);
            await pool.query(`SELECT * FROM "${upgraded}".cms_provider_create('shared-a','azure','shared',NULL,$1,NULL,NULL,TRUE)`,
                [JSON.stringify({ apiKey: "k" })]);
            const old = (await pool.query(`SELECT created_at FROM "${upgraded}".provider_instances WHERE name = 'shared-a'`)).rows[0];

            await runMigrations(pool, upgraded, through(upgraded), SEED);
            const after = await schemaSnapshot(query, upgraded);
            const provider = (await pool.query(
                `SELECT provider_instance_id::text AS id, created_at FROM "${upgraded}".provider_instances WHERE name = 'shared-a'`)).rows[0];
            expect(provider.id).toMatch(/^[0-9a-f-]{36}$/);
            expect(provider.created_at).toEqual(old.created_at);
            const columns = (await pool.query(
                `SELECT table_name, column_name FROM information_schema.columns
                  WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name, column_name`,
                [upgraded, ["provider_instances", "workflow_runs", "provider_inference_operations"]])).rows;
            expect(columns).toEqual(expect.arrayContaining([
                expect.objectContaining({ table_name: "provider_instances", column_name: "provider_instance_id" }),
                expect.objectContaining({ table_name: "workflow_runs", column_name: "decision_provider_bindings" }),
                expect.objectContaining({ table_name: "provider_inference_operations", column_name: "provider_instance_id" }),
                expect.objectContaining({ table_name: "provider_inference_operations", column_name: "provider_type_id" }),
            ]));
            await rerun(pool, upgraded);
            expect(snapshotDifferences(after, await schemaSnapshot(query, upgraded))).toEqual({});

            await runMigrations(pool, fresh, through(fresh), SEED);
            const installed = await schemaSnapshot(query, fresh);
            await rerun(pool, fresh);
            expect(snapshotDifferences(installed, await schemaSnapshot(query, fresh))).toEqual({});
            const catalogOnly = ({ data, ...catalog }) => catalog;
            expect(snapshotDifferences(catalogOnly(after), catalogOnly(installed))).toEqual({});
        } finally {
            await pool.query(`DROP SCHEMA IF EXISTS "${upgraded}" CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS "${fresh}" CASCADE`);
            await pool.end();
        }
    });
});
