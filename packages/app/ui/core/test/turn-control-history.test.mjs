// Session turn control in the shared transcript: Stop and Steer items, their
// outcomes, and carried-steer labels from the closing record (P17). Bulk and
// live paths must agree, survive a reload, render each control once, and
// reconcile labels by seq across history pages.
import test from "node:test";
import assert from "node:assert/strict";
import {
    CHAT_HISTORY_EVENT_TYPES,
    PilotSwarmUiController,
    appReducer,
    appendEventToHistory,
    buildHistoryModel,
    createInitialState,
    createStore,
    resolveTurnControlOutcome,
    selectChatLines,
} from "../src/index.js";

const SID = "s1";
const BASE = Date.parse("2026-10-13T05:00:00Z");
function evt(seq, eventType, data = {}) {
    return { sessionId: SID, seq, eventType, data, createdAt: new Date(BASE + seq * 1000) };
}
const steer = (seq, text, turn = 1) => evt(seq, "user.steer", { turn, text, requestId: `r-${seq}`, actor: null });
const stop = (seq, turn = 1, text = "Stopped by user") => evt(seq, "user.stop", { turn, text, requestId: `r-${seq}`, actor: null });
const outcome = (seq, controlSeq, value, turn = 1) => evt(seq, "session.control_outcome", { seq: controlSeq, turn, outcome: value });
const closed = (seq, seqs, reason, turnIndex = 2) => evt(seq, "session.carried_steers_closed", { seqs, turnIndex, reason });

function live(events) {
    let history = { chat: [], activity: [], events: [], lastSeq: 0 };
    for (const event of events) history = appendEventToHistory(history, event);
    return history;
}
const controls = (history) => history.chat
    .filter((item) => item.kind === "turn-control" || item.kind === "turn-stop-legacy")
    .map((item) => ({ id: item.id, kind: item.kind === "turn-stop-legacy" ? "stop-legacy" : item.controlKind, outcome: resolveTurnControlOutcome(item) }));

function bothPaths(events) {
    const bulk = controls(buildHistoryModel(events));
    const appended = controls(live(events));
    assert.deepEqual(appended, bulk, "live append and bulk load agree");
    return bulk;
}

test("history paging requests every turn-control transcript input, never the confirmation", () => {
    for (const type of ["user.steer", "user.stop", "session.control_outcome", "session.carried_steers_closed"]) {
        assert.ok(CHAT_HISTORY_EVENT_TYPES.includes(type), type);
    }
    assert.equal(CHAT_HISTORY_EVENT_TYPES.includes("session.steer_confirmed"), false);
});

test("every steer outcome renders, bulk and live, once", () => {
    const events = [
        evt(1, "user.message", { content: "start" }),
        steer(2, "use metric"), steer(3, "also inches"), steer(4, "late one"), steer(5, "pending one"),
        outcome(6, 2, "delivered"), outcome(7, 3, "not_delivered"), outcome(8, 4, "carried"),
        evt(9, "session.steer_confirmed", { seq: 2, turn: 1, messageId: "m1" }),
    ];
    const items = bothPaths(events);
    assert.deepEqual(items.map((item) => item.outcome), ["delivered", "not_delivered", "carried", "pending"]);
    assert.equal(new Set(items.map((item) => item.id)).size, 4);
    // A confirmation is not a chat item.
    assert.equal(buildHistoryModel(events).chat.filter((item) => item.kind === "turn-control").length, 4);
});

test("a carried steer is labelled only from its closing record", () => {
    const base = [steer(10, "carry me"), outcome(11, 10, "carried")];
    assert.equal(bothPaths(base)[0].outcome, "carried", "no closing record: will run next");
    for (const [reason, expected] of [["ran", "carried_ran"], ["stopped", "carried_then_stopped"], ["gave_up", "carried_not_run"], ["terminal", "carried_not_run"]]) {
        assert.equal(bothPaths([...base, closed(12, [10], reason)])[0].outcome, expected, reason);
    }
});

test("an unrelated later Stop does not relabel a carried steer that ran", () => {
    const items = bothPaths([
        steer(10, "carry me"), outcome(11, 10, "carried"), closed(15, [10], "ran"),
        stop(20, 3), outcome(21, 20, "stopped", 3), closed(22, [18], "stopped", 3),
    ]);
    assert.deepEqual(items.map((item) => [item.kind, item.outcome]), [["steer", "carried_ran"], ["stop", "stopped"]]);
});

test("Stop outcomes and the legacy Stop line", () => {
    const items = bothPaths([
        stop(1), outcome(2, 1, "stopped"),
        stop(3, 2), outcome(4, 3, "too_late", 2),
        stop(5, 3),
        evt(6, "session.turn_stopped", { turnIndex: 4, reason: "Stopped by user", interrupt: "stopped", clientMessageIds: ["c1"] }),
        evt(7, "system.message", { content: "Turn stopped by user." }),
        evt(8, "session.turn_stopped", { turnIndex: 5, reason: "Stopped by user", interrupt: "stop_forced" }),
        // 1.0.81 marks its own stopped result; the user.stop item is its record.
        evt(9, "session.turn_stopped", { turnIndex: 6, reason: "Stopped by user", interrupt: "turn-result" }),
    ]);
    assert.deepEqual(items.map((item) => [item.kind, item.outcome]), [
        ["stop", "stopped"], ["stop", "too_late"], ["stop", "pending"], ["stop-legacy", "stopped"], ["stop-legacy", "stop_forced"],
    ]);
});

test("a duplicate delivery and a reload render the same items", () => {
    const events = [steer(1, "go"), outcome(2, 1, "delivered")];
    let history = live(events);
    history = appendEventToHistory(history, events[0]);
    history = appendEventToHistory(history, events[1]);
    assert.equal(controls(history).length, 1);
    assert.deepEqual(controls(buildHistoryModel(events)), controls(history));
});

test("two quick steers with the same text stay two items, in order", () => {
    const items = bothPaths([steer(1, "same"), steer(2, "same"), outcome(3, 1, "delivered"), outcome(4, 2, "delivered")]);
    assert.deepEqual(items.map((item) => item.id), ["s1:1:control", "s1:2:control"]);
});

function renderState(history, principal = null) {
    return {
        sessions: { activeSessionId: SID, byId: { [SID]: { sessionId: SID, status: "idle" } } },
        history: { bySessionId: new Map([[SID, history]]) },
        auth: { principal },
        ui: {},
        branding: {},
    };
}

test("the TUI renders a steer as a user line with its badge and a Stop as a short line", () => {
    const history = live([
        steer(1, "use metric units"), outcome(2, 1, "delivered"),
        stop(3), outcome(4, 3, "too_late"),
        steer(5, "carry"), outcome(6, 5, "carried"), closed(7, [5], "stopped"),
    ]);
    const text = selectChatLines(renderState(history), 80).map((line) => (Array.isArray(line) ? line.map((run) => run.text).join("") : line.text)).join("\n");
    assert.match(text, /You \(steer\) · Delivered/);
    assert.match(text, /use metric units/);
    assert.match(text, /■ Stop · Too late/);
    assert.match(text, /You \(steer\) · Carried, then stopped/);
});

test("the portal gets one turnControl line per control and a group around an ordinary user message", () => {
    const history = live([
        evt(1, "user.message", { content: "hello", clientMessageIds: ["cm-1"] }),
        steer(2, "steer text"), outcome(3, 2, "carried"), closed(4, [2], "ran"),
        evt(5, "session.turn_stopped", { turnIndex: 1, interrupt: "stop_forced" }),
    ]);
    const lines = selectChatLines(renderState(history), 80, { tableMode: "sentinel" });
    const turnControls = lines.filter((line) => line?.kind === "turnControl").map((line) => line.control);
    assert.deepEqual(turnControls.map((control) => [control.controlKind, control.seq, control.outcome, control.label]), [
        ["steer", 2, "carried_ran", "Carried, ran next"],
        ["stop-legacy", null, "stop_forced", "Stopped (forced)"],
    ]);
    const start = lines.findIndex((line) => line?.kind === "groupStart");
    const end = lines.findIndex((line) => line?.kind === "groupEnd");
    assert.ok(start >= 0 && end > start, "user message bounded");
    assert.equal(lines[start].group, "transcript-user-message");
    assert.deepEqual(lines[start].clientMessageIds, ["cm-1"]);
    assert.match(lines.slice(start + 1, end).map((line) => (Array.isArray(line) ? line.map((run) => run.text).join("") : "")).join(""), /hello/);
    // The TUI never sees the portal-only bounds.
    assert.equal(selectChatLines(renderState(history), 80).some((line) => line?.kind === "groupStart"), false);
});

test("a parent agent's Steer and Stop name the parent agent in the TUI and the portal", () => {
    const actor = { kind: "agent", sessionId: "parent-1", display: "Coordinator" };
    const history = live([
        evt(1, "user.steer", { turn: 1, text: "use metric units", requestId: "r-1", actor }), outcome(2, 1, "delivered"),
        evt(3, "user.stop", { turn: 1, text: "Stopped by parent agent", requestId: "r-3", actor }), outcome(4, 3, "stopped"),
        steer(5, "a person's steer"),
    ]);
    const text = selectChatLines(renderState(history), 80).map((line) => (Array.isArray(line) ? line.map((run) => run.text).join("") : line.text)).join("\n");
    assert.match(text, /Coordinator \(steer\) · Delivered/);
    assert.match(text, /■ Coordinator: Stop · Stopped — Stopped by parent agent/);
    assert.match(text, /You \(steer\) · Pending/);
    const portal = selectChatLines(renderState(history), 80, { tableMode: "sentinel" })
        .filter((line) => line?.kind === "turnControl").map((line) => line.control);
    assert.deepEqual(portal.map((control) => [control.controlKind, control.speaker, control.actorKind]), [
        ["steer", "Coordinator", "agent"],
        ["stop", "Coordinator", "agent"],
        ["steer", "You", "user"],
    ]);
});

test("an agent's message is a call row, never wrapped as a person's transcript message", () => {
    const history = live([
        evt(1, "user.message", { content: "from the parent", sender: { kind: "agent", sessionId: "parent-1", display: "Coordinator" } }),
    ]);
    const lines = selectChatLines(renderState(history), 80, { tableMode: "sentinel" });
    assert.equal(lines.some((line) => line?.kind === "groupStart"), false);
    assert.equal(lines.some((line) => line?.kind === "chatCall"), true);
});

test("labels reconcile across pages after a reload (steer, outcome and closing record on different pages)", async () => {
    // Transcript noise between the steer, its outcome and its closing
    // record, so even the type-filtered backward pages (300 events each)
    // split them: the reload window holds none of the three; page 1 brings
    // the closing record, page 2 the outcome, page 3 the steer.
    const events = [];
    let seq = 0;
    const push = (make) => { seq += 1; events.push(make(seq)); return seq; };
    const noise = (count) => {
        for (let i = 0; i < count; i += 1) push((s) => evt(s, "assistant.message", { content: `note ${s}`, messageId: `m-${s}`, phase: "commentary" }));
    };
    const steerSeq = push((s) => steer(s, "carried guidance", 1));
    noise(350);
    const outcomeSeq = push((s) => outcome(s, steerSeq, "carried", 1));
    noise(350);
    const closedSeq = push((s) => closed(s, [steerSeq], "ran", 2));
    noise(350);
    // A later unrelated Stop with its own closing record for other seqs.
    const stopSeq = push((s) => stop(s, 3));
    push((s) => outcome(s, stopSeq, "stopped", 3));

    const transport = {
        getSessionEvents: async (_sessionId, afterSeq, limit) => (afterSeq ? events.filter((e) => e.seq > afterSeq) : events).slice(-(limit || 300)),
        getSessionEventsBefore: async (_sessionId, beforeSeq, limit, types) => events
            .filter((e) => e.seq < beforeSeq && (!types || types.includes(e.eventType)))
            .slice(-(limit || 300)),
        subscribeSession: () => () => {},
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "T", status: "idle" }] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    await controller.ensureSessionHistory(SID, { force: true });
    const before = store.getState().history.bySessionId.get(SID);
    assert.equal(before.events.some((event) => [steerSeq, outcomeSeq, closedSeq].includes(event.seq)), false,
        "the reload window holds none of the three");
    const pageOldest = [];
    for (let page = 0; page < 3; page += 1) {
        await controller.expandSessionHistory(SID, { pages: 1, eventTypes: CHAT_HISTORY_EVENT_TYPES });
        const history = store.getState().history.bySessionId.get(SID);
        pageOldest.push(history.events[0].seq);
        const item = history.chat.find((candidate) => candidate.controlSeq === steerSeq);
        if (page < 2) assert.equal(item, undefined, `page ${page + 1}: the steer is still older`);
    }
    assert.ok(pageOldest[0] < closedSeq && pageOldest[0] > outcomeSeq, "page 1 brought the closing record only");
    assert.ok(pageOldest[1] < outcomeSeq && pageOldest[1] > steerSeq, "page 2 brought the outcome");
    const after = store.getState().history.bySessionId.get(SID);
    const steerItems = after.chat.filter((item) => item.controlSeq === steerSeq);
    assert.equal(steerItems.length, 1, "shown once");
    assert.equal(resolveTurnControlOutcome(steerItems[0]), "carried_ran");
    const stopItem = after.chat.find((item) => item.controlSeq === stopSeq);
    assert.equal(resolveTurnControlOutcome(stopItem), "stopped");
});
