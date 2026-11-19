import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = name => readFileSync(new URL(`../../plugins/workflow/skills/${name}/SKILL.md`, import.meta.url), "utf8");
const flat = text => text.replace(/\s+/g, " ");
const normalized = name => flat(skill(name));
const testingSkill = () => readFileSync(new URL("../../plugins/workflow/test-mode-skills/workflow-testing/SKILL.md", import.meta.url), "utf8");

test("the dedicated guide distinguishes Decision model admission from answering an interception", () => {
    const text = testingSkill();
    const prose = flat(text);
    assert.match(prose, /`update_workflow` `test`[^.]*\{ model \}[^.]*`agent_models`/);
    assert.match(prose, /`decision_models`[^.]*`workflow_definition` `test`/);
    assert.match(prose, /eligible Cluster Decision Default/);
    assert.match(prose, /WORKFLOW_DECISION_MODEL_UNAVAILABLE/);
    assert.match(prose, /both agent modes[^.]*fixture[^.]*`test_respond`/i);
    for (const promise of [/no live provider call/, /no provider budget charge/, /no inference call/]) {
        assert.match(prose, promise);
    }
    assert.match(text, /^\| A Decision[^\n]*\|[^|\n]*`timeoutMs`[^|\n]*\|/m);
});

test("the dedicated guide distinguishes Decision fixture matching, invalid bodies, and simulated timeouts", () => {
    const text = testingSkill();
    const matching = flat(text.match(/^- `arguments`[^\n]*(?:\n  [^\n]+)*/m)?.[0] ?? "");
    assert.match(matching, /exact evaluated input of that state/);
    assert.match(matching, /`approval`[^.]*frozen context/);
    assert.doesNotMatch(text, /any exact state input/);

    const prose = flat(text);
    assert.match(prose, /raw provider response body/);
    assert.match(prose, /`success`[^.]*raw body[^.]*decides[^.]*`invalid_output`/);
    assert.match(prose, /Decision interception[^.]*no virtual deadline/);
    assert.match(prose, /`test_advance`[^.]*cannot time it out/);
    assert.match(prose, /"kind": "error", "value": \{ "code": "timed_out", "message": "[^"]+" \}/);
});

test("composition guidance stays inside every Workflow skill's body budget", () => {
    const testing = testingSkill();
    assert.ok(Buffer.byteLength(testing) <= 20_480, `workflow-testing file: ${Buffer.byteLength(testing)} bytes`);
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
