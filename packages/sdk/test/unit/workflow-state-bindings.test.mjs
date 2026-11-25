import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow, parseWorkflowIr } from "../../dist/workflow/compiler.js";
import { evaluateBindingTemplate } from "../../dist/workflow/bindings.js";

function yaml(statesBlock, extra = "") {
    return `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: state-bindings-test
  version: 0.1.0
${extra}initial: first
states:
${statesBlock}`;
}

test("compiler accepts ${states.<id>.output}, nested fields, ?? defaults, and self-references", () => {
    const res = compileWorkflow(yaml(`  first:
    type: script
    input:
      prev: "\${states.first.output.items ?? []}"
      raw: "\${states.first.output}"
    outcomes: [done]
    source: |
      await setResult("done", { items: [...context.input.prev, 1] });
    transition: { next: { done: finished, failure: failed } }
  finished:
    type: terminal
    outcome: succeeded
    output:
      items: "\${states.first.output.items}"
      whole: "\${states.first.output}"
  failed:
    type: terminal
    outcome: failed
    output: "\${runtime.error}"
`));
    assert.equal(res.valid, true, JSON.stringify(res.diagnostics));
    const parsed = parseWorkflowIr(res.ir);
    assert.deepEqual(parsed.nodes.first.input, { prev: "${states.first.output.items ?? []}", raw: "${states.first.output}" });
});

test("compiler rejects unknown state id, non-.output member, bare states.<id>, and states in initialInput", () => {
    const unknownId = compileWorkflow(yaml(`  first:
    type: script
    input: { x: "\${states.no_such.output}" }
    outcomes: [ok]
    source: "await setResult('ok', {});"
    transition: { next: { ok: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`));
    assert.equal(unknownId.valid, false);
    assert.ok(unknownId.diagnostics.some(d => d.code === "WORKFLOW_BINDING_INVALID" && /no_such/.test(d.message)), JSON.stringify(unknownId.diagnostics));

    for (const expr of ["${states.first.input}", "${states.first.outcome}", "${states.first}", "${states}"]) {
        const badMember = compileWorkflow(yaml(`  first:
    type: script
    input: { x: "${expr}" }
    outcomes: [ok]
    source: "await setResult('ok', {});"
    transition: { next: { ok: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`));
        assert.equal(badMember.valid, false, `expected ${expr} to fail`);
        assert.ok(badMember.diagnostics.some(d => d.code === "WORKFLOW_BINDING_INVALID"), JSON.stringify(badMember.diagnostics));
    }

    const inInitial = compileWorkflow(yaml(`  first:
    type: script
    outcomes: [ok]
    source: "await setResult('ok', {});"
    transition: { next: { ok: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`, `initialInput: "\${states.first.output}"\n`));
    assert.equal(inInitial.valid, false);
    assert.ok(inInitial.diagnostics.some(d => d.code === "WORKFLOW_BINDING_INVALID" && /initialInput/.test(d.path)));
});

test("evaluateBindingTemplate resolves unvisited state to null or ?? default without breaking own null", () => {
    const scope = { inputs: {}, input: null, kv: {}, runtime: { error: null }, states: { a: {}, b: { output: null }, c: { output: { n: 7 } } } };
    assert.equal(evaluateBindingTemplate("${states.a.output}", scope), null);
    assert.deepEqual(evaluateBindingTemplate("${states.a.output ?? []}", scope), []);
    assert.deepEqual(evaluateBindingTemplate("${states.a.output.items ?? []}", scope), []);
    assert.throws(() => evaluateBindingTemplate("${states.a.output.items}", scope), /could not resolve .*items.* of states/);
    assert.equal(evaluateBindingTemplate("${states.b.output}", scope), null);
    assert.equal(evaluateBindingTemplate("${states.c.output.n}", scope), 7);
});
