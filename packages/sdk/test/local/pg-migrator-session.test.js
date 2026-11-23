/**
 * The migration runner ends each migration's session settings. One connection runs every pending migration and then
 * goes back to the pool, and CMS migrations 0036 and 0070 run a session-level `SET lock_timeout = '5s'`. Kept, that
 * limit cut short 0088's CREATE INDEX CONCURRENTLY, which waits for every older transaction in the database: under a
 * loaded suite a fresh catalog failed with "canceling statement due to lock timeout". The pooled connection also kept
 * the limit for later catalog queries. Settings the pool's connect hook made stay (workflow-semver-reused SDK3-F2 sets
 * a REPEATABLE READ default that way).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const CMS_LOCK_SEED = 0x63_6D_73;
const schemaName = prefix => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const lockTimeout = async pool => (await pool.query("SHOW lock_timeout")).rows[0].lock_timeout;

describe("migration runner session settings", () => {
    it("a migration's session lock_timeout neither cuts short a later migration's lock wait nor replaces the pool's own", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const schema = schemaName("mig_session");
        const pool = new pg.Pool({ connectionString: env.store, max: 1 });
        const hookErrors = [];
        pool.on("connect", client => { client.query("SET lock_timeout = '30s'").catch(error => hookErrors.push(error)); });
        const holder = new pg.Client({ connectionString: env.store });
        await holder.connect();
        let timer;
        try {
            await pool.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".held (id int)`);
            expect(await lockTimeout(pool)).toBe("30s");
            await holder.query(`BEGIN; LOCK TABLE "${schema}".held IN ACCESS EXCLUSIVE MODE`);
            const released = new Promise(resolve => { timer = setTimeout(resolve, 1_000); }).then(() => holder.query("COMMIT"));
            const startedAt = Date.now();
            await runMigrations(pool, schema, [
                { version: "0001", name: "short session limit", steps: ["SET lock_timeout = '100ms'; SELECT 1"] },
                { version: "0002", name: "waits for the held table", steps: [`ALTER TABLE "${schema}".held ADD COLUMN note text`] },
            ], 0x5e_55);
            const waitedMs = Date.now() - startedAt;
            await released;
            console.log(`  0002 waited ${waitedMs} ms for the held table`);
            expect(waitedMs).toBeGreaterThanOrEqual(800);
            const columns = await pool.query(
                "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'held' ORDER BY ordinal_position",
                [schema],
            );
            expect(columns.rows.map(row => row.column_name)).toEqual(["id", "note"]);
            expect((await pool.query(`SELECT version FROM "${schema}".schema_migrations ORDER BY version`)).rows.map(row => row.version))
                .toEqual(["0001", "0002"]);
            expect(await lockTimeout(pool)).toBe("30s");
            expect(hookErrors).toEqual([]);
        } finally {
            clearTimeout(timer);
            await holder.query("ROLLBACK").catch(() => {});
            await holder.end().catch(() => {});
            await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
            await pool.end();
        }
    });

    it("a fresh CMS catalog hands its connection back with the lock_timeout it started with", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const schema = schemaName("mig_cms_session");
        const migrations = CMS_MIGRATIONS(schema);
        // Not vacuous: some CMS migration sets lock_timeout for the session.
        expect(migrations.some(migration => (migration.steps ?? [migration.sql]).some(sql => /^SET lock_timeout/m.test(sql)))).toBe(true);
        const pool = new pg.Pool({ connectionString: env.store, max: 1 });
        try {
            const before = await lockTimeout(pool);
            await runMigrations(pool, schema, migrations, CMS_LOCK_SEED);
            expect(await lockTimeout(pool)).toBe(before);
        } finally {
            await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
            await pool.end();
        }
    });
});
