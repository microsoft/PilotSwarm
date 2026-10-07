import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createStore, createInitialState, appReducer, PilotSwarmUiController, buildHistoryModel, UI_COMMANDS, selectPromptActions } from "../../ui/core/src/index.js";
import { isMouseInputSequence, isPlainShortcutKey } from "../src/app.js";

const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const ast = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let callback;
function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useInput") callback = node.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
}
visit(ast);

function harness() {
    const store = createStore(appReducer, createInitialState());
    const actor = { provider: "test", subject: "alice" };
    store.dispatch({ type: "auth/context", principal: actor });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s", status: "running" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s" });
    store.dispatch({ type: "history/set", sessionId: "s", history: buildHistoryModel([1, 2].map(seq => ({
        seq, sessionId: "s", eventType: "user.message", createdAt: seq, data: { content: `own ${seq}`, sender: { kind: "user", ...actor } },
    }))) });
    const controller = new PilotSwarmUiController({ store, transport: {} });
    controller.syncPromptReferenceBrowser = () => {};
    controller.setFocus("prompt");
    const input = vm.runInNewContext(`(${callback})`, {
        controller, UI_COMMANDS, selectPromptActions, isMouseInputSequence, isPlainShortcutKey,
        mouseInputRef: { current: { ignoreUntil: 0 } }, quitStateRef: { current: { armedUntil: 0 } }, clearQuitArm() {},
    });
    return { controller, store, key: (key, text = "") => input(text, key) };
}

test("native Up recalls own history and Down restores the unsent draft through actual input handling", () => {
    const h = harness();
    h.controller.setPrompt("draft");
    h.key({ upArrow: true });
    assert.equal(h.store.getState().ui.prompt, "own 2");
    h.key({ upArrow: true });
    assert.equal(h.store.getState().ui.prompt, "own 1");
    h.key({ downArrow: true });
    h.key({ downArrow: true });
    assert.equal(h.store.getState().ui.prompt, "draft");
});
test("native edits end recall and ordinary multiline/menu arrows keep priority", () => {
    const h = harness();
    h.controller.setPrompt("first\nsecond", 8);
    h.key({ upArrow: true });
    assert.equal(h.store.getState().ui.prompt, "first\nsecond");
    h.key({ upArrow: true });
    assert.equal(h.store.getState().ui.prompt, "own 2");
    h.key({}, "!");
    h.key({ downArrow: true });
    assert.equal(h.store.getState().ui.prompt, "own 2!");
    h.controller.setPrompt("@artifact");
    h.key({ upArrow: true });
    assert.equal(h.store.getState().ui.prompt, "@artifact");
    h.store.dispatch({ type: "ui/modal", modal: { type: "help", selectedIndex: 0 } });
    h.key({ downArrow: true });
    assert.equal(h.store.getState().ui.prompt, "@artifact");
});
