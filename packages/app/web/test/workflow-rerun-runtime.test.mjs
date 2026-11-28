/**
 * Phase 3 I7 Task 8a: re-run from a step over the Web API, the SDK web client and the TUI transports:
 * - GET .../workflow?rerunPlan=<json> reaches the read with the signed-in caller (OQ1/OQ5 are decided for that caller), and
 *   a shared reader reads only the revision's fit (OQ2);
 * - POST .../workflow-definitions/start forwards rerunFrom and Boolean(viaMcp); each re-run refusal keeps its HTTP status;
 * - /bootstrap advertises workflows.rerun, and WebPilotSwarmManagementClient fails closed without it (M1);
 * - NodeSdkTransport and HttpApiTransport forward rerunFrom and rerunPlan.
 * The re-run behaviour itself is proven against PG16 (packages/sdk/test/local/workflow-rerun-read.test.js).
 *
 * Run: node --test web/test/workflow-rerun-runtime.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { NodeSdkTransport } from "pilotswarm/host";
import { PilotSwarmManagementClient, WebPilotSwarmManagementClient } from "pilotswarm-sdk";
import { ApiClient, HttpApiTransport } from "pilotswarm-sdk/api";
import { WorkflowStoreError } from "../../../sdk/dist/workflow/store.js";
import { workflowCapabilities } from "../../../sdk/dist/workflow/human-commands.js";

import { createApiRouter } from "../api/router.js";
import { PortalRuntime } from "../runtime.js";

const owner = { provider: "dev", subject: "alice" };

/** A re-run plan as the management client answers it for its owner. */
const PLAN = {
    of: { workflowId: "wf-2", runId: "run-2", revision: 3, status: "failed", number: null },
    from: { executionId: "nx-2", stateId: "provision", visit: 1, picked: "requested" },
    mode: "supply", modesAvailable: ["run_again", "supply"],
    supplyContract: { outcomes: ["ok"], outputSchemaName: "Out", resolvedOutputSchema: { type: "object" }, maxOutputBytes: 262144,
        nextByOutcome: { ok: { stateId: "done", visit: 1 } } },
    supply: { outcome: "ok", valid: true, next: { stateId: "done", visit: 1 }, problems: [] },
    revision: { target: 3, source: 3, newestValid: 4, newestValidFits: false,
        newestValidProblem: { code: "step_missing", stateId: "provision", visit: 1, message: "secret-step-words" },
        fits: true, problems: [], changedReusedSteps: [] },
    reused: { visits: 1, bytes: 10, steps: [{ stateId: "setup", visits: 1 }], requests: [], approvals: [] },
    carried: { count: 2, contracts: ["Note@1"] },
    runs: { first: { stateId: "done", visit: 1 } }, dropped: [], warnings: [],
    allowed: true, blockedReason: null, grantSource: "inherited",
};

function harness() {
    const calls = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce: true };
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => ({
            rootSessionId: sessionId, isSystem: false, visibility: "shared_read", owner: { ...owner, displayName: "Alice" },
            viewerIsOwner: viewer.provider === owner.provider && viewer.subject === owner.subject, viewerShareAccess: null,
        }),
        recordAuthzAudit: async () => {},
        readWorkflow: async (...args) => { calls.push(["read", ...args]); return { workflowId: args[0], rerunPlan: structuredClone(PLAN) }; },
        startSessionWorkflowDefinition: async (...args) => { calls.push(["start", ...args]); return { operation: "start", workflowId: "wf-3" }; },
    };
    return { runtime, calls };
}

async function serve(runtime) {
    const requireAuth = (req, _res, next) => {
        const subject = String(req.headers["x-test-user"] || "alice");
        req.auth = { principal: { provider: "dev", subject, displayName: subject === "alice" ? "Alice" : null },
            authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] } };
        next();
    };
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({ runtime, requireAuth }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const transport = (subject) => new HttpApiTransport({ api: new ApiClient({ apiUrl: origin,
        fetchImpl: (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, "x-test-user": subject } }) }) });
    return { transport, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("GET ?rerunPlan= reads the plan for the signed-in caller (outcome only, viaMcp kept); a shared reader reads only the revision's fit (OQ2)", async () => {
    const { runtime, calls } = harness();
    const served = await serve(runtime);
    try {
        const rerunPlan = { executionId: "nx-2", mode: "supply", outcome: "ok", viaMcp: true };
        const owned = await served.transport("alice").readWorkflow("wf-2", { rerunPlan });
        assert.deepEqual(owned, { workflowId: "wf-2", rerunPlan: PLAN });
        assert.deepEqual(calls.at(-1), ["read", "wf-2", { rerunPlan }, { principal: { provider: "dev", subject: "alice", displayName: "Alice" } }]);

        for (const read of [await served.transport("bob").readWorkflow("wf-2", { rerunPlan: {} }),
            await runtime.call("readWorkflow", { sessionId: "wf-2", rerunPlan: {} }, { principal: { provider: "dev", subject: "bob" }, authorization: { role: "user" } })]) {
            const plan = read.rerunPlan;
            assert.deepEqual(plan.revision, { target: 3, source: 3, fits: true });
            assert.equal(plan.allowed, false);
            assert.equal(plan.blockedReason, "Only the owner or an admin can start a Workflow.");
            for (const key of ["supplyContract", "supply", "carried"]) assert.equal(key in plan, false, key);
            assert.equal(JSON.stringify(read).includes("secret-step-words"), false);
            assert.equal("ownerOnlyArtifacts" in read, false);
        }
        assert.deepEqual(calls.at(-1).slice(3), [{ principal: { provider: "dev", subject: "bob", displayName: null } }]);
    } finally {
        await served.close();
    }
});

test("POST start forwards rerunFrom and Boolean(viaMcp) with the signed-in caller; a start without rerunFrom is sent as before", async () => {
    const { runtime, calls } = harness();
    const served = await serve(runtime);
    try {
        const alice = served.transport("alice");
        const rerunFrom = { workflowId: "wf-2", executionId: "nx-2", mode: "supply", result: { outcome: "ok", output: { fqdn: "a.db" } }, note: "checked" };
        await alice.startSessionWorkflowDefinition("owner-1", { definitionId: "def-1", rerunFrom, viaMcp: true, operationId: "op-1" });
        const [, sessionId, request, options] = calls.at(-1);
        assert.equal(sessionId, "owner-1");
        assert.deepEqual(request.rerunFrom, rerunFrom);
        assert.equal(request.viaMcp, true);
        assert.equal(Object.hasOwn(request, "workspace"), false);
        assert.deepEqual(options, { principal: { provider: "dev", subject: "alice" } });
        await alice.startSessionWorkflowDefinition("owner-1", { definitionId: "def-1", rerunFrom: { workflowId: "wf-2" }, viaMcp: "yes", operationId: "op-2" });
        assert.equal(calls.at(-1)[2].viaMcp, true);
        await alice.startSessionWorkflowDefinition("owner-1", { definitionId: "def-1", rerunFrom: { workflowId: "wf-2" }, operationId: "op-3" });
        assert.equal(calls.at(-1)[2].viaMcp, false);
        await alice.startSessionWorkflowDefinition("owner-1", { definitionId: "def-1", viaMcp: true, operationId: "op-4" });
        for (const key of ["rerunFrom", "viaMcp"]) assert.equal(Object.hasOwn(calls.at(-1)[2], key), false, key);
    } finally {
        await served.close();
    }
});

test("every re-run refusal of a person's Start keeps its HTTP status and its details over the route", async () => {
    const { runtime } = harness();
    const served = await serve(runtime);
    const expected = [["RERUN_ARGUMENT_REFUSED", 400], ["RERUN_VISIT_REQUIRED", 400], ["RERUN_APPROVAL_REUSED", 403], ["WORKFLOW_DELETED", 404],
        ["RERUN_VISIT_NOT_FOUND", 404], ["RERUN_SOURCE_ACTIVE", 409], ["RERUN_SOURCE_GONE", 409], ["WORKFLOW_TOOLS_UNAVAILABLE", 409],
        ["RERUN_INCOMPATIBLE", 422], ["RERUN_VISIT_NOT_ALLOWED", 422], ["RERUN_SUPPLY_NOT_ALLOWED", 422], ["RERUN_SUPPLIED_RESULT_INVALID", 422],
        ["RERUN_NOT_A_WORKFLOW", 422], ["RERUN_TOO_LARGE", 422]];
    try {
        for (const [code, status] of expected) {
            const details = { problems: [{ code: "route_changed", stateId: "a", visit: 1, message: "m" }] };
            // The management client's own failure for a refused Start.
            runtime.transport.startSessionWorkflowDefinition = async () => {
                throw PilotSwarmManagementClient.prototype._definitionFailure.call({}, new WorkflowStoreError(code, `refused ${code}`, details));
            };
            await assert.rejects(served.transport("alice").startSessionWorkflowDefinition("owner-1",
                { definitionId: "def-1", rerunFrom: { workflowId: "wf-2" }, operationId: `op-${code}` }), (error) => {
                assert.equal(error.code, code);
                assert.equal(error.status, status, code);
                assert.deepEqual(error.details, details, code);
                return true;
            });
        }
    } finally {
        await served.close();
    }
});

test("bootstrap advertises workflows.rerun; the web client fails closed (501, nothing sent) on a server without it (M1)", async () => {
    assert.equal(workflowCapabilities({ read: true, commands: null }).rerun, true);
    const newer = workflowCapabilities({ read: true, commands: {} });
    for (const [label, getBootstrap] of [
        ["no workflows", async () => ({ ok: true })],
        ["workflows without rerun", async () => ({ ok: true, workflows: { ...newer, rerun: undefined } })],
        ["rerun not true", async () => ({ ok: true, workflows: { ...newer, rerun: "yes" } })],
        ["bootstrap failed", async () => { throw Object.assign(new Error("down"), { status: 502 }); }],
    ]) {
        const sent = [];
        const client = new WebPilotSwarmManagementClient({ api: { getBootstrap, call: async (...args) => { sent.push(args); return {}; } } });
        for (const send of [
            () => client.startSessionWorkflowDefinition("owner-1", { definitionId: "def-1", rerunFrom: { workflowId: "wf-2" }, operationId: "op-1" }),
            () => client.readWorkflow("wf-2", { rerunPlan: { mode: "continue" } }),
        ]) {
            await assert.rejects(send(), (error) => error.code === "WORKFLOW_API_UNAVAILABLE" && error.status === 501
                && /workflows\.rerun is not advertised/.test(error.message), label);
        }
        assert.deepEqual(sent, [], label);
        // A start or read without re-run is not gated.
        await client.startSessionWorkflowDefinition("owner-1", { definitionId: "def-1", operationId: "op-2" });
        await client.readWorkflow("wf-2", {});
        assert.equal(sent.length, 2, label);
    }
    const sent = [];
    const client = new WebPilotSwarmManagementClient({ api: { getBootstrap: async () => ({ ok: true, workflows: newer }),
        call: async (...args) => { sent.push(args); return {}; } } });
    await client.startSessionWorkflowDefinition("owner-1", { definitionId: "def-1", rerunFrom: { workflowId: "wf-2" }, viaMcp: true, operationId: "op-3" });
    await client.readWorkflow("wf-2", { rerunPlan: { outcome: "ok", viaMcp: true } });
    assert.deepEqual(sent, [
        ["startSessionWorkflowDefinition", { sessionId: "owner-1", definitionId: "def-1", rerunFrom: { workflowId: "wf-2" }, viaMcp: true, operationId: "op-3" }],
        ["readWorkflow", { rerunPlan: { outcome: "ok", viaMcp: true }, sessionId: "wf-2" }],
    ]);
});

test("the TUI transports forward rerunFrom and rerunPlan: NodeSdkTransport with its user, HttpApiTransport on the wire", async () => {
    const calls = [];
    const mgmt = {
        readWorkflow: async (...args) => { calls.push(["read", ...args]); return {}; },
        startSessionWorkflowDefinition: async (...args) => { calls.push(["start", ...args]); return {}; },
    };
    const node = Object.assign(Object.create(NodeSdkTransport.prototype), { mgmt, currentUser: { provider: "dev", subject: "alice", displayName: "Alice" } });
    await node.readWorkflow("wf-2", { rerunPlan: { mode: "run_again" } });
    assert.deepEqual(calls.at(-1), ["read", "wf-2", { rerunPlan: { mode: "run_again" } }, { principal: { provider: "dev", subject: "alice", displayName: "Alice" } }]);
    await node.readWorkflow("wf-2", { rerunPlan: {} }, { principal: null });
    assert.deepEqual(calls.at(-1)[3], { principal: null });
    await node.readWorkflow("wf-2", { runId: "r" });
    assert.deepEqual(calls.at(-1), ["read", "wf-2", { runId: "r" }]);
    await node.startSessionWorkflowDefinition("owner-1", { definitionId: "def-1", rerunFrom: { workflowId: "wf-2" }, viaMcp: false, operationId: "op-1" });
    assert.deepEqual(calls.at(-1)[2], { definitionId: "def-1", rerunFrom: { workflowId: "wf-2" }, viaMcp: false, operationId: "op-1" });

    const requests = [];
    const wire = new HttpApiTransport({ api: new ApiClient({ apiUrl: "http://portal.test", fetchImpl: async (url, init = {}) => {
        requests.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
    } }) });
    await wire.readWorkflow("wf-2", { rerunPlan: { executionId: "nx-2", outcome: "ok" } });
    const read = new URL(requests.at(-1).url);
    assert.equal(read.pathname, "/api/v1/sessions/wf-2/workflow");
    assert.deepEqual(JSON.parse(read.searchParams.get("rerunPlan")), { executionId: "nx-2", outcome: "ok" });
    await wire.startSessionWorkflowDefinition("owner-1", { definitionId: "def-1", rerunFrom: { workflowId: "wf-2", mode: "continue" }, viaMcp: true, operationId: "op-2" });
    assert.equal(requests.at(-1).method, "POST");
    assert.deepEqual(requests.at(-1).body, { definitionId: "def-1", rerunFrom: { workflowId: "wf-2", mode: "continue" }, viaMcp: true, operationId: "op-2" });
});
