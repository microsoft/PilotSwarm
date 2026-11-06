/**
 * Workflow Simplified, owner feedback 2026-11-06T14:35Z (F6): the owner's #2 read "failed failed": its poll script failed
 * ("The script exited with code 1", a SyntaxError on stderr), its failure route took the run to a terminal named "failed"
 * with outcome failed and no summary, and the headline took the terminal's name and outcome. A run ended by its own
 * failure route has no error of its own (run.error is null). Rule: never repeat a terminal's name and outcome; prefer the
 * error of the execution that took the failure route; next the terminal's summary; last "Ended at <terminal> (<outcome>)".
 *
 * Run: node --test ui/core/test/workflow-simplified-failure-route.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { workflowFailure, workflowFailureText, workflowStateOf } from "../src/index.js";

const STDERR = [
    "file:///tmp/wf-script-2b9/script.mjs:12",
    "  const items = feed.map(item => item.title;",
    "                                            ^",
    "",
    "SyntaxError: missing ) after argument list",
    "    at compileSourceTextModule (node:internal/modules/esm/utils:340:16)",
    "",
    "Node.js v24.11.0",
].join("\n");
const POLL_ERROR = JSON.stringify({ code: "execution_failed", details: { exitCode: 1, stderr: STDERR }, message: "The script exited with code 1." });
// His #2: poll (step 1) ended with the runtime error and took its failure route; the terminal "failed" (step 2) ended the run.
const rows = [
    { nodeExecutionId: "nx-poll-1", stateId: "poll", ordinal: 1, state: "completed", resultKind: "runtime_error", outcome: "execution_failed",
        errorPreview: POLL_ERROR },
    { nodeExecutionId: "nx-failed-2", stateId: "failed", ordinal: 2, state: "completed", resultKind: "business", outcome: "failed" },
];
const run = (extra = {}) => ({ runId: "run-2", mode: "live", status: "failed", outcome: "failed", terminalState: "failed", error: null, output: "{}",
    nodeExecutions: rows, ...extra });

test("his #2: the headline is the poll script's error, never the terminal's name and outcome", () => {
    const failure = workflowFailure(run());
    assert.equal(failure.headline, "poll failed: the script stopped with an error: missing ) after argument list");
    assert.equal(failure.reason, "at poll: the script stopped with an error: missing ) after argument list");
    assert.equal(failure.stateId, "poll");
    assert.equal(failure.executionId, "nx-poll-1", "Read the whole error reads the poll's visit");
    assert.doesNotMatch(failure.headline, /failed failed/);
    // Newest first in the read (a page of executions) changes nothing.
    assert.equal(workflowFailure(run({ nodeExecutions: [...rows].reverse() })).headline, failure.headline);
    // The Workflows list's reason beside the Failed chip says the same.
    const session = { sessionId: "wf-2", sessionKind: "workflow", status: "failed", parentSessionId: "owner" };
    const model = { runs: [{ runId: "run-2", mode: "live", status: "failed", outcome: "failed" }], run: run() };
    assert.equal(workflowStateOf(session, { readModel: model }).reason, failure.headline);
});

test("without such an error: the terminal's summary, else where it ended, with its outcome once", () => {
    // The step before the terminal ended normally (a business outcome routed to "failed"): no error to show.
    const business = [{ ...rows[0], resultKind: "business", outcome: "empty", errorPreview: null }, rows[1]];
    assert.equal(workflowFailureText(run({ nodeExecutions: business }), { summary: "The feed had no stories." }), "The feed had no stories.");
    assert.equal(workflowFailureText(run({ nodeExecutions: business })), "Ended at failed (failed)");
    // An earlier error the Workflow handled and went on from is not the cause.
    const handled = [{ ...rows[0], ordinal: 1 }, { nodeExecutionId: "nx-wait-2", stateId: "pause", ordinal: 2, state: "completed", resultKind: "business",
        outcome: "elapsed" }, { ...rows[1], ordinal: 3 }];
    assert.equal(workflowFailureText(run({ nodeExecutions: handled })), "Ended at failed (failed)");
    // No executions read: where it ended.
    assert.equal(workflowFailureText(run({ nodeExecutions: [] })), "Ended at failed (failed)");
});

test("a run that failed with an error of its own keeps its headline", () => {
    const own = { status: "failed", terminalState: "poll", error: JSON.stringify({ code: "execution_failed", message: "no route",
        details: { nodeExecutionId: "nx-poll-1" } }), nodeExecutions: [rows[0]] };
    assert.equal(workflowFailureText(own), "poll failed: the script stopped with an error: missing ) after argument list");
    assert.equal(workflowFailureText({ status: "failed", terminalState: "poll", error: "plain words" }), "poll failed: plain words");
});
