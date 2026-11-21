/** Run after the SDK build: node --test test/unit/workflow-decision-guidance.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { loadSkills } from "../../dist/skills.js";
import { SessionManager } from "../../dist/session-manager.js";
import { WORKFLOW_SKILLS_DIR, workflowSessionGuidance } from "../../dist/workflow/guidance.js";

const UNAVAILABLE = "Decision nodes are unavailable: no eligible Cluster Decision Default is configured.";
const AVAILABLE = "Decision nodes are available with default team:decision-model.";
const unset = { available: false, defaultModel: null, models: [], reason: "no_cluster_decision_default" };
const stale = { ...unset, reason: "cluster_decision_default_ineligible" };
const configured = { available: true, defaultModel: "team:decision-model", models: ["team:decision-model"], reason: null };

test("Workflow authoring guidance names the missing-default gate when Decision is absent, unset or stale", () => {
    for (const decision of [undefined, unset, stale]) {
        for (const scripts of [false, true]) {
            const text = workflowSessionGuidance(false, { decision, scripts });
            assert.ok(text.includes(UNAVAILABLE), text);
            assert.equal(text.split(UNAVAILABLE).length - 1, 1);
            assert.ok(!text.includes("Decision nodes are available with default"));
            assert.match(text, /call `load_skill` with name `workflow-authoring`/);
        }
    }
});

test("Workflow authoring guidance names the configured qualified Decision default only while available", () => {
    for (const testMode of [false, true]) {
        const text = workflowSessionGuidance(testMode, { decision: configured, scripts: true });
        assert.ok(text.includes(AVAILABLE), text);
        assert.equal(text.split(AVAILABLE).length - 1, 1);
        assert.ok(!text.includes(UNAVAILABLE));
        assert.ok(!text.includes("team:chat-model"));
    }
});

test("a session inside a Workflow still receives no Decision-authoring recommendation", () => {
    const text = workflowSessionGuidance(false, { decision: configured, insideWorkflow: true });
    assert.match(text, /Inside a Workflow you cannot write or start Workflow Definitions/);
    assert.ok(!text.includes(AVAILABLE));
    assert.ok(!text.includes("call `load_skill` with name `workflow-authoring`"));
});

test("an unavailable Decision capability does not remove the Workflow authoring skill from the real loadable catalog or prompt index", async () => {
    const skills = await loadSkills(WORKFLOW_SKILLS_DIR);
    const authoring = skills.find(skill => skill.name === "workflow-authoring");
    assert.ok(authoring, "the Workflow authoring skill remains registered on an unconfigured cluster");
    const manager = new SessionManager(undefined, null, { skills, frameworkBasePrompt: "Legacy base." });
    const prompt = JSON.stringify(manager._buildSystemMessage("no-decision-default", {
        workflowContext: "on", baseAgentPolicy: { version: "v1", fingerprint: "test", revision: null },
    }));
    assert.ok(prompt.includes("workflow-authoring"));
    assert.ok(prompt.includes(UNAVAILABLE), "the default session prompt does not advertise unavailable Decision nodes");
    const guard = authoring.prompt.split("\n").find(line => line.includes("workflows.decision.available"));
    assert.ok(guard, "the skill must gate Decision authoring on workflows.decision.available");
    assert.match(guard, /\btrue\b/);
    assert.match(guard, /\b(?:only|unless)\b/i, "the skill says to use Decision only while that capability is available");
});
