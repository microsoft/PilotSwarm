import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    createInitialState,
    createStore,
} from "../src/index.js";

const { captureScrollAnchor, resolveAnchoredScrollTop } = await import("../../react/src/web-app.js");

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
    controller.setChatScrollAnchor(FIRST, {
        key: "sk:preview:m21",
        occurrence: 0,
        leafIndex: 3,
        offsetPx: -14,
        ratio: 0.25,
        scrollTop: 3724,
    });

    store.dispatch({ type: "sessions/selected", sessionId: SECOND });
    assert.equal(store.getState().ui.followBottom.chat, true);
    assert.equal(controller.getChatScrollAnchor(SECOND), null);
    store.dispatch({ type: "sessions/selected", sessionId: FIRST });

    assert.equal(store.getState().ui.followBottom.chat, false);
    assert.equal(store.getState().ui.scroll.chat, 12);
    assert.deepEqual(controller.getChatScrollAnchor(FIRST), {
        key: "sk:preview:m21",
        occurrence: 0,
        leafIndex: 3,
        offsetPx: -14,
        ratio: 0.25,
        scrollTop: 3724,
    });
});

test("chat scroll anchor clears when returning to bottom-follow, on keyboard scroll, and on history eviction", () => {
    const { store, controller } = setup();
    controller.updatePaneScrollFromViewport("chat", 18, { atBottom: false });
    controller.setChatScrollAnchor(FIRST, { key: "sk:preview:m21", occurrence: 0, leafIndex: -1, offsetPx: -8, ratio: 0, scrollTop: 1200 });
    assert.ok(controller.getChatScrollAnchor(FIRST));

    // Keyboard/programmatic paused scroll (without fromViewport) clears the stale anchor.
    controller.applyPaneVisualScrollOffset("chat", 5, { followBottom: false });
    assert.equal(store.getState().ui.followBottom.chat, false);
    assert.equal(controller.getChatScrollAnchor(FIRST), null, "programmatic chat scroll clears stale anchor");

    controller.setChatScrollAnchor(FIRST, { key: "sk:preview:m5", occurrence: 0, leafIndex: 0, offsetPx: 0, ratio: 0, scrollTop: 80 });
    controller.updatePaneScrollFromViewport("chat", 40, { atBottom: true });
    assert.equal(store.getState().ui.followBottom.chat, true);
    assert.equal(controller.getChatScrollAnchor(FIRST), null, "returning to bottom clears any paused anchor");

    controller.updatePaneScrollFromViewport("chat", 15, { atBottom: false });
    controller.setChatScrollAnchor(FIRST, { key: "txt:Assessment 11", occurrence: 1, leafIndex: -1, offsetPx: 4, ratio: 0, scrollTop: 900 });
    store.dispatch({ type: "history/evict", sessionIds: [FIRST] });
    assert.equal(controller.getChatScrollAnchor(FIRST), null, "evicting a session drops its scroll anchor");
});

function fakeNode({ scrollTop, scrollHeight, clientHeight, children, top = 100 }) {
    return {
        scrollTop,
        scrollHeight,
        clientHeight,
        children,
        getBoundingClientRect: () => ({ top, bottom: top + clientHeight, height: clientHeight }),
    };
}

function fakeBlock({ top, height, scrollKey = "", clientMessageId = "", textContent = "", leaves = [] }) {
    const dataset = {};
    if (scrollKey) dataset.scrollKey = scrollKey;
    if (clientMessageId) dataset.clientMessageId = clientMessageId;
    return {
        nodeType: 1,
        dataset,
        textContent,
        getBoundingClientRect: () => ({ top, bottom: top + height, height }),
        querySelectorAll: () => leaves,
    };
}

function fakeLeaf({ top, height }) {
    return {
        nodeType: 1,
        getBoundingClientRect: () => ({ top, bottom: top + height, height }),
    };
}

test("captureScrollAnchor and resolveAnchoredScrollTop preserve leaf-level fractional position across reflow", () => {
    // Tall assistant block spanning 1,000px with 5 leaves; viewport top is at y=100,
    // and leaf #3 starts at y=80 (20px scrolled above viewport top, 25% into an 80px leaf).
    const tallLeavesBefore = [
        fakeLeaf({ top: -400, height: 160 }),
        fakeLeaf({ top: -240, height: 160 }),
        fakeLeaf({ top: -80, height: 160 }),
        fakeLeaf({ top: 80, height: 80 }),
        fakeLeaf({ top: 160, height: 200 }),
    ];
    const nodeBefore = fakeNode({
        scrollTop: 900,
        scrollHeight: 3000,
        clientHeight: 600,
        top: 100,
        children: [
            fakeBlock({ top: -900, height: 500, scrollKey: "preview:m1" }),
            fakeBlock({ top: -400, height: 1000, scrollKey: "preview:m2", leaves: tallLeavesBefore }),
            fakeBlock({ top: 600, height: 400, scrollKey: "preview:m3" }),
        ],
    });
    const anchor = captureScrollAnchor(nodeBefore);
    assert.deepEqual(anchor, {
        key: "sk:preview:m2",
        occurrence: 0,
        leafIndex: 3,
        offsetPx: -20,
        ratio: 0.25,
        scrollTop: 900,
    });

    // Narrower viewport reflows blocks above and grows leaf #3 from 80px to 160px,
    // starting fresh at scrollTop=0 (nodeTop=60). Leaf #3 is now at y=1560.
    const tallLeavesAfter = [
        fakeLeaf({ top: 760, height: 260 }),
        fakeLeaf({ top: 1020, height: 260 }),
        fakeLeaf({ top: 1280, height: 280 }),
        fakeLeaf({ top: 1560, height: 160 }),
        fakeLeaf({ top: 1720, height: 320 }),
    ];
    const nodeAfter = fakeNode({
        scrollTop: 0,
        scrollHeight: 4200,
        clientHeight: 600,
        top: 60,
        children: [
            fakeBlock({ top: 60, height: 700, scrollKey: "preview:m1" }),
            fakeBlock({ top: 760, height: 1400, scrollKey: "preview:m2", leaves: tallLeavesAfter }),
            fakeBlock({ top: 2160, height: 600, scrollKey: "preview:m3" }),
        ],
    });
    // Expected: leaf #3 top relative to nodeTop is 1560 - 60 = 1500;
    // 25% into 160px leaf is -40px -> scrollTop = 1500 - (-40) = 1540.
    assert.equal(resolveAnchoredScrollTop(nodeAfter, anchor, 0, "top"), 1540);
});

test("captureScrollAnchor handles duplicate text keys, zero-height children, hidden containers, and fallbacks", () => {
    // Hidden/non-scrollable container returns null.
    assert.equal(captureScrollAnchor(fakeNode({ scrollTop: 0, scrollHeight: 400, clientHeight: 400, children: [] })), null);
    assert.equal(captureScrollAnchor(fakeNode({ scrollTop: 0, scrollHeight: 0, clientHeight: 0, children: [] })), null);

    // Duplicate text fallback picks the 2nd occurrence and skips empty/zero-height nodes.
    const node = fakeNode({
        scrollTop: 320,
        scrollHeight: 2000,
        clientHeight: 500,
        top: 100,
        children: [
            fakeBlock({ top: -120, height: 80, textContent: "Repeated line" }),
            fakeBlock({ top: 108, height: 0, textContent: "Collapsed" }),
            fakeBlock({ top: 108, height: 40, textContent: "   " }),
            fakeBlock({ top: 112, height: 60, textContent: "Repeated line" }),
        ],
    });
    const anchor = captureScrollAnchor(node);
    assert.equal(anchor.key, "txt:Repeated line");
    assert.equal(anchor.occurrence, 1);
    assert.equal(anchor.offsetPx, 12);

    // Bottom mode always pins to bottom; missing key falls back to clamped scrollTop.
    assert.equal(resolveAnchoredScrollTop(node, anchor, 0, "bottom"), 1500);
    const missingAnchor = { key: "sk:preview:gone", occurrence: 0, leafIndex: -1, offsetPx: 0, ratio: 0, scrollTop: 9999 };
    assert.equal(resolveAnchoredScrollTop(node, missingAnchor, 0, "top"), 1500);
});
