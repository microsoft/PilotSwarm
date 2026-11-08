export const HEADER_ACCENT_PASS_MS = 5_500;
export const HEADER_ACCENT_MIN_IDLE_MS = 60_000;
export const HEADER_ACCENT_MAX_IDLE_MS = 180_000;

export function createHeaderAccent({
    start,
    stop,
    random = Math.random,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}) {
    let enabled = false;
    let active = false;
    let timer = null;
    let disposed = false;

    const clear = () => {
        if (timer !== null) clearTimer(timer);
        timer = null;
        if (active) {
            active = false;
            stop();
        }
    };
    const schedule = () => {
        const delay = HEADER_ACCENT_MIN_IDLE_MS
            + random() * (HEADER_ACCENT_MAX_IDLE_MS - HEADER_ACCENT_MIN_IDLE_MS);
        timer = setTimer(() => {
            timer = null;
            if (!enabled || disposed) return;
            active = true;
            start();
            timer = setTimer(() => {
                timer = null;
                active = false;
                stop();
                if (enabled && !disposed) schedule();
            }, HEADER_ACCENT_PASS_MS);
        }, delay);
    };

    return {
        setEnabled(next) {
            if (disposed || enabled === next) return;
            enabled = next;
            clear();
            if (enabled) schedule();
        },
        dispose() {
            disposed = true;
            enabled = false;
            clear();
        },
    };
}
