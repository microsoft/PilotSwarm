/**
 * Theme sound player lifecycle: every voice the player starts is stopped.
 *
 * Runs the real player against a fake Web Audio context and mocked timers,
 * and counts the looped fire beds that are running.
 *
 * Run: node --test test/theme-sound-player.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { getTheme } from "../src/themes/index.js";
import { createThemeSoundPlayer } from "../../react/src/theme-sound-player.js";

function param(value = 0) {
    return {
        value,
        cancelScheduledValues() {},
        setTargetAtTime() {},
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {},
    };
}

function fakeAudio() {
    const stats = { beds: 0, bedsStopped: 0, contexts: 0, resumes: 0, unlocks: 0, ctx: null };
    const node = (extra = {}) => ({ connect() {}, disconnect() {}, ...extra });
    class FakeAudioContext {
        constructor() {
            stats.contexts += 1;
            stats.ctx = this;
            this.sampleRate = 100;
            this.currentTime = 0;
            this.state = "running";
            this.destination = node();
        }
        createGain() { return node({ gain: param(1) }); }
        createDynamicsCompressor() {
            return node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
        }
        createBuffer(_channels, length) {
            const data = new Float32Array(length);
            return { length, getChannelData: () => data };
        }
        createBufferSource() {
            let started = false;
            let stopped = false;
            const source = node({
                buffer: null,
                loop: false,
                start() {
                    started = true;
                    if (source.loop) stats.beds += 1;
                    if (source.buffer?.length === 1) stats.unlocks += 1;
                },
                stop() {
                    if (!started || stopped) throw new Error("not running");
                    stopped = true;
                    if (source.loop) stats.bedsStopped += 1;
                },
            });
            return source;
        }
        createBiquadFilter() { return node({ type: "", frequency: param(), Q: param() }); }
        createOscillator() { return node({ frequency: param(), start() {}, stop() {} }); }
        resume() { stats.resumes += 1; this.state = "running"; return Promise.resolve(); }
        close() { return Promise.resolve(); }
    }
    const listeners = new Map();
    const win = {
        AudioContext: FakeAudioContext,
        document: { hidden: false, documentElement: { dataset: {} } },
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: (handle) => clearInterval(handle),
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener: (type) => listeners.delete(type),
    };
    return { win, stats, listeners, running: () => stats.beds - stats.bedsStopped };
}

const fire = getTheme("hearth").sound;

// Node's mock timers do not run a timeout that an interval callback creates
// within the same tick() call, so advance in short steps like a real clock.
function advance(t, ms) {
    for (let done = 0; done < ms; done += 100) t.mock.timers.tick(Math.min(100, ms - done));
}

test("turning sound off, on and off during the fade leaves no fire running", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const audio = fakeAudio();
    const player = createThemeSoundPlayer({ win: audio.win });
    player.update({ sound: fire, enabled: true, volume: 0.4 });
    advance(t, 3000);
    assert.equal(audio.running(), 1, "one fire plays");
    for (const type of ["pointerup", "touchend"]) assert.ok(audio.listeners.has(type), `a tap unlocks audio through ${type}`);

    for (let round = 0; round < 5; round += 1) {
        player.update({ sound: fire, enabled: false, volume: 0.4 });
        advance(t, 400);
        player.update({ sound: fire, enabled: true, volume: 0.4 });
        advance(t, 400);
        assert.equal(audio.running(), 1, `round ${round}: the fading fire is reused, not doubled`);
    }

    player.update({ sound: fire, enabled: false, volume: 0.4 });
    advance(t, 10_000);
    assert.equal(audio.running(), 0, "the fire stops after its fade");
    assert.equal(audio.stats.beds, 1, "only one fire was ever started");
    assert.equal(audio.listeners.size, 0, "gesture listeners are removed");
});

test("a hidden tab fades the fire and showing it again reuses it", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const audio = fakeAudio();
    const player = createThemeSoundPlayer({ win: audio.win });
    player.update({ sound: fire, enabled: true, volume: 0.4 });
    advance(t, 3000);
    audio.win.document.hidden = true;
    advance(t, 400);
    audio.win.document.hidden = false;
    advance(t, 400);
    assert.equal(audio.running(), 1);
    audio.win.document.hidden = true;
    advance(t, 10_000);
    assert.equal(audio.running(), 0, "the fire stops while the tab stays hidden");
});

test("dispose stops a fading fire at once", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const audio = fakeAudio();
    const player = createThemeSoundPlayer({ win: audio.win });
    player.update({ sound: fire, enabled: true, volume: 0.4 });
    advance(t, 3000);
    player.update({ sound: fire, enabled: false, volume: 0.4 });
    player.dispose();
    assert.equal(audio.running(), 0);
    advance(t, 10_000);
    assert.equal(audio.running(), 0);
});

test("a tap starts sound on iPhone: unlock inside the gesture, resume an interrupted context", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const audio = fakeAudio();
    const player = createThemeSoundPlayer({ win: audio.win });
    player.prime();
    assert.equal(audio.stats.unlocks, 1, "the switch's own tap plays one silent sample");
    player.update({ sound: fire, enabled: true, volume: 0.4 });
    advance(t, 3000);
    audio.stats.ctx.state = "interrupted";
    const before = audio.stats.resumes;
    audio.listeners.get("touchend")();
    assert.equal(audio.stats.resumes, before + 1, "an interrupted context resumes on the next tap");
    assert.equal(audio.stats.unlocks, 2, "and is unlocked inside that tap");
    assert.equal(audio.stats.ctx.state, "running");
    player.dispose();
});
