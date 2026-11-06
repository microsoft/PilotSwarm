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
        target: value,
        cancelScheduledValues() {},
        setTargetAtTime(target) { this.target = target; },
        setValueAtTime() {},
        linearRampToValueAtTime() {},
        exponentialRampToValueAtTime() {},
    };
}

function fakeAudio() {
    const stats = { beds: 0, bedsStopped: 0, contexts: 0, resumes: 0, unlocks: 0, oscillators: 0, ctx: null, gains: [], oscs: [], limiter: null };
    const node = (extra = {}) => ({ to: new Set(), connect(target) { this.to.add(target); }, disconnect() { this.to.clear(); }, ...extra });
    class FakeAudioContext {
        constructor() {
            stats.contexts += 1;
            stats.ctx = this;
            this.sampleRate = 100;
            this.currentTime = 0;
            this.state = "running";
            this.destination = node();
        }
        createGain() { const g = node({ gain: param(1) }); stats.gains.push(g); return g; }
        createDynamicsCompressor() {
            stats.limiter = node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
            return stats.limiter;
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
        createOscillator() {
            stats.oscillators += 1;
            // `cut` records an early stop: no time, or one earlier than the note's own end.
            const osc = node({ type: "", frequency: param(), detune: param(), end: null, cut: false, start() {}, stop(when) {
                if (osc.end === null && when !== undefined) { osc.end = when; return; }
                osc.cut = true;
            } });
            stats.oscs.push(osc);
            return osc;
        }
        createConvolver() { return node({ buffer: null }); }
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

const dawn = getTheme("horizon-dawn").sound;

test("the dawn sky plays, keeps changing chords, and stops cleanly", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const audio = fakeAudio();
    const player = createThemeSoundPlayer({ win: audio.win });
    assert.equal(dawn?.id, "dawn");
    player.update({ sound: dawn, enabled: true, volume: 0.4 });
    advance(t, 3000);
    assert.equal(audio.running(), 1, "one air bed plays under the chords");
    const early = audio.stats.oscillators;
    assert.ok(early >= 10, "the first chord sounds at once");
    advance(t, 60_000);
    assert.ok(audio.stats.oscillators > early + 10, "new chords and stars keep coming");
    player.update({ sound: dawn, enabled: false, volume: 0.4 });
    advance(t, 10_000);
    assert.equal(audio.running(), 0, "the air bed stops after the fade");
    const stopped = audio.stats.oscillators;
    advance(t, 120_000);
    assert.equal(audio.stats.oscillators, stopped, "no chord or star is scheduled after it stops");
    player.dispose();
});

test("action cues sound only for a theme that has them, while its sound is on", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const audio = fakeAudio();
    const player = createThemeSoundPlayer({ win: audio.win });
    assert.equal(player.cue("tick"), false, "silent before any sound is on");
    player.update({ sound: fire, enabled: true, volume: 0.4 });
    advance(t, 500);
    assert.equal(player.cue("tick"), false, "the fire has no cues");
    player.update({ sound: dawn, enabled: true, volume: 0.4 });
    advance(t, 500);
    assert.equal(player.cue("tick"), true, "Horizon Dawn ticks");
    assert.equal(player.cue("tick"), false, "a second tick in the same instant is dropped");
    advance(t, 100);
    assert.equal(player.cue("tick"), true);
    assert.equal(player.cue("send"), true);
    assert.equal(player.cue("done"), true);
    assert.equal(player.cue("nonsense"), false, "only known cues play");
    audio.win.document.hidden = true;
    advance(t, 1000);
    assert.equal(player.cue("done"), false, "a hidden tab is silent");
    audio.win.document.hidden = false;
    player.update({ sound: dawn, enabled: false, volume: 0.4 });
    advance(t, 1000);
    assert.equal(player.cue("send"), false, "sounds off means cues off");
    player.dispose();
});

// The cue bus is the second gain wired to the limiter (the first is the ambient's master).
const cueBusOf = (audio) => audio.stats.gains.filter((g) => g.to.has(audio.stats.limiter))[1];

test("cues already ringing stop when sound goes off, the tab hides, the theme changes or the volume drops to zero", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const transitions = [
        ["sound off", (player) => player.update({ sound: dawn, enabled: false, volume: 0.4 })],
        ["tab hidden", (player, audio) => { audio.win.document.hidden = true; }],
        ["a theme without cues", (player) => player.update({ sound: fire, enabled: true, volume: 0.4 })],
        ["volume zero", (player) => player.update({ sound: dawn, enabled: true, volume: 0 })],
    ];
    for (const [name, change] of transitions) {
        const audio = fakeAudio();
        const player = createThemeSoundPlayer({ win: audio.win });
        player.update({ sound: dawn, enabled: true, volume: 0.4 });
        advance(t, 500);
        const bus = cueBusOf(audio);
        assert.ok(bus, `${name}: the cue bus exists`);
        assert.ok(bus.gain.target > 0, `${name}: the cue bus is open while sound is on`);
        const before = audio.stats.oscs.length;
        assert.equal(player.cue("done"), true);
        const notes = audio.stats.oscs.slice(before);
        assert.ok(notes.length >= 4, `${name}: the done chime started its notes`);
        change(player, audio);
        advance(t, 500);
        assert.equal(bus.gain.target, 0, `${name}: the cue bus is muted`);
        assert.ok(notes.every((osc) => osc.cut), `${name}: every ringing cue note is cut`);
        assert.equal(player.cue("tick"), false, `${name}: and no new cue plays`);
        player.dispose();
    }
});

test("stopping the dawn sky cuts its star chimes and unhooks its room", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    const audio = fakeAudio();
    const player = createThemeSoundPlayer({ win: audio.win });
    player.update({ sound: dawn, enabled: true, volume: 0.4 });
    advance(t, 30_000);
    const voiceOscs = audio.stats.oscs.slice();
    assert.ok(voiceOscs.length > 20, "chords and stars have played");
    player.update({ sound: dawn, enabled: false, volume: 0.4 });
    advance(t, 10_000);
    assert.ok(voiceOscs.every((osc) => osc.cut), "every chord and star oscillator was stopped by the voice");
    const stillWired = audio.stats.gains.filter((g) => g.to.size > 0 && voiceOscs.some((o) => o.to.has(g)));
    assert.equal(stillWired.length, 0, "no note gain is left connected");
    player.dispose();
});
