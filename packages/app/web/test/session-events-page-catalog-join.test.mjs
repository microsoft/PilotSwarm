/**
 * REAL CATALOG JOIN for the paged session read (issue 148).
 *
 * `session-events-page-portal-authz.test.mjs` drives the real router and the
 * real runtime decision path, but `getSessionAccess` returns a SCRIPTED
 * snapshot — so ownership and share data are fabricated. That proves the
 * decision logic is right GIVEN a snapshot. It cannot prove the snapshot
 * itself is right.
 *
 * This file removes the fabrication. Ownership, grants and revocations are
 * real rows, created through the shipped management APIs:
 *
 *   grantSessionShare   (management-client.ts:1178 — access is THIRD POSITIONAL)
 *   revokeSessionShare  (management-client.ts:1199)
 *   getSessionAccess    (management-client.ts:1166)
 *
 * NO FABRICATED ACCESS SNAPSHOT APPEARS ANYWHERE IN THIS FILE. If a future
 * edit reintroduces one, the file has lost its reason to exist.
 *
 * ── REQUIRES A DATABASE ─────────────────────────────────────────────────
 * No model and no inference: this is membership and authorization only. It
 * skips cleanly when PS_TEST_DATABASE_URL is absent, so it never pretends to
 * have run.
 *
 * STATUS: authored, NOT EXECUTED. No database, pod, model or credential
 * authority has been used. The expected outcomes below are expectations, not
 * results.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { PortalRuntime } from "../runtime.js";
import { createApiRouter } from "../api/router.js";

const DB_URL = process.env.PS_TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeOrSkip = DB_URL ? test : test.skip;

const OWNER = { provider: "test", subject: `owner-${process.pid}` };
const READER = { provider: "test", subject: `reader-${process.pid}` };
const STRANGER = { provider: "test", subject: `stranger-${process.pid}` };

const pagePath = (sessionId) => `/api/v1/management/sessions/${sessionId}/events-page`;

/**
 * Mount the real router over a runtime backed by the REAL catalog.
 *
 * Only the caller's identity is supplied by the test; everything the
 * authorization decision reads comes from the database.
 */
async function serve(runtime, principal) {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/api/v1", createApiRouter({
        runtime,
        requireAuth: (req, _res, next) => {
            req.auth = {
                principal,
                authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] },
            };
            next();
        },
    }));
    const server = http.createServer(app);
    await new Promise((done) => server.listen(0, done));
    return {
        baseUrl: `http://localhost:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
    };
}

/**
 * A runtime on the real store, with ownership enforcement ON.
 *
 * `authz.enforce` is set explicitly rather than inherited: a deployment
 * default of "off" would make every case below pass vacuously.
 */
async function realRuntime() {
    const runtime = new PortalRuntime({ store: DB_URL, mode: "local" });
    await runtime.start();
    runtime.authz = { ...runtime.authz, enforce: true, adminScope: "unrestricted", systemVisibility: "read" };
    return runtime;
}

describeOrSkip("CATALOG JOIN: owner, grant, revoke and persistence against real rows", async (t) => {
    const runtime = await realRuntime();
    let sessionId;

    t.after(async () => {
        try { if (sessionId) await runtime.transport.mgmt.revokeSessionShare(sessionId, READER); } catch { /* best effort */ }
        try { await runtime.stop?.(); } catch { /* best effort */ }
    });

    // Arrange: a real session owned by a real principal.
    //
    // Created through the same shipped surface the existing database suites
    // use — `catalog.createSession(id, { owner })`, as in
    // session-events-page-authz.test.js:131. Not a test-only helper, and not
    // a fabricated row.
    sessionId = `catalog-join-${process.pid}-${Date.now()}`;
    await runtime.transport.mgmt.createSession(sessionId, { title: "catalog-join", owner: OWNER });

    await t.test("POSITIVE CONTROL: the owner is served their own session", async () => {
        // Load-bearing. A 404-only result set is indistinguishable from an
        // implementation that refuses everyone, so this must pass in the SAME
        // run as the denials below.
        const { baseUrl, close } = await serve(runtime, OWNER);
        try {
            const res = await fetch(`${baseUrl}${pagePath(sessionId)}`);
            const body = await res.json();
            assert.equal(res.status, 200, `owner must be served — got ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
            assert.ok(body.result?.events, "the owner must receive an events array");
        } finally { await close(); }
    });

    await t.test("DENIED: a stranger gets NOT FOUND, never an empty page", async () => {
        const { baseUrl, close } = await serve(runtime, STRANGER);
        try {
            const res = await fetch(`${baseUrl}${pagePath(sessionId)}`);
            const body = await res.json();
            assert.equal(res.status, 404, "a stranger must be refused as not-found");
            assert.ok(!body.result?.events, "and must not receive an events array — an empty page would confirm the session exists");
        } finally { await close(); }
    });

    await t.test("GRANT: a real share makes the reader readable", async () => {
        await runtime.transport.mgmt.grantSessionShare(sessionId, READER, "read");
        const { baseUrl, close } = await serve(runtime, READER);
        try {
            const res = await fetch(`${baseUrl}${pagePath(sessionId)}`);
            const body = await res.json();
            assert.equal(res.status, 200, `a granted reader must be served — got ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
            assert.ok(body.result?.events, "a granted reader must receive events");
        } finally { await close(); }
    });

    await t.test("PERSISTENCE: the grant survives a FRESH runtime, so it is a row and not in-process state", async () => {
        // The distinction this whole file exists for. A grant cached in memory
        // would satisfy the previous case and fail this one.
        const fresh = await realRuntime();
        const { baseUrl, close } = await serve(fresh, READER);
        try {
            const res = await fetch(`${baseUrl}${pagePath(sessionId)}`);
            assert.equal(res.status, 200, "the grant must be visible to a runtime that never saw it created");
        } finally {
            await close();
            try { await fresh.stop?.(); } catch { /* best effort */ }
        }
    });

    await t.test("REVOKE: revoking the real share refuses the next page mid-drain", async () => {
        const { baseUrl, close } = await serve(runtime, READER);
        try {
            const before = await fetch(`${baseUrl}${pagePath(sessionId)}`);
            assert.equal(before.status, 200, "control: readable before revocation");

            await runtime.transport.mgmt.revokeSessionShare(sessionId, READER);

            const after = await fetch(`${baseUrl}${pagePath(sessionId)}?afterSeq=1`);
            const body = await after.json();
            assert.equal(after.status, 404, "after revocation the same viewer must be refused");
            assert.ok(!body.result?.events, "and must receive no events");
        } finally { await close(); }
    });

    await t.test("REVOKE PERSISTENCE: the revocation also survives a fresh runtime", async () => {
        const fresh = await realRuntime();
        const { baseUrl, close } = await serve(fresh, READER);
        try {
            const res = await fetch(`${baseUrl}${pagePath(sessionId)}`);
            assert.equal(res.status, 404, "a revoked grant must not reappear for a runtime that never saw it");
        } finally {
            await close();
            try { await fresh.stop?.(); } catch { /* best effort */ }
        }
    });

    await t.test("CONCURRENCY: two readers of the same session do not see each other's access", async () => {
        // Real rows, two identities, interleaved. A per-process cache keyed on
        // the session rather than the viewer would fail here.
        await runtime.transport.mgmt.grantSessionShare(sessionId, READER, "read");
        const granted = await serve(runtime, READER);
        const denied = await serve(runtime, STRANGER);
        try {
            const [a, b] = await Promise.all([
                fetch(`${granted.baseUrl}${pagePath(sessionId)}`),
                fetch(`${denied.baseUrl}${pagePath(sessionId)}`),
            ]);
            assert.equal(a.status, 200, "the granted reader must still be served under concurrent load");
            assert.equal(b.status, 404, "the stranger must still be refused under concurrent load");
        } finally {
            await granted.close();
            await denied.close();
        }
    });
});
