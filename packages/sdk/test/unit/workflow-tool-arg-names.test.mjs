import test from "node:test";
import assert from "node:assert/strict";
import {
    parseUpdateWorkflowArgs, READ_WORKFLOW_ARGUMENTS, READ_WORKFLOW_TOOL_SPEC, readWorkflowFromTool, readWorkflowToolSpec,
    SEND_WORKFLOW_INPUT_ARGUMENTS, SEND_WORKFLOW_INPUT_TOOL_SPEC, sendWorkflowInputFromTool, UPDATE_WORKFLOW_ARGUMENTS,
    UPDATE_WORKFLOW_TOOL_SPEC, updateWorkflowFromTool, updateWorkflowToolSpec,
} from "../../dist/workflow/tools.js";
import { workflowToolArgumentMeant } from "../../dist/workflow/tool-args.js";
import { WORKFLOW_DEFINITION_ARGUMENTS, WORKFLOW_DEFINITION_TOOL_SPEC, workflowDefinitionFromTool } from "../../dist/workflow/definition-tool.js";
import { COMPLETE_WORKFLOW_NODE_ARGUMENTS, COMPLETE_WORKFLOW_NODE_TOOL_SPEC, completeWorkflowNodeFromTool } from "../../dist/workflow/agent-node-service.js";
import { RESPOND_SESSION_REQUEST_ARGUMENTS, RESPOND_SESSION_REQUEST_TOOL_SPEC, respondSessionRequestFromTool } from "../../dist/workflow/request-service.js";

// The workflow tools' results say workflowId and runId; their arguments are workflow_id and run_id. A misnamed argument
// was ignored before: "workflow_id is required" for a valid id, or a run id dropped so the command acted on the live run.
// Now a key with a capital letter, or one that plainly means an argument (runid, run-id), is refused before anything is read.

/** A host or store that records that the call got past the argument check, then fails it. */
function recording() {
    const seen = { reached: false };
    const stub = new Proxy({}, { get: () => { seen.reached = true; throw new Error("reached the host"); } });
    return { seen, stub };
}
const answerOf = text => JSON.parse(text);
const refused = (answer, code, pattern) => {
    assert.equal(answer.ok, false);
    assert.equal(answer.error.code, code);
    assert.match(answer.error.message, pattern);
};

const ALL = [UPDATE_WORKFLOW_ARGUMENTS, READ_WORKFLOW_ARGUMENTS, SEND_WORKFLOW_INPUT_ARGUMENTS, WORKFLOW_DEFINITION_ARGUMENTS,
    COMPLETE_WORKFLOW_NODE_ARGUMENTS, RESPOND_SESSION_REQUEST_ARGUMENTS];

function declarations() {
    const specs = [WORKFLOW_DEFINITION_TOOL_SPEC, SEND_WORKFLOW_INPUT_TOOL_SPEC, COMPLETE_WORKFLOW_NODE_TOOL_SPEC, RESPOND_SESSION_REQUEST_TOOL_SPEC];
    const byTool = new Map([[WORKFLOW_DEFINITION_TOOL_SPEC, WORKFLOW_DEFINITION_ARGUMENTS], [SEND_WORKFLOW_INPUT_TOOL_SPEC, SEND_WORKFLOW_INPUT_ARGUMENTS],
        [COMPLETE_WORKFLOW_NODE_TOOL_SPEC, COMPLETE_WORKFLOW_NODE_ARGUMENTS], [RESPOND_SESSION_REQUEST_TOOL_SPEC, RESPOND_SESSION_REQUEST_ARGUMENTS]]);
    const out = specs.map(spec => ({ spec, args: byTool.get(spec) }));
    for (const milestone of [false, true]) {
        for (const testMode of [false, true]) {
            out.push({ spec: updateWorkflowToolSpec({ milestone, testMode }), args: UPDATE_WORKFLOW_ARGUMENTS });
            out.push({ spec: readWorkflowToolSpec({ milestone, testMode }), args: READ_WORKFLOW_ARGUMENTS });
            out.push({ spec: readWorkflowToolSpec({ milestone, testMode, updateWorkflow: false }), args: READ_WORKFLOW_ARGUMENTS });
        }
    }
    return out;
}

test("every declared argument of every variant is accepted, snake_case, and passes the check", () => {
    for (const { spec, args } of declarations()) {
        for (const name of Object.keys(spec.parameters.properties)) {
            assert.ok(args.accepted.includes(name), `${args.tool} declares ${name} but does not accept it`);
            assert.match(name, /^[a-z][a-z0-9_]*$/, `${args.tool}.${name}`);
        }
    }
    for (const spec of ALL) for (const name of spec.accepted) assert.equal(workflowToolArgumentMeant(name, spec.accepted), name);
});

test("1.0.83 declarations are closed; the frozen 1.0.82 ones stay open, as their handlers take more than they declare", () => {
    for (const { spec } of declarations()) {
        const frozen = spec.parameters === UPDATE_WORKFLOW_TOOL_SPEC.parameters || spec.parameters === READ_WORKFLOW_TOOL_SPEC.parameters;
        assert.equal(spec.parameters.additionalProperties, frozen ? undefined : false, spec.description.slice(0, 60));
    }
    assert.ok(!("limit" in READ_WORKFLOW_TOOL_SPEC.parameters.properties) && READ_WORKFLOW_ARGUMENTS.accepted.includes("limit"));
});

test("a suggestion is always an argument the tool takes, or none", () => {
    const cases = [
        [READ_WORKFLOW_ARGUMENTS, "workflowId", "workflow_id"], [UPDATE_WORKFLOW_ARGUMENTS, "runId", "run_id"],
        [UPDATE_WORKFLOW_ARGUMENTS, "RUNID", "run_id"], [UPDATE_WORKFLOW_ARGUMENTS, "run-id", "run_id"], [UPDATE_WORKFLOW_ARGUMENTS, "runid", "run_id"],
        [UPDATE_WORKFLOW_ARGUMENTS, "kvRevision", "expected_kv_revision"], [READ_WORKFLOW_ARGUMENTS, "executionId", "execution_id"],
        [READ_WORKFLOW_ARGUMENTS, "includeYAML", "include_yaml"], [WORKFLOW_DEFINITION_ARGUMENTS, "definitionId", "definition_id"],
        [WORKFLOW_DEFINITION_ARGUMENTS, "workflowId", null], [UPDATE_WORKFLOW_ARGUMENTS, "revision", null],
        [COMPLETE_WORKFLOW_NODE_ARGUMENTS, "findingsCount", null], [READ_WORKFLOW_ARGUMENTS, "nodeExecutionId", null],
    ];
    for (const [spec, key, meant] of cases) {
        assert.equal(workflowToolArgumentMeant(key, spec.accepted), meant, `${spec.tool} ${key}`);
        if (meant) assert.ok(spec.accepted.includes(meant));
    }
});

test("read_workflow refuses workflowId and names workflow_id, before the host is read", async () => {
    const { seen, stub } = recording();
    refused(answerOf(await readWorkflowFromTool({ workflowId: "wf-1" }, { callerSessionId: "s-1", host: stub })), "WORKFLOW_COMMAND_INVALID",
        /^Use the argument names read_workflow declares \(snake_case; its results are camelCase\)\. Not an argument of read_workflow: workflowId \(did you mean workflow_id\?\)\.$/);
    assert.equal(seen.reached, false);
});

test("update_workflow refuses a misnamed run id in any spelling, so the live run is never touched", async () => {
    for (const key of ["runId", "RUNID", "runid", "run-id"]) {
        const { seen, stub } = recording();
        refused(answerOf(await updateWorkflowFromTool({ workflow_id: "wf-1", operation: "cancel", operation_id: "op-1", [key]: "r-1" },
            { callerSessionId: "s-1", host: stub })), "WORKFLOW_COMMAND_INVALID", new RegExp(`${key} \\(did you mean run_id\\?\\)`));
        assert.equal(seen.reached, false, key);
    }
});

test("send_workflow_input names every misnamed argument", async () => {
    refused(answerOf(await sendWorkflowInputFromTool({ workflowId: "wf-1", operationId: "op-1", contract: "A@1", payload: {} },
        { callerSessionId: "s-1", host: recording().stub })), "WORKFLOW_COMMAND_INVALID",
        /Not arguments of send_workflow_input: workflowId \(did you mean workflow_id\?\), operationId \(did you mean operation_id\?\)\.$/);
});

test("workflow_definition, complete_workflow_node and respond_session_request refuse in their own codes and words", async () => {
    refused(answerOf(await workflowDefinitionFromTool({ operation: "read", definitionId: "d-1" }, { callerSessionId: "s-1", host: recording().stub })),
        "WORKFLOW_COMMAND_INVALID", /definitionId \(did you mean definition_id\?\)/);
    refused(answerOf(await completeWorkflowNodeFromTool({ outcome: "done", operation_id: "op-1", findingsCount: 3 },
        { callerSessionId: "s-1", store: recording().stub })), "COMPLETION_INVALID", /findingsCount \(a field of output goes inside output\)/);
    refused(answerOf(await respondSessionRequestFromTool({ requestId: "q-1", operation_id: "op-1", response: {} },
        { callerSessionId: "s-1", store: recording().stub })), "RESPONSE_INVALID", /requestId \(did you mean request_id\?\)/);
});

test("nested camelCase and unrelated lowercase keys pass the check and reach the handler", async () => {
    const { seen, stub } = recording();
    await workflowDefinitionFromTool({ operation: "list", agent_models: { a: { reasoningEffort: "high" } }, note: "x" }, { callerSessionId: "s-1", host: stub });
    assert.equal(seen.reached, true);
    const node = recording();
    await completeWorkflowNodeFromTool({ outcome: "done", operation_id: "op-1", output: { findingsCount: 3 } }, { callerSessionId: "s-1", store: node.stub });
    assert.equal(node.seen.reached, true);
});

test("a missing required argument in an agent call lists the keys received; a person's command is unchanged", async () => {
    refused(answerOf(await readWorkflowFromTool({ run_id: "r-1" }, { callerSessionId: "s-1", host: recording().stub })), "WORKFLOW_COMMAND_INVALID",
        /^workflow_id is required\. Received: run_id\.$/);
    refused(answerOf(await respondSessionRequestFromTool({}, { callerSessionId: "s-1", store: recording().stub })), "RESPONSE_INVALID",
        /^request_id is required\. Received no arguments\.$/);
    // The shared parser a person's command uses keeps its words.
    assert.throws(() => parseUpdateWorkflowArgs({ workflow_id: "wf-1", operation: "pause" }), error => error.message === "operation_id is required.");
});

test("refusals show at most 8 names, each at most 64 characters, and stay well inside the 2,000-character reply", async () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`keyNumber${i}${"X".repeat(70)}`, i]));
    const answer = answerOf(await readWorkflowFromTool(many, { callerSessionId: "s-1", host: recording().stub }));
    assert.match(answer.error.message, / and 22 more\.$/);
    assert.ok(answer.error.message.length < 1_000, String(answer.error.message.length));
    assert.ok(!answer.error.message.includes("X".repeat(60)));
});
