import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PilotSwarmClient } from "../../dist/client.js";
import { createSessionManagerProxy, createSessionProxy, registerActivities } from "../../dist/session-proxy.js";
import { routeHandoffActivity, AGENT_HANDOFF_CAPABILITY, WORKSPACE_CAPABILITY } from "../../dist/activity-routing.js";
import { handleSubAgentAction } from "../../dist/orchestration/agents.js";
import { DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../dist/orchestration-registry.js";
import {
    ENQUEUE_AGENT_CHILD_BOOTSTRAP_ACTIVITY,
    ENSURE_AGENT_CHILD_SESSION_ACTIVITY,
} from "../../dist/agent-child-bootstrap.js";
const { OrchestrationContext } = createRequire(import.meta.url)("duroxide");
const context = () => new OrchestrationContext({ instanceId: "parent", executionId: "1", orchestrationName: "test", orchestrationVersion: "1.0.74" });
const wire = (value) => JSON.parse(JSON.stringify(value));
const sourceHash = (url) => {
    const bytes = readFileSync(url);
    const checkoutBytes = process.platform === "win32"
        ? Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"))
        : bytes;
    return createHash("sha256").update(checkoutBytes).digest("hex");
};

// Immutable snapshot of the shipped 1.0.74 generator tree. The only change
// from the former live tree was pinning its own version constant, as with
// all earlier freezes. This catches edits to helpers as well as the entrypoint.
const frozenHashes = {
    "state.ts": "6f696822458e8ae1aa9fdf5a6850c911ed9eb1875f252876c9f5f1e0987afdc7",
    "lifecycle.ts": "aaa0da323b81a5b2c962fa95f062c505907f8ab16522fbce46ce94a0d94b75f5",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
    "agents.ts": "47b860ff73690c6c82aaf04f11700074259cb6792bbf4e79c8d68ef63f4ba8df",
    "runtime.ts": "e40cfcbacecdde9a9a50ea6cf620eebc16d9f800ae212723239365282c1d67a8",
    "index.ts": "f83f7d0895e9090eeed6462034f6c1ba37cc7a717a1bb4c154cd639c09b01ab0",
    "turn.ts": "a120114106a14e6c92c188181b3b4e9bc646c8c354bd4eeec3529cffd02ffed4",
    "queue.ts": "529218aed1877208a144e5cad6acece5b3c4711af5dcc72065231698649c4c3b"
};
for (const [name, hash] of Object.entries(frozenHashes)) {
    test(`frozen 1.0.74 ${name} remains unchanged`, () => {
        assert.equal(sourceHash(new URL(`../../src/orchestration_1_0_74/${name}`, import.meta.url)), hash);
    });
}

// The last selector-capable version must preserve its historical scheduling.
const selectorFreezeHashes = {
    "state.ts": "6f696822458e8ae1aa9fdf5a6850c911ed9eb1875f252876c9f5f1e0987afdc7",
    "lifecycle.ts": "498dfe9c73253058929cfdd5d14185ca16347920ddba42c26c16dd9548a12d42",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
    "agents.ts": "e563f1a251f9fc487dc38446c7ebb857844f9eae72dfb08611a80e9a7434395c",
    "runtime.ts": "140a23c4d8bd688afbe6a7da3238f83f5bed7b42c9a959aa5af07ffc08edf7a2",
    "index.ts": "f8eb4413b1cbbee437bd8b867555e9ad7f1f60a02fadf4e17bf8143c1367e2eb",
    "turn.ts": "17f997507c7b94c4e4524a12a63dfa60c573be21125b6ad9cb35b46fab749c01",
    "queue.ts": "529218aed1877208a144e5cad6acece5b3c4711af5dcc72065231698649c4c3b"
};
for (const [name, hash] of Object.entries(selectorFreezeHashes)) {
    test(`frozen 1.0.75 ${name} remains unchanged`, () => {
        assert.equal(sourceHash(new URL(`../../src/orchestration_1_0_75/${name}`, import.meta.url)), hash);
    });
}

test("registry retains 1.0.74 through 1.0.81 separately and activates 1.0.82", () => {
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-1).version, "1.0.82");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.81").handler.name, "durableSessionOrchestration_1_0_81");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.80").handler.name, "durableSessionOrchestration_1_0_80");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.79").handler.name, "durableSessionOrchestration_1_0_79");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.78").handler.name, "durableSessionOrchestration_1_0_78");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.77").handler.name, "durableSessionOrchestration_1_0_77");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.76").handler.name, "durableSessionOrchestration_1_0_76");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.74").handler.name, "durableSessionOrchestration_1_0_74");
    assert.equal(DURABLE_SESSION_ORCHESTRATION_REGISTRY.find(r => r.version === "1.0.75").handler.name, "durableSessionOrchestration_1_0_75");
});

test("legacy proxy descriptors retain their serialized names, inputs and affinity, without tags", () => {
    const ctx = context();
    const manager = createSessionManagerProxy(ctx);
    const proxy = createSessionProxy(ctx, "child", "affinity", { model: "test" });
    assert.deepEqual(wire(manager.resolveAgentConfig("analyst")), {
        type: "activity", name: "resolveAgentConfig", input: '{"agentName":"analyst","callerSessionId":"parent"}',
    });
    assert.deepEqual(wire(manager.resolveAgentForRequiredTool("lookup")), {
        type: "activity", name: "resolveAgentForRequiredTool", input: '{"requiredTool":"lookup","callerSessionId":"parent"}',
    });
    assert.deepEqual(wire(manager.spawnChildSession("parent", {}, "work", 1, false)), {
        type: "activity", name: "spawnChildSession", input: '{"parentSessionId":"parent","config":{},"task":"work","nestingLevel":1,"isSystem":false}',
    });
    assert.deepEqual(wire(manager.spawnWorkflowSession(
        "parent",
        { kind: "registered", definitionId: "definition-1" },
        { target: "staging" },
    )), {
        type: "activity",
        name: "spawnWorkflowSession",
        input: '{"parentSessionId":"parent","definition":{"kind":"registered","definitionId":"definition-1"},"inputs":{"target":"staging"}}',
    });
    for (const historical of [manager, createSessionManagerProxy(ctx, "agent-handoff-v2")]) {
        assert.deepEqual(wire(historical.getSessionStatus("child")), {
            type: "activity", name: "getSessionStatus", input: '{"sessionId":"child"}',
        });
        assert.deepEqual(wire(historical.listChildSessions("parent")), {
            type: "activity", name: "listChildSessions", input: '{"parentSessionId":"parent"}',
        });
    }
    assert.deepEqual(wire(proxy.runTurn("work", false, 2)), {
        type: "activity", name: "runTurn", input: '{"sessionId":"child","prompt":"work","config":{"model":"test"},"turnIndex":2}', sessionId: "affinity",
    });
    assert.deepEqual(wire(proxy.runTurn("work", true, 0, { epochStart: true, requiredTool: "initialize" })), {
        type: "activity", name: "runTurn2", input: '{"sessionId":"child","prompt":"work","config":{"model":"test"},"bootstrap":true,"turnIndex":0,"requiredTool":"initialize","epochStart":true}', sessionId: "affinity",
    });
});

test("1.0.78 status activities opt into result provenance and capability routing", () => {
    const manager = createSessionManagerProxy(context(), "agent-handoff-v2", { childResultProvenance: true });
    assert.deepEqual(wire(manager.getSessionStatus("child")), {
        type: "activity", name: "getSessionStatusV2", input: '{"sessionId":"child"}', tag: AGENT_HANDOFF_CAPABILITY,
    });
    assert.deepEqual(wire(manager.listChildSessions("parent")), {
        type: "activity", name: "listChildSessionsV2", input: '{"parentSessionId":"parent"}', tag: AGENT_HANDOFF_CAPABILITY,
    });
});

test("new handoff proxies route every critical activity with the capability tag", () => {
    const ctx = context();
    const manager = createSessionManagerProxy(ctx, "agent-handoff-v2");
    const proxy = createSessionProxy(ctx, "child", "affinity", {}, "agent-handoff-v2");
    const tasks = [manager.resolveAgentConfig("analyst"), manager.resolveAgentForRequiredTool("lookup"), manager.spawnChildSession("parent", {}, "work"), proxy.runTurn("work"), proxy.runTurn("work", true, 0, { epochStart: true })];
    assert.deepEqual(tasks.map(t => t.name), ["resolveAgentConfigV2", "resolveAgentForRequiredToolV2", "spawnChildSessionV2", "runTurnV3", "runTurnEpochV3"]);
    for (const task of tasks) assert.equal(task.tag, AGENT_HANDOFF_CAPABILITY);
    assert.equal(tasks[3].sessionId, "affinity");
    assert.equal(tasks[4].sessionId, "affinity");
    assert.equal(manager.listModels().tag, undefined, "unrelated activities retain their existing routing");
});

test("workflow agent spawning carries a replay-stable child session id", () => {
    const manager = createSessionManagerProxy(context(), "agent-handoff-v2");
    const task = wire(manager.spawnChildSession(
        "workflow-parent",
        { toolNames: ["submit_workflow_result"] },
        "Inspect the change.",
        1,
        false,
        "Inspector",
        "inspector",
        undefined,
        false,
        "submit_workflow_result",
        false,
        "child-fixed",
    ));

    assert.equal(task.name, "spawnChildSessionV2");
    const input = JSON.parse(task.input);
    assert.equal(input.childSessionId, "child-fixed");
    assert.equal(input.requiredTool, "submit_workflow_result");
});

test("workflow child creation uses its dedicated routed activity contract", () => {
    const manager = createSessionManagerProxy(context(), "agent-handoff-v2");
    const task = wire(manager.spawnWorkflowSession(
        "parent",
        { kind: "registered", definitionId: "definition-1" },
        {},
        "workflow-1",
    ));
    assert.deepEqual(task, {
        type: "activity",
        name: "spawnWorkflowSessionV1",
        input: '{"parentSessionId":"parent","definition":{"kind":"registered","definitionId":"definition-1"},"inputs":{},"childSessionId":"workflow-1"}',
        tag: AGENT_HANDOFF_CAPABILITY,
    });
    assert.deepEqual(wire(manager.getWorkflowResult("parent", "workflow-1")), {
        type: "activity",
        name: "getWorkflowResultV1",
        input: '{"parentSessionId":"parent","childSessionId":"workflow-1"}',
        tag: AGENT_HANDOFF_CAPABILITY,
    });
});

test("workers register legacy and routed workflow child activities", () => {
    const handlers = new Map();
    registerActivities(
        { registerActivity: (name, handler) => handlers.set(name, handler) },
        {},
        null,
        undefined,
        null,
        undefined,
        "postgres://unused",
    );
    assert.equal(typeof handlers.get("spawnWorkflowSession"), "function");
    assert.equal(typeof handlers.get("spawnWorkflowSessionV1"), "function");
    assert.equal(typeof handlers.get(ENSURE_AGENT_CHILD_SESSION_ACTIVITY), "function");
    assert.equal(typeof handlers.get(ENQUEUE_AGENT_CHILD_BOOTSTRAP_ACTIVITY), "function");
});

test("workflow child activities inherit the parent session model", async () => {
    const handlers = new Map();
    const created = [];
    const originalStart = PilotSwarmClient.prototype.start;
    const originalCreateWorkflowSession = PilotSwarmClient.prototype.createWorkflowSession;
    const originalStop = PilotSwarmClient.prototype.stop;
    PilotSwarmClient.prototype.start = async function () {};
    PilotSwarmClient.prototype.createWorkflowSession = async function (config) {
        created.push(config);
        return {};
    };
    PilotSwarmClient.prototype.stop = async function () {};
    const parent = {
        sessionKind: "agent",
        parentSessionId: null,
        isSystem: false,
        model: "team:gpt-5.3-codex",
        reasoningEffort: "high",
        contextTier: "long_context",
        owner: {
            provider: "entra",
            subject: "user-1",
            email: "user@example.test",
            displayName: "User One",
        },
    };
    const reads = [];
    const catalog = {
        async getSession(sessionId) {
            reads.push(sessionId);
            if (sessionId === "parent") return parent;
            return null;
        },
    };

    try {
        registerActivities(
            { registerActivity: (name, handler) => handlers.set(name, handler) },
            {},
            null,
            undefined,
            catalog,
            undefined,
            "postgres://unused",
        );
        const result = await handlers.get("spawnWorkflowSessionV1")(
            { traceInfo() {} },
            {
                parentSessionId: "parent",
                childSessionId: "workflow-1",
                definition: { kind: "registered", definitionId: "definition-1" },
                inputs: { target: "staging" },
            },
        );

        assert.equal(result, "workflow-1");
        assert.equal(created[0].model, "team:gpt-5.3-codex");
        // The whole selection travels, not just the name: inheriting the model
        // alone would leave the child at the descriptor's default effort while
        // still displaying the parent's model.
        assert.equal(created[0].reasoningEffort, "high");
        assert.equal(created[0].contextTier, "long_context");
        assert.deepEqual(created[0].owner, parent.owner);
        assert.equal(
            reads.filter(id => id === "parent").length,
            1,
            "the parent row is read once, not once per inherited field",
        );
    } finally {
        PilotSwarmClient.prototype.start = originalStart;
        PilotSwarmClient.prototype.createWorkflowSession = originalCreateWorkflowSession;
        PilotSwarmClient.prototype.stop = originalStop;
    }
});

test("an inherited model that no longer resolves falls back instead of failing the spawn", async () => {
    // The parent's binding is re-resolved against the *effective* spawn owner,
    // which the ancestor walk can move. A personal provider, a bare alias that
    // has since become ambiguous, or a retired model must not take the
    // parent's turn down with it.
    const handlers = new Map();
    const attempts = [];
    const originalStart = PilotSwarmClient.prototype.start;
    const originalCreateWorkflowSession = PilotSwarmClient.prototype.createWorkflowSession;
    const originalStop = PilotSwarmClient.prototype.stop;
    PilotSwarmClient.prototype.start = async function () {};
    PilotSwarmClient.prototype.createWorkflowSession = async function (config) {
        attempts.push(config);
        if (config.model) {
            throw Object.assign(
                new Error(`No usable provider serves model "${config.model}".`),
                { code: "MODEL_UNRESOLVED" },
            );
        }
        return {};
    };
    PilotSwarmClient.prototype.stop = async function () {};
    const catalog = {
        async getSession(sessionId) {
            if (sessionId === "parent") {
                return {
                    sessionKind: "agent",
                    parentSessionId: null,
                    isSystem: false,
                    model: "alice-ghcp:claude-opus-5",
                    owner: { provider: "entra", subject: "user-1" },
                };
            }
            return null;
        },
    };

    try {
        registerActivities(
            { registerActivity: (name, handler) => handlers.set(name, handler) },
            {},
            null,
            undefined,
            catalog,
            undefined,
            "postgres://unused",
        );
        const result = await handlers.get("spawnWorkflowSessionV1")(
            { traceInfo() {} },
            {
                parentSessionId: "parent",
                childSessionId: "workflow-1",
                definition: { kind: "registered", definitionId: "definition-1" },
                inputs: {},
            },
        );

        assert.equal(result, "workflow-1");
        assert.equal(attempts.length, 2, "it retries once without the inherited model");
        assert.equal(attempts[0].model, "alice-ghcp:claude-opus-5");
        assert.equal(attempts[1].model, undefined);
    } finally {
        PilotSwarmClient.prototype.start = originalStart;
        PilotSwarmClient.prototype.createWorkflowSession = originalCreateWorkflowSession;
        PilotSwarmClient.prototype.stop = originalStop;
    }
});

test("a workflow child failure is reported to the parent instead of failing its turn", async () => {
    // spawn_agent already degrades this way; spawn_workflow yielded the
    // activity bare, so a creation failure escaped the turn's error handling.
    const runtime = {
        ctx: {
            newGuid: () => "child-1",
            traceInfo: () => {},
        },
        input: { sessionId: "parent" },
        state: { subWorkflows: [], pendingPrompt: undefined },
        manager: {
            spawnWorkflowSession: () => {
                throw new Error("provider catalog unavailable");
            },
        },
    };
    const generator = handleSubAgentAction(runtime, {
        type: "spawn_workflow",
        definition: { kind: "registered", definitionId: "definition-1" },
        inputs: {},
    });

    let step = generator.next();
    while (!step.done) step = generator.next("child-1");

    assert.equal(step.value, true, "the turn continues");
    assert.equal(runtime.state.subWorkflows.length, 0, "no child is tracked");
    assert.match(
        String(runtime.state.pendingPrompt),
        /spawn_workflow failed/,
        "the session is told the spawn failed",
    );
});

test("routing fails closed if the SDK cannot express capability tags", () => {
    const descriptor = { type: "activity", name: "turn" };
    assert.equal(routeHandoffActivity(descriptor), descriptor, "legacy descriptors need no new SDK API");
    assert.throws(() => routeHandoffActivity(descriptor, "agent-handoff-v2"), /tag routing support/);
});

// Frozen from checkpoint 4c2ce252 before cleanup notification changes.
const cleanupFreezeHashes = {
    "state.ts": "6f696822458e8ae1aa9fdf5a6850c911ed9eb1875f252876c9f5f1e0987afdc7",
    "lifecycle.ts": "498dfe9c73253058929cfdd5d14185ca16347920ddba42c26c16dd9548a12d42",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
    "agents.ts": "137267e3336ca750d8b7752ed33169aecfd6c7ad196f5f8f74a2058a0a457f66",
    "runtime.ts": "c4195ca97362ee536e4d9970a67825dc12839532ea60aaf9d61686ef89c6a43f",
    "index.ts": "9013b0cb988fdfd3a9641418bffcd07d694d665230a0d3592fe1784d294d15db",
    "turn.ts": "17f997507c7b94c4e4524a12a63dfa60c573be21125b6ad9cb35b46fab749c01",
    "queue.ts": "529218aed1877208a144e5cad6acece5b3c4711af5dcc72065231698649c4c3b"
};
for (const [name, hash] of Object.entries(cleanupFreezeHashes)) {
    test(`frozen 1.0.76 ${name} remains unchanged`, () => {
        assert.equal(sourceHash(new URL(`../../src/orchestration_1_0_76/${name}`, import.meta.url)), hash);
    });
}

// Frozen from checkpoint bf46d953 before adding explicit result provenance.
const provenanceFreezeHashes = {
    "state.ts": "6f696822458e8ae1aa9fdf5a6850c911ed9eb1875f252876c9f5f1e0987afdc7",
    "lifecycle.ts": "498dfe9c73253058929cfdd5d14185ca16347920ddba42c26c16dd9548a12d42",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7",
    "agents.ts": "46eaca87704dbf87e4f90c32c22be2cae1770311821ca83a8b9b4d323c598c4d",
    "runtime.ts": "a7fdab4a3c6d7bef1c5ba986aae528505d0215b8071551f01708899a38805bce",
    "index.ts": "10e9141124dbf14858f2aca9f395a9e7a80c006250fd604fcfeea4d7088f460a",
    "turn.ts": "ff1aea267ac079d9734876572a0ee8cd25999321d545574e8007038262dfe3a8",
    "queue.ts": "529218aed1877208a144e5cad6acece5b3c4711af5dcc72065231698649c4c3b"
};
for (const [name, hash] of Object.entries(provenanceFreezeHashes)) {
    test(`frozen 1.0.77 ${name} remains unchanged`, () => {
        assert.equal(sourceHash(new URL(`../../src/orchestration_1_0_77/${name}`, import.meta.url)), hash);
    });
}

test("a workspace session's turns and workspace activities go only to workers that know workspaces", () => {
    const ctx = context();
    const workspace = { schema: 1, root: "a", folder: "repo-x" };
    const proxy = createSessionProxy(ctx, "child", "affinity", { workspace }, "agent-handoff-v2");
    const turns = [proxy.runTurn("work", false, 1, { workspaceRevision: 1 }), proxy.runTurn("work", true, 0, { epochStart: true, workspaceRevision: 1 })];
    assert.deepEqual(turns.map((t) => [t.name, t.tag, t.sessionId]), [
        ["runTurnV3", WORKSPACE_CAPABILITY, "affinity"],
        ["runTurnEpochV3", WORKSPACE_CAPABILITY, "affinity"],
    ]);
    // After a clear the revision still goes out, and so does the tag.
    const cleared = createSessionProxy(ctx, "child", "affinity", { model: "m" }, "agent-handoff-v2");
    assert.equal(cleared.runTurn("work", false, 2, { workspaceRevision: 2 }).tag, WORKSPACE_CAPABILITY);
    for (const task of [
        proxy.checkWorkspace({ workspace, revision: 2, turnIndex: 1 }),
        proxy.releaseWorkspace({ reason: "idle", revision: 1, turnIndex: 1 }),
    ]) {
        assert.equal(task.tag, WORKSPACE_CAPABILITY);
        assert.equal(task.sessionId, "affinity");
    }
    // A session that never had a workspace keeps the handoff tag.
    const plain = createSessionProxy(ctx, "child", "affinity", { model: "m" }, "agent-handoff-v2");
    assert.equal(plain.runTurn("work", false, 1).tag, AGENT_HANDOFF_CAPABILITY);
});
