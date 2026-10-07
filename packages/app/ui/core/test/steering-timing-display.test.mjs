import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInitialState, appReducer, getSteeringDisplay, getSteeringAttemptDisplay, canReuseSteeringInDraft,
    buildSteeringMessage, selectInspector } from "../src/index.js";
import { steeringResultDisplay } from "../src/steering-labels.js";
import { SteeringReceipt } from "../../../ui/react/src/steering-receipt.js";

const label = "Delivered (timing unconfirmed)";
const detail = "Delivered before recovery; whether it reached the turn or followed the response is not known.";
const receipt = { schemaVersion: 1, sessionId: "s", requestId: "r", revision: 2, status: "delivered",
    disposition: "delivered_timing_unconfirmed", text: "Known delivered input",
    inclusion: { state: "included" }, actions: { canWithdraw: false, canSendAsNewMessage: false } };

test("recovered delivery uses exact approved label/details in UI and CLI/MCP without draft or resend actions", () => {
    for (const status of ["delivered", "closed"]) {
        const row = { ...receipt, status };
        assert.equal(getSteeringDisplay(row).label, label);
        assert.equal(steeringResultDisplay(row).label, label);
        assert.equal(getSteeringDisplay(row).detail, `${detail} Included in the saved conversation.`);
        assert.equal(canReuseSteeringInDraft(row), false);
        const html = renderToStaticMarkup(React.createElement(SteeringReceipt, { message: buildSteeringMessage(row), controller: {} }));
        assert.match(html, /Delivered \(timing unconfirmed\)/);
        assert.doesNotMatch(html, /Reuse in draft|Send as new message|Withdraw guidance/);
    }
    assert.equal(getSteeringAttemptDisplay({ deliveredAt: "2026-01-01T00:00:00Z" }), label);
});

test("shared Steering stats show the canonical timing-unconfirmed request count", () => {
    let state = appReducer(createInitialState(), { type: "sessions/loaded", sessions: [{ sessionId: "s" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s" });
    state = { ...state, ui: { ...state.ui, inspectorTab: "stats" }, sessionStats: { bySessionId: { s: {
        summary: {}, steeringStats: { data: {
            requests: { accepted: 6, unresolved: 0, claimable: 0, byDisposition: { delivered_timing_unconfirmed: 3 },
                byInclusion: { unconfirmed: 0 } },
            attempts: { deliveries: 7, deliveredByKind: { steering: 2, queued: 1, idle: 1 }, redeliveries: 0, unconfirmed: 0 },
            latency: {},
        } },
    } } } };
    const text = selectInspector(state, { width: 110 }).lines.map(line => (
        Array.isArray(line) ? line.map(run => run.text).join("")
            : line.text ?? line.runs?.map(run => run.text).join("") ?? ""
    )).join("\n");
    assert.match(text, /Delivered \(timing unconfirmed\)\s+3/);
});
