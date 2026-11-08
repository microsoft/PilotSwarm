// Workflow Simplified stage 2.1c, FU-17: an agent node's tool limit in words, the same in the portal and the TUI, from
// the graph's `tools` (describeWorkflowV2State shows it only for a state that sets one): "None (it can only finish the
// step)" for `tools: none`, the names for a list, and nothing for a state without a limit.
//
// Run: node --test packages/app/ui/core/test/workflow-agent-tools-words.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowViewModal,
} from "../src/index.js";
import { projectWorkflowV2, workflowV2AgentTools } from "../src/workflow-v2-view.js";
import { workflowNodeSummary } from "../src/workflow-node-summary.js";
import { WorkflowV2NodeContent } from "../../react/src/workflow-v2-panels.js";
import { readModel } from "./workflow-v2-fixtures.mjs";

process.env.TZ = "UTC";

const states = [
    { id: "sealed", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["ok"], tools: [], next: { ok: "listed" } },
    { id: "listed", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["ok"], tools: ["read_facts", "web_fetch"],
        next: { ok: "open" } },
    { id: "open", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["ok"], next: { ok: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
];
const model = readModel({ graph: { revision: 1, initial: "sealed", states } });
const nodeOf = id => projectWorkflowV2({ readModel: model }).nodes.find(node => node.id === id);

test("the tool limit in words, from the graph; the Node details say it only for a state that sets one", () => {
    assert.equal(workflowV2AgentTools(nodeOf("sealed")), "None");
    assert.equal(workflowV2AgentTools(nodeOf("listed")), "read_facts, web_fetch");
    assert.equal(workflowV2AgentTools(nodeOf("open")), null);
    assert.equal(workflowV2AgentTools(null), null);
    assert.equal(workflowNodeSummary(nodeOf("listed")).agent.tools, "read_facts, web_fetch");
    const projection = projectWorkflowV2({ readModel: model });
    for (const [id, words] of [["sealed", "None"], ["listed", "read_facts, web_fetch"], ["open", null]]) {
        const html = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, {
            tab: "details", selected: projection.nodes.find(node => node.id === id), nodes: projection.nodes, select: () => {},
        }));
        if (words === null) assert.ok(!html.includes("Tools"), id);
        else assert.ok(html.includes("Tools") && html.includes(words), `${id}: ${words}`);
    }
});

test("the TUI's node details say the tool limit as the portal does", async () => {
    const transport = { getSessionEventsBefore: async () => [], readWorkflow: async () => model };
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: limited", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model, readModelRunId: null } });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    const lines = selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);
    assert.ok(lines.includes("Tools: None"), lines.join("\n"));
});
