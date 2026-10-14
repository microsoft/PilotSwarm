// Convert a queued message to a steer, or cancel it (portal and TUI share
// this controller). Steer now sends the queued text as a steer that replaces
// the queued message; the message stays queued ("Steering…") until the
// orchestration drops it (delivered) or the steer misses (still queued).
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    UI_COMMANDS,
    appReducer,
    createInitialState,
    createStore,
    selectQueuedMessageActions,
    selectStatusBar,
    buildHelpModalRows,
} from "../src/index.js";

const SID = "s1";

function harness({ steer = { outcome: "accepted", steerId: 70, turn: 2 }, session = {}, flags = { effective: true } } = {}) {
    const calls = { steer: [], cancel: [], send: [] };
    const transport = {
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
        listSessions: async () => [],
        getSession: async () => null,
        getMyFeatureFlags: async () => ({ userId: 1, flags: [{ featureKey: "sessions.steering", effective: flags.effective }] }),
        steerSessionTurn: async (sessionId, options) => {
            calls.steer.push({ sessionId, ...options });
            const answer = typeof steer === "function" ? steer(calls.steer.length, options) : steer;
            if (answer instanceof Error) throw answer;
            return answer;
        },
        cancelPendingMessage: async (sessionId, ids) => { calls.cancel.push({ sessionId, ids }); },
        sendMessage: async (sessionId, prompt, options) => { calls.send.push({ sessionId, prompt, ...options }); },
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "T", status: "running", ...session }] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    store.dispatch({ type: "sessions/merged", session: { sessionId: SID, acceptsTurnControl: true, ...session } });
    store.dispatch({ type: "turnControl/steering", enabled: flags.effective });
    const queue = (text = "and let me know what it is doing", extra = {}) => {
        const item = { ...controller.buildOutboxItem(text, "queued"), ...extra };
        controller.setSessionOutboxItems(SID, [...controller.getSessionOutbox(SID), item]);
        return item;
    };
    const item = (id) => controller.getSessionOutbox(SID).find((entry) => entry.id === id);
    const block = (id) => selectQueuedMessageActions(store.getState(), SID).find((entry) => entry.itemId === id);
    const event = (eventType, data, seq) => controller.reconcileOutboxAgainstEvent(SID, { sessionId: SID, seq, eventType, data });
    return { controller, store, calls, queue, item, block, event };
}

const networkError = () => new TypeError("fetch failed");

test("Steer now sends the queued text as a steer that replaces the queued message, and shows Steering…", async () => {
    const h = harness();
    const x = h.queue("check the build");
    await h.controller.convertQueuedToSteer(SID, x.id);
    assert.equal(h.calls.steer.length, 1);
    assert.deepEqual({ text: h.calls.steer[0].text, replaces: h.calls.steer[0].replacesClientMessageId }, { text: "check the build", replaces: x.id });
    assert.ok(h.calls.steer[0].requestId);
    assert.equal(h.item(x.id).phase, "steering");
    assert.equal(h.block(x.id).phaseLabel, "Steering…");
    assert.equal(h.block(x.id).canSteer, false);
    assert.equal(h.block(x.id).canCancel, false);
    // A second click while it is open sends nothing.
    await h.controller.convertQueuedToSteer(SID, x.id);
    assert.equal(h.calls.steer.length, 1);
    assert.equal(h.calls.send.length, 0);
});

test("delivered: the item stays Steering… until the orchestration's converted_to_steer receipt removes it", async () => {
    const h = harness();
    const x = h.queue();
    await h.controller.convertQueuedToSteer(SID, x.id);
    h.event("session.control_outcome", { seq: 70, turn: 2, outcome: "delivered" }, 80);
    assert.equal(h.item(x.id).phase, "steering");
    h.event("pending_messages.cancelled", { clientMessageIds: [x.id], reason: "converted_to_steer" }, 81);
    assert.equal(h.item(x.id), undefined);
    assert.equal(h.calls.send.length, 0);
});

test("not delivered: the item is queued again with a notice; nothing is re-sent; the next Steer now uses a new request id", async () => {
    const h = harness();
    const x = h.queue();
    await h.controller.convertQueuedToSteer(SID, x.id);
    const first = h.calls.steer[0].requestId;
    h.event("session.control_outcome", { seq: 70, turn: 2, outcome: "not_delivered" }, 80);
    assert.equal(h.item(x.id).phase, "queued");
    assert.equal(h.block(x.id).notice, "Could not steer: the turn ended before the agent read it. Still queued.");
    assert.equal(h.calls.send.length, 0);
    await h.controller.convertQueuedToSteer(SID, x.id);
    assert.notEqual(h.calls.steer[1].requestId, first);
    assert.equal(h.block(x.id).notice, null);
});

for (const [outcome, notice] of [
    ["no_turn", "Could not steer: no turn is running. Still queued."],
    ["steering_disabled", "Could not steer: steering is not enabled for you. Still queued."],
    ["too_many", "Could not steer: too many open steers on this turn. Still queued."],
]) {
    test(`refused ${outcome}: queued again with a notice, and no fallback message`, async () => {
        const h = harness({ steer: { outcome } });
        const x = h.queue();
        await h.controller.convertQueuedToSteer(SID, x.id);
        assert.equal(h.item(x.id).phase, "queued");
        assert.equal(h.block(x.id).notice, notice);
        assert.equal(h.calls.send.length, 0);
    });
}

test("already_received: the message already reached the agent; its own receipt clears it", async () => {
    const h = harness({ steer: { outcome: "already_received" } });
    const x = h.queue();
    await h.controller.convertQueuedToSteer(SID, x.id);
    assert.equal(h.item(x.id).phase, "queued");
    assert.equal(h.block(x.id).notice, "Could not steer: the agent already has this message.");
    h.event("user.message", { content: x.text, clientMessageIds: [x.id] }, 90);
    assert.equal(h.item(x.id), undefined);
});

test("no answer: queued again; Steer now retries with the same request id until a definite answer", async () => {
    let call = 0;
    const h = harness({ steer: () => (++call === 1 ? networkError() : { outcome: "no_turn" }) });
    const x = h.queue();
    await h.controller.convertQueuedToSteer(SID, x.id);
    assert.equal(h.item(x.id).phase, "queued");
    assert.equal(h.block(x.id).notice, "Could not steer: no answer from the server. Still queued.");
    await h.controller.convertQueuedToSteer(SID, x.id);
    assert.equal(h.calls.steer[1].requestId, h.calls.steer[0].requestId);
    await h.controller.convertQueuedToSteer(SID, x.id);
    assert.notEqual(h.calls.steer[2].requestId, h.calls.steer[1].requestId);
});

test("Steer now is offered only on a queued text item while a running turn accepts steering; Cancel always", () => {
    const allowed = harness();
    const x = allowed.queue();
    const pending = allowed.controller.buildOutboxItem("not yet durable", "pending");
    allowed.controller.setSessionOutboxItems(SID, [...allowed.controller.getSessionOutbox(SID), pending]);
    const withImage = allowed.queue("look", { attachments: [{ filename: "a.png", contentType: "image/png", sizeBytes: 3 }] });
    assert.deepEqual([allowed.block(x.id).canSteer, allowed.block(x.id).canCancel], [true, true]);
    assert.equal(allowed.block(pending.id), undefined, "a pending (not yet durable) message has no row");
    assert.deepEqual([allowed.block(withImage.id).canSteer, allowed.block(withImage.id).canCancel], [false, true]);

    for (const options of [{ flags: { effective: false } }, { session: { status: "idle" } }, { session: { acceptsTurnControl: false } }, { session: { serviceKind: "distiller" } }]) {
        const h = harness(options);
        const y = h.queue();
        assert.deepEqual([h.block(y.id).canSteer, h.block(y.id).canCancel], [false, true], JSON.stringify(options));
    }
});

test("Cancel on a queued item sends the tombstone; its receipt removes it", async () => {
    const h = harness();
    const x = h.queue();
    await h.controller.cancelOutboxItem(SID, x.id);
    assert.deepEqual(h.calls.cancel, [{ sessionId: SID, ids: [x.id] }]);
    assert.equal(h.block(x.id).phaseLabel, "Cancelling…");
    h.event("pending_messages.cancelled", { clientMessageIds: [x.id], reason: "drain-incoming" }, 85);
    assert.equal(h.item(x.id), undefined);
});

test("Steer (Ctrl+T) on a selected queued item converts it; on a selected pending item it refuses", async () => {
    const h = harness();
    const x = h.queue("selected queued");
    h.controller.selectPreviousPendingPrompt(SID);
    assert.equal(h.store.getState().ui.promptEdit.itemId, x.id);
    await h.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.equal(h.calls.steer.length, 1);
    assert.equal(h.calls.steer[0].replacesClientMessageId, x.id);
    assert.equal(h.store.getState().ui.promptEdit, null);

    const p = harness();
    const pending = p.controller.buildOutboxItem("pending text", "pending");
    p.controller.setSessionOutboxItems(SID, [pending]);
    p.controller.selectPreviousPendingPrompt(SID);
    await p.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.equal(p.calls.steer.length, 0);
});

test("the TUI status line offers ctrl-t steer now on a selected queued message only when it applies; help lists the keys", () => {
    const h = harness();
    const x = h.queue();
    h.controller.selectPreviousPendingPrompt(SID);
    h.store.dispatch({ type: "ui/focus", focusRegion: "prompt" });
    assert.match(selectStatusBar(h.store.getState()).right, /queued prompt selected · ctrl-t steer now · d delete/);
    const off = harness({ flags: { effective: false } });
    off.queue();
    off.controller.selectPreviousPendingPrompt(SID);
    off.store.dispatch({ type: "ui/focus", focusRegion: "prompt" });
    assert.match(selectStatusBar(off.store.getState()).right, /queued prompt selected · d delete/);
    assert.doesNotMatch(selectStatusBar(off.store.getState()).right, /steer now/);
    const help = buildHelpModalRows().map((row) => row.map((run) => run.text).join("")).join("\n");
    assert.match(help, /selected queued message: steer now/);
    assert.match(help, /selected queued message: cancel it/);
    assert.ok(x.id);
});
