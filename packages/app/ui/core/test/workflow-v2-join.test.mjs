// Owner batch 7 (H2): a parallel step drawn as fork, branch box and join bar. What the box and the bar show (the
// branches now, the join's rule and state; no time limit, which the engine does not have for a join), the parallel
// step's details (For each, Branch steps, Branches, Next steps from the join), a branch step's branch picker, and
// branches numbered from 1 for people. The graph layout itself is in workflow-graph-layout.test.mjs.
//
// Run: node --test packages/app/ui/core/test/workflow-v2-join.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    projectWorkflowV2, workflowV2BranchChoice, workflowV2BranchChoices, workflowV2BranchList, workflowV2BranchNumber, workflowV2BranchSteps,
    workflowV2ForEachText, workflowV2NodeLabel,
} from "../src/workflow-v2-view.js";
import { WorkflowV2NodeContent } from "../../react/src/workflow-v2-panels.js";
import { WorkflowGroupBox, WorkflowJoinBar } from "../../react/src/workflow-graph.js";
import { readModel, row, done } from "./workflow-v2-fixtures.mjs";

/** The owner's case: for each reviewer, prepare it, have an agent review, and end the branch; then pause, or end blocked. */
const fan = (extra = {}) => ({ id: "fan", type: "parallel", forEach: "${input.reviewers}", concurrency: 2, join: "all_required", failFast: false,
    body: { initial: "prepare", states: ["prepare", "review", "reviewed"] }, outcomes: ["joined", "blocked"],
    next: { joined: "pause", blocked: "review_blocked" }, ...extra });
const states = [
    fan(),
    { id: "prepare", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["ready"], next: { ready: "review" }, parallel: "fan" },
    { id: "review", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["completed"], next: { completed: "reviewed" }, parallel: "fan" },
    { id: "reviewed", type: "terminal", outcome: "succeeded", parallel: "fan" },
    { id: "pause", type: "wait", seconds: 15, outcomes: ["elapsed"], next: { elapsed: "done" } },
    { id: "review_blocked", type: "terminal", outcome: "blocked" },
    { id: "done", type: "terminal", outcome: "succeeded" },
];
const graph = { revision: 1, initial: "fan", states };
const literal = count => ({ count, sha256: "a".repeat(64) });
const branch = index => ({ scopeId: `nx-fan-1#${index}`, branch: { parallelNodeExecutionId: "nx-fan-1", index } });
const chat = childSessionId => ({ childSessionId, spawned: true, spawnAttempts: 1, end: null, endSent: false });
/** Three reviewers: the first two branches are at their review, the third waits. */
const running = () => projectWorkflowV2({ readModel: readModel({ graph,
    nodeExecutions: [
        row("fan", 1, "pending", { branches: 3 }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-b0", ...branch(0) }),
        row("review", 1, "pending", { nodeExecutionId: "nx-review-b0", deadline: "2026-11-04T18:20:00.000Z", agent: chat("child-0"), ...branch(0) }),
        done("prepare", 2, "ready", { nodeExecutionId: "nx-prepare-b1", ...branch(1) }),
        row("review", 2, "pending", { nodeExecutionId: "nx-review-b1", deadline: "2026-11-04T18:10:00.000Z", ...branch(1) }),
    ] }) });
const byId = (projection, id) => projection.nodes.find(node => node.id === id);
const details = (projection, id, props = {}) => renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, {
    tab: "details", selected: byId(projection, id), nodes: projection.nodes, select: () => {}, runOutput: null, runError: null, ...props }));

test("labels and words: a branch's end says so, the items' source never shows a literal list's values, branch steps come in route order, branches count from 1", () => {
    assert.equal(workflowV2NodeLabel(states.find(node => node.id === "reviewed")), "branch ends · succeeded");
    assert.equal(workflowV2NodeLabel(states.find(node => node.id === "done")), "ends · succeeded");
    assert.equal(workflowV2ForEachText("${input.reviewers}"), "the list in ${input.reviewers}");
    assert.equal(workflowV2ForEachText(literal(3)), "3 items in the definition");
    assert.equal(workflowV2ForEachText(literal(1)), "1 item in the definition");
    assert.equal(workflowV2ForEachText(null), "a list this view does not show");
    assert.deepEqual(workflowV2BranchSteps(fan({ body: { initial: "prepare", states: ["reviewed", "review", "prepare"] } }), states), ["prepare", "review", "reviewed"]);
    assert.deepEqual([0, 1, 9].map(workflowV2BranchNumber), [1, 2, 10]);
    assert.equal(workflowV2BranchList([1]), "branch 2");
    assert.equal(workflowV2BranchList([0, 2]), "branches 1, 3");
});

test("while it runs: the box counts its branches and the bar waits; once joined or blocked it says so; it shows no time limit", () => {
    const projection = running();
    const join = byId(projection, "fan").joinBar;
    assert.deepEqual(join, { id: "join:fan", state: "waiting", rule: "all required", label: "join · all required", stateText: "waiting for its branches",
        group: { label: "Each branch", counts: { running: 2, queued: 1, done: 0 }, text: "2 running · 1 queued · 0 done" } });
    // Only a parallel step has a join; a body step has its branches instead.
    assert.equal(byId(projection, "review").joinBar, undefined);
    assert.equal(byId(projection, "pause").branches, undefined);
    const ended = outcome => byId(projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: [done("fan", 1, outcome, { branches: 3 })] }) }), "fan").joinBar;
    assert.deepEqual([ended("joined").state, ended("joined").stateText, ended("joined").group.counts], ["joined", "joined", null]);
    assert.deepEqual([ended("blocked").state, ended("blocked").stateText], ["blocked", "blocked"]);
    const idle = byId(projectWorkflowV2({ readModel: readModel({ graph, noRun: true }) }), "fan").joinBar;
    assert.deepEqual([idle.state, idle.stateText, idle.group.text, idle.label], ["idle", null, null, "join · all required"]);
});

test("the box and the bar as drawn: counts, state and rule; a click on the bar selects the parallel step", () => {
    const fanView = byId(running(), "fan");
    const box = renderToStaticMarkup(React.createElement(WorkflowGroupBox, { group: { id: "group:fan", parallel: "fan" }, node: fanView }));
    assert.match(box, /class="ps-workflow-group is-waiting" data-group="fan" role="group"/);
    assert.match(box, /<span class="ps-workflow-group-label">Each branch<\/span><span class="ps-workflow-group-counts">2 running · 1 queued · 0 done<\/span>/);
    const selected = [];
    const element = WorkflowJoinBar({ join: { id: "join:fan", parallel: "fan" }, node: fanView, selected: false, onSelect: id => selected.push(id) });
    const bar = renderToStaticMarkup(element);
    assert.match(bar, /class="ps-workflow-join is-waiting" data-join="fan" role="button"/);
    assert.match(bar, /<span class="ps-workflow-join-rule">join · all required · waiting for its branches<\/span><\/div>$/);
    assert.ok(!bar.includes("⏱") && !bar.includes("ps-workflow-join-time"), "no time limit is shown");
    element.props.onClick();
    element.props.onKeyDown({ key: "Enter", preventDefault() {} });
    assert.deepEqual(selected, ["fan", "fan"], "the bar is not a step: it selects the parallel step");
    // Before any run the box has no counts.
    const quiet = renderToStaticMarkup(React.createElement(WorkflowGroupBox, { group: { id: "group:fan", parallel: "fan" }, node: null }));
    assert.ok(quiet.includes(">Each branch<") && !quiet.includes("ps-workflow-group-counts"), quiet);
});

test("a parallel step's details: For each, Branch steps, Branches with deadlines and agent chats, and its next steps from the join", () => {
    const opened = [];
    const html = details(running(), "fan", { openSession: id => opened.push(id) });
    for (const [label, value] of [["Items", "the list in ${input.reviewers}"], ["At a time", "Up to 2 branches at a time"], ["Join", "Every branch must succeed"],
        ["Branches", "3"]]) {
        assert.ok(html.includes(`<span>${label}</span><strong>${value}</strong>`), `${label}: ${html}`);
    }
    assert.ok(!html.includes("Time limit") && !html.includes("⏱"), "no time limit is shown for the join");
    const order = ["prepare", "review", "reviewed"].map(id => html.indexOf(`data-branch-step="${id}"`));
    assert.ok(order.every(at => at > 0) && order[0] < order[1] && order[1] < order[2], "branch steps in route order");
    assert.ok(html.includes("reviewed · branch ends · succeeded"), html);
    assert.match(html, /aria-label="Branches"><h3>Branches<\/h3><p[^>]*>0 of 3 branches succeeded, 2 running, 1 queued\.<\/p>/);
    // People read branches from 1; the data attributes keep the index from 0.
    assert.match(html, /<tr data-branch="0" data-status="running"><td>1<\/td><td>review<\/td><td>running<\/td><td>2026-11-04 18:20:00 UTC<\/td><td>—<\/td><td><button[^>]*data-action="open-branch-chat" data-session="child-0"[^>]*>Open chat<\/button><\/td><\/tr>/);
    assert.match(html, /<tr data-branch="1" data-status="running"><td>2<\/td><td>review<\/td><td>running<\/td><td>2026-11-04 18:10:00 UTC<\/td><td>—<\/td><td>—<\/td><\/tr>/);
    assert.match(html, /<tr data-branch="2" data-status="queued"><td>3<\/td><td>—<\/td><td>queued<\/td>/);
    assert.ok(html.includes("<h3>Next steps from the join</h3>"), html);
    assert.ok(html.includes("joined → pause") && html.includes("blocked → review_blocked"), html);
    // Without a way to open sessions the chat is named, not offered.
    assert.match(details(running(), "fan"), /<td>2026-11-04 18:20:00 UTC<\/td><td>—<\/td><td>child-0<\/td>/);
});

test("a branch step's details show one branch's visit: the first running by default, else the one that ended last; the picker chooses another", () => {
    const projection = running();
    const review = byId(projection, "review");
    assert.deepEqual(review.branches.choices.map(choice => [choice.index, choice.label]), [[0, "Branch 1 · running"], [1, "Branch 2 · running"]]);
    assert.equal(review.branches.defaultIndex, 0);
    const prepare = byId(projection, "prepare");
    assert.deepEqual(prepare.branches.choices.map(choice => choice.label), ["Branch 1 · ended 'ready'", "Branch 2 · ended 'ready'"]);
    assert.equal(prepare.branches.defaultIndex, 1, "no branch runs it: the one that ended last");
    assert.equal(workflowV2BranchChoice(review.branches, 7).index, 0, "an unknown branch shows the default");
    assert.equal(workflowV2BranchChoices([], { id: "nx-fan-1" }), null);
    assert.equal(workflowV2BranchChoices(review.executions, null), null);

    const first = details(projection, "review");
    assert.match(first, /<select class="ps-workflow-input" data-field="branch" disabled="">/);
    assert.match(first, /<option value="0" selected="">Branch 1 · running<\/option><option value="1">Branch 2 · running<\/option>/);
    assert.ok(first.includes("In branch 1 of its parallel step.") && first.includes("<span>Branch</span><strong>1</strong>"), first);
    assert.ok(first.includes("2026-11-04 18:20:00 UTC") && first.includes("child-0"), "the first branch's deadline and its agent chat");
    const chosen = [];
    const second = details(projection, "review", { branchIndex: 1, onBranch: index => chosen.push(index) });
    assert.match(second, /<select class="ps-workflow-input" data-field="branch">/);
    assert.match(second, /<option value="1" selected="">Branch 2 · running<\/option>/);
    assert.ok(second.includes("In branch 2 of its parallel step.") && !second.includes("In branch 1 of its parallel step."), second);
    assert.ok(second.includes("2026-11-04 18:10:00 UTC") && !second.includes("child-0"), "the second branch's deadline, and no agent chat yet");
    // A step outside every branch has no picker.
    assert.ok(!details(projection, "pause").includes("data-field=\"branch\""));
});
