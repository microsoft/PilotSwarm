import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { appReducer, createInitialState, createStore, selectPromptActions, UI_COMMANDS } from "../../ui/core/src/index.js";
import { isMouseInputSequence, isPlainShortcutKey } from "../src/app.js";

const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const ast = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const callbacks = [];
function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useInput") callbacks.push(node.arguments[0].getText(ast));
    ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(callbacks.length, 1, "exercise the actual host input callback, not a copy of its routing");

function harness({ autocomplete = false, steerable = true } = {}) {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", status: "running" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    state = appReducer(state, { type: "steering/stateLoaded", sessionId: "s1", windowSeq: 1, state: {
        supported: true, canWrite: true, steerable, expectedTarget: steerable ? "target-a" : null, limits: { maxBytes: 8192 },
    } });
    state = { ...state, ui: { ...state.ui, focusRegion: "prompt", prompt: "guidance", promptActionIndex: null } };
    const store = createStore(appReducer, state);
    const commands = [];
    const controller = {
        getState: store.getState,
        dispatch: store.dispatch,
        handleCommand: async (command) => { commands.push(command); },
        acceptPromptReferenceAutocomplete: () => autocomplete,
        setStatus() {},
    };
    const input = vm.runInNewContext(`(${callbacks[0]})`, {
        controller, UI_COMMANDS, selectPromptActions, isMouseInputSequence, isPlainShortcutKey,
        mouseInputRef: { current: { ignoreUntil: 0 } }, quitStateRef: { current: { armedUntil: 0 } },
        clearQuitArm() {}, requestExit() { throw new Error("steering action must not exit the host"); },
    });
    return { store, commands, key: (key, text = "") => input(text, key) };
}

test("ST-U10: normal prompt Tab/Right/Enter invokes Steer, never ordinary Send", () => {
    const h = harness();
    h.key({ tab: true });
    assert.equal(h.store.getState().ui.promptActionIndex, 0);
    h.key({ rightArrow: true });
    assert.equal(h.store.getState().ui.promptActionIndex, 1);
    h.key({ return: true });
    assert.deepEqual(h.commands, [UI_COMMANDS.STEER_TURN]);
    assert.equal(h.store.getState().ui.prompt, "guidance");
});

test("ST-U10: Escape and Shift+Tab return to editing without sending", () => {
    for (const key of [{ escape: true, name: "escape" }, { tab: true, shift: true }]) {
        const h = harness();
        h.key({ tab: true });
        h.key(key);
        assert.equal(h.store.getState().ui.promptActionIndex, null);
        assert.deepEqual(h.commands, []);
    }
});

test("ST-U10: autocomplete wins before action-row focus; Tab from actions traverses panes", () => {
    const complete = harness({ autocomplete: true });
    complete.key({ tab: true });
    assert.equal(complete.store.getState().ui.promptActionIndex, null);
    assert.deepEqual(complete.commands, []);
    const h = harness();
    h.key({ tab: true });
    h.key({ tab: true });
    assert.equal(h.store.getState().ui.promptActionIndex, null);
    assert.deepEqual(h.commands, [UI_COMMANDS.FOCUS_NEXT]);
});

test("ST-U10: a confirm modal captures Enter before prompt actions", () => {
    const h = harness();
    h.key({ tab: true });
    h.key({ rightArrow: true });
    h.store.dispatch({ type: "ui/modal", modal: { type: "confirm", title: "Fixture confirmation" } });
    h.key({ return: true });
    assert.deepEqual(h.commands, [UI_COMMANDS.MODAL_CONFIRM]);
});

test("ST-U10: unavailable Steer cannot fall through to Send, but ordinary Enter stays Send", () => {
    const h = harness({ steerable: false });
    h.key({ tab: true });
    h.key({ rightArrow: true });
    h.key({ return: true });
    assert.deepEqual(h.commands, []);
    h.key({ escape: true });
    h.key({ return: true });
    assert.deepEqual(h.commands, [UI_COMMANDS.SEND_PROMPT]);
});

test("ST-U10: Stop shortcut remains independent of prompt action-row focus", () => {
    const h = harness();
    h.key({ tab: true });
    h.key({ ctrl: true }, "x");
    assert.deepEqual(h.commands, [UI_COMMANDS.STOP_TURN]);
});
