import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, buildHistoryModel, createInitialState, createStore, PilotSwarmUiController, selectPromptHistory } from "../src/index.js";

const alice = { provider: "test", subject: "alice" };
const event = (seq, content, sender = alice, over = {}) => ({
    sessionId: "s1", seq, eventType: "user.message", createdAt: seq,
    data: { content, sender: { kind: "user", ...sender }, clientMessageIds: [`id-${seq}`], ...over },
});
function harness(events = [], transport = {}) {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "auth/context", principal: alice });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", status: "running" }, { sessionId: "s2", status: "running" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    store.dispatch({ type: "history/set", sessionId: "s1", history: buildHistoryModel(events) });
    const controller = new PilotSwarmUiController({ store, transport });
    controller.syncPromptReferenceBrowser = () => {};
    return { store, controller, state: store.getState };
}

test("history fail-closes on absent/forged attribution and respects actual resend actor, not receipt origin", () => {
    const h = harness([
        event(1, "own first"),
        event(2, "another participant", { provider: "test", subject: "bob", displayName: "alice" }),
        event(3, "provider mismatch", { provider: "other", subject: "alice" }),
        event(4, "owner forged", { provider: "test", subject: "bob", relation: "owner" }),
        event(5, "own resend", alice, { steeringRequestId: "bob-original-receipt" }),
        event(6, "bob resend", { provider: "test", subject: "bob" }, { steeringRequestId: "alice-original-receipt" }),
        event(7, "unattributed", {}, { sender: null }),
        event(8, "trusted system", alice, { sender: { ...alice, kind: "system" } }),
    ]);
    assert.deepEqual(selectPromptHistory(h.state()), ["own resend", "own first"]);
    h.store.dispatch({ type: "auth/context", principal: { provider: "test", subject: "bob" } });
    assert.deepEqual(selectPromptHistory(h.state()), ["bob resend", "owner forged", "another participant"]);
    h.store.dispatch({ type: "auth/context", principal: null });
    assert.deepEqual(selectPromptHistory(h.state()), []);
});

test("reload rebuilds only own bounded history and steering redelivery is one request identity", async () => {
    const page = Array.from({ length: 14 }, (_, i) => event(i + 1, `input-${i}`));
    page.push(event(15, "recoverable", alice, { steering: { requestId: "same-request" } }));
    page.push(event(16, "recoverable", alice, { steering: { requestId: "same-request" } }));
    page.push(event(17, "not mine", { provider: "test", subject: "bob" }));
    const h = harness([], { getSessionEventsBefore: async () => page });
    await h.controller.loadPromptHistory("s1");
    assert.deepEqual(selectPromptHistory(h.state()), ["recoverable", ...Array.from({ length: 9 }, (_, i) => `input-${13 - i}`)]);
    assert.equal(h.state().ui.prompt, "");
});

test("failed and rejected input never enters history; late acceptance cannot replace another session draft", async () => {
    const response = Promise.withResolvers();
    let captured;
    const h = harness([event(1, "durable own")], { steerSessionTurn: async (id, options) => {
        captured = { id, options };
        return await response.promise;
    } });
    h.store.dispatch({ type: "steering/stateLoaded", sessionId: "s1", windowSeq: 1,
        state: { supported: true, canWrite: true, steerable: true, expectedTarget: "target" } });
    h.controller.setPrompt("pending guidance");
    const pending = h.controller.steerPrompt();
    assert.deepEqual(selectPromptHistory(h.state()), ["durable own"]);
    h.store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    h.controller.setPrompt("private other draft");
    response.resolve({ ok: false, code: "stale_target" });
    await pending;
    assert.equal(h.state().ui.prompt, "private other draft");
    assert.equal(h.state().sessions.activeSessionId, "s2");
    assert.deepEqual(selectPromptHistory(h.state(), "s1"), ["durable own"]);
    assert.equal(captured.options.expectedTarget, "target");
});

test("recalled multiline edits exit navigation and session switch cannot restore a stale stashed draft", () => {
    const h = harness([event(1, "first\nlast")]);
    h.controller.setPrompt("original draft", 2);
    assert.equal(h.controller.recallPromptHistory(-1), true);
    h.controller.setPrompt("first\nlast edited");
    assert.equal(h.state().ui.promptHistoryNavigation, null);
    assert.equal(h.controller.recallPromptHistory(1), false);
    h.store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    h.controller.setPrompt("second session draft");
    assert.equal(h.controller.recallPromptHistory(1), false);
    assert.equal(h.state().ui.prompt, "second session draft");
    h.store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    assert.equal(h.state().ui.prompt, "first\nlast edited");
    assert.equal(h.state().ui.promptHistoryNavigation, null);
});

test("stale paged history after revocation cannot recreate a gone session recall buffer", async () => {
    const response = Promise.withResolvers();
    const h = harness([], { getSessionEventsBefore: () => response.promise });
    const read = h.controller.loadPromptHistory("s1");
    h.store.dispatch({ type: "sessions/gone", sessionId: "s1" });
    response.resolve([event(1, "revoked private input")]);
    await read;
    assert.equal(h.state().promptHistory.bySessionId.s1, undefined);
    assert.deepEqual(selectPromptHistory(h.state(), "s1"), []);
});

test("reload retains the viewer's accepted but not-yet-delivered guidance from its durable transcript receipt", () => {
    const h = harness([
        event(1, "ordinary own input"),
        { sessionId: "s1", seq: 2, eventType: "session.steering_accepted", createdAt: 2, data: { receipt: {
            schemaVersion: 1, sessionId: "s1", requestId: "accepted-own", clientRequestId: "caller-own",
            sequence: 1, revision: 1, acceptedAt: new Date(2).toISOString(), actor: alice,
            text: "own accepted guidance", status: "pending", disposition: "accepted",
        } } },
        { sessionId: "s1", seq: 3, eventType: "session.steering_accepted", createdAt: 3, data: { receipt: {
            schemaVersion: 1, sessionId: "s1", requestId: "accepted-other", clientRequestId: "caller-other",
            sequence: 2, revision: 1, acceptedAt: new Date(3).toISOString(), actor: { provider: "test", subject: "bob" },
            text: "other participant accepted guidance", status: "pending", disposition: "accepted",
        } } },
    ]);
    assert.deepEqual(selectPromptHistory(h.state()), ["own accepted guidance", "ordinary own input"],
        "reload must not drop accepted input solely because delivery has not occurred");
});

test("accepted receipts remain viewer-filtered and a later delivery/redelivery is one recall identity", () => {
    const accepted = (seq, requestId, actor = alice, over = {}) => ({
        sessionId: "s1", seq, eventType: "session.steering_accepted", createdAt: seq,
        data: { receipt: {
            schemaVersion: 1, sessionId: "s1", requestId, clientRequestId: `caller-${requestId}`,
            sequence: seq, revision: 1, actor, acceptedAt: new Date(seq).toISOString(), text: `guidance-${requestId}`,
            disposition: "accepted", status: "pending", ...over,
        } },
    });
    const h = harness([
        event(1, "own ordinary"),
        accepted(2, "own"),
        accepted(3, "other", { provider: "test", subject: "bob", displayName: "alice" }),
        accepted(4, "foreign", { provider: "other", subject: "alice" }),
        accepted(5, "wrong-session", alice, { sessionId: "s2" }),
        accepted(6, "bad-schema", alice, { schemaVersion: 999 }),
        event(7, "guidance-own", alice, { steering: { requestId: "own" } }),
        event(8, "guidance-own", alice, { steering: { requestId: "own" } }),
    ]);
    assert.deepEqual(selectPromptHistory(h.state()), ["guidance-own", "own ordinary"]);
});
