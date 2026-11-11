/**
 * Adversarial review UI-8: a workflow's step log shows the entries of the run the person chose (else the run the
 * workflow's read model shows), and the session's own notices; another run's entries are left out.
 *
 * Run: node --test test/workflow-step-log-run.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoryModel } from "../src/history.js";
import { workflowDefinition, workflowStepLogHistory, workflowStepLogNotice, workflowStepLogRunId, workflowStepLogScope } from "../src/workflow-view.js";
import { workflowStepLogLines, WORKFLOW_STEP_LOG_EMPTY_TEXT } from "../src/workflow-sessions.js";

const SID = "wf-log";
let seq = 0;
const event = (eventType, data) => ({ seq: ++seq, sessionId: SID, eventType, data, createdAt: new Date(1788800000000 + seq * 1000).toISOString() });
const STATES = [{ id: "work", type: "script", runtime: "node", next: { ok: "done" } }, { id: "done", type: "terminal", outcome: "succeeded" }];
const runEvents = (runId, output) => [
    event("workflow.started", { runId, mode: "test", revision: 1, name: "w", version: "1.0.0", initial: "work", states: STATES }),
    event("workflow.state_completed", { runId, stateId: "work", step: 1, outcome: "ok", resultKind: "business", outputPreview: output }),
    event("workflow.completed", { runId, stateId: "done", outcome: "succeeded", steps: 1 }),
];

test("a step log shows only the chosen run's entries and the session's own notices", () => {
    const history = buildHistoryModel([...runEvents("run-old", "{\"v\":\"old\"}"), ...runEvents("run-new", "{\"v\":\"new\"}"),
        event("workflow.recovered", { action: "none" })]);
    const runs = new Set(history.chat.map(item => item.workflowRunId).filter(Boolean));
    assert.deepEqual([...runs].sort(), ["run-new", "run-old"]);
    const old = workflowStepLogHistory(history, "run-old");
    assert.ok(old.chat.length > 0);
    assert.ok(old.chat.every(item => !item.workflowRunId || item.workflowRunId === "run-old"));
    assert.ok(!JSON.stringify(old.chat).includes('\\"new\\"'));
    assert.ok(old.chat.some(item => !item.workflowRunId), "the session's own notice stays");
    // No run chosen, or nothing to leave out: the same history.
    assert.equal(workflowStepLogHistory(history, null), history);
    assert.equal(workflowStepLogHistory(old, "run-old"), old);
});

test("the log's run: the person's choice, else the read model's run, else none", () => {
    assert.equal(workflowStepLogRunId({ selectedRunId: "run-a", readModel: { run: { runId: "run-b" } } }), "run-a");
    assert.equal(workflowStepLogRunId({ readModel: { run: { runId: "run-b" } }, readModelRunId: null }), "run-b");
    assert.equal(workflowStepLogRunId({ readModel: { runs: [], run: null } }), null);
    assert.equal(workflowStepLogRunId(null), null);
    assert.equal(workflowStepLogRunId({ definition: { states: [] } }), null);
});

// Adversarial review R2-UI-3: the log uses the same selection-bound read as the graph. A switch from test run A to the
// live run shows no entries of A while the live read is on its way or failed, and a draft with only tests (run null)
// shows none of them under the live run: only the session's own notices and a line that says why.
test("R2-UI-3: switching to the live run never shows another run's entries: loading, failed, and no live run", () => {
    const history = buildHistoryModel([...runEvents("test-a", "{\"v\":\"a\"}"), ...runEvents("test-b", "{\"v\":\"b\"}"),
        event("workflow.recovered", { action: "none" })]);
    const runEntries = log => log.chat.filter(item => item.workflowRunId);
    const notices = log => log.chat.filter(item => item.workflowStepLogNotice).map(item => item.text);
    const testA = { selectedRunId: "test-a", readModel: { run: { runId: "test-a" }, runs: [] }, readModelRunId: "test-a" };
    assert.deepEqual(workflowStepLogScope(testA), { kind: "run", runId: "test-a" });

    // Live run chosen; the read of test A is still held while the live read is on its way.
    const delayed = { ...testA, selectedRunId: null };
    assert.deepEqual(workflowStepLogScope(delayed), { kind: "loading" });
    assert.equal(workflowStepLogRunId(delayed), null);
    const loading = workflowStepLogHistory(history, workflowStepLogScope(delayed));
    assert.deepEqual(runEntries(loading), []);
    assert.deepEqual(notices(loading), ["Loading the live run's log…"]);
    assert.ok(loading.chat.some(item => !item.workflowRunId && !item.workflowStepLogNotice), "the session's own notice stays");

    // The live read failed.
    const failed = { ...delayed, readModelAttempt: { runId: null }, readModelError: "Gateway timeout" };
    assert.deepEqual(workflowStepLogScope(failed), { kind: "failed", error: "Gateway timeout" });
    assert.deepEqual(runEntries(workflowStepLogHistory(history, workflowStepLogScope(failed))), []);
    assert.deepEqual(notices(workflowStepLogHistory(history, workflowStepLogScope(failed))),
        ["The live run could not be read, so its log is not shown: Gateway timeout"]);

    // The live read came back: a draft with only test runs has no live run.
    const none = { selectedRunId: null, readModel: { run: null, runs: [{ runId: "test-a" }, { runId: "test-b" }] }, readModelRunId: null };
    assert.deepEqual(workflowStepLogScope(none), { kind: "none" });
    const empty = workflowStepLogHistory(history, workflowStepLogScope(none));
    assert.deepEqual(runEntries(empty), []);
    assert.deepEqual(notices(empty), ["No live run yet. Choose a test run to see its log."]);

    // A live run read for the live selection: only its entries.
    const live = { selectedRunId: null, readModel: { run: { runId: "test-b" }, runs: [] }, readModelRunId: null };
    assert.deepEqual(workflowStepLogScope(live), { kind: "run", runId: "test-b" });
    assert.ok(runEntries(workflowStepLogHistory(history, workflowStepLogScope(live))).every(item => item.workflowRunId === "test-b"));
    // A view with nothing read yet is not filtered.
    assert.deepEqual(workflowStepLogScope({}), { kind: "all" });
    assert.equal(workflowStepLogHistory(history, { kind: "all" }), history);
});

// Re-check RC-2: the first open of a workflow whose history already holds test runs. The definition comes from its start
// event before the first read of the run comes back (the controller dispatches it first, then the read): the log is a
// run's from that moment, so it shows no test run's entries under the live run while it waits.
test("RC-2: a first open with a known definition and its first read on its way shows no run's entries", () => {
    const history = buildHistoryModel([...runEvents("test-a", "{\"v\":\"a\"}"), event("workflow.recovered", { action: "none" })]);
    const definition = workflowDefinition({ irSha256: "f".repeat(64), name: "w", version: "1.0.0", initial: "work",
        states: [{ id: "work", type: "script", runtime: "node", outcomes: ["ok"], next: { ok: "done" } }, { id: "done", type: "terminal", outcome: "succeeded" }] });
    // As the controller sets it at the first open: the definition, nothing read yet, no run chosen.
    const first = { definition, loading: false, error: null };
    assert.deepEqual(workflowStepLogScope(first), { kind: "loading" });
    const shown = workflowStepLogHistory(history, workflowStepLogScope(first));
    assert.deepEqual(shown.chat.filter(item => item.workflowRunId), []);
    assert.deepEqual(shown.chat.filter(item => item.workflowStepLogNotice).map(item => item.text), ["Loading the live run's log…"]);
    // The read comes back with no live run: none; with a live run: only its entries.
    assert.deepEqual(workflowStepLogScope({ ...first, readModel: { run: null, runs: [{ runId: "test-a" }] }, readModelRunId: null }), { kind: "none" });
    assert.deepEqual(workflowStepLogScope({ ...first, readModel: { run: { runId: "live-1" }, runs: [] }, readModelRunId: null }), { kind: "run", runId: "live-1" });
    // With no run at all: empty (S8-UI).
    assert.deepEqual(workflowStepLogScope({ ...first, readModel: { run: null, runs: [] }, readModelRunId: null }), { kind: "empty" });
});

// S8-UI (browser suite g-06/g-07 at 28217174): a workflow with no run at all has no test run to choose, so its step log
// adds no line telling the person to choose one; an empty log says "No step output yet." as before R2-UI-3. A draft with
// only test runs keeps that line. In both, the log shows only the session's own notices, never a run's entries.
test("S8-UI: with no run at all the step log adds no notice and says 'No step output yet.'; with only test runs it keeps the notice", () => {
    const runEntries = log => log.chat.filter(item => item.workflowRunId);
    const notices = log => log.chat.filter(item => item.workflowStepLogNotice).map(item => item.text);
    const noRuns = { selectedRunId: null, readModel: { run: null, runs: [] }, readModelRunId: null };
    assert.deepEqual(workflowStepLogScope(noRuns), { kind: "empty" });
    assert.equal(workflowStepLogRunId(noRuns), null);
    assert.equal(workflowStepLogNotice({ kind: "empty" }), null);

    // No events at all (the browser case): the same empty history, and the empty log's own words.
    const blank = buildHistoryModel([]);
    const blankLog = workflowStepLogHistory(blank, workflowStepLogScope(noRuns));
    assert.deepEqual(blankLog.chat, []);
    assert.deepEqual(workflowStepLogLines([], blankLog), [{ text: WORKFLOW_STEP_LOG_EMPTY_TEXT, color: "gray" }]);

    // Entries of a run the read does not list (for example a removed test run): never shown; the session's own notice stays.
    const history = buildHistoryModel([...runEvents("gone", "{\"v\":\"gone\"}"), event("workflow.recovered", { action: "none" })]);
    const shown = workflowStepLogHistory(history, workflowStepLogScope(noRuns));
    assert.deepEqual(runEntries(shown), []);
    assert.deepEqual(notices(shown), []);
    assert.ok(shown.chat.length > 0 && shown.chat.every(item => !item.workflowRunId), "only the session's own notices");
    // Only run entries: nothing is left, so the empty log's words show.
    const onlyRun = workflowStepLogHistory(buildHistoryModel(runEvents("gone", "{\"v\":\"gone\"}")), workflowStepLogScope(noRuns));
    assert.deepEqual(onlyRun.chat, []);
    assert.deepEqual(workflowStepLogLines([], onlyRun), [{ text: WORKFLOW_STEP_LOG_EMPTY_TEXT, color: "gray" }]);

    // Only test runs, no live run: the notice stays, and no run's entries.
    const onlyTests = { selectedRunId: null, readModel: { run: null, runs: [{ runId: "gone" }] }, readModelRunId: null };
    assert.deepEqual(workflowStepLogScope(onlyTests), { kind: "none" });
    const tests = workflowStepLogHistory(history, workflowStepLogScope(onlyTests));
    assert.deepEqual(runEntries(tests), []);
    assert.deepEqual(notices(tests), ["No live run yet. Choose a test run to see its log."]);
    assert.notDeepEqual(workflowStepLogLines([], tests), [{ text: WORKFLOW_STEP_LOG_EMPTY_TEXT, color: "gray" }]);
});
