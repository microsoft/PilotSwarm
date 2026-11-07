/**
 * Workflow Simplified (L1, S4): the right block's Workflow tab stays until the person chooses otherwise. Owner feedback
 * 2026-11-06: "the canvas pops back up time from time". The profile saved the Workflow tab as "canvas" (only the
 * Workspace tab was kept), so every profile read that changed anything else (each 5 s poll after a save) turned the
 * right block back to the canvas. Now:
 * - the profile keeps the side tab as it is: canvas, Workspace or Workflow;
 * - while a Workflow row is selected and its Workflow tab shows, a profile read never turns the block to the canvas.
 *
 * Run: node --test test/workflow-simplified-side-tab.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { appReducer, createInitialState } from "../src/index.js";
import { WORKFLOW_SIDE_TAB } from "../src/workflow-owner.js";

const OWNER = "owner-1";
const SESSIONS = [
    { sessionId: OWNER, title: "Jokes", status: "idle", createdAt: 1, updatedAt: 1 },
    { sessionId: "wf-1", sessionKind: "workflow", title: "Workflow: dad-joke", status: "running", parentSessionId: OWNER, createdAt: 2, updatedAt: 2 },
];
const apply = (state, settings) => appReducer(state, { type: "profileSettings/apply", settings });

test("a profile read keeps the Workflow tab while a Workflow row is selected, even when the profile says canvas", () => {
    let state = appReducer(createInitialState({ mode: "api" }), { type: "sessions/loaded", sessions: SESSIONS });
    state = appReducer(state, { type: "sessions/selected", sessionId: "wf-1" });
    assert.equal(state.sessions.activeSessionId, OWNER);
    assert.equal(state.sessions.workflowRowId, "wf-1");
    assert.equal(state.ui.sidePaneTab, WORKFLOW_SIDE_TAB);
    // Another device's (or an older) profile that says canvas, with another change that makes the poll apply it.
    state = apply(state, { themeId: "terminal-green", desktopPanes: { canvasOpen: true, diagnosticsOpen: false, zen: false, sideTab: "canvas" } });
    assert.equal(state.ui.themeId, "terminal-green", "the read was applied");
    assert.equal(state.ui.sidePaneTab, WORKFLOW_SIDE_TAB, "the right block stays on the Workflow tab");
});

test("before this tab chose a side tab (hydration), the profile's side tab applies as stored, the Workflow tab included", () => {
    let state = appReducer(createInitialState({ mode: "api" }), { type: "sessions/loaded", sessions: SESSIONS });
    state = appReducer(state, { type: "sessions/selected", sessionId: OWNER });
    assert.equal(state.sessions.workflowRowId, null);
    state = apply(state, { desktopPanes: { canvasOpen: true, diagnosticsOpen: false, zen: false, sideTab: WORKFLOW_SIDE_TAB } });
    assert.equal(state.ui.sidePaneTab, WORKFLOW_SIDE_TAB);
    state = apply(state, { desktopPanes: { canvasOpen: true, diagnosticsOpen: false, zen: false, sideTab: "canvas" } });
    assert.equal(state.ui.sidePaneTab, "canvas");
    assert.equal(createInitialState({ desktopPanes: { canvasOpen: true, sideTab: WORKFLOW_SIDE_TAB } }).ui.sidePaneTab, WORKFLOW_SIDE_TAB);
});

// Review UI-7: the protection does not depend on the selected row. Once this tab chose the Workflow tab (the person's
// toggle, or a Workflow opened), a profile read keeps it: after the parent row is selected, and while a definition is shown
// with no Workflow row at all.
test("once this tab chose the Workflow tab, a profile read keeps it whatever row is selected", () => {
    let state = appReducer(createInitialState({ mode: "api" }), { type: "sessions/loaded", sessions: SESSIONS });
    state = appReducer(state, { type: "sessions/selected", sessionId: "wf-1" });
    state = appReducer(state, { type: "sessions/selected", sessionId: OWNER });
    assert.equal(state.sessions.workflowRowId, null, "the parent row is selected");
    assert.equal(state.ui.sidePaneTab, WORKFLOW_SIDE_TAB);
    state = apply(state, { themeId: "terminal-green", desktopPanes: { canvasOpen: true, diagnosticsOpen: false, zen: false, sideTab: "canvas" } });
    assert.equal(state.ui.themeId, "terminal-green", "the read was applied");
    assert.equal(state.ui.sidePaneTab, WORKFLOW_SIDE_TAB, "the Workflow tab stays");

    // A definition opened from the toolbar (no Workflow row): the person's toggle is kept too.
    let shown = appReducer(createInitialState({ mode: "api" }), { type: "sessions/loaded", sessions: SESSIONS });
    shown = appReducer(shown, { type: "sessions/selected", sessionId: OWNER });
    shown = appReducer(shown, { type: "ui/sidePaneTab", tab: WORKFLOW_SIDE_TAB });
    shown = apply(shown, { desktopPanes: { canvasOpen: true, diagnosticsOpen: false, zen: false, sideTab: "canvas" } });
    assert.equal(shown.ui.sidePaneTab, WORKFLOW_SIDE_TAB);
    // The canvas and Workspace tabs follow another device's saved choice as before (desktop-panes.test.mjs).
    shown = appReducer(shown, { type: "ui/sidePaneTab", tab: "canvas" });
    shown = apply(shown, { desktopPanes: { canvasOpen: true, diagnosticsOpen: false, zen: false, sideTab: "workspace" } });
    assert.equal(shown.ui.sidePaneTab, "workspace");
});

test("the portal saves and reads the side tab as it is: no profile path maps the Workflow tab to the canvas", () => {
    const webApp = fs.readFileSync(new URL("../../react/src/web-app.js", import.meta.url), "utf8");
    assert.doesNotMatch(webApp, /=== "workspace" \? "workspace" : "canvas"/, "the old mapping is gone");
    const within = (name, end = "\n}\n") => {
        const at = webApp.indexOf(name);
        assert.notEqual(at, -1, `${name} not found — renamed?`);
        return webApp.slice(at, webApp.indexOf(end, at));
    };
    assert.match(within("function normalizeProfileSettings("), /sideTab: normalizeSidePaneTab\(candidate\.desktopPanes\.sideTab\)/);
    assert.match(within("function profileSettingsFromViewState("), /sideTab: normalizeSidePaneTab\(state\.sidePaneTab\)/);
    assert.match(within("function buildDefaultProfileSettingsFromState("), /sideTab: normalizeSidePaneTab\(state\?\.ui\?\.sidePaneTab\)/);
    assert.match(webApp, /sidePaneTab: normalizeSidePaneTab\(rootState\.ui\.sidePaneTab\),/);
});
