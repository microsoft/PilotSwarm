import test from "node:test";
import assert from "node:assert/strict";
import {
    WORKFLOW_SESSION_LATEST_VERSION,
    WORKFLOW_SESSION_ORCHESTRATION_NAME,
    WORKFLOW_SESSION_ORCHESTRATION_REGISTRY,
} from "../../dist/workflow-orchestration-registry.js";
import {
    durableWorkflowSessionOrchestration_1_0_0,
} from "../../dist/workflow-orchestration/index.js";

test("workflow orchestration has an independent durable name and version registry", () => {
    assert.equal(WORKFLOW_SESSION_ORCHESTRATION_NAME, "workflow-session-v1");
    assert.equal(WORKFLOW_SESSION_LATEST_VERSION, "1.0.0");
    assert.deepEqual(
        WORKFLOW_SESSION_ORCHESTRATION_REGISTRY.map(({ version }) => version),
        ["1.0.0"],
    );
});

test("workflow orchestration registry preserves the initial controller", () => {
    assert.equal(
        WORKFLOW_SESSION_ORCHESTRATION_REGISTRY[0].handler,
        durableWorkflowSessionOrchestration_1_0_0,
    );
});
