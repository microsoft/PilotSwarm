/**
 * Workflow Simplified, review UI-14: a Workflow row's Terminate choices are a real modal dialog (ModalDialog), as the
 * Stop dialog is: role dialog, aria-modal, named by its title; it takes focus and gives it back, Tab stays among its
 * choices, Enter or Space presses one, Escape closes it.
 *
 * Run: node --test ui/core/test/workflow-simplified-terminate-dialog.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import { ModalLayer } from "../../react/src/web-app.js";

test("the Workflow row's Terminate choices render in a modal dialog named by its title", () => {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    const controller = new PilotSwarmUiController({ store, transport: {} });
    store.dispatch({ type: "ui/modal", modal: { type: "terminatePicker", title: "check-items #2", sessionId: "wf-2", workflow: { ended: false } } });
    const html = renderToStaticMarkup(React.createElement(ModalLayer, { controller }));
    const dialog = /<div class="ps-modal is-narrow" role="dialog" aria-modal="true" aria-labelledby="([^"]+)" tabindex="-1">/.exec(html);
    assert.ok(dialog, html);
    assert.ok(html.includes(`<div class="ps-modal-title" id="${dialog[1]}">check-items #2</div>`), "named by its title");
    for (const action of ["stop", "cancel", "delete"]) assert.ok(html.includes(`data-action="${action}"`), action);
    assert.ok(html.includes(">Keep running</button>"));
});
