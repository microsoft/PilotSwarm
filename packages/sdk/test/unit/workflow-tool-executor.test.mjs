import test from "node:test";
import assert from "node:assert/strict";
import { admittedWorkflowToolGrant, captureWorkflowTools, isWorkflowControlTool, resolveWorkflowTool, validateWorkflowToolArguments, workflowToolGrant,
    workflowToolPermission } from "../../dist/workflow/tool-policy.js";
import { createWorkflowToolExecutor, workflowToolResult } from "../../dist/workflow/tool-executor.js";
import { WORKFLOW_TOOL_CONCURRENCY_MESSAGE } from "../../dist/workflow/script-analysis.js";

const metadata = [
    { name: "bash", description: "shell", input_schema: { type: "object" } },
    { name: "view", description: "read", input_schema: { type: "object" } },
    { name: "facts_read", namespacedName: "facts.read", mcpServerName: "facts", mcpToolName: "read",
        description: "facts", input_schema: { type: "object" } },
    { name: "spawn_workflow", description: "control" },
];
function fixture(overrides = {}) {
    let active = metadata;
    const calls = [];
    let authorized = 0, disposed = 0;
    const session = {
        rpc: { tools: {
            initializeAndValidate: async () => ({}),
            getCurrentMetadata: async () => ({ tools: active }),
            execute: async call => { calls.push(call); return { resultType: "success", textResultForLlm: "native output" }; },
        } },
        abort: async () => undefined,
    };
    return {
        calls, session,
        setMetadata: value => { active = value; },
        get authorized() { return authorized; }, get disposed() { return disposed; },
        options: { session, grants: captureWorkflowTools(metadata), invocationPrefix: "workflow/state/attempt",
            authorize: async () => { authorized++; }, dispose: async () => { disposed++; }, ...overrides },
    };
}

test("FB-017: concurrent calls refuse with an actionable hint; sequential calls still work", async () => {
    const f = fixture();
    const executor = await createWorkflowToolExecutor(f.options);
    const first = executor.call("bash", {});
    await assert.rejects(executor.call("view", {}), { message: WORKFLOW_TOOL_CONCURRENCY_MESSAGE });
    await first;
    assert.equal(f.calls.length, 1);
    await executor.call("view", {});
    assert.equal(f.calls.length, 2);
    await executor.close();
});

for (const name of ["wait", "cron_at", "spawn_agent", "task", "tools/spawn_workflow", "session.create_session", "use_package",
    "workflow_definition", "respond_session_request", "complete_workflow_node", "send_session_message", "reply_session_message"]) {
    test(`workflow control is excluded: ${name}`, () => assert.equal(isWorkflowControlTool(name), true));
}
test("review PRW-T1: a parent's grant never captures the Workflow tools that edit, answer or complete, or session messaging", () => {
    const workflowTools = ["workflow_definition", "respond_session_request", "complete_workflow_node", "send_session_message", "reply_session_message"]
        .map(name => ({ name, description: "workflow", input_schema: { type: "object" } }));
    const grants = captureWorkflowTools([...metadata, ...workflowTools]);
    assert.deepEqual(grants.map(grant => grant.name).sort(), ["bash", "facts_read", "view"]);
    for (const tool of workflowTools) {
        assert.throws(() => resolveWorkflowTool(tool.name, grants, [...metadata, ...workflowTools]), /not permitted/);
    }
});
for (const name of ["bash", "view", "apply_patch", "rg", "read_bash", "stop_bash", "facts/read"]) {
    test(`ordinary tool remains eligible: ${name}`, () => assert.equal(isWorkflowControlTool(name), false));
}
// Review DS2-002: the bundled PilotSwarm MCP server's (and the SDK management tools') lifecycle, conversational, access and
// deployment controls are control tools under their own names. With full MCP metadata, capture leaves each out; a grant
// stored before this change (holding one) is refused at resolution, at a test run's interception and by the executor,
// which never calls the tool.
const MCP_CONTROL_LEAVES = ["send_answer", "abort_session", "regenerate_session", "stop_turn", "steer_session_turn", "complete_session",
    "cancel_pending_messages", "send_session_event", "retry_session_workspace", "switch_model", "send_command", "restart_system_session",
    "set_session_visibility", "grant_session_share", "revoke_session_share", "grant_agent_package_editor", "revoke_agent_package_editor",
    "manage_provider", "set_provider_limit", "set_provider_allowance", "provider_hold", "set_provider_default", "set_model_default",
    "set_provider_system_use", "set_system_model_default", "adopt_legacy_system_github_key", "push_agent_package", "publish_agent_package",
    "import_agent_package", "republish_agent_package_version", "pin_agent_package_version", "set_agent_package_enabled",
    "set_agent_package_scope", "delete_agent_package", "set_cluster_feature_flag", "reset_cluster_feature_flag", "set_user_feature_flag",
    "unset_user_feature_flag", "set_my_feature_flag", "unset_my_feature_flag", "create_motd", "delete_motd", "start_embedder",
    "stop_embedder", "facts_admin", "scale_workers", "compact_database", "purge_old_events", "purge_orphaned_blobs", "facts_force_purge",
    "facts_purge_tombstones"];
const mcpTool = leaf => ({ name: `pilotswarm-${leaf}`, namespacedName: `pilotswarm.${leaf}`, mcpServerName: "pilotswarm", mcpToolName: leaf,
    description: leaf, input_schema: { type: "object" } });
test("review DS2-002: the PilotSwarm MCP server's control tools are never captured, and a stored grant of one is refused", async () => {
    const controls = MCP_CONTROL_LEAVES.map(mcpTool);
    const ordinary = [mcpTool("list_sessions"), mcpTool("get_session_detail"), mcpTool("read_facts"), mcpTool("list_artifacts")];
    assert.deepEqual(captureWorkflowTools([...metadata, ...controls, ...ordinary]).map(grant => grant.name).sort(),
        ["bash", "facts_read", "pilotswarm-get_session_detail", "pilotswarm-list_artifacts", "pilotswarm-list_sessions", "pilotswarm-read_facts", "view"]);
    for (const tool of controls) {
        assert.equal(isWorkflowControlTool(tool.mcpToolName), true, tool.mcpToolName);
        const legacy = [workflowToolGrant(tool)];
        for (const name of [tool.name, `pilotswarm/${tool.mcpToolName}`, tool.namespacedName]) {
            assert.throws(() => resolveWorkflowTool(name, legacy, [tool]), /not permitted|not uniquely admitted/, name);
            assert.throws(() => admittedWorkflowToolGrant(name, legacy, []), /not permitted|not uniquely admitted/, name);
        }
    }
    // One executor per call form (an executor takes at most 100 calls).
    for (const form of [tool => `pilotswarm/${tool.mcpToolName}`, tool => tool.name]) {
        const f = fixture();
        f.setMetadata([...metadata, ...controls]);
        const executor = await createWorkflowToolExecutor({ ...f.options, grants: [...captureWorkflowTools(metadata), ...controls.map(workflowToolGrant)] });
        for (const tool of controls) await assert.rejects(executor.call(form(tool), {}), /not permitted|not uniquely admitted/, form(tool));
        assert.deepEqual(f.calls, []);
        await executor.close();
    }
});
test("captured tools exclude orchestration and match MCP aliases exactly", () => {
    const grants = captureWorkflowTools(metadata);
    assert.equal(grants.length, 3);
    assert.equal(resolveWorkflowTool("facts/read", grants, metadata).name, "facts_read");
    assert.throws(() => resolveWorkflowTool("spawn_workflow", grants, metadata), /not permitted/);
    assert.throws(() => resolveWorkflowTool("new-tool", grants, [...metadata, { name: "new-tool" }]), /not uniquely admitted/);
});
test("schema or source-name drift cannot acquire the old grant", () => {
    const grants = captureWorkflowTools(metadata);
    assert.throws(() => resolveWorkflowTool("bash", grants, [{ ...metadata[0], input_schema: { type: "string" } }]), /changed/);
    assert.throws(() => resolveWorkflowTool("facts/read", grants, [{ ...metadata[2], mcpServerName: "other" }]), /unavailable/);
});
test("native execution does not require send and reauthorizes every call", async () => {
    const f = fixture();
    const executor = await createWorkflowToolExecutor(f.options);
    assert.equal(await executor.call("bash", { command: "printf ok" }), "native output");
    await executor.call("facts/read", {});
    assert.equal(f.authorized, 2);
    assert.deepEqual(f.calls.map(call => call.name), ["bash", "facts_read"]);
    assert.notEqual(f.calls[0].toolCallId, f.calls[1].toolCallId);
    await executor.close();
    await executor.close();
    assert.equal(f.disposed, 1);
    await assert.rejects(executor.call("view", {}), /closed/);
});
test("uninitialized catalogs fail rather than use generic defaults", async () => {
    const f = fixture();
    f.setMetadata(null);
    await assert.rejects(createWorkflowToolExecutor(f.options), /did not initialize/);
});
test("revoked authority prevents native invocation", async () => {
    const f = fixture({ authorize: async () => { throw new Error("revoked"); } });
    const executor = await createWorkflowToolExecutor(f.options);
    await assert.rejects(executor.call("bash", {}), /revoked/);
    assert.equal(f.calls.length, 0);
    await executor.close();
});
test("attempted calls count against the budget even when authorization rejects", async () => {
    const f = fixture({ maxCalls: 1, authorize: async () => { throw new Error("revoked"); } });
    const executor = await createWorkflowToolExecutor(f.options);
    await assert.rejects(executor.call("bash", {}), /revoked/);
    await assert.rejects(executor.call("bash", {}), /limit/);
    await executor.close();
});
test("changed live tool metadata is refused", async () => {
    const f = fixture();
    const executor = await createWorkflowToolExecutor(f.options);
    f.setMetadata([]);
    await assert.rejects(executor.call("bash", {}), /unavailable/);
    await executor.close();
});
test("results preserve structured JSON without parsing native shell text", () => {
    assert.deepEqual(workflowToolResult({ resultType: "success", textResultForLlm: "display", structuredContent: { count: 2 } }), { count: 2 });
    assert.equal(workflowToolResult({ resultType: "success", textResultForLlm: '{"count":2}' }), '{"count":2}');
    for (const resultType of ["failure", "denied", "timeout", "rejected"]) {
        assert.throws(() => workflowToolResult({ resultType, textResultForLlm: "not executed" }), /not executed/);
    }
});
test("cleanup errors remain visible", async () => {
    const f = fixture({ dispose: async () => { throw new Error("shell still active"); } });
    const executor = await createWorkflowToolExecutor(f.options);
    await assert.rejects(executor.close(), /shell still active/);
});
test("effective exclusions apply to capture and invocation, including MCP aliases", () => {
    assert.deepEqual(captureWorkflowTools(metadata, ["bash", "facts/read"]).map(tool => tool.name), ["view"]);
    assert.throws(() => resolveWorkflowTool("bash", captureWorkflowTools(metadata), metadata, ["bash"]), /not uniquely admitted/);
});
test("workflow permission handling permits ordinary tools but rejects sampling and unknown kinds", () => {
    for (const request of [{ kind: "read" }, { kind: "write" }, { kind: "shell", commands: [] },
        { kind: "mcp", serverName: "example", toolName: "read" }, { kind: "custom-tool", toolName: "echo" }]) {
        assert.equal(workflowToolPermission(request).kind, "approve-once");
    }
    for (const request of [{ kind: "mcp-sampling", serverName: "example" }, { kind: "future" }, undefined]) {
        assert.equal(workflowToolPermission(request).kind, "reject");
    }
});
test("attached shells remain usable; detached shells cannot outlive a workflow state", () => {
    assert.doesNotThrow(() => validateWorkflowToolArguments("bash", { mode: "async", detach: false }));
    assert.throws(() => validateWorkflowToolArguments("bash", { mode: "async", detach: true }), /remain attached/);
});
test("close during authorization registers and aborts the call without executing it", async () => {
    let authorize;
    const f = fixture({ authorize: () => new Promise(resolve => { authorize = resolve; }) });
    let aborts = 0;
    f.session.abort = async () => { aborts++; authorize(); };
    const executor = await createWorkflowToolExecutor(f.options);
    const call = executor.call("bash", {});
    const rejected = assert.rejects(call, /cancelled/);
    await executor.close();
    await rejected;
    assert.equal(aborts, 1);
    assert.equal(f.calls.length, 0);
    assert.equal(f.disposed, 1);
});
// A close aborts a call that runs, waits for it (bounded by the cleanup deadline), and only then disposes (E1b, G1b); the
// call settles with its own outcome. Here only the disposal ends the native call, so the wait reaches its deadline.
test("abort failure still disposes and waits for the active call", async () => {
    let finish;
    const f = fixture({ cleanupTimeoutMs: 50 });
    f.session.rpc.tools.execute = () => new Promise(resolve => { finish = resolve; });
    f.session.abort = async () => { throw new Error("abort failed"); };
    let disposed = 0;
    f.options.dispose = async () => { disposed++; finish({ resultType: "success", textResultForLlm: "stopped" }); };
    const executor = await createWorkflowToolExecutor(f.options);
    const call = executor.call("bash", {});
    const outcome = call.then(value => ({ value }), error => ({ error }));
    for (let i = 0; i < 50 && !finish; i += 1) await Promise.resolve();
    assert.equal(typeof finish, "function", "the native call runs");
    await assert.rejects(executor.close(), /abort failed/);
    assert.deepEqual(await outcome, { value: "stopped" });
    assert.equal(disposed, 1);
});
test("a hung abort has a bounded close and does not skip disposal", async () => {
    let finish;
    const f = fixture({ cleanupTimeoutMs: 10 });
    f.session.rpc.tools.execute = () => new Promise(resolve => { finish = resolve; });
    f.session.abort = () => new Promise(() => {});
    f.options.dispose = async () => { finish({ resultType: "success", textResultForLlm: "stopped" }); };
    const executor = await createWorkflowToolExecutor(f.options);
    const call = executor.call("bash", {});
    const outcome = call.then(value => ({ value }), error => ({ error }));
    for (let i = 0; i < 50 && !finish; i += 1) await Promise.resolve();
    assert.equal(typeof finish, "function", "the native call runs");
    await assert.rejects(executor.close(), /cleanup timed out/);
    assert.deepEqual(await outcome, { value: "stopped" });
});
// E1b (verification of RT-2) and G1b: on a shared session a call is checked when its turn comes. A close rejects a call
// that has not begun its turn at once ("closed"); a call whose turn has begun settles with its own outcome: the close
// aborts it, waits for it, and only then disposes the handle.
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
function turnGate() {
    let open;
    const opened = new Promise(resolve => { open = resolve; });
    return { opened, open };
}
test("E1b: a call waiting for its turn never starts once its script ended", async () => {
    const f = fixture();
    const turn = turnGate();
    const stop = new AbortController();
    const executor = await createWorkflowToolExecutor({ ...f.options, serially: run => turn.opened.then(run), signal: stop.signal });
    const waiting = executor.call("bash", {});
    stop.abort();
    turn.open();
    await assert.rejects(waiting, /script ended/);
    assert.equal(f.authorized, 0);
    assert.equal(f.calls.length, 0);
    await assert.rejects(executor.call("bash", {}), /script ended/);
    await executor.close();
});
test("E1b: a close rejects a call still waiting for its turn at once, does not abort the session, and the turn runs nothing", async () => {
    const f = fixture();
    let aborted = 0;
    f.session.abort = async () => { aborted++; };
    const turn = turnGate();
    const outcomes = [];
    const executor = await createWorkflowToolExecutor({ ...f.options, serially: run => turn.opened.then(run), dispose: async outcome => { outcomes.push(outcome); } });
    const waiting = executor.call("bash", {});
    const refused = assert.rejects(waiting, /closed/);
    await executor.close();
    await refused;
    turn.open();
    await tick();
    assert.equal(aborted, 0);
    assert.equal(f.authorized, 0);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(outcomes, [{ settled: true }]);
});
test("E1b: a close aborts this handle's own running call and disposes it only after the call ended, or reports that it did not end", async () => {
    const f = fixture({ cleanupTimeoutMs: 20 });
    let aborted = 0;
    let finish;
    f.session.abort = async () => { aborted++; };
    f.session.rpc.tools.execute = () => new Promise(resolve => { finish = resolve; });
    const outcomes = [];
    const executor = await createWorkflowToolExecutor({ ...f.options, dispose: async outcome => { outcomes.push(outcome); } });
    const running = executor.call("bash", {});
    const runningOutcome = running.then(value => ({ value }), error => ({ error }));
    await tick();
    await assert.rejects(executor.close(), /timed out/);
    assert.equal(aborted, 1);
    assert.deepEqual(outcomes, [{ settled: false }]);
    // A call whose turn began is not turned away by the close: it settles with its own outcome.
    finish({ resultType: "success", textResultForLlm: "late" });
    assert.deepEqual(await runningOutcome, { value: "late" });

    const g = fixture();
    let release;
    g.session.rpc.tools.execute = () => new Promise(resolve => { release = resolve; });
    const order = [];
    g.session.abort = async () => { order.push("abort"); };
    const second = await createWorkflowToolExecutor({ ...g.options, dispose: async outcome => { order.push(`dispose:${outcome.settled}`); } });
    const call = second.call("bash", {});
    const callOutcome = call.then(value => ({ value }), error => ({ error }));
    await tick();
    const closing = second.close();
    await tick();
    assert.deepEqual(order, ["abort"], "not disposed while its call runs");
    release({ resultType: "success", textResultForLlm: "done" });
    await closing;
    assert.deepEqual(order, ["abort", "dispose:true"]);
    assert.deepEqual(await callOutcome, { value: "done" });
});

// E1c (E1b-R2): a shared check (the workflow session's failure barrier, a worker shutting down) refuses a call when its
// turn comes, after its authorization, and just before it runs.
test("E1b-R2: a shared check is made when a call's turn comes, after its authorization, and just before it runs", async () => {
    let blocked = false;
    const check = () => { if (blocked) throw new Error("Workflow executor requires recovery: a sibling's cleanup failed"); };
    // Raised during the authorization.
    const f = fixture({ authorize: async () => { blocked = true; } });
    const executor = await createWorkflowToolExecutor({ ...f.options, check });
    await assert.rejects(executor.call("bash", {}), /requires recovery/);
    assert.equal(f.calls.length, 0);
    await executor.close();
    // Raised while the call reads the tool catalog.
    blocked = false;
    const g = fixture();
    const second = await createWorkflowToolExecutor({ ...g.options, check });
    const read = g.session.rpc.tools.getCurrentMetadata;
    g.session.rpc.tools.getCurrentMetadata = async () => { blocked = true; return read(); };
    await assert.rejects(second.call("bash", {}), /requires recovery/);
    assert.equal(g.calls.length, 0);
    // Raised before the turn: the authorization is not even asked.
    const authorized = g.authorized;
    await assert.rejects(second.call("bash", {}), /requires recovery/);
    assert.equal(g.authorized, authorized);
    assert.equal(g.calls.length, 0);
    await second.close();
});

// FU-25 (stage 2.4): a call's real run window begins when its turn on the shared session begins, not when it was asked.
test("FU-25: the observer is told when the call's turn begins; a call that never gets its turn never tells it", async () => {
    const f = fixture();
    const turn = turnGate();
    const executor = await createWorkflowToolExecutor({ ...f.options, serially: run => turn.opened.then(run) });
    const seen = [];
    const asked = Date.now();
    const waiting = executor.call("bash", {}, { started: at => seen.push(at) });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(seen, [], "not before its turn");
    turn.open();
    assert.equal(await waiting, "native output");
    assert.equal(seen.length, 1);
    assert.ok(seen[0] >= asked + 25, "its start is its turn's, after the wait");
    // An observer that throws never fails the call.
    assert.equal(await executor.call("bash", {}, { started: () => { throw new Error("observer failed"); } }), "native output");
    // A call refused before its turn (the script ended) never starts.
    const g = fixture();
    const later = turnGate();
    const stop = new AbortController();
    const other = await createWorkflowToolExecutor({ ...g.options, serially: run => later.opened.then(run), signal: stop.signal });
    const never = [];
    const refused = other.call("bash", {}, { started: at => never.push(at) });
    stop.abort();
    later.open();
    await assert.rejects(refused, /script ended/);
    assert.deepEqual(never, []);
    await executor.close();
    await other.close();
});

test("FB-014: a workflow script's canvas writes need a live bridge and never reach native execution", async () => {
    for (const [name, args] of [["draw_canvas", { html: "<p>x</p>" }], ["update_canvas", { patch: { a: 1 }, slot: 1 }],
        ["canvas_kv", { op: "put", key: "app/x", value: 1 }]]) {
        assert.doesNotThrow(() => validateWorkflowToolArguments(name, args), `${name} ${JSON.stringify(args)}`);
    }
    const canvasMetadata = [...metadata, { name: "draw_canvas", description: "canvas", input_schema: { type: "object" } }];
    const f = fixture();
    f.options.grants = captureWorkflowTools(canvasMetadata);
    f.setMetadata(canvasMetadata);
    const executor = await createWorkflowToolExecutor(f.options);
    try {
        await assert.rejects(executor.call("draw_canvas", { html: "<p>x</p>" }), /needs a live agent session/);
        assert.deepEqual(f.calls, []);
    } finally {
        await executor.close();
    }
});
