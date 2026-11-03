// "Include canvas" in the session Copy link dialog.
//
// Three things have to hold, and each fails quietly in a different way:
//   1. the link the box produces is one the opener already understands —
//      session plus canvas beside the chat, never the canvas-covering max=1;
//   2. with no usable slot the link is the plain session link, unchanged;
//   3. the dialog starts unchecked and re-copies when the choice changes, so
//      the clipboard always holds the link the sharer is looking at.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { withCanvasTarget, buildPortalLinks } from "../../ui/core/src/portal-links.js";
import { readDeepLinkTargetFromUrl } from "../src/lib/deep-link.js";

const WEB_APP = readFileSync(fileURLToPath(new URL(
    "../../ui/react/src/web-app.js", import.meta.url)), "utf8");

function targetFor(url) {
    const previous = globalThis.window;
    globalThis.window = { location: { search: new URL(url).search } };
    try {
        return readDeepLinkTargetFromUrl();
    } finally {
        if (previous === undefined) delete globalThis.window;
        else globalThis.window = previous;
    }
}

const BASE = "https://portal.example.com/?session=abc-123";

test("an included canvas opens the session with that slot beside the chat", () => {
    const url = withCanvasTarget(BASE, 3);
    assert.equal(url, `${BASE}&view=canvas&slot=3`);
    const target = targetFor(url);
    assert.equal(target.sessionId, "abc-123");
    assert.equal(target.canvas, true);
    assert.equal(target.slot, 3);
    assert.equal(target.max, false, "beside the chat, not covering it");
    assert.equal(target.fullscreen, false);
    assert.equal(target.hideChrome, false);
});

test("no usable slot leaves the plain session link untouched", () => {
    for (const slot of [null, undefined, "", 0, 6, 2.5, "x"]) {
        assert.equal(withCanvasTarget(BASE, slot), BASE, `slot ${String(slot)}`);
    }
    assert.equal(withCanvasTarget("", 2), "");
});

test("the canvas target survives the multi-origin rebase", () => {
    const links = buildPortalLinks(withCanvasTarget(BASE, 2), [
        { label: "Corporate", origin: "https://a.example.com" },
        { label: "VPN", origin: "https://b.example.com" },
    ]);
    assert.deepEqual(links.map((l) => l.url), [
        "https://a.example.com/?session=abc-123&view=canvas&slot=2",
        "https://b.example.com/?session=abc-123&view=canvas&slot=2",
    ]);
});

test("the dialog starts unchecked, re-copies on change, and reads the session's drawn canvases", () => {
    const start = WEB_APP.indexOf("function SessionLinkModal(");
    assert.ok(start > 0, "SessionLinkModal exists");
    const body = WEB_APP.slice(start, WEB_APP.indexOf("\nconst VISIBILITY_META", start));
    assert.match(body, /const \[includeCanvas, setIncludeCanvas\] = React\.useState\(false\)/,
        "off by default: the copied link is unchanged until the sharer opts in");
    assert.match(body, /"Include canvas"/);
    assert.match(body, /withCanvasTarget\(baseUrl, canvasSlot\)/);
    assert.match(body, /disabled: slots\.length === 0/, "no canvas → the box cannot be ticked");
    assert.match(body, /const recopy = \(nextInclude, nextSlot\) =>/);
    assert.equal((body.match(/recopy\(/g) || []).length, 2, "called from the box and the picker");
    assert.match(body, /MultiOriginLinkRows, \{ url, keyPrefix: "session", copied, onCopy: copy, wrap: true \}/,
        "the whole link is visible, so the added canvas part can be seen");
    assert.match(WEB_APP, /const canvas = selectCanvasView\(controller\.getState\(\)\);/,
        "the click handler reads the drawn slots");
});
