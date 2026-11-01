import { createTheme, THEME_GROUP_OTHER } from "./helpers.js";

// String lights. The ground stays night-black so a long transcript is still
// readable. The cheer is the row of dots: cranberry, gold, holly, ice.
// You is ice, so it is not a second red.

const NIGHT = "#0c1226";
const PAPER = "#f7f1e6";
const GOLD = "#ffcb3d";
const CRANBERRY = "#ff5468";
const HOLLY = "#4fdc85";
const ICE = "#8fd4e8";
const WIRE = "#3e7a52";
const BULB = "#ff9b42";
const PINK = "#ff86c8";

const stringLightsTheme = createTheme({
    id: "string-lights",
    label: "String lights",
    description: "Night ground. The session dots are the lights.",
    group: THEME_GROUP_OTHER,
    icon: {
        viewBox: "0 0 32 32",
        paths: [
            { d: "M0 0h32v32H0z", fill: NIGHT },
            { d: "M5 16a3 3 0 1 0 6 0a3 3 0 1 0-6 0z", fill: CRANBERRY },
            { d: "M13 16a3 3 0 1 0 6 0a3 3 0 1 0-6 0z", fill: GOLD },
            { d: "M21 16a3 3 0 1 0 6 0a3 3 0 1 0-6 0z", fill: HOLLY },
        ],
    },
    page: {
        background: NIGHT,
        foreground: PAPER,
        overlayBackground: "#151c33",
        overlayForeground: PAPER,
        hintColor: "#c4b8a8",
        modalBackdrop: "rgba(12, 18, 38, 0.84)",
        modalBackground: "#151c33",
        modalBorder: WIRE,
        modalForeground: PAPER,
        modalMuted: "#c4b8a8",
        modalSelectedBackground: GOLD,
        modalSelectedBorder: "#ffe08a",
        modalSelectedForeground: NIGHT,
    },
    terminal: {
        background: NIGHT,
        foreground: PAPER,
        cursor: GOLD,
        cursorAccent: NIGHT,
        selectionBackground: GOLD,
        black: NIGHT,
        red: CRANBERRY,
        green: HOLLY,
        yellow: BULB,
        blue: ICE,
        magenta: PINK,
        cyan: GOLD,
        white: PAPER,
        brightBlack: "#c4b8a8",
        brightRed: "#ff9aa8",
        brightGreen: "#8aebae",
        brightYellow: "#ffc48a",
        brightBlue: "#c4eaf4",
        brightMagenta: "#ffb0dc",
        brightCyan: "#ffe08a",
        brightWhite: "#ffffff",
    },
    tui: {
        border: WIRE,
        userChat: ICE,
        userChatLabel: ICE,
        selectionBackground: GOLD,
        selectionForeground: NIGHT,
        activeHighlightBackground: GOLD,
        activeHighlightForeground: NIGHT,
        promptCursorBackground: GOLD,
        promptCursorForeground: NIGHT,
    },
});

export default stringLightsTheme;
