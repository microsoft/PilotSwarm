// Phone back and forward by a two-finger swipe: the desktop's view history.
//
// Two fingers, everywhere, so one finger always belongs to the screen under
// it: scrolling the chat, and tapping, dragging and drawing on a canvas.
// Two fingers to the right go back, to the left go forward. The screen follows
// the fingers, the next screen's name shows on the side it comes from, and a
// release past the threshold slides the old screen out and the new one in.
// With nothing in that direction the screen only gives a little and springs
// back. Spreading or pinching the fingers is a zoom, not a swipe. Master of
// Agents keeps its own swipes (it does not render this surface).
//
// A canvas page runs in a sandboxed frame, so its touches never reach this
// document. The canvas forwards a two-finger swipe it has classified as one
// (see CanvasFrame) as a `ps-two-finger-swipe` window event in page
// coordinates; it goes through the same gesture as a touch on the page.
import React from "react";

export const TWO_FINGER_SWIPE_EVENT = "ps-two-finger-swipe";

const DECIDE_PX = 12;          // movement before the gesture picks a kind
const COMMIT_PX = 84;          // distance that commits a navigation
const COMMIT_VELOCITY = 0.45;  // or a quick flick, in px per ms
const RESIST = 0.22;           // how far the screen gives with nowhere to go

/**
 * What two fingers are doing, from how far their midpoint moved (dx, dy) and
 * how much the gap between them changed (dd), all in px: "swipe" (sideways,
 * together), "pinch" (spreading or closing), "scroll" (up or down), or null
 * while it is too early to tell.
 */
export function classifyTwoFinger(dx, dy, dd) {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const ad = Math.abs(dd);
    if (ax < DECIDE_PX && ay < DECIDE_PX && ad < DECIDE_PX) return null;
    if (ad >= DECIDE_PX && ad > ax * 0.6) return "pinch";
    if (ax >= DECIDE_PX && ax > ay * 1.4) return "swipe";
    if (ay >= DECIDE_PX) return "scroll";
    return null;
}

function ensureHint(root) {
    let hint = root.parentElement?.querySelector(":scope > .ps-swipe-hint");
    if (!hint && root.parentElement) {
        hint = document.createElement("div");
        hint.className = "ps-swipe-hint";
        hint.setAttribute("aria-hidden", "true");
        hint.innerHTML = '<span class="ps-swipe-hint-arrow"></span><span class="ps-swipe-hint-label"></span>';
        root.parentElement.appendChild(hint);
    }
    return hint;
}

function twoFingers(event) {
    const [a, b] = event.touches;
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
}

export function useSwipeNavigation(ref, { enabled = true, navigation = null } = {}) {
    const navRef = React.useRef(navigation);
    navRef.current = navigation;
    React.useEffect(() => {
        const root = ref.current;
        if (!enabled || !root || typeof window === "undefined") return undefined;
        const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        let gesture = null;
        const hint = ensureHint(root);
        const setHint = (dx, label, can) => {
            if (!hint) return;
            hint.dataset.side = dx > 0 ? "left" : "right";
            hint.dataset.ready = String(Math.abs(dx) >= COMMIT_PX && can);
            hint.dataset.blocked = String(!can);
            hint.querySelector(".ps-swipe-hint-arrow").textContent = dx > 0 ? "‹" : "›";
            hint.querySelector(".ps-swipe-hint-label").textContent = can ? label : (dx > 0 ? "Nothing back" : "Nothing forward");
            hint.style.opacity = String(Math.min(1, Math.abs(dx) / COMMIT_PX));
        };
        const clearHint = () => { if (hint) hint.style.opacity = "0"; };
        // What moves: the workspace, or a full-screen canvas on its own. A
        // transform on the workspace would make it the containing block of
        // the fixed full-screen layer, which would jump into the content box.
        let moved = null;
        const surface = () => root.querySelector(":scope > .ps-mobile-canvas-layer.is-maximized:not(.is-hidden)") || root;
        const move = (x, transition = "") => {
            const el = surface();
            if (moved && moved !== el) { moved.style.transition = ""; moved.style.transform = ""; }
            el.style.transition = transition;
            el.style.transform = x ? `translate3d(${x}px,0,0)` : "";
            moved = x || transition ? el : null;
        };

        const begin = (x, y, d, decided = false) => {
            gesture = { x, y, d, time: Date.now(), kind: decided ? "swipe" : null, dx: 0, can: false };
        };
        // Returns true while the gesture is (or may become) a swipe.
        const update = (x, y, d) => {
            if (!gesture) return false;
            const dx = x - gesture.x;
            if (!gesture.kind) {
                gesture.kind = classifyTwoFinger(dx, y - gesture.y, d - gesture.d);
                if (!gesture.kind) return true;
                if (gesture.kind !== "swipe") { gesture = null; return false; }
            }
            const nav = navRef.current;
            const can = dx > 0 ? Boolean(nav?.canBack) : Boolean(nav?.canForward);
            const label = dx > 0 ? nav?.backTitle : nav?.forwardTitle;
            gesture.dx = dx;
            gesture.can = can;
            move(can ? dx : dx * RESIST);
            setHint(dx, label || (dx > 0 ? "Back" : "Forward"), can);
            return true;
        };
        const end = () => {
            if (!gesture) return;
            const { dx, can, kind, time } = gesture;
            gesture = null;
            clearHint();
            if (kind !== "swipe") return;
            const velocity = Math.abs(dx) / Math.max(1, Date.now() - time);
            const commit = can && (Math.abs(dx) >= COMMIT_PX || (velocity >= COMMIT_VELOCITY && Math.abs(dx) > 30));
            if (!commit) { move(0, reduced ? "" : "transform 180ms ease-out"); return; }
            const width = root.getBoundingClientRect().width || window.innerWidth;
            const direction = dx > 0 ? 1 : -1;
            const go = () => (direction > 0 ? navRef.current?.back?.() : navRef.current?.forward?.());
            if (reduced) { move(0); go(); return; }
            // Out with the old screen, then in with the new from the far side.
            move(direction * width, "transform 150ms ease-in");
            window.setTimeout(() => {
                go();
                move(-direction * width * 0.35);
                requestAnimationFrame(() => requestAnimationFrame(() => move(0, "transform 220ms cubic-bezier(.2,.8,.2,1)")));
            }, 150);
        };
        const cancel = () => {
            if (gesture?.kind === "swipe") move(0, "transform 180ms ease-out");
            gesture = null;
            clearHint();
        };

        const onStart = (event) => {
            if (event.touches.length === 2) { const p = twoFingers(event); begin(p.x, p.y, p.d); return; }
            if (event.touches.length > 2) cancel();
        };
        const onMove = (event) => {
            if (!gesture || event.touches.length !== 2) return;
            const p = twoFingers(event);
            // Claimed from the first move: iOS decides on the first move
            // whether the page pinches or scrolls, and ignores a later refusal.
            if (update(p.x, p.y, p.d) && event.cancelable) event.preventDefault();
        };
        const onEnd = (event) => { if (gesture && event.touches.length < 2) end(); };
        const onFrameSwipe = (event) => {
            const { phase, x, y } = event.detail || {};
            if (phase === "start") begin(Number(x) || 0, Number(y) || 0, 0, true);
            else if (phase === "move") update(Number(x) || 0, Number(y) || 0, 0);
            else if (phase === "end") end();
            else cancel();
        };
        const onTransitionEnd = (event) => { if (event.target === moved && !moved.style.transform) { moved.style.transition = ""; moved = null; } };

        root.addEventListener("touchstart", onStart, { passive: true });
        root.addEventListener("touchmove", onMove, { passive: false });
        root.addEventListener("touchend", onEnd, { passive: true });
        root.addEventListener("touchcancel", cancel, { passive: true });
        root.addEventListener("transitionend", onTransitionEnd);
        window.addEventListener(TWO_FINGER_SWIPE_EVENT, onFrameSwipe);
        return () => {
            root.removeEventListener("touchstart", onStart);
            root.removeEventListener("touchmove", onMove);
            root.removeEventListener("touchend", onEnd);
            root.removeEventListener("touchcancel", cancel);
            root.removeEventListener("transitionend", onTransitionEnd);
            window.removeEventListener(TWO_FINGER_SWIPE_EVENT, onFrameSwipe);
            move(0);
            hint?.remove();
        };
    }, [ref, enabled]);
}
