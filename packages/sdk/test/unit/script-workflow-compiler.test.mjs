import assert from "node:assert/strict";
import test from "node:test";
import { compileScriptWorkflow, ScriptWorkflowCompileError } from "../../dist/script-workflow/compiler.js";
import { executeScriptWorkflow, ScriptWorkflowExecutionError } from "../../dist/script-workflow/executor.js";

const validWorkflow = `
apiVersion: pilotswarm.dev/v1alpha1
kind: ScriptWorkflow
metadata:
  name: tool-aware-script
spec:
  entry: collect
  nodes:
    collect:
      type: script
      runtime: python
      source: |
        print('{"outcome":"success","output":{"value":1}}')
      next:
        success: null
`;

test("compiles a script-only workflow", () => {
    const compiled = compileScriptWorkflow(validWorkflow);
    assert.equal(compiled.name, "tool-aware-script");
    assert.equal(compiled.entry, "collect");
    assert.deepEqual(compiled.nodes.collect.next, { success: null });
});

test("rejects deferred agent nodes", () => {
    assert.throws(
        () => compileScriptWorkflow(validWorkflow.replace("type: script", "type: agent")),
        (error) => error instanceof ScriptWorkflowCompileError && /agent nodes are not supported/.test(error.message),
    );
});

test("rejects a transition to an unknown node", () => {
    assert.throws(
        () => compileScriptWorkflow(validWorkflow.replace("success: null", "success: missing")),
        (error) => error instanceof ScriptWorkflowCompileError && /unknown node 'missing'/.test(error.message),
    );
});

test("executes declared transitions and returns the terminal script output", async () => {
    const workflow = compileScriptWorkflow(validWorkflow);
    const result = await executeScriptWorkflow(workflow, {}, async () => ({
        outcome: "success",
        output: { value: 1 },
    }));
    assert.deepEqual(result, {
        outcome: "success",
        output: { value: 1 },
        transitions: 1,
        terminalNodeId: "collect",
    });
});

test("rejects undeclared script outcomes", async () => {
    await assert.rejects(
        () => executeScriptWorkflow(compileScriptWorkflow(validWorkflow), {}, async () => ({
            outcome: "unexpected",
            output: null,
        })),
        (error) => error instanceof ScriptWorkflowExecutionError && /undeclared outcome/.test(error.message),
    );
});
