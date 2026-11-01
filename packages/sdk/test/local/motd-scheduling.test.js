import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { MotdStore } from "../../src/motd-store.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { motdToolParameters, motdCreateInput, MOTD_OPERATION_SPECS } from "../../src/motd-tools.ts";
import { OPERATIONS, buildOperationRequest } from "../../api/src/protocol.js";

const url = process.env.PS_TEST_DATABASE_URL;
const admin = { principal: { provider: "test", subject: "admin" }, isAdmin: true };
const reader = { principal: { provider: "test", subject: "reader" }, isAdmin: false };
const input = extra => ({ bodyMd: "Announcement", requestId: randomUUID(), ...extra });

describe("optional MoTD time schemas", () => {
    it("makes both canonical times optional in every shared tool and the web API", () => {
        const spec = MOTD_OPERATION_SPECS.find(row => row.kind === "create");
        const schema = motdToolParameters(spec);
        expect(schema.required).toEqual(["bodyMd", "requestId"]);
        expect(schema.properties.startsAt.description).toContain("server creation");
        expect(schema.properties.endsAt.description).toContain("until replaced or deleted");
        expect(motdCreateInput(input())).toMatchObject({ bodyMd: "Announcement" });
        expect(OPERATIONS.find(row => row.name === "createMotd").params).toHaveProperty("startsAt");
        expect(buildOperationRequest("createMotd", { bodyMd: "Now", requestId: "one" }).body).toEqual({ bodyMd: "Now", requestId: "one" });
    });
    it.each([{ startsAt: "" }, { endsAt: null }, { startsAt: "2026-11-01T12:00" },
        { startsAt: "2090-01-01T00:00:00Z", endsAt: "2080-01-01T00:00:00Z" },
        { startsAt: "2020-01-01T00:00:00Z", fromAt: "2021-01-01T00:00:00Z" }])("rejects malformed or conflicting explicit times", async extra => {
        const store = new MotdStore({ connect: async () => { throw new Error("No database call expected"); } }, "test");
        await expect(store.create(admin, input(extra))).rejects.toMatchObject({ code: "MOTD_INVALID" });
    });
});

describe.skipIf(!url)("optional schedules and upgrade in real PostgreSQL", () => {
    async function fixture(run, through = "0086") {
        const schema = `ps_test_motd_schedule_${randomUUID().replaceAll("-", "")}`;
        const pool = new pg.Pool({ connectionString: url, max: 4 });
        let catalog;
        try {
            await runMigrations(pool, schema, CMS_MIGRATIONS(schema).filter(entry => entry.version <= through), 0x63_6D_73);
            const store = new MotdStore(pool, schema);
            await run({ schema, pool, store, upgrade: async () => {
                catalog = await PgSessionCatalog.create(url, schema);
                await catalog.initialize();
                return catalog.motds;
            } });
        } finally {
            await catalog?.close();
            await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await pool.end();
        }
    }
    it("uses server creation time and a null end, including identical retries", async () => {
        await fixture(async ({ pool, schema, store }) => {
            const request = input();
            const first = await store.create(admin, request);
            expect(first.startsAt).toBe(first.createdAt);
            expect(first.endsAt).toBeNull(); expect(first.toAt).toBeNull();
            expect(await store.create(admin, request)).toEqual(first);
            expect((await store.current(reader)).endsAt).toBeNull();
            expect((await store.list(reader))[0]).toMatchObject({ status: "live", endsAt: null });
            await pool.query(`UPDATE "${schema}".motds SET from_at = now() - interval '10 years',
                created_at = now() - interval '10 years' WHERE motd_id = $1`, [first.motdId]);
            expect((await store.current(reader)).motdId).toBe(first.motdId);
        });
    });
    it("newly created active messages replace running messages even with an older supplied start", async () => {
        await fixture(async ({ pool, schema, store }) => {
            const running = await store.create(admin, input({ startsAt: "2025-01-01T00:00:00Z" }));
            await pool.query(`UPDATE "${schema}".motds SET created_at = now() - interval '2 days' WHERE motd_id = $1`, [running.motdId]);
            const newest = await store.create(admin, input({ startsAt: "2020-01-01T00:00:00Z" }));
            expect((await store.current(reader)).motdId).toBe(newest.motdId);
            expect((await store.list(reader)).map(row => row.status)).toEqual(["live", "hidden"]);
            await store.dismiss(reader, newest.motdId);
            expect((await store.current(reader)).motdId).toBe(running.motdId);
        });
    });
    it("an earlier-created schedule takes over when its start arrives; ID breaks equal activation times", async () => {
        await fixture(async ({ pool, schema, store }) => {
            const scheduled = await store.create(admin, input({ startsAt: "2080-01-01T00:00:00Z" }));
            const running = await store.create(admin, input());
            expect((await store.current(reader)).motdId).toBe(running.motdId);
            expect((await store.list(reader)).some(row => row.motdId === scheduled.motdId)).toBe(false);
            await expect(store.image(reader, scheduled.motdId)).rejects.toMatchObject({ status: 404 });
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                await client.query(`UPDATE "${schema}".motds SET created_at = now() - interval '2 days', from_at = now()
                    WHERE motd_id = $1`, [scheduled.motdId]);
                await client.query(`UPDATE "${schema}".motds SET from_at = now() - interval '1 hour', created_at = now() - interval '1 hour'
                    WHERE motd_id = $1`, [running.motdId]);
                const current = () => client.query(`SELECT "${schema}".cms_motd_current('test', 'reader', false) AS result`);
                expect((await current()).rows[0].result.motdId).toBe(scheduled.motdId);
                await client.query(`UPDATE "${schema}".motds SET from_at = now(), created_at = now()`);
                expect((await current()).rows[0].result.motdId).toBe(running.motdId);
                await client.query("COMMIT");
            } finally { await client.query("ROLLBACK"); client.release(); }
        });
    });
    it("allows end-only creation, rejects past ends in SQL, and expires only finite ends", async () => {
        await fixture(async ({ pool, schema, store }) => {
            const finite = await store.create(admin, input({ endsAt: "2090-01-01T00:00:00Z" }));
            expect(finite.startsAt).toBe(finite.createdAt);
            await expect(store.create(admin, input({ endsAt: "2020-01-01T00:00:00Z" }))).rejects.toMatchObject({ status: 400, message: "End must be in the future" });
            await expect(pool.query(`SELECT "${schema}".cms_motd_create('test','admin',true,$1,NULL,NULL)`,
                [input({ endsAt: "2020-01-01T00:00:00Z" })])).rejects.toThrow("MOTD_INVALID: End must be in the future");
            await pool.query(`UPDATE "${schema}".motds SET from_at = now() - interval '1 day', to_at = now() - interval '1 hour'
                WHERE motd_id = $1`, [finite.motdId]);
            expect(await store.current(reader)).toBeNull();
            expect((await store.list(reader))[0].status).toBe("ended");
            const open = await store.create(admin, input());
            expect((await store.current(reader)).motdId).toBe(open.motdId);
        });
    });
    it("preserves 0084+0085 data, pictures, dismissals and retry receipts while upgrading to 0086", async () => {
        await fixture(async ({ pool, schema, store, upgrade }) => {
            const picture = { base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", contentType: "image/png", alt: "Existing picture" };
            const request = input({ fromAt: "2020-01-01T00:00:00Z", toAt: "2090-01-01T00:00:00Z", image: picture });
            const existing = await store.create(admin, request);
            await store.dismiss(reader, existing.motdId);
            const rows = (await pool.query(`SELECT * FROM "${schema}".motds`)).rows;
            const dismissals = (await pool.query(`SELECT * FROM "${schema}".motd_dismissals`)).rows;
            const migrations = (await pool.query(`SELECT * FROM "${schema}".schema_migrations ORDER BY version`)).rows;
            expect(migrations.at(-1).version).toBe("0085");
            const upgraded = await upgrade();
            expect((await pool.query(`SELECT * FROM "${schema}".motds`)).rows).toEqual(rows);
            expect((await pool.query(`SELECT * FROM "${schema}".motd_dismissals`)).rows).toEqual(dismissals);
            expect((await pool.query(`SELECT * FROM "${schema}".schema_migrations WHERE version <= '0085' ORDER BY version`)).rows).toEqual(migrations);
            expect(await upgraded.current(reader)).toBeNull();
            expect(await upgraded.image(reader, existing.motdId)).toEqual(picture);
            expect((await upgraded.create(admin, request)).motdId).toBe(existing.motdId);
            const newMessage = await upgraded.create(admin, input());
            expect(newMessage.endsAt).toBeNull();
            expect((await upgraded.current(reader)).motdId).toBe(newMessage.motdId);
            await expect(upgraded.create(reader, input())).rejects.toMatchObject({ status: 403 });
            await expect(upgraded.delete(reader, existing.motdId)).rejects.toMatchObject({ status: 403 });
        }, "0085");
    });
    it("reuses a receipt across SQL connection time zones, even after a committed finite end expires", async () => {
        await fixture(async ({ pool, schema }) => {
            const client = await pool.connect();
            try {
                const body = input({ startsAt: "2020-01-01T00:00:00Z", endsAt: "2090-01-01T00:00:00Z" });
                const call = () => client.query(`SELECT "${schema}".cms_motd_create('test','admin',true,$1,NULL,NULL) AS result`, [body]);
                await client.query("SET TimeZone='UTC'");
                const first = (await call()).rows[0].result;
                await client.query("SET TimeZone='America/Los_Angeles'");
                const retry = (await call()).rows[0].result;
                expect(retry.motdId).toBe(first.motdId);
                await client.query(`UPDATE "${schema}".motds SET to_at = now() - interval '1 hour' WHERE motd_id = $1`, [first.motdId]);
                expect((await call()).rows[0].result.motdId).toBe(first.motdId);
                await client.query("RESET TimeZone");
            } finally { client.release(); }
        });
    });
});
