/**
 * Workflow tools: tools(workflow) = tools(parent) − the excluded list, run
 * through a CLI tool session with no model. The policy (excluded list,
 * argument guards, permissions, the soft redeploy rule) and the executor
 * against a fake CLI session. Some cases follow Affan Dar's tests for his
 * parent-native executor.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    WORKFLOW_EXCLUDED_TOOL_GROUPS,
    captureWorkflowTools,
    isWorkflowControlTool,
    readWorkflowToolBinding,
    resolveWorkflowTool,
    validateWorkflowToolArguments,
    workflowExcludedGroup,
    workflowToolPermission,
} from "../../dist/workflow/tool-policy.js";
import { createWorkflowToolExecutor, workflowToolResult } from "../../dist/workflow/tool-executor.js";

const metadata = [
    { name: "bash", description: "shell", input_schema: { type: "object" } },
    { name: "view", description: "read", input_schema: { type: "object" } },
    { name: "store_fact", description: "facts", input_schema: { type: "object" } },
    { name: "facts-read", namespacedName: "facts/read", mcpServerName: "facts", mcpToolName: "read", description: "facts", input_schema: { type: "object" } },
    { name: "ops-wait", namespacedName: "ops/wait", mcpServerName: "ops", mcpToolName: "wait", description: "an MCP tool named wait" },
    { name: "spawn_workflow", description: "control" },
    { name: "cron", description: "control" },
];

function fixture(overrides = {}) {
    let active = metadata;
    const calls = [];
    const authorized = [];
    let disposed = 0;
    const session = {
        rpc: { tools: {
            initializeAndValidate: async () => ({}),
            getCurrentMetadata: async () => ({ tools: active }),
            execute: async (call) => { calls.push(call); return { resultType: "success", textResultForLlm: "native output" }; },
        } },
        abort: async () => undefined,
    };
    return {
        calls, session, authorized,
        setMetadata: (value) => { active = value; },
        get disposed() { return disposed; },
        options: {
            session, grants: captureWorkflowTools(metadata), invocationPrefix: "workflow/state/attempt",
            authorize: async (tool) => { authorized.push(tool); }, dispose: async () => { disposed++; }, ...overrides,
        },
    };
}

// ── The excluded list ─────────────────────────────────────────────────

for (const name of ["wait", "wait_on_worker", "cron", "cron_at", "spawn_agent", "spawn_workflow", "task", "ask_user",
    "set_session_model", "use_package", "load_agent", "set_session_workspace", "context_health", "execute_sampling",
    "regenerate_context", "delete_agent", "factory_run", "schedule_create", "session.schedule_list"]) {
    test(`excluded from workflow scripts: ${name}`, () => assert.equal(isWorkflowControlTool(name), true));
}
for (const name of ["tools/spawn_workflow", "session.create_session", "github/cron", "ops.wait"]) {
    test(`excluded by its last segment (namespaced or MCP alias): ${name}`, () => assert.equal(isWorkflowControlTool(name), true));
}
for (const name of ["bash", "view", "edit", "rg", "read_bash", "stop_bash", "store_fact", "facts/read", "send_session_message", "load_skill"]) {
    test(`allowed for workflow scripts: ${name}`, () => assert.equal(isWorkflowControlTool(name), false));
}

test("every excluded group says why, and a group lookup names it", () => {
    for (const [group, entry] of Object.entries(WORKFLOW_EXCLUDED_TOOL_GROUPS)) {
        assert.ok(entry.reason.length > 10, group);
        for (const tool of entry.tools) assert.equal(workflowExcludedGroup(tool), group, tool);
    }
    assert.equal(workflowExcludedGroup("bash"), null);
});

test("capture keeps the parent's tools minus the excluded list, an MCP tool named like a control, and the parent's own exclusions", () => {
    assert.deepEqual(captureWorkflowTools(metadata).map((tool) => tool.name), ["bash", "view", "store_fact", "facts-read"]);
    assert.deepEqual(captureWorkflowTools(metadata, ["bash", "facts/read"]).map((tool) => tool.name), ["view", "store_fact"]);
    const grant = captureWorkflowTools(metadata).find((tool) => tool.name === "facts-read");
    assert.deepEqual({ ...grant, schemaHash: undefined }, { name: "facts-read", namespacedName: "facts/read", mcpServerName: "facts", mcpToolName: "read", schemaHash: undefined });
    assert.match(grant.schemaHash, /^[0-9a-f]{64}$/);
});

test("a script names a tool by its CLI name, namespaced name or <server>/<tool>", () => {
    const grants = captureWorkflowTools(metadata);
    assert.equal(resolveWorkflowTool("facts/read", grants, metadata).name, "facts-read");
    assert.equal(resolveWorkflowTool("facts-read", grants, metadata).name, "facts-read");
    assert.throws(() => resolveWorkflowTool("spawn_workflow", grants, metadata), { code: "WORKFLOW_TOOL_EXCLUDED" });
    assert.throws(() => resolveWorkflowTool("ops/wait", grants, metadata), { code: "WORKFLOW_TOOL_EXCLUDED" });
    assert.throws(() => resolveWorkflowTool("new-tool", grants, [...metadata, { name: "new-tool" }]), { code: "WORKFLOW_TOOL_NOT_GRANTED" });
    assert.throws(() => resolveWorkflowTool("bash", grants, metadata, ["bash"]), { code: "WORKFLOW_TOOL_NOT_GRANTED" });
    assert.throws(() => resolveWorkflowTool("spawn_workflow", grants, metadata), /^Error: WORKFLOW_TOOL_EXCLUDED|WORKFLOW_TOOL_EXCLUDED: Tool 'spawn_workflow' is excluded from workflow scripts: a script cannot start or manage agents or workflows\./);
});

// ── The soft redeploy rule ────────────────────────────────────────────

test("a changed schema or a new package version does not refuse the call; it runs against the current tool", () => {
    const grants = captureWorkflowTools(metadata);
    const changed = [{ ...metadata[0], description: "shell v2", input_schema: { type: "object", properties: { command: { type: "string" } } } }];
    assert.equal(resolveWorkflowTool("bash", grants, changed), changed[0]);
    const movedNamespace = [{ ...metadata[3], namespacedName: "facts.read" }];
    assert.equal(resolveWorkflowTool("facts-read", grants, movedNamespace), movedNamespace[0]);
});

test("a tool that is no longer offered is refused", () => {
    const grants = captureWorkflowTools(metadata);
    assert.throws(() => resolveWorkflowTool("bash", grants, metadata.filter((tool) => tool.name !== "bash")), { code: "WORKFLOW_TOOL_UNAVAILABLE" });
    assert.throws(() => resolveWorkflowTool("facts/read", grants, [{ ...metadata[3], mcpServerName: "other" }]), { code: "WORKFLOW_TOOL_UNAVAILABLE" });
});

// ── Argument guards and permissions ──────────────────────────────────

test("canvas tools are allowed except writes to the workflow's own live slot", () => {
    const own = { workflowSessionId: "wf-1" };
    const refused = { code: "WORKFLOW_TOOL_ARGUMENTS_REFUSED", message: /slot 1 shows this workflow's live diagram/ };
    assert.throws(() => validateWorkflowToolArguments("draw_canvas", { html: "<p/>" }, own), refused);
    assert.throws(() => validateWorkflowToolArguments("draw_canvas", { html: "<p/>", slot: 1 }, own), refused);
    assert.throws(() => validateWorkflowToolArguments("update_canvas", { patch: {}, slot: "1", session_id: "session-wf-1" }, own), refused);
    assert.throws(() => validateWorkflowToolArguments("canvas_kv", { op: "put", key: "a", value: 1 }, own), refused);
    assert.throws(() => validateWorkflowToolArguments("canvas_kv", { op: "delete", key: "a", session_id: "wf-1" }, own), refused);
    assert.doesNotThrow(() => validateWorkflowToolArguments("draw_canvas", { html: "<p/>", slot: 2 }, own));
    assert.doesNotThrow(() => validateWorkflowToolArguments("update_canvas", { patch: {}, slot: 5 }, own));
    assert.doesNotThrow(() => validateWorkflowToolArguments("draw_canvas", { html: "<p/>", session_id: "session-parent" }, own));
    assert.doesNotThrow(() => validateWorkflowToolArguments("canvas_kv", { op: "put", key: "a", value: 1, session_id: "parent" }, own));
    assert.doesNotThrow(() => validateWorkflowToolArguments("canvas_kv", { op: "get", key: "a" }, own));
    assert.doesNotThrow(() => validateWorkflowToolArguments("canvas_kv", { op: "list" }, own));
    assert.doesNotThrow(() => validateWorkflowToolArguments("read_canvas", { slot: 1 }, own));
    assert.doesNotThrow(() => validateWorkflowToolArguments("show_canvas", { slot: 1 }, own));
});

test("argument guards: no detached shell, no skill loading by path, no awaited replies", () => {
    assert.doesNotThrow(() => validateWorkflowToolArguments("bash", { command: "ls", mode: "async", detach: false }));
    assert.throws(() => validateWorkflowToolArguments("bash", { command: "x", mode: "async", detach: true }), { code: "WORKFLOW_TOOL_ARGUMENTS_REFUSED" });
    assert.throws(() => validateWorkflowToolArguments("powershell", { command: "x", detach: true }), { code: "WORKFLOW_TOOL_ARGUMENTS_REFUSED" });
    assert.doesNotThrow(() => validateWorkflowToolArguments("load_skill", { name: "notes" }));
    assert.throws(() => validateWorkflowToolArguments("load_skill", { path: "skills/x" }), { code: "WORKFLOW_TOOL_ARGUMENTS_REFUSED" });
    assert.throws(() => validateWorkflowToolArguments("load_skill", { unload: "x" }), { code: "WORKFLOW_TOOL_ARGUMENTS_REFUSED" });
    assert.doesNotThrow(() => validateWorkflowToolArguments("send_session_message", { session_id: "a", body: "b" }));
    assert.throws(() => validateWorkflowToolArguments("send_session_message", { expects_response: true }), { code: "WORKFLOW_TOOL_ARGUMENTS_REFUSED" });
});

test("the permission handler allows ordinary tool permissions and rejects sampling and unknown kinds", () => {
    for (const request of [{ kind: "read" }, { kind: "write" }, { kind: "shell", commands: [] },
        { kind: "mcp", serverName: "example", toolName: "read" }, { kind: "custom-tool", toolName: "echo" }, { kind: "url", url: "https://example.invalid" }]) {
        assert.equal(workflowToolPermission(request).kind, "approve-once", JSON.stringify(request));
    }
    for (const request of [{ kind: "mcp-sampling", serverName: "example" }, { kind: "future" }, undefined]) {
        assert.equal(workflowToolPermission(request).kind, "reject", JSON.stringify(request));
    }
});

// ── The executor ──────────────────────────────────────────────────────

test("the executor sends no prompt, checks authority for every call, and runs calls in order", async () => {
    const f = fixture();
    const executor = await createWorkflowToolExecutor(f.options);
    assert.equal(await executor.call("bash", { command: "printf ok" }), "native output");
    await executor.call("facts/read", {});
    assert.deepEqual(f.authorized, [{ name: "bash" }, { name: "facts-read", mcpServerName: "facts" }]);
    assert.deepEqual(f.calls.map((call) => call.name), ["bash", "facts-read"]);
    assert.notEqual(f.calls[0].toolCallId, f.calls[1].toolCallId);
    assert.equal("send" in f.session, false);
    await executor.close();
    await executor.close();
    assert.equal(f.disposed, 1);
    await assert.rejects(executor.call("view", {}), { code: "WORKFLOW_STATE_STOPPING" });
});

test("concurrent calls from a script run one at a time instead of failing", async () => {
    const f = fixture();
    let running = 0, most = 0;
    f.session.rpc.tools.execute = async (call) => {
        running++; most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        return { resultType: "success", textResultForLlm: call.toolCallId };
    };
    const executor = await createWorkflowToolExecutor(f.options);
    const results = await Promise.all([executor.call("bash", {}), executor.call("view", {}), executor.call("store_fact", {})]);
    assert.equal(most, 1);
    assert.deepEqual(results, ["workflow/state/attempt/1", "workflow/state/attempt/2", "workflow/state/attempt/3"]);
    await executor.close();
});

test("an excluded tool and a refused argument never reach the CLI", async () => {
    const f = fixture();
    const executor = await createWorkflowToolExecutor(f.options);
    await assert.rejects(executor.call("spawn_agent", { task: "x" }), { code: "WORKFLOW_TOOL_EXCLUDED" });
    await assert.rejects(executor.call("cron", { seconds: 60 }), { code: "WORKFLOW_TOOL_EXCLUDED" });
    await assert.rejects(executor.call("bash", { command: "sleep 1", detach: true }), { code: "WORKFLOW_TOOL_ARGUMENTS_REFUSED" });
    assert.equal(f.calls.length, 0);
    await executor.close();
});

test("an uninitialized tool catalog fails instead of falling back to generic tools", async () => {
    const f = fixture();
    f.setMetadata(null);
    await assert.rejects(createWorkflowToolExecutor(f.options), /did not initialize/);
});

test("a refused authority check stops the call before the CLI runs it", async () => {
    const f = fixture({ authorize: async () => { throw Object.assign(new Error("revoked"), { code: "WORKFLOW_CAPABILITY_REVOKED" }); } });
    const executor = await createWorkflowToolExecutor(f.options);
    await assert.rejects(executor.call("bash", {}), /revoked/);
    assert.equal(f.calls.length, 0);
    await executor.close();
});

test("calls count against the state's limit even when refused", async () => {
    const f = fixture({ maxCalls: 1, authorize: async () => { throw new Error("revoked"); } });
    const executor = await createWorkflowToolExecutor(f.options);
    await assert.rejects(executor.call("bash", {}), /revoked/);
    await assert.rejects(executor.call("bash", {}), { code: "WORKFLOW_TOOL_LIMIT" });
    await executor.close();
});

test("a tool removed from the live catalog is refused as unavailable", async () => {
    const f = fixture();
    const executor = await createWorkflowToolExecutor(f.options);
    f.setMetadata([]);
    await assert.rejects(executor.call("bash", {}), { code: "WORKFLOW_TOOL_UNAVAILABLE" });
    await executor.close();
});

test("results: structured content when the tool has it, text otherwise, and failures throw", () => {
    assert.deepEqual(workflowToolResult({ resultType: "success", textResultForLlm: "display", structuredContent: { count: 2 } }), { count: 2 });
    assert.equal(workflowToolResult({ resultType: "success", textResultForLlm: '{"count":2}' }), '{"count":2}');
    assert.equal(workflowToolResult({ resultType: "success", textResultForLlm: "42", contents: [{ type: "text", text: "42" }], binaryResultsForLlm: [] }), "42");
    const image = { type: "image", data: "x", mimeType: "image/png" };
    assert.deepEqual(workflowToolResult({ resultType: "success", textResultForLlm: "pic", contents: [image] }), { text: "pic", contents: [image] });
    for (const resultType of ["failure", "denied", "timeout", "rejected"]) {
        assert.throws(() => workflowToolResult({ resultType, textResultForLlm: "not executed" }), /not executed/);
    }
});

test("close aborts the running call, disposes the session and waits for the call to settle", async () => {
    let finish;
    const f = fixture();
    f.session.rpc.tools.execute = () => new Promise((resolve) => { finish = resolve; });
    let aborts = 0;
    f.session.abort = async () => { aborts++; };
    f.options.dispose = async () => { finish({ resultType: "success", textResultForLlm: "stopped" }); };
    const executor = await createWorkflowToolExecutor(f.options);
    const call = executor.call("bash", { command: "sleep 100" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await executor.close();
    assert.equal(aborts, 1);
    assert.equal(await call, "stopped");
});

test("cleanup errors are reported, and a hung abort has a bounded close that still disposes", async () => {
    const failing = fixture({ dispose: async () => { throw new Error("shell still active"); } });
    await assert.rejects((await createWorkflowToolExecutor(failing.options)).close(), /shell still active/);

    let finish, disposed = 0;
    const hung = fixture({ cleanupTimeoutMs: 10 });
    hung.session.rpc.tools.execute = () => new Promise((resolve) => { finish = resolve; });
    hung.session.abort = () => new Promise(() => {});
    hung.options.dispose = async () => { disposed++; finish({ resultType: "success", textResultForLlm: "stopped" }); };
    const executor = await createWorkflowToolExecutor(hung.options);
    const call = executor.call("bash", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(executor.close(), /cleanup timed out/);
    assert.equal(disposed, 1);
    assert.equal(await call, "stopped");
});

test("a saved binding is read back, and a malformed one is refused", () => {
    const binding = { policy: "parent-tools-v1", parentSessionId: "p", owner: { provider: "dev", subject: "a" }, config: {},
        capabilities: { revision: 0, selections: [] }, tools: [{ name: "bash", schemaHash: "h" }], excludedTools: [] };
    assert.equal(readWorkflowToolBinding(binding), binding);
    assert.equal(readWorkflowToolBinding(undefined), null);
    assert.throws(() => readWorkflowToolBinding({ ...binding, policy: "node-parent-tools-v1" }), /Invalid saved workflow tool binding/);
    assert.throws(() => readWorkflowToolBinding({ ...binding, tools: [{ name: "bash" }] }), /Invalid/);
});
