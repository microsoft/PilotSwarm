// A failed Workflow's error in plain words (coordinator, 2026-11-06): the owner's "poll" script failed with its raw error
// JSON (code, details, exit code, a stack) as the headline. The read's error preview is canonical JSON cut at 500
// characters, keys sorted, so a script error is cut before its message: its fields are read from the cut text.
import test from "node:test";
import assert from "node:assert/strict";
import { workflowErrorDetails, workflowErrorParts, workflowErrorWords, workflowFailure, workflowScriptErrorLine } from "../src/index.js";
import { workflowNodeNow, workflowNodeResult } from "../src/workflow-node-summary.js";

const STDERR = [
    "file:///tmp/wf-script-7c1/script.mjs:101",
    "    if (!payload.ok) throw new Error(payload.error)",
    "                     ^",
    "",
    "Error: Unknown model \"azure-openai:gpt-5.6-terra\". Call list_available_models and choose an exact configured provider:model value.",
    "    at callTool (file:///tmp/wf-script-7c1/script.mjs:101:28)",
    "    at async main (file:///tmp/wf-script-7c1/script.mjs:130:15)",
    "    at async run (file:///tmp/wf-script-7c1/script.mjs:160:9)",
    "    at async file:///tmp/wf-script-7c1/script.mjs:200:1",
    "",
    "Node.js v24.11.0",
].join("\n");
// canonicalJson sorts keys: code, details { exitCode, stderr }, message.
const WHOLE = JSON.stringify({ code: "execution_failed", details: { exitCode: 1, stderr: STDERR }, message: "The script exited with code 1." });
const CUT = `${WHOLE.slice(0, 499)}…`;
const WORDS = "the script stopped with an error: Unknown model \"azure-openai:gpt-5.6-terra\". Call list_available_models and choose an exact configured provider:model value.";

test("a script error reads as the error its script raised, whole or cut", () => {
    assert.ok(!CUT.includes("The script exited"), "the cut preview has lost its message");
    assert.throws(() => JSON.parse(CUT));
    for (const value of [WHOLE, CUT, JSON.parse(WHOLE)]) {
        assert.equal(workflowErrorWords(value), WORDS);
        assert.doesNotMatch(workflowErrorWords(value), /exitCode|stderr|"code"|\bat callTool/);
    }
    assert.deepEqual({ ...workflowErrorParts(CUT), raw: undefined }, {
        code: "execution_failed", message: null, exitCode: 1, stderr: workflowErrorParts(CUT).stderr, raw: undefined,
    });
    // The details keep the error as it arrived: indented when whole, its text when cut.
    assert.equal(workflowErrorDetails(WHOLE), JSON.stringify(JSON.parse(WHOLE), null, 2));
    assert.equal(workflowErrorDetails(CUT), CUT);
});

test("other errors read as their message; a script without an error line says its exit code", () => {
    assert.equal(workflowErrorWords(JSON.stringify({ code: "timed_out", message: "The script ran past its 30s timeout." })), "The script ran past its 30s timeout.");
    assert.equal(workflowErrorWords(JSON.stringify({ code: "execution_failed", details: { exitCode: 3, stderr: "nothing useful" }, message: "x" })),
        "the script exited with code 3");
    assert.equal(workflowErrorWords("{\"message\":\"cherry is out of stock\"}"), "cherry is out of stock");
    assert.equal(workflowErrorWords("\"no stock\""), "no stock");
    assert.equal(workflowErrorWords("plain words"), "plain words");
    assert.equal(workflowErrorWords(JSON.stringify({ code: "unavailable" })), "unavailable");
    assert.equal(workflowErrorWords(null), null);
    assert.equal(workflowErrorWords(""), null);
    // A message cut inside an escape keeps what arrived.
    assert.equal(workflowErrorWords("{\"code\":\"x\",\"message\":\"a \\\"quoted\\u00"), "a \"quoted");
    // Error lines of other runtimes.
    assert.equal(workflowScriptErrorLine("Traceback (most recent call last):\n  File \"s.py\", line 3\nValueError: bad input"), "bad input");
    assert.equal(workflowScriptErrorLine("TypeError [ERR_INVALID_ARG_TYPE]: The \"path\" argument must be of type string"),
        "The \"path\" argument must be of type string");
    assert.equal(workflowScriptErrorLine("    at main (x.mjs:1:1)"), null);
});

test("the failed Workflow's headline, reason and details, and the Node panel, use the words", () => {
    const run = { status: "failed", terminalState: "poll", error: JSON.stringify({ code: "execution_failed",
        message: "State 'poll' ended with runtime error 'execution_failed' and has no route for it.", details: { nodeExecutionId: "nx-poll-7" } }),
    nodeExecutions: [{ nodeExecutionId: "nx-poll-7", stateId: "poll", state: "completed", resultKind: "runtime_error", outcome: "execution_failed",
        errorPreview: CUT }] };
    const failure = workflowFailure(run);
    assert.equal(failure.headline, `poll failed: ${WORDS}`);
    assert.equal(failure.reason, `at poll: ${WORDS}`);
    assert.equal(failure.details, CUT);
    const node = { id: "poll", type: "script", runs: 7 };
    const execution = { id: "nx-poll-7", status: "completed", resultKind: "runtime_error", outcome: "execution_failed", errorPreview: CUT };
    assert.equal(workflowNodeResult(node, execution)?.text, `${WORDS} (execution_failed)`);
    assert.doesNotMatch(workflowNodeNow(node, execution) ?? "", /exitCode|stderr/);
});

// Review UI-D7: readable words are a summary, not the whole error. Whenever they leave out recorded detail (a cut preview,
// a script's stderr), the whole error stays readable: Read the whole value in the Node panel (also for an error the
// Workflow handled and then went on) and Read the whole error under a failed Workflow's headline.
test("UI-D7: a summarized error keeps the whole error readable, in the Node panel and under the headline", async () => {
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { WorkflowV2FailureDetails, WorkflowV2NodeSummary } = await import("../../react/src/workflow-v2-panels.js");
    const { workflowV2ExecutionValueKey } = await import("../src/workflow-v2-view.js");
    const { workflowErrorLeavesOut } = await import("../src/workflow-error-words.js");
    assert.equal(workflowErrorLeavesOut(CUT), true, "a cut preview");
    assert.equal(workflowErrorLeavesOut(WHOLE), true, "a script's stderr and exit code");
    assert.equal(workflowErrorLeavesOut(JSON.stringify({ code: "timed_out", message: "The script ran past its 30s timeout." })), false);
    assert.equal(workflowErrorLeavesOut("plain words"), false);
    assert.equal(workflowErrorLeavesOut(JSON.stringify({ message: "x".repeat(300) })), true, "words shortened to 240 characters");

    // The Node panel: a handled error (the Workflow took its route and went on) and a failed run's visit alike.
    const values = { [workflowV2ExecutionValueKey("run-1", "nx-poll-7")]: { runId: "run-1", executionId: "nx-poll-7", phase: "loaded",
        result: { kind: "error", whole: true, bytes: WHOLE.length, value: JSON.parse(WHOLE) } } };
    for (const outcome of ["execution_failed", "handled"]) {
        const execution = { id: "nx-poll-7", status: "completed", resultKind: "runtime_error", outcome, errorPreview: CUT, ordinal: 7 };
        const node = { id: "poll", type: "script", kind: "script", runs: 7, executions: [execution], next: {}, current: execution };
        const result = workflowNodeResult(node, execution);
        assert.deepEqual({ truncated: result.truncated, summary: result.summary }, { truncated: true, summary: true }, outcome);
        const asked = [];
        const render = executionValues => renderToStaticMarkup(React.createElement(WorkflowV2NodeSummary, { selected: node, nodes: [node], select: () => {},
            runId: "run-1", executionValues, onReadWholeValue: id => asked.push(id) }));
        const before = render(null);
        assert.ok(before.includes("This is a summary of the error; Read the whole value shows all of it."), before);
        assert.ok(/data-action="whole-value"[^>]*data-execution="nx-poll-7"/.test(before), before);
        const after = render(values);
        assert.ok(after.includes("Whole runtime error") && after.includes("Node.js v24.11.0"), "the tail of the stored stderr is reachable");
    }
    // A short whole error said fully by its words: nothing more to read.
    const short = { id: "nx-1", status: "completed", resultKind: "runtime_error", outcome: "timed_out",
        errorPreview: JSON.stringify({ code: "timed_out", message: "The script ran past its 30s timeout." }) };
    assert.equal(workflowNodeResult({ id: "poll", type: "script", runs: 1 }, short).truncated, false);

    // Under the headline of a failed run: the folded details are the cut preview; Read the whole error reads the visit's.
    const run = { status: "failed", terminalState: "poll", error: JSON.stringify({ code: "execution_failed", message: "no route",
        details: { nodeExecutionId: "nx-poll-7" } }),
    nodeExecutions: [{ nodeExecutionId: "nx-poll-7", stateId: "poll", state: "completed", resultKind: "runtime_error", outcome: "execution_failed",
        errorPreview: CUT }] };
    const failure = workflowFailure(run);
    assert.deepEqual({ leavesOut: failure.leavesOut, executionId: failure.executionId }, { leavesOut: true, executionId: "nx-poll-7" });
    const asked = [];
    const details = executionValues => renderToStaticMarkup(React.createElement(WorkflowV2FailureDetails, { failure, runId: "run-1", executionValues,
        onReadWholeValue: id => asked.push(id) }));
    const folded = details(null);
    assert.ok(folded.includes("<summary>Details</summary>") && /data-action="whole-error"[^>]*>Read the whole error</.test(folded), folded);
    assert.ok(details(values).includes("Node.js v24.11.0"));
    // A failure whose words say it all, with nothing more recorded: no Details at all.
    const plain = workflowFailure({ status: "failed", terminalState: "poll", error: "plain words" });
    assert.equal(renderToStaticMarkup(React.createElement(WorkflowV2FailureDetails, { failure: plain, runId: "run-1" })), "");
});
