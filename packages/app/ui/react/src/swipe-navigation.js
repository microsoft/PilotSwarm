// Phone back and forward by swipe: the desktop's view history, under a finger.
//
// Swipe right goes back, swipe left goes forward. The screen follows the
// finger, the next screen's name shows on the side it comes from, and a
// release past the threshold slides the old screen out and the new one in.
// With nothing in that direction the screen only gives a little and springs
// back. Master of Agents keeps its own swipes (it does not render this
// surface), and horizontally scrolling content keeps its own pans.
import React from "react";

const DECIDE_PX = 12;          // movement before the gesture picks an axis
const COMMIT_PX = 84;          // distance that commits a navigation
const COMMIT_VELOCITY = 0.45;  // or a quick flick, in px per ms
const EDGE_PX = 22;            // the browser owns swipes that start at the screen edge
const RESIST = 0.22;           // how far the screen gives with nowhere to go

function blockedBy(target, root, direction) {
    if (target?.closest?.("input,textarea,select,iframe,[contenteditable='true'],[contenteditable=''],.ps-swipe-ignore")) return true;
    for (let node = target; node && node !== root; node = node.parentElement) {
        if (node.scrollWidth <= node.clientWidth + 2) continue;
        if (!/auto|scroll/.test(getComputedStyle(node).overflowX)) continue;
        // A horizontal scroller keeps the pan while it can still move that way.
        const atStart = node.scrollLeft <= 1;
        const atEnd = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1;
        if (direction > 0 ? !atStart : !atEnd) return true;
    }
    return Boolean(globalThis.getSelection?.()?.toString());
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
            const side = dx > 0 ? "left" : "right";
            hint.dataset.side = side;
            hint.dataset.ready = String(Math.abs(dx) >= COMMIT_PX && can);
            hint.dataset.blocked = String(!can);
            hint.querySelector(".ps-swipe-hint-arrow").textContent = dx > 0 ? "‹" : "›";
            hint.querySelector(".ps-swipe-hint-label").textContent = can ? label : (dx > 0 ? "Nothing back" : "Nothing forward");
            hint.style.opacity = String(Math.min(1, Math.abs(dx) / COMMIT_PX));
        };
        const clearHint = () => { if (hint) hint.style.opacity = "0"; };
        const move = (x, transition = "") => {
            root.style.transition = transition;
            root.style.transform = x ? `translate3d(${x}px,0,0)` : "";
        };
        const finish = () => {
            gesture = null;
            clearHint();
        };

        const onStart = (event) => {
            if (event.touches.length !== 1) { gesture = null; return; }
            const t = event.touches[0];
            if (t.clientX < EDGE_PX || t.clientX > window.innerWidth - EDGE_PX) return;
            gesture = { x: t.clientX, y: t.clientY, time: Date.now(), axis: null, dx: 0, target: event.target };
        };
        const onMove = (event) => {
            if (!gesture || event.touches.length !== 1) return;
            const t = event.touches[0];
            const dx = t.clientX - gesture.x;
            const dy = t.clientY - gesture.y;
            if (!gesture.axis) {
                if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return;
                const horizontal = Math.abs(dx) > Math.abs(dy) * 1.4;
                if (!horizontal || blockedBy(gesture.target, root, dx)) { gesture = null; return; }
                gesture.axis = "x";
            }
            if (event.cancelable) event.preventDefault();
            const nav = navRef.current;
            const can = dx > 0 ? Boolean(nav?.canBack) : Boolean(nav?.canForward);
            const label = dx > 0 ? nav?.backTitle : nav?.forwardTitle;
            gesture.dx = dx;
            gesture.can = can;
            move(can ? dx : dx * RESIST);
            setHint(dx, label || (dx > 0 ? "Back" : "Forward"), can);
        };
        const onEnd = () => {
            if (!gesture) return;
            const { dx, can, axis, time } = gesture;
            finish();
            if (axis !== "x") return;
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
        const onCancel = () => { if (gesture?.axis === "x") move(0, "transform 180ms ease-out"); finish(); };
        const onTransitionEnd = () => { root.style.transition = ""; };

        root.addEventListener("touchstart", onStart, { passive: true });
        root.addEventListener("touchmove", onMove, { passive: false });
        root.addEventListener("touchend", onEnd, { passive: true });
        root.addEventListener("touchcancel", onCancel, { passive: true });
        root.addEventListener("transitionend", onTransitionEnd);
        return () => {
            root.removeEventListener("touchstart", onStart);
            root.removeEventListener("touchmove", onMove);
            root.removeEventListener("touchend", onEnd);
            root.removeEventListener("touchcancel", onCancel);
            root.removeEventListener("transitionend", onTransitionEnd);
            move(0);
            hint?.remove();
        };
    }, [ref, enabled]);
}
