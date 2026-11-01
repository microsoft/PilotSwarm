// Theme sounds: the person's setting, and the shape of an ambient sound over
// time. Pure functions only. The browser player lives in ui/react.
//
// A theme that sounds declares `sound` (see themes/hearth.js). It plays for
// `playSeconds` out of every `everySeconds`, fading in and out, and only when
// the person has turned theme sounds on. The setting is desktop-only: the
// phone has no Appearance settings, and a phone in a pocket should not crackle.

export const THEME_SOUND_VOLUME_DEFAULT = 35;

export function defaultThemeSound() {
    return { on: false, volume: THEME_SOUND_VOLUME_DEFAULT };
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
    const every = positive(sound?.everySeconds, 30);
    const play = Math.min(every, positive(sound?.playSeconds, 10));
    const fadeIn = Math.min(play / 2, positive(sound?.fadeInSeconds, 2.5));
    const fadeOut = Math.min(play / 2, positive(sound?.fadeOutSeconds, 3));
    return { every, play, fadeIn, fadeOut };
}

// Raised cosine: starts and ends with zero slope, so the fade has no audible
// corner at either end.
function ease(x) {
    const t = Math.min(1, Math.max(0, x));
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

/**
 * Loudness, 0 to 1, `elapsedSeconds` after the sound was switched on.
 * The first cycle starts at once, so turning the setting on is heard.
 */
export function themeSoundEnvelope(elapsedSeconds, sound) {
    const elapsed = Number(elapsedSeconds);
    if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
    const { every, play, fadeIn, fadeOut } = themeSoundTiming(sound);
    const phase = elapsed % every;
    if (phase >= play) return 0;
    if (phase < fadeIn) return ease(phase / fadeIn);
    if (phase > play - fadeOut) return ease((play - phase) / fadeOut);
    return 1;
}
