import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { workflowApprovalView, workflowRunCommandArgs, workflowRunCommandWire } from "../src/workflow-commands.js";
import { projectWorkflow, workflowExecutionOfRow } from "../src/workflow-view.js";
import { workflowNodeSummary } from "../src/workflow-node-summary.js";
import { WorkflowApprovalDetails } from "../../react/src/workflow-tab.js";

const approval = { approvalId: "visit-a", question: "Approve <this> exact release?", context: { change: "Read this full context", secretless: "<script>unsafe()</script>" },
    contextSha256: "a".repeat(64), owner: { provider: "dev", subject: "alice", displayName: "Alice" }, activatedAt: "2026-11-12T00:00:00Z",
    deadlineAt: "2026-12-01T00:00:00Z", status: "pending", decision: null };
const execution = { nodeExecutionId: "visit-a", stateId: "consent", ordinal: 1, state: "pending", approval };
const model = { personCommands: { operations: ["approval_respond"], approvals: [{ approvalId: "visit-a", runId: "run", mayAnswer: true, reason: null }] },
    run: { runId: "run", status: "running" } };

test("the shared command pins the exact visit and digest and never carries an actor", () => {
    const checked = workflowRunCommandArgs("approval_respond", { approvalId: "visit-a", contextSha256: approval.contextSha256, decision: "rejected", reason: "Not ready" });
    assert.equal(checked.ok, true);
    assert.deepEqual(workflowRunCommandWire("approval_respond", "run", "op", checked.args), { operation: "approval_respond", operation_id: "op", run_id: "run",
        approval_id: "visit-a", context_sha256: approval.contextSha256, decision: "rejected", reason: "Not ready" });
    assert.equal(workflowRunCommandArgs("approval_respond", { ...checked.args, reason: " " }).ok, false);
    assert.equal(workflowRunCommandArgs("approval_respond", { ...checked.args, contextSha256: "stale" }).ok, false);
});
test("command access alone never infers consent authority and another visit cannot borrow it", () => {
    assert.equal(workflowApprovalView(model, execution).mayAnswer, true);
    assert.equal(workflowApprovalView({ ...model, personCommands: { operations: ["approval_respond"], viewer: { allowed: true } } }, execution).mayAnswer, false);
    assert.equal(workflowApprovalView(model, { approval: { ...approval, approvalId: "visit-b" } }).mayAnswer, false);
    assert.equal(workflowExecutionOfRow(execution).approval, approval);
});
for (const mobile of [false, true]) {
    test(`${mobile ? "phone" : "desktop"} approval details show the frozen proposal before usable controls`, () => {
        const html = renderToStaticMarkup(React.createElement("main", { className: mobile ? "is-mobile" : "is-desktop" },
            React.createElement(WorkflowApprovalDetails, { sessionId: "wf", controller: {}, approval: workflowApprovalView(model, execution) })));
        assert.ok(html.indexOf("Proposal context") < html.indexOf(">Approve<"));
        assert.ok(html.includes("Read this full context") && html.includes("Owner: Alice") && html.includes("Answer before:"));
        assert.ok(html.includes("&lt;script&gt;") && !html.includes("<script>"));
        assert.ok(html.includes("font-size:16px") && html.includes("min-height:44px") && html.includes("maxLength=\"2000\""));
        const readOnly = renderToStaticMarkup(React.createElement(WorkflowApprovalDetails, { sessionId: "wf", controller: {},
            approval: workflowApprovalView({ ...model, personCommands: null }, execution) }));
        assert.ok(!readOnly.includes(">Approve<") && !readOnly.includes(">Reject<"));
        assert.ok(readOnly.includes("directly in the portal"));
    });
}
test("approval graphs project as approval nodes and TUI words direct the person to the portal", () => {
    const graph = { initial: "consent", states: [{ id: "consent", type: "approval", question: approval.question, timeoutSeconds: 172800,
        outcomes: ["approved", "rejected"], next: { approved: "done", rejected: "done", timed_out: "done" } }, { id: "done", type: "terminal", outcome: "succeeded" }] };
    const projection = projectWorkflow({ readModel: { workflowId: "wf", graph, runs: [], run: { ...model.run, mode: "live", nodeExecutions: [execution], openExecutions: [] } } });
    const node = projection.nodes.find(item => item.id === "consent");
    assert.equal(node.kind, "approval");
    assert.equal(node.current.approval, approval);
    assert.match(workflowNodeSummary(node).now, /answer directly in the portal/i);
});
