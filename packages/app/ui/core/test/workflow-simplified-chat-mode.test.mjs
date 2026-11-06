// Workflow Simplified: an agent node that continues its chat (owner decision agent-node-continue-20261106). The Node
// details say the mode in words in the portal and the TUI ("New chat each visit" / "Continues the same chat"), from the
// graph's `chat` (describeWorkflowV2State shows it only for `continue`); the Workflow log says a later visit reuses the
// chat, that a visit ended while its chat stays open, that the chat ended with the Workflow, and that a chat which had
// ended on its own was replaced.
//
// Run: node --test packages/app/ui/core/test/workflow-simplified-chat-mode.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowViewModal,
} from "../src/index.js";
import { projectWorkflowV2, workflowEventText, workflowV2AgentChatMode } from "../src/workflow-v2-view.js";
import { WorkflowV2NodeContent } from "../../react/src/workflow-v2-panels.js";
import { readModel } from "./workflow-v2-fixtures.mjs";

process.env.TZ = "UTC";

const states = [
    { id: "talk", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["again", "finish"], chat: "continue",
        next: { again: "fresh", finish: "done" } },
    { id: "fresh", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["ok"], next: { ok: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
];
const model = readModel({ graph: { revision: 1, initial: "talk", states } });
const nodeOf = id => projectWorkflowV2({ readModel: model }).nodes.find(node => node.id === id);

test("the chat mode in words, from the graph", () => {
    assert.equal(workflowV2AgentChatMode(nodeOf("talk")), "Continues the same chat");
    assert.equal(workflowV2AgentChatMode(nodeOf("fresh")), "New chat each visit");
    assert.equal(workflowV2AgentChatMode(null), "New chat each visit");
    const projection = projectWorkflowV2({ readModel: model });
    for (const [id, words] of [["talk", "Continues the same chat"], ["fresh", "New chat each visit"]]) {
        const html = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, {
            tab: "details", selected: projection.nodes.find(node => node.id === id), nodes: projection.nodes, select: () => {},
        }));
        assert.ok(html.includes(words), `${id}: ${words}`);
    }
});

test("the TUI's node details say the chat mode as the portal does", async () => {
    const transport = { getSessionEventsBefore: async () => [], readWorkflow: async () => model };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: chatter", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model, readModelRunId: null } });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    const lines = selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);
    assert.ok(lines.includes("Chat: Continues the same chat"), lines.join("\n"));
});

test("the Workflow log says a later visit reuses the chat, a visit ended with its chat open, the chat ended, and a chat was replaced", () => {
    const short = (type, data) => workflowEventText(type, data, "short").text;
    assert.equal(short("workflow.agent_spawned", { stateId: "talk", childSessionId: "chat-1234567890", deadline: "2026-11-06T03:00:00Z" }),
        "Agent chat for node talk created (session chat-123); its time limit is 2026-11-06 03:00:00 UTC");
    assert.equal(short("workflow.agent_spawned", { stateId: "talk", childSessionId: "chat-1234567890", chat: "continue", cycle: 1 }),
        "Agent chat for node talk created (session chat-123)");
    assert.equal(short("workflow.agent_spawned", { stateId: "talk", childSessionId: "chat-1234567890", chat: "continue", cycle: 3,
        deadline: "2026-11-06T03:00:00Z" }), "Agent chat for node talk given visit 3 (same chat, session chat-123); its time limit is 2026-11-06 03:00:00 UTC");
    assert.equal(short("workflow.agent_cycle_ended", { stateId: "talk", turnStopped: true }),
        "Node talk visit ended; its agent chat stays open for the next visit (its running turn was stopped)");
    assert.equal(short("workflow.agent_cycle_ended", { stateId: "talk" }), "Node talk visit ended; its agent chat stays open for the next visit");
    assert.equal(short("workflow.agent_ended", { stateId: "talk", end: "done", chat: "continue" }),
        `Agent chat for node talk ended${short("workflow.agent_ended", { stateId: "talk", end: "done" }).slice("Agent chat for node talk ended".length)}`
        + "; the Workflow has no more visits for it");
    const restarted = workflowEventText("workflow.agent_chat_restarted", { stateId: "talk", endedChatSessionId: "old-chat-123456", cycle: 2 }, "short");
    assert.deepEqual(restarted, { text: "The agent chat for node talk (session old-chat) had ended, so visit 2 starts a new chat", level: "warning" });
});
