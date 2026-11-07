/**
 * Workflow Simplified, review UI-3: the Node panel of a For each step shows the chosen item's own result. A pending item
 * whose earlier visits ended nowhere says it has no result yet, never another item's; a step the For each's current
 * visit has not reached shows no earlier visit's result. A step outside a For each keeps its latest result.
 *
 * Run: node --test ui/core/test/workflow-simplified-node-item-result.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { projectWorkflowV2 } from "../src/workflow-v2-view.js";
import { workflowNodeSummary } from "../src/workflow-node-summary.js";
import { WorkflowV2NodeSummary } from "../../react/src/workflow-v2-panels.js";
import { done, readModel, row } from "./workflow-v2-fixtures.mjs";

const states = [
    { id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 2, join: "all_required", failFast: false,
        body: { initial: "check", states: ["check", "checked"] }, outcomes: ["joined", "blocked"], next: { joined: "done", blocked: "failed" } },
    { id: "check", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["ready"], next: { ready: "checked" }, parallel: "fan" },
    { id: "checked", type: "terminal", outcome: "succeeded", parallel: "fan" },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const graph = { revision: 1, initial: "fan", states };
const at = (fan, index) => ({ scopeId: `${fan}#${index}`, branch: { parallelNodeExecutionId: fan, index } });
const nodeOf = rows => projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: rows }) }).nodes.find(node => node.id === "check");
const render = (selected, branchIndex = null) => renderToStaticMarkup(React.createElement(WorkflowV2NodeSummary, {
    selected, nodes: [], select: () => {}, runId: "run-1", branchIndex, onBranch: () => {} }));

// apple (item 1) ended with its result; cherry (item 2) is still running.
const visitOne = [
    row("fan", 1, "pending", { nodeExecutionId: "nx-fan-1", branches: 2 }),
    done("check", 1, "ready", { nodeExecutionId: "nx-check-apple", outputPreview: '"apple is in stock"', ...at("nx-fan-1", 0) }),
    row("check", 1, "pending", { nodeExecutionId: "nx-check-cherry", ...at("nx-fan-1", 1) }),
];

test("a running item shows that it has no result yet, never another item's", () => {
    const node = nodeOf(visitOne);
    const cherry = render(node, 1);
    assert.ok(!cherry.includes("apple is in stock"), cherry);
    assert.ok(cherry.includes("No result yet for this item: it is still running."), cherry);
    const apple = render(node, 0);
    assert.ok(apple.includes("apple is in stock"), apple);
    assert.ok(!apple.includes("No result yet"), apple);
    // The model, directly: the chosen item's own ended visit decides, or says none.
    const cherryChoice = node.branches.choices.find(choice => choice.index === 1);
    const summary = workflowNodeSummary(node, { execution: cherryChoice.execution, ended: cherryChoice.ended ?? null });
    assert.equal(summary.result, null);
    assert.equal(summary.noResult, "No result yet for this item: it is still running.");
});

test("a step the For each's current visit has not reached shows no earlier visit's result", () => {
    const node = nodeOf([
        done("fan", 1, "joined", { nodeExecutionId: "nx-fan-1", branches: 1 }),
        done("check", 1, "ready", { nodeExecutionId: "nx-check-old", outputPreview: '"from the first visit"', ...at("nx-fan-1", 0) }),
        row("fan", 2, "pending", { nodeExecutionId: "nx-fan-2", branches: 1 }),
    ]);
    assert.ok(node.notReached, "not reached in visit 2");
    const html = render(node);
    assert.ok(!html.includes("from the first visit"), html);
    assert.equal(workflowNodeSummary(node).result, null);
});

test("a step outside a For each still shows its latest result", () => {
    const fan = projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: [
        done("fan", 1, "joined", { nodeExecutionId: "nx-fan-1", branches: 1, outputPreview: '"all checked"' }),
    ] }) }).nodes.find(node => node.id === "fan");
    assert.equal(workflowNodeSummary(fan).result?.text, "all checked");
});
