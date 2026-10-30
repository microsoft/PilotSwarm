import assert from "node:assert/strict";
import test from "node:test";
import {
    compileWorkflow,
    resolveWorkflowTemplate,
    validateWorkflowInputs,
    WorkflowCompileError,
    WORKFLOW_MAX_YAML_BYTES,
} from "../../dist/workflow/compiler.js";
import { executeWorkflow, WorkflowExecutionError } from "../../dist/workflow/executor.js";

const VALID = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata:
  name: tool-aware-script
  version: 1.0.0
inputs:
  pattern: { type: string, required: true }
  limit: { type: integer }
configuration:
  label: nightly
initial: collect
states:
  collect:
    type: script
    runtime: python
    timeoutSeconds: 60
    source: |
      print('{"outcome":"found","output":{"value":1}}')
    completion: { outcomes: [found, empty] }
    transition:
      next: { found: done, empty: nothing }
  done:
    type: terminal
    outcome: succeeded
    summary: Found it.
    output:
      value: \${states.collect.result.value}
      label: \${configuration.label}
  nothing:
    type: terminal
    outcome: blocked
`;

const rejects = (yaml, pattern, code) => assert.throws(() => compileWorkflow(yaml), (error) => {
    assert.ok(error instanceof WorkflowCompileError, `expected WorkflowCompileError, got ${error}`);
    assert.match(error.message, pattern);
    if (code) assert.equal(error.code, code);
    return true;
});

test("compiles a Workflow document with script and terminal states", () => {
    const compiled = compileWorkflow(VALID);
    assert.equal(compiled.name, "tool-aware-script");
    assert.equal(compiled.version, "1.0.0");
    assert.equal(compiled.initial, "collect");
    assert.deepEqual(compiled.inputs, { pattern: { type: "string", required: true }, limit: { type: "integer" } });
    assert.deepEqual(compiled.states.collect, {
        id: "collect", type: "script", runtime: "python", timeoutSeconds: 60,
        source: "print('{\"outcome\":\"found\",\"output\":{\"value\":1}}')\n",
        outcomes: ["found", "empty"], next: { found: "done", empty: "nothing" },
    });
    assert.equal(compiled.states.done.type, "terminal");
    assert.equal(compiled.states.done.outcome, "succeeded");
    assert.equal(compiled.states.nothing.summary, "Workflow 'tool-aware-script' ended with outcome 'blocked'.");
});

test("the document shape is PR 116's: kind Workflow, metadata.version, initial, states, completion, transition", () => {
    rejects(VALID.replace("kind: Workflow", "kind: ScriptWorkflow"), /kind must be 'Workflow'/);
    rejects(VALID.replace("  version: 1.0.0\n", ""), /metadata\.version must be a non-empty string/);
    rejects(VALID.replace("initial: collect", "initial: missing"), /initial references unknown state 'missing'/);
    rejects(VALID.replace("    completion: { outcomes: [found, empty] }\n", ""), /states\.collect\.completion must be a mapping/);
});

test("state types and transition forms from later versions are refused, not misread", () => {
    rejects(VALID.replace("type: script", "type: agent"), /type 'agent' is not supported yet/, "WORKFLOW_STATE_TYPE_UNSUPPORTED");
    for (const type of ["question", "action", "observed-condition"]) {
        rejects(VALID.replace("type: script", `type: ${type}`), new RegExp(`type '${type}' is not supported yet`));
    }
    rejects(VALID.replace("type: script", "type: banana"), /'banana' is not a workflow state type/);
    rejects(VALID.replace("      next: { found: done, empty: nothing }", "      handler: { module: ./t.mjs, export: collect }"),
        /transition\.handler is not supported yet/, "WORKFLOW_TRANSITION_HANDLER_UNSUPPORTED");
    rejects(VALID.replace("    transition:\n", "    next: { found: done }\n    transition:\n"),
        /declares transitions outside 'transition'/, "WORKFLOW_INLINE_TRANSITION_UNSUPPORTED");
    rejects(VALID.replace("initial: collect", "identity: { primaryKey: [inputs.pattern] }\ninitial: collect"), /identity is not supported yet/);
});

test("every declared outcome has exactly one known target", () => {
    rejects(VALID.replace("{ found: done, empty: nothing }", "{ found: done }"), /no target for outcome 'empty'/);
    rejects(VALID.replace("{ found: done, empty: nothing }", "{ found: done, empty: nothing, extra: done }"), /next\.extra is not a declared outcome/);
    rejects(VALID.replace("{ found: done, empty: nothing }", "{ found: missing, empty: nothing }"), /unknown state 'missing'/);
    rejects(VALID.replace("[found, empty]", "[found, found]"), /must not repeat an outcome/);
});

test("terminal states and graph rules", () => {
    rejects(VALID.replace("outcome: succeeded", "outcome: done"), /outcome must be one of succeeded, blocked, failed, cancelled/);
    rejects(VALID.replace("initial: collect", "initial: done"), /initial must be a script state/);
    rejects(VALID.replace("value: ${states.collect.result.value}", "value: ${states.nope.result}"), /references unknown state 'nope'/);
    rejects(VALID.replace("label: ${configuration.label}", "label: x-${configuration.label}"), /embeds an expression/);
    const noTerminal = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: loop, version: "1" }
initial: a
states:
  a: { type: script, runtime: node, source: x, completion: { outcomes: [again] }, transition: { next: { again: a } } }
`;
    rejects(noTerminal, /at least one terminal state/);
});

test("limits on ids, timeouts, document size and YAML strictness", () => {
    rejects(VALID.replace(/collect/g, "1collect"), /must use a letter/);
    rejects(VALID.replace("timeoutSeconds: 60", "timeoutSeconds: 0"), /timeoutSeconds must be an integer from 1 to 3600/);
    rejects(VALID.replace("runtime: python", "runtime: bash"), /runtime must be node, python or powershell/);
    rejects(`# ${"x".repeat(WORKFLOW_MAX_YAML_BYTES)}\n${VALID}`, /at most/);
    rejects(VALID.replace("initial: collect", "initial: collect\ninitial: collect"), /Workflow YAML is invalid/);
});

test("inputs are checked against the declared schema", () => {
    const compiled = compileWorkflow(VALID);
    validateWorkflowInputs(compiled, { pattern: "metrics/%", limit: 5, extra: true });
    assert.throws(() => validateWorkflowInputs(compiled, {}), /Input 'pattern' is required/);
    assert.throws(() => validateWorkflowInputs(compiled, { pattern: 3 }), /must be of type string/);
    assert.throws(() => validateWorkflowInputs(compiled, { pattern: "x", limit: 1.5 }), /must be of type integer/);
});

test("terminal output templates resolve exact expressions only", () => {
    const context = { inputs: { a: 1 }, configuration: { c: "x" }, results: { s: { n: 2 } } };
    assert.deepEqual(resolveWorkflowTemplate({ a: "${inputs.a}", c: "${configuration.c}", n: "${states.s.result.n}", plain: "text" }, "out", context),
        { a: 1, c: "x", n: 2, plain: "text" });
    assert.throws(() => resolveWorkflowTemplate("${states.t.result}", "out", context), /before it ran/);
});

test("in-process execution follows declared transitions to a terminal state", async () => {
    const workflow = compileWorkflow(VALID);
    const result = await executeWorkflow(workflow, { pattern: "p" }, async () => ({ outcome: "found", output: { value: 7 } }));
    assert.deepEqual(result, {
        outcome: "succeeded",
        summary: "Found it.",
        output: { value: 7, label: "nightly" },
        transitions: 1,
        terminalStateId: "done",
    });
});

test("an undeclared outcome fails the run", async () => {
    await assert.rejects(
        () => executeWorkflow(compileWorkflow(VALID), {}, async () => ({ outcome: "unexpected", output: null })),
        (error) => error instanceof WorkflowExecutionError && /undeclared outcome 'unexpected' \(declared: found, empty\)/.test(error.message),
    );
});
