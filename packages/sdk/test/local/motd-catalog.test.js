import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";

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
        } finally {
            await catalog?.close();
            await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await pool.end();
        }
    });
});
