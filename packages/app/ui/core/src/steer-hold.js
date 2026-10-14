/**
 * The phone's blue button while a turn accepts steering. A tap steers. With
 * typed text, a hold opens a menu above the button: "Steer now" (lit, the
 * default) and "Queue". Release on an item does it; release on the button
 * keeps the menu open for a tap on an item; release or a tap anywhere else
 * closes it and sends nothing (the text stays). Nothing is remembered.
 *
 * States: { phase: "idle" } | { phase: "pressed", canHold } |
 * { phase: "open", highlight: "steer" | "queue" | null }.
 * Events: down { canHold }, hold (the timer), open (the keyboard), move
 * { over }, up { over },
 * pick { item } (a tap on an item), dismiss, cancel (the browser took the
 * gesture). `over` is "steer", "queue", "button" or null.
 * Returns { state, action } with action null, "steer" or "queue".
 */
export const STEER_HOLD_MS = 450;

const IDLE = Object.freeze({ phase: "idle" });
const MENU_ITEMS = new Set(["steer", "queue"]);

export function nextSteerHold(state, event) {
    const done = (action = null) => ({ state: IDLE, action });
    switch (event?.type) {
        case "down":
            return { state: { phase: "pressed", canHold: event.canHold === true }, action: null };
        case "hold":
            return state?.phase === "pressed" && state.canHold
                ? { state: { phase: "open", highlight: "steer" }, action: null }
                : { state, action: null };
        case "open":
            return { state: { phase: "open", highlight: "steer" }, action: null };
        case "move":
            return state?.phase === "open"
                ? { state: { phase: "open", highlight: MENU_ITEMS.has(event.over) ? event.over : null }, action: null }
                : { state, action: null };
        case "up":
            // A press that slides off the button before the hold sends nothing.
            if (state?.phase === "pressed") return done(event.over === "button" ? "steer" : null);
            if (state?.phase !== "open") return { state, action: null };
            if (MENU_ITEMS.has(event.over)) return done(event.over);
            return event.over === "button" ? { state: { phase: "open", highlight: "steer" }, action: null } : done();
        case "pick":
            return state?.phase === "open" && MENU_ITEMS.has(event.item) ? done(event.item) : { state, action: null };
        case "dismiss":
        case "cancel":
            return done();
        default:
            return { state, action: null };
    }
}
