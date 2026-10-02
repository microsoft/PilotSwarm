import test from "node:test";
import assert from "node:assert/strict";
import {
    WORKFLOW_SESSION_LATEST_VERSION,
    WORKFLOW_SESSION_ORCHESTRATION_NAME,
    WORKFLOW_SESSION_ORCHESTRATION_REGISTRY,
} from "../../dist/workflow-orchestration-registry.js";

test("workflow orchestration has an independent durable name and version registry", () => {
    assert.equal(WORKFLOW_SESSION_ORCHESTRATION_NAME, "workflow-session-v1");
    assert.equal(WORKFLOW_SESSION_LATEST_VERSION, "1.0.0");
    assert.deepEqual(
        WORKFLOW_SESSION_ORCHESTRATION_REGISTRY.map(({ version }) => version),
        ["1.0.0"],
    );
});

test("workflow orchestration scaffold fails explicitly instead of running conversation logic", () => {
    const [{ handler }] = WORKFLOW_SESSION_ORCHESTRATION_REGISTRY;
    const execution = handler({}, {
        sessionId: "workflow-1",
        parentSessionId: "parent-1",
        definition: { kind: "inline", yaml: "kind: workflow\nversion: 1\n" },
        inputs: {},
    });

    assert.throws(
        () => execution.next(),
        error => error?.code === "WORKFLOW_CONTROLLER_NOT_IMPLEMENTED",
    );
});
