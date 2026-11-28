import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { SessionManager } from "../../dist/session-manager.js";
import { loadSkillsSync } from "../../dist/skills.js";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
import { WORKFLOW_ENDED_NOTICE_MAX_BYTES, WORKFLOW_MAX_SEND_PAYLOAD_BYTES } from "../../dist/workflow/runtime.js";
import { WORKFLOW_JSON_MAX_DEPTH, WORKFLOW_PAYLOAD_MAX_BYTES } from "../../dist/workflow/json.js";
import { WORKFLOW_CARRY_MAX_BYTES } from "../../dist/workflow/carry.js";
import { SCRIPT_NODE_MAX_TOOL_CALLS } from "../../dist/workflow/runner.js";
import {
    WORKFLOW_AUTHORING_SKILL, WORKFLOW_SESSION_GUIDANCE, WORKFLOW_SKILLS_DIR, WORKFLOW_TEST_MODE_SKILLS_DIR,
} from "../../dist/workflow/guidance.js";

// The base's workflow guidance mentions testing only with workflow test mode on (Workflow Simplified, spec 16); these
// tests compare the prompt with the guidance as it is with test mode on. workflow-test-mode-switch.test.mjs covers it off.
process.env.PILOTSWARM_WORKFLOW_TEST_MODE = "on";

/**
 * The workflow-authoring skills (design 04; R24, T124; INACTIVE): loaded on
 * demand, kept out of every production worker tier, with complete examples
 * that the compiler accepts as they are written.
 */

const PLUGINS = fileURLToPath(new URL("../../plugins", import.meta.url));
const skills = () => loadSkillsSync(WORKFLOW_SKILLS_DIR);
// The testing guide is hidden with test mode (Workflow Simplified, spec 16): apart from the guides agents read.
const testModeSkills = () => loadSkillsSync(WORKFLOW_TEST_MODE_SKILLS_DIR);

test("the workflow skills load from their own plugin directory, which no worker tier loads", () => {
    assert.equal(path.resolve(WORKFLOW_SKILLS_DIR), path.join(PLUGINS, "workflow", "skills"));
    assert.deepEqual(skills().map(skill => skill.name).sort(), ["workflow-approval", "workflow-authoring", "workflow-carry", "workflow-decision", "workflow-limits", "workflow-long-agent",
        "workflow-patterns", "workflow-polling", "workflow-reference", "workflow-rerun", "workflow-schedules", "workflow-tools"]);
    assert.equal(path.resolve(WORKFLOW_TEST_MODE_SKILLS_DIR), path.join(PLUGINS, "workflow", "test-mode-skills"));
    assert.deepEqual(testModeSkills().map(skill => skill.name), ["workflow-testing"]);
    for (const skill of [...skills(), ...testModeSkills()]) {
        // The skills index clips a description at 240 characters; each body stays small enough to load on demand: 20 KiB,
        // and 8 KiB for workflow-patterns, which a session loads only when one Workflow runs different nodes per branch (OF-S2-6),
        // and for the basic how-to skills a session loads for one kind of state or schedule (workflow-decision, workflow-schedules),
        // and for the one table of size limits (workflow-limits).
        assert.ok(skill.description.length >= 80 && skill.description.length <= 240, `${skill.name} description: ${skill.description.length}`);
        const budget = ["workflow-decision", "workflow-limits", "workflow-patterns", "workflow-polling", "workflow-schedules"].includes(skill.name) ? 8 * 1024 : 20 * 1024;
        assert.ok(Buffer.byteLength(skill.prompt, "utf8") <= budget, `${skill.name} body: ${Buffer.byteLength(skill.prompt, "utf8")} bytes`);
        assert.ok(readFileSync(path.join(skill.dir, "SKILL.md")).byteLength <= budget, `${skill.name} file exceeds ${budget} bytes`);
    }
    // The worker's tiers 1 to 3 load plugins/system, plugins/mgmt and plugins/default-agents only.
    for (const tier of ["system", "mgmt", "default-agents"]) {
        assert.equal(loadSkillsSync(path.join(PLUGINS, tier, "skills")).filter(skill => skill.name.startsWith("workflow-")).length, 0, tier);
    }
    const core = skills().find(skill => skill.name === WORKFLOW_AUTHORING_SKILL);
    for (const phrase of ["workflow-reference", "complete_workflow_node", "needs_input", "all_required",
        "expected_revision", "definition_id", "Bound every loop"]) {
        assert.ok(core.prompt.includes(phrase), `the core skill covers: ${phrase}`);
    }
    assert.match(core.prompt, /Preserve descriptions \(graph labels\) and root\/state\/route notes when rewriting YAML unless asked to change them/);
    const reference = skills().find(skill => skill.name === "workflow-reference");
    for (const phrase of ["description", "graph label; id stays visible", "transition.notes", "16 KiB UTF-8",
        "never executed", "Absent keys stay absent", "editing notes makes a new revision/hash"]) {
        assert.ok(reference.prompt.includes(phrase), `the reference covers annotations: ${phrase}`);
    }
    // Owner decision i6-downstream: the size limits in one table, with the fan-out rule; the reference and the core skill point to it.
    const limits = skills().find(skill => skill.name === "workflow-limits");
    for (const phrase of ["keep only what you need from each child", "`full_output: true`", "`WORKFLOW_ENDED_WHOLE_OUTPUT`",
        `${WORKFLOW_ENDED_NOTICE_MAX_BYTES.toLocaleString("en-US")} bytes`,
        `| A \`send\` or \`request\` message (the state's input) | ${WORKFLOW_MAX_SEND_PAYLOAD_BYTES / 1024} KiB |`,
        `| A parallel join's output (all branches together) | ${WORKFLOW_PAYLOAD_MAX_BYTES / 1024} KiB |`,
        `| \`carry\` | ${WORKFLOW_CARRY_MAX_BYTES / 1024} KiB |`, `| JSON nesting, anywhere | ${WORKFLOW_JSON_MAX_DEPTH} levels |`,
        `| Tool calls in one script visit (a live run) | ${SCRIPT_NODE_MAX_TOOL_CALLS} |`]) {
        assert.ok(limits.prompt.includes(phrase), `workflow-limits covers: ${phrase}`);
    }
    // A child's end notice gives its values next to its fields (a model checked status "succeeded"); the values are pinned
    // in workflow-child-runtime.test.js.
    assert.ok(reference.prompt.includes("`status`: `completed` (`outcome` `succeeded` or `blocked`), `failed`, `cancelled` or `stopped`; `outcome`: the terminal state's, else `null`."));
    // The script tool-call cap is stated once per mode: live in workflow-limits, a test run's in the hidden testing guide.
    assert.match(core.prompt, /`callTool\(name, args\)`: one call at a time, capped \(`workflow-limits`\),/);
    assert.ok(!/at most \d+ calls/.test(core.prompt), "the core skill states no call count of its own");
    assert.ok(testModeSkills()[0].prompt.includes(`at most 100 tool calls (a live run allows ${SCRIPT_NODE_MAX_TOOL_CALLS}, \`workflow-limits\`)`));
    for (const name of ["workflow-reference", WORKFLOW_AUTHORING_SKILL]) {
        assert.match(skills().find(skill => skill.name === name).prompt, /keep only what you need (from each|per) child; size limits: `workflow-limits`\./, name);
    }
    // I9 depth rule: full depth rules & level table live in workflow-limits; workflow-authoring drops stale "level 3" text; user guide documents it.
    assert.ok(!core.prompt.includes("its children are level 3"), "workflow-authoring drops stale level 3 wording");
    assert.ok(core.prompt.includes("Step sits at its Workflow's level; first Workflow free, max level 2."), "workflow-authoring names I9 level-2 rule");
    for (const phrase of ["nothing goes past level 2", "first Workflow in a chain is free", "agent step", "three deep"]) {
        assert.ok(limits.prompt.toLowerCase().includes(phrase.toLowerCase()), `workflow-limits covers depth rule: ${phrase}`);
    }
    // I8 follow-up: workflow-limits states the 3 continued-session parallel limits/upgrade bullets.
    for (const phrase of ["(runId, stateId)", "`forEach` bodies allow `session: new` only", "saved again as a new revision to start"]) {
        assert.ok(limits.prompt.includes(phrase), `workflow-limits covers I8 parallel continue bullet: ${phrase}`);
    }
    const userGuide = readFileSync(fileURLToPath(new URL("../../../../docs/user-guide/workflows.md", import.meta.url)), "utf8");
    assert.ok(userGuide.includes("## How deep can sessions and Workflows go?"), "user guide has depth-rules section");
    assert.ok(userGuide.includes("#how-deep-can-sessions-and-workflows-go"), "A.4 cross-links depth-rules section");
    // The guides agents read do not teach test mode (spec 16): no test operation, test run or testing guide.
    for (const skill of skills()) {
        for (const word of ["workflow-testing", "test_respond", "test_advance", "test run", "test_waiting", "TEST_NEEDS_DRAFT"]) {
            assert.ok(!skill.prompt.includes(word), `${skill.name} does not mention ${word}`);
        }
    }
    assert.match(testModeSkills()[0].prompt, /Hidden \(Workflow Simplified, spec 16\)/);
});

// The CLI skips a skill whose front matter is not valid YAML, with no error: an unquoted ": " in a description dropped
// workflow-polling, then workflow-authoring. Each front matter parses strictly, to the name and description loaded.
test("every Workflow skill's front matter is strict YAML that gives its name and description", () => {
    for (const skill of [...skills(), ...testModeSkills()]) {
        const front = readFileSync(path.join(skill.dir, "SKILL.md"), "utf8").match(/^---\n([\s\S]*?)\n---\n/)?.[1];
        assert.ok(front, `${skill.name}: front matter`);
        const parsed = parseYaml(front);
        assert.equal(parsed.name, skill.name, `${skill.name}: name`);
        assert.equal(parsed.description, skill.description, `${skill.name}: description`);
    }
});

// Owner 2026-11-08T16:55Z: the trimmed guidance itself names the Workflow skills; the separate authoring pointer is gone.
test("the base names the Workflow skills in its guidance, scripts on or off, whatever skills the worker loaded", () => {
    const loaded = skills();
    const elsewhere = loaded.map(skill => ({ ...skill, dir: path.join(PLUGINS, "elsewhere", skill.name) }));
    // G-4: every turn can test a revision (its host runs tests), a frozen 1.0.82 turn's included: each is taught testing.
    const prompt = (workerSkills, scripts, version, requestTurn = true) => {
        const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "Legacy base.", ...(workerSkills ? { skills: workerSkills } : {}) });
        manager.workflowScriptsEnabled = scripts;
        return JSON.stringify(manager._buildSystemMessage("session", { baseAgentPolicy: { version, fingerprint: "test", revision: null },
            ...(requestTurn ? { workflowMilestoneTurn: true } : {}) }));
    };
    for (const version of ["v1", "v2"]) {
        for (const workerSkills of [loaded, undefined, [], elsewhere]) {
            for (const scripts of [true, false]) {
                const on = prompt(workerSkills, scripts, version);
                assert.equal(on.split("## Workflows").length - 1, 1, version);
                assert.ok(on.includes("call `load_skill` with name `workflow-authoring`"), version);
                assert.ok(on.includes(JSON.stringify(WORKFLOW_SESSION_GUIDANCE).slice(1, -1)), version);
                assert.ok(!on.includes("When an authorized task is a finite procedure"), "the old pointer is gone");
            }
            const frozen = prompt(workerSkills, true, version, false);
            assert.ok(!/tests do not run here/i.test(frozen), version);
            assert.ok(frozen.includes("Test a revision only when the user asks"), version);
        }
    }
});

test("every complete example in the workflow skills compiles as written, with no diagnostics, and together they use every state type", () => {
    const examples = [];
    for (const skill of [...skills(), ...testModeSkills()]) {
        for (const match of skill.prompt.matchAll(/```yaml\n([\s\S]*?)```/g)) {
            if (match[1].startsWith("# example: ")) examples.push({ skill: skill.name, name: match[1].split("\n")[0].slice("# example: ".length), yaml: match[1] });
        }
    }
    assert.deepEqual(examples.map(item => `${item.skill}/${item.name}`).sort(),
        ["workflow-approval/owner-consent", "workflow-authoring/build-watch", "workflow-carry/carry-retry", "workflow-decision/refund-guard",
            "workflow-decision/ticket-triage", "workflow-long-agent/long-agent", "workflow-patterns/two-lane-summary", "workflow-patterns/two-views",
            "workflow-polling/ci-poll", "workflow-polling/uncertain-send", "workflow-reference/change-review", "workflow-reference/child-dispatch", "workflow-schedules/follow-ups",
            "workflow-schedules/twice-daily", "workflow-testing/release-notes"]);
    const kinds = new Set();
    for (const example of examples) {
        const compiled = compileWorkflow(example.yaml);
        assert.equal(compiled.valid, true, `${example.name}: ${JSON.stringify(compiled.diagnostics)}`);
        assert.deepEqual(compiled.diagnostics, [], example.name);
        assert.equal(compiled.name, example.name);
        for (const node of Object.values(compiled.ir.nodes)) kinds.add(node.type === "messaging" ? node.mode : node.type);
    }
    assert.deepEqual([...kinds].sort(), ["agent", "approval", "decision", "parallel", "receive", "request", "script", "send", "spawn", "terminal", "wait"]);
});
