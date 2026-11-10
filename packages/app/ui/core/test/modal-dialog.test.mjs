// The portal's confirm box as a dialog for assistive technology (owner decision q17): role dialog, marked modal, named
// by its title, described by its message, focusable so that it takes focus when it opens. When it closes it gives focus
// back to the control that opened it, and the portal's effects that move focus when a modal closes (the session list's
// active-row reveal, the composer) leave it there. Effects do not run in server rendering, so those two are checked by
// their source shape here; the focus moves themselves are checked in the browser
// (web/test/e2e/workflow-session.spec.mjs, "Workflow commands: run controls ...").
//
// Run: node --test packages/app/ui/core/test/modal-dialog.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModalDialog, focusGivenBack } from "../../react/src/modal-dialog.js";

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

test("focus a closing confirm box gave back to its opener stays there; a modal that gave nothing back leaves the page focused", () => {
    const body = { tagName: "BODY" }, root = { tagName: "HTML" }, stop = { tagName: "BUTTON" };
    const page = activeElement => ({ activeElement, body, documentElement: root });
    // Stop opened the confirm box; Cancel closed it, and the box focused Stop again.
    assert.equal(focusGivenBack(true, page(stop)), true);
    // A list modal (the model picker, say) gave nothing back: the page has focus, and the row or the composer takes it.
    assert.equal(focusGivenBack(true, page(body)), false);
    assert.equal(focusGivenBack(true, page(root)), false);
    assert.equal(focusGivenBack(true, page(null)), false);
    // No modal closed (a session chosen, the list refreshed): focus moves as it always did.
    assert.equal(focusGivenBack(false, page(stop)), false);
    assert.equal(focusGivenBack(true, null), false);
});

const webApp = readFileSync(fileURLToPath(new URL("../../react/src/web-app.js", import.meta.url)), "utf8");

/** The React.useEffect around `anchor`, from its start to the end of its dependency list. */
function effectAround(anchor) {
    const at = webApp.indexOf(anchor);
    assert.notEqual(at, -1, `${anchor} not found: was it renamed?`);
    return webApp.slice(webApp.lastIndexOf("React.useEffect(", at), webApp.indexOf("]);", at) + 3);
}

test("the effects that move focus when a modal closes leave the focus the confirm box gave back", () => {
    // In the browser run on 792c61e3, Cancel gave focus back to Stop, and the session list's reveal then moved it to the
    // active session's row. The composer does the same while the prompt has the keyboard.
    for (const [name, anchor, open] of [
        ["the active-row reveal", "const activeButton = sessionButtonRefs.current.get(viewState.activeSessionId)", "viewState.modalOpen"],
        ["the composer", "if (!active || promptState.modalOpen || !promptState.focused || !inputNode) return;", "promptState.modalOpen"],
    ]) {
        const effect = effectAround(anchor);
        // It sees the modal close on every run, before any early return...
        assert.ok(effect.includes(`const modalClosed = modalWasOpenRef.current && !${open};`), `${name}: sees a modal close`);
        const recorded = effect.indexOf(`modalWasOpenRef.current = ${open};`);
        assert.ok(recorded !== -1 && recorded < effect.indexOf("return;"), `${name}: records the modal state before returning`);
        // ...and asks before it moves focus.
        const asks = effect.indexOf("focusGivenBack(modalClosed)");
        assert.ok(asks !== -1 && asks < effect.lastIndexOf(".focus("), `${name}: leaves focus a closing dialog gave back`);
    }
});
