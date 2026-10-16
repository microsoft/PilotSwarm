// TUI parity for session turn control: Ctrl+T steers from the prompt pane,
// Ctrl+X stops; the status hints, the `?` help and the binding agree.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    PilotSwarmUiController,
    UI_COMMANDS,
    appReducer,
    createInitialState,
    createStore,
    selectHelpModal,
    selectOutboxOverlayLines,
    selectStatusBar,
} from "pilotswarm/ui-core";
import { StatusBar } from "../../ui/react/src/components.js";
import { UiPlatformProvider } from "../../ui/react/src/platform.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(here, "..", "src", "app.js"), "utf8");

function harness({ steering = true, accepts = true, focus = "prompt", steer } = {}) {
    const calls = [];
    const transport = {
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
        steerSessionTurn: async (sessionId, options) => { calls.push({ sessionId, ...options }); return steer ?? { outcome: "accepted", steerId: 1, turn: 0 }; },
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "T", status: "running" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    store.dispatch({ type: "sessions/merged", session: { sessionId: "s1", acceptsTurnControl: accepts } });
    store.dispatch({ type: "turnControl/steering", enabled: steering });
    controller.setFocus(focus);
    return { controller, store, calls };
}

test("Ctrl+T in the prompt pane dispatches STEER_TURN; Ctrl+X stays Stop", () => {
    const steerStart = APP.indexOf('matchesCtrlKey("t", "\\u0014")');
    assert.ok(steerStart > 0, "the Ctrl+T binding exists");
    const block = APP.slice(APP.lastIndexOf("if (", steerStart), APP.indexOf("}", steerStart) + 1);
    assert.match(block, /focus === "prompt"/, "only in the prompt pane");
    assert.match(APP.slice(steerStart, steerStart + 200), /UI_COMMANDS\.STEER_TURN/);
    assert.match(APP, /key\.ctrl && \(input === "x" \|\| key\.escape\)\) \{\s*controller\.handleCommand\(UI_COMMANDS\.STOP_TURN\)/);
});

test("the STEER_TURN command sends the prompt text as a steer", async () => {
    const { controller, store, calls } = harness();
    controller.setPrompt("prefer the shorter answer");
    await controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, "prefer the shorter answer");
    assert.equal(store.getState().ui.prompt, "");
});

test("the status line shows why Steer does not apply", async () => {
    const off = harness({ steering: false });
    off.controller.setPrompt("x");
    await off.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.equal(off.calls.length, 0);
    assert.match(off.store.getState().ui.statusText, /Steering is not enabled/);
    const legacy = harness({ accepts: false });
    legacy.controller.setPrompt("x");
    await legacy.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.equal(legacy.calls.length, 0);
    assert.match(legacy.store.getState().ui.statusText, /No running turn accepts steering/);
});

test("status hints: ctrl-t steer in the prompt while it applies; retry keys for unconfirmed requests", async () => {
    assert.match(selectStatusBar(harness().store.getState()).right, /^ctrl-x stop · ctrl-t steer · /);
    assert.doesNotMatch(selectStatusBar(harness({ steering: false }).store.getState()).right, /ctrl-t/);
    assert.doesNotMatch(selectStatusBar(harness({ focus: "chat" }).store.getState()).right, /ctrl-t steer/);
    const lost = harness({ steer: Object.assign(new TypeError("fetch failed")) });
    lost.controller.transport.steerSessionTurn = async () => { throw new TypeError("fetch failed"); };
    lost.controller.setPrompt("x");
    await lost.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.match(selectStatusBar(lost.store.getState()).right, /ctrl-t retry steer/);
    lost.controller.setFocus("chat");
    assert.doesNotMatch(selectStatusBar(lost.store.getState()).right, /ctrl-t/);
});

test("the rendered TUI status line shows the turn-control hints", async () => {
    const platform = { StatusLine: ({ right }) => React.createElement("span", null, right) };
    const line = ({ controller }, width = 400) => renderToStaticMarkup(
        React.createElement(UiPlatformProvider, { platform }, React.createElement(StatusBar, { controller, width })));
    const steer = harness();
    steer.controller.setPrompt("x");
    assert.match(line(steer), /^<span>ctrl-x stop · ctrl-t steer · /);
    // Fitted to the terminal width the layout passes in (it changes on resize).
    assert.ok(line(steer, 100).length < line(steer, 200).length);
    assert.match(line(steer, 100), /^<span>ctrl-x stop · ctrl-t steer · .*\.\.\.<\/span>$/);
    const lost = harness();
    lost.controller.transport.steerSessionTurn = async () => { throw new TypeError("fetch failed"); };
    lost.controller.setPrompt("lost words");
    await lost.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.match(line(lost), /ctrl-t retry steer · alt-t give up · /);
});

test("the help lists both keys", () => {
    const { store } = harness();
    store.dispatch({ type: "ui/modal", modal: { type: "help", selectedIndex: 0 } });
    const text = JSON.stringify(selectHelpModal(store.getState(), 120));
    assert.match(text, /ctrl-t/);
    assert.match(text, /steer the running turn/);
    assert.match(text, /ctrl-x/);
});

test("Alt+T gives up unconfirmed requests; the hint and help list it", async () => {
    assert.match(APP, /key\.meta && !key\.ctrl && \(input === "t" \|\| key\.name === "t"\)\s*&& controller\.giveUpTurnControl\(\)/);
    const lost = harness();
    lost.controller.transport.steerSessionTurn = async () => { throw new TypeError("fetch failed"); };
    lost.controller.setPrompt("lost words");
    await lost.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.match(selectStatusBar(lost.store.getState()).right, /ctrl-t retry steer · alt-t give up · /);
    assert.equal(lost.controller.giveUpTurnControl(), true);
    assert.equal(lost.store.getState().ui.prompt, "lost words");
    lost.store.dispatch({ type: "ui/modal", modal: { type: "help", selectedIndex: 0 } });
    assert.match(JSON.stringify(selectHelpModal(lost.store.getState(), 120)), /alt-t/);
});

test("Ctrl+T with an empty prompt steers every queued text message in order; the status line says how many; an image refuses it", async () => {
    let seq = 10;
    const h = harness({ steer: undefined });
    h.controller.transport.steerSessionTurn = async (sessionId, options) => { h.calls.push({ sessionId, ...options }); return { outcome: "accepted", steerId: seq++, turn: 0 }; };
    const queue = (text, extra = {}) => {
        const item = { ...h.controller.buildOutboxItem(text, "queued"), ...extra };
        h.controller.setSessionOutboxItems("s1", [...h.controller.getSessionOutbox("s1"), item]);
        return item;
    };
    const a = queue("first queued");
    const b = queue("second queued");
    assert.match(selectStatusBar(h.store.getState()).right, /^ctrl-x stop · ctrl-t steer 2 queued · /);
    await h.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.deepEqual(h.calls.map((call) => [call.text, call.replacesClientMessageId]), [["first queued", a.id], ["second queued", b.id]]);
    const strip = selectOutboxOverlayLines(h.store.getState(), 80).map((line) => line.map((run) => run.text).join("")).join("\n");
    assert.match(strip, /queued prompts: 2 steering/);
    assert.match(strip, /↪ You: first queued\n  steering/);

    const img = harness();
    img.controller.setSessionOutboxItems("s1", [
        img.controller.buildOutboxItem("text", "queued"),
        { ...img.controller.buildOutboxItem("look", "queued"), attachments: [{ filename: "a.png", contentType: "image/png", sizeBytes: 3 }] },
    ]);
    assert.doesNotMatch(selectStatusBar(img.store.getState()).right, /ctrl-t steer/);
    await img.controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.equal(img.calls.length, 0);
    assert.equal(img.store.getState().ui.statusText, "A queued message has an image; images cannot be steered");
});
