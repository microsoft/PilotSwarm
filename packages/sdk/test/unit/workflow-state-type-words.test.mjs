/**
 * I2 (owner 2026-11-09T06:40Z; UXP-AC-01: a real user's chat invented state types and said there was no script node): a
 * state type the compiler does not know is refused with the types it takes and the one most likely meant.
 *
 * Run: node --test test/unit/workflow-state-type-words.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflowV2, workflowNearestStateType } from "../../dist/workflow/v2/compiler.js";

const FLAGS = { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true, enableClockWaits: true };
const ALL = ["script", "wait", "messaging", "agent", "parallel", "terminal"];
const typeError = (type, flags = FLAGS) => compileWorkflowV2(`apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: types, version: "1.0.0" }
initial: a
states:
  a: { type: ${type}, transition: { next: { ok: done } } }
  done: { type: terminal, outcome: succeeded }
`, flags).diagnostics.find(item => item.path === "states.a.type");

test("an unknown type is refused with the types this compile takes and the one most likely meant", () => {
    for (const [word, meant] of [["scirpt", "script"], ["scripts", "script"], ["code", "script"], ["http", "script"], ["sleep", "wait"],
        ["send", "messaging with mode: send"], ["receive", "messaging with mode: receive"], ["request", "messaging with mode: request"],
        ["llm", "agent"], ["agnet", "agent"], ["end", "terminal"], ["foreach", "parallel"], ["paralel", "parallel"]]) {
        const error = typeError(word);
        assert.equal(error?.code, "WORKFLOW_NODE_TYPE_UNKNOWN", word);
        assert.equal(error.message, `'${word}' is not a workflow state type. The types are script, wait, messaging, agent, parallel, terminal. `
            + `Did you mean ${meant}?`, word);
    }
    // No near type: the list only.
    assert.equal(typeError("banana").message, "'banana' is not a workflow state type. The types are script, wait, messaging, agent, parallel, terminal.");
    // A compile without agents or parallel names only what it takes, and suggests only those.
    assert.equal(typeError("llm", {}).message, "'llm' is not a workflow state type. The types are script, wait, messaging, terminal.");
    // A type this build knows but does not take keeps its own message.
    assert.equal(typeError("join").code, "WORKFLOW_NODE_TYPE_UNSUPPORTED");
});

test("the nearest type: a known word first, then spelling within 2 edits or a third of the word", () => {
    assert.equal(workflowNearestStateType("Task", ALL), "script");
    assert.equal(workflowNearestStateType("wiat", ALL), "wait");
    assert.equal(workflowNearestStateType("terminl", ALL), "terminal");
    assert.equal(workflowNearestStateType("xyz", ALL), null);
    assert.equal(workflowNearestStateType("prompt", ["script", "wait", "messaging", "terminal"]), null, "agent is not taken here");
});
