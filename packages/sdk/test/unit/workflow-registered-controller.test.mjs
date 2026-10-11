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
    EXECUTE_WORKFLOW_ACTION_ACTIVITY,
    EXECUTE_WORKFLOW_TRANSITION_ACTIVITY,
    OBSERVE_WORKFLOW_CONDITION_ACTIVITY,
    RESOLVE_WORKFLOW_DEFINITION_ACTIVITY,
    workflowQuestionQueueName,
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
        scheduleTimer(delayMs) {
            return { kind: "timer", delayMs };
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
    compilerVersion: "v1alpha1-4",
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
        agent: "sample-inspector",
        input: {
            changeId: "${inputs.changeId}",
            retries: "${configuration.retryCount}",
        },
        resultSchema: "sample/inspection/v1",
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

    {
        const controlManifest = {
            ...manifest,
            initialState: "approve",
            states: [{
                id: "approve",
                type: "question",
                prompt: "Publish?",
                context: { changeId: "${inputs.changeId}" },
                authorization: { mode: "session-write" },
                completion: { outcomes: ["publish"] },
                transition: {
                    handler: { module: "./transitions.mjs", export: "approve" },
                    allowedTargets: ["publish"],
                },
            }, {
                id: "publish",
                type: "action",
                provider: "test",
                operation: "publish",
                input: { changeId: "${inputs.changeId}" },
                completion: { outcomes: ["succeeded"] },
                transition: {
                    handler: { module: "./transitions.mjs", export: "publish" },
                    allowedTargets: ["observe"],
                },
            }, {
                id: "observe",
                type: "observed-condition",
                provider: "test",
                operation: { changeId: "${inputs.changeId}" },
                conditions: { state: "complete" },
                pollIntervalMs: 250,
                completion: { outcomes: ["satisfied"] },
                transition: {
                    handler: { module: "./transitions.mjs", export: "observe" },
                    allowedTargets: ["done"],
                },
            }, {
                id: "done",
                type: "terminal",
                outcome: "succeeded",
                summary: "Done.",
                hasOutput: true,
                output: "${states.observe.result}",
            }],
        };
        const execution = durableWorkflowSessionOrchestration_1_0_0(createContext(), {
            sessionId: "workflow-control",
            definition: { kind: "registered", definitionId: "definition-control" },
            inputs: { changeId: "change-9" },
        });
        const targets = ["publish", "observe", "done"];
        const recordedExecutions = [];
        const actionRequests = [];
        const observationRequests = [];
        const transitionRequests = [];
        let observationCount = 0;
        let step = execution.next();
        while (!step.done) {
            const operation = step.value;
            if (operation.name === RESOLVE_WORKFLOW_DEFINITION_ACTIVITY) {
                step = execution.next({
                    definitionId: "definition-control",
                    manifest: controlManifest,
                });
            } else if (operation.name === RECORD_WORKFLOW_STATE_EXECUTION_ACTIVITY) {
                recordedExecutions.push(operation.input);
                step = execution.next(undefined);
            } else if (
                operation.kind === "dequeue"
                && operation.name === workflowQuestionQueueName(1)
            ) {
                step = execution.next(JSON.stringify({
                    outcome: "publish",
                    output: { decisionId: "decision-1" },
                }));
            } else if (operation.name === EXECUTE_WORKFLOW_ACTION_ACTIVITY) {
                actionRequests.push(operation.input);
                step = execution.next({
                    outcome: "succeeded",
                    output: { publicationId: "publication-1" },
                });
            } else if (operation.name === OBSERVE_WORKFLOW_CONDITION_ACTIVITY) {
                observationRequests.push(operation.input);
                observationCount += 1;
                step = execution.next(observationCount === 1
                    ? { status: "pending", retryAfterMs: 750 }
                    : {
                        status: "completed",
                        outcome: "satisfied",
                        output: { observed: true },
                    });
            } else if (operation.kind === "timer") {
                assert.equal(operation.delayMs, 750);
                step = execution.next(undefined);
            } else if (operation.name === ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY) {
                step = execution.next({
                    outcome: operation.input.outcome,
                    output: operation.input.output,
                });
            } else if (operation.name === EXECUTE_WORKFLOW_TRANSITION_ACTIVITY) {
                transitionRequests.push(operation.input);
                step = execution.next({ kind: "advance", target: targets.shift() });
            } else if (operation.kind === "utcNow") {
                step = execution.next("2026-10-07T00:00:00.000Z");
            } else if (operation.name === COMPLETE_WORKFLOW_ACTIVITY) {
                step = execution.next(operation.input.result);
            } else {
                throw new Error(`Unexpected operation: ${JSON.stringify(operation)}`);
            }
        }

        assert.equal(step.value.outcome, "succeeded");
        assert.deepEqual(step.value.result, { observed: true });
        assert.equal(observationCount, 2);
        assert.deepEqual(
            recordedExecutions.map(record => ({
                executionSequence: record.executionSequence,
                stateId: record.stateId,
                waitingOn: record.waitingOn,
            })),
            [
                { executionSequence: 1, stateId: "approve", waitingOn: "question" },
                { executionSequence: 2, stateId: "publish", waitingOn: "activity" },
                {
                    executionSequence: 3,
                    stateId: "observe",
                    waitingOn: "observed-condition",
                },
            ],
        );
        assert.deepEqual(recordedExecutions[0].waitingDetails.context, {
            changeId: "change-9",
        });
        assert.deepEqual(actionRequests, [{
            workflowSessionId: "workflow-control",
            graphId: "registered-controller@0.1.0",
            stateId: "publish",
            executionSequence: 2,
            workflowInputs: { changeId: "change-9" },
            provider: "test",
            operation: "publish",
            input: { changeId: "change-9" },
        }]);
        assert.deepEqual(
            observationRequests.map(request => ({
                executionSequence: request.executionSequence,
                operation: request.operation,
                conditions: request.conditions,
                observationAttempt: request.observationAttempt,
            })),
            [
                {
                    executionSequence: 3,
                    operation: { changeId: "change-9" },
                    conditions: { state: "complete" },
                    observationAttempt: 1,
                },
                {
                    executionSequence: 3,
                    operation: { changeId: "change-9" },
                    conditions: { state: "complete" },
                    observationAttempt: 2,
                },
            ],
        );
        assert.deepEqual(
            transitionRequests.map(request => ({
                stateId: request.stateId,
                stateOutcome: request.context.stateOutcome,
            })),
            [
                { stateId: "approve", stateOutcome: "publish" },
                { stateId: "publish", stateOutcome: "succeeded" },
                { stateId: "observe", stateOutcome: "satisfied" },
            ],
        );
    }

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

test("rejects invalid observed-condition responses and retry delays", () => {
    const observationManifest = {
        ...manifest,
        initialState: "observe",
        states: [{
            id: "observe",
            type: "observed-condition",
            provider: "test",
            operation: {},
            conditions: {},
            pollIntervalMs: 250,
            completion: { outcomes: ["satisfied"] },
            transition: {
                handler: { module: "./transitions.mjs", export: "observe" },
                allowedTargets: ["done"],
            },
        }, {
            id: "done",
            type: "terminal",
            outcome: "succeeded",
            summary: "Done.",
            hasOutput: false,
        }],
    };

    for (const invalidObservation of [
        { status: "unknown" },
        { status: "pending", retryAfterMs: 99 },
        { status: "completed", outcome: "unknown", output: null },
    ]) {
        const execution = durableWorkflowSessionOrchestration_1_0_0(createContext(), {
            sessionId: "workflow-invalid-observation",
            definition: {
                kind: "registered",
                definitionId: "definition-invalid-observation",
            },
            inputs: {},
        });
        let step = execution.next();
        assert.equal(step.value.name, RESOLVE_WORKFLOW_DEFINITION_ACTIVITY);
        step = execution.next({
            definitionId: "definition-invalid-observation",
            manifest: observationManifest,
        });
        assert.equal(step.value.name, RECORD_WORKFLOW_STATE_EXECUTION_ACTIVITY);
        step = execution.next(undefined);
        assert.equal(step.value.name, OBSERVE_WORKFLOW_CONDITION_ACTIVITY);

        assert.throws(
            () => execution.next(invalidObservation),
            error => error?.code === (
                invalidObservation.status === "completed"
                    ? "WORKFLOW_STATE_OUTCOME_INVALID"
                    : "WORKFLOW_OBSERVATION_INVALID"
            ),
        );
    }
});

test("rejects undeclared action outcomes before accepting the execution", () => {
    const actionManifest = {
        ...manifest,
        initialState: "act",
        states: [{
            id: "act",
            type: "action",
            provider: "test",
            operation: "publish",
            input: {},
            completion: { outcomes: ["succeeded"] },
            transition: {
                handler: { module: "./transitions.mjs", export: "act" },
                allowedTargets: ["done"],
            },
        }, {
            id: "done",
            type: "terminal",
            outcome: "succeeded",
            summary: "Done.",
            hasOutput: false,
        }],
    };
    const execution = durableWorkflowSessionOrchestration_1_0_0(createContext(), {
        sessionId: "workflow-invalid-action",
        definition: {
            kind: "registered",
            definitionId: "definition-invalid-action",
        },
        inputs: {},
    });
    let step = execution.next();
    step = execution.next({
        definitionId: "definition-invalid-action",
        manifest: actionManifest,
    });
    step = execution.next(undefined);
    assert.equal(step.value.name, EXECUTE_WORKFLOW_ACTION_ACTIVITY);

    assert.throws(
        () => execution.next({ outcome: "failed", output: null }),
        error => error?.code === "WORKFLOW_STATE_OUTCOME_INVALID",
    );
});

test("stops registered workflow cycles at the transition limit", () => {
    const cycleManifest = {
        ...manifest,
        initialState: "repeat",
        states: [{
            id: "repeat",
            type: "action",
            provider: "test",
            operation: "repeat",
            input: {},
            completion: { outcomes: ["succeeded"] },
            transition: {
                handler: { module: "./transitions.mjs", export: "repeat" },
                allowedTargets: ["repeat"],
            },
        }],
    };
    const execution = durableWorkflowSessionOrchestration_1_0_0(createContext(), {
        sessionId: "workflow-cycle",
        definition: {
            kind: "registered",
            definitionId: "definition-cycle",
        },
        inputs: {},
    });
    let step = execution.next();
    step = execution.next({
        definitionId: "definition-cycle",
        manifest: cycleManifest,
    });

    for (let transitionCount = 0; transitionCount < 100; transitionCount += 1) {
        assert.equal(step.value.name, RECORD_WORKFLOW_STATE_EXECUTION_ACTIVITY);
        step = execution.next(undefined);
        assert.equal(step.value.name, EXECUTE_WORKFLOW_ACTION_ACTIVITY);
        step = execution.next({ outcome: "succeeded", output: null });
        assert.equal(step.value.name, ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY);
        step = execution.next({ outcome: "succeeded", output: null });
        assert.equal(step.value.name, EXECUTE_WORKFLOW_TRANSITION_ACTIVITY);

        if (transitionCount === 99) {
            assert.throws(
                () => execution.next({ kind: "advance", target: "repeat" }),
                error => error?.code === "WORKFLOW_TRANSITION_LIMIT_EXCEEDED",
            );
        } else {
            step = execution.next({ kind: "advance", target: "repeat" });
        }
    }
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
