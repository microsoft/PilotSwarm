// OF-S2-5-F1 at 390 px (42fe6838 DEV): on a phone the session list pans long rows sideways at their full width, so a long
// title pushed the "Has Workflows" mark past the list's visible right edge. A row with the mark is at most as wide as the
// visible list (a container query on the list's track), its title takes the ellipsis there, and the mark never shrinks.
// The geometry itself is the browser test workflow-session-definitions.spec.mjs -g "OF-S2-5-F1"; this is the narrow source
// check that the phone's rules for such a row exist and outrank the phone's "rows grow to their content" rules.
//
// Run: node --test packages/app/web/test/session-owner-mark-phone.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const block = selector => {
    const at = css.indexOf(`${selector} {`);
    if (at < 0) return null;
    return css.slice(at, css.indexOf("}", at) + 1);
};
const TRACK = ".ps-session-pane.ps-mobile-session-pane .ps-session-list-track";

test("a phone row with the mark is as wide as the visible list at most, and its title takes the ellipsis", () => {
    assert.match(block(TRACK) ?? "", /container-type:\s*inline-size;/, "the track is the rows' size container");
    assert.match(block(`${TRACK} .ps-list-button:has(.has-owner-mark)`) ?? "", /max-width:\s*100cqw;/);
    assert.match(block(`${TRACK} .ps-line.has-owner-mark`) ?? "", /overflow:\s*hidden;/);
    const title = css.slice(css.indexOf(`${TRACK} .has-owner-mark > .ps-session-row-title__text,`));
    assert.match(title.slice(0, title.indexOf("}") + 1), /overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;/);
    // The rule it overrides: the phone's titles otherwise overflow visibly (and so push the mark away).
    assert.ok(css.indexOf(`${TRACK} .ps-session-row-title__text,`) < css.indexOf(`${TRACK} .has-owner-mark > .ps-session-row-title__text,`),
        "the mark row's rule comes after the phone's own, at greater specificity");
    // The mark itself never shrinks.
    assert.match(block(".has-owner-mark > .ps-workflow-owner-mark") ?? css.match(/\.has-owner-mark > \.ps-workflow-owner-mark \{[^}]*\}/)?.[0] ?? "", /flex:\s*none;/);
});
