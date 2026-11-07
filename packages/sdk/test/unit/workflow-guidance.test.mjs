import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../dist/session-manager.js";
import { SPAWN_WORKFLOW_TOOL_SPEC } from "../../dist/workflow/tool-spec.js";
import { WORKFLOW_SESSION_GUIDANCE } from "../../dist/workflow/guidance.js";

test("workflow guidance teaches bounded selection, correct bindings and controller-owned waits", () => {
    const block = WORKFLOW_SESSION_GUIDANCE;
    for (const phrase of ["When `spawn_workflow` is available", "already-authorized, finite", "without an LLM turn",
        "new judgment", "does not expand permissions", "context.input", "context.inputs", "top-level `return`",
        "type: wait", "survives worker restart", "from 1 to 86,400", "`limits.maxNodeExecutions` (default 1,000, at most 10,000)",
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
        assert.ok(prompt.includes("type: wait"));
        assert.ok(!prompt.includes("transition.delaySeconds"));
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

// Owner revision dump 2 (2026-11-06): a chat made 9 Workflows of one definition. Every change and every per-minute run was a
// published spawn_workflow (cron + spawn), it reused 1.1.3 for 4 different YAMLs, worked around DEFINITION_INVALID by
// spawning again, and said "I updated" when it had made a new Workflow. The base guidance now says how to change one.
test("changing a Workflow: same name, a higher version for any YAML change, a draft first, and the person is told it is new", () => {
    const text = WORKFLOW_SESSION_GUIDANCE;
    for (const phrase of [
        "To change a Workflow, keep `metadata.name` and raise `metadata.version` (for example 1.0.0 to 1.1.0).",
        "Every change to the YAML needs a new version: never give different YAML a version that a Workflow of this definition already has (`spawn_workflow` refuses it with SEMVER_REUSED).",
        "spawn it as a draft (no `state`), show the person what changed, then call `update_workflow` `publish_and_start` on that draft when they want it running.",
        "Tell the person you made a new Workflow of the same definition, not that you updated the old one: the Workflow tab shows it under the definition's name, with its version.",
        "The old Workflow keeps running until it is stopped; ask the person whether to stop it.",
    ]) {
        assert.ok(text.includes(phrase), `Missing guidance: ${phrase}`);
    }
    // Starting another Workflow of an unchanged definition is still the same YAML, spawned again.
    assert.ok(text.indexOf("To start another Workflow from a definition") < text.indexOf("To change a Workflow"));
});

test("an invalid draft is fixed in place with replace_definition, never by spawning another Workflow", () => {
    const text = WORKFLOW_SESSION_GUIDANCE;
    for (const phrase of [
        "If a draft is not valid (it comes back with diagnostics, or publishing it is refused with DEFINITION_INVALID), fix the YAML and replace that same draft: `update_workflow` `replace_definition` with its `workflow_id` and `expected_revision`, and the same version.",
        "Do not spawn another Workflow to get past an error.",
        "A `spawn_workflow` with `state: published` that is refused as not valid made nothing: fix the YAML and spawn it as a draft.",
    ]) {
        assert.ok(text.includes(phrase), `Missing guidance: ${phrase}`);
    }
});

// FU-22: the base guidance taught transition.delaySeconds, which version 2 refuses; it now teaches the wait state, and recurring
// work as one Workflow that loops through it, never cron or a timer that spawns a Workflow each time.
test("recurring or polling work is one Workflow looping through a wait state; delaySeconds and cron + spawn are gone", () => {
    const text = WORKFLOW_SESSION_GUIDANCE;
    assert.ok(!text.includes("delaySeconds"));
    for (const phrase of [
        "To wait, use a wait state: `pause: { type: wait, seconds: 60, transition: { next: { elapsed: check } } }`.",
        "it survives worker restart, uses no model turn and passes its input on as its output. `seconds` is an integer from 1 to 86,400.",
        "Do not call `wait`, `cron`, `sleep` or JavaScript timers inside a script.",
        "For recurring or polling work (check every minute, watch for a change), make one Workflow that loops: a check state, then a wait state whose `elapsed` route goes back to the check.",
        "Never use `cron`, `cron_at` or a timer of your own to call `spawn_workflow` each time: every call makes another Workflow.",
    ]) {
        assert.ok(text.includes(phrase), `Missing guidance: ${phrase}`);
    }
    const spawn = SPAWN_WORKFLOW_TOOL_SPEC.description;
    assert.ok(!spawn.includes("set cron or cron_at and call spawn_workflow on each wake-up"));
    assert.ok(spawn.includes("For recurring or polling work, loop inside one workflow (a v2 wait state, or v1 transition.delaySeconds); "
        + "never use cron or cron_at to call spawn_workflow on each wake-up: each call starts another workflow."));
});

test("the guidance's wait state compiles in a version 2 loop, where transition.delaySeconds is refused", async () => {
    const { compileWorkflowV2 } = await import("../../dist/workflow/v2/compiler.js");
    const wait = /`(pause: \{ type: wait, [^`]+)`/.exec(WORKFLOW_SESSION_GUIDANCE)?.[1];
    assert.ok(wait, "the guidance shows a wait state");
    const doc = check => [
        "apiVersion: pilotswarm.dev/v2-draft", "kind: Workflow", "metadata: { name: watcher, version: \"1.0.0\" }", "initial: check", "states:",
        "  check:", "    type: script", "    source: |", "      await setResult('unchanged', { n: 1 });", check,
        `  ${wait}`, "  done: { type: terminal, outcome: succeeded }", "",
    ].join("\n");
    const looped = compileWorkflowV2(doc("    transition: { next: { unchanged: pause, changed: done } }"));
    assert.deepEqual(looped.diagnostics.filter(item => item.severity === "error"), []);
    assert.equal(looped.valid, true);
    const delayed = compileWorkflowV2(doc("    transition: { next: { unchanged: check, changed: done }, delaySeconds: { unchanged: 60 } }"));
    assert.equal(delayed.valid, false);
    assert.ok(delayed.diagnostics.some(item => item.severity === "error" && /delaySeconds/.test(item.path)), JSON.stringify(delayed.diagnostics));
});
