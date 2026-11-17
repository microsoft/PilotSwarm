import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { PortalRuntime } from "../runtime.js";
import { createApiRouter } from "../api/router.js";

const as = (role) => ({ principal: { provider: "dev", subject: "alice" }, authorization: { role } });
const user = { provider: "dev", subject: "bob" };

function fixture({ role = "admin", systemVisibility = "read", enforce = true } = {}) {
    const calls = [];
    const reads = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce, systemVisibility };
    runtime.transport = {
        getSessionAccess: async (id) => {
            reads.push(id);
            return id === "missing" ? null : {
                rootSessionId: id === "child" ? "system" : id,
                isSystem: id !== "ordinary",
                visibility: "private",
                viewerIsOwner: id === "ordinary",
                owner: { provider: "dev", subject: "alice" },
                viewerShareAccess: null,
            };
        },
        setSessionVisibility: async (...args) => { calls.push(["visibility", ...args]); },
        grantSessionShare: async (...args) => { calls.push(["grant", ...args]); },
        revokeSessionShare: async (...args) => { calls.push(["revoke", ...args]); },
    };
    return { runtime, calls, reads, auth: as(role) };
}

for (const enforce of [true, false]) {
    test(`system roots and descendants refuse visibility/grants after authorization (enforce=${enforce})`, async () => {
        for (const role of ["admin", "anonymous"]) {
            for (const sessionId of ["system", "child"]) {
                for (const [method, params] of [
                    ["setSessionVisibility", { visibility: "shared_write" }],
                    ["grantSessionShare", { user, access: "write" }],
                ]) {
                    const { runtime, calls, reads, auth } = fixture({ role, enforce });
                    await assert.rejects(runtime.call(method, { sessionId, ...params }, auth), (error) => {
                        assert.equal(error.code, "CONFLICT");
                        assert.equal(error.status, 409);
                        assert.match(error.message, /system session sharing.*deployment policy/i);
                        return true;
                    });
                    assert.deepEqual(calls, []);
                    assert.deepEqual(reads, [sessionId], "reuse the authorization snapshot");
                }
            }
        }
    });
}

test("authorized revocation on a system tree and ordinary sharing still reach the transport", async () => {
    const { runtime, calls, auth } = fixture();
    await runtime.call("setSessionVisibility", { sessionId: "ordinary", visibility: "shared_write" }, auth);
    await runtime.call("grantSessionShare", { sessionId: "ordinary", user, access: "write" }, auth);
    for (const sessionId of ["system", "child"]) {
        await runtime.call("revokeSessionShare", { sessionId, user }, auth);
    }
    assert.deepEqual(calls.map(([method]) => method), ["visibility", "grant", "revoke", "revoke"]);
});

test("the sharing refusal does not replace authorization or not-found privacy", async () => {
    for (const [sessionId, systemVisibility, code] of [
        ["system", "read", "FORBIDDEN"],
        ["system", "admin", "NOT_FOUND"],
        ["missing", "read", "NOT_FOUND"],
    ]) {
        const { runtime, calls, auth } = fixture({ role: "user", systemVisibility });
        await assert.rejects(runtime.call("setSessionVisibility", { sessionId, visibility: "shared_write" }, auth),
            { code });
        assert.deepEqual(calls, []);
    }
});

test("the generated HTTP route preserves the policy conflict and its actionable message", async (t) => {
    const { runtime, auth, calls } = fixture();
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({ runtime, requireAuth: (req, res, next) => { req.auth = auth; next(); } }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/sessions/system/visibility`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: "shared_write" }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error.code, "CONFLICT");
    assert.match(body.error.message, /system session sharing.*deployment policy/i);
    assert.deepEqual(calls, []);
});
