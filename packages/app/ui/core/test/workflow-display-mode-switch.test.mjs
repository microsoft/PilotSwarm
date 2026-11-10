/**
 * OF-S2-3b (owner, 2026-11-07): choosing another definition or another Workflow in the Workflow tab, in full screen or in
 * zen, left that mode: a Workflow chosen opened the tab anew, and that put full screen off. The mode survives a choice of
 * definition, Workflow or view; only the person's own exit control or Escape leaves it (web-app's own handlers).
 *
 * Run: node --test ui/core/test/workflow-display-mode-switch.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState, createStore } from "../src/index.js";

const rows = [
    { sessionId: "owner", title: "Release triage agent", updatedAt: 2 },
    { sessionId: "wf-1", sessionKind: "workflow", title: "Workflow: watch", status: "running", parentSessionId: "owner", createdAt: 1, updatedAt: 2 },
    { sessionId: "wf-2", sessionKind: "workflow", title: "Workflow: watch", status: "completed", parentSessionId: "owner", createdAt: 3, updatedAt: 4 },
    { sessionId: "wf-3", sessionKind: "workflow", title: "Workflow: digest", status: "running", parentSessionId: "owner", createdAt: 5, updatedAt: 6 },
];

function shownIn(mode) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "ui/sessionViewDevice", device: "desktop" });
    store.dispatch({ type: "profileSettings/apply", settings: { sessionViews: {} } });
    store.dispatch({ type: "sessions/loaded", sessions: rows });
    store.dispatch({ type: "sessions/selected", sessionId: "wf-1" });
    store.dispatch(mode === "full" ? { type: "ui/canvasMaximized", on: true } : { type: "ui/canvasZen", on: true });
    return store;
}
const modeOf = store => ({ full: store.getState().ui.canvasMaximized === true, zen: store.getState().ui.canvasZen === true,
    tab: store.getState().ui.sidePaneTab, open: store.getState().ui.canvasOpen });

for (const mode of ["full", "zen"]) {
    test(`${mode}: another Workflow, another definition and the other view keep the mode`, () => {
        const store = shownIn(mode);
        const want = { full: mode === "full", zen: mode === "zen", tab: "workflow", open: true };
        assert.deepEqual(modeOf(store), want);
        // Another Workflow of the same definition (the Workflow picker, the list): its row is selected.
        store.dispatch({ type: "ui/workflowTab", ownerId: "owner", patch: { view: "workflows", workflowId: "wf-2" } });
        store.dispatch({ type: "sessions/selected", sessionId: "wf-2" });
        assert.equal(store.getState().sessions.workflowRowId, "wf-2");
        assert.deepEqual(modeOf(store), want, "a Workflow chosen");
        // Another definition (the definition picker): only the tab moves (workflow-tab.js, workflowPickerChoicePatch); no
        // session is selected.
        store.dispatch({ type: "ui/workflowTab", ownerId: "owner",
            patch: { versionChild: null, definitionChild: null, definition: "digest", workflowId: null } });
        assert.equal(store.getState().ui.workflowTabs?.owner?.definition, "digest");
        assert.equal(store.getState().sessions.workflowRowId, "wf-2", "the definition picker selects no session");
        assert.deepEqual(modeOf(store), want, "a definition chosen");
        // The other view, then a Workflow of that definition.
        store.dispatch({ type: "ui/workflowTab", ownerId: "owner", patch: { view: "definition" } });
        assert.deepEqual(modeOf(store), want, "the Definition view");
        store.dispatch({ type: "sessions/selected", sessionId: "wf-3" });
        assert.deepEqual(modeOf(store), want, "a Workflow of the other definition");
        // The person's own exit leaves it.
        store.dispatch(mode === "full" ? { type: "ui/canvasMaximized", on: false } : { type: "ui/canvasZen", on: false });
        assert.deepEqual(modeOf(store), { ...want, full: false, zen: false });
    });
}
