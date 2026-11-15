/**
 * Workflow Simplified (S4): with a Workflow row selected, its session's row is the chat on screen ("chatOwner"), and a
 * click on it selects the session itself. Owner feedback 2026-11-06: "can't select the parent session once the workflow
 * session is selected" — the click went to the list's re-arm path (the session was already the active one) and the
 * Workflow row stayed selected.
 *
 * Run: node --test test/workflow-simplified-parent-select.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { appReducer, createInitialState, selectSessionRows } from "../src/index.js";
import { selectWorkflowTabContext, WORKFLOW_SIDE_TAB } from "../src/workflow-owner.js";

const OWNER = "owner-1";
const SESSIONS = [
    { sessionId: OWNER, title: "Jokes", status: "idle", createdAt: 1, updatedAt: 1 },
    { sessionId: "wf-1", sessionKind: "workflow", title: "Workflow: dad-joke", status: "running", parentSessionId: OWNER, createdAt: 2, updatedAt: 2 },
];
const rowOf = (state, id) => selectSessionRows(state).find(row => row.sessionId === id);

test("selecting the session after its Workflow row selects the session alone; its Workflow tab and right block stay", () => {
    let state = appReducer(createInitialState({ mode: "api" }), { type: "sessions/loaded", sessions: SESSIONS });
    state = appReducer(state, { type: "sessions/expand", sessionId: OWNER });
    state = appReducer(state, { type: "sessions/selected", sessionId: "wf-1" });
    assert.equal(state.sessions.activeSessionId, OWNER);
    assert.equal(state.sessions.workflowRowId, "wf-1");
    // The Workflow row is the selected one; the session's row is marked as the chat on screen (what the click reads).
    assert.equal(rowOf(state, "wf-1").active, true);
    assert.equal(rowOf(state, OWNER).active, false);
    assert.equal(rowOf(state, OWNER).chatOwner, true);
    const sidePaneTab = state.ui.sidePaneTab;
    const canvasOpen = state.ui.canvasOpen;
    assert.equal(sidePaneTab, WORKFLOW_SIDE_TAB);

    // The click on the session's row selects it (loadSession dispatches sessions/selected for it).
    state = appReducer(state, { type: "sessions/selected", sessionId: OWNER });
    assert.equal(state.sessions.activeSessionId, OWNER);
    assert.equal(state.sessions.workflowRowId, null);
    assert.equal(rowOf(state, OWNER).active, true);
    assert.equal(rowOf(state, OWNER).chatOwner, false);
    assert.equal(rowOf(state, "wf-1").active, false);
    // The right block stays as it was; the session's Workflow tab still shows the Workflow it showed last (S5).
    assert.equal(state.ui.sidePaneTab, sidePaneTab);
    assert.equal(state.ui.canvasOpen, canvasOpen);
    assert.equal(selectWorkflowTabContext(state).workflowId, "wf-1");
});

test("the session list's click selects the chat-owner row itself instead of re-arming the list", () => {
    const webApp = fs.readFileSync(new URL("../../react/src/web-app.js", import.meta.url), "utf8");
    const at = webApp.indexOf("const handleRowClick = React.useCallback(");
    assert.notEqual(at, -1, "handleRowClick not found — renamed?");
    const body = webApp.slice(at, webApp.indexOf("}, []);", at));
    assert.match(body, /if \(row\.chatOwner\) \{[\s\S]*?ctl\.loadSession\(row\.sessionId\)/);
    assert.ok(body.indexOf("if (row.chatOwner)") < body.indexOf("sessions/listReselect"), "checked before the re-arm path");
});
