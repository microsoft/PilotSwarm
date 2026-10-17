/**
 * LIVE PORTAL AUTHORIZATION for the paged session read (issue 148).
 *
 * The companion file, session-events-page-boundaries.test.mjs, asserts the
 * POLICY function and inspects runtime source text. That is useful but it is
 * not proof: it never issues a request, so it cannot show that the policy is
 * actually consulted, that a refusal reaches the caller as the right status,
 * or that a mid-drain revocation is honoured.
 *
 * These tests do issue requests. They mount the REAL `createApiRouter` on a
 * real HTTP server and drive the REAL `PortalRuntime.call()` — the single
 * enforcement point for both /api/v1 and the legacy dispatcher — so the
 * authorization path under test is the shipped one.
 *
 * WHAT IS REAL HERE, precisely, so no one over-reads these results:
 *   - real HTTP request/response, real express router, real route binding
 *   - real PortalRuntime.call -> _authorizeCall -> _gateSession ->
 *     _decideSessionAccess -> evaluateSessionAccess
 *   - real access-class lookup from the protocol table
 *   - ownership enforcement ON (authz.enforce = true)
 *
 * WHAT IS SUBSTITUTED — all of it, not just the convenient part:
 *   - the CATALOG. `transport.getSessionAccess` returns a scripted snapshot
 *     instead of reading Postgres, and the underlying page read returns a
 *     fixed payload. The data source is faked; the decision is not.
 *   - `start()` is a no-op, so no database connection is opened.
 *   - the AUTHENTICATION MIDDLEWARE. `requireAuth` is scripted per test.
 *
 * That last one bounds the anonymous and expired cases sharply, so read them
 * narrowly. They assert the CONSEQUENCE of a 401 — that the request is
 * refused and, critically, that it never reaches the session catalog at all.
 * They do NOT validate a real token issuer, real signature checking, or a
 * real expiry implementation; the middleware is told to reject rather than
 * deciding to. A genuine expired-token test needs the auth provider, which
 * is a separate surface from the one this file covers.
 *
 * So: the authorization decisions (owner, shared reader, stranger,
 * revoked-share mid-drain) are real end-to-end through the runtime. The
 * authentication boundary cases are structural, not cryptographic. It also
 * does NOT cover a real session in a real database, or concurrency.
 *
 * No credential is created, no auth is bypassed, and no concurrency setting
 * is touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { PortalRuntime } from "../runtime.js";
import { createApiRouter } from "../api/router.js";

const SESSION = "11111111-2222-3333-4444-555555555555";
const PATH = `/api/v1/management/sessions/${SESSION}/events-page`;

const OWNER = { provider: "test", subject: "owner-1" };
const STRANGER = { provider: "test", subject: "stranger-9" };

/** A session-access snapshot in the shape the catalog returns. */
function snapshot({ ownerSubject = OWNER.subject, viewerIsOwner = false, viewerShareAccess = null, visibility = "private", isSystem = false } = {}) {
    return {
        sessionId: SESSION,
        ownerProvider: "test",
        ownerSubject,
        visibility,
        isSystem,
        viewerIsOwner,
        viewerShareAccess,
    };
}

/**
 * A real PortalRuntime with a scripted catalog.
 *
 * `accessFor` is called with the viewer on EVERY request, so a test can
 * change its mind between calls — that is how mid-drain revocation is
 * expressed without touching a database.
 */
function makeRuntime(accessFor) {
    const runtime = new PortalRuntime({ mode: "local" });
    const calls = [];
    runtime.start = async () => { runtime.started = true; };
    runtime.authz = { ...runtime.authz, enforce: true, adminScope: "unrestricted", systemVisibility: "read" };
    runtime.transport = {
        async getSessionAccess(sessionId, viewer) {
            calls.push({ sessionId, viewer });
            return accessFor(viewer, calls.length);
        },
        mgmt: {
            async getSessionEventsPage() {
                return {
                    events: [{ seq: 1, eventType: "assistant.message", data: { content: "hi" }, createdAt: new Date(0) }],
                    receipt: { mode: "latest", hasMore: false, nextCursor: null, nextDirection: null },
                };
            },
        },
    };
    return { runtime, calls };
}

/**
 * Mount the real router. `authFor` decides what the auth middleware does —
 * including refusing, which is how an anonymous or expired caller is
 * expressed at the layer that actually makes that decision.
 */
async function serve(runtime, authFor) {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    const requireAuth = (req, res, next) => {
        const outcome = authFor(req);
        if (outcome.reject) {
            res.status(outcome.status).json({ ok: false, error: { message: outcome.message } });
            return;
        }
        req.auth = outcome.auth;
        next();
    };
    app.use("/api/v1", createApiRouter({ runtime, requireAuth }));
    const server = http.createServer(app);
    await new Promise((done) => server.listen(0, done));
    return {
        baseUrl: `http://localhost:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
    };
}

const authed = (principal, role = "user") => () => ({
    auth: {
        principal,
        authorization: { allowed: true, role, reason: "test", matchedGroups: [] },
    },
});

test("POSITIVE: the owner receives a page over a real request", async () => {
    const { runtime } = makeRuntime(() => snapshot({ viewerIsOwner: true }));
    const { baseUrl, close } = await serve(runtime, authed(OWNER));
    try {
        const res = await fetch(`${baseUrl}${PATH}`);
        assert.equal(res.status, 200, "owner must be served");
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.ok(body.result?.events?.length >= 1, "owner receives actual events");
    } finally {
        await close();
    }
});

test("POSITIVE: a shared reader receives a page", async () => {
    const { runtime } = makeRuntime(() => snapshot({ viewerShareAccess: "read" }));
    const { baseUrl, close } = await serve(runtime, authed(STRANGER));
    try {
        const res = await fetch(`${baseUrl}${PATH}`);
        assert.equal(res.status, 200, "a read grant is sufficient for a history read");
        const body = await res.json();
        assert.ok(body.result?.events?.length >= 1);
    } finally {
        await close();
    }
});

test("DENIED: a stranger on a private session is refused as NOT FOUND, never an empty page", async () => {
    // The distinction matters: an empty page would confirm the session
    // exists, and would also look to a drain like a completed history.
    const { runtime } = makeRuntime(() => snapshot());
    const { baseUrl, close } = await serve(runtime, authed(STRANGER));
    try {
        const res = await fetch(`${baseUrl}${PATH}`);
        assert.equal(res.status, 404, "a stranger must be refused as not-found");
        const body = await res.json();
        assert.equal(body.ok, false, "and must not carry a success envelope");
        assert.ok(!body.result?.events, "a refusal must not contain an events array");
    } finally {
        await close();
    }
});

test("DENIED: an unresolvable or deleted session id does not open the gate", async () => {
    const { runtime } = makeRuntime(() => null);
    const { baseUrl, close } = await serve(runtime, authed(OWNER));
    try {
        const res = await fetch(`${baseUrl}${PATH}`);
        assert.equal(res.status, 404, "no snapshot must mean refused, not permitted");
        const body = await res.json();
        assert.ok(!body.result?.events);
    } finally {
        await close();
    }
});

test("MID-DRAIN: revoking a share between pages refuses the next page", async () => {
    // The real question behind per-call authorization: a reader who was
    // allowed on page 1 must NOT keep draining after the grant is revoked.
    let revoked = false;
    const { runtime, calls } = makeRuntime(() => (revoked ? snapshot() : snapshot({ viewerShareAccess: "read" })));
    const { baseUrl, close } = await serve(runtime, authed(STRANGER));
    try {
        const first = await fetch(`${baseUrl}${PATH}`);
        assert.equal(first.status, 200, "control: allowed before revocation");

        revoked = true;

        const second = await fetch(`${baseUrl}${PATH}?afterSeq=1`);
        assert.equal(second.status, 404, "after revocation the same viewer is refused");
        const body = await second.json();
        assert.ok(!body.result?.events, "and receives no events");

        assert.equal(calls.length, 2,
            "authorization must be resolved PER CALL — a cached first decision would show one lookup");
    } finally {
        await close();
    }
});

test("ANONYMOUS (structural): a refused caller never reaches the session catalog", async () => {
    const { runtime, calls } = makeRuntime(() => snapshot({ viewerIsOwner: true }));
    const { baseUrl, close } = await serve(runtime, () => ({
        reject: true, status: 401, message: "authentication required",
    }));
    try {
        const res = await fetch(`${baseUrl}${PATH}`);
        assert.equal(res.status, 401, "an anonymous caller must be refused");
        assert.equal(calls.length, 0,
            "and must not reach the session catalog at all");
    } finally {
        await close();
    }
});

test("EXPIRED (structural): a refused credential reads nothing; real expiry is the auth provider's surface", async () => {
    const { runtime, calls } = makeRuntime(() => snapshot({ viewerIsOwner: true }));
    const { baseUrl, close } = await serve(runtime, () => ({
        reject: true, status: 401, message: "token expired",
    }));
    try {
        const res = await fetch(`${baseUrl}${PATH}`, {
            headers: { authorization: "Bearer expired-token" },
        });
        assert.equal(res.status, 401, "an expired credential must be refused");
        const body = await res.json();
        assert.ok(!body.result?.events, "and must not return history");
        assert.equal(calls.length, 0, "and must not reach the session catalog");
    } finally {
        await close();
    }
});

test("the paged read is gated exactly like the legacy reads, over real requests", async () => {
    // Same viewer, same session, all three content reads: the new paged
    // route must not be a softer door into the same history.
    const { runtime } = makeRuntime(() => snapshot());
    const { baseUrl, close } = await serve(runtime, authed(STRANGER));
    try {
        for (const path of [
            PATH,
            `/api/v1/management/sessions/${SESSION}/events`,
            `/api/v1/management/sessions/${SESSION}/events-before?beforeSeq=10`,
        ]) {
            const res = await fetch(`${baseUrl}${path}`);
            assert.equal(res.status, 404, `${path} must refuse a stranger identically`);
        }
    } finally {
        await close();
    }
});
