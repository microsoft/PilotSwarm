/**
 * Theme sounds: the desktop setting on the profile, and the fade shape.
 *
 * The fire plays continuously once the person turns theme sounds on, fading
 * in when it starts and out when it stops.
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

test("the fire plays continuously and fades in smoothly when it starts", () => {
    const fire = getTheme("hearth").sound;
    assert.deepEqual(themeSoundTiming(fire), { continuous: true, fadeIn: 3, fadeOut: 2 });
    close(themeSoundEnvelope(0, fire), 0, "starts silent");
    close(themeSoundEnvelope(1.5, fire), 0.5, "half way up the fade in");
    close(themeSoundEnvelope(3, fire), 1, "full after the fade in");
    for (const s of [10, 20, 30, 45, 600]) close(themeSoundEnvelope(s, fire), 1, `still playing at ${s} s`);
    let previous = 0;
    for (let s = 0; s <= 3; s += 0.05) {
        const level = themeSoundEnvelope(s, fire);
        assert.ok(level >= previous - 1e-9, "the fade in never dips");
        previous = level;
    }
    assert.equal(themeSoundEnvelope(-1, fire), 0);
    assert.equal(themeSoundEnvelope(Number.NaN, fire), 0);
});

test("a theme may still ask for a window: 10 s of every 30 s with fades", () => {
    const windowed = { id: "fire", everySeconds: 30, playSeconds: 10, fadeInSeconds: 2.5, fadeOutSeconds: 3 };
    assert.deepEqual(themeSoundTiming(windowed), { continuous: false, every: 30, play: 10, fadeIn: 2.5, fadeOut: 3 });
    close(themeSoundEnvelope(1.25, windowed), 0.5, "half way up");
    close(themeSoundEnvelope(6, windowed), 1, "full");
    close(themeSoundEnvelope(8.5, windowed), 0.5, "half way down");
    close(themeSoundEnvelope(20, windowed), 0, "silent between windows");
    close(themeSoundEnvelope(31.25, windowed), 0.5, "the next window");
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
    assert.match(player, /bedGain\.gain\.value = 0\.09/, "the low rumble stays quiet under the crackle");
    const gapMin = Number(/CRACKLE_GAP_MIN_MS = (\d+)/.exec(player)?.[1]);
    const gapSpread = Number(/CRACKLE_GAP_SPREAD_MS = (\d+)/.exec(player)?.[1]);
    assert.ok(gapMin + gapSpread / 4 >= 1000, "crackle events average at least a second apart, each one distinct");
    assert.match(player, /0\.35 \+ Math\.random\(\) \* 0\.95/, "crackles are clearly audible over the rumble");
    assert.match(player, /setTimeout\(crackle, CRACKLE_GAP_MIN_MS \+ Math\.random\(\) \* Math\.random\(\) \* CRACKLE_GAP_SPREAD_MS\)/);
    assert.match(player, /silence\(themeSoundTiming\(previous\)\.fadeOut\)/, "switching off fades out");
});
