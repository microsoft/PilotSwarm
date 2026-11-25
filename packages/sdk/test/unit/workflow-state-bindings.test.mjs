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

test("K1: compiler rejects ${states.<id>.output} referencing a parallel body state from root, root terminal, or sibling branch", () => {
    const makeParallel = (extraAlpha, rootReader, doneReader) => `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: k1-parallel-scope, version: "1.0.0" }
initial: fan
states:
  fan:
    type: parallel
    concurrency: 2
    branches:
      alpha:
        initial: a1
        states:
          a1:
            type: script
            outcomes: [ok]
            source: "await setResult('ok', { a: 1 });"
            transition: { next: { ok: a2, failure: a_end } }
          a2:
            type: script
            input: ${extraAlpha}
            outcomes: [ok]
            source: "await setResult('ok', context.input);"
            transition: { next: { ok: a_end, failure: a_end } }
          a_end: { type: terminal, outcome: succeeded, output: "\${states.a2.output}" }
      beta:
        initial: b1
        states:
          b1:
            type: script
            outcomes: [ok]
            source: "await setResult('ok', { b: 2 });"
            transition: { next: { ok: b_end, failure: b_end } }
          b_end: { type: terminal, outcome: succeeded, output: "\${states.b1.output}" }
    transition: { next: { joined: after, blocked: failed, failure: failed } }
  after:
    type: script
    input: ${rootReader}
    outcomes: [ok]
    source: "await setResult('ok', context.input);"
    transition: { next: { ok: done, failure: failed } }
  done:
    type: terminal
    outcome: succeeded
    output: ${doneReader}
  failed: { type: terminal, outcome: failed }
`;

    // Cross-branch: alpha reads beta's b1
    const cross = compileWorkflow(makeParallel('{ bad: "${states.b1.output}" }', '{}', '{}'));
    assert.equal(cross.valid, false);
    const crossErr = cross.diagnostics.find(d => d.code === "WORKFLOW_BINDING_INVALID");
    assert.ok(crossErr, JSON.stringify(cross.diagnostics));
    assert.ok(Number.isInteger(crossErr.line), `expected line number, got ${JSON.stringify(crossErr)}`);
    assert.match(crossErr.message, /only visible inside its branch/);

    // Root state reading parallel branch state a1
    const fromRoot = compileWorkflow(makeParallel('{}', '{ bad: "${states.a1.output}" }', '{}'));
    assert.equal(fromRoot.valid, false);
    const rootErr = fromRoot.diagnostics.find(d => d.code === "WORKFLOW_BINDING_INVALID");
    assert.ok(rootErr && Number.isInteger(rootErr.line));
    assert.match(rootErr.message, /only visible inside its branch/);

    // Root terminal output reading parallel branch state a1
    const fromTerm = compileWorkflow(makeParallel('{}', '{}', '{ bad: "${states.a1.output}" }'));
    assert.equal(fromTerm.valid, false);
    const termErr = fromTerm.diagnostics.find(d => d.code === "WORKFLOW_BINDING_INVALID");
    assert.ok(termErr && Number.isInteger(termErr.line));
    assert.match(termErr.message, /only visible inside its branch/);

    // Valid: same branch + root reading parallel state itself
    const ok = compileWorkflow(makeParallel('{ own: "${states.a1.output}" }', '{ joined: "${states.fan.output}" }', '"${states.after.output}"'));
    assert.equal(ok.valid, true, JSON.stringify(ok.diagnostics));
});
