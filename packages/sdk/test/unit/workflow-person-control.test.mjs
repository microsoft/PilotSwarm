/**
 * UXP-AD-01 (owner 2026-11-09T03:25Z): a person paused a run through the chat and resumed it from the portal; when the
 * Workflow next wrote to the chat, the chat read the run as "running again, despite your earlier pause request" and paused
 * it again. The fixes, without a database:
 * - L1: the Workflow guidance of every chat that controls its Workflows says a person controls runs from the portal or the
 *   API, that their latest control action is their current instruction, and to ask when it conflicts; a chat inside a
 *   Workflow (it controls none) and a chat with Workflows off do not carry it.
 * - L2: read_workflow's description names run.lastControl, and runControlView says who took the action: this session, another
 *   session (its id), a person (their portal name, never their sign-in identity) or system (its name).
 * The store's read and the tool are test/local/workflow-v2-last-control.test.js.
 *
 * Run: node --test test/unit/workflow-person-control.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../../dist/session-manager.js";
import {
    WORKFLOW_CONTEXT_STUB, WORKFLOW_PERSON_CONTROL_GUIDANCE, WORKFLOW_SESSION_GUIDANCE, workflowSessionGuidance,
} from "../../dist/workflow/guidance.js";
import { READ_WORKFLOW_TOOL_SPEC, readWorkflowToolSpec, runControlView } from "../../dist/workflow/v2/tools.js";

const SENTENCE = "A person can pause, resume, stop or cancel a run, or set its variables, from the portal or the API at any time; "
    + "their latest control action is their current instruction, so never reverse it, and if it conflicts with something they "
    + "said earlier, ask them.";
const CLAUSE = "Its lastControl says who last paused, resumed, stopped or cancelled it or set its variables, and when.";
const count = (text, part) => text.split(part).length - 1;

test("L1: every chat that controls its Workflows is told a person's latest control action is their instruction; once", () => {
    assert.equal(WORKFLOW_PERSON_CONTROL_GUIDANCE, SENTENCE);
    assert.equal(count(WORKFLOW_SESSION_GUIDANCE, SENTENCE), 1);
    for (const testMode of [false, true]) for (const scripts of [false, true]) for (const turn of [false, true]) {
        const label = `test mode ${testMode}, scripts ${scripts}, 1.0.83 ${turn}`;
        // A frozen 1.0.82 turn too: a person controls its runs all the same.
        assert.equal(count(workflowSessionGuidance(testMode, { scripts, clockWaits: turn, requests: turn }), SENTENCE), 1, label);
        // A chat inside a Workflow controls no run (it is declared no update_workflow).
        assert.equal(count(workflowSessionGuidance(testMode, { scripts, clockWaits: turn, requests: turn, insideWorkflow: true }), SENTENCE), 0, label);
    }
    // It follows how to follow a Workflow, in the same paragraph.
    assert.match(workflowSessionGuidance(false, { scripts: true, clockWaits: true, requests: true }),
        /start no other run unless asked\. `request`: [^\n]*never in chat\. A person can pause, resume, stop or cancel a run/);
    // The paragraph while Workflows are off does not carry it.
    assert.ok(!WORKFLOW_CONTEXT_STUB.includes("A person can pause"));
});

test("L1 (wiring): a chat with Workflows on carries the sentence in its system message; one with them off or inside a Workflow does not", () => {
    const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "Legacy base." });
    const message = config => JSON.stringify(manager._buildSystemMessage("chat", { workflowMilestoneTurn: true, ...config }));
    for (const version of [{ version: "v1", fingerprint: "test", revision: null }, { version: "v2", fingerprint: "test", revision: null }]) {
        const shown = SENTENCE.replace(/"/g, '\\"');
        assert.ok(message({ baseAgentPolicy: version, workflowContext: "on" }).includes(shown), version.version);
        assert.ok(!message({ baseAgentPolicy: version, workflowContext: "off" }).includes(shown), version.version);
        assert.ok(!message({ baseAgentPolicy: version, workflowContext: "on", workflowInsideWorkflow: true, workflowAgentChild: true }).includes(shown),
            version.version);
    }
});

test("L2: read_workflow's description names lastControl in every variant, within its budget", () => {
    assert.ok(READ_WORKFLOW_TOOL_SPEC.description.includes(CLAUSE));
    assert.ok(READ_WORKFLOW_TOOL_SPEC.description.length <= 700, `${READ_WORKFLOW_TOOL_SPEC.description.length}`);
    for (const milestone of [false, true]) for (const testMode of [false, true]) for (const updateWorkflow of [true, false]) {
        assert.equal(count(readWorkflowToolSpec({ milestone, testMode, updateWorkflow }).description, CLAUSE), 1,
            `milestone ${milestone}, test mode ${testMode}, update_workflow ${updateWorkflow}`);
    }
});

test("L2: lastControl says who took the action as the calling session reads it, never a person's sign-in identity", () => {
    const at = new Date("2026-11-09T03:00:00.000Z");
    const control = (actor, extra = {}) => ({ operation: "pause", actor, displayName: null, at, reason: null, ...extra });
    assert.deepEqual(runControlView(control({ kind: "agent", sessionId: "chat-1" }, { reason: "the person asked" }), "chat-1"),
        { operation: "pause", by: "this session", at: "2026-11-09T03:00:00.000Z", reason: "the person asked" });
    assert.deepEqual(runControlView(control({ kind: "agent", sessionId: "other-2" }, { operation: "set_vars" }), "chat-1"),
        { operation: "set_vars", by: "another session", sessionId: "other-2", at: "2026-11-09T03:00:00.000Z" });
    const person = { kind: "user", provider: "entra", subject: "person-subject-7f3" };
    const named = runControlView(control(person, { operation: "resume", displayName: "Ada Lovelace" }), "chat-1");
    assert.deepEqual(named, { operation: "resume", by: "a person", name: "Ada Lovelace", at: "2026-11-09T03:00:00.000Z" });
    const unnamed = runControlView(control(person, { operation: "resume" }), "chat-1");
    assert.deepEqual(unnamed, { operation: "resume", by: "a person", at: "2026-11-09T03:00:00.000Z" });
    for (const view of [named, unnamed]) {
        assert.ok(!JSON.stringify(view).includes("person-subject-7f3") && !JSON.stringify(view).includes("entra"), JSON.stringify(view));
    }
    assert.deepEqual(runControlView(control({ kind: "system", name: "management-client" }, { operation: "cancel", reason: "Cancelled by an operator" }), "chat-1"),
        { operation: "cancel", by: "system", name: "management-client", at: "2026-11-09T03:00:00.000Z", reason: "Cancelled by an operator" });
    // Read by no session (a caller with none): an agent is another session.
    assert.equal(runControlView(control({ kind: "agent", sessionId: "chat-1" }), null).by, "another session");
});
