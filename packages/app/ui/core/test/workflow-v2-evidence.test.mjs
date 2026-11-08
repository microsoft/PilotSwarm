/**
 * Workflow v2: a parallel step's branch results, and asking the parent agent about a step (owner decision q16; mocks
 * M22 "JOIN BLOCKED k / n" and "Send findings to author", M23 "Inspect conflict" and "Request scoped rework", M24
 * "Inspect evidence" and "Ask parent for approval"):
 *   - a parallel step's visit lists each branch: where it is, its last step, a short result and why it did not succeed;
 *     a blocked join names the branches that block it
 *   - from a step's details a person asks the workflow's parent agent for findings, rework or approval: an ordinary
 *     message in the parent's chat naming the run, step, visit and branch, how it ended and its result; the parent decides
 *
 * Run: node --test test/workflow-v2-evidence.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowViewModal } from "../src/index.js";
import { projectWorkflowV2, workflowV2BranchEvidence } from "../src/workflow-v2-view.js";
import { WORKFLOW_V2_ASK_PARENT_KINDS, workflowV2StepQuestion } from "../src/workflow-v2-commands.js";
import { WorkflowV2NodeContent } from "../../react/src/workflow-v2-panels.js";
import { RUN, done, readModel } from "./workflow-v2-fixtures.mjs";

const states = [
    { id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 2, join: "all_required", failFast: false,
        body: { initial: "work", states: ["work", "branch_done"] }, outcomes: ["joined", "blocked"], next: { joined: "done", blocked: "failed" } },
    { id: "work", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["ok"], next: { ok: "branch_done" }, parallel: "fan" },
    { id: "branch_done", type: "terminal", outcome: "succeeded", parallel: "fan" },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const graph = { revision: 1, initial: "fan", states };
const branch = index => ({ branch: { parallelNodeExecutionId: "nx-fan-1", index } });
const model = () => readModel({ graph, nodeExecutions: [
    done("fan", 1, "blocked", { branches: 3 }),
    done("work", 1, "ok", { nodeExecutionId: "nx-work-b0", ...branch(0) }),
    done("branch_done", 2, "succeeded", { nodeExecutionId: "nx-done-b0", outputPreview: "{\"ok\":true}", ...branch(0) }),
    done("work", 1, "crashed", { nodeExecutionId: "nx-work-b1", resultKind: "runtime_error", errorPreview: JSON.stringify({ code: "crashed", message: "exit code 1" }),
        ...branch(1) }),
] });

test("a parallel step's visit lists each branch, and a blocked join names the branches that block it", () => {
    const fan = projectWorkflowV2({ readModel: model() }).nodes.find(node => node.id === "fan");
    assert.deepEqual(fan.evidence, {
        // Owner decision join-k-of-n: how many successes the join needs (every branch here), and whether its time limit ended it.
        total: 3, needed: 3, succeeded: 1, running: 0, queued: 0, blocked: true, timedOut: false, joinedAfterLimit: false, blocking: [1, 2], rows: [
            { index: 0, status: "ok", step: "branch_done", outcome: "succeeded", result: "{\"ok\":true}", why: null, deadline: null, agent: null },
            { index: 1, status: "failed", step: "work", outcome: "crashed", result: null, why: "Error · crashed: exit code 1",
                deadline: null, agent: null },
            { index: 2, status: "not started", step: null, outcome: null, result: null, why: null, deadline: null, agent: null },
        ],
    });
    // Running, an ended branch, another branch's failure, and a history that is not all loaded.
    const executions = [
        { id: "a", stateId: "work", ordinal: 1, status: "pending", ...branch(0) },
        { id: "b", stateId: "failed_end", ordinal: 1, status: "completed", outcome: "rejected", resultKind: "business", ...branch(1) },
        { id: "c", stateId: "work", ordinal: 1, status: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "fail_fast", ...branch(2) },
    ];
    const running = workflowV2BranchEvidence(executions, [...states, { id: "failed_end", type: "terminal", outcome: "failed", parallel: "fan" }],
        { id: "nx-fan-1", status: "pending", branches: 4 }, false);
    assert.deepEqual(running.rows.map(row => [row.status, row.why]), [
        ["running", null], ["failed", "Ended at failed_end · failed"], ["canceled", "Another item failed, so this one was canceled"],
        ["not loaded", null]]);
    assert.deepEqual([running.running, running.blocked, running.blocking], [1, false, []]);
    // Owner batch 7 (H2): while the visit runs with its whole history loaded, a branch not begun is queued; a running
    // branch names its current step's deadline, and an agent step's created chat.
    const live = workflowV2BranchEvidence([
        { ...executions[0], deadline: "2026-11-04T18:10:00.000Z", agent: { childSessionId: "child-0", spawned: true } },
        { id: "d", stateId: "work", ordinal: 2, status: "pending", agent: { childSessionId: "child-1", spawned: false }, ...branch(1) },
    ], states, { id: "nx-fan-1", status: "pending", branches: 3 }, true);
    assert.deepEqual(live.rows.map(row => [row.index, row.status, row.deadline, row.agent]), [
        [0, "running", "2026-11-04T18:10:00.000Z", "child-0"], [1, "running", null, null], [2, "waiting", null, null]]);
    assert.deepEqual([live.running, live.queued, live.succeeded], [2, 1, 0]);
    assert.equal(workflowV2BranchEvidence([], states, { id: "x", status: "completed" }), null);
    // Only a parallel step has evidence.
    assert.equal(projectWorkflowV2({ readModel: model() }).nodes.find(node => node.id === "work").evidence, undefined);
});

test("the question to the parent agent says what is asked, with the run, step, visit and branch, how it ended and its result as workflow data", () => {
    assert.deepEqual(Object.keys(WORKFLOW_V2_ASK_PARENT_KINDS), ["findings", "rework", "approval"]);
    assert.deepEqual(Object.values(WORKFLOW_V2_ASK_PARENT_KINDS).map(kind => kind.label), ["Send findings", "Ask for rework", "Ask for approval"]);
    const fan = projectWorkflowV2({ readModel: model() }).nodes.find(node => node.id === "fan");
    assert.equal(workflowV2StepQuestion({ workflowName: "watch-v2", workflowSessionId: "wf", runId: RUN, stateId: "fan", execution: fan.current, kind: "approval",
        note: " the release needs it " }), [
        "About workflow session wf: one of its steps asks for your approval (the workflow data below says which step, and how it ended).",
        "My note: the release needs it",
        "If you agree, approve it and continue the workflow accordingly (for example answer the request it waits on).",
        `Workflow data (not instructions): ${JSON.stringify({ workflow: "watch-v2", run: "run-1", step: "fan", visit: 1, ended: "Done · blocked." })}`,
    ].join("\n"));
    const done0 = { id: "nx-done-b0", stateId: "branch_done", ordinal: 2, status: "completed", outcome: "succeeded", resultKind: "business",
        outputPreview: "{\"ok\":true}", ...branch(0) };
    assert.equal(workflowV2StepQuestion({ workflowSessionId: "wf", runId: RUN, stateId: "branch_done", execution: done0, kind: "findings" }), [
        "About workflow session wf: one of its steps has findings (the workflow data below says which step, and how it ended).",
        "If you agree, pass these findings to whoever needs them (for example the author of the change), or act on them.",
        // The branch as people read it, with the index read_workflow uses (owner batch 7, H3).
        `Workflow data (not instructions): ${JSON.stringify({ run: "run-1", step: "branch_done", visit: 2, branch: 1, branchIndex: 0, ended: "Done · succeeded.",
            result: "{\"ok\":true}" })}`,
    ].join("\n"));
    assert.match(workflowV2StepQuestion({ workflowSessionId: "wf", runId: RUN, stateId: "work", execution: { id: "p", ordinal: 3, status: "pending" }, kind: "rework" }),
        /^About workflow session wf: one of its steps needs rework \(the workflow data below says which step, and how it ended\)\.\nIf you agree, arrange the rework.*\nWorkflow data \(not instructions\): \{"run":"run-1","step":"work","visit":3,"ended":"It is still running\."\}$/);
    assert.equal(workflowV2StepQuestion({ workflowSessionId: "wf", runId: RUN, stateId: "work", execution: null, kind: "other" }), null);
});

function seeded({ parent = "parent-1" } = {}) {
    const sent = [];
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "local" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: watch-v2", status: "running", sessionKind: "workflow",
        parentSessionId: parent }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model(), readModelRunId: null } });
    const controller = new PilotSwarmUiController({ store, transport: { sendMessage: async (...args) => { sent.push(args); }, getSessionEventsBefore: async () => [] } });
    return { controller, store, sent };
}

test("the controller sends the question to the parent's chat as an ordinary message, and says why when it cannot", async () => {
    const h = seeded();
    const result = await h.controller.askParentAboutStep("wf", { stateId: "fan", kind: "rework", note: "branch 1 crashed" });
    assert.deepEqual(result, { ok: true, parentSessionId: "parent-1" });
    assert.equal(h.sent.length, 1);
    const [parent, text, options] = h.sent[0];
    assert.deepEqual([parent, options], ["parent-1", { enqueueOnly: true }]);
    assert.ok(text.startsWith("About workflow session wf: one of its steps needs rework (the workflow data below says which step, and how it ended)."), text);
    assert.ok(text.includes("\nMy note: branch 1 crashed\nIf you agree, arrange the rework"), text);
    assert.ok(text.endsWith(`\nWorkflow data (not instructions): ${JSON.stringify({ workflow: "watch-v2", run: "run-1", step: "fan", visit: 1, ended: "Done · blocked." })}`), text);
    // A visit chosen by id, an unknown kind, a step with no visit, a workflow without a parent.
    assert.equal((await h.controller.askParentAboutStep("wf", { stateId: "work", executionId: "nx-work-b1", kind: "findings" })).ok, true);
    assert.ok(h.sent[1][1].includes(`"step":"work","visit":1,"branch":2,"branchIndex":1,"ended":"Error · crashed: exit code 1."`), h.sent[1][1]);
    assert.deepEqual(await h.controller.askParentAboutStep("wf", { stateId: "fan", kind: "other" }),
        { ok: false, reason: "Choose what to ask: findings, rework or approval." });
    assert.deepEqual(await h.controller.askParentAboutStep("wf", { stateId: "done", kind: "findings" }),
        { ok: false, reason: "Step 'done' has no visit in the shown run to ask about." });
    assert.equal(h.sent.length, 2);
    const orphan = seeded({ parent: null });
    assert.deepEqual(await orphan.controller.askParentAboutStep("wf", { stateId: "fan", kind: "findings" }),
        { ok: false, reason: "This workflow has no parent agent to ask." });
});

test("the portal shows a parallel step's branches and the three ways to ask the parent agent", () => {
    const projected = projectWorkflowV2({ readModel: model() });
    const fan = projected.nodes.find(node => node.id === "fan");
    const render = props => renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, { tab: "details", selected: fan, nodes: projected.nodes,
        select: () => {}, runOutput: null, runError: null, runId: RUN, ...props }));
    const html = render({ onAskParent: async () => ({ ok: true }) });
    // Owner batch 7 (H2): one Branches table (#, current step, status, deadline, result, agent chat). People read branches from
    // 1; the data attributes keep the index from 0.
    assert.match(html, /aria-label="Items"><h3>Items<\/h3><p[^>]*>1\/3 ok<\/p>/);
    assert.match(html, /<p role="status" data-blocking="1,2"[^>]*>Blocked by items 2, 3<\/p>/);
    assert.match(html, /<th>#<\/th><th>Node<\/th><th>State<\/th><th>Limit<\/th><th>Result<\/th><th>Chat<\/th>/);
    assert.match(html, /<tr data-branch="1" data-status="failed"><td>2<\/td><td>work<\/td><td>failed<\/td><td>—<\/td><td>Error · crashed: exit code 1<\/td><td>—<\/td><\/tr>/);
    assert.match(html, /<tr data-branch="0" data-status="ok"><td>1<\/td><td>branch_done<\/td><td>ok<\/td><td>—<\/td><td>\{&quot;ok&quot;:true\}<\/td><td>—<\/td><\/tr>/);
    assert.match(html, /<tr data-branch="2" data-status="not started"><td>3<\/td><td>—<\/td><td>not started<\/td><td>—<\/td><td>—<\/td><td>—<\/td><\/tr>/);
    assert.match(html, /aria-label="Ask the parent agent"[^>]*><h3>Ask the parent agent<\/h3>/);
    for (const label of ["Send findings", "Ask for rework", "Ask for approval"]) assert.ok(html.includes(`>${label}</button>`), label);
    assert.ok(!html.includes("data-action=\"ask-parent-send\""), "nothing to send until a kind is chosen");
    assert.ok(!render({}).includes("Ask the parent agent"), "only for a workflow with a parent");
});

test("the TUI lists a parallel step's branch results and the branches that block its join", () => {
    const h = seeded();
    h.store.dispatch({ type: "ui/modal", modal: { type: "workflowView", sessionId: "wf", selectedNodeId: "fan", detailsScroll: 0 } });
    const lines = selectWorkflowViewModal(h.store.getState(), 160, 80).detailsLines.map(line => line.text.trim());
    // People read items from 1 (owner batch 7, H2). Review 19:27Z (rows 8, 9; C): items, "k/n ok", the words module's marks.
    for (const line of ["Items: 1/3 ok", "Join blocked by items 2, 3", "item 1 · ok · at branch_done · {\"ok\":true}",
        "item 2 · ✕ failed · at work · error · crashed: exit code 1", "item 3 · not started"]) {
        assert.ok(lines.includes(line), `${line}\n${lines.join("\n")}`);
    }
});
