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
    defaultThemeSoundMobile,
    nextCrackleGapMs,
    normalizeThemeSound,
    themeSoundEnvelope,
    themeSoundTiming,
} from "../src/theme-sound.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);

test("theme sounds are on by default at volume 40 on desktop and on a phone", () => {
    const state = createInitialState({ mode: "web" });
    assert.deepEqual(state.ui.themeSound, defaultThemeSound());
    assert.deepEqual(state.ui.themeSound, { on: true, volume: 40 });
    assert.deepEqual(state.ui.themeSoundMobile, defaultThemeSoundMobile());
    assert.deepEqual(state.ui.themeSoundMobile, { on: true, volume: 40 });
    assert.deepEqual(normalizeThemeSound({ on: false }), { on: false, volume: 40 }, "a missing volume takes the default");
});

test("the setting round-trips through the profile and a partial profile keeps it", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "profileSettings/apply", settings: { themeSound: { on: true, volume: 60 } } });
    assert.deepEqual(state.ui.themeSound, { on: true, volume: 60 });
    state = appReducer(state, { type: "profileSettings/apply", settings: { themeId: "hearth" } });
    assert.deepEqual(state.ui.themeSound, { on: true, volume: 60 }, "a poll that omits the key keeps it");
    state = appReducer(state, { type: "profileSettings/apply", settings: { themeSoundMobile: { on: true, volume: 25 } } });
    assert.deepEqual(state.ui.themeSoundMobile, { on: true, volume: 25 });
    assert.deepEqual(state.ui.themeSound, { on: true, volume: 60 }, "the phone slot never changes the desktop slot");
});

test("each device class edits only its own slot", () => {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, { type: "ui/themeSound", device: "mobile", themeSound: { on: true, volume: 30 } });
    assert.deepEqual(state.ui.themeSoundMobile, { on: true, volume: 30 });
    assert.deepEqual(state.ui.themeSound, { on: true, volume: 40 });
    state = appReducer(state, { type: "ui/themeSound", themeSound: { on: false, volume: 40 } });
    assert.deepEqual(state.ui.themeSound, { on: false, volume: 40 });
    assert.deepEqual(state.ui.themeSoundMobile, { on: true, volume: 30 }, "turning the desktop off leaves the phone alone");
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
    assert.match(webApp, /\(narrowViewport \? state\.themeSoundMobile : state\.themeSound\)/, "each device class uses its own setting");
    assert.match(webApp, /\[state\.themeId, state\.themeSound, state\.themeSoundMobile, narrowViewport\]/, "crossing the phone breakpoint re-evaluates the sound");
    assert.match(webApp, /themeSound: normalizedRemote\.themeSound/, "applied from the profile");
    assert.match(webApp, /themeSoundMobile: normalizedRemote\.themeSoundMobile/, "the phone slot is applied from the profile");
    assert.match(webApp, /device: "mobile", themeSound: next/, "the phone switch edits the phone slot");
    assert.match(player, /themeSoundEnvelope\(elapsed, sound\)/);
    assert.match(player, /doc\.hidden/, "silent while the tab is hidden");
    assert.match(player, /bedGain\.gain\.value = 0\.11/, "the low rumble stays under the crackle");
    assert.match(player, /0\.35 \+ Math\.random\(\) \* 0\.95/, "crackles are clearly audible over the rumble");
    assert.match(player, /setTimeout\(crackle, nextCrackleGapMs\(\)\)/, "crackle timing comes from the random gap model");
    assert.match(player, /createDynamicsCompressor\(\)/, "a limiter keeps the loudest pops from clipping");
    assert.match(player, /silence\(themeSoundTiming\(previous\)\.fadeOut\)/, "switching off fades out");
});

test("crackle gaps are random: about a second on average, with bursts and lulls", () => {
    let seed = 12345;
    const random = () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const gaps = Array.from({ length: 20000 }, () => nextCrackleGapMs(random));
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    assert.ok(mean > 900 && mean < 1400, `mean gap ${mean} ms`);
    assert.ok(sd / mean > 0.8, `irregular, not metronomic: cv ${sd / mean}`);
    assert.ok(Math.min(...gaps) >= 60 && Math.max(...gaps) <= 4000, "bounded");
    assert.ok(gaps.filter(g => g < 250).length / gaps.length > 0.12, "quick bursts happen");
    assert.ok(gaps.filter(g => g > 2000).length / gaps.length > 0.12, "quiet lulls happen");
});
