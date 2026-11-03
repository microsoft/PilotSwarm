import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import express from "express";
import { PgSessionCatalog } from "../../src/cms.ts";
import { PilotSwarmManagementClient } from "../../src/management-client.ts";
import { ApiClient } from "../../api/src/api-client.js";
import { PortalRuntime } from "../../../app/web/runtime.js";
import { createApiRouter } from "../../../app/web/api/router.js";

const url = process.env.PS_TEST_DATABASE_URL;
describe.skipIf(!url)("authenticated MoTD history through HTTP and the real CMS store", () => {
    it("projects admin fields by trusted role and denies non-admin create and delete", async () => {
        const schema = `ps_test_motd_http_${randomUUID().replaceAll("-", "")}`;
        const pool = new pg.Pool({ connectionString: url });
        let catalog, server;
        try {
            catalog = await PgSessionCatalog.create(url, schema); await catalog.initialize();
            const admin = { principal: { provider: "test", subject: "admin" }, isAdmin: true };
            const previous = await catalog.motds.create(admin, { fromAt: "2020-01-01T00:00:00Z", toAt: "2090-01-01T00:00:00Z",
                bodyMd: "Previous announcement", requestId: randomUUID(), image: {
                    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", contentType: "image/png", alt: "Previous picture" } });
            await pool.query(`UPDATE "${schema}".motds SET to_at = '2021-01-01T00:00:00Z' WHERE motd_id = $1`, [previous.motdId]);
            const scheduled = await catalog.motds.create(admin, { fromAt: "2080-01-01T00:00:00Z", toAt: "2090-01-01T00:00:00Z",
                bodyMd: "Not announced yet", requestId: randomUUID() });
            const mgmt = new PilotSwarmManagementClient({ store: "sqlite::memory:" });
            mgmt._catalog = catalog; mgmt._started = true;
            const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
            runtime.start = async () => {}; runtime.transport = { mgmt };
            const app = express(); app.use(express.json());
            app.use("/api/v1", createApiRouter({ runtime, requireAuth: (req, res, next) => {
                const subject = req.headers["x-test-actor"];
                if (!["admin", "reader"].includes(subject)) return res.status(401).json({ ok: false, error: { code: "UNAUTHORIZED" } });
                req.auth = { principal: { provider: "test", subject }, authorization: { role: subject === "admin" ? "admin" : "user" } };
                next();
            } }));
            server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
            const base = `http://127.0.0.1:${server.address().port}`;
            const client = actor => new ApiClient({ apiUrl: base, fetchImpl: (uri, options) => fetch(uri, { ...options,
                headers: { ...options.headers, "x-test-actor": actor } }) });
            const reader = client("reader"), privileged = client("admin");
            const running = await privileged.call("createMotd", { bodyMd: "Still active, superseded", requestId: randomUUID() });
            const open = await privileged.call("createMotd", { bodyMd: "Optional times", requestId: randomUUID() });
            expect(open.startsAt).toBe(open.createdAt); expect(open.endsAt).toBeNull();
            expect((await reader.call("getCurrentMotd")).endsAt).toBeNull();
            await reader.call("dismissMotd", { motdId: open.motdId });
            expect(await reader.call("getCurrentMotd")).toBeNull();
            expect((await reader.call("listMotds")).find(row => row.motdId === running.motdId).status).toBe("hidden");
            await privileged.call("deleteMotd", { motdId: open.motdId });
            expect((await reader.call("getCurrentMotd")).motdId).toBe(running.motdId);
            await privileged.call("deleteMotd", { motdId: running.motdId });
            const history = await reader.call("listMotds");
            expect(history).toHaveLength(1);
            expect(history[0]).toMatchObject({ motdId: previous.motdId, status: "ended", bodyMd: "Previous announcement" });
            expect(history[0]).not.toHaveProperty("createdBy"); expect(history[0]).not.toHaveProperty("dismissalCount");
            expect((await privileged.call("listMotds"))[0]).toMatchObject({ motdId: scheduled.motdId, createdBy: admin.principal, dismissalCount: 0 });
            expect((await reader.call("getMotdImage", { motdId: previous.motdId })).alt).toBe("Previous picture");
            await expect(reader.call("getMotdImage", { motdId: scheduled.motdId })).rejects.toMatchObject({ status: 404 });
            const forged = await runtime.call("listMotds", { isAdmin: true, principal: admin.principal }, {
                principal: { provider: "test", subject: "reader" }, authorization: { role: "user" },
            });
            expect(forged[0]).not.toHaveProperty("createdBy"); expect(forged[0]).not.toHaveProperty("dismissalCount");
            await expect(reader.call("createMotd", { fromAt: previous.fromAt, toAt: previous.toAt,
                bodyMd: "Not allowed", requestId: randomUUID(), isAdmin: true })).rejects.toMatchObject({ status: 403 });
            await expect(reader.call("deleteMotd", { motdId: previous.motdId, isAdmin: true })).rejects.toMatchObject({ status: 403 });
            await privileged.call("deleteMotd", { motdId: previous.motdId });
            expect(await reader.call("listMotds")).toEqual([]);
            await expect(reader.call("getMotdImage", { motdId: previous.motdId })).rejects.toMatchObject({ status: 404 });
        } finally {
            if (server) await new Promise(resolve => server.close(resolve));
            await catalog?.close(); await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end();
        }
    });
});
