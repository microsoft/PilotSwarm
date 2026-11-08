import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../dist/session-manager.js";
import { SPAWN_WORKFLOW_TOOL_SPEC } from "../../dist/workflow/tool-spec.js";
import { WORKFLOW_SESSION_GUIDANCE } from "../../dist/workflow/guidance.js";

test("workflow guidance teaches bounded selection, correct bindings and controller-owned waits", () => {
    const block = WORKFLOW_SESSION_GUIDANCE;
    for (const phrase of ["When `workflow_definition` is available", "already-authorized, finite", "without an LLM turn",
        "new judgment", "does not expand permissions", "context.input", "context.inputs", "top-level `return`",
        "type: wait", "survives worker restart", "from 1 to 86,400", "`limits.maxNodeExecutions` (default 1,000, at most 10,000)",
        "notify_on_completion", "not an instruction to start another", "actual terminal result"]) {
        assert.ok(block.includes(phrase), `Missing guidance: ${phrase}`);
    }
});

// OF-S2-6 (owner, 2026-11-07T21:07Z): any session or sub-agent can grow a Workflow, so the base guidance says to keep it
// simple and to give the hard part to an agent node; it no longer invites decisions written in JavaScript and YAML.
test("workflow guidance: keep a Workflow simple, an agent node for the hard part, no code in YAML", () => {
    const block = WORKFLOW_SESSION_GUIDANCE;
    for (const phrase of ["Keep a Workflow simple", "few nodes and a straight path", "route corner cases to an agent node",
        "judgment, parsing, many branches, nested conditions or string logic, use an agent node with a short, clear prompt",
        "Scripts do work, not decisions", "no code in YAML", "costs fewer tokens than a brittle definition"]) {
        assert.ok(block.includes(phrase), `Missing guidance: ${phrase}`);
    }
    assert.ok(!block.includes("expressed in JavaScript and YAML"), "decisions are not invited into JavaScript and YAML");
});

test("both base policies always receive the workflow guidance, scripts on or off (Workflows are always on)", () => {
    // A session manager as a worker makes it, with no Workflow setting: the guidance is there.
    const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "Legacy base." });
    for (const version of ["v1", "v2"]) {
        const config = { baseAgentPolicy: { version, fingerprint: "test", revision: null } };
        for (const scripts of [false, true]) {
            manager.workflowScriptsEnabled = scripts;
            const prompt = JSON.stringify(manager._buildSystemMessage("session", config));
            assert.equal(prompt.split("## Workflow Sessions").length - 1, 1, `${version} scripts ${scripts}`);
            assert.ok(prompt.includes("type: wait"));
            assert.ok(!prompt.includes("transition.delaySeconds"));
            if (scripts) assert.ok(prompt.includes("context.input"));
        }
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

// Stage 2.1 (D2): spawn_workflow is kept one release, mapped to a save of the chat's definition and, with start, its start.
test("spawn_workflow says it is kept one release, saves a revision and starts it only with state published and start", () => {
    const text = SPAWN_WORKFLOW_TOOL_SPEC.description;
    assert.match(text, /spawn_workflow is kept for one release, and workflow_definition \(list, read, save, start\) replaces it\./);
    assert.match(text, /a v2 YAML is saved as the next revision of this chat's definition named by its metadata\.name/);
    assert.match(text, /with state: published and start: true that revision is also started as a new Workflow \(each start is another Workflow/);
    const { state, start, key } = SPAWN_WORKFLOW_TOOL_SPEC.parameters.properties;
    assert.match(state.description, /draft \(default: save the revision, start nothing\)/);
    assert.match(start.description, /also start the saved revision as a new Workflow/);
    assert.match(key.description, /To start another Workflow of a v2 definition, use workflow_definition start; never rename the definition to start another\.$/);
});

// Stage 2.1: another Workflow of a definition is another start of it; a renamed definition is a new definition.
test("another Workflow from the same definition: start it again, never a renamed definition", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { WORKFLOW_V2_SKILLS_DIR } = await import("../../dist/workflow/guidance.js");
    const skill = fs.readFileSync(path.join(WORKFLOW_V2_SKILLS_DIR, "workflow-authoring", "SKILL.md"), "utf8").replace(/\s+/g, " ");
    assert.ok(WORKFLOW_SESSION_GUIDANCE.includes("To run a definition again (\"another one\", \"run it again\"), call `start` again: one definition may have "
        + "many Workflows running at once, so a second one never needs the first stopped."));
    assert.ok(WORKFLOW_SESSION_GUIDANCE.includes("Never rename a definition to change or rerun it: a new name makes a new definition."));
    assert.ok(skill.includes("To start another Workflow, call `start` again. Never rename the definition: a new name makes a new definition."));
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
        assert.match(text, /many Workflows (of one definition may run at once|running at once)/, where);
    }
    assert.ok(texts.update_workflow.includes("to run it again, call workflow_definition start"));
    assert.ok(WORKFLOW_SESSION_GUIDANCE.includes("so a second one never needs the first stopped"));
});

// Owner revision dump 2 (2026-11-06): a chat made 9 Workflows of one definition and said "I updated" when it had made a new one.
// Stage 2.1: a change is the next revision of the same definition, guarded by the revision read; Start runs it.
test("changing a Workflow: read, save the next revision with its guard, start it, and the person is told it is a new Workflow", () => {
    const text = WORKFLOW_SESSION_GUIDANCE;
    for (const phrase of [
        "To change a Workflow, `read` its definition, edit the YAML and `save` it with its `definition_id` and `expected_revision` (the revision you read): that is the next revision of the same definition.",
        "A save based on an older revision is refused because someone (the person, in the Workflow tab) saved since: read again and redo your change on the newest revision.",
        "`metadata.version` is a label you may raise; revisions, not versions, order the history.",
        "to run the change, `start` the new revision, and tell the person it is a new Workflow of that revision, not that you updated the running one.",
        "The old Workflow keeps running until it is stopped; ask the person whether to stop it.",
    ]) {
        assert.ok(text.includes(phrase), `Missing guidance: ${phrase}`);
    }
    assert.ok(!text.includes("SEMVER_REUSED"), "the version guard is retired with the version model");
    assert.ok(text.indexOf("To run a definition again") < text.indexOf("To change a Workflow"));
});

test("a revision with errors is saved, cannot start, and is fixed by saving again on it; a person's save leaves a note", () => {
    const text = WORKFLOW_SESSION_GUIDANCE;
    for (const phrase of [
        "A revision with errors is saved and comes back with them, and it cannot start. Fix the YAML and save again on that revision (its `expected_revision`).",
        "Do not save under another name to get past an error.",
        "When the person saves a revision in the Workflow tab, your next turn starts with a note saying so: read the definition before you change it.",
        "`spawn_workflow` still works for one release: it saves a revision of the definition its YAML names and, with `state: published` and `start: true`, starts that revision. Prefer `workflow_definition`.",
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
        "Never use `cron`, `cron_at` or a timer of your own to start a Workflow each time: every start makes another Workflow.",
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
