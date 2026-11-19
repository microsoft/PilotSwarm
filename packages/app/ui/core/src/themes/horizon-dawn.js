import { createTheme, THEME_GROUP_OTHER } from "./helpers.js";

// Horizon Dawn. Celebrates Azure HorizonDB becoming generally available on
// 17 November 2026: a pre-dawn Azure sky full of stars, Orion over a range of
// mountains, and the HorizonDB cylinder mark holding a light that slowly
// brightens and dims.
//
// The scenery (star field, Orion, mountains, the animated mark, the banner and
// the Sora type) is portal CSS scoped to [data-ps-theme="horizon-dawn"]; this
// file carries the palette and a still mark for the picker and the terminal.

const NIGHT = "#071125";
const PANEL = "#101d31";
const RAISED = "#13243b";
const LIGHT = "#eaf3ff";
const MUTED = "#a4b8d1";
const BORDER = "#304b67";
const AZURE = "#3d8fe0";
const CYAN = "#5cc8f2";
const GREEN = "#84d6ac";
const AMBER = "#f1c879";
const ROSE = "#ff9caa";

const horizonDawnTheme = createTheme({
    id: "horizon-dawn",
    label: "Horizon Dawn",
    description: "Azure HorizonDB, generally available: Orion over a pre-dawn horizon.",
    group: THEME_GROUP_OTHER,
    // Code in JetBrains Mono unless the person picks another code font.
    codeFont: "jetbrains",
    // The HorizonDB mark: a database cylinder with a white chevron and a
    // sky-cyan peak. The header shows an animated version from the portal CSS.
    icon: {
        viewBox: "0 0 112 124",
        paths: [
            { d: "M16 20V102A40 13 0 0 0 96 102V20Z", fill: "#2b6fd1" },
            { d: "M56 7A40 13 0 1 0 56 33A40 13 0 1 0 56 7Z", fill: "#3478d6" },
            { d: "M16 90L56 59L96 90V79L56 48L16 79Z", fill: "#ffffff" },
            { d: "M24 109.8L52.6 85.4Q56 82.6 59.4 85.4L88 109.8A40 13 0 0 1 24 109.8Z", fill: "#8fe1fb" },
        ],
    },
    // A pre-dawn sky: a soft, warm chord that swells and changes every half
    // minute or so, with faint high chimes now and then, like stars. `cues`
    // adds short sounds for actions: a soft tick on buttons, a rising pair
    // when a message is sent, and a low chime when the agent finishes.
    sound: {
        id: "dawn",
        fadeInSeconds: 4,
        fadeOutSeconds: 3,
        cues: true,
    },
    page: {
        background: NIGHT,
        foreground: LIGHT,
        overlayBackground: RAISED,
        overlayForeground: LIGHT,
        hintColor: MUTED,
        modalBackdrop: "rgba(7, 17, 37, 0.86)",
        modalBackground: RAISED,
        modalBorder: "#47617e",
        modalForeground: LIGHT,
        modalMuted: MUTED,
        modalSelectedBackground: "#1c4865",
        modalSelectedBorder: CYAN,
        modalSelectedForeground: "#f1fbff",
    },
    terminal: {
        background: NIGHT,
        foreground: LIGHT,
        cursor: CYAN,
        cursorAccent: NIGHT,
        selectionBackground: "#153d59",
        black: NIGHT,
        red: ROSE,
        green: GREEN,
        yellow: AMBER,
        blue: AZURE,
        magenta: "#c7b5ff",
        cyan: CYAN,
        white: LIGHT,
        brightBlack: MUTED,
        brightRed: "#ffc2cb",
        brightGreen: "#b6ebcd",
        brightYellow: "#f8e0ac",
        brightBlue: "#9ac9ff",
        brightMagenta: "#ddd2ff",
        brightCyan: "#8fe1fb",
        brightWhite: "#ffffff",
    },
    tui: {
        surface: PANEL,
        border: BORDER,
        selectionBackground: "#153d59",
        selectionForeground: "#f1fbff",
        activeHighlightBackground: "#173450",
        activeHighlightForeground: "#f1fbff",
        promptCursorBackground: CYAN,
        promptCursorForeground: NIGHT,
    },
});

export default horizonDawnTheme;
