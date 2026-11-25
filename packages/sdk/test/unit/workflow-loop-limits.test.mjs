import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow, parseWorkflowIr } from "../../dist/workflow/compiler.js";

function yaml(statesBlock, extra = "") {
    return `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: loop-limits-test
  version: 0.1.0
${extra}initial: first
states:
${statesBlock}`;
}

test("compiler accepts maxVisits (1..10000) with exhausted route on non-terminal states and round-trips IR", () => {
    const res = compileWorkflow(yaml(`  first:
    type: script
    maxVisits: 3
    outcomes: [again]
    source: "await setResult('again', {});"
    transition: { next: { again: first, exhausted: pause, failure: failed } }
  pause:
    type: wait
    seconds: 5
    maxVisits: 10000
    transition: { next: { elapsed: judge, exhausted: done, failure: failed } }
  judge:
    type: decision
    maxVisits: 2
    question:
      type: noul
      instructions: "Done?"
    transition: { next: { yes: done, no: first, exhausted: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`));
    assert.equal(res.valid, true, JSON.stringify(res.diagnostics));
    const parsed = parseWorkflowIr(res.ir);
    assert.equal(parsed.nodes.first.maxVisits, 3);
    assert.equal(parsed.nodes.pause.maxVisits, 10000);
    assert.equal(parsed.nodes.judge.maxVisits, 2);
    assert.equal(parsed.nodes.first.next.exhausted, "pause");
});

test("compiler rejects missing exhausted route, invalid maxVisits bounds, maxVisits on terminal, and exhausted without maxVisits", () => {
    const missingRoute = compileWorkflow(yaml(`  first:
    type: script
    maxVisits: 2
    outcomes: [ok]
    source: "await setResult('ok', {});"
    transition: { next: { ok: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`));
    assert.equal(missingRoute.valid, false);
    assert.ok(missingRoute.diagnostics.some(d => d.code === "WORKFLOW_ROUTE_MISSING" && /exhausted/.test(d.message)));

    for (const bad of [0, -1, 10001, 1.5, '"3"']) {
        const res = compileWorkflow(yaml(`  first:
    type: wait
    seconds: 1
    maxVisits: ${bad}
    transition: { next: { elapsed: done, exhausted: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`));
        assert.equal(res.valid, false, `expected maxVisits=${bad} to fail`);
        assert.ok(res.diagnostics.some(d => d.code === "WORKFLOW_FIELD_INVALID" && /maxVisits/.test(d.path)));
    }

    const onTerminal = compileWorkflow(yaml(`  first:
    type: wait
    seconds: 1
    transition: { next: { elapsed: done, failure: done } }
  done:
    type: terminal
    outcome: succeeded
    maxVisits: 1
`));
    assert.equal(onTerminal.valid, false);
    assert.ok(onTerminal.diagnostics.some(d => d.code === "WORKFLOW_FIELD_INVALID" && /maxVisits/.test(d.path)));

    const strayExhausted = compileWorkflow(yaml(`  first:
    type: wait
    seconds: 1
    transition: { next: { elapsed: done, exhausted: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`));
    assert.equal(strayExhausted.valid, false);
    assert.ok(strayExhausted.diagnostics.some(d => d.code === "WORKFLOW_ROUTE_INVALID" && /exhausted/.test(d.path)));
});

test("compiler accepts receive wait.totalSeconds (literal or binding) and rejects seconds+totalSeconds or missing elapsed", () => {
    const ok = compileWorkflow(yaml(`  first:
    type: messaging
    mode: receive
    contract: Ping@1
    wait: { totalSeconds: "\${inputs.budget ?? 60}" }
    transition: { next: { received: done, elapsed: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`, `schemas:
  Ping: { type: object }
contracts:
  Ping@1: { schema: { type: object } }
`));
    assert.equal(ok.valid, true, JSON.stringify(ok.diagnostics));
    const parsed = parseWorkflowIr(ok.ir);
    assert.equal(parsed.nodes.first.waitSeconds, null);
    assert.equal(parsed.nodes.first.waitTotalSeconds, "${inputs.budget ?? 60}");

    const both = compileWorkflow(yaml(`  first:
    type: messaging
    mode: receive
    contract: Ping@1
    wait: { seconds: 10, totalSeconds: 60 }
    transition: { next: { received: done, elapsed: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`, `schemas:
  Ping: { type: object }
contracts:
  Ping@1: { schema: { type: object } }
`));
    assert.equal(both.valid, false);
    assert.ok(both.diagnostics.some(d => d.code === "WORKFLOW_FIELD_INVALID" && /exactly one of seconds or totalSeconds/.test(d.message)));

    const neither = compileWorkflow(yaml(`  first:
    type: messaging
    mode: receive
    contract: Ping@1
    wait: {}
    transition: { next: { received: done, elapsed: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`, `schemas:
  Ping: { type: object }
contracts:
  Ping@1: { schema: { type: object } }
`));
    assert.equal(neither.valid, false);
    assert.ok(neither.diagnostics.some(d => d.code === "WORKFLOW_FIELD_INVALID"));

    const noElapsed = compileWorkflow(yaml(`  first:
    type: messaging
    mode: receive
    contract: Ping@1
    wait: { totalSeconds: 30 }
    transition: { next: { received: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`, `schemas:
  Ping: { type: object }
contracts:
  Ping@1: { schema: { type: object } }
`));
    assert.equal(noElapsed.valid, false);
    assert.ok(noElapsed.diagnostics.some(d => d.code === "WORKFLOW_ROUTE_MISSING" && /elapsed/.test(d.message)));
});

test("K2: maxVisits rejects business outcome or Decision choice label named 'exhausted', while states without maxVisits remain unchanged", () => {
    const scriptCollision = compileWorkflow(yaml(`  first:
    type: script
    maxVisits: 2
    outcomes: [ok, exhausted]
    source: "await setResult('ok', {});"
    transition: { next: { ok: done, exhausted: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`));
    assert.equal(scriptCollision.valid, false);
    assert.ok(scriptCollision.diagnostics.some(d => d.code === "WORKFLOW_FIELD_INVALID" && /collides with maxVisits/.test(d.message)),
        JSON.stringify(scriptCollision.diagnostics));

    const decisionCollision = compileWorkflow(yaml(`  first:
    type: decision
    maxVisits: 2
    question:
      type: choice
      instructions: "Pick"
      criteria:
        keep_going: "continue"
        exhausted: "collision"
    transition: { next: { keep_going: done, exhausted: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`));
    assert.equal(decisionCollision.valid, false);
    assert.ok(decisionCollision.diagnostics.some(d => d.code === "WORKFLOW_FIELD_INVALID" && /collides with maxVisits/.test(d.message)),
        JSON.stringify(decisionCollision.diagnostics));

    // Without maxVisits, a script business outcome named 'exhausted' still compiles cleanly.
    const withoutMax = compileWorkflow(yaml(`  first:
    type: script
    outcomes: [ok, exhausted]
    source: "await setResult('exhausted', {});"
    transition: { next: { ok: done, exhausted: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`));
    assert.equal(withoutMax.valid, true, JSON.stringify(withoutMax.diagnostics));
});

test("K3: out-of-range wait.totalSeconds diagnostic names totalSeconds, not seconds", () => {
    const bad = compileWorkflow(yaml(`  first:
    type: messaging
    mode: receive
    contract: Ping@1
    wait: { totalSeconds: 0 }
    transition: { next: { received: done, elapsed: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`, `contracts:
  Ping@1: { schema: { type: object } }
`));
    assert.equal(bad.valid, false);
    const err = bad.diagnostics.find(d => d.path === "states.first.wait.totalSeconds");
    assert.ok(err, JSON.stringify(bad.diagnostics));
    assert.match(err.message, /^totalSeconds must be an integer/);
});
