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
