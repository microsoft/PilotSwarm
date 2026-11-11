// Workflows are always on (owner 2026-11-08T08:03Z): the portal's and the terminal UI's shared model shows them with no
// opt-in. There is no switch in the state, a stale `ui/workflowsEnabled` action changes nothing, Workflow rows are kept,
// the side pane shows its Workflow tab, the terminal's w opens the Workflow view and its help names the Workflow keys,
// and the attention refresh reads a running Workflow.
//
// Run: node --test packages/app/ui/core/test/workflows-always-on.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as core from "../src/index.js";
import { readModel } from "./workflow-fixtures.mjs";

const {
    PilotSwarmUiController, UI_COMMANDS, appReducer, createInitialState, createStore, selectHelpModal, selectSessionRows, shownSidePaneTab,
} = core;

const ROWS = [
    { sessionId: "r1", title: "Stock check", status: "idle", createdAt: 1 },
    { sessionId: "wf1", title: "Workflow: check-items", status: "completed", sessionKind: "workflow", parentSessionId: "r1", createdAt: 2 },
    { sessionId: "wf2", title: "Workflow: check-items", status: "running", sessionKind: "workflow", parentSessionId: "r1", createdAt: 3 },
    { sessionId: "a1", title: "Other session", status: "idle", createdAt: 5 },
];

/** A host as it starts today: no Workflows option at all. */
function harness() {
    const reads = [];
    const transport = new Proxy({
        readWorkflow: async (sessionId) => { reads.push(sessionId); return readModel(); },
        getSessionEventsBefore: async () => [],
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
    }, { get: (target, name) => (name in target ? target[name] : typeof name === "string" ? async () => null : undefined) });
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store, reads };
}

test("no switch: the state has no Workflows flag, the module no longer exports one, and a stale ui/workflowsEnabled action changes nothing", () => {
    assert.equal("workflowsEnabled" in createInitialState().ui, false);
    assert.equal("workflowsEnabled" in createInitialState({ mode: "local", workflowsEnabled: false }).ui, false, "an old host's option is ignored");
    assert.equal("workflowsShown" in core, false);
    const { store } = harness();
    store.dispatch({ type: "sessions/loaded", sessions: ROWS });
    const before = store.getState();
    store.dispatch({ type: "ui/workflowsEnabled", on: false });
    assert.equal(store.getState(), before, "the old action is unknown, so the state is the same object");
});

// Review AOU-F1 (always-on review, low): no comment in the shared model still says Workflows can be off.
test("no source comment says Workflows are off", () => {
    for (const name of ["selectors.js", "state.js", "reducer.js", "controller.js", "workflow-owner.js", "workflow-lifecycle.js"]) {
        const text = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
        assert.doesNotMatch(text, /Workflows are off|while Workflows are off/i, name);
    }
});

test("Workflow rows are kept with no opt-in; a later update of one lands", () => {
    const { store } = harness();
    store.dispatch({ type: "sessions/loaded", sessions: ROWS });
    assert.deepEqual(Object.keys(store.getState().sessions.byId).sort(), ["a1", "r1", "wf1", "wf2"]);
    assert.ok(selectSessionRows(store.getState()).some(row => row.sessionId === "r1"));
    store.dispatch({ type: "sessions/merged", session: { ...ROWS[2], status: "failed" } });
    assert.equal(store.getState().sessions.byId.wf2.status, "failed");
});

test("the side pane shows its Workflow tab with no opt-in", () => {
    const { store } = harness();
    store.dispatch({ type: "ui/sidePaneTab", tab: "workflow" });
    assert.equal(shownSidePaneTab(store.getState()), "workflow");
    store.dispatch({ type: "ui/sidePaneTab", tab: "workspace" });
    assert.equal(shownSidePaneTab(store.getState()), "workspace");
});

test("the terminal's w opens the Workflow view, and its help names the Workflow keys, with no opt-in", async () => {
    const { controller, store } = harness();
    store.dispatch({ type: "sessions/loaded", sessions: ROWS });
    store.dispatch({ type: "sessions/selected", sessionId: "r1" });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    assert.equal(store.getState().ui.modal?.type ?? null, "workflowView");
    await controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    store.dispatch({ type: "ui/modal", modal: { type: "help" } });
    const text = selectHelpModal(store.getState()).rows.map(row => row.map(run => run.text).join("")).join("\n");
    assert.match(text, /Workflow pane for this session/);
    assert.match(text, /workflow view:/);
    assert.match(text, /new session \/ refresh/);
});

test("the attention refresh reads the running Workflow with no opt-in", async () => {
    const { controller, store, reads } = harness();
    store.dispatch({ type: "sessions/loaded", sessions: ROWS });
    store.dispatch({ type: "sessions/selected", sessionId: "r1" });
    controller.refreshWorkflowAttention();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(reads.includes("wf2"), "the running Workflow is read");
});
