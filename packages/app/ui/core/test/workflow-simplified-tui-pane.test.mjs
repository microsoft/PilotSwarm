// Workflow Simplified, terminal UI (spec 18: "Same model: chat plus a Workflow pane toggle, shared words"):
// - a Workflow row selects its session's chat, as in the portal; w then opens the Workflow pane for that Workflow, kept
//   live while it is open (its own subscription), and Esc goes back to the chat;
// - an agent node's chat opens its Workflow with that node selected; a chat opens its selected or newest Workflow; a
//   chat with no Workflows says so;
// - the pane says node, not step; an agent node's chat is read-only with one plain line naming the chat that owns it.
//
// Run: node --test packages/app/ui/core/test/workflow-simplified-tui-pane.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, createInitialState, createStore, selectWorkflowInputNote, selectWorkflowViewModal,
    workflowPaneTarget,
} from "../src/index.js";
import { readModel } from "./workflow-v2-fixtures.mjs";

const states = [
    { id: "fetch", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["done"], next: { done: "review", failure: "failed", timed_out: "failed" } },
    { id: "review", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["accepted"], next: { accepted: "done", timed_out: "failed" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const MODEL = readModel({ graph: { revision: 1, initial: "fetch", states }, revision: { name: "check-items" } });
/** Stock check (r1) owns two Workflows of check-items (wf1, the older, and wf2); wf2's node review runs in chat c1; a1 has none. */
const ROWS = [
    { sessionId: "r1", title: "Stock check", status: "idle", createdAt: 1 },
    { sessionId: "wf1", title: "Workflow: check-items", status: "completed", sessionKind: "workflow", parentSessionId: "r1", createdAt: 2 },
    { sessionId: "wf2", title: "Workflow: check-items", status: "running", sessionKind: "workflow", parentSessionId: "r1", createdAt: 3 },
    { sessionId: "c1", title: "Workflow step: review", status: "running", parentSessionId: "wf2", createdAt: 4 },
    { sessionId: "a1", title: "Other chat", status: "idle", createdAt: 5 },
];

function harness() {
    const subscriptions = [];
    const transport = new Proxy({
        readWorkflow: async () => MODEL,
        getSessionEventsBefore: async () => [],
        getSessionEvents: async () => [],
        subscribeSession: (sessionId) => {
            const entry = { sessionId, closed: false };
            subscriptions.push(entry);
            return () => { entry.closed = true; };
        },
    }, { get: (target, name) => (name in target ? target[name] : typeof name === "string" ? async () => null : undefined) });
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: ROWS });
    for (const id of ["wf1", "wf2"]) store.dispatch({ type: "ui/workflowView", sessionId: id, view: { readModel: MODEL, readModelRunId: null } });
    return { controller, store, subscriptions };
}

const status = store => store.getState().ui.statusText;
const modal = store => store.getState().ui.modal;

test("a Workflow row keeps its session's chat; w opens that Workflow's pane, kept live while it is open, and Esc goes back to the chat", async () => {
    const { controller, store, subscriptions } = harness();
    store.dispatch({ type: "sessions/selected", sessionId: "wf1" });
    assert.equal(store.getState().sessions.activeSessionId, "r1", "the chat stays in the middle");
    assert.deepEqual(workflowPaneTarget(store.getState()), { workflowId: "wf1", nodeStateId: null });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    assert.equal(modal(store).type, "workflowView");
    assert.equal(modal(store).sessionId, "wf1");
    assert.equal(status(store), "Workflow — ↑↓ node · PgUp/PgDn details · Tab agent chat · Enter open · Esc back to the chat");
    const view = selectWorkflowViewModal(store.getState(), 100, 40);
    assert.match(view.detailsTitle, /^Node fetch — ↑↓ node · Tab agent chat · Enter open · Esc back to the chat$/);
    assert.ok(!/step/i.test(view.detailsTitle));
    assert.deepEqual(subscriptions.map(entry => [entry.sessionId, entry.closed]), [["wf1", false]], "the shown Workflow is kept live");
    await controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.equal(modal(store), null);
    assert.equal(store.getState().sessions.activeSessionId, "r1");
    assert.deepEqual(subscriptions.map(entry => [entry.sessionId, entry.closed]), [["wf1", true]], "released when the pane closes");
});

test("a chat with no selected Workflow opens its newest; an agent node's chat opens its Workflow at that node; a chat with none says so", async () => {
    const { controller, store } = harness();
    store.dispatch({ type: "sessions/selected", sessionId: "r1" });
    assert.deepEqual(workflowPaneTarget(store.getState()), { workflowId: "wf2", nodeStateId: null });
    store.dispatch({ type: "sessions/selected", sessionId: "c1" });
    assert.equal(store.getState().sessions.activeSessionId, "c1");
    assert.deepEqual(workflowPaneTarget(store.getState()), { workflowId: "wf2", nodeStateId: "review" });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    assert.equal(modal(store).sessionId, "wf2");
    assert.equal(modal(store).selectedNodeId, "review");
    await controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    store.dispatch({ type: "sessions/selected", sessionId: "a1" });
    assert.equal(workflowPaneTarget(store.getState()), null);
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    assert.equal(modal(store), null);
    assert.equal(status(store), "This chat has no Workflows yet");
});

test("an agent node's chat is read-only with one plain line naming the chat that owns the Workflow", () => {
    const { store } = harness();
    store.dispatch({ type: "ui/workflowInputPolicy", sessionId: "c1", policy: { canSendPrompt: false, canAnswer: false, canSteer: false,
        reason: "This session runs a step of a workflow.", workflowSessionId: "wf2", controllingSessionId: "r1" } });
    const recorded = store.getState().ui.workflowInputPolicies?.c1;
    assert.equal(recorded.controllingSessionId, "r1");
    assert.equal(selectWorkflowInputNote(store.getState(), "c1"), "Read-only. To change this, message Stock check.");
});
