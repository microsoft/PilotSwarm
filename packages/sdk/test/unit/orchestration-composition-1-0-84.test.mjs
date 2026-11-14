import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";
import * as routing from "../../dist/activity-routing.js";
import { ManagedSession } from "../../dist/managed-session.js";
import { createSessionProxy } from "../../dist/session-proxy.js";
import { SessionManager, packageAgentKey } from "../../dist/session-manager.js";
import { projectSerializableSessionConfig } from "../../dist/client.js";
import { workflowToolGrant, readWorkflowToolBinding } from "../../dist/workflow/tool-policy.js";
import { handleSubAgentAction } from "../../dist/orchestration/agents.js";

const read = name => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");
const spawn = options => ManagedSession.subAgentToolDefs(options).find(tool => tool.name === "spawn_agent").parameters.properties;

test("1.0.84 is a distinct handler while 1.0.83 retains its frozen replay tree", () => {
    assert.equal(DURABLE_SESSION_LATEST_VERSION, "1.0.84");
    const old = DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(entry => entry.version === "1.0.83");
    const latest = DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1);
    assert.equal(latest.version, "1.0.84");
    assert.notEqual(latest.handler, old.handler);
    assert.match(read("orchestration_1_0_83/index.ts"), /durableSessionOrchestration_1_0_83/);
    assert.match(read("orchestration_1_0_83/runtime.ts"), /"workflow-intake-v1"/);
    assert.match(read("orchestration/runtime.ts"), /LIVE_SESSION_PROXY_CONTRACT/);
    assert.match(read("orchestration/proxy-contract.ts"), /"tool-composition-v1"/);
});

test("only composition turns expose grant and tools; every turn keeps the deprecated tool_names compatibility path", () => {
    const legacy = spawn({});
    assert.ok(legacy.tool_names);
    assert.equal(Object.hasOwn(legacy, "grant"), false);
    assert.equal(Object.hasOwn(legacy, "tools"), false);
    const current = spawn({ toolComposition: true });
    assert.ok(current.grant);
    assert.ok(current.tools);
    assert.ok(current.tool_names);
    assert.match(current.tool_names.description, /Deprecated/);
    assert.doesNotMatch(current.agent_name.description, /do not override.*grant/i);
});

test("composition uses new tagged V6 activities and fails closed without tag support", () => {
    assert.deepEqual(routing.COMPOSITION_TURN_ACTIVITY_NAMES, { runTurn: "runTurnV6", runTurn2: "runTurnEpochV6" });
    assert.equal(routing.TOOL_COMPOSITION_CAPABILITY, "pilotswarm.tool-composition.v1");
    const tags = [];
    const task = { withTag(tag) { tags.push(tag); return this; } };
    assert.equal(routing.routeToolCompositionActivity(task), task);
    assert.deepEqual(tags, ["pilotswarm.tool-composition.v1"]);
    assert.throws(() => routing.routeToolCompositionActivity({}), /tag routing support/);
    assert.deepEqual(routing.WORKFLOW_INTAKE_TURN_ACTIVITY_NAMES, { runTurn: "runTurnV5", runTurn2: "runTurnEpochV5" });
});

test("a composition proxy keeps intake and epoch fields but never schedules a legacy turn", () => {
    const calls = [];
    const context = {
        scheduleActivityOnSession(name, input, affinity) {
            const call = { name, input, affinity, tags: [], withTag(tag) { this.tags.push(tag); return this; } };
            calls.push(call);
            return call;
        },
    };
    const proxy = createSessionProxy(context, "child", "affinity", { model: "fixture-model" }, "tool-composition-v1");
    const intake = { fixture: "retained" };
    proxy.runTurn("Task", false, 0, { intake, epochStart: true, transcriptEpoch: 2 });
    assert.equal(calls[0].name, "runTurnEpochV6");
    assert.deepEqual(calls[0].input.intake, intake);
    assert.equal(calls[0].input.transcriptEpoch, 2);
    assert.deepEqual(calls[0].tags, ["pilotswarm.tool-composition.v1"]);
    const historical = createSessionProxy(context, "old", "old-affinity", {}, "workflow-intake-v1");
    historical.runTurn("Task", false, 0, {});
    assert.equal(calls[1].name, "runTurnV5");
    assert.deepEqual(calls[1].tags, ["pilotswarm.workflow-request.v1"]);
});

const owner = { provider: "test", subject: "owner" };
const pkgTool = { name: "pkg_tool", parameters: { type: "object", properties: {} } };
const source = { id: "pkg", name: "tools", revision: "one", source: "published", scope: "shared", owner,
    artifacts: [], tools: new Map([["pkg_tool", pkgTool]]), mcpServers: {} };
const root = {
    policy: "node-parent-tools-v1", parentSessionId: "parent", owner, config: {},
    capabilities: { revision: 1, selections: [{ sourceId: "pkg", tools: ["pkg_tool"], mcpServers: [] }] },
    tools: [workflowToolGrant({ name: "pkg_tool", input_schema: pkgTool.parameters })],
    sourceRevisions: { pkg: "one" }, toolSources: { pkg_tool: "pkg" }, excludedTools: [],
    boundAgentFingerprint: "fixture", agentStepTools: "selections",
};
const managerForSpawn = () => {
    const manager = new SessionManager(undefined, null, { getCapabilitySources: () => [source] });
    manager.captureWorkflowToolBinding = async () => structuredClone(root);
    manager.setSessionCatalog({ getSession: async id => ({ sessionId: id, owner, state: "idle" }) });
    return manager;
};

test("spawn captures unnamed all and named none, and refuses unheld selectors before a child exists", async () => {
    const manager = managerForSpawn();
    const unnamed = await manager.captureSpawnTools("parent", {}, undefined, undefined, null);
    assert.deepEqual(unnamed.toolGrant.tools.map(tool => tool.name), ["pkg_tool"]);
    const named = await manager.captureSpawnTools("parent", {}, undefined, undefined, { name: "fixture", tools: [] });
    assert.deepEqual(named.toolGrant.tools, []);
    const explicit = await manager.captureSpawnTools("parent", {}, ["package:tools"], undefined, { name: "fixture", tools: [] });
    assert.deepEqual(explicit.toolGrant.tools.map(tool => tool.name), ["pkg_tool"]);
    for (const selector of ["missing", "package:missing", "mcp:missing", "spawn_agent"]) {
        await assert.rejects(manager.captureSpawnTools("parent", {}, [selector], undefined, null), /parent.*hold|grant.*parent/i);
    }
});

test("spawn ceilings inherit, none is empty, and a startup requirement outside the ceiling refuses", async () => {
    const manager = managerForSpawn();
    manager.sessionConfigs.set("parent", { workflowToolLimit: ["pkg_tool", "read_facts"] });
    const narrowed = await manager.captureSpawnTools("parent", {}, undefined, ["pkg_tool", "wait"], null);
    assert.deepEqual(narrowed.toolCeiling, ["pkg_tool"]);
    assert.deepEqual(narrowed.toolGrant.tools.map(tool => tool.name), ["pkg_tool"]);
    const none = await manager.captureSpawnTools("parent", {}, undefined, "none", null);
    assert.deepEqual(none.toolCeiling, []);
    assert.deepEqual(none.toolGrant.tools, []);
    await assert.rejects(manager.captureSpawnTools("parent", {}, undefined, "none", {
        name: "fixture", tools: [], initialRequiredTool: "load_skill",
    }), /required tool 'load_skill'/);
});

test("ownerless and system spawns retain their baseline and ceiling, without inventing capability authority", async () => {
    for (const isSystem of [false, true]) {
        const manager = managerForSpawn();
        manager.setSessionCatalog({ getSession: async id => ({ sessionId: id, owner: null, isSystem }) });
        manager.captureWorkflowToolBinding = async () => { throw new Error("Must not capture ownerless authority"); };
        for (const grant of [undefined, "all", "none"]) {
            assert.deepEqual(await manager.captureSpawnTools("parent", {}, grant, ["read_facts"], null), { toolCeiling: ["read_facts"] });
        }
        await assert.rejects(manager.captureSpawnTools("parent", {}, ["pkg_tool"], undefined, null), /cannot grant package capabilities/);
    }
});

test("current spawn accepts tool_names alone and refuses only a combination with grant or tools", async () => {
    const queued = [];
    const managed = new ManagedSession("fixture", {}, { toolCompositionTurn: true });
    const makeTool = () => managed.buildToolHandlers({ pendingActions: queued, queuedActions: [], subAgents: [] })
        .find(candidate => candidate.name === "spawn_agent");
    const tool = makeTool();
    await tool.handler({ task: "Fixture", tool_names: ["read_facts"] });
    assert.equal(queued[0].toolNames[0], "read_facts");
    for (const extra of [{ grant: "none" }, { tools: "none" }]) {
        const result = await makeTool().handler({ task: "Fixture", tool_names: ["read_facts"], ...extra });
        assert.match(result, /cannot be combined/);
    }
});

test("the legacy tool_names path captures only the inherited ceiling, including a Workflow step ceiling", async () => {
    const manager = managerForSpawn();
    manager.captureWorkflowToolBinding = async () => { throw new Error("Legacy tool_names must not capture a grant"); };
    const baseline = { toolNames: ["read_facts", "deployment_tool"], toolCeiling: ["read_facts"] };
    const inherited = await manager.captureSpawnTools("parent", baseline, undefined, undefined, null, true);
    assert.deepEqual(inherited, { toolCeiling: ["read_facts"] });
    assert.deepEqual(projectSerializableSessionConfig({ ...baseline, ...inherited }).toolCeiling, ["read_facts"]);
    manager.sessionConfigs.set("parent", { workflowToolLimit: [] });
    assert.deepEqual(await manager.captureSpawnTools("parent", baseline, undefined, undefined, null, true), { toolCeiling: [] });
    assert.deepEqual(baseline.toolNames, ["read_facts", "deployment_tool"]);
});

test("durable tool_names spawning retains the parent's ceiling without adding a grant", () => {
    let captureArgs;
    let childConfig;
    const runtime = {
        options: { nestingLevel: 0 }, input: { sessionId: "parent" },
        ctx: { traceInfo() {} },
        state: { subAgents: [], config: { toolNames: ["read_facts"], toolCeiling: ["read_facts"] } },
        session: { captureSpawnTools(...args) { captureArgs = args; return "capture"; } },
        manager: { spawnChildSession(_parent, config) { childConfig = config; return "spawn"; } },
    };
    const action = handleSubAgentAction(runtime, { type: "spawn_agent", task: "Fixture", toolNames: ["deployment_tool"] });
    assert.equal(action.next().value, "capture");
    assert.equal(captureArgs[4], true);
    action.next({ toolCeiling: ["read_facts"] });
    assert.deepEqual(childConfig.toolCeiling, ["read_facts"]);
    assert.equal(Object.hasOwn(childConfig, "toolGrant"), false);
    action.return();
});

test("a composition proxy forwards the legacy ceiling-only capture on parent affinity", () => {
    let scheduled;
    const proxy = createSessionProxy({
        scheduleActivityOnSession(name, input, affinity) {
            scheduled = { name, input, affinity };
            return { withTag() { return this; } };
        },
    }, "parent", "parent-affinity", {}, "tool-composition-v1");
    proxy.captureSpawnTools({}, undefined, undefined, null, true);
    assert.equal(scheduled.name, "captureSpawnToolsV1");
    assert.equal(scheduled.affinity, "parent-affinity");
    assert.equal(scheduled.input.legacyToolNames, true);
});

test("spawn pins survive projection and later parent selection changes without changing legacy projections", async () => {
    const captured = await managerForSpawn().captureSpawnTools("parent", {}, undefined, undefined, null);
    const projected = projectSerializableSessionConfig({ ...captured, toolNames: ["read_facts"] });
    assert.deepEqual(projected.toolGrant, captured.toolGrant);
    assert.equal(Object.hasOwn(projectSerializableSessionConfig({ toolNames: ["read_facts"] }), "toolGrant"), false);
    root.capabilities.selections[0].tools.push("later");
    try { assert.deepEqual(captured.toolGrant.capabilities.selections[0].tools, ["pkg_tool"]); }
    finally { root.capabilities.selections[0].tools.pop(); }
});

test("a spawned grant survives parent completion, but rejects recorded binding tampering and owner changes", async () => {
    const binding = (await managerForSpawn().captureSpawnTools("parent", {}, undefined, undefined, null)).toolGrant;
    const rows = { parent: { sessionId: "parent", owner, state: "completed" },
        child: { sessionId: "child", parentSessionId: "parent", owner } };
    let recorded = binding;
    const manager = managerForSpawn();
    manager.setSessionCatalog({ getSession: async id => rows[id] ?? null, getSessionCreationConfig: async () => ({ toolGrant: recorded }) });
    await manager.authorizeWorkflowTools("child", binding, "pkg_tool", false, true);
    recorded = { ...binding, tools: [] };
    await assert.rejects(manager.authorizeWorkflowTools("child", binding, "pkg_tool", false, true), /binding changed/);
    recorded = binding;
    rows.child.owner = { provider: "test", subject: "changed" };
    await assert.rejects(manager.authorizeWorkflowTools("child", binding, "pkg_tool", false, true), /owner changed/);
});

test("a child hands down its held pinned revision rather than a later active package", async () => {
    const childGrant = { ...structuredClone(root), parentSessionId: "grandparent" };
    const manager = new SessionManager(undefined, null, {
        getCapabilitySources: () => [{ ...source, revision: "two" }],
        getWorkflowCapabilitySnapshot: async captured => ({
            sources: [source], pins: [{ packageId: "pkg", revision: "one", state: "available" }],
            labels: { packagePins: {}, toolSources: captured.toolSources ?? { pkg_tool: "pkg" } },
        }),
    });
    manager.setSessionCatalog({
        getSession: async id => ({ sessionId: id, owner, parentSessionId: id === "parent" ? "grandparent" : null }),
        getSessionCreationConfig: async id => id === "parent" ? { toolGrant: childGrant } : {},
        getSessionCapabilities: async () => ({ revision: 0, selections: [] }),
    });
    manager.sessions.set("parent", { getWorkflowToolSession: () => ({ rpc: { tools: {
        initializeAndValidate: async () => {}, getCurrentMetadata: async () => ({
            tools: [{ name: "pkg_tool", input_schema: pkgTool.parameters }],
        }),
    } } }) });
    manager.sessionConfigs.set("parent", { toolGrant: childGrant });
    manager.workflowParentConfigs.set("parent", {});
    const captured = await manager.captureWorkflowToolBinding("parent", true);
    assert.equal(captured.sourceRevisions.pkg, "one");
    assert.deepEqual(captured.capabilities.selections, childGrant.capabilities.selections);
});

test("an opened ordinary child executes its pinned foreign handler after republish, and rejects its revocation", async t => {
    const home = mkdtempSync(join(tmpdir(), "ps-spawn-grant-"));
    const configs = [];
    let revoked = false;
    const held = { ...source, tools: new Map([["pkg_tool", { ...pkgTool, handler: async () => "held-one" }]]),
        mcpServers: { data: { type: "http", url: "https://one.example.test", tools: ["*"] } } };
    const binding = (await managerForSpawn().captureSpawnTools("parent", {}, undefined, undefined, null)).toolGrant;
    binding.mcpSources = { data: "pkg" };
    const manager = new SessionManager(undefined, null, {
        getCapabilitySources: () => [{ ...held, revision: "two", tools: new Map([["pkg_tool", {
            ...pkgTool, handler: async () => "later-two",
        }]]) }],
        getWorkflowCapabilitySnapshot: async () => ({
            sources: revoked ? [] : [held],
            pins: [{ packageId: "pkg", revision: "one", state: revoked ? "unavailable" : "available",
                ...(revoked ? { reason: "disabled" } : {}) }],
            labels: { packagePins: {}, toolSources: { pkg_tool: "pkg" } },
        }),
    }, home);
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }) });
    manager.setSessionCatalog({
        getSession: async id => ({ sessionId: id, owner, parentSessionId: id === "child" ? "parent" : null }),
        getSessionCreationConfig: async () => ({ toolGrant: binding }),
        getSessionCapabilities: async () => ({ revision: 0, selections: [] }),
        recordEvents: async () => {},
    });
    const open = config => {
        configs.push(config);
        mkdirSync(join(home, config.sessionId), { recursive: true });
        return { disconnect: async () => {} };
    };
    manager.ensureClient = async () => ({ createSession: async config => open(config),
        resumeSession: async (_id, config) => open(config), deleteSession: async () => {} });
    t.after(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        rmSync(home, { recursive: true, force: true });
    });
    const session = await manager.getOrCreate("child", { toolGrant: binding }, { turnIndex: 0 });
    assert.ok(configs.at(-1).tools.some(tool => tool.name === "pkg_tool"));
    assert.equal(configs.at(-1).mcpServers.data.url, "https://one.example.test");
    const permission = configs.at(-1).onPermissionRequest;
    assert.deepEqual(await permission({ kind: "mcp", serverName: "data", toolName: "read" }), { kind: "approve-once" });
    const handler = session.config.tools.find(tool => tool.name === "pkg_tool")?.handler;
    assert.equal(typeof handler, "function");
    assert.equal(await handler({}, {}), "held-one");
    revoked = true;
    await assert.rejects(handler({}, {}), /disabled|unavailable|revoked/i);
    assert.equal((await permission({ kind: "mcp", serverName: "data", toolName: "read" })).kind, "reject");
});

test("a named spawn pins its declared MCP server even when it declares no ordinary tools or known methods", async () => {
    const manager = managerForSpawn();
    const agentSource = { ...source, packageId: "pkg", revision: "a".repeat(64), tools: new Map(),
        mcpServers: { data: { type: "http", url: "https://one.example.test", tools: ["*"] } } };
    manager.workerDefaults.getCapabilitySources = () => [agentSource];
    manager.workerDefaults.agentMcpServers = { [packageAgentKey("pkg", "fixture")]: { data: agentSource.mcpServers.data } };
    manager.workerDefaults.agentPromptLookup = { fixture: { prompt: "Fixture", toolNames: [], kind: "app-agent",
        packageId: "pkg", packageScope: "shared", packageOwner: owner,
        descriptor: { layerKind: "agent", layerId: "pkg", name: "fixture", schemaVersion: "3", version: "one", type: "app" } } };
    const captured = await manager.captureSpawnTools("parent", {}, undefined, undefined, { name: "fixture", packageId: "pkg", tools: [] });
    assert.deepEqual(captured.toolGrant.tools, []);
    assert.equal(captured.toolGrant.sourceRevisions.pkg, agentSource.revision);
    assert.equal(captured.boundAgentPackageId, `pkg@${agentSource.revision}`);
    assert.deepEqual(captured.toolGrant.mcpSources, { data: "pkg" });
});

test("MCP source validation does not depend on ordinary tool sources being present", () => {
    const { toolSources, ...binding } = structuredClone(root);
    assert.throws(() => readWorkflowToolBinding({ ...binding, mcpSources: { data: "missing" } }), /Invalid persisted MCP providers/);
    assert.throws(() => readWorkflowToolBinding({ ...binding, mcpSources: { data: "toString" } }), /Invalid persisted MCP providers/);
    assert.deepEqual(readWorkflowToolBinding({ ...binding, mcpSources: { data: "pkg" } }).mcpSources, { data: "pkg" });
});

test("a Workflow step hands down only its scoped pinned capabilities and its own ceiling", async () => {
    const scoped = { ...structuredClone(root), parentSessionId: "starter", agentStepStateId: "analyze" };
    const manager = new SessionManager(undefined, null, { getCapabilitySources: () => [{ ...source, revision: "two" }] });
    const context = { workflowSessionId: "workflow", nodeExecutionId: "execution" };
    manager.workflowParentAgentTools.set("step", context);
    manager.readWorkflowAgentBinding = async (id, received) => {
        assert.equal(id, "step");
        assert.equal(received, context);
        return scoped;
    };
    manager.authorizeWorkflowTools = async (id, binding, _tool, _load, spawned) => {
        assert.equal(id, "workflow");
        assert.equal(binding, scoped);
        assert.equal(spawned, false);
        return { sources: [source], pins: [], labels: { packagePins: {}, toolSources: { pkg_tool: "pkg" } } };
    };
    manager.sessions.set("step", { getWorkflowToolSession: () => ({ rpc: { tools: {
        initializeAndValidate: async () => {}, getCurrentMetadata: async () => ({
            tools: [{ name: "pkg_tool", input_schema: pkgTool.parameters },
                { name: "outside", input_schema: { type: "object" } }],
        }),
    } } }) });
    manager.workflowParentConfigs.set("step", {});
    manager.sessionConfigs.set("step", { workflowToolLimit: ["pkg_tool"] });
    manager.setSessionCatalog({
        getSession: async id => ({ sessionId: id, owner }),
        getSessionCapabilities: async () => ({ revision: 0, selections: [] }),
    });
    const captured = await manager.captureWorkflowToolBinding("step", true);
    assert.equal(captured.sourceRevisions.pkg, "one");
    assert.deepEqual(captured.capabilities.selections, scoped.capabilities.selections);
    assert.deepEqual(captured.tools.map(tool => tool.name), ["pkg_tool"]);
});
