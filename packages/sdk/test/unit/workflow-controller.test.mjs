import test from "node:test";
import assert from "node:assert/strict";
import {
    clearInMemoryWorkflowGraphs,
    registerInMemoryWorkflowGraph,
} from "../../dist/workflow-orchestration/graph.js";
import {
    ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY,
    COMPLETE_WORKFLOW_ACTIVITY,
    EXECUTE_WORKFLOW_STATE_ACTIVITY,
    createWorkflowActivityHandlers,
} from "../../dist/workflow-orchestration/activities.js";
import {
    durableWorkflowSessionOrchestration_1_0_0,
} from "../../dist/workflow-orchestration/index.js";
import { HANDOFF_ACTIVITY_NAMES } from "../../dist/activity-routing.js";
import {
    SUBMIT_WORKFLOW_RESULT_TOOL,
    workflowResultQueueName,
} from "../../dist/workflow-orchestration/result-tool.js";

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
            return { kind: "dequeueEvent", name };
        },
        newGuid() {
            return { kind: "newGuid" };
        },
        utcNow() {
            return { kind: "utcNow" };
        },
    };
}

async function runController(input, catalog = null, options = {}) {
    const handlers = createWorkflowActivityHandlers(catalog);
    const execution = durableWorkflowSessionOrchestration_1_0_0(createContext(), input);
    const operations = [];
    let childNumber = 0;
    let spawnedChild = null;
    let step = execution.next();

    while (!step.done) {
        const operation = step.value;
        operations.push(operation);
        if (operation.kind === "newGuid") {
            childNumber += 1;
            step = execution.next(`child-${childNumber}`);
            continue;
        }
        if (operation.kind === "dequeueEvent") {
            if (!spawnedChild || !options.agentResult) {
                throw new Error(`No agent result configured for queue ${operation.name}`);
            }
            const binding = spawnedChild.input.config.childContract;
            step = execution.next(JSON.stringify({
                workflowSessionId: binding.workflowSessionId,
                childSessionId: spawnedChild.input.childSessionId,
                graphId: binding.graphId,
                stateId: binding.stateId,
                executionSequence: binding.executionSequence,
                outcome: options.agentResult.outcome,
                output: options.agentResult.output,
                ...options.agentResult.override,
            }));
            continue;
        }
        if (operation.kind === "utcNow") {
            step = execution.next("2026-10-07T18:00:00.000Z");
            continue;
        }
        if (operation.name === HANDOFF_ACTIVITY_NAMES.spawnChildSession) {
            spawnedChild = operation;
            step = execution.next(operation.input.childSessionId);
            continue;
        }
        if (operation.name === EXECUTE_WORKFLOW_STATE_ACTIVITY) {
            step = execution.next(await handlers.executeState(operation.input));
            continue;
        }
        if (operation.name === ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY) {
            step = execution.next(await handlers.acceptStateResult(operation.input));
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
                execute: ({ latestStateOutputs }) => ({
                    outcome: "published",
                    output: {
                        revision: latestStateOutputs.inspect.output.revision,
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
                result: ({ latestStateOutputs }) => latestStateOutputs.publish.output,
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
        firstRun.operations
            .filter(operation => operation.name === EXECUTE_WORKFLOW_STATE_ACTIVITY)
            .map(operation => operation.input.executionSequence),
        [1, 2],
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

test("preserves execution history when a workflow revisits the same state", async () => {
    const definition = registerInMemoryWorkflowGraph({
        id: "loop-history",
        initialState: "retry",
        maxTransitions: 3,
        states: {
            retry: {
                type: "activity",
                allowedOutcomes: ["retry", "done"],
                allowedTargets: ["retry", "complete"],
                execute: ({ executionHistory }) => ({
                    outcome: executionHistory.length === 0 ? "retry" : "done",
                    output: { attempt: executionHistory.length + 1 },
                }),
                transition: ({ stateOutcome }) =>
                    stateOutcome === "retry" ? "retry" : "complete",
            },
            complete: {
                type: "terminal",
                outcome: "succeeded",
                summary: "Retries completed.",
                result: ({ latestStateOutputs, executionHistory }) => ({
                    latestAttempt: latestStateOutputs.retry.output.attempt,
                    attempts: executionHistory.map(record => ({
                        sequence: record.executionSequence,
                        attempt: record.output.attempt,
                    })),
                }),
            },
        },
    });

    const run = await runController({
        sessionId: "workflow-loop-1",
        definition,
        inputs: {},
    });

    assert.deepEqual(run.result.result, {
        latestAttempt: 2,
        attempts: [
            { sequence: 1, attempt: 1 },
            { sequence: 2, attempt: 2 },
        ],
    });
});

test("dispatches a named agent and waits for its bound workflow result", async () => {
    const definition = registerInMemoryWorkflowGraph({
        id: "agent-controller",
        initialState: "inspect",
        states: {
            inspect: {
                type: "agent",
                agent: "change-delivery-intake",
                prompt: ({ workflowInputs, executionSequence }) =>
                    `Inspect pull request ${workflowInputs.pullRequestId}; execution ${executionSequence}.`,
                allowedOutcomes: ["succeeded", "blocked"],
                allowedTargets: ["done", "blocked"],
                transition: context =>
                    context.stateOutcome === "succeeded" ? "done" : "blocked",
            },
            done: {
                type: "terminal",
                outcome: "succeeded",
                summary: "Inspection completed.",
                result: ({ latestStateOutputs }) => latestStateOutputs.inspect.output,
            },
            blocked: {
                type: "terminal",
                outcome: "blocked",
                summary: "Inspection blocked.",
            },
        },
    });

    const acceptedResults = [];
    const run = await runController({
        sessionId: "workflow-agent-1",
        definition,
        inputs: { pullRequestId: 42 },
    }, {
        upsertChildOutcome: async input => acceptedResults.push(input),
    }, {
        agentResult: {
            outcome: "succeeded",
            output: { sourceCommit: "abc123" },
        },
    });

    assert.deepEqual(
        run.operations.map(operation => operation.name ?? operation.kind),
        [
            "newGuid",
            HANDOFF_ACTIVITY_NAMES.spawnChildSession,
            workflowResultQueueName(1),
            ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY,
            "utcNow",
            COMPLETE_WORKFLOW_ACTIVITY,
        ],
    );
    const spawn = run.operations[1];
    assert.equal(spawn.input.childSessionId, "child-1");
    assert.equal(spawn.input.parentSessionId, "workflow-agent-1");
    assert.equal(spawn.input.task, "Inspect pull request 42; execution 1.");
    assert.equal(spawn.input.requiredTool, SUBMIT_WORKFLOW_RESULT_TOOL);
    assert.deepEqual(spawn.input.config.toolNames, [SUBMIT_WORKFLOW_RESULT_TOOL]);
    assert.deepEqual(spawn.input.config.childContract, {
        kind: "workflow-state-execution",
        workflowSessionId: "workflow-agent-1",
        graphId: "agent-controller",
        stateId: "inspect",
        executionSequence: 1,
        allowedOutcomes: ["succeeded", "blocked"],
    });
    assert.equal(run.operations[2].name, workflowResultQueueName(1));
    assert.deepEqual(run.operations[3].input, {
        workflowSessionId: "workflow-agent-1",
        childSessionId: "child-1",
        graphId: "agent-controller",
        stateId: "inspect",
        executionSequence: 1,
        outcome: "succeeded",
        output: { sourceCommit: "abc123" },
    });
    assert.equal(acceptedResults.length, 1);
    assert.equal(acceptedResults[0].childSessionId, "child-1");
    assert.equal(acceptedResults[0].resultJson.executionSequence, 1);
    assert.deepEqual(run.result.result, { sourceCommit: "abc123" });
});

test("rejects an agent result that does not match the active execution", async () => {
    const definition = registerInMemoryWorkflowGraph({
        id: "mismatched-agent-result",
        initialState: "run",
        states: {
            run: {
                type: "agent",
                agent: "worker",
                prompt: "Run the assigned task.",
                allowedOutcomes: ["succeeded"],
                allowedTargets: ["done"],
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
            sessionId: "workflow-agent-2",
            definition,
            inputs: {},
        }, null, {
            agentResult: {
                outcome: "succeeded",
                output: {},
                override: { executionSequence: 99 },
            },
        }),
        error => error?.code === "WORKFLOW_STATE_RESULT_MISMATCH",
    );
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
