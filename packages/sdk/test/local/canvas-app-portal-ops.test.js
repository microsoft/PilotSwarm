/**
 * Canvas app registry over the Web API (issue 181, plan r4 phase 3).
 *
 * Real HTTP router + PortalRuntime + PilotSwarmManagementClient + PG. The
 * same operations are called directly on the management client and over the
 * wire, as five personas, and must agree on results and error codes.
 * Alice and Bob are users, Dev is a contributor, Ada an admin under an
 * unrestricted admin scope, Cara an admin under the cluster scope.
 *
 * Run: npx vitest run test/local/canvas-app-portal-ops.test.js
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import pg from "pg";
import express from "express";
import { PgSessionCatalog } from "../../src/cms.ts";
import { PilotSwarmManagementClient } from "../../src/management-client.ts";
import { FilesystemArtifactStore } from "../../src/session-store.ts";
import { canvasArtifactFilename } from "../../src/canvas-support.ts";
import { ApiClient } from "../../api/src/api-client.js";
import { OPERATIONS } from "../../api/src/protocol.js";
import { PortalRuntime } from "../../../app/web/runtime.js";
import { createApiRouter } from "../../../app/web/api/router.js";

const schema = `ps_test_canvas_api_${randomUUID().replaceAll("-", "")}`;
const url = process.env.PS_TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/pilotswarm";
const pool = new pg.Pool({ connectionString: url });
const P = (subject) => ({ provider: "test", subject });
const PEOPLE = { alice: P("alice"), bob: P("bob"), dev: P("dev"), ada: P("ada"), cara: P("cara") };
const ADMINS = new Set(["ada", "cara"]);
const DESCRIPTION = "Use when testing the canvas app registry over the Web API.";
const CANVAS_OPS = OPERATIONS.filter((op) => /CanvasApp/.test(op.name)).map((op) => op.name);

function page(title, extra = "") {
    const manifest = { name: title, description: DESCRIPTION, interface: { keys: [{ key: "app/x", purpose: "x" }], requests: [], events: [] } };
    return `<!doctype html>\n<!-- CANVAS-APP-MANIFEST ${JSON.stringify(manifest)} -->\n<html><body>${title}${extra}</body></html>\n`;
}

let catalog, mgmt, server, clients, artifactDir;

beforeAll(async () => {
    catalog = await PgSessionCatalog.create(url, schema);
    await catalog.initialize();
    for (const p of Object.values(PEOPLE)) await pool.query(`SELECT "${schema}".cms_register_user($1, $2, $3, $4)`, [p.provider, p.subject, `${p.subject}@example.invalid`, p.subject]);
    artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-api-"));
    mgmt = new PilotSwarmManagementClient({ store: "sqlite::memory:" });
    mgmt._catalog = catalog;
    mgmt._artifactStore = new FilesystemArtifactStore(artifactDir);
    mgmt._started = true;
    // The transport the runtime dispatches to: the same one-line delegation
    // NodeSdkTransport has for every canvas op.
    const transport = { mgmt };
    for (const op of CANVAS_OPS) transport[op] = (args, owner, isAdmin) => mgmt[op](args, owner, isAdmin);
    transport.recordAuthzAudit = (entry) => mgmt.recordAuthzAudit(entry);
    const makeRuntime = (adminScope) => {
        const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
        runtime.start = async () => {};
        runtime.transport = transport;
        runtime.authz.adminScope = adminScope;
        return runtime;
    };
    const unrestricted = makeRuntime("unrestricted");
    const cluster = makeRuntime("cluster");
    const app = express();
    app.use(express.json({ limit: "30mb" }));
    const auth = (req, res, next) => {
        const who = req.headers["x-test-actor"];
        if (!PEOPLE[who]) return res.status(401).json({ ok: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } });
        req.auth = { principal: PEOPLE[who], authorization: { role: ADMINS.has(who) ? "admin" : "user" } };
        next();
    };
    // Cara's requests go through the cluster-scoped runtime; everyone else's through the unrestricted one.
    const unrestrictedRouter = createApiRouter({ runtime: unrestricted, requireAuth: auth });
    const clusterRouter = createApiRouter({ runtime: cluster, requireAuth: auth });
    app.use("/api/v1", (req, res, next) => (req.headers["x-test-actor"] === "cara" ? clusterRouter : unrestrictedRouter)(req, res, next));
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    clients = Object.fromEntries(Object.keys(PEOPLE).map((who) => [who, new ApiClient({
        apiUrl: `http://127.0.0.1:${server.address().port}`,
        fetchImpl: (uri, options) => fetch(uri, { ...options, headers: { ...options.headers, "x-test-actor": who } }),
    })]));
});

afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await catalog?.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    if (artifactDir) fs.rmSync(artifactDir, { recursive: true, force: true });
});

const plain = (value) => JSON.parse(JSON.stringify(value));

describe("canvas app registry over the Web API", () => {
    it("every canvas op has an access class and a same-named direct method", () => {
        expect(CANVAS_OPS.length).toBe(19);
        for (const name of CANVAS_OPS) {
            expect(OPERATIONS.find((op) => op.name === name)).toMatchObject({ access: expect.any(String) });
            expect(typeof mgmt[name]).toBe("function");
        }
    });

    it("private apps: direct and HTTP agree for every persona; NOT_FOUND hides existence, cluster admin included", async () => {
        const name = `api-priv-${randomUUID().slice(0, 8)}`;
        const published = await clients.alice.call("uploadCanvasApp", { html: page(name), name, description: DESCRIPTION });
        expect(published).toMatchObject({ status: "published", scope: "user", version: "1.0.0" });

        const direct = plain(await mgmt.getCanvasApp({ name }, PEOPLE.alice, false));
        const wire = await clients.alice.call("getCanvasApp", { name });
        expect(wire).toEqual(direct);

        for (const who of ["bob", "dev", "cara"]) {
            await expect(clients[who].call("getCanvasApp", { name, scope: "user", ownerProvider: "test", ownerSubject: "alice" })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
            await expect(clients[who].call("getCanvasAppHtml", { name, scope: "user", ownerProvider: "test", ownerSubject: "alice" })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
            await expect(clients[who].call("exportCanvasApp", { name, scope: "user", ownerProvider: "test", ownerSubject: "alice" })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
            await expect(clients[who].call("deleteCanvasApp", { name, scope: "user", ownerProvider: "test", ownerSubject: "alice" })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
            expect((await clients[who].call("listCanvasApps")).some((a) => a.name === name)).toBe(false);
            expect((await clients[who].call("searchCanvasApps", { query: name })).some((a) => a.name === name)).toBe(false);
        }
        const adaSees = await clients.ada.call("getCanvasApp", { name, scope: "user", ownerProvider: "test", ownerSubject: "alice" });
        expect(adaSees.name).toBe(name);

        const html = await clients.alice.call("getCanvasAppHtml", { name });
        expect(html.html).toBe(page(name));
        const raw = await fetch(`${clients.alice.apiUrl}/api/v1/canvas-apps/${name}/html`, { headers: { "x-test-actor": "alice" } });
        expect(raw.headers.get("content-type")).toMatch(/application\/json/);
    });

    it("shared apps: rights for Bob, a contributor, owner and admins; audit rows for contributor and scope changes", async () => {
        const name = `api-shared-${randomUUID().slice(0, 8)}`;
        await clients.alice.call("uploadCanvasApp", { html: page(name), name, description: DESCRIPTION, scope: "shared" });
        await expect(clients.bob.call("uploadCanvasApp", { html: page(name, "x"), name, description: DESCRIPTION, scope: "shared" })).rejects.toMatchObject({ status: 409, code: "NAME_TAKEN" });
        await expect(clients.bob.call("setCanvasAppEnabled", { name, scope: "shared", enabled: false })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
        await expect(clients.bob.call("grantCanvasAppEditor", { name, user: PEOPLE.dev })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });

        await clients.alice.call("grantCanvasAppEditor", { name, user: PEOPLE.dev });
        expect((await clients.bob.call("listCanvasAppEditors", { name })).map((e) => e.subject)).toEqual(["dev"]);
        const devPublished = await clients.dev.call("uploadCanvasApp", { html: page(name, "<p>dev</p>"), name, scope: "shared" });
        expect(devPublished.version).toBe("1.0.1");
        await clients.dev.call("pinCanvasAppVersion", { name, scope: "shared", version: "1.0.0" });
        await clients.dev.call("setCanvasAppMetadata", { name, scope: "shared", description: "Use when a contributor edits this app's description." });
        await expect(clients.dev.call("setCanvasAppScope", { name, scope: "shared", targetScope: "user" })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
        await expect(clients.dev.call("getCanvasAppLoads", { name, scope: "shared" })).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
        expect((await clients.alice.call("getCanvasAppLoads", { name, scope: "shared" }))).toMatchObject({ rows: [], total30d: 0 });
        expect((await clients.cara.call("getCanvasAppLoads", { name, scope: "shared" }).catch((e) => e))).toMatchObject({ status: 403, code: "FORBIDDEN" });

        await clients.alice.call("setCanvasAppScope", { name, scope: "shared", targetScope: "user" });
        await expect(clients.bob.call("getCanvasApp", { name })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
        const audit = await pool.query(`SELECT action FROM "${schema}".authz_audit WHERE action IN ('grantCanvasAppEditor','setCanvasAppScope')`);
        expect(audit.rows.map((r) => r.action).sort()).toEqual(["grantCanvasAppEditor", "setCanvasAppScope"]);
    });

    it("export over the wire, import as another user, and admin-only maintenance", async () => {
        const name = `api-exp-${randomUUID().slice(0, 8)}`;
        await clients.alice.call("uploadCanvasApp", { html: page(name), name, description: DESCRIPTION, version: "1.0.0" });
        await clients.alice.call("uploadCanvasApp", { html: page(name, "<p>2</p>"), name, version: "2.0.0" });
        const archive = await clients.alice.call("exportCanvasApp", { name });
        expect(archive.filename).toBe(`${name}.canvas-app.tar.gz`);
        const direct = await mgmt.exportCanvasApp({ name }, PEOPLE.alice, false);
        expect(archive.sha256).toBe(direct.sha256);
        const imported = await clients.bob.call("importCanvasApp", { contentBase64: archive.contentBase64 });
        expect(imported.versions.map((v) => v.status)).toEqual(["imported", "imported"]);
        expect((await clients.bob.call("getCanvasAppHtml", { name })).version).toBe("2.0.0");
        const again = await clients.bob.call("importCanvasApp", { contentBase64: archive.contentBase64 });
        expect(again.versions.map((v) => v.status)).toEqual(["unchanged", "unchanged"]);
        await expect(clients.bob.call("importCanvasApp", { contentBase64: Buffer.from("not an archive").toString("base64") })).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });

        await expect(clients.alice.call("pruneCanvasApps")).rejects.toMatchObject({ status: 403 });
        await expect(clients.cara.call("pruneCanvasApps")).rejects.toMatchObject({ status: 403 });
        expect(await clients.ada.call("pruneCanvasApps")).toMatchObject({ loadsRemoved: expect.any(Number) });
        await expect(clients.cara.call("migrateLegacyCanvasApps", { dryRun: true })).rejects.toMatchObject({ status: 403 });
        // The canvas app transition: while the portal's switch is on, an
        // unrestricted admin's apply is refused over the wire (409) before
        // anything is read; switched off, it gets past the guard (this
        // fixture has no facts store, so it then stops at 503).
        const savedMode = mgmt.config.canvasLegacyMode;
        try {
            mgmt.config.canvasLegacyMode = true;
            await expect(clients.ada.call("migrateLegacyCanvasApps", { dryRun: false })).rejects.toMatchObject({ status: 409, code: "CANVAS_LEGACY_MODE_ON" });
            mgmt.config.canvasLegacyMode = false;
            await expect(clients.ada.call("migrateLegacyCanvasApps", { dryRun: false })).rejects.toMatchObject({ status: 503, code: "UNAVAILABLE" });
        } finally {
            mgmt.config.canvasLegacyMode = savedMode;
        }

        await clients.bob.call("deleteCanvasApp", { name });
        await expect(clients.bob.call("getCanvasApp", { name, scope: "user" })).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
        expect((await clients.alice.call("getCanvasApp", { name })).versions.length).toBe(2);
    });

    it("publishing a session's canvas needs write access to that session, directly and over the wire", async () => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m", owner: PEOPLE.alice });
        const html = page(`api-sess-${randomUUID().slice(0, 8)}`);
        await mgmt._artifactStore.uploadArtifact(sessionId, canvasArtifactFilename(1), html, "text/html");
        await catalog.recordEvents(sessionId, [{ eventType: "session.canvas_updated", data: { rev: 1, slot: 1, sizeBytes: html.length, trust: "owner" } }], "test");
        const nameFor = (who) => `api-sess-${who}-${randomUUID().slice(0, 6)}`;
        // Bob has no access: NOT_FOUND hides the session, directly and over HTTP.
        await expect(mgmt.publishCanvasApp({ sessionId, name: nameFor("bob"), description: DESCRIPTION }, PEOPLE.bob, false)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(clients.bob.call("publishCanvasApp", { sessionId, name: nameFor("bob"), description: DESCRIPTION })).rejects.toMatchObject({ status: 404 });
        // Dev can read but not write: FORBIDDEN.
        await catalog.grantSessionShare(sessionId, { ...PEOPLE.dev, email: null, displayName: null }, "read");
        await expect(mgmt.publishCanvasApp({ sessionId, name: nameFor("dev"), description: DESCRIPTION }, PEOPLE.dev, false)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(clients.dev.call("publishCanvasApp", { sessionId, name: nameFor("dev"), description: DESCRIPTION })).rejects.toMatchObject({ status: 403 });
        // A caller with no identity and no admin right is refused.
        await expect(mgmt.publishCanvasApp({ sessionId, name: nameFor("anon"), description: DESCRIPTION }, null, false)).rejects.toMatchObject({ code: "FORBIDDEN" });
        // Write collaborator, owner and unrestricted admin may publish.
        await catalog.grantSessionShare(sessionId, { ...PEOPLE.dev, email: null, displayName: null }, "write");
        expect((await mgmt.publishCanvasApp({ sessionId, name: nameFor("dev"), description: DESCRIPTION }, PEOPLE.dev, false)).status).toBe("published");
        expect((await mgmt.publishCanvasApp({ sessionId, name: nameFor("alice"), description: DESCRIPTION }, PEOPLE.alice, false)).status).toBe("published");
        expect((await mgmt.publishCanvasApp({ sessionId, name: nameFor("ada"), description: DESCRIPTION }, PEOPLE.ada, true)).status).toBe("published");
    });

    it("checkOnly returns the publish check and writes nothing, directly and over the wire", async () => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m", owner: PEOPLE.alice });
        const name = `api-check-${randomUUID().slice(0, 8)}`;
        const html = page(name);
        await mgmt._artifactStore.uploadArtifact(sessionId, canvasArtifactFilename(1), html, "text/html");
        await catalog.recordEvents(sessionId, [{ eventType: "session.canvas_updated", data: { rev: 1, slot: 1, sizeBytes: html.length, trust: "owner" } }], "test");
        const broken = "<!doctype html><html><body>no manifest</body></html>";
        await mgmt._artifactStore.uploadArtifact(sessionId, canvasArtifactFilename(2), broken, "text/html");
        await catalog.recordEvents(sessionId, [{ eventType: "session.canvas_updated", data: { rev: 1, slot: 2, sizeBytes: broken.length, trust: "owner" } }], "test");

        const files = () => {
            const out = [];
            const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(dir, e.name)) : out.push(path.join(dir, e.name))); };
            walk(artifactDir);
            return out.sort();
        };
        const snapshot = async () => ({
            apps: (await pool.query(`SELECT count(*)::int AS n FROM "${schema}".canvas_apps`)).rows[0].n,
            versions: (await pool.query(`SELECT count(*)::int AS n FROM "${schema}".canvas_app_versions`)).rows[0].n,
            published: (await catalog.getSessionEvents(sessionId)).filter((e) => e.eventType === "session.canvas_app_published").length,
            files: files(),
        });
        const before = await snapshot();

        const direct = plain(await mgmt.publishCanvasApp({ sessionId, checkOnly: true }, PEOPLE.alice, false));
        expect(direct).toMatchObject({ checkOnly: true, ok: true, code: null, manifest: { name, description: DESCRIPTION }, workspace: false });
        expect(direct.interface).toMatchObject({ keys: [expect.objectContaining({ key: "app/x" })] });
        const wire = await clients.alice.call("publishCanvasApp", { sessionId, checkOnly: true });
        expect(wire).toEqual(direct);
        // A failing page is a result, not an error, and writes nothing either.
        const failed = await clients.alice.call("publishCanvasApp", { sessionId, slot: 2, checkOnly: true });
        expect(failed).toMatchObject({ checkOnly: true, ok: false, code: "BAD_REQUEST", manifest: null });
        expect(failed.error).toMatch(/CANVAS-APP-MANIFEST/);
        const empty = await clients.alice.call("publishCanvasApp", { sessionId, slot: 3, checkOnly: true });
        expect(empty).toMatchObject({ ok: false, error: "no canvas has been drawn on slot 3" });
        // The session write rule still applies to the check.
        await expect(clients.bob.call("publishCanvasApp", { sessionId, checkOnly: true })).rejects.toMatchObject({ status: 404 });

        expect(await snapshot()).toEqual(before);
        await expect(mgmt.getCanvasApp({ name }, PEOPLE.alice, false)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});
