/**
 * UX round UX2D-F7: a form control's edge (the Workflow tab's edit boxes, pickers and YAML box) is seen in every theme:
 * 3:1 against the theme's background and its panel. Before, the controls drew a 60% mix of the theme's hairline: 1.19:1
 * in Workspace Dark.
 *
 * Run: node --test ui/core/test/theme-control-border.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CONTROL_BORDER_MIN_CONTRAST, contrastRatio, getTheme, listThemes, themeControlBorder } from "../src/index.js";

const hex = value => /^#[0-9a-f]{3}([0-9a-f]{3})?$/iu.test(String(value || ""));

test("every theme's control border is 3:1 against its background and its panel", () => {
    assert.equal(CONTROL_BORDER_MIN_CONTRAST, 3);
    for (const theme of listThemes()) {
        const border = themeControlBorder(theme);
        for (const ground of [theme.tui.background, theme.tui.surface].filter(hex)) {
            const ratio = contrastRatio(border, ground);
            assert.ok(ratio >= 3, `${theme.id}: ${border} on ${ground} is ${ratio?.toFixed(2)}:1`);
        }
    }
});

test("Workspace Dark: its hairline (1.4:1) is moved toward its text until it reaches 3:1; a border that reaches it is kept", () => {
    const dark = getTheme("workspace-dark");
    assert.ok(contrastRatio(dark.tui.border, dark.tui.background) < 3);
    const border = themeControlBorder(dark);
    assert.notEqual(border, dark.tui.border);
    assert.ok(contrastRatio(border, dark.tui.background) >= 3 && contrastRatio(border, dark.tui.surface) >= 3);
    const mono = getTheme("high-contrast-mono");
    assert.equal(themeControlBorder(mono), mono.tui.border);
    assert.equal(themeControlBorder({ tui: { border: "rgba(1,2,3,0.5)", foreground: "#fff", background: "#000" } }), "rgba(1,2,3,0.5)");
});

test("the portal publishes it, and the Workflow tab's controls draw their edge with it", () => {
    const webApp = fs.readFileSync(new URL("../../react/src/web-app.js", import.meta.url), "utf8");
    assert.match(webApp, /root\.style\.setProperty\("--ps-control-border", themeControlBorder\(theme\)/);
    const css = fs.readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");
    const rule = selector => css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));
    assert.match(rule(".ps-workflow-input"), /border: 1px solid var\(--ps-control-border, var\(--ps-border\)\);/);
    assert.match(rule(".ps-workflow-yaml"), /border: 1px solid var\(--ps-control-border, var\(--ps-border\)\);/);
    assert.doesNotMatch(rule(".ps-workflow-input"), /color-mix\(in srgb, var\(--ps-border\) 60%/);
});
