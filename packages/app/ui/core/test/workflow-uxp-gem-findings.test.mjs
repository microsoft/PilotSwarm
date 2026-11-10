/**
 * UX lane findings UXP-GEM-02 to 06 (a phone in WebKit at 390 px, and every theme), as the stylesheet and the words say
 * them:
 * - UXP-GEM-04: on a phone the chat's YAML editor (ChatYamlEditor) caps its box at 55vh and keeps its bar at the top, as
 *   the draft editor does (UXFD-F10 named only the draft editor).
 * - UXP-GEM-05: the marks under the YAML box say what the diagnostics list says, the code only in their tooltip; the line
 *   over an invalid revision ends with one full stop.
 * - UXP-GEM-03: a phone's state chip with its time cuts only the end of its label ("leted ·… · 0:15" before).
 * - UXP-GEM-02: a failed Workflow's line on a phone does not widen the tab (it scrolled sideways in WebKit), and its focus
 *   ring is not cut.
 * - UXP-GEM-06: win95's pickers and YAML box have edges seen on the window face (3:1); the Workflow tab's muted words read
 *   4.5:1 in every theme (the figures under 4.5:1 in six themes were the node marks', which are 3:1 parts).
 *
 * Run: node --test ui/core/test/workflow-uxp-gem-findings.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { contrastRatio, getTheme, listThemes } from "../src/themes/index.js";
import { workflowDraftMarks } from "../src/workflow-commands.js";
import { WorkflowDiagnostics, WorkflowYamlBox } from "../../react/src/workflow-panels.js";
import { revisionLine } from "../../react/src/workflow-tab.js";

const h = React.createElement;
const css = fs.readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");
const source = file => fs.readFileSync(new URL(`../../react/src/${file}`, import.meta.url), "utf8");
// The stylesheet's rules without its comments: each rule's selectors (whitespace made single) and its declarations, a media
// block's rules included.
const RULES = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
    selectors: selectors.split(",").map(one => one.trim().replace(/\s+/g, " ")).filter(Boolean), body,
}));
/** What the rules that name `selector` declare, in the stylesheet's order (the later wins): { property: value }. */
function declared(selector) {
    const out = {};
    for (const rule of RULES.filter(one => one.selectors.includes(selector))) {
        for (const part of rule.body.split(";")) {
            const at = part.indexOf(":");
            if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
        }
    }
    return out;
}
const pick = (values, names) => Object.fromEntries(names.map(name => [name, values[name]]));
const words = html => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'");

test("UXP-GEM-04: on a phone the chat's YAML editor's box scrolls inside itself and its bar stays at the top, as the draft editor's", () => {
    // The chat's editor: its bar, then the YAML box, each a child of .ps-wf-chat-editor (the box is the first element the
    // YAML box component draws, not wrapped).
    const chat = source("workflow-chat-tab.js");
    assert.match(chat, /h\("div", \{ className: "ps-wf-chat-editor", "data-base-revision": draft\.base \},\n\s*h\("div", \{ className: "ps-wf-bar is-yaml" \},/);
    assert.match(chat, /\n\s*h\(WorkflowYamlBox, \{ value: draft\.text \?\? "", marks, changed: draft\.dirty,/);
    const drawn = renderToStaticMarkup(h("div", { className: "ps-wf-chat-editor" },
        h(WorkflowYamlBox, { value: "name: a\n", marks: { lines: [], unplaced: 0 }, changed: false, onChange: () => {} })));
    assert.match(drawn, /^<div class="ps-wf-chat-editor"><div class="ps-workflow-yaml">/);
    // The draft editor keeps its 55vh cap; the chat's editor fills its view instead (the next test).
    assert.deepEqual(pick(declared(".ps-wf-tab.is-phone .ps-workflow-draft-editor > .ps-workflow-yaml"), ["max-height", "overflow"]),
        { "max-height": "55vh", overflow: "auto" });
    assert.equal(declared(".ps-wf-tab.is-phone .ps-wf-chat-editor > .ps-workflow-yaml").overflow, "auto");
    for (const bar of [".ps-workflow-draft-editor > .ps-workflow-yaml-strip", ".ps-wf-chat-editor > .ps-wf-bar.is-yaml"]) {
        assert.deepEqual(pick(declared(`.ps-wf-tab.is-phone ${bar}`), ["position", "top", "z-index", "background"]),
            { position: "sticky", top: "0", "z-index": "2", background: "var(--ps-surface)" }, bar);
    }
    // Only a phone: no other rule caps the chat's box or holds its bar.
    const chatRules = RULES.filter(rule => rule.selectors.some(one => one.includes(".ps-wf-chat-editor")));
    assert.ok(chatRules.length >= 2 && chatRules.every(rule => rule.selectors.every(one => one.startsWith(".ps-wf-tab.is-phone "))),
        JSON.stringify(chatRules.map(rule => rule.selectors)));
});

const DIAGNOSTICS = [
    { severity: "error", code: "WORKFLOW_YAML_INVALID", path: "$", line: 9,
        message: "Duplicate key \"required\" at line 9 (first at line 8): a mapping may name each key once." },
    { severity: "warning", code: "WORKFLOW_INPUT_JSON_TEXT", path: "states.ask.input", line: 12, message: "This input is JSON text in quotes." },
];

// DEV at bfa03e9b (WebKit 390 px): the view's scroller (.ps-wf-yaml) is about 327 px under the tab's header lines, less than
// 55vh, so a capped box still ran under the bar. On a phone the chat's editor fills the scroller and the box takes the rest.
test("UXP-GEM-04: on a phone the chat's editor fills the YAML view; its bar and notes keep their height, the box takes the rest", () => {
    const chat = source("workflow-chat-tab.js");
    assert.match(chat, /mode === "yaml" \? h\("div", \{ className: "ps-wf-main ps-wf-yaml" \},\n\s*h\(ChatYamlPanel,/);
    assert.deepEqual(pick(declared(".ps-wf-yaml"), ["overflow", "flex-direction"]), { overflow: "auto", "flex-direction": "column" });
    assert.deepEqual(pick(declared(".ps-wf-tab.is-phone .ps-wf-yaml > .ps-wf-chat-editor"), ["display", "flex-direction", "min-height"]),
        { display: "flex", "flex-direction": "column", "min-height": "0" });
    assert.equal(declared(".ps-wf-tab.is-phone .ps-wf-chat-editor > :not(.ps-workflow-yaml):not(.ps-workflow-yaml-marks)").flex, "none");
    // No viewport cap (it was taller than the view); at least 8 lines of the box's own font (line-height 1.45) and its padding.
    assert.deepEqual(pick(declared(".ps-wf-tab.is-phone .ps-wf-chat-editor > .ps-workflow-yaml"), ["flex", "min-height", "max-height", "overflow"]),
        { flex: "1 1 auto", "min-height": "calc(8 * 1.45em + 6px)", "max-height": "none", overflow: "auto" });
    assert.equal(declared(".ps-workflow-yaml")["line-height"], "1.45");
    // The list of marks under the box shrinks and scrolls too (at most 8em).
    assert.deepEqual(pick(declared(".ps-workflow-yaml-marks"), ["flex", "max-height", "overflow"]), { flex: "0 1 auto", "max-height": "8em", overflow: "auto" });
});

// DEV at bfa03e9b (WebKit): a Workflow session's Definition picker is a plain select; WebKit drew its own white face under
// the theme's light words. The page draws it: no native appearance, the theme's ground and words (win95: its white well),
// and an arrow in the words' colour.
test("the plain Definition picker is drawn by the page in every browser: theme ground and words at 4.5:1, its arrow kept", () => {
    assert.match(source("workflow-tab.js"), /h\("select", \{ id, className: "ps-workflow-input ps-wf-picker-select", value,/);
    const selector = ".ps-wf-tab .ps-wf-picker select.ps-workflow-input.ps-wf-picker-select";
    const drawn = declared(selector);
    assert.deepEqual(pick(drawn, ["-webkit-appearance", "appearance", "background-repeat", "padding-right"]),
        { "-webkit-appearance": "none", appearance: "none", "background-repeat": "no-repeat", "padding-right": "24px" });
    assert.match(drawn["background-image"], /^linear-gradient\(45deg, transparent 50%, currentColor 50%\), linear-gradient\(135deg, currentColor 50%, transparent 50%\)$/);
    // Its ground and words: the field's (every theme), and win95's white well; the shorthand there does not clear the arrow,
    // which is more specific (4 classes and an element against 4 classes).
    assert.deepEqual(pick(declared(".ps-workflow-input"), ["background", "color"]), { background: "var(--ps-background)", color: "var(--ps-foreground)" });
    const win95 = declared(':root[data-ps-theme="win95"] .ps-wf-tab .ps-workflow-input');
    assert.deepEqual(pick(win95, ["background", "color"]), { background: "#ffffff", color: "var(--w95-dark)" });
    assert.ok(!("background" in drawn) && !("background-color" in drawn), "the theme's ground stays the field's");
    const ratios = { "workspace-dark": contrastRatio(getTheme("workspace-dark").tui.foreground, getTheme("workspace-dark").tui.background),
        win95: contrastRatio("#000000", "#ffffff") };
    for (const [id, ratio] of Object.entries(ratios)) assert.ok(ratio >= 4.5, `${id}: ${ratio}`);
    // Every other theme's field: its words on its ground (win95's field is the white well above).
    const low = listThemes().filter(theme => theme.id !== "win95" && !(contrastRatio(theme.tui.foreground, theme.tui.background) >= 4.5))
        .map(theme => theme.id);
    assert.deepEqual(low, []);
});

test("UXP-GEM-05: the marks under the YAML box say what the diagnostics list says; the code and path only in their tooltip", () => {
    const marks = workflowDraftMarks(DIAGNOSTICS);
    assert.deepEqual(marks.lines, [
        { line: 9, severity: "error", texts: ["Duplicate key \"required\" at line 9 (first at line 8): a mapping may name each key once."],
            codes: ["WORKFLOW_YAML_INVALID · $"] },
        { line: 12, severity: "warning", texts: ["Warning: This input is JSON text in quotes."], codes: ["WORKFLOW_INPUT_JSON_TEXT · states.ask.input"] },
    ]);
    const box = renderToStaticMarkup(h(WorkflowYamlBox, { value: "a: 1\n".repeat(12), marks, changed: false, onChange: () => {} }));
    const list = box.slice(box.indexOf("<ul"), box.indexOf("</ul>"));
    const items = [...list.matchAll(/<li data-mark="(\w+)">(.*?)<\/li>/g)].map(([, mark, item]) => ({ mark, item }));
    assert.equal(items.length, 2);
    assert.ok(!words(list).includes("WORKFLOW_"), words(list));
    // The diagnostics list's words for each, its "Line N: " being the mark's own Line N button.
    const listed = renderToStaticMarkup(h(WorkflowDiagnostics, { diagnostics: DIAGNOSTICS }));
    const said = [...listed.matchAll(/<li [^>]*title="([^"]*)"[^>]*>(.*?)<\/li>/g)].map(([, title, item]) => ({ title, text: words(item) }));
    for (const [at, { item }] of items.entries()) {
        const line = DIAGNOSTICS[at].line;
        assert.match(item, new RegExp(`^<button type="button" class="ps-mini-button" data-line="${line}">Line ${line}</button> <span title="([^"]*)"`));
        const span = /<span title="([^"]*)"[^>]*>(.*)<\/span>$/.exec(item);
        assert.equal(words(span[2]), said[at].text.replace(`Line ${line}: `, ""), `line ${line}`);
        assert.equal(span[1], said[at].title, `line ${line}: the tooltip is the diagnostics list's`);
    }
    // The gutter's tooltip: the words, then the code and path.
    assert.match(box, /<div data-mark="error" title="Duplicate key &quot;required&quot; at line 9 \(first at line 8\): a mapping may name each key once\. \(WORKFLOW_YAML_INVALID · \$\)"[^>]*>● 9<\/div>/);
});

test("UXP-GEM-05: the line over an invalid revision ends with one full stop, never two", () => {
    const model = (message, more = {}) => ({ revision: { revision: 4, valid: false, diagnostics: [{ severity: "error", line: 9, message }] }, ...more });
    const once = "Duplicate key \"required\" at line 9 (first at line 8): a mapping may name each key once.";
    assert.equal(revisionLine(model(once)).text, `Revision 4 not valid · line 9: ${once}`);
    assert.equal(revisionLine(model(`${once} `)).text, `Revision 4 not valid · line 9: ${once}`);
    assert.equal(revisionLine(model(once, { graph: { revision: 3 } })).text, `Revision 4 not valid · line 9: ${once} Showing revision 3.`);
    assert.equal(revisionLine(model("route goes nowhere")).text, "Revision 4 not valid · line 9: route goes nowhere.");
    for (const end of ["?", "!", "…"]) assert.equal(revisionLine(model(`Is it there${end}`)).text, `Revision 4 not valid · line 9: Is it there${end}`);
    assert.equal(revisionLine({ revision: { revision: 4, valid: false, diagnostics: [] } }).text, "Revision 4 not valid.");
    // The component draws the words revisionLine gives.
    assert.match(source("workflow-tab.js"), /const line = revisionLine\(workflowModel, \{ writing: ownerWorking, writer: ownerTitle \}\);/);
    assert.match(source("workflow-chat-tab.js"), /const line = revisionLine\(model, \{ writing: /);
});

test("UXP-GEM-03: a phone's state chip with its time cuts only the end of its label, never its start", () => {
    const chip = declared(".ps-wf-tab.is-phone .ps-wf-bar .ps-wf-state.has-time");
    assert.deepEqual(pick(chip, ["display", "justify-content", "overflow"]), { display: "inline-flex", "justify-content": "flex-start", overflow: "clip" });
    const label = declared(".ps-wf-state.has-time > .ps-wf-state-label");
    assert.deepEqual(pick(label, ["flex", "min-width", "overflow", "text-overflow", "white-space", "text-align", "direction"]),
        { flex: "1 1 auto", "min-width": "0", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "text-align": "left", direction: "ltr" });
    assert.equal(declared(".ps-wf-state.has-time > .ps-wf-state-time").flex, "none");
    // DEV at bfa03e9b (WebKit 390 px, measured): the Workflow picker's group shrank below its words, so its picker painted over
    // the chip's first 41 px. In the run bar the group keeps its width (the chip gives way); the picker is that group's.
    assert.match(source("workflow-tab.js"), /h\("div", \{ className: "ps-wf-bar is-run" \},\n\s*h\(WorkflowNumberPicker,/);
    assert.equal(declared(".ps-wf-tab.is-phone .ps-wf-bar.is-run > .ps-wf-picker-group").flex, "none");
    assert.equal(declared(".ps-wf-picker.is-faced").flex, "none");
    assert.equal(declared(".ps-wf-tab.is-phone .ps-wf-bar .ps-wf-state")["min-width"], "0");
    // Nothing that draws a state chip or its parts packs them to the end, centres them or reads them right to left.
    const chipRules = RULES.filter(rule => rule.selectors.some(one => /\.ps-wf-state\b/.test(one)));
    assert.ok(chipRules.length >= 5);
    for (const rule of chipRules) {
        assert.doesNotMatch(rule.body, /direction:\s*rtl|justify-content:\s*(center|flex-end|end|right)|text-align:\s*(right|end|center)/,
            rule.selectors.join(", "));
    }
});

test("UXP-GEM-02: a failed Workflow's line on a phone holds its toggle's words; the tab clips nothing and the focus ring is whole", () => {
    const line = declared(".ps-wf-tab.is-phone .ps-wf-failure");
    assert.deepEqual(pick(line, ["min-width", "max-width", "overflow-x"]), { "min-width": "0", "max-width": "100%", "overflow-x": "clip" });
    // Sideways only: no overflow or overflow-y that would cut the ring above and below the toggle (or make it scroll).
    assert.ok(!("overflow" in line) && !("overflow-y" in line), JSON.stringify(line));
    const toggle = declared(".ps-wf-tab.is-phone .ps-wf-failure-toggle");
    assert.deepEqual(pick(toggle, ["min-height", "min-width", "max-width"]), { "min-height": "44px", "min-width": "0", "max-width": "100%" });
    // The tab itself does not clip.
    for (const selector of [".ps-wf-tab", ".ps-wf-tab.is-phone", ".ps-wf-tab.is-mobile"]) {
        const tab = declared(selector);
        assert.ok(!/hidden|clip/.test(`${tab.overflow ?? ""} ${tab["overflow-x"] ?? ""}`), `${selector}: ${JSON.stringify(tab)}`);
    }
    // The ring (its width and its offset) fits in the line's side padding, so the sideways clip does not reach it.
    const ring = declared(".ps-wf-failure-toggle:focus-visible");
    const reach = parseFloat(ring.outline) + parseFloat(ring["outline-offset"]);
    const side = parseFloat(declared(".ps-wf-line").padding.split(/\s+/)[1]);
    assert.ok(reach > 0 && reach <= side, `ring ${reach}px, padding ${side}px`);
    assert.ok(!("padding-left" in declared(".ps-wf-tab.is-phone .ps-wf-failure > .ps-wf-line.is-error")));
});

// Coordinator 00:17Z, with UXP-GEM-02 (WebKit at 390 px): the Node panel's head, its description and a Result box ran past
// the right edge. A code box (white-space: pre) set the panel's grids' minimum width, so every row widened with it.
test("UXP-GEM-02: the Node panel never runs past its pane: its grids' items have no minimum width; values wrap, code scrolls", () => {
    const grids = [".ps-wf-node", ".ps-wf-summary", ".ps-wf-def-node", ".ps-wf-facts", ".ps-wf-more-list", ".ps-wf-agent", ".ps-wf-next"];
    for (const grid of grids) {
        assert.equal(declared(grid)["grid-template-columns"], "minmax(0, 1fr)", grid);
        assert.deepEqual(pick(declared(`${grid} > *`), ["min-width", "max-width"]), { "min-width": "0", "max-width": "100%" }, grid);
    }
    // A fact's value column too (its label keeps 8em).
    assert.equal(declared(".ps-wf-fact")["grid-template-columns"], "8em minmax(0, 1fr)");
    // The head and the description wrap anywhere; a Result box wraps; a code box scrolls inside itself.
    for (const selector of [".ps-wf-node-head", ".ps-wf-what"]) assert.equal(declared(selector)["overflow-wrap"], "anywhere", selector);
    assert.deepEqual(pick(declared(".ps-wf-result pre"), ["white-space", "overflow-wrap", "overflow"]),
        { "white-space": "pre-wrap", "overflow-wrap": "anywhere", overflow: "auto" });
    assert.deepEqual(pick(declared(".ps-wf-more-body > pre.ps-wf-code"), ["white-space", "overflow"]), { "white-space": "pre", overflow: "auto" });
    assert.equal(declared(".ps-wf-more-body")["min-width"], "0");
    // Nothing in the panel keeps its words on one line.
    const panelRules = RULES.filter(rule => rule.selectors.some(one => /\.ps-wf-(node|summary|what|fact|result|def-node)\b/.test(one)));
    assert.ok(panelRules.every(rule => !/white-space:\s*nowrap/.test(rule.body)), JSON.stringify(panelRules.map(rule => rule.selectors)));
});

test("UXP-GEM-06: win95's pickers and YAML box have top and left edges seen on the window face (3:1); other themes keep theirs", () => {
    const vars = declared(':root[data-ps-theme="win95"]');
    const resolve = value => value.replace(/var\((--[\w-]+)\)/g, (_, name) => vars[name]);
    const face = resolve("var(--w95-face)");
    assert.equal(face, "#c0c0c0");
    assert.equal(getTheme("win95").page.workflowGround, face, "the Workflow tab's ground is the face");
    // A picker's face is a .ps-workflow-input in the tab.
    assert.match(source("workflow-tab.js"), /h\("span", \{ className: "ps-workflow-input ps-wf-picker-face", "aria-hidden": "true" \}/);
    for (const control of [".ps-workflow-input", ".ps-workflow-yaml"]) {
        const [top, , , left] = resolve(declared(`:root[data-ps-theme="win95"] .ps-wf-tab ${control}`)["border-color"]).split(/\s+/);
        for (const [edge, colour] of [["top", top], ["left", left]]) {
            const ratio = contrastRatio(colour, face);
            assert.ok(ratio >= 3, `${control} ${edge} ${colour} on ${face}: ${ratio?.toFixed(2)}:1`);
        }
    }
    // Before: the grey shadow on the face.
    assert.ok(contrastRatio(resolve("var(--w95-shadow)"), face) < 2.2);
    // Only win95: every rule naming these edges is win95's.
    for (const rule of RULES.filter(one => /--w95-dark\) var\(--w95-light\) var\(--w95-light\) var\(--w95-dark\)/.test(one.body)
        && one.selectors.some(selector => selector.includes(".ps-wf-tab")))) {
        assert.ok(rule.selectors.every(selector => selector.startsWith(':root[data-ps-theme="win95"]')), rule.selectors.join(", "));
    }
});

test("UXP-GEM-06: the Workflow tab's muted words read 4.5:1 on its ground and its panel in every theme; the node marks are 3:1 parts", () => {
    // The portal draws muted words with the theme's grey.
    assert.match(source("web-app.js"), /root\.style\.setProperty\("--ps-muted", theme\.tui\.gray\);/);
    const low = [];
    for (const theme of listThemes()) {
        for (const ground of [theme.page.workflowGround ?? theme.tui.background, theme.tui.surface]) {
            const ratio = contrastRatio(theme.tui.gray, ground);
            if (!(ratio >= 4.5)) low.push(`${theme.id}: ${theme.tui.gray} on ${ground} ${ratio?.toFixed(2)}`);
        }
    }
    assert.deepEqual(low, []);
    // The figures under 4.5:1 (3.2:1 to 4.5:1 in ms-dos, doom, hacker-x-matrix, win95, gruvbox-dark and cobalt2) are a node's
    // state mark (✓ ✕): a glyph beside the state's words, hidden from screen readers, held to 3:1 (theme-workflow-colors).
    assert.match(source("workflow-graph.js"), /h\("span", \{ className: "ps-workflow-node-mark", "aria-hidden": "true" \}, card\.mark\.glyph\)/);
});
