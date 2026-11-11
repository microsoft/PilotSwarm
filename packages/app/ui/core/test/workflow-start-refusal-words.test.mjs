/**
 * UXFD (C): a refused Start reads in plain words, the same in the Start dialog and in the session's answer. The server's
 * schema problems (WORKFLOW_INPUT_INVALID's details, schema-words.ts in the SDK) name their place ("model is required");
 * the dialog shows "Start refused: <the problems, joined by '; '>", without the schema's name or any JSON.
 *
 * Run: node --test ui/core/test/workflow-start-refusal-words.test.mjs (after the SDK build: it reads packages/sdk/dist)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { workflowProblemText, workflowRunCommandFailure, workflowRunCommandNotice } from "../src/workflow-commands.js";
import { workflowRefusalText } from "../src/workflow-words.js";
import { WorkflowSchemaSet } from "../../../../sdk/dist/workflow/schema.js";
import { WorkflowStoreError } from "../../../../sdk/dist/workflow/store.js";
import { workflowToolErrorPayload } from "../../../../sdk/dist/workflow/tools.js";

const INPUTS = {
    type: "object", required: ["model", "sessions", "topic"], additionalProperties: false,
    properties: {
        model: { type: "string" },
        sessions: { type: "array", minItems: 6, uniqueItems: true, items: { type: "string" } },
        topic: { type: "string", minLength: 3 },
        mode: { enum: ["fast", "slow"] },
        count: { type: "number" },
    },
};
// What the server answers a Start whose inputs do not match (service.ts validateRunInputs), as the browser gets it.
function refusal(inputs) {
    const problems = new WorkflowSchemaSet({ Inputs: INPUTS }).validate("Inputs", inputs);
    const error = new WorkflowStoreError("WORKFLOW_INPUT_INVALID", "Workflow inputs do not match inputs.schema.",
        problems.map(problem => ({ path: problem.path, message: problem.message })));
    return { error, http: Object.assign(new Error(error.message), { status: 422, code: error.code, details: error.details }) };
}
const dialogText = failure => workflowRefusalText("Start refused", failure.message, "the Workflow was not started.");

test("the Start dialog reads the problems in plain words, joined by '; ', with no JSON and no schema name", () => {
    const { http } = refusal({ sessions: ["a", "b", "a"], topic: "ab" });
    const failure = workflowRunCommandFailure(http);
    assert.equal(failure.phase, "failed");
    assert.equal(failure.code, "WORKFLOW_INPUT_INVALID");
    assert.equal(dialogText(failure),
        "Start refused: model is required; sessions needs at least 6 items; items 1 and 3 of sessions are the same; and 1 more.");
    assert.doesNotMatch(dialogText(failure), /[{}"]|inputs\.schema|limit|missingProperty/);
    // The same words where the refusal is a notice beside the graph.
    assert.equal(workflowRunCommandNotice({ operation: "start", phase: "failed", message: failure.message }).text, dialogText(failure));
});

test("one problem, a type and an enum: each names its field", () => {
    assert.equal(dialogText(workflowRunCommandFailure(refusal({ model: "m", sessions: ["1", "2", "3", "4", "5", "6"], topic: "abc", count: "3" }).http)),
        "Start refused: count must be a number.");
    assert.equal(dialogText(workflowRunCommandFailure(refusal({ model: "m", sessions: ["1", "2", "3", "4", "5", "6"], topic: "abc", mode: "x", extra: 1 }).http)),
        "Start refused: extra is not a known field; mode must be one of the allowed values.");
});

test("the session's start refusal (the workflow_definition answer) carries the same words as the dialog", () => {
    const { error, http } = refusal({ sessions: [], topic: "x" });
    const answer = JSON.parse(workflowToolErrorPayload(error));
    assert.equal(answer.ok, false);
    assert.equal(answer.error.code, "WORKFLOW_INPUT_INVALID");
    const words = answer.error.details.map(item => item.message);
    assert.deepEqual(words, ["model is required", "sessions needs at least 6 items", "topic needs at least 3 characters"]);
    assert.equal(dialogText(workflowRunCommandFailure(http)), `Start refused: ${words.join("; ")}.`);
    assert.ok(!JSON.stringify(answer.error.details).includes("{\\\""), "no JSON inside a message");
});

test("words that name no place (an older server's Ajv words) keep their place and the refusal's own message", () => {
    assert.equal(workflowProblemText({ path: "/repo", message: "must be string" }), "/repo: must be string");
    assert.equal(workflowProblemText({ path: "/", message: "is required" }), "/: is required");
    assert.equal(workflowProblemText({ path: "/repo", message: "repo must be text." }), "repo must be text");
    const old = workflowRunCommandFailure(Object.assign(new Error("Workflow inputs do not match inputs.schema."),
        { status: 422, code: "WORKFLOW_INPUT_INVALID", details: [{ path: "/repo", message: "must be string" }] }));
    assert.equal(old.message, "Workflow inputs do not match inputs.schema. /repo: must be string");
    // Another refusal keeps its own message before the problems' words.
    const answer = workflowRunCommandFailure(Object.assign(new Error("The output does not match ReviewResult."),
        { status: 422, code: "TEST_RESPONSE_INVALID", details: { problems: [{ path: "/verdict", message: "verdict must be text" }] } }));
    assert.equal(answer.message, "The output does not match ReviewResult. verdict must be text");
});
