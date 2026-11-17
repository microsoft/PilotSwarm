/**
 * Plan 3, Task 2: which Terminated rows are open, and the guards that keep a Terminated row from acting as a session.
 * R6 the open set (actions, every list rebuild, profile hydration, pruning), R7 the selected session is never hidden
 * inside a closed Terminated row, R4 a virtual row id never reaches a session API or session state, R11 the keyboard
 * on a Terminated row, R12 status changes.
 *
 * Run: node --test test/session-terminated-open-state.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import * as core from "../src/index.js";

const {
    PilotSwarmUiController, SESSION_NAV_SETTLE_MS, UI_COMMANDS, appReducer, createInitialState, createStore,
    selectFileSessionIdsForScope, selectFilesView, selectNodeMapView, selectSessionRows, selectVisibleSessionRows,
} = core;

const at = n => 1_800_000_000_000 + n * 60_000;
const session = (sessionId, extra = {}) => ({ sessionId, title: `Session ${sessionId}`, status: "idle", createdAt: at(0), updatedAt: at(0), ...extra });
const agent = (sessionId, parentSessionId, n, status, extra = {}) => session(sessionId, {
    parentSessionId, status, createdAt: at(n), updatedAt: at(n), ...extra,
});
const workflow = (sessionId, parentSessionId, n, status, extra = {}) => agent(sessionId, parentSessionId, n, status, {
    sessionKind: "workflow", title: "Workflow: check-items", ...extra,
});
const folder = (groupId, n) => ({ sessionId: `group:${groupId}`, groupId, isGroup: true, title: "Incidents", status: "group", createdAt: at(n), updatedAt: at(n) });

const ids = flat => flat.map(entry => entry.sessionId);
const rowIds = state => selectSessionRows(state).map(row => row.sessionId);
const openIds = state => [...state.sessions.openTerminatedIds].sort();
const entryOf = (state, sessionId) => state.sessions.flat.find(entry => entry.sessionId === sessionId);
const highlighted = state => selectSessionRows(state).filter(row => row.active).map(row => row.sessionId);

// One parent: live and finished agents and Workflows interleaved.
const DEPTH_ONE = [
    session("P"),
    agent("a1", "P", 1, "running"),
    workflow("w1", "P", 2, "completed"),
    agent("a2", "P", 3, "completed"),
    workflow("w2", "P", 4, "running"),
    agent("a3", "P", 5, "failed"),
    agent("a4", "P", 7, "idle"),
];
const P_CLOSED = ["P", "w2", "a1", "a4", "terminated:P"];
const P_OPEN = ["P", "w2", "a1", "a4", "terminated:P", "w1", "a2", "a3"];

// A finished Workflow (wT) under P with its own live and finished children.
const DEPTH_TWO = [
    session("P"),
    agent("a1", "P", 1, "running"),
    workflow("wT", "P", 2, "completed"),
    agent("x1", "wT", 3, "running"),
    agent("x3", "wT", 5, "failed"),
];

function loaded(sessions, initial = {}) {
    let state = appReducer(createInitialState({ mode: "local", ...initial }), { type: "ui/sessionViewDevice", device: "desktop" });
    state = appReducer(state, { type: "sessions/loaded", sessions });
    return state;
}

function expandAll(state) {
    let next = state;
    for (const id of [...next.sessions.collapsedIds]) next = appReducer(next, { type: "sessions/expand", sessionId: id });
    return next;
}

const openRow = (state, parentSessionId) => appReducer(state, { type: "sessions/terminatedOpen", parentSessionId });

test("sessions/terminatedOpen and sessions/terminatedClose open and close one Terminated row (R6)", () => {
    let state = expandAll(loaded(DEPTH_ONE));
    assert.ok(state.sessions.openTerminatedIds instanceof Set);
    assert.deepEqual(openIds(state), [], "every Terminated row starts closed");
    assert.deepEqual(ids(state.sessions.flat), P_CLOSED);
    assert.equal(entryOf(state, "terminated:P").collapsed, true);

    state = openRow(state, "P");
    assert.deepEqual(openIds(state), ["P"]);
    assert.deepEqual(ids(state.sessions.flat), P_OPEN);
    assert.equal(entryOf(state, "terminated:P").collapsed, false);
    assert.deepEqual(rowIds(state), P_OPEN);

    assert.equal(openRow(state, "P"), state, "opening an open row changes nothing");
    for (const parentSessionId of ["", "   ", null, undefined, "group:g", "terminated:P"]) {
        assert.equal(openRow(state, parentSessionId), state, `a parent id must be a real session: ${JSON.stringify(parentSessionId)}`);
    }

    state = appReducer(state, { type: "sessions/terminatedClose", parentSessionId: "P" });
    assert.deepEqual(openIds(state), []);
    assert.deepEqual(ids(state.sessions.flat), P_CLOSED);
    assert.equal(appReducer(state, { type: "sessions/terminatedClose", parentSessionId: "P" }), state, "closing a closed row changes nothing");
});

test("the open set reaches every rebuild of the visible list (R6)", () => {
    const base = openRow(expandAll(loaded([...DEPTH_ONE, session("Q", { createdAt: at(20), updatedAt: at(20) })])), "P");
    const stillOpen = (state, label) => {
        assert.equal(entryOf(state, "terminated:P")?.collapsed, false, `${label}: the row stays open`);
        assert.ok(ids(state.sessions.flat).includes("a3"), `${label}: its members stay listed`);
    };
    stillOpen(base, "open");
    stillOpen(appReducer(base, { type: "sessions/merged", session: { sessionId: "a1", title: "Renamed" } }), "sessions/merged");
    stillOpen(appReducer(base, { type: "sessions/loaded", sessions: [...DEPTH_ONE, session("Q"), session("R")] }), "sessions/loaded");
    stillOpen(appReducer(base, { type: "sessions/groupsLoaded", groups: [] }), "sessions/groupsLoaded");
    stillOpen(appReducer(base, { type: "sessions/collapse", sessionId: "Q" }), "sessions/collapse");
    stillOpen(appReducer(appReducer(base, { type: "sessions/collapse", sessionId: "P" }), { type: "sessions/expand", sessionId: "P" }), "sessions/expand");
    stillOpen(appReducer(base, { type: "sessions/pinToggle", sessionId: "Q" }), "sessions/pinToggle");
    stillOpen(appReducer(base, { type: "sessions/reorder", sessionId: "Q", beforeSessionId: "P" }), "sessions/reorder");
    stillOpen(appReducer(base, { type: "profileSettings/apply", settings: { pinnedSessionIds: ["Q"] } }), "profileSettings/apply");
    stillOpen(appReducer(base, { type: "sessions/sortMode", mode: "updated" }), "sort by updated");
    stillOpen(appReducer(appReducer(base, { type: "sessions/sortMode", mode: "used" }), { type: "sessions/refreshSort" }), "sort by used");
});

test("a parent that appears later, or gets its first finished child later, starts closed (R6, R12)", () => {
    let state = openRow(expandAll(loaded([session("P"), agent("a1", "P", 1, "running"), agent("a2", "P", 2, "completed")])), "P");
    state = appReducer(state, { type: "sessions/loaded", sessions: [
        session("P"), agent("a1", "P", 1, "running"), agent("a2", "P", 2, "completed"),
        session("Q", { createdAt: at(10), updatedAt: at(10) }), agent("q1", "Q", 11, "running"), agent("q2", "Q", 12, "cancelled"),
    ] });
    state = appReducer(state, { type: "sessions/expand", sessionId: "Q" });
    assert.deepEqual(openIds(state), ["P"]);
    assert.equal(entryOf(state, "terminated:Q").collapsed, true, "Q appeared later: its Terminated row is closed");
    assert.ok(!ids(state.sessions.flat).includes("q2"));

    state = appReducer(state, { type: "sessions/loaded", sessions: [
        session("P"), agent("a1", "P", 1, "running"), agent("a2", "P", 2, "completed"),
        session("Q", { createdAt: at(10), updatedAt: at(10) }), agent("q1", "Q", 11, "running"), agent("q2", "Q", 12, "cancelled"),
        session("S", { createdAt: at(20), updatedAt: at(20) }), agent("s1", "S", 21, "running"),
    ] });
    state = appReducer(state, { type: "sessions/expand", sessionId: "S" });
    assert.equal(entryOf(state, "terminated:S"), undefined, "no finished child yet: no Terminated row");
    state = appReducer(state, { type: "sessions/merged", session: { sessionId: "s1", status: "completed" } });
    assert.equal(entryOf(state, "terminated:S").collapsed, true, "S's first finished child goes under a closed row");
    assert.ok(!ids(state.sessions.flat).includes("s1"), "a finished child moves into Terminated on the next rebuild (R12)");
    state = appReducer(state, { type: "sessions/merged", session: { sessionId: "s1", status: "running" } });
    assert.equal(entryOf(state, "terminated:S"), undefined, "running again, it moves back out (R12)");
    assert.ok(ids(state.sessions.flat).includes("s1"));
    assert.deepEqual(openIds(state), ["P"]);
});

test("openTerminatedSessionIds hydrates from the initial state and from the profile; virtual and blank ids are dropped (R6)", () => {
    const initial = createInitialState({ openTerminatedSessionIds: ["P", " ", "group:g", "terminated:P", "Q", "P", 7, null] });
    assert.deepEqual([...initial.sessions.openTerminatedIds].sort(), ["7", "P", "Q"]);
    assert.deepEqual([...createInitialState().sessions.openTerminatedIds], []);
    assert.deepEqual([...createInitialState({ openTerminatedSessionIds: "P" }).sessions.openTerminatedIds], []);

    // Before any session listing, the profile's ids are kept as they are: their parents may not have arrived.
    let state = appReducer(createInitialState(), { type: "profileSettings/apply", settings: { openTerminatedSessionIds: ["P", "Q", "group:g"] } });
    assert.deepEqual(openIds(state), ["P", "Q"]);
    // The first listing holds P but not Q: Q is pruned, and P's row is open.
    state = expandAll(appReducer(state, { type: "sessions/loaded", sessions: DEPTH_ONE }));
    assert.deepEqual(openIds(state), ["P"]);
    assert.deepEqual(ids(state.sessions.flat), P_OPEN);

    // A later profile read replaces the set, pruned against the listing; a read without the key leaves it alone.
    state = appReducer(state, { type: "profileSettings/apply", settings: { openTerminatedSessionIds: ["Q"] } });
    assert.deepEqual(openIds(state), []);
    assert.deepEqual(ids(state.sessions.flat), P_CLOSED);
    state = appReducer(state, { type: "profileSettings/apply", settings: { openTerminatedSessionIds: ["P", "Q"] } });
    assert.deepEqual(openIds(state), ["P"]);
    assert.deepEqual(ids(state.sessions.flat), P_OPEN);
    state = appReducer(state, { type: "profileSettings/apply", settings: { themeId: "dark" } });
    assert.deepEqual(openIds(state), ["P"]);
    assert.deepEqual(ids(state.sessions.flat), P_OPEN);
});

test("a stored Terminated row id never becomes the active session (R4)", () => {
    assert.equal(createInitialState({ activeSessionId: "terminated:P" }).sessions.activeSessionId, null);
    assert.equal(createInitialState({ activeSessionId: "group:g" }).sessions.activeSessionId, "group:g", "a folder still can");
    let state = expandAll(loaded(DEPTH_ONE));
    assert.equal(state.sessions.activeSessionId, "P");
    state = appReducer(state, { type: "profileSettings/apply", settings: { activeSessionId: "terminated:P" } });
    assert.equal(state.sessions.activeSessionId, "P");
    assert.deepEqual(highlighted(state), ["P"]);
});

test("an open id is pruned when its parent is gone: deleted, or missing from a later listing (R6)", () => {
    let state = loaded([...DEPTH_ONE, session("Q", { createdAt: at(20), updatedAt: at(20) }), agent("q1", "Q", 21, "failed")]);
    state = openRow(openRow(state, "P"), "Q");
    assert.deepEqual(openIds(state), ["P", "Q"]);
    state = appReducer(state, { type: "sessions/gone", sessionId: "Q" });
    assert.deepEqual(openIds(state), ["P"], "a deleted parent is dropped");
    state = openRow(state, "Q");
    state = appReducer(state, { type: "sessions/loaded", sessions: DEPTH_ONE });
    assert.deepEqual(openIds(state), ["P"], "a parent the full listing no longer holds is dropped");
    state = appReducer(state, { type: "sessions/loaded", sessions: [...DEPTH_ONE, session("Q", { createdAt: at(20), updatedAt: at(20) }), agent("q1", "Q", 21, "failed")] });
    state = appReducer(state, { type: "sessions/expand", sessionId: "Q" });
    assert.equal(entryOf(state, "terminated:Q").collapsed, true, "when it comes back, its row starts closed");
});

test("R7 on selection: a session chosen inside closed Terminated rows and collapsed parents is shown", () => {
    let state = loaded(DEPTH_TWO);
    assert.ok(state.sessions.collapsedIds.has("P"));
    state = appReducer(state, { type: "sessions/selected", sessionId: "x3" });
    assert.equal(state.sessions.activeSessionId, "x3");
    assert.deepEqual(openIds(state), ["P", "wT"], "both Terminated rows on its path open");
    assert.ok(!state.sessions.collapsedIds.has("P") && !state.sessions.collapsedIds.has("wT"), "today's ancestor expansion stays");
    assert.deepEqual(rowIds(state), ["P", "a1", "terminated:P", "wT", "x1", "terminated:wT", "x3"]);
    assert.deepEqual(highlighted(state), ["x3"]);

    // A live session inside a finished one: only the row that holds its finished ancestor opens.
    state = loaded(DEPTH_TWO);
    state = appReducer(state, { type: "sessions/selected", sessionId: "x1" });
    assert.deepEqual(openIds(state), ["P"]);
    assert.ok(rowIds(state).includes("x1"));
});

test("R7 on selection of a Workflow row: the row the list highlights is revealed", () => {
    let state = loaded([session("O"), agent("o1", "O", 1, "running"), workflow("wDone", "O", 2, "completed", { sessionKind: "workflow" })]);
    state = appReducer(state, { type: "sessions/selected", sessionId: "wDone" });
    assert.equal(state.sessions.activeSessionId, "O", "the Workflow's session is the active session");
    assert.equal(state.sessions.workflowRowId, "wDone");
    assert.deepEqual(openIds(state), ["O"]);
    assert.deepEqual(highlighted(state), ["wDone"]);
});

test("R7 on a deep link: the linked finished session opens its Terminated rows", () => {
    let state = appReducer(createInitialState({ mode: "local" }), { type: "sessions/navigationIntent", sessionId: "x3" });
    state = appReducer(state, { type: "sessions/loaded", sessions: DEPTH_TWO });
    assert.equal(state.sessions.activeSessionId, "x3");
    assert.deepEqual(openIds(state), ["P", "wT"]);
    assert.ok(rowIds(state).includes("x3"));
    assert.deepEqual(highlighted(state), ["x3"]);
});

test("R7 when the active session, or an ancestor on its path, becomes terminal: it stays on screen", () => {
    let state = expandAll(loaded(DEPTH_ONE));
    state = appReducer(state, { type: "sessions/selected", sessionId: "a1" });
    assert.deepEqual(openIds(state), []);
    state = appReducer(state, { type: "sessions/merged", session: { sessionId: "a1", status: "completed" } });
    assert.equal(state.sessions.activeSessionId, "a1");
    assert.deepEqual(openIds(state), ["P"], "its new Terminated row opens");
    assert.deepEqual(rowIds(state), ["P", "w2", "a4", "terminated:P", "w1", "a1", "a2", "a3"]);
    assert.deepEqual(highlighted(state), ["a1"]);

    // An ancestor: x1 stays live, its parent finishes and moves into P's Terminated row.
    state = expandAll(loaded([session("P"), agent("a1", "P", 1, "running"), workflow("wL", "P", 2, "running"), agent("x1", "wL", 3, "running")]));
    state = appReducer(state, { type: "sessions/selected", sessionId: "x1" });
    state = appReducer(state, { type: "sessions/loaded", sessions: [
        session("P"), agent("a1", "P", 1, "running"), workflow("wL", "P", 2, "completed"), agent("x1", "wL", 3, "running"),
    ] });
    assert.equal(state.sessions.activeSessionId, "x1");
    assert.deepEqual(openIds(state), ["P"]);
    assert.deepEqual(rowIds(state), ["P", "a1", "terminated:P", "wL", "x1"]);
    assert.deepEqual(highlighted(state), ["x1"]);
});

test("filterExceptionId records only a real session; a link to a Terminated row fails without a fetch (R4, R9b)", () => {
    let state = loaded([folder("g", 1), session("m1", { groupId: "g", createdAt: at(2), updatedAt: at(2) }), ...DEPTH_ONE]);
    state = appReducer(state, { type: "sessions/filterQuery", query: "zebra quartz" });
    state = appReducer(state, { type: "sessions/navigationIntent", sessionId: "group:g" });
    assert.equal(state.sessions.filterExceptionId, null, "a folder link is never the filter exception");
    state = appReducer(state, { type: "sessions/navigationIntent", sessionId: "a3" });
    assert.equal(state.sessions.filterExceptionId, "a3", "a real session still is");

    const before = state.sessions.activeSessionId;
    state = appReducer(state, { type: "sessions/navigationIntent", sessionId: "terminated:P" });
    assert.deepEqual(state.sessions.navigationIntent, { sessionId: "terminated:P", status: "failed", errorKind: "not_found" });
    assert.equal(state.sessions.filterExceptionId, null);
    assert.equal(state.sessions.activeSessionId, before);
});

/**
 * A transport that records every call to any method (each one exists and answers null unless given here). The tests
 * below assert which ids reach it. The paged catalog, the folder list and the worker count are left out, so the
 * controller takes its plain `listSessions` path.
 */
const NOT_OFFERED = new Set(["then", "listSessionsPage", "listSessionGroups", "getWorkerCount"]);
function recordingTransport(extra = {}) {
    const calls = [];
    const base = {
        listSessions: async () => [],
        getSession: async id => ({ sessionId: id }),
        getSessionEvents: async () => [],
        listArtifacts: async () => [],
        subscribeSession: () => () => {},
        ...extra,
    };
    const transport = new Proxy(base, {
        get(target, name) {
            if (typeof name !== "string" || NOT_OFFERED.has(name)) return undefined;
            const method = target[name] || (async () => null);
            return (...args) => {
                calls.push([name, ...args]);
                return method(...args);
            };
        },
    });
    return { transport, calls };
}

function controllerWith(sessions, { extra, setup } = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const { transport, calls } = recordingTransport(extra);
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions });
    for (const id of [...store.getState().sessions.collapsedIds]) store.dispatch({ type: "sessions/expand", sessionId: id });
    setup?.(store);
    calls.length = 0;
    return { store, controller, calls };
}

const settle = () => new Promise(resolve => setTimeout(resolve, SESSION_NAV_SETTLE_MS + 60));
const virtualCalls = calls => calls.filter(call => call.slice(1).some(arg => typeof arg === "string" && /^(terminated|group):/.test(arg)));

test("R11: the keyboard moves onto a Terminated row: no session loads, no transport call, + and - open and close it", async () => {
    const { store, controller, calls } = controllerWith([session("P"), agent("a1", "P", 1, "running"), agent("d1", "P", 2, "completed"), session("Q", { createdAt: at(9), updatedAt: at(9) })]);
    store.dispatch({ type: "sessions/selected", sessionId: "a1" });
    calls.length = 0;
    assert.deepEqual(rowIds(store.getState()), ["P", "a1", "terminated:P", "Q"]);

    await controller.handleCommand(UI_COMMANDS.MOVE_SESSION_DOWN);
    await settle();
    let state = store.getState();
    assert.equal(state.sessions.activeSessionId, "a1", "the chat keeps its session");
    assert.deepEqual(highlighted(state), ["terminated:P"]);
    assert.deepEqual(calls, [], "no transport method is called");

    await controller.handleCommand(UI_COMMANDS.EXPAND_SESSION);
    assert.deepEqual(openIds(store.getState()), ["P"]);
    assert.deepEqual(rowIds(store.getState()), ["P", "a1", "terminated:P", "d1", "Q"]);
    await controller.handleCommand(UI_COMMANDS.COLLAPSE_SESSION);
    assert.deepEqual(openIds(store.getState()), []);
    assert.deepEqual(rowIds(store.getState()), ["P", "a1", "terminated:P", "Q"]);
    assert.equal(store.getState().sessions.collapsedIds.has("terminated:P"), false, "no virtual id in the collapse state");
    assert.deepEqual(calls, []);

    await controller.loadSession("terminated:P");
    controller.navigateToSession("terminated:P");
    await settle();
    assert.deepEqual(calls, [], "loadSession and navigateToSession never fetch a Terminated row");
    assert.equal(store.getState().sessions.activeSessionId, "a1");

    // Down again leaves it for the next session; up from there comes back to it.
    await controller.handleCommand(UI_COMMANDS.MOVE_SESSION_DOWN);
    assert.equal(store.getState().sessions.activeSessionId, "Q");
    assert.deepEqual(highlighted(store.getState()), ["Q"]);
    await controller.handleCommand(UI_COMMANDS.MOVE_SESSION_UP);
    assert.deepEqual(highlighted(store.getState()), ["terminated:P"]);
    await controller.handleCommand(UI_COMMANDS.MOVE_SESSION_UP);
    assert.equal(store.getState().sessions.activeSessionId, "a1");
    assert.deepEqual(highlighted(store.getState()), ["a1"], "back on the active session's own row");
    await settle();
    assert.deepEqual(virtualCalls(calls), []);
    controller.stop?.();
});

test("R11: leaving a Terminated row keeps the chat as it was, and a load still settling does not pull the highlight back", async () => {
    const { store, controller, calls } = controllerWith([session("P"), agent("a1", "P", 1, "running"), agent("d1", "P", 2, "completed")]);
    store.dispatch({ type: "sessions/selected", sessionId: "P" });
    calls.length = 0;

    // Down twice at once: a1 is chosen and its load settles while the keyboard is already on the Terminated row.
    await controller.handleCommand(UI_COMMANDS.MOVE_SESSION_DOWN);
    await controller.handleCommand(UI_COMMANDS.MOVE_SESSION_DOWN);
    assert.equal(store.getState().sessions.activeSessionId, "a1");
    await settle();
    assert.ok(calls.some(([name, id]) => name === "getSessionEvents" && id === "a1"), "a1's chat still loads");
    assert.deepEqual(highlighted(store.getState()), ["terminated:P"], "the highlight stays where the keyboard put it");

    // The person was reading a1 higher up; back on a1's row the chat stays there.
    store.dispatch({ type: "ui/followBottom", pane: "chat", followBottom: false });
    store.dispatch({ type: "ui/scroll", pane: "chat", offset: 37 });
    const before = store.getState();
    calls.length = 0;
    await controller.handleCommand(UI_COMMANDS.MOVE_SESSION_UP);
    const after = store.getState();
    assert.deepEqual(highlighted(after), ["a1"]);
    assert.equal(after.sessions.selectedTerminatedRowId, null);
    assert.equal(after.ui.scroll.chat, 37);
    assert.equal(after.ui.followBottom.chat, false);
    assert.equal(after.ui.prompt, before.ui.prompt);

    // A click on the active session's row (the portal re-arms the highlight) also takes it back.
    store.dispatch({ type: "sessions/selected", sessionId: "terminated:P" });
    store.dispatch({ type: "sessions/listReselect" });
    assert.deepEqual(highlighted(store.getState()), ["a1"]);
    controller.stop?.();
});

test("R4, R11: row commands never act on another session while a Terminated row is the selected row", async () => {
    const { store, controller, calls } = controllerWith([session("P"), agent("d1", "P", 1, "completed"), session("Q", { createdAt: at(9), updatedAt: at(9) })]);
    store.dispatch({ type: "sessions/selected", sessionId: "P" });
    calls.length = 0;
    await controller.handleCommand(UI_COMMANDS.MOVE_SESSION_DOWN);
    assert.deepEqual(highlighted(store.getState()), ["terminated:P"]);
    assert.equal(store.getState().sessions.activeSessionId, "P", "P is pinnable, selectable and deletable: nothing below may touch it");

    for (const command of [UI_COMMANDS.PIN_SESSION, UI_COMMANDS.TOGGLE_SESSION_SELECTION, UI_COMMANDS.DELETE_SESSION,
        UI_COMMANDS.CANCEL_SESSION, UI_COMMANDS.DONE_SESSION, UI_COMMANDS.OPEN_RENAME_SESSION, UI_COMMANDS.OPEN_MOVE_TO_GROUP,
        UI_COMMANDS.OPEN_TERMINATE_PICKER, UI_COMMANDS.REGENERATE_SESSION, UI_COMMANDS.CYCLE_SESSION_VISIBILITY,
        UI_COMMANDS.OPEN_SHARE_SESSION]) {
        await controller.handleCommand(command);
    }
    await settle();
    const state = store.getState();
    assert.deepEqual(state.sessions.pinnedIds, []);
    assert.deepEqual(state.sessions.selectedIds, []);
    assert.equal(state.ui.modal, null);
    assert.deepEqual(calls, []);
    assert.match(state.ui.statusText, /Terminated/);

    // Back on P, the same command acts on P.
    await controller.handleCommand(UI_COMMANDS.MOVE_SESSION_UP);
    await controller.handleCommand(UI_COMMANDS.PIN_SESSION);
    assert.deepEqual(store.getState().sessions.pinnedIds, ["P"]);
    controller.stop?.();
});

test("R11: the TUI window is placed on the selected Terminated row", () => {
    const children = Array.from({ length: 12 }, (_, i) => agent(`c${String(i + 1).padStart(2, "0")}`, "P", i + 1, "running"));
    let state = expandAll(loaded([session("P"), ...children, agent("done", "P", 30, "completed"), session("Z", { createdAt: at(40), updatedAt: at(40) })]));
    state = appReducer(state, { type: "sessions/selected", sessionId: "c01" });
    state = appReducer(state, { type: "sessions/selected", sessionId: "terminated:P" });
    assert.equal(state.sessions.activeSessionId, "c01", "the chat keeps its session");
    const window = selectVisibleSessionRows(state, 6).map(row => row.sessionId);
    assert.ok(window.includes("terminated:P"), `window: ${window.join(",")}`);
    assert.ok(!window.includes("c01"));
    assert.equal(selectVisibleSessionRows(state, 6).find(row => row.sessionId === "terminated:P").active, true);
});

test("R4: visible-detail sync, the history prefetch, the files scope and the node map never see a virtual id", async () => {
    const sessions = [folder("g", 0), session("m1", { groupId: "g", createdAt: at(1), updatedAt: at(1) }),
        session("P", { createdAt: at(2), updatedAt: at(2) }), agent("a1", "P", 3, "running"), agent("d1", "P", 4, "completed")];
    const { store, controller, calls } = controllerWith(sessions);
    controller.setViewport?.({ width: 200, height: 80 });
    calls.length = 0;
    assert.ok(rowIds(store.getState()).includes("terminated:P") && rowIds(store.getState()).includes("group:g"));

    // The list shows a folder row and a closed Terminated row.
    await controller.syncVisibleSessionDetails();
    await controller.ensureInspectorData("nodes");
    await controller.syncSessionDetail("terminated:P");
    controller.scheduleSessionDetailSync("terminated:P", 0);
    controller.handleSessionGone("terminated:P");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(virtualCalls(calls), [], `virtual ids reached: ${JSON.stringify(virtualCalls(calls))}`);
    assert.ok(calls.some(([name, id]) => name === "getSession" && id === "a1"), "real rows are synced");
    assert.ok(calls.some(([name, id]) => name === "getSessionEvents" && id === "a1"), "real rows are prefetched");

    // Open, its members are real rows like any other.
    store.dispatch({ type: "sessions/terminatedOpen", parentSessionId: "P" });
    await controller.syncVisibleSessionDetails();
    await controller.ensureInspectorData("nodes");
    assert.ok(calls.some(([name, id]) => name === "getSession" && id === "d1"));
    assert.ok(calls.some(([name, id]) => name === "getSessionEvents" && id === "d1"));

    store.dispatch({ type: "files/filter", filter: { scope: "allSessions" } });
    const scoped = selectFileSessionIdsForScope(store.getState(), "allSessions");
    assert.deepEqual(scoped.filter(id => /^(terminated|group):/.test(id)), []);
    assert.ok(scoped.includes("d1") && scoped.includes("m1"));
    await controller.ensureFilesForScope("allSessions");
    assert.equal(await controller.ensureFilesForSession("terminated:P"), null);
    assert.equal(await controller.ensureFilesForSession("group:g"), null);
    assert.deepEqual(virtualCalls(calls), [], `virtual ids reached: ${JSON.stringify(virtualCalls(calls))}`);
    assert.ok(calls.some(([name, id]) => name === "listArtifacts" && id === "d1"));
    assert.equal(store.getState().sessions.byId.P?.sessionId, "P", "no virtual id was evicted as gone");
    assert.deepEqual(store.getState().sessions.goneIds || [], []);

    // Every real session's files are in: the all-sessions view is not left waiting on a row that is not a session.
    const view = selectFilesView(store.getState());
    const text = JSON.stringify(view);
    assert.ok(!text.includes("Loading exported files across all sessions"), "the files view is not stuck loading");
    assert.ok(!JSON.stringify(selectNodeMapView(store.getState())).includes("terminated:"));
    controller.stop?.();
});

test("R4: a pending link to a Terminated row never asks the server for it", async () => {
    const { store, controller, calls } = controllerWith(DEPTH_ONE, {
        extra: { listSessions: async () => DEPTH_ONE.map(row => ({ ...row })) },
    });
    store.dispatch({ type: "sessions/navigationIntent", sessionId: "terminated:P" });
    await controller.refreshSessions();
    assert.deepEqual(virtualCalls(calls), []);
    assert.equal(store.getState().sessions.navigationIntent?.status, "failed");
    controller.stop?.();
});
