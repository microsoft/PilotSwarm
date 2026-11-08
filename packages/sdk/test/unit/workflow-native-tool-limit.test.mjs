/**
 * Stage 2 review S2RT-F1: a Workflow agent state's tool limit (FU-17) binds the native workers its chat starts. With
 * `tools: [task, view, read_facts]` the agent may start a native task, but the worker may not run `bash` or a disallowed
 * MCP tool: their declarations are cut to the limit, and the child hook refuses the call. The state's own chat keeps
 * complete_workflow_node; a worker never gets it. Without a limit nothing changes.
 *
 * Run: node --test test/unit/workflow-native-tool-limit.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { limitNativeAgents, nativeSubagentDefinitions, nativeSubagentHooks, nativeWorkflowToolLimit, NATIVE_SUBAGENT_TOOLS }
    from "../../dist/native-subagents.js";

const PARENT = "parent-1";
const CHILD = "child-1";
const LIMIT = ["task", "view", "read_facts", "complete_workflow_node", "docs/search"];

test("the native workers' declarations are cut to the limit; without one they are as before", () => {
    const limit = nativeWorkflowToolLimit(LIMIT);
    for (const agent of nativeSubagentDefinitions("model-1", undefined, limit)) {
        assert.deepEqual(agent.tools, ["view"], agent.name);
    }
    for (const agent of nativeSubagentDefinitions("model-1")) {
        assert.deepEqual(agent.tools, NATIVE_SUBAGENT_TOOLS, `${agent.name} without a limit`);
    }
    // An adopted repository agent, and MCP grants: only what the limit names, by server/tool or server-tool.
    const [repo] = limitNativeAgents([{ name: "reviewer", prompt: "p", tools: ["view", "bash", "read_facts", "docs/search"],
        mcpServers: { docs: { tools: ["search", "write"] }, other: { tools: ["*"] } } }], limit);
    assert.deepEqual(repo.tools, ["view", "read_facts", "docs/search"]);
    assert.deepEqual(repo.mcpServers, { docs: { tools: ["search"] } });
    assert.equal(nativeWorkflowToolLimit(null), undefined);
    assert.equal(limit.allows("complete_workflow_node"), false, "a worker never finishes the state");
});

test("S2RT-F1: task is allowed to the state's chat; its worker's bash and a disallowed MCP tool are refused; an allowed read goes on", async () => {
    const hooks = nativeSubagentHooks("model-1", undefined, () => true, undefined, undefined, nativeWorkflowToolLimit(LIMIT));
    const pre = (sessionId, toolName, toolArgs = {}) => hooks.onPreToolUse({ sessionId, toolName, toolArgs }, { sessionId: PARENT });
    // The parent (the state's chat) starts a native task.
    const task = await pre(PARENT, "task", { agent_type: "swarm-task", prompt: "run it", mode: "sync" });
    assert.notEqual(task?.permissionDecision, "deny", JSON.stringify(task));
    // Its worker tries bash: refused, whatever it was declared.
    const bash = await pre(CHILD, "bash", { command: "rm -rf /tmp/x", mode: "sync" });
    assert.equal(bash.permissionDecision, "deny");
    assert.match(bash.permissionDecisionReason, /^This Workflow step limits its tools; a native task cannot use bash\./);
    for (const tool of ["powershell", "grep", "store_fact", "complete_workflow_node"]) {
        assert.equal((await pre(CHILD, tool)).permissionDecision, "deny", tool);
    }
    // An allowed read goes on.
    assert.notEqual((await pre(CHILD, "view", { path: "/x" }))?.permissionDecision, "deny");
    // MCP: an allowed tool goes on to the access check, a disallowed one is refused.
    await assert.rejects(hooks.onPreMcpToolCall({ sessionId: CHILD, serverName: "docs", toolName: "write" }, { sessionId: PARENT }),
        /limits its tools; a native task cannot use this MCP tool/);
    // The parent's own tools are its Copilot session's availableTools: the hook leaves them alone.
    assert.notEqual((await pre(PARENT, "complete_workflow_node"))?.permissionDecision, "deny");
    // Without a limit the worker's bash is as before.
    const open = nativeSubagentHooks("model-1", undefined, () => true);
    assert.notEqual((await open.onPreToolUse({ sessionId: CHILD, toolName: "bash", toolArgs: { mode: "sync" } }, { sessionId: PARENT }))?.permissionDecision, "deny");
});
