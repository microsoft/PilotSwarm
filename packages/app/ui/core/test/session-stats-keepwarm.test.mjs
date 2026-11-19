/**
 * The session stats pane shows the Claude keep-warm counters (Agent Tuner
 * rule step 4): the Tokens card has a "Keep-warm Pings" row once the session
 * has had a ping, a "Keep-warm Cost" row (the pings' nano-AIU in AIU) once the
 * ping replies reported a cost, and neither row before.
 *
 * Run: node --test ui/core/test/session-stats-keepwarm.test.mjs (from packages/app)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { selectInspector } from "../src/selectors.js";

const SID = "session-stats-keepwarm";

const lineText = (line) => (Array.isArray(line) ? line.map((run) => run?.text ?? "").join("")
    : typeof line === "string" ? line
        : line?.text ?? (Array.isArray(line?.runs) ? line.runs.map((run) => run?.text ?? "").join("") : ""));

function statsText(summary) {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "Keep-warm", status: "idle", createdAt: 1, updatedAt: 1 }] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    store.dispatch({ type: "sessionStats/loaded", sessionId: SID, summary: { sessionId: SID, ...summary }, tokensByModel: [] });
    const state = store.getState();
    const inspector = selectInspector({ ...state, ui: { ...state.ui, inspectorTab: "stats" } }, { width: 90 });
    return inspector.lines.map(lineText).join("\n");
}

test("the Tokens card shows the keep-warm ping count and cost of a session that had pings", () => {
    const text = statsText({ heartbeatCount: 2, heartbeatNanoAiu: 750000 });
    assert.match(text, /Keep-warm Pings +2\b/);
    assert.match(text, /Keep-warm Cost +0\.0008 AIU/);
});

test("the Tokens card shows the ping count but no cost row when the ping replies reported no cost", () => {
    const text = statsText({ heartbeatCount: 2, heartbeatNanoAiu: 0 });
    assert.match(text, /Keep-warm Pings +2\b/);
    assert.ok(!text.includes("Keep-warm Cost"), "no cost row");
});

test("the Tokens card shows no keep-warm row for a session with no ping", () => {
    const text = statsText({ heartbeatCount: 0, heartbeatNanoAiu: 0 });
    assert.ok(text.includes("Hit Ratio"), "the Tokens card is there");
    assert.ok(!text.includes("Keep-warm"), "no keep-warm row");
});
