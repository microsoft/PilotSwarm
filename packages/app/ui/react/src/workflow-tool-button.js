import React from "react";
import { createPortal } from "react-dom";

const h = React.createElement;
const HOVER_TOOLTIP_MS = 400;
/** How long a finger holds a button before its tooltip shows (the top bar's IconButton). */
const LONG_PRESS_MS = 450;
/** How long a long-press tooltip stays after the finger lifts (the top bar's IconButton). */
const LONG_PRESS_LINGER_MS = 3_000;
/** The tooltip's distance from the viewport's edges and from its button. */
const TIP_MARGIN = 8;
/** The tooltip's widest: min(260 px, the viewport less its margins); narrower only when its text is. */
const TIP_MAX_WIDTH = 260;

/** A 24-unit stroked glyph in the app's icon style (the top bar's SVG icon buttons). */
function glyph(...children) {
    return h("svg", { className: "ps-share-glyph", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2",
        strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false" }, ...children);
}

/** The workflow screen's toolbar glyphs, by what each button does (of-04). */
export const WORKFLOW_TOOL_GLYPHS = Object.freeze({
    pause: () => glyph(h("path", { d: "M9 5v14" }), h("path", { d: "M15 5v14" })),
    resume: () => glyph(h("path", { d: "M7 4l12 8-12 8z" })),
    stop: () => glyph(h("rect", { x: "6", y: "6", width: "12", height: "12", rx: "1" })),
    cancel: () => glyph(h("circle", { cx: "12", cy: "12", r: "9" }), h("path", { d: "M9 9l6 6" }), h("path", { d: "M15 9l-6 6" })),
    variables: () => glyph(h("path", { d: "M8 4c-2 0-3 1-3 3v2c0 1.5-1 2-2 3 1 1 2 1.5 2 3v2c0 2 1 3 3 3" }),
        h("path", { d: "M16 4c2 0 3 1 3 3v2c0 1.5 1 2 2 3-1 1-2 1.5-2 3v2c0 2-1 3-3 3" }), h("path", { d: "M10 10l4 4" }), h("path", { d: "M14 10l-4 4" })),
    edit: () => glyph(h("path", { d: "M4 20h4L19 9l-4-4L4 16z" }), h("path", { d: "M13 7l4 4" })),
    publish: () => glyph(h("path", { d: "M12 16V4" }), h("path", { d: "M7 9l5-5 5 5" }), h("path", { d: "M5 20h14" })),
    start: () => glyph(h("circle", { cx: "12", cy: "12", r: "9" }), h("path", { d: "M10 8l6 4-6 4z" })),
    // Exit full screen (owner, 2026-11-06T19:40Z, F7): four corners pulling in, as the canvas's Restore.
    "exit-full-screen": () => glyph(h("path", { d: "M4 9h5V4" }), h("path", { d: "M20 9h-5V4" }), h("path", { d: "M20 15h-5v5" }), h("path", { d: "M4 15h5v5" })),
    test: () => glyph(h("path", { d: "M9 3h6" }), h("path", { d: "M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" }), h("path", { d: "M7.5 15h9" })),
    details: () => glyph(h("rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }), h("path", { d: "M14 4v16" }),
        h("path", { d: "M16.5 9h2" }), h("path", { d: "M16.5 13h2" })),
    // The graph's view controls (batch 5, g-04 and g-05).
    "zoom-in": () => glyph(h("circle", { cx: "10.5", cy: "10.5", r: "6.5" }), h("path", { d: "M20 20l-4.8-4.8" }),
        h("path", { d: "M10.5 7.5v6" }), h("path", { d: "M7.5 10.5h6" })),
    "zoom-out": () => glyph(h("circle", { cx: "10.5", cy: "10.5", r: "6.5" }), h("path", { d: "M20 20l-4.8-4.8" }), h("path", { d: "M7.5 10.5h6" })),
    fit: () => glyph(h("path", { d: "M4 9V4h5" }), h("path", { d: "M15 4h5v5" }), h("path", { d: "M20 15v5h-5" }), h("path", { d: "M9 20H4v-5" })),
    hand: () => glyph(h("path", { d: "M7.5 12.5V7a1.5 1.5 0 0 1 3 0v4.5" }), h("path", { d: "M10.5 11V5a1.5 1.5 0 0 1 3 0v6" }),
        h("path", { d: "M13.5 11V6.5a1.5 1.5 0 0 1 3 0V12" }),
        h("path", { d: "M16.5 10.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a6 6 0 0 1-4.7-2.3l-2.6-3.4a1.6 1.6 0 0 1 2.5-2l1.8 1.9" })),
    // The pane's panels (batch 5, g-03).
    log: () => glyph(h("rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }), h("path", { d: "M7 9h10" }), h("path", { d: "M7 13h10" }),
        h("path", { d: "M7 17h6" })),
    activity: () => glyph(h("path", { d: "M3 12h4l3-7 4 14 3-7h4" })),
    notices: () => glyph(h("path", { d: "M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" }), h("path", { d: "M10 20.5a2 2 0 0 0 4 0" })),
    calls: () => glyph(h("path", { d: "M5 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" }),
        h("path", { d: "M12 7.5v4" }), h("path", { d: "M12 13.5v.5" })),
    // The side pane's panels and the draft's tools (batch 6, r-3).
    tools: () => glyph(h("path", { d: "M4 7h9" }), h("path", { d: "M17 7h3" }), h("circle", { cx: "15", cy: "7", r: "2" }),
        h("path", { d: "M4 17h3" }), h("path", { d: "M11 17h9" }), h("circle", { cx: "9", cy: "17", r: "2" })),
    close: () => glyph(h("path", { d: "M6 6l12 12" }), h("path", { d: "M18 6L6 18" })),
    // Sample inputs from the workflow's input schema (batch 7, f-05).
    sample: () => glyph(h("path", { d: "M4 20l10-10" }), h("path", { d: "M15 3l1 2.5 2.5 1-2.5 1L15 10l-1-2.5-2.5-1 2.5-1z" }),
        h("path", { d: "M19 12l.6 1.4 1.4.6-1.4.6L19 16l-.6-1.4-1.4-.6 1.4-.6z" })),
    // Reset layout: every step box back in its automatic place (batch 6, f-03).
    reset: () => glyph(h("path", { d: "M4 12a8 8 0 1 0 2.3-5.7" }), h("path", { d: "M4 4v4h4" })),
    // The Workflow tab's header and toolbar (owner, 2026-11-06T13:43Z: icons, no text). Definition: its graph, three nodes;
    // Workflows: a list; Start another: start again (a turn arrow around a play mark).
    definition: () => glyph(h("circle", { cx: "6", cy: "6", r: "2.6" }), h("circle", { cx: "18", cy: "6", r: "2.6" }),
        h("circle", { cx: "12", cy: "18", r: "2.6" }), h("path", { d: "M8.6 6h6.8" }), h("path", { d: "M7.4 8.3l3.2 7.4" }), h("path", { d: "M16.6 8.3l-3.2 7.4" })),
    workflows: () => glyph(h("path", { d: "M9 6h11" }), h("path", { d: "M9 12h11" }), h("path", { d: "M9 18h11" }),
        h("path", { d: "M4.5 6h.01" }), h("path", { d: "M4.5 12h.01" }), h("path", { d: "M4.5 18h.01" })),
    "start-another": () => glyph(h("path", { d: "M20 12a8 8 0 1 1-2.3-5.7" }), h("path", { d: "M20 4v4h-4" }), h("path", { d: "M10 9l5 3-5 3z" })),
    yaml: () => glyph(h("path", { d: "M8 7l-5 5 5 5" }), h("path", { d: "M16 7l5 5-5 5" }), h("path", { d: "M14 4l-4 16" })),
    compare: () => glyph(h("rect", { x: "3", y: "4", width: "7", height: "16", rx: "1" }), h("rect", { x: "14", y: "4", width: "7", height: "16", rx: "1" }),
        h("path", { d: "M5.5 9h2" }), h("path", { d: "M16.5 9h2" }), h("path", { d: "M16.5 13h2" })),
    save: () => glyph(h("path", { d: "M5 3h11l3 3v15H5z" }), h("path", { d: "M8 3v5h7V3" }), h("path", { d: "M8 21v-7h8v7" })),
    discard: () => glyph(h("path", { d: "M9 14L4 9l5-5" }), h("path", { d: "M4 9h11a5 5 0 0 1 0 10h-4" })),
    // Stage 2.4 (FU-26): the replay's steps, a bar beside a play mark.
    "step-back": () => glyph(h("path", { d: "M6 5v14" }), h("path", { d: "M18 5l-9 7 9 7z" })),
    "step-on": () => glyph(h("path", { d: "M18 5v14" }), h("path", { d: "M6 5l9 7-9 7z" })),
    // Stage 2.1b: delete a chat's definition (a bin).
    delete: () => glyph(h("path", { d: "M4 7h16" }), h("path", { d: "M9 7V4h6v3" }), h("path", { d: "M6 7l1 13h10l1-13" }), h("path", { d: "M10 11v6" }),
        h("path", { d: "M14 11v6" })),
});

/**
 * A workflow-screen toolbar button drawn as an icon (of-04, the owner's "icons with hover tooltips instead of text
 * buttons"). Its accessible name is `label`, exactly the text the button used to show, so screen readers and tests find
 * it as before. A tooltip with the label (and `title`, the reason or explanation the button used to carry, when there is
 * one) shows on mouse hover and on keyboard focus, and Escape or leaving hides it. The tooltip is portaled to <body>, as
 * the top bar's is, so a clipping pane cannot hide it. The wrapper takes the hover, so a disabled button still explains
 * why. `data-title` keeps that explanation readable to tests. On touch, as the top bar's icon buttons do (IconButton):
 * a tap acts; holding the button about half a second shows the tooltip above it instead (the click that follows is not
 * acted on), and it stays about 3 s after the finger lifts (owner, 2026-11-06T13:43Z: icons only, on the phone too).
 * The tooltip is sized to its text, at most min(260 px, the viewport less 16 px), and kept inside the viewport with an
 * 8 px margin by moving it, never by narrowing it (a button at the edge squeezed it into a one-word column); with no room
 * above its button it shows below. On touch one tooltip is open at a time: any new touch, a long-press elsewhere or a tap
 * anywhere, closes it. Review UI2-F7: one Workflow tooltip is on screen at a time whatever showed it (touch, hover or
 * focus): a new one closes the one before; and Escape closes the one on screen wherever focus is, leaving focus there.
 * `badge` (a count) shows on the icon, tinted by `badgeLevel`; the count is said in `title` too, for screen readers.
 */
/** Review UI2-F7: the Workflow tooltip on screen ({ owner, close }), whichever input showed it; one at a time. */
let shownTip = null;

export function WorkflowToolButton({ label, glyph: glyphName, title = null, danger = false, disabled = false, badge = null, badgeLevel = null, tipAbove = false, onClick,
    ...rest }) {
    const [tip, setTip] = React.useState(null);
    const buttonRef = React.useRef(null);
    const tipRef = React.useRef(null);
    const timerRef = React.useRef(null);
    const hideTimerRef = React.useRef(null);
    const longPressRef = React.useRef(false);
    const pressOriginRef = React.useRef(null);
    const describedId = `wf-tool-${React.useId().replace(/:/g, "")}`;
    const explain = typeof title === "string" && title && title !== label ? title : null;
    // A finger covers what is below it: a long-press (`touch`) prefers above. UX2P-F3: so does a button whose tooltip would
    // cover the status line under it (`tipAbove`). Either flips when there is no room.
    const show = (touch = false) => {
        const element = buttonRef.current;
        if (!element || typeof window === "undefined") return;
        const box = element.getBoundingClientRect();
        const below = touch || tipAbove ? box.top - 56 < 0 : box.bottom + 56 < window.innerHeight;
        setTip({ x: box.left + box.width / 2, y: below ? box.bottom + TIP_MARGIN : box.top - TIP_MARGIN, placement: below ? "below" : "above",
            touch: touch === true });
    };
    const hide = () => {
        clearTimeout(timerRef.current);
        clearTimeout(hideTimerRef.current);
        setTip(null);
    };
    const ownerRef = React.useRef({});
    const hideRef = React.useRef(hide);
    hideRef.current = hide;
    React.useEffect(() => () => { clearTimeout(timerRef.current); clearTimeout(hideTimerRef.current); }, []);
    // Review UI2-F7: shown, this tooltip closes any other; while it is shown, Escape closes it wherever focus is.
    const shownNow = Boolean(tip);
    React.useLayoutEffect(() => {
        const owner = ownerRef.current;
        if (!shownNow) {
            if (shownTip?.owner === owner) shownTip = null;
            return undefined;
        }
        if (shownTip && shownTip.owner !== owner) shownTip.close();
        shownTip = { owner, close: () => hideRef.current() };
        if (typeof document === "undefined") return undefined;
        const onKey = event => { if (event.key === "Escape") hideRef.current(); };
        document.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("keydown", onKey, true);
            if (shownTip?.owner === owner) shownTip = null;
        };
    }, [shownNow]);
    // A touch tooltip closes at the next touch anywhere: a tap, or a long-press on another button (one at a time).
    const touchTip = Boolean(tip?.touch);
    React.useEffect(() => {
        if (!touchTip || typeof document === "undefined") return undefined;
        const onDown = () => { clearTimeout(hideTimerRef.current); setTip(null); };
        document.addEventListener("pointerdown", onDown, true);
        return () => document.removeEventListener("pointerdown", onDown, true);
    }, [touchTip]);
    // Sized to its text and kept inside the (visual) viewport, before it is painted (IconButton's measure).
    React.useLayoutEffect(() => {
        const element = tipRef.current, button = buttonRef.current;
        if (!tip || !element || !button || typeof window === "undefined") return;
        const viewport = window.visualViewport;
        const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
        const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
        const box = button.getBoundingClientRect();
        element.style.width = "max-content";
        element.style.maxWidth = `${Math.min(TIP_MAX_WIDTH, width - 2 * TIP_MARGIN)}px`;
        const own = element.getBoundingClientRect();
        let below = tip.placement === "below";
        if (!below && box.top - own.height - TIP_MARGIN < top) below = true;
        if (below && box.bottom + own.height + TIP_MARGIN > top + height && box.top - own.height - TIP_MARGIN >= top) below = false;
        // UX2P-F3: one that prefers above goes back above as soon as its measured height fits there.
        if (below && tipAbove && box.top - own.height - TIP_MARGIN >= top) below = false;
        const x = Math.max(left + TIP_MARGIN, Math.min(box.left + box.width / 2 - own.width / 2, left + width - own.width - TIP_MARGIN));
        const y = Math.max(top + TIP_MARGIN, Math.min(below ? box.bottom + TIP_MARGIN : box.top - own.height - TIP_MARGIN, top + height - own.height - TIP_MARGIN));
        element.style.transform = "none";
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
    }, [tip]);
    // Touch (IconButton's long-press): hold to see the tooltip; a real move (a scroll) cancels it.
    const startPress = event => {
        if (event.pointerType === "mouse") return;
        longPressRef.current = false;
        pressOriginRef.current = { x: event.clientX, y: event.clientY };
        clearTimeout(timerRef.current);
        clearTimeout(hideTimerRef.current);
        timerRef.current = setTimeout(() => { longPressRef.current = true; show(true); }, LONG_PRESS_MS);
    };
    const movePress = event => {
        if (event.pointerType === "mouse" || !pressOriginRef.current) return;
        const dx = event.clientX - pressOriginRef.current.x;
        const dy = event.clientY - pressOriginRef.current.y;
        if (dx * dx + dy * dy > 100) {
            pressOriginRef.current = null;
            clearTimeout(timerRef.current);
            setTip(null);
        }
    };
    const endPress = event => {
        if (event.pointerType === "mouse") return;
        pressOriginRef.current = null;
        clearTimeout(timerRef.current);
        if (longPressRef.current) {
            clearTimeout(hideTimerRef.current);
            hideTimerRef.current = setTimeout(() => setTip(null), LONG_PRESS_LINGER_MS);
            // The click that follows a long-press usually consumes the flag; clear it shortly after in case it never comes.
            setTimeout(() => { longPressRef.current = false; }, 250);
        } else setTip(null);
    };
    const act = event => {
        // The click after a long-press only showed the tooltip.
        if (longPressRef.current) { longPressRef.current = false; event.preventDefault?.(); return; }
        if (disabled) { event.preventDefault?.(); return; }
        onClick?.(event);
    };
    const focusVisible = element => {
        try { return element.matches(":focus-visible"); } catch { return true; }
    };
    const tooltip = tip && typeof document !== "undefined" && document.body
        ? createPortal(h("span", { ref: tipRef, className: `ps-icon-tooltip is-${tip.placement}`, role: "tooltip",
            style: { left: `${tip.x}px`, top: `${tip.y}px` } }, explain ? `${label} — ${explain}` : label), document.body)
        : null;
    const icon = WORKFLOW_TOOL_GLYPHS[glyphName] ?? WORKFLOW_TOOL_GLYPHS.details;
    return h("span", { className: "ps-workflow-tool-wrap",
        onPointerEnter: event => {
            if (event.pointerType !== "mouse") return;
            clearTimeout(timerRef.current);
            timerRef.current = setTimeout(show, HOVER_TOOLTIP_MS);
        },
        onPointerLeave: event => { if (event.pointerType === "mouse") hide(); },
        onPointerDown: startPress, onPointerMove: movePress, onPointerUp: endPress, onPointerCancel: endPress,
        // iOS opens its callout on a long-press without this (and the touch-callout CSS on the button).
        onContextMenu: event => { if (longPressRef.current || pressOriginRef.current) event.preventDefault?.(); } },
    // UXFD-F15: a disabled tool button stays focusable (aria-disabled, not the disabled attribute), so a keyboard or
    // screen-reader user reaches it and hears why (its description, as the tooltip shows it); a click does nothing.
    h("button", { ref: buttonRef, type: "button", "aria-disabled": disabled ? "true" : undefined,
        className: `ps-mini-button ps-workflow-tool-button${danger ? " is-danger" : ""}${disabled ? " is-disabled" : ""}`,
        "aria-label": label, "data-title": explain ?? undefined, "aria-describedby": explain ? describedId : undefined,
        onClick: act, onFocus: event => { if (focusVisible(event.currentTarget)) show(); }, onBlur: hide,
        onKeyDown: event => { if (event.key === "Escape" && tip) { event.stopPropagation(); hide(); } },
        ...rest },
    h("span", { className: "ps-workflow-tool-glyph", "aria-hidden": "true" }, icon()),
    Number.isSafeInteger(badge) && badge > 0
        ? h("span", { className: "ps-workflow-tool-badge", "data-level": badgeLevel ?? undefined, "aria-hidden": "true" }, badge > 99 ? "99+" : String(badge))
        : null),
    explain ? h("span", { id: describedId, className: "ps-sr-only" }, explain) : null,
    tooltip);
}
