import test from "node:test";
import assert from "node:assert/strict";

import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import {
    COMPUTE_TARGET_PROBE_ACTIVITY,
    computeTargetProbeOrchestration,
    withoutComputeTargetConfig,
} from "../../dist/compute-target-probe.js";
import { registerComputeTargetTools } from "../../../app/mcp/dist/src/tools/compute-targets.js";
import { registerSessionTools } from "../../../app/mcp/dist/src/tools/sessions.js";

const principal = { provider: "test", subject: "user-1", email: "owner@example.com" };
const viewer = { principal, isAdmin: false };
const personalTarget = {
    id: "target-1",
    name: "owner@example.com/devbox",
    kind: "pool",
    class: "personal",
    ownerUserId: 4,
    displayName: null,
    config: { selector: "mine" },
    enabled: true,
    manageable: true,
    createdAt: null,
    updatedAt: null,
};

function managementClient({ target = personalTarget } = {}) {
    const calls = [];
    const store = {
        lookupUserId: async () => 4,
        list: async () => target ? [target] : [],
        create: async (input, actor, isAdmin) => {
            calls.push({ method: "create", input, actor, isAdmin });
            return { ...input, id: "new-target", ownerUserId: actor, enabled: true };
        },
        update: async (name, input, actor, isAdmin) => {
            calls.push({ method: "update", name, input, actor, isAdmin });
            return { ...target, ...input, name };
        },
        delete: async (name, actor, isAdmin) => {
            calls.push({ method: "delete", name, actor, isAdmin });
            return 0;
        },
        listTargetModels: async () => [],
    };
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._started = true;
    client._catalog = { computeTargets: store, recordAuthzAudit: async (audit) => calls.push({ method: "audit", audit }) };
    client._duroxideClient = {
        startOrchestration: async (id, name, input) => calls.push({ method: "startOrchestration", id, name, input }),
        waitForOrchestration: async () => ({
            status: "Completed",
            output: { ok: true, target: { id: target.id, name: target.name, kind: target.kind, class: target.class, ownerUserId: target.ownerUserId, displayName: null, config: {}, enabled: true } },
        }),
    };
    return { client, calls };
}

function recordingServer() {
    const tools = new Map();
    return {
        tools,
        server: {
            registerTool(name, _definition, handler) {
                tools.set(name, handler);
            },
        },
    };
}

test("target probes dispatch a durable worker activity using only target id and caller identity", async () => {
    const { client, calls } = managementClient();
    const result = await client.probeMyComputeTarget(viewer, "devbox");
    assert.equal(result.ok, true);

    const start = calls.find((call) => call.method === "startOrchestration");
    assert.equal(start.name, "compute-target-probe");
    assert.deepEqual(start.input, {
        targetId: personalTarget.id,
        principal: { provider: principal.provider, subject: principal.subject, email: principal.email },
    });
    assert.equal("config" in start.input, false);
    assert.ok(calls.some((call) => call.method === "audit" && call.audit.action === "probeComputeTarget"));
});

test("personal target creation assigns the signed-in owner namespace", async () => {
    const { client, calls } = managementClient({ target: null });
    const result = await client.createMyComputeTarget(viewer, { label: "workstation", kind: "pool" });
    assert.equal(result.target.name, "owner@example.com/workstation");
    assert.equal(calls[0].input.class, "personal");
    assert.equal(calls[0].actor, 4);
    assert.equal(calls[0].isAdmin, false);
    await assert.rejects(
        client.createMyComputeTarget(viewer, { name: "someone-else@example.com/workstation", kind: "pool" }),
        (error) => error.code === "COMPUTE_TARGET_FORBIDDEN",
    );
});

test("probe orchestration schedules the worker activity", () => {
    const input = { targetId: personalTarget.id, principal };
    const scheduled = [];
    const generator = computeTargetProbeOrchestration({
        scheduleActivity(name, activityInput) {
            scheduled.push({ name, input: activityInput });
            return "result";
        },
    }, input);
    assert.deepEqual(generator.next(), { value: "result", done: true });
    assert.deepEqual(scheduled, [{ name: COMPUTE_TARGET_PROBE_ACTIVITY, input }]);
});

test("probe activity results omit provider-owned target configuration", () => {
    const result = withoutComputeTargetConfig({ ok: true, target: personalTarget });
    assert.equal(result.ok, true);
    assert.equal("config" in result.target, false);
    assert.equal(result.target.name, personalTarget.name);
});

test("MCP compute-target tool exposes the management surface", async () => {
    const { server, tools } = recordingServer();
    const calls = [];
    const ctx = {
        admin: true,
        mgmt: {
            listComputeTargets: async (value) => { calls.push(["list", value]); return { targets: [] }; },
            listComputeTargetModels: async (value, name) => { calls.push(["models", value, name]); return { hostModels: [] }; },
            createComputeTarget: async (value, input) => { calls.push(["create", value, input]); return { target: personalTarget }; },
        },
    };
    registerComputeTargetTools(server, ctx);
    await tools.get("list_compute_targets")();
    await tools.get("list_compute_target_models")({ name: "shared/pool" });
    await tools.get("manage_compute_target")({ action: "create", mine: false, label: "pool", kind: "pool" });
    assert.deepEqual(calls.map(([method]) => method), ["list", "models", "create"]);
    assert.deepEqual(calls[2][2], { name: undefined, label: "pool", kind: "pool", displayName: undefined, config: undefined });
});

test("MCP session creation forwards compute_target for ordinary and agent-bound sessions", async () => {
    const { server, tools } = recordingServer();
    const calls = [];
    let id = 0;
    const ctx = {
        webMode: false,
        client: {
            createSession: async (input) => {
                calls.push(["createSession", input]);
                return { sessionId: `s${++id}`, send: async () => {} };
            },
            createSessionForAgent: async (agent, input) => {
                calls.push(["createSessionForAgent", agent, input]);
                return { sessionId: `s${++id}`, send: async () => {} };
            },
        },
        mgmt: {},
    };
    registerSessionTools(server, ctx);
    const create = tools.get("create_session");
    await create({ compute_target: "shared/pool" });
    await create({ agent: "Worker", compute_target: "owner@example.com/workstation" });
    assert.equal(calls[0][1].computeTarget, "shared/pool");
    assert.equal(calls[1][2].computeTarget, "owner@example.com/workstation");
});
