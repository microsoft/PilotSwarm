import test from "node:test";
import assert from "node:assert/strict";
import { PortalRuntime } from "../runtime.js";
import { createJsonRpcError } from "../server.js";

const auth = { principal: { provider: "dev", subject: "alice" }, authorization: { role: "admin" } };
const user = { provider: "dev", subject: "bob" };

function fixture() {
    const calls = [];
    const reads = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce: true, systemVisibility: "read" };
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
    return { runtime, calls, reads };
}

test("system sharing returns a clear 409 using the authorized tree snapshot", async () => {
    for (const [sessionId, method, params] of [
        ["system", "setSessionVisibility", { visibility: "shared_write" }],
        ["child", "grantSessionShare", { user, access: "write" }],
    ]) {
        const { runtime, calls, reads } = fixture();
        await assert.rejects(runtime.call(method, { sessionId, ...params }, auth), (error) => {
            const { status, body } = createJsonRpcError(error);
            assert.equal(status, 409);
            assert.equal(body.error.code, "CONFLICT");
            assert.match(body.error.message, /system session sharing.*deployment policy/i);
            return true;
        });
        assert.deepEqual(calls, []);
        assert.deepEqual(reads, [sessionId], "reuse the authorization snapshot");
    }
});

test("authorized revocation on a system tree and ordinary sharing still reach the transport", async () => {
    const { runtime, calls } = fixture();
    await runtime.call("setSessionVisibility", { sessionId: "ordinary", visibility: "shared_write" }, auth);
    await runtime.call("grantSessionShare", { sessionId: "ordinary", user, access: "write" }, auth);
    await runtime.call("revokeSessionShare", { sessionId: "child", user }, auth);
    assert.deepEqual(calls.map(([method]) => method), ["visibility", "grant", "revoke"]);
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
