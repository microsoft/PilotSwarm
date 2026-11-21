/** Run after the SDK build: node --test test/unit/workflow-decision-guidance.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { loadSkills } from "../../dist/skills.js";
import { SessionManager } from "../../dist/session-manager.js";
import { WORKFLOW_DECISION_GUIDANCE, WORKFLOW_SESSION_GUIDANCE, WORKFLOW_SKILLS_DIR, workflowSessionGuidance } from "../../dist/workflow/guidance.js";

// CHK 0.8.14 rollout: a session built before the Cluster Decision Default was set kept saying "Decision nodes are
// unavailable" for its whole life, because the system message carried the worker's cached capability and a warm session is
// not rebuilt. The prompt now never states availability or a default model; save and Start check it live.
const STATIC = "Decision availability is checked live: save marks a Decision state invalid, and Start refuses it, when no eligible Decision model is configured; the error says what to do.";
const CLAIMS = [/Decision nodes are (un)?available/, /available with default/, /no eligible Cluster Decision Default/];
const unset = { available: false, defaultModel: null, models: [], reason: "no_cluster_decision_default" };
const configured = { available: true, defaultModel: "team:decision-model", models: ["team:decision-model"], reason: null };

test("the Workflow guidance carries one static Decision line and no availability claim, whatever is configured", () => {
    assert.equal(WORKFLOW_DECISION_GUIDANCE, STATIC);
    assert.equal(WORKFLOW_SESSION_GUIDANCE.split(STATIC).length - 1, 1);
    for (const claim of CLAIMS) assert.doesNotMatch(WORKFLOW_SESSION_GUIDANCE, claim);
    for (const testMode of [false, true]) {
        for (const scripts of [false, true]) {
            const text = workflowSessionGuidance(testMode, { scripts });
            assert.equal(text.split(STATIC).length - 1, 1, text);
            for (const claim of CLAIMS) assert.doesNotMatch(text, claim);
            assert.ok(!text.includes("team:decision-model"));
            assert.match(text, /call `load_skill` with name `workflow-authoring`/);
        }
    }
});

test("the guidance no longer takes a Decision capability: a configured and an unset cluster give the same text", () => {
    for (const testMode of [false, true]) {
        const plain = workflowSessionGuidance(testMode, { scripts: true });
        assert.equal(workflowSessionGuidance(testMode, { scripts: true, decision: configured }), plain);
        assert.equal(workflowSessionGuidance(testMode, { scripts: true, decision: unset }), plain);
    }
});

test("a session inside a Workflow receives no Decision-authoring line", () => {
    const text = workflowSessionGuidance(false, { insideWorkflow: true });
    assert.match(text, /Inside a Workflow you cannot write or start Workflow Definitions/);
    assert.ok(!text.includes(STATIC));
    assert.ok(!text.includes("call `load_skill` with name `workflow-authoring`"));
});

test("a session's prompt states nothing about Decision availability, whether the default is unset or configured", async () => {
    const skills = await loadSkills(WORKFLOW_SKILLS_DIR);
    const authoring = skills.find(skill => skill.name === "workflow-authoring");
    assert.ok(authoring, "the Workflow authoring skill remains registered on an unconfigured cluster");
    const prompts = [];
    for (const decision of [unset, configured]) {
        const manager = new SessionManager(undefined, null, { skills, frameworkBasePrompt: "Legacy base." });
        // A worker of the previous release handed the manager its cached capability here; it has no effect on the prompt.
        manager.setModelProviders(null, { decision });
        const prompt = JSON.stringify(manager._buildSystemMessage("decision-default", {
            workflowContext: "on", baseAgentPolicy: { version: "v1", fingerprint: "test", revision: null },
        }));
        assert.ok(prompt.includes("workflow-authoring"));
        assert.ok(prompt.includes(STATIC), "the session prompt carries the static Decision line");
        for (const claim of CLAIMS) assert.doesNotMatch(prompt, claim);
        assert.ok(!prompt.includes("team:decision-model"));
        prompts.push(prompt);
    }
    assert.equal(prompts[0], prompts[1], "an unset and a configured Cluster Decision Default give the same prompt");
    const guard = authoring.prompt.split("\n").find(line => line.includes("workflows.decision.available"));
    assert.ok(guard, "the skill must gate Decision authoring on workflows.decision.available");
    assert.match(guard, /\btrue\b/);
    assert.match(guard, /\b(?:only|unless)\b/i, "the skill says to use Decision only while that capability is available");
});
