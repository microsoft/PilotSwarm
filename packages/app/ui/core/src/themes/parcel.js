import { createTheme, THEME_GROUP_OTHER } from "./helpers.js";

// Parcel. A daytime card: cream paper, pine ink, a cranberry ribbon.
//
// The ribbon is the accent. Failed is a burnt orange, not the same red, so a
// status dot is not mistaken for a selected row.

const CREAM = "#f6f1e6";
const PAPER = "#fffaf2";
const INK = "#1c2a22";
const RIBBON = "#9d1c28";
const FAILED = "#c2410c";
const HOLLY = "#13703f";
const GOLD = "#9a5f00";
const TWINE = "#9a6c34";

const parcelTheme = createTheme({
    id: "parcel",
    label: "Parcel",
    description: "Cream paper and a cranberry ribbon. Failed is a separate red.",
    group: THEME_GROUP_OTHER,
    icon: {
        viewBox: "0 0 32 32",
        paths: [
            { d: "M0 0h32v32H0z", fill: CREAM },
            { d: "M6 12h20v14H6z", fill: RIBBON },
            { d: "M8 14h16v10H8z", fill: PAPER },
            { d: "M14 12h4v14h-4z", fill: RIBBON },
            { d: "M6 17h20v3H6z", fill: RIBBON },
            { d: "M16 12 9 6h5l2 4 2-4h5z", fill: RIBBON },
            { d: "M14 8h4v4h-4z", fill: GOLD },
        ],
    },
    page: {
        background: CREAM,
        foreground: INK,
        overlayBackground: PAPER,
        overlayForeground: INK,
        hintColor: "#4a5850",
        modalBackdrop: "rgba(28, 42, 34, 0.34)",
        modalBackground: PAPER,
        modalBorder: TWINE,
        modalForeground: INK,
        modalMuted: "#4a5850",
        modalSelectedBackground: RIBBON,
        modalSelectedBorder: "#c44752",
        modalSelectedForeground: PAPER,
    },
    terminal: {
        background: PAPER,
        foreground: INK,
        cursor: RIBBON,
        cursorAccent: PAPER,
        selectionBackground: RIBBON,
        black: INK,
        red: FAILED,
        green: HOLLY,
        yellow: GOLD,
        blue: "#1d6a8a",
        magenta: "#7a3e68",
        cyan: RIBBON,
        white: "#5c6b60",
        brightBlack: "#4a5850",
        brightRed: "#9a3008",
        brightGreen: "#0f4a28",
        brightYellow: "#6e4610",
        brightBlue: "#145270",
        brightMagenta: "#5e2e50",
        brightCyan: "#7a1520",
        brightWhite: INK,
    },
    tui: {
        surface: PAPER,
        border: TWINE,
        userChat: GOLD,
        userChatLabel: GOLD,
        selectionBackground: RIBBON,
        selectionForeground: PAPER,
        activeHighlightBackground: RIBBON,
        activeHighlightForeground: PAPER,
        promptCursorBackground: RIBBON,
        promptCursorForeground: PAPER,
    },
});

export default parcelTheme;
