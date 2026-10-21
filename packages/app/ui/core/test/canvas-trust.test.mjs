// Canvas app registry (issue 181): the trust of a canvas revision in the
// client store. Three rules are pinned here:
//   1. fail closed: only "owner" and "agent" frame a page directly; a missing
//      or unknown trust is another user's page ("cross-owner");
//   2. trust belongs to a revision: the session-list seed that raises a
//      slot's revision drops the old revision's trust, page hash and app, so
//      they never stand for the new page;
//   3. a snapshot older than what the store knows keeps the store's trust as
//      it is, with no default: an unclassified revision stays unclassified,
//      and the canvas frame waits instead of guessing.
import test from "node:test";
import assert from "node:assert/strict";

import { appReducer, createInitialState } from "../src/index.js";
import { selectCanvasView } from "../src/selectors.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function stateWithSession(id = "s1") {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: id, title: "One", status: "running" }] });
    return appReducer(state, { type: "sessions/selected", sessionId: id });
}

const entry = (state, key = "s1") => state.canvas.bySessionId[key];
const seed = (state, rows) => appReducer(state, { type: "canvas/seed", entries: rows });

test("a draw event's trust maps fail-closed: only owner and agent stand; missing or unknown is cross-owner", () => {
    const cases = [
        ["owner", "owner"],
        ["agent", "agent"],
        ["cross-owner", "cross-owner"],
        [undefined, "cross-owner"],
        [null, "cross-owner"],
        ["", "cross-owner"],
        ["admin", "cross-owner"],
        [7, "cross-owner"],
    ];
    for (const [given, expected] of cases) {
        for (const type of ["canvas/updated", "canvas/snapshot"]) {
            const state = appReducer(stateWithSession(), { type, sessionId: "s1", rev: 3, sizeBytes: 10, trust: given, pageSha256: SHA_A });
            assert.equal(entry(state).trust, expected, `${type} with trust ${JSON.stringify(given)}`);
            assert.equal(entry(state).pageSha256, SHA_A);
            assert.equal(selectCanvasView(state).trust, expected, `the view agrees for ${JSON.stringify(given)}`);
        }
    }
});

test("the app and page hash ride the revision; malformed ones are dropped", () => {
    let state = appReducer(stateWithSession(), {
        type: "canvas/updated", sessionId: "s1", rev: 1, trust: "cross-owner", pageSha256: SHA_A, app: { name: "board", version: "1.0.0" },
    });
    assert.deepEqual(entry(state).app, { name: "board", version: "1.0.0" });
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 2, trust: "owner", pageSha256: 42, app: "board" });
    assert.equal(entry(state).trust, "owner");
    assert.equal(entry(state).pageSha256, null);
    assert.equal(entry(state).app, null);
});

test("the seed names a revision without classifying it", () => {
    const state = seed(stateWithSession(), [{ sessionId: "s1", slot: 1, latestRev: 4, name: "board", sizeBytes: 900 }]);
    assert.equal(entry(state).latestRev, 4);
    assert.equal(entry(state).trust, undefined, "no trust: the frame must wait for the draw event");
    assert.equal(entry(state).pageSha256, undefined);
    assert.equal(entry(state).snapshotLoaded, undefined);
    assert.equal(selectCanvasView(state).trust, "cross-owner", "the view reads an unclassified revision as sealed");
});

test("a seed that raises the revision drops the old revision's trust, page hash and app", () => {
    let state = appReducer(stateWithSession(), {
        type: "canvas/updated", sessionId: "s1", rev: 2, sizeBytes: 10, trust: "owner", pageSha256: SHA_A, app: { name: "board", version: "1.0.0" },
    });
    state = seed(state, [{ sessionId: "s1", slot: 1, latestRev: 3, name: "board", sizeBytes: 11 }]);
    assert.equal(entry(state).latestRev, 3);
    assert.equal("trust" in entry(state), false, "rev 2's trust must not stand for rev 3");
    assert.equal("pageSha256" in entry(state), false, "rev 2's hash must not stand for rev 3");
    assert.equal("app" in entry(state), false);
});

test("a seed at the same or an older revision keeps the trust the store has", () => {
    for (const latestRev of [2, 1]) {
        let state = appReducer(stateWithSession(), {
            type: "canvas/updated", sessionId: "s1", rev: 2, sizeBytes: 10, trust: "owner", pageSha256: SHA_A,
        });
        state = seed(state, [{ sessionId: "s1", slot: 1, latestRev, name: "renamed", sizeBytes: 10 }]);
        assert.equal(entry(state).latestRev, 2);
        assert.equal(entry(state).trust, "owner", `seed rev ${latestRev}`);
        assert.equal(entry(state).pageSha256, SHA_A, `seed rev ${latestRev}`);
    }
});

test("slot 2 follows the same rules as slot 1", () => {
    let state = appReducer(stateWithSession(), {
        type: "canvas/updated", sessionId: "s1", slot: 2, rev: 5, sizeBytes: 10, trust: "cross-owner", pageSha256: SHA_A,
    });
    const key = Object.keys(state.canvas.bySessionId).find((k) => k !== "s1" && state.canvas.bySessionId[k].slot === 2);
    assert.ok(key, "a slot-2 entry exists");
    assert.equal(entry(state, key).trust, "cross-owner");
    state = seed(state, [{ sessionId: "s1", slot: 2, latestRev: 6, name: "two", sizeBytes: 10 }]);
    assert.equal(entry(state, key).latestRev, 6);
    assert.equal("trust" in entry(state, key), false);
    state = appReducer(state, { type: "canvas/snapshot", sessionId: "s1", slot: 2, rev: 6, sizeBytes: 10, trust: "cross-owner", pageSha256: SHA_B });
    assert.equal(entry(state, key).trust, "cross-owner");
    assert.equal(entry(state, key).pageSha256, SHA_B);
});

test("a snapshot older than the seeded revision leaves it unclassified (no default)", () => {
    let state = seed(stateWithSession(), [{ sessionId: "s1", slot: 1, latestRev: 5, name: "board", sizeBytes: 10 }]);
    state = appReducer(state, { type: "canvas/snapshot", sessionId: "s1", rev: 4, sizeBytes: 10, trust: "agent", pageSha256: SHA_A });
    assert.equal(entry(state).latestRev, 5, "never regresses");
    assert.equal(entry(state).trust, undefined, "rev 4's trust must not stand for rev 5, and there is no default");
    assert.equal(entry(state).snapshotLoaded, true);
    // The draw event for rev 5 itself then classifies it (same revision).
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 5, sizeBytes: 12, trust: "owner", pageSha256: SHA_B, note: "five" });
    assert.equal(entry(state).latestRev, 5);
    assert.equal(entry(state).trust, "owner");
    assert.equal(entry(state).pageSha256, SHA_B);
    assert.equal(entry(state).note, "five", "the revision's own metadata lands with its trust");
});

test("loaded r2, then seed r3, then the live draw event for r3: r3 is classified, and the memo is re-armed", () => {
    let state = appReducer(stateWithSession(), {
        type: "canvas/snapshot", sessionId: "s1", rev: 2, sizeBytes: 10, trust: "owner", pageSha256: SHA_A, responseContract: { actions: { a: {} } },
    });
    assert.equal(entry(state).snapshotLoaded, true);
    state = seed(state, [{ sessionId: "s1", slot: 1, latestRev: 3, name: "new", sizeBytes: 10 }]);
    assert.equal(entry(state).latestRev, 3);
    assert.equal(entry(state).trust, undefined);
    assert.equal(entry(state).snapshotLoaded, false, "a newer revision makes the snapshot memo stale");
    state = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 3, sizeBytes: 11, trust: "owner", pageSha256: SHA_B });
    assert.equal(entry(state).trust, "owner", "the live event for the seeded revision is not dropped");
    assert.equal(entry(state).pageSha256, SHA_B);
    assert.equal(entry(state).responseContract, null, "r2's contract does not stand for r3");
    // A replay of the same, now classified, revision changes nothing.
    const replay = appReducer(state, { type: "canvas/updated", sessionId: "s1", rev: 3, sizeBytes: 99, trust: "cross-owner", pageSha256: SHA_A });
    assert.equal(replay, state);
});

test("a seed that raises slot 2 re-arms the session memo on slot 1", () => {
    let state = appReducer(stateWithSession(), { type: "canvas/snapshot", sessionId: "s1", rev: 1, sizeBytes: 10, trust: "agent", pageSha256: SHA_A });
    state = appReducer(state, { type: "canvas/snapshot", sessionId: "s1", slot: 2, rev: 1, sizeBytes: 10, trust: "agent", pageSha256: SHA_A });
    assert.equal(entry(state).snapshotLoaded, true);
    state = seed(state, [{ sessionId: "s1", slot: 1, latestRev: 1, name: "one", sizeBytes: 10 }, { sessionId: "s1", slot: 2, latestRev: 2, name: "two", sizeBytes: 10 }]);
    assert.equal(entry(state).snapshotLoaded, false);
    assert.equal(entry(state).trust, "agent", "slot 1 did not change revision and keeps its trust");
    // A seed that names nothing new leaves the memo alone.
    let quiet = appReducer(stateWithSession(), { type: "canvas/snapshot", sessionId: "s1", rev: 4, sizeBytes: 10, trust: "agent", pageSha256: SHA_A });
    quiet = seed(quiet, [{ sessionId: "s1", slot: 1, latestRev: 4, name: "same", sizeBytes: 10 }]);
    assert.equal(entry(quiet).snapshotLoaded, true);
});

test("a snapshot read that leaves a seeded revision unclassified keeps the memo open, so the next read classifies it", async () => {
    const { PilotSwarmUiController, createStore } = await import("../src/index.js");
    const store = createStore(appReducer, seed(stateWithSession(), [{ sessionId: "s1", slot: 1, latestRev: 5, name: "board", sizeBytes: 10 }]));
    let reads = 0;
    let rows = [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 4, sizeBytes: 10, trust: "agent", pageSha256: SHA_A } }];
    const c = new PilotSwarmUiController({
        store,
        transport: {
            listSessions: async () => [], subscribeSession: () => () => {}, getCurrentUserProfile: async () => ({ profileSettings: {} }),
            getSessionEventsBefore: async (_id, _before, _limit, types) => { if (types[0] === "session.canvas_updated") reads += 1; return types[0] === "session.canvas_updated" ? rows : []; },
        },
    });
    await c.ensureCanvasSnapshot("s1");
    assert.equal(reads, 1);
    assert.equal(c.getState().canvas.bySessionId.s1.trust, undefined, "rev 4's trust does not stand for rev 5");
    assert.equal(c.getState().canvas.bySessionId.s1.snapshotLoaded, false, "the memo stays open");
    rows = [{ seq: 2, eventType: "session.canvas_updated", data: { slot: 1, rev: 5, sizeBytes: 10, trust: "owner", pageSha256: SHA_B } }];
    await c.ensureCanvasSnapshot("s1");
    assert.equal(reads, 2, "read again");
    assert.equal(c.getState().canvas.bySessionId.s1.trust, "owner");
    assert.equal(c.getState().canvas.bySessionId.s1.snapshotLoaded, true);
    await c.ensureCanvasSnapshot("s1");
    assert.equal(reads, 2, "classified: the memo holds again");
});

test("a snapshot older than a live draw keeps that draw's trust", () => {
    let state = appReducer(stateWithSession(), {
        type: "canvas/updated", sessionId: "s1", rev: 5, sizeBytes: 10, trust: "owner", pageSha256: SHA_A,
    });
    state = appReducer(state, { type: "canvas/snapshot", sessionId: "s1", rev: 4, sizeBytes: 10, trust: "cross-owner", pageSha256: SHA_B });
    assert.equal(entry(state).latestRev, 5);
    assert.equal(entry(state).trust, "owner");
    assert.equal(entry(state).pageSha256, SHA_A);
});

test("a snapshot at the seeded revision classifies it, legacy rows included", () => {
    let state = seed(stateWithSession(), [{ sessionId: "s1", slot: 1, latestRev: 5, name: "board", sizeBytes: 10 }]);
    state = appReducer(state, { type: "canvas/snapshot", sessionId: "s1", rev: 5, sizeBytes: 10, trust: "agent", pageSha256: SHA_A });
    assert.equal(entry(state).trust, "agent");
    assert.equal(entry(state).pageSha256, SHA_A);
    // A revision drawn before draw events carried trust: sealed, with no hash.
    let legacy = seed(stateWithSession(), [{ sessionId: "s1", slot: 1, latestRev: 5, name: "old", sizeBytes: 10 }]);
    legacy = appReducer(legacy, { type: "canvas/snapshot", sessionId: "s1", rev: 5, sizeBytes: 10 });
    assert.equal(entry(legacy).trust, "cross-owner");
    assert.equal(entry(legacy).pageSha256, null);
});

test("the live controller path carries the event's trust; an event without one is sealed", async () => {
    const { PilotSwarmUiController, createStore } = await import("../src/index.js");
    const store = createStore(appReducer, stateWithSession());
    const c = new PilotSwarmUiController({
        store,
        transport: { listSessions: async () => [], subscribeSession: () => () => {}, getCurrentUserProfile: async () => ({ profileSettings: {} }) },
    });
    const at = new Date().toISOString();
    c.applyCanvasUpdate("s1", { seq: 1, eventType: "session.canvas_updated", createdAt: at, data: { rev: 1, sizeBytes: 5, trust: "agent", pageSha256: SHA_A } });
    assert.equal(c.getState().canvas.bySessionId.s1.trust, "agent");
    c.applyCanvasUpdate("s1", { seq: 2, eventType: "session.canvas_updated", createdAt: at, data: { rev: 2, sizeBytes: 5 } });
    assert.equal(c.getState().canvas.bySessionId.s1.trust, "cross-owner");
    assert.equal(c.getState().canvas.bySessionId.s1.pageSha256, null);
});

// ── Finding the draw event of every known slot (review D1) ─────────────────

/** A transport over an in-memory draw-event log that honours beforeSeq and limit. */
function logTransport(log) {
    const calls = [];
    return {
        calls,
        transport: {
            listSessions: async () => [], subscribeSession: () => () => {}, getCurrentUserProfile: async () => ({ profileSettings: {} }),
            getSessionEventsBefore: async (_id, beforeSeq, limit, types) => {
                calls.push({ beforeSeq, type: types[0] });
                if (types[0] !== "session.canvas_updated") return [];
                return log.filter((e) => e.seq < beforeSeq).sort((a, b) => b.seq - a.seq).slice(0, limit);
            },
        },
    };
}

test("a known slot whose draw event is older than the newest 30 is found by paging back, classified, and then memoized", async () => {
    const { PilotSwarmUiController, createStore } = await import("../src/index.js");
    // Slot 2 drawn once (owner), long ago; then 100 draws of slot 1.
    const log = [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 2, rev: 1, sizeBytes: 10, trust: "owner", pageSha256: SHA_A } }];
    for (let i = 1; i <= 100; i++) log.push({ seq: 1 + i, eventType: "session.canvas_updated", data: { slot: 1, rev: i, sizeBytes: 10, trust: "agent", pageSha256: SHA_B } });
    const store = createStore(appReducer, seed(stateWithSession(), [
        { sessionId: "s1", slot: 1, latestRev: 100, name: "one", sizeBytes: 10 },
        { sessionId: "s1", slot: 2, latestRev: 1, name: "older-owner", sizeBytes: 10 },
    ]));
    const t = logTransport(log);
    const c = new PilotSwarmUiController({ store, transport: t.transport });
    await c.ensureCanvasSnapshot("s1");
    const s = c.getState().canvas.bySessionId;
    assert.equal(s.s1.trust, "agent");
    assert.equal(s["s1#2"].trust, "owner", "the older slot's own draw event classifies it");
    assert.equal(s.s1.snapshotLoaded, true, "every known slot is classified: the memo holds");
    const draws = t.calls.filter((x) => x.type === "session.canvas_updated").length;
    assert.equal(draws, 4, "pages back 30 at a time until slot 2 is found (seq 1 is in the 4th page)");
    await c.ensureCanvasSnapshot("s1");
    assert.equal(t.calls.filter((x) => x.type === "session.canvas_updated").length, draws, "memoized: no more reads");
});

test("paging back is bounded, and a known slot with no draw event at all does not re-arm the read", async () => {
    const { PilotSwarmUiController, createStore } = await import("../src/index.js");
    const log = [];
    for (let i = 1; i <= 1000; i++) log.push({ seq: i, eventType: "session.canvas_updated", data: { slot: 1, rev: i, sizeBytes: 10, trust: "agent", pageSha256: SHA_B } });
    const store = createStore(appReducer, seed(stateWithSession(), [
        { sessionId: "s1", slot: 1, latestRev: 1000, name: "one", sizeBytes: 10 },
        { sessionId: "s1", slot: 3, latestRev: 2, name: "lost", sizeBytes: 10 },
    ]));
    const t = logTransport(log);
    const c = new PilotSwarmUiController({ store, transport: t.transport });
    await c.ensureCanvasSnapshot("s1");
    assert.equal(t.calls.filter((x) => x.type === "session.canvas_updated").length, 10, "at most 10 pages of 30 draw events");
    assert.equal(c.getState().canvas.bySessionId["s1#3"].trust, undefined, "unclassified: sealed");
    assert.equal(c.getState().canvas.bySessionId.s1.snapshotLoaded, true, "no event found for it: another read would find the same nothing");
});

test("a revision the list names ahead of its draw event is re-read a bounded number of times", async () => {
    const { PilotSwarmUiController, createStore } = await import("../src/index.js");
    const log = [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 4, sizeBytes: 10, trust: "agent", pageSha256: SHA_A } }];
    const store = createStore(appReducer, seed(stateWithSession(), [{ sessionId: "s1", slot: 1, latestRev: 5, name: "ahead", sizeBytes: 10 }]));
    const t = logTransport(log);
    const c = new PilotSwarmUiController({ store, transport: t.transport });
    for (let i = 0; i < 9; i++) await c.ensureCanvasSnapshot("s1");
    const draws = t.calls.filter((x) => x.type === "session.canvas_updated").length;
    assert.equal(draws, 6, "the first read plus 5 re-reads, then the memo holds");
    assert.equal(c.getState().canvas.bySessionId.s1.trust, undefined, "still unclassified: sealed");
    // Retry reads again, explicitly.
    c.dispatch({ type: "canvas/snapshotInvalidate", sessionId: "s1" });
    log.push({ seq: 2, eventType: "session.canvas_updated", data: { slot: 1, rev: 5, sizeBytes: 10, trust: "owner", pageSha256: SHA_B } });
    await c.ensureCanvasSnapshot("s1");
    assert.equal(c.getState().canvas.bySessionId.s1.trust, "owner", "a Retry after the event lands classifies it");
});
