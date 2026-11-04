import React from "react";
import { createPortal } from "react-dom";

const h = React.createElement;
const HOVER_TOOLTIP_MS = 400;

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
});

/**
 * A workflow-screen toolbar button drawn as an icon (of-04, the owner's "icons with hover tooltips instead of text
 * buttons"). Its accessible name is `label`, exactly the text the button used to show, so screen readers and tests find
 * it as before. A tooltip with the label (and `title`, the reason or explanation the button used to carry, when there is
 * one) shows on mouse hover and on keyboard focus, and Escape or leaving hides it. The tooltip is portaled to <body>, as
 * the top bar's is, so a clipping pane cannot hide it. The wrapper takes the hover, so a disabled button still explains
 * why. `data-title` keeps that explanation readable to tests. On touch, the button only acts (no tooltip). `badge` (a
 * count) shows on the icon, tinted by `badgeLevel`; the count is said in `title` too, for screen readers.
 */
export function WorkflowToolButton({ label, glyph: glyphName, title = null, danger = false, disabled = false, badge = null, badgeLevel = null, onClick, ...rest }) {
    const [tip, setTip] = React.useState(null);
    const buttonRef = React.useRef(null);
    const timerRef = React.useRef(null);
    const describedId = `wf-tool-${React.useId().replace(/:/g, "")}`;
    const explain = typeof title === "string" && title && title !== label ? title : null;
    const show = () => {
        const element = buttonRef.current;
        if (!element || typeof window === "undefined") return;
        const box = element.getBoundingClientRect();
        const below = box.bottom + 56 < window.innerHeight;
        setTip({ x: box.left + box.width / 2, y: below ? box.bottom + 6 : box.top - 6, placement: below ? "below" : "above" });
    };
    const hide = () => {
        clearTimeout(timerRef.current);
        setTip(null);
    };
    React.useEffect(() => () => clearTimeout(timerRef.current), []);
    const focusVisible = element => {
        try { return element.matches(":focus-visible"); } catch { return true; }
    };
    const tooltip = tip && typeof document !== "undefined" && document.body
        ? createPortal(h("span", { className: `ps-icon-tooltip is-${tip.placement}`, role: "tooltip",
            style: { left: `${tip.x}px`, top: `${tip.y}px` } }, explain ? `${label} — ${explain}` : label), document.body)
        : null;
    const icon = WORKFLOW_TOOL_GLYPHS[glyphName] ?? WORKFLOW_TOOL_GLYPHS.details;
    return h("span", { className: "ps-workflow-tool-wrap",
        onPointerEnter: event => {
            if (event.pointerType !== "mouse") return;
            clearTimeout(timerRef.current);
            timerRef.current = setTimeout(show, HOVER_TOOLTIP_MS);
        },
        onPointerLeave: hide },
    h("button", { ref: buttonRef, type: "button", disabled,
        className: `ps-mini-button ps-workflow-tool-button${danger ? " is-danger" : ""}`,
        "aria-label": label, "data-title": explain ?? undefined, "aria-describedby": explain ? describedId : undefined,
        onClick, onFocus: event => { if (focusVisible(event.currentTarget)) show(); }, onBlur: hide,
        onKeyDown: event => { if (event.key === "Escape" && tip) { event.stopPropagation(); hide(); } },
        ...rest },
    h("span", { className: "ps-workflow-tool-glyph", "aria-hidden": "true" }, icon()),
    Number.isSafeInteger(badge) && badge > 0
        ? h("span", { className: "ps-workflow-tool-badge", "data-level": badgeLevel ?? undefined, "aria-hidden": "true" }, badge > 99 ? "99+" : String(badge))
        : null),
    explain ? h("span", { id: describedId, className: "ps-sr-only" }, explain) : null,
    tooltip);
}
