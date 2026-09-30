// Text colours for code and files (the Workspace tab's editor and markdown
// preview): each theme's own palette, each colour readable on the theme's
// panel. The portal publishes them as --ps-code-* (applyDocumentTheme).
//
// WHY THIS EXISTS: the editor first used two fixed palettes, one for dark
// panels and one for light. A theme whose panel is neither (Win95's grey,
// MS-DOS's black with CGA colours) got colours chosen for someone else's
// background.
import test from "node:test";
import assert from "node:assert/strict";

import {
    CODE_COLOR_MIN_CONTRAST,
    CODE_COLOR_ROLES,
    contrastRatio,
    listThemes,
    themeCodeColors,
} from "../src/themes/index.js";

test("every code colour is readable on its theme's panel, in every theme", () => {
    const unreadable = [];
    let measured = 0;
    for (const theme of listThemes()) {
        const colours = themeCodeColors(theme);
        assert.deepEqual(Object.keys(colours).sort(), [...CODE_COLOR_ROLES].sort(), theme.id);
        for (const [role, colour] of Object.entries(colours)) {
            const ratio = contrastRatio(colour, theme.tui.surface);
            measured += 1;
            if (ratio === null || ratio < CODE_COLOR_MIN_CONTRAST) unreadable.push(`${theme.id} ${role}: ${colour} on ${theme.tui.surface} = ${ratio?.toFixed(2)}:1`);
        }
    }
    assert.ok(measured >= 20 * CODE_COLOR_ROLES.length, `measured only ${measured}`);
    assert.deepEqual(unreadable, [], `unreadable code colours:\n  ${unreadable.join("\n  ")}`);
});

test("a colour too faint for the panel gives way to the next, and in the end to the text colour", () => {
    const theme = {
        page: { background: "#000000" },
        terminal: { brightGreen: "#55ff55", brightBlack: "#111111" },
        tui: { surface: "#000000", foreground: "#eeeeee", green: "#003300", magenta: "#ff77ff", gray: "#222222" },
    };
    const colours = themeCodeColors(theme);
    assert.equal(colours.string, "#55ff55", "dark green is too faint on black: the bright green");
    assert.equal(colours.keyword, "#ff77ff");
    assert.equal(colours.comment, "#eeeeee", "no readable grey: the text colour");
});

test("themes keep their own look: most roles are not the plain text colour", () => {
    // A picker that fell back everywhere would pass the readability test and
    // still turn every editor monochrome.
    for (const theme of listThemes()) {
        const colours = themeCodeColors(theme);
        const own = Object.values(colours).filter((colour) => colour !== theme.tui.foreground).length;
        assert.ok(own >= 6, `${theme.id}: only ${own} of ${CODE_COLOR_ROLES.length} roles use the theme's palette`);
    }
});

test("contrast is measured, never guessed", () => {
    assert.equal(Math.round(contrastRatio("#000", "#ffffff")), 21);
    assert.equal(contrastRatio("#777777", "#777777"), 1);
    assert.equal(contrastRatio("rgba(0, 0, 0, 0.5)", "#ffffff"), null);
    assert.equal(contrastRatio("teal", "#ffffff"), null);
});
