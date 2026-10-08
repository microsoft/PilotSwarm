import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
    WorkflowTransitionRegistry,
    compileAndRegisterWorkflowYaml,
    compileWorkflowYaml,
} from "../../dist/workflow-orchestration/compiler.js";
import {
    compileWorkflowPackageYaml,
    loadWorkflowTransitionRegistry,
} from "../../dist/workflow-orchestration/package-loader.js";
import {
    clearInMemoryWorkflowGraphs,
    resolveInMemoryWorkflowGraph,
} from "../../dist/workflow-orchestration/graph.js";

const PACKAGE_ROOT = fileURLToPath(
    new URL("../fixtures/workflow-package/", import.meta.url),
);
const INSPECT_HANDLER = {
    module: "./transitions.mjs",
    export: "inspect",
};
const PUBLISH_HANDLER = {
    module: "./transitions.mjs",
    export: "publish",
};

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
      handler:
        module: ./transitions.mjs
        export: inspect
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
      handler:
        module: ./transitions.mjs
        export: publish
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
        .register(INSPECT_HANDLER, {
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
        .register(PUBLISH_HANDLER, {
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
            && /transitions\.mjs/.test(error.message)
            && /inspect/.test(error.message),
    );
});

test("rejects inline transition syntax instead of maintaining two programming models", () => {
    const yaml = VALID_WORKFLOW.replace(
        "    transition:\n      handler:\n        module: ./transitions.mjs\n        export: inspect",
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
    registry.register(INSPECT_HANDLER, {
        allowedTargets: ["missing-state"],
        handler: () => ({ kind: "advance", target: "missing-state" }),
    });

    assert.throws(
        () => registry.register(INSPECT_HANDLER, {
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
        .register(INSPECT_HANDLER, {
            allowedTargets: ["publish"],
            handler: async () => ({ kind: "advance", target: "publish" }),
        })
        .register(PUBLISH_HANDLER, {
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
        .register(INSPECT_HANDLER, {
            allowedTargets: ["publish"],
            handler: () => "",
        })
        .register(PUBLISH_HANDLER, {
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
        .register(INSPECT_HANDLER, {
            allowedTargets: ["publish"],
            handler: () => ({
                kind: "resume-producer",
                feedback: "Revise the candidate.",
            }),
        })
        .register(PUBLISH_HANDLER, {
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

test("loads package-relative transition modules before compilation", async () => {
    const compiled = await compileWorkflowPackageYaml(VALID_WORKFLOW, {
        packageRoot: PACKAGE_ROOT,
    });
    const target = compiled.graph.states.inspect.transition({
        workflowInputs: {},
        currentStateId: "inspect",
        stateOutcome: "succeeded",
        stateOutput: {},
        latestStateOutputs: {},
        executionHistory: [],
    });

    assert.equal(target, "publish");
});

test("identifies transition code by both module and package content", async () => {
    const registry = await loadWorkflowTransitionRegistry(
        VALID_WORKFLOW,
        PACKAGE_ROOT,
    );
    const identity = registry.resolve(INSPECT_HANDLER).moduleIdentity;

    assert.equal(identity.module, "./transitions.mjs");
    assert.equal(identity.export, "inspect");
    assert.match(identity.moduleSha256, /^[a-f0-9]{64}$/);
    assert.match(identity.packageSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(identity.moduleSha256, identity.packageSha256);
});

test("rejects transition modules outside the workflow package", async () => {
    const yaml = VALID_WORKFLOW.replaceAll(
        "./transitions.mjs",
        "../outside.mjs",
    );

    await assert.rejects(
        () => compileWorkflowPackageYaml(yaml, { packageRoot: PACKAGE_ROOT }),
        error => error?.code === "WORKFLOW_TRANSITION_MODULE_PATH_INVALID",
    );
});

test("rejects missing transition modules and package roots", async () => {
    const yaml = VALID_WORKFLOW.replaceAll(
        "./transitions.mjs",
        "./missing.mjs",
    );

    await assert.rejects(
        () => compileWorkflowPackageYaml(yaml, { packageRoot: PACKAGE_ROOT }),
        error => error?.code === "WORKFLOW_TRANSITION_MODULE_NOT_FOUND",
    );
    await assert.rejects(
        () => compileWorkflowPackageYaml(VALID_WORKFLOW, {
            packageRoot: `${PACKAGE_ROOT}-missing`,
        }),
        error => error?.code === "WORKFLOW_PACKAGE_ROOT_NOT_FOUND",
    );
});

test("reports transition module evaluation failures explicitly", async () => {
    const yaml = VALID_WORKFLOW.replaceAll(
        "./transitions.mjs",
        "./invalid-transitions.mjs",
    );

    await assert.rejects(
        () => compileWorkflowPackageYaml(yaml, { packageRoot: PACKAGE_ROOT }),
        error => error?.code === "WORKFLOW_TRANSITION_MODULE_LOAD_FAILED"
            && error.cause?.message === "fixture module failed during evaluation",
    );
});

test("rejects missing transition module exports", async () => {
    const yaml = VALID_WORKFLOW.replace(
        "export: inspect",
        "export: missing",
    );

    await assert.rejects(
        () => compileWorkflowPackageYaml(yaml, { packageRoot: PACKAGE_ROOT }),
        error => error?.code === "WORKFLOW_TRANSITION_EXPORT_INVALID",
    );
});
