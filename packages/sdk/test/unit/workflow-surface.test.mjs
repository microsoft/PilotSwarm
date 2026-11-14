/**
 * Workflow surfaces: the spawn_workflow tool, the tools a script may
 * call, the worker switch and the Web API operations.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ManagedSession } from "../../dist/managed-session.js";
import { findReservedPackageToolName } from "../../dist/reserved-tool-names.js";
import { resolveWorkflowScriptSettings } from "../../dist/worker.js";
import { SPAWN_WORKFLOW_TOOL_SPEC } from "../../dist/workflow/tool-spec.js";
import { spawnWorkflowFromTool, WORKFLOW_API_VERSION_REFUSED } from "../../dist/workflow/spawn.js";
import { parseWorkflowCommand, workflowErrorMessage } from "../../dist/workflow/commands.js";
import { createScriptSessionTools } from "../../dist/workflow/session-tools.js";
import { OPERATIONS } from "../../api/src/protocol.js";
import { WORKFLOW_CONTROLLER_REGISTRY } from "../../dist/workflow/controller-registry.js";
import {
    registerWorkflow,
    workflowControllerFeatures,
    WORKFLOW_CONTROLLER_NAME,
    WORKFLOW_CONTROLLER_VERSION,
    WORKFLOW_CONTROLLER_VERSIONS,
    WORKFLOW_EFFECT_NAME,
    WORKFLOW_EFFECT_VERSION,
    WORKFLOW_NOTIFY_NAME,
    WORKFLOW_NOTIFY_VERSION,
    WORKFLOW_SEND_NAME,
    WORKFLOW_SEND_VERSION,
    WORKFLOW_REQUEST_NAME,
    WORKFLOW_REQUEST_VERSION,
    WORKFLOW_AGENT_NAME,
    WORKFLOW_AGENT_VERSION,
    WORKFLOW_AGENT_SESSION_END_NAME,
    WORKFLOW_AGENT_SESSION_END_VERSION,
    WORKFLOW_ACTIVITIES,
} from "../../dist/workflow/runtime.js";

// Owner 2026-11-08T16:55Z, ruling 18:12Z: spawn_workflow is no longer declared (workflow_definition replaces it); its spec
// stays for its turn handler, which still answers a stale call.
test("spawn_workflow is no longer declared; its handler's spec keeps the YAML contract", () => {
    for (const opts of [{}, { workflowMilestone: true }, { workflowMilestone: true, workflowAgentChild: true }]) {
        assert.ok(!ManagedSession.subAgentToolDefs(opts).some((def) => def.name === "spawn_workflow"), JSON.stringify(opts));
    }
    const tool = SPAWN_WORKFLOW_TOOL_SPEC;
    assert.deepEqual(tool.parameters.required, ["yaml"]);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["agent_models", "inputs", "key", "notify_on_completion", "start", "state", "vars", "yaml"]);
    for (const phrase of ["Kept for one release; prefer workflow_definition", "pilotswarm.dev/v1", "state: published", "start: true", "key", "notify_on_completion"]) {
        assert.ok(tool.description.includes(phrase), `description should mention ${phrase}`);
    }
});


test("a package cannot shadow a Workflow tool, declared or not (spawn_workflow keeps its handler)", () => {
    const platform = [...ManagedSession.systemToolDefs(), ...ManagedSession.subAgentToolDefs()].map((def) => def.name);
    assert.ok(!platform.includes("spawn_workflow"));
    for (const name of ["spawn_workflow", "workflow_definition", "update_workflow", "read_workflow", "send_workflow_input", "enable_workflows"]) {
        assert.equal(findReservedPackageToolName([name], platform, []), name);
        assert.equal(findReservedPackageToolName([name], [], []), name, `${name} with no declarations at all`);
    }
});

test("update_workflow and read_workflow are declared with typed operations", () => {
    const defs = ManagedSession.subAgentToolDefs();
    const update = defs.find((def) => def.name === "update_workflow");
    const read = defs.find((def) => def.name === "read_workflow");
    assert.ok(update && read);
    // G-9: the definition operations of a Workflow made before revisions, and their arguments, are not declared.
    assert.deepEqual([...update.parameters.properties.operation.enum].sort(), ["cancel", "pause", "recover", "resume", "set_vars"]);
    assert.deepEqual([...update.parameters.required].sort(), ["operation", "operation_id", "workflow_id"]);
    assert.deepEqual(Object.keys(update.parameters.properties).sort(),
        ["delete", "expected_kv_revision", "operation", "operation_id", "reason", "run_id", "set", "workflow_id"]);
    assert.ok(update.description.includes("recover") && update.description.includes("needsRecovery"), "update_workflow describes recover");
    for (const operation of ["set_vars", "pause", "resume", "cancel", "expected_kv_revision", "load_skill with name workflow-tools"]) {
        assert.ok(update.description.includes(operation), `update_workflow describes ${operation}`);
    }
    assert.deepEqual([...read.parameters.required], ["workflow_id"]);
    assert.deepEqual(Object.keys(read.parameters.properties).sort(), ["include_yaml", "run_id", "workflow_id"]);
    // Reading never changes a workflow: the read tool has no operation, and says so.
    assert.ok(read.description.includes("reading changes nothing"), "read_workflow promises a pure read");
    assert.ok(read.description.includes("needsRecovery") && read.description.includes("update_workflow recover"),
        "read_workflow points to recover instead of acting itself");
    assert.ok(read.description.includes("kvRevision") && read.description.includes("not list_sessions"), "read_workflow shows the run's KV and is the status read");
});

test("send_workflow_input is declared beside the workflow tools, with the sender taken from the session", () => {
    const defs = ManagedSession.subAgentToolDefs();
    const send = defs.find((def) => def.name === "send_workflow_input");
    assert.ok(send, "send_workflow_input must be declared beside update_workflow");
    assert.deepEqual([...send.parameters.required].sort(), ["contract", "operation_id", "payload", "workflow_id"]);
    assert.deepEqual(Object.keys(send.parameters.properties).sort(),
        ["contract", "correlation", "operation_id", "payload", "run_id", "ttl_seconds", "workflow_id"]);
    // No field names a sender: the runtime names the calling session.
    assert.ok(!Object.keys(send.parameters.properties).some((name) => /sender|from|actor/.test(name)));
    for (const phrase of ["receive", "operation_id", "same receipt", "Accepted is not processed", "your user's", "ttl_seconds", "receipt as JSON"]) {
        assert.ok(send.description.includes(phrase), `send_workflow_input describes ${phrase}`);
    }
});

test("workflow registers the controller at 1.0.0 and 1.1.0 and one version of each helper, and each activity once under one name", () => {
    const registered = [];
    const activities = [];
    const runtime = {
        registerActivity: (name) => activities.push(name),
        registerOrchestrationVersioned: (name, version, fn) => registered.push({ name, version, fn }),
    };
    registerWorkflow(runtime, { store: {} });
    assert.deepEqual(registered.map((entry) => [entry.name, entry.version]), [
        [WORKFLOW_CONTROLLER_NAME, "1.0.0"],
        [WORKFLOW_CONTROLLER_NAME, "1.1.0"],
        [WORKFLOW_EFFECT_NAME, WORKFLOW_EFFECT_VERSION],
        [WORKFLOW_NOTIFY_NAME, WORKFLOW_NOTIFY_VERSION],
        [WORKFLOW_SEND_NAME, WORKFLOW_SEND_VERSION],
        [WORKFLOW_REQUEST_NAME, WORKFLOW_REQUEST_VERSION],
        [WORKFLOW_AGENT_NAME, WORKFLOW_AGENT_VERSION],
        [WORKFLOW_AGENT_SESSION_END_NAME, WORKFLOW_AGENT_SESSION_END_VERSION],
    ]);
    assert.ok(registered.filter((entry) => entry.name !== WORKFLOW_CONTROLLER_NAME).every((entry) => entry.version === "1.0.0"),
        "every helper orchestration is at 1.0.0");
    // New runs use live code; the old handler remains distinct and registered for old histories.
    assert.equal(WORKFLOW_CONTROLLER_VERSION, "1.1.0");
    assert.deepEqual(WORKFLOW_CONTROLLER_VERSIONS, ["1.0.0", "1.1.0"]);
    assert.deepEqual({ ...workflowControllerFeatures("1.0.0") }, { carry: false, approval: false, succession: false });
    assert.throws(() => workflowControllerFeatures("0.9.0"), /not one this build runs/);
    for (const entry of registered.filter((item) => item.name === WORKFLOW_CONTROLLER_NAME)) assert.equal(typeof entry.fn, "function");
    assert.deepEqual(WORKFLOW_CONTROLLER_REGISTRY.map(entry => entry.version), WORKFLOW_CONTROLLER_VERSIONS);
    assert.deepEqual(registered.filter(entry => entry.name === WORKFLOW_CONTROLLER_NAME).map(entry => entry.fn),
        WORKFLOW_CONTROLLER_REGISTRY.map(entry => entry.handler));
    assert.notEqual(WORKFLOW_CONTROLLER_REGISTRY[0].handler, WORKFLOW_CONTROLLER_REGISTRY[1].handler);
    // Every activity is registered once, under its one name.
    assert.deepEqual([...activities].sort(), [...new Set(Object.values(WORKFLOW_ACTIVITIES))].sort());
    assert.ok(activities.every((name) => /^workflow\.[A-Za-z]+$/.test(name)), activities.join(", "));
});

// Owner 2026-11-08T15:45Z (pse/decision/scripts-default-on): PILOTSWARM_WORKFLOW_SCRIPTS is an opt-out.
test("workflow scripts are on unless an operator turns them off", () => {
    assert.equal(resolveWorkflowScriptSettings(undefined, {}).enabled, true, "unset: on");
    assert.equal(resolveWorkflowScriptSettings(undefined, { PILOTSWARM_WORKFLOW_SCRIPTS: "" }).enabled, true, "empty: on");
    for (const off of ["0", "false", "no", "off", " OFF "]) {
        assert.equal(resolveWorkflowScriptSettings(undefined, { PILOTSWARM_WORKFLOW_SCRIPTS: off }).enabled, false, off);
    }
    for (const on of ["1", "true", "yes"]) assert.equal(resolveWorkflowScriptSettings(undefined, { PILOTSWARM_WORKFLOW_SCRIPTS: on }).enabled, true, on);
    assert.equal(resolveWorkflowScriptSettings({ enabled: false }, {}).enabled, false, "the option wins");
    assert.equal(resolveWorkflowScriptSettings({ enabled: true }, { PILOTSWARM_WORKFLOW_SCRIPTS: "0" }).enabled, true, "the option wins");
    assert.deepEqual(resolveWorkflowScriptSettings(undefined, {}), { enabled: true }, "a switch only: no runtimes or programs");
});

test("the Web API has no workflow-create route (stage 2.5, PR 235 8055fcd8): a Workflow is created by its parent agent", () => {
    // POST /sessions/workflow refused every call (no parent agent, so no tool grant); it and its client methods are gone.
    assert.equal(OPERATIONS.find((entry) => entry.name === "createWorkflowSession"), undefined);
    assert.equal(OPERATIONS.find((entry) => entry.method === "POST" && entry.path === "/sessions/workflow"), undefined);
});

test("activity error wrappers are removed from the reason people read", () => {
    assert.equal(
        workflowErrorMessage(new Error("Activity 'scriptWorkflow.runNode' JS execution failed: GenericFailure, Error: Script node 'x' timed out")),
        "Script node 'x' timed out",
    );
    assert.equal(workflowErrorMessage(new Error("plain")), "plain");
});

// ── spawn_workflow behind the control bridge ─────────────────────────

const WORKFLOW_YAML = "apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: w, version: \"1.0.0\" }\ninitial: a\n"
    + "states:\n  a: { type: wait, seconds: 1, transition: { next: { elapsed: b } } }\n  b: { type: terminal, outcome: succeeded }\n";

function spawnDeps(overrides = {}) {
    return {
        parentSessionId: "parent-agent",
        enabled: () => true,
        resolveOwner: async () => ({ provider: "dev", subject: "alice" }),
        captureToolBinding: async () => ({ policy: "node-parent-tools-v1", parentSessionId: "parent-agent" }),
        ...overrides,
    };
}

// Owner 2026-11-10T02:47Z: there is one Workflow format. Any other apiVersion is refused, in words that name the one it
// takes, before the host, the owner or the tool binding is read.
test("spawn_workflow refuses any other apiVersion, naming the one it takes, and touches nothing", async () => {
    const never = (name) => async () => { throw new Error(`${name} must not be called`); };
    const deps = spawnDeps({ resolveOwner: never("resolveOwner"), captureToolBinding: never("captureToolBinding"), workflowHost: never("workflowHost") });
    const older = "apiVersion: example.com/other\nkind: Workflow\nmetadata: { name: x, version: 1.0.0 }\ninitial: a\nstates: {}\n";
    for (const yaml of [older, "kind: Workflow\n", "not yaml: [", ""]) {
        const answer = JSON.parse(await spawnWorkflowFromTool({ yaml }, { toolCallId: "t" }, deps));
        assert.equal(answer.ok, false);
        assert.equal(answer.error.code, WORKFLOW_API_VERSION_REFUSED);
        assert.match(answer.error.message, /^A Workflow's YAML must say apiVersion: pilotswarm\.dev\/v1\. .*there is no converter/);
    }
});

test("a session without a live tool context gets a coded refusal in plain words (of-01)", async () => {
    const lost = () => Object.assign(new Error("ignored"), { code: "WORKFLOW_PARENT_CONTEXT_UNAVAILABLE" });
    // A save and start: the scripts gate needs the host first (d52e5ed2); the binding is captured next, before the store is
    // read, so nothing is saved for a session whose tools are not ready.
    const store = new Proxy({}, { get: (_target, name) => { throw new Error(`the store must not be read (${String(name)})`); } });
    const deps = spawnDeps({ captureToolBinding: async () => { throw lost(); }, workflowHost: async () => ({ scripts: true, store }) });
    const answer = JSON.parse(await spawnWorkflowFromTool({ yaml: WORKFLOW_YAML, state: "published", start: true }, { toolCallId: "p2" }, deps));
    assert.equal(answer.ok, false);
    assert.equal(answer.error.code, "WORKFLOW_PARENT_CONTEXT_UNAVAILABLE");
    assert.match(answer.error.message, /^The workflow was not created: this session's tools were not ready/);
});

// Adversarial review R2-SF-4: spawn_workflow's failure never carries the error's own text: it is the workflow tools' coded
// JSON, its secrets hidden.
test("R2-SF-4: a spawn_workflow failure hides the error's secrets", async () => {
    const CANARY = "canary-r2sf4-spawn";
    const deps = spawnDeps({ workflowHost: async () => { throw new Error(`pool to postgres://svc:${CANARY}@db.invalid/x failed; token=${CANARY}`); } });
    const answer = await spawnWorkflowFromTool({ yaml: WORKFLOW_YAML }, { toolCallId: "s1" }, deps);
    assert.ok(!answer.includes(CANARY), answer);
    const parsed = JSON.parse(answer);
    assert.equal(parsed.ok, false);
    assert.deepEqual(Object.keys(parsed.error).sort(), ["code", "message"]);
});

// ── Commands and session tools ─────────────────────────────────────────

test("lifecycle commands are recognised; everything else is not a command", () => {
    assert.deepEqual(parseWorkflowCommand(JSON.stringify({ type: "cmd", cmd: "cancel", args: { reason: " stop " }, requestedBy: "p" })),
        { cmd: "cancel", reason: "stop", requestedBy: "p" });
    assert.deepEqual(parseWorkflowCommand({ type: "cmd", cmd: "delete" }), { cmd: "delete" });
    assert.equal(parseWorkflowCommand({ type: "cmd", cmd: "set_model" }), null);
    assert.equal(parseWorkflowCommand({ prompt: "hi" }), null);
    assert.equal(parseWorkflowCommand("not json"), null);
});

function sessionCatalog(rows) {
    return {
        async listSessions() { return rows; },
        async getSession(id) { return rows.find((r) => r.sessionId === id) ?? null; },
    };
}

test("list_sessions for scripts filters like the agent tool and returns JSON", async () => {
    const now = Date.now();
    const rows = [
        { sessionId: "wf", title: "Workflow: x", state: "running", sessionKind: "workflow", parentSessionId: "agent", owner: { provider: "dev", subject: "alice" }, createdAt: new Date(now), updatedAt: new Date(now) },
        { sessionId: "agent", title: "Release agent", state: "idle", agentId: "release", owner: { provider: "dev", subject: "alice" }, createdAt: new Date(now - 1000), updatedAt: new Date(now - 1000) },
        { sessionId: "sys", title: "Sweeper", state: "running", isSystem: true, createdAt: new Date(now), updatedAt: new Date(now) },
        { sessionId: "gone", title: "Deleted", state: "idle", deletedAt: new Date(now), createdAt: new Date(now), updatedAt: new Date(now) },
    ];
    const tools = createScriptSessionTools({ sessionId: "wf", catalog: sessionCatalog(rows), duroxideClient: null });
    const top = await tools.get("list_sessions")({});
    assert.deepEqual(top.sessions.map((s) => s.sessionId), ["agent"]);
    const all = await tools.get("list_sessions")({ include_children: true });
    assert.deepEqual(all.sessions.map((s) => [s.sessionId, s.kind, s.self ?? false]), [["wf", "workflow", true], ["agent", "agent", false]]);
    const byParent = await tools.get("list_sessions")({ parent_session_id: "session-agent" });
    assert.deepEqual(byParent.sessions.map((s) => s.sessionId), ["wf"]);
    const byQuery = await tools.get("list_sessions")({ query: "release" });
    assert.deepEqual(byQuery.sessions.map((s) => s.sessionId), ["agent"]);
    const withSystem = await tools.get("list_sessions")({ include_system: true });
    assert.ok(withSystem.sessions.some((s) => s.sessionId === "sys"));
});

test("send_session_message from a script is one-way, and workflow sessions accept no messages", async () => {
    const rows = [
        { sessionId: "wf", title: "Workflow: x", state: "running", sessionKind: "workflow" },
        { sessionId: "agent", title: "Agent", state: "idle" },
        { sessionId: "wf2", title: "Workflow: y", state: "running", sessionKind: "workflow" },
    ];
    const enqueued = [];
    const duroxideClient = {
        async getStatus() { return { status: "Running" }; },
        async getInstanceInfo() { return { status: "Running" }; },
        async enqueueEvent(id, queue, data) { enqueued.push({ id, queue, data: JSON.parse(data) }); },
    };
    const tools = createScriptSessionTools({ sessionId: "wf", catalog: sessionCatalog(rows), duroxideClient });
    await assert.rejects(() => tools.get("send_session_message")({ session_id: "agent", subject: "s", body: "b", expects_response: true }), /cannot receive replies/);
    const sent = await tools.get("send_session_message")({ session_id: "session-agent", subject: "Report", body: "3 rows", reason: "handoff" });
    assert.equal(sent.target, "agent");
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].id, "session-agent");
    assert.match(enqueued[0].data.prompt, /\[SESSION_MESSAGE request_id=\S+ from=wf subject=Report reason=handoff\]/);
    await assert.rejects(() => tools.get("send_session_message")({ session_id: "wf2", subject: "s", body: "b" }), /workflow session; .*takes no session messages/);
    await assert.rejects(() => tools.get("reply_session_message")({ request_id: "r", session_id: "wf2", body: "b" }), /workflow session; .*takes no session replies/);
});
