import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow, parseWorkflowIr } from "../../dist/workflow/compiler.js";
import { canonicalJson } from "../../dist/workflow/json.js";
import { parseApprovalCommand } from "../../dist/workflow/approval.js";
import { workflowApprovalPrompt, workflowControllerFeatures, describeWorkflowState } from "../../dist/workflow/runtime.js";
import { testResultFor } from "../../dist/workflow/test-mode.js";
import { updateWorkflowForPerson } from "../../dist/workflow/human-commands.js";

test("person dispatch refuses a non-person actor, answers through an agent session, and wakes only after the decision commits", async () => {
    const calls = [];
    const command = { operation: "approval_respond", operation_id: "answer", run_id: "run", approval_id: "visit",
        context_sha256: "a".repeat(64), decision: "approved" };
    const host = { catalog: { getSession: async () => ({ sessionKind: "workflow", deletedAt: null }) },
        store: { readDefinition: async () => ({}), readWorkflowLineage: async () => null,
            approvals: { respond: async () => { calls.push("committed"); return { accepted: true }; } },
            readRun: async () => { calls.push("read"); return { runId: "run", status: "running", stop: null, controllerInstanceId: "controller" }; } },
        duroxideClient: { enqueueEvent: async (_id, _queue, message) => { calls.push(JSON.parse(message).type); } } };
    for (const context of [{ actor: { kind: "system", name: "admin" } }, { actor: { kind: "agent", sessionId: "agent" } }]) {
        await assert.rejects(updateWorkflowForPerson(command, { host, workflowSessionId: "wf", ...context }), error => error.code === "FORBIDDEN");
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(await updateWorkflowForPerson(command, { host, workflowSessionId: "wf",
        actor: { kind: "user", provider: "test", subject: "owner" } }), { accepted: true });
    assert.deepEqual(calls, ["committed", "read", "workflow-wake"]);
    assert.deepEqual(await updateWorkflowForPerson(command, { host, workflowSessionId: "wf",
        actor: { kind: "user", provider: "test", subject: "owner" }, originatingSessionId: "agent" }), { accepted: true });
    assert.deepEqual(calls, ["committed", "read", "workflow-wake", "committed", "read", "workflow-wake"]);
});

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
    assert.deepEqual(parseWorkflowIr(JSON.parse(canonicalJson(compiled.ir))), compiled.ir);
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
test("an approval notice cuts its context to at most 1,500 characters with its marker, whole code points, and no person's identity", () => {
    const notice = context => {
        const text = workflowApprovalPrompt({ workflowSessionId: "wf", runId: "run", approvalId: "visit", stateId: "consent", question: "Q",
            context, contextSha256: "a".repeat(64), deadlineAt: "2030-01-01T00:00:00.000Z" });
        return JSON.parse(text.slice(text.lastIndexOf("\n") + 1)).context;
    };
    // canonicalJson of the string puts a quote first, so the 1,499th UTF-16 unit is the high half of a pair.
    for (const filler of ["x".repeat(1_496), "x".repeat(1_497)]) {
        const preview = notice(filler + "\u{1F600}".repeat(800));
        assert.ok(preview.length <= 1_500, `${preview.length}`);
        assert.ok(preview.endsWith("…"));
        assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(preview), false);
    }
    assert.equal(notice({ build: "1.2.3" }), '{"build":"1.2.3"}');
    // An earlier approval's output carried in this one's context shows its decider as a person, whole or cut inside the
    // provider (a: 1,440) or the subject (a: 1,414).
    const decided = { decision: "approved", decidedBy: { provider: "github", subject: "secret-subject", displayName: "Ada" } };
    for (const context of [{ earlier: decided }, { a: "x".repeat(1_440), earlier: decided }, { a: "x".repeat(1_414), earlier: decided }]) {
        const preview = notice(context);
        assert.ok(preview.length <= 1_500);
        assert.doesNotMatch(preview, /secret|github|gi…|se…/);
    }
});
