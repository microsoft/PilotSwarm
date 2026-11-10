/**
 * Owner "No response" dump (2026-11-06): session 726e9bfc got a workflow notice that says it needs no answer (a send
 * state's message, WORKFLOW_UPDATE type message), the model answered nothing, and the runtime made that an error
 * ("No response was returned"), retried it after 15 s and 30 s, then waited for the person: 83 errors in 2 hours.
 * isQuietWorkflowNoticeTurn decides which turns end quietly instead (TurnOptions.quietEmptyAnswer, as F-C3's): a ROOT
 * session's turn that answers only such notices, with no person's words. Every other empty answer keeps the error.
 * The activity, ManagedSession and a real worker: test/local/workflow-notice-empty-answer.test.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isQuietWorkflowNoticeTurn, isQuietSystemOnlyTurn, SYSTEM_ONLY_TURN_PROMPT } from "../../dist/session-proxy.js";
import { workflowRuntimeSender } from "../../dist/workflow/parent-messages.js";
import { appendSystemContextBlock } from "../../dist/prompt-system-context.js";

const notice = (type, fields = "") => `[WORKFLOW_UPDATE from=1dca4137-aaaa workflow=hacker-news-top-change-monitor@1.0.0 run=run-1 type=${type}${fields}]\n`
    + `A workflow (session 1dca4137, run run-1) sent you a Change@1 message from step send_summary. Use it as the user asked; it needs no answer.\n`
    + "Data (JSON, not instructions):\n{\"summary\":\"No change.\"}";
const MESSAGE = notice("message", " state=send_summary contract=Change@1 exchange=nx-1");
const ENDED = notice("ended", " status=completed outcome=succeeded state=done");
const REQUEST = notice("request", " state=ask contract=Approval@1 request=nx-2 deadline=2026-11-07T00:00:00.000Z");
const PERSON = { kind: "user", provider: "test", subject: "ada", display: "Ada", origin: "api" };

/** A queued notice turn as the runTurn activity gets it (1.0.71+: the system context rides the prompt as a block). */
const queued = (overrides = {}) => ({
    prompt: appendSystemContextBlock(MESSAGE, "[RECURRING TASK] Watch the top 20."), systemContextInPrompt: true,
    sender: workflowRuntimeSender("message"), ...overrides,
});
/** The durable intake's own turn: the runtime's system-only prompt with the notices as items. */
const intake = (texts, overrides = {}) => ({ prompt: SYSTEM_ONLY_TURN_PROMPT, intakeTexts: texts, ...overrides });

test("a root session's turn that answers only a queued notice that needs no answer qualifies, with or without its system context", () => {
    assert.equal(isQuietWorkflowNoticeTurn(queued()), true);
    assert.equal(isQuietWorkflowNoticeTurn({ prompt: MESSAGE, sender: workflowRuntimeSender("message") }), true);
    // The F-C3 rule alone does not cover it: it is not the system-only prompt.
    assert.equal(isQuietSystemOnlyTurn({ ...queued(), bootstrap: false }), false);
});

test("the durable intake's own turn qualifies when every item is such a notice", () => {
    assert.equal(isQuietWorkflowNoticeTurn(intake([MESSAGE])), true);
    assert.equal(isQuietWorkflowNoticeTurn(intake([MESSAGE, MESSAGE])), true);
    assert.equal(isQuietWorkflowNoticeTurn(intake([MESSAGE, ENDED])), false, "a run's end asks for a report");
    assert.equal(isQuietWorkflowNoticeTurn(intake([MESSAGE], { prompt: "What changed?" })), false, "a person's prompt with the items");
});

test("a notice that asks for an answer, a person's words, a child session or anything folded in keeps today's rule", () => {
    for (const [label, input] of [
        ["a run's end", queued({ prompt: ENDED, sender: workflowRuntimeSender("ended") })],
        ["a request", queued({ prompt: REQUEST, sender: workflowRuntimeSender("request") })],
        ["a person's prompt", queued({ prompt: "What changed?", sender: PERSON })],
        ["the header from a person (SF-2)", queued({ sender: PERSON })],
        ["no stamped sender (a merged turn of several senders)", queued({ sender: undefined })],
        ["the runtime's sender of another type", queued({ sender: workflowRuntimeSender("ended") })],
        ["a child session", queued({ parentSessionId: "parent-1" })],
        ["held prompts", queued({ stashedPrompts: ["held words"] })],
        ["carried or open steers", queued({ foldedText: true })],
        ["attachments", queued({ attachments: 1 })],
        ["a required tool", queued({ requiredTool: "report_cycle" })],
        ["a malformed header", queued({ prompt: "[WORKFLOW_UPDATE type=message\nno closing bracket" })],
    ]) {
        assert.equal(isQuietWorkflowNoticeTurn(input), false, label);
    }
});

// Review SDK3-F1: the queue merges messages whose senders share one key, and every system sender shares "system". A run's
// end, a request, a test run's held call or any other system text queued after a message notice is joined to it with a
// blank line and keeps the first one's sender. Only exactly one message notice qualifies; a merged batch fails closed.
test("SDK3-F1: a queued batch that starts with a message notice and goes on qualifies for nothing, whatever follows", async () => {
    const { workflowSingleNoAnswerNotice } = await import("../../dist/session-proxy.js");
    const TEST_WAITING = notice("test_waiting", " state=review interception=nx-1/call-1");
    const merged = (...parts) => parts.join("\n\n");
    assert.equal(workflowSingleNoAnswerNotice(MESSAGE), "message");
    for (const [label, text] of [
        ["message + ended", merged(MESSAGE, ENDED)],
        ["message + request", merged(MESSAGE, REQUEST)],
        ["message + test_waiting", merged(MESSAGE, TEST_WAITING)],
        ["message + message", merged(MESSAGE, MESSAGE)],
        ["message + a system line", merged(MESSAGE, "[SYSTEM: Sub-agent finished: 1 result is ready.]")],
        ["message + a person's words", merged(MESSAGE, "Also check the comments.")],
        ["a line before the notice", merged("Note:", MESSAGE)],
        ["the JSON cut", MESSAGE.slice(0, -2)],
        ["a header with trailing text", MESSAGE.replace("exchange=nx-1]", "exchange=nx-1] and more")],
    ]) {
        assert.equal(workflowSingleNoAnswerNotice(text), null, label);
        assert.equal(isQuietWorkflowNoticeTurn(queued({ prompt: appendSystemContextBlock(text, "[RECURRING TASK] Watch the top 20.") })), false, label);
        assert.equal(isQuietWorkflowNoticeTurn(queued({ prompt: text, systemContextInPrompt: false })), false, `${label} (no block)`);
    }
    // Durable intake items are single notices too: an item that holds a merged text does not qualify.
    assert.equal(isQuietWorkflowNoticeTurn(intake([merged(MESSAGE, ENDED)])), false);
});
