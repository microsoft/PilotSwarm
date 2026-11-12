import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow, parseWorkflowIr } from "../../dist/workflow/compiler.js";

const definition = (state, extra = "") => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: carry, version: "1.0.0" }
contracts:
  Test@1:
    schema: { type: object }
    response: { schema: { type: object } }
initial: work
${extra}
states:
  work:
    carry: { loop: "\${input.loop}", value: "\${kv.value ?? 0}" }
${state}
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  bad: { type: terminal, outcome: blocked, output: "\${runtime.error}" }
`;

const states = {
    script: `    type: script
    source: await setResult("ok", {});
    transition: { next: { ok: done, failure: bad } }`,
    wait: `    type: wait
    seconds: 10
    transition: { next: { elapsed: done, failure: bad } }`,
    send: `    type: messaging
    mode: send
    contract: Test@1
    recipient: { parent: true }
    transition: { next: { sent: done, failure: bad } }`,
    request: `    type: messaging
    mode: request
    contract: Test@1
    recipient: { parent: true }
    timeoutSeconds: 10
    transition: { next: { responded: done, declined: bad, failure: bad } }`,
    receive: `    type: messaging
    mode: receive
    contract: Test@1
    wait: { seconds: 10 }
    transition: { next: { received: done, elapsed: done, failure: bad } }`,
    agent: `    type: agent
    invoke: { prompt: Answer from your input. }
    outcomes: [ok]
    timeoutSeconds: 10
    transition: { next: { ok: done, failure: bad } }`,
    parallel: `    type: parallel
    forEach: []
    body:
      initial: item
      states:
        item: { type: terminal, outcome: succeeded, output: "\${input}" }
    transition: { next: { joined: done, blocked: bad, failure: bad } }`,
};

for (const [kind, state] of Object.entries(states)) {
    test(`carry compiles and survives stored IR for ${kind}`, () => {
        const compiled = compileWorkflow(definition(state));
        assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
        assert.deepEqual(compiled.ir.nodes.work.carry, { loop: "${input.loop}", value: "${kv.value ?? 0}" });
        assert.deepEqual(parseWorkflowIr(compiled.ir).nodes.work.carry, compiled.ir.nodes.work.carry);
    });
}

test("carry is optional; legacy IR has no new field", () => {
    const compiled = compileWorkflow(definition(states.script).replace(/    carry:.*\n/, ""));
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.equal(Object.hasOwn(compiled.ir.nodes.work, "carry"), false);
    assert.equal(Object.hasOwn(parseWorkflowIr(compiled.ir).nodes.work, "carry"), false);
});

test("carry is an object template, not a scalar or array; terminals refuse it", () => {
    for (const value of ["null", "[]", '"${input}"', "12"]) {
        const compiled = compileWorkflow(definition(states.script).replace(/carry:.*\n/, `carry: ${value}\n`));
        assert.equal(compiled.valid, false, value);
        assert.ok(compiled.diagnostics.some(item => item.path === "states.work.carry"), value);
    }
    assert.equal(compileWorkflow(definition(states.script).replace(
        "done: { type: terminal,", "done: { carry: {}, type: terminal,")).valid, false);
});

test("carry participates in binding and branch-scope validation", () => {
    for (const template of ['{ x: "${unknown.value}" }', '{ x: "${branch.item}" }']) {
        const compiled = compileWorkflow(definition(states.script).replace(/carry:.*\n/, `carry: ${template}\n`));
        assert.equal(compiled.valid, false);
        assert.ok(compiled.diagnostics.some(item => item.path.startsWith("states.work.carry")));
    }
});

test("stored carry shape cannot bypass validation", () => {
    const compiled = compileWorkflow(definition(states.script).replace(/    carry:.*\n/, ""));
    for (const value of [null, [], "${input}", { x: "${unknown.value}" }]) {
        const ir = structuredClone(compiled.ir);
        ir.nodes.work.carry = value;
        assert.throws(() => parseWorkflowIr(ir));
    }
    const ir = structuredClone(compiled.ir);
    ir.nodes.done.carry = {};
    assert.throws(() => parseWorkflowIr(ir));
});

// FB-005 meets FB-007 (lead, at integration): an approval state does not take carry yet; the key is refused at save, once,
// with a fix the author can apply, and the same state without carry compiles.
test("an approval state refuses carry at save, with one error that says what to do", () => {
    const yaml = (carry) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: consent-carry, version: "1.0.0" }
initial: consent
states:
  consent:
    type: approval
    question: Approve this exact proposal?
    input: "\${input}"
${carry ? '    carry: { round: "${input.round}" }\n' : ""}    timeoutSeconds: 172800
    transition:
      next: { approved: release, rejected: hold, timed_out: hold }
  release: { type: terminal, outcome: succeeded }
  hold: { type: terminal, outcome: failed }
`;
    const refused = compileWorkflow(yaml(true));
    assert.equal(refused.valid, false);
    const errors = refused.diagnostics.filter((item) => item.severity === "error");
    assert.deepEqual(errors.map((item) => [item.code, item.path]), [["WORKFLOW_FIELD_UNKNOWN", "states.consent.carry"]]);
    assert.match(errors[0].message, /approval state does not take carry/);
    const accepted = compileWorkflow(yaml(false));
    assert.equal(accepted.valid, true, JSON.stringify(accepted.diagnostics));
    assert.equal(accepted.ir.nodes.consent.carry, undefined);
});
