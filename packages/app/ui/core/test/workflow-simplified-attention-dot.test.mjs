/**
 * Workflow Simplified, owner feedback 2026-11-06T14:35Z (F4): the Workflow button carries the canvas button's dot, not a
 * count. What it watches is what the count counted: the session's Workflows that need the person (waiting for input, or
 * failed). As the canvas's lastViewedRev, the Workflow panel records what it showed in the canvas prefs ("canvas/viewed"
 * with workflowAt; persisted and merged by MAX like lastViewedRev); the dot shows while something newer needs the person.
 *
 * Run: node --test ui/core/test/workflow-simplified-attention-dot.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState, createStore, normalizeStoredCanvasPrefs } from "../src/index.js";
import { workflowAttentionAt, workflowNeedsAttention } from "../src/workflow-owner.js";

const row = (sessionId, status, updatedAt) => ({ sessionId, sessionKind: "workflow", title: "Workflow: watch-v2", status, parentSessionId: "owner",
    createdAt: updatedAt - 1_000, updatedAt });

test("the dot follows what needs the person, newer than what the Workflow panel last showed", () => {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "owner", title: "Release triage agent", updatedAt: 1 },
        row("wf-1", "running", 1_000), row("wf-2", "failed", 2_000)] });
    const state = () => store.getState();
    // A running Workflow needs nothing; a failed one does, from its last change.
    assert.equal(workflowAttentionAt(state().sessions.byId, "owner", state().ui.workflowViews), 2_000);
    assert.equal(workflowNeedsAttention(state(), "owner"), true, "never shown: the dot");
    assert.equal(workflowNeedsAttention(state(), null), false);
    // The panel showed it: the dot goes, and stays gone.
    store.dispatch({ type: "canvas/viewed", sessionId: "owner", workflowAt: 2_000 });
    assert.equal(state().canvas.prefs.owner.lastViewedWorkflowAt, 2_000);
    assert.equal(workflowNeedsAttention(state(), "owner"), false);
    // An older receipt never moves it back (MAX, as lastViewedRev).
    store.dispatch({ type: "canvas/viewed", sessionId: "owner", workflowAt: 1_500 });
    assert.equal(state().canvas.prefs.owner.lastViewedWorkflowAt, 2_000);
    // The running Workflow changes: nothing new needs the person.
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "owner", title: "Release triage agent", updatedAt: 1 },
        row("wf-1", "running", 3_000), row("wf-2", "failed", 2_000)] });
    assert.equal(workflowNeedsAttention(state(), "owner"), false);
    // A new failure after that: the dot comes back.
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "owner", title: "Release triage agent", updatedAt: 1 },
        row("wf-1", "failed", 4_000), row("wf-2", "failed", 2_000)] });
    assert.equal(workflowNeedsAttention(state(), "owner"), true);
    // The canvas's own receipt is unchanged by it.
    store.dispatch({ type: "canvas/viewed", sessionId: "owner", rev: 3 });
    assert.deepEqual([state().canvas.prefs.owner.lastViewedRev, state().canvas.prefs.owner.lastViewedWorkflowAt], [3, 2_000]);
});

test("the receipt lives in the canvas prefs: it is stored, read back and merged by MAX like the canvas's", () => {
    assert.deepEqual(normalizeStoredCanvasPrefs({ owner: { lastViewedRev: 2, lastViewedWorkflowAt: 1234.7 } }),
        { owner: { optedOut: false, lastViewedRev: 2, lastViewedDataRev: 0, lastViewedWorkflowAt: 1234 } });
    assert.deepEqual(normalizeStoredCanvasPrefs({ owner: { lastViewedWorkflowAt: -1 } }), { owner: { optedOut: false, lastViewedRev: 0, lastViewedDataRev: 0 } });
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "owner", title: "x", updatedAt: 1 }] });
    store.dispatch({ type: "canvas/viewed", sessionId: "owner", workflowAt: 5_000 });
    // A profile read snapshotted before this window's receipt never regresses it; a newer one from another device wins.
    store.dispatch({ type: "profileSettings/apply", settings: { canvasPrefs: { owner: { lastViewedWorkflowAt: 4_000 } } } });
    assert.equal(store.getState().canvas.prefs.owner.lastViewedWorkflowAt, 5_000);
    store.dispatch({ type: "profileSettings/apply", settings: { canvasPrefs: { owner: { lastViewedWorkflowAt: 6_000 } } } });
    assert.equal(store.getState().canvas.prefs.owner.lastViewedWorkflowAt, 6_000);
    // A receipt alone keeps its entry (it is not a default-valued one to prune).
    store.dispatch({ type: "profileSettings/apply", settings: { canvasPrefs: {} } });
    assert.equal(store.getState().canvas.prefs.owner.lastViewedWorkflowAt, 6_000);
});

test("the Workflow button draws the canvas's dot and says so in its name; there is no count", async () => {
    const { readFileSync } = await import("node:fs");
    const webApp = readFileSync(new URL("../../react/src/web-app.js", import.meta.url), "utf8");
    assert.match(webApp, /label: workflowTabOpen \? "Hide the Workflow tab" : workflowAttention \? "Workflow — needs attention" : "Workflow",/);
    assert.match(webApp, /active: workflowTabOpen,\n\s*badge: workflowAttention,/, "the canvas's badge (ps-canvas-toggle, ps-canvas-badge)");
    assert.doesNotMatch(webApp, /ps-toolbar-count|needs" : "need"\} you/);
    const tab = readFileSync(new URL("../../react/src/workflow-tab.js", import.meta.url), "utf8");
    assert.match(tab, /controller\.dispatch\(\{ type: "canvas\/viewed", sessionId: context\.ownerId, workflowAt: attentionAt \}\)/);
});
