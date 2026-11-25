import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileWorkflow, parseWorkflowIr } from "../../dist/workflow/compiler.js";
import { definitionTestReport } from "../../dist/workflow/definition-test.js";

const BASE = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata:
  name: multi-recv-unit
  version: "1.0.0"
contracts:
  Progress@1:
    schema: { type: object, properties: { step: { type: integer } } }
  Alert@1:
    schema: { type: object, properties: { code: { type: string } } }
initial: listen
`;

test("multi-contract receive compiles with declared contracts + built-in WorkflowEnded@1, and round-trips through parseWorkflowIr", () => {
    const yaml = BASE + `states:
  listen:
    type: messaging
    mode: receive
    contract: [Progress@1, Alert@1, WorkflowEnded@1]
    wait: { seconds: 60 }
    transition:
      next:
        Progress@1: listen
        Alert@1: done
        WorkflowEnded@1: done
        elapsed: done
        failure: failed
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed, output: "\${runtime.error}" }
`;
    const compiled = compileWorkflow(yaml);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.deepEqual(compiled.ir.nodes.listen.contract, ["Progress@1", "Alert@1", "WorkflowEnded@1"]);
    const parsed = parseWorkflowIr(JSON.parse(JSON.stringify(compiled.ir)));
    assert.deepEqual(parsed.nodes.listen.contract, ["Progress@1", "Alert@1", "WorkflowEnded@1"]);
});

test("multi-contract receive rejects duplicates, undeclared names, <2 or >8 distinct contracts, missing contract route, and 'received' route", () => {
    const cases = [
        ["single-item list", "contract: [Progress@1]\n    transition: { next: { Progress@1: done } }", "WORKFLOW_FIELD_INVALID"],
        ["duplicate", "contract: [Progress@1, Progress@1]\n    transition: { next: { Progress@1: done } }", "WORKFLOW_FIELD_INVALID"],
        ["undeclared", "contract: [Progress@1, Missing@1]\n    transition: { next: { Progress@1: done, Missing@1: done } }", "WORKFLOW_CONTRACT_UNKNOWN"],
        ["missing route", "contract: [Progress@1, Alert@1]\n    transition: { next: { Progress@1: done } }", "WORKFLOW_ROUTE_MISSING"],
        ["received refused", "contract: [Progress@1, Alert@1]\n    transition: { next: { Progress@1: done, Alert@1: done, received: done } }", "WORKFLOW_ROUTE_INVALID"],
    ];
    for (const [label, snippet, expectedCode] of cases) {
        const res = compileWorkflow(BASE + `states:\n  listen:\n    type: messaging\n    mode: receive\n    ${snippet}\n  done: { type: terminal, outcome: succeeded }\n`);
        assert.equal(res.valid, false, `${label} should fail`);
        assert.ok(res.diagnostics.some(d => d.code === expectedCode), `${label}: expected ${expectedCode}, got ${JSON.stringify(res.diagnostics)}`);
    }

    // X1: 9 distinct declared contracts with all 9 routes present so ONLY the 8-contract cap fails.
    const names = Array.from({ length: 9 }, (_, i) => `C${i + 1}@1`);
    const nineYaml = `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: nine-contracts, version: "1.0.0" }
contracts:
${names.map(n => `  ${n}: { schema: { type: object } }`).join("\n")}
initial: listen
states:
  listen:
    type: messaging
    mode: receive
    contract: [${names.join(", ")}]
    transition:
      next:
${names.map(n => `        ${n}: done`).join("\n")}
        failure: done
  done: { type: terminal, outcome: succeeded }
`;
    const nineRes = compileWorkflow(nineYaml);
    assert.equal(nineRes.valid, false);
    assert.equal(nineRes.diagnostics.filter(d => d.severity === "error").length, 1, JSON.stringify(nineRes.diagnostics));
    assert.equal(nineRes.diagnostics[0].code, "WORKFLOW_FIELD_INVALID");
    assert.match(nineRes.diagnostics[0].message, /2 to 8 distinct/);
});

test("X1: frozen BASE (263169efe) single-contract receive IR fixture parses with identical receive fields", () => {
    const raw = JSON.parse(readFileSync(new URL("./fixtures/legacy-single-receive-ir-263169efe.json", import.meta.url), "utf8"));
    const parsed = parseWorkflowIr(raw);
    assert.equal(parsed.nodes.listen.type, "messaging");
    assert.equal(parsed.nodes.listen.mode, "receive");
    assert.equal(parsed.nodes.listen.contract, "Progress@1");
    assert.equal(parsed.nodes.listen.waitSeconds, 30);
    assert.equal(parsed.nodes.listen.waitTotalSeconds, undefined);
    assert.deepEqual(parsed.nodes.listen.next, { elapsed: "done", failure: "failed", received: "done" });
});

test("T1: definitionTestReport passes compiled multi-contract receive node to fixture skeleton", async () => {
    const compiled = compileWorkflow(BASE + `states:
  listen:
    type: messaging
    mode: receive
    contract: [Progress@1, WorkflowEnded@1]
    transition:
      next: { Progress@1: done, WorkflowEnded@1: done, failure: failed }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    const store = {
        async listNodeExecutions() {
            return [{
                nodeExecutionId: "ne-1", runId: "run-1", scopeId: "root", nodeId: "listen", ordinal: 1, nodeType: "messaging",
                predecessorId: null, arrivalRoute: null, input: null, inputSha256: "h", state: "completed", carrySnapshot: null,
                outcome: "cancelled", resultKind: "runtime_error", output: null, error: { code: "cancelled", message: "stuck" },
                hasOutput: false, winner: "cancel", effectAttempts: 0, kvRevision: 0, deadlineAt: null, receive: null,
                enteredAt: new Date(), completedAt: new Date(),
            }];
        },
        async listInterceptions() { return []; },
        async readRevisionIr() { return compiled.ir; },
    };
    const report = await definitionTestReport({ store }, {
        testId: "bench-1", definitionId: "def-1", name: "multi-recv-unit", revision: 1, expect: null,
    }, {
        runId: "run-1", workflowSessionId: "bench-1", revision: 1, irSha256: "ir-1", status: "cancelled",
        terminalOutcome: "cancelled", terminalState: null, terminalOutput: null,
        terminalError: { code: "TEST_STUCK", message: "TEST_STUCK: no prepared answer for the receive step listen. Add a receive fixture." },
        stop: null, mode: "test", virtualNow: new Date(), createdAt: new Date(), startedAt: new Date(), completedAt: new Date(),
    });
    assert.equal(report.status, "failed");
    assert.ok(report.unanswered?.fixture);
    assert.deepEqual(report.unanswered.fixture.response, {
        kind: "success",
        value: { contract: "Progress@1", payload: "<the message, as the chosen contract's schema says>" },
    });
});
