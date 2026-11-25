import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow, parseWorkflowIr } from "../../dist/workflow/compiler.js";
import { canonicalJson } from "../../dist/workflow/json.js";

const BASE = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: multi-recv, version: "1.0.0" }
contracts:
  Progress@1:
    schema: { type: object, required: [step], properties: { step: { type: integer } } }
  Alert@1:
    schema: { type: object, required: [msg], properties: { msg: { type: string } } }
initial: listen
`;

test("multi-contract receive compiles with declared contracts + built-in WorkflowEnded@1, and round-trips through parseWorkflowIr", () => {
    const yaml = BASE + `states:
  listen:
    type: messaging
    mode: receive
    contract: [Progress@1, WorkflowEnded@1]
    wait: { seconds: 30 }
    transition:
      next:
        Progress@1: listen
        WorkflowEnded@1: done
        elapsed: timed
        failure: failed
  done: { type: terminal, outcome: succeeded }
  timed: { type: terminal, outcome: blocked }
  failed: { type: terminal, outcome: failed }
`;
    const compiled = compileWorkflow(yaml);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    const node = compiled.ir.nodes.listen;
    assert.deepEqual(node.contract, ["Progress@1", "WorkflowEnded@1"]);
    assert.equal(node.next["Progress@1"], "listen");
    assert.equal(node.next["WorkflowEnded@1"], "done");
    assert.equal(node.next.elapsed, "timed");
    const roundTripped = parseWorkflowIr(JSON.parse(canonicalJson(compiled.ir)));
    assert.deepEqual(roundTripped.nodes.listen.contract, ["Progress@1", "WorkflowEnded@1"]);
});

test("multi-contract receive rejects duplicates, undeclared names, <2 or >8 entries, missing contract route, and 'received' route", () => {
    const cases = [
        ["single-item list", "contract: [Progress@1]\n    transition: { next: { Progress@1: done } }", "WORKFLOW_FIELD_INVALID"],
        ["duplicate", "contract: [Progress@1, Progress@1]\n    transition: { next: { Progress@1: done } }", "WORKFLOW_FIELD_INVALID"],
        ["undeclared", "contract: [Progress@1, Missing@1]\n    transition: { next: { Progress@1: done, Missing@1: done } }", "WORKFLOW_CONTRACT_UNKNOWN"],
        ["missing route", "contract: [Progress@1, Alert@1]\n    transition: { next: { Progress@1: done } }", "WORKFLOW_ROUTE_MISSING"],
        ["received refused", "contract: [Progress@1, Alert@1]\n    transition: { next: { Progress@1: done, Alert@1: done, received: done } }", "WORKFLOW_ROUTE_INVALID"],
        ["over 8 contracts", "contract: [Progress@1, Alert@1, Progress@1, Alert@1, Progress@1, Alert@1, Progress@1, Alert@1, WorkflowEnded@1]\n    transition: { next: { Progress@1: done } }", "WORKFLOW_FIELD_INVALID"],
    ];
    for (const [label, snippet, expectedCode] of cases) {
        const res = compileWorkflow(BASE + `states:\n  listen:\n    type: messaging\n    mode: receive\n    ${snippet}\n  done: { type: terminal, outcome: succeeded }\n`);
        assert.equal(res.valid, false, `${label} should fail`);
        assert.ok(res.diagnostics.some(d => d.code === expectedCode), `${label}: expected ${expectedCode}, got ${JSON.stringify(res.diagnostics)}`);
    }
});

test("single-contract receive IR and routes remain unchanged and old stored IR still parses", () => {
    const yaml = BASE + `states:
  listen:
    type: messaging
    mode: receive
    contract: Progress@1
    transition: { next: { received: done } }
  done: { type: terminal, outcome: succeeded }
`;
    const compiled = compileWorkflow(yaml);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.equal(compiled.ir.nodes.listen.contract, "Progress@1");
    assert.equal(compiled.ir.nodes.listen.next.received, "done");
    const parsed = parseWorkflowIr(JSON.parse(canonicalJson(compiled.ir)));
    assert.equal(parsed.nodes.listen.contract, "Progress@1");
});
