import test from "node:test";
import assert from "node:assert/strict";
import { handleSubAgentAction } from "../../dist/orchestration/agents.js";
import { buildContinueInput } from "../../dist/orchestration/lifecycle.js";
import { createInitialState, deriveOptions } from "../../dist/orchestration/state.js";

test("spawn_workflow durably creates and tracks the workflow child", () => {
    const state = { subAgents: [], subWorkflows: [], pendingPrompt: undefined };
    const runtime = {
        input: { sessionId: "parent-1" },
        ctx: {
            traceInfo() {},
            newGuid() {
                return { kind: "new-guid" };
            },
        },
        state,
        manager: {
            spawnWorkflowSession(parentSessionId, definition, inputs, childSessionId) {
                return { parentSessionId, childSessionId, definition, inputs };
            },
        },
    };
    const generator = handleSubAgentAction(runtime, {
        type: "spawn_workflow",
        definition: { kind: "inline", yaml: "name: test" },
        inputs: { target: "staging" },
    });
    assert.deepEqual(generator.next().value, { kind: "new-guid" });
    assert.deepEqual(generator.next("workflow-1").value, {
        parentSessionId: "parent-1",
        childSessionId: "workflow-1",
        definition: { kind: "inline", yaml: "name: test" },
        inputs: { target: "staging" },
    });
    assert.deepEqual(generator.next("workflow-1"), { done: true, value: true });
    assert.deepEqual(state.subAgents, []);
    assert.deepEqual(state.subWorkflows, [{
        sessionId: "workflow-1",
        status: "running",
        resultDelivered: false,
    }]);
    assert.match(state.pendingPrompt, /workflow-1/);
});

test("workflow tracking survives continue-as-new", () => {
    const input = {
        sessionId: "parent-1",
        config: {},
        subWorkflows: [{
            sessionId: "workflow-1",
            status: "running",
            resultDelivered: false,
        }],
        waitingForWorkflowIds: ["workflow-1"],
    };
    const options = deriveOptions(input);
    const state = createInitialState(input, options);
    const continued = buildContinueInput({ input, state, options });
    assert.deepEqual(continued.subWorkflows, input.subWorkflows);
    assert.deepEqual(continued.waitingForWorkflowIds, ["workflow-1"]);
});

test("wait_for_workflows delivers controller-written results to the parent prompt", () => {
    const state = {
        subAgents: [],
        subWorkflows: [{
            sessionId: "workflow-1",
            status: "running",
            resultDelivered: false,
        }],
        pendingPrompt: undefined,
    };
    const runtime = {
        input: { sessionId: "parent-1" },
        ctx: { traceInfo() {} },
        state,
        manager: {
            getWorkflowResult(parentSessionId, childSessionId) {
                return { parentSessionId, childSessionId };
            },
        },
    };
    const generator = handleSubAgentAction(runtime, {
        type: "wait_for_workflows",
        workflowIds: ["workflow-1"],
    });
    assert.deepEqual(generator.next().value, {
        parentSessionId: "parent-1",
        childSessionId: "workflow-1",
    });
    assert.deepEqual(generator.next(JSON.stringify({
        sessionId: "workflow-1",
        status: "succeeded",
        result: {
            sessionId: "workflow-1",
            parentSessionId: "parent-1",
            outcome: "succeeded",
            summary: "Deployment validated.",
            result: { target: "staging" },
            completedAt: "2026-10-02T14:00:00.000Z",
        },
    })), { done: true, value: true });
    assert.equal(state.subWorkflows[0].status, "succeeded");
    assert.equal(state.subWorkflows[0].resultDelivered, true);
    assert.match(state.pendingPrompt, /Deployment validated/);
    assert.match(state.pendingPrompt, /"target":"staging"/);
});
