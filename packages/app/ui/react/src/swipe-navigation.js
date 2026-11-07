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

// While one of these is open the person is in a dialog, not on a screen:
// two fingers must not navigate away under it. Several of them are fixed
// overlays inside the workspace, which a transform would also displace.
const DIALOG_OPEN = ".ps-modal-backdrop, .ps-share-overlay, .ps-budget-sheet-backdrop, .ps-moa-dialog";
const dialogOpen = () => typeof document !== "undefined" && Boolean(document.querySelector(DIALOG_OPEN));

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
        let touched = null;
        const surface = () => (touched?.isConnected ? touched : null)
            || root.querySelector(":scope > .ps-mobile-canvas-layer.is-maximized:not(.is-hidden)")
            || root;
        const move = (x, transition = "") => {
            const el = surface();
            if (moved && moved !== el) { moved.style.transition = ""; moved.style.transform = ""; }
            el.style.transition = transition;
            el.style.transform = x ? `translate3d(${x}px,0,0)` : "";
            moved = x || transition ? el : null;
        };

        // Timers and frames of a committed swipe. Cleanup cancels them, so a
        // surface that is gone (phone layout off, MoA opened, unmount) can
        // never navigate or write a transform afterwards.
        let alive = true;
        const pending = { timer: null, frames: [], go: null };
        const cancelPending = () => {
            if (pending.timer) window.clearTimeout(pending.timer);
            pending.timer = null;
            pending.go = null;
            for (const frame of pending.frames) cancelAnimationFrame(frame);
            pending.frames = [];
        };
        // A new swipe during the slide-out finishes the first one at once:
        // its navigation happens and the screen is put straight back.
        const flushPending = () => {
            const go = pending.go;
            cancelPending();
            if (!go) return;
            go();
            touched = null;
            move(0);
        };
        const begin = (x, y, d, decided = false, source = null) => {
            flushPending();
            gesture = { x, y, d, time: Date.now(), kind: decided ? "swipe" : null, dx: 0, can: false, source };
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
            pending.go = go;
            pending.timer = window.setTimeout(() => {
                pending.timer = null;
                pending.go = null;
                if (!alive) return;
                go();
                // The new screen slides in, whatever was touched.
                touched = null;
                move(-direction * width * 0.35);
                pending.frames.push(requestAnimationFrame(() => {
                    pending.frames.push(requestAnimationFrame(() => { if (alive) move(0, "transform 220ms cubic-bezier(.2,.8,.2,1)"); }));
                }));
            }, 150);
        };
        const cancel = () => {
            if (gesture?.kind === "swipe") move(0, "transform 180ms ease-out");
            gesture = null;
            clearHint();
        };

        // Fingers count on the workspace and on the phone's full-screen
        // artifact preview, which sits over it outside this element. The
        // preview slides by itself; dialogs and everything else are left alone.
        const host = root.parentElement || root;
        const surfaceFor = (target) => {
            const overlay = target?.closest?.(".ps-artifact-overlay");
            if (overlay && host.contains(overlay)) return overlay;
            return root.contains(target) ? root : null;
        };
        const onStart = (event) => {
            if (event.touches.length === 2) {
                if (dialogOpen()) return;
                const target = surfaceFor(event.target);
                if (!target) return;
                touched = target === root ? null : target;
                const p = twoFingers(event); begin(p.x, p.y, p.d);
                return;
            }
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
        // A canvas forwards one gesture at a time, tagged with an identity
        // object; anything that is not the gesture it started is ignored, and
        // a canvas never interrupts fingers already on the page.
        const onFrameSwipe = (event) => {
            const { phase, x, y, gesture: source, surface: frameSurface } = event.detail || {};
            if (!source || typeof source !== "object") return;
            if (phase === "start") {
                if (gesture && !gesture.source) return;
                if (dialogOpen()) return;
                if (!Number.isFinite(x) || !Number.isFinite(y)) return;
                // A frame inside the full-screen artifact preview moves the
                // preview, as fingers on its own bar do.
                const overlay = frameSurface instanceof Element ? surfaceFor(frameSurface) : null;
                touched = overlay && overlay !== root ? overlay : null;
                begin(x, y, 0, true, source);
                return;
            }
            if (!gesture || gesture.source !== source) return;
            if (phase === "move" && Number.isFinite(x) && Number.isFinite(y)) update(x, y, 0);
            else if (phase === "end") end();
            else cancel();
        };
        const onTransitionEnd = (event) => { if (event.target === moved && !moved.style.transform) { moved.style.transition = ""; moved = null; } };

        host.addEventListener("touchstart", onStart, { passive: true });
        host.addEventListener("touchmove", onMove, { passive: false });
        host.addEventListener("touchend", onEnd, { passive: true });
        host.addEventListener("touchcancel", cancel, { passive: true });
        host.addEventListener("transitionend", onTransitionEnd);
        window.addEventListener(TWO_FINGER_SWIPE_EVENT, onFrameSwipe);
        return () => {
            alive = false;
            cancelPending();
            host.removeEventListener("touchstart", onStart);
            host.removeEventListener("touchmove", onMove);
            host.removeEventListener("touchend", onEnd);
            host.removeEventListener("touchcancel", cancel);
            host.removeEventListener("transitionend", onTransitionEnd);
            window.removeEventListener(TWO_FINGER_SWIPE_EVENT, onFrameSwipe);
            move(0);
            hint?.remove();
        };
    }, [ref, enabled]);
}
