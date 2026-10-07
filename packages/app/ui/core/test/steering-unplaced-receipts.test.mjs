import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, createStore, appReducer, buildHistoryModel, selectActiveChat,
    selectUnplacedSteeringReceipts, selectSteeringReceipts, PilotSwarmUiController } from "../src/index.js";

const receipt = { schemaVersion: 1, sessionId: "s", requestId: "r", clientRequestId: "c",
    revision: 1, sequence: 1, acceptedAt: new Date(100).toISOString(), text: "Old guidance", disposition: "withdrawn" };
const recent = { sessionId: "s", seq: 50, eventType: "user.message", createdAt: 5000, data: { content: "New conversation" } };
test("out-of-window receipt stays unplaced until its durable acceptance page loads", () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s" });
    store.dispatch({ type: "history/set", sessionId: "s", history: buildHistoryModel([recent]) });
    store.dispatch({ type: "steering/receiptReceived", sessionId: "s", receipt });
    assert.deepEqual(selectActiveChat(store.getState()).map(item => item.text), ["New conversation"]);
    assert.equal(selectUnplacedSteeringReceipts(store.getState())[0].text, "Old guidance");
    store.dispatch({ type: "history/set", sessionId: "s", history: buildHistoryModel([
        { sessionId: "s", seq: 2, eventType: "session.steering_accepted", data: { receipt } }, recent,
    ]) });
    assert.deepEqual(selectActiveChat(store.getState()).map(item => item.text), ["Old guidance", "New conversation"]);
    assert.equal(selectUnplacedSteeringReceipts(store.getState()).length, 0);
});
test("receipt load-more retains opaque cursor and discloses partial state", async () => {
    const store = createStore(appReducer, createInitialState());
    const cursors = [];
    const controller = new PilotSwarmUiController({ store, transport: {
        listSteeringRequests: async (_sessionId, options) => {
            cursors.push(options.cursor);
            return { items: [{ ...receipt, requestId: options.cursor ? "r2" : "r" }], nextCursor: options.cursor ? null : "opaque-next" };
        },
    } });
    await controller.loadSteeringRequests("s", { reset: true });
    assert.equal(store.getState().steering.bySessionId.s.page.nextCursor, "opaque-next");
    await controller.loadSteeringRequests("s");
    assert.deepEqual(cursors, [undefined, "opaque-next"]);
    assert.equal(store.getState().steering.bySessionId.s.page.nextCursor, null);
    assert.equal(Object.keys(store.getState().steering.bySessionId.s.receipts).length, 2);
});

function receiptBrowser(transport) {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s", canWrite: true }, { sessionId: "other", canWrite: true }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s" });
    store.dispatch({ type: "steering/stateLoaded", sessionId: "s", windowSeq: 1,
        state: { supported: true, canWrite: true, steerable: true, expectedTarget: "target" } });
    return { store, controller: new PilotSwarmUiController({ store, transport }) };
}

test("overlapping receipt list requests share the issued read without dropping its opaque cursor", async () => {
    const response = Promise.withResolvers();
    const calls = [];
    const h = receiptBrowser({ listSteeringRequests: async (...args) => { calls.push(args); return response.promise; } });
    h.store.dispatch({ type: "steering/page", sessionId: "s", page: { nextCursor: "captured-cursor" } });
    const first = h.controller.loadSteeringRequests("s");
    const second = h.controller.loadSteeringRequests("s");
    assert.equal(first, second);
    assert.deepEqual(calls, [["s", { limit: 50, cursor: "captured-cursor" }]]);
    response.resolve({ items: [receipt], nextCursor: "remaining-cursor" });
    await first;
    assert.equal(h.store.getState().steering.bySessionId.s.page.nextCursor, "remaining-cursor");
    assert.equal(h.store.getState().steering.bySessionId.s.page.loading, false);
});

test("a revoked receipt page cannot reconstruct retained text, actions, or cursor", async () => {
    const response = Promise.withResolvers();
    const h = receiptBrowser({ listSteeringRequests: () => response.promise });
    const reading = h.controller.loadSteeringRequests("s", { reset: true });
    h.store.dispatch({ type: "steering/accessLost", sessionId: "s" });
    response.resolve({ items: [{ ...receipt, actions: { canWithdraw: true, canSendAsNewMessage: true } }], nextCursor: "private-next" });
    await reading;
    const entry = h.store.getState().steering.bySessionId.s;
    assert.equal(entry.accessLost, true);
    assert.deepEqual(entry.receipts, {});
    assert.equal(entry.page?.nextCursor, undefined);
    assert.deepEqual(selectSteeringReceipts(h.store.getState()), []);
});

test("an old receipt-page denial cannot erase a newer authoritative access grant", async () => {
    const response = Promise.withResolvers();
    const h = receiptBrowser({
        listSteeringRequests: () => response.promise,
        getSession: async () => ({ sessionId: "s", canWrite: true }),
    });
    const reading = h.controller.loadSteeringRequests("s", { reset: true });
    h.store.dispatch({ type: "steering/accessLost", sessionId: "s" });
    h.store.dispatch({ type: "steering/stateLoaded", sessionId: "s", accessRevision: 1, windowSeq: 2,
        state: { supported: true, canWrite: true, steerable: true, expectedTarget: "new-target" } });
    h.store.dispatch({ type: "steering/receiptReceived", sessionId: "s", accessRevision: 1,
        receipt: { ...receipt, revision: 2, text: "newly authorized receipt" } });
    response.reject(Object.assign(new Error("Old list access denied"), { code: "FORBIDDEN" }));
    await reading;
    const entry = h.store.getState().steering.bySessionId.s;
    assert.equal(entry.accessLost, false, "the old request captured revision zero, not the restored grant");
    assert.equal(entry.accessRevision, 1);
    assert.equal(entry.state.expectedTarget, "new-target");
    assert.equal(entry.receipts.r.text, "newly authorized receipt");
});

test("receipt paging preserves selected guidance identity when an earlier receipt becomes visible", async () => {
    const h = receiptBrowser({ listSteeringRequests: async () => ({ items: [receipt], nextCursor: null }) });
    h.store.dispatch({ type: "steering/receiptReceived", sessionId: "s", receipt: { ...receipt, requestId: "later", sequence: 2 } });
    h.store.dispatch({ type: "steering/page", sessionId: "s", page: { nextCursor: "older-page" } });
    h.controller.openSteeringReceipts();
    const before = h.store.getState().ui.modal;
    const selectedId = before.items[before.selectedIndex];
    await h.controller.loadSteeringRequests("s");
    const after = h.store.getState().ui.modal;
    assert.equal(after.items[after.selectedIndex], selectedId, "paging must not silently retarget Withdraw or Send as new message");
    assert.equal(after.items.length, 2);
});

test("a receipt page completing after navigation stays in its captured session and leaves another session modal untouched", async () => {
    const response = Promise.withResolvers();
    const h = receiptBrowser({ listSteeringRequests: () => response.promise });
    const reading = h.controller.loadSteeringRequests("s", { reset: true });
    h.store.dispatch({ type: "sessions/selected", sessionId: "other" });
    h.store.dispatch({ type: "steering/receiptReceived", sessionId: "other",
        receipt: { ...receipt, sessionId: "other", requestId: "other-receipt" } });
    h.controller.openSteeringReceipts();
    const modal = h.store.getState().ui.modal;
    response.resolve({ items: [receipt], nextCursor: "old-session-next" });
    await reading;
    assert.equal(h.store.getState().sessions.activeSessionId, "other");
    assert.deepEqual(h.store.getState().ui.modal, modal);
    assert.deepEqual(selectSteeringReceipts(h.store.getState()).map(row => row.steering.requestId), ["other-receipt"]);
    assert.equal(h.store.getState().steering.bySessionId.s.page.nextCursor, "old-session-next");
});

test("receipt list transport failure keeps readable retained evidence and its retry cursor", async () => {
    const h = receiptBrowser({ listSteeringRequests: async () => { throw new Error("Fixture transport failed"); } });
    h.store.dispatch({ type: "steering/receiptReceived", sessionId: "s", receipt });
    h.store.dispatch({ type: "steering/page", sessionId: "s", page: { nextCursor: "retry-cursor" } });
    await h.controller.loadSteeringRequests("s");
    const entry = h.store.getState().steering.bySessionId.s;
    assert.equal(entry.accessLost, false);
    assert.equal(entry.receipts.r.text, receipt.text);
    assert.equal(entry.page.nextCursor, "retry-cursor");
    assert.equal(entry.page.loading, false);
    assert.equal(entry.page.error, "Fixture transport failed");
});
