/**
 * Child Workflows UI tests (T23 + nested Workflow selection):
 * - Graph with a spawn state draws its icon, label and words.
 * - Node details for a spawn state list 2 children with links.
 * - Child Workflow projection carries spawnedBy.
 * - Selecting a nested child Workflow W2 under W1 under chat C0 resolves ownerId = C0, workflowId = W2.
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { projectWorkflow, workflowNodeLabel } from "../src/workflow-view.js";
import { workflowNodeCardWords } from "../src/workflow-words.js";
import { workflowNodeSummary } from "../src/workflow-node-summary.js";
import { selectWorkflowTabContext, workflowHighlightedSessionId, workflowSelectionTarget } from "../src/workflow-owner.js";
import { WorkflowGraph } from "../../react/src/workflow-graph.js";
import { WorkflowNodeSummary } from "../../react/src/workflow-panels.js";
import { selectWorkflowViewModal } from "../src/workflow-tui.js";
import { PilotSwarmUiController } from "../src/controller.js";

const READ_MODEL = {
    workflowId: "wf-parent",
    definition: { state: "published", semver: "1.0.0", currentRevision: 1, publishedRevision: 1, publishedDefinitionHash: "h", source: null, notifyOnCompletion: true },
    revision: { revision: 1, definitionHash: "h", valid: true, irSha256: "ir", name: "service-monitor", diagnostics: [] },
    graph: {
        revision: 1,
        initial: "launch_inv",
        states: [
            { id: "launch_inv", type: "spawn", definition: "anomaly-investigation", revision: 2, outcomes: ["started"], next: { started: "done", failure: "failed" } },
            { id: "done", type: "terminal", outcome: "succeeded" },
            { id: "failed", type: "terminal", outcome: "failed" },
        ],
    },
    runs: [{ runId: "run-p", mode: "live", status: "running", revision: 1, outcome: null }],
    run: {
        runId: "run-p", mode: "live", status: "running", outcome: null,
        terminalState: null, output: null, error: null, kvRevision: 1, kv: {}, inputs: {},
        spawnChildren: [
            { workflowId: "wf-child-1", runId: "run-c1", definition: "anomaly-investigation", revision: 2, status: "running", outcome: null, stateId: "launch_inv", visit: 1, startedAt: "2026-11-25T00:00:01Z", endedAt: null },
            { workflowId: "wf-child-2", runId: "run-c2", definition: "anomaly-investigation", revision: 2, status: "completed", outcome: "succeeded", stateId: "launch_inv", visit: 2, startedAt: "2026-11-25T00:05:01Z", endedAt: "2026-11-25T00:12:00Z" },
        ],
        nodeExecutions: [
            { nodeExecutionId: "nx-1", stateId: "launch_inv", ordinal: 1, state: "completed", outcome: "started", resultKind: "business", winner: "effect", attempts: 1, kvRevision: 1, enteredAt: "2026-11-25T00:00:00Z", endedAt: "2026-11-25T00:00:01Z", inputPreview: "{}" },
            { nodeExecutionId: "nx-2", stateId: "launch_inv", ordinal: 2, state: "completed", outcome: "started", resultKind: "business", winner: "effect", attempts: 1, kvRevision: 1, enteredAt: "2026-11-25T00:05:00Z", endedAt: "2026-11-25T00:05:01Z", inputPreview: "{}" },
        ],
        openExecutions: [], inbox: [], openInbox: [], outbox: [], openOutbox: [], pages: {},
    },
};

test("T23: graph with spawn state draws icon and words; node details list 2 children with links; spawnedBy projected", async () => {
    const flow = projectWorkflow({ readModel: READ_MODEL, events: [], session: { sessionId: "wf-parent", status: "running" } });
    const spawnNode = flow.nodes.find(n => n.id === "launch_inv");
    assert.ok(spawnNode);
    assert.equal(spawnNode.kind, "spawn");
    assert.equal(workflowNodeLabel(spawnNode), "Spawn · anomaly-investigation");
    assert.equal(workflowNodeCardWords({ kind: "spawn", definition: "anomaly-investigation", state: "done", outcome: "started", runs: 2 }).fact, "anomaly-investigation");
    assert.equal(spawnNode.children.length, 2);

    const graphHtml = renderToStaticMarkup(React.createElement(WorkflowGraph, { definition: flow.definition, nodes: flow.nodes, selected: "launch_inv", select: () => {} }));
    assert.match(graphHtml, /is-kind-spawn/);
    assert.match(graphHtml, /anomaly-investigation/);

    const summary = workflowNodeSummary(spawnNode);
    assert.equal(summary.spawn.definition, "anomaly-investigation");
    assert.equal(summary.spawn.children.length, 2);
    const panelHtml = renderToStaticMarkup(React.createElement(WorkflowNodeSummary, {
        selected: spawnNode, current: spawnNode.current, nodes: flow.nodes, runId: "run-p", openSession: () => {},
    }));
    assert.match(panelHtml, /data-section="spawn-children"/);
    assert.match(panelHtml, /Children \(2\)/);
    assert.match(panelHtml, /data-child-workflow="wf-child-1"/);
    assert.match(panelHtml, /data-child-workflow="wf-child-2"/);
    assert.match(panelHtml, /data-action="open-child-workflow"/);

    // Child Workflow carries spawnedBy
    const childFlow = projectWorkflow({
        readModel: { ...READ_MODEL, workflowId: "wf-child-1", spawnedBy: { workflowId: "wf-parent", stateId: "launch_inv", visit: 1 } },
        events: [], session: { sessionId: "wf-child-1", status: "running" },
    });
    assert.deepEqual(childFlow.spawnedBy, { workflowId: "wf-parent", stateId: "launch_inv", visit: 1 });

    // TUI Enter (confirmModal -> openWorkflowViewChild) actually opens the spawned child session, and child header shows spawnedBy.
    const parentState = {
        sessions: { byId: { "wf-parent": { sessionId: "wf-parent", status: "running", sessionKind: "workflow" } }, activeSessionId: "wf-parent" },
        history: { bySessionId: new Map() },
        ui: {
            workflowViews: { "wf-parent": { readModel: READ_MODEL, loading: false } },
            modal: { type: "workflowView", sessionId: "wf-parent", selectedNodeId: "launch_inv", detailsScroll: 0 },
            layout: { viewportHeight: 40 },
        },
    };
    const opened = [];
    const fakeCtrl = Object.create(PilotSwarmUiController.prototype);
    fakeCtrl.getState = () => parentState;
    fakeCtrl.dispatch = () => {};
    fakeCtrl.releaseWorkflowPaneWatch = () => {};
    fakeCtrl.setFocus = () => {};
    fakeCtrl.loadSession = async (id) => { opened.push(id); };
    await fakeCtrl.openWorkflowViewChild();
    assert.deepEqual(opened, ["wf-child-1"]);

    const childReadModel = { ...READ_MODEL, workflowId: "wf-child-1", spawnedBy: { workflowId: "wf-parent", stateId: "launch_inv", visit: 1 } };
    const childTui = selectWorkflowViewModal({
        sessions: { byId: { "wf-child-1": { sessionId: "wf-child-1", status: "running", sessionKind: "workflow" } }, activeSessionId: "wf-child-1" },
        history: { bySessionId: new Map() },
        ui: {
            workflowViews: { "wf-child-1": { readModel: childReadModel, loading: false } },
            modal: { type: "workflowView", sessionId: "wf-child-1", selectedNodeId: "launch_inv", detailsScroll: 0 },
            layout: { viewportHeight: 40 },
        },
    }, 120, 40);
    assert.match(childTui?.title ?? "", /from launch_inv #1/);
});

test("nested child Workflow selection resolves to non-workflow definition owner and focuses the child", () => {
    const byId = {
        C0: { sessionId: "C0", parentSessionId: null, sessionKind: "agent" },
        W1: { sessionId: "W1", parentSessionId: "C0", sessionKind: "workflow" },
        W2: { sessionId: "W2", parentSessionId: "W1", sessionKind: "workflow" },
    };
    assert.deepEqual(workflowSelectionTarget(byId, "W2"), { ownerId: "C0", workflowId: "W2" });
    const ctx = selectWorkflowTabContext({ sessions: { byId, activeSessionId: "C0", workflowRowId: "W2" }, ui: {} });
    assert.deepEqual(ctx, { ownerId: "C0", workflowId: "W2", nodeSessionId: null, nodeStateId: null });
    assert.equal(workflowHighlightedSessionId({ byId, activeSessionId: "C0", workflowRowId: "W2" }), "W2");
});
