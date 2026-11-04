/**
 * Adversarial review R2-UI-5: a branch step's Output and History follow the branch its details show, and say which
 * branch (and which visit of the parallel step) each visit was in; visits of different branches are never combined.
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
