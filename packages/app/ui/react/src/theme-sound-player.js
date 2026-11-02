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

import { nextCrackleGapMs, themeSoundEnvelope, themeSoundTiming } from "pilotswarm/ui-core";

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

const VOICES = { fire: startFire };

export function createThemeSoundPlayer({ win = typeof window === "undefined" ? null : window } = {}) {
    const doc = win?.document || null;
    const AudioContextClass = win ? (win.AudioContext || win.webkitAudioContext) : null;
    let ctx = null;
    let master = null;
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
        },
    };
}

let sharedPlayer = null;

export function themeSoundPlayer() {
    if (!sharedPlayer) sharedPlayer = createThemeSoundPlayer();
    return sharedPlayer;
}
