import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";

function makeReceipt(options, over = {}) {
    return {
        schemaVersion: 1, sessionId: "s1", requestId: "request-a", clientRequestId: options.clientRequestId,
        expectedTarget: options.expectedTarget, sequence: 1, acceptedAt: "2026-01-01T00:00:00.000Z",
        actor: { provider: "test", subject: "alice" }, text: options.text, revision: 1,
        status: "pending", disposition: "accepted", eligibility: { state: "pending", reason: null },
        inclusion: { state: "unconfirmed", snapshotVersion: null }, recoveryFlags: [],
        attempts: { items: [], nextCursor: null }, actions: { canWithdraw: true, canSendAsNewMessage: false }, ...over,
    };
}

function makeController(transport = {}) {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [
        { sessionId: "s1", status: "running", canWrite: true },
        { sessionId: "s2", status: "running", canWrite: true },
    ] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    state = appReducer(state, { type: "steering/stateLoaded", sessionId: "s1", windowSeq: 1,
        state: { supported: true, canWrite: true, steerable: true, expectedTarget: "target-a", limits: { maxBytes: 8192 } } });
    state = { ...state, ui: { ...state.ui, prompt: "guidance for s1", promptCursor: 15 } };
    const store = createStore(appReducer, state);
    const controller = new PilotSwarmUiController({ store, transport: {
        getSessionEvents: async () => [],
        sendAnswer: async () => { throw new Error("fixture: retained steering must never answer a question"); },
        ...transport,
    } });
    return { controller, store };
}

test("ST-U07: an accepted steer stays on the captured session and target across a session switch", async () => {
    const response = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const h = makeController({ steerSessionTurn: async (sessionId, options) => {
        entered.resolve({ sessionId, options });
        return await response.promise;
    } });
    const submission = h.controller.steerPrompt();
    const call = await entered.promise;
    assert.equal(call.sessionId, "s1");
    assert.equal(call.options.expectedTarget, "target-a");
    assert.equal(call.options.text, "guidance for s1");
    h.store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    h.controller.setPrompt("new draft for s2");
    response.resolve({ ok: true, duplicate: false, receipt: makeReceipt(call.options) });
    await submission;
    const state = h.store.getState();
    assert.equal(state.sessions.activeSessionId, "s2");
    assert.equal(state.ui.prompt, "new draft for s2");
    assert.equal(state.steering.bySessionId.s1.receipts["request-a"].expectedTarget, "target-a");
    assert.equal(state.steering.bySessionId.s2, undefined);
    assert.equal(Object.keys(state.steering.bySessionId.s1.pending).length, 0);
});

test("ST-U07/ST-A01: lost response retries the original identity and target, never the latest target", async () => {
    const calls = [];
    const h = makeController({
        steerSessionTurn: async (sessionId, options) => {
            calls.push({ sessionId, options });
            if (calls.length === 1) throw new Error("fixture: HTTP response lost");
            return { ok: true, duplicate: true, receipt: makeReceipt(options) };
        },
    });
    await h.controller.steerPrompt();
    const original = calls[0];
    const pending = h.store.getState().steering.bySessionId.s1.pending[original.options.clientRequestId];
    assert.equal(pending.text, "guidance for s1");
    assert.equal(pending.inFlight, false);
    assert.equal(pending.rejected, false);
    h.controller.setPrompt("newer draft");
    h.store.dispatch({ type: "steering/windowChanged", sessionId: "s1", seq: 2,
        window: { schemaVersion: 1, state: "open", expectedTarget: "target-b", reason: "turn_started" } });
    await h.controller.retrySteering("s1", original.options.clientRequestId);
    assert.deepEqual(calls[1], original, "explicit ambiguous retry cannot retarget or mint a new key");
    assert.equal(h.store.getState().ui.prompt, "newer draft");
    assert.equal(Object.keys(h.store.getState().steering.bySessionId.s1.receipts).length, 1);
});

test("ST-U07: an accepted event followed by a lost HTTP response does not recreate an optimistic row", async () => {
    let h;
    h = makeController({ steerSessionTurn: async (_sessionId, options) => {
        h.controller.reconcileSteeringEvent("s1", {
            eventType: "session.steering_accepted", data: { receipt: makeReceipt(options) },
        });
        throw new Error("fixture: HTTP response lost after durable event");
    } });
    await h.controller.steerPrompt();
    const entry = h.store.getState().steering.bySessionId.s1;
    assert.equal(Object.keys(entry.receipts).length, 1);
    assert.equal(Object.keys(entry.pending).length, 0);
    assert.equal(entry.receipts["request-a"].disposition, "accepted");
});

test("ST-U07/ST-A06: explicit retained-text resend uses ordinary Send, a new ID and provenance without touching the draft", async () => {
    const read = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const sent = [];
    const h = makeController({
        getSteeringRequest: async (sessionId, requestId) => {
            entered.resolve({ sessionId, requestId });
            return await read.promise;
        },
        sendMessage: async (...args) => { sent.push(args); },
    });
    const resending = h.controller.resendSteering("s1", "request-a");
    assert.deepEqual(await entered.promise, { sessionId: "s1", requestId: "request-a" });
    h.store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    h.controller.setPrompt("do not clear this draft");
    read.resolve(makeReceipt({ text: "/wait is literal retained text", clientRequestId: "old-client-id", expectedTarget: "old-target" }, {
        status: "closed", disposition: "not_delivered_turn_ended",
        actions: { canWithdraw: false, canSendAsNewMessage: true },
    }));
    await resending;
    assert.equal(sent.length, 1);
    const [sessionId, text, options] = sent[0];
    assert.equal(sessionId, "s1");
    assert.equal(text, "/wait is literal retained text");
    assert.equal(options.enqueueOnly, true);
    assert.equal(options.steeringRequestId, "request-a");
    assert.equal(options.clientMessageIds.length, 1);
    assert.notEqual(options.clientMessageIds[0], "old-client-id");
    assert.equal(options.sender, undefined, "the server, not the controller, stamps the actual resender");
    assert.equal(h.store.getState().ui.prompt, "do not clear this draft");
    assert.equal(h.store.getState().sessions.activeSessionId, "s2");
});

test("ST-U07: copy-to-draft refuses to overwrite a newer draft and offers explicit append", () => {
    const h = makeController();
    h.store.dispatch({ type: "steering/receiptReceived", sessionId: "s1",
        receipt: makeReceipt({ text: "retained text", clientRequestId: "caller-a", expectedTarget: "target-a" }) });
    h.controller.copySteeringToDraft("s1", "request-a");
    assert.equal(h.store.getState().ui.prompt, "guidance for s1");
    h.controller.copySteeringToDraft("s1", "request-a", { append: true });
    assert.equal(h.store.getState().ui.prompt, "guidance for s1\n\nretained text");
    h.store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    h.controller.setPrompt("s2 draft");
    h.controller.copySteeringToDraft("s1", "request-a", { append: true });
    assert.equal(h.store.getState().ui.prompt, "s2 draft", "retained text cannot follow a session switch");
});

test("ST-U07: stale discovery cannot reopen a newer closed window", () => {
    const h = makeController();
    h.store.dispatch({ type: "steering/windowChanged", sessionId: "s1", seq: 10,
        window: { schemaVersion: 1, state: "closed", expectedTarget: null, reason: "stopped" } });
    h.store.dispatch({ type: "steering/stateLoaded", sessionId: "s1", windowSeq: 1,
        state: { supported: true, canWrite: true, steerable: true, expectedTarget: "target-a" } });
    const entry = h.store.getState().steering.bySessionId.s1;
    assert.equal(entry.windowSeq, 10);
    assert.equal(entry.state.steerable, false);
    assert.equal(entry.state.expectedTarget, null);
});

test("ST-U07/ST-I01: steering delivery cannot acknowledge equal-text ordinary queued input", () => {
    const h = makeController();
    const ordinary = h.controller.buildOutboxItem("retained text", "queued");
    h.controller.setSessionOutboxItems("s1", [ordinary]);
    h.controller.reconcileOutboxAgainstEvent("s1", { sessionId: "s1", seq: 2, eventType: "user.message",
        data: { content: "retained text", steering: { requestId: "request-a", revision: 2 } } });
    assert.deepEqual(h.store.getState().outbox.bySessionId.s1.map((item) => item.id), [ordinary.id]);
});

test("ST-U07/ST-A05: a gone/revoked session evicts receipts and ignores late responses", () => {
    const h = makeController();
    const value = makeReceipt({ text: "retained guidance", clientRequestId: "caller-a", expectedTarget: "target-a" });
    h.store.dispatch({ type: "steering/receiptReceived", sessionId: "s1", receipt: value });
    h.store.dispatch({ type: "sessions/gone", sessionId: "s1" });
    assert.equal(h.store.getState().steering.bySessionId.s1, undefined);
    h.store.dispatch({ type: "steering/receiptReceived", sessionId: "s1", receipt: { ...value, revision: 3 } });
    assert.equal(h.store.getState().steering.bySessionId.s1, undefined, "late response cannot restore inaccessible content");
});
