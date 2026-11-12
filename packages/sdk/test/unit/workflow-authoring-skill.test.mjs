import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../../dist/session-manager.js";
import { loadSkillsSync } from "../../dist/skills.js";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
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
    assert.deepEqual(skills().map(skill => skill.name).sort(), ["workflow-authoring", "workflow-patterns", "workflow-polling", "workflow-reference", "workflow-tools"]);
    assert.equal(path.resolve(WORKFLOW_TEST_MODE_SKILLS_DIR), path.join(PLUGINS, "workflow", "test-mode-skills"));
    assert.deepEqual(testModeSkills().map(skill => skill.name), ["workflow-testing"]);
    for (const skill of [...skills(), ...testModeSkills()]) {
        // The skills index clips a description at 240 characters; each body stays small enough to load on demand: 20 KiB,
        // and 8 KiB for workflow-patterns, which a session loads only when one Workflow runs different nodes per branch (OF-S2-6).
        assert.ok(skill.description.length >= 80 && skill.description.length <= 240, `${skill.name} description: ${skill.description.length}`);
        const budget = ["workflow-patterns", "workflow-polling"].includes(skill.name) ? 8 * 1024 : 20 * 1024;
        assert.ok(Buffer.byteLength(skill.prompt, "utf8") <= budget, `${skill.name} body: ${Buffer.byteLength(skill.prompt, "utf8")} bytes`);
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
    // The guides agents read do not teach test mode (spec 16): no test operation, test run or testing guide.
    for (const skill of skills()) {
        for (const word of ["workflow-testing", "test_respond", "test_advance", "test run", "test_waiting", "TEST_NEEDS_DRAFT"]) {
            assert.ok(!skill.prompt.includes(word), `${skill.name} does not mention ${word}`);
        }
    }
    assert.match(testModeSkills()[0].prompt, /Hidden \(Workflow Simplified, spec 16\)/);
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
        ["workflow-authoring/build-watch", "workflow-patterns/two-lane-summary", "workflow-patterns/two-views",
            "workflow-polling/ci-poll", "workflow-polling/uncertain-send", "workflow-reference/change-review", "workflow-testing/release-notes"]);
    const kinds = new Set();
    for (const example of examples) {
        const compiled = compileWorkflow(example.yaml);
        assert.equal(compiled.valid, true, `${example.name}: ${JSON.stringify(compiled.diagnostics)}`);
        assert.deepEqual(compiled.diagnostics, [], example.name);
        assert.equal(compiled.name, example.name);
        for (const node of Object.values(compiled.ir.nodes)) kinds.add(node.type === "messaging" ? node.mode : node.type);
    }
    assert.deepEqual([...kinds].sort(), ["agent", "parallel", "receive", "request", "script", "send", "terminal", "wait"]);
});
