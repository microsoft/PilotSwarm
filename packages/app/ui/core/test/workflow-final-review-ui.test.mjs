/**
 * Final cross-family review of Workflow Simplified stage 2, UI lens (FUI-F1, FUI-F2), as the stylesheet says it:
 * - FUI-F1: the Workflow's phone touch targets (the draft actions, the replay and package links, the Workflow dialogs) use
 *   the merged phone query, so a phone held sideways (844 x 390, coarse pointer) keeps its 44 px targets too.
 * - FUI-F2: words in the danger colour use the Workflow's danger-text colour, chosen per theme to read 4.5:1 on the tab and
 *   its panel (gruvbox-dark and ms-dos read 2.5:1 to 2.7:1 with the theme's own danger colour); in win95 every code box of
 *   the tab is a white well (a result, a whole value, the variables), as the script's and samples' are, which the theme
 *   test measures its code colours on.
 * The rendered measure is in the browser specs: "FUI-F1" (workflow-tab.spec.mjs) and "OF-S2-8 contrast"
 * (workflow-chat-definitions.spec.mjs).
 *
 * Run: node --test ui/core/test/workflow-final-review-ui.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { contrastRatio, getTheme, themeCodeColors, themeWorkflowColors } from "../src/themes/index.js";

const css = fs.readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");
const PHONE = "@media (max-width: 600px), (orientation: landscape) and (max-height: 500px) and (max-width: 1000px) and (pointer: coarse) {";
const mediaOf = (selector) => {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, `${selector} is in the stylesheet`);
    const open = css.lastIndexOf("@media", at);
    return css.slice(open, css.indexOf("\n", open));
};

test("FUI-F1: the Workflow's phone touch targets use the merged phone query, a phone held sideways included", () => {
    for (const selector of ["  .ps-wf-unstarted .ps-link-button,", "  .ps-wf-replay-range { min-height: 44px; }", "  .ps-wf-dialog button,"]) {
        assert.equal(mediaOf(selector), PHONE.replace(/ \{$/, " {"), selector);
    }
});

test("FUI-F2: danger words use the Workflow's danger-text colour, which reads 4.5:1 where the theme's own did not", () => {
    for (const rule of [".ps-wf-last-test.is-failed", ".ps-wf-list-reason", ".ps-wf-result.is-error pre", '.ps-wf-alog-row[data-level="error"]',
        '.ps-wf-log li[data-level="error"]']) {
        const line = css.split("\n").find(text => text.startsWith(`${rule} {`));
        assert.ok(line, rule);
        assert.match(line, /color: var\(--ps-wf-danger-text, var\(--ps-danger\)\);/, rule);
    }
    // DEV run of 297824f4: on the graph too, a failed card's edge, a failed or blocked box's edge and counts, and a join's rule.
    for (const rule of [".ps-workflow-node.is-failed { border-color: var(--ps-wf-danger-text, var(--ps-danger)); }",
        ".ps-workflow-group.is-blocked, .ps-workflow-group.is-failed, .ps-workflow-group.is-timed_out { border-color: var(--ps-wf-danger-text, var(--ps-danger)); }",
        ".ps-workflow-join.is-timed_out .ps-workflow-join-rule { color: var(--ps-wf-danger-text, var(--ps-danger)); }",
        ".ps-workflow-group.is-blocked .ps-workflow-group-counts { color: var(--ps-wf-danger-text, var(--ps-danger)); }",
        ".ps-wf-state.is-failed { --ps-wf-tone: var(--ps-wf-danger-text, var(--ps-danger)); }",
        '.ps-workflow-input[aria-invalid="true"] { border-color: var(--ps-wf-danger-text, var(--ps-danger)); }',
        ".ps-workflow-field-error { color: var(--ps-wf-danger-text, var(--ps-danger));"]) {
        assert.ok(css.includes(rule), rule);
    }
    // No other rule of the Workflow viewer uses the theme's own danger colour bare (the toolbar's error badge is a filled
    // count, its digits drawn on it: not a part on the viewer's ground).
    const bare = [];
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const [, selector, body] = match;
        if (/ps-wf|ps-workflow/.test(selector) && /(?<!, )var\(--ps-danger\)/.test(body)) bare.push(selector.trim().split("\n").at(-1));
    }
    assert.deepEqual(bare, ['.ps-workflow-tool-badge[data-level="error"]']);
    for (const id of ["gruvbox-dark", "ms-dos"]) {
        const theme = getTheme(id);
        const danger = themeWorkflowColors(theme)["danger-text"];
        for (const ground of [theme.tui.background, theme.tui.surface, theme.page.workflowGround ?? theme.tui.background]) {
            assert.ok(contrastRatio(danger, ground) >= 4.5, `${id}: danger-text on ${ground}`);
            assert.ok(contrastRatio(danger, ground) >= 3, `${id}: a failed card's edge on ${ground}`);
            assert.ok(contrastRatio(theme.tui.red, ground) < 4.5 || danger === theme.tui.red, `${id}: its own red on ${ground} was the defect`);
        }
    }
});

test("FUI-F2 win95: every code box of the Workflow tab is a white well, so its code colours read 4.5:1", () => {
    assert.ok(css.includes(':root[data-ps-theme="win95"] .ps-wf-tab pre.ps-wf-code,'));
    assert.ok(css.includes(':root[data-ps-theme="win95"] .ps-wf-tab code.ps-wf-code-inline { background: #ffffff;'));
    assert.ok(!css.includes(":root[data-ps-theme=\"win95\"] .ps-wf-tab .ps-wf-more-body > pre.ps-wf-code"), "not only the script's and samples' boxes");
    // The code colours are the ones the theme test measures on the white well.
    const theme = getTheme("win95");
    for (const [role, colour] of Object.entries(themeCodeColors(theme))) assert.ok(contrastRatio(colour, "#ffffff") >= 4.5, `${role} on white`);
});
