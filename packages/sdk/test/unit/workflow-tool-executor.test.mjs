import test from "node:test";
import assert from "node:assert/strict";
import { captureWorkflowTools, isWorkflowControlTool, resolveWorkflowTool, validateWorkflowToolArguments, workflowToolPermission } from "../../dist/workflow/tool-policy.js";
import { createWorkflowToolExecutor, workflowToolResult } from "../../dist/workflow/tool-executor.js";
import { compileWorkflow, validateNodeWorkflowAdmission } from "../../dist/workflow/compiler.js";

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

for (const name of ["wait", "cron_at", "spawn_agent", "task", "tools/spawn_workflow", "session.create_session", "use_package"]) {
    test(`workflow control is excluded: ${name}`, () => assert.equal(isWorkflowControlTool(name), true));
}
for (const name of ["bash", "view", "apply_patch", "rg", "read_bash", "stop_bash", "facts/read"]) {
    test(`ordinary tool remains eligible: ${name}`, () => assert.equal(isWorkflowControlTool(name), false));
}
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
test("new admission is Node-only without invalidating old compiled documents", () => {
    for (const runtime of ["node", "python", "powershell"]) {
        const workflow = compileWorkflow(`
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: example, version: 1.0.0 }
initial: run
states:
  run:
    type: script
    runtime: ${runtime}
    source: "legacy source retained"
    completion: { outcomes: [done] }
    transition: { next: { done: end } }
  end: { type: terminal, outcome: succeeded }
`);
        assert.equal(workflow.states.run.runtime, runtime);
        if (runtime === "node") assert.doesNotThrow(() => validateNodeWorkflowAdmission(workflow));
        else assert.throws(() => validateNodeWorkflowAdmission(workflow), { code: "WORKFLOW_RUNTIME_UNSUPPORTED" });
    }
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
