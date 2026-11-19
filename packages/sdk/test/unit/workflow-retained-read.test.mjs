import test from "node:test";
import assert from "node:assert/strict";
import { retainedWorkflowReadModel } from "../../dist/workflow/tools.js";

test("a retained ordinary child outcome is not read as a Workflow", () => {
    assert.throws(() => retainedWorkflowReadModel("child", {
        resultJson: { current: { kind: "agent", sessionId: "child", parentSessionId: "parent", summary: "done" }, revisions: [] },
    }), (error) => error?.code === "WORKFLOW_NOT_FOUND");
});
