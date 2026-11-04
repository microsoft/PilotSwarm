/**
 * Adversarial review RT-1: a database that applied the workflow migrations under their earlier numbers (0084-0101,
 * before main's MOTD migrations took 0084-0087) is reconciled by version and name, under the migration lock, before
 * anything runs: the workflow rows move to 0088-0105, the MOTD migrations then run, and nothing is applied twice. A
 * second pass changes nothing; an ambiguous ledger stops the start.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runCmsMigrations } from "../../src/cms-migrator.ts";
import { runMigrations } from "../../src/pg-migrator.ts";

const url = process.env.PS_TEST_DATABASE_URL;
const SEED = 0x63_6D_73;

/** The migrations an old-number branch applied: main's through 0083, then the workflow ones (through `last`, its own number) at version - 4. */
function oldNumbered(schema, last) {
    return CMS_MIGRATIONS(schema).flatMap(entry => {
        const number = Number(entry.version);
        if (number <= 83) return [entry];
        if (number >= 88 && number - 4 <= last) return [{ ...entry, version: String(number - 4).padStart(4, "0") }];
        return [];
    });
}

describe.skipIf(!url)("CMS migration ledger renumbering in real PostgreSQL", () => {
    async function withSchema(run) {
        const schema = `ps_test_ledger_${randomUUID().replaceAll("-", "")}`;
        const pool = new pg.Pool({ connectionString: url, max: 4 });
        try {
            await run({ schema, pool, ledger: async () => (await pool.query(`SELECT version, name FROM "${schema}".schema_migrations ORDER BY version`)).rows });
        } finally {
            await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await pool.end();
        }
    }
    const expected = schema => CMS_MIGRATIONS(schema).map(entry => ({ version: entry.version, name: entry.name }));

    it.each([[85, "a prefix (0084-0085)"], [101, "the whole old sequence (0084-0101)"]])("upgrades %s old workflow migrations", async (last) => {
        await withSchema(async ({ schema, pool, ledger }) => {
            await runMigrations(pool, schema, oldNumbered(schema, last), SEED);
            // A workflow session written under the old numbers survives.
            const id = randomUUID();
            await pool.query(`INSERT INTO "${schema}".sessions (session_id, session_kind) VALUES ($1, 'workflow')`, [id]);
            await runCmsMigrations(pool, schema);
            expect(await ledger()).toEqual(expected(schema));
            // The MOTD migrations ran: their table exists.
            expect((await pool.query(`SELECT to_regclass($1) AS t`, [`"${schema}".motds`])).rows[0].t).not.toBeNull();
            expect((await pool.query(`SELECT session_kind FROM "${schema}".sessions WHERE session_id = $1`, [id])).rows[0].session_kind).toBe("workflow");
            // A second pass is a no-op.
            await runCmsMigrations(pool, schema);
            expect(await ledger()).toEqual(expected(schema));
        });
    });

    it("leaves a clean database and a correctly numbered one as they are", async () => {
        await withSchema(async ({ schema, pool, ledger }) => {
            await runCmsMigrations(pool, schema);
            expect(await ledger()).toEqual(expected(schema));
            await runCmsMigrations(pool, schema);
            expect(await ledger()).toEqual(expected(schema));
        });
    });

    it("stops on an ambiguous ledger", async () => {
        await withSchema(async ({ schema, pool }) => {
            await runMigrations(pool, schema, oldNumbered(schema, 85), SEED);
            await pool.query(`INSERT INTO "${schema}".schema_migrations (version, name) VALUES ('0086', 'something_else')`);
            await expect(runCmsMigrations(pool, schema)).rejects.toThrow(/cannot be reconciled: version 0086 is recorded as 'something_else'/);
        });
    });
});
