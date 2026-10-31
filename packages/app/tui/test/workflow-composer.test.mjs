import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "pilotswarm/ui-core";
import { PromptBar } from "../../ui/react/src/components.js";
import { UiPlatformProvider } from "../../ui/react/src/platform.js";

function harness(sessionKind) {
    const calls = [];
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport: {
        sendMessage: async (...args) => { calls.push(args); },
    } });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "Test", status: "running", sessionKind }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    return { store, controller, calls };
}

const platform = {
    Lines: ({ lines }) => React.createElement("span", { "data-kind": "readonly" }, lines.map(line => line.text).join("")),
    Input: ({ value, placeholder }) => React.createElement("input", { value, placeholder, readOnly: true }),
};
const render = controller => renderToStaticMarkup(React.createElement(UiPlatformProvider, { platform },
    React.createElement(PromptBar, { controller, rows: 1 })));

test("the TUI workflow footer is exactly Workflow session without an input", () => {
    const { controller } = harness("workflow");
    const html = render(controller);
    assert.equal(html, '<span data-kind="readonly">Workflow session</span>');
});

test("the ordinary agent prompt remains available", () => {
    const { controller } = harness("agent");
    const html = render(controller);
    assert.match(html, /<input/);
    assert.match(html, /Type a message and press Enter/);
});

test("Enter on a workflow does not enqueue a conversational prompt or lose its draft", async () => {
    const { controller, store, calls } = harness("workflow");
    controller.setPrompt("keep my draft");
    await controller.sendPrompt();
    assert.equal(calls.length, 0);
    assert.equal(store.getState().ui.statusText, "Workflow session");
    assert.equal(store.getState().ui.prompt, "keep my draft");
    assert.deepEqual(store.getState().outbox?.bySessionId?.s1 ?? [], []);
});
