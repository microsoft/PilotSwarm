// Definitions-lens UX findings (TEST rehearsal at 2422c33e) and the phone icon button (packages lens, P11): the words a
// person reads under an invalid revision, the error colour, the dividers and wells, the phone targets and layout, the stale
// Save's time and a disabled Start… a keyboard reaches.
//
// Run: node --test packages/app/ui/core/test/workflow-definitions-ux.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowDiagnostics } from "../../react/src/workflow-panels.js";
import { WorkflowToolButton } from "../../react/src/workflow-tool-button.js";
import { chatDefinitionFailure } from "../src/workflow-chat-definitions.js";
import { workflowShortTime } from "../src/workflow-words.js";

const css = fs.readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");
const panels = fs.readFileSync(new URL("../../react/src/workflow-panels.js", import.meta.url), "utf8");
/** The rules of the media block that starts with `header` (to its matching brace). */
function mediaBlock(header, after = 0) {
    const start = css.indexOf(header, after);
    assert.ok(start >= 0, `no block ${header}`);
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
    }
    throw new Error("unbalanced CSS");
}
const PHONE = "/* Final review FUI-F1: the phone query, a phone held sideways included. */";

test("UXFD-F6: the list under an invalid revision says the line and the message; the code and path stay in the tooltip", () => {
    const html = renderToStaticMarkup(React.createElement(WorkflowDiagnostics, { diagnostics: [
        { severity: "error", code: "WORKFLOW_YAML_INVALID", path: "$", line: 11, message: "Duplicate key \"required\" at line 11 (first at line 8)" },
        { severity: "warning", code: "WORKFLOW_INPUT_JSON_TEXT", path: "states.ask.input", message: "This input is JSON text in quotes." },
    ] }));
    const text = html.replace(/<[^>]+>/g, "");
    assert.ok(!text.includes("WORKFLOW_YAML_INVALID") && !text.includes(" · $"), text);
    assert.ok(text.includes("Line 11: Duplicate key &quot;required&quot; at line 11 (first at line 8)"), text);
    assert.ok(text.includes("Warning: This input is JSON text in quotes."), text);
    assert.match(html, /title="WORKFLOW_YAML_INVALID · \$"/);
    assert.match(html, /title="WORKFLOW_INPUT_JSON_TEXT · states\.ask\.input"/);
});

test("UXFD-F5: the panels' error words use the Workflow's danger text colour, chosen per theme for 4.5:1", () => {
    assert.match(panels, /const TONES = \{ error: "var\(--ps-wf-danger-text, var\(--ps-danger\)\)"/);
});

test("UXFD-F15: a disabled tool button (Start…) stays focusable and says why; a click does nothing", () => {
    let clicked = 0;
    const html = renderToStaticMarkup(React.createElement(WorkflowToolButton, { label: "Start…", glyph: "start", disabled: true,
        title: "Revision 8 has errors, so it cannot start", onClick: () => { clicked += 1; } }));
    assert.match(html, /aria-disabled="true"/);
    assert.ok(!/<button[^>]* disabled=""/.test(html), "no disabled attribute: Tab reaches it");
    assert.match(html, /aria-describedby="wf-tool-[^"]+"/);
    assert.ok(html.includes("Revision 8 has errors, so it cannot start"));
    assert.equal(clicked, 0);
    const enabled = renderToStaticMarkup(React.createElement(WorkflowToolButton, { label: "Start…", glyph: "start", title: "Start #3" }));
    assert.ok(!enabled.includes("aria-disabled"));
});

test("UXFD-F14: the stale Save says the time as the info line does (workflowShortTime, no zone)", () => {
    const savedAt = new Date().toISOString();
    const failure = chatDefinitionFailure(Object.assign(new Error("x"), { code: "REVISION_STALE", status: 409,
        details: { currentRevision: 6, savedAt, savedBy: { kind: "chat" } } }));
    assert.equal(failure.message, `Revision not saved: revision 6 was saved by the chat at ${workflowShortTime(savedAt)}. Reload to edit it.`);
    assert.ok(!/ [A-Z]{2,5}\. Reload/.test(failure.message), failure.message);
});

test("UXFD-F7, F8: the bottom panel's rule is a control border; win95's Compare view is a white well", () => {
    assert.match(css, /\.ps-wf-panel \{[^}]*border-top: 1px solid var\(--ps-control-border, var\(--ps-border\)\);/);
    const well = css.slice(css.indexOf(':root[data-ps-theme="win95"] .ps-wf-tab .ps-workflow-yaml,'));
    assert.match(well.slice(0, well.indexOf("{")), /:root\[data-ps-theme="win95"\] \.ps-wf-tab \.ps-workflow-compare-view/);
    assert.match(well.slice(well.indexOf("{"), well.indexOf("}")), /background: #ffffff;/);
});

test("UXFD-F9 and P11: on a phone (held sideways too) the YAML marks' Line buttons and the icon buttons are 44 px tall; desktop does not change", () => {
    const phone = mediaBlock("@media", css.indexOf(PHONE));
    assert.match(phone, /\.ps-workflow-yaml-marks \.ps-mini-button \{ min-height: 44px; min-width: 44px; \}/);
    assert.match(phone, /\.ps-icon-button \{ min-height: 44px; \}/);
    assert.match(phone, /orientation: landscape\) and \(max-height: 500px\)/);
    // Outside the phone query the icon button has no min-height of 44 px.
    const base = css.slice(css.indexOf("\n.ps-icon-button {"), css.indexOf("}", css.indexOf("\n.ps-icon-button {")));
    assert.ok(!/min-height/.test(base), base);
});

test("UXFD-F10, F11: a phone's YAML box scrolls under a kept editor bar; from 700 px wide the Definition row is one line", () => {
    assert.match(css, /\.ps-wf-tab\.is-phone \.ps-workflow-draft-editor > \.ps-workflow-yaml \{ max-height: 55vh; overflow: auto; \}/);
    assert.match(css, /\.ps-wf-tab\.is-phone \.ps-workflow-draft-editor > \.ps-workflow-yaml-strip \{ position: sticky; top: 0;/);
    const wide = mediaBlock("@media (min-width: 700px) {", css.indexOf("UXFD-F11"));
    assert.match(wide, /\.ps-wf-tab\.is-phone \.ps-wf-tab-head\.is-two-lines \{ flex-wrap: nowrap; \}/);
});
