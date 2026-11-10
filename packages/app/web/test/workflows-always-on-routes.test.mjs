/**
 * Workflows are always on (owner 2026-11-08T08:03Z): the portal's side, over the real router and runtime.
 * - The bootstrap's `workflows` says `enabled: true` with the version 2 fields, a workflow's read reaches the store, and a
 *   person's command gets the deployment's own answer, never WORKFLOWS_DISABLED.
 * - POST /sessions/workflow is no route: 404 NOT_FOUND, and nothing is created.
 *
 * Run: node --test web/test/workflows-always-on-routes.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { NodeSdkTransport } from "pilotswarm/host";
import { PilotSwarmManagementClient } from "pilotswarm-sdk";

import { createApiRouter } from "../api/router.js";
import { PortalRuntime } from "../runtime.js";

/**
 * The real router and runtime over a transport whose workflow calls are the real management client methods on a stand-in
 * (a workflow "wf1" of alice's). `reads` counts every catalog read; `created` every create that reached the transport.
 */
async function harness() {
    const counts = { reads: 0, created: 0 };
    const mgmt = {
        _ensureStarted() {},
        _started: true,
        // As every management client is now configured (its default): a person's commands, on the full engine.
        config: { workflowCommands: {} },
        _catalog: {
            workflowStore: () => { counts.reads += 1; return { readDefinition: async () => ({ parentSessionId: "p1" }), readWorkflowLineage: async () => null }; },
            getSession: async (sessionId) => { counts.reads += 1; return { sessionId, sessionKind: "workflow", deletedAt: null }; },
        },
        // The real methods (and the bodies they wrap).
        getWorkflowCapabilities() { return PilotSwarmManagementClient.prototype.getWorkflowCapabilities.call(this); },
        _readWorkflow(...args) { return PilotSwarmManagementClient.prototype._readWorkflow.apply(this, args); },
        _updateWorkflow(...args) { return PilotSwarmManagementClient.prototype._updateWorkflow.apply(this, args); },
    };
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    const owner = { provider: "dev", subject: "alice" };
    runtime.transport = {
        getWorkflowCapabilities: (...args) => NodeSdkTransport.prototype.getWorkflowCapabilities.apply({ mgmt }, [...args]),
        getSessionAccess: async (sessionId, viewer) => ({ rootSessionId: sessionId, isSystem: false, visibility: "private", owner: { ...owner, displayName: "Alice" },
            viewerIsOwner: viewer.provider === owner.provider && viewer.subject === owner.subject, viewerShareAccess: null }),
        recordAuthzAudit: async () => {},
        readWorkflow: (sessionId, options) => PilotSwarmManagementClient.prototype.readWorkflow.call(mgmt, sessionId, options),
        updateWorkflow: (sessionId, command, options) => PilotSwarmManagementClient.prototype.updateWorkflow.call(mgmt, sessionId, command, options),
        createWorkflowSession: async () => { counts.created += 1; return { sessionId: "new", workflowName: "x" }; },
    };
    const requireAuth = (req, _res, next) => {
        req.auth = { principal: { provider: "dev", subject: "alice" }, authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] } };
        next();
    };
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({ runtime, requireAuth }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const call = async (path, init = {}) => {
        const response = await fetch(`${origin}/api/v1${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
        return { status: response.status, body: await response.json() };
    };
    return { mgmt, counts, call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("always on: the bootstrap says enabled with the version 2 fields; a read reaches the store; a command is never WORKFLOWS_DISABLED; there is no create route", async () => {
    const h = await harness();
    try {
        const boot = await h.call("/bootstrap");
        assert.equal(boot.status, 200);
        assert.equal(boot.body.workflows.enabled, true);
        assert.equal(boot.body.workflows.read, true);
        const read = await h.call("/sessions/wf1/workflow");
        assert.notEqual(read.body?.error?.code, "WORKFLOWS_DISABLED");
        assert.ok(h.counts.reads > 0, "the read reached the catalog");
        const command = await h.call("/sessions/wf1/workflow/commands", { method: "POST",
            body: JSON.stringify({ command: { operation: "pause", operation_id: "op-1" } }) });
        // Every deployment takes a person's commands (owner decision 2026-11-08T15:30Z): the stand-in store has no run,
        // so the command is refused by the store, never as unavailable or disabled.
        assert.ok(!["WORKFLOW_COMMANDS_UNAVAILABLE", "WORKFLOWS_DISABLED"].includes(command.body?.error?.code), JSON.stringify(command.body));
        // There is no create route: it is an unknown route.
        const create = await h.call("/sessions/workflow", { method: "POST", body: JSON.stringify({ yaml: "kind: Workflow\n" }) });
        assert.equal(create.status, 404);
        assert.equal(create.body.error.code, "NOT_FOUND");
        assert.equal(h.counts.created, 0, "nothing was created");
    } finally {
        await h.close();
    }
});
