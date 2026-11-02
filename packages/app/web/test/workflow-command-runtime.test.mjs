/**
 * Workflow v2 updateWorkflow (POST /api/v1/sessions/:sessionId/workflow/commands;
 * design 04, R26, D11; INACTIVE unless the deployment enables it): one
 * protocol row, access session:manage. The portal runtime's session gate
 * decides first, with not-found privacy, and it is enforced even while the
 * ownership switch is off (a new capability, as session:share is); then the
 * transport runs the command with the signed-in caller as its principal,
 * never an actor taken from the request. Over HTTP, a refusal keeps its code
 * and status, its details when the adapter marks them safe to show, and the
 * message of the inactive 501; both HTTP-backed clients send the command in
 * the body and carry the details back.
 *
 * Run: node --test web/test/workflow-command-runtime.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { WebPilotSwarmManagementClient } from "pilotswarm-sdk";
import { ApiClient, HttpApiTransport } from "pilotswarm-sdk/api";

import { createApiRouter } from "../api/router.js";
import { PortalRuntime } from "../runtime.js";

test("updateWorkflow is one POST session:manage operation: the session in the path, the command in the body", async () => {
    const { OPERATIONS } = await import("../../../sdk/api/src/protocol.js");
    const op = OPERATIONS.find((entry) => entry.name === "updateWorkflow");
    assert.ok(op, "updateWorkflow is a protocol operation");
    assert.deepEqual({ access: op.access, method: op.method, path: op.path, params: op.params }, {
        access: "session:manage", method: "POST", path: "/sessions/:sessionId/workflow/commands",
        params: { sessionId: { in: "path", name: "sessionId" }, command: { in: "body" } },
    });
});

/** A runtime whose transport knows alice's private session s1, bob-shared session shared (shared_write), and missing (none). */
function runtimeWith({ enforce }) {
    const calls = [];
    const audits = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce };
    const owner = { provider: "dev", subject: "alice" };
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => (sessionId === "missing" ? null : {
            rootSessionId: sessionId,
            isSystem: false,
            visibility: sessionId === "shared" ? "shared_write" : "private",
            owner: { ...owner, displayName: "Alice" },
            viewerIsOwner: viewer.provider === owner.provider && viewer.subject === owner.subject,
            viewerShareAccess: null,
        }),
        recordAuthzAudit: async (entry) => { audits.push(entry); },
        updateWorkflow: async (sessionId, command, options) => {
            calls.push([sessionId, command, options]);
            return { workflowId: sessionId, operation: command?.operation ?? null };
        },
    };
    return { runtime, calls, audits };
}

const as = (subject, role = "user") => ({ principal: { provider: "dev", subject }, authorization: { role } });

for (const enforce of [true, false]) {
    test(`the session:manage gate decides first, owner or admin only, with not-found privacy (ownership switch ${enforce ? "on" : "off"})`, async () => {
        const { runtime, calls, audits } = runtimeWith({ enforce });
        const command = { operation: "pause", operation_id: "p-1", actor: { kind: "agent", sessionId: "s9" } };
        // The owner commands it; the transport gets the command as it is and the signed-in caller as the principal.
        assert.deepEqual(await runtime.call("updateWorkflow", { sessionId: "s1", command }, as("alice")), { workflowId: "s1", operation: "pause" });
        assert.deepEqual(calls, [["s1", command, { principal: { provider: "dev", subject: "alice" } }]]);
        // Someone who cannot see it, someone it is shared with for writing, and a session that does not exist: refused, even
        // with the switch off, and nothing reaches the transport.
        for (const [sessionId, subject] of [["s1", "bob"], ["shared", "bob"], ["missing", "alice"]]) {
            await assert.rejects(runtime.call("updateWorkflow", { sessionId, command }, as(subject)),
                (error) => (error.status === 404 && error.code === "NOT_FOUND") || (error.status === 403 && error.code === "FORBIDDEN"),
                `${sessionId} as ${subject}`);
        }
        assert.equal(calls.length, 1);
        assert.ok(audits.some((entry) => entry.action === "updateWorkflow" && entry.decision === "deny"));
        // An admin outside the owner's visibility commands it, audited as break-glass, as the admin.
        await runtime.call("updateWorkflow", { sessionId: "s1", command }, as("ada", "admin"));
        assert.deepEqual(calls.at(-1)[2], { principal: { provider: "dev", subject: "ada" } });
        assert.ok(audits.some((entry) => entry.action === "updateWorkflow" && entry.sessionId === "s1" && entry.decision === "break_glass"));
    });
}

/** The generated HTTP route over the real runtime gate, with a transport that answers or refuses as the adapter does. */
async function routeHarness(answer) {
    const owner = { provider: "dev", subject: "alice" };
    const calls = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce: false };
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => ({
            rootSessionId: sessionId, isSystem: false, visibility: "private", owner: { ...owner, displayName: "Alice" },
            viewerIsOwner: viewer.provider === owner.provider && viewer.subject === owner.subject, viewerShareAccess: null,
        }),
        recordAuthzAudit: async () => {},
        updateWorkflow: async (sessionId, command, options) => { calls.push([sessionId, command, options]); return answer(command); },
    };
    const requireAuth = (req, _res, next) => {
        const subject = String(req.headers["x-test-user"] || "alice");
        req.auth = { principal: { provider: "dev", subject }, authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] } };
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

test("over HTTP: the receipt, the refusals with their status and safe details, the inactive 501's message, through both clients", async () => {
    const h = await routeHarness((command) => {
        if (command.operation === "set_vars") {
            throw refusal("WORKFLOW_HUMAN_INPUT_DENIED", 403, "Session w runs a workflow state for workflow c: people cannot change its definition, inputs, runs or tests.",
                { details: { sessionId: "w", action: "workflow", controllingSessionId: "P" }, exposeDetails: true });
        }
        if (command.operation === "start") throw refusal("WORKFLOW_COMMANDS_UNAVAILABLE", 501, "This deployment does not take workflow commands from people yet.", { expose: true });
        if (command.operation === "publish") throw refusal("REVISION_CONFLICT", 409, "The definition is at revision 2, not 1.", { details: { currentRevision: 2 } });
        return { workflowId: "w", operation: command.operation, replayed: false };
    });
    try {
        const post = async (command, subject = "alice") => {
            const response = await fetch(`${h.origin}/api/v1/sessions/w/workflow/commands`, {
                method: "POST", headers: { "content-type": "application/json", "x-test-user": subject }, body: JSON.stringify({ command }),
            });
            return { status: response.status, body: await response.json() };
        };
        const ok = await post({ operation: "pause", operation_id: "p-1" });
        assert.equal(ok.status, 200);
        assert.deepEqual(ok.body, { ok: true, result: { workflowId: "w", operation: "pause", replayed: false } });
        assert.deepEqual(h.calls[0], ["w", { operation: "pause", operation_id: "p-1" }, { principal: { provider: "dev", subject: "alice" } }]);

        const denied = await post({ operation: "set_vars", operation_id: "k-1" });
        assert.equal(denied.status, 403);
        assert.deepEqual(denied.body.error, { code: "WORKFLOW_HUMAN_INPUT_DENIED", message: denied.body.error.message,
            details: { sessionId: "w", action: "workflow", controllingSessionId: "P" } });
        assert.match(denied.body.error.message, /people cannot change its definition/);
        // Details not marked safe to show stay on the server; an exposed 5xx keeps its message.
        const conflict = await post({ operation: "publish", operation_id: "x-1" });
        assert.deepEqual([conflict.status, conflict.body.error], [409, { code: "REVISION_CONFLICT", message: "The definition is at revision 2, not 1." }]);
        const inactive = await post({ operation: "start", operation_id: "s-1" });
        assert.deepEqual([inactive.status, inactive.body.error], [501, { code: "WORKFLOW_COMMANDS_UNAVAILABLE",
            message: "This deployment does not take workflow commands from people yet." }]);
        // Another user cannot command alice's workflow, even with the ownership switch off.
        const hidden = await post({ operation: "pause", operation_id: "p-2" }, "bob");
        assert.deepEqual([hidden.status, hidden.body.error.code], [404, "NOT_FOUND"]);
        assert.equal(h.calls.length, 4);

        // Both HTTP-backed clients send the command in the body and carry the refusal's details back.
        const api = new ApiClient({ apiUrl: h.origin, fetchImpl: (url, init = {}) =>
            fetch(url, { ...init, headers: { ...init.headers, "x-test-user": "alice" } }) });
        const transport = new HttpApiTransport({ api });
        assert.deepEqual(await transport.updateWorkflow("w", { operation: "resume", operation_id: "r-1" }), { workflowId: "w", operation: "resume", replayed: false });
        const web = new WebPilotSwarmManagementClient({ api });
        await assert.rejects(web.updateWorkflow("w", { operation: "set_vars", operation_id: "k-2" }), (error) => error.code === "WORKFLOW_HUMAN_INPUT_DENIED"
            && error.status === 403 && error.details?.controllingSessionId === "P");
        assert.deepEqual(h.calls.slice(-2).map(([sessionId, command]) => [sessionId, command.operation]), [["w", "resume"], ["w", "set_vars"]]);
    } finally {
        await h.close();
    }
});
