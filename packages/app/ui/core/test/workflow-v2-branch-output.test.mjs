/**
 * Adversarial review R2-UI-5: a branch step's Output and History follow the branch its details show, and say which
 * branch (and which visit of the parallel step) each visit was in; visits of different branches are never combined.
 * Its re-check: a step not reached yet in the current parallel visit shows no earlier visit's result as its own (RC-5),
 * and a History choice ends when another branch is chosen in Details or a new parallel visit starts (RC-6).
 *
 * Run: node --test test/workflow-v2-branch-output.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compactWorkflowV2Executions, projectWorkflowV2, workflowV2ShownExecution, workflowV2VisitPlaces } from "../src/workflow-v2-view.js";
import { WorkflowV2NodeContent } from "../../react/src/workflow-v2-panels.js";
import { done, readModel, row } from "./workflow-v2-fixtures.mjs";

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
const prepare = rows => projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: rows }) }).nodes.find(node => node.id === "prepare");
const render = (selected, tab, props = {}) => renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, {
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
    assert.equal(workflowV2ShownExecution(node, "run-1", null, node.branches.choices[0]).execution.id, "nx-prepare-b0");
    const running = prepare([...oneVisit().slice(0, 2), row("prepare", 1, "pending", { nodeExecutionId: "nx-prepare-b1", ...at("nx-fan-1", 1) })]);
    const pending = render(running, "output", { branchIndex: 1 });
    assert.ok(pending.includes("This step has no result in branch 2 in the loaded history yet."), pending);
    assert.ok(!pending.includes("&quot;a&quot;"), "not branch 1's result in its place");
    // A visit chosen in History says its branch.
    const chosen = render(node, "output", { branchIndex: 0, selection: { runId: "run-1", stateId: "prepare", executionId: "nx-prepare-b1" } });
    assert.ok(chosen.includes("Result of visit 1 in branch 2, chosen in History."), chosen);
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
    assert.deepEqual(node.where["nx-prepare-1b1"], { index: 1, number: 2, parallelExecutionId: "nx-fan-1", parallelVisit: 1, label: "branch 2 · parallel visit 1" });
    assert.equal(node.where["nx-prepare-2b0"].label, "branch 1 · parallel visit 2");
    // The same result in three scopes is three rows, never one combined row.
    assert.equal(compactWorkflowV2Executions(node.executions).length, 3);
    const html = render(node, "history", { branchIndex: 0 });
    assert.ok(html.includes("Most recent visits of branch 1 (the branch chosen in Details) in the loaded history."), html);
    assert.ok(html.includes("<th>Branch</th><th>Visit</th>"), html);
    const [main, rest] = html.split("<details>");
    // The shown parallel visit is the second: its branch 1 is the chosen branch.
    assert.ok(main.includes("<td>1 · parallel visit 2</td>") && !main.includes("parallel visit 1"), main);
    assert.ok(rest.includes("Every loaded visit, all branches (3)") && rest.includes("<td>2 · parallel visit 1</td>") && rest.includes("<td>1 · parallel visit 1</td>"), rest);
    // One parallel visit only: the branch alone.
    assert.equal(workflowV2VisitPlaces(oneVisit().slice(1).map(item => ({ id: item.nodeExecutionId, branch: item.branch })), null)["nx-prepare-b0"].label, "branch 1");
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
    const project = list => projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: list }) }).nodes.find(node => node.id === "reviewed");
    const reviewed = project(rows);
    assert.equal(reviewed.state, "idle");
    assert.equal(reviewed.stateLabel, "Not reached in visit 2 of 'fan'");
    assert.equal(reviewed.result, null);
    assert.equal(reviewed.current, null);
    assert.equal(reviewed.branches, null);
    assert.deepEqual(reviewed.notReached, { parallelStateId: "fan", parallelVisit: 2 });
    assert.ok(reviewed.description.includes("This step is not reached yet in visit 2 of 'fan', so it has no state or result of its own there. "
        + "Its visits in earlier parallel visits are in History."), reviewed.description.join("\n"));
    const output = plain(render(reviewed, "output"));
    assert.ok(output.includes("This step is not reached yet in visit 2 of 'fan'"), output);
    assert.ok(!output.includes("old"), "the first parallel visit's result is not shown as its own");
    const history = plain(render(reviewed, "history"));
    assert.ok(history.includes("Not reached yet in visit 2 of 'fan'. Its visits in earlier parallel visits, newest first."), history);
    assert.ok(history.includes("<td>1 · parallel visit 1</td>"), history);
    // Once a branch of the second visit reaches it, that visit's own state and result are shown.
    const reached = project([...rows.slice(0, 4), done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-2b0", ...at("nx-fan-2", 0) }),
        done("reviewed", 1, "succeeded", { nodeExecutionId: "nx-reviewed-2b0", outputPreview: '{"who":"new"}', ...at("nx-fan-2", 0) })]);
    assert.equal(reached.notReached, undefined);
    assert.equal(reached.result.id, "nx-reviewed-2b0");
    // The step's first visit, shown while no second visit of the parallel step exists, is its own as before.
    assert.equal(project(rows.slice(0, 3)).result.id, "nx-reviewed-1b0");
});

// Re-check RC-6: a result chosen in History keeps the branch chosen in Details and the parallel visit current when it was
// chosen. Choosing another branch in Details, or a new parallel visit, ends the choice: Output and its whole-value control
// follow the branch shown again.
test("RC-6: a History choice ends when another branch is chosen in Details or a new parallel visit starts", () => {
    const node = prepare(oneVisit());
    const selection = { runId: "run-1", stateId: "prepare", executionId: "nx-prepare-b0", parallelExecutionId: "nx-fan-1", branchIndex: 0 };
    // Chosen while branch 1 was shown: it applies while branch 1 is shown.
    const kept = plain(render(node, "output", { branchIndex: 0, selection, onReadWholeValue: () => {} }));
    assert.ok(kept.includes("Result of visit 1 in branch 1, chosen in History."), kept);
    assert.match(kept, /data-action="whole-value"[^>]*data-execution="nx-prepare-b0"/);
    // Branch 2 chosen in Details afterwards: branch 2's latest result, and its whole value, not branch 1's.
    const moved = plain(render(node, "output", { branchIndex: 1, selection, onReadWholeValue: () => {} }));
    assert.ok(moved.includes("Latest result of branch 2 in the loaded history for this step (the branch chosen in Details)."), moved);
    assert.ok(moved.includes('"who": "b"') && !moved.includes('"who": "a"'), moved);
    assert.match(moved, /data-action="whole-value"[^>]*data-execution="nx-prepare-b1"/);
    assert.ok(!moved.includes('data-execution="nx-prepare-b0"'), moved);
    assert.equal(workflowV2ShownExecution(node, "run-1", selection, node.branches.choices[1]).chosen, false);
    // A new parallel visit: the choice made in the first one no longer applies.
    const second = prepare([done("fan", 1, "joined", { nodeExecutionId: "nx-fan-1", branches: 2 }), ...oneVisit().slice(1),
        row("fan", 2, "pending", { nodeExecutionId: "nx-fan-2", branches: 2 }),
        row("prepare", 1, "pending", { nodeExecutionId: "nx-prepare-2b0", ...at("nx-fan-2", 0) })]);
    assert.equal(second.branches.parallelExecutionId, "nx-fan-2");
    assert.equal(workflowV2ShownExecution(second, "run-1", selection, second.branches.choices[0]).chosen, false);
    // A choice made without these fields (an older client) is kept as before.
    assert.equal(workflowV2ShownExecution(node, "run-1", { runId: "run-1", stateId: "prepare", executionId: "nx-prepare-b0" }, node.branches.choices[1]).chosen, true);
    // The History button records them: press branch 2's Result (the panel has no state of its own, so its element tree is read
    // and the button's own handler is called, as a click would).
    const recorded = [];
    const tabs = [];
    const tree = WorkflowV2NodeContent({ tab: "history", selected: node, nodes: [], select: () => {}, runOutput: null, runError: null, runId: "run-1",
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
