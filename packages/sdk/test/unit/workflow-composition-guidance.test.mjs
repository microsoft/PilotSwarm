import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = name => readFileSync(new URL(`../../plugins/workflow/skills/${name}/SKILL.md`, import.meta.url), "utf8");
const normalized = name => skill(name).replace(/\s+/g, " ");

test("composition guidance stays inside every Workflow skill's body budget", () => {
    for (const name of ["workflow-authoring", "workflow-reference", "workflow-tools"]) {
        const text = skill(name);
        const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
        assert.ok(Buffer.byteLength(body) <= 20_480, `${name} body: ${Buffer.byteLength(body)} bytes`);
        assert.ok(Buffer.byteLength(text) <= 20_480, `${name} file: ${Buffer.byteLength(text)} bytes`);
        assert.doesNotMatch(text, /hand[_-]?over/i, `${name} must not teach the withdrawn feature`);
    }
});

test("Workflow authors can discover grant and the detailed composition rules", () => {
    assert.match(normalized("workflow-authoring"), /Use `grant` to add held tools; `tools` only limits/);
    assert.match(normalized("workflow-reference"), /\| `grant` \| `all`\/`none`\/selectors/);
    const text = normalized("workflow-tools");
    for (const phrase of [
        "A named step defaults to `grant: none`, an inline step to `grant: all`",
        "`package:<name>`", "`mcp:<server>`", "Start has no `grant` argument",
        "not only its `use_package` selections", "visible packages",
        "selection changes or republishing do not replace the pins",
        "Other packages keep their tools",
        "`grant: none` removes no baseline tools", "inherited ceiling still applies",
        "never bypass MCP `allowedAgents`", "grants no package/MCP authority",
        "Deprecated `tool_names` keeps its 0.8.11 meaning and adds no grant",
        "Never combine `tool_names` with `grant` or `tools`",
        "Workflows started before the upgrade",
        "named steps lose formerly inherited parent package tools",
        "The inherited ceiling limits `tool_names` too",
    ]) assert.ok(text.includes(phrase), `Missing composition rule: ${phrase}`);
    assert.doesNotMatch(normalized("workflow-authoring"), /void grant/i);
});
