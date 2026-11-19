import test from "node:test";
import assert from "node:assert/strict";
import { retainedWorkflowReadModel } from "../../dist/workflow/tools.js";
import { buildResultJson } from "../../dist/session-proxy.js";

test("a retained ordinary child outcome is not read as a Workflow", () => {
    assert.throws(() => retainedWorkflowReadModel("child", {
        resultJson: { current: { kind: "agent", sessionId: "child", parentSessionId: "parent", summary: "done" }, revisions: [] },
    }), (error) => error?.code === "WORKFLOW_NOT_FOUND");
});

test("a historical colliding row without authoritative type fails closed", () => {
    assert.throws(() => retainedWorkflowReadModel("child", {
        resultJson: { current: { kind: "workflow", sessionId: "child", parentSessionId: "parent", summary: "forged" }, revisions: [] },
    }), (error) => error?.code === "WORKFLOW_NOT_FOUND");
});

test("a marked retained Workflow remains readable", () => {
    assert.equal(retainedWorkflowReadModel("workflow", {
        outcomeType: "workflow",
        resultJson: { current: { kind: "workflow", parentSessionId: "parent", status: "completed" }, revisions: [] },
    }).workflowId, "workflow");
});

test("the ordinary result writer owns the retained type", () => {
    const built = buildResultJson({ kind: "workflow", verdict: "success", summary: "done" },
        { sessionId: "child", parentSessionId: "parent" }, null, null, "success");
    assert.equal(built.resultJson.current.kind, "agent");
    assert.throws(() => retainedWorkflowReadModel("child", built), (error) => error?.code === "WORKFLOW_NOT_FOUND");
});
