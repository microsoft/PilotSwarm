import test from "node:test";
import assert from "node:assert/strict";
import {
    parseUpdateWorkflowArgs, readWorkflowFromTool, readWorkflowToolSpec, SEND_WORKFLOW_INPUT_TOOL_SPEC, sendWorkflowInputFromTool,
    updateWorkflowFromTool, updateWorkflowToolSpec,
} from "../../dist/workflow/tools.js";
import { WORKFLOW_DEFINITION_TOOL_SPEC, workflowDefinitionFromTool } from "../../dist/workflow/definition-tool.js";
import { COMPLETE_WORKFLOW_NODE_TOOL_SPEC, completeWorkflowNodeFromTool } from "../../dist/workflow/agent-node-service.js";
import { RESPOND_SESSION_REQUEST_TOOL_SPEC, respondSessionRequestFromTool } from "../../dist/workflow/request-service.js";

// The workflow tools' results say workflowId, runId and definitionId; their arguments are workflow_id, run_id and
// definition_id. A copied result key is refused by name before anything is looked up, never ignored (which read as
// "workflow_id is required" for a valid id or, for runId, acted on the live run).

const unused = new Proxy({}, { get: () => { throw new Error("a refused call must not reach the host"); } });
const refusal = text => JSON.parse(text);
const misnamed = (answer, pattern) => {
    assert.equal(answer.ok, false);
    assert.equal(answer.error.code, "WORKFLOW_COMMAND_INVALID");
    assert.match(answer.error.message, pattern);
};

test("read_workflow refuses workflowId and names workflow_id", async () => {
    misnamed(refusal(await readWorkflowFromTool({ workflowId: "wf-1" }, { callerSessionId: "s-1", host: unused })),
        /^Not an argument of read_workflow: workflowId \(did you mean workflow_id\?\)\. Its arguments are snake_case; only its results are camelCase\.$/);
});

test("update_workflow refuses a camelCase run id even when workflow_id is right", async () => {
    misnamed(refusal(await updateWorkflowFromTool({ workflow_id: "wf-1", operation: "pause", operation_id: "op-1", runId: "r-1" },
        { callerSessionId: "s-1", host: unused })), /^Not an argument of update_workflow: runId \(did you mean run_id\?\)\./);
});

test("send_workflow_input names every camelCase argument", async () => {
    misnamed(refusal(await sendWorkflowInputFromTool({ workflowId: "wf-1", operationId: "op-1", contract: "A@1", payload: {} },
        { callerSessionId: "s-1", host: unused })),
        /^Not arguments of send_workflow_input: workflowId \(did you mean workflow_id\?\), operationId \(did you mean operation_id\?\)\./);
});

test("workflow_definition, complete_workflow_node and respond_session_request refuse camelCase arguments too", async () => {
    misnamed(refusal(await workflowDefinitionFromTool({ operation: "read", definitionId: "d-1" }, { callerSessionId: "s-1", host: unused })),
        /^Not an argument of workflow_definition: definitionId \(did you mean definition_id\?\)\./);
    misnamed(refusal(await completeWorkflowNodeFromTool({ outcome: "done", operationId: "op-1" }, { callerSessionId: "s-1", store: unused })),
        /^Not an argument of complete_workflow_node: operationId \(did you mean operation_id\?\)\./);
    misnamed(refusal(await respondSessionRequestFromTool({ requestId: "q-1", operation_id: "op-1", response: {} }, { callerSessionId: "s-1", store: unused })),
        /^Not an argument of respond_session_request: requestId \(did you mean request_id\?\)\./);
});

test("nested camelCase stays the callee's to check", async () => {
    // agent_models takes reasoningEffort and contextTier inside; only top-level keys are refused here.
    const answer = refusal(await workflowDefinitionFromTool({ operation: "list", agent_models: { a: { reasoningEffort: "high" } } },
        { callerSessionId: "s-1", host: unused }));
    assert.doesNotMatch(answer.error?.message ?? "", /Not an argument/);
});

test("a missing required argument lists the keys that were received", () => {
    assert.throws(() => parseUpdateWorkflowArgs({ operation: "pause", operation_id: "op-1" }),
        error => error?.code === "WORKFLOW_COMMAND_INVALID" && /^workflow_id is required\. Received: operation, operation_id\.$/.test(error.message));
    assert.throws(() => parseUpdateWorkflowArgs({}),
        error => /^workflow_id is required\. Received no arguments\.$/.test(error.message));
});

test("every workflow tool declaration is closed: no argument outside its properties", () => {
    const specs = [WORKFLOW_DEFINITION_TOOL_SPEC, SEND_WORKFLOW_INPUT_TOOL_SPEC, COMPLETE_WORKFLOW_NODE_TOOL_SPEC, RESPOND_SESSION_REQUEST_TOOL_SPEC];
    for (const milestone of [false, true]) {
        for (const testMode of [false, true]) {
            specs.push(updateWorkflowToolSpec({ milestone, testMode }), readWorkflowToolSpec({ milestone, testMode }),
                readWorkflowToolSpec({ milestone, testMode, updateWorkflow: false }));
        }
    }
    for (const spec of specs) assert.equal(spec.parameters.additionalProperties, false, spec.description.slice(0, 60));
});
