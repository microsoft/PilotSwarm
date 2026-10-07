import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canReuseSteeringInDraft, buildSteeringMessage, createInitialState, appReducer, createStore, PilotSwarmUiController } from "../src/index.js";
import { SteeringReceipt } from "../../../ui/react/src/steering-receipt.js";

const receipt = { sessionId: "s", requestId: "r", revision: 1, text: "Retained guidance", disposition: "not_delivered_turn_ended" };
test("only undelivered, withdrawn and uncertain receipts offer one reuse action", () => {
    for (const disposition of ["not_delivered_turn_ended", "not_delivered_turn_stopped", "withdrawn", "delivery_unconfirmed"]) {
        const row = { ...receipt, disposition };
        assert.equal(canReuseSteeringInDraft(row), true);
        const html = renderToStaticMarkup(React.createElement(SteeringReceipt, { message: buildSteeringMessage(row), controller: {} }));
        assert.match(html, /aria-label="Reuse in draft"/);
        assert.doesNotMatch(html, /Copy to draft|Append to draft/);
    }
    for (const disposition of ["accepted", "delivered_current_turn", "delivered_after_response", "delivered_before_stop"]) {
        const row = { ...receipt, disposition };
        assert.equal(canReuseSteeringInDraft(row), false);
        assert.doesNotMatch(renderToStaticMarkup(React.createElement(SteeringReceipt, { message: buildSteeringMessage(row), controller: {} })), /Reuse in draft/);
    }
});
test("reuse fills or appends without mutating a receipt, another session or queued editing", () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s" }, { sessionId: "other" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s" });
    store.dispatch({ type: "steering/receiptReceived", sessionId: "s", receipt });
    const controller = new PilotSwarmUiController({ store, transport: {} });
    assert.equal(controller.reuseSteeringInDraft("s", "r"), true);
    assert.equal(store.getState().ui.prompt, receipt.text);
    controller.setPrompt("Newer draft");
    controller.reuseSteeringInDraft("s", "r");
    assert.equal(store.getState().ui.prompt, `Newer draft\n${receipt.text}`);
    assert.equal(store.getState().steering.bySessionId.s.receipts.r.text, receipt.text);
    store.dispatch({ type: "sessions/selected", sessionId: "other" });
    controller.setPrompt("Other draft");
    assert.equal(controller.reuseSteeringInDraft("s", "r"), false);
    assert.equal(store.getState().ui.prompt, "Other draft");
});
