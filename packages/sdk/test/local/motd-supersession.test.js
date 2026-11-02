import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { MotdStore } from "../../src/motd-store.ts";
import { PilotSwarmManagementClient } from "../../src/management-client.ts";
import { createMotdTools } from "../../src/motd-tools.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerMotdTools } from "../../../app/mcp/dist/src/tools/motd.js";

const url = process.env.PS_TEST_DATABASE_URL;
const admin = { principal: { provider: "test", subject: "admin" }, isAdmin: true };
const reader = { principal: { provider: "test", subject: "reader" }, isAdmin: false };
const other = { principal: { provider: "test", subject: "other" }, isAdmin: false };
const input = extra => ({ bodyMd: "Announcement", requestId: randomUUID(), ...extra });

describe.skipIf(!url)("fleet-current MoTD supersession in real PostgreSQL", () => {
    async function fixture(run, through = "0087") {
        const schema = `ps_test_motd_supersede_${randomUUID().replaceAll("-", "")}`;
        const pool = new pg.Pool({ connectionString: url, max: 4 });
        let catalog;
        try {
            await runMigrations(pool, schema, CMS_MIGRATIONS(schema).filter(entry => entry.version <= through), 0x63_6D_73);
            const store = new MotdStore(pool, schema);
            await run({ pool, schema, store, upgrade: async () => {
                catalog = await PgSessionCatalog.create(url, schema);
                await catalog.initialize();
                return catalog;
            } });
        } finally {
            await catalog?.close();
            await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await pool.end();
        }
    }
    it("does not resurrect older active rows after dismissing fleet-current; list statuses stay unchanged", async () => {
        await fixture(async ({ store }) => {
            const older = await store.create(admin, input({ endsAt: "2090-01-01T00:00:00Z" }));
            const newer = await store.create(admin, input());
            expect((await store.current(reader)).motdId).toBe(newer.motdId);
            const before = await store.list(reader);
            await store.dismiss(reader, newer.motdId);
            expect(await store.current(reader)).toBeNull();
            expect((await store.current(other)).motdId).toBe(newer.motdId);
            expect(await store.list(reader)).toEqual(before);
            expect(before.map(row => [row.motdId, row.status])).toEqual([[newer.motdId, "live"], [older.motdId, "hidden"]]);
        });
    });
    it("a viewer's older dismissal does not hide a newer active message", async () => {
        await fixture(async ({ store }) => {
            const older = await store.create(admin, input());
            await store.dismiss(reader, older.motdId);
            const newer = await store.create(admin, input({ startsAt: "2020-01-01T00:00:00Z" }));
            expect((await store.current(reader)).motdId).toBe(newer.motdId);
        });
    });
    it("a previously-created schedule takes over at its exact start despite the older dismissal", async () => {
        await fixture(async ({ pool, schema, store }) => {
            const scheduled = await store.create(admin, input({ startsAt: "2080-01-01T00:00:00Z" }));
            const older = await store.create(admin, input());
            await store.dismiss(reader, older.motdId);
            expect(await store.current(reader)).toBeNull();
            expect((await store.list(reader)).some(row => row.motdId === scheduled.motdId)).toBe(false);
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                await client.query(`UPDATE "${schema}".motds SET from_at = now() - interval '1 hour',
                    created_at = now() - interval '1 hour' WHERE motd_id = $1`, [older.motdId]);
                await client.query(`UPDATE "${schema}".motds SET from_at = now(), created_at = now() - interval '2 days'
                    WHERE motd_id = $1`, [scheduled.motdId]);
                const current = (await client.query(`SELECT "${schema}".cms_motd_current('test','reader',false) AS result`)).rows[0].result;
                expect(current.motdId).toBe(scheduled.motdId);
                await client.query("COMMIT");
            } finally { await client.query("ROLLBACK"); client.release(); }
        });
    });
    it("deleting fleet-current reveals the next-newest, but that row's own dismissal still applies", async () => {
        await fixture(async ({ store }) => {
            const older = await store.create(admin, input());
            await store.dismiss(other, older.motdId);
            const newer = await store.create(admin, input());
            await store.dismiss(reader, newer.motdId);
            expect(await store.current(reader)).toBeNull();
            await store.delete(admin, newer.motdId);
            expect((await store.current(reader)).motdId).toBe(older.motdId);
            expect(await store.current(other)).toBeNull();
        });
    });
    it("message ID breaks equal activation times before dismissal; ends remain exclusive", async () => {
        await fixture(async ({ pool, schema, store }) => {
            const older = await store.create(admin, input());
            const newer = await store.create(admin, input());
            await pool.query(`UPDATE "${schema}".motds SET from_at = '2020-01-01', created_at = '2020-01-01'`);
            await store.dismiss(reader, newer.motdId);
            expect(await store.current(reader)).toBeNull();
            expect((await store.current(other)).motdId).toBe(newer.motdId);
            await pool.query(`UPDATE "${schema}".motds SET to_at = now() WHERE motd_id = $1`, [newer.motdId]);
            expect((await store.current(reader)).motdId).toBe(older.motdId);
        });
    });
    it("upgrades seeded 0086 to 0087 without changing rows, pictures, dismissals, history or earlier migration records", async () => {
        await fixture(async ({ pool, schema, store, upgrade }) => {
            const picture = { base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", contentType: "image/png", alt: "Seeded picture" };
            const olderRequest = input({ endsAt: "2090-01-01T00:00:00Z", image: picture });
            const older = await store.create(admin, olderRequest);
            const newer = await store.create(admin, input({ image: picture }));
            await store.dismiss(reader, newer.motdId);
            await store.dismiss(other, older.motdId);
            expect((await store.current(reader)).motdId).toBe(older.motdId);
            const rows = (await pool.query(`SELECT * FROM "${schema}".motds ORDER BY motd_id`)).rows;
            const dismissals = (await pool.query(`SELECT * FROM "${schema}".motd_dismissals ORDER BY user_id,motd_id`)).rows;
            const records = (await pool.query(`SELECT * FROM "${schema}".schema_migrations ORDER BY version`)).rows;
            expect(records.at(-1).version).toBe("0086");
            const listDefinition = (await pool.query(`SELECT pg_get_functiondef('"${schema}".cms_motd_list(text,text,boolean,integer,bigint)'::regprocedure) AS sql`)).rows[0].sql;
            const history = await store.list(admin);
            const catalog = await upgrade();
            expect((await pool.query(`SELECT * FROM "${schema}".motds ORDER BY motd_id`)).rows).toEqual(rows);
            expect((await pool.query(`SELECT * FROM "${schema}".motd_dismissals ORDER BY user_id,motd_id`)).rows).toEqual(dismissals);
            expect((await pool.query(`SELECT * FROM "${schema}".schema_migrations WHERE version <= '0086' ORDER BY version`)).rows).toEqual(records);
            expect((await pool.query(`SELECT version FROM "${schema}".schema_migrations ORDER BY version DESC LIMIT 1`)).rows[0].version).toBe("0087");
            expect((await pool.query(`SELECT pg_get_functiondef('"${schema}".cms_motd_list(text,text,boolean,integer,bigint)'::regprocedure) AS sql`)).rows[0].sql).toBe(listDefinition);
            expect(await catalog.motds.list(admin)).toEqual(history);
            expect(await catalog.motds.current(reader)).toBeNull();
            expect((await catalog.motds.current(other)).motdId).toBe(newer.motdId);
            expect(await catalog.motds.image(reader, older.motdId)).toEqual(picture);
            expect((await catalog.motds.create(admin, olderRequest)).motdId).toBe(older.motdId);
            await expect(catalog.motds.current({ principal: null, isAdmin: false })).rejects.toMatchObject({ status: 403 });
        }, "0086");
    });
    it("agent and MCP current tools return SQL null rather than an older message after dismissal", async () => {
        await fixture(async ({ store, upgrade }) => {
            await store.create(admin, input({ endsAt: "2090-01-01T00:00:00Z" }));
            const newest = await store.create(admin, input());
            const catalog = await upgrade();
            const mgmt = new PilotSwarmManagementClient({ store: "sqlite::memory:" });
            mgmt._catalog = catalog; mgmt._started = true;
            const tools = createMotdTools(catalog.motds, async () => reader, async () => { throw new Error("No picture read expected"); });
            const agentCurrent = () => tools.find(tool => tool.name === "get_current_motd").handler({}, {});
            expect(JSON.parse(await agentCurrent()).motdId).toBe(newest.motdId);
            const keys = ["PILOTSWARM_MCP_ACTOR_PROVIDER", "PILOTSWARM_MCP_ACTOR_SUBJECT"];
            const prior = keys.map(key => process.env[key]);
            process.env[keys[0]] = reader.principal.provider; process.env[keys[1]] = reader.principal.subject;
            const server = new McpServer({ name: "motd-supersession", version: "1.0.0" });
            const client = new Client({ name: "motd-reader", version: "1.0.0" });
            const [a, b] = InMemoryTransport.createLinkedPair();
            try {
                registerMotdTools(server, { mgmt, admin: false, webMode: false });
                await server.connect(b); await client.connect(a);
                const current = async () => {
                    const result = await client.callTool({ name: "get_current_motd", arguments: {} });
                    expect(result.isError).not.toBe(true);
                    return JSON.parse(result.content[0].text);
                };
                expect((await current()).motdId).toBe(newest.motdId);
                const dismissed = await client.callTool({ name: "dismiss_motd", arguments: { motdId: newest.motdId } });
                expect(dismissed.isError).not.toBe(true);
                expect(await current()).toBeNull();
                expect(JSON.parse(await agentCurrent())).toBeNull();
                expect(await mgmt.getCurrentMotd(reader)).toBeNull();
            } finally {
                await client.close(); await server.close();
                keys.forEach((key, i) => { if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i]; });
            }
        });
    });
});
