// OF-S2-5: the TUI's session list and chat title say when a session (a sub-agent too) has grown Workflows: " ◇" after its
// title, gray, from the list row's hasWorkflowDefinitions flag. Workflows are always on, so the terminal's panes, which
// build their own selector state (components.js), pass no Workflows slice; this checks the same shape they pass.
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

function store() {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [ROOT, SUB] });
    return appReducer(state, { type: "sessions/expand", sessionId: "root-1" });
}

/** The session list's selector state, as components.js SessionList builds it. */
const listState = state => ({ sessions: state.sessions, connection: { mode: "local" }, branding: { title: "PilotSwarm" } });
/** The chat pane's, as components.js ChatPane builds it: the active session alone. */
const chatState = (state, id) => ({ sessions: { activeSessionId: id, byId: { [id]: state.sessions.byId[id] } }, connection: { mode: "local" },
    ui: { workflowTestMode: false }, history: { bySessionId: new Map() }, outbox: { bySessionId: {} } });
const text = runs => (runs || []).map(run => run.text).join("");

test("the TUI list: a sub-agent that owns a definition reads 'Helper ◇', the mark gray, with no opt-in", () => {
    const row = selectVisibleSessionRows(listState(store()), 20).find(candidate => candidate.sessionId === "sub-1");
    assert.ok(row);
    assert.match(text(row.runs), /Helper ◇/);
    assert.equal(row.runs.find(run => run.role === "workflowOwner")?.color, "gray");
});

test("the TUI chat title: 'Helper ◇' from the row flag, with no opt-in", () => {
    assert.match(text(selectChatPaneChrome(chatState(store(), "sub-1")).title), /Helper ◇/);
    assert.doesNotMatch(text(selectChatPaneChrome(chatState(store(), "root-1")).title), /◇/);
});

test("the TUI panes pass no Workflows switch to their selectors: Workflows are always on", () => {
    assert.doesNotMatch(COMPONENTS, /workflowsEnabled/);
});
