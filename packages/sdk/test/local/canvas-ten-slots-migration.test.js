/**
 * Migration 0095: every canvas table accepts slots 1-10, and only those.
 *
 * Run: npx vitest run test/local/canvas-ten-slots-migration.test.js
 */

import { describe, it } from "vitest";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { canvasTenSlotsMigration } from "../../src/migrations/canvas-ten-slots-0095.ts";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);
const TABLES = ["session_canvases", "canvas_live", "canvas_share_links", "canvas_kv"];

describe("migration 0095: ten canvas slots", () => {
    it("each canvas table has one slot CHECK, 1 to 10", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        const client = new pg.Client({ connectionString: env.store });
        await client.connect();
        try {
            for (const table of TABLES) {
                const { rows } = await client.query(
                    `SELECT pg_get_constraintdef(c.oid) AS def
                       FROM pg_constraint c
                      WHERE c.conrelid = format('%I.%I', $1::text, $2::text)::regclass
                        AND c.contype = 'c'
                        AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                               WHERE attrelid = format('%I.%I', $1::text, $2::text)::regclass
                                                 AND attname = 'slot')]::smallint[]`,
                    [env.cmsSchema, table],
                );
                assertEqual(rows.length, 1, `${table}: exactly one slot CHECK`);
                assertEqual(rows[0].def, "CHECK (((slot >= 1) AND (slot <= 10)))", `${table}: the range is 1-10`);
            }
        } finally {
            await client.end();
            await catalog.close?.();
        }
    });

    it("slot 10 mints a revision; slot 11 is refused by the database", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const sid = `ten-slots-${env.runId}`;
            await catalog.createSession(sid, { model: "m" });
            assertEqual(await catalog.mintCanvasRev(sid, 10, 0), 1, "slot 10 is a canvas");
            let code = null;
            try {
                await catalog.mintCanvasRev(sid, 11, 0);
            } catch (error) {
                code = error?.code ?? null;
            }
            assert(code === "23514", `slot 11 violates the CHECK (got ${code})`);
        } finally {
            await catalog.close?.();
        }
    });

    it("works for a schema name with a single quote, a double quote and a space", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const schema = `ps_test_0095 o'brien "q" ${env.runId}`.slice(0, 63);
        const ident = `"${schema.replace(/"/g, '""')}"`;
        const client = new pg.Client({ connectionString: env.store });
        await client.connect();
        try {
            await client.query(`CREATE SCHEMA ${ident}`);
            for (const table of TABLES) {
                await client.query(`CREATE TABLE ${ident}.${table} (id serial, slot SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 5))`);
            }
            await client.query(`BEGIN; ${canvasTenSlotsMigration(schema)} COMMIT;`);
            for (const table of TABLES) {
                const { rows } = await client.query(
                    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                      WHERE conrelid = format('%I.%I', $1::text, $2::text)::regclass AND contype = 'c'`, [schema, table]);
                assertEqual(rows.length, 1, `${table}: one check`);
                assertEqual(rows[0].conname, `${table}_slot_range`);
                assertEqual(rows[0].def, "CHECK (((slot >= 1) AND (slot <= 10)))");
            }
        } finally {
            await client.query("ROLLBACK").catch(() => {});
            await client.query(`DROP SCHEMA IF EXISTS ${ident} CASCADE`);
            await client.end();
        }
    });
});
