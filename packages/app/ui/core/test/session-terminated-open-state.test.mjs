/**
 * Plan 3, Task 2: which Terminated rows are open, and the guards that keep a Terminated row from acting as a session.
 * R6 the open set (actions, every list rebuild, profile hydration, pruning), R7 the Terminated rows that hold the
 * session on screen open when it is chosen or when it (or an ancestor) finishes, and a row the person closed stays closed
 * (amended 2026-11-17), R4 a virtual row id never reaches a session API or session state, R11 the keyboard on a
 * Terminated row, R12 status changes.
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
    const withQ = [...DEPTH_ONE, session("Q", { createdAt: at(20), updatedAt: at(20) }), agent("q1", "Q", 21, "failed")];
    let state = loaded(withQ);
    state = openRow(openRow(state, "P"), "Q");
    assert.deepEqual(openIds(state), ["P", "Q"]);
    state = appReducer(state, { type: "sessions/gone", sessionId: "Q" });
    assert.deepEqual(openIds(state), ["P"], "a deleted parent is dropped");
    assert.deepEqual(openIds(openRow(state, "Q")), ["P"], "a parent that is not in the list cannot be opened");

    state = openRow(appReducer(state, { type: "sessions/loaded", sessions: withQ }), "Q");
    assert.deepEqual(openIds(state), ["P", "Q"]);
    state = appReducer(state, { type: "sessions/loaded", sessions: DEPTH_ONE });
    assert.deepEqual(openIds(state), ["P"], "a parent the full listing no longer holds is dropped");
    state = appReducer(state, { type: "sessions/loaded", sessions: withQ });
    state = appReducer(state, { type: "sessions/expand", sessionId: "Q" });
    assert.equal(entryOf(state, "terminated:Q").collapsed, true, "when it comes back, its row starts closed");
});

test("sessions/gone rebuilds the list: the gone parent's rows and its Terminated row leave it, and so does a Terminated row whose last member went (R4, R6)", () => {
    const Q = [session("Q", { createdAt: at(20), updatedAt: at(20) }), agent("q1", "Q", 21, "failed"), agent("q2", "Q", 22, "running")];
    let state = expandAll(loaded([...DEPTH_ONE, ...Q]));
    state = appReducer(state, { type: "sessions/selected", sessionId: "a4" });
    state = openRow(openRow(state, "P"), "Q");
    state = appReducer(state, { type: "sessions/selected", sessionId: "terminated:Q" });
    assert.deepEqual(rowIds(state).filter(id => /^(Q|q\d|terminated:Q)$/.test(id)), ["Q", "q2", "terminated:Q", "q1"]);
    assert.deepEqual(highlighted(state), ["terminated:Q"]);

    // Q is deleted while another session is active and its open Terminated row has the keyboard highlight.
    state = appReducer(state, { type: "sessions/gone", sessionId: "Q" });
    assert.deepEqual(openIds(state), ["P"]);
    assert.deepEqual(ids(state.sessions.flat), P_OPEN, "the tree is rebuilt without Q, its children and its Terminated row");
    assert.deepEqual(rowIds(state), P_OPEN, "no stale row is shown");
    assert.equal(state.sessions.selectedTerminatedRowId, null, "the highlight leaves the row that is gone");
    assert.equal(state.sessions.activeSessionId, "a4", "the active session stays");
    assert.deepEqual(highlighted(state), ["a4"]);
    assert.equal(openRow(state, "Q"), state, "a stale toggle cannot bring Q back into the open set");

    // The last finished child of R goes: R's Terminated row goes with it. R still exists, so its open state stays.
    state = expandAll(loaded([session("R"), agent("r1", "R", 1, "running"), agent("r2", "R", 2, "completed")]));
    state = appReducer(state, { type: "sessions/selected", sessionId: "r1" });
    state = openRow(state, "R");
    state = appReducer(state, { type: "sessions/selected", sessionId: "terminated:R" });
    assert.deepEqual(rowIds(state), ["R", "r1", "terminated:R", "r2"]);
    state = appReducer(state, { type: "sessions/gone", sessionId: "r2" });
    assert.deepEqual(ids(state.sessions.flat), ["R", "r1"]);
    assert.deepEqual(rowIds(state), ["R", "r1"]);
    assert.equal(state.sessions.selectedTerminatedRowId, null);
    assert.deepEqual(highlighted(state), ["r1"]);
    assert.deepEqual(openIds(state), ["R"]);

    // The active session itself goes: it is released as before, and the list is rebuilt without it.
    state = appReducer(state, { type: "sessions/gone", sessionId: "r1" });
    assert.equal(state.sessions.activeSessionId, null);
    assert.deepEqual(ids(state.sessions.flat), ["R"]);
    assert.equal(entryOf(state, "R").hasChildren, false);
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

test("R7 on selection 1,500 levels deep, under many open rows: the open set is copied once, not once per row it opens", () => {
    // c1 … c1499 have ended, each the child of the one before, so every one sits in its parent's Terminated row.
    const N = 1500;
    const chain = [session("c0")];
    for (let i = 1; i < N; i += 1) chain.push(agent(`c${i}`, `c${i - 1}`, i, "completed"));
    const alreadyOpen = Array.from({ length: N / 2 }, (_, i) => `c${i * 2}`);
    let state = loaded(chain, { openTerminatedSessionIds: alreadyOpen });
    const before = state.sessions.openTerminatedIds;
    assert.equal(before.size, N / 2);

    const add = Set.prototype.add;
    let inserts = 0;
    Set.prototype.add = function countedAdd(value) { inserts += 1; return add.call(this, value); };
    try {
        state = appReducer(state, { type: "sessions/selected", sessionId: `c${N - 1}` });
    } finally {
        Set.prototype.add = add;
    }
    assert.equal(state.sessions.openTerminatedIds.size, N - 1, "every Terminated row on the path is open");
    assert.ok(state.sessions.openTerminatedIds.has("c1") && state.sessions.openTerminatedIds.has(`c${N - 2}`));
    assert.equal(before.size, N / 2, "the previous open set is not changed");
    assert.equal(entryOf(state, `c${N - 1}`)?.depth, 2 * (N - 1), "the selected session is in the list");
    // Copying the open set once per row it opens inserted about 842,000 ids here.
    assert.ok(inserts < 20 * N, `one reveal inserted ${inserts} Set entries`);

    const again = appReducer(state, { type: "sessions/selected", sessionId: `c${N - 1}` });
    assert.equal(again.sessions.openTerminatedIds, state.sessions.openTerminatedIds, "nothing to open keeps the same set");
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

const cursor = state => state.sessions.selectedTerminatedRowId;

test("R11: the selection on a Terminated row ends when its parent collapses, and does not come back when it expands", () => {
    let state = expandAll(loaded(DEPTH_ONE));
    state = appReducer(state, { type: "sessions/selected", sessionId: "P" });
    state = appReducer(state, { type: "sessions/selected", sessionId: "terminated:P" });
    assert.deepEqual(highlighted(state), ["terminated:P"]);
    state = appReducer(state, { type: "sessions/collapse", sessionId: "P" });
    assert.deepEqual(rowIds(state), ["P"]);
    assert.equal(cursor(state), null, "collapse: the row is gone, so is the selection on it");
    assert.deepEqual(highlighted(state), ["P"]);
    state = appReducer(state, { type: "sessions/expand", sessionId: "P" });
    assert.deepEqual(rowIds(state), P_CLOSED);
    assert.equal(cursor(state), null);
    assert.deepEqual(highlighted(state), ["P"], "expand: the highlight stays on P");
});

test("R11: the selection on a nested Terminated row ends when the Terminated row that holds it closes, and does not come back when it opens", () => {
    let state = loaded(DEPTH_TWO);
    state = appReducer(state, { type: "sessions/selected", sessionId: "x3" });
    state = appReducer(state, { type: "sessions/selected", sessionId: "a1" });
    state = appReducer(state, { type: "sessions/selected", sessionId: "terminated:wT" });
    assert.deepEqual(rowIds(state), ["P", "a1", "terminated:P", "wT", "x1", "terminated:wT", "x3"]);
    assert.deepEqual(highlighted(state), ["terminated:wT"]);
    state = appReducer(state, { type: "sessions/terminatedClose", parentSessionId: "P" });
    assert.deepEqual(rowIds(state), ["P", "a1", "terminated:P"]);
    assert.equal(cursor(state), null, "close: the nested row is gone, so is the selection on it");
    assert.deepEqual(highlighted(state), ["a1"]);
    state = openRow(state, "P");
    assert.ok(rowIds(state).includes("terminated:wT"));
    assert.equal(cursor(state), null);
    assert.deepEqual(highlighted(state), ["a1"], "open: the highlight stays on the active session");
});

test("R11: the selection on a Terminated row ends when a search hides the row, and does not come back when it is cleared", () => {
    let state = expandAll(loaded([...DEPTH_ONE, session("Q", { title: "Quarterly report", createdAt: at(20), updatedAt: at(20) })]));
    state = appReducer(state, { type: "sessions/selected", sessionId: "P" });
    state = appReducer(state, { type: "sessions/selected", sessionId: "terminated:P" });
    state = appReducer(state, { type: "sessions/filterQuery", query: "quarterly" });
    assert.ok(!rowIds(state).includes("terminated:P"), `rows: ${rowIds(state).join(",")}`);
    assert.equal(cursor(state), null, "search: the row is not shown, so the selection on it ends");
    state = appReducer(state, { type: "sessions/filterQuery", query: "" });
    assert.deepEqual(highlighted(state), ["P"]);
});

test("R11: an empty-space deselect ends the selection on a Terminated row; a reselect highlights the active session", () => {
    let state = expandAll(loaded(DEPTH_ONE));
    state = appReducer(state, { type: "sessions/selected", sessionId: "P" });
    state = appReducer(state, { type: "sessions/selected", sessionId: "terminated:P" });
    assert.deepEqual(highlighted(state), ["terminated:P"]);
    state = appReducer(state, { type: "sessions/listDeselect" });
    assert.equal(cursor(state), null, "deselect: no selection is left on any row");
    assert.deepEqual(highlighted(state), []);
    state = appReducer(state, { type: "sessions/listReselect" });
    assert.deepEqual(highlighted(state), ["P"]);
    assert.equal(state.sessions.activeSessionId, "P");
});

const P_WITH_OPEN_ROW = [session("P"), agent("a1", "P", 1, "running"), agent("d1", "P", 2, "completed"), session("Q", { createdAt: at(9), updatedAt: at(9) })];
async function onOpenTerminatedRowOfP() {
    const harness = controllerWith(P_WITH_OPEN_ROW);
    harness.store.dispatch({ type: "sessions/selected", sessionId: "P" });
    harness.controller.navigateToSession("terminated:P");
    await harness.controller.handleCommand(UI_COMMANDS.EXPAND_SESSION);
    assert.deepEqual(openIds(harness.store.getState()), ["P"]);
    assert.deepEqual(highlighted(harness.store.getState()), ["terminated:P"]);
    harness.calls.length = 0;
    return harness;
}

/** Real rows still load after it; no virtual id ever reached the transport. */
async function assertRealRowLoadsAndNoVirtualCall({ store, controller, calls }) {
    await controller.handleCommand(UI_COMMANDS.MOVE_SESSION_DOWN);
    assert.equal(store.getState().sessions.activeSessionId, "a1");
    await settle();
    assert.ok(calls.some(([name, id]) => name === "getSessionEvents" && id === "a1"), "a1's chat loads");
    assert.deepEqual(virtualCalls(calls), []);
    controller.stop?.();
}

test("R11: after its parent collapses and expands, + and - and the row commands act on the parent, not on the Terminated row", async () => {
    const harness = await onOpenTerminatedRowOfP();
    const { store, controller } = harness;

    // P is collapsed and expanded again by its own row (a click on its chevron): the selection is back on P.
    store.dispatch({ type: "sessions/collapse", sessionId: "P" });
    store.dispatch({ type: "sessions/expand", sessionId: "P" });
    assert.deepEqual(highlighted(store.getState()), ["P"]);
    assert.equal(controller.selectedTerminatedRow(), null);
    await controller.handleCommand(UI_COMMANDS.COLLAPSE_SESSION);
    assert.ok(store.getState().sessions.collapsedIds.has("P"), "- collapses P");
    assert.deepEqual(openIds(store.getState()), ["P"], "- does not close the Terminated row the person left");
    await controller.handleCommand(UI_COMMANDS.EXPAND_SESSION);
    assert.ok(!store.getState().sessions.collapsedIds.has("P"), "+ expands P");
    await controller.handleCommand(UI_COMMANDS.PIN_SESSION);
    assert.deepEqual(store.getState().sessions.pinnedIds, ["P"], "a row command acts on P, not refused");
    await assertRealRowLoadsAndNoVirtualCall(harness);
});

test("R11: after an empty-space deselect, - acts as it does today (on the active session) and never closes the Terminated row", async () => {
    const harness = await onOpenTerminatedRowOfP();
    const { store, controller } = harness;
    store.dispatch({ type: "sessions/listDeselect" });
    assert.deepEqual(highlighted(store.getState()), []);
    assert.equal(controller.selectedTerminatedRow(), null);
    await controller.handleCommand(UI_COMMANDS.COLLAPSE_SESSION);
    assert.deepEqual(openIds(store.getState()), ["P"], "no row without a visible selection is closed");
    assert.ok(store.getState().sessions.collapsedIds.has("P"));
    store.dispatch({ type: "sessions/expand", sessionId: "P" });
    store.dispatch({ type: "sessions/listReselect" });
    assert.deepEqual(highlighted(store.getState()), ["P"]);

    // The helper itself ignores a Terminated row in a deselected list.
    const now = store.getState();
    assert.equal(controller.selectedTerminatedRow({ ...now, sessions: { ...now.sessions, selectedTerminatedRowId: "terminated:P", listDeselected: true } }), null);
    await assertRealRowLoadsAndNoVirtualCall(harness);
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

// R7 as amended after the owner's try-out (2026-11-17): "when one of the terminated workflows or sessions is selected,
// and I collapse the Terminated node then it reopens in a few secs". The Terminated rows that hold the session on screen
// open only when (a) the selection moves to it (a click, the keyboard, a link) or (b) it or an ancestor on its path
// finishes. A row the person closed stays closed through every other listing, merge and status update.

// P holds a finished child T (the session the person looks at) and live siblings; Q is another root.
const CLOSE_FAMILY = [
    session("P"),
    agent("a1", "P", 1, "running"),
    agent("T", "P", 2, "completed"),
    agent("s1", "P", 3, "running"),
    session("Q", { createdAt: at(9), updatedAt: at(9) }),
];
const relisted = (changes = {}, rows = CLOSE_FAMILY) => rows.map(row => ({ ...row, ...(changes[row.sessionId] || {}) }));

/** T is chosen (the row that holds it opens), then the person closes that row. */
function closedOverT({ sessions = CLOSE_FAMILY, ownerFilter = null, close = "terminatedClose" } = {}) {
    let state = expandAll(loaded(sessions));
    if (ownerFilter) state = appReducer(state, { type: "sessions/ownerFilter", filter: ownerFilter });
    state = appReducer(state, { type: "sessions/selected", sessionId: "T" });
    assert.deepEqual(openIds(state), ["P"], "choosing T opens the row that holds it");
    assert.deepEqual(highlighted(state), ["T"]);
    state = close === "collapse"
        ? appReducer(state, { type: "sessions/collapse", sessionId: "terminated:P" })
        : appReducer(state, { type: "sessions/terminatedClose", parentSessionId: "P" });
    assert.deepEqual(openIds(state), []);
    assert.ok(rowIds(state).includes("terminated:P") && !rowIds(state).includes("T"), "the person closed the row over T");
    assert.equal(state.sessions.activeSessionId, "T");
    return state;
}

/** Updates in which T and P keep their status: listings, merges of other rows (a status-only one too), folders, the profile. */
function ordinaryUpdates(sessions = CLOSE_FAMILY) {
    return [
        ["a sibling's status changes (merged)", { type: "sessions/merged", session: { sessionId: "s1", status: "idle" } }],
        ["another sibling is renamed (merged)", { type: "sessions/merged", session: { sessionId: "a1", title: "Reads the logs" } }],
        ["a listing with a root updated", { type: "sessions/loaded", sessions: relisted({ s1: { status: "idle" }, Q: { updatedAt: at(30) } }, sessions) }],
        ["T's details are read again (merged, still finished)", { type: "sessions/merged", session: { sessionId: "T", title: "Summary", updatedAt: at(31) } }],
        ["P's details are read again (merged)", { type: "sessions/merged", session: { sessionId: "P", updatedAt: at(32) } }],
        ["a listing with a new root", { type: "sessions/loaded", sessions: [...relisted({ Q: { updatedAt: at(33) } }, sessions), session("R", { createdAt: at(34), updatedAt: at(34) })] }],
        ["the folder listing", { type: "sessions/groupsLoaded", groups: [] }],
        ["a profile read", { type: "profileSettings/apply", settings: { openTerminatedSessionIds: [], pinnedSessionIds: [] } }],
        ["a sibling's status changes back (merged)", { type: "sessions/merged", session: { sessionId: "s1", status: "running" } }],
    ];
}

function assertStaysClosed(state, label, activeSessionId = "T", parents = []) {
    assert.deepEqual(openIds(state), parents, `${label}: the row the person closed stays closed`);
    assert.ok(!rowIds(state).includes(activeSessionId), `${label}: ${activeSessionId} stays inside it`);
    assert.equal(state.sessions.activeSessionId, activeSessionId, `${label}: ${activeSessionId} stays the active session`);
}

test("R7 amended: a Terminated row the person closed over the active session stays closed through listings and merges", () => {
    for (const close of ["terminatedClose", "collapse"]) {
        let state = closedOverT({ close });
        for (const [label, action] of ordinaryUpdates()) {
            state = appReducer(state, action);
            assertStaysClosed(state, `${close}, ${label}`);
        }
    }
});

test("R7 amended: under an owner filter (the portal's default) the closed row stays closed and the chat keeps T", () => {
    // Everything here is unowned, so this filter shows it all: only the closed row hides T.
    let state = closedOverT({ ownerFilter: { all: false, includeUnowned: true } });
    for (const [label, action] of ordinaryUpdates()) {
        state = appReducer(state, action);
        assertStaysClosed(state, `owner filter, ${label}`);
    }

    // When the owner filter itself hides T, the list still chooses a session it shows, as it does today.
    const withSystem = [...CLOSE_FAMILY, session("S", { isSystem: true, createdAt: at(40), updatedAt: at(40) })];
    state = closedOverT({ sessions: withSystem, ownerFilter: { all: false, includeUnowned: true, includeSystem: true } });
    state = appReducer(state, { type: "sessions/ownerFilter", filter: { all: false, includeSystem: true } });
    assert.equal(state.sessions.activeSessionId, "S", "a session the filter hides gives way to one the list shows");
});

test("R7 amended: choosing T again, or a link to it, opens the row again; after a close it stays closed again", () => {
    let state = closedOverT();
    state = appReducer(state, { type: "sessions/selected", sessionId: "Q" });
    assert.deepEqual(openIds(state), [], "choosing another session opens nothing");
    state = appReducer(state, { type: "sessions/selected", sessionId: "T" });
    assert.deepEqual(openIds(state), ["P"], "choosing T again opens the row");
    assert.deepEqual(highlighted(state), ["T"]);

    state = appReducer(state, { type: "sessions/terminatedClose", parentSessionId: "P" });
    state = appReducer(state, { type: "sessions/merged", session: { sessionId: "s1", status: "idle" } });
    assertStaysClosed(state, "closed again");
    state = appReducer(state, { type: "sessions/navigationIntent", sessionId: "T" });
    assert.deepEqual(openIds(state), ["P"], "a link to T, while T is the chat, opens the row");
    assert.equal(state.sessions.activeSessionId, "T");
    assert.deepEqual(highlighted(state), ["T"]);

    // The link has been followed; it does not count again on later updates.
    state = appReducer(state, { type: "sessions/terminatedClose", parentSessionId: "P" });
    for (const [label, action] of ordinaryUpdates()) {
        state = appReducer(state, action);
        assertStaysClosed(state, `after the link, ${label}`);
    }
});

test("R7 amended: the active session finishing opens its row; closed again, it stays closed while it stays finished", () => {
    let state = expandAll(loaded(CLOSE_FAMILY));
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    assert.deepEqual(openIds(state), []);
    state = appReducer(state, { type: "sessions/merged", session: { sessionId: "s1", status: "completed" } });
    assert.deepEqual(openIds(state), ["P"], "(b) s1 has just finished: the row that now holds it opens");
    assert.deepEqual(highlighted(state), ["s1"]);

    state = appReducer(state, { type: "sessions/terminatedClose", parentSessionId: "P" });
    const updates = [
        ["s1 is renamed (merged)", { type: "sessions/merged", session: { sessionId: "s1", title: "Done" } }],
        ["s1 changes from completed to failed (still finished)", { type: "sessions/merged", session: { sessionId: "s1", status: "failed" } }],
        ["a listing with s1 still finished", { type: "sessions/loaded", sessions: relisted({ s1: { status: "failed" }, Q: { updatedAt: at(30) } }) }],
        ["a sibling's status changes (merged)", { type: "sessions/merged", session: { sessionId: "a1", status: "idle" } }],
    ];
    for (const [label, action] of updates) {
        state = appReducer(state, action);
        assertStaysClosed(state, label, "s1");
    }

    // It runs again (R12: it leaves the row), then finishes again: a new transition opens the row again.
    state = appReducer(state, { type: "sessions/merged", session: { sessionId: "s1", status: "running" } });
    assert.ok(rowIds(state).includes("s1"), "running again, s1 is back among the live children");
    assert.deepEqual(openIds(state), []);
    state = appReducer(state, { type: "sessions/merged", session: { sessionId: "s1", status: "completed" } });
    assert.deepEqual(openIds(state), ["P"], "finished again: the row opens again");
    assert.deepEqual(highlighted(state), ["s1"]);
});

test("R7 amended: an ancestor two levels up finishing opens the outer row once; closed, it stays closed", () => {
    const nested = [
        session("P"),
        agent("a1", "P", 1, "running"),
        workflow("wL", "P", 2, "running"),
        agent("x1", "wL", 3, "running"),
        agent("x2", "wL", 4, "running"),
    ];
    let state = expandAll(loaded(nested));
    state = appReducer(state, { type: "sessions/selected", sessionId: "x1" });
    assert.deepEqual(openIds(state), []);
    state = appReducer(state, { type: "sessions/loaded", sessions: relisted({ wL: { status: "completed" } }, nested) });
    assert.deepEqual(openIds(state), ["P"], "(b) its Workflow has just finished: the one row that holds it opens");
    assert.deepEqual(highlighted(state), ["x1"]);

    state = appReducer(state, { type: "sessions/terminatedClose", parentSessionId: "P" });
    const updates = [
        ["a listing with wL still finished", { type: "sessions/loaded", sessions: relisted({ wL: { status: "completed" }, x2: { updatedAt: at(30) } }, nested) }],
        ["a sibling's status changes (merged)", { type: "sessions/merged", session: { sessionId: "x2", status: "idle" } }],
        ["wL is renamed (merged)", { type: "sessions/merged", session: { sessionId: "wL", title: "Workflow: nightly" } }],
        ["x1's details are read again (merged)", { type: "sessions/merged", session: { sessionId: "x1", updatedAt: at(31) } }],
    ];
    for (const [label, action] of updates) {
        state = appReducer(state, action);
        assertStaysClosed(state, label, "x1");
    }

    // x1 itself finishes: a new transition on its path shows it again, with every row that holds it.
    state = appReducer(state, { type: "sessions/merged", session: { sessionId: "x1", status: "completed" } });
    assert.deepEqual(openIds(state), ["P", "wL"]);
    assert.ok(rowIds(state).includes("x1"));
    assert.deepEqual(highlighted(state), ["x1"]);
});

test("R7 amended, TUI: - closes the row that holds the chat's session, and catalog refreshes leave it closed", async () => {
    let reads = 0;
    // Every read differs a little (a root's time, a sibling's status), as a live catalog does.
    const catalog = () => {
        reads += 1;
        return relisted({ Q: { updatedAt: at(20 + reads) }, s1: { status: reads % 2 ? "idle" : "running" } });
    };
    const { store, controller, calls } = controllerWith(CLOSE_FAMILY, { extra: { listSessions: async () => catalog() } });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    // The keyboard: down onto the closed row, + opens it, down onto T (the chat moves to T), up onto the row, - closes it.
    await controller.handleCommand(UI_COMMANDS.MOVE_SESSION_DOWN);
    assert.deepEqual(highlighted(store.getState()), ["terminated:P"]);
    await controller.handleCommand(UI_COMMANDS.EXPAND_SESSION);
    await controller.handleCommand(UI_COMMANDS.MOVE_SESSION_DOWN);
    assert.equal(store.getState().sessions.activeSessionId, "T");
    await controller.handleCommand(UI_COMMANDS.MOVE_SESSION_UP);
    assert.deepEqual(highlighted(store.getState()), ["terminated:P"]);
    await controller.handleCommand(UI_COMMANDS.COLLAPSE_SESSION);
    assert.deepEqual(openIds(store.getState()), []);
    await settle();

    for (let i = 1; i <= 3; i += 1) {
        await controller.refreshSessions();
        const state = store.getState();
        assertStaysClosed(state, `refresh ${i}`);
        assert.deepEqual(highlighted(state), ["terminated:P"], `refresh ${i}: the keyboard stays on the row`);
    }
    assert.ok(reads >= 3, "the catalog was read");
    assert.deepEqual(virtualCalls(calls), []);
    controller.stop?.();
});

test("R7 amended: isSessionListed answers as selectSessionRows does, without building the rows", () => {
    const withSystem = [...CLOSE_FAMILY, session("S", { isSystem: true, createdAt: at(40), updatedAt: at(40) }), folder("g", 41),
        session("m1", { groupId: "g", createdAt: at(42), updatedAt: at(42) })];
    const closed = closedOverT({ sessions: withSystem });
    const states = [
        ["T's row closed", closed],
        ["T's row open", openRow(closed, "P")],
        ["an owner filter that hides the family", appReducer(closed, { type: "sessions/ownerFilter", filter: { all: false, includeSystem: true } })],
        ["an owner filter that shows all", appReducer(closed, { type: "sessions/ownerFilter", filter: { all: false, includeUnowned: true, includeSystem: true } })],
        ["a search", appReducer(closed, { type: "sessions/filterQuery", query: "Session T" })],
        ["P collapsed", appReducer(closed, { type: "sessions/collapse", sessionId: "P" })],
    ];
    for (const [label, state] of states) {
        const listed = new Set(rowIds(state));
        for (const id of [...Object.keys(state.sessions.byId), "terminated:P", "nobody"]) {
            assert.equal(core.isSessionListed(state, id), listed.has(id), `${label}: ${id}`);
        }
    }
});

// What is remembered is the selection's current path: a member seen running again loses its mark even while its parent
// is missing from a listing, and ancestors the path no longer has are dropped (review round 2).
const withoutP = (changes = {}) => relisted(changes).filter(row => row.sessionId !== "P");

test("R7 amended: P leaves a listing and comes back while T stays finished: the row the person closed stays closed", () => {
    let state = closedOverT();
    state = appReducer(state, { type: "sessions/loaded", sessions: withoutP({ Q: { updatedAt: at(30) } }) });
    assert.ok(!state.sessions.byId.P, "P is missing from the listing");
    assert.equal(state.sessions.activeSessionId, "T");
    state = appReducer(state, { type: "sessions/loaded", sessions: relisted({ Q: { updatedAt: at(31) } }) });
    assertStaysClosed(state, "P is back, T still finished");

    // Missing from two listings in a row, with T's details read in between, then back.
    state = appReducer(state, { type: "sessions/loaded", sessions: withoutP({ Q: { updatedAt: at(32) } }) });
    state = appReducer(state, { type: "sessions/merged", session: { sessionId: "T", updatedAt: at(33) } });
    state = appReducer(state, { type: "sessions/loaded", sessions: withoutP({ Q: { updatedAt: at(34) } }) });
    state = appReducer(state, { type: "sessions/loaded", sessions: relisted({ Q: { updatedAt: at(35) } }) });
    assertStaysClosed(state, "P missing from two listings, then back");
});

test("R7 amended: T runs again while P is missing, then finishes as P comes back: the row opens and shows T (R12)", () => {
    let state = closedOverT();
    state = appReducer(state, { type: "sessions/loaded", sessions: withoutP({ T: { status: "running" } }) });
    assert.equal(state.sessions.activeSessionId, "T");
    assert.equal(state.sessions.byId.T.status, "running");
    state = appReducer(state, { type: "sessions/loaded", sessions: relisted({ Q: { updatedAt: at(30) } }) });
    assert.equal(state.sessions.byId.T.status, "completed");
    assert.deepEqual(openIds(state), ["P"], "(b) T has finished again: the row that holds it opens");
    assert.ok(rowIds(state).includes("T"), "T is shown");
    assert.deepEqual(highlighted(state), ["T"]);
});

test("R7 amended: while a parent on the path is missing, what was known above it is kept; an ancestor seen running there counts again", () => {
    const deep = [
        session("G"),
        agent("a0", "G", 1, "running"),
        agent("P", "G", 2, "completed"),
        workflow("wL", "P", 3, "completed"),
        agent("x1", "wL", 4, "completed"),
        agent("x2", "wL", 5, "running"),
    ];
    const withoutWL = (changes = {}) => relisted(changes, deep).filter(row => row.sessionId !== "wL");
    let state = expandAll(loaded(deep));
    state = appReducer(state, { type: "sessions/selected", sessionId: "x1" });
    assert.deepEqual(openIds(state), ["G", "P", "wL"]);
    state = appReducer(state, { type: "sessions/terminatedClose", parentSessionId: "G" });
    assertStaysClosed(state, "the outer row closed", "x1", ["P", "wL"]);

    // wL leaves a listing and comes back with nothing else changed: nothing opens. (R6 drops wL's own open row: it left.)
    state = appReducer(state, { type: "sessions/loaded", sessions: withoutWL({ a0: { updatedAt: at(30) } }) });
    assert.equal(state.sessions.activeSessionId, "x1");
    state = appReducer(state, { type: "sessions/loaded", sessions: relisted({ a0: { updatedAt: at(31) } }, deep) });
    assertStaysClosed(state, "wL is back, the path unchanged", "x1", ["P"]);

    // While wL is missing, P runs again; P has finished again when wL comes back: a new transition on the path.
    state = appReducer(state, { type: "sessions/loaded", sessions: withoutWL({ P: { status: "running" } }) });
    assert.equal(state.sessions.activeSessionId, "x1");
    state = appReducer(state, { type: "sessions/loaded", sessions: relisted({ a0: { updatedAt: at(32) } }, deep) });
    assert.deepEqual(openIds(state), ["G", "P", "wL"], "(b) P has finished again: the rows that hold x1 open");
    assert.ok(rowIds(state).includes("x1"));
    assert.deepEqual(highlighted(state), ["x1"]);
});

test("R7 amended: what is remembered is the selection's current path, not every path it has had, and moving S keeps the close", () => {
    // The selection S stays; each listing places it under a finished ancestor A<i>, all under P. With `keepAll` every A<j>
    // is listed, finished, from the start (S moves under a session that had already finished); otherwise each listing has
    // only the A<i> it places S under. The person closed P's row after choosing S: a change of the path alone keeps it closed.
    const listing = (i, keepAll) => [
        session("P"),
        ...Array.from({ length: 7 }, (_, j) => j)
            .filter(j => keepAll || j === i)
            .map(j => agent(`A${j}`, "P", j + 1, "completed")),
        agent("S", `A${i}`, 50, "running", { updatedAt: at(50 + i) }),
    ];
    for (const keepAll of [true, false]) {
        let state = expandAll(loaded(listing(0, keepAll)));
        state = appReducer(state, { type: "sessions/selected", sessionId: "S" });
        assert.deepEqual(openIds(state), ["P"], "choosing S opens the row that holds A0");
        state = appReducer(state, { type: "sessions/terminatedClose", parentSessionId: "P" });
        for (let i = 1; i <= 6; i += 1) {
            state = appReducer(state, { type: "sessions/loaded", sessions: listing(i, keepAll) });
            const label = `${keepAll ? "every A listed" : "only the current A listed"}, under A${i}`;
            assertStaysClosed(state, label, "S");
            assert.deepEqual(state.sessions.terminatedRevealPath, ["S", `A${i}`, "P"], `${label}: the remembered path is the current one`);
            assert.deepEqual([...state.sessions.terminatedRevealWatch], [["S", "finish"], ["P", "finish"]],
                `${label}: only the current path's running members are watched`);
        }
    }

    // Each listing places S under a finished B<i> whose parent M<i> is missing: only that missing parent is kept above the walk.
    const orphaned = i => [agent(`B${i}`, `M${i}`, 1, "completed"), agent("S", `B${i}`, 2, "running", { updatedAt: at(60 + i) })];
    let state = loaded(orphaned(0));
    state = appReducer(state, { type: "sessions/selected", sessionId: "S" });
    for (let i = 1; i <= 6; i += 1) {
        state = appReducer(state, { type: "sessions/loaded", sessions: orphaned(i) });
        assert.equal(state.sessions.activeSessionId, "S");
        assert.deepEqual([...state.sessions.terminatedRevealWatch], [["S", "finish"]], `M${i} missing: only S, running, is watched`);
        assert.deepEqual(state.sessions.terminatedRevealPath, ["S", `B${i}`, `M${i}`], `M${i} missing: the path is bounded`);
    }
});

// Review round 3: a change of the path alone is not a finish (R7 b is a live -> terminal status change). P's finished
// children A and B are both loaded; S runs under A.
const MOVE_FAMILY = [
    session("P"),
    agent("A", "P", 1, "completed"),
    agent("B", "P", 2, "completed"),
    agent("S", "A", 3, "running"),
    session("Q", { createdAt: at(9), updatedAt: at(9) }),
];

/** S is chosen (the row that holds A opens), then the person closes that row. */
function closedOverS({ sessions = MOVE_FAMILY, ownerFilter = null } = {}) {
    let state = expandAll(loaded(sessions));
    if (ownerFilter) state = appReducer(state, { type: "sessions/ownerFilter", filter: ownerFilter });
    state = appReducer(state, { type: "sessions/selected", sessionId: "S" });
    assert.deepEqual(openIds(state), ["P"], "choosing S opens the row that holds its finished parent");
    assert.deepEqual(highlighted(state), ["S"]);
    state = appReducer(state, { type: "sessions/terminatedClose", parentSessionId: "P" });
    assertStaysClosed(state, "the person closed the row over S", "S");
    return state;
}

test("R7 amended: S moved under another child of P that had already finished stays inside the row the person closed", () => {
    // Everything here is unowned, so the owner filter (the portal's default) shows it all: only the closed row hides S.
    for (const ownerFilter of [null, { all: false, includeUnowned: true }]) {
        const label = ownerFilter ? "owner filter" : "all owners";
        let state = closedOverS({ ownerFilter });
        state = appReducer(state, { type: "sessions/merged", session: { sessionId: "S", parentSessionId: "B" } });
        assert.equal(state.sessions.byId.S.parentSessionId, "B");
        assert.equal(state.sessions.byId.B.status, "completed");
        assertStaysClosed(state, `${label}, merged: S now under B`, "S");
        state = appReducer(state, { type: "sessions/loaded", sessions: relisted({ S: { parentSessionId: "A" }, Q: { updatedAt: at(30) } }, MOVE_FAMILY) });
        assert.equal(state.sessions.byId.S.parentSessionId, "A");
        assertStaysClosed(state, `${label}, listing: S back under A`, "S");
        state = appReducer(state, { type: "sessions/loaded", sessions: relisted({ S: { parentSessionId: "B" }, Q: { updatedAt: at(31) } }, MOVE_FAMILY) });
        assert.equal(state.sessions.byId.S.parentSessionId, "B");
        assertStaysClosed(state, `${label}, listing: S under B again`, "S");

        // A choice still reveals it (R7 a).
        state = appReducer(state, { type: "sessions/selected", sessionId: "S" });
        assert.deepEqual(openIds(state), ["P"], `${label}: choosing S again opens the row`);
        assert.deepEqual(highlighted(state), ["S"]);
    }
});

test("R7 amended: S moved under a session new to the list that has already finished stays inside the closed row", () => {
    let state = closedOverS();
    const withN = [...relisted({ S: { parentSessionId: "N" } }, MOVE_FAMILY), agent("N", "P", 5, "failed")];
    state = appReducer(state, { type: "sessions/loaded", sessions: withN });
    assert.equal(state.sessions.byId.S.parentSessionId, "N");
    assertStaysClosed(state, "S under N, which the list had not had", "S");
    state = appReducer(state, { type: "sessions/merged", session: { sessionId: "N", title: "Checks" } });
    assertStaysClosed(state, "N read again, still finished", "S");
});

test("R7 amended: S moved under a child of P that finishes then, or later, opens the row (a finish on its path)", () => {
    const withC = [...MOVE_FAMILY, agent("C", "P", 4, "running")];
    // C finishes in the listing that moves S under it.
    let state = closedOverS({ sessions: withC });
    state = appReducer(state, { type: "sessions/loaded", sessions: relisted({ S: { parentSessionId: "C" }, C: { status: "completed" } }, withC) });
    assert.deepEqual(openIds(state), ["P"], "(b) C was running just before: its finish opens the row");
    assert.deepEqual(highlighted(state), ["S"]);

    // S moves under C while C runs (C is not in the row, so nothing opens), then C finishes.
    state = closedOverS({ sessions: withC });
    state = appReducer(state, { type: "sessions/merged", session: { sessionId: "S", parentSessionId: "C" } });
    assert.deepEqual(openIds(state), []);
    assert.deepEqual(highlighted(state), ["S"], "under a running C, S is listed");
    state = appReducer(state, { type: "sessions/merged", session: { sessionId: "C", status: "completed" } });
    assert.deepEqual(openIds(state), ["P"], "(b) C has finished: the row opens");
    assert.deepEqual(highlighted(state), ["S"]);
});

test("R7 amended: S chosen before its ancestors are loaded: their rows open as they arrive (the choice completes), then a close is kept", () => {
    const Q = session("Q", { createdAt: at(9), updatedAt: at(9) });
    // Only S is known at first (a link's fetch, say); its parent Y and Y's parent Z arrive in later listings.
    let state = loaded([agent("S", "Y", 3, "running"), Q]);
    state = appReducer(state, { type: "sessions/selected", sessionId: "S" });
    assert.equal(state.sessions.activeSessionId, "S");
    state = appReducer(state, { type: "sessions/loaded", sessions: [agent("Y", "Z", 2, "running"), agent("S", "Y", 3, "running"), Q] });
    assert.deepEqual(openIds(state), [], "Y runs, under Z, which is not loaded yet");
    const full = [session("R"), agent("Z", "R", 1, "completed"), agent("Y", "Z", 2, "running"), agent("S", "Y", 3, "running"), Q];
    state = appReducer(state, { type: "sessions/loaded", sessions: full });
    assert.deepEqual(openIds(state), ["R"], "Z arrives finished: the row that holds S's path opens");
    assert.deepEqual(highlighted(state), ["S"]);

    state = appReducer(state, { type: "sessions/terminatedClose", parentSessionId: "R" });
    for (let i = 1; i <= 2; i += 1) {
        state = appReducer(state, { type: "sessions/loaded", sessions: relisted({ Q: { updatedAt: at(40 + i) } }, full) });
        assertStaysClosed(state, `listing ${i} after the close`, "S");
    }
});
