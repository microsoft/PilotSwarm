// Session turn control in the shared controller (portal and TUI): request
// ids per action (P14), Retry with the same id after a lost response, the
// message fallback only after a definite refusal, Steer eligibility (flag,
// legacy turn, service session, refresh to false) and Stop answers.
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    UI_COMMANDS,
    appReducer,
    classifyTurnControlError,
    createInitialState,
    createStore,
    selectTurnControlView,
} from "../src/index.js";

const SID = "s1";

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function harness({ steer, stop, send, session = {}, flags = { effective: true } } = {}) {
    const calls = { steer: [], stop: [], send: [], features: 0 };
    const transport = {
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
        listSessions: async () => [],
        getSession: async () => null,
        getMyFeatureFlags: async () => {
            calls.features += 1;
            return { userId: 1, flags: [{ featureKey: "sessions.steering", effective: flags.effective }] };
        },
        steerSessionTurn: async (sessionId, options) => {
            calls.steer.push({ sessionId, ...options });
            const answer = typeof steer === "function" ? steer(calls.steer.length, options) : steer;
            if (answer instanceof Error) throw answer;
            return answer;
        },
        stopSessionTurn: async (sessionId, options) => {
            calls.stop.push({ sessionId, ...options });
            const answer = typeof stop === "function" ? stop(calls.stop.length, options) : stop;
            if (answer instanceof Error) throw answer;
            return answer;
        },
        sendMessage: async (sessionId, prompt, options) => {
            calls.send.push({ sessionId, prompt, ...options });
            if (send) return send(calls.send.length, { sessionId, prompt, ...options });
        },
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: SID, title: "T", status: "running", ...session },
        { sessionId: "s2", title: "Other", status: "idle" },
    ] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    store.dispatch({ type: "sessions/merged", session: { sessionId: SID, acceptsTurnControl: true, ...session } });
    store.dispatch({ type: "turnControl/steering", enabled: flags.effective });
    return { controller, store, calls, view: () => selectTurnControlView(store.getState()) };
}

const networkError = () => Object.assign(new TypeError("fetch failed"), {});
const httpError = (status, code) => Object.assign(new Error(`HTTP ${status}`), { status, code });

test("an accepted steer sends the composer text once with a fresh request id and clears the composer", async () => {
    const { controller, store, calls, view } = harness({ steer: { outcome: "accepted", steerId: 7, turn: 2 } });
    controller.setPrompt("use metric units");
    await controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.equal(calls.steer.length, 1);
    assert.equal(calls.steer[0].text, "use metric units");
    assert.ok(calls.steer[0].requestId);
    assert.equal(store.getState().ui.prompt, "");
    assert.equal(view().steer, null);
    assert.equal(view().notice, null);
    assert.equal(calls.send.length, 0);
});

test("a lost response keeps the request; Retry reuses the same id and is recorded once", async () => {
    const { controller, calls, view } = harness({
        steer: (n) => (n === 1 ? networkError() : { outcome: "accepted", steerId: 9, turn: 2, repeat: true }),
    });
    controller.setPrompt("only once");
    await controller.steerActiveSessionTurn();
    assert.equal(view().steer.phase, "unconfirmed");
    assert.equal(view().notice.reason, "unconfirmed");
    assert.equal(view().notice.requestId, calls.steer[0].requestId);
    assert.equal(calls.send.length, 0, "a transport failure never falls back to a message");
    await controller.retryTurnControl("steer", SID);
    assert.equal(calls.steer.length, 2);
    assert.equal(calls.steer[1].requestId, calls.steer[0].requestId, "same request id");
    assert.equal(calls.steer[1].text, "only once", "same immutable text");
    assert.equal(view().steer, null);
    // One control event renders one transcript item.
    const event = { sessionId: SID, seq: 9, eventType: "user.steer", data: { turn: 2, text: "only once", requestId: calls.steer[0].requestId }, createdAt: new Date() };
    controller.mergeSessionEvent(SID, event);
    controller.mergeSessionEvent(SID, event);
    const items = controller.getState().history.bySessionId.get(SID).chat.filter((item) => item.kind === "turn-control");
    assert.equal(items.length, 1);
});

test("Ctrl+T / Steer with an unconfirmed steer pending retries it instead of starting another", async () => {
    const { controller, calls } = harness({ steer: (n) => (n === 1 ? httpError(503) : { outcome: "accepted", steerId: 1, turn: 0 }) });
    controller.setPrompt("first");
    await controller.steerActiveSessionTurn();
    controller.setPrompt("different text");
    await controller.steerActiveSessionTurn();
    assert.equal(calls.steer.length, 2);
    assert.equal(calls.steer[1].requestId, calls.steer[0].requestId);
    assert.equal(calls.steer[1].text, "first");
});

for (const refusal of ["no_turn", "legacy_turn"]) {
    test(`a definite ${refusal} sends the text as a message with a new client message id`, async () => {
        const { controller, calls, view } = harness({ steer: { outcome: refusal } });
        controller.setPrompt("fallback text");
        await controller.steerActiveSessionTurn();
        assert.equal(calls.send.length, 1);
        assert.equal(calls.send[0].prompt, "fallback text");
        assert.equal(calls.send[0].clientMessageIds.length, 1);
        assert.notEqual(calls.send[0].clientMessageIds[0], calls.steer[0].requestId);
        assert.equal(view().notice.reason, "fallback_sent");
        assert.equal(view().notice.clientMessageId, calls.send[0].clientMessageIds[0]);
    });
}

test("a failed fallback is reported and never retries the refused request id", async () => {
    const { controller, calls, view } = harness({ steer: { outcome: "no_turn" } });
    controller.transport.sendMessage = async () => { throw httpError(403, "FORBIDDEN"); };
    controller.setPrompt("x");
    await controller.steerActiveSessionTurn();
    assert.equal(view().notice.reason, "fallback_failed");
    assert.equal(calls.steer.length, 1);
});

test("other refusals and server errors show their reason and restore the text, without a message", async () => {
    for (const [answer, reason] of [
        [{ outcome: "too_many" }, "too_many"],
        [{ outcome: "not_found" }, "not_found"],
        [{ outcome: "request_id_reused" }, "request_id_reused"],
        [{ outcome: "steering_disabled" }, "steering_disabled"],
        [httpError(403, "FORBIDDEN"), "forbidden"],
        [httpError(413, "PAYLOAD_TOO_LARGE"), "too_long"],
        [httpError(400, "INVALID_REQUEST"), "error"],
    ]) {
        const { controller, store, calls, view } = harness({ steer: answer });
        controller.setPrompt("keep me");
        await controller.steerActiveSessionTurn();
        assert.equal(view().notice.reason, reason, reason);
        assert.equal(view().steer, null);
        assert.equal(calls.send.length, 0, `${reason}: no fallback`);
        assert.equal(store.getState().ui.prompt, "keep me", `${reason}: text restored`);
        if (reason === "steering_disabled") assert.equal(view().steeringEnabled, false);
    }
});

test("canSteer needs the flag, a turn that accepts controls, and a writable session", async () => {
    assert.equal(harness().view().canSteer, true);
    assert.equal(harness({ flags: { effective: false } }).view().canSteer, false, "flag off");
    assert.equal(harness({ session: { acceptsTurnControl: false } }).view().canSteer, false, "legacy turn");
    assert.equal(harness({ session: { serviceKind: "regen-distiller" } }).view().canSteer, false, "read-only service session");
    assert.equal(harness({ session: { status: "idle", acceptsTurnControl: false } }).view().canSteer, false, "no turn");
    const off = harness({ flags: { effective: false } });
    off.controller.setPrompt("x");
    await off.controller.steerActiveSessionTurn();
    assert.equal(off.calls.steer.length, 0);
    assert.match(off.store.getState().ui.statusText, /not enabled/);
});

test("eligibility turns false (never undefined) when the turn ends, waits, stops or asks", () => {
    for (const eventType of ["session.turn_completed", "session.turn_stopped", "session.wait_started", "session.input_required_started"]) {
        const { controller, store } = harness();
        controller.mergeSessionEvent(SID, { sessionId: SID, seq: 5, eventType, data: {}, createdAt: new Date() });
        assert.equal(store.getState().sessions.byId[SID].acceptsTurnControl, false, eventType);
    }
});

test("the detailed view refreshes eligibility", async () => {
    const { controller, store } = harness();
    controller.transport.getSession = async () => ({ sessionId: SID, status: "running", activeTurnIndex: 3, turnHigh: 2, acceptsTurnControl: false });
    await controller.syncSessionDetail(SID);
    assert.equal(store.getState().sessions.byId[SID].acceptsTurnControl, false);
    controller.transport.getSession = async () => ({ sessionId: SID, status: "running", activeTurnIndex: 4, turnHigh: 4, acceptsTurnControl: true });
    await controller.syncSessionDetail(SID);
    assert.equal(store.getState().sessions.byId[SID].acceptsTurnControl, true);
});

test("the steering flag is read for the viewer at session load", async () => {
    const { controller, store, calls } = harness({ flags: { effective: true } });
    store.dispatch({ type: "turnControl/steering", enabled: false });
    await controller.refreshSteeringFeature({ force: true });
    assert.equal(calls.features, 1);
    assert.equal(store.getState().turnControl.steeringEnabled, true);
});

test("Stop: each action has its own request id; too_late, no_active_turn and an accepted timeout", async () => {
    const answers = [
        { outcome: "stopped", turnIndex: 2, controlSeq: 5 },
        { outcome: "too_late", turnIndex: 2, controlSeq: 6 },
        { outcome: "no_active_turn", detail: "no turn is running" },
        { outcome: "no_active_turn", detail: "too_many" },
        { outcome: "timeout", turnIndex: 3, controlSeq: 9 },
        { outcome: "timeout", turnIndex: 3 },
    ];
    const { controller, calls, view, store } = harness({ stop: (n) => answers[n - 1] });
    await controller.stopActiveSessionTurn();
    assert.equal(view().notice, null);
    await controller.stopActiveSessionTurn();
    assert.equal(view().notice, null, "too_late is shown on the transcript item");
    assert.match(store.getState().ui.statusText, /Too late/);
    await controller.stopActiveSessionTurn();
    assert.equal(view().notice.reason, "no_active_turn");
    await controller.stopActiveSessionTurn();
    assert.equal(view().notice.reason, "too_many");
    await controller.stopActiveSessionTurn();
    assert.deepEqual([view().notice.reason, view().notice.controlSeq], ["stop_pending_retry", 9], "pending, not an error");
    await controller.stopActiveSessionTurn();
    assert.equal(view().notice.reason, "timeout");
    assert.equal(new Set(calls.stop.map((call) => call.requestId)).size, 6, "one request id per Stop action");
    assert.ok(calls.stop.every((call) => call.reason === "Stopped by user"));
});

test("an unconfirmed Stop is resent with the same request id", async () => {
    const { controller, calls, view } = harness({ stop: (n) => (n === 1 ? networkError() : { outcome: "stopped", turnIndex: 1, controlSeq: 3 }) });
    await controller.stopActiveSessionTurn();
    assert.equal(view().stop.phase, "unconfirmed");
    assert.equal(view().notice.reason, "unconfirmed");
    await controller.retryTurnControl("stop", SID);
    assert.equal(calls.stop[1].requestId, calls.stop[0].requestId);
    assert.equal(view().stop, null);
});

test("dismissing an unconfirmed steer gives it up and returns its text to the composer", async () => {
    const { controller, store, view } = harness({ steer: networkError() });
    controller.setPrompt("give up");
    await controller.steerActiveSessionTurn();
    assert.equal(store.getState().ui.prompt, "");
    controller.dismissTurnControlNotice(SID);
    assert.equal(view().steer, null);
    assert.equal(view().notice, null);
    assert.equal(store.getState().ui.prompt, "give up");
});

test("error classification: definite answers end the request, anything else is unconfirmed", () => {
    assert.equal(classifyTurnControlError(httpError(403)), "forbidden");
    assert.equal(classifyTurnControlError(httpError(413)), "too_long");
    assert.equal(classifyTurnControlError(httpError(404, "NOT_FOUND")), "error");
    assert.equal(classifyTurnControlError(httpError(502)), "unconfirmed");
    assert.equal(classifyTurnControlError(networkError()), "unconfirmed");
});

test("a refusal that arrives after a session switch keeps the text for that session", async () => {
    const answer = deferred();
    const { controller, store, view } = harness({ steer: () => answer.promise });
    controller.setPrompt("guidance for s1");
    const pending = controller.steerActiveSessionTurn();
    store.dispatch({ type: "sessions/selected", sessionId: "s2" });
    controller.setPrompt("draft in s2");
    answer.resolve({ outcome: "too_many" });
    await pending;
    assert.equal(store.getState().ui.prompt, "draft in s2", "the other session's composer is untouched");
    assert.equal(view().notice, null, "s2 has no notice");
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    assert.equal(view().notice.reason, "too_many");
    assert.equal(view().notice.text, "guidance for s1", "kept on the notice");
    assert.equal(controller.restoreTurnControlText(SID), true);
    assert.equal(store.getState().ui.prompt, "guidance for s1");
    assert.equal(view().notice, null);
});

test("a refusal that arrives after a new draft keeps both; Restore appends after the draft", async () => {
    const answer = deferred();
    const { controller, store, view } = harness({ steer: () => answer.promise });
    controller.setPrompt("first guidance");
    const pending = controller.steerActiveSessionTurn();
    controller.setPrompt("a new draft");
    answer.reject(httpError(403, "FORBIDDEN"));
    await pending;
    assert.equal(store.getState().ui.prompt, "a new draft");
    assert.deepEqual([view().notice.reason, view().notice.text], ["forbidden", "first guidance"]);
    controller.restoreTurnControlText(SID);
    assert.equal(store.getState().ui.prompt, "a new draft\n\nfirst guidance");
});

test("an empty-prompt Steer press restores kept text instead of sending", async () => {
    const answer = deferred();
    const { controller, store, calls } = harness({ steer: () => answer.promise });
    controller.setPrompt("kept");
    const pending = controller.steerActiveSessionTurn();
    controller.setPrompt("other");
    answer.resolve({ outcome: "not_found" });
    await pending;
    controller.setPrompt("");
    await controller.steerActiveSessionTurn();
    assert.equal(store.getState().ui.prompt, "kept");
    assert.equal(calls.steer.length, 1);
});

test("dismissing an unconfirmed steer after a new draft keeps both texts", async () => {
    const { controller, store, view } = harness({ steer: networkError() });
    controller.setPrompt("lost answer");
    await controller.steerActiveSessionTurn();
    controller.setPrompt("typed meanwhile");
    controller.dismissTurnControlNotice(SID);
    assert.equal(view().steer, null);
    assert.equal(store.getState().ui.prompt, "typed meanwhile\n\nlost answer");
});

test("a fallback behind an outbox send in flight reports its own send, not the earlier one", async () => {
    const first = deferred();
    const fallback = deferred();
    const { controller, calls, view } = harness({
        steer: { outcome: "no_turn" },
        send: (n) => (n === 1 ? first.promise : fallback.promise),
    });
    controller.setPrompt("an ordinary message");
    const sending = controller.sendPrompt();
    controller.setPrompt("steer that falls back");
    const steering = controller.steerActiveSessionTurn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(view().notice.reason, "no_turn", "refusal shows while the fallback waits");
    assert.equal(calls.send.length, 1, "the fallback waits for the envelope in flight");
    first.resolve();
    await sending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.send.length, 2, "its own envelope is sent next");
    assert.equal(calls.send[1].prompt, "steer that falls back");
    assert.equal(view().notice.reason, "no_turn", "not sent until its own send is answered");
    fallback.reject(httpError(403, "FORBIDDEN"));
    await steering;
    assert.equal(view().notice.reason, "fallback_failed");
    assert.equal(view().notice.clientMessageId, calls.send[1].clientMessageIds[0]);
});

test("a fallback behind an outbox send in flight is sent once its own send succeeds", async () => {
    const first = deferred();
    const { controller, calls, view } = harness({
        steer: { outcome: "legacy_turn" },
        send: (n) => (n === 1 ? first.promise : undefined),
    });
    controller.setPrompt("an ordinary message");
    const sending = controller.sendPrompt();
    controller.setPrompt("fallback text");
    const steering = controller.steerActiveSessionTurn();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(view().notice.reason, "legacy_turn");
    first.resolve();
    await sending;
    await steering;
    assert.equal(view().notice.reason, "fallback_sent");
    assert.equal(calls.send.length, 2);
    assert.equal(view().notice.clientMessageId, calls.send[1].clientMessageIds[0]);
});

for (const phase of ["pending", "queued"]) {
    test(`Steer is unavailable while a ${phase} outbox message is selected and leaves it intact`, async () => {
        const { controller, store, calls, view } = harness({ steer: { outcome: "accepted", steerId: 1, turn: 0 } });
        const item = controller.buildOutboxItem("queued words", phase);
        controller.setSessionOutboxItems(SID, [item]);
        assert.equal(controller.enterPendingPromptEdit(SID, item.id), true);
        assert.equal(view().canSteer, false);
        await controller.steerActiveSessionTurn();
        assert.equal(calls.steer.length, 0);
        assert.equal(store.getState().ui.prompt, "queued words");
        assert.equal(store.getState().outbox.bySessionId[SID][0].text, "queued words");
        assert.match(store.getState().ui.statusText, /pending message is selected/);
    });
}

test("a Stop keeps the unconfirmed steer's notice; each kind has its own Retry/Dismiss", async () => {
    const { controller, calls, view } = harness({
        steer: networkError(),
        stop: { outcome: "stopped", turnIndex: 2, controlSeq: 4 },
    });
    controller.setPrompt("lost steer");
    await controller.steerActiveSessionTurn();
    await controller.stopActiveSessionTurn();
    assert.equal(view().steer.phase, "unconfirmed");
    assert.equal(view().steerNotice.reason, "unconfirmed");
    assert.equal(view().steerNotice.requestId, calls.steer[0].requestId);
    assert.equal(view().stopNotice, null);
    // Eligibility ends, the notice and its request stay recoverable.
    controller.mergeSessionEvent(SID, { sessionId: SID, seq: 3, eventType: "session.turn_stopped", data: { interrupt: "turn-result" }, createdAt: new Date() });
    assert.equal(view().canSteer, false);
    controller.transport.steerSessionTurn = async (sessionId, options) => { calls.steer.push({ sessionId, ...options }); return { outcome: "accepted", steerId: 9, turn: 2, repeat: true }; };
    await controller.retryTurnControl("steer", SID);
    assert.equal(calls.steer[1].requestId, calls.steer[0].requestId);
    assert.equal(view().steerNotice, null);
});

test("Stop and Steer notices are dismissed separately", async () => {
    const { controller, view } = harness({ steer: { outcome: "too_many" }, stop: { outcome: "no_active_turn", detail: "no turn is running" } });
    controller.setPrompt("x");
    await controller.steerActiveSessionTurn();
    await controller.stopActiveSessionTurn();
    assert.equal(view().steerNotice.reason, "too_many");
    assert.equal(view().stopNotice.reason, "no_active_turn");
    controller.dismissTurnControlNotice(SID, "stop");
    assert.equal(view().stopNotice, null);
    assert.equal(view().steerNotice.reason, "too_many");
});
