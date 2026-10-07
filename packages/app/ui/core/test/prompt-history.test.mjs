import test from "node:test";
import assert from "node:assert/strict";
import { createStore, createInitialState, appReducer, PilotSwarmUiController, selectPromptHistory, buildHistoryModel } from "../src/index.js";

const alice = { provider: "test", subject: "alice" };
const event = (seq, text, sender = alice, extra = {}) => ({
    sessionId: "s", seq, eventType: "user.message", createdAt: 1000 + seq,
    data: { content: text, sender: { kind: "user", ...sender }, ...extra },
});
function harness(events = [], transport = {}) {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "auth/context", principal: alice });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s", status: "running" }, { sessionId: "other", status: "idle" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s" });
    store.dispatch({ type: "history/set", sessionId: "s", history: buildHistoryModel(events) });
    const controller = new PilotSwarmUiController({ store, transport });
    controller.syncPromptReferenceBrowser = () => {};
    controller.scheduleSessionsRefresh = () => {};
    return { store, controller, state: () => store.getState() };
}

test("history uses only the current viewer's durable user inputs, newest first, at most ten", () => {
    const events = Array.from({ length: 15 }, (_, i) => event(i + 1, `entry ${i}`));
    events.push(event(16, "other writer", { provider: "test", subject: "bob" }));
    events.push(event(17, "same subject other provider", { provider: "other", subject: "alice" }));
    events.push({ ...event(18, "assistant"), eventType: "assistant.message" });
    events.push(event(19, "system", { kind: "system", ...alice }));
    const h = harness(events);
    assert.deepEqual(selectPromptHistory(h.state()), Array.from({ length: 10 }, (_, i) => `entry ${14 - i}`));
    h.store.dispatch({ type: "sessions/selected", sessionId: "other" });
    assert.deepEqual(selectPromptHistory(h.state()), []);
});

test("delivered steering is user input and recovery duplicates collapse by request identity", () => {
    const h = harness([
        event(1, "ordinary"), event(2, "guidance", alice, { steering: { requestId: "r" } }),
        event(3, "guidance", alice, { steering: { requestId: "r" } }),
        event(4, "last"), event(5, "last"), event(6, "ordinary"),
    ]);
    assert.deepEqual(selectPromptHistory(h.state()), ["ordinary", "last", "guidance", "ordinary"]);
});

test("Up/Down boundary navigation stashes draft and restores it past newest", () => {
    const h = harness([event(1, "oldest"), event(2, "newest")]);
    h.controller.setPrompt("first line\nlast line", 3);
    h.store.dispatch({ type: "ui/promptAttachments", attachments: [{ kind: "image", filename: "draft.png" }] });
    assert.equal(h.controller.recallPromptHistory(-1), true);
    assert.equal(h.state().ui.prompt, "newest");
    assert.equal(h.state().ui.promptCursor, 6);
    assert.equal(h.state().ui.promptAttachments.length, 0);
    h.controller.recallPromptHistory(-1);
    assert.equal(h.state().ui.prompt, "oldest");
    h.controller.recallPromptHistory(1);
    assert.equal(h.state().ui.prompt, "newest");
    h.controller.recallPromptHistory(1);
    assert.equal(h.state().ui.prompt, "first line\nlast line");
    assert.equal(h.state().ui.promptCursor, 3);
    assert.equal(h.state().ui.promptAttachments[0].filename, "draft.png");
    assert.equal(h.state().ui.promptHistoryNavigation, null);
});

test("inside multiline drafts arrows move normally and Down requires active navigation", () => {
    const h = harness([event(1, "old\ninput")]);
    h.controller.setPrompt("a\nb\nc", 3);
    assert.equal(h.controller.recallPromptHistory(-1), false);
    assert.equal(h.controller.recallPromptHistory(1), false);
    h.controller.setPrompt("", 0);
    h.controller.recallPromptHistory(-1);
    h.controller.setPromptCursor(0);
    assert.equal(h.controller.recallPromptHistory(1), false);
    h.controller.setPromptCursor(h.state().ui.prompt.length);
    assert.equal(h.controller.recallPromptHistory(1), true);
    assert.equal(h.state().ui.prompt, "");
});

test("editing recalled input ends navigation without changing history; next Up starts newest", () => {
    const h = harness([event(1, "oldest"), event(2, "newest")]);
    h.controller.recallPromptHistory(-1);
    h.controller.setPrompt("edited newest");
    assert.equal(h.state().ui.promptHistoryNavigation, null);
    assert.equal(h.controller.recallPromptHistory(1), false);
    assert.deepEqual(selectPromptHistory(h.state()), ["newest", "oldest"]);
    h.controller.recallPromptHistory(-1);
    assert.equal(h.state().ui.prompt, "newest");
    h.controller.recallPromptHistory(1);
    assert.equal(h.state().ui.prompt, "edited newest");
});

test("switching sessions and changing viewer reset navigation and isolate history", () => {
    const h = harness([event(1, "mine")]);
    h.controller.recallPromptHistory(-1);
    h.store.dispatch({ type: "sessions/selected", sessionId: "other" });
    assert.equal(h.state().ui.promptHistoryNavigation, null);
    assert.equal(h.controller.recallPromptHistory(-1), false);
    h.store.dispatch({ type: "sessions/selected", sessionId: "s" });
    h.store.dispatch({ type: "auth/context", principal: { provider: "test", subject: "bob" } });
    assert.deepEqual(selectPromptHistory(h.state()), []);
});

test("modal, reference and command menus take priority over history", () => {
    const h = harness([event(1, "mine")]);
    for (const modal of [{ type: "help" }, { type: "slashMenu" }, { type: "mentionMenu" }]) {
        h.store.dispatch({ type: "ui/modal", modal });
        assert.equal(h.controller.recallPromptHistory(-1), false);
    }
    h.store.dispatch({ type: "ui/modal", modal: null });
    h.controller.setPrompt("@file");
    assert.equal(h.controller.recallPromptHistory(-1), false);
    h.controller.setPrompt("@@session");
    assert.equal(h.controller.recallPromptHistory(-1), false);
});

test("accepted sends appear immediately and their durable echo does not create another entry", async () => {
    const h = harness([event(1, "old")], { sendMessage: async () => {}, getSessionEvents: async () => [] });
    h.controller.setPrompt("new");
    await h.controller.sendPrompt();
    assert.equal(h.state().ui.promptHistoryNavigation, null);
    assert.equal(selectPromptHistory(h.state())[0], "new");
    const queued = h.state().outbox.bySessionId.s[0];
    h.store.dispatch({ type: "history/set", sessionId: "s", history: buildHistoryModel([
        event(1, "old"), event(2, "new", alice, { clientMessageIds: queued.clientMessageIds }),
    ]) });
    assert.deepEqual(selectPromptHistory(h.state()), ["new", "old"]);
});

test("a late accepted send cannot enter another viewer's recall buffer", () => {
    const h = harness();
    h.store.dispatch({ type: "auth/context", principal: { provider: "test", subject: "bob" } });
    h.controller.recordAcceptedPrompt("s", "alice private draft", ["message:x"], alice);
    assert.deepEqual(selectPromptHistory(h.state()), []);
});

test("consecutive accepted duplicates do not push different recent inputs out of the ten-entry window", () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.controller.recordAcceptedPrompt("s", `input ${i}`, [`message:${i}`], alice);
    for (let i = 10; i < 30; i++) h.controller.recordAcceptedPrompt("s", "input 9", [`message:${i}`], alice);
    assert.deepEqual(selectPromptHistory(h.state()), Array.from({ length: 10 }, (_, i) => `input ${9 - i}`));
});

test("accepted steering enters recall immediately without requiring a delivery event", async () => {
    const h = harness([], { steerSessionTurn: async (sessionId, options) => ({ ok: true, receipt: {
        schemaVersion: 1, sessionId, ...options, requestId: "r", revision: 1,
        sequence: 1, actor: alice, status: "pending", disposition: "accepted",
    } }) });
    h.store.dispatch({ type: "steering/stateLoaded", sessionId: "s", windowSeq: 1,
        state: { supported: true, steerable: true, canWrite: true, expectedTarget: "t" } });
    h.controller.setPrompt("new guidance");
    await h.controller.steerPrompt();
    assert.deepEqual(selectPromptHistory(h.state()), ["new guidance"]);
});

test("history reads use existing user-event paging and retain a completed scan without rereading", async () => {
    const reads = [];
    const h = harness([], { getSessionEventsBefore: async (...args) => {
        reads.push(args);
        return Array.from({ length: 12 }, (_, i) => event(i + 1, `entry ${i}`));
    } });
    await h.controller.loadPromptHistory("s");
    assert.deepEqual(reads[0], ["s", Number.MAX_SAFE_INTEGER, 100, ["user.message", "session.steering_accepted"]]);
    assert.equal(selectPromptHistory(h.state()).length, 10);
    await h.controller.loadPromptHistory("s");
    assert.equal(reads.length, 1, "completed discovery does not start another network scan");
});

test("an actually outstanding history read rejects late cross-viewer private content", async () => {
    const response = Promise.withResolvers();
    const reads = [];
    const h = harness([], { getSessionEventsBefore: (...args) => { reads.push(args); return response.promise; } });
    const pending = h.controller.loadPromptHistory("s");
    assert.equal(reads.length, 1, "the privacy cut starts at a genuinely issued read, not a completed-scan shortcut");
    assert.equal(h.state().promptHistory.bySessionId.s.scan.loading, true);
    h.store.dispatch({ type: "auth/context", principal: { provider: "test", subject: "bob" } });
    response.resolve([event(15, "private input")]);
    await pending;
    assert.deepEqual(selectPromptHistory(h.state()), []);
    assert.deepEqual(h.state().promptHistory.bySessionId, {}, "the prior viewer's delayed page never rebuilds the new viewer's cache");
});

test("reducer text edits end navigation but cursor changes and old page arrival do not", () => {
    const h = harness([event(1, "old"), event(2, "new")]);
    h.controller.recallPromptHistory(-1);
    h.controller.setPromptCursor(1);
    assert.equal(h.state().ui.promptHistoryNavigation.index, 0);
    h.store.dispatch({ type: "history/set", sessionId: "s", history: buildHistoryModel([event(0, "older")]) });
    h.controller.recallPromptHistory(-1);
    assert.equal(h.state().ui.prompt, "old", "navigation snapshot does not jump when paging arrives");
    h.store.dispatch({ type: "ui/prompt", prompt: "edited", promptCursor: 6 });
    assert.equal(h.state().ui.promptHistoryNavigation, null);
});
