import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, createStore, appReducer, PilotSwarmUiController, buildHistoryModel,
    selectActiveChat, selectUnplacedSteeringReceipts, promptDraftForPersistence } from "../src/index.js";

const receipt = { schemaVersion: 1, sessionId: "s", requestId: "r", sequence: 1, revision: 2, text: "Old guidance",
    disposition: "delivered_after_response", status: "delivered" };
const ordinary = { sessionId: "s", seq: 50, eventType: "user.message", data: { content: "New conversation" } };
function harness() {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s", status: "running" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s" });
    const controller = new PilotSwarmUiController({ store, transport: {} });
    controller.syncPromptReferenceBrowser = () => {};
    return { store, controller };
}
for (const event of [
    { sessionId: "s", seq: 60, eventType: "session.steering_updated", data: { projection: receipt } },
    { sessionId: "s", seq: 61, eventType: "user.message", data: { content: "Old guidance", steering: { requestId: "r", revision: 2 } } },
]) {
    test(`F10: ${event.eventType} without acceptance never anchors old guidance after new input`, () => {
        const { store } = harness();
        store.dispatch({ type: "steering/receiptReceived", sessionId: "s", receipt });
        store.dispatch({ type: "history/set", sessionId: "s", history: buildHistoryModel([ordinary, event]) });
        assert.deepEqual(selectActiveChat(store.getState()).map(row => row.text), ["New conversation"]);
        assert.equal(selectUnplacedSteeringReceipts(store.getState()).length, 1);
        const acceptance = { sessionId: "s", seq: 2, eventType: "session.steering_accepted", data: { receipt: { ...receipt, revision: 1 } } };
        store.dispatch({ type: "history/set", sessionId: "s", history: buildHistoryModel([acceptance, ordinary, event]) });
        assert.deepEqual(selectActiveChat(store.getState()).map(row => row.text), ["Old guidance", "New conversation"]);
        assert.equal(selectUnplacedSteeringReceipts(store.getState()).length, 0);
    });
}
for (const phase of ["pending", "queued"]) {
    test(`N01: atomic MoA draft restore clears ${phase} edit binding without mutating queue`, () => {
        const { store, controller } = harness();
        const item = controller.buildOutboxItem("Queue text", phase);
        controller.setSessionOutboxItems("s", [item]);
        controller.setPrompt("Original draft", 3);
        controller.setPromptAttachments([{ kind: "image", filename: "draft.png" }]);
        controller.recallPromptInput(-1);
        const draft = promptDraftForPersistence(store.getState().ui);
        let updates = 0;
        const off = store.subscribe(state => {
            updates++;
            assert.equal(state.ui.promptEdit, null);
            assert.equal(state.ui.promptHistoryNavigation, null);
            assert.equal(state.ui.prompt, "Original draft");
        });
        controller.dispatch({ type: "ui/promptRestored", draft });
        off();
        assert.equal(updates, 1);
        assert.equal(store.getState().ui.promptCursor, 3);
        assert.equal(store.getState().ui.promptAttachments[0].filename, "draft.png");
        controller.setPrompt("Original draft typed");
        assert.equal(controller.getSessionOutbox("s")[0].text, "Queue text");
        assert.equal(controller.getSessionOutbox("s")[0].phase, phase);
    });
}
