import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../dist/session-manager.js";
import { SPAWN_WORKFLOW_TOOL_SPEC } from "../../dist/workflow/tool-spec.js";
import { WORKFLOW_SESSION_GUIDANCE } from "../../dist/workflow/guidance.js";

test("workflow guidance teaches bounded selection, correct bindings and controller-owned waits", () => {
    const block = WORKFLOW_SESSION_GUIDANCE;
    for (const phrase of ["When `spawn_workflow` is available", "already-authorized, finite", "without an LLM turn",
        "new judgment", "does not expand permissions", "context.input", "context.inputs", "top-level `return`",
        "transition.delaySeconds", "survives worker restart", "1 to 3,600", "1,000 script-state executions",
        "notify_on_completion", "not an instruction to start another", "actual terminal result"]) {
        assert.ok(block.includes(phrase), `Missing guidance: ${phrase}`);
    }
});

test("both base policies receive workflow guidance only when the worker enables workflows", () => {
    const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "Legacy base." });
    for (const version of ["v1", "v2"]) {
        const config = { baseAgentPolicy: { version, fingerprint: "test", revision: null } };
        manager.workflowScriptsEnabled = false;
        assert.ok(!JSON.stringify(manager._buildSystemMessage("session", config)).includes("## Workflow Sessions"));
        manager.workflowScriptsEnabled = true;
        const prompt = JSON.stringify(manager._buildSystemMessage("session", config));
        assert.equal(prompt.split("## Workflow Sessions").length - 1, 1);
        assert.ok(prompt.includes("context.input"));
        assert.ok(prompt.includes("transition.delaySeconds"));
    }
});

test("workflow authoring shows the actual previous-output binding and separates durable delay from script waiting", () => {
    const text = SPAWN_WORKFLOW_TOOL_SPEC.description;
    assert.match(text, /const previous = context\.input;/);
    assert.match(text, /not bare `input` or `context\.result`/);
    assert.match(text, /return is not/);
    assert.match(text, /Workflows CAN wait durably through transition\.delaySeconds/);
    assert.match(text, /Do not use sleep or JavaScript timers/);
});

test("a new v2 workflow stays a draft unless the person asks to run it now; then it publishes and starts (flow-10)", () => {
    const text = SPAWN_WORKFLOW_TOOL_SPEC.description;
    assert.match(text, /Keep the default draft unless the person asks to run the workflow now/);
    assert.match(text, /When they do ask to run it now, pass state: published with start: true\./);
    const { state, start } = SPAWN_WORKFLOW_TOOL_SPEC.parameters.properties;
    assert.match(state.description, /draft \(default, runs nothing; keep it unless the person asks to run the workflow now\)/);
    assert.match(start.description, /when the person asks to run the workflow now/);
});

// Workflow Simplified (Run again in stage 1, owner feedback 2026-11-06): another Workflow of a definition is the same YAML
// spawned again, with no key or a new one. Renaming the definition made a new definition instead of a second Workflow.
test("another Workflow from the same definition: the same YAML, no key or a new one, never a renamed definition", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { WORKFLOW_V2_SKILLS_DIR } = await import("../../dist/workflow/guidance.js");
    const skill = fs.readFileSync(path.join(WORKFLOW_V2_SKILLS_DIR, "workflow-authoring", "SKILL.md"), "utf8").replace(/\s+/g, " ");
    for (const [where, text] of [["base guidance", WORKFLOW_SESSION_GUIDANCE], ["authoring skill", skill]]) {
        assert.ok(text.includes("To start another Workflow from a definition, call `spawn_workflow` again with the same YAML, unchanged "
            + "(the same `metadata.name` and `version`) and no `key` or a new one"), where);
        assert.ok(text.includes("Never rename the definition: a new name makes a new definition."), where);
    }
    assert.ok(WORKFLOW_SESSION_GUIDANCE.includes("an old key returns the Workflow it named"));
    assert.ok(WORKFLOW_SESSION_GUIDANCE.includes("for version 2, pass `state: published` and `start: true` with the inputs"));
    const key = SPAWN_WORKFLOW_TOOL_SPEC.parameters.properties.key.description;
    assert.match(key, /^Optional idempotency key\./);
    assert.match(key, /pass the same YAML \(the same metadata\.name and version\) with no key or a new key; never rename the definition to start another\.$/);
});

// Owner feedback 2026-11-06 (finding 5): told "one live run", the agent refused to run a second Workflow and stopped it.
// One live run belongs to each Workflow (each spawn_workflow call); one definition may have many Workflows at once.
test("one live run is each Workflow's, never the definition's: the four texts agents read say so", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { WORKFLOW_V2_SKILLS_DIR } = await import("../../dist/workflow/guidance.js");
    const { UPDATE_WORKFLOW_TOOL_SPEC } = await import("../../dist/workflow/v2/tools.js");
    const skill = name => fs.readFileSync(path.join(WORKFLOW_V2_SKILLS_DIR, name, "SKILL.md"), "utf8").replace(/\s+/g, " ");
    const texts = {
        "base guidance": WORKFLOW_SESSION_GUIDANCE,
        "spawn_workflow": SPAWN_WORKFLOW_TOOL_SPEC.description,
        "update_workflow": UPDATE_WORKFLOW_TOOL_SPEC.description,
        "workflow-authoring": skill("workflow-authoring"),
        "workflow-reference": skill("workflow-reference"),
    };
    for (const [where, text] of Object.entries(texts)) {
        for (const old of ["one live run per workflow", "its one live run", "A workflow child has one live run", "Starts the one live run"]) {
            assert.ok(!text.includes(old), `${where} still says: ${old}`);
        }
        assert.match(text, /each `?spawn_workflow`? call/i, where);
        assert.match(text, /many Workflows (of one definition may run at once|running at once)/, where);
    }
    assert.ok(texts.update_workflow.includes("to run it again, call spawn_workflow with the same YAML and no key"));
    assert.ok(WORKFLOW_SESSION_GUIDANCE.includes("so a second one never needs the first stopped"));
});
