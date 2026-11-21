/**
 * Portal CSS: no rule is ever inserted into the middle of another rule's
 * selector list.
 *
 * WHY THIS EXISTS: a new block was once added between two selectors of the
 * chat-line wrap rule (".ps-scroll-panel.is-wrapped .ps-line," then a comment
 * and a new rule). The browser read the leftover selector as part of the new
 * rule, so every wrapped chat line, splash screens included, took the new
 * rule's text-align: right and lost its own wrapping. A comment right after a
 * selector's trailing comma is the signature of that mistake.
 *
 * Run: node --test web/test/css-selector-lists.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function cssFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "assets" ? [] : cssFiles(path);
        return entry.name.endsWith(".css") ? [path] : [];
    });
}

test("no comment or rule interrupts a selector list", () => {
    const problems = [];
    for (const file of cssFiles(SRC)) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(/,[ \t]*\n[ \t]*\/\*/g)) {
            problems.push(`${file.slice(SRC.length)}:${text.slice(0, match.index).split("\n").length}`);
        }
    }
    assert.deepEqual(problems, [], "a selector ends with ',' and the next line starts a comment: a rule was inserted inside a selector list");
});

test("wrapped chat lines keep their wrap rule and their default alignment", () => {
    const css = readFileSync(join(SRC, "index.css"), "utf8");
    const rule = /\.ps-scroll-panel\.is-wrapped \.ps-line,\s*\.ps-modal-details \.ps-line,\s*\.ps-filter-column \.ps-line\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, "the wrapped-line rule keeps its whole selector list");
    assert.match(rule[1], /white-space:\s*pre-wrap/);
    assert.doesNotMatch(rule[1], /text-align/);
});
