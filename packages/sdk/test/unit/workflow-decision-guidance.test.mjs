/** Run after the SDK build: node --test test/unit/workflow-decision-guidance.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { loadSkills } from "../../dist/skills.js";
import { SessionManager } from "../../dist/session-manager.js";
import { WORKFLOW_DECISION_GUIDANCE, WORKFLOW_SESSION_GUIDANCE, WORKFLOW_SKILLS_DIR, workflowSessionGuidance } from "../../dist/workflow/guidance.js";

// CHK 0.8.14 rollout: a session built before the Cluster Decision Default was set kept saying "Decision nodes are
// unavailable" for its whole life, because the system message carried the worker's cached capability and a warm session is
// not rebuilt. The prompt now never states availability or a default model; save and Start check it live.
const STATIC = "Save flags and Start refuses Decision states without an eligible Cluster Decision Default.";
const CLAIMS = [/Decision nodes are (un)?available/, /available with default/, /no eligible Cluster Decision Default/];

test("the Workflow guidance carries one static Decision line and no availability claim", () => {
    assert.equal(WORKFLOW_DECISION_GUIDANCE, STATIC);
    assert.equal(WORKFLOW_SESSION_GUIDANCE.split(STATIC).length - 1, 1);
    for (const claim of CLAIMS) assert.doesNotMatch(WORKFLOW_SESSION_GUIDANCE, claim);
    for (const testMode of [false, true]) {
        for (const scripts of [false, true]) {
            const text = workflowSessionGuidance(testMode, { scripts });
            assert.equal(text.split(STATIC).length - 1, 1, text);
            for (const claim of CLAIMS) assert.doesNotMatch(text, claim);
            assert.match(text, /call `load_skill` with name `workflow-authoring`/);
        }
    }
});

test("a session inside a Workflow receives no Decision-authoring line", () => {
    const text = workflowSessionGuidance(false, { insideWorkflow: true });
    assert.match(text, /Inside a Workflow you cannot write or start Workflow Definitions/);
    assert.ok(!text.includes(STATIC));
    assert.ok(!text.includes("call `load_skill` with name `workflow-authoring`"));
});

test("a session's prompt carries the static Decision line and states nothing about Decision availability", async () => {
    const skills = await loadSkills(WORKFLOW_SKILLS_DIR);
    const authoring = skills.find(skill => skill.name === "workflow-authoring");
    assert.ok(authoring, "the Workflow authoring skill remains registered on an unconfigured cluster");
    const manager = new SessionManager(undefined, null, { skills, frameworkBasePrompt: "Legacy base." });
    const prompt = JSON.stringify(manager._buildSystemMessage("decision-default", {
        workflowContext: "on", baseAgentPolicy: { version: "v1", fingerprint: "test", revision: null },
    }));
    assert.ok(prompt.includes("workflow-authoring"));
    assert.ok(prompt.includes(STATIC), "the session prompt carries the static Decision line");
    for (const claim of CLAIMS) assert.doesNotMatch(prompt, claim);
    // Owner 2026-11-22T07:36Z: the basic instructions for a Decision state live in their own skill, next to the others.
    assert.match(authoring.prompt, /For a `decision` state, call `load_skill` with name `workflow-decision`\./);
    const decision = skills.find(skill => skill.name === "workflow-decision");
    assert.ok(decision, "the workflow-decision skill is registered");
    assert.ok(decision.prompt.includes(STATIC), "the skill says what Save and Start do without an eligible default");
    assert.match(decision.prompt, /`set_model_default` with scope `cluster` and purpose `decision`/);
    assert.match(decision.prompt, /call the `decide` tool/);
});
