import { contrastRatio } from "./helpers.js";

/**
 * OF-S2-8 (owner, 2026-11-07T23:14Z): "see the wf viewer in all the themes and make sure proper contrasting happens. e.g.
 * the win95 theme it is too grayed out." The Workflow viewer's own colours for one theme, each one seen against what it
 * is drawn on (WCAG: 4.5:1 for text, 3:1 for icons, lines and edges):
 * - the graph's ground: the Workflow tab's own colour (the theme's background, or `page.workflowGround` when the theme
 *   paints the tab otherwise: win95's window face), the theme's panel, and a node card (the panel tinted 6% toward the
 *   text, --ps-chrome);
 * - each colour is the one the viewer used before when it is already seen, else the theme's own palette colour for it,
 *   else that colour moved toward the theme's text colour, in tenths, until it is; the text colour at the end.
 * { name: "#rrggbb" } for the CSS variables --ps-wf-<name> (web-app's applyDocumentTheme). A theme whose colours are not
 * #rgb or #rrggbb gets {} (the CSS keeps its fallbacks). Pure.
 */
export const WORKFLOW_TEXT_MIN_CONTRAST = 4.5;
export const WORKFLOW_PART_MIN_CONTRAST = 3;

const hex = value => {
    const text = String(value || "").trim();
    if (/^#[0-9a-f]{3}$/iu.test(text)) return `#${text.slice(1).split("").map(channel => channel + channel).join("")}`.toLowerCase();
    return /^#[0-9a-f]{6}$/iu.test(text) ? text.toLowerCase() : null;
};

function mix(from, to, share) {
    const channel = (color, at) => parseInt(color.slice(at, at + 2), 16);
    return `#${[1, 3, 5].map(at => Math.round(channel(from, at) * (1 - share) + channel(to, at) * share).toString(16).padStart(2, "0")).join("")}`;
}

/** The names of the colours themeWorkflowColors gives (each the CSS variable --ps-wf-<name>). */
export const WORKFLOW_COLOR_NAMES = Object.freeze(["ground", "edge", "edge-text", "node-border", "selected", "meta", "dim-text", "dim-icon",
    "icon-script", "icon-agent", "icon-wait", "icon-request", "icon-message", "icon-other", "mark-done", "mark-running", "mark-failed", "mark-canceled",
    "start", "end-succeeded", "end-blocked", "end-failed", "end-cancelled", "danger-text"]);

/** The node icons' own colours, as the viewer drew them in every theme before (the kind of each node at a glance). */
export const WORKFLOW_ICON_COLORS = Object.freeze({ script: "#60a5fa", agent: "#a78bfa", wait: "#f59e0b", request: "#fb923c", message: "#22d3ee" });

/** The first colour seen on every ground, else the first one moved toward `text` until it is; `text` at the end. */
function seenColor(candidates, grounds, min, text) {
    const colors = candidates.map(hex).filter(Boolean);
    const seen = color => grounds.every(ground => (contrastRatio(color, ground) ?? 0) >= min);
    const first = colors.find(seen);
    if (first) return first;
    const from = colors[0] ?? text;
    for (let step = 1; step <= 10; step += 1) {
        const color = mix(from, text, step / 10);
        if (seen(color)) return color;
    }
    return text;
}

export function themeWorkflowColors(theme) {
    const tui = theme?.tui ?? {};
    const text = hex(tui.foreground || theme?.page?.foreground);
    const background = hex(theme?.page?.workflowGround) ?? hex(tui.background);
    const surface = hex(tui.surface || tui.background);
    if (!text || !background || !surface) return {};
    const card = mix(surface, text, 0.06);
    const canvas = [background];
    const muted = tui.gray;
    const icon = (own, palette) => {
        // An icon sits on its own well: its colour at 16% over the card.
        const candidates = [own, palette].map(hex).filter(Boolean);
        const seenOnWell = color => (contrastRatio(color, mix(card, color, 0.16)) ?? 0) >= WORKFLOW_PART_MIN_CONTRAST;
        const first = candidates.find(seenOnWell);
        if (first) return first;
        for (let step = 1; step <= 10; step += 1) {
            const color = mix(candidates[0] ?? text, text, step / 10);
            if (seenOnWell(color)) return color;
        }
        return text;
    };
    return {
        // The Workflow tab's ground (the graph's canvas).
        "ground": background,
        // The graph: edges, their arrowheads and a parallel's dashed box; an edge's words on their label.
        "edge": seenColor([muted], canvas, WORKFLOW_PART_MIN_CONTRAST, text),
        "edge-text": seenColor([muted], [surface], WORKFLOW_TEXT_MIN_CONTRAST, text),
        // A node card's edge, and the one selected.
        "node-border": seenColor([tui.border, muted], canvas, WORKFLOW_PART_MIN_CONTRAST, text),
        "selected": seenColor([tui.cyan, tui.blue], [...canvas, card], WORKFLOW_PART_MIN_CONTRAST, text),
        // A node's type line, and a node not reached yet: quieter than the name, still read.
        "meta": seenColor([mix(hex(muted) ?? text, text, 0.3)], [card], WORKFLOW_TEXT_MIN_CONTRAST, text),
        "dim-text": seenColor([muted], [card], WORKFLOW_TEXT_MIN_CONTRAST, text),
        "dim-icon": seenColor([muted], [card], WORKFLOW_PART_MIN_CONTRAST, text),
        // Each kind of node's icon.
        "icon-script": icon(WORKFLOW_ICON_COLORS.script, tui.blue),
        "icon-agent": icon(WORKFLOW_ICON_COLORS.agent, tui.magenta),
        "icon-wait": icon(WORKFLOW_ICON_COLORS.wait, tui.yellow),
        "icon-request": icon(WORKFLOW_ICON_COLORS.request, tui.red),
        "icon-message": icon(WORKFLOW_ICON_COLORS.message, tui.cyan),
        "icon-other": icon(muted, tui.foreground),
        // A node's state mark (✓ ● ✕ ⊘) on its card.
        "mark-done": seenColor([tui.green], [card], WORKFLOW_PART_MIN_CONTRAST, text),
        "mark-running": seenColor([tui.cyan, tui.blue], [card], WORKFLOW_PART_MIN_CONTRAST, text),
        "mark-failed": seenColor([tui.red], [card], WORKFLOW_PART_MIN_CONTRAST, text),
        "mark-canceled": seenColor([muted], [card], WORKFLOW_PART_MIN_CONTRAST, text),
        // The first node's Start marker (its ring and its word) and each end's ring, on the canvas.
        "start": seenColor([tui.green], canvas, WORKFLOW_TEXT_MIN_CONTRAST, text),
        "end-succeeded": seenColor([tui.green], canvas, WORKFLOW_PART_MIN_CONTRAST, text),
        "end-blocked": seenColor([tui.yellow], canvas, WORKFLOW_PART_MIN_CONTRAST, text),
        "end-failed": seenColor([tui.red], canvas, WORKFLOW_PART_MIN_CONTRAST, text),
        "end-cancelled": seenColor([muted], canvas, WORKFLOW_PART_MIN_CONTRAST, text),
        // Words in the danger colour ("not valid", an error edge's label): on the tab, its panel and an error line's tint.
        "danger-text": seenColor([tui.red], [background, surface, mix(background, hex(tui.red) ?? text, 0.1), mix(surface, hex(tui.red) ?? text, 0.1)],
            WORKFLOW_TEXT_MIN_CONTRAST, text),
    };
}
