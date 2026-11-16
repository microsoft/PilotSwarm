/**
 * Activity-run rails keep their status colour in every theme.
 *
 * The shared rules colour the rail by state (.is-working, .is-failed). A theme
 * rule that restyles the rail is more specific than those, so it must restate
 * the state colours or a running or failed tool shows the success colour.
 *
 * Run: node --test web/test/activity-run-rails.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

function rules() {
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    for (let match = re.exec(css); match; match = re.exec(css)) {
        for (const selector of match[1].split(",")) out.push({ selector: selector.trim().replace(/\s+/g, " "), body: match[2] });
    }
    return out;
}

test("a theme that restyles the activity-run rail restates its working and failed colours", () => {
    const all = rules();
    const themed = all.filter(({ selector, body }) => {
        const m = /^:root\[data-ps-theme="([^"]+)"\] \.ps-chat-panel \.ps-activity-run$/.exec(selector);
        return m && /border-left(-color)?\s*:/.test(body);
    });
    assert.ok(themed.length >= 2, "expected at least Win95 and Duroxide to restyle the rail");
    for (const { selector } of themed) {
        const theme = /data-ps-theme="([^"]+)"/.exec(selector)[1];
        for (const state of ["is-working", "is-failed"]) {
            const stateSelector = `:root[data-ps-theme="${theme}"] .ps-chat-panel .ps-activity-run.${state}`;
            const rule = all.find((entry) => entry.selector === stateSelector && /border-left-color\s*:/.test(entry.body));
            assert.ok(rule, `${theme} needs ${stateSelector} { border-left-color }`);
        }
    }
});
