// Plan 3 (R5, R8, R11, R16): the TUI prints the Terminated row from the same shared row view the portal draws, its count
// in the same [+N] a parent row carries: closed "▸ Terminated · 1 failed [+5]" (all it holds), open "▾ Terminated · 1
// failed [+1]" (what is still hidden: the collapsed member's child). ↓ moves the list highlight onto it and the chat stays;
// + and - (EXPAND_SESSION and COLLAPSE_SESSION, tui/src/app.js) open and close it. The lines are built as components.js
// SessionList builds them: selectVisibleSessionRows, and the active row through applyActiveHighlightRuns.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, applyActiveHighlightRuns, createInitialState, createStore, selectVisibleSessionRows,
} from "pilotswarm/ui-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS = fs.readFileSync(path.join(here, "..", "..", "ui", "react", "src", "components.js"), "utf8");
const APP = fs.readFileSync(path.join(here, "..", "src", "app.js"), "utf8");

const at = n => 1_800_000_000_000 + n * 60_000;
const session = (sessionId, title, n, extra = {}) => ({ sessionId, title, status: "idle", createdAt: at(n), updatedAt: at(n), ...extra });
const child = (sessionId, title, n, status, extra = {}) => session(sessionId, title, n, { parentSessionId: "P", status, ...extra });
const SESSIONS = [
    session("P", "Release coordinator", 0),
    child("ad", "Summary writer", 1, "completed"),
    child("al", "Log reader", 2, "idle"),
    child("af", "Build fixer", 3, "failed"),
    child("wd", "Workflow: nightly-build", 4, "completed", { sessionKind: "workflow" }),
    child("wl", "Workflow: nightly-build", 5, "running", { sessionKind: "workflow" }),
    child("ac", "Flaky test hunter", 6, "cancelled"),
    // The failed member has a finished child of its own: it starts collapsed, so it hides one session.
    child("afk", "Retry helper", 7, "completed", { parentSessionId: "af" }),
    session("Q", "Later session", 9),
];

/** The lines components.js SessionList prints, with the id and highlight of each. */
function lines(state) {
    const selectorState = { sessions: state.sessions, connection: { mode: "local" }, branding: { title: "PilotSwarm" }, ui: {}, agentTitles: state.agentTitles };
    return selectVisibleSessionRows(selectorState, 20).map(row => ({
        id: row.sessionId,
        active: row.active,
        text: (row.active ? applyActiveHighlightRuns(row.runs, { preserveColors: true }) : row.runs).map(run => run.text).join(""),
    }));
}
const lineOf = (state, id) => lines(state).find(line => line.id === id);

function tui() {
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const calls = [];
    const transport = new Proxy({}, {
        get(_target, name) {
            if (typeof name !== "string" || ["then", "listSessionsPage", "listSessionGroups", "getWorkerCount"].includes(name)) return undefined;
            return async (...args) => { calls.push([name, ...args]); return name === "getSessionEvents" || name === "listArtifacts" || name === "listSessions" ? [] : null; };
        },
    });
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: SESSIONS });
    store.dispatch({ type: "sessions/expand", sessionId: "P" });
    store.dispatch({ type: "sessions/selected", sessionId: "al" });
    calls.length = 0;
    return { store, controller, calls };
}

test("the TUI list prints the Terminated row last in P's children, closed: '└ ▸ Terminated · 1 failed [+5]'", () => {
    const { store } = tui();
    assert.deepEqual(lines(store.getState()).map(line => line.id), ["P", "wl", "al", "terminated:P", "Q"]);
    assert.equal(lineOf(store.getState(), "terminated:P").text, "└ ▸ Terminated · 1 failed [+5]");
    // The same notation as its parent's: P hides the same five sessions (after its title and its Workflow mark).
    assert.match(lineOf(store.getState(), "P").text, /Release coordinator .*\[\+5\]/);
});

test("↓ highlights the row and keeps the chat; + opens it ('▾', members one level deeper); - closes it", async () => {
    const { store, controller, calls } = tui();
    await controller.handleCommand(UI_COMMANDS.MOVE_SESSION_DOWN);
    let state = store.getState();
    assert.equal(state.sessions.activeSessionId, "al", "the chat stays on the session");
    assert.deepEqual(lines(state).filter(line => line.active).map(line => line.id), ["terminated:P"]);
    assert.equal(lineOf(state, "terminated:P").text, "└ ▸ Terminated · 1 failed [+5]", "the highlighted line keeps its words");

    await controller.handleCommand(UI_COMMANDS.EXPAND_SESSION);
    state = store.getState();
    // Open: the members show; af is collapsed and hides afk, so the row counts one, as af does.
    assert.equal(lineOf(state, "terminated:P").text, "└ ▾ Terminated · 1 failed [+1]");
    assert.deepEqual(lines(state).map(line => line.id), ["P", "wl", "al", "terminated:P", "wd", "ad", "af", "ac", "Q"]);
    assert.equal(lineOf(state, "wd").text.startsWith("  └ "), true, lineOf(state, "wd").text);
    assert.match(lineOf(state, "af").text, /^ {2}└ .*Build fixer \[\+1\]/);
    // af opened: afk sits in af's own closed Terminated row, so it is still hidden from P's.
    store.dispatch({ type: "sessions/expand", sessionId: "af" });
    state = store.getState();
    assert.equal(lineOf(state, "terminated:P").text, "└ ▾ Terminated · 1 failed [+1]");
    assert.equal(lineOf(state, "terminated:af").text, "    └ ▸ Terminated [+1]");
    store.dispatch({ type: "sessions/terminatedOpen", parentSessionId: "af" });
    state = store.getState();
    assert.equal(lineOf(state, "terminated:P").text, "└ ▾ Terminated · 1 failed", "nothing is hidden: no badge");
    assert.equal(lineOf(state, "terminated:af").text, "    └ ▾ Terminated");
    store.dispatch({ type: "sessions/terminatedClose", parentSessionId: "af" });
    store.dispatch({ type: "sessions/collapse", sessionId: "af" });

    await controller.handleCommand(UI_COMMANDS.COLLAPSE_SESSION);
    state = store.getState();
    assert.equal(lineOf(state, "terminated:P").text, "└ ▸ Terminated · 1 failed [+5]");
    assert.equal(state.sessions.activeSessionId, "al");
    assert.deepEqual(calls.filter(call => call.slice(1).some(arg => typeof arg === "string" && arg.startsWith("terminated:"))), []);
});

test("the TUI renders the shared rows unchanged and maps + and - to the expand and collapse commands", () => {
    assert.match(COMPONENTS, /selectVisibleSessionRows\(selectorState, maxRows\)/);
    assert.match(COMPONENTS, /applyActiveHighlightRuns\(row\.runs, \{ preserveColors: true \}\)/);
    assert.match(APP, /input === "\+" \|\| input === "="\) \{\s*controller\.handleCommand\(UI_COMMANDS\.EXPAND_SESSION\)/);
    assert.match(APP, /input === "-"\) \{\s*controller\.handleCommand\(UI_COMMANDS\.COLLAPSE_SESSION\)/);
});
