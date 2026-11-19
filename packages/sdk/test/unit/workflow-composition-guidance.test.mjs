import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const skill = name => readFileSync(new URL(`../../plugins/workflow/skills/${name}/SKILL.md`, import.meta.url), "utf8");
const normalized = name => skill(name).replace(/\s+/g, " ");

function workflowTestOperationsFromSource() {
    const source = readFileSync(new URL("../../src/workflow/store.ts", import.meta.url), "utf8");
    const match = source.match(/export const WORKFLOW_TEST_OPERATIONS = (\[[^\]]+\]) as const;/);
    assert.ok(match, "WORKFLOW_TEST_OPERATIONS export is present in source");
    return JSON.parse(match[1]);
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

test("the dedicated test skill covers every exported operation and a parseable reachable Decision fixture", () => {
    const relative = "../../plugins/workflow/test-mode-skills/workflow-testing/SKILL.md";
    const text = readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.ok(Buffer.byteLength(text, "utf8") <= 20_480, `${relative}: ${Buffer.byteLength(text, "utf8")} bytes`);

    const operations = workflowTestOperationsFromSource();
    assert.ok(operations.includes("decision"), JSON.stringify(operations));
    for (const operation of operations) {
        assert.ok(text.includes(`\`${operation}\``), `dedicated test skill omits ${operation}`);
    }

    const fixtureFence = text.match(/```json\n\{\n\s*"operation"\s*:\s*"decision",[\s\S]*?\n\}\n```/)?.[0];
    assert.ok(fixtureFence, "dedicated test skill has a parseable raw Decision fixture");
    const fixtureBlock = fixtureFence.replace(/^```json\n/, "").replace(/\n```$/, "");
    const fixture = JSON.parse(fixtureBlock);
    assert.equal(fixture.operation, "decision");
    assert.equal(fixture.state, "route");
    assert.deepEqual(fixture.arguments, { ticket: "Please refund invoice 42" });
    assert.equal(fixture.response.kind, "success");
    assert.equal(fixture.response.value.answers.decision.type, "choice");
    assert.equal(fixture.response.value.answers.decision.choice, "billing");

    const stateInput = { ticket: "Please refund invoice 42" };
    const stateHash = createHash("sha256").update(canonicalJson(stateInput)).digest("hex");
    const fixtureHash = createHash("sha256").update(canonicalJson(fixture.arguments)).digest("hex");
    assert.equal(fixtureHash, stateHash, "the fixture is reachable for the exact state input");
    assert.equal(fixture.operation, "decision");
    assert.equal(fixture.state, "route");

    const flat = text.replace(/\s+/g, " ");
    assert.match(flat, /exact state input/i);
    assert.match(flat, /raw provider response body/i);
    assert.match(flat, /eligible Cluster Decision Default/i);
    assert.match(flat, /WORKFLOW_DECISION_MODEL_UNAVAILABLE/i);
    assert.match(flat, /no live provider call/i);
    assert.match(flat, /no provider budget charge/i);
    assert.match(flat, /no inference call/i);
    assert.match(text, /^- \{ operation: approval, state: consent, response: \{ kind: success, value: \{ decision: approved \} \} \}$/m);
    assert.match(text, /\| Approval \|/);
});

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
