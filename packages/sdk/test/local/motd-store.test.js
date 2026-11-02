import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { MotdStore } from "../../src/motd-store.ts";
import { motdMigration } from "../../src/migrations/motd-0084.ts";
import { motdHistoryMigration } from "../../src/migrations/motd-history-0085.ts";

const admin = { principal: { provider: "test", subject: "admin" }, isAdmin: true };
const alice = { principal: { provider: "test", subject: "alice" }, isAdmin: false };
const bob = { principal: { provider: "test", subject: "bob" }, isAdmin: false };
const input = extra => ({ fromAt: "2020-01-01T00:00:00Z", toAt: "2090-01-01T00:00:00Z", bodyMd: "Hello",
    requestId: randomUUID(), ...extra });
const png = { base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", contentType: "image/png", alt: "One pixel" };
const schema = `ps_test_motd_${randomUUID().replaceAll("-", "")}`;
const url = process.env.PS_TEST_DATABASE_URL;
const localPostgres = process.env.PS_TEST_LOCAL_POSTGRES === "true";
const pool = url || localPostgres ? new pg.Pool({ ...(url ? { connectionString: url } : {}), max: 4 }) : null;
let store;

describe("message input validation without a database", () => {
    const disconnected = new MotdStore({ connect: async () => { throw new Error("must not reach database"); } }, "test");
    it.each([
        { bodyMd: "" }, { bodyMd: "é".repeat(8193) }, { mobileBodyMd: "x".repeat(16385) },
        { toAt: "2020-01-01T00:00:00Z" }, { fromAt: "not a time" }, { requestId: "" }, { imagePlacement: "under" },
        { image: { ...png, alt: "" } }, { image: { ...png, contentType: "image/svg+xml" } },
        { image: { ...png, base64: "AAAA" } }, { image: { ...png, base64: "*invalid*" } },
        { image: { ...png, base64: Buffer.alloc(2097153).toString("base64") } },
        { mobileImage: { ...png, base64: Buffer.alloc(2097153).toString("base64") } },
        { bodyMd: "Hello\u0000world" }, { mobileBodyMd: "\u0000" }, { requestId: "req\u0000" },
        { image: { ...png, alt: "logo\u0000" } },
    ])("rejects invalid bodies, windows or pictures: %j", async extra => {
        await expect(disconnected.create(admin, input(extra))).rejects.toMatchObject({ code: "MOTD_INVALID" });
    });
    it.each(["0", "-1", "1.5", "9223372036854775808", 1])("rejects malformed message ID %s", id => {
        expect(() => disconnected.dismiss(alice, id)).toThrow("Invalid message ID");
        expect(() => disconnected.delete(admin, id)).toThrow("Invalid message ID");
        expect(() => disconnected.image(alice, id)).toThrow("Invalid message ID");
    });
});

describe.skipIf(!pool)("message SQL functions in isolated PostgreSQL", () => {
    beforeAll(async () => {
        await pool.query(`CREATE SCHEMA "${schema}"`);
        await pool.query(`CREATE TABLE "${schema}".users(user_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            provider TEXT NOT NULL, subject TEXT NOT NULL, UNIQUE(provider, subject))`);
        await pool.query(`CREATE FUNCTION "${schema}".cms_register_user(p TEXT, s TEXT, e TEXT, d TEXT) RETURNS BIGINT
            LANGUAGE sql AS $$ INSERT INTO "${schema}".users(provider, subject) VALUES(p, s)
            ON CONFLICT(provider, subject) DO UPDATE SET subject = EXCLUDED.subject RETURNING user_id; $$`);
        await pool.query(motdMigration(schema));
        await pool.query(motdHistoryMigration(schema));
        for (const viewer of [admin, alice, bob]) await pool.query(`INSERT INTO "${schema}".users(provider, subject) VALUES($1, $2)`, [viewer.principal.provider, viewer.principal.subject]);
        store = new MotdStore(pool, schema);
    });
    beforeEach(async () => {
        await pool.query(`DELETE FROM "${schema}".motds`);
        await pool.query(`DELETE FROM "${schema}".motd_dismissals`);
    });
    afterAll(async () => { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
    it("applies time windows with an inclusive start and exclusive end", async () => {
        expect(await store.current(alice)).toBeNull();
        await store.create(admin, input({ toAt: "2021-01-01T00:00:00Z" }));
        await store.create(admin, input({ fromAt: "2080-01-01T00:00:00Z" }));
        expect(await store.current(alice)).toBeNull();
        const live = await store.create(admin, input());
        expect((await store.current(alice)).motdId).toBe(live.motdId);
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`UPDATE "${schema}".motds SET from_at = now(), to_at = now() + interval '1 hour' WHERE motd_id = $1`, [live.motdId]);
            const current = () => client.query(`SELECT "${schema}".cms_motd_current('test', 'alice', false) AS result`);
            expect((await current()).rows[0].result.motdId).toBe(live.motdId);
            await client.query(`UPDATE "${schema}".motds SET from_at = now() - interval '1 hour', to_at = now() WHERE motd_id = $1`, [live.motdId]);
            expect((await current()).rows[0].result).toBeNull();
            await client.query("COMMIT");
        } finally { await client.query("ROLLBACK"); client.release(); }
    });
    it("resolves overlaps, ties, history labels and bounded pagination", async () => {
        const older = await store.create(admin, input());
        const later = await store.create(admin, input({ fromAt: "2025-01-01T00:00:00Z" }));
        const tie = await store.create(admin, input({ fromAt: later.fromAt }));
        expect((await store.current(alice)).motdId).toBe(tie.motdId);
        expect((await store.list(admin)).map(m => m.status)).toEqual(["live", "hidden", "hidden"]);
        expect((await store.list(admin, 1))[0].motdId).toBe(tie.motdId);
        expect((await store.list(admin, 1, later.motdId))[0].motdId).toBe(older.motdId);
    });
    it("dismisses once per person and lets a later message show", async () => {
        const first = await store.create(admin, input());
        await store.dismiss(alice, first.motdId); await store.dismiss(alice, first.motdId);
        expect(await store.current(alice)).toBeNull();
        expect((await store.current(bob)).motdId).toBe(first.motdId);
        expect((await store.list(admin))[0].dismissalCount).toBe(1);
        const next = await store.create(admin, input({ fromAt: "2025-01-01T00:00:00Z" }));
        expect((await store.current(alice)).motdId).toBe(next.motdId);
    });
    it("removes rows and pictures without auditing, keeps dismissals and never reuses IDs", async () => {
        const first = await store.create(admin, input({ image: png, mobileImage: png }));
        await store.dismiss(alice, first.motdId);
        expect(await store.image(bob, first.motdId)).toEqual(png);
        expect(await store.delete(admin, first.motdId)).toMatchObject({ deleted: true });
        expect(await store.delete(admin, first.motdId)).toMatchObject({ deleted: false });
        expect((await pool.query(`SELECT * FROM "${schema}".motd_dismissals`)).rows).toHaveLength(1);
        await expect(store.image(bob, first.motdId)).rejects.toMatchObject({ status: 404 });
        const next = await store.create(admin, input());
        expect(BigInt(next.motdId)).toBeGreaterThan(BigInt(first.motdId));
        expect((await store.current(alice)).motdId).toBe(next.motdId);
        // There is deliberately no authz_audit table in this fixture.
    });
    it("enforces admin inside SQL for create and delete, and authentication for reads", async () => {
        for (const viewer of [alice, { principal: null, isAdmin: true }]) {
            await expect(store.create(viewer, input())).rejects.toMatchObject({ status: 403 });
            await expect(store.delete(viewer, "1")).rejects.toMatchObject({ status: 403 });
        }
        await expect(pool.query(`SELECT "${schema}".cms_motd_create('test', 'alice', false, '{}'::jsonb, NULL, NULL)`)).rejects.toThrow("MOTD_FORBIDDEN");
        await expect(store.current({ principal: null, isAdmin: false })).rejects.toMatchObject({ status: 403 });
        await expect(store.list({ principal: null, isAdmin: true })).rejects.toMatchObject({ status: 403 });
        await expect(store.image({ principal: null, isAdmin: true }, "1")).rejects.toMatchObject({ status: 403 });
        await expect(store.dismiss({ principal: null, isAdmin: false }, "1")).rejects.toMatchObject({ status: 403 });
    });
    it("coalesces retries and refuses changed input or a different actor", async () => {
        const request = input();
        const [first, retry] = await Promise.all([store.create(admin, request), store.create(admin, request)]);
        expect(retry).toEqual(first);
        await expect(store.create(admin, { ...request, bodyMd: "changed" })).rejects.toMatchObject({ status: 409 });
        await expect(store.create({ ...bob, isAdmin: true }, request)).rejects.toMatchObject({ status: 409 });
        expect(await store.list(admin)).toHaveLength(1);
    });
    it("uses the main picture when no mobile picture exists and does not put bytes in message reads", async () => {
        const message = await store.create(admin, input({ image: png }));
        expect(message).toMatchObject({ hasImage: true, hasMobileImage: false, imagePlacement: "above" });
        expect(message).not.toHaveProperty("image");
        expect(await store.image(alice, message.motdId, true)).toEqual(png);
    });
    it("accepts exactly 2 MB for each picture and rejects invalid table metadata", async () => {
        const bytes = Buffer.alloc(2 * 1024 * 1024);
        Buffer.from(png.base64, "base64").copy(bytes);
        const image = { ...png, base64: bytes.toString("base64") };
        const message = await store.create(admin, input({ image, mobileImage: image }));
        expect(message).toMatchObject({ hasImage: true, hasMobileImage: true });
        await expect(pool.query(`UPDATE "${schema}".motds SET image_alt = NULL WHERE motd_id = $1`, [message.motdId]))
            .rejects.toMatchObject({ code: "23514" });
    });
    it("does not allow pre-dismissal of a future ID and acknowledges deletion races", async () => {
        await store.dismiss(alice, "9223372036854775807");
        expect((await pool.query(`SELECT * FROM "${schema}".motd_dismissals`)).rows).toHaveLength(0);
        const message = await store.create(admin, input());
        await store.delete(admin, message.motdId);
        expect(await store.dismiss(alice, message.motdId)).toMatchObject({ dismissed: true });
    });
    it("allows authenticated history pictures while keeping admin-only metadata private", async () => {
        const ended = await store.create(admin, input({ image: png, toAt: "2021-01-01T00:00:00Z" }));
        const scheduled = await store.create(admin, input({ image: png, fromAt: "2080-01-01T00:00:00Z" }));
        expect(await store.image(alice, ended.motdId)).toEqual(png);
        await expect(store.image(alice, scheduled.motdId)).rejects.toMatchObject({ status: 404 });
        expect(await store.image(admin, scheduled.motdId)).toEqual(png);
        expect((await store.list(admin)).some(row => row.motdId === scheduled.motdId)).toBe(true);
        expect((await store.list(alice)).some(row => row.motdId === scheduled.motdId)).toBe(false);
        expect((await store.list(alice, 50, "9223372036854775807")).some(row => row.motdId === scheduled.motdId)).toBe(false);
        const older = await store.create(admin, input({ image: png }));
        await store.create(admin, input({ fromAt: "2025-01-01T00:00:00Z" }));
        expect(await store.image(alice, older.motdId)).toEqual(png);
        expect(await store.current(alice)).not.toHaveProperty("createdBy");
        expect((await store.list(admin))[0]).toHaveProperty("createdBy");
        expect((await store.list(admin))[0]).toHaveProperty("dismissalCount");
        for (const row of await store.list(alice)) {
            expect(row).not.toHaveProperty("createdBy");
            expect(row).not.toHaveProperty("dismissalCount");
        }
        const direct = await pool.query(`SELECT "${schema}".cms_motd_list('test', 'alice', false, 50, NULL) AS result`);
        expect(direct.rows[0].result).toEqual(await store.list(alice));
        await store.delete(admin, ended.motdId);
        expect((await store.list(alice)).some(row => row.motdId === ended.motdId)).toBe(false);
        await expect(store.image(alice, ended.motdId)).rejects.toMatchObject({ status: 404 });
    });
    it("accepts an animated PNG declared as image/png", async () => {
        const original = Buffer.from(png.base64, "base64");
        const control = Buffer.alloc(20);
        control.writeUInt32BE(8, 0); control.write("acTL", 4); control.writeUInt32BE(1, 8);
        const animated = Buffer.concat([original.subarray(0, 33), control, original.subarray(33)]);
        const message = await store.create(admin, input({ image: { ...png, base64: animated.toString("base64") } }));
        expect(message).toMatchObject({ hasImage: true, imageType: "image/png" });
    });
});
