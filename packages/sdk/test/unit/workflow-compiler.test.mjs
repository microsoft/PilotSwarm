import test from "node:test";
import assert from "node:assert/strict";
import {
    WorkflowTransitionRegistry,
    compileAndRegisterWorkflowYaml,
    compileWorkflowYaml,
} from "../../dist/workflow-orchestration/compiler.js";
import {
    clearInMemoryWorkflowGraphs,
    resolveInMemoryWorkflowGraph,
} from "../../dist/workflow-orchestration/graph.js";

const VALID_WORKFLOW = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata:
  name: delivery
  version: 0.1.0
inputs:
  changeId:
    type: string
    required: true
configuration:
  policy:
    retries: 2
initial: inspect
states:
  inspect:
    type: agent
    agent: delivery-inspector
    input:
      changeId: \${inputs.changeId}
      retries: \${configuration.policy.retries}
    result:
      schema: delivery/inspection/v1
    completion:
      mode: one-shot
      outcomes:
        - succeeded
        - blocked
    transition:
      handler: delivery.inspect
  publish:
    type: agent
    agent: delivery-publisher
    input:
      inspection: \${states.inspect.result}
    result:
      schema: delivery/publication/v1
    completion:
      mode: one-shot
      outcomes:
        - succeeded
        - failed
    transition:
      handler: delivery.publish
  committed:
    type: terminal
    outcome: succeeded
    output: \${states.publish.result}
  needs-attention:
    type: terminal
    outcome: blocked
    output:
      inspection: \${states.inspect.result}
  failed:
    type: terminal
    outcome: failed
`;

function createRegistry(calls = []) {
    return new WorkflowTransitionRegistry()
        .register("delivery.inspect", {
            allowedTargets: ["publish", "needs-attention"],
            handler: context => {
                calls.push(context);
                return {
                    kind: "advance",
                    target: context.stateOutcome === "succeeded"
                        ? "publish"
                        : "needs-attention",
                };
            },
        })
        .register("delivery.publish", {
            allowedTargets: ["committed", "failed"],
            handler: context => ({
                kind: "advance",
                target: context.stateOutcome === "succeeded" ? "committed" : "failed",
            }),
        });
}

function executionContext(overrides = {}) {
    return {
        sessionId: "workflow-1",
        stateId: "inspect",
        executionSequence: 1,
        workflowInputs: { changeId: "change-7" },
        latestStateOutputs: {},
        executionHistory: [],
        ...overrides,
    };
}

test.beforeEach(() => clearInMemoryWorkflowGraphs());
test.afterEach(() => clearInMemoryWorkflowGraphs());

test("compiles the v1alpha1 agent and terminal subset into an in-memory graph", () => {
    const compiled = compileWorkflowYaml(VALID_WORKFLOW, {
        transitions: createRegistry(),
    });

    assert.equal(compiled.graph.id, "delivery@0.1.0");
    assert.equal(compiled.graph.initialState, "inspect");
    assert.deepEqual(compiled.metadata, { name: "delivery", version: "0.1.0" });
    assert.deepEqual(compiled.inputSchema, {
        changeId: { type: "string", required: true },
    });
    assert.deepEqual(compiled.configuration, { policy: { retries: 2 } });

    const inspect = compiled.graph.states.inspect;
    assert.equal(inspect.type, "agent");
    assert.equal(inspect.agent, "delivery-inspector");
    assert.deepEqual(inspect.allowedOutcomes, ["succeeded", "blocked"]);
    assert.deepEqual(inspect.allowedTargets, ["publish", "needs-attention"]);
    assert.match(inspect.prompt(executionContext()), /"changeId": "change-7"/);
    assert.match(inspect.prompt(executionContext()), /"retries": 2/);
    assert.match(inspect.prompt(executionContext()), /submit_workflow_result/);
    assert.match(inspect.prompt(executionContext()), /delivery\/inspection\/v1/);

    const committed = compiled.graph.states.committed;
    assert.equal(committed.type, "terminal");
    assert.equal(committed.summary, "Workflow 'delivery' completed with outcome 'succeeded'.");
    assert.deepEqual(committed.result({
        workflowInputs: { changeId: "change-7" },
        latestStateOutputs: {
            publish: { outcome: "succeeded", output: { pullRequest: 17 } },
        },
        executionHistory: [],
    }), { pullRequest: 17 });
});

test("registered handlers receive immutable workflow context and choose the next state", () => {
    const calls = [];
    const compiled = compileWorkflowYaml(VALID_WORKFLOW, {
        transitions: createRegistry(calls),
    });
    const state = compiled.graph.states.inspect;
    const target = state.transition({
        workflowInputs: { changeId: "change-7" },
        currentStateId: "inspect",
        stateOutcome: "succeeded",
        stateOutput: { sourceCommit: "abc" },
        latestStateOutputs: {
            inspect: { outcome: "succeeded", output: { sourceCommit: "abc" } },
        },
        executionHistory: [{
            stateId: "inspect",
            executionSequence: 1,
            outcome: "succeeded",
            output: { sourceCommit: "abc" },
        }],
    });

    assert.equal(target, "publish");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].graphId, "delivery@0.1.0");
    assert.deepEqual(calls[0].metadata, { name: "delivery", version: "0.1.0" });
    assert.deepEqual(calls[0].configuration, { policy: { retries: 2 } });
    assert.equal(calls[0].stateOutcome, "succeeded");
    assert.deepEqual(calls[0].completion, {});
    assert.ok(Object.isFrozen(calls[0]));
    assert.ok(Object.isFrozen(calls[0].configuration));
    assert.ok(Object.isFrozen(calls[0].completion));
});

test("compiles and registers a graph for the existing orchestration lookup", () => {
    const { compiled, definition } = compileAndRegisterWorkflowYaml(VALID_WORKFLOW, {
        transitions: createRegistry(),
    });

    assert.deepEqual(definition, {
        kind: "in-memory",
        graphId: "delivery@0.1.0",
    });
    assert.equal(resolveInMemoryWorkflowGraph(definition.graphId), compiled.graph);
});

test("requires every agent state to reference a registered transition handler", () => {
    assert.throws(
        () => compileWorkflowYaml(VALID_WORKFLOW, {
            transitions: new WorkflowTransitionRegistry(),
        }),
        error => error?.code === "WORKFLOW_TRANSITION_HANDLER_NOT_REGISTERED"
            && /delivery\.inspect/.test(error.message),
    );
});

test("rejects inline transition syntax instead of maintaining two programming models", () => {
    const yaml = VALID_WORKFLOW.replace(
        "    transition:\n      handler: delivery.inspect",
        "    next:\n      cases:\n        succeeded:\n          to: publish",
    );

    assert.throws(
        () => compileWorkflowYaml(yaml, { transitions: createRegistry() }),
        error => error?.code === "WORKFLOW_INLINE_TRANSITION_UNSUPPORTED",
    );
});

test("rejects unsupported state and completion types with specific errors", () => {
    const actionYaml = VALID_WORKFLOW.replace("type: agent", "type: action");
    assert.throws(
        () => compileWorkflowYaml(actionYaml, { transitions: createRegistry() }),
        error => error?.code === "WORKFLOW_STATE_TYPE_UNSUPPORTED",
    );

    const reviewedYaml = VALID_WORKFLOW.replace("mode: one-shot", "mode: reviewed");
    assert.throws(
        () => compileWorkflowYaml(reviewedYaml, { transitions: createRegistry() }),
        error => error?.code === "WORKFLOW_COMPLETION_MODE_UNSUPPORTED",
    );
});

test("validates transition registration names, targets, and duplicates", () => {
    const registry = new WorkflowTransitionRegistry();
    registry.register("delivery.inspect", {
        allowedTargets: ["missing-state"],
        handler: () => ({ kind: "advance", target: "missing-state" }),
    });

    assert.throws(
        () => registry.register("delivery.inspect", {
            allowedTargets: ["publish"],
            handler: () => ({ kind: "advance", target: "publish" }),
        }),
        error => error?.code === "WORKFLOW_TRANSITION_HANDLER_ALREADY_REGISTERED",
    );
    assert.throws(
        () => compileWorkflowYaml(VALID_WORKFLOW, { transitions: registry }),
        error => error?.code === "WORKFLOW_TRANSITION_TARGET_INVALID"
            && /missing-state/.test(error.message),
    );
});

test("rejects asynchronous and invalid transition handler results at execution time", () => {
    const asyncRegistry = new WorkflowTransitionRegistry()
        .register("delivery.inspect", {
            allowedTargets: ["publish"],
            handler: async () => ({ kind: "advance", target: "publish" }),
        })
        .register("delivery.publish", {
            allowedTargets: ["committed", "failed"],
            handler: () => ({ kind: "advance", target: "committed" }),
        });
    const asyncState = compileWorkflowYaml(VALID_WORKFLOW, {
        transitions: asyncRegistry,
    }).graph.states.inspect;
    assert.throws(
        () => asyncState.transition({
            workflowInputs: {},
            currentStateId: "inspect",
            stateOutcome: "succeeded",
            stateOutput: {},
            latestStateOutputs: {},
            executionHistory: [],
        }),
        error => error?.code === "WORKFLOW_TRANSITION_ASYNC",
    );

    const invalidRegistry = new WorkflowTransitionRegistry()
        .register("delivery.inspect", {
            allowedTargets: ["publish"],
            handler: () => "",
        })
        .register("delivery.publish", {
            allowedTargets: ["committed", "failed"],
            handler: () => ({ kind: "advance", target: "committed" }),
        });
    const invalidState = compileWorkflowYaml(VALID_WORKFLOW, {
        transitions: invalidRegistry,
    }).graph.states.inspect;
    assert.throws(
        () => invalidState.transition({
            workflowInputs: {},
            currentStateId: "inspect",
            stateOutcome: "succeeded",
            stateOutput: {},
            latestStateOutputs: {},
            executionHistory: [],
        }),
        error => error?.code === "WORKFLOW_TRANSITION_RESULT_INVALID",
    );
});

test("rejects producer-resume directives for the initial one-shot subset", () => {
    const registry = new WorkflowTransitionRegistry()
        .register("delivery.inspect", {
            allowedTargets: ["publish"],
            handler: () => ({
                kind: "resume-producer",
                feedback: "Revise the candidate.",
            }),
        })
        .register("delivery.publish", {
            allowedTargets: ["committed", "failed"],
            handler: () => ({ kind: "advance", target: "committed" }),
        });
    const state = compileWorkflowYaml(VALID_WORKFLOW, {
        transitions: registry,
    }).graph.states.inspect;

    assert.throws(
        () => state.transition({
            workflowInputs: {},
            currentStateId: "inspect",
            stateOutcome: "blocked",
            stateOutput: {},
            latestStateOutputs: {},
            executionHistory: [],
        }),
        error => error?.code === "WORKFLOW_TRANSITION_DIRECTIVE_UNSUPPORTED",
    );
});

test("resolves previous state results in downstream agent inputs", () => {
    const state = compileWorkflowYaml(VALID_WORKFLOW, {
        transitions: createRegistry(),
    }).graph.states.publish;
    const prompt = state.prompt(executionContext({
        stateId: "publish",
        executionSequence: 2,
        latestStateOutputs: {
            inspect: {
                outcome: "succeeded",
                output: { sourceCommit: "abc" },
            },
        },
    }));

    assert.match(prompt, /"sourceCommit": "abc"/);
});

test("fails explicitly when a runtime expression cannot be resolved", () => {
    const state = compileWorkflowYaml(VALID_WORKFLOW, {
        transitions: createRegistry(),
    }).graph.states.publish;

    assert.throws(
        () => state.prompt(executionContext({
            stateId: "publish",
            executionSequence: 2,
        })),
        error => error?.code === "WORKFLOW_EXPRESSION_UNRESOLVED"
            && /before it has produced a result/.test(error.message),
    );
});

test("rejects malformed YAML, unsupported envelopes, embedded expressions, and unknown state references", () => {
    assert.throws(
        () => compileWorkflowYaml("apiVersion: [", { transitions: createRegistry() }),
        error => error?.code === "WORKFLOW_YAML_INVALID",
    );
    assert.throws(
        () => compileWorkflowYaml(
            VALID_WORKFLOW.replace("pilotswarm.dev/v1alpha1", "pilotswarm.dev/v2"),
            { transitions: createRegistry() },
        ),
        /Unsupported workflow apiVersion/,
    );
    assert.throws(
        () => compileWorkflowYaml(
            VALID_WORKFLOW.replace("changeId: ${inputs.changeId}", "changeId: change-${inputs.changeId}"),
            { transitions: createRegistry() },
        ),
        error => error?.code === "WORKFLOW_EXPRESSION_UNSUPPORTED",
    );
    assert.throws(
        () => compileWorkflowYaml(
            VALID_WORKFLOW.replace(
                "inspection: ${states.inspect.result}",
                "inspection: ${states.unknown.result}",
            ),
            { transitions: createRegistry() },
        ),
        /references unknown workflow state 'unknown'/,
    );
});

test("preserves prototype-sensitive state ids as ordinary graph entries", () => {
    const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata:
  name: prototype-safe
  version: 0.1.0
initial: __proto__
states:
  __proto__:
    type: terminal
    outcome: succeeded
  constructor:
    type: terminal
    outcome: blocked
  prototype:
    type: terminal
    outcome: failed
`;

    const compiled = compileWorkflowYaml(yaml, {
        transitions: new WorkflowTransitionRegistry(),
    });

    assert.equal(Object.getPrototypeOf(compiled.graph.states), null);
    assert.deepEqual(
        Object.keys(compiled.graph.states),
        ["__proto__", "constructor", "prototype"],
    );
    assert.equal(compiled.graph.states.__proto__.type, "terminal");
    assert.equal(compiled.graph.states.constructor.type, "terminal");
    assert.equal(compiled.graph.states.prototype.type, "terminal");
});
