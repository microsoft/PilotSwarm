/**
 * Theme sounds: the desktop setting on the profile, and the fade shape.
 *
 * The fire plays 10 seconds out of every 30, fading in and out, and only
 * after the person turns theme sounds on.
 *
 * Run: node --test test/theme-sound.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { getTheme } from "../src/themes/index.js";
import {
    defaultThemeSound,
    normalizeThemeSound,
    themeSoundEnvelope,
    themeSoundTiming,
} from "../src/theme-sound.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);

test("theme sounds are off by default", () => {
    const state = createInitialState({ mode: "web" });
    assert.deepEqual(state.ui.themeSound, defaultThemeSound());
    assert.equal(state.ui.themeSound.on, false);
});

test("the setting round-trips through the profile and a partial profile keeps it", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "profileSettings/apply", settings: { themeSound: { on: true, volume: 60 } } });
    assert.deepEqual(state.ui.themeSound, { on: true, volume: 60 });
    state = appReducer(state, { type: "profileSettings/apply", settings: { themeId: "hearth" } });
    assert.deepEqual(state.ui.themeSound, { on: true, volume: 60 }, "a poll that omits the key keeps it");
});

test("a repeat write is a no-op and bad values clamp or are ignored", () => {
    let state = appReducer(createInitialState({ mode: "web" }), { type: "ui/themeSound", themeSound: { on: true, volume: 40 } });
    assert.equal(appReducer(state, { type: "ui/themeSound", themeSound: { on: true, volume: 40 } }), state);
    state = appReducer(state, { type: "profileSettings/apply", settings: { themeSound: "loud" } });
    assert.deepEqual(state.ui.themeSound, { on: true, volume: 40 });
    assert.deepEqual(normalizeThemeSound({ on: "yes", volume: 900 }), { on: false, volume: 100 });
    assert.deepEqual(normalizeThemeSound({ on: true, volume: -5 }), { on: true, volume: 0 });
    assert.equal(normalizeThemeSound(null), null);
});

test("the fire plays 10 s of every 30 s and fades in and out smoothly", () => {
    const fire = getTheme("hearth").sound;
    assert.deepEqual(themeSoundTiming(fire), { every: 30, play: 10, fadeIn: 2.5, fadeOut: 3 });
    close(themeSoundEnvelope(0, fire), 0, "starts silent");
    close(themeSoundEnvelope(1.25, fire), 0.5, "half way up the fade in");
    close(themeSoundEnvelope(2.5, fire), 1, "full after the fade in");
    close(themeSoundEnvelope(6, fire), 1, "full in the middle");
    close(themeSoundEnvelope(8.5, fire), 0.5, "half way down the fade out");
    close(themeSoundEnvelope(10, fire), 0, "silent at the end of the window");
    close(themeSoundEnvelope(20, fire), 0, "silent between windows");
    close(themeSoundEnvelope(31.25, fire), 0.5, "the next window starts at 30 s");
    let previous = 0;
    for (let s = 0; s <= 2.5; s += 0.05) {
        const level = themeSoundEnvelope(s, fire);
        assert.ok(level >= previous - 1e-9, "the fade in never dips");
        previous = level;
    }
    assert.equal(themeSoundEnvelope(-1, fire), 0);
    assert.equal(themeSoundEnvelope(Number.NaN, fire), 0);
});

test("the portal wires the setting to Appearance, the profile, and the player", () => {
    const webApp = read("../../react/src/web-app.js");
    const player = read("../../react/src/theme-sound-player.js");
    assert.match(webApp, /function ThemeSoundControl/);
    assert.match(webApp, /"Theme sounds"/);
    assert.match(webApp, /themeSoundPlayer\(\)\.prime\(\)/, "the switch primes audio inside its click");
    assert.match(webApp, /enabled: setting\.on === true && !isNarrowViewport\(\)/, "desktop only");
    assert.match(webApp, /themeSound: normalizedRemote\.themeSound/, "applied from the profile on desktop");
    assert.match(player, /themeSoundEnvelope\(elapsed, sound\)/);
    assert.match(player, /doc\.hidden/, "silent while the tab is hidden");
});
