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
import { PgSessionCatalog } from "pilotswarm-sdk";

// PS_TEST_DATABASE_URL ONLY. Accepting an ambient DATABASE_URL would let this
// file run against whatever database happens to be configured — including a
// real one — which is exactly the accident a test must not have.
const DB_URL = process.env.PS_TEST_DATABASE_URL;

/**
 * A SKIP MUST NOT READ AS COVERAGE.
 *
 * Review found the real hazard: without PS_TEST_DATABASE_URL this file skips,
 * `test:web` still exits zero, and the aggregate runner records the packages/app
 * stage as PASS (scripts/run-tests.sh:688-691, which has no no-skips gate). So a
 * CI run that simply forgot the variable looks identical to one where every
 * catalog assertion passed.
 *
 * Two defences here, since a test file cannot fix the aggregate runner:
 *   1. PS_REQUIRE_DB_COVERAGE=1 turns the skip into a FAILURE. A runner that
 *      intends this coverage can demand it instead of hoping for it.
 *   2. Otherwise the skip announces itself loudly on stderr, so "skipped" is
 *      visible in the log rather than inferred from a silent green.
 *
 * The aggregate no-skips gate remains a REAL GAP. It lives in the runner
 * script, which is outside this test-only change, and is recorded rather than
 * quietly widened into scope.
 */
const REQUIRE_DB = process.env.PS_REQUIRE_DB_COVERAGE === "1";
if (!DB_URL) {
    const msg = "[catalog-join] PS_TEST_DATABASE_URL is not set: ZERO catalog assertions will run. "
        + "A green result here is NOT evidence of catalog coverage.";
    if (REQUIRE_DB) {
        test("catalog coverage was REQUIRED but no database was provided", () => {
            assert.fail(`${msg} PS_REQUIRE_DB_COVERAGE=1 was set, so this is a failure, not a skip.`);
        });
    } else {
        console.error(msg);
    }
}
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
    // WORKERS=0 is LOAD-BEARING, not tidiness.
    //
    // node-sdk-transport.js:593 reads `parseInt(process.env.WORKERS || "4")`
    // and starts that many EMBEDDED WORKERS in local mode. This file creates
    // three runtimes, so the default would start twelve workers against the
    // test database — and if it held eligible queued work, they would execute
    // it. A membership test must not run anyone's agent turns.
    const prevWorkers = process.env.WORKERS;
    process.env.WORKERS = "0";
    let runtime;
    try {
        runtime = new PortalRuntime({ store: DB_URL, mode: "local" });
        await runtime.start();
    } finally {
        if (prevWorkers === undefined) delete process.env.WORKERS;
        else process.env.WORKERS = prevWorkers;
    }
    runtime.authz = { ...runtime.authz, enforce: true, adminScope: "unrestricted", systemVisibility: "read" };
    return runtime;
}

describeOrSkip("CATALOG JOIN: owner, grant, resumed-then-revoked drain against REAL catalog rows", async (t) => {
    const runtime = await realRuntime();
    let sessionId;
    let catalog;

    t.after(async () => {
        try { if (sessionId) await runtime.transport.mgmt.revokeSessionShare(sessionId, READER); } catch { /* best effort */ }
        try { await catalog?.close?.(); } catch { /* best effort */ }
        try { await runtime.stop?.(); } catch { /* best effort */ }
    });

    // Arrange: a real session owned by a real principal.
    //
    // Created through the same shipped surface the existing database suites
    // use — `catalog.createSession(id, { owner })`, as in
    // session-events-page-authz.test.js:131. Not a test-only helper, and not
    // a fabricated row.
    // R34-1: `createSession` does NOT exist on PilotSwarmManagementClient. It
    // lives on the CATALOG (cms.ts), which is what the existing database
    // suites use via their own helper. Two earlier drafts of this file got
    // this wrong: one called a nonexistent method on the management client,
    // the other used the catalog's PRIVATE constructor. Both were caught in
    // independent review, before any database existed to run them against.
    // N1: PgSessionCatalog's CONSTRUCTOR IS PRIVATE. `new PgSessionCatalog(...)`
    // does not work, so my first correction swapped one unusable API for
    // another. The real entry point is the static factory, which builds the
    // pool itself — the same call the existing database helper makes.
    catalog = await PgSessionCatalog.create(DB_URL);
    sessionId = `catalog-join-${process.pid}-${Date.now()}`;
    await catalog.createSession(sessionId, { title: "catalog-join", owner: OWNER });
    // REAL events, so a drain has something to page through. Without these the
    // revocation case could only use a hand-written cursor, which proves a
    // later denied request but NOT that a drain in progress is stopped.
    await catalog.recordEvents(sessionId, Array.from({ length: 6 }, (_, i) => ({
        eventType: "assistant.message",
        data: { content: `catalog-join event ${i + 1}` },
    })));

    await t.test("POSITIVE CONTROL: the owner is served their own session", async () => {
        // Load-bearing. A 404-only result set is indistinguishable from an
        // implementation that refuses everyone, so this must pass in the SAME
        // run as the denials below.
        const { baseUrl, close } = await serve(runtime, OWNER);
        try {
            const res = await fetch(`${baseUrl}${pagePath(sessionId)}`);
            const body = await res.json();
            assert.equal(res.status, 200, `owner must be served — got ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
            assert.ok(Array.isArray(body.result?.events), "the owner must receive an events ARRAY, not merely something truthy");
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
            assert.ok(Array.isArray(body.result?.events), "a granted reader must receive an events ARRAY");
        } finally { await close(); }
    });

    await t.test("VISIBILITY: the grant is visible to a FRESH runtime instance", async () => {
        // SCOPED CLAIM, narrowed after review. This proves the grant is visible
        // to a runtime instance that never saw it created - which rules out
        // per-instance caching. It does NOT prove durable-storage independence:
        // both instances share this process, and module-level state shared
        // between them would also satisfy it. Durability across processes is a
        // remaining gap, recorded rather than claimed.
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

    await t.test("REVOKE: a drain that RESUMED while granted is refused after revocation", async () => {
        const { baseUrl, close } = await serve(runtime, READER);
        try {
            // A GENUINE mid-drain: take page one, continue from the cursor the
            // SERVER issued, and revoke in between. An earlier version used a
            // hand-written afterSeq=1 against a session with no events, which
            // proved only that a later request was denied - not that a drain
            // already in progress is stopped. Flagged in review; fixed rather
            // than relabelled.
            // No `page` parameter: this route IS the paged op, and the
            // protocol accepts only afterSeq/beforeSeq/limit/eventTypes.
            // `page=true` is the MCP tool's own flag and was ignored here.
            const first = await fetch(`${baseUrl}${pagePath(sessionId)}?limit=2`);
            assert.equal(first.status, 200, "control: the drain starts readable");
            const firstBody = await first.json();
            // N2: the receipt crosses the Web API as the MANAGEMENT CLIENT's
            // shape, which is camelCase (hasMore / nextCursor,
            // session-events-page.ts:161-162). snake_case is the MCP tool's
            // own rendering and does not apply on this path. Asserting
            // has_more here compared undefined and would have failed at the
            // control — loudly, but for the wrong reason.
            const receipt = firstBody.result?.receipt;
            assert.ok(Array.isArray(firstBody.result?.events) && firstBody.result.events.length > 0,
                "control: page one must deliver real rows to continue from");
            // `!== null` ACCEPTS `undefined`. That is the same vacuous shape
            // this branch has been bitten by repeatedly, and here it would let
            // a route that emits no cursor at all pass the control. Require a
            // real number.
            assert.equal(receipt?.hasMore, true,
                `control: the drain must be INCOMPLETE so continuing is meaningful; receipt=${JSON.stringify(receipt)}`);
            assert.equal(typeof receipt?.nextCursor, "number",
                `control: the cursor must be a NUMBER, not merely non-null; receipt=${JSON.stringify(receipt)}`);

            // DIRECTION MATTERS, and I had it wrong. A request with no cursor
            // is LATEST mode (session-events-page.ts:48-49), whose
            // continuation is BACKWARD. Continuing with afterSeq would have
            // been a forward request against a backward cursor - an incoherent
            // drain that happened to still be denied, so it would have "passed"
            // while testing nothing real.
            //
            // Follow the receipt's OWN direction instead of assuming one.
            assert.equal(receipt.nextDirection, "backward",
                `control: a cursorless first page is LATEST and must continue BACKWARD; receipt=${JSON.stringify(receipt)}`);

            // AUTHORIZED CONTINUATION FIRST. Without this the case never shows
            // the cursor actually resumes a drain: a route emitting a bogus or
            // ignored cursor, still authorizing initial pages and returning 404
            // after revocation, would pass while proving nothing. So continue
            // ONCE while still permitted, and require real rows back.
            const resumed = await fetch(
                `${baseUrl}${pagePath(sessionId)}?limit=2&beforeSeq=${receipt.nextCursor}`);
            assert.equal(resumed.status, 200, "control: the drain must RESUME while the share is still granted");
            const resumedBody = await resumed.json();
            const resumedSeqs = (resumedBody.result?.events ?? []).map((e) => e.seq);
            assert.ok(resumedSeqs.length > 0,
                `control: continuing from the cursor must return rows; got ${JSON.stringify(resumedBody.result?.receipt)}`);
            const firstSeqs = (firstBody.result?.events ?? []).map((e) => e.seq);
            assert.ok(resumedSeqs.every((q) => !firstSeqs.includes(q)),
                `control: the continuation must return DIFFERENT rows, not repeat page one; page1=${JSON.stringify(firstSeqs)} page2=${JSON.stringify(resumedSeqs)}`);

            await runtime.transport.mgmt.revokeSessionShare(sessionId, READER);

            // Now the SAME continuation shape that just worked must stop.
            const after = await fetch(
                `${baseUrl}${pagePath(sessionId)}?limit=2&beforeSeq=${resumedBody.result.receipt.nextCursor ?? receipt.nextCursor}`);
            const body = await after.json();
            assert.equal(after.status, 404,
                "a drain in progress must STOP when the share is revoked, not continue from its cursor");
            assert.ok(!body.result?.events, "and must receive no further events");
        } finally { await close(); }
    });

    await t.test("VISIBILITY: the revocation is visible to a FRESH runtime instance", async () => {
        // Same scoped claim as above: new-instance visibility, not proof of
        // cross-process durability.
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
