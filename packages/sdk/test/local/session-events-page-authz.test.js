/**
 * M6 — authorization around the paged session read (issue 148).
 *
 * The property under test is NOT "the tool exists and is labelled
 * session:read". Tool registration and labels are not enforcement. It is:
 *
 *   a caller receives exactly the history they were already entitled to read,
 *   and is told plainly when they are not entitled.
 *
 * The sharpest failure mode is refusal that LOOKS like emptiness. If an
 * unauthorized read returned an empty page instead of an error, a calling
 * agent could not distinguish "you may not see this" from "this session has
 * no events", and would report a clean, empty investigation on a session it
 * was never allowed to touch. Several tests below exist only to make that
 * distinction impossible to blur.
 *
 * SCOPE, stated honestly. Access is enforced at the Web API / portal dispatch
 * layer (protocol access: session:read), not inside the direct management
 * client. This file therefore covers what IS decidable here:
 *   - access resolution for owner, non-owner and shared reader
 *   - that the paged operation carries the same classification as the legacy
 *     reads, and is break-glass audited like them
 *   - that a cursor is a position, not a capability
 * Per-page re-authorization through the live portal dispatcher, and the
 * anonymous/expired-credential cases, need the portal runtime and are NOT
 * covered here. They remain open and must not be reported as covered.
 *
 * Synthetic principals and synthetic data only.
 *
 * Run: npx vitest run test/local/session-events-page-authz.test.js
 *
 * STATUS: authored against the documented harness; NOT YET EXECUTED. No
 * database has been granted at the time of writing.
 */

import { describe, it, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PilotSwarmManagementClient } from "../../src/index.ts";
import { useSuiteEnv, DATABASE_URL } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert, assertEqual, assertNotNull } from "../helpers/assertions.js";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const OWNER = { provider: "test", subject: "owner-0001" };
const STRANGER = { provider: "test", subject: "stranger-0002" };
const READER = { provider: "test", subject: "reader-0003" };

/**
 * DB-only preflight. Deliberately NOT the shared preflightChecks(), which also
 * requires a model provider and throws without GITHUB_TOKEN
 * (test/helpers/local-env.js). These suites drive the catalog directly and
 * never call a model, so demanding a model credential would turn a missing
 * token into a false failure of database coverage.
 *
 * DATABASE_URL resolves PS_TEST_DATABASE_URL first, so a runner passing that
 * variable is already correct.
 */
beforeAll(async () => {
    const pg = await import("pg");
    const client = new pg.default.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 4000 });
    try {
        await client.connect();
        await client.query("SELECT 1");
    } finally {
        try { await client.end(); } catch {}
    }
});

async function managementFor(env) {
    const mgmt = new PilotSwarmManagementClient({ store: env.store, cmsSchema: env.cmsSchema });
    await mgmt.start();
    return mgmt;
}

const sid = (tag) => `22222222-3333-4444-5555-${tag}${Date.now().toString(16).slice(-8)}`.slice(0, 36);

describe("paged read carries the same authorization as the legacy reads", () => {
    it("is classified session:read, identically to both legacy event reads", () => {
        // Hard-coding the string alone would not catch the real risk, which is
        // the paged read drifting to a WEAKER gate than the reads it sits
        // beside. Assert equality with them, not just the literal.
        const protocolSrc = fs.readFileSync(
            path.join(REPO_ROOT, "packages/sdk/api/src/protocol.js"), "utf8");
        const entry = (name) => {
            const line = protocolSrc.split("\n").find((l) => l.includes(`name: "${name}"`));
            assertNotNull(line, `${name} must exist in the protocol table`);
            const m = line.match(/access:\s*"([^"]+)"/);
            assertNotNull(m, `${name} must declare an access classification`);
            return m[1];
        };
        const paged = entry("getSessionEventsPage");
        assertEqual(paged, "session:read");
        assertEqual(paged, entry("getSessionEvents"), "must not differ from the forward read");
        assertEqual(paged, entry("getSessionEventsBefore"), "must not differ from the backward read");
    });

    it("is break-glass audited, like the other content-exposing reads", () => {
        // BREAK_GLASS_AUDITED exists because these reads expose CONTENT. A
        // content read that is not audited is a silent hole in the trail.
        const runtimeSrc = fs.readFileSync(
            path.join(REPO_ROOT, "packages/app/web/runtime.js"), "utf8");
        const block = runtimeSrc.slice(
            runtimeSrc.indexOf("const BREAK_GLASS_AUDITED"),
            runtimeSrc.indexOf("};", runtimeSrc.indexOf("const BREAK_GLASS_AUDITED")));
        assert(block.includes("getSessionEventsPage:"), "paged read must be break-glass audited");
        assert(block.includes("getSessionEvents:"), "control: the legacy read is audited");
        assert(block.includes("getSessionEventsBefore:"), "control: the backward read is audited");
    });
});

describe("access resolution for owner, stranger and shared reader", () => {
    // These assert the REAL SessionAccessSnapshot fields: rootSessionId,
    // isSystem, visibility, owner, viewerIsOwner, viewerShareAccess
    // (packages/sdk/src/cms.ts:301-308). There is no canRead and no role.
    // An earlier version of this file asserted those invented fields; the
    // shared-reader check would have passed VACUOUSLY, because
    // `undefined !== "none"` is true. Caught in independent review before any
    // database run, which is exactly when it was still cheap.

    it("the owner is reported as the owner", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = sid("a");
        await catalog.createSession(sessionId, { title: "authz-owner", owner: OWNER });

        const access = await mgmt.getSessionAccess(sessionId, OWNER);
        assertNotNull(access, "owner must resolve to an access snapshot");
        assertEqual(access.viewerIsOwner, true, "viewerIsOwner identifies the owner");
        assertEqual(access.owner.subject, OWNER.subject, "the snapshot names the owning subject");

        await mgmt.stop?.();
    });

    it("POSITIVE CONTROL: a granted reader carries viewerShareAccess 'read'", { timeout: TIMEOUT }, async () => {
        // Without this, the stranger case below proves only that a call
        // returned something, not that granting changes the answer.
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = sid("b");
        await catalog.createSession(sessionId, { title: "authz-shared", owner: OWNER });

        // access is the THIRD POSITIONAL argument, not a field on the grantee
        // (management-client.ts:1176-1180).
        await mgmt.grantSessionShare(sessionId, READER, "read");

        const access = await mgmt.getSessionAccess(sessionId, READER);
        assertNotNull(access, "a shared reader must resolve to an access snapshot");
        assertEqual(access.viewerShareAccess, "read", "the grant is visible on the snapshot");
        assertEqual(access.viewerIsOwner, false, "a grantee is not the owner");

        await mgmt.stop?.();
    });

    it("a stranger has no grant and is not the owner on a private session", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = sid("c");
        await catalog.createSession(sessionId, { title: "authz-private", owner: OWNER, visibility: "private" });

        const access = await mgmt.getSessionAccess(sessionId, STRANGER);
        if (access !== null) {
            assertEqual(access.viewerIsOwner, false, "a stranger is not the owner");
            assertEqual(access.viewerShareAccess, null, "a stranger holds no grant");
            assertEqual(access.visibility, "private", "and the session is private");
        }
        // The snapshot is raw input to the policy engine; the DENIAL itself is
        // asserted at the portal layer, in
        // packages/app/web/test/session-events-page-boundaries.test.mjs, where
        // a stranger is refused as not-found rather than as an empty page.

        await mgmt.stop?.();
    });

    it("revoking a share clears viewerShareAccess", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = sid("d");
        await catalog.createSession(sessionId, { title: "authz-revoke", owner: OWNER });

        await mgmt.grantSessionShare(sessionId, READER, "read");
        const granted = await mgmt.getSessionAccess(sessionId, READER);
        assertEqual(granted.viewerShareAccess, "read", "control: the grant took effect first");

        await mgmt.revokeSessionShare(sessionId, READER);
        const after = await mgmt.getSessionAccess(sessionId, READER);
        assertEqual(after === null ? null : after.viewerShareAccess, null,
            "revocation clears the grant, so a mid-drain change is enforceable");

        await mgmt.stop?.();
    });
});

describe("a cursor is a position, not a capability", () => {
    it("a cursor from one session does not select another session's rows", { timeout: TIMEOUT }, async () => {
        // seq is a GLOBAL BIGSERIAL, so a cursor taken from session A is a
        // syntactically valid number in session B. Nothing about its SHAPE
        // rejects it. The read must be scoped by session, so presenting A's
        // cursor against B can only ever return B's own rows.
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);

        const sessionA = sid("e");
        const sessionB = sid("f");
        await catalog.createSession(sessionA, { title: "cursor-a", owner: OWNER });
        await catalog.createSession(sessionB, { title: "cursor-b", owner: OWNER });

        await catalog.recordEvents(sessionA, [
            { eventType: "assistant.message", data: { content: "A-1" } },
            { eventType: "assistant.message", data: { content: "A-2" } },
        ]);
        await catalog.recordEvents(sessionB, [
            { eventType: "assistant.message", data: { content: "B-1" } },
        ]);

        const aRows = await catalog.getSessionEvents(sessionA, undefined, 100);
        const aSeqs = aRows.map((r) => r.seq);
        const bRows = await catalog.getSessionEvents(sessionB, undefined, 100);
        const bSeqs = bRows.map((r) => r.seq);

        // Present A's cursor against B.
        const crossed = await mgmt.getSessionEventsPage(sessionB, { afterSeq: aSeqs[0], limit: 100 });
        const returned = crossed.events.map((e) => e.seq);

        for (const seq of returned) {
            assert(bSeqs.includes(seq), `row ${seq} must belong to session B`);
            assert(!aSeqs.includes(seq), `row ${seq} from session A must never be returned for session B`);
        }
        assert(crossed.events.every((e) => e.sessionId === sessionB),
            "every returned row must carry the requested session id");

        await mgmt.stop?.();
    });
});

/**
 * NOT COVERED HERE, and deliberately not implied to be:
 *   - per-page re-authorization through the live portal dispatcher
 *   - unauthorized read returning an explicit ERROR rather than an empty page
 *     (that behaviour lives in the Web API layer, not the direct client)
 *   - anonymous and expired-credential paths
 *   - admin-tagged MCP tools not registering for a non-admin credential
 * These need the portal runtime and an auth provider. They remain OPEN.
 */
