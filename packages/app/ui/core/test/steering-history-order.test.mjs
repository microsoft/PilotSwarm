import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState, buildHistoryModel, selectActiveChat } from "../src/index.js";

function stateWithHistory() {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", status: "running" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    state = appReducer(state, { type: "history/set", sessionId: "s1", history: buildHistoryModel([
        { sessionId: "s1", seq: 1, eventType: "user.message", createdAt: 3000, data: { content: "Earlier page, newer capture clock" } },
        { sessionId: "s1", seq: 2, eventType: "user.message", createdAt: 1000, data: { content: "Recent page, older capture clock" } },
    ]) });
    return state;
}

test("empty steering discovery never reorders ordinary history by capture timestamp", () => {
    let state = stateWithHistory();
    const before = selectActiveChat(state).map(message => message.text);
    state = appReducer(state, { type: "steering/stateLoaded", sessionId: "s1",
        state: { supported: false, steerable: false, expectedTarget: null, reason: "unsupported" }, windowSeq: 0 });
    assert.deepEqual(selectActiveChat(state).map(message => message.text), before);
});

test("inserting a missing receipt preserves the relative order of all ordinary messages", () => {
    let state = stateWithHistory();
    const before = selectActiveChat(state).map(message => message.text);
    state = appReducer(state, { type: "steering/receiptReceived", sessionId: "s1", receipt: {
        schemaVersion: 1, sessionId: "s1", requestId: "r1", clientRequestId: "c1",
        revision: 1, sequence: 1, acceptedAt: new Date(2000).toISOString(), text: "Guidance",
        status: "pending", disposition: "accepted",
    } });
    const chat = selectActiveChat(state);
    assert.deepEqual(chat.filter(message => message.kind !== "steering").map(message => message.text), before);
    assert.equal(chat.filter(message => message.kind === "steering").length, 1);
});
