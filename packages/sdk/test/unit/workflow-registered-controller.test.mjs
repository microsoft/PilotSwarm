import test from "node:test";
import assert from "node:assert/strict";
import {
    durableWorkflowSessionOrchestration_1_0_0,
} from "../../dist/workflow-orchestration/index.js";
import {
    registerInMemoryWorkflowGraph,
    unregisterInMemoryWorkflowGraph,
} from "../../dist/workflow-orchestration/graph.js";
import {
    ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY,
    COMPLETE_WORKFLOW_ACTIVITY,
    RECORD_WORKFLOW_STATE_EXECUTION_ACTIVITY,
} from "../../dist/workflow-orchestration_1_0_0/contracts.js";
import {
    EXECUTE_WORKFLOW_TRANSITION_ACTIVITY,
    RESOLVE_WORKFLOW_DEFINITION_ACTIVITY,
} from "../../dist/workflow-orchestration/registered-contracts.js";

function createContext() {
    return {
        scheduleActivity(name, input) {
            const operation = {
                kind: "activity",
                name,
                input,
                withTag(tag) {
                    operation.tag = tag;
                    return operation;
                },
            };
            return operation;
        },
        dequeueEvent(name) {
            return { kind: "dequeue", name };
        },
        newGuid() {
            return { kind: "newGuid" };
        },
        utcNow() {
            return { kind: "utcNow" };
        },
    };
}

const manifest = {
    compilerVersion: "v1alpha1-2",
    apiVersion: "pilotswarm.dev/v1alpha1",
    kind: "Workflow",
    graphId: "registered-controller@0.1.0",
    packageSha256: "a".repeat(64),
    metadata: { name: "registered-controller", version: "0.1.0" },
    inputSchema: {},
    configuration: { retryCount: 2 },
    initialState: "inspect",
    states: [{
        id: "inspect",
        type: "agent",
        agent: "delivery-inspector",
        input: {
            changeId: "${inputs.changeId}",
            retries: "${configuration.retryCount}",
        },
        resultSchema: "delivery/inspection/v1",
        completion: { mode: "one-shot", outcomes: ["succeeded", "blocked"] },
        transition: {
            handler: {
                module: "./transitions.mjs",
                export: "inspect",
                moduleSha256: "b".repeat(64),
                packageSha256: "a".repeat(64),
            },
            allowedTargets: ["done", "blocked"],
        },
    }, {
        id: "done",
        type: "terminal",
        outcome: "succeeded",
        summary: "Done.",
        hasOutput: true,
        output: "${states.inspect.result}",
    }, {
        id: "blocked",
        type: "terminal",
        outcome: "blocked",
        summary: "Blocked.",
        hasOutput: false,
    }],
};

test("hydrates a registered plan and executes it without an in-memory graph", () => {
    const execution = durableWorkflowSessionOrchestration_1_0_0(createContext(), {
        sessionId: "workflow-registered",
        definition: { kind: "registered", definitionId: "definition-1" },
        inputs: { changeId: "change-42" },
    });

    const operations = [];
    let step = execution.next();
    let dispatch;

    while (!step.done) {
        const operation = step.value;
        operations.push(operation);
        if (operation.name === RESOLVE_WORKFLOW_DEFINITION_ACTIVITY) {
            step = execution.next({ definitionId: "definition-1", manifest });
        } else if (operation.kind === "newGuid") {
            step = execution.next("child-1");
        } else if (operation.name === RECORD_WORKFLOW_STATE_EXECUTION_ACTIVITY) {
            step = execution.next(undefined);
        } else if (operation.name === "spawnChildSessionV2") {
            dispatch = operation;
            step = execution.next("child-1");
        } else if (operation.kind === "dequeue") {
            const binding = dispatch.input.config.childContract;
            step = execution.next(JSON.stringify({
                workflowSessionId: binding.workflowSessionId,
                childSessionId: "child-1",
                graphId: binding.graphId,
                stateId: binding.stateId,
                executionSequence: binding.executionSequence,
                outcome: "succeeded",
                output: { approved: true },
            }));
        } else if (operation.name === ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY) {
            step = execution.next({
                outcome: operation.input.outcome,
                output: operation.input.output,
            });
        } else if (operation.name === EXECUTE_WORKFLOW_TRANSITION_ACTIVITY) {
            step = execution.next({ kind: "advance", target: "done" });
        } else if (operation.kind === "utcNow") {
            step = execution.next("2026-10-07T00:00:00.000Z");
        } else if (operation.name === COMPLETE_WORKFLOW_ACTIVITY) {
            step = execution.next(operation.input.result);
        } else {
            throw new Error(`Unexpected operation: ${JSON.stringify(operation)}`);
        }
    }

    assert.equal(step.value.outcome, "succeeded");
    assert.deepEqual(step.value.result, { approved: true });
    assert.equal(step.value.metadata.definitionId, "definition-1");
    assert.match(dispatch.input.task, /"changeId": "change-42"/);
    assert.match(dispatch.input.task, /"retries": 2/);
    assert.deepEqual(
        operations
            .filter(operation => operation.kind === "activity")
            .map(operation => operation.name),
        [
            RESOLVE_WORKFLOW_DEFINITION_ACTIVITY,
            RECORD_WORKFLOW_STATE_EXECUTION_ACTIVITY,
            "spawnChildSessionV2",
            ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY,
            EXECUTE_WORKFLOW_TRANSITION_ACTIVITY,
            COMPLETE_WORKFLOW_ACTIVITY,
        ],
    );
});

test("preserves the in-memory graph path in orchestration 1.0.0", () => {
    const definition = registerInMemoryWorkflowGraph({
        id: "in-memory-compatibility",
        initialState: "done",
        states: {
            done: {
                type: "terminal",
                outcome: "succeeded",
                summary: "Done.",
                result: () => ({ compatible: true }),
            },
        },
    });
    try {
        const execution = durableWorkflowSessionOrchestration_1_0_0(createContext(), {
            sessionId: "workflow-in-memory",
            definition,
            inputs: {},
        });
        let step = execution.next();
        assert.equal(step.value.kind, "utcNow");
        step = execution.next("2026-10-07T00:00:00.000Z");
        assert.equal(step.value.name, COMPLETE_WORKFLOW_ACTIVITY);
        step = execution.next(step.value.input.result);
        assert.equal(step.done, true);
        assert.deepEqual(step.value.result, { compatible: true });
    } finally {
        unregisterInMemoryWorkflowGraph(definition.graphId);
    }
});
