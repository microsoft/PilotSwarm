// Browser player for theme sounds. One player per page.
//
// The sound is synthesized live with Web Audio, so there is no audio file to
// fetch, cache or license. The loudness follows themeSoundEnvelope(): a
// raised-cosine fade in when it starts, and a fade out when it is switched
// off or the tab is hidden.
//
// Browsers keep audio silent until the person interacts with the page, so the
// player waits for a click or key press before it resumes its context, and a
// settings switch can prime it directly inside its own click.

import {
    DAWN_CHORDS,
    DAWN_STAR_NOTES,
    THEME_SOUND_CUES,
    nextCrackleGapMs,
    nextDawnStarGapMs,
    themeSoundEnvelope,
    themeSoundTiming,
} from "pilotswarm/ui-core";

const TICK_MS = 200;
// Events that count as a user gesture for unlocking audio. On a touch screen
// pointerdown does not: a tap unlocks only on pointerup or touchend.
const GESTURES = ["pointerdown", "pointerup", "touchend", "keydown"];
// Peak gain at volume 100. The fire is ambience, not an alert. A limiter on
// the output keeps the loudest pops from clipping.
const MAX_GAIN = 1;

function brownNoise(ctx, seconds) {
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i += 1) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.2;
    }
    return buffer;
}

function whiteNoise(ctx, seconds) {
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
}

// A fire that is mostly crackle: distinct crackles and snaps at random
// intervals (about one a second on average, with bursts and lulls), now and then the
// deeper pop of a settling log, over a quiet low rumble that breathes slowly.
function startFire(ctx, output, cache) {
    cache.bed = cache.bed || brownNoise(ctx, 5);
    cache.white = cache.white || whiteNoise(ctx, 0.08);
    const bed = ctx.createBufferSource();
    bed.buffer = cache.bed;
    bed.loop = true;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 300;
    const bedGain = ctx.createGain();
    bedGain.gain.value = 0.11;
    bed.connect(lowpass);
    lowpass.connect(bedGain);
    bedGain.connect(output);
    bed.start();
    const breath = ctx.createOscillator();
    breath.frequency.value = 0.11;
    const breathDepth = ctx.createGain();
    breathDepth.gain.value = 0.035;
    breath.connect(breathDepth);
    breathDepth.connect(bedGain.gain);
    breath.start();

    let timer = null;
    let running = true;
    // kind: "crackle" (bright, very short), "snap" (mid, a little longer),
    // or "pop" (low, the settling log).
    const pop = (at, kind) => {
        const source = ctx.createBufferSource();
        source.buffer = cache.white;
        const filter = ctx.createBiquadFilter();
        if (kind === "pop") {
            filter.type = "lowpass";
            filter.frequency.value = 260 + Math.random() * 120;
        } else if (kind === "snap") {
            filter.type = "bandpass";
            filter.frequency.value = 650 + Math.random() * 700;
            filter.Q.value = 1.2 + Math.random() * 2;
        } else {
            filter.type = "bandpass";
            filter.frequency.value = 1300 + Math.random() * 4200;
            filter.Q.value = 0.7 + Math.random() * 2.2;
        }
        const gain = ctx.createGain();
        const peak = kind === "pop" ? 1.4 : kind === "snap" ? 0.9 + Math.random() * 0.5 : 0.35 + Math.random() * 0.95;
        const length = kind === "pop" ? 0.12 : kind === "snap" ? 0.03 + Math.random() * 0.04 : 0.006 + Math.random() * 0.03;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(peak, at + 0.0015);
        gain.gain.exponentialRampToValueAtTime(0.0005, at + length);
        source.connect(filter);
        filter.connect(gain);
        gain.connect(output);
        source.start(at, Math.random() * 0.03, length + 0.02);
    };
    const crackle = () => {
        if (!running) return;
        const at = ctx.currentTime + 0.01;
        const count = Math.random() < 0.25 ? 2 + Math.floor(Math.random() * 2) : 1;
        for (let k = 0; k < count; k += 1) pop(at + k * (0.008 + Math.random() * 0.04), "crackle");
        if (Math.random() < 0.2) pop(at + 0.015, "snap");
        if (Math.random() < 0.1) pop(at + 0.02, "pop");
        timer = setTimeout(crackle, nextCrackleGapMs());
    };
    crackle();

    return () => {
        running = false;
        clearTimeout(timer);
        try { bed.stop(); } catch { /* already stopped */ }
        try { breath.stop(); } catch { /* already stopped */ }
        bedGain.disconnect();
    };
}

// A synthetic room: two seconds of decaying stereo noise. Built once per
// context; a browser without ConvolverNode gets the dry sound.
function roomTail(ctx, cache) {
    if (typeof ctx.createConvolver !== "function") return null;
    if (!cache.room) {
        const seconds = 2.6;
        const length = Math.floor(ctx.sampleRate * seconds);
        const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
        for (let channel = 0; channel < 2; channel += 1) {
            const data = buffer.getChannelData(channel);
            for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3);
        }
        cache.room = buffer;
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = cache.room;
    return convolver;
}

// A bell-like note: a sine with a quieter inharmonic partial, struck and left
// to ring. Used by the star chimes and the cues.
function bell(ctx, output, at, frequency, peak, seconds, partial = 2.76) {
    for (const [ratio, level] of [[1, 1], [partial, 0.28]]) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = frequency * ratio;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(peak * level, at + 0.006);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds / ratio);
        osc.connect(gain);
        gain.connect(output);
        osc.start(at);
        osc.stop(at + seconds / ratio + 0.05);
    }
}

// The pre-dawn sky: a warm chord that swells in over about twelve seconds,
// holds, and gives way to the next one every half minute or so, so two
// overlap at the change. Faint star chimes ring every 4 to 10 seconds into a
// soft room, over a barely-there hush of air.
function startDawn(ctx, output, cache) {
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    const room = roomTail(ctx, cache);
    if (room) { wet.connect(room); room.connect(output); } else { wet.connect(output); }

    cache.air = cache.air || brownNoise(ctx, 6);
    const air = ctx.createBufferSource();
    air.buffer = cache.air;
    air.loop = true;
    const airFilter = ctx.createBiquadFilter();
    airFilter.type = "bandpass";
    airFilter.frequency.value = 420;
    airFilter.Q.value = 0.4;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.035;
    air.connect(airFilter);
    airFilter.connect(airGain);
    airGain.connect(output);
    air.start();

    const padFilter = ctx.createBiquadFilter();
    padFilter.type = "lowpass";
    padFilter.frequency.value = 1100;
    padFilter.Q.value = 0.3;
    const padGain = ctx.createGain();
    padGain.gain.value = 0.5;
    padFilter.connect(padGain);
    padGain.connect(output);
    padGain.connect(wet);

    const live = new Set();
    const timers = new Set();
    let running = true;
    let index = 0;
    const later = (fn, ms) => {
        const handle = setTimeout(() => { timers.delete(handle); if (running) fn(); }, ms);
        timers.add(handle);
    };

    const SWELL = 12;
    const HOLD = 10;
    const RELEASE = 14;
    const chord = () => {
        const notes = DAWN_CHORDS[index % DAWN_CHORDS.length];
        index += 1;
        const at = ctx.currentTime + 0.05;
        const end = at + SWELL + HOLD + RELEASE;
        notes.forEach((frequency, n) => {
            // Two slightly detuned voices per note make it breathe.
            for (const detune of [-4, 4]) {
                const osc = ctx.createOscillator();
                osc.type = n === 0 ? "sine" : "triangle";
                osc.frequency.value = frequency;
                osc.detune.value = detune + (Math.random() * 4 - 2);
                const gain = ctx.createGain();
                const peak = (n === 0 ? 0.09 : 0.055) / (1 + n * 0.15);
                gain.gain.setValueAtTime(0.0001, at);
                gain.gain.linearRampToValueAtTime(peak, at + SWELL);
                gain.gain.setValueAtTime(peak, at + SWELL + HOLD);
                gain.gain.linearRampToValueAtTime(0.0001, end);
                osc.connect(gain);
                gain.connect(padFilter);
                osc.start(at);
                osc.stop(end + 0.1);
                const entry = { osc, gain };
                live.add(entry);
                osc.onended = () => { live.delete(entry); gain.disconnect(); };
            }
        });
        later(chord, (SWELL + HOLD) * 1000);
    };
    chord();

    const star = () => {
        const at = ctx.currentTime + 0.02;
        const note = DAWN_STAR_NOTES[Math.floor(Math.random() * DAWN_STAR_NOTES.length)];
        bell(ctx, wet, at, note, 0.05 + Math.random() * 0.04, 2.5 + Math.random() * 1.5);
        if (Math.random() < 0.3) {
            const echo = DAWN_STAR_NOTES[Math.floor(Math.random() * DAWN_STAR_NOTES.length)];
            bell(ctx, wet, at + 0.18 + Math.random() * 0.25, echo, 0.03, 2.2);
        }
        later(star, nextDawnStarGapMs());
    };
    later(star, 2500);

    return () => {
        running = false;
        for (const handle of timers) clearTimeout(handle);
        timers.clear();
        try { air.stop(); } catch { /* already stopped */ }
        for (const { osc } of live) { try { osc.stop(); } catch { /* already stopped */ } }
        live.clear();
        padGain.disconnect();
        airGain.disconnect();
        wet.disconnect();
    };
}

// Short sounds for actions, for a theme that asks for them with `cues`.
// tick: a soft glass tick, pitch varied so repeats do not grate.
// send: two rising notes. done: one low, warm chime.
function playCue(ctx, output, name, wet) {
    const at = ctx.currentTime + 0.005;
    if (name === "tick") {
        bell(ctx, output, at, 2300 + Math.random() * 500, 0.07, 0.07, 2.4);
    } else if (name === "send") {
        bell(ctx, output, at, 880, 0.09, 0.45);
        bell(ctx, output, at + 0.09, 1318.51, 0.09, 0.6);
        if (wet) bell(ctx, wet, at + 0.09, 1318.51, 0.04, 0.8);
    } else if (name === "done") {
        bell(ctx, output, at, 293.66, 0.16, 1.8, 2.0);
        bell(ctx, output, at, 440, 0.05, 1.4, 2.0);
        if (wet) bell(ctx, wet, at, 293.66, 0.08, 2.2, 2.0);
    }
}

const VOICES = { fire: startFire, dawn: startDawn };

/** For offline rendering in tests: start a named voice on any context. */
export function startThemeVoice(id, ctx, output, cache = {}) {
    return VOICES[id] ? VOICES[id](ctx, output, cache) : null;
}

/** For offline rendering in tests: play a named cue on any context. */
export function playThemeCue(name, ctx, output, cache = {}) {
    const room = roomTail(ctx, cache);
    let wet = null;
    if (room) { wet = ctx.createGain(); wet.gain.value = 0.35; wet.connect(room); room.connect(output); }
    playCue(ctx, output, name, wet);
}

export function createThemeSoundPlayer({ win = typeof window === "undefined" ? null : window } = {}) {
    const doc = win?.document || null;
    const AudioContextClass = win ? (win.AudioContext || win.webkitAudioContext) : null;
    let ctx = null;
    let master = null;
    let cueBus = null;
    let cueWet = null;
    const lastCue = {};
    let stopVoice = null;
    let sound = null;
    let enabled = false;
    let volume = 0;
    let startedAt = 0;
    let timer = null;
    // A voice that is fading out, with the timer that will stop it. Kept so
    // that turning the sound back on during the fade reuses it, and so that a
    // second fade or dispose() can never lose track of it.
    let fading = null;
    const cache = {};

    const stopFadingNow = () => {
        if (!fading) return;
        clearTimeout(fading.handle);
        const { stop } = fading;
        fading = null;
        stop();
    };

    const setMarker = (value) => {
        if (!doc) return;
        if (value) doc.documentElement.dataset.psThemeSound = value;
        else delete doc.documentElement.dataset.psThemeSound;
    };

    const ensureContext = () => {
        if (ctx || !AudioContextClass) return ctx;
        try {
            ctx = new AudioContextClass();
            master = ctx.createGain();
            master.gain.value = 0;
            const limiter = ctx.createDynamicsCompressor();
            limiter.threshold.value = -3;
            limiter.knee.value = 0;
            limiter.ratio.value = 20;
            limiter.attack.value = 0.001;
            limiter.release.value = 0.1;
            master.connect(limiter);
            limiter.connect(ctx.destination);
            // Cues bypass the ambient's fade: they sound at the person's
            // volume whenever the theme's sound is on and the tab is shown.
            cueBus = ctx.createGain();
            cueBus.gain.value = 0;
            cueBus.connect(limiter);
            const room = roomTail(ctx, cache);
            if (room) {
                cueWet = ctx.createGain();
                cueWet.gain.value = 0.35;
                cueWet.connect(room);
                room.connect(cueBus);
            }
        } catch {
            ctx = null;
        }
        return ctx;
    };

    // iPhone Safari also reports "interrupted" (after a call, a lock or another
    // app taking the audio) and stays silent until resumed by a gesture.
    const resume = () => {
        if (ctx && (ctx.state === "suspended" || ctx.state === "interrupted")) ctx.resume().catch(() => {});
    };

    // Older iOS unlocks audio only when a sound starts inside the gesture
    // itself; resume() alone is not enough there. One silent sample does it.
    const unlock = () => {
        if (!ctx) return;
        try {
            const blip = ctx.createBufferSource();
            blip.buffer = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
            blip.connect(ctx.destination);
            blip.start(0);
        } catch { /* nothing to unlock */ }
    };

    const onGesture = () => {
        if (ctx && ctx.state !== "running") unlock();
        resume();
    };

    // Fade to silence over `seconds`, then stop the voice so it costs nothing.
    const silence = (seconds = 0.3) => {
        if (master && ctx) {
            master.gain.cancelScheduledValues(ctx.currentTime);
            master.gain.setTargetAtTime(0, ctx.currentTime, Math.max(0.02, seconds / 4));
        }
        if (stopVoice) {
            stopFadingNow();
            const entry = { stop: stopVoice, id: sound?.id ?? null, handle: null };
            stopVoice = null;
            entry.handle = setTimeout(() => {
                if (fading === entry) fading = null;
                entry.stop();
            }, seconds * 1000 + 300);
            fading = entry;
        }
    };

    const tick = () => {
        const active = Boolean(enabled && sound && VOICES[sound.id] && doc && !doc.hidden);
        if (!active) {
            silence(0.6);
            setMarker(enabled && sound ? "resting" : null);
            return;
        }
        if (!ensureContext()) return;
        const elapsed = (Date.now() - startedAt) / 1000;
        const level = themeSoundEnvelope(elapsed, sound);
        if (level > 0 && !stopVoice && fading) {
            if (fading.id === sound.id) {
                clearTimeout(fading.handle);
                stopVoice = fading.stop;
                fading = null;
            } else {
                stopFadingNow();
            }
        }
        if (level > 0 && !stopVoice && ctx.state === "running") stopVoice = VOICES[sound.id](ctx, master, cache);
        if (level === 0 && stopVoice) {
            stopVoice();
            stopVoice = null;
        }
        master.gain.setTargetAtTime(level * volume * MAX_GAIN, ctx.currentTime, 0.12);
        setMarker(level > 0 ? "playing" : "resting");
    };

    const schedule = () => {
        if (timer || !win) return;
        timer = win.setInterval(tick, TICK_MS);
        for (const type of GESTURES) win.addEventListener(type, onGesture, true);
    };

    const unschedule = () => {
        if (!timer || !win) return;
        win.clearInterval(timer);
        timer = null;
        for (const type of GESTURES) win.removeEventListener(type, onGesture, true);
    };

    return {
        /** Call inside a click or key handler so the browser allows sound. */
        prime() {
            if (!ensureContext()) return;
            unlock();
            resume();
        },
        /**
         * Play a short action sound (see THEME_SOUND_CUES) when the current
         * theme asks for cues and its sound is on. Silent otherwise, and
         * never before the browser has allowed audio.
         */
        cue(name) {
            const gap = THEME_SOUND_CUES[name];
            if (gap === undefined || !enabled || !sound?.cues || !doc || doc.hidden) return false;
            if (!ctx || ctx.state !== "running" || !cueBus) return false;
            const now = Date.now();
            if (now - (lastCue[name] || 0) < gap) return false;
            lastCue[name] = now;
            cueBus.gain.setTargetAtTime(volume * MAX_GAIN, ctx.currentTime, 0.005);
            try { playCue(ctx, cueBus, name, cueWet); } catch { return false; }
            return true;
        },
        update(next = {}) {
            const nextSound = next.sound && VOICES[next.sound.id] ? next.sound : null;
            const nextEnabled = next.enabled === true && Boolean(nextSound);
            const turnedOn = nextEnabled && (!enabled || nextSound?.id !== sound?.id);
            const previous = sound;
            sound = nextSound;
            enabled = nextEnabled;
            volume = Math.min(1, Math.max(0, Number(next.volume) || 0));
            if (turnedOn) startedAt = Date.now();
            if (enabled) {
                schedule();
                tick();
            } else {
                silence(themeSoundTiming(previous).fadeOut);
                setMarker(null);
                unschedule();
            }
        },
        dispose() {
            enabled = false;
            silence(0.05);
            stopFadingNow();
            setMarker(null);
            unschedule();
            if (ctx) ctx.close().catch(() => {});
            ctx = null;
            master = null;
            cueBus = null;
            cueWet = null;
        },
    };
}

let sharedPlayer = null;

export function themeSoundPlayer() {
    if (!sharedPlayer) sharedPlayer = createThemeSoundPlayer();
    return sharedPlayer;
}
