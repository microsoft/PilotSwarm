import { contrastRatio } from "./helpers.js";

/**
 * The border colour of a form control (an edit box, a picker, the YAML box) for one theme (UX round UX2D-F7: the
 * Workflow tab's controls drew a 60% mix of the theme's hairline, 1.19:1 in Workspace Dark). A control's edge must be
 * seen: 3:1 against the theme's background and its panel (WCAG non-text contrast). The theme's own border colour when it
 * reaches that; otherwise that colour moved toward the theme's text colour, in tenths, until it does; the text colour at
 * the end. A theme whose colours are not #rgb or #rrggbb keeps its border colour.
 */
export const CONTROL_BORDER_MIN_CONTRAST = 3;

const hex = value => {
    const text = String(value || "").trim();
    if (/^#[0-9a-f]{3}$/iu.test(text)) return `#${text.slice(1).split("").map(channel => channel + channel).join("")}`.toLowerCase();
    return /^#[0-9a-f]{6}$/iu.test(text) ? text.toLowerCase() : null;
};

function mix(from, to, share) {
    const channel = (color, at) => parseInt(color.slice(at, at + 2), 16);
    return `#${[1, 3, 5].map(at => Math.round(channel(from, at) * (1 - share) + channel(to, at) * share).toString(16).padStart(2, "0")).join("")}`;
}

export function themeControlBorder(theme) {
    const border = theme?.tui?.border || theme?.tui?.gray;
    const from = hex(border);
    const text = hex(theme?.tui?.foreground || theme?.page?.foreground);
    const grounds = [theme?.tui?.background, theme?.tui?.surface].map(hex).filter(Boolean);
    if (!from || !text || grounds.length === 0) return border ?? null;
    const seen = color => grounds.every(ground => (contrastRatio(color, ground) ?? 0) >= CONTROL_BORDER_MIN_CONTRAST);
    for (let step = 0; step <= 10; step += 1) {
        const color = step === 0 ? from : mix(from, text, step / 10);
        if (seen(color)) return color;
    }
    return text;
}
