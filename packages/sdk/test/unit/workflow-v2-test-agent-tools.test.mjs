/**
 * Workflow v2 real-agent test runs, inactive: the pure parts of
 * workflow/v2/test-agent-tools.ts (design 05 agent mode real; R19, R20,
 * T112), over fakes.
 *
 * - interceptWorkflowTestTools: every framework tool's handler but
 *   complete_workflow_node's and ask_user's is replaced by the test's call
 *   (text as it is, any other value as JSON, a failure as the session's
 *   failure result); the declarations are unchanged.
 * - workflowTestPermission: while a session is under such a test, MCP tools
 *   and MCP sampling are refused; every other request, and every other
 *   session, goes to the base handler.
 * - authorizeWorkflowTestNotice: the worker's rule for a test's notices.
 * - workflowTestAgentScope: a test run's agent state gives a scope, a live
 *   run's none; a node or run that cannot be read throws (fail closed).
 * - workflowTestAgentToolCall over a fake store: a fixture answers at once;
 *   otherwise the parent is told once, and its success, error or cancel is
 *   the call's result; a decided state or an ended run stops the wait; the
 *   wait is bounded; a failed notice is recorded and the call goes on.
 *
 * Run: node --test test/unit/workflow-v2-test-agent-tools.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    authorizeWorkflowTestNotice, interceptWorkflowTestTools, WORKFLOW_V2_TEST_AGENT_UNINTERCEPTED_TOOLS, WORKFLOW_V2_TEST_MCP_REFUSAL,
    workflowTestAgentScope, workflowTestAgentToolCall, workflowTestPermission,
} from "../../dist/workflow/v2/test-agent-tools.js";
import { parseTestFixtures } from "../../dist/workflow/v2/test-mode.js";

const SCOPE = { workflowSessionId: "W", runId: "run-1", nodeExecutionId: "nx-1", stateId: "review", agentSessionId: "C" };

test("intercepts every framework tool's handler but the state's completion and ask_user, and keeps the declarations", async () => {
    assert.deepEqual([...WORKFLOW_V2_TEST_AGENT_UNINTERCEPTED_TOOLS], ["complete_workflow_node", "ask_user"]);
    const live = [];
    const tools = ["read_build", "wait", "spawn_agent", "complete_workflow_node", "ask_user"].map(name => ({
        name, description: `${name} tool`, parameters: { type: "object" }, overridesBuiltInTool: name === "wait",
        handler: async () => { live.push(name); return "live"; },
    }));
    const calls = [];
    const answers = { read_build: { state: "green" }, wait: "waited", spawn_agent: null };
    const wrapped = interceptWorkflowTestTools(tools, async (tool, args) => {
        calls.push([tool, args]);
        if (tool === "spawn_agent" && args.task === "fail") throw new Error("not answered");
        return answers[tool];
    }, error => ({ resultType: "failure", error: error.message }));
    assert.deepEqual(wrapped.map(tool => tool.name), tools.map(tool => tool.name));
    for (const [index, tool] of wrapped.entries()) {
        assert.equal(tool.description, tools[index].description);
        assert.equal(tool.parameters, tools[index].parameters);
        assert.equal(tool.overridesBuiltInTool, tools[index].overridesBuiltInTool);
    }
    const byName = name => wrapped.find(tool => tool.name === name);
    assert.equal(await byName("read_build").handler({ buildId: 1 }, { toolCallId: "t1" }), JSON.stringify({ state: "green" }));
    assert.equal(await byName("wait").handler({ seconds: 5 }, { toolCallId: "t2" }), "waited");
    assert.equal(await byName("spawn_agent").handler(null, { toolCallId: "t3" }), "null");
    assert.deepEqual(await byName("spawn_agent").handler({ task: "fail" }, { toolCallId: "t4" }), { resultType: "failure", error: "not answered" });
    assert.deepEqual(calls, [["read_build", { buildId: 1 }], ["wait", { seconds: 5 }], ["spawn_agent", {}], ["spawn_agent", { task: "fail" }]]);
    // The state's completion and ask_user keep their own handlers (the same objects).
    assert.equal(byName("complete_workflow_node"), tools[3]);
    assert.equal(byName("ask_user"), tools[4]);
    assert.deepEqual(live, []);
});

test("refuses MCP tools and MCP sampling only while the session is under a real-agent test", () => {
    let active = false;
    const base = (request, invocation) => ({ kind: "approve-for-session", request: request?.kind, invocation });
    const handler = workflowTestPermission(base, () => active);
    for (const kind of ["mcp", "mcp-sampling", "shell", "custom-tool"]) {
        assert.deepEqual(handler({ kind }, { sessionId: "s" }), { kind: "approve-for-session", request: kind, invocation: { sessionId: "s" } }, kind);
    }
    active = true;
    for (const kind of ["mcp", "mcp-sampling"]) assert.deepEqual(handler({ kind, serverName: "x" }, { sessionId: "s" }), { kind: "reject", feedback: WORKFLOW_V2_TEST_MCP_REFUSAL });
    for (const kind of ["shell", "read", "write", "custom-tool", "url"]) {
        assert.deepEqual(handler({ kind }, { sessionId: "s" }), { kind: "approve-for-session", request: kind, invocation: { sessionId: "s" } }, kind);
    }
    assert.deepEqual(handler(undefined), { kind: "approve-for-session", request: undefined, invocation: undefined });
});

test("authorizes a test's notice by the worker's rule: the workflow's live parent, with the same effective owner", async () => {
    const alice = { provider: "test", subject: "alice" };
    const rows = {
        P: { parentSessionId: null, owner: alice, state: "running", deletedAt: null },
        W: { parentSessionId: "P", owner: null, state: "running", deletedAt: null },
        Q: { parentSessionId: null, owner: { provider: "test", subject: "bob" }, state: "running", deletedAt: null },
        WQ: { parentSessionId: "Q", owner: alice, state: "running", deletedAt: null },
        ENDED: { parentSessionId: null, owner: alice, state: "completed", deletedAt: null },
        WE: { parentSessionId: "ENDED", owner: null, state: "running", deletedAt: null },
        GONE: { parentSessionId: null, owner: alice, state: "running", deletedAt: new Date() },
        WG: { parentSessionId: "GONE", owner: null, state: "running", deletedAt: null },
    };
    const getSession = async id => rows[id] ?? null;
    assert.equal(await authorizeWorkflowTestNotice(getSession, "W", "P"), true);
    assert.equal(await authorizeWorkflowTestNotice(getSession, "W", "Q"), false, "not the workflow's parent");
    assert.equal(await authorizeWorkflowTestNotice(getSession, "WQ", "Q"), false, "another owner");
    assert.equal(await authorizeWorkflowTestNotice(getSession, "WE", "ENDED"), false, "an ended parent");
    assert.equal(await authorizeWorkflowTestNotice(getSession, "WG", "GONE"), false, "a deleted parent");
    assert.equal(await authorizeWorkflowTestNotice(getSession, "missing", "P"), false);
});

test("gives a test run's agent state a scope and a live run's none; fails closed on what it cannot read", async () => {
    const nodes = { "nx-test": { nodeExecutionId: "nx-test", nodeType: "agent", runId: "run-test", nodeId: "review" },
        "nx-live": { nodeExecutionId: "nx-live", nodeType: "agent", runId: "run-live", nodeId: "review" },
        "nx-script": { nodeExecutionId: "nx-script", nodeType: "script", runId: "run-test", nodeId: "fetch" },
        "nx-orphan": { nodeExecutionId: "nx-orphan", nodeType: "agent", runId: "run-missing", nodeId: "review" } };
    const runs = { "run-test": { runId: "run-test", mode: "test", workflowSessionId: "W" }, "run-live": { runId: "run-live", mode: "live", workflowSessionId: "W" } };
    const store = { readNodeExecution: async id => nodes[id] ?? null, readRun: async id => runs[id] ?? null };
    const lineage = (nodeExecutionId, childSessionId = "C") => ({ agentRoot: { nodeExecutionId, childSessionId, workflowSessionId: "W", controllingSessionId: "P", distance: 1 } });
    assert.equal(await workflowTestAgentScope(store, null), null);
    assert.equal(await workflowTestAgentScope(store, { agentRoot: null }), null);
    assert.deepEqual(await workflowTestAgentScope(store, lineage("nx-test")),
        { workflowSessionId: "W", runId: "run-test", nodeExecutionId: "nx-test", stateId: "review", agentSessionId: "C" });
    assert.equal(await workflowTestAgentScope(store, lineage("nx-live")), null);
    for (const id of ["nx-missing", "nx-script", "nx-orphan"]) {
        await assert.rejects(workflowTestAgentScope(store, lineage(id)), error => error.code === "WORKFLOW_STORE_CORRUPT", id);
    }
});

/**
 * A fake store for one agent state's calls: `fixtures` as stored; `answers`, one per later readInterception (null: still
 * waiting); the node's state and the run's status, which a test may change.
 */
function fakeStore({ fixtures = [], answers = [], noticeFails = false } = {}) {
    const state = { intercepted: [], reads: 0, events: [], node: "pending", run: "running", record: null };
    return {
        state, noticeFails,
        async readTestFixtures(runId) { assert.equal(runId, SCOPE.runId); return JSON.parse(JSON.stringify(fixtures)); },
        async interceptAgentToolCall(input) {
            state.intercepted.push(input);
            const answered = input.fixture !== null;
            state.record = {
                interceptionId: `${input.nodeExecutionId}/call-${state.intercepted.length}`, operation: "tool.call", tool: input.tool,
                arguments: JSON.parse(input.argumentsText), responseSchema: null, state: answered ? "responded" : "awaiting_parent",
                response: answered ? { kind: input.fixture.kind, value: JSON.parse(input.fixture.valueText), disposition: "fixture" } : null,
            };
            const projected = input.projection?.(state.record);
            if (projected) state.events.push(...projected.events);
            return { record: state.record };
        },
        async readInterception(id) {
            state.reads += 1;
            assert.equal(id, state.record.interceptionId);
            const answer = answers.length > 0 ? answers.shift() : null;
            if (answer) state.record = { ...state.record, state: "responded", response: { ...answer, disposition: "parent" } };
            return state.record;
        },
        async readNodeExecution() { return { state: state.node }; },
        async readRun() { return { status: state.run }; },
        async readDefinition(id) { assert.equal(id, SCOPE.workflowSessionId); return { parentSessionId: "P" }; },
        async recordSessionEvents(id, events) { state.events.push(...events); },
    };
}

function callFor(store, options = {}) {
    const notices = [];
    const call = workflowTestAgentToolCall({
        store, pollMs: 1, waitMs: 2_000,
        authorizeNotice: async (workflowSessionId, parentSessionId) => workflowSessionId === "W" && parentSessionId === "P",
        notice: async (parentSessionId, prompt, clientMessageId) => {
            if (store.noticeFails) throw new Error("queue unavailable");
            notices.push({ parentSessionId, prompt, clientMessageId });
        },
        ...options,
    }, SCOPE, "C");
    return { call, notices };
}

test("answers a call from a fixture at once, by its tool and the exact hash of its arguments", async () => {
    const fixtures = parseTestFixtures([{ tool: "read_build", arguments: { buildId: 101, branch: "main" }, response: { kind: "success", value: { state: "green" } } }]);
    const store = fakeStore({ fixtures });
    const { call, notices } = callFor(store);
    // Key order does not matter; the canonical JSON is recorded.
    assert.deepEqual(await call("read_build", { branch: "main", buildId: 101 }), { state: "green" });
    assert.equal(store.state.intercepted[0].argumentsText, JSON.stringify({ branch: "main", buildId: 101 }));
    assert.deepEqual(store.state.intercepted[0].fixture, { kind: "success", valueText: JSON.stringify({ state: "green" }) });
    assert.deepEqual(notices, []);
    assert.equal(store.state.reads, 0);
    assert.deepEqual(store.state.events.map(event => [event.eventType, event.data.tool, event.data.disposition, event.data.realAgent]),
        [["workflow.test_intercepted", "read_build", "fixture", { agentSessionId: "C", callerSessionId: "C" }]]);
    // Other arguments, or another tool, are not answered by it.
    const other = fakeStore({ fixtures, answers: [null, { kind: "success", value: 1 }] });
    assert.equal(await callFor(other).call("read_build", { buildId: 102, branch: "main" }), 1);
    assert.equal(other.state.intercepted[0].fixture, null);
});

test("waits for the parent's answer, telling it once; its error or cancel fails the call", async () => {
    const store = fakeStore({ answers: [null, null, { kind: "success", value: "waited" }] });
    const { call, notices } = callFor(store);
    assert.equal(await call("wait", { seconds: 60 }), "waited");
    assert.equal(store.state.reads, 3);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].parentSessionId, "P");
    assert.equal(notices[0].clientMessageId, "workflow-test:nx-1/call-1");
    assert.ok(notices[0].prompt.startsWith("[SYSTEM: A workflow test run waits for your mock response"));
    const json = JSON.parse(notices[0].prompt.split("\n")[1]);
    assert.deepEqual({ ...json, arguments: undefined }, { sessionId: "W", runId: "run-1", interceptionId: "nx-1/call-1", operation: "tool.call",
        stateId: "review", tool: "wait", arguments: undefined, responseSchema: null, agentSessionId: "C" });

    const failing = fakeStore({ answers: [{ kind: "error", value: { code: "not_found", message: "no logs" } }] });
    await assert.rejects(callFor(failing).call("read_logs", {}), /^Error: not_found: no logs$/);
    const cancelled = fakeStore({ answers: [{ kind: "cancel", value: null }] });
    await assert.rejects(callFor(cancelled).call("read_logs", {}), /cancelled tool call nx-1\/call-1/);
});

test("stops waiting when the state is decided or the run ends, and when its bound passes; a failed notice is recorded", async () => {
    const decided = fakeStore();
    const deciding = callFor(decided).call("read_build", {});
    setTimeout(() => { decided.state.node = "completed"; }, 20);
    await assert.rejects(deciding, /stopped waiting for the answer to nx-1\/call-1/);

    const ended = fakeStore();
    ended.state.run = "cancelled";
    await assert.rejects(callFor(ended).call("read_build", {}), /stopped waiting/);

    const slow = fakeStore({ noticeFails: true });
    await assert.rejects(callFor(slow, { waitMs: 30 }).call("read_build", { buildId: 1 }),
        /The test's parent did not answer nx-1\/call-1 \(read_build\) within 0 seconds; the call did not run/);
    assert.deepEqual(slow.state.events.filter(event => event.eventType === "workflow.test_notice_failed").map(event => event.data),
        [{ runId: "run-1", interceptionId: "nx-1/call-1", error: "queue unavailable" }]);

    // Arguments that are not JSON fail the call before anything is recorded.
    const odd = fakeStore();
    await assert.rejects(callFor(odd).call("read_build", { n: Number.NaN }), /arguments of read_build/i);
    assert.equal(odd.state.intercepted.length, 0);
});
