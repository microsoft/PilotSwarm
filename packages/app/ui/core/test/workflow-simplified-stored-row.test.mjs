/**
 * Usability re-test r3, C09: zen did not survive a reload at 1440 px. The page had a Workflow row selected (the parent's
 * Workflow #1); the profile saves it as activeSessionId (the highlighted row, review UI-8); after the reload the profile
 * was applied before the catalog answered, so it could not be mapped to its session, and the Workflow stayed the active
 * session itself: it showed alone in the middle (no chat, and no zen there). Once the session's row is loaded, its chat is
 * selected with the Workflow row, and that chat's own view (its columns and zen) applies.
 *
 * Run: node --test ui/core/test/workflow-simplified-stored-row.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState, createStore, selectWorkflowTabContext } from "../src/index.js";

const rows = [
    { sessionId: "owner", title: "Release triage agent", updatedAt: 2 },
    { sessionId: "wf-1", sessionKind: "workflow", title: "Workflow: ux-facts", status: "failed", parentSessionId: "owner", createdAt: 1, updatedAt: 2 },
];

test("a stored Workflow row applied before the catalog selects its session's chat with the row once the catalog answers", () => {
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "api" }));
    store.dispatch({ type: "ui/sessionViewDevice", device: "desktop" });
    // The profile first: the Workflow row was the selection, the owner's view had the canvas column in zen.
    store.dispatch({ type: "profileSettings/apply", settings: { activeSessionId: "wf-1",
        desktopPanes: { canvasOpen: true, diagnosticsOpen: false, zen: true, sideTab: "workflow" },
        sessionViews: { owner: { desktop: { at: 1, canvasOpen: true, diagnosticsOpen: false, zen: true, layout: {} } } } } });
    assert.equal(store.getState().sessions.activeSessionId, "wf-1", "no catalog yet: it cannot be mapped");
    store.dispatch({ type: "sessions/loaded", sessions: rows });
    const state = store.getState();
    assert.equal(state.sessions.activeSessionId, "owner", "its session's chat is selected");
    assert.equal(state.sessions.workflowRowId, "wf-1", "with the Workflow row");
    assert.deepEqual({ ...selectWorkflowTabContext(state) }, { ownerId: "owner", workflowId: "wf-1", nodeSessionId: null, nodeStateId: null });
    assert.equal(state.ui.workflowTabs.owner.workflowId, "wf-1", "the owner's tab remembers it");
    assert.equal(state.ui.canvasZen, true, "the chat's own view: zen");
    assert.equal(state.ui.canvasOpen, true);
});

test("a Workflow whose session is not loaded stays the active session; a link still resolving maps itself", () => {
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [rows[1]] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf-1" });
    assert.equal(store.getState().sessions.activeSessionId, "wf-1", "its session is not loaded");
    store.dispatch({ type: "sessions/loaded", sessions: rows });
    assert.deepEqual([store.getState().sessions.activeSessionId, store.getState().sessions.workflowRowId], ["owner", "wf-1"], "loaded later: its chat");
    // A link (navigation intent) to the Workflow keeps its own mapping (S8).
    const linked = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "api" }));
    linked.dispatch({ type: "sessions/navigationIntent", sessionId: "wf-1" });
    linked.dispatch({ type: "sessions/loaded", sessions: rows });
    assert.deepEqual([linked.getState().sessions.activeSessionId, linked.getState().sessions.workflowRowId], ["owner", "wf-1"]);
});

test("the mapping runs only when the sessions slice changes: streamed history leaves the slice as it was", () => {
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: rows });
    store.dispatch({ type: "sessions/selected", sessionId: "owner" });
    const before = store.getState();
    for (let i = 0; i < 50; i += 1) store.dispatch({ type: "history/loadState", sessionId: "owner", loadState: i % 2 ? "loaded" : "loading" });
    assert.equal(store.getState().sessions, before.sessions, "no history action replaces the sessions slice");
    // The rule it relies on: a state the reducer made is already mapped, so skipping unchanged sessions misses nothing.
    assert.deepEqual([store.getState().sessions.activeSessionId, store.getState().sessions.workflowRowId], ["owner", null]);
});
