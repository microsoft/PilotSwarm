// The portal's confirm box as a dialog for assistive technology (owner decision q17): role dialog, marked modal, named
// by its title, described by its message, focusable so that it takes focus when it opens. The focus moves themselves
// are checked in the browser (web/test/e2e/workflow-session.spec.mjs, "v2 commands: run controls ...").
//
// Run: node --test packages/app/ui/core/test/modal-dialog.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModalDialog } from "../../react/src/modal-dialog.js";

const h = React.createElement;

test("the confirm box is a modal dialog named by its title and described by its message", () => {
    const html = renderToStaticMarkup(h(ModalDialog, { className: "ps-modal is-narrow", titleId: "c-title", messageId: "c-message" },
        h("div", { className: "ps-modal-title", id: "c-title" }, "Stop Workflow Run"),
        h("p", { id: "c-message" }, "Stop run run-1?")));
    assert.equal(html, '<div class="ps-modal is-narrow" role="dialog" aria-modal="true" aria-labelledby="c-title" aria-describedby="c-message" tabindex="-1">'
        + '<div class="ps-modal-title" id="c-title">Stop Workflow Run</div><p id="c-message">Stop run run-1?</p></div>');
});

test("a dialog without a message is named by its title only", () => {
    const html = renderToStaticMarkup(h(ModalDialog, { className: "ps-modal", titleId: "t" }, h("div", { id: "t" }, "Title")));
    assert.match(html, /^<div class="ps-modal" role="dialog" aria-modal="true" aria-labelledby="t" tabindex="-1">/);
    assert.ok(!html.includes("aria-describedby"));
});
