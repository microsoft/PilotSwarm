import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, createStore, appReducer, buildHistoryModel, selectActiveChat,
    selectUnplacedSteeringReceipts, PilotSwarmUiController } from "../src/index.js";

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
