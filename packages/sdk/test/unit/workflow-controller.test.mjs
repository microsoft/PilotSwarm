import test from "node:test";
import assert from "node:assert/strict";
import {
    clearInMemoryWorkflowGraphs,
    registerInMemoryWorkflowGraph,
} from "../../dist/workflow-orchestration/graph.js";
import {
    COMPLETE_WORKFLOW_ACTIVITY,
    EXECUTE_WORKFLOW_STATE_ACTIVITY,
    createWorkflowActivityHandlers,
} from "../../dist/workflow-orchestration/activities.js";
import {
    durableWorkflowSessionOrchestration_1_0_0,
} from "../../dist/workflow-orchestration/index.js";

function createContext() {
    return {
        scheduleActivity(name, input) {
            return { kind: "activity", name, input };
        },
        utcNow() {
            return { kind: "utcNow" };
        },
    };
}

async function runController(input, catalog = null) {
    const handlers = createWorkflowActivityHandlers(catalog);
    const execution = durableWorkflowSessionOrchestration_1_0_0(createContext(), input);
    const operations = [];
    let step = execution.next();

    while (!step.done) {
        const operation = step.value;
        operations.push(operation);
        if (operation.kind === "utcNow") {
            step = execution.next("2026-10-07T18:00:00.000Z");
            continue;
        }
        if (operation.name === EXECUTE_WORKFLOW_STATE_ACTIVITY) {
            step = execution.next(await handlers.executeState(operation.input));
            continue;
        }
        if (operation.name === COMPLETE_WORKFLOW_ACTIVITY) {
            step = execution.next(await handlers.completeWorkflow(operation.input));
            continue;
        }
        throw new Error(`Unexpected operation: ${JSON.stringify(operation)}`);
    }

    return { result: step.value, operations };
}

test.beforeEach(() => clearInMemoryWorkflowGraphs());
test.afterEach(() => clearInMemoryWorkflowGraphs());

test("executes states and deterministic transitions until a terminal state", async () => {
    const definition = registerInMemoryWorkflowGraph({
        id: "basic-controller",
        initialState: "inspect",
        states: {
            inspect: {
                type: "activity",
                allowedOutcomes: ["ready", "blocked"],
                allowedTargets: ["publish", "blocked"],
                execute: ({ workflowInputs }) => ({
                    outcome: workflowInputs.approved ? "ready" : "blocked",
                    output: { revision: 7 },
                }),
                transition: context =>
                    context.stateOutcome === "ready" ? "publish" : "blocked",
            },
            publish: {
                type: "activity",
                allowedOutcomes: ["published"],
                allowedTargets: ["done"],
                execute: ({ recordedStateOutputs }) => ({
                    outcome: "published",
                    output: {
                        revision: recordedStateOutputs.inspect.output.revision,
                        url: "https://example.test/pull/7",
                    },
                }),
                transition: () => "done",
            },
            blocked: {
                type: "terminal",
                outcome: "blocked",
                summary: "Workflow was blocked.",
            },
            done: {
                type: "terminal",
                outcome: "succeeded",
                summary: "Workflow completed.",
                result: ({ recordedStateOutputs }) => recordedStateOutputs.publish.output,
            },
        },
    });
    const writes = [];

    const firstRun = await runController({
        sessionId: "workflow-1",
        parentSessionId: "parent-1",
        definition,
        inputs: { approved: true },
    }, {
        upsertChildOutcome: async input => writes.push(input),
    });
    const secondRun = await runController({
        sessionId: "workflow-2",
        definition,
        inputs: { approved: true },
    });

    assert.deepEqual(
        firstRun.operations.map(operation => operation.name ?? operation.kind),
        [EXECUTE_WORKFLOW_STATE_ACTIVITY, EXECUTE_WORKFLOW_STATE_ACTIVITY, "utcNow", COMPLETE_WORKFLOW_ACTIVITY],
    );
    assert.deepEqual(
        secondRun.operations.map(operation => operation.name ?? operation.kind),
        firstRun.operations.map(operation => operation.name ?? operation.kind),
    );
    assert.deepEqual(firstRun.result, {
        sessionId: "workflow-1",
        parentSessionId: "parent-1",
        outcome: "succeeded",
        summary: "Workflow completed.",
        result: { revision: 7, url: "https://example.test/pull/7" },
        completedAt: "2026-10-07T18:00:00.000Z",
        metadata: {
            graphId: "basic-controller",
            terminalStateId: "done",
            transitionCount: 2,
        },
    });
    assert.deepEqual(writes, [{
        childSessionId: "workflow-1",
        parentSessionId: "parent-1",
        resultJson: {
            outcome: "succeeded",
            summary: "Workflow completed.",
            result: { revision: 7, url: "https://example.test/pull/7" },
            metadata: {
                graphId: "basic-controller",
                terminalStateId: "done",
                transitionCount: 2,
            },
        },
        verdict: "succeeded",
        summary: "Workflow completed.",
        completedAt: new Date("2026-10-07T18:00:00.000Z"),
    }]);
});

test("rejects undeclared state outcomes", async () => {
    const definition = registerInMemoryWorkflowGraph({
        id: "invalid-outcome",
        initialState: "run",
        states: {
            run: {
                type: "activity",
                allowedOutcomes: ["succeeded"],
                allowedTargets: ["done"],
                execute: () => ({ outcome: "unexpected", output: {} }),
                transition: () => "done",
            },
            done: {
                type: "terminal",
                outcome: "succeeded",
                summary: "Done.",
            },
        },
    });

    await assert.rejects(
        runController({
            sessionId: "workflow-2",
            definition,
            inputs: {},
        }),
        error => error?.code === "WORKFLOW_STATE_OUTCOME_INVALID",
    );
});

test("rejects transition targets outside the declared graph edge", async () => {
    const definition = registerInMemoryWorkflowGraph({
        id: "invalid-transition",
        initialState: "run",
        states: {
            run: {
                type: "activity",
                allowedOutcomes: ["succeeded"],
                allowedTargets: ["done"],
                execute: () => ({ outcome: "succeeded", output: {} }),
                transition: () => "other",
            },
            done: {
                type: "terminal",
                outcome: "succeeded",
                summary: "Done.",
            },
            other: {
                type: "terminal",
                outcome: "failed",
                summary: "Wrong edge.",
            },
        },
    });

    await assert.rejects(
        runController({
            sessionId: "workflow-3",
            definition,
            inputs: {},
        }),
        error => error?.code === "WORKFLOW_TRANSITION_TARGET_INVALID",
    );
});

test("keeps YAML definitions behind the deferred compiler boundary", () => {
    const execution = durableWorkflowSessionOrchestration_1_0_0(createContext(), {
        sessionId: "workflow-4",
        definition: { kind: "inline", yaml: "name: deferred\n" },
        inputs: {},
    });

    assert.throws(
        () => execution.next(),
        error => error?.code === "WORKFLOW_DEFINITION_COMPILER_REQUIRED",
    );
});
