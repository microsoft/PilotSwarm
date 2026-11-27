import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
} from "../src/index.js";

const FIRST = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SECOND = "11111111-2222-3333-4444-555555555555";

function chat(id, text) {
    return { id, messageId: id, role: "assistant", text };
}

function history(...messages) {
    return { chat: messages, activity: [], events: [], lastSeq: messages.length };
}

function setup() {
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport: {} });
    store.dispatch({
        type: "sessions/loaded",
        sessions: [
            { sessionId: FIRST, title: "First", status: "running" },
            { sessionId: SECOND, title: "Second", status: "idle" },
        ],
    });
    store.dispatch({ type: "sessions/selected", sessionId: FIRST });
    store.dispatch({ type: "history/set", sessionId: FIRST, history: history(chat("m1", "one")) });
    return { store, controller };
}

test("new chat preserves a reader's paused viewport and follows only at the bottom", () => {
    const { store, controller } = setup();

    controller.updatePaneScrollFromViewport("chat", 18, { atBottom: false });
    assert.equal(store.getState().ui.followBottom.chat, false);
    assert.equal(store.getState().ui.scroll.chat, 18);

    store.dispatch({
        type: "history/set",
        sessionId: FIRST,
        history: history(chat("m1", "one"), chat("m2", "new text")),
    });
    assert.equal(store.getState().ui.followBottom.chat, false);
    assert.equal(store.getState().ui.scroll.chat, 18,
        "new text moved a reader who had scrolled away from the bottom");

    controller.updatePaneScrollFromViewport("chat", 40, { atBottom: true });
    assert.equal(store.getState().ui.followBottom.chat, true);
    assert.equal(store.getState().ui.scroll.chat, 0);
    store.dispatch({
        type: "history/set",
        sessionId: FIRST,
        history: history(chat("m1", "one"), chat("m2", "new text"), chat("m3", "latest")),
    });
    assert.equal(store.getState().ui.followBottom.chat, true);
    assert.equal(store.getState().ui.scroll.chat, 0,
        "a reader at the bottom stopped following new text");
});

test("paused chat position survives switching sessions", () => {
    const { store, controller } = setup();
    controller.updatePaneScrollFromViewport("chat", 12, { atBottom: false });
    controller.setChatScrollAnchor(FIRST, { key: "txt:Assessment 21", occurrence: 0, offsetPx: -14, scrollTop: 3724 });

    store.dispatch({ type: "sessions/selected", sessionId: SECOND });
    assert.equal(store.getState().ui.followBottom.chat, true);
    assert.equal(controller.getChatScrollAnchor(SECOND), null);
    store.dispatch({ type: "sessions/selected", sessionId: FIRST });

    assert.equal(store.getState().ui.followBottom.chat, false);
    assert.equal(store.getState().ui.scroll.chat, 12);
    assert.deepEqual(controller.getChatScrollAnchor(FIRST), {
        key: "txt:Assessment 21",
        occurrence: 0,
        offsetPx: -14,
        scrollTop: 3724,
    });
});

test("chat scroll anchor clears when returning to bottom-follow and on session eviction", () => {
    const { store, controller } = setup();
    controller.updatePaneScrollFromViewport("chat", 18, { atBottom: false });
    controller.setChatScrollAnchor(FIRST, { key: "txt:Assessment 21", occurrence: 0, offsetPx: -8, scrollTop: 1200 });
    assert.ok(controller.getChatScrollAnchor(FIRST));

    controller.updatePaneScrollFromViewport("chat", 40, { atBottom: true });
    assert.equal(store.getState().ui.followBottom.chat, true);
    assert.equal(controller.getChatScrollAnchor(FIRST), null, "returning to bottom clears any paused anchor");

    controller.updatePaneScrollFromViewport("chat", 15, { atBottom: false });
    controller.setChatScrollAnchor(FIRST, { key: "txt:Assessment 11", occurrence: 1, offsetPx: 4, scrollTop: 900 });
    store.dispatch({ type: "history/evict", sessionIds: [FIRST] });
    assert.equal(controller.getChatScrollAnchor(FIRST), null, "evicting a session drops its scroll anchor");
});
