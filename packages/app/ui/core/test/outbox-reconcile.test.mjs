// A sent message must not stay shown as queued. An outbox item clears only
// when the controller that holds it sees the matching receipt (a user.message
// with its client message id), so every path that can deliver a receipt must
// reconcile, and a queued item without a receipt gets one bounded re-check.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController } from "../src/controller.js";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { createStore } from "../src/store.js";

const SID = "s1";
const RECEIPT_TYPES = ["user.message", "system.message", "pending_messages.cancelled"];

function receipt(seq, ids, content = "hello") {
    return { seq, sessionId: SID, eventType: "user.message", createdAt: "2026-10-13T10:00:00Z", data: { content, clientMessageIds: ids } };
}

function harness(transport = {}) {
    const calls = { events: [], before: [], send: [], upload: [] };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({
        store,
        transport: {
            getSessionEvents: async (...args) => { calls.events.push(args); return []; },
            subscribeSession: () => () => {},
            sendMessage: async (...args) => { calls.send.push(args); return { queued: true }; },
            stop: async () => {},
            ...transport(calls),
        },
    });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "T", status: "running" }] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    const outbox = () => store.getState().outbox.bySessionId[SID] || [];
    return { controller, store, calls, outbox };
}

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("a receipt seen again after it was loaded still clears an item queued since (no early return before reconcile)", async () => {
    const loaded = [];
    const { controller, outbox } = harness(() => ({ getSessionEvents: async () => loaded }));
    const item = controller.buildOutboxItem("hello", "queued");
    const event = receipt(5, item.clientMessageIds);
    loaded.push(event);
    // The history load sees the receipt before this controller holds the item.
    await controller.ensureSessionHistory(SID, { force: true });
    controller.setSessionOutboxItems(SID, [item]);
    assert.equal(outbox().length, 1);
    // A second subscription or a replay delivers the same receipt again.
    controller.mergeSessionEvent(SID, event);
    assert.deepEqual(outbox(), []);
});

test("a duplicate suppressed by the server triggers one exact re-check: the earlier receipt clears the item", async () => {
    const item0 = { id: "m-1", text: "hello", createdAt: 1, phase: "queued", attempted: false, clientMessageIds: ["m-1"] };
    const { controller, calls, outbox } = harness((c) => ({
        getSessionEventsBefore: async (...args) => { c.before.push(args); return [receipt(3, ["m-1"])]; },
    }));
    controller.setSessionOutboxItems(SID, [item0]);
    controller.mergeSessionEvent(SID, { seq: 9, sessionId: SID, eventType: "session.message_duplicate_suppressed",
        data: { clientMessageIds: ["m-1"], duplicateClientMessageIds: ["m-1"], windowSize: 20, source: "drain" } });
    await settle();
    assert.deepEqual(calls.before, [[SID, Number.MAX_SAFE_INTEGER, 50, RECEIPT_TYPES]]);
    assert.deepEqual(outbox(), []);
});

test("a duplicate whose original has no receipt yet keeps the item queued (it is accepted, not yet run)", async () => {
    const item0 = { id: "m-2", text: "hello", createdAt: 1, phase: "queued", attempted: false, clientMessageIds: ["m-2"] };
    const { controller, calls, outbox } = harness((c) => ({
        getSessionEventsBefore: async (...args) => { c.before.push(args); return []; },
    }));
    controller.setSessionOutboxItems(SID, [item0]);
    controller.mergeSessionEvent(SID, { seq: 9, sessionId: SID, eventType: "session.message_duplicate_suppressed",
        data: { clientMessageIds: ["m-2"], duplicateClientMessageIds: ["m-2"] } });
    await settle();
    assert.equal(calls.before.length, 1);
    assert.deepEqual(outbox().map((i) => [i.id, i.phase]), [["m-2", "queued"]]);
});

test("a re-check never acknowledges by text: only receipts that carry client message ids count", async () => {
    const item0 = { id: "m-3", text: "yes", createdAt: 1, phase: "queued", attempted: false, clientMessageIds: ["m-3"] };
    const { controller, outbox } = harness(() => ({
        getSessionEventsBefore: async () => [{ seq: 2, sessionId: SID, eventType: "user.message", data: { content: "yes" } }],
    }));
    controller.setSessionOutboxItems(SID, [item0]);
    controller.mergeSessionEvent(SID, { seq: 9, sessionId: SID, eventType: "session.message_duplicate_suppressed",
        data: { clientMessageIds: ["m-3"], duplicateClientMessageIds: ["m-3"] } });
    await settle();
    assert.equal(outbox().length, 1);
});

test("a queued item without a receipt gets exactly one re-check after 10 s", async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    let receipts = [];
    const { controller, calls, outbox } = harness((c) => ({
        getSessionEventsBefore: async (...args) => { c.before.push(args); return receipts; },
    }));
    controller.queuePromptInOutbox(SID, "hello");
    await controller.dispatchPendingOutbox(SID);
    const [item] = outbox();
    assert.equal(item.phase, "queued");
    mock.timers.tick(9_999);
    await settle();
    assert.equal(calls.before.length, 0);
    receipts = [receipt(4, item.clientMessageIds)];
    mock.timers.tick(1);
    await settle();
    assert.deepEqual(calls.before, [[SID, Number.MAX_SAFE_INTEGER, 50, RECEIPT_TYPES]]);
    assert.deepEqual(outbox(), []);
});

test("the re-check is bounded: one query per queued item, never a polling loop", async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const { controller, calls, outbox } = harness((c) => ({
        getSessionEventsBefore: async (...args) => { c.before.push(args); return []; },
    }));
    controller.queuePromptInOutbox(SID, "hello");
    await controller.dispatchPendingOutbox(SID);
    for (let i = 0; i < 5; i++) { mock.timers.tick(10_000); await settle(); }
    assert.equal(calls.before.length, 1);
    assert.equal(outbox()[0].phase, "queued");
    await controller.stop();
});

test("stop() cancels a pending re-check", async (t) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => mock.timers.reset());
    const { controller, calls } = harness((c) => ({
        getSessionEventsBefore: async (...args) => { c.before.push(args); return []; },
    }));
    controller.queuePromptInOutbox(SID, "hello");
    await controller.dispatchPendingOutbox(SID);
    await controller.stop();
    mock.timers.tick(10_000);
    await settle();
    assert.equal(calls.before.length, 0);
});

test("re-read old receipts acknowledge only by exact id: a same-text legacy or empty-id receipt never clears a new item", async () => {
    const loaded = [];
    const { controller, outbox } = harness(() => ({ getSessionEvents: async () => loaded }));
    loaded.push({ seq: 4, sessionId: SID, eventType: "user.message", data: { content: "yes" } },
        { seq: 5, sessionId: SID, eventType: "user.message", data: { content: "yes", clientMessageIds: [] } });
    await controller.ensureSessionHistory(SID, { force: true });
    const item = controller.buildOutboxItem("yes", "queued");
    controller.setSessionOutboxItems(SID, [item]);
    for (const event of loaded) controller.mergeSessionEvent(SID, event);
    assert.deepEqual(outbox().map((i) => i.id), [item.id]);
});

test("a history load or expansion acknowledges only by exact id: an older same-text receipt never clears a queued item", async () => {
    const loaded = [{ seq: 4, sessionId: SID, eventType: "user.message", data: { content: "yes" } }];
    const { controller, outbox } = harness(() => ({ getSessionEvents: async () => loaded }));
    const item = controller.buildOutboxItem("yes", "queued");
    controller.setSessionOutboxItems(SID, [item]);
    await controller.ensureSessionHistory(SID, { force: true });
    assert.deepEqual(outbox().map((i) => i.id), [item.id]);
    loaded.push(receipt(5, item.clientMessageIds, "yes"));
    await controller.ensureSessionHistory(SID, { force: true });
    assert.deepEqual(outbox(), []);
});

test("a catch-up skips an event a live update already added: that stale copy acknowledges by exact id only", async () => {
    const old = { seq: 6, sessionId: SID, eventType: "user.message", data: { content: "yes" } };
    let release;
    const { controller, outbox, store } = harness(() => ({
        getSessionEvents: async (_sessionId, afterSeq) => {
            if (afterSeq === 5) await new Promise((resolve) => { release = resolve; });
            return afterSeq === 5 ? [old] : [];
        },
    }));
    store.dispatch({ type: "history/set", sessionId: SID, history: { chat: [], activity: [], events: [], lastSeq: 5 } });
    const catchUp = controller.catchUpSessionHistory(SID, store.getState().history.bySessionId.get(SID), 5);
    await settle();
    // While the catch-up waits, the live stream delivers the same event and
    // a newer item with the same text is queued.
    controller.mergeSessionEvent(SID, old);
    const item = controller.buildOutboxItem("yes", "queued");
    controller.setSessionOutboxItems(SID, [item]);
    release();
    await catchUp;
    assert.deepEqual(outbox().map((i) => i.id), [item.id]);
});

test("a reconnect replays the events missed during the gap (onResubscribe -> syncSessionEvents)", async () => {
    let onResubscribe = null;
    const { controller, calls, store } = harness((c) => ({
        subscribeSession: (_sessionId, _handler, resubscribe) => { onResubscribe = resubscribe; return () => {}; },
        getSessionEvents: async (...args) => { c.events.push(args); return args[1] === undefined ? [receipt(7, ["x"], "earlier")] : []; },
    }));
    await controller.ensureSessionHistory(SID, { force: true });
    controller.attachActiveSession(SID);
    assert.equal(typeof onResubscribe, "function");
    calls.events.length = 0;
    onResubscribe();
    await settle();
    assert.deepEqual(calls.events.map(([sessionId, afterSeq]) => [sessionId, afterSeq]), [[SID, store.getState().history.bySessionId.get(SID).lastSeq]]);
});

test("a second submit while an attachment upload is in flight sends nothing more", async () => {
    let release;
    const uploaded = new Promise((resolve) => { release = resolve; });
    const { controller, calls } = harness((c) => ({
        uploadArtifactFromFile: async (...args) => { c.upload.push(args); await uploaded; },
    }));
    controller.setPrompt("look at this");
    controller.setPromptAttachments([{ kind: "image", file: { name: "a.png" }, contentType: "image/png", filename: "a.png" }]);
    const first = controller.sendPrompt();
    await settle();
    const second = controller.sendPrompt();
    await settle();
    release();
    await Promise.all([first, second]);
    assert.equal(calls.upload.length, 1);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0][1], "look at this");
});

test("a submit without images while an upload is in flight sends nothing either (the draft stays)", async () => {
    let release;
    const uploaded = new Promise((resolve) => { release = resolve; });
    const { controller, calls, store } = harness((c) => ({
        uploadArtifactFromFile: async (...args) => { c.upload.push(args); await uploaded; },
    }));
    controller.setPrompt("look at this");
    controller.setPromptAttachments([{ kind: "image", file: { name: "a.png" }, contentType: "image/png", filename: "a.png" }]);
    const first = controller.sendPrompt();
    await settle();
    controller.setPromptAttachments([]);
    const second = controller.sendPrompt();
    await settle();
    assert.equal(calls.send.length, 0);
    release();
    await Promise.all([first, second]);
    assert.equal(calls.send.length, 1);
    assert.equal(store.getState().ui.prompt, "");
});

test("a draft typed during an image upload survives the send", async () => {
    let release;
    const uploaded = new Promise((resolve) => { release = resolve; });
    const { controller, calls, store } = harness((c) => ({
        uploadArtifactFromFile: async (...args) => { c.upload.push(args); await uploaded; },
    }));
    const image = { kind: "image", file: { name: "a.png" }, contentType: "image/png", filename: "a.png" };
    controller.setPrompt("look at this");
    controller.setPromptAttachments([image]);
    const sending = controller.sendPrompt();
    await settle();
    controller.setPrompt("my next message");
    release();
    await sending;
    assert.equal(calls.send[0][1], "look at this");
    assert.equal(store.getState().ui.prompt, "my next message");
    assert.deepEqual(controller.getPromptAttachments(), []);
});

test("a throwing store listener does not stop later listeners or the dispatch; the error is still reported", (t) => {
    const reported = [];
    t.mock.method(console, "error", (...args) => reported.push(args));
    const store = createStore((state, action) => ({ ...state, n: action.n }), { n: 0 });
    const seen = [];
    store.subscribe(() => { throw new Error("listener bug"); });
    store.subscribe((state) => seen.push(state.n));
    assert.doesNotThrow(() => store.dispatch({ type: "x", n: 1 }));
    assert.deepEqual(seen, [1]);
    assert.equal(reported.length, 1);
    assert.match(String(reported[0].at(-1)?.message), /listener bug/);
});
