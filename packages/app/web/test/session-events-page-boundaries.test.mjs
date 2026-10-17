/**
 * Portal-layer authorization boundaries for the paged session read (issue 148).
 *
 * The SDK-side authz tests cover access RESOLUTION. They cannot cover the
 * portal's own decisions, and the Opus 4.8 review left exactly that as a
 * residual: per-page re-authorization is architecturally sound but empirically
 * unproven. These tests close the policy half of that gap without a database.
 *
 * The property that matters most: REFUSAL MUST NOT LOOK LIKE SUCCESS. If an
 * unauthorized paged read returned an empty page, a calling agent could not
 * distinguish "you may not see this" from "this session has no events", and
 * would report a clean empty investigation on a session it was never allowed
 * to touch.
 *
 * STILL NOT COVERED, deliberately and visibly: a live PortalRuntime serving
 * real HTTP across multiple pages, a real expired credential mid-drain, and a
 * real anonymous request against a running server. Those need the server and
 * remain open. Nothing here should be read as covering them.
 *
 * Pure. No database, no server, no model.
 *
 * STATUS: authored, NOT YET EXECUTED.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSessionAccess, getMethodAccess } from "../authz.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const readRepo = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

const PAGED = "getSessionEventsPage";
const FORWARD = "getSessionEvents";
const BACKWARD = "getSessionEventsBefore";

const snap = (over = {}) => ({
    rootSessionId: "root", isSystem: false, visibility: "private",
    owner: { provider: "dev", subject: "alice", displayName: "Alice Anderson", email: "alice@dev.local" },
    viewerIsOwner: false, viewerShareAccess: null, ...over,
});

/**
 * Resolve through the portal's OWN lookup rather than re-parsing the protocol
 * source. This exercises the path the dispatcher actually uses, so a change
 * that bypassed or mis-registered the operation would surface here.
 */
function accessFor(name) {
    const entry = getMethodAccess(name);
    assert.ok(entry, `${name} must resolve through the portal access map`);
    return entry;
}
const accessClassOf = (name) => accessFor(name).access;

test("the paged read resolves to a session-scoped gate on the session id", () => {
    const entry = accessFor(PAGED);
    assert.equal(entry.access, "session:read");
    assert.equal(entry.sessionParam, "sessionId",
        "the gate must key on the session id, so the target session is what is authorized");
    assert.ok(entry.access.startsWith("session:"),
        "a non-session access class would skip session gating entirely");
});

test("the paged read is gated by the same access class as both legacy reads", () => {
    // Asserting equality with the legacy reads, not against a literal: the
    // real risk is the new operation drifting to a WEAKER gate than the reads
    // it sits beside, and a hard-coded string would not notice that.
    const paged = accessClassOf(PAGED);
    assert.equal(paged, "session:read");
    assert.equal(paged, accessClassOf(FORWARD));
    assert.equal(paged, accessClassOf(BACKWARD));
});

test("a stranger on a private session is refused as NOT FOUND, never as an empty page", () => {
    const decision = evaluateSessionAccess(accessClassOf(PAGED), snap(), { isAdmin: false, systemReadable: true });
    assert.equal(decision.allowed, false, "a stranger must not be allowed");
    assert.equal(decision.notFound, true,
        "refusal must surface as not-found, so it can never be mistaken for an empty result set");
});

test("POSITIVE CONTROLS: owner and shared reader are allowed", () => {
    // Without these, the refusal above proves only that the call failed, not
    // that authorization is what made it fail.
    const cls = accessClassOf(PAGED);
    const caps = { isAdmin: false, systemReadable: true };
    assert.equal(evaluateSessionAccess(cls, snap({ viewerIsOwner: true }), caps).allowed, true, "owner");
    assert.equal(evaluateSessionAccess(cls, snap({ viewerShareAccess: "read" }), caps).allowed, true, "read grant");
    assert.equal(evaluateSessionAccess(cls, snap({ viewerShareAccess: "write" }), caps).allowed, true, "write grant implies read");
    assert.equal(evaluateSessionAccess(cls, snap({ visibility: "shared_read" }), caps).allowed, true, "deployment shared_read");
});

test("a read grant is sufficient; the paged read never demands write", () => {
    const cls = accessClassOf(PAGED);
    assert.equal(cls, "session:read", "a history read must not require write access");
    const readOnly = snap({ viewerShareAccess: "read" });
    assert.equal(evaluateSessionAccess(cls, readOnly, { isAdmin: false }).allowed, true);
});

test("revoking a share removes access, so a mid-drain change is enforceable", () => {
    // Per-page re-authorization only means something if the decision actually
    // changes when the grant goes away.
    const cls = accessClassOf(PAGED);
    const caps = { isAdmin: false, systemReadable: true };
    const granted = evaluateSessionAccess(cls, snap({ viewerShareAccess: "read" }), caps);
    assert.equal(granted.allowed, true, "control: access before revocation");
    const revoked = evaluateSessionAccess(cls, snap({ viewerShareAccess: null }), caps);
    assert.equal(revoked.allowed, false, "after revocation the same viewer is refused");
    assert.equal(revoked.notFound, true, "and is refused as not-found");
});

test("the paged read is authorized per call, not once per drain", () => {
    // Source-level, because the live multi-page path needs a running server.
    // The dispatcher authorizes every call before dispatch, and the cursor is
    // an ordinary parameter carrying no authorization of its own.
    const runtime = readRepo("packages/app/web/runtime.js");
    assert.ok(runtime.includes("_authorizeCall"), "dispatch authorizes calls");
    assert.ok(/case "getSessionEventsPage"/.test(runtime), "the paged read is dispatched like any other op");

    // The cursor must not appear in any authorization decision.
    const authz = readRepo("packages/app/web/authz.js");
    for (const token of ["afterSeq", "beforeSeq", "nextCursor"]) {
        assert.ok(!authz.includes(token),
            `the authorization engine must not consult ${token}; a cursor is a position, not a capability`);
    }
});

test("the paged read is break-glass audited, like the other content reads", () => {
    const runtime = readRepo("packages/app/web/runtime.js");
    const start = runtime.indexOf("const BREAK_GLASS_AUDITED");
    assert.ok(start > -1, "the audited set exists");
    const block = runtime.slice(start, runtime.indexOf("};", start));
    assert.ok(block.includes(`${PAGED}:`), "the paged read exposes content and must be audited");
    assert.ok(block.includes(`${FORWARD}:`), "control: the forward read is audited");
    assert.ok(block.includes(`${BACKWARD}:`), "control: the backward read is audited");
});

test("system-session readability is not widened by the paged read", () => {
    const cls = accessClassOf(PAGED);
    const systemSnap = snap({ isSystem: true, viewerIsOwner: false });
    const withSystemRead = evaluateSessionAccess(cls, systemSnap, { isAdmin: false, systemReadable: true });
    const withoutSystemRead = evaluateSessionAccess(cls, systemSnap, { isAdmin: false, systemReadable: false });
    assert.notEqual(withSystemRead.allowed, undefined);
    assert.equal(withoutSystemRead.allowed, false,
        "when system sessions are not readable, the paged read must not be a way in");
});
