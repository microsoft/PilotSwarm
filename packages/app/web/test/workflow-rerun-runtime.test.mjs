/**
 * Phase 3 I7 Task 8a: re-run from a step over the Web API, the SDK web client and the TUI transports:
 * - GET .../workflow?rerunPlan=<json> reaches the read with the signed-in caller (OQ1/OQ5 are decided for that caller), and
 *   a shared reader reads only the revision's fit (OQ2);
 * - POST .../workflow-definitions/start forwards rerunFrom and Boolean(viaMcp); each re-run refusal keeps its HTTP status;
 * - /bootstrap advertises workflows.rerun, and WebPilotSwarmManagementClient (its methods and its generated ops) and
 *   HttpApiTransport fail closed without it (M1, review H1);
 * - a shared reader's plan is chosen field by field from the real plan: nothing a supply preview or a changed reused step
 *   decides (review H2);
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
import { WorkflowStoreError, nodeExecutionIdFor } from "../../../sdk/dist/workflow/store.js";
import { workflowCapabilities } from "../../../sdk/dist/workflow/human-commands.js";
import { compileWorkflow } from "../../../sdk/dist/workflow/compiler.js";
import { WORKFLOW_CONTROLLER_VERSION } from "../../../sdk/dist/workflow/controller-version.js";
import {
    buildRerunPlan, buildRerunWarnings, checkRerunCompatibility, partitionRerunVisits, pickRerunTarget,
} from "../../../sdk/dist/workflow/rerun.js";

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
        // A server that takes re-runs advertises it: HttpApiTransport sends a re-run only after reading workflows.rerun (M1).
        getWorkflowCapabilities: async () => workflowCapabilities({ read: true, commands: {} }),
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
    const api = (subject) => new ApiClient({ apiUrl: origin,
        fetchImpl: (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, "x-test-user": subject } }) });
    const transport = (subject) => new HttpApiTransport({ api: api(subject) });
    return { api, transport, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the Web SDK and HTTP route preserve the decision plan, outcome-only Start and refusals", async () => {
    const { runtime } = harness();
    const supplyContract = { outcomes: ["engineering", "uncertain"], outcomeOnly: true, resolvedOutputSchema: null };
    runtime.transport.readWorkflow = async (_id, { rerunPlan }) => {
        assert.deepEqual(rerunPlan, { executionId: "nx-2", mode: "supply", outcome: "engineering" });
        return { rerunPlan: { ...PLAN, supplyContract } };
    };
    const rerunFrom = { workflowId: "wf-2", executionId: "nx-2", mode: "supply",
        result: { outcome: "engineering" }, note: "Engineering confirmed ownership." };
    runtime.transport.startSessionWorkflowDefinition = async (_id, req) => {
        assert.deepEqual(req.rerunFrom, rerunFrom);
        if (req.operationId !== "op-ok") {
            throw PilotSwarmManagementClient.prototype._definitionFailure.call({},
                new WorkflowStoreError(req.operationId, "Decision supply refused."));
        }
        return { workflowId: "wf-3" };
    };
    const served = await serve(runtime);
    try {
        const client = new WebPilotSwarmManagementClient({ api: served.api("alice") });
        const plan = await client.readWorkflow("wf-2", { rerunPlan: { executionId: "nx-2", mode: "supply", outcome: "engineering" } });
        assert.deepEqual(plan.rerunPlan.supplyContract, supplyContract);
        const start = operationId => client.startSessionWorkflowDefinition("owner-1", { definitionId: "def-1", operationId, rerunFrom });
        assert.deepEqual(await start("op-ok"), { workflowId: "wf-3" });
        for (const code of ["RERUN_SUPPLIED_RESULT_INVALID", "RERUN_SUPPLY_NOT_ALLOWED"]) {
            await assert.rejects(start(code), error => error.code === code && error.status === 422);
        }
    } finally { await served.close(); }
});

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

/**
 * Review H2: real plans, made by the SDK's own planner as readWorkflowRerunPlan calls it, for a source that ran review (an agent
 * step with session: continue) and failed at provision, whose outcome retry goes back to review. Revision 2 changes review.
 */
const READER_YAML = (prompt) => `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: reader-plan, version: "1.0.0" }
limits: { maxNodeExecutions: 50 }
initial: review
states:
  review:
    type: agent
    session: continue
    invoke: { prompt: "${prompt}" }
    outcomes: [approved]
    timeoutSeconds: 120
    transition: { next: { approved: provision } }
  provision:
    type: script
    outcomes: [ok, retry]
    source: 'await setResult("ok", {});'
    transition: { next: { ok: done, retry: review } }
  done: { type: terminal, outcome: succeeded }
`;

function realPlanRead({ mode, outcome = null, revision = 1 }) {
    const compiled = (prompt) => {
        const result = compileWorkflow(READER_YAML(prompt));
        assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
        return result.ir;
    };
    const sourceIr = compiled("Review the change.");
    const targetIr = revision === 1 ? sourceIr : compiled("Review the change and its tests.");
    const visit = (nodeId, nodeType, fields) => ({
        nodeExecutionId: nodeExecutionIdFor("run-src", "root", nodeId, 1), runId: "run-src", scopeId: "root", nodeId, ordinal: 1, nodeType,
        predecessorId: null, arrivalRoute: null, state: "completed", outcome: "ok", resultKind: "business", winner: "effect", kvRevision: 1,
        enteredAt: new Date("2026-11-26T10:00:00Z"), completedAt: new Date("2026-11-26T10:01:00Z"), inputSha256: `in-${nodeId}`, carrySha256: null,
        hasCarry: false, carryByteLength: 0, byteLength: 1024, reusedFromExecutionId: null, reusedFromRunId: null, reusedFromWorkflowSessionId: null,
        suppliedFromExecutionId: null, suppliedFromRunId: null, suppliedFromWorkflowSessionId: null, suppliedNote: null, spawnChildWorkflowId: null,
        spawnChildCancelledBySourceEnd: false, spawnChildHasNotice: true, ...fields,
    });
    const review = visit("review", "agent", { outcome: "approved" });
    const provision = visit("provision", "script", { predecessorId: review.nodeExecutionId, arrivalRoute: "approved", outcome: "execution_failed",
        resultKind: "runtime_error", enteredAt: new Date("2026-11-26T10:02:00Z"), completedAt: new Date("2026-11-26T10:03:00Z") });
    const keys = [review, provision];
    const run = { status: "failed", terminalNodeId: null, terminalOutcome: null,
        terminalError: { code: "execution_failed", details: { nodeExecutionId: provision.nodeExecutionId } } };
    const picked = pickRerunTarget(run, keys, { executionId: provision.nodeExecutionId, mode, sourceIr, targetIr });
    const part = partitionRerunVisits(keys, picked.chosen.nodeExecutionId, picked.mode);
    const fit = checkRerunCompatibility({ sourceIr, targetIr, reused: part.reused, reusedTop: part.reusedTop, chosen: picked.chosen, mode: picked.mode,
        sourceControllerVersion: WORKFLOW_CONTROLLER_VERSION, suppliedOutcome: null });
    const dropped = part.dropped.map((item) => ({ ...item, outputPreview: null }));
    const supplyOutcome = picked.mode === "supply" ? outcome : null;
    const warnings = buildRerunWarnings({ sourceNumber: null, targetIr, reused: part.reused, dropped, chosen: picked.chosen, mode: picked.mode,
        suppliedOutcome: supplyOutcome, changedReusedSteps: fit.changedReusedSteps, deliveredOutboxExecIds: new Set(), droppedSpawnChildren: new Map(),
        reusedSpawnNoticeChildIds: new Set(), droppedConsumedUncarriedExecIds: new Set(), reusedApprovals: [], droppedApprovals: [] });
    const plan = buildRerunPlan({
        source: { workflowId: "wf-2", runId: "run-src", revision: 1, status: "failed", number: null },
        chosen: picked.chosen, picked: picked.picked, mode: picked.mode, modesAvailable: picked.modesAvailable,
        revision: { target: revision, newestValid: 2, newestValidFits: true, newestValidProblem: null, fits: fit.fits, problems: fit.problems,
            changedReusedSteps: fit.changedReusedSteps },
        reused: part.reused, reusedRequests: [], dropped, sourceIr, targetIr, supplyOutcome, carried: { count: 1, contracts: ["Note@1"] }, warnings,
        allowed: true, blockedReason: null, grantSource: "none",
    });
    return JSON.parse(JSON.stringify({ workflowId: "wf-2", rerunPlan: { ...plan, reused: { ...plan.reused, approvals: [] } } }));
}

test("a shared reader's plan shows nothing a supply preview or a changed reused step decides; the owner's keeps them (OQ2, review H2)", async () => {
    const { runtime } = harness();
    runtime.transport.readWorkflow = async (_sessionId, options) => realPlanRead(options.rerunPlan);
    const read = async (subject, rerunPlan) => (await runtime.call("readWorkflow", { sessionId: "wf-2", rerunPlan },
        { principal: { provider: "dev", subject }, authorization: { role: "user" } })).rerunPlan;

    // (a) supply: retry is valid and goes back to review; nope is not declared. The owner's previews differ.
    const ownerValid = await read("alice", { mode: "supply", outcome: "retry" });
    const ownerInvalid = await read("alice", { mode: "supply", outcome: "nope" });
    assert.equal(ownerValid.supply.valid, true);
    assert.deepEqual(ownerValid.runs.first, { stateId: "review", visit: 2 });
    assert.ok(ownerValid.warnings.some((warning) => warning.code === "agent_memory"), "the valid outcome's route reaches review again");
    assert.ok(ownerValid.supplyContract && ownerValid.carried && ownerValid.grantSource, "the owner's preview is whole");
    assert.equal(ownerInvalid.supply.valid, false);
    assert.equal(ownerInvalid.runs.first, null);
    assert.equal(ownerInvalid.warnings.some((warning) => warning.code === "agent_memory"), false);
    // The reader's two plans are the same, apart from its own outcome echoed back.
    const readerValid = await read("bob", { mode: "supply", outcome: "retry" });
    const readerInvalid = await read("bob", { mode: "supply", outcome: "nope" });
    const echo = (plan, outcome) => JSON.parse(JSON.stringify(plan).replaceAll(`'${outcome}'`, "'<outcome>'"));
    assert.deepEqual(echo(readerValid, "retry"), echo(readerInvalid, "nope"));
    assert.equal(readerValid.runs.first, null);
    for (const key of ["supplyContract", "supply", "carried", "grantSource"]) assert.equal(key in readerValid, false, key);
    assert.deepEqual(readerValid.revision, { target: 1, source: 1, fits: true });
    assert.equal(readerValid.allowed, false);
    assert.equal(readerValid.blockedReason, "Only the owner or an admin can start a Workflow.");

    // (b) Revision 2 changed review, a reused step: the owner reads which; the reader reads only the fit.
    const ownerChanged = await read("alice", { mode: "run_again", revision: 2 });
    assert.deepEqual(ownerChanged.revision.changedReusedSteps, [{ stateId: "review", visits: 1 }]);
    assert.ok(ownerChanged.warnings.some((warning) => warning.code === "changed_reused_step"));
    const readerChanged = await read("bob", { mode: "run_again", revision: 2 });
    const readerSame = await read("bob", { mode: "run_again" });
    assert.equal(readerChanged.warnings.some((warning) => warning.code === "changed_reused_step"), false);
    assert.deepEqual(readerChanged.revision, { target: 2, source: 1, fits: true });
    assert.deepEqual({ ...readerChanged, revision: { ...readerChanged.revision, target: 1 } }, readerSame,
        "only the target tells revision 2 apart");
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

test("the web client's generated ops and HttpApiTransport fail closed the same way: no re-run is sent without workflows.rerun (M1, review H1)", async () => {
    const newer = workflowCapabilities({ read: true, commands: {} });
    const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    // A portal on the wire: /bootstrap answers as given ("down": it cannot be read); every other request is recorded.
    const portal = (bootstrap) => {
        const sent = [];
        const api = new ApiClient({ apiUrl: "http://portal.test", fetchImpl: async (url, init = {}) => {
            const { pathname, searchParams } = new URL(String(url));
            if (pathname === "/api/v1/bootstrap") {
                return bootstrap === "down" ? json(502, { ok: false, error: { code: "BAD_GATEWAY", message: "down" } }) : json(200, bootstrap);
            }
            sent.push([init.method ?? "GET", pathname, init.body ? JSON.parse(init.body) : Object.fromEntries(searchParams)]);
            return json(200, { ok: true, result: {} });
        } });
        return { sent, client: new WebPilotSwarmManagementClient({ api }), transport: new HttpApiTransport({ api }) };
    };
    const rerunCalls = ({ client, transport }) => [
        () => client.ops.startSessionWorkflowDefinition({ sessionId: "owner-1", definitionId: "def-1", rerunFrom: { workflowId: "wf-2" }, operationId: "op-1" }),
        () => client.ops.readWorkflow({ sessionId: "wf-2", rerunPlan: { mode: "continue" } }),
        () => transport.startSessionWorkflowDefinition("owner-1", { definitionId: "def-1", rerunFrom: { workflowId: "wf-2" }, operationId: "op-2" }),
        () => transport.readWorkflow("wf-2", { rerunPlan: { mode: "continue" } }),
    ];
    for (const [label, bootstrap] of [
        ["no workflows", { ok: true }],
        ["workflows without rerun", { ok: true, workflows: { ...newer, rerun: undefined } }],
        ["rerun false", { ok: true, workflows: { ...newer, rerun: false } }],
        ["rerun not true", { ok: true, workflows: { ...newer, rerun: "yes" } }],
        ["bootstrap failed", "down"],
    ]) {
        const wire = portal(bootstrap);
        for (const [index, send] of rerunCalls(wire).entries()) {
            await assert.rejects(send(), (error) => error.code === "WORKFLOW_API_UNAVAILABLE" && error.status === 501
                && /workflows\.rerun is not advertised/.test(error.message), `${label}: call ${index}`);
        }
        assert.deepEqual(wire.sent, [], `${label}: nothing is sent`);
        // A start or read without re-run is not gated.
        await wire.client.ops.startSessionWorkflowDefinition({ sessionId: "owner-1", definitionId: "def-1", operationId: "op-3" });
        await wire.client.ops.readWorkflow({ sessionId: "wf-2" });
        await wire.transport.startSessionWorkflowDefinition("owner-1", { definitionId: "def-1", operationId: "op-4" });
        await wire.transport.readWorkflow("wf-2", {});
        assert.deepEqual(wire.sent.map(([method, path]) => `${method} ${path}`), [
            "POST /api/v1/sessions/owner-1/workflow-definitions/start", "GET /api/v1/sessions/wf-2/workflow",
            "POST /api/v1/sessions/owner-1/workflow-definitions/start", "GET /api/v1/sessions/wf-2/workflow",
        ], label);
    }
    // A portal that advertises workflows.rerun gets each re-run as it was given.
    const wire = portal({ ok: true, workflows: newer });
    for (const send of rerunCalls(wire)) await send();
    assert.deepEqual(wire.sent, [
        ["POST", "/api/v1/sessions/owner-1/workflow-definitions/start", { definitionId: "def-1", rerunFrom: { workflowId: "wf-2" }, operationId: "op-1" }],
        ["GET", "/api/v1/sessions/wf-2/workflow", { rerunPlan: JSON.stringify({ mode: "continue" }) }],
        ["POST", "/api/v1/sessions/owner-1/workflow-definitions/start", { definitionId: "def-1", rerunFrom: { workflowId: "wf-2" }, operationId: "op-2" }],
        ["GET", "/api/v1/sessions/wf-2/workflow", { rerunPlan: JSON.stringify({ mode: "continue" }) }],
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
        // The server takes re-runs (M1): its bootstrap advertises workflows.rerun.
        const result = new URL(String(url)).pathname === "/api/v1/bootstrap" ? { workflows: { rerun: true } } : {};
        return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
    } }) });
    await wire.readWorkflow("wf-2", { rerunPlan: { executionId: "nx-2", outcome: "ok" } });
    const read = new URL(requests.at(-1).url);
    assert.equal(read.pathname, "/api/v1/sessions/wf-2/workflow");
    assert.deepEqual(JSON.parse(read.searchParams.get("rerunPlan")), { executionId: "nx-2", outcome: "ok" });
    await wire.startSessionWorkflowDefinition("owner-1", { definitionId: "def-1", rerunFrom: { workflowId: "wf-2", mode: "continue" }, viaMcp: true, operationId: "op-2" });
    assert.equal(requests.at(-1).method, "POST");
    assert.deepEqual(requests.at(-1).body, { definitionId: "def-1", rerunFrom: { workflowId: "wf-2", mode: "continue" }, viaMcp: true, operationId: "op-2" });
});
