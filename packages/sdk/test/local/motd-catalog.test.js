import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { MotdStore } from "../../src/motd-store.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";

const url = process.env.PS_TEST_DATABASE_URL;
describe.skipIf(!url)("MoTD through the complete CMS migration chain", () => {
    it("registers a first-time viewer during dismissal and keeps it through profile saves", async () => {
        const schema = `ps_test_motd_catalog_${randomUUID().replaceAll("-", "")}`;
        const pool = new pg.Pool({ connectionString: url });
        let catalog;
        try {
            catalog = await PgSessionCatalog.create(url, schema);
            await catalog.initialize();
            const admin = { principal: { provider: "test", subject: "admin" }, isAdmin: true };
            const viewer = { principal: { provider: "test", subject: "first-time" }, isAdmin: false };
            const message = await catalog.motds.create(admin, { fromAt: "2020-01-01T00:00:00Z", toAt: "2090-01-01T00:00:00Z",
                bodyMd: "Hello", requestId: randomUUID() });
            expect((await catalog.motds.current(viewer)).motdId).toBe(message.motdId);
            await catalog.motds.dismiss(viewer, message.motdId);
            expect((await pool.query(`SELECT subject FROM "${schema}".users WHERE subject = 'first-time'`)).rows).toHaveLength(1);
            await catalog.setUserProfileSettings(viewer.principal, { themeId: "workspace-dark" });
            expect(await catalog.motds.current(viewer)).toBeNull();
            expect((await pool.query(`SELECT version FROM "${schema}".schema_migrations WHERE version = '0084'`)).rows).toHaveLength(1);
            expect((await pool.query(`SELECT version FROM "${schema}".schema_migrations WHERE version = '0085'`)).rows).toHaveLength(1);
        } finally {
            await catalog?.close();
            await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await pool.end();
        }
    });
    it("upgrades deployed 0084 without changing its migration record or losing messages", async () => {
        const schema = `ps_test_motd_upgrade_${randomUUID().replaceAll("-", "")}`;
        const pool = new pg.Pool({ connectionString: url });
        let catalog;
        try {
            await runMigrations(pool, schema, CMS_MIGRATIONS(schema).filter(entry => entry.version <= "0084"), 0x63_6D_73);
            const store = new MotdStore(pool, schema);
            const admin = { principal: { provider: "test", subject: "admin" }, isAdmin: true };
            const reader = { principal: { provider: "test", subject: "reader" }, isAdmin: false };
            const message = await store.create(admin, { fromAt: "2020-01-01T00:00:00Z", toAt: "2021-01-01T00:00:00Z",
                bodyMd: "Previous message", requestId: randomUUID(), image: {
                    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", contentType: "image/png", alt: "Previous picture" } });
            await expect(store.list(reader)).rejects.toMatchObject({ status: 403 });
            await expect(store.image(reader, message.motdId)).rejects.toMatchObject({ status: 404 });
            const before = (await pool.query(`SELECT * FROM "${schema}".schema_migrations WHERE version = '0084'`)).rows;
            catalog = await PgSessionCatalog.create(url, schema);
            await catalog.initialize();
            const rows = await catalog.motds.list(reader);
            expect(rows).toEqual([expect.objectContaining({ motdId: message.motdId, bodyMd: "Previous message" })]);
            expect(rows[0]).not.toHaveProperty("createdBy");
            expect(rows[0]).not.toHaveProperty("dismissalCount");
            expect((await catalog.motds.image(reader, message.motdId)).alt).toBe("Previous picture");
            expect((await pool.query(`SELECT * FROM "${schema}".schema_migrations WHERE version = '0084'`)).rows).toEqual(before);
        } finally {
            await catalog?.close();
            await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await pool.end();
        }
    });
});
