/**
 * The router pattern (owner 2026-11-08T00:35Z, "teach the router pattern now"): when different branches must run different
 * nodes at once (a different prompt, or a different model for each), agents write ONE Workflow: a parallel state over a
 * literal list of lanes, concurrency equal to their number, join all, a router script first in the body, one agent node per
 * lane (its own state id, so its own agent_models entry), and one item end whose output names the lane.
 *
 * It lives in its own on-demand skill, workflow-patterns (at most 8 KiB), so the authoring skill every Workflow-authoring
 * chat loads stays under 20 KiB (OF-S2-6: fewer tokens). The authoring skill, the base guidance and Agent Smith point to it.
 *
 * Named branches (slice 3): the same need is now taught as one parallel state with named branches, first, with its
 * own complete example (two-views); the router pattern stays as the older form, for branches that come from a list.
 *
 * Run: node --test test/unit/workflow-router-pattern.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
import { requireAgentModelsForRevision } from "../../dist/workflow/agent-models.js";
import { loadSkillsSync } from "../../dist/skills.js";
import { WORKFLOW_SESSION_GUIDANCE, WORKFLOW_SKILLS_DIR } from "../../dist/workflow/guidance.js";
// As the skill loader reads it (skills.ts: a Windows checkout's CRLF line ends are LF).
const read = relative => fs.readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const AUTHORING = read("../../plugins/workflow/skills/workflow-authoring/SKILL.md");
const REFERENCE = read("../../plugins/workflow/skills/workflow-reference/SKILL.md");
const PATTERNS = read("../../plugins/workflow/skills/workflow-patterns/SKILL.md");

/** One of the skill's examples: the fenced YAML block that starts with "# example: <name>". */
function example(name = "two-lane-summary") {
    const start = PATTERNS.indexOf(`\`\`\`yaml\n# example: ${name}`);
    assert.ok(start >= 0, `the patterns skill has the example ${name}`);
    const body = PATTERNS.slice(start + "```yaml\n".length);
    return body.slice(0, body.indexOf("\n```"));
}

test("the patterns skill's router example compiles: one parallel state over literal lanes, a router script, an agent node per lane", () => {
    const compiled = compileWorkflow(example());
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    const lanes = compiled.ir.nodes.lanes;
    assert.equal(lanes.type, "parallel");
    assert.equal(lanes.concurrency, 2, "every lane at once");
    assert.equal(lanes.body.initial, "route");
    assert.equal(compiled.ir.nodes.route.type, "script");
    assert.deepEqual(compiled.ir.nodes.route.outcomes.slice().sort(), ["careful", "quick"]);
    for (const id of ["quick_summary", "careful_summary"]) assert.equal(compiled.ir.nodes[id].type, "agent", id);
    // Each lane's agent node takes its own model at start.
    requireAgentModelsForRevision({ quick_summary: { model: "a:fast" }, careful_summary: { model: "a:strong" } }, compiled.ir, "the example");
});

test("workflow-patterns is an on-demand skill of its own, at most 8 KiB, that the registry lists beside the authoring skills", () => {
    const loaded = loadSkillsSync(WORKFLOW_SKILLS_DIR);
    const patterns = loaded.find(skill => skill.name === "workflow-patterns");
    assert.ok(patterns, "the registry lists workflow-patterns");
    assert.ok(Buffer.byteLength(patterns.prompt, "utf8") <= 8 * 1024, `${Buffer.byteLength(patterns.prompt, "utf8")} bytes`);
    // Its index card says when to load it.
    assert.match(patterns.description, /^Load when one Workflow must run different nodes in its branches at the same time/);
    // The section and its example moved: the skills every authoring chat loads stay under 20 KiB.
    for (const name of ["workflow-authoring", "workflow-reference"]) {
        const skill = loaded.find(item => item.name === name);
        assert.ok(Buffer.byteLength(skill.prompt, "utf8") <= 20 * 1024, `${name}: ${Buffer.byteLength(skill.prompt, "utf8")} bytes`);
        assert.ok(!skill.prompt.includes("# example: two-lane-summary"), name);
        assert.ok(!skill.prompt.includes("section 8a"), name);
    }
});

test("the patterns skill's named-branches example compiles: two branches, each its own graph and agent node, bounded by a time limit", () => {
    const compiled = compileWorkflow(example("two-views"));
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.deepEqual(compiled.diagnostics, [], "no warning: the parallel state has its own time limit");
    const views = compiled.ir.nodes.views;
    assert.equal(views.type, "parallel");
    assert.deepEqual(views.branches.map(branch => [branch.name, branch.initial]), [["quick", "quick_summary"], ["careful", "careful_summary"]]);
    assert.equal(views.concurrency, 2, "every branch at once");
    assert.equal(views.timeoutSeconds, 2400);
    // Each branch's agent node takes its own model at start.
    requireAgentModelsForRevision({ quick_summary: { model: "a:fast" }, careful_summary: { model: "a:strong" } }, compiled.ir, "the example");
});

test("named branches first, the router pattern as the older form: the patterns skill, authoring and the reference", () => {
    const named = PATTERNS.slice(PATTERNS.indexOf("## Different work in each branch at once: named branches"), PATTERNS.indexOf("## When the branches are data"));
    for (const want of ["write ONE parallel state\nwith named `branches`", "Do not split it into several Workflows.", "Its routes stay inside it.",
        "A branch has no `catchAll`", "its own\n  `agent_models` entry", "`joined` gives `{ <name>: output }`", "holds the winners only",
        "`${branch.name}`", "`WORKFLOW_BRANCH_UNBOUNDED`"]) {
        assert.ok(named.includes(want), want);
    }
    const router = PATTERNS.slice(PATTERNS.indexOf("## When the branches are data: the router pattern"));
    for (const want of ["The older form, for branches that come from a list", "router script", "`concurrency` is the number of lanes",
        "one item end whose output names the lane", "in the list's", "mechanical work, which scripts may do. Judgment still goes to an agent\nnode."]) {
        assert.ok(router.includes(want), want);
    }
    assert.ok(PATTERNS.indexOf("# example: two-views") < PATTERNS.indexOf("# example: two-lane-summary"), "named branches come first");
    // The authoring skill teaches named branches in its parallel section, and points to the patterns skill for an example.
    const parallel = AUTHORING.slice(AUTHORING.indexOf("## 8. Parallel states"), AUTHORING.indexOf("## 9."));
    assert.match(parallel, /Named branches run different nodes at once \(a prompt or a model for each\):\s+`branches: \{ <name>: \{ initial, states, input\? \} \}` instead of `forEach` and\s+`body`/);
    assert.match(parallel, /`joined` gives `\{ <name>: output \}` \(first k: the\s+winners only\)/);
    assert.match(parallel, /Give the state `timeoutSeconds` when a branch runs an agent\./);
    assert.match(parallel, /Never use several Workflows for this; `workflow-patterns` has an example\./);
    assert.match(AUTHORING, /\| Different nodes at once \(a prompt or a model for each branch\), then one join \| `parallel` with named `branches` \| several Workflows \|/);
    assert.match(AUTHORING, /`\$\{branch\.name\}`/);
    // The reference has the field, the joined output and the warning.
    assert.match(REFERENCE, /\| `branches` \| Instead of `forEach` and `body`: `\{ <name>: \{ initial, states, input\? \} \}`, 1 to 64/);
    assert.match(REFERENCE, /Named branches: `\{ <name>: output \}`, the winners only/);
    assert.match(REFERENCE, /`WORKFLOW_BRANCH_UNBOUNDED`/);
    assert.match(REFERENCE, /`branch\.name` in named branches/);
    // Review NB-R3: the guides state the rule: more than 16 branches need an explicit concurrency.
    assert.match(parallel, /`concurrency`\s+defaults to their number \(set it above 16\)/);
    assert.match(REFERENCE, /`concurrency` defaults to their number; above 16, set it\./);
    assert.match(named, /Above\s+16 branches, set it \(at most 16\)\./);
    // The base guidance names the authoring skill, which teaches named branches and points to the patterns skill (owner
    // 2026-11-08T16:55Z: the guidance keeps its rules; the details are in the skills).
    assert.match(WORKFLOW_SESSION_GUIDANCE, /call `load_skill` with name `workflow-authoring`/);
    assert.doesNotMatch(WORKFLOW_SESSION_GUIDANCE, /section 8a/);
    assert.doesNotMatch(REFERENCE, /section 8a/);
});
