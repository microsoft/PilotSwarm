import { createTheme, THEME_GROUP_OTHER } from "./helpers.js";

// Hearth. A pine room with one candle, not a red-and-green page.
//
// Failed is already red and Done is already green. Painting the ground in
// either of those makes the status dots disappear. Gold is the accent, the
// selection, and the send button. Holly is only the Done rail.

const PINE = "#0b2419";
const PAPER = "#f3efe4";
const GOLD = "#ffa62e";
const HOLLY = "#7ee05a";
const EMBER = "#ff5f56";
const ROSE = "#ff9cbc";
const BRASS = "#8a6b2e";

const hearthTheme = createTheme({
    id: "hearth",
    label: "Hearth",
    description: "Pine ground and candle gold. Holly is only Done.",
    group: THEME_GROUP_OTHER,
    icon: {
        viewBox: "0 0 32 32",
        paths: [
            { d: "M0 0h32v32H0z", fill: PINE },
            { d: "M3 7h26v4H3z", fill: BRASS },
            { d: "M5 11h4v15H5z", fill: BRASS },
            { d: "M23 11h4v15h-4z", fill: BRASS },
            { d: "M3 24h26v4H3z", fill: BRASS },
            { d: "M16 11c4 4 6 7 6 9.5a6 6 0 0 1-12 0C10 18 12 15 16 11z", fill: GOLD },
            { d: "M16 16c1.6 1.6 2.4 2.8 2.4 3.8a2.4 2.4 0 0 1-4.8 0c0-1 .8-2.2 2.4-3.8z", fill: ROSE },
        ],
    },
    page: {
        background: PINE,
        foreground: PAPER,
        overlayBackground: "#143022",
        overlayForeground: PAPER,
        hintColor: "#b7c4b0",
        modalBackdrop: "rgba(11, 36, 25, 0.84)",
        modalBackground: "#143022",
        modalBorder: BRASS,
        modalForeground: PAPER,
        modalMuted: "#b7c4b0",
        modalSelectedBackground: GOLD,
        modalSelectedBorder: "#ffd08a",
        modalSelectedForeground: PINE,
    },
    terminal: {
        background: PINE,
        foreground: PAPER,
        cursor: GOLD,
        cursorAccent: PINE,
        selectionBackground: GOLD,
        black: PINE,
        red: EMBER,
        green: HOLLY,
        yellow: "#f2e86d",
        blue: "#7ec8c0",
        magenta: ROSE,
        cyan: GOLD,
        white: PAPER,
        brightBlack: "#b7c4b0",
        brightRed: "#ffb0a4",
        brightGreen: "#b6ee9a",
        brightYellow: "#f8f3a8",
        brightBlue: "#b4e2dc",
        brightMagenta: "#ffc4d8",
        brightCyan: "#ffd08a",
        brightWhite: "#ffffff",
    },
    tui: {
        border: BRASS,
        userChat: ROSE,
        userChatLabel: ROSE,
        selectionBackground: GOLD,
        selectionForeground: PINE,
        activeHighlightBackground: GOLD,
        activeHighlightForeground: PINE,
        promptCursorBackground: GOLD,
        promptCursorForeground: PINE,
    },
});

export default hearthTheme;
