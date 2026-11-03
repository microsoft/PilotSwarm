import test from "node:test";
import assert from "node:assert/strict";
import { restrictMarkdownLinkToExternal } from "../../react/src/workspace-markdown.js";

function linkWith(href, childNodes = [{ textContent: "Label" }]) {
    const attributes = new Map(href === null ? [] : [["href", href]]);
    return { childNodes, attributes, replacement: null,
        ownerDocument: { createElement: tag => ({ tagName: tag.toUpperCase(), childNodes: [],
            append(...nodes) { this.childNodes.push(...nodes); } }) },
        getAttribute: name => attributes.get(name) ?? null,
        setAttribute: (name, value) => attributes.set(name, value),
        replaceWith(node) { this.replacement = node; } };
}
for (const [name, href] of [["relative", "docs/readme.md"], ["anchor", "#anchor"],
    ["javascript", "javascript:alert(1)"], ["already sanitized javascript", null]]) {
    test(`MoTD ${name} link becomes plain span content`, () => {
        const link = linkWith(href);
        restrictMarkdownLinkToExternal(link);
        assert.equal(link.replacement.tagName, "SPAN");
        assert.deepEqual(link.replacement.childNodes, link.childNodes);
        assert.equal(link.replacement.attributes, undefined);
    });
}
for (const [name, href] of [["markdown https", "https://example.invalid/guide"],
    ["bare https", "https://example.invalid/bare"], ["www autolink", "http://www.example.invalid"],
    ["mailto", "mailto:reader@example.invalid"]]) {
    test(`MoTD ${name} link keeps its external destination and new-tab protections`, () => {
        const link = linkWith(href);
        restrictMarkdownLinkToExternal(link);
        assert.equal(link.replacement, null);
        assert.equal(link.getAttribute("href"), href);
        assert.equal(link.getAttribute("target"), "_blank");
        assert.equal(link.getAttribute("rel"), "noopener noreferrer");
    });
}
test("neutralized links retain inline label formatting and order", () => {
    const children = [{ tagName: "STRONG", textContent: "Bold label" }, { textContent: " suffix" }];
    const link = linkWith("#anchor", children);
    restrictMarkdownLinkToExternal(link);
    assert.equal(link.replacement.childNodes[0], children[0]);
    assert.equal(link.replacement.childNodes[1], children[1]);
});
