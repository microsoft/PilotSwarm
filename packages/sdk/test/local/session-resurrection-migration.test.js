import { describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { schemaSnapshot, snapshotDifferences } from "../helpers/schema-snapshot.js";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { sessionResurrectionMigration } from "../../src/migrations/session-resurrection-0094.ts";

const getEnv = useSuiteEnv(import.meta.url);

describe("migration 0094: guarded resurrection", () => {
    it("changes only five function bodies, preserves existing rows, and matches fresh creation on rerun", { timeout: 240_000 }, async () => {
        const pool = new pg.Pool({ connectionString: getEnv().store, max: 1 });
        const tag = randomUUID().replaceAll("-", "").slice(0, 12);
        const upgraded = `rs0094_${tag}_u`, fresh = `rs0094_${tag}_f`;
        const query = (sql, params) => pool.query(sql, params);
        try {
            await runMigrations(pool, upgraded, CMS_MIGRATIONS(upgraded).filter(item => item.version < "0094"), 0x63_6d_73);
            await query(`SELECT "${upgraded}".cms_create_session('root',NULL,NULL,NULL,FALSE,NULL,NULL,NULL,NULL,NULL);
                SELECT "${upgraded}".cms_create_session('connector',NULL,NULL,'root',FALSE,NULL,NULL,NULL,NULL,NULL);
                SELECT "${upgraded}".cms_create_session('leaf',NULL,NULL,'connector',FALSE,NULL,NULL,NULL,NULL,NULL);
                UPDATE "${upgraded}".sessions SET deleted_at = now() WHERE session_id = 'connector';`);
            const rowsBefore = (await query(`SELECT * FROM "${upgraded}".sessions ORDER BY session_id`)).rows;
            const before = await schemaSnapshot(query, upgraded);
            await runMigrations(pool, upgraded, CMS_MIGRATIONS(upgraded).filter(item => item.version <= "0094"), 0x63_6d_73);
            const after = await schemaSnapshot(query, upgraded);
            expect((await query(`SELECT * FROM "${upgraded}".sessions ORDER BY session_id`)).rows).toEqual(rowsBefore);
            const { functions: beforeFunctions, ...beforeRest } = before;
            const { functions: afterFunctions, ...afterRest } = after;
            expect(snapshotDifferences(beforeRest, afterRest)).toEqual({});
            expect(afterFunctions).toHaveLength(beforeFunctions.length);
            const changed = afterFunctions.filter((entry, i) => JSON.stringify(entry) !== JSON.stringify(beforeFunctions[i]));
            expect(changed.map(entry => entry.proname).sort()).toEqual([
                "cms_create_session", "cms_create_session", "cms_create_session", "cms_create_session",
                "cms_create_workflow_session",
            ]);
            for (const entry of changed) {
                const { definition, ...signature } = entry;
                const { definition: oldDefinition, ...oldSignature } = beforeFunctions.find(
                    previous => previous.proname === entry.proname && previous.arguments === entry.arguments);
                expect(signature).toEqual(oldSignature);
                expect(definition).not.toBe(oldDefinition);
            }
            await query(`BEGIN; ${sessionResurrectionMigration(upgraded)} COMMIT;`);
            expect(snapshotDifferences(after, await schemaSnapshot(query, upgraded))).toEqual({});
            await runMigrations(pool, fresh, CMS_MIGRATIONS(fresh).filter(item => item.version <= "0094"), 0x63_6d_73);
            const { data: ignored, ...freshCatalog } = await schemaSnapshot(query, fresh);
            const { data: ignoredAgain, ...upgradedCatalog } = after;
            expect(snapshotDifferences(upgradedCatalog, freshCatalog)).toEqual({});
        } finally {
            await query(`DROP SCHEMA IF EXISTS "${upgraded}" CASCADE`);
            await query(`DROP SCHEMA IF EXISTS "${fresh}" CASCADE`);
            await pool.end();
        }
    });
});
