// Convert queued messages to steers, or cancel them (portal and TUI share
// this controller). Steer sends a queued text as a steer that replaces the
// queued message; the message waits as "↪ steering" until the model reads the
// steer (then it leaves the strip) or the steer misses (queued again).
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    UI_COMMANDS,
    appReducer,
    createInitialState,
    createStore,
    selectOutboxOverlayBlocks,
    selectOutboxOverlayLines,
    selectStatusBar,
    selectSteerAction,
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
    const block = (id) => selectOutboxOverlayBlocks(store.getState(), 80).blocks.find((entry) => entry.itemId === id);
    const text = (id) => block(id).lines.map((line) => line.map((run) => run.text).join("")).join("\n");
    const event = (eventType, data, seq) => controller.reconcileOutboxAgainstEvent(SID, { sessionId: SID, seq, eventType, data });
    return { controller, store, calls, queue, item, block, text, event };
}

const networkError = () => new TypeError("fetch failed");

test("Steer sends the queued text as a steer that replaces the queued message; its line reads ↪ steering", async () => {
    const h = harness();
    const x = h.queue("check the build");
    await h.controller.convertQueuedToSteer(SID, x.id);
    assert.equal(h.calls.steer.length, 1);
    assert.deepEqual({ text: h.calls.steer[0].text, replaces: h.calls.steer[0].replacesClientMessageId }, { text: "check the build", replaces: x.id });
    assert.ok(h.calls.steer[0].requestId);
    assert.equal(h.item(x.id).phase, "steering");
    assert.equal(h.block(x.id).phaseLabel, "steering");
    assert.match(h.text(x.id), /↪ You: check the build/);
    assert.equal(selectOutboxOverlayBlocks(h.store.getState(), 80).header[0].text, " queued prompts: 1 steering ");
    // A second click while it is open sends nothing.
    await h.controller.convertQueuedToSteer(SID, x.id);
    assert.equal(h.calls.steer.length, 1);
    assert.equal(h.calls.send.length, 0);
});

test("delivered: the item stays (out of the strip once read) until the orchestration's converted_to_steer receipt removes it", async () => {
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

test("Steer acts on the typed text, else a selected queued message, else every queued message (not while idle, legacy or steering off)", () => {
    const h = harness();
    const action = () => selectSteerAction(h.store.getState(), SID);
    assert.deepEqual(action(), { available: true, target: "none", count: 0, itemIds: [], blocked: null, sending: false });
    const x = h.queue("first");
    const pending = h.controller.buildOutboxItem("not yet durable", "pending");
    h.controller.setSessionOutboxItems(SID, [...h.controller.getSessionOutbox(SID), pending]);
    const y = h.queue("second");
    assert.deepEqual(action(), { available: true, target: "queue", count: 2, itemIds: [x.id, y.id], blocked: null, sending: false });
    h.controller.setPrompt("typed guidance");
    assert.deepEqual(action(), { available: true, target: "text", count: 0, itemIds: [], blocked: null, sending: false });
    h.controller.setPrompt("");
    h.controller.enterPendingPromptEdit(SID, y.id);
    assert.deepEqual(action(), { available: true, target: "selected", count: 1, itemIds: [y.id], blocked: null, sending: false });
    h.controller.enterPendingPromptEdit(SID, pending.id);
    assert.deepEqual(action(), { available: true, target: "selected", count: 0, itemIds: [], blocked: "Only a queued message can be steered", sending: false });
    for (const options of [{ flags: { effective: false } }, { session: { status: "idle", acceptsTurnControl: false } }, { session: { acceptsTurnControl: false } }, { session: { serviceKind: "distiller" } }]) {
        const off = harness(options);
        off.queue();
        assert.equal(selectSteerAction(off.store.getState(), SID).available, false, JSON.stringify(options));
    }
});

test("a message with an image cannot be steered: with one queued, Steer on the queue is blocked; selected, too", () => {
    const h = harness();
    const x = h.queue("text only");
    const withImage = h.queue("look", { attachments: [{ filename: "a.png", contentType: "image/png", sizeBytes: 3 }] });
    const blocked = "A queued message has an image; images cannot be steered";
    assert.deepEqual(selectSteerAction(h.store.getState(), SID), { available: true, target: "queue", count: 2, itemIds: [], blocked, sending: false });
    h.controller.enterPendingPromptEdit(SID, withImage.id);
    assert.deepEqual(selectSteerAction(h.store.getState(), SID), { available: true, target: "selected", count: 0, itemIds: [], blocked: "This message has an image; images cannot be steered", sending: false });
    h.controller.enterPendingPromptEdit(SID, x.id);
    assert.equal(selectSteerAction(h.store.getState(), SID).blocked, null);
});

test("Steer with an empty box steers every queued message in order, each replacing its message", async () => {
    let seq = 70;
    const h = harness({ steer: () => ({ outcome: "accepted", steerId: seq++, turn: 2 }) });
    const x = h.queue("first");
    const y = h.queue("second");
    await h.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.deepEqual(h.calls.steer.map((call) => [call.text, call.replacesClientMessageId]), [["first", x.id], ["second", y.id]]);
    assert.notEqual(h.calls.steer[0].requestId, h.calls.steer[1].requestId);
    assert.deepEqual([h.item(x.id).phase, h.item(y.id).phase], ["steering", "steering"]);
    assert.equal(h.calls.send.length, 0);
});

test("Steer with an empty box and a queued image sends nothing and says why", async () => {
    const h = harness();
    h.queue("first");
    h.queue("look", { attachments: [{ filename: "a.png", contentType: "image/png", sizeBytes: 3 }] });
    await h.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.equal(h.calls.steer.length, 0);
    assert.equal(h.store.getState().ui.statusText, "A queued message has an image; images cannot be steered");
});

test("a second Steer while the queue is being steered does nothing: one batch, in order", async () => {
    const answers = [];
    let seq = 70;
    const h = harness({ steer: () => new Promise((resolve) => answers.push(() => resolve({ outcome: "accepted", steerId: seq++, turn: 2 }))) });
    const [a, b] = [h.queue("a"), h.queue("b")];
    const first = h.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(selectSteerAction(h.store.getState(), SID).sending, true);
    await h.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.equal(h.calls.steer.length, 1);
    answers.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    answers.shift()();
    await first;
    assert.deepEqual(h.calls.steer.map((call) => call.replacesClientMessageId), [a.id, b.id]);
    assert.equal(selectSteerAction(h.store.getState(), SID).sending, false);
});

test("while the queue is being steered, Steer on typed text or a selected message does nothing either", async () => {
    const answers = [];
    let seq = 70;
    const h = harness({ steer: () => new Promise((resolve) => answers.push(() => resolve({ outcome: "accepted", steerId: seq++, turn: 2 }))) });
    const [a, b] = [h.queue("a"), h.queue("b")];
    const batch = h.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    await new Promise((resolve) => setImmediate(resolve));
    // Not awaited: a steer that went out would wait for its held answer.
    h.controller.setPrompt("typed meanwhile");
    h.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.store.getState().ui.prompt, "typed meanwhile");
    h.controller.setPrompt("");
    h.controller.enterPendingPromptEdit(SID, b.id);
    h.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.steer.length, 1);
    assert.equal(h.store.getState().ui.statusText, "Steering your queued messages; wait for it to finish");
    h.controller.exitPendingPromptEdit();
    answers.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    answers.shift()();
    await batch;
    assert.deepEqual(h.calls.steer.map((call) => call.replacesClientMessageId), [a.id, b.id]);
});

test("one steer request at a time: while a typed steer or a queued message's steer waits for its answer, Steer does nothing", async () => {
    const answers = [];
    let seq = 70;
    const h = harness({ steer: () => new Promise((resolve) => answers.push(() => resolve({ outcome: "accepted", steerId: seq++, turn: 2 }))) });
    const x = h.queue("queued");
    h.controller.setPrompt("typed guidance");
    const typed = h.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    await new Promise((resolve) => setImmediate(resolve));
    h.controller.enterPendingPromptEdit(SID, x.id);
    h.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.steer.length, 1);
    assert.equal(h.store.getState().ui.statusText, "A steer is being sent; wait for its answer");
    answers.shift()();
    await typed;
    // The selected message's steer waits; typed text meanwhile stays in the box.
    const converting = h.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.item(x.id).phase, "steering");
    assert.equal(selectSteerAction(h.store.getState(), SID).sending, true);
    h.controller.setPrompt("more guidance");
    h.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.steer.length, 2);
    assert.equal(h.store.getState().ui.prompt, "more guidance");
    answers.shift()();
    await converting;
    assert.equal(selectSteerAction(h.store.getState(), SID).sending, false);
});

test("past the open-steer cap the first messages go; the rest stay queued with the too-many notice and are not sent", async () => {
    let call = 0;
    const h = harness({ steer: () => (++call === 1 ? { outcome: "accepted", steerId: 70, turn: 2 } : { outcome: "too_many" }) });
    const [a, b, c] = [h.queue("a"), h.queue("b"), h.queue("c")];
    await h.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.equal(h.calls.steer.length, 2);
    assert.equal(h.item(a.id).phase, "steering");
    for (const rest of [b, c]) {
        assert.equal(h.item(rest.id).phase, "queued");
        assert.equal(h.block(rest.id).notice, "Could not steer: too many open steers on this turn. Still queued.");
    }
});

test("Cancel on a queued item sends the tombstone; its receipt removes it", async () => {
    const h = harness();
    const x = h.queue();
    await h.controller.cancelOutboxItem(SID, x.id);
    assert.deepEqual(h.calls.cancel, [{ sessionId: SID, ids: [x.id] }]);
    assert.equal(h.block(x.id).phaseLabel, "Cancelling · takes effect when the turn ends");
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

test("the TUI status line offers ctrl-t steer on a selected queued message, and on the queue with an empty prompt, only when it applies; help lists the keys", () => {
    const h = harness();
    const x = h.queue();
    h.store.dispatch({ type: "ui/focus", focusRegion: "prompt" });
    assert.match(selectStatusBar(h.store.getState()).right, /^ctrl-x stop · ctrl-t steer 1 queued · /);
    h.queue("with image", { attachments: [{ filename: "a.png", contentType: "image/png", sizeBytes: 3 }] });
    assert.doesNotMatch(selectStatusBar(h.store.getState()).right, /ctrl-t steer/);
    h.controller.setSessionOutboxItems(SID, [h.item(x.id)]);
    h.controller.selectPreviousPendingPrompt(SID);
    assert.match(selectStatusBar(h.store.getState()).right, /queued prompt selected · ctrl-t steer now · d cancel/);
    const off = harness({ flags: { effective: false } });
    off.queue();
    off.controller.selectPreviousPendingPrompt(SID);
    off.store.dispatch({ type: "ui/focus", focusRegion: "prompt" });
    assert.match(selectStatusBar(off.store.getState()).right, /queued prompt selected · d cancel/);
    assert.doesNotMatch(selectStatusBar(off.store.getState()).right, /steer now/);
    const help = buildHelpModalRows().map((row) => row.map((run) => run.text).join("")).join("\n");
    assert.match(help, /selected queued message: steer now/);
    assert.match(help, /empty prompt: steer every queued message/);
    assert.match(help, /selected queued message: cancel it/);
    assert.ok(x.id);
});

test("the message's own receipt while Steering… removes it, and a late answer does not bring it back", async () => {
    let answer;
    const h = harness({ steer: () => new Promise((resolve) => { answer = resolve; }) });
    const x = h.queue();
    const pending = h.controller.convertQueuedToSteer(SID, x.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.item(x.id).phase, "steering");
    h.event("user.message", { content: x.text, clientMessageIds: [x.id] }, 95);
    assert.equal(h.item(x.id), undefined);
    answer({ outcome: "already_received" });
    await pending;
    assert.equal(h.item(x.id), undefined);
    assert.equal(h.controller.getSessionOutbox(SID).length, 0);
});

test("no answer, then the steer's record and its not_delivered outcome arrive: queued with that notice, and the next Steer now uses a new request id", async () => {
    let call = 0;
    const h = harness({ steer: () => (++call === 1 ? networkError() : { outcome: "accepted", steerId: 120, turn: 3 }) });
    const x = h.queue();
    await h.controller.convertQueuedToSteer(SID, x.id);
    const lost = h.calls.steer[0].requestId;
    assert.equal(h.item(x.id).phase, "queued");
    // The server had recorded it: its steer and outcome arrive on the stream.
    h.event("user.steer", { turn: 2, text: x.text, requestId: lost, actor: null, replacesClientMessageId: x.id }, 100);
    h.event("session.control_outcome", { seq: 100, turn: 2, outcome: "not_delivered" }, 101);
    assert.equal(h.item(x.id).phase, "queued");
    assert.equal(h.block(x.id).notice, "Could not steer: the turn ended before the agent read it. Still queued.");
    await h.controller.convertQueuedToSteer(SID, x.id);
    assert.notEqual(h.calls.steer[1].requestId, lost);
});

test("no answer, then the steer's record and a delivered outcome arrive: the converted_to_steer receipt removes the message", async () => {
    const h = harness({ steer: () => networkError() });
    const x = h.queue();
    await h.controller.convertQueuedToSteer(SID, x.id);
    const lost = h.calls.steer[0].requestId;
    h.event("user.steer", { turn: 2, text: x.text, requestId: lost, actor: null, replacesClientMessageId: x.id }, 100);
    h.event("session.control_outcome", { seq: 100, turn: 2, outcome: "delivered" }, 101);
    h.event("pending_messages.cancelled", { clientMessageIds: [x.id], reason: "converted_to_steer" }, 102);
    assert.equal(h.item(x.id), undefined);
});

test("the strip shows each message once: the flattened strip (TUI) is each block's lines and its phase and notice", async () => {
    const h = harness({ steer: { outcome: "too_many" } });
    const a = h.queue("first queued message");
    const b = h.queue("second queued message");
    const { header, blocks } = selectOutboxOverlayBlocks(h.store.getState(), 60);
    assert.deepEqual(selectOutboxOverlayLines(h.store.getState(), 60), [header, ...blocks.flatMap((block) => block.lines)]);
    await h.controller.convertQueuedToSteer(SID, a.id);
    await h.controller.cancelOutboxItem(SID, b.id);
    const flat = selectOutboxOverlayLines(h.store.getState(), 60).map((line) => line.map((run) => run.text).join("")).join("\n");
    assert.match(flat, /first queued message\n +Could not steer: too many open steers on this turn\. Still queued\./);
    assert.match(flat, /second queued message\n +Cancelling · takes effect when the turn ends/);
    assert.deepEqual(blocks.map((block) => block.itemId), [a.id, b.id]);
    const text = (block) => block.lines.map((line) => line.map((run) => run.text).join("")).join("\n");
    assert.match(text(blocks[0]), /first queued message/);
    assert.doesNotMatch(text(blocks[0]), /second queued message/);
});

test("once the model has read the converted steer, its line leaves the strip; a later not_delivered brings it back queued with its notice", async () => {
    const h = harness();
    const x = h.queue();
    const y = h.queue("still waiting");
    await h.controller.convertQueuedToSteer(SID, x.id);
    assert.equal(h.block(x.id).phaseLabel, "steering");
    h.event("session.steer_confirmed", { seq: 70, turn: 2, messageId: "m-1" }, 80);
    assert.equal(h.item(x.id).phase, "steering");
    assert.equal(h.block(x.id), undefined);
    assert.equal(selectOutboxOverlayBlocks(h.store.getState(), 80).header[0].text, " queued prompts: 1 queued ");
    assert.ok(h.block(y.id));
    // The turn is then stopped: the steer is not delivered and the message is queued again.
    h.event("session.control_outcome", { seq: 70, turn: 2, outcome: "not_delivered" }, 81);
    assert.equal(h.item(x.id).phase, "queued");
    assert.equal(h.block(x.id).notice, "Could not steer: the turn ended before the agent read it. Still queued.");
});

test("a confirmation already loaded when the steer is accepted takes the line out at once", async () => {
    const h = harness();
    const x = h.queue();
    h.store.dispatch({ type: "history/set", sessionId: SID, history: { chat: [], activity: [], events: [
        { sessionId: SID, seq: 80, eventType: "session.steer_confirmed", data: { seq: 70, turn: 2, messageId: "m-1" } },
    ], lastSeq: 80 } });
    await h.controller.convertQueuedToSteer(SID, x.id);
    assert.equal(h.block(x.id), undefined);
    assert.equal(selectOutboxOverlayBlocks(h.store.getState(), 80).header, null);
});

test("a cancelled queued message says when the cancel takes effect: at turn end while a turn runs", async () => {
    const running = harness();
    const x = running.queue();
    await running.controller.cancelOutboxItem(SID, x.id);
    assert.equal(running.block(x.id).phaseLabel, "Cancelling · takes effect when the turn ends");
    const idle = harness({ session: { status: "idle", acceptsTurnControl: false } });
    const y = idle.queue();
    await idle.controller.cancelOutboxItem(SID, y.id);
    assert.equal(idle.block(y.id).phaseLabel, "Cancelling…");
});

test("the strip's revision changes with everything a queued line shows, so a compact view follows label-only changes and a line that grows", async () => {
    const h = harness();
    const x = h.queue();
    const revision = () => selectOutboxOverlayBlocks(h.store.getState(), 80).revision;
    const seen = [revision()];
    const changed = (why) => {
        const next = revision();
        assert.ok(!seen.includes(next), why);
        seen.push(next);
    };
    // A queued line whose text grows: the same message, more lines.
    h.controller.setSessionOutboxItems(SID, h.controller.getSessionOutbox(SID).map((item) => (
        item.id === x.id ? { ...item, text: `${item.text}\nand a second paragraph that makes it longer` } : item
    )));
    changed("the line grows");
    // Label only: the steer is sent (phase steering, ↪ steering).
    await h.controller.convertQueuedToSteer(SID, x.id);
    changed("steering");
    // Label only: a cancel waits for the turn end, then the turn ends (phase stays cancelling).
    const y = h.queue("a second line");
    changed("a second queued line");
    await h.controller.cancelOutboxItem(SID, y.id);
    changed("Cancelling · takes effect when the turn ends");
    h.store.dispatch({ type: "sessions/merged", session: { sessionId: SID, status: "idle", acceptsTurnControl: false } });
    changed("Cancelling…");
});
