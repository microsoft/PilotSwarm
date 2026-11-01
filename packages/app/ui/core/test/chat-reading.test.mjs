/**
 * Desktop chat column, stored on the user profile.
 *
 * Phone has no slot. A profile that omits the key must not reset a local
 * change. Master of Agents chat panes must not opt into the column.
 *
 * Run: node --test test/chat-reading.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { appReducer } from "../src/reducer.js";
import { createInitialState, normalizeChatReading } from "../src/state.js";
import { selectAdminConsole } from "../src/selectors.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("the column is off by default and a repeat write is a no-op", () => {
    let state = createInitialState({ mode: "web" });
    assert.equal(state.ui.chatReading.on, false);
    assert.equal(state.ui.chatReading.width, null);
    assert.equal(state.ui.chatReading.align, "left");
    assert.equal(state.ui.chatReading.pad, 0);

    const next = { on: true, width: 1100, align: "left", pad: 40 };
    state = appReducer(state, { type: "ui/chatReading", reading: next });
    assert.deepEqual(state.ui.chatReading, next);
    assert.equal(appReducer(state, { type: "ui/chatReading", reading: { ...next } }), state);
});

test("the preference survives a profile round-trip and a partial profile does not reset it", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, {
        type: "profileSettings/apply",
        settings: { chatReading: { on: true, width: 900, align: "left", pad: 32 } },
    });
    assert.equal(state.ui.chatReading.on, true);
    assert.equal(state.ui.chatReading.width, 900);
    assert.equal(state.ui.chatReading.align, "left");
    assert.equal(state.ui.chatReading.pad, 32);

    state = appReducer(state, { type: "profileSettings/apply", settings: { themeId: "doom" } });
    assert.equal(state.ui.chatReading.width, 900, "a poll that omits the key must not clobber it");
});

test("a corrupt stored value is ignored and out-of-range numbers clamp", () => {
    let state = appReducer(createInitialState({ mode: "web" }), {
        type: "ui/chatReading",
        reading: { on: true, width: 1100, align: "center", pad: 24 },
    });
    state = appReducer(state, { type: "profileSettings/apply", settings: { chatReading: "wide" } });
    assert.equal(state.ui.chatReading.width, 1100);

    assert.equal(normalizeChatReading({ on: 1, width: 20, align: "middle", pad: 400 }).width, 480);
    assert.equal(normalizeChatReading({ on: 1, width: 20, align: "middle", pad: 400 }).align, "left");
    assert.equal(normalizeChatReading({ on: 1, width: 20, align: "middle", pad: 400 }).pad, 160);
    assert.equal(normalizeChatReading({ on: 1, width: 20, align: "middle", pad: 400 }).on, false);
    assert.equal(normalizeChatReading({ on: false }).width, null, "an omitted width is full, not a 720 cap");
    assert.equal(normalizeChatReading(null), null);
});

test("Appearance is a settings section, and only the main desktop chat opts in", () => {
    const view = selectAdminConsole(createInitialState({ mode: "web" }));
    const labels = view.settingsTree.filter((row) => row.kind === "section").map((row) => row.label);
    assert.equal(labels[0], "Appearance");

    const webApp = read("../../react/src/web-app.js");
    const moa = read("../../../web/src/moa/MoaWorkspace.jsx");
    assert.match(webApp, /ChatPane, \{ controller, readingColumn: true \}/);
    assert.equal((webApp.match(/readingColumn: true/g) || []).length, 1);
    assert.doesNotMatch(moa, /readingColumn/);
    assert.match(webApp, /readingColumn && storedReading\?\.on/);
    assert.doesNotMatch(webApp, /Same as before|Desktop chat only/);
});
