// Theme sounds: the person's setting, and the shape of an ambient sound over
// time. Pure functions only. The browser player lives in ui/react.
//
// A theme that sounds declares `sound` (see themes/hearth.js). Theme sounds
// are on by default; the sound plays continuously while they are on, fading
// in when it starts and out when it stops. A theme may instead ask for a window:
// `playSeconds` out of every `everySeconds`, fading in and out each time.
// The setting is per device class, like touch size: `themeSound` for the
// desktop and `themeSoundMobile` for a phone, both on by default at volume 40.
// A phone in silent mode stays silent: Web Audio follows the ringer switch.

export const THEME_SOUND_VOLUME_DEFAULT = 40;

export function defaultThemeSound() {
    return { on: true, volume: THEME_SOUND_VOLUME_DEFAULT };
}

export function defaultThemeSoundMobile() {
    return { on: true, volume: THEME_SOUND_VOLUME_DEFAULT };
}

export function normalizeThemeSound(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const volume = Number(value.volume);
    return {
        on: value.on === true,
        volume: Number.isFinite(volume)
            ? Math.min(100, Math.max(0, Math.round(volume)))
            : THEME_SOUND_VOLUME_DEFAULT,
    };
}

function positive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** The timing a theme asked for, with safe defaults and sane bounds. */
export function themeSoundTiming(sound) {
    const fadeIn = positive(sound?.fadeInSeconds, 2.5);
    const fadeOut = positive(sound?.fadeOutSeconds, 2);
    const every = Number(sound?.everySeconds);
    if (!Number.isFinite(every) || every <= 0) {
        return { continuous: true, fadeIn, fadeOut };
    }
    const play = Math.min(every, positive(sound?.playSeconds, 10));
    return {
        continuous: false,
        every,
        play,
        fadeIn: Math.min(play / 2, fadeIn),
        fadeOut: Math.min(play / 2, fadeOut),
    };
}

// Raised cosine: starts and ends with zero slope, so the fade has no audible
// corner at either end.
function ease(x) {
    const t = Math.min(1, Math.max(0, x));
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

/**
 * Loudness, 0 to 1, `elapsedSeconds` after the sound was switched on.
 * It starts at once, so turning the setting on is heard.
 */
export function themeSoundEnvelope(elapsedSeconds, sound) {
    const elapsed = Number(elapsedSeconds);
    if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
    const timing = themeSoundTiming(sound);
    if (timing.continuous) return ease(elapsed / timing.fadeIn);
    const { every, play, fadeIn, fadeOut } = timing;
    const phase = elapsed % every;
    if (phase >= play) return 0;
    if (phase < fadeIn) return ease(phase / fadeIn);
    if (phase > play - fadeOut) return ease((play - phase) / fadeOut);
    return 1;
}

/**
 * Milliseconds until the fire's next crackle. Real fires are irregular:
 * mostly a random (exponential) wait averaging about a second, sometimes a
 * quick burst of crackles close together, and now and then a quiet lull.
 * `random` is injectable so the shape can be tested.
 */
export function nextCrackleGapMs(random = Math.random) {
    const roll = random();
    if (roll < 0.15) return 60 + random() * 190;
    if (roll < 0.25) return 2000 + random() * 2000;
    const wait = -Math.log(1 - random() * 0.98) * 1000;
    return Math.min(4000, Math.max(120, wait));
}
