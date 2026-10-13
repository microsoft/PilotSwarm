// TUI parity for session turn control: Ctrl+T steers from the prompt pane,
// Ctrl+X stops; the status hints, the `?` help and the binding agree.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    PilotSwarmUiController,
    UI_COMMANDS,
    appReducer,
    createInitialState,
    createStore,
    selectHelpModal,
    selectStatusBar,
} from "pilotswarm/ui-core";

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
});

test("the help lists both keys", () => {
    const { store } = harness();
    store.dispatch({ type: "ui/modal", modal: { type: "help", selectedIndex: 0 } });
    const text = JSON.stringify(selectHelpModal(store.getState(), 120));
    assert.match(text, /ctrl-t/);
    assert.match(text, /steer the running turn/);
    assert.match(text, /ctrl-x/);
});
