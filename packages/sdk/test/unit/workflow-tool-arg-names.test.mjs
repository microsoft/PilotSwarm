import test from "node:test";
import assert from "node:assert/strict";
import {
    parseUpdateWorkflowArgs, readWorkflowFromTool, sendWorkflowInputFromTool, updateWorkflowFromTool,
} from "../../dist/workflow/tools.js";

// Workflow tool results say workflowId and runId; the arguments are workflow_id and run_id. A copied result key is refused
// by name before any lookup, never ignored (which read as "workflow_id is required" or, for runId, acted on the live run).

const context = { callerSessionId: "caller-1", host: {} };
const refusal = text => JSON.parse(text);

test("read_workflow refuses workflowId and names workflow_id", async () => {
    const answer = refusal(await readWorkflowFromTool({ workflowId: "wf-1" }, context));
    assert.equal(answer.ok, false);
    assert.equal(answer.error.code, "WORKFLOW_COMMAND_INVALID");
    assert.match(answer.error.message, /workflowId \(use workflow_id\)/);
});

test("update_workflow refuses a camelCase run id even when workflow_id is right", async () => {
    const answer = refusal(await updateWorkflowFromTool({ workflow_id: "wf-1", operation: "pause", operation_id: "op-1", runId: "r-1" }, context));
    assert.equal(answer.error.code, "WORKFLOW_COMMAND_INVALID");
    assert.match(answer.error.message, /runId \(use run_id\)/);
});

test("send_workflow_input refuses camelCase keys and names each one", async () => {
    const answer = refusal(await sendWorkflowInputFromTool({ workflowId: "wf-1", operationId: "op-1", contract: "A@1", payload: {} }, context));
    assert.match(answer.error.message, /workflowId \(use workflow_id\), operationId \(use operation_id\)/);
});

test("a missing required argument lists the keys that were received", () => {
    assert.throws(() => parseUpdateWorkflowArgs({ operation: "pause", operation_id: "op-1" }),
        error => error?.code === "WORKFLOW_COMMAND_INVALID" && /^workflow_id is required\. Received: operation, operation_id\.$/.test(error.message));
    assert.throws(() => parseUpdateWorkflowArgs({}),
        error => /^workflow_id is required\. Received no arguments\.$/.test(error.message));
});
