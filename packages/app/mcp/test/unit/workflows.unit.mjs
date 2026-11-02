// Unit test: update_workflow, a person's workflow command over MCP (Workflow v2, INACTIVE).
//
// The tool is registered only when the server context enables workflow
// commands (test-only); it sends { session_id, command } to the management
// client's updateWorkflow and answers its receipt; every refusal with a code
// (an invalid command, the subtree denial, a 501 while the deployment has it
// off) answers in one JSON shape with its code, status and details.
//
// No DB, no SDK client: `mgmt` is a fake. Run after `npm run build:mcp`.
import assert from "node:assert/strict";
import { WorkflowCredentialVault } from "pilotswarm-sdk";
import { registerWorkflowTools } from "../../dist/src/tools/workflows.js";

const SID = "a7f23cda-5cfd-4f0e-aff1-d6b0400b8da5";

function toolsWith(ctx) {
    const handlers = new Map();
    const server = { registerTool: (name, _spec, handler) => { handlers.set(name, handler); } };
    registerWorkflowTools(server, ctx);
    return handlers;
}

// 1. Absent unless the context enables it.
assert.equal(toolsWith({ mgmt: {} }).has("update_workflow"), false, "absent by default");
assert.equal(toolsWith({ mgmt: {}, workflowCommands: false }).has("update_workflow"), false, "absent when off");

// 2. The command goes to the management client as it is; the receipt is the answer.
{
    const calls = [];
    const tool = toolsWith({ workflowCommands: true, mgmt: {
        updateWorkflow: async (sessionId, command, ...rest) => { calls.push([sessionId, command, rest.length]); return { operation: "pause", runId: "r1", status: "paused" }; },
    } }).get("update_workflow");
    const result = await tool({ session_id: SID, command: { operation: "pause", operation_id: "p-1" } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { operation: "pause", runId: "r1", status: "paused" });
    assert.deepEqual(calls, [[SID, { operation: "pause", operation_id: "p-1" }, 0]], "no actor is sent: the client stamps it");
}

// 3. Refusals with a code: one JSON shape, with status and details.
for (const [error, expected] of [
    [Object.assign(new Error("Session x runs a workflow state for workflow w: people cannot change its definition, inputs, runs or tests."),
        { code: "WORKFLOW_HUMAN_INPUT_DENIED", status: 403, details: { sessionId: SID, action: "workflow", controllingSessionId: "P" } }),
        { code: "WORKFLOW_HUMAN_INPUT_DENIED", status: 403, details: { sessionId: SID, action: "workflow", controllingSessionId: "P" } }],
    [Object.assign(new Error("This deployment does not take workflow commands from people yet."), { code: "WORKFLOW_COMMANDS_UNAVAILABLE", status: 501 }),
        { code: "WORKFLOW_COMMANDS_UNAVAILABLE", status: 501 }],
    [Object.assign(new Error("Workflow inputs do not match inputs.schema."), { code: "WORKFLOW_INPUT_INVALID", status: 422, details: [{ path: "$.since", message: "required" }] }),
        { code: "WORKFLOW_INPUT_INVALID", status: 422, details: [{ path: "$.since", message: "required" }] }],
]) {
    const tool = toolsWith({ workflowCommands: true, mgmt: { updateWorkflow: async () => { throw error; } } }).get("update_workflow");
    const result = await tool({ session_id: SID, command: { operation: "set_vars", operation_id: "k-1" } });
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), { error: error.message, session_id: SID, ...expected });
}

// 4. A bare 403 (the portal's session gate) and an error without a code keep the standard answers.
{
    const forbidden = toolsWith({ workflowCommands: true, mgmt: { updateWorkflow: async () => {
        throw Object.assign(new Error("Only the session owner or an admin can do this."), { code: "FORBIDDEN", status: 403 });
    } } }).get("update_workflow");
    const denied = await forbidden({ session_id: SID, command: { operation: "pause", operation_id: "p-2" } });
    assert.equal(denied.isError, true);
    assert.deepEqual(JSON.parse(denied.content[0].text), { error: "Only the session owner or an admin can do this.", status: 403, code: "FORBIDDEN" });
    const plain = toolsWith({ workflowCommands: true, mgmt: { updateWorkflow: async () => { throw new Error("boom"); } } }).get("update_workflow");
    const failed = await plain({ session_id: SID, command: { operation: "pause", operation_id: "p-3" } });
    assert.equal(failed.content[0].text, "Error: boom");
}

// 5. The credentialed tools: absent without a vault; the credential reaches only the management call, never a result.
{
    assert.equal(toolsWith({ mgmt: {} }).has("complete_workflow_node"), false, "absent without a vault");
    assert.equal(toolsWith({ mgmt: {} }).has("respond_session_request"), false, "absent without a vault");
    const issued = [];
    const vault = new WorkflowCredentialVault({
        holderSessionIds: [SID],
        issue: async (input) => {
            issued.push(input);
            return { token: `pswic_${String(issued.length).repeat(43)}`, credential: { credentialId: `c-${issued.length}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } };
        },
    });
    const calls = [];
    const mgmt = {
        completeWorkflowNode: async (sessionId, input) => {
            calls.push(["complete", sessionId, input]);
            if (input.output?.verdict === 5) throw Object.assign(new Error("The completion does not match the state's contract."), { code: "OUTPUT_INVALID", status: 422,
                details: { problems: [{ path: "$.verdict", message: "must be string" }] } });
            return { replayed: false, nodeExecutionId: "nx-1", outcome: "accepted" };
        },
        respondToSessionRequest: async (requestId, input) => { calls.push(["respond", requestId, input]); return { replayed: false, status: "responded" }; },
    };
    const tools = toolsWith({ mgmt, workflowCredentialVault: vault });
    assert.equal(tools.has("update_workflow"), false, "update_workflow keeps its own gate");
    const complete = tools.get("complete_workflow_node");
    const respond = tools.get("respond_session_request");
    const done = await complete({ session_id: SID, node_execution_id: "nx-1", operation_id: "op-1", outcome: "accepted", output: { verdict: "ok" } });
    assert.equal(done.isError, undefined);
    assert.deepEqual(JSON.parse(done.content[0].text), { replayed: false, nodeExecutionId: "nx-1", outcome: "accepted" });
    assert.deepEqual(calls[0].slice(0, 2), ["complete", SID]);
    assert.deepEqual({ ...calls[0][2], credential: undefined }, { nodeExecutionId: "nx-1", operationId: "op-1", outcome: "accepted", output: { verdict: "ok" }, credential: undefined });
    assert.match(calls[0][2].credential, /^pswic_/);
    assert.deepEqual(issued[0], { audience: "workflow.complete", nodeExecutionId: "nx-1", holderSessionId: SID });

    const refused = await complete({ session_id: SID, node_execution_id: "nx-2", operation_id: "op-2", outcome: "accepted", output: { verdict: 5 } });
    assert.equal(refused.isError, true);
    assert.deepEqual(JSON.parse(refused.content[0].text), { error: "The completion does not match the state's contract.", code: "OUTPUT_INVALID",
        session_id: SID, node_execution_id: "nx-2", status: 422, details: { problems: [{ path: "$.verdict", message: "must be string" }] } });

    const other = await complete({ session_id: "b8f23cda-5cfd-4f0e-aff1-d6b0400b8da5", node_execution_id: "nx-3", operation_id: "op-3", outcome: "accepted" });
    assert.equal(JSON.parse(other.content[0].text).code, "CREDENTIAL_HOLDER_NOT_SERVED");
    assert.equal(issued.length, 2, "nothing is issued for a session this server does not act for");

    const answered = await respond({ session_id: SID, request_id: "nx-9", operation_id: "op-4", decline: { reason: "not now" } });
    assert.deepEqual(JSON.parse(answered.content[0].text), { replayed: false, status: "responded" });
    assert.deepEqual({ ...calls.at(-1)[2], credential: undefined }, { operationId: "op-4", decline: { reason: "not now" }, credential: undefined });
    for (const result of [done, refused, other, answered]) assert.equal(/pswic_/.test(result.content[0].text), false, "no tool result carries a credential");
}

console.log("✅ update_workflow: registration gate, receipt and refusal shapes; credentialed tools keep the credential in the vault");
