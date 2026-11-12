import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow, parseWorkflowIr } from "../../dist/workflow/compiler.js";
import { canonicalJson } from "../../dist/workflow/json.js";
import { parseApprovalCommand } from "../../dist/workflow/approval.js";
import { workflowControllerFeatures, describeWorkflowState } from "../../dist/workflow/runtime.js";
import { testResultFor } from "../../dist/workflow/test-mode.js";

const yaml = (fields = "question: Release this proposal?\n    timeoutSeconds: 172800", routes = "approved: done, rejected: done, timed_out: done, failure: done") => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: owner-approval, version: "1.0.0" }
initial: consent
states:
  consent:
    type: approval
    ${fields}
    transition: { next: { ${routes} } }
  done: { type: terminal, outcome: succeeded }
`;
const command = (fields = {}) => ({ operation: "approval_respond", operation_id: "answer", run_id: "run", approval_id: "visit",
    context_sha256: "a".repeat(64), decision: "approved", ...fields });

test("owner approval compiles a 48-hour interval and round-trips the frozen IR", () => {
    const compiled = compileWorkflow(yaml());
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.deepEqual(parseWorkflowIr(canonicalJson(compiled.ir)), compiled.ir);
    assert.equal(compiled.ir.nodes.consent.approver, "owner");
    assert.equal(describeWorkflowState(compiled.ir.nodes.consent).type, "approval");
    assert.equal(workflowControllerFeatures("1.0.0").approval, false);
    assert.equal(workflowControllerFeatures("1.1.0").approval, true);
});

for (const fields of ["question: ''\n    timeoutSeconds: 30", "question: Q\n    timeoutSeconds: 0",
    "question: Q\n    timeoutSeconds: 2592001", "question: Q\n    timeoutSeconds: '${input}'",
    "question: Q\n    timeoutSeconds: 30\n    approver: admin", "question: Q\n    timeoutSeconds: 30\n    source: evil"]) {
    test(`approval rejects a malformed closed state: ${fields}`, () => assert.equal(compileWorkflow(yaml(fields)).valid, false));
}
for (const missing of ["approved", "rejected", "timed_out"]) {
    test(`approval requires ${missing}`, () => {
        const routes = ["approved", "rejected", "timed_out"].filter(key => key !== missing).map(key => `${key}: done`).join(", ");
        assert.equal(compileWorkflow(yaml(undefined, routes)).valid, false);
    });
}
test("approval permits the 30-day limit and warns about a shorter whole-run deadline", () => {
    const compiled = compileWorkflow(yaml("question: Q\n    timeoutSeconds: 2592000").replace("initial: consent", "limits: { timeoutSeconds: 100 }\ninitial: consent"));
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.ok(compiled.diagnostics.some(item => item.code === "WORKFLOW_APPROVAL_RUN_DEADLINE"));
});
test("approval inputSchema is checked for a fixed input", () => {
    const compiled = compileWorkflow(yaml("question: Q\n    timeoutSeconds: 10\n    input: 7\n    inputSchema: { type: string }"));
    assert.equal(compiled.valid, false);
});
test("answer parser pins a visit and digest, not a state name, and refuses identity injection", () => {
    assert.equal(parseApprovalCommand(command()).approvalId, "visit");
    for (const fields of [{ actor: { kind: "user" } }, { context_sha256: "bad" }, { approval_id: "" }, { decision: "approve" },
        { decision: "rejected" }, { decision: "rejected", reason: " " }, { reason: "x".repeat(2001) }]) {
        assert.throws(() => parseApprovalCommand(command(fields)), error => error.code === "WORKFLOW_COMMAND_INVALID");
    }
});
test("approval fixtures are visibly mocked and validate rejection reasons", () => {
    const compiled = compileWorkflow(yaml());
    const interception = { operation: "approval", interceptionId: "visit/approval", arguments: {} };
    const decide = value => testResultFor(interception, compiled.ir.nodes.consent, compiled.ir, compiled.irSha256, { kind: "success", value });
    const result = decide({ decision: "rejected", reason: "Not ready" });
    assert.equal(result.outcome, "rejected");
    assert.equal(result.winner, "test");
    assert.equal(JSON.parse(result.valueText).mocked, true);
    assert.throws(() => decide({ decision: "rejected" }), error => error.code === "TEST_RESPONSE_INVALID");
});
