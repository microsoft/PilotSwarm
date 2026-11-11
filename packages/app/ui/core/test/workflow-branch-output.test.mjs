/**
 * Adversarial review R2-UI-5: a branch step's Output and History follow the branch its details show, and say which
 * branch (and which visit of the parallel step) each visit was in; visits of different branches are never combined.
 * Its re-check: a step not reached yet in the current parallel visit shows no earlier visit's result as its own (RC-5),
 * and a History choice ends when another branch is chosen in Details or a new parallel visit starts (RC-6). History
 * records a branch only when one was chosen in Details, so the default branch moving never ends a choice (R3-UI-3).
 *
 * Run: node --test test/workflow-branch-output.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    compactWorkflowExecutions, projectWorkflow, workflowBranchChoice, workflowSelectionAfterBranchChange, workflowShownExecution,
    workflowVisitPlaces,
} from "../src/workflow-view.js";
import { WorkflowNodeContent } from "../../react/src/workflow-panels.js";
import { done, readModel, row } from "./workflow-fixtures.mjs";

const states = [
    { id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 2, join: "all_required", failFast: false,
        body: { initial: "prepare", states: ["prepare", "reviewed"] }, outcomes: ["joined", "blocked"], next: { joined: "done", blocked: "failed" } },
    { id: "prepare", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["ready"], next: { ready: "reviewed" }, parallel: "fan" },
    { id: "reviewed", type: "terminal", outcome: "succeeded", parallel: "fan" },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const graph = { revision: 1, initial: "fan", states };
const at = (fan, index) => ({ scopeId: `${fan}#${index}`, branch: { parallelNodeExecutionId: fan, index } });
const prepare = rows => projectWorkflow({ readModel: readModel({ graph, nodeExecutions: rows }) }).nodes.find(node => node.id === "prepare");
const render = (selected, tab, props = {}) => renderToStaticMarkup(React.createElement(WorkflowNodeContent, {
    tab, selected, nodes: [], select: () => {}, runOutput: null, runError: null, runId: "run-1", onSelectExecution: () => {}, ...props }));

const oneVisit = () => [
    row("fan", 1, "pending", { nodeExecutionId: "nx-fan-1", branches: 2 }),
    done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-b0", outputPreview: '{"who":"a"}', ...at("nx-fan-1", 0) }),
    done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-b1", outputPreview: '{"who":"b"}', ...at("nx-fan-1", 1) }),
];

test("Output shows the result of the branch chosen in Details, and says which branch", () => {
    const node = prepare(oneVisit());
    // The default branch (the highest-numbered where it ended: branch 2) and a chosen one (branch 1).
    const fallback = render(node, "output");
    assert.ok(fallback.includes("Latest result of branch 2 in the loaded history for this step (the branch chosen in Details)."), fallback);
    assert.ok(fallback.includes("&quot;who&quot;: &quot;b&quot;") && !fallback.includes("&quot;a&quot;"), fallback);
    // A reader that can read whole values (onReadWholeValue) gets the control for every ended visit, clipped or not.
    const first = render(node, "output", { branchIndex: 0, onReadWholeValue: () => {} });
    assert.ok(first.includes("Latest result of branch 1 in the loaded history"), first);
    assert.ok(first.includes("&quot;who&quot;: &quot;a&quot;") && !first.includes("&quot;b&quot;"), first);
    assert.match(first, /data-action="whole-value"[^>]*data-execution="nx-prepare-b0"/, "its whole value is read for that branch's visit");
    assert.ok(!first.includes('data-execution="nx-prepare-b1"'), "never for another branch's visit");
    // Without a way to read whole values, there is no control (and no execution id) to show.
    assert.ok(!render(node, "output", { branchIndex: 0 }).includes('data-action="whole-value"'));
    // The shown visit, by the branch: that branch's latest ended visit, never another's in its place.
    assert.equal(workflowShownExecution(node, "run-1", null, node.branches.choices[0]).execution.id, "nx-prepare-b0");
    const running = prepare([...oneVisit().slice(0, 2), row("prepare", 1, "pending", { nodeExecutionId: "nx-prepare-b1", ...at("nx-fan-1", 1) })]);
    const pending = render(running, "output", { branchIndex: 1 });
    assert.ok(pending.includes("This step has no result in branch 2 in the loaded history yet."), pending);
    assert.ok(!pending.includes("&quot;a&quot;"), "not branch 1's result in its place");
    // A visit chosen in History says its branch.
    const chosen = render(node, "output", { branchIndex: 0, selection: { runId: "run-1", stateId: "prepare", executionId: "nx-prepare-b1" } });
    assert.ok(chosen.includes("Result of visit 1 in item 2, chosen in History."), chosen);
});

test("History lists the chosen branch's visits, every visit of all branches below, with branch and parallel visit; branches are never combined", () => {
    const rows = [
        done("fan", 1, "joined", { nodeExecutionId: "nx-fan-1", branches: 2 }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-1b0", outputPreview: "1", ...at("nx-fan-1", 0) }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-1b1", outputPreview: "1", ...at("nx-fan-1", 1) }),
        row("fan", 2, "pending", { nodeExecutionId: "nx-fan-2", branches: 2 }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-2b0", outputPreview: "1", ...at("nx-fan-2", 0) }),
    ];
    const node = prepare(rows);
    assert.deepEqual(node.where["nx-prepare-1b1"], { index: 1, number: 2, parallelExecutionId: "nx-fan-1", parallelVisit: 1, label: "item 2 · For each visit 1" });
    assert.equal(node.where["nx-prepare-2b0"].label, "item 1 · For each visit 2");
    // The same result in three scopes is three rows, never one combined row.
    assert.equal(compactWorkflowExecutions(node.executions).length, 3);
    const html = render(node, "history", { branchIndex: 0 });
    assert.ok(html.includes("Most recent visits of branch 1 (the branch chosen in Details) in the loaded history."), html);
    assert.ok(html.includes("<th>Branch</th><th>Visit</th>"), html);
    const [main, rest] = html.split("<details>");
    // The shown parallel visit is the second: its branch 1 is the chosen branch.
    assert.ok(main.includes("<td>1 · For each visit 2</td>") && !main.includes("For each visit 1"), main);
    assert.ok(rest.includes("Every loaded visit, all branches (3)") && rest.includes("<td>2 · For each visit 1</td>") && rest.includes("<td>1 · For each visit 1</td>"), rest);
    // One parallel visit only: the branch alone.
    assert.equal(workflowVisitPlaces(oneVisit().slice(1).map(item => ({ id: item.nodeExecutionId, branch: item.branch })), null)["nx-prepare-b0"].label, "item 1");
});

const plain = html => html.replaceAll("&#x27;", "'").replaceAll("&quot;", "\"");

// Re-check RC-5: the parallel step's second visit has started, but no branch of it reached `reviewed` yet. The step is not
// reached in that visit: it shows no state or result of the first visit as its own; the first visit's rows stay in History,
// each with its parallel visit.
test("RC-5: a step not reached yet in the current parallel visit shows no earlier visit's state or result as its own", () => {
    const rows = [
        done("fan", 1, "joined", { nodeExecutionId: "nx-fan-1", branches: 1 }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-1b0", outputPreview: '{"who":"a"}', ...at("nx-fan-1", 0) }),
        done("reviewed", 1, "succeeded", { nodeExecutionId: "nx-reviewed-1b0", outputPreview: '{"who":"old"}', ...at("nx-fan-1", 0) }),
        row("fan", 2, "pending", { nodeExecutionId: "nx-fan-2", branches: 1 }),
        row("prepare", 1, "pending", { nodeExecutionId: "nx-prepare-2b0", ...at("nx-fan-2", 0) }),
    ];
    const project = list => projectWorkflow({ readModel: readModel({ graph, nodeExecutions: list }) }).nodes.find(node => node.id === "reviewed");
    const reviewed = project(rows);
    assert.equal(reviewed.state, "idle");
    assert.equal(reviewed.stateLabel, "Not reached in visit 2 of fan");
    assert.equal(reviewed.result, null);
    assert.equal(reviewed.current, null);
    assert.equal(reviewed.branches, null);
    assert.deepEqual(reviewed.notReached, { parallelStateId: "fan", parallelVisit: 2 });
    // Review 19:27Z: a node, the For each's id without quotes.
    assert.ok(reviewed.description.includes("This node is not reached yet in visit 2 of fan, so it has no state or result of its own there. "
        + "Its visits in earlier visits of fan are in its history."), reviewed.description.join("\n"));
    const output = plain(render(reviewed, "output"));
    assert.ok(output.includes("This node is not reached yet in visit 2 of fan"), output);
    assert.ok(!output.includes("old"), "the first parallel visit's result is not shown as its own");
    const history = plain(render(reviewed, "history"));
    assert.ok(history.includes("Not reached yet in visit 2 of 'fan'. Its visits in earlier parallel visits, newest first."), history);
    assert.ok(history.includes("<td>1 · For each visit 1</td>"), history);
    // Re-check UI-RC2-2: the step's only visits are in the parallel step's first visit, but the parallel step had two, so
    // each says its parallel visit.
    assert.equal(reviewed.where["nx-reviewed-1b0"].label, "item 1 · For each visit 1");
    // Once a branch of the second visit reaches it, that visit's own state and result are shown.
    const reached = project([...rows.slice(0, 4), done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-2b0", ...at("nx-fan-2", 0) }),
        done("reviewed", 1, "succeeded", { nodeExecutionId: "nx-reviewed-2b0", outputPreview: '{"who":"new"}', ...at("nx-fan-2", 0) })]);
    assert.equal(reached.notReached, undefined);
    assert.equal(reached.result.id, "nx-reviewed-2b0");
    // The step's first visit, shown while no second visit of the parallel step exists, is its own as before.
    assert.equal(project(rows.slice(0, 3)).result.id, "nx-reviewed-1b0");
});

// Re-check UI-RC2-2: a visit's place names its parallel visit whenever it could be mistaken: visits in two parallel visits,
// a parallel step that had two visits, or a visit outside the parallel step's current visit (its own visit not loaded).
test("UI-RC2-2: the parallel visit is named when the step's visits, the parallel step's visits or the current visit call for it", () => {
    const visits = [{ id: "nx-a", branch: { parallelNodeExecutionId: "nx-fan-1", index: 0 } }];
    assert.equal(workflowVisitPlaces(visits, new Map([["nx-fan-1", 1]]))["nx-a"].label, "item 1", "one parallel visit, the current one");
    assert.equal(workflowVisitPlaces(visits, new Map([["nx-fan-1", 1]]), "nx-fan-1")["nx-a"].label, "item 1");
    assert.equal(workflowVisitPlaces(visits, new Map([["nx-fan-1", 1], ["nx-fan-2", 2]]))["nx-a"].label, "item 1 · For each visit 1");
    assert.equal(workflowVisitPlaces(visits, new Map([["nx-fan-2", 2]]), "nx-fan-2")["nx-a"].label, "item 1 · For each visit not loaded");
});

// Re-check RC-6: a result chosen in History keeps the branch chosen in Details and the parallel visit current when it was
// chosen. Choosing another branch in Details, or a new parallel visit, ends the choice: Output and its whole-value control
// follow the branch shown again.
test("RC-6: a History choice ends when another branch is chosen in Details or a new parallel visit starts", () => {
    const node = prepare(oneVisit());
    const selection = { runId: "run-1", stateId: "prepare", executionId: "nx-prepare-b0", parallelExecutionId: "nx-fan-1", branchIndex: 0 };
    // Chosen while branch 1 was shown: it applies while branch 1 is shown.
    const kept = plain(render(node, "output", { branchIndex: 0, selection, onReadWholeValue: () => {} }));
    assert.ok(kept.includes("Result of visit 1 in item 1, chosen in History."), kept);
    assert.match(kept, /data-action="whole-value"[^>]*data-execution="nx-prepare-b0"/);
    // Branch 2 chosen in Details afterwards: branch 2's latest result, and its whole value, not branch 1's.
    const moved = plain(render(node, "output", { branchIndex: 1, selection, onReadWholeValue: () => {} }));
    assert.ok(moved.includes("Latest result of branch 2 in the loaded history for this step (the branch chosen in Details)."), moved);
    assert.ok(moved.includes('"who": "b"') && !moved.includes('"who": "a"'), moved);
    assert.match(moved, /data-action="whole-value"[^>]*data-execution="nx-prepare-b1"/);
    assert.ok(!moved.includes('data-execution="nx-prepare-b0"'), moved);
    assert.equal(workflowShownExecution(node, "run-1", selection, node.branches.choices[1]).chosen, false);
    // A new parallel visit: the choice made in the first one no longer applies.
    const second = prepare([done("fan", 1, "joined", { nodeExecutionId: "nx-fan-1", branches: 2 }), ...oneVisit().slice(1),
        row("fan", 2, "pending", { nodeExecutionId: "nx-fan-2", branches: 2 }),
        row("prepare", 1, "pending", { nodeExecutionId: "nx-prepare-2b0", ...at("nx-fan-2", 0) })]);
    assert.equal(second.branches.parallelExecutionId, "nx-fan-2");
    assert.equal(workflowShownExecution(second, "run-1", selection, second.branches.choices[0]).chosen, false);
    // A choice made without these fields (an older client) is kept as before.
    assert.equal(workflowShownExecution(node, "run-1", { runId: "run-1", stateId: "prepare", executionId: "nx-prepare-b0" }, node.branches.choices[1]).chosen, true);
    // The History button records them: press branch 2's Result (the panel has no state of its own, so its element tree is read
    // and the button's own handler is called, as a click would).
    const recorded = [];
    const tabs = [];
    const tree = WorkflowNodeContent({ tab: "history", selected: node, nodes: [], select: () => {}, runOutput: null, runError: null, runId: "run-1",
        branchIndex: 1, onSelectExecution: (id, bound) => recorded.push([id, bound]), onTab: tab => tabs.push(tab) });
    const find = (element, match) => {
        if (Array.isArray(element)) return element.map(item => find(item, match)).find(Boolean) ?? null;
        if (!element || typeof element !== "object" || !element.props) return null;
        if (match(element.props)) return element;
        return find(element.props.children, match);
    };
    const button = find(tree, props => props["data-action"] === "show-result" && props["data-execution"] === "nx-prepare-b1");
    assert.ok(button, "branch 2's Result button");
    button.props.onClick();
    assert.deepEqual(recorded, [["nx-prepare-b1", { parallelExecutionId: "nx-fan-1", branchIndex: 1 }]]);
    assert.deepEqual(tabs, ["output"]);
});

// Re-check UI-RC2-3: a branch change in Details clears a History choice made for the step, so a round trip back to its
// branch shows that branch's latest result, not the old choice; a choice for another step is kept.
test("UI-RC2-3: a branch round trip 1 -> 2 -> 1 does not bring back a History choice; Output and its whole value follow the branch", () => {
    // Branch 1 has two visits of prepare; its first is chosen in History.
    const rows = [
        row("fan", 1, "pending", { nodeExecutionId: "nx-fan-1", branches: 2 }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-b0-1", outputPreview: '{"v":"old"}', ...at("nx-fan-1", 0) }),
        done("prepare", 2, "ready", { nodeExecutionId: "nx-prepare-b0-2", outputPreview: '{"v":"new"}', ...at("nx-fan-1", 0) }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-b1-1", outputPreview: '{"v":"b"}', ...at("nx-fan-1", 1) }),
    ];
    const node = prepare(rows);
    let selection = { runId: "run-1", stateId: "prepare", executionId: "nx-prepare-b0-1", parallelExecutionId: "nx-fan-1", branchIndex: 0 };
    assert.equal(workflowShownExecution(node, "run-1", selection, node.branches.choices[0]).execution.id, "nx-prepare-b0-1");
    // Branch 2 chosen: the choice is cleared.
    selection = workflowSelectionAfterBranchChange(selection, "prepare");
    assert.equal(selection, null);
    // Back to branch 1: its latest result, and its whole value, not the old choice.
    const back = plain(render(node, "output", { branchIndex: 0, selection, onReadWholeValue: () => {} }));
    assert.ok(back.includes("Latest result of branch 1") && back.includes('"v": "new"') && !back.includes('"v": "old"'), back);
    assert.match(back, /data-action="whole-value"[^>]*data-execution="nx-prepare-b0-2"/);
    // A choice for another step is not cleared by this step's branch change.
    const other = { runId: "run-1", stateId: "reviewed", executionId: "nx-x" };
    assert.equal(workflowSelectionAfterBranchChange(other, "prepare"), other);
    assert.equal(workflowSelectionAfterBranchChange(null, "prepare"), null);
});

// Re-check UI-RC2-4: a History choice made while the step is not reached in the parallel step's current visit is bound to
// that visit (not to none): another visit that does not reach the step either ends it, and the step's first reach within
// the same visit keeps it.
test("UI-RC2-4: a choice made while the step is unreached binds to the current parallel visit, ends with another one, and survives the first reach", () => {
    const visit1 = [
        done("fan", 1, "joined", { nodeExecutionId: "nx-fan-1", branches: 1 }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-1b0", ...at("nx-fan-1", 0) }),
        done("reviewed", 1, "succeeded", { nodeExecutionId: "nx-reviewed-1b0", outputPreview: '{"who":"old"}', ...at("nx-fan-1", 0) }),
    ];
    const reviewedOf = list => projectWorkflow({ readModel: readModel({ graph, nodeExecutions: list }) }).nodes.find(node => node.id === "reviewed");
    // Visit 2 runs, and has not reached reviewed: the choice of visit 1's result is bound to visit 2.
    const unreached = reviewedOf([...visit1, row("fan", 2, "pending", { nodeExecutionId: "nx-fan-2", branches: 1 }),
        row("prepare", 1, "pending", { nodeExecutionId: "nx-prepare-2b0", ...at("nx-fan-2", 0) })]);
    assert.equal(unreached.branches, null);
    assert.equal(unreached.parallelVisitId, "nx-fan-2");
    const recorded = [];
    const tree = WorkflowNodeContent({ tab: "history", selected: unreached, nodes: [], select: () => {}, runOutput: null, runError: null, runId: "run-1",
        onSelectExecution: (id, bound) => recorded.push([id, bound]), onTab: () => {} });
    const find = (element, match) => {
        if (Array.isArray(element)) return element.map(item => find(item, match)).find(Boolean) ?? null;
        if (!element || typeof element !== "object" || !element.props) return null;
        if (match(element.props)) return element;
        return find(element.props.children, match);
    };
    find(tree, props => props["data-action"] === "show-result" && props["data-execution"] === "nx-reviewed-1b0").props.onClick();
    assert.deepEqual(recorded, [["nx-reviewed-1b0", { parallelExecutionId: "nx-fan-2", branchIndex: null }]]);
    const selection = { runId: "run-1", stateId: "reviewed", executionId: "nx-reviewed-1b0", ...recorded[0][1] };
    assert.equal(workflowShownExecution(unreached, "run-1", selection).execution.id, "nx-reviewed-1b0");
    // The first reach within visit 2: the choice stays.
    const reached = reviewedOf([...visit1, row("fan", 2, "pending", { nodeExecutionId: "nx-fan-2", branches: 1 }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-2b0", ...at("nx-fan-2", 0) }),
        row("reviewed", 1, "pending", { nodeExecutionId: "nx-reviewed-2b0", ...at("nx-fan-2", 0) })]);
    assert.equal(reached.parallelVisitId, "nx-fan-2");
    assert.equal(workflowShownExecution(reached, "run-1", selection, null).chosen, true);
    // Re-check UI-RC3-1: also with the default branch the reach brings, as the portal passes it.
    assert.ok(reached.branches, "the reach brings a branch to choose");
    assert.equal(workflowShownExecution(reached, "run-1", selection, workflowBranchChoice(reached.branches, null)).chosen, true);
    // Visit 3, again not reaching reviewed: the choice ends.
    const third = reviewedOf([...visit1, done("fan", 2, "joined", { nodeExecutionId: "nx-fan-2", branches: 1 }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-2b0", ...at("nx-fan-2", 0) }),
        row("fan", 3, "pending", { nodeExecutionId: "nx-fan-3", branches: 1 })]);
    assert.equal(third.parallelVisitId, "nx-fan-3");
    assert.equal(workflowShownExecution(third, "run-1", selection).chosen, false);
});

// Re-check UI-RC3-1: a History choice made while the step has no branch to choose (its branchIndex is null) survives the
// step's first reach within the same parallel visit through the real panel: the default branch that the reach brings does
// not end it, and the whole value is read for the chosen visit, never for the new branch's. A branch chosen in Details
// still ends it (the portal's onBranch clears it), and a choice that named a branch still ends with another branch.
test("UI-RC3-1: a choice made before the step had a branch survives the default branch of its first reach; the whole value is the chosen visit's", () => {
    const find = (element, match) => {
        if (Array.isArray(element)) return element.map(item => find(item, match)).find(Boolean) ?? null;
        if (!element || typeof element !== "object" || !element.props) return null;
        if (match(element.props)) return element;
        return find(element.props.children, match);
    };
    const visit1 = [
        done("fan", 1, "joined", { nodeExecutionId: "nx-fan-1", branches: 1 }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-1b0", ...at("nx-fan-1", 0) }),
        done("reviewed", 1, "succeeded", { nodeExecutionId: "nx-reviewed-1b0", outputPreview: '{"who":"old"}', ...at("nx-fan-1", 0) }),
    ];
    const reviewedOf = list => projectWorkflow({ readModel: readModel({ graph, nodeExecutions: list }) }).nodes.find(node => node.id === "reviewed");
    const props = { nodes: [], select: () => {}, runOutput: null, runError: null, runId: "run-1" };
    // Visit 2 runs and has not reached reviewed: History's Result button of visit 1's result, pressed as a click would.
    const unreached = reviewedOf([...visit1, row("fan", 2, "pending", { nodeExecutionId: "nx-fan-2", branches: 1 }),
        row("prepare", 1, "pending", { nodeExecutionId: "nx-prepare-2b0", ...at("nx-fan-2", 0) })]);
    assert.equal(unreached.branches, null);
    const recorded = [];
    const history = WorkflowNodeContent({ ...props, tab: "history", selected: unreached, branchIndex: null,
        onSelectExecution: (id, bound) => recorded.push([id, bound]), onTab: () => {} });
    find(history, item => item["data-action"] === "show-result" && item["data-execution"] === "nx-reviewed-1b0").props.onClick();
    assert.deepEqual(recorded, [["nx-reviewed-1b0", { parallelExecutionId: "nx-fan-2", branchIndex: null }]]);
    // The choice as the portal stores it (selectWorkflowExecution keeps a null branchIndex).
    const selection = { runId: "run-1", stateId: "reviewed", executionId: "nx-reviewed-1b0", ...recorded[0][1] };
    // The first reach within visit 2: branch 1 reaches reviewed and ends there with a result of its own.
    const reached = reviewedOf([...visit1, row("fan", 2, "pending", { nodeExecutionId: "nx-fan-2", branches: 1 }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-2b0", ...at("nx-fan-2", 0) }),
        done("reviewed", 1, "succeeded", { nodeExecutionId: "nx-reviewed-2b0", outputPreview: '{"who":"new"}', ...at("nx-fan-2", 0) })]);
    assert.equal(reached.parallelVisitId, "nx-fan-2");
    assert.equal(workflowBranchChoice(reached.branches, null)?.ended?.id, "nx-reviewed-2b0", "the default branch has a result of its own");
    // Output with no branch chosen in Details (branchIndex null: the panel shows the default branch).
    const reads = [];
    const output = WorkflowNodeContent({ ...props, tab: "output", selected: reached, selection, branchIndex: null,
        onSelectExecution: () => {}, onReadWholeValue: id => reads.push(id) });
    const whole = find(output, item => item["data-action"] === "whole-value");
    assert.ok(whole, "the whole-value control");
    assert.equal(whole.props["data-execution"], "nx-reviewed-1b0");
    whole.props.onClick();
    assert.deepEqual(reads, ["nx-reviewed-1b0"], "the whole value read is the chosen visit's, not the new branch's");
    const shown = plain(render(reached, "output", { selection, onReadWholeValue: () => {} }));
    assert.ok(shown.includes("chosen in History") && shown.includes('"who": "old"') && !shown.includes('"who": "new"'), shown);
    // A branch chosen in Details clears the choice (the portal's onBranch), and Output follows that branch again.
    assert.equal(workflowSelectionAfterBranchChange(selection, "reviewed"), null);
    assert.equal(workflowShownExecution(reached, "run-1", null, reached.branches.choices[0]).execution.id, "nx-reviewed-2b0");
    // A choice that named a branch still ends when another branch is shown.
    assert.equal(workflowShownExecution(reached, "run-1", { ...selection, branchIndex: 1 }, reached.branches.choices[0]).chosen, false);
    // Another parallel visit still ends the choice made with no branch.
    const third = reviewedOf([...visit1, done("fan", 2, "joined", { nodeExecutionId: "nx-fan-2", branches: 1 }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-2b0", ...at("nx-fan-2", 0) }),
        done("reviewed", 1, "succeeded", { nodeExecutionId: "nx-reviewed-2b0", ...at("nx-fan-2", 0) }),
        row("fan", 3, "pending", { nodeExecutionId: "nx-fan-3", branches: 1 }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-3b0", ...at("nx-fan-3", 0) }),
        done("reviewed", 1, "succeeded", { nodeExecutionId: "nx-reviewed-3b0", ...at("nx-fan-3", 0) })]);
    assert.equal(third.parallelVisitId, "nx-fan-3");
    assert.equal(workflowShownExecution(third, "run-1", selection, workflowBranchChoice(third.branches, null)).chosen, false);
});

// Adversarial review R3-UI-3: History records a branch only when one was chosen in Details. A choice made while the panel
// showed the default branch survives the default moving (branch 1 ends, so branch 2, still running, becomes the default),
// through the real History and Output handlers: the whole value is still the chosen visit's, never the new default's
// earlier one. A branch chosen in Details still clears the choice, and a choice made with one records it.
test("R3-UI-3: a History choice made with the default branch shown survives the default moving; the whole value stays the chosen visit's", () => {
    const find = (element, match) => {
        if (Array.isArray(element)) return element.map(item => find(item, match)).find(Boolean) ?? null;
        if (!element || typeof element !== "object" || !element.props) return null;
        if (match(element.props)) return element;
        return find(element.props.children, match);
    };
    // Branch 2 ended its first visit and runs its second; branch 3 ended.
    const base = [
        row("fan", 1, "pending", { nodeExecutionId: "nx-fan-1", branches: 3 }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-b1-1", outputPreview: '{"who":"b1"}', ...at("nx-fan-1", 1) }),
        row("prepare", 2, "pending", { nodeExecutionId: "nx-prepare-b1-2", ...at("nx-fan-1", 1) }),
        done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-b2", outputPreview: '{"who":"b2"}', ...at("nx-fan-1", 2) }),
    ];
    const props = { nodes: [], select: () => {}, runOutput: null, runError: null, runId: "run-1" };
    // Branch 1 runs too: it is the default.
    const before = prepare([...base, row("prepare", 1, "pending", { nodeExecutionId: "nx-prepare-b0", ...at("nx-fan-1", 0) })]);
    assert.equal(before.branches.defaultIndex, 0, "the first branch where it runs");
    // Branch 3's Result in History's list of every visit, with no branch chosen in Details, pressed as a click would.
    const recorded = [];
    const history = WorkflowNodeContent({ ...props, tab: "history", selected: before, branchIndex: null,
        onSelectExecution: (id, bound) => recorded.push([id, bound]), onTab: () => {} });
    find(history, item => item["data-action"] === "show-result" && item["data-execution"] === "nx-prepare-b2").props.onClick();
    assert.deepEqual(recorded, [["nx-prepare-b2", { parallelExecutionId: "nx-fan-1", branchIndex: null }]], "the default branch is not recorded as chosen");
    const selection = { runId: "run-1", stateId: "prepare", executionId: "nx-prepare-b2", ...recorded[0][1] };
    // Branch 1 ends: the default moves to branch 2.
    const after = prepare([...base, done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-b0", outputPreview: '{"who":"b0"}', ...at("nx-fan-1", 0) })]);
    assert.equal(after.branches.defaultIndex, 1);
    const reads = [];
    const output = WorkflowNodeContent({ ...props, tab: "output", selected: after, selection, branchIndex: null, onSelectExecution: () => {},
        onReadWholeValue: id => reads.push(id) });
    const whole = find(output, item => item["data-action"] === "whole-value");
    assert.ok(whole, "the whole-value control");
    assert.equal(whole.props["data-execution"], "nx-prepare-b2");
    whole.props.onClick();
    assert.deepEqual(reads, ["nx-prepare-b2"], "the chosen visit's whole value, not branch 2's earlier one");
    const shown = plain(render(after, "output", { selection, onReadWholeValue: () => {} }));
    assert.ok(shown.includes("Result of visit 1 in item 3, chosen in History.") && shown.includes('"who": "b2"') && !shown.includes('"who": "b1"'), shown);
    // A branch chosen in Details clears the choice (the portal's onBranch); Output follows that branch again.
    assert.equal(workflowSelectionAfterBranchChange(selection, "prepare"), null);
    assert.equal(workflowShownExecution(after, "run-1", null, workflowBranchChoice(after.branches, 1)).execution.id, "nx-prepare-b1-1");
    // A choice made with a branch chosen in Details records that branch.
    const picked = [];
    const explicit = WorkflowNodeContent({ ...props, tab: "history", selected: before, branchIndex: 2,
        onSelectExecution: (id, bound) => picked.push([id, bound]), onTab: () => {} });
    find(explicit, item => item["data-action"] === "show-result" && item["data-execution"] === "nx-prepare-b2").props.onClick();
    assert.deepEqual(picked, [["nx-prepare-b2", { parallelExecutionId: "nx-fan-1", branchIndex: 2 }]]);
});
