/**
 * OF-S2-8 (owner, 2026-11-07T23:14Z), part C: "see the wf viewer in all the themes and make sure proper contrasting
 * happens. e.g. the win95 theme it is too grayed out." The Workflow viewer's colours are each theme's own, chosen to be
 * seen on what they are drawn on (themeWorkflowColors), and the stylesheet draws with them. Before this, in the themes'
 * own tokens: win95's node-kind icons read 1.0:1 to 1.3:1 on their wells, its card edges 2.2:1, its Start 2.8:1 and its
 * code 1.9:1 on the teal; GitHub Light's icons 1.5:1 to 2.1:1 and its card edges 1.4:1; Workspace Dark's card edges
 * 1.4:1; gruvbox's and ms-dos's danger text 2.7:1; a node not reached (55% opacity) 3.2:1 to 4.4:1 in eight themes.
 * The rendered measure in every theme is the browser spec "OF-S2-8 contrast".
 *
 * Run: node --test ui/core/test/theme-workflow-colors.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { contrastRatio, listThemes, getTheme, themeCodeColors, themeWorkflowColors, WORKFLOW_COLOR_NAMES, WORKFLOW_ICON_COLORS } from "../src/themes/index.js";

const hex = value => {
    const text = String(value).trim();
    return /^#[0-9a-f]{3}$/iu.test(text) ? `#${text.slice(1).split("").map(c => c + c).join("")}`.toLowerCase() : text.toLowerCase();
};
const mix = (from, to, share) => `#${[1, 3, 5].map(at => Math.round(parseInt(hex(from).slice(at, at + 2), 16) * (1 - share)
    + parseInt(hex(to).slice(at, at + 2), 16) * share).toString(16).padStart(2, "0")).join("")}`;

/** Every theme's viewer, as the stylesheet draws it with these colours: [what, colour, ground, target]. */
function drawn(theme) {
    const tui = theme.tui;
    const w = themeWorkflowColors(theme);
    const ground = hex(theme.page.workflowGround ?? tui.background);
    const card = mix(tui.surface, tui.foreground, 0.06);
    const rows = [
        ["card edge on the canvas", w["node-border"], ground, 3],
        ["node name on its card", tui.foreground, card, 4.5],
        ["node type line on its card", w.meta, card, 4.5],
        ["edge line on the canvas", w.edge, ground, 3],
        ["edge label on its label", w["edge-text"], tui.surface, 4.5],
        ["error edge label on its label", w["danger-text"], tui.surface, 4.5],
        ["selected card edge on the canvas", w.selected, ground, 3],
        // Owner 2026-11-09 (the timeline): the lit trail and the current step's ring at full strength, and a name on the current
        // step's fill (the lit colour at 20% over the card).
        ["lit trail and ring on the canvas", w.lit, ground, 3],
        ["node name on the current step's fill", tui.foreground, mix(card, w.lit, 0.2), 4.5],
        ["Start on the canvas", w.start, ground, 4.5],
        ["not valid on the tab", w["danger-text"], ground, 4.5],
        ["a node not reached: its name", w["dim-text"], card, 4.5],
        ["a node not reached: its icon", w["dim-icon"], card, 3],
        ["the line under the pickers", tui.gray, ground, 4.5],
        ["a picker's label", tui.foreground, ground, 4.5],
    ];
    for (const kind of ["script", "agent", "wait", "request", "message", "other"]) {
        rows.push([`icon ${kind} on its well`, w[`icon-${kind}`], mix(card, w[`icon-${kind}`], 0.16), 3]);
    }
    for (const mark of ["done", "running", "failed", "canceled"]) rows.push([`mark ${mark} on its card`, w[`mark-${mark}`], card, 3]);
    for (const end of ["succeeded", "blocked", "failed", "cancelled"]) rows.push([`end ${end} ring on the canvas`, w[`end-${end}`], ground, 3]);
    // Code (YAML, JSON, scripts) on its box: the theme's background, a white well in win95.
    const box = theme.id === "win95" ? "#ffffff" : hex(tui.background);
    for (const [role, colour] of Object.entries(themeCodeColors(theme))) {
        if (["keyword", "string", "number", "function", "type", "property", "variable", "comment", "invalid"].includes(role)) rows.push([`code ${role}`, colour, box, 4.5]);
    }
    return rows;
}

test("in every theme the viewer's text reads 4.5:1 and its parts 3:1 on what they are drawn on", () => {
    const low = [];
    for (const theme of listThemes()) {
        for (const [what, colour, ground, min] of drawn(theme)) {
            const ratio = contrastRatio(colour, ground);
            if (!(ratio >= min)) low.push(`${theme.id}: ${what} ${colour} on ${ground} ${ratio?.toFixed(2)} < ${min}`);
        }
    }
    assert.deepEqual(low, []);
    assert.ok(listThemes().length >= 20);
});

test("every theme gives every colour; a colour already seen is kept (the dark themes' icons are as they were)", () => {
    for (const theme of listThemes()) {
        const colours = themeWorkflowColors(theme);
        assert.deepEqual(Object.keys(colours).sort(), [...WORKFLOW_COLOR_NAMES].sort(), theme.id);
        for (const [name, colour] of Object.entries(colours)) assert.match(colour, /^#[0-9a-f]{6}$/, `${theme.id} ${name}`);
    }
    const dark = themeWorkflowColors(getTheme("workspace-dark"));
    assert.deepEqual([dark["icon-script"], dark["icon-agent"], dark["icon-wait"], dark["icon-request"], dark["icon-message"]],
        [WORKFLOW_ICON_COLORS.script, WORKFLOW_ICON_COLORS.agent, WORKFLOW_ICON_COLORS.wait, WORKFLOW_ICON_COLORS.request, WORKFLOW_ICON_COLORS.message]);
    assert.equal(dark.edge, getTheme("workspace-dark").tui.gray);
});

test("win95 is no longer grey on grey: its window face is the ground, its icons are its own VGA colours, its edges dark", () => {
    const theme = getTheme("win95");
    assert.equal(theme.page.workflowGround, "#c0c0c0");
    const w = themeWorkflowColors(theme);
    assert.equal(w.ground, "#c0c0c0");
    assert.deepEqual([w["icon-script"], w["icon-agent"], w["icon-request"], w.selected], ["#000080", "#800080", "#800000", "#000080"]);
    assert.ok(contrastRatio(w["node-border"], "#c0c0c0") >= 3);
    assert.ok(contrastRatio(w.edge, "#c0c0c0") >= 3);
    // Before: the stylesheet's own icon colours and the theme's border on the face.
    assert.ok(contrastRatio("#60a5fa", mix("#b5b5b5", "#60a5fa", 0.16)) < 1.5);
    assert.ok(contrastRatio(theme.tui.border, "#c0c0c0") < 3);
});

test("the stylesheet draws with them, and the portal sets them per theme", () => {
    const css = fs.readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");
    for (const needle of [
        "background: var(--ps-wf-ground, var(--ps-background));",
        "border: 1.5px solid var(--ps-wf-node-border, var(--ps-border));",
        ".ps-workflow-edge-path { fill: none; stroke: var(--ps-wf-edge, var(--ps-muted)); stroke-width: 1.5; }",
        ".ps-workflow-edge-label text { fill: var(--ps-wf-edge-text, var(--ps-muted)); font-size: 10px; }",
        "--xy-edge-stroke: var(--ps-wf-edge, var(--ps-muted));",
        ".ps-workflow-node.is-kind-script .ps-workflow-node-icon { color: var(--ps-wf-icon-script, #60a5fa); }",
        ".ps-workflow-node.is-not-reached .ps-workflow-node-name { color: var(--ps-wf-dim-text, var(--ps-muted)); }",
        "--ps-end: var(--ps-wf-end-succeeded, var(--ps-success));",
        "border: 2px solid var(--ps-wf-start, var(--ps-success));",
        ".ps-wf-info-error { color: var(--ps-wf-danger-text, var(--ps-danger)); }",
        ':root[data-ps-theme="win95"] .ps-wf-tab .ps-workflow-yaml,',
    ]) assert.ok(css.includes(needle), needle);
    assert.ok(!css.includes(".ps-workflow-node.is-not-reached { opacity: 0.55; }"), "no opacity on a node not reached");
    assert.ok(!/\.ps-workflow-node\.is-kind-[a-z]+ \.ps-workflow-node-icon \{ color: #/.test(css), "no fixed icon colour");
    const webApp = fs.readFileSync(new URL("../../react/src/web-app.js", import.meta.url), "utf8");
    assert.match(webApp, /const workflow = themeWorkflowColors\(theme\);\n\s*for \(const name of WORKFLOW_COLOR_NAMES\) \{\n\s*if \(workflow\[name\]\) root\.style\.setProperty\(`--ps-wf-\$\{name\}`, workflow\[name\]\);/);
});
