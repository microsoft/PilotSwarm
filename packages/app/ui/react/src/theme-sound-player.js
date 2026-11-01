// Browser player for theme sounds. One player per page.
//
// The sound is synthesized live with Web Audio, so there is no audio file to
// fetch, cache or license. The loudness follows themeSoundEnvelope(): a short
// play window every few seconds with a raised-cosine fade at each end.
//
// Browsers keep audio silent until the person interacts with the page, so the
// player waits for a click or key press before it resumes its context, and a
// settings switch can prime it directly inside its own click.

import { themeSoundEnvelope } from "pilotswarm/ui-core";

const TICK_MS = 200;
// Peak gain at volume 100. The fire is ambience, not an alert.
const MAX_GAIN = 0.7;

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

// A low fire: a filtered rumble that breathes slowly, small crackles at
// irregular intervals, and now and then the deeper pop of a settling log.
function startFire(ctx, output, cache) {
    cache.bed = cache.bed || brownNoise(ctx, 5);
    cache.white = cache.white || whiteNoise(ctx, 0.08);
    const bed = ctx.createBufferSource();
    bed.buffer = cache.bed;
    bed.loop = true;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 380;
    const bedGain = ctx.createGain();
    bedGain.gain.value = 0.32;
    bed.connect(lowpass);
    lowpass.connect(bedGain);
    bedGain.connect(output);
    bed.start();
    const breath = ctx.createOscillator();
    breath.frequency.value = 0.11;
    const breathDepth = ctx.createGain();
    breathDepth.gain.value = 0.1;
    breath.connect(breathDepth);
    breathDepth.connect(bedGain.gain);
    breath.start();

    let timer = null;
    let running = true;
    const pop = (at, deep) => {
        const source = ctx.createBufferSource();
        source.buffer = cache.white;
        const filter = ctx.createBiquadFilter();
        if (deep) {
            filter.type = "lowpass";
            filter.frequency.value = 260 + Math.random() * 120;
        } else {
            filter.type = "bandpass";
            filter.frequency.value = 1100 + Math.random() * 3800;
            filter.Q.value = 0.7 + Math.random() * 2.2;
        }
        const gain = ctx.createGain();
        const peak = deep ? 0.7 : 0.08 + Math.random() * 0.5;
        const length = deep ? 0.11 : 0.004 + Math.random() * 0.028;
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
        const count = Math.random() < 0.28 ? 2 + Math.floor(Math.random() * 4) : 1;
        for (let k = 0; k < count; k += 1) pop(at + k * (0.008 + Math.random() * 0.045), false);
        if (Math.random() < 0.05) pop(at + 0.02, true);
        timer = setTimeout(crackle, 35 + Math.random() * Math.random() * 520);
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
    const cache = {};

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
            master.connect(ctx.destination);
        } catch {
            ctx = null;
        }
        return ctx;
    };

    const resume = () => {
        if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    };

    const onGesture = () => resume();

    const silence = () => {
        if (stopVoice) {
            stopVoice();
            stopVoice = null;
        }
        if (master && ctx) master.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    };

    const tick = () => {
        const active = Boolean(enabled && sound && VOICES[sound.id] && doc && !doc.hidden);
        if (!active) {
            silence();
            setMarker(enabled && sound ? "resting" : null);
            return;
        }
        if (!ensureContext()) return;
        const elapsed = (Date.now() - startedAt) / 1000;
        const level = themeSoundEnvelope(elapsed, sound);
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
        win.addEventListener("pointerdown", onGesture, true);
        win.addEventListener("keydown", onGesture, true);
    };

    const unschedule = () => {
        if (!timer || !win) return;
        win.clearInterval(timer);
        timer = null;
        win.removeEventListener("pointerdown", onGesture, true);
        win.removeEventListener("keydown", onGesture, true);
    };

    return {
        /** Call inside a click or key handler so the browser allows sound. */
        prime() {
            if (ensureContext()) resume();
        },
        update(next = {}) {
            const nextSound = next.sound && VOICES[next.sound.id] ? next.sound : null;
            const nextEnabled = next.enabled === true && Boolean(nextSound);
            const turnedOn = nextEnabled && (!enabled || nextSound?.id !== sound?.id);
            sound = nextSound;
            enabled = nextEnabled;
            volume = Math.min(1, Math.max(0, Number(next.volume) || 0));
            if (turnedOn) startedAt = Date.now();
            if (enabled) {
                schedule();
                tick();
            } else {
                silence();
                setMarker(null);
                unschedule();
            }
        },
        dispose() {
            enabled = false;
            silence();
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
