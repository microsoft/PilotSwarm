import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postcss from "postcss";

const css = postcss.parse(readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8"));
const rules = [];
css.walkRules(rule => rules.push(rule));
const declaration = (rule, property) => rule.nodes.find(node => node.type === "decl" && node.prop === property)?.value;
const find = selector => rules.find(rule => rule.selector === selector);

test("composer touch targets outrank the panel mini-button size", () => {
    const panel = find(".ps-panel .ps-mini-button,\n.ps-panel .ps-tab");
    const buttons = find(".ps-prompt-shell .ps-prompt-actions > button");
    assert.equal(declaration(panel, "min-height"), "30px", "exercise the compact panel rule from the reported regression");
    assert.equal(declaration(buttons, "min-height"), "44px");
    assert.equal(declaration(buttons, "min-width"), "44px");
    assert.equal(declaration(buttons, "flex"), "none");
    // Both selectors have two classes; the composer selector's button type
    // wins over the panel rule regardless of source order.
    assert.match(buttons.selector, /> button$/);
});

test("narrow composers give the input one full-width column and actions a separate wrapping row", () => {
    assert.equal(declaration(find(".ps-chat-composer"), "container"), "prompt-composer / inline-size");
    const narrow = css.nodes.find(node => node.type === "atrule"
        && node.name === "container" && node.params === "prompt-composer (max-width: 480px)");
    assert.ok(narrow);
    const grid = narrow.nodes.find(node => node.selector === ".ps-chat-composer .ps-prompt-shell");
    assert.equal(declaration(grid, "grid-template-columns"), "minmax(0, 1fr)");
    const fullWidth = narrow.nodes.find(node => node.selector?.includes(".ps-prompt-shell > .ps-prompt-input"));
    assert.equal(declaration(fullWidth, "grid-column"), "1 / -1");
    const actions = narrow.nodes.find(node => node.selector === ".ps-prompt-shell > .ps-prompt-actions");
    assert.equal(declaration(actions, "flex-wrap"), "wrap");
    assert.equal(declaration(actions, "justify-content"), "flex-end");
    assert.equal(declaration(actions, "min-width"), "0");
    assert.ok(narrow.source.start.line > find(".ps-prompt-shell.is-compact").source.start.line,
        "the equal-specificity narrow rule must override compact and mobile grids");
});

test("wider composers retain the existing horizontal grid and DOM action order", () => {
    assert.equal(declaration(find(".ps-prompt-shell"), "grid-template-columns"), "auto minmax(0, 1fr) auto");
    assert.equal(declaration(find(".ps-prompt-shell.is-mobile"), "grid-template-columns"), "auto minmax(0, 1fr) auto");
    for (const rule of rules.filter(rule => /ps-prompt-actions|ps-steer-button/.test(rule.selector))) {
        assert.equal(declaration(rule, "order"), undefined);
        assert.notEqual(declaration(rule, "flex-direction"), "row-reverse");
    }
});
