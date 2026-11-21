/**
 * Canvas slots: the one place that says how many canvases a session has.
 *
 * Browser-safe. The SDK, the portal server and the API mirror import this module; `ui/core` keeps its own copy of the
 * limit, checked equal by a test, so it takes no SDK dependency. Database CHECKs write the number literally in their
 * migrations.
 */

export const CANVAS_SLOT_MAX = 10;
export const CANVAS_SLOT_RANGE = `1-${CANVAS_SLOT_MAX}`;
export const CANVAS_SLOT_ERROR = `slot must be an integer ${CANVAS_SLOT_RANGE}`;
/** Events scanned for one slot's latest event: enough that every other slot drawing in between cannot hide it. */
export const CANVAS_EVENT_WINDOW = 6 * CANVAS_SLOT_MAX;
/** A canvas key for slots 2-10: "<sessionId>#<slot>". Slot 1's key is the bare session id. */
export const CANVAS_KEY_SUFFIX = /^(.*)#(10|[2-9])$/;

/** An integer number from 1 to CANVAS_SLOT_MAX. Text is not coerced. */
export function isCanvasSlot(n) {
    return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= CANVAS_SLOT_MAX;
}

/** A missing value (undefined, null, "") is slot 1; otherwise the slot it names, or null when it names none. */
export function normalizeCanvasSlot(value) {
    if (value === undefined || value === null || value === "") return 1;
    const n = Number(value);
    return isCanvasSlot(n) ? n : null;
}

/** Slot 1 keeps the historical name canvas.html; slots 2-10 are canvas2.html .. canvas10.html. */
export function canvasArtifactFilename(slot) {
    return slot <= 1 ? "canvas.html" : `canvas${slot}.html`;
}
