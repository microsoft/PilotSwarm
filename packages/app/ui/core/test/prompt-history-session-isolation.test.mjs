import test from "node:test";
import assert from "node:assert/strict";
import { createStore, createInitialState, appReducer, PilotSwarmUiController, selectPromptHistory } from "../src/index.js";

const carol = { provider: "test", subject: "carol" };
const event = (sessionId, seq, text, extra = {}) => ({
    sessionId, seq, eventType: "user.message",
    data: { content: text, sender: { kind: "user", ...carol }, ...extra },
});

function tab(transport, sessionId) {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "auth/context", principal: carol });
    store.dispatch({ type: "sessions/loaded", sessions: ["a", "b"].map(sessionId => ({ sessionId, status: "running", canWrite: true })) });
    store.dispatch({ type: "sessions/selected", sessionId });
    for (const id of ["a", "b"]) store.dispatch({ type: "steering/stateLoaded", sessionId: id, windowSeq: 1,
        state: { supported: true, canWrite: true, steerable: true, expectedTarget: `target-${id}` } });
    const controller = new PilotSwarmUiController({ store, transport });
    controller.syncPromptReferenceBrowser = () => {};
    controller.scheduleSessionsRefresh = () => {};
    return { store, controller };
}

test("same canonical user in independent tabs keeps interleaved sends, steers, recalls and draft stashes strictly per session", async () => {
    const pages = { a: [event("a", 1, "a initial")], b: [event("b", 1, "b initial")] };
    const held = { a: Promise.withResolvers(), b: Promise.withResolvers() };
    const entered = { a: Promise.withResolvers(), b: Promise.withResolvers() };
    const transport = {
        getSessionEventsBefore: async sessionId => [...pages[sessionId]],
        getSessionEvents: async sessionId => [...pages[sessionId]],
        sendMessage: async (sessionId, text, options) => {
            pages[sessionId].push(event(sessionId, pages[sessionId].length + 1, text, { clientMessageIds: options.clientMessageIds }));
        },
        steerSessionTurn: async (sessionId, options) => {
            const receipt = { schemaVersion: 1, sessionId, requestId: `steer-${sessionId}`, clientRequestId: options.clientRequestId,
                expectedTarget: options.expectedTarget, text: options.text, actor: carol, sequence: 1, revision: 1,
                status: "pending", disposition: "accepted" };
            pages[sessionId].push({ sessionId, seq: pages[sessionId].length + 1, eventType: "session.steering_accepted", data: { receipt } });
            entered[sessionId].resolve();
            await held[sessionId].promise;
            return { ok: true, receipt };
        },
    };
    const a = tab(transport, "a"), b = tab(transport, "b");
    await Promise.all([a.controller.loadPromptHistory("a"), b.controller.loadPromptHistory("b")]);
    a.controller.setPrompt("a sent");
    b.controller.setPrompt("b sent");
    await Promise.all([a.controller.sendPrompt(), b.controller.sendPrompt()]);
    for (const view of [a, b]) {
        const id = view.store.getState().sessions.activeSessionId;
        view.controller.mergeSessionEvent(id, pages[id].at(-1));
        view.controller.setPrompt(`${id} steer`);
    }
    const acceptingA = a.controller.steerPrompt(), acceptingB = b.controller.steerPrompt();
    await Promise.all([entered.a.promise, entered.b.promise]);
    try {
        a.store.dispatch({ type: "sessions/selected", sessionId: "b" });
        b.store.dispatch({ type: "sessions/selected", sessionId: "a" });
        a.controller.setPrompt("tab-a draft for b", 4);
        b.controller.setPrompt("tab-b draft for a", 7);
    } finally {
        held.b.resolve();
        held.a.resolve();
        await Promise.all([acceptingA, acceptingB]);
    }
    assert.equal(a.store.getState().ui.prompt, "tab-a draft for b");
    assert.equal(b.store.getState().ui.prompt, "tab-b draft for a");
    for (const view of [a, b]) {
        for (const id of ["a", "b"]) {
            for (const row of pages[id]) view.controller.mergeSessionEvent(id, row);
            const entries = selectPromptHistory(view.store.getState(), id);
            assert(entries.length >= 3);
            assert(entries.every(text => text.startsWith(`${id} `)), "same-user identity is not a substitute for captured session identity");
        }
    }
    for (const [view, id, draft, cursor] of [
        [a, "b", "tab-a draft for b", 4], [b, "a", "tab-b draft for a", 7],
    ]) {
        const image = { kind: "image", filename: `tab-${id}-draft.png` };
        view.controller.setPromptAttachments([image]);
        assert.equal(view.controller.recallPromptHistory(-1), true);
        assert.equal(view.store.getState().ui.prompt, `${id} steer`);
        view.store.dispatch({ type: "sessions/selected", sessionId: id === "a" ? "b" : "a" });
        view.store.dispatch({ type: "sessions/selected", sessionId: id });
        assert.equal(view.store.getState().ui.prompt, draft);
        assert.equal(view.store.getState().ui.promptCursor, cursor);
        assert.deepEqual(view.store.getState().ui.promptAttachments, [image]);
        assert.equal(view.store.getState().ui.promptHistoryNavigation, null);
    }
});

test("same-user stale page arrivals after rapid a-b-a navigation never enter another session's recall or overwrite either draft", async () => {
    const responses = { a: Promise.withResolvers(), b: Promise.withResolvers() };
    const h = tab({ getSessionEventsBefore: sessionId => responses[sessionId].promise }, "a");
    h.controller.setPrompt("draft a", 2);
    const readingA = h.controller.loadPromptHistory("a");
    h.store.dispatch({ type: "promptHistory/eventsReceived", sessionId: "a", actor: carol, events: [event("a", 0, "a initial")] });
    h.controller.recallPromptHistory(-1);
    h.store.dispatch({ type: "sessions/selected", sessionId: "b" });
    h.controller.setPrompt("draft b", 3);
    const readingB = h.controller.loadPromptHistory("b");
    h.store.dispatch({ type: "promptHistory/eventsReceived", sessionId: "b", actor: carol, events: [event("b", 0, "b initial")] });
    h.controller.recallPromptHistory(-1);
    h.store.dispatch({ type: "sessions/selected", sessionId: "a" });
    responses.b.resolve([event("b", 1, "b private input")]);
    responses.a.resolve([event("a", 1, "a private input")]);
    await Promise.all([readingA, readingB]);
    assert.deepEqual(selectPromptHistory(h.store.getState()), ["a private input", "a initial"]);
    assert.equal(h.store.getState().ui.prompt, "draft a");
    h.controller.recallPromptHistory(-1);
    assert.equal(h.store.getState().ui.prompt, "a private input");
    h.controller.recallPromptHistory(1);
    assert.equal(h.store.getState().ui.prompt, "draft a");
    assert.equal(h.store.getState().ui.promptCursor, 2);
    h.store.dispatch({ type: "sessions/selected", sessionId: "b" });
    assert.deepEqual(selectPromptHistory(h.store.getState()), ["b private input", "b initial"]);
    assert.equal(h.store.getState().ui.prompt, "draft b");
    assert.equal(h.store.getState().ui.promptCursor, 3);
});
