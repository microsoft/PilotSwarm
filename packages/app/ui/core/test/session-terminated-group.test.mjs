/**
 * Plan 3, Task 1: the session list puts live Workflow children first, then the other live children, then one
 * "Terminated" row that holds the finished children (Workflows first, then the others), at every depth (R1-R5, R8-R10,
 * R13). The Terminated row is a virtual row: `terminated:<parentSessionId>`, closed unless its parent is in
 * `openTerminatedIds`.
 *
 * Run: node --test test/session-terminated-group.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import * as core from "../src/index.js";

const { appReducer, buildSessionTree, createInitialState, selectSessionRows } = core;

const at = n => 1_800_000_000_000 + n * 60_000;
const session = (sessionId, extra = {}) => ({ sessionId, title: `Session ${sessionId}`, status: "idle", createdAt: at(0), updatedAt: at(0), ...extra });
const agent = (sessionId, parentSessionId, n, status, extra = {}) => session(sessionId, {
    parentSessionId, status, createdAt: at(n), updatedAt: at(n), ...extra,
});
const workflow = (sessionId, parentSessionId, n, status, extra = {}) => agent(sessionId, parentSessionId, n, status, {
    sessionKind: "workflow", title: "Workflow: check-items", ...extra,
});

const ids = flat => flat.map(entry => entry.sessionId);
const shape = flat => flat.map(entry => `${entry.depth}:${entry.sessionId}`);
const open = (...parentIds) => ({ openTerminatedIds: new Set(parentIds) });

// One parent, children created in this order (today's order, since none has a saved place): live and finished agents
// and Workflows interleaved, every terminal status present.
const DEPTH_ONE = [
    session("P"),
    agent("a1", "P", 1, "running"),
    workflow("w1", "P", 2, "completed"),
    agent("a2", "P", 3, "completed"),
    workflow("w2", "P", 4, "running"),
    agent("a3", "P", 5, "failed", { title: "Nightly cleanup" }),
    workflow("w3", "P", 6, "cancelled"),
    agent("a4", "P", 7, "idle"),
    workflow("w4", "P", 8, "error"),
];

// A finished Workflow (wT) with its own live and finished children, under a parent with one live child.
const DEPTH_TWO = [
    session("P"),
    agent("a1", "P", 1, "running"),
    workflow("wT", "P", 2, "completed"),
    agent("x1", "wT", 3, "running"),
    workflow("x2", "wT", 4, "completed"),
    agent("x3", "wT", 5, "failed", { title: "Deep failure" }),
    workflow("x4", "wT", 6, "running"),
];

function loaded(sessions) {
    let state = appReducer(createInitialState({ mode: "local" }), { type: "ui/sessionViewDevice", device: "desktop" });
    state = appReducer(state, { type: "sessions/loaded", sessions });
    return state;
}

function expandAll(state) {
    let next = state;
    for (const id of [...next.sessions.collapsedIds]) next = appReducer(next, { type: "sessions/expand", sessionId: id });
    return next;
}

/** The same state with its tree rebuilt with these Terminated rows open (Task 2 adds the actions that do this). */
function withOpenTerminated(state, ...parentIds) {
    const { sessions } = state;
    return {
        ...state,
        sessions: {
            ...sessions,
            flat: buildSessionTree(Object.values(sessions.byId), sessions.collapsedIds, sessions.orderById, sessions.pinnedIds,
                sessions.manualOrder, open(...parentIds)),
        },
    };
}

const rowOf = (rows, sessionId) => rows.find(row => row.sessionId === sessionId);

test("the terminal set and the virtual row ids live in one module (R3, R4)", () => {
    assert.deepEqual([...core.TERMINAL_SESSION_STATUSES].sort(), ["cancelled", "completed", "error", "failed"]);
    for (const status of ["completed", "cancelled", "failed", "error"]) assert.equal(core.isTerminalSession({ status }), true, status);
    for (const status of ["idle", "running", "waiting", "pending", "input_required", undefined]) {
        assert.equal(core.isTerminalSession({ status }), false, String(status));
    }
    assert.equal(core.terminatedRowId("P"), "terminated:P");
    assert.equal(core.isTerminatedRowId("terminated:P"), true);
    assert.equal(core.isTerminatedRowId("P"), false);
    assert.equal(core.isTerminatedRowId(null), false);
    assert.equal(core.terminatedRowParentId("terminated:P"), "P");
    assert.equal(core.terminatedRowParentId("group:g1"), null);
    assert.equal(core.terminatedRowParentId("P"), null);
    assert.equal(core.isVirtualSessionRowId("terminated:P"), true);
    assert.equal(core.isVirtualSessionRowId("group:g1"), true);
    assert.equal(core.isVirtualSessionRowId("P"), false);
    assert.equal(core.isVirtualSessionRowId(undefined), false);
});

test("a child list reads live Workflows, live others, then one closed Terminated row (R2, depth 1)", () => {
    const flat = buildSessionTree(DEPTH_ONE, new Set());
    assert.deepEqual(shape(flat), ["0:P", "1:w2", "1:a1", "1:a4", "1:terminated:P"]);
    const row = flat.at(-1);
    assert.equal(row.collapsed, true, "closed by default");
    assert.equal(row.hasChildren, true);
    assert.equal(row.standIn.sessionId, "terminated:P", "the row builder needs no byId lookup");
    assert.deepEqual(row.virtual, {
        kind: "terminated", parentSessionId: "P", count: 5, failed: 2, text: "Terminated 5 · 2 failed",
        memberIds: ["w1", "w3", "w4", "a2", "a3"],
    });
    assert.equal(flat[0].hasChildren, true);
});

test("an open Terminated row lists Workflows, then the others, one level deeper (R2)", () => {
    const flat = buildSessionTree(DEPTH_ONE, new Set(), [], null, null, open("P"));
    assert.deepEqual(shape(flat), ["0:P", "1:w2", "1:a1", "1:a4", "1:terminated:P", "2:w1", "2:w3", "2:w4", "2:a2", "2:a3"]);
    assert.equal(flat[4].collapsed, false);
    // An array of open parents works too (the profile stores an array).
    assert.deepEqual(ids(buildSessionTree(DEPTH_ONE, new Set(), [], null, null, { openTerminatedIds: ["P"] })), ids(flat));
});

test("each band keeps today's order: a stable partition of sortSessions (R2)", () => {
    // A saved order that reverses creation: the bands keep it.
    const orderSource = { P: 0, w4: 1, a4: 2, w3: 3, a3: 4, w2: 5, a2: 6, w1: 7, a1: 8 };
    const flat = buildSessionTree(DEPTH_ONE, new Set(), orderSource, null, null, open("P"));
    assert.deepEqual(ids(flat), ["P", "w2", "a4", "a1", "terminated:P", "w4", "w3", "w1", "a3", "a2"]);
});

test("the same algorithm applies to children of children (R2, depth 2)", () => {
    const closed = buildSessionTree(DEPTH_TWO, new Set());
    assert.deepEqual(shape(closed), ["0:P", "1:a1", "1:terminated:P"]);
    const outerOnly = buildSessionTree(DEPTH_TWO, new Set(), [], null, null, open("P"));
    assert.deepEqual(shape(outerOnly), ["0:P", "1:a1", "1:terminated:P", "2:wT", "3:x4", "3:x1", "3:terminated:wT"]);
    const both = buildSessionTree(DEPTH_TWO, new Set(), [], null, null, open("P", "wT"));
    assert.deepEqual(shape(both), ["0:P", "1:a1", "1:terminated:P", "2:wT", "3:x4", "3:x1", "3:terminated:wT", "4:x2", "4:x3"]);
    assert.deepEqual(both.find(entry => entry.sessionId === "terminated:wT").virtual,
        { kind: "terminated", parentSessionId: "wT", count: 2, failed: 1, text: "Terminated 2 · 1 failed", memberIds: ["x2", "x3"] });
    // A collapsed member hides its own children and its own Terminated row.
    const collapsedMember = buildSessionTree(DEPTH_TWO, new Set(["wT"]), [], null, null, open("P", "wT"));
    assert.deepEqual(ids(collapsedMember), ["P", "a1", "terminated:P", "wT"]);
});

test("every terminal status goes under Terminated; other statuses stay live (R3)", () => {
    for (const status of ["completed", "cancelled", "failed", "error"]) {
        const flat = buildSessionTree([session("P"), agent("c", "P", 1, status)], new Set(), [], null, null, open("P"));
        assert.deepEqual(shape(flat), ["0:P", "1:terminated:P", "2:c"], status);
    }
    for (const status of ["idle", "running", "waiting", "input_required"]) {
        const flat = buildSessionTree([session("P"), agent("c", "P", 1, status)], new Set(), [], null, null, open("P"));
        assert.deepEqual(shape(flat), ["0:P", "1:c"], status);
    }
});

test("a parent with only finished children shows just the Terminated row; none finished, no row (R2)", () => {
    const onlyDone = buildSessionTree([session("P"), agent("c1", "P", 1, "completed"), workflow("c2", "P", 2, "cancelled")], new Set());
    assert.deepEqual(shape(onlyDone), ["0:P", "1:terminated:P"]);
    assert.equal(onlyDone[0].hasChildren, true);
    const noneDone = buildSessionTree([session("P"), agent("c1", "P", 1, "running"), workflow("c2", "P", 2, "running")], new Set());
    assert.deepEqual(ids(noneDone), ["P", "c2", "c1"], "Workflows first even when nothing is finished");
});

test("top-level rows and folder members are unchanged; system sessions' children are grouped (R1)", () => {
    const sessions = [
        session("done-root", { status: "completed", createdAt: at(1), updatedAt: at(1) }),
        session("live-root", { createdAt: at(2), updatedAt: at(2) }),
        { sessionId: "group:g1", groupId: "g1", isGroup: true, title: "Folder", status: "group", createdAt: at(3), updatedAt: at(3) },
        session("m1", { groupId: "g1", status: "completed", createdAt: at(4), updatedAt: at(4) }),
        session("m2", { groupId: "g1", sessionKind: "workflow", status: "running", createdAt: at(5), updatedAt: at(5) }),
        session("m3", { groupId: "g1", status: "running", createdAt: at(6), updatedAt: at(6) }),
        session("sys", { isSystem: true, title: "PilotSwarm" }),
        agent("sys-child", "sys", 7, "completed"),
    ];
    const flat = buildSessionTree(sessions, new Set());
    assert.deepEqual(shape(flat), ["0:sys", "1:terminated:sys", "0:group:g1", "1:m1", "1:m2", "1:m3", "0:done-root", "0:live-root"]);
    assert.ok(!ids(flat).includes("terminated:group:g1"), "a folder has no Terminated row");
});

test("manual order and pins still place the top-level rows (R1)", () => {
    const sessions = [
        session("A", { createdAt: at(1), updatedAt: at(1) }),
        session("B", { createdAt: at(2), updatedAt: at(2) }),
        session("C", { createdAt: at(3), updatedAt: at(3) }),
        agent("a-done", "A", 4, "completed"),
        agent("a-live", "A", 5, "running"),
    ];
    // A stray child id in the manual order never reorders children.
    const flat = buildSessionTree(sessions, new Set(), [], ["A"], ["C", "B", "a-done", "A"], open("A"));
    assert.deepEqual(ids(flat), ["A", "a-live", "terminated:A", "a-done", "C", "B"]);
    const unpinned = buildSessionTree(sessions, new Set(), [], null, ["C", "B", "A"]);
    assert.deepEqual(ids(unpinned), ["C", "B", "A", "a-live", "terminated:A"]);
});

test("the Terminated row's words come from one place: `Terminated 8 · 1 failed` (R5)", () => {
    assert.deepEqual(core.terminatedRowWords({ count: 8, failed: 1 }), { label: "Terminated 8", failed: "1 failed", text: "Terminated 8 · 1 failed" });
    assert.deepEqual(core.terminatedRowWords({ count: 2, failed: 0 }), { label: "Terminated 2", failed: null, text: "Terminated 2" });
    assert.equal(core.terminatedRowWords({ count: 1500, failed: 12 }).text, "Terminated 1,500 · 12 failed");
});

test("the list row: muted Terminated text, a disclosure mark, no status, owner, pin, badge or drag (R4, R5)", () => {
    const state = expandAll(loaded(DEPTH_ONE));
    const rows = selectSessionRows(state);
    assert.deepEqual(rows.map(row => row.sessionId), ["P", "w2", "a1", "a4", "terminated:P"]);
    const row = rowOf(rows, "terminated:P");
    assert.equal(row.chrome.kind, "terminated");
    assert.equal(row.chrome.title, "Terminated 5 · 2 failed");
    assert.ok(row.text.endsWith("▸ Terminated 5 · 2 failed"), row.text);
    assert.deepEqual(row.virtual, { kind: "terminated", parentSessionId: "P", count: 5, failed: 2 });
    assert.equal(row.depth, 1);
    assert.equal(row.collapsed, true);
    assert.equal(row.hasChildren, true);
    assert.ok(row.runs.some(run => run.role === "disclosure" && run.text.trim() === "▸"));
    assert.ok(!row.runs.some(run => run.role === "status"), "no status mark");
    assert.ok(!row.runs.some(run => run.role === "collapseBadge"), "no [+N]: its count is its text");
    assert.ok(!row.runs.some(run => run.ownerChip), "no owner chip");
    assert.equal(row.chrome.childBadge, null);
    assert.equal(row.chrome.owner, null);
    assert.equal(row.ownerBadge, null);
    assert.equal(row.isGroup, false);
    assert.equal(row.isSystem, false);
    assert.equal(row.canPin, false);
    assert.equal(row.pinned, false);
    assert.equal(row.orderable, false);
    assert.equal(row.orderContainer, null);
    assert.equal(row.canvasMark, null);
    assert.equal(row.searchMatch, false);
    // Open: the mark turns, the members follow one level deeper.
    const openRows = selectSessionRows(withOpenTerminated(state, "P"));
    const openRow = rowOf(openRows, "terminated:P");
    assert.equal(openRow.collapsed, false);
    assert.ok(openRow.text.endsWith("▾ Terminated 5 · 2 failed"), openRow.text);
    assert.deepEqual(openRows.map(row => `${row.depth}:${row.sessionId}`),
        ["0:P", "1:w2", "1:a1", "1:a4", "1:terminated:P", "2:w1", "2:w3", "2:w4", "2:a2", "2:a3"]);
    // No failures: no "failed" words at all.
    const calm = selectSessionRows(expandAll(loaded([session("Q"), agent("q1", "Q", 1, "completed"), agent("q2", "Q", 2, "cancelled")])));
    const calmRow = rowOf(calm, "terminated:Q");
    assert.equal(calmRow.chrome.title, "Terminated 2");
    assert.ok(!calmRow.text.includes("failed"), calmRow.text);
});

test("a parent's [+N] counts the members of a closed Terminated row as hidden (R8)", () => {
    const state = expandAll(loaded(DEPTH_TWO));
    const badge = row => row.titleRuns.find(run => run.role === "collapseBadge")?.text.trim() ?? null;
    const closedRows = selectSessionRows(state);
    assert.equal(badge(rowOf(closedRows, "P")), "[+5]", "wT and its four children are not shown");
    assert.equal(badge(rowOf(closedRows, "terminated:P")), null);
    const openRows = selectSessionRows(withOpenTerminated(state, "P"));
    assert.equal(badge(rowOf(openRows, "P")), "[+2]", "x2 and x3 sit in wT's closed Terminated row");
    assert.equal(badge(rowOf(openRows, "wT")), "[+2]");
    const allOpen = selectSessionRows(withOpenTerminated(state, "P", "wT"));
    assert.equal(badge(rowOf(allOpen, "P")), null);
    assert.equal(badge(rowOf(allOpen, "wT")), null);
});

test("search finds a member under an open Terminated row; the virtual row is never a match (R9)", () => {
    const state = expandAll(loaded(DEPTH_ONE));
    const found = selectSessionRows(appReducer(state, { type: "sessions/filterQuery", query: "nightly cleanup" }));
    assert.deepEqual(found.map(row => `${row.depth}:${row.sessionId}`), ["0:P", "1:terminated:P", "2:a3"]);
    assert.equal(rowOf(found, "terminated:P").collapsed, false, "shown open");
    assert.equal(rowOf(found, "terminated:P").searchMatch, false);
    assert.equal(rowOf(found, "terminated:P").searchScore, 0);
    assert.equal(rowOf(found, "a3").searchMatch, true);
    // The row's own words match nothing.
    assert.deepEqual(selectSessionRows(appReducer(state, { type: "sessions/filterQuery", query: "terminated" })), []);
    // Deeper: the match shows with every real ancestor and both Terminated rows.
    const deep = selectSessionRows(appReducer(expandAll(loaded(DEPTH_TWO)), { type: "sessions/filterQuery", query: "deep failure" }));
    assert.deepEqual(deep.map(row => `${row.depth}:${row.sessionId}`), ["0:P", "1:terminated:P", "2:wT", "3:terminated:wT", "4:x3"]);
    // Search runs on the whole catalog: a collapsed parent does not hide a finished member.
    const fromClosed = selectSessionRows(appReducer(loaded(DEPTH_ONE), { type: "sessions/filterQuery", query: "nightly cleanup" }));
    assert.deepEqual(fromClosed.map(row => row.sessionId), ["P", "terminated:P", "a3"]);
});

const ME = { provider: "github", subject: "me", displayName: "Me", email: "me@example.com" };
const BOB = { provider: "github", subject: "bob", displayName: "Bob", email: "bob@example.com" };
const ONLY_ME = { all: false, includeSystem: false, includeUnowned: false, includeMe: true, includeShared: false, ownerKeys: [] };

function filtered(sessions, extra = {}) {
    let state = createInitialState();
    state = appReducer(state, { type: "auth/context", principal: ME, authorization: { role: "user" } });
    state = appReducer(state, { type: "sessions/ownerFilter", filter: ONLY_ME });
    state = appReducer(state, { type: "sessions/loaded", sessions });
    state = expandAll(state);
    return { ...state, sessions: { ...state.sessions, ...extra } };
}

test("owner filter: the Terminated row follows its parent and counts only members that pass (R10)", () => {
    const sessions = [
        session("P", { owner: ME }),
        agent("p-live", "P", 1, "running"),
        agent("p-done", "P", 2, "completed", { owner: BOB }),
        agent("p-fail", "P", 3, "failed"),
        session("Q", { owner: BOB, createdAt: at(10), updatedAt: at(10) }),
        agent("q-live", "Q", 11, "running", { owner: BOB }),
        agent("q-bob", "Q", 12, "failed", { owner: BOB }),
        agent("q-mine", "Q", 13, "completed", { owner: ME, title: "Mine under Bob" }),
    ];
    const state = filtered(sessions);
    const rows = selectSessionRows(state);
    // P passes: every member passes with it (an ancestor that passes admits its children).
    assert.deepEqual(rowOf(rows, "terminated:P").virtual, { kind: "terminated", parentSessionId: "P", count: 2, failed: 1 });
    // Q is hidden, so its Terminated row is too.
    assert.equal(rowOf(rows, "Q"), undefined);
    assert.equal(rowOf(rows, "terminated:Q"), undefined);
    // Q shown by a deep link's exception: the row counts only q-mine (q-bob does not pass the filter).
    const linked = selectSessionRows({ ...state, sessions: { ...state.sessions, filterExceptionId: "q-live" } });
    assert.ok(rowOf(linked, "Q"));
    assert.deepEqual(rowOf(linked, "terminated:Q").virtual, { kind: "terminated", parentSessionId: "Q", count: 1, failed: 0 });
    assert.equal(rowOf(linked, "terminated:Q").chrome.title, "Terminated 1");
    // No member passes: no row.
    const noneMine = filtered(sessions.filter(item => item.sessionId !== "q-mine"), { filterExceptionId: "q-live" });
    const noneRows = selectSessionRows(noneMine);
    assert.ok(rowOf(noneRows, "Q"));
    assert.equal(rowOf(noneRows, "terminated:Q"), undefined);
    // Search under an owner filter: the count is of members that pass it.
    const searched = selectSessionRows(appReducer(state, { type: "sessions/filterQuery", query: "mine under bob" }));
    assert.deepEqual(searched.map(row => row.sessionId), ["Q", "terminated:Q", "q-mine"]);
    assert.deepEqual(rowOf(searched, "terminated:Q").virtual, { kind: "terminated", parentSessionId: "Q", count: 1, failed: 0 });
});

test("Workflow numbers do not move when finished Workflows go under Terminated (R13)", () => {
    const sessions = [
        session("P"),
        workflow("wf-1", "P", 1, "completed"),
        workflow("wf-2", "P", 2, "failed"),
        workflow("wf-3", "P", 3, "running"),
    ];
    const rows = selectSessionRows(withOpenTerminated(expandAll(loaded(sessions)), "P"));
    assert.deepEqual(rows.map(row => row.sessionId), ["P", "wf-3", "terminated:P", "wf-1", "wf-2"]);
    assert.equal(rowOf(rows, "wf-3").chrome.title, "check-items #3");
    assert.equal(rowOf(rows, "wf-1").chrome.title, "check-items #1");
    assert.equal(rowOf(rows, "wf-2").chrome.title, "check-items #2");
});

test("the first load still ranks finished children in today's order, and ranks no virtual row", () => {
    // Listed newest first: the saved order must still be oldest first, as the tree shows it.
    const state = loaded([session("P"), agent("c-new", "P", 3, "completed"), agent("c-old", "P", 1, "completed")]);
    const { orderById } = state.sessions;
    assert.ok(orderById["c-old"] < orderById["c-new"], JSON.stringify(orderById));
    assert.ok(!Object.keys(orderById).some(id => core.isVirtualSessionRowId(id)), JSON.stringify(orderById));
    const rows = selectSessionRows(withOpenTerminated(expandAll(state), "P"));
    assert.deepEqual(rows.map(row => row.sessionId), ["P", "terminated:P", "c-old", "c-new"]);
});

test("the first load ranks every child in today's unbanded order, so a Workflow that finishes keeps its place (R2)", () => {
    // Today's order (no saved places) is creation order. The bands must not leak into the saved ranks: a newer live
    // Workflow is shown first while it runs, but its rank stays after the older Workflow it was created after.
    const sessions = [
        session("P"),
        workflow("w-old", "P", 1, "completed"),
        agent("a-live", "P", 2, "running"),
        workflow("w-new", "P", 3, "running"),
        agent("a-done", "P", 4, "failed"),
        workflow("w-kid-done", "a-live", 5, "cancelled"),
        agent("a-kid-live", "a-live", 6, "running"),
        workflow("w-kid-live", "a-live", 7, "running"),
    ];
    const state = expandAll(loaded(sessions));
    const { orderById } = state.sessions;
    const ranked = Object.keys(orderById).sort((a, b) => orderById[a] - orderById[b]);
    assert.deepEqual(ranked, ["P", "w-old", "a-live", "w-kid-done", "a-kid-live", "w-kid-live", "w-new", "a-done"]);
    // The list shows the bands.
    assert.deepEqual(selectSessionRows(withOpenTerminated(state, "P", "a-live")).map(row => row.sessionId),
        ["P", "w-new", "a-live", "w-kid-live", "a-kid-live", "terminated:a-live", "w-kid-done", "terminated:P", "w-old", "a-done"]);
    // w-new finishes: in the Terminated band it follows the older w-old, as today's order has it.
    const finished = appReducer(state, { type: "sessions/merged", session: { sessionId: "w-new", status: "completed" } });
    assert.ok(finished.sessions.orderById["w-old"] < finished.sessions.orderById["w-new"], JSON.stringify(finished.sessions.orderById));
    assert.deepEqual(selectSessionRows(withOpenTerminated(finished, "P")).map(row => row.sessionId),
        ["P", "a-live", "w-kid-live", "a-kid-live", "terminated:a-live", "terminated:P", "w-old", "w-new", "a-done"]);
    // a-kid-live finishes: it follows w-kid-done (Workflows first), and w-kid-live stays live.
    const kidDone = appReducer(finished, { type: "sessions/merged", session: { sessionId: "a-kid-live", status: "completed" } });
    assert.deepEqual(selectSessionRows(withOpenTerminated(kidDone, "a-live")).map(row => row.sessionId),
        ["P", "a-live", "w-kid-live", "terminated:a-live", "w-kid-done", "a-kid-live", "terminated:P"]);
});

test("owner filter: a hidden Terminated row hides its members and their subtrees, open or closed (R10)", () => {
    const sessions = [
        session("Q", { owner: BOB }),
        agent("q-live", "Q", 1, "running", { owner: BOB }),
        agent("q-bob", "Q", 2, "failed", { owner: BOB }),
        agent("q-bob-kid", "q-bob", 3, "running", { owner: ME, title: "Mine under Bob's failure" }),
        agent("q-mine", "Q", 4, "completed", { owner: ME, title: "Mine under Bob" }),
        agent("q-mine-kid", "q-mine", 5, "running", { owner: ME, title: "Mine, deeper" }),
        session("R", { owner: ME, createdAt: at(10), updatedAt: at(10) }),
    ];
    // Q is hidden, so its Terminated row is hidden, open or not; q-mine passes but must not show without it, and nor
    // must the passing sessions deeper inside the group.
    const hiddenParent = withOpenTerminated(filtered(sessions), "Q");
    assert.ok(hiddenParent.sessions.flat.some(entry => entry.sessionId === "q-mine-kid"), "the tree holds the open group");
    assert.deepEqual(selectSessionRows(hiddenParent).map(row => row.sessionId), ["R"]);
    // Q shown by a deep link, but no direct member passes: no Terminated row, and nothing from inside it. Q's [+N]
    // counts what that hides (q-bob and q-bob-kid), the same whether the hidden row is open or closed (R8).
    const badge = row => row?.titleRuns.find(run => run.role === "collapseBadge")?.text.trim() ?? null;
    const noMemberClosed = filtered(sessions.filter(item => item.sessionId !== "q-mine"), { filterExceptionId: "q-live" });
    const noMember = withOpenTerminated(noMemberClosed, "Q");
    const noMemberRows = selectSessionRows(noMember);
    assert.deepEqual(noMemberRows.map(row => `${row.depth}:${row.sessionId}`), ["0:Q", "1:q-live", "0:R"]);
    assert.equal(badge(rowOf(noMemberRows, "Q")), "[+2]");
    assert.equal(badge(rowOf(selectSessionRows(noMemberClosed), "Q")), "[+2]");
    // Q shown and q-mine passes: the row and q-mine's subtree show under it; the rows after the group are unaffected.
    const shown = withOpenTerminated(filtered(sessions, { filterExceptionId: "q-live" }), "Q");
    const shownRows = selectSessionRows(shown).map(row => `${row.depth}:${row.sessionId}`);
    assert.ok(shownRows.includes("1:terminated:Q") && shownRows.includes("2:q-mine") && shownRows.includes("3:q-mine-kid"), shownRows.join());
    assert.equal(shownRows.at(-1), "0:R");
    // Search keeps the same rule. q-bob-kid matches and passes, but it sits inside a Terminated row with no member that
    // passes, so that row does not show, nor anything inside it, nor ancestors kept only to hold it.
    const contextOnly = filtered(sessions.filter(item => item.sessionId !== "q-mine"));
    const searched = selectSessionRows(appReducer(contextOnly, { type: "sessions/filterQuery", query: "mine under bob's failure" }));
    assert.deepEqual(searched.map(row => `${row.depth}:${row.sessionId}`), []);
    // A deep link to it is the explicit exception: its chain passes, so the row shows and counts q-bob.
    const linkedSearch = appReducer(contextOnly, { type: "sessions/filterQuery", query: "mine under bob's failure" });
    const linkedRows = selectSessionRows({ ...linkedSearch, sessions: { ...linkedSearch.sessions, filterExceptionId: "q-bob-kid" } });
    assert.deepEqual(linkedRows.map(row => `${row.depth}:${row.sessionId}`), ["0:Q", "1:terminated:Q", "2:q-bob", "3:q-bob-kid"]);
    assert.deepEqual(rowOf(linkedRows, "terminated:Q").virtual, { kind: "terminated", parentSessionId: "Q", count: 1, failed: 1 });
});

test("owner filter under search: a match's ancestor that does not pass is shown but not counted (R9, R10)", () => {
    const sessions = [
        session("Q", { owner: BOB }),
        agent("q-live", "Q", 1, "running", { owner: BOB }),
        agent("q-bob", "Q", 2, "failed", { owner: BOB }),
        agent("q-bob-kid", "q-bob", 3, "running", { owner: ME, title: "Orphaned nightly report" }),
        agent("q-mine", "Q", 4, "completed", { owner: ME, title: "Mine under Bob" }),
        session("R", { owner: ME, createdAt: at(10), updatedAt: at(10) }),
    ];
    const state = appReducer(filtered(sessions), { type: "sessions/filterQuery", query: "orphaned nightly report" });
    const rows = selectSessionRows(state);
    // q-mine passes, so the Terminated row shows; q-bob is there only as the match's ancestor.
    assert.deepEqual(rows.map(row => `${row.depth}:${row.sessionId}`), ["0:Q", "1:terminated:Q", "2:q-bob", "3:q-bob-kid"]);
    assert.equal(rowOf(rows, "q-bob-kid").searchMatch, true);
    // The count and the failed count are of members that pass the filter: q-mine only, not the failed q-bob.
    assert.deepEqual(rowOf(rows, "terminated:Q").virtual, { kind: "terminated", parentSessionId: "Q", count: 1, failed: 0 });
    assert.equal(rowOf(rows, "terminated:Q").chrome.title, "Terminated 1");
    // With no owner filter, the count is every member, under search as without it.
    const everyone = selectSessionRows(appReducer(state, { type: "sessions/ownerFilter", filter: { all: true } }));
    assert.deepEqual(rowOf(everyone, "terminated:Q").virtual, { kind: "terminated", parentSessionId: "Q", count: 2, failed: 1 });
});
