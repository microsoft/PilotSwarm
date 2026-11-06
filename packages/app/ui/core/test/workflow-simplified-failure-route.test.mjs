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
const T = seconds => new Date(Date.UTC(2026, 10, 6, 13, 36, 19) + seconds * 1_000).toISOString();
// His #2, as the read model gives it (sdk tools.ts nodeExecutionViewOf): `ordinal` is each node's own visit number, so poll's
// and the terminal's are both 1 (r3, C17: f42de1d8 ordered by it and found no step before the terminal). poll ended with the
// runtime error and took its failure route; the terminal "failed" was entered after and ended the run.
const visit = (stateId, ordinal, entered, ended, result) => ({ nodeExecutionId: `nx-${stateId}-${ordinal}`, stateId, ordinal, state: "completed",
    winner: "controller", attempts: 0, kvRevision: 1, enteredAt: T(entered), endedAt: T(ended), ...result });
const rows = [
    visit("poll", 1, 0, 1, { outcome: "execution_failed", resultKind: "runtime_error", errorPreview: POLL_ERROR }),
    visit("failed", 1, 1.2, 1.2, { outcome: "failed", resultKind: "business", outputPreview: "{}" }),
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
    // r3's ux-boom: a script that throws, its failure route, the terminal "failed" with no summary. As the read gives it
    // (HN #2, 5482bae3 live data): the node's error is its envelope's text, so its preview is that text as a JSON string.
    const boomError = JSON.stringify(JSON.stringify({ code: "execution_failed", details: { exitCode: 1,
        stderr: "file:///tmp/wf-script-1/script.mjs:1\nthrow new Error('ux-boom-4821');\n^\n\nError: ux-boom-4821\n    at file:///tmp/wf-script-1/script.mjs:1:7\n\nNode.js v24.11.0" },
        message: "The script exited with code 1." }));
    const boom = run({ nodeExecutions: [visit("boom", 1, 0, 0.8, { outcome: "execution_failed", resultKind: "runtime_error", errorPreview: boomError }),
        visit("failed", 1, 0.9, 0.9, { outcome: "failed", resultKind: "business", outputPreview: "{}" })] });
    assert.equal(workflowFailureText(boom), "boom failed: the script stopped with an error: ux-boom-4821");
    // HN #2 as read live: poll's error preview cut at 500 characters inside that JSON string.
    const longError = JSON.stringify(JSON.stringify({ code: "execution_failed", details: { exitCode: 1, stderr: ["<anonymous_script>:3",
        "<note>Content truncated. Call the fetch tool with a start_index of 4000 to get more content.</note>", "^", "",
        "SyntaxError: Expected ',' or ']' after array element in JSON at position 4002 (line 3 column 1)",
        ...Array.from({ length: 12 }, (_, i) => `    at frame${i} (file:///tmp/pilotswarm-script-x/script.mjs:${100 + i}:15)`)].join("\n") },
        message: "The script exited with code 1." }));
    const hn2 = run({ nodeExecutions: [visit("poll", 1, 0, 0.455, { outcome: "execution_failed", resultKind: "runtime_error",
        errorPreview: `${longError.slice(0, 500)}…` }), visit("failed", 1, 0.55, 0.573, { outcome: "failed", resultKind: "business", outputPreview: "\"null\"" })] });
    assert.equal(workflowFailureText(hn2),
        "poll failed: the script stopped with an error: Expected ',' or ']' after array element in JSON at position 4002 (line 3 column 1)");
    // The Workflows list's reason beside the Failed chip says the same.
    const session = { sessionId: "wf-2", sessionKind: "workflow", status: "failed", parentSessionId: "owner" };
    const model = { runs: [{ runId: "run-2", mode: "live", status: "failed", outcome: "failed" }], run: run() };
    assert.equal(workflowStateOf(session, { readModel: model }).reason, failure.headline);
});

test("without such an error: the terminal's summary, else where it ended, with its outcome once", () => {
    // The step before the terminal ended normally (a business outcome routed to "failed"): no error to show.
    const business = [{ ...rows[0], resultKind: "business", outcome: "empty", errorPreview: null, outputPreview: "{}" }, rows[1]];
    assert.equal(workflowFailureText(run({ nodeExecutions: business }), { summary: "The feed had no stories." }), "The feed had no stories.");
    assert.equal(workflowFailureText(run({ nodeExecutions: business })), "Ended at failed (failed)");
    // An earlier error the Workflow handled and went on from is not the cause.
    const handled = [rows[0], visit("pause", 1, 1.1, 31.1, { outcome: "elapsed", resultKind: "business", outputPreview: "{}" }),
        visit("failed", 1, 31.2, 31.2, { outcome: "failed", resultKind: "business", outputPreview: "{}" })];
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

// Review UI2-F3 (short UI re-review, medium): with no named predecessor the fallback chose the visit that ended last, in
// any scope, and without the terminal any completed visit: an unrelated branch's error could become the headline. Now a
// cause only on evidence (the terminal's own scope, a unique latest visit, a named predecessor or nothing), else the
// terminal's summary or "Ended at …", never a wrong cause.
test("UI2-F3: no cause from another scope, from a tie, without the terminal, or for a named predecessor not loaded", () => {
    const BRANCH_ERROR = JSON.stringify({ code: "execution_failed", details: { exitCode: 1, stderr: "Error: item 3 feed timed out" }, message: "x" });
    const branch = (stateId, entered, ended) => ({ ...visit(stateId, 1, entered, ended, { outcome: "execution_failed", resultKind: "runtime_error",
        errorPreview: BRANCH_ERROR }), scopeId: "scope-par-1", branch: { index: 2 }, predecessorId: null });
    const ok = (stateId, entered, ended) => visit(stateId, 1, entered, ended, { outcome: "ok", resultKind: "business", outputPreview: "{}" });
    const terminal = (entered) => visit("failed", 1, entered, entered, { outcome: "failed", resultKind: "business", outputPreview: "{}" });
    const ended = "Ended at failed (failed)";
    // A root terminal reached by a business outcome; an unrelated branch error ended later than that outcome: not the cause.
    const mixed = [ok("decide", 0, 1), branch("fetch", 0.2, 1.1), terminal(1.2)];
    assert.equal(workflowFailureText(run({ nodeExecutions: mixed })), ended);
    assert.equal(workflowFailureText(run({ nodeExecutions: [...mixed].reverse() })), ended, "page order changes nothing");
    // Two top-level visits ended at the same time before the terminal: a tie proves no route, in either order.
    const tied = [visit("poll", 1, 0, 1, { outcome: "execution_failed", resultKind: "runtime_error", errorPreview: POLL_ERROR }), ok("audit", 0.5, 1), terminal(1.2)];
    assert.equal(workflowFailureText(run({ nodeExecutions: tied })), ended);
    assert.equal(workflowFailureText(run({ nodeExecutions: [...tied].reverse() })), ended);
    // The terminal's visit is not in the page: no cause is chosen among the others.
    assert.equal(workflowFailureText(run({ nodeExecutions: [rows[0]] })), ended);
    // A named predecessor that is not loaded: never another row instead.
    assert.equal(workflowFailureText(run({ nodeExecutions: [rows[0], { ...rows[1], predecessorId: "nx-not-loaded" }] })), ended);
    // A handled retry: an earlier error, then a business visit just before the terminal: the error did not take the route.
    const handled = [visit("poll", 1, 0, 1, { outcome: "execution_failed", resultKind: "runtime_error", errorPreview: POLL_ERROR }), ok("poll", 1.1, 1.15), terminal(1.2)];
    assert.equal(workflowFailureText(run({ nodeExecutions: handled })), ended);
    // A branch's own terminal visits (repeated) are not the run's terminal; the top-level one is, and its cause is found.
    const branchEnds = [{ ...terminal(0.5), nodeExecutionId: "nx-failed-b1", scopeId: "scope-par-1", predecessorId: null },
        { ...terminal(0.6), nodeExecutionId: "nx-failed-b2", scopeId: "scope-par-1", predecessorId: null }, ...rows];
    assert.equal(workflowFailureText(run({ nodeExecutions: branchEnds })), "poll failed: the script stopped with an error: missing ) after argument list");
    // The summary, when the terminal has one, is what an unproven cause leaves.
    assert.equal(workflowFailureText(run({ nodeExecutions: mixed }), { summary: "The feed check failed." }), "The feed check failed.");
});
