import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow, validateWorkflowYaml } from "../../dist/index.js";
import { workflowCommandStatus } from "../../dist/workflow/human-commands.js";

const VALID_WITH_REF = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: sum-pair
  version: "1.0.0"
inputs:
  schema:
    $ref: "#/schemas/Input"
schemas:
  Input:
    type: object
    required: [a, b]
    properties:
      a: { type: number }
      b: { type: number }
initial: compute
states:
  compute:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { sum: Number(context.inputs.a) + Number(context.inputs.b) });
    transition:
      next:
        ok: done
        failure: failed
  done:
    type: terminal
    outcome: succeeded
    output: "\${input}"
  failed:
    type: terminal
    outcome: failed
    output: "\${runtime.error}"
`;

test("Task 1: pilotswarm-sdk publicly exports compileWorkflow and validateWorkflowYaml", () => {
    assert.equal(typeof compileWorkflow, "function");
    assert.equal(typeof validateWorkflowYaml, "function");
});

test("Task 1: validateWorkflowYaml returns graph (without revision) and resolved inputsSchema for valid YAML with $ref", async () => {
    const res = await validateWorkflowYaml(VALID_WITH_REF);
    assert.equal(res.valid, true);
    assert.equal(res.name, "sum-pair");
    assert.deepEqual(res.errors, []);
    assert.ok(res.graph && typeof res.graph === "object");
    assert.equal(Object.hasOwn(res.graph, "revision"), false);
    assert.equal(res.graph.initial, "compute");
    assert.ok(Array.isArray(res.graph.states));
    assert.ok(res.inputsSchema && typeof res.inputsSchema === "object");
    assert.equal(res.inputsSchema.type, "object");
    assert.deepEqual(res.inputsSchema.required, ["a", "b"]);
    assert.equal(res.inputsSchema.$ref, undefined);
});

test("Task 1: validateWorkflowYaml returns line/path errors and null graph/inputsSchema for invalid YAML", async () => {
    const unknownType = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: bad-type
initial: run
states:
  run:
    type: javascript
    source: "return 1;"
`;
    const r1 = await validateWorkflowYaml(unknownType);
    assert.equal(r1.valid, false);
    assert.equal(r1.name, "bad-type");
    assert.equal(r1.graph, null);
    assert.equal(r1.inputsSchema, null);
    assert.ok(r1.errors.some(e => e.code === "WORKFLOW_NODE_TYPE_UNKNOWN" && e.path === "states.run.type"));

    const badScript = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: bad-script
initial: run
states:
  run:
    type: script
    outcomes: [ok]
    source: "const = ;"
    transition:
      next:
        ok: done
        failure: failed
  done:
    type: terminal
    outcome: succeeded
    output: "\${input}"
  failed:
    type: terminal
    outcome: failed
    output: "\${runtime.error}"
`;
    const r2 = await validateWorkflowYaml(badScript);
    assert.equal(r2.valid, false);
    assert.equal(r2.graph, null);
    assert.equal(r2.inputsSchema, null);
    assert.ok(r2.errors.length > 0);
    assert.ok(r2.errors.some(e => e.code === "WORKFLOW_SCRIPT_SYNTAX"));

    const dupKey = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: dup-key
  name: dup-key-2
initial: done
states:
  done:
    type: terminal
    outcome: succeeded
    output: {}
`;
    const r3 = await validateWorkflowYaml(dupKey);
    assert.equal(r3.valid, false);
    assert.equal(r3.graph, null);
    assert.equal(r3.inputsSchema, null);
    assert.ok(r3.errors.length > 0);
    assert.ok(r3.errors.some(e => typeof e.line === "number"));
});

test("Task 1: validateWorkflowYaml with scripts: false flags WORKFLOW_SCRIPTS_DISABLED using save wording", async () => {
    const res = await validateWorkflowYaml(VALID_WITH_REF, { scripts: false });
    assert.equal(res.valid, false);
    assert.equal(res.graph, null);
    assert.equal(res.inputsSchema, null);
    const err = res.errors.find(e => e.code === "WORKFLOW_SCRIPTS_DISABLED");
    assert.ok(err);
    assert.equal(err.path, "states.compute.type");
    assert.match(err.message, /PILOTSWARM_WORKFLOW_SCRIPTS=0/);
    assert.match(err.message, /Nothing was saved\./);
});

test("Task 1: validateWorkflowYaml flags WORKFLOW_DECISION_MODEL_UNAVAILABLE when decisionCapability is unavailable", async () => {
    const withDecision = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: classify
  version: "1.0.0"
initial: judge
states:
  judge:
    type: decision
    question:
      type: noul
      instructions: "Is this urgent?"
    transition:
      next:
        yes: done
        no: done
        failure: failed
  done:
    type: terminal
    outcome: succeeded
    output: "\${input}"
  failed:
    type: terminal
    outcome: failed
    output: "\${runtime.error}"
`;
    const unavailable = await validateWorkflowYaml(withDecision, {
        decisionCapability: async () => ({ available: false, defaultModel: null, models: [], reason: "no_cluster_decision_default" }),
    });
    assert.equal(unavailable.valid, false);
    assert.equal(unavailable.graph, null);
    assert.equal(unavailable.inputsSchema, null);
    assert.ok(unavailable.errors.some(e => e.code === "WORKFLOW_DECISION_MODEL_UNAVAILABLE"));

    const available = await validateWorkflowYaml(withDecision, {
        decisionCapability: async () => ({ available: true, defaultModel: "dec:m1", models: ["dec:m1"], reason: null }),
    });
    assert.equal(available.valid, true);
    assert.deepEqual(available.errors, []);
    assert.ok(available.graph);
});

test("Task 1: validateWorkflowYaml emits WORKFLOW_TOOLS_DYNAMIC and filters out save-only .source WORKFLOW_TOOLS_UNCHECKED", async () => {
    const withTools = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: tools-warn
  version: "1.0.0"
initial: run
states:
  run:
    type: script
    outcomes: [ok]
    source: |
      const t = context.inputs.toolName;
      await callTool("foo", {});
      await callTool(t, {});
      await setResult("ok", {});
    transition:
      next:
        ok: step
        failure: failed
  step:
    type: agent
    timeoutSeconds: 60
    invoke:
      prompt: "Check it."
    requiredTools: [bar]
    outcomes: [done]
    transition:
      next:
        done: done
        failure: failed
  done:
    type: terminal
    outcome: succeeded
    output: "\${input}"
  failed:
    type: terminal
    outcome: failed
    output: "\${runtime.error}"
`;
    const res = await validateWorkflowYaml(withTools);
    assert.equal(res.valid, true);
    assert.ok(res.warnings.some(w => w.code === "WORKFLOW_TOOLS_DYNAMIC" && w.path === "states.run.source"));
    assert.equal(
        res.warnings.some(w => w.code === "WORKFLOW_TOOLS_UNCHECKED" && w.path.endsWith(".source")),
        false,
        "must filter out save-only .source WORKFLOW_TOOLS_UNCHECKED warning",
    );
    assert.ok(
        res.warnings.some(w => w.code === "WORKFLOW_TOOLS_UNCHECKED" && w.path === "states.step.requiredTools"),
        "must retain agent-step requiredTools Start-will-check warning",
    );
});

test("Task 1: workflowCommandStatus maps WORKFLOW_SKILL_NOT_FOUND to 404", () => {
    assert.equal(workflowCommandStatus("WORKFLOW_SKILL_NOT_FOUND"), 404);
});

test("validateWorkflowYaml warns on context.vars and stays clean on context.kv", async () => {
    const makeYaml = (expr) => `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: check-kv
  version: "1.0.0"
initial: run
states:
  run:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { flag: ${expr} });
    transition:
      next:
        ok: done
        failure: failed
  done:
    type: terminal
    outcome: succeeded
    output: "\${input}"
  failed:
    type: terminal
    outcome: failed
    output: "\${runtime.error}"
`;
    const bad = await validateWorkflowYaml(makeYaml("context.vars.flag"));
    assert.equal(bad.valid, true);
    assert.deepEqual(bad.errors, []);
    const warning = bad.warnings.find(w => w.code === "WORKFLOW_SCRIPT_CONTEXT_VARS");
    assert.ok(warning, "expected WORKFLOW_SCRIPT_CONTEXT_VARS warning");
    assert.equal(warning.path, "states.run.source");
    assert.match(warning.message, /context\.kv/);

    const good = await validateWorkflowYaml(makeYaml("context.kv.flag"));
    assert.equal(good.valid, true);
    assert.deepEqual(good.errors, []);
    assert.equal(good.warnings.some(w => w.code === "WORKFLOW_SCRIPT_CONTEXT_VARS"), false);
});
