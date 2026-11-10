/**
 * Model-facing Workflow text where a chat's tools differ (PR 270 text review, findings G-1 to G-11): the guidance and the
 * declarations name only tools the chat is declared, and only what its turn can do.
 *
 * - G-1: a chat inside a Workflow (an agent state's chat and its sub-agents) is declared neither workflow_definition nor
 *   update_workflow: its guidance has one sentence in the definition paragraphs' place.
 * - G-2: read_workflow sends a reader to update_workflow recover only where update_workflow is declared.
 * - G-3: a frozen 1.0.82 turn is not declared respond_session_request: its guidance does not name it.
 * - G-4: every turn's host runs a Workflow test, a frozen 1.0.82 turn's included: no line says tests do not run here.
 * - G-6: a Base V1 chat with Workflows on lists the Workflow skills in its skills index, so load_skill's "exactly as
 *   listed" holds; while they are off they stay unlisted (the Base V2 index's rule).
 * - G-9 and G-11: update_workflow declares no operation of a Workflow made before revisions, and the workflow-tools skill
 *   speaks of revisions and this chat's Workflows, not workflow children.
 *
 * The tests marked "(wiring)" read what session-manager.ts and managed-session.ts pass; the others the text itself.
 *
 * Run: node --test test/unit/workflow-model-text-variants.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManagedSession } from "../../dist/managed-session.js";
import { SessionManager } from "../../dist/session-manager.js";
import { PilotSwarmWorker } from "../../dist/worker.js";
import * as guidance from "../../dist/workflow/guidance.js";
import {
    READ_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC, READ_WORKFLOW_MILESTONE_TOOL_SPEC, READ_WORKFLOW_TOOL_SPEC, readWorkflowToolSpec,
    UPDATE_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC, UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC, UPDATE_WORKFLOW_TOOL_SPEC, updateWorkflowFromTool,
} from "../../dist/workflow/v2/tools.js";
import { workflowDefinitionToolSpec } from "../../dist/workflow/v2/definition-tool.js";

const {
    SKILLS_INDEX_HEADING, WORKFLOW_INSIDE_GUIDANCE, WORKFLOW_PERSON_CONTROL_GUIDANCE, WORKFLOW_SESSION_GUIDANCE, WORKFLOW_V2_SKILLS_DIR,
    WORKFLOW_V2_TEST_MODE_SKILLS_DIR,
    isWorkflowSkill, skillsIndexLine, skillsIndexSection, withWorkflowSkillsListed, workflowSessionGuidance,
} = guidance;

const REQUEST_SENTENCE = "`request`: answer it once with `respond_session_request` before its deadline, never in chat.";
const TEST_LINE = "Test a revision only when the user asks, or before you publish it in a package; `start` never needs a test.";
const V1 = { version: "v1", fingerprint: "test", revision: null };
const V2 = { version: "v2", fingerprint: "test", revision: null };
const named = (defs, name) => defs.find(def => def.name === name);

// ─── G-1: inside a Workflow ───

test("G-1: inside a Workflow the guidance has one sentence for the definition paragraphs, and no line on writing or testing one", () => {
    assert.equal(WORKFLOW_INSIDE_GUIDANCE, "Inside a Workflow you cannot write or start Workflow Definitions; report what you need in your result.");
    for (const testMode of [false, true]) for (const scripts of [false, true]) for (const clockWaits of [false, true]) {
        const label = `test mode ${testMode}, scripts ${scripts}, clock waits ${clockWaits}`;
        const inside = workflowSessionGuidance(testMode, { scripts, clockWaits, requests: true, insideWorkflow: true });
        assert.ok(inside.startsWith(`## Workflows\n\n${WORKFLOW_INSIDE_GUIDANCE}\n\nFollow a Workflow with \`read_workflow\``), label);
        assert.ok(inside.endsWith(REQUEST_SENTENCE), label);
        // Tools it is not declared, and the lines on writing, testing or scripting a definition.
        for (const word of ["workflow_definition", "update_workflow", "load_skill", "Definitions belong", "Test a revision", "A save with errors",
            "test_waiting", "A wait state can wait until a clock time", "Script nodes are off"]) {
            assert.ok(!inside.includes(word), `${label}: ${word}`);
        }
        // Every other chat keeps the definition paragraphs.
        const outside = workflowSessionGuidance(testMode, { scripts, clockWaits, requests: true });
        assert.ok(outside.includes("call `load_skill` with name `workflow-authoring`") && outside.includes(TEST_LINE), label);
        assert.ok(!outside.includes(WORKFLOW_INSIDE_GUIDANCE), label);
        assert.equal(workflowSessionGuidance(testMode, { scripts, clockWaits, requests: true, insideWorkflow: false }), outside, label);
    }
    assert.equal(workflowSessionGuidance(false, { insideWorkflow: true, requests: false }),
        `## Workflows\n\n${WORKFLOW_INSIDE_GUIDANCE}\n\n${WORKFLOW_SESSION_GUIDANCE.split("\n\n").at(-1)
            .replace(` ${REQUEST_SENTENCE} ${WORKFLOW_PERSON_CONTROL_GUIDANCE}`, "")}`);
});

test("G-1 (wiring): a session inside a Workflow carries the inside guidance; a chat outside every Workflow, the full guidance", () => {
    const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "Legacy base." });
    for (const version of [V1, V2]) {
        const inside = JSON.stringify(manager._buildSystemMessage("inside", { baseAgentPolicy: version, workflowMilestoneTurn: true,
            workflowInsideWorkflow: true, workflowAgentChild: true, workflowContext: "on" }));
        assert.ok(inside.includes(WORKFLOW_INSIDE_GUIDANCE), version.version);
        assert.ok(!inside.includes("workflow_definition") && !inside.includes("Definitions belong to this chat"), version.version);
        const outside = JSON.stringify(manager._buildSystemMessage("outside", { baseAgentPolicy: version, workflowMilestoneTurn: true,
            workflowContext: "on" }));
        assert.ok(!outside.includes(WORKFLOW_INSIDE_GUIDANCE) && outside.includes("Definitions belong to this chat"), version.version);
    }
});

// ─── G-2: read_workflow's recover sentence ───

test("G-2: read_workflow names update_workflow recover only where update_workflow is declared", () => {
    const recover = "A run that shows needsRecovery needs update_workflow recover.";
    for (const milestone of [false, true]) for (const testMode of [false, true]) {
        const label = `milestone ${milestone}, test mode ${testMode}`;
        const declared = readWorkflowToolSpec({ milestone, testMode });
        assert.ok(declared.description.includes(recover), label);
        assert.equal(readWorkflowToolSpec({ milestone, testMode, updateWorkflow: true }), declared, label);
        const inside = readWorkflowToolSpec({ milestone, testMode, updateWorkflow: false });
        assert.ok(!inside.description.includes("update_workflow") && !inside.description.includes("needsRecovery"), label);
        assert.equal(inside.description, declared.description.replace(` ${recover}`, ""), label);
        assert.deepEqual(inside.parameters, declared.parameters, label);
    }
    assert.equal(readWorkflowToolSpec({ milestone: false, testMode: false }), READ_WORKFLOW_TOOL_SPEC);
    assert.equal(readWorkflowToolSpec({ milestone: true, testMode: false }), READ_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC);
    assert.equal(readWorkflowToolSpec({ milestone: true, testMode: true }), READ_WORKFLOW_MILESTONE_TOOL_SPEC);
});

test("G-2 (wiring): a session inside a Workflow is declared read_workflow without update_workflow recover", () => {
    const inside = ManagedSession.subAgentToolDefs({ workflowMilestone: true, workflowAgentChild: true, workflowInsideWorkflow: true });
    assert.equal(named(inside, "update_workflow"), undefined);
    assert.ok(!named(inside, "read_workflow").description.includes("update_workflow"), named(inside, "read_workflow").description);
    const outside = ManagedSession.subAgentToolDefs({ workflowMilestone: true });
    assert.ok(named(outside, "read_workflow").description.includes("update_workflow recover"));
});

// ─── G-3: respond_session_request on a frozen 1.0.82 turn ───

test("G-3: the request sentence names respond_session_request only where it is declared", () => {
    // UXP-AD-01: the person's control sentence follows it (a chat that controls its Workflows).
    assert.ok(WORKFLOW_SESSION_GUIDANCE.endsWith(`${REQUEST_SENTENCE} ${WORKFLOW_PERSON_CONTROL_GUIDANCE}`));
    for (const testMode of [false, true]) for (const scripts of [false, true]) {
        const frozen = workflowSessionGuidance(testMode, { scripts, requests: false });
        assert.ok(!frozen.includes("respond_session_request") && !frozen.includes("`request`:"), `${testMode} ${scripts}`);
        assert.ok(frozen.includes("`ended`: tell the user the result briefly; start no other run unless asked."));
        for (const requests of [true, undefined]) {
            assert.ok(workflowSessionGuidance(testMode, { scripts, requests }).includes(REQUEST_SENTENCE), `${testMode} ${scripts} ${requests}`);
        }
    }
});

test("G-3 (wiring): a frozen 1.0.82 turn's guidance does not name respond_session_request; a 1.0.83 turn's does", () => {
    const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "Legacy base." });
    const frozen = JSON.stringify(manager._buildSystemMessage("frozen", { baseAgentPolicy: V2, workflowContext: "on" }));
    assert.ok(frozen.includes("## Workflows") && !frozen.includes("respond_session_request"));
    assert.equal(named(ManagedSession.subAgentToolDefs(), "respond_session_request"), undefined, "not declared there");
    const current = JSON.stringify(manager._buildSystemMessage("current", { baseAgentPolicy: V2, workflowMilestoneTurn: true, workflowContext: "on" }));
    assert.ok(current.includes("respond_session_request"));
});

// ─── G-4: tests run on every turn ───

test("G-4: every turn's host runs a Workflow test, so no guidance says tests do not run here", () => {
    assert.equal(Object.hasOwn(guidance, "WORKFLOW_TESTS_UNAVAILABLE_GUIDANCE"), false);
    for (const requests of [false, true]) for (const testMode of [false, true]) {
        const text = workflowSessionGuidance(testMode, { scripts: true, clockWaits: requests, requests });
        assert.ok(text.includes(TEST_LINE), `requests ${requests}`);
        assert.ok(!/tests do not run here|has no `test`/i.test(text), `requests ${requests}`);
    }
    // The declaration always has the test operation (every turn's host runs a test, a frozen 1.0.82 turn's too).
    assert.ok(workflowDefinitionToolSpec().parameters.properties.operation.enum.includes("test"));
});

test("G-4 (wiring): workflow_definition declares test on a frozen 1.0.82 turn too", () => {
    for (const workflowMilestone of [false, true]) {
        const definition = named(ManagedSession.subAgentToolDefs(workflowMilestone ? { workflowMilestone } : {}), "workflow_definition");
        assert.ok(definition.parameters.properties.operation.enum.includes("test"), `1.0.83 ${workflowMilestone}`);
        assert.ok(definition.description.includes("test: only when the user asks"), `1.0.83 ${workflowMilestone}`);
    }
});

// ─── G-6: the Base V1 skills index ───

function buildWorker() {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-wf-text-variants-"));
    return new PilotSwarmWorker({ sessionStateDir: path.join(stateDir, "session-state"), pluginDirs: [], workerNodeId: "test-wf-text-variants" });
}

const WORKFLOW_SKILLS = ["workflow-authoring", "workflow-patterns", "workflow-reference", "workflow-tools"];
const indexed = (prompt, name) => prompt.split("\n").filter(line => line.startsWith(`- \`${name}\``)).length;
const indexLines = prompt => {
    const head = prompt.indexOf(`${SKILLS_INDEX_HEADING}\n\n`);
    return prompt.slice(head).split("\n").filter(line => line.startsWith("- `"));
};

test("G-6: the shared V1 index leaves the Workflow skills out; withWorkflowSkillsListed lists each once, in name order", () => {
    const worker = buildWorker();
    const shared = worker._frameworkBasePrompt;
    for (const name of WORKFLOW_SKILLS) {
        assert.equal(indexed(shared, name), 0, `unlisted in the shared base: ${name}`);
        assert.ok(worker._loadableSkills.some(skill => skill.name === name && isWorkflowSkill(skill)), `loadable: ${name}`);
    }
    const listed = withWorkflowSkillsListed(shared, worker._loadableSkills);
    assert.equal(listed.split(SKILLS_INDEX_HEADING).length - 1, 1, "one index");
    for (const name of WORKFLOW_SKILLS) assert.equal(indexed(listed, name), 1, `listed once: ${name}`);
    const lines = indexLines(listed);
    const names = lines.map(line => /^- `([^`]*)`/.exec(line)[1]);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "in name order");
    // Only lines are added: every line of the shared index stays, and the text before the index is unchanged.
    for (const line of indexLines(shared)) assert.ok(lines.includes(line), line);
    assert.equal(listed.slice(0, listed.indexOf(SKILLS_INDEX_HEADING)), shared.slice(0, shared.indexOf(SKILLS_INDEX_HEADING)));
    const authoring = worker._loadableSkills.find(skill => skill.name === "workflow-authoring");
    assert.ok(lines.includes(skillsIndexLine(authoring)));
    // Twice is once; nothing changes without a Workflow skill or a base.
    assert.equal(withWorkflowSkillsListed(listed, worker._loadableSkills), listed);
    assert.equal(withWorkflowSkillsListed(shared, worker._loadableSkills.filter(skill => !isWorkflowSkill(skill))), shared);
    assert.equal(withWorkflowSkillsListed(undefined, worker._loadableSkills), undefined);
});

test("G-6: a base without a skills index gets one with the Workflow skills; other directories are not Workflow skills", () => {
    const skills = [
        { name: "workflow-tools", description: "Every argument.", dir: path.join(WORKFLOW_V2_SKILLS_DIR, "workflow-tools") },
        { name: "workflow-testing", description: "Tests.", dir: path.join(WORKFLOW_V2_TEST_MODE_SKILLS_DIR, "workflow-testing") },
        { name: "canvas-apps", description: "Canvas.", dir: path.join(os.tmpdir(), "skills", "canvas-apps") },
        { name: "no-dir", description: "None." },
    ];
    assert.deepEqual(skills.map(isWorkflowSkill), [true, true, false, false]);
    assert.equal(withWorkflowSkillsListed("Base.", skills),
        `Base.\n\n${skillsIndexSection(["- `workflow-testing` — Tests.", "- `workflow-tools` — Every argument."])}`);
    // A section after the index stays after it.
    const base = `Base.\n\n${skillsIndexSection(["- `alpha` — A.", "- `zeta` — Z."])}\n\n## After\n\nMore.`;
    assert.equal(withWorkflowSkillsListed(base, skills),
        `Base.\n\n${skillsIndexSection(["- `alpha` — A.", "- `workflow-testing` — Tests.", "- `workflow-tools` — Every argument.", "- `zeta` — Z."])}\n\n## After\n\nMore.`);
});

test("G-6 (wiring): a Base V1 chat lists the Workflow skills in its skills index only while Workflows are on in it", () => {
    const worker = buildWorker();
    const manager = new SessionManager(undefined, null, { frameworkBasePrompt: worker._frameworkBasePrompt, skills: worker._loadableSkills });
    const prompt = context => JSON.parse(JSON.stringify(manager._buildSystemMessage(`v1-${context}`, { baseAgentPolicy: V1, workflowContext: context })));
    const text = value => JSON.stringify(value);
    for (const name of WORKFLOW_SKILLS) {
        assert.ok(text(prompt("on")).includes(`- \`${name}\``), `on: ${name}`);
        assert.ok(!text(prompt("off")).includes(`- \`${name}\``), `off: ${name}`);
    }
});

// ─── G-9: update_workflow's declaration ───

test("G-9: update_workflow declares no operation or argument of a Workflow made before revisions; a stale call is still answered", async () => {
    const before = ["replace_definition", "publish", "publish_and_start", "start"];
    for (const spec of [UPDATE_WORKFLOW_TOOL_SPEC, UPDATE_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC, UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC]) {
        const operations = spec.parameters.properties.operation.enum;
        for (const operation of before) assert.ok(!operations.includes(operation), operation);
        assert.doesNotMatch(spec.description, /replace_definition|publish|before revisions/);
        for (const operation of ["set_vars", "pause", "resume", "cancel", "recover"]) assert.ok(operations.includes(operation), operation);
        for (const name of ["yaml", "notify_on_completion"]) assert.equal(Object.hasOwn(spec.parameters.properties, name), false, name);
        assert.ok(spec.description.includes("To change or start a definition use workflow_definition."));
    }
    for (const spec of [UPDATE_WORKFLOW_TOOL_SPEC, UPDATE_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC]) {
        for (const name of ["expected_revision", "definition_hash", "inputs", "vars"]) assert.equal(Object.hasOwn(spec.parameters.properties, name), false, name);
    }
    // With test mode on, test takes the draft's revision, hash, inputs and variables (the workflow-testing skill).
    for (const name of ["expected_revision", "definition_hash", "inputs", "vars"]) {
        assert.ok(Object.hasOwn(UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC.parameters.properties, name), name);
    }
    // The handler still answers a stale call of a definition operation with a coded answer, not as an unknown operation.
    const host = {
        catalog: { getSession: async () => null },
        store: { readDefinition: async () => null },
        duroxideClient: {}, requests: true,
    };
    for (const operation of before) {
        const answer = JSON.parse(await updateWorkflowFromTool({ workflow_id: "wf", operation_id: "op-1", operation, yaml: "x",
            expected_revision: 1, definition_hash: "h", inputs: {} }, { callerSessionId: "parent", host }));
        assert.equal(answer.ok, false, operation);
        assert.ok(!/^operation must be/.test(answer.error.message), `${operation}: ${answer.error.message}`);
    }
});

// ─── G-11: the workflow-tools skill ───

test("G-11: the workflow-tools skill speaks of revisions and this chat's Workflows, not workflow children", () => {
    const text = fs.readFileSync(path.join(WORKFLOW_V2_SKILLS_DIR, "workflow-tools", "SKILL.md"), "utf8");
    const flat = text.replace(/\s+/g, " ");
    for (const old of ["workflow child", "creating agent", "Workflows made before definitions had revisions", "replace_definition",
        "publish_and_start", "PINNED_TO_CHAT_REVISION", "WORKFLOW_REVISION_LIMIT"]) {
        assert.ok(!flat.includes(old), old);
    }
    for (const phrase of [
        "| `SEMVER_IMMUTABLE`, `DEFINITION_IMMUTABLE` | A Workflow keeps its revision; it never changes. Save a new revision with `workflow_definition`, then start it. |",
        "| `LIVE_RUN_EXISTS` | This Workflow already has its live run. To run the definition again, `start` it again: each start is a new Workflow. |",
        "| `FORBIDDEN`, `WORKFLOW_NOT_FOUND` | `update_workflow` and `read_workflow` take only this chat's Workflows: those started from its definitions, by you or the person. A person changes theirs in the Workflow tab. |",
        "It controls a Workflow's run; to change or start a definition, use `workflow_definition`.",
    ]) assert.ok(flat.includes(phrase), phrase);
    assert.ok(Buffer.byteLength(text, "utf8") <= 20 * 1024, `${Buffer.byteLength(text, "utf8")} bytes`);
});
