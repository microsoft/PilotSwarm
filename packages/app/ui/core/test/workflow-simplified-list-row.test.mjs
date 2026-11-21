/**
 * Workflow Simplified, review UI-16: the Workflows table is a table of real rows with cells, and each row's action is a
 * named button in its first cell (never a button given the row role).
 *
 * Run: node --test ui/core/test/workflow-simplified-list-row.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("each Workflows row is a row with cells, and its first cell holds its named Open button", () => {
    const source = fs.readFileSync(new URL("../../react/src/workflow-tab.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /h\("button", \{[^}]*role: "row"/, "no button takes the row role");
    assert.match(source, /h\("div", \{ key: row\.sessionId, role: "row", className: "ps-wf-list-row is-action"/);
    assert.match(source, /h\("span", \{ role: "cell", className: "ps-wf-list-number" \},\s*h\("button", \{ type: "button", className: "ps-link-button", "aria-label": `Open \$\{definition\.name\} #\$\{row\.number\}`/);
});
