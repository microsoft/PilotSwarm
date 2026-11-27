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
        blockOffsetPx: -414,
        blockRatio: 0.4,
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
        blockOffsetPx: -414,
        blockRatio: 0.4,
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

function fakeBlock({ top, height, scrollKey = "", clientMessageId = "", taskGroup = "", textContent = "", tagName = "DIV", className = "", leaves = [] }) {
    const dataset = {};
    if (scrollKey) dataset.scrollKey = scrollKey;
    if (clientMessageId) dataset.clientMessageId = clientMessageId;
    if (taskGroup) dataset.taskGroup = taskGroup;
    const block = {
        nodeType: 1,
        tagName,
        className,
        dataset,
        textContent,
        parentElement: null,
        getBoundingClientRect: () => ({ top, bottom: top + height, height }),
        querySelectorAll: () => leaves,
    };
    for (const leaf of leaves) {
        if (leaf && !leaf.parentElement) leaf.parentElement = block;
    }
    return block;
}

function fakeLeaf({ top, height, parentElement = null, clientRectsCount = null }) {
    return {
        nodeType: 1,
        tagName: "DIV",
        className: "ps-line",
        parentElement,
        getBoundingClientRect: () => ({ top, bottom: top + height, height }),
        ...(clientRectsCount != null ? { getClientRects: () => new Array(clientRectsCount) } : {}),
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
            fakeBlock({ top: -400, height: 1000, scrollKey: "preview:m2", tagName: "DETAILS", className: "ps-assistant-preview is-final", leaves: tallLeavesBefore }),
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
        blockOffsetPx: -500,
        blockRatio: 0.5,
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
            fakeBlock({ top: 760, height: 1400, scrollKey: "preview:m2", tagName: "DETAILS", className: "ps-assistant-preview is-final", leaves: tallLeavesAfter }),
            fakeBlock({ top: 2160, height: 600, scrollKey: "preview:m3" }),
        ],
    });
    // Expected: leaf #3 top relative to nodeTop is 1560 - 60 = 1500;
    // 25% into 160px leaf is -40px -> scrollTop = 1500 - (-40) = 1540.
    assert.equal(resolveAnchoredScrollTop(nodeAfter, anchor, 0, "top"), 1540);
});

test("captureScrollAnchor skips collapsible details/nested scrollers and resolve falls back when a leaf has zero rect", () => {
    // Expanded collapsible ChatActivityRun (<details> without .is-final): must
    // anchor on the outer block (leafIndex: -1), never on inner tool-call leaves.
    const innerViewport = { nodeType: 1, tagName: "DIV", className: "ps-activity-run-viewport", parentElement: null };
    const innerLeaf = fakeLeaf({ top: 90, height: 20, parentElement: innerViewport });
    const runBlock = fakeBlock({
        top: 70,
        height: 260,
        scrollKey: "calls:c1",
        tagName: "DETAILS",
        className: "ps-native-tasks ps-activity-run is-done",
        leaves: [innerLeaf],
    });
    innerViewport.parentElement = runBlock;
    const nodeBefore = fakeNode({
        scrollTop: 2080,
        scrollHeight: 5000,
        clientHeight: 600,
        top: 100,
        children: [
            fakeBlock({ top: -1980, height: 2050, scrollKey: "preview:m1" }),
            runBlock,
            fakeBlock({ top: 330, height: 2500, scrollKey: "preview:m2" }),
        ],
    });
    const runAnchor = captureScrollAnchor(nodeBefore);
    assert.equal(runAnchor.key, "sk:calls:c1");
    assert.equal(runAnchor.leafIndex, -1, "collapsible <details> must not descend into inner leaves");
    assert.equal(runAnchor.blockOffsetPx, -30);

    // Even if a stored anchor references a leaf whose rect collapsed to zero
    // height / empty client rects after remount, resolve falls back to the
    // outer block's offset instead of jumping to scrollTop 0.
    const collapsedLeaf = fakeLeaf({ top: 0, height: 0, clientRectsCount: 0 });
    const nodeAfter = fakeNode({
        scrollTop: 0,
        scrollHeight: 4800,
        clientHeight: 600,
        top: 100,
        children: [
            fakeBlock({ top: 100, height: 2050, scrollKey: "preview:m1" }),
            fakeBlock({
                top: 2150,
                height: 44,
                scrollKey: "calls:c1",
                tagName: "DETAILS",
                className: "ps-native-tasks ps-activity-run is-done",
                leaves: [collapsedLeaf],
            }),
            fakeBlock({ top: 2194, height: 2500, scrollKey: "preview:m2" }),
        ],
    });
    const staleLeafAnchor = {
        key: "sk:calls:c1",
        occurrence: 0,
        leafIndex: 0,
        offsetPx: -10,
        ratio: 0.5,
        blockOffsetPx: -30,
        blockRatio: 0.115,
        scrollTop: 2080,
    };
    const resolved = resolveAnchoredScrollTop(nodeAfter, staleLeafAnchor, 0, "top");
    assert.ok(resolved >= 2050 && resolved <= 2100, `expected block-level fallback near 2055, got ${resolved}`);

    // Duplicate sk: keys honor occurrence so repeated keys resolve to the right block.
    const dupNode = fakeNode({
        scrollTop: 0,
        scrollHeight: 3000,
        clientHeight: 500,
        top: 100,
        children: [
            fakeBlock({ top: 100, height: 400, scrollKey: "card:dup" }),
            fakeBlock({ top: 500, height: 400, scrollKey: "card:dup" }),
            fakeBlock({ top: 900, height: 2000, scrollKey: "card:tail" }),
        ],
    });
    assert.equal(
        resolveAnchoredScrollTop(dupNode, { key: "sk:card:dup", occurrence: 1, leafIndex: -1, offsetPx: 0, ratio: 0, blockOffsetPx: 0, blockRatio: 0, scrollTop: 400 }, 0, "top"),
        400,
    );
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
