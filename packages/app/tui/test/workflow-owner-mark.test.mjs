// OF-S2-5: the TUI's session list and chat title say when a session (a sub-agent too) has grown Workflows: " ◇" after its
// title, gray, from the list row's hasWorkflowDefinitions flag, only while Workflows are shown. The terminal's panes build
// their own selector state (components.js), so this checks the same shape they pass, and that they pass the Workflows
// slice at all: without it every row computed as if Workflows were off.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appReducer, createInitialState, selectChatPaneChrome, selectVisibleSessionRows } from "pilotswarm/ui-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS = fs.readFileSync(path.join(here, "..", "..", "ui", "react", "src", "components.js"), "utf8");

const ROOT = { sessionId: "root-1", title: "Planner", status: "idle", createdAt: 1, updatedAt: 10, parentSessionId: null };
const SUB = { sessionId: "sub-1", title: "Helper", status: "idle", createdAt: 2, updatedAt: 9, parentSessionId: "root-1", hasWorkflowDefinitions: true };

function store(on) {
    let state = createInitialState({ workflowsEnabled: on });
    state = appReducer(state, { type: "sessions/loaded", sessions: [ROOT, SUB] });
    return appReducer(state, { type: "sessions/expand", sessionId: "root-1" });
}

/** The session list's selector state, as components.js SessionList builds it. */
const listState = state => ({ sessions: state.sessions, connection: { mode: "local" }, branding: { title: "PilotSwarm" },
    ui: { workflowsEnabled: state.ui.workflowsEnabled === true } });
/** The chat pane's, as components.js ChatPane builds it: the active session alone. */
const chatState = (state, id) => ({ sessions: { activeSessionId: id, byId: { [id]: state.sessions.byId[id] } }, connection: { mode: "local" },
    ui: { workflowsEnabled: state.ui.workflowsEnabled === true }, history: { bySessionId: new Map() }, outbox: { bySessionId: {} } });
const text = runs => (runs || []).map(run => run.text).join("");

test("the TUI list: a sub-agent that owns a definition reads 'Helper ◇', the mark gray; Workflows off, no mark", () => {
    const on = selectVisibleSessionRows(listState(store(true)), 20).find(row => row.sessionId === "sub-1");
    assert.ok(on);
    assert.match(text(on.runs), /Helper ◇/);
    assert.equal(on.runs.find(run => run.role === "workflowOwner")?.color, "gray");
    const off = selectVisibleSessionRows(listState(store(false)), 20).find(row => row.sessionId === "sub-1");
    assert.doesNotMatch(text(off.runs), /◇/);
});

test("the TUI chat title: 'Helper ◇' from the row flag; Workflows off, no mark", () => {
    assert.match(text(selectChatPaneChrome(chatState(store(true), "sub-1")).title), /Helper ◇/);
    assert.doesNotMatch(text(selectChatPaneChrome(chatState(store(false), "sub-1")).title), /◇/);
    assert.doesNotMatch(text(selectChatPaneChrome(chatState(store(true), "root-1")).title), /◇/);
});

test("the TUI panes pass the Workflows slice to their selectors", () => {
    assert.match(COMPONENTS, /ui: \{ workflowsEnabled: sessionView\.workflowsEnabled \}/, "SessionList");
    assert.match(COMPONENTS, /workflowTestMode: chatView\.workflowTestMode,\s*workflowsEnabled: chatView\.workflowsEnabled,/, "ChatPane");
});
