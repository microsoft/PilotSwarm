/**
 * The code font: a choice in Appearance between the theme's own default,
 * JetBrains Mono and the system monospace stack. Horizon Dawn defaults to
 * JetBrains Mono; every other theme keeps the system stack it always had.
 *
 * Run: node --test test/code-font.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { appReducer } from "../src/reducer.js";
import { createInitialState } from "../src/state.js";
import { getTheme, listThemes } from "../src/themes/index.js";
import { CODE_FONT_CHOICES, normalizeCodeFont, resolveCodeFont } from "../src/code-font.js";

test("the theme's default applies until the person picks a font", () => {
    assert.equal(resolveCodeFont("theme", getTheme("horizon-dawn")), "jetbrains");
    assert.equal(resolveCodeFont(undefined, getTheme("horizon-dawn")), "jetbrains");
    for (const theme of listThemes().filter((t) => t.id !== "horizon-dawn")) {
        assert.equal(resolveCodeFont("theme", theme), "system", theme.id);
    }
});

test("a picked font wins over the theme's default, both ways", () => {
    assert.equal(resolveCodeFont("system", getTheme("horizon-dawn")), "system");
    assert.equal(resolveCodeFont("jetbrains", getTheme("hearth")), "jetbrains");
});

test("only the three choices are kept", () => {
    assert.deepEqual([...CODE_FONT_CHOICES], ["theme", "jetbrains", "system"]);
    for (const bad of ["fira", "", null, 3, {}]) assert.equal(normalizeCodeFont(bad), null);
    assert.equal(resolveCodeFont("fira", getTheme("hearth")), "system");
});

test("the choice starts at the theme default, is set by Appearance, and comes back from the profile", () => {
    let state = createInitialState({ mode: "remote" });
    assert.equal(state.ui.codeFont, "theme");
    state = appReducer(state, { type: "ui/codeFont", codeFont: "jetbrains" });
    assert.equal(state.ui.codeFont, "jetbrains");
    const same = appReducer(state, { type: "ui/codeFont", codeFont: "nonsense" });
    assert.equal(same, state, "an unknown value changes nothing");

    let loaded = createInitialState({ mode: "remote" });
    loaded = appReducer(loaded, { type: "profileSettings/apply", settings: { codeFont: "system" } });
    assert.equal(loaded.ui.codeFont, "system");
    // A profile without the key leaves the current choice alone.
    loaded = appReducer(loaded, { type: "profileSettings/apply", settings: { themeId: "hearth" } });
    assert.equal(loaded.ui.codeFont, "system");
});
