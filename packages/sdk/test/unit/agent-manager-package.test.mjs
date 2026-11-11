/**
 * The shipped agent-manager package: what it promises the user.
 *
 * This bundle is unusually privileged — it reaches every session the account
 * can see, and can delete them. Two things therefore have to survive every
 * future edit to the prompt, and neither is enforceable in code:
 *
 *   1. the splash tells the user the blast radius, on both surfaces;
 *   2. the prompt names the destructive actions and requires a yes first.
 *
 * A prompt is data, so the only way to keep these is to assert on them.
 *
 * Run: node --test test/unit/agent-manager-package.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgentFiles } from "../../dist/agent-loader.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const pkgDir = path.join(repoRoot, "agent-packages/agent-manager");
const agent = loadAgentFiles(path.join(pkgDir, "agents"))[0];
const prompt = fs.readFileSync(path.join(pkgDir, "agents/agent-manager.agent.md"), "utf8");

test("the package and agent parse at all", () => {
    assert.ok(agent, "agent-manager.agent.md did not load");
    assert.equal(agent.name, "agent-manager");
    // The description must be real prose, not the YAML block-scalar marker
    // that shipped in 1.0.0 and read as "|" in every picker.
    assert.notEqual(agent.description?.trim(), "|");
    assert.ok((agent.description || "").length > 40, "description looks truncated");
});

test("the desktop splash warns about session reach", () => {
    const splash = agent.splash || "";
    assert.match(splash, /REACH EVERY SESSION/i);
    assert.match(splash, /cancel/i);
    assert.match(splash, /delete/i);
    assert.match(splash, /asks before anything destructive/i);
});

test("the mobile splash carries the same warning", () => {
    // The phone is where someone is most likely to fire a destructive action
    // without reading carefully, so it must not be the surface that omits it.
    const splash = agent.splashMobile || "";
    assert.match(splash, /REACHES EVERY SESSION/i);
    assert.match(splash, /destructive/i);
});

test("the splash box is aligned once colour tags are stripped", () => {
    // A ragged warning box reads as a rendering bug and undermines the
    // warning it is carrying.
    // Scope to the warning box: the ASCII-art letterforms also contain ║.
    const stripped = (agent.splash || "").split("\n").map((l) => l.replace(/\{[^}]*\}/g, ""));
    // Anchor on the long ═ runs: the letterforms use ╔ and ╚ too, just never
    // ten of them in a row.
    const top = stripped.findIndex((l) => /╔═{10,}╗/.test(l));
    const bottom = stripped.findIndex((l) => /╚═{10,}╝/.test(l));
    assert.ok(top >= 0 && bottom > top, "warning box not found in the splash");
    const boxLines = stripped.slice(top, bottom + 1);
    assert.ok(boxLines.length >= 5, "warning box not found in the splash");
    const widths = new Set(boxLines.map((l) => [...l].length));
    assert.equal(widths.size, 1, `warning box lines differ in width: ${[...widths].join(", ")}`);
});

test("the prompt requires approval before destructive actions", () => {
    assert.match(prompt, /ASK BEFORE ANYTHING DESTRUCTIVE/);
    // Every destructive tool has to be named, or the model will reason by
    // analogy about the ones that are missing.
    for (const tool of [
        "manage_agent_session",
        "message_agent_session",
        "set_agent_package_enabled",
        "pin_agent_package_version",
        "publish_agent_package",
    ]) {
        assert.ok(prompt.includes(tool), `destructive-action table omits ${tool}`);
    }
});

test("the prompt forbids acting first and asking later", () => {
    assert.match(prompt, /Ask, then stop/);
    assert.match(prompt, /Do not call the tool in the same turn you asked in/);
    // Unattended runs are the case where "nobody objected" is most tempting.
    assert.match(prompt, /nobody said no.{0,30}not consent/is);
});

test("the prompt still keeps reads free", () => {
    // Over-gating is its own failure: an agent that asks permission to read
    // is useless for diagnosis.
    assert.match(prompt, /Reading is always fine/i);
});

test("declared tools match the tools the bundle actually provides", () => {
    // A declared-but-nonexistent tool is invisible-to-the-model dead weight;
    // the reverse is a capability nobody reviewed.
    for (const tool of ["create_agent_session", "message_agent_session", "manage_agent_session"]) {
        assert.ok(agent.tools?.includes(tool), `frontmatter does not declare ${tool}`);
    }
});

test("the package ships a CHANGELOG with an entry for its current version", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "plugin.json"), "utf8"));
    const changelog = fs.readFileSync(path.join(pkgDir, "CHANGELOG.md"), "utf8");
    assert.ok(
        changelog.includes(`## ${manifest.version}`),
        `CHANGELOG.md has no entry for ${manifest.version}`,
    );
});

// Agent Smith 1.4.2 smoke on TEST: two tests of a valid revision failed with TEST_UNANSWERED at an ask (request) node, because
// the fixtures were shaped as an agent node's; it then showed a publish plan anyway. 1.4.3 (OF-S2-6 follow-up): the prompt
// and the repair loop give each step kind's fixture shape, and a failed test is never followed by a publish plan.
test("the prompt gives each step kind's test fixture shape and never follows a failed test with a publish plan", () => {
    const skill = fs.readFileSync(path.join(pkgDir, "skills/agent-repair-loop/SKILL.md"), "utf8");
    for (const text of [prompt, skill]) {
        assert.match(text, /\{ outcome(: <[^>]+>)?, output/, "an agent node's fixture");
        assert.match(text, /\{ response: <[^>]*response[^>]*> \}/, "an ask (request) node's fixture");
        assert.match(text, /\{ decline: \{ reason/, "an ask node's decline");
        assert.match(text, /failed test is never followed\s+by a publish plan/i);
        assert.match(text, /same failure twice/i);
    }
    assert.match(prompt, /operation: "request", state: "review", response: \{ kind: "success",\s+value: \{ response: \{ approved: true \} \} \}/);
    // Still tested before publish (1.4.1) and kept simple (1.4.2).
    assert.match(prompt, /A Workflow Definition is tested before it is published/);
    assert.match(prompt, /Keep a Workflow simple/);
});

// OF-S2-7 (1.4.4): a definition never names a model; a card's model hints are kinds of model, never a provider or model name.
test("the prompt: agent nodes use the starting session's model; a card's modelHints are kinds, keyed by node id, never a model's name", () => {
    assert.match(prompt, /a definition never names a model: every agent node uses the model of the\s+session that starts it/);
    assert.match(prompt, /`modelHints` entry for it, keyed by the node's id/);
    assert.match(prompt, /A hint is a kind, never a provider or model name/);
    // 1.4.5 (review OF7-R5): structured hints, an example, and the note's limit.
    assert.match(prompt, /`strength` \(fast, balanced,\s+strong\), `reasoning` \(low, medium, high, xhigh, max\), `context` \(default,\s+long_context\)/);
    assert.match(prompt, /review: \{ strength: strong, reasoning: high, context: long_context \}/);
    assert.match(prompt, /at most 120 characters/);
});

// 1.4.6 (owner 2026-11-08T00:35Z): the router pattern, in the prompt and the repair loop; 1.4.7: named branches first.
test("the prompt and the repair loop teach named branches, then the router pattern for branches from a list: one Workflow, never several", () => {
    const skill = fs.readFileSync(path.join(pkgDir, "skills/agent-repair-loop/SKILL.md"), "utf8");
    for (const text of [prompt, skill]) {
        assert.match(text, /one\s+Workflow, never several/i);
        assert.match(text, /router script/);
        // 1.4.7: named branches first; the router pattern is the older form, for branches that come from a list.
        assert.match(text, /a parallel state with\s+named `branches`/);
        assert.match(text, /joined as\s+`\{ <name>: output \}`|`joined` gives\s+`\{ <name>: output \}`/);
        assert.match(text, /When the branches come from a list/);
        // The patterns and their examples live in the on-demand workflow-patterns skill.
        assert.match(text, /`workflow-patterns`\s+skill/);
    }
    assert.match(prompt, /forEach: \[\{ lane: quick \}, \{ lane: careful \}\]/);
});

// 1.4.11 (G-12/13, Workflows on demand): an ordinary session has no Workflow tools until enable_workflows; Agent Smith's own
// session has them. Neither text says `test` is offered in every session, and each names the call that loads a skill.
test("the prompt and the repair loop say where `test` is offered: where Workflows are on, turned on with enable_workflows", () => {
    const skill = fs.readFileSync(path.join(pkgDir, "skills/agent-repair-loop/SKILL.md"), "utf8");
    for (const text of [prompt, skill]) {
        assert.doesNotMatch(text, /every current\s+session|always on with the full engine/);
        assert.match(text, /offered where\s+Workflows\s+are on/);
        assert.match(text, /turns\s+them on with\s+`enable_workflows`/);
        assert.match(text, /call\s+load_skill with name workflow-patterns/);
        assert.doesNotMatch(text, /Load the `workflow-patterns` skill/);
    }
    assert.match(prompt, /Your own session has them/);
    assert.match(skill, /Agent Smith's own session has them/);
    const changelog = fs.readFileSync(path.join(pkgDir, "CHANGELOG.md"), "utf8");
    const current = changelog.slice(changelog.indexOf("## 1.4.11"), changelog.indexOf("## 1.4.10"));
    assert.match(current, /offered where Workflows are on/);
});

// 1.5.0 (owner request 2026-11-11): every publish tripped on the card (effects as a list, outcomes keyed by the outcome value
// `succeeded` instead of the terminal state `done`), and each miss cost a new diff and approval. The prompt gives the exact card
// template the publish check enforces, and a check of the card's keys before proposing.
test("the prompt gives the exact Workflow card template the publish check enforces, and a key check before proposing", () => {
    assert.match(prompt, /`effects` is ONE plain text string, never a list or a map/);
    assert.match(prompt, /`outcomes` is required: a map keyed by the definition's TERMINAL STATE\s+IDs/);
    assert.match(prompt, /never by outcome values such as\s+`succeeded`/);
    assert.match(prompt, /`asks` is a map keyed by the definition's request state IDs and `sends`\s+a map keyed by its send state IDs/);
    assert.match(prompt, /`inputs\.example` is required when the definition has an input schema/);
    assert.match(prompt, /No other field: an unknown field is refused/);
    assert.match(prompt, /<terminal state id>: <words about this end>/);
    assert.match(prompt, /\*\*Before you propose a package with a Workflow:\*\* list the YAML's\s+terminal, request and send state IDs/);
    const skill = fs.readFileSync(path.join(pkgDir, "skills/agent-repair-loop/SKILL.md"), "utf8");
    assert.match(skill, /each terminal state ID \(the keys of the card's\s+`outcomes`\), not each outcome value/);
    assert.doesNotMatch(skill, /each outcome the card/);
});

test("a Workflow-only package is verified without adding an agent", () => {
    assert.match(prompt, /A package that ships only Workflow Definitions \(no agent\) is valid as it\s+is\. Never add an agent just to verify it\./);
    assert.match(prompt, /run it in test mode in your own session/);
    assert.match(prompt, /portal's new-session picker/);
});
