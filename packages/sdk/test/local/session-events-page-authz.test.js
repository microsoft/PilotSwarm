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
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert, assertEqual, assertNotNull } from "../helpers/assertions.js";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const OWNER = { provider: "test", subject: "owner-0001" };
const STRANGER = { provider: "test", subject: "stranger-0002" };
const READER = { provider: "test", subject: "reader-0003" };

beforeAll(async () => {
    await preflightChecks();
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
    it("the owner resolves to read access on their own session", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = sid("a");
        await catalog.createSession(sessionId, { title: "authz-owner", owner: OWNER });

        const access = await mgmt.getSessionAccess(sessionId, OWNER);
        assertNotNull(access, "owner must resolve to an access snapshot");
        assert(access.canRead === true || access.role === "owner",
            "owner must have read access");

        await mgmt.stop?.();
    });

    it("POSITIVE CONTROL: a shared reader resolves to read access", { timeout: TIMEOUT }, async () => {
        // Without this, the negative test below proves only that a call
        // failed, not that authorization is what made it fail.
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = sid("b");
        await catalog.createSession(sessionId, { title: "authz-shared", owner: OWNER });
        await mgmt.grantSessionShare(sessionId, { ...READER, access: "read" });

        const access = await mgmt.getSessionAccess(sessionId, READER);
        assertNotNull(access, "a shared reader must resolve to an access snapshot");
        assert(access.canRead === true || (access.role && access.role !== "none"),
            "a granted reader must have read access");

        await mgmt.stop?.();
    });

    it("a stranger does NOT resolve to read access on a private session", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = sid("c");
        await catalog.createSession(sessionId, { title: "authz-private", owner: OWNER });

        const access = await mgmt.getSessionAccess(sessionId, STRANGER);
        const denied = access === null || access.canRead === false || access.role === "none";
        assert(denied, "a stranger must not resolve to read access on a private session");

        await mgmt.stop?.();
    });

    it("revoking a share removes read access", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = sid("d");
        await catalog.createSession(sessionId, { title: "authz-revoke", owner: OWNER });

        await mgmt.grantSessionShare(sessionId, { ...READER, access: "read" });
        const granted = await mgmt.getSessionAccess(sessionId, READER);
        assert(granted && (granted.canRead === true || granted.role !== "none"),
            "control: the share took effect before revocation");

        await mgmt.revokeSessionShare(sessionId, READER);
        const after = await mgmt.getSessionAccess(sessionId, READER);
        const revoked = after === null || after.canRead === false || after.role === "none";
        assert(revoked, "revocation must remove read access, so a mid-drain change is enforceable");

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
