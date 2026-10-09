import test from "node:test";
import assert from "node:assert/strict";
import {
    WorkflowStateProviderRegistry,
} from "../../dist/workflow-orchestration/state-providers.js";

const context = {
    workflowSessionId: "workflow-1",
    graphId: "graph-1",
    stateId: "state-1",
    executionSequence: 1,
    workflowInputs: { changeId: "change-1" },
};

test("dispatches workflow action and observed-condition providers", async () => {
    const registry = new WorkflowStateProviderRegistry()
        .registerAction("ado", () => ({
            outcome: "succeeded",
            output: { published: true },
        }))
        .registerObservedCondition("ado", async () => ({
            status: "pending",
            retryAfterMs: 750,
        }));

    assert.deepEqual(await registry.executeAction({
        ...context,
        provider: "ado",
        operation: "publish",
        input: { branch: "main" },
    }), {
        outcome: "succeeded",
        output: { published: true },
    });
    assert.deepEqual(await registry.observeCondition({
        ...context,
        provider: "ado",
        operation: { pullRequestId: 17 },
        conditions: { status: "completed" },
        observationAttempt: 2,
    }), {
        status: "pending",
        retryAfterMs: 750,
    });
});

test("rejects duplicate and missing workflow state providers", () => {
    const registry = new WorkflowStateProviderRegistry()
        .registerAction("ado", () => ({ outcome: "succeeded", output: null }));

    assert.throws(
        () => registry.registerAction("ado", () => ({
            outcome: "succeeded",
            output: null,
        })),
        error => error?.code === "WORKFLOW_STATE_PROVIDER_ALREADY_REGISTERED",
    );
    assert.throws(
        () => registry.observeCondition({
            ...context,
            provider: "ado",
            operation: {},
            conditions: {},
            observationAttempt: 1,
        }),
        error =>
            error?.code === "WORKFLOW_OBSERVED_CONDITION_PROVIDER_NOT_REGISTERED",
    );
});
