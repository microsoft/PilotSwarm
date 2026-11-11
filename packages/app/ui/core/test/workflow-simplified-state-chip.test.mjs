/**
 * UX round UX2D-F12: on a phone the run bar's state pill read "Running · …": the time taken was cut with the label. The
 * time is a part of its own that never gives way; the label is cut first. Elsewhere the chip is one text, as before.
 * The mounted case (390 px) is the browser spec "UX2D-F12".
 *
 * Run: node --test ui/core/test/workflow-simplified-state-chip.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StateChip } from "../../react/src/workflow-tab.js";

const running = { key: "running", label: "Running", tone: "running" };

test("UX2D-F12: a chip with the time taken keeps it in a part of its own; without, it is one text as before", () => {
    assert.equal(renderToStaticMarkup(React.createElement(StateChip, { state: running, time: "2:03:04", title: "Started 08:21" })),
        '<span class="ps-wf-state is-running has-time" data-state="running" title="Started 08:21"><span class="ps-wf-state-label">Running</span>'
        + '<span class="ps-wf-state-time"> · 2:03:04</span></span>');
    assert.equal(renderToStaticMarkup(React.createElement(StateChip, { state: running })),
        '<span class="ps-wf-state is-running" data-state="running">Running</span>');
    const tab = fs.readFileSync(new URL("../../react/src/workflow-tab.js", import.meta.url), "utf8");
    assert.match(tab, /\? h\(StateChip, \{ state, time: took,/);
    const css = fs.readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");
    assert.match(css, /\.ps-wf-state\.has-time > \.ps-wf-state-time \{ flex: none;/);
    assert.match(css, /\.ps-wf-state\.has-time > \.ps-wf-state-label \{[^}]*min-width: 0; overflow: hidden; text-overflow: ellipsis;/);
});
