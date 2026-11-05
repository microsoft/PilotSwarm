/**
 * Adversarial review RT-1: a database that applied the workflow migrations under their earlier numbers (0084-0101,
 * before main's MOTD migrations took 0084-0087) is reconciled by version and name, under the migration lock, before
 * anything runs: the workflow rows move to 0088-0105, the MOTD migrations then run, and nothing is applied twice. A
 * second pass changes nothing; an ambiguous ledger stops the start.
 *
 * Verification of RT-1 (M-07): every old prefix 0084..0101, a valid ledger with old and current numbers mixed, an
 * occupied destination and a migration recorded at both numbers (refused before any change), a failure in either phase
 * of the move (rolled back whole; a later start finishes it), and two migrators of the same schema at once (the lock
 * serializes them). Workflow data written before stays, and a second pass changes nothing.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { cmsLedgerMoves, runCmsMigrations } from "../../src/cms-migrator.ts";
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

    /** A workflow session and a definition's session row, written under the old numbers; read back after the move. */
    async function writeWorkflowData(pool, schema) {
        const id = randomUUID();
        await pool.query(`INSERT INTO "${schema}".sessions (session_id, session_kind) VALUES ($1, 'workflow')`, [id]);
        return async () => {
            expect((await pool.query(`SELECT session_kind FROM "${schema}".sessions WHERE session_id = $1`, [id])).rows[0]?.session_kind).toBe("workflow");
        };
    }

    // M-07: every old prefix, one at a time: the workflow rows move, the MOTD migrations run, data stays, a second pass is a no-op.
    it.each(Array.from({ length: 18 }, (_, i) => [84 + i]))("M-07: upgrades the old prefix 0084..%i", async (last) => {
        await withSchema(async ({ schema, pool, ledger }) => {
            await runMigrations(pool, schema, oldNumbered(schema, last), SEED);
            const stays = await writeWorkflowData(pool, schema);
            await runCmsMigrations(pool, schema);
            expect(await ledger()).toEqual(expected(schema));
            await stays();
            await runCmsMigrations(pool, schema);
            expect(await ledger()).toEqual(expected(schema));
        });
    });

    it("M-07: a valid ledger with old and current numbers mixed is reconciled", async () => {
        await withSchema(async ({ schema, pool, ledger }) => {
            // The first two workflow migrations under their old numbers (0084, 0085), the rest under their current ones.
            const mixed = CMS_MIGRATIONS(schema).flatMap(entry => {
                const number = Number(entry.version);
                if (number <= 83 || number >= 90) return [entry];
                if (number === 88 || number === 89) return [{ ...entry, version: String(number - 4).padStart(4, "0") }];
                return [];
            });
            await runMigrations(pool, schema, mixed, SEED);
            const stays = await writeWorkflowData(pool, schema);
            await runCmsMigrations(pool, schema);
            expect(await ledger()).toEqual(expected(schema));
            await stays();
            await runCmsMigrations(pool, schema);
            expect(await ledger()).toEqual(expected(schema));
        });
    });

    it("M-07: an occupied destination or a migration at both numbers is refused before anything changes", async () => {
        for (const [extra, message] of [
            [{ version: "0088", name: "something_else" }, /version 0088 is recorded as 'something_else'/],
            [{ version: "0088", name: "workflow_session_kind" }, /'workflow_session_kind' is recorded at both 0084 and 0088/],
        ]) {
            await withSchema(async ({ schema, pool, ledger }) => {
                await runMigrations(pool, schema, oldNumbered(schema, 85), SEED);
                await pool.query(`INSERT INTO "${schema}".schema_migrations (version, name) VALUES ($1, $2)`, [extra.version, extra.name]);
                const before = await ledger();
                await expect(runCmsMigrations(pool, schema)).rejects.toThrow(message);
                expect(await ledger()).toEqual(before);
                expect((await pool.query(`SELECT to_regclass($1) AS t`, [`"${schema}".motds`])).rows[0].t).toBeNull();
            });
        }
    });

    it.each([["the first", (params) => typeof params?.[0] === "string" && params[0].startsWith("moving:")],
        ["the second", (params) => typeof params?.[1] === "string" && params[1].startsWith("moving:")]])(
        "M-07: a failure in %s phase of the move rolls the whole move back; the next start finishes it", async (_label, inPhase) => {
            await withSchema(async ({ schema, pool, ledger }) => {
                await runMigrations(pool, schema, oldNumbered(schema, 101), SEED);
                const stays = await writeWorkflowData(pool, schema);
                const before = await ledger();
                // The fifth update of that phase fails.
                let seen = 0;
                const failing = {
                    async connect() {
                        const client = await pool.connect();
                        return {
                            query(text, params) {
                                const sql = typeof text === "string" ? text : text.text;
                                if (/SET version = \$1 WHERE version = \$2 AND name = \$3/.test(sql) && inPhase(params) && ++seen === 5) {
                                    return Promise.reject(new Error("injected failure in the ledger move"));
                                }
                                return client.query(text, params);
                            },
                            release: (...args) => client.release(...args),
                        };
                    },
                };
                const migrations = CMS_MIGRATIONS(schema);
                await expect(runMigrations(failing, schema, migrations, SEED, { ledgerMoves: cmsLedgerMoves(migrations) }))
                    .rejects.toThrow(/injected failure in the ledger move/);
                expect(seen).toBe(5);
                // Nothing moved, nothing half-moved, nothing else ran.
                expect(await ledger()).toEqual(before);
                expect((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".schema_migrations WHERE version LIKE 'moving:%'`)).rows[0].n).toBe(0);
                expect((await pool.query(`SELECT to_regclass($1) AS t`, [`"${schema}".motds`])).rows[0].t).toBeNull();
                await runCmsMigrations(pool, schema);
                expect(await ledger()).toEqual(expected(schema));
                await stays();
            });
        });

    it("M-07: two migrators of the same schema at once: the lock serializes them, the move happens once, both end with the same ledger", async () => {
        await withSchema(async ({ schema, pool, ledger }) => {
            await runMigrations(pool, schema, oldNumbered(schema, 101), SEED);
            const stays = await writeWorkflowData(pool, schema);
            const other = new pg.Pool({ connectionString: url, max: 4 });
            try {
                await Promise.all([runCmsMigrations(pool, schema), runCmsMigrations(other, schema)]);
            } finally {
                await other.end();
            }
            expect(await ledger()).toEqual(expected(schema));
            await stays();
            await runCmsMigrations(pool, schema);
            expect(await ledger()).toEqual(expected(schema));
        });
    });
});

