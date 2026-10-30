/**
 * Workflow surfaces: the spawn_workflow tool, the tools a script may
 * call, the worker switch, the Web API operation and the compiler limits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ManagedSession } from "../../dist/managed-session.js";
import { SessionManager } from "../../dist/session-manager.js";
import { findReservedPackageToolName } from "../../dist/reserved-tool-names.js";
import { resolveWorkflowScriptSettings } from "../../dist/worker.js";
import {
    buildParentNotification,
    compileWorkflow,
    WorkflowCompileError,
    SPAWN_WORKFLOW_TOOL_SPEC,
    WORKFLOW_MAX_YAML_BYTES,
    workflowErrorMessage,
    workflowStatusForOutcome,
    spawnWorkflowFromTool,
    workflowChildSessionId,
} from "../../dist/workflow/index.js";
import { OPERATIONS } from "../../api/src/protocol.js";

const yaml = (stateExtra = "", stateId = "only") => `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: limits, version: 1.0.0 }
initial: ${stateId}
states:
  ${stateId}:
    type: script
    runtime: python
    source: print(1)
${stateExtra}    completion: { outcomes: [success] }
    transition: { next: { success: done } }
  done: { type: terminal, outcome: succeeded }
`;

test("spawn_workflow is declared for agent sessions and carries the YAML contract", () => {
    const defs = ManagedSession.subAgentToolDefs();
    const tool = defs.find((def) => def.name === "spawn_workflow");
    assert.ok(tool, "spawn_workflow must be declared beside spawn_agent");
    assert.deepEqual(tool.parameters.required, ["yaml"]);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["inputs", "key", "notify_on_completion", "yaml"]);
    for (const phrase of ["kind: Workflow", "type: script", "type: terminal", "completion: { outcomes:", "transition:", "call_tool", "callTool", "Invoke-PilotSwarmTool", "set_result", "cron"]) {
        assert.ok(tool.description.includes(phrase), `description should mention ${phrase}`);
    }
    assert.equal(tool.description, SPAWN_WORKFLOW_TOOL_SPEC.description);
});

test("a package cannot shadow spawn_workflow", () => {
    const platform = [...ManagedSession.systemToolDefs(), ...ManagedSession.subAgentToolDefs()].map((def) => def.name);
    assert.equal(findReservedPackageToolName(["spawn_workflow"], platform, []), "spawn_workflow");
});

test("script tools are the generic agent's data-plane tools, bound to the workflow session", async () => {
    const seen = [];
    const workerTool = (name) => ({
        name,
        description: name,
        parameters: { type: "object", properties: {} },
        handler: async (args, invocation) => {
            seen.push({ name, args, sessionId: invocation.durableSessionId, hasFacts: Boolean(invocation.facts) });
            return { ok: name };
        },
    });
    const stored = [];
    const factStore = {
        capabilities: {},
        async storeFact(inputs) {
            const list = Array.isArray(inputs) ? inputs : [inputs];
            stored.push(...list);
            const facts = list.map((input) => ({ key: input.key, shared: Boolean(input.shared), stored: true }));
            return Array.isArray(inputs) ? { stored: facts.length, facts } : facts[0];
        },
        async readFacts() { return { count: 0, facts: [] }; },
        async deleteFact() { return { deleted: true }; },
    };
    const manager = new SessionManager(undefined, null, {
        frameworkBaseToolNames: ["echo_default"],
        appDefaultToolNames: ["package_only"],
    });
    manager.setToolRegistry(
        new Map([["echo_default", workerTool("echo_default")], ["not_default", workerTool("not_default")], ["package_only", workerTool("package_only")]]),
        {
            staticNames: new Set(["echo_default", "not_default"]),
            byPackage: new Map([["pkg-1", new Map([["package_only", workerTool("package_only")]])]]),
        },
    );
    manager.setFactStore(factStore);

    const tools = await manager.resolveScriptTools("wf-session");
    const names = [...tools.keys()];
    assert.ok(names.includes("echo_default"));
    assert.ok(names.includes("store_fact") && names.includes("read_facts"));
    assert.ok(!names.includes("not_default"), "only the default agent's worker tools");
    assert.ok(!names.includes("package_only"), "package tools belong to a bound named agent");
    for (const control of ["wait", "cron", "cron_at", "ask_user", "spawn_agent", "spawn_workflow", "draw_canvas"]) {
        assert.ok(!names.includes(control), `${control} is a turn-control tool and must not reach scripts`);
    }

    assert.deepEqual(await tools.get("echo_default")({ x: 1 }), { ok: "echo_default" });
    assert.deepEqual(seen, [{ name: "echo_default", args: { x: 1 }, sessionId: "wf-session", hasFacts: true }]);

    await tools.get("store_fact")({ key: "results/run", value: { n: 1 } });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].key, "results/run");
    assert.equal(stored[0].sessionId, "wf-session");
});

test("workflow scripts are off unless an operator turns them on", () => {
    assert.equal(resolveWorkflowScriptSettings(undefined, {}).enabled, false);
    assert.equal(resolveWorkflowScriptSettings(undefined, { PILOTSWARM_WORKFLOW_SCRIPTS: "1" }).enabled, true);
    assert.equal(resolveWorkflowScriptSettings(undefined, { PILOTSWARM_WORKFLOW_SCRIPTS: "true" }).enabled, true);
    assert.equal(resolveWorkflowScriptSettings({ enabled: false }, { PILOTSWARM_WORKFLOW_SCRIPTS: "1" }).enabled, false);
    assert.equal(resolveWorkflowScriptSettings({ enabled: true }, {}).enabled, true);
    assert.deepEqual(
        resolveWorkflowScriptSettings({ executables: { powershell: "/opt/pwsh" } }, { PILOTSWARM_WORKFLOW_PYTHON: "/usr/bin/python3.12" }).executables,
        { python: "/usr/bin/python3.12", powershell: "/opt/pwsh" },
    );
});

test("the Web API creates workflow sessions under the session-create gate", () => {
    const op = OPERATIONS.find((entry) => entry.name === "createWorkflowSession");
    assert.ok(op);
    assert.equal(op.access, "session:create");
    assert.equal(op.method, "POST");
    assert.deepEqual(Object.keys(op.params).sort(), ["groupId", "inputs", "visibility", "yaml"]);
});

test("the parent hears the terminal state and outcome, or the reason the run stopped", () => {
    assert.equal(
        buildParentNotification({ sessionId: "s1", workflowName: "nightly", status: "completed", outcome: "succeeded", summary: "Done.", stateId: "done", output: { n: 2 }, steps: 3, notifyParent: true }),
        '[SYSTEM: Workflow session s1 "nightly" ended at state \'done\' with outcome succeeded after 3 step(s). Done. Output: {"n":2}]',
    );
    assert.equal(
        buildParentNotification({ sessionId: "s1", workflowName: null, status: "failed", error: "boom", steps: 0, notifyParent: true }),
        "[SYSTEM: Workflow session s1 (unnamed) failed after 0 step(s). Error: boom]",
    );
    assert.equal(
        buildParentNotification({ sessionId: "s1", workflowName: "n", status: "cancelled", reason: "no longer needed", steps: 1, notifyParent: true }),
        '[SYSTEM: Workflow session s1 "n" cancelled after 1 step(s). Reason: no longer needed]',
    );
});

test("a terminal outcome sets the session status", () => {
    assert.equal(workflowStatusForOutcome("succeeded"), "completed");
    assert.equal(workflowStatusForOutcome("blocked"), "completed");
    assert.equal(workflowStatusForOutcome("failed"), "failed");
    assert.equal(workflowStatusForOutcome("cancelled"), "cancelled");
});

test("activity error wrappers are removed from the reason people read", () => {
    assert.equal(
        workflowErrorMessage(new Error("Activity 'scriptWorkflow.runNode' JS execution failed: GenericFailure, Error: Script node 'x' timed out")),
        "Script node 'x' timed out",
    );
    assert.equal(workflowErrorMessage(new Error("plain")), "plain");
});

// ── spawn_workflow behind the control bridge ─────────────────────────



function spawnDeps(overrides = {}) {
    const created = [];
    const sessions = new Map();
    return {
        created,
        sessions,
        deps: {
            parentSessionId: "parent-agent",
            enabled: () => true,
            getSession: async (id) => sessions.get(id) ?? null,
            resolveOwner: async () => ({ provider: "dev", subject: "alice" }),
            createWorkflowSession: async (config) => {
                created.push(config);
                sessions.set(config.sessionId, { title: "Workflow: limits", state: "running" });
                return { sessionId: config.sessionId, workflowName: "limits" };
            },
            ...overrides,
        },
    };
}

test("spawn_workflow starts a child workflow owned like its parent and says how the result comes back", async () => {
    const { created, deps } = spawnDeps();
    const text = await spawnWorkflowFromTool({ yaml: yaml(), inputs: { day: "mon" } }, { toolCallId: "call-1" }, deps);
    const expectedId = workflowChildSessionId("parent-agent", undefined, "call-1");
    assert.match(text, new RegExp(`started workflow session ${expectedId} running "limits"`));
    assert.match(text, /receive its result as a system message/);
    assert.deepEqual(created, [{
        sessionId: expectedId,
        yaml: yaml(),
        inputs: { day: "mon" },
        parentSessionId: "parent-agent",
        owner: { provider: "dev", subject: "alice" },
        notifyParent: true,
    }]);
});

test("spawn_workflow is idempotent per key, and per tool call without one", async () => {
    assert.equal(workflowChildSessionId("p", "nightly", "a"), workflowChildSessionId("p", "nightly", "b"));
    assert.notEqual(workflowChildSessionId("p", undefined, "a"), workflowChildSessionId("p", undefined, "b"));
    assert.equal(workflowChildSessionId("p", undefined, "a"), workflowChildSessionId("p", undefined, "a"));
    assert.notEqual(workflowChildSessionId("p", "nightly"), workflowChildSessionId("q", "nightly"));

    const { created, deps } = spawnDeps();
    await spawnWorkflowFromTool({ yaml: yaml(), key: "nightly" }, { toolCallId: "c1" }, deps);
    const again = await spawnWorkflowFromTool({ yaml: yaml(), key: "nightly" }, { toolCallId: "c2" }, deps);
    assert.equal(created.length, 1);
    assert.match(again, /found the existing workflow session .* state running\)\. Nothing new was started/);
});

test("spawn_workflow refuses when workflows are off or the YAML is wrong, without creating anything", async () => {
    const off = spawnDeps({ enabled: () => false });
    assert.match(await spawnWorkflowFromTool({ yaml: yaml() }, {}, off.deps), /refused — Workflow scripts are disabled on this worker/);
    assert.equal(off.created.length, 0);

    const bad = spawnDeps();
    const text = await spawnWorkflowFromTool({ yaml: yaml().replace("type: script", "type: agent") }, {}, bad.deps);
    assert.match(text, /the workflow is not valid: .*type 'agent' is not supported yet.*Fix it/);
    const missingInput = spawnDeps();
    const typed = yaml().replace("initial: only", "inputs: { day: { type: string, required: true } }\ninitial: only");
    assert.match(await spawnWorkflowFromTool({ yaml: typed }, {}, missingInput.deps), /Input 'day' is required/);
    assert.equal(missingInput.created.length, 0);
    assert.equal(bad.created.length, 0);
});

test("spawn_workflow can run without waking the parent, and reports a failed create plainly", async () => {
    const quiet = spawnDeps();
    const text = await spawnWorkflowFromTool({ yaml: yaml(), notify_on_completion: false }, { toolCallId: "q" }, quiet.deps);
    assert.equal(quiet.created[0].notifyParent, false);
    assert.match(text, /will not be told when it ends/);

    const broken = spawnDeps({ createWorkflowSession: async () => { throw new Error("catalog unavailable"); } });
    assert.equal(
        await spawnWorkflowFromTool({ yaml: yaml() }, { toolCallId: "x" }, broken.deps),
        "[SYSTEM: spawn_workflow failed — catalog unavailable]",
    );
});

// ── Live view, cancellation commands, MCP and session tools ─────────

import {
    buildWorkflowCanvasHtml,
    fitWorkflowCanvasState,
    foldWorkflowCanvasState,
    mcpConfigAllowsTool,
    parseScriptMcpToolName,
    parseWorkflowCommand,
    scriptMcpResult,
} from "../../dist/workflow/index.js";
import { createScriptSessionTools } from "../../dist/workflow/session-tools.js";

test("lifecycle commands are recognised; everything else is not a command", () => {
    assert.deepEqual(parseWorkflowCommand(JSON.stringify({ type: "cmd", cmd: "cancel", args: { reason: " stop " }, requestedBy: "p" })),
        { cmd: "cancel", reason: "stop", requestedBy: "p" });
    assert.deepEqual(parseWorkflowCommand({ type: "cmd", cmd: "delete" }), { cmd: "delete" });
    assert.equal(parseWorkflowCommand({ type: "cmd", cmd: "set_model" }), null);
    assert.equal(parseWorkflowCommand({ prompt: "hi" }), null);
    assert.equal(parseWorkflowCommand("not json"), null);
});

test("the canvas page carries the definition as data, never as markup", () => {
    const workflow = compileWorkflow(`
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: "</script><img src=x onerror=alert(1)>", version: "1" }
initial: a
states:
  a:
    type: script
    runtime: node
    source: x
    completion: { outcomes: ["</script><b>"] }
    transition: { next: { "</script><b>": done } }
  done: { type: terminal, outcome: succeeded }
`);
    const html = buildWorkflowCanvasHtml(workflow, foldWorkflowCanvasState([], workflow));
    assert.equal((html.match(/<\/script>/g) || []).length, 3, "only the page's own script elements close");
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("\\u003c/script\\u003e\\u003cimg"));
    assert.match(html, /textContent/);
    assert.ok(!/innerHTML/.test(html));
});

test("the canvas state is folded from the workflow log and fits a data tick", () => {
    const events = [
        { eventType: "workflow.started", data: { name: "loop", states: [{ id: "a" }, { id: "b" }] } },
        { eventType: "workflow.state_started", data: { stateId: "a", step: 1 } },
        { eventType: "workflow.state_completed", data: { stateId: "a", step: 1, outcome: "again", resultSource: "reported", durationMs: 5, toolCalls: [{ ok: true }, { ok: false }] } },
        { eventType: "workflow.state_started", data: { stateId: "a", step: 2 } },
        { eventType: "workflow.state_completed", data: { stateId: "a", step: 2, outcome: "next", exitCode: 1, resultSource: "exit" } },
        { eventType: "workflow.state_started", data: { stateId: "b", step: 3 } },
        { eventType: "workflow.failed", data: { steps: 3, error: "boom" } },
    ];
    const state = foldWorkflowCanvasState(events);
    assert.equal(state.status, "failed");
    assert.equal(state.error, "boom");
    assert.deepEqual(state.nodes.a, { state: "failed", runs: 2, lastOutcome: "next", lastDurationMs: undefined });
    assert.equal(state.nodes.b.state, "cancelled", "a node still running when the run ended was stopped");
    assert.deepEqual(state.taken, { "a\u0001again": 1, "a\u0001next": 1 });
    assert.deepEqual(state.steps.map((s) => [s.step, s.state, s.tools ?? 0, s.failedTools ?? 0]), [[1, "done", 2, 1], [2, "failed", 0, 0], [3, "cancelled", 0, 0]]);

    const big = { ...state, steps: Array.from({ length: 400 }, (_, i) => ({ step: i, node: "a".repeat(60), outcome: "x".repeat(80), state: "done" })) };
    const fitted = fitWorkflowCanvasState(big);
    assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= 32_768);
    assert.equal(fitted.steps.at(-1).step, 399, "the newest steps are kept");
});

test("a run that reaches a terminal state marks it and the edge into it", () => {
    const state = foldWorkflowCanvasState([
        { eventType: "workflow.started", data: { name: "w", states: [{ id: "a", type: "script" }, { id: "done", type: "terminal", outcome: "succeeded" }] } },
        { eventType: "workflow.state_started", data: { stateId: "a", step: 1 } },
        { eventType: "workflow.state_completed", data: { stateId: "a", step: 1, outcome: "ok", resultSource: "reported" } },
        { eventType: "workflow.completed", data: { steps: 1, stateId: "done", outcome: "succeeded", summary: "All good.", outputPreview: "{}" } },
    ]);
    assert.equal(state.status, "completed");
    assert.equal(state.nodes.done.state, "done");
    assert.equal(state.current, "done");
    assert.equal(state.summary, "All good.");
    assert.deepEqual(state.taken, { "a\u0001ok": 1 });
});

test("MCP tool names, tool lists and results", () => {
    assert.deepEqual(parseScriptMcpToolName("github/search_issues"), { server: "github", tool: "search_issues" });
    assert.deepEqual(parseScriptMcpToolName("a/b/c"), { server: "a", tool: "b/c" });
    assert.equal(parseScriptMcpToolName("store_fact"), null);
    assert.equal(parseScriptMcpToolName("/x"), null);
    assert.equal(mcpConfigAllowsTool({ tools: ["*"] }, "any"), true);
    assert.equal(mcpConfigAllowsTool({ tools: ["a"] }, "b"), false);
    assert.equal(mcpConfigAllowsTool({}, "any"), true);
    assert.equal(scriptMcpResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
    assert.deepEqual(scriptMcpResult({ content: [{ type: "text", text: "{}" }], structuredContent: { n: 1 } }), { n: 1 });
    assert.deepEqual(scriptMcpResult({ content: [{ type: "image", data: "x", mimeType: "image/png" }] }), [{ type: "image", data: "x", mimeType: "image/png" }]);
    assert.throws(() => scriptMcpResult({ isError: true, content: [{ type: "text", text: "nope" }] }), /nope/);
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

test("scripts get the session and inspect tools, without context_health", async () => {
    const manager = new SessionManager(undefined, null, {});
    manager.setSessionCatalog({ async listSessions() { return []; }, async getSession() { return null; } });
    const names = [...(await manager.resolveScriptTools("wf-session")).keys()];
    for (const name of ["list_sessions", "send_session_message", "reply_session_message", "read_agent_events"]) {
        assert.ok(names.includes(name), `${name} should be available to scripts`);
    }
    assert.ok(!names.includes("context_health"));
    const servers = new SessionManager(undefined, null, { baseMcpServers: { github: { type: "http", url: "https://example.invalid/mcp", tools: ["*"] } } }).scriptMcpServers();
    assert.deepEqual(Object.keys(servers), ["github"]);
});
