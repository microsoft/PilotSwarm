import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { PortalRuntime } from "../runtime.js";
import { createApiRouter } from "../api/router.js";
import { createJsonRpcError } from "../server.js";

const auth = { principal: { provider: "dev", subject: "alice" }, authorization: { role: "admin" } };
const user = { provider: "dev", subject: "bob" };

function fixture() {
    const calls = [];
    const reads = [];
    const audits = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce: true, systemVisibility: "read" };
    runtime.transport = {
        getSessionAccess: async (id) => {
            reads.push(id);
            return id === "missing" ? null : {
                rootSessionId: id === "child" ? "system" : id,
                isSystem: id !== "ordinary",
                systemVisibility: "read",
                visibility: "private",
                viewerIsOwner: id === "ordinary",
                owner: { provider: "dev", subject: "alice" },
                viewerShareAccess: null,
            };
        },
        setSessionVisibility: async (...args) => { calls.push(["visibility", ...args]); },
        grantSessionShare: async (...args) => { calls.push(["grant", ...args]); },
        revokeSessionShare: async (...args) => { calls.push(["revoke", ...args]); },
        recordAuthzAudit: async (entry) => { audits.push(entry); },
        mgmt: { getSession: async () => null },
    };
    return { runtime, calls, reads, audits };
}

test("system sharing returns a clear 409 using the authorized tree snapshot", async () => {
    for (const [sessionId, method, params] of [
        ["system", "setSessionVisibility", { visibility: "shared_write" }],
        ["child", "grantSessionShare", { user, access: "write" }],
    ]) {
        const { runtime, calls, reads, audits } = fixture();
        await assert.rejects(runtime.call(method, { sessionId, ...params }, auth), (error) => {
            const { status, body } = createJsonRpcError(error);
            assert.equal(status, 409);
            assert.equal(body.error.code, "SYSTEM_SESSION_PROTECTED");
            assert.match(body.error.message, /system session sharing.*deployment policy/i);
            return true;
        });
        assert.deepEqual(calls, []);
        assert.deepEqual(reads, [sessionId], "reuse the authorization snapshot");
        assert.deepEqual(audits.map(({ action, decision, reason }) => ({ action, decision, reason })), [{
            action: method,
            decision: "deny",
            reason: "system_session_sharing_policy",
        }]);
    }
});

test("the generated REST route returns the fixed 409 code without a transport write", async () => {
    const { runtime, calls } = fixture();
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({
        runtime,
        requireAuth: (req, _res, next) => { req.auth = auth; next(); },
    }));
    const server = await new Promise((resolve) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
        const base = `http://127.0.0.1:${server.address().port}/api/v1`;
        for (const [path, body] of [
            ["/sessions/system/visibility", { visibility: "shared_write" }],
            ["/sessions/child/shares", { user, access: "write" }],
        ]) {
            const response = await fetch(`${base}${path}`, {
                method: path.endsWith("visibility") ? "PUT" : "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
            assert.equal(response.status, 409);
            const envelope = await response.json();
            assert.equal(envelope.error.code, "SYSTEM_SESSION_PROTECTED");
            assert.match(envelope.error.message, /deployment policy/i);
        }
        assert.deepEqual(calls, []);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("access reports the effective system-session policy without exposing stored visibility as authoritative", async () => {
    const { runtime } = fixture();
    const systemAccess = await runtime.call("getSessionAccess", { sessionId: "system" }, auth);
    const ordinaryAccess = await runtime.call("getSessionAccess", { sessionId: "ordinary" }, auth);
    assert.equal(systemAccess.isSystem, true);
    assert.equal(systemAccess.systemVisibility, "read");
    assert.equal(ordinaryAccess.isSystem, false);
    assert.equal(ordinaryAccess.systemVisibility, null);
});

test("authorized revocation on a system tree and ordinary sharing still reach the transport", async () => {
    const { runtime, calls } = fixture();
    await runtime.call("setSessionVisibility", { sessionId: "ordinary", visibility: "shared_write" }, auth);
    await runtime.call("grantSessionShare", { sessionId: "ordinary", user, access: "write" }, auth);
    await runtime.call("revokeSessionShare", { sessionId: "child", user }, auth);
    assert.deepEqual(calls.map(([method]) => method), ["visibility", "grant", "revoke"]);
    assert.equal(calls[0][3].subject, "alice", "visibility carries the portal actor to catalog audit fallback");
    assert.equal(calls[1][5].subject, "alice", "grant carries the portal actor to catalog audit fallback");
});

test("the sharing refusal does not replace authorization or not-found privacy", async () => {
    for (const [sessionId, systemVisibility, code] of [
        ["system", "read", "FORBIDDEN"],
        ["system", "admin", "NOT_FOUND"],
        ["missing", "read", "NOT_FOUND"],
    ]) {
        const { runtime, calls } = fixture();
        runtime.authz.systemVisibility = systemVisibility;
        await assert.rejects(runtime.call("setSessionVisibility", { sessionId, visibility: "shared_write" },
            { ...auth, authorization: { role: "user" } }), { code });
        assert.deepEqual(calls, []);
    }
});
