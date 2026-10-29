import test from "node:test";
import assert from "node:assert/strict";
import {
    createSubmitWorkflowResultTool,
    workflowResultQueueName,
} from "../../dist/workflow-orchestration/result-tool.js";

function createHarness() {
    const events = [];
    let childOutcome = null;
    const binding = {
        kind: "workflow-state-execution",
        workflowSessionId: "workflow-1",
        graphId: "graph-1",
        stateId: "inspect",
        executionSequence: 3,
        allowedOutcomes: ["succeeded", "blocked"],
    };
    const catalog = {
        async getSession(sessionId) {
            if (sessionId === "child-1") {
                return {
                    sessionId,
                    parentSessionId: "workflow-1",
                    sessionKind: "agent",
                };
            }
            if (sessionId === "workflow-1") {
                return {
                    sessionId,
                    parentSessionId: null,
                    sessionKind: "workflow",
                };
            }
            return null;
        },
        async getSessionCreationConfig(sessionId) {
            return sessionId === "child-1" ? { childContract: binding } : null;
        },
        async getChildOutcome() {
            return childOutcome;
        },
    };
    const duroxideClient = {
        async enqueueEvent(instanceId, queue, payload) {
            events.push({ instanceId, queue, payload: JSON.parse(payload) });
        },
    };
    const tool = createSubmitWorkflowResultTool({ catalog, duroxideClient });
    return {
        tool,
        events,
        markAccepted() {
            childOutcome = { completedAt: new Date() };
        },
    };
}

test("derives the workflow execution binding from the durable child session", async () => {
    const { tool, events } = createHarness();

    const response = JSON.parse(await tool.handler({
        outcome: "succeeded",
        output: { sourceCommit: "abc123" },
    }, {
        durableSessionId: "child-1",
    }));

    assert.deepEqual(response, {
        submitted: true,
        workflowSessionId: "workflow-1",
        executionSequence: 3,
    });
    assert.deepEqual(events, [{
        instanceId: "session-workflow-1",
        queue: workflowResultQueueName(3),
        payload: {
            workflowSessionId: "workflow-1",
            childSessionId: "child-1",
            graphId: "graph-1",
            stateId: "inspect",
            executionSequence: 3,
            outcome: "succeeded",
            output: { sourceCommit: "abc123" },
        },
    }]);
});

test("treats a result submitted after controller acceptance as an idempotent duplicate", async () => {
    const { tool, markAccepted, events } = createHarness();
    const invocation = { durableSessionId: "child-1" };
    const args = { outcome: "succeeded", output: { sourceCommit: "abc123" } };

    markAccepted();
    const duplicate = JSON.parse(await tool.handler(args, invocation));

    assert.equal(duplicate.duplicate, true);
    assert.equal(events.length, 0);
});

test("rejects outcomes not declared by the assigned workflow state", async () => {
    const { tool, events } = createHarness();

    await assert.rejects(
        tool.handler({
            outcome: "unexpected",
            output: {},
        }, {
            durableSessionId: "child-1",
        }),
        error => error?.code === "WORKFLOW_STATE_OUTCOME_INVALID",
    );
    assert.equal(events.length, 0);
});
