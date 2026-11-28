import test from "node:test";
import assert from "node:assert/strict";
import { workflowCommandStatus } from "../../dist/workflow/human-commands.js";
import { WORKFLOW_READ_STATUS, workflowReadStatus } from "../../dist/workflow/read-pages.js";
import { READ_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC, readWorkflowModel, retainedWorkflowReadModel } from "../../dist/workflow/tools.js";
import { WORKFLOW_DEFINITION_TOOL_SPEC, workflowDefinitionFromTool } from "../../dist/workflow/definition-tool.js";
import { readWorkflowRerunPlan } from "../../dist/workflow/session-definitions.js";

/** A host that fails the test if a refusal reads anything: every refusal here comes before any read. */
const untouchable = new Proxy({}, { get: (_target, name) => { throw new Error(`read ${String(name)} before refusing`); } });

test("Phase 3 I7: every re-run refusal has the HTTP status of design §6.3", () => {
    const expected = {
        RERUN_ARGUMENT_REFUSED: 400, RERUN_VISIT_REQUIRED: 400,
        RERUN_APPROVAL_REUSED: 403,
        WORKFLOW_DELETED: 404, RERUN_VISIT_NOT_FOUND: 404,
        RERUN_SOURCE_ACTIVE: 409, RERUN_SOURCE_GONE: 409, WORKFLOW_TOOLS_UNAVAILABLE: 409,
        RERUN_INCOMPATIBLE: 422, RERUN_VISIT_NOT_ALLOWED: 422, RERUN_SUPPLY_NOT_ALLOWED: 422, RERUN_SUPPLIED_RESULT_INVALID: 422,
        RERUN_NOT_A_WORKFLOW: 422, RERUN_TOO_LARGE: 422,
    };
    for (const [code, status] of Object.entries(expected)) assert.equal(workflowCommandStatus(code), status, code);
    // A plan read refuses as Start does; a plan that does not fit is read (200), never RERUN_INCOMPATIBLE.
    for (const code of ["RERUN_VISIT_NOT_FOUND", "RERUN_VISIT_REQUIRED", "RERUN_SOURCE_ACTIVE", "RERUN_SOURCE_GONE", "RERUN_NOT_A_WORKFLOW",
        "RERUN_VISIT_NOT_ALLOWED", "RERUN_SUPPLY_NOT_ALLOWED"]) {
        assert.equal(workflowReadStatus(code), expected[code], code);
    }
    assert.equal(workflowReadStatus("DEFINITION_INVALID"), 422);
    assert.equal(workflowReadStatus("RERUN_INCOMPATIBLE"), undefined);
    for (const [code, status] of Object.entries(WORKFLOW_READ_STATUS)) assert.equal(workflowReadStatus(code), status, code);
});

test("Phase 3 I7: rerun_plan is a read of its own, outcome-only, and never takes an output", async () => {
    const host = { store: untouchable, catalog: untouchable };
    for (const [extra, name] of [[{ executionId: "x" }, "execution_id"], [{ runId: "r" }, "run_id"], [{ cursor: {} }, "cursor"],
        [{ kvRevision: 1 }, "kv_revision"], [{ limit: 5 }, "limit"]]) {
        await assert.rejects(readWorkflowModel(host, "wf", { rerunPlan: {}, ...extra }, "tool"),
            error => error.code === "WORKFLOW_READ_INVALID" && error.message.includes(`A re-run plan is a read of its own; leave out ${name}`), name);
    }
    // The API names each option as the caller wrote it.
    await assert.rejects(readWorkflowModel(host, "wf", { rerunPlan: {}, executionId: "x" }, "api"),
        error => error.code === "WORKFLOW_READ_INVALID" && error.message.endsWith("leave out executionId."));
    // The other reads of their own come first; rerun_plan is then the extra one named.
    for (const extra of [{ agentVersions: true }, { definitionRevision: 1 }, { stepInput: { state: "a" } }]) {
        await assert.rejects(readWorkflowModel(host, "wf", { rerunPlan: {}, ...extra }, "tool"),
            error => error.code === "WORKFLOW_READ_INVALID" && error.message.includes("rerun_plan"), JSON.stringify(extra));
    }
    for (const value of [{ result: { outcome: "ok", output: {} } }, { output: {} }, { mode: "supply", outcome: "ok", note: "n" }, "plan", [],
        { mode: "again" }, { revision: 0 }, { outcome: "" }, { viaMcp: "yes" }, { execution_id: "a", executionId: "b" }]) {
        await assert.rejects(readWorkflowRerunPlan(host, "wf", value), { code: "WORKFLOW_READ_INVALID" }, JSON.stringify(value));
    }
    await assert.rejects(readWorkflowModel({ store: untouchable }, "wf", { rerunPlan: {} }, "api"), { code: "WORKFLOW_READ_INVALID" });
});

test("Phase 3 I7: a cleaned-up Workflow answers rerun_plan with RERUN_SOURCE_GONE and its kept outcome", () => {
    const row = { outcomeType: "workflow", resultJson: { current: { kind: "workflow", runId: "run-2", status: "failed", outcome: "failed",
        completedAt: "2026-11-27T10:00:00.000Z" }, revisions: [] } };
    for (const options of [{ rerun_plan: {} }, { rerunPlan: { mode: "continue" } }]) {
        assert.throws(() => retainedWorkflowReadModel("wf-2", row, options), error => {
            assert.equal(error.code, "RERUN_SOURCE_GONE");
            assert.match(error.message, /cleaned up\. Only its result is kept\. Use Run again\./);
            assert.deepEqual(error.details, { workflowId: "wf-2", runId: "run-2", status: "failed", outcome: "failed", completedAt: "2026-11-27T10:00:00.000Z" });
            return true;
        });
    }
    assert.equal(retainedWorkflowReadModel("wf-2", row, {}).deleted, true);
});

test("Phase 3 I7: workflow_definition start refuses what a re-run inherits or cannot take, before anything is read", async () => {
    const context = { callerSessionId: "s", host: untouchable, toolCallId: "call-1", owner: null, binding: async () => null };
    const start = async (args) => JSON.parse(await workflowDefinitionFromTool({ operation: "start", ...args }, context));
    const from = { workflow_id: "wf-2" };
    for (const args of [{ rerun_from: from, inputs: { topic: "x" } }, { rerun_from: from, workspace: null }, { rerun_from: from, workspace: "none" },
        { rerun_from: from, run_again_of: "wf-1" }, { rerun_from: { ...from, child: "c-1" } }, { rerun_from: "wf-2" }, { rerun_from: {} },
        { rerun_from: { ...from, execution_id: 7 } }]) {
        const answer = await start(args);
        assert.equal(answer.ok, false, JSON.stringify(args));
        assert.equal(answer.error.code, "RERUN_ARGUMENT_REFUSED", JSON.stringify(args));
    }
});

test("Phase 3 I7: the rerun_from and rerun_plan declarations stay small and point to the workflow-rerun skill", () => {
    const from = WORKFLOW_DEFINITION_TOOL_SPEC.parameters.properties.rerun_from;
    assert.deepEqual(from.required, ["workflow_id"]);
    assert.equal(from.additionalProperties, false);
    assert.deepEqual(Object.keys(from.properties), ["workflow_id", "execution_id", "mode", "result", "note"]);
    assert.deepEqual(from.properties.mode.enum, ["run_again", "continue", "supply"]);
    assert.equal(from.properties.note.maxLength, 2000);
    assert.match(from.description, /Omit inputs and workspace/);
    assert.match(from.description, /load_skill with name workflow-rerun/);
    const plan = READ_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC.parameters.properties.rerun_plan;
    assert.deepEqual(Object.keys(plan.properties), ["execution_id", "mode", "revision", "outcome"]);
    assert.equal(plan.additionalProperties, false);
    assert.match(READ_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC.description, /rerun_plan, alone, previews a re-run.*workflow-rerun/);
    // Prompt budget (S9): the two new declarations together stay under 1,200 bytes of schema.
    assert.ok(Buffer.byteLength(JSON.stringify(from)) + Buffer.byteLength(JSON.stringify(plan)) <= 1_200,
        `${Buffer.byteLength(JSON.stringify(from)) + Buffer.byteLength(JSON.stringify(plan))}`);
});
