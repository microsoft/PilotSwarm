import { contrastRatio } from "./helpers.js";

// Colours for code and plain-text files in the portal (the Workspace tab's
// editor and its markdown preview), from the theme's own palette. A colour is
// used only when it is readable on the theme's panel (tui.surface, what the
// side pane is painted with): 4.5:1, the WCAG bar for body text. Otherwise the
// next one in its list, and in the end the theme's text colour.
export const CODE_COLOR_MIN_CONTRAST = 4.5;

// Where each role looks, in order: a tui colour, or a terminal bright colour.
const CANDIDATES = {
    keyword: ["tui.magenta", "terminal.brightMagenta", "tui.blue", "terminal.brightBlue"],
    string: ["tui.green", "terminal.brightGreen"],
    number: ["tui.yellow", "terminal.brightYellow", "tui.cyan"],
    function: ["tui.blue", "terminal.brightBlue", "tui.cyan", "terminal.brightCyan"],
    type: ["tui.cyan", "terminal.brightCyan", "tui.yellow", "terminal.brightYellow"],
    property: ["tui.cyan", "terminal.brightCyan", "tui.blue", "terminal.brightBlue"],
    variable: ["tui.yellow", "terminal.brightYellow", "tui.red", "terminal.brightRed"],
    comment: ["tui.gray", "terminal.brightBlack"],
    heading: ["tui.cyan", "terminal.brightCyan", "tui.blue", "terminal.brightBlue"],
    link: ["tui.cyan", "terminal.brightCyan", "tui.blue", "terminal.brightBlue"],
    invalid: ["tui.red", "terminal.brightRed"],
    inserted: ["tui.green", "terminal.brightGreen"],
    deleted: ["tui.red", "terminal.brightRed"],
};

export const CODE_COLOR_ROLES = Object.freeze(Object.keys(CANDIDATES));

function pick(theme, ref) {
    const [group, key] = ref.split(".");
    return theme?.[group]?.[key];
}

/** The readable colour for each role, for one theme: { keyword: "#…", … }. */
export function themeCodeColors(theme) {
    const text = theme?.tui?.foreground || theme?.page?.foreground || "#ffffff";
    const panel = theme?.tui?.surface || theme?.page?.background;
    const readable = (colour) => {
        const ratio = contrastRatio(colour, panel);
        return ratio !== null && ratio >= CODE_COLOR_MIN_CONTRAST;
    };
    const out = {};
    for (const [role, refs] of Object.entries(CANDIDATES)) {
        out[role] = refs.map((ref) => pick(theme, ref)).find((colour) => colour && readable(colour)) ?? text;
    }
    return out;
}
