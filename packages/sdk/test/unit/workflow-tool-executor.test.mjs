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
test("abort failure still disposes and waits for the active call", async () => {
    let finish;
    const f = fixture();
    f.session.rpc.tools.execute = () => new Promise(resolve => { finish = resolve; });
    f.session.abort = async () => { throw new Error("abort failed"); };
    let disposed = 0;
    f.options.dispose = async () => { disposed++; finish({ resultType: "success", textResultForLlm: "stopped" }); };
    const executor = await createWorkflowToolExecutor(f.options);
    const call = executor.call("bash", {});
    await Promise.resolve();
    await Promise.resolve();
    await assert.rejects(executor.close(), /abort failed/);
    assert.equal(await call, "stopped");
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
    await Promise.resolve();
    await Promise.resolve();
    await assert.rejects(executor.close(), /cleanup timed out/);
    assert.equal(await call, "stopped");
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
