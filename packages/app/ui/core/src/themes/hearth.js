import { createTheme, THEME_GROUP_OTHER } from "./helpers.js";

// Hearth. A dark walnut room lit by one fire in the top-left corner.
//
// The fire is the theme. The mark in the header is the fireplace, its light
// spreads across the banner and the page from that corner, and everything
// else stays dark enough to work in. Candle amber is the accent, the
// selection and the send button.
//
// Red and green keep their status meaning. The ground is brown, not red or
// green, so Failed and Done still read. Holly green is only Done.
//
// The fire can also be heard: `sound` names an ambient that the portal plays
// only after the person turns theme sounds on.

const WALNUT = "#1c120c";
const PANEL = "#211610";
const RAISED = "#251810";
const CREAM = "#f6ead8";
const ASH = "#cdb79a";
const CANDLE = "#ffa62e";
const COPPER = "#9a6434";
const EMBER = "#ff6b5b";
const HOLLY = "#8fd36a";
const ROSE = "#ff9cbc";

// The fireplace, after the owner's reference: an arched opening, a flame with
// a lit core, and two crossed logs, on a warm cream tile so it reads at 20px.
// `motion` names a small, CSS-driven movement for that shape. It is data, not
// markup; the portal maps it to a class and stops it when motion is reduced.
const hearthTheme = createTheme({
    id: "hearth",
    label: "Hearth",
    description: "A dark walnut room lit by the fire in the corner.",
    group: THEME_GROUP_OTHER,
    icon: {
        viewBox: "0 0 64 64",
        paths: [
            { d: "M0 0h64v64H0z", fill: CREAM },
            { d: "M15 42a17 17 0 1 0 34 0a17 17 0 1 0-34 0z", fill: "#ffd9a8", motion: "glow" },
            { d: "M7 64V30a25 25 0 0 1 50 0v34h-8V30a17 17 0 0 0-34 0v34z", fill: "#2a1a10" },
            { d: "M33 13c3 9 12 13 12 25c0 8-5.5 12.5-12 12.5S20 46 20 39.5c0-7.5 5.5-10 6.5-16c2 3 3 6 5.5 7.5c1-5.5 1-11.5 1-18z", fill: "#e35a12", motion: "flame" },
            { d: "M33 30c2.5 4.5 6 6.5 6 12c0 4.5-3 7-6 7s-6-2.5-6-6c0-3.5 3-5 4-8c1 1.5 2 .5 2-5z", fill: "#ffb648", motion: "flame-core" },
            { d: "M17.27 53.2L45.04 59.61A3.75 3.75 0 0 0 46.73 52.3L18.96 45.89A3.75 3.75 0 0 0 17.27 53.2Z", fill: "#3a2416" },
            { d: "M18.96 59.61L46.73 53.2A3.75 3.75 0 0 0 45.04 45.89L17.27 52.3A3.75 3.75 0 0 0 18.96 59.61Z", fill: "#3a2416" },
        ],
    },
    // Plays continuously while theme sounds are on: mostly crackle, with a
    // quiet low bed. It fades in when it starts and out when it stops.
    sound: {
        id: "fire",
        fadeInSeconds: 3,
        fadeOutSeconds: 2,
    },
    page: {
        background: WALNUT,
        foreground: CREAM,
        overlayBackground: RAISED,
        overlayForeground: CREAM,
        hintColor: ASH,
        modalBackdrop: "rgba(28, 18, 12, 0.84)",
        modalBackground: RAISED,
        modalBorder: COPPER,
        modalForeground: CREAM,
        modalMuted: ASH,
        modalSelectedBackground: CANDLE,
        modalSelectedBorder: "#ffd08a",
        modalSelectedForeground: WALNUT,
    },
    terminal: {
        background: WALNUT,
        foreground: CREAM,
        cursor: CANDLE,
        cursorAccent: WALNUT,
        selectionBackground: CANDLE,
        black: WALNUT,
        red: EMBER,
        green: HOLLY,
        yellow: "#f2e86d",
        blue: "#8cc7d6",
        magenta: ROSE,
        cyan: CANDLE,
        white: CREAM,
        brightBlack: ASH,
        brightRed: "#ffaa9e",
        brightGreen: "#b8e89a",
        brightYellow: "#f8f3a8",
        brightBlue: "#bfe2ea",
        brightMagenta: "#ffc4d8",
        brightCyan: "#ffd08a",
        brightWhite: "#ffffff",
    },
    tui: {
        surface: PANEL,
        border: COPPER,
        userChat: ROSE,
        userChatLabel: ROSE,
        selectionBackground: CANDLE,
        selectionForeground: WALNUT,
        activeHighlightBackground: CANDLE,
        activeHighlightForeground: WALNUT,
        promptCursorBackground: CANDLE,
        promptCursorForeground: WALNUT,
    },
});

export default hearthTheme;
