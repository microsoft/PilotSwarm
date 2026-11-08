// Workflows can be switched off (Workflow Simplified stage 2.0): the portal's and the terminal UI's shared model.
// - Fail closed: every host starts with Workflows off and takes the server's word at start (its bootstrap's
//   workflows.enabled); with no answer they stay off. Tests opt in.
// - Off: the client keeps no workflow session (no row, nothing to read), the side pane never shows its Workflow tab, the
//   terminal's w does nothing and its help names no Workflow key, and the attention refresh reads nothing.
// - On: as before.
//
// Run: node --test packages/app/ui/core/test/workflows-switch.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, createInitialState, createStore, selectHelpModal, selectSessionRows, shownSidePaneTab,
    workflowsShown,
} from "../src/index.js";
import { readModel } from "./workflow-v2-fixtures.mjs";

const ROWS = [
    { sessionId: "r1", title: "Stock check", status: "idle", createdAt: 1 },
    { sessionId: "wf1", title: "Workflow: check-items", status: "completed", sessionKind: "workflow", parentSessionId: "r1", createdAt: 2 },
    { sessionId: "wf2", title: "Workflow: check-items", status: "running", sessionKind: "workflow", parentSessionId: "r1", createdAt: 3 },
    { sessionId: "a1", title: "Other chat", status: "idle", createdAt: 5 },
];

function harness({ workflowsEnabled }) {
    const reads = [];
    const transport = new Proxy({
        readWorkflow: async (sessionId) => { reads.push(sessionId); return readModel(); },
        getSessionEventsBefore: async () => [],
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
    }, { get: (target, name) => (name in target ? target[name] : typeof name === "string" ? async () => null : undefined) });
    const store = createStore(appReducer, createInitialState({ mode: "local", workflowsEnabled }));
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store, reads };
}

test("fail closed: every host starts with Workflows off and takes the server's word; tests opt in", () => {
    assert.equal(createInitialState({ mode: "local" }).ui.workflowsEnabled, false);
    assert.equal(createInitialState().ui.workflowsEnabled, false);
    assert.equal(createInitialState({ mode: "local", workflowsEnabled: true }).ui.workflowsEnabled, true);
    assert.equal(createInitialState({ mode: "local", workflowsEnabled: false }).ui.workflowsEnabled, false);
    assert.equal(createInitialState({ mode: "local", workflowsEnabled: "true" }).ui.workflowsEnabled, false, "only true is on");
    const store = createStore(appReducer, createInitialState({ mode: "local", workflowsEnabled: false }));
    store.dispatch({ type: "ui/workflowsEnabled", on: true });
    assert.equal(workflowsShown(store.getState()), true);
    store.dispatch({ type: "ui/workflowsEnabled", on: "yes" });
    assert.equal(workflowsShown(store.getState()), false, "anything but true is off");
});

test("off: no workflow session is kept, so no Workflow row; agent sessions are as before", () => {
    const { store } = harness({ workflowsEnabled: false });
    store.dispatch({ type: "sessions/loaded", sessions: ROWS });
    assert.deepEqual(Object.keys(store.getState().sessions.byId).sort(), ["a1", "r1"]);
    assert.deepEqual(selectSessionRows(store.getState()).map(row => row.sessionId).sort(), ["a1", "r1"]);
    // A later update of one does not bring it in either.
    store.dispatch({ type: "sessions/merged", session: { ...ROWS[2], status: "failed" } });
    assert.equal(store.getState().sessions.byId.wf2, undefined);
    // An agent session's update still lands.
    store.dispatch({ type: "sessions/merged", session: { sessionId: "a1", title: "Renamed" } });
    assert.equal(store.getState().sessions.byId.a1.title, "Renamed");

    const on = harness({ workflowsEnabled: true }).store;
    on.dispatch({ type: "sessions/loaded", sessions: ROWS });
    assert.deepEqual(Object.keys(on.getState().sessions.byId).sort(), ["a1", "r1", "wf1", "wf2"]);
});

test("off: the side pane never shows its Workflow tab (a stored choice is kept for when Workflows are on)", () => {
    const { store } = harness({ workflowsEnabled: false });
    store.dispatch({ type: "ui/sidePaneTab", tab: "workflow" });
    assert.equal(store.getState().ui.sidePaneTab, "workflow", "the stored choice is kept");
    assert.equal(shownSidePaneTab(store.getState()), "canvas");
    store.dispatch({ type: "ui/sidePaneTab", tab: "workspace" });
    assert.equal(shownSidePaneTab(store.getState()), "workspace");
    store.dispatch({ type: "ui/workflowsEnabled", on: true });
    store.dispatch({ type: "ui/sidePaneTab", tab: "workflow" });
    assert.equal(shownSidePaneTab(store.getState()), "workflow");
});

test("off: the terminal's w does nothing, and its help names no Workflow key; on, both are there", async () => {
    for (const enabled of [false, true]) {
        const { controller, store } = harness({ workflowsEnabled: enabled });
        store.dispatch({ type: "sessions/loaded", sessions: ROWS });
        store.dispatch({ type: "sessions/selected", sessionId: "r1" });
        await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
        assert.equal(store.getState().ui.modal?.type ?? null, enabled ? "workflowView" : null, `w with Workflows ${enabled ? "on" : "off"}`);
        if (enabled) await controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
        store.dispatch({ type: "ui/modal", modal: { type: "help" } });
        const text = selectHelpModal(store.getState()).rows.map(row => row.map(run => run.text).join("")).join("\n");
        assert.equal(/Workflow pane for this chat/.test(text), enabled, `help, Workflows ${enabled ? "on" : "off"}`);
        assert.equal(/workflow view:/.test(text), enabled);
        assert.match(text, /new session \/ refresh/, "the rest of the help is there either way");
    }
});

test("off: the attention refresh reads no Workflow", async () => {
    const off = harness({ workflowsEnabled: false });
    // As if the rows had been kept (an older state): still nothing is read.
    off.store.dispatch({ type: "ui/workflowsEnabled", on: true });
    off.store.dispatch({ type: "sessions/loaded", sessions: ROWS });
    off.store.dispatch({ type: "sessions/selected", sessionId: "r1" });
    off.store.dispatch({ type: "ui/workflowsEnabled", on: false });
    off.controller.refreshWorkflowAttention();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(off.reads, []);
    const on = harness({ workflowsEnabled: true });
    on.store.dispatch({ type: "sessions/loaded", sessions: ROWS });
    on.store.dispatch({ type: "sessions/selected", sessionId: "r1" });
    on.controller.refreshWorkflowAttention();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(on.reads.includes("wf2"), "on, the running Workflow is read");
});
