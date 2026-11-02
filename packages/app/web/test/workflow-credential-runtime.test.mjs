/**
 * Workflow v2 credentialed answer and completion (design 04: "The public
 * completion endpoint must not let an ordinary human bearer token complete a
 * node"; INACTIVE unless the deployment enables them):
 * POST /api/v1/session-requests/:requestId/responses (respondToSessionRequest)
 * and POST /api/v1/sessions/:sessionId/workflow-node/result
 * (completeWorkflowNode), access workflow:credential. The portal admits the
 * caller and asks nothing else: no session gate runs, and the caller's
 * identity is not passed on, because the invocation credential in the body is
 * the only authority, checked by the transport (the management client). An
 * absent field stays absent on the way; a refusal keeps its code and status
 * and its details when the adapter marks them safe to show; both HTTP-backed
 * clients send the fields and carry the details back.
 *
 * Run: node --test web/test/workflow-credential-runtime.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { WebPilotSwarmManagementClient } from "pilotswarm-sdk";
import { ApiClient, HttpApiTransport } from "pilotswarm-sdk/api";

import { createApiRouter } from "../api/router.js";
import { PortalRuntime } from "../runtime.js";

test("the answer and the completion are POST operations whose authority is the credential in the body", async () => {
    const { OPERATIONS } = await import("../../../sdk/api/src/protocol.js");
    const byName = (name) => OPERATIONS.find((entry) => entry.name === name);
    const body = { in: "body" };
    const respond = byName("respondToSessionRequest");
    assert.deepEqual({ access: respond.access, method: respond.method, path: respond.path, params: respond.params }, {
        access: "workflow:credential", method: "POST", path: "/session-requests/:requestId/responses",
        params: { requestId: { in: "path", name: "requestId" }, operationId: body, response: body, decline: body, credential: body },
    });
    const complete = byName("completeWorkflowNode");
    assert.deepEqual({ access: complete.access, method: complete.method, path: complete.path, params: complete.params }, {
        access: "workflow:credential", method: "POST", path: "/sessions/:sessionId/workflow-node/result",
        params: { sessionId: { in: "path", name: "sessionId" }, nodeExecutionId: body, operationId: body, outcome: body, output: body, error: body,
            credential: body },
    });
});

/** A runtime whose transport records what it gets; its session access lookup must never be asked. */
function runtimeWith(answer = async () => ({ ok: "fine" })) {
    const calls = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce: true };
    runtime.transport = {
        getSessionAccess: async () => { throw new Error("no session gate runs for a credentialed action"); },
        recordAuthzAudit: async () => {},
        respondToSessionRequest: async (requestId, input) => { calls.push(["respond", requestId, input]); return answer("respond", input); },
        completeWorkflowNode: async (sessionId, input) => { calls.push(["complete", sessionId, input]); return answer("complete", input); },
    };
    return { runtime, calls };
}

const as = (subject, role = "user") => ({ principal: { provider: "dev", subject }, authorization: { role } });

test("the portal admits the caller and passes only the fields given, never the caller's identity", async () => {
    const { runtime, calls } = runtimeWith();
    await runtime.call("respondToSessionRequest", { requestId: "nx-9", operationId: "op-1", response: { approved: true }, credential: "pswic_x" }, as("bob"));
    await runtime.call("completeWorkflowNode", { sessionId: "child-1", operationId: "op-2", outcome: "accepted", output: null, credential: "pswic_y" },
        as("carol"));
    // A call without a credential still reaches the transport, which refuses it there (CREDENTIAL_REQUIRED).
    await runtime.call("completeWorkflowNode", { sessionId: "child-1", operationId: "op-3", error: { code: "needs_input", message: "Which base?" } }, as("bob"));
    assert.deepEqual(calls, [
        ["respond", "nx-9", { operationId: "op-1", response: { approved: true }, credential: "pswic_x" }],
        ["complete", "child-1", { operationId: "op-2", outcome: "accepted", output: null, credential: "pswic_y" }],
        ["complete", "child-1", { operationId: "op-3", error: { code: "needs_input", message: "Which base?" } }],
    ]);
});

async function routeHarness(answer) {
    const { runtime, calls } = runtimeWith(answer);
    const requireAuth = (req, _res, next) => {
        req.auth = { principal: { provider: "dev", subject: String(req.headers["x-test-user"] || "alice") },
            authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] } };
        next();
    };
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({ runtime, requireAuth }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    return { calls, origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

const refusal = (code, status, message, extra = {}) => Object.assign(new Error(message), { code, status, ...extra });

test("over HTTP: the receipt, the credential refusals with their status and safe details, the inactive 501, through both clients", async () => {
    const h = await routeHarness(async (kind, input) => {
        if (!input.credential) throw refusal("CREDENTIAL_REQUIRED", 403, "This action needs a workflow invocation credential; a person's sign-in alone does not grant it.",
            { exposeDetails: true });
        if (input.credential === "pswic_revoked") throw refusal("CREDENTIAL_REVOKED", 403, "The workflow invocation credential was revoked.",
            { details: { reason: "rotated" }, exposeDetails: true });
        if (input.credential === "pswic_off") throw refusal("WORKFLOW_CREDENTIALS_UNAVAILABLE", 501, "This deployment does not take workflow invocation credentials yet.",
            { expose: true });
        return kind === "respond" ? { replayed: false, status: "responded" } : { replayed: false, outcome: "accepted" };
    });
    try {
        const post = async (path, payload) => {
            const response = await fetch(`${h.origin}/api/v1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
            return { status: response.status, body: await response.json() };
        };
        const answered = await post("/session-requests/nx-9/responses", { operationId: "op-1", decline: { reason: "not now" }, credential: "pswic_a" });
        assert.deepEqual([answered.status, answered.body], [200, { ok: true, result: { replayed: false, status: "responded" } }]);
        assert.deepEqual(h.calls[0], ["respond", "nx-9", { operationId: "op-1", decline: { reason: "not now" }, credential: "pswic_a" }]);

        const bare = await post("/sessions/child-1/workflow-node/result", { operationId: "op-2", outcome: "accepted", output: { verdict: "ok" } });
        assert.deepEqual([bare.status, bare.body.error.code], [403, "CREDENTIAL_REQUIRED"]);
        assert.match(bare.body.error.message, /sign-in alone/);
        const revoked = await post("/sessions/child-1/workflow-node/result", { operationId: "op-2", outcome: "accepted", credential: "pswic_revoked" });
        assert.deepEqual([revoked.status, revoked.body.error], [403, { code: "CREDENTIAL_REVOKED", message: "The workflow invocation credential was revoked.",
            details: { reason: "rotated" } }]);
        const off = await post("/session-requests/nx-9/responses", { operationId: "op-3", response: {}, credential: "pswic_off" });
        assert.deepEqual([off.status, off.body.error], [501, { code: "WORKFLOW_CREDENTIALS_UNAVAILABLE", message: "This deployment does not take workflow invocation credentials yet." }]);

        const api = new ApiClient({ apiUrl: h.origin, fetchImpl: (url, init = {}) => fetch(url, init) });
        const transport = new HttpApiTransport({ api });
        assert.deepEqual(await transport.completeWorkflowNode("child-1", { operationId: "op-4", outcome: "accepted", output: { verdict: "ok" }, credential: "pswic_b" }),
            { replayed: false, outcome: "accepted" });
        const web = new WebPilotSwarmManagementClient({ api });
        await assert.rejects(web.respondToSessionRequest("nx-9", { operationId: "op-5", response: { approved: true }, credential: "pswic_revoked" }),
            (error) => error.code === "CREDENTIAL_REVOKED" && error.status === 403 && error.details?.reason === "rotated");
        assert.deepEqual(h.calls.slice(-2), [
            ["complete", "child-1", { operationId: "op-4", outcome: "accepted", output: { verdict: "ok" }, credential: "pswic_b" }],
            ["respond", "nx-9", { operationId: "op-5", response: { approved: true }, credential: "pswic_revoked" }],
        ]);
    } finally {
        await h.close();
    }
});
