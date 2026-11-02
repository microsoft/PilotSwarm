// The workflow execution log for version 2 runs: repeated polls compact into one updating row, the eight v2 control
// events are logged, and a notice colour follows the result kind. Payload shapes are the ones the runtime writes
// (packages/sdk/src/workflow/v2 runtime.ts, service.ts, store.ts); nothing here is invented.
import test from "node:test";
import assert from "node:assert/strict";
import {
    appendEventToHistory, buildHistoryModel, describeWorkflowEvent, formatWorkflowEventText, isWorkflowEvent,
    CHAT_HISTORY_EVENT_TYPES, WORKFLOW_CONTROL_EVENT_TYPES, WORKFLOW_EVENT_TYPES,
} from "../src/index.js";

let seq = 0;
const event = (eventType, data) => {
    seq += 1;
    return { sessionId: "wf", seq, eventType, data, createdAt: new Date(Date.UTC(2026, 10, 1, 12, 0, seq)) };
};

const v2States = next => [
    { id: "poll", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["unchanged", "changed", "failure"], next },
    { id: "end", type: "terminal", outcome: "succeeded" },
];
const LOOP = { unchanged: "poll", failure: "poll", changed: "end", timed_out: "end" };
const started = (runId = "run-a", revision = 1, next = LOOP) => event("workflow.started", {
    runId, mode: "live", revision, definitionHash: `h${revision}`, irSha256: `i${revision}`, name: "watch-v2", version: "1.0.0",
    initial: "poll", states: v2States(next),
});
const begin = (step, runId = "run-a") => event("workflow.state_started", {
    runId, nodeExecutionId: `nx-${runId}-${step}`, stateId: "poll", scopeId: "root", ordinal: step, type: "script", step, kvRevision: 1,
});
const done = (step, outcome = "unchanged", runId = "run-a", extra = {}) => event("workflow.state_completed", {
    runId, nodeExecutionId: `nx-${runId}-${step}`, stateId: "poll", step, outcome, resultKind: "business", outputPreview: '{"n":1}', ...extra,
});
const runtimeError = (step, code = "timed_out", error = "Script timed out", runId = "run-a") => event("workflow.state_failed", {
    runId, nodeExecutionId: `nx-${runId}-${step}`, stateId: "poll", step, outcome: code, resultKind: "runtime_error", error,
});
const progress = history => history.chat.filter(item => item.workflowProgress);
const counts = history => progress(history).map(item => item.workflowProgress.count);

test("a normal v2 loop is one updating row, live append matches replay, and the raw events stay", () => {
    const rows = [started()];
    for (let step = 1; step <= 28; step++) rows.push(begin(step), done(step));
    const history = buildHistoryModel(rows);
    assert.equal(history.chat.length, 2);
    assert.deepEqual(counts(history), [28]);
    assert.equal(progress(history)[0].workflowProgress.runId, "run-a");
    assert.match(progress(history)[0].workflowNotice.title, /Waiting for changes/);
    assert.match(progress(history)[0].workflowNotice.summary, /28 checks.*unchanged/);
    assert.equal(history.events.length, rows.length);
    let live = buildHistoryModel(rows.slice(0, 3));
    for (const next of rows.slice(3)) live = appendEventToHistory(live, next);
    assert.deepEqual(live.chat, history.chat);
});

test("a changed outcome, a business failure and a runtime error each stay visible and end the quiet group", () => {
    const changed = buildHistoryModel([started(), begin(1), done(1), begin(2), done(2), begin(3), done(3, "changed")]);
    assert.deepEqual(counts(changed), [2]);
    assert.equal(changed.chat.length, 3);
    assert.match(changed.chat.at(-1).text, /→ \*\*changed\*\*/);

    // "failure" is a business outcome the author routed back to the same state: it is not a runtime error, and it is not hidden.
    const failure = buildHistoryModel([started(), begin(1), done(1), begin(2), done(2), begin(3), done(3, "failure"), begin(4), done(4)]);
    assert.deepEqual(counts(failure), [2, 1]);
    const shown = failure.chat.find(item => item.workflowEvent === "workflow.state_completed" && !item.workflowProgress);
    assert.match(shown.text, /→ \*\*failure\*\*/);
    assert.equal(shown.workflowNotice.color, "yellow");

    const errored = buildHistoryModel([started(), begin(1), done(1), begin(2), runtimeError(2)]);
    assert.deepEqual(counts(errored), [1]);
    assert.equal(progress(errored)[0].workflowProgress.pending, false);
    assert.match(errored.chat.at(-1).text, /runtime error `timed_out`: `Script timed out`/);
    assert.equal(errored.chat.at(-1).workflowNotice.color, "red");

    // A completion that claims a runtime error is never merged into a quiet repeat, whatever its outcome.
    const claimed = buildHistoryModel([started(), begin(1), done(1), begin(2), done(2, "unchanged", "run-a", { resultKind: "runtime_error" })]);
    assert.deepEqual(counts(claimed), [1]);
    assert.equal(claimed.chat.length, 3, "the start, the closed summary and the completion shown on its own");
    assert.equal(claimed.chat.at(-1).workflowProgress, undefined);
});

test("poll counts never merge across runs or revisions", () => {
    const next2 = { unchanged: "poll", retry: "poll", changed: "end" };
    const both = buildHistoryModel([
        started("run-a", 1), begin(1), done(1), begin(2), done(2),
        started("run-b", 2, next2), begin(1, "run-b"), done(1, "unchanged", "run-b"), begin(2, "run-b"), done(2, "unchanged", "run-b"),
    ]);
    assert.deepEqual(counts(both), [2, 2]);
    assert.deepEqual(progress(both).map(item => item.workflowProgress.runId), ["run-a", "run-b"]);
    assert.match(progress(both)[0].workflowNotice.title, /Polling ended/, "the earlier run's summary is closed when the next run starts");

    // The next run's start is not among the loaded events: its steps are shown singly, never added to the earlier run.
    const unbound = buildHistoryModel([started("run-a", 1), begin(1), done(1), begin(2), done(2), begin(1, "run-b"), done(1, "unchanged", "run-b")]);
    assert.deepEqual(counts(unbound), [2]);
    assert.equal(unbound.chat.length, 4);
    assert.ok(unbound.chat.slice(2).every(item => !item.workflowProgress));

    // The same state of another run with the same step numbers is not dropped as a duplicate.
    const again = buildHistoryModel([started("run-a"), begin(1), done(1), begin(1, "run-b"), done(1, "unchanged", "run-b")]);
    assert.deepEqual(counts(again), [1]);
    assert.equal(again.chat.length, 4);
    assert.match(again.chat.at(-1).text, /Step 1: `poll` → \*\*unchanged\*\*/);
});

test("legacy steps keep their rules and an unclassified step is never a quiet repeat", () => {
    const legacy = (next = { unchanged: "poll", failed: "end" }) => event("workflow.started", { name: "legacy", initial: "poll", states: [
        { id: "poll", type: "script", runtime: "node", next }, { id: "end", type: "terminal", outcome: "succeeded" }] });
    const lstart = step => event("workflow.state_started", { stateId: "poll", step, runtime: "node" });
    const ldone = (step, extra = {}) => event("workflow.state_completed", { stateId: "poll", step, outcome: "unchanged", exitCode: 0, resultSource: "reported", ...extra });
    assert.deepEqual(counts(buildHistoryModel([legacy(), lstart(1), ldone(1), lstart(2), ldone(2), lstart(3), ldone(3)])), [3]);
    const failedExit = buildHistoryModel([legacy(), lstart(1), ldone(1), lstart(2), ldone(2, { exitCode: 1, resultSource: "exit" })]);
    assert.deepEqual(counts(failedExit), [1]);
    assert.equal(failedExit.chat.at(-1).workflowProgress, undefined);
    const bare = buildHistoryModel([legacy(), lstart(1), ldone(1), lstart(2), event("workflow.state_completed", { stateId: "poll", step: 2, outcome: "unchanged" })]);
    assert.deepEqual(counts(bare), [1], "no exit code, result source or v2 result kind: not a quiet repeat");
    const odd = buildHistoryModel([started(), begin(1), done(1), begin(2), done(2, "unchanged", "run-a", { resultKind: "unexpected" })]);
    assert.deepEqual(counts(odd), [1], "an unknown result kind is not trusted");
});

test("the eight control events are workflow events, in the history paging types, and each is logged from its real payload", () => {
    assert.deepEqual(WORKFLOW_CONTROL_EVENT_TYPES, [
        "workflow.paused", "workflow.resumed", "workflow.vars_set", "workflow.input_accepted", "workflow.recovered",
        "workflow.cancel_requested", "workflow.parent_notified", "workflow.parent_notification_skipped",
    ]);
    for (const type of WORKFLOW_CONTROL_EVENT_TYPES) {
        assert.ok(WORKFLOW_EVENT_TYPES.includes(type), type);
        assert.ok(CHAT_HISTORY_EVENT_TYPES.includes(type), type);
        assert.equal(isWorkflowEvent({ eventType: type }), true);
    }
    assert.equal(isWorkflowEvent({ eventType: "workflow.unknown" }), false);
    assert.equal(describeWorkflowEvent(event("workflow.unknown", {})), null);
    assert.equal(formatWorkflowEventText(event("workflow.unknown", {})), null);

    const user = { kind: "user", provider: "entra", subject: "u-1" };
    const cases = [
        [event("workflow.paused", { runId: "r", actor: user, reason: "maintenance" }), "⏸ Workflow paused by user `u-1`: `maintenance`", "paused", "yellow"],
        [event("workflow.resumed", { runId: "r", actor: { kind: "agent", sessionId: "abcdef12-3456" } }), "▶ Workflow resumed by agent `abcdef12`.", "resumed", "gray"],
        [event("workflow.vars_set", { runId: "r", kvRevision: 4, set: ["a", "b"], deleted: ["c"], actor: { kind: "system", name: "controller" } }),
            "✎ Workflow variables updated by `controller` (revision 4): set `a`, `b`; removed `c`.", "variables updated", "gray"],
        [event("workflow.input_accepted", { runId: "r", messageId: "m1", contract: "Ack@1", senderSessionId: "1234567890", claimedBy: null }),
            "✉ Input `Ack@1` from `12345678` accepted by the workflow; it waits for a receive state.", "input accepted", "gray"],
        [event("workflow.input_accepted", { runId: "r", messageId: "m1", contract: "Ack@1", senderSessionId: "1234567890", claimedBy: "nx-1" }),
            "a waiting receive state took it", "input accepted and taken", "gray"],
        [event("workflow.recovered", { runId: "r", action: "dispatched", requestedBy: "abcdef1234", operationId: "op" }),
            "↻ Recovery requested by `abcdef12`: the run was started again.", "recovery requested", "yellow"],
        [event("workflow.cancel_requested", { runId: "r", effects: [{ nodeExecutionId: "n", instanceId: "i", status: "Running" }, { nodeExecutionId: "m", instanceId: "j", status: "Suspended" }] }),
            "⏹ Asked 2 running effects to stop.", "2 effects asked to stop", "yellow"],
        [event("workflow.parent_notified", { runId: "r", parentSessionId: "parent-123456" }),
            "✉ The parent session was told that the run ended (`parent-1`).", "parent told the run ended", "gray"],
        [event("workflow.parent_notification_skipped", { runId: "r", reason: "Parent authority is no longer available" }),
            "✉ The parent session was not told that the run ended: `Parent authority is no longer available`", "parent not told", "yellow"],
    ];
    for (const [row, text, summary, color] of cases) {
        assert.ok(formatWorkflowEventText(row).includes(text), `${row.eventType}: ${formatWorkflowEventText(row)}`);
        const view = describeWorkflowEvent(row);
        assert.deepEqual([view.kind, view.summary, view.color], ["notice", summary, color], row.eventType);
    }
    const history = buildHistoryModel(cases.map(([row]) => row));
    assert.equal(history.events.length, cases.length);
    assert.deepEqual(history.chat.map(item => item.workflowEvent), cases.map(([row]) => row.eventType));
    assert.ok(history.chat.every(item => item.workflowNotice?.summary));
});

test("pause, resume, recovery and a cancel request are rows of their own that do not split or end a poll summary", () => {
    const rows = [started(), begin(1), done(1), begin(2), done(2),
        event("workflow.paused", { runId: "run-a", actor: { kind: "user", provider: "p", subject: "u" } }),
        event("workflow.resumed", { runId: "run-a", actor: { kind: "user", provider: "p", subject: "u" } }),
        event("workflow.recovered", { runId: "run-a", action: "dispatched", requestedBy: "u", operationId: "o" }),
        begin(3), done(3)];
    const history = buildHistoryModel(rows);
    assert.deepEqual(counts(history), [3]);
    assert.deepEqual(history.chat.map(item => item.workflowEvent), [
        "workflow.started", "workflow.state_completed", "workflow.paused", "workflow.resumed", "workflow.recovered"]);
    assert.equal(progress(history)[0].workflowProgress.firstStep, 1);
    let live = buildHistoryModel(rows.slice(0, 3));
    for (const next of rows.slice(3)) live = appendEventToHistory(live, next);
    assert.deepEqual(live.chat, history.chat);

    // A cancel is a terminal row first; the request that follows is logged after it and the summary stays closed.
    const cancelled = buildHistoryModel([started(), begin(1), done(1), begin(2),
        event("workflow.cancelled", { runId: "run-a", reason: "Stopped", command: "done" }),
        event("workflow.cancel_requested", { runId: "run-a", effects: [{ nodeExecutionId: "n", instanceId: "i", status: "Running" }] })]);
    assert.equal(progress(cancelled)[0].workflowProgress.pending, false);
    assert.deepEqual(cancelled.chat.map(item => item.workflowEvent).slice(-2), ["workflow.cancelled", "workflow.cancel_requested"]);
    assert.match(cancelled.chat.at(-1).text, /Asked 1 running effect to stop/);
    // The next run's start still closes the earlier summary when a control row sits between them.
    const nextRun = buildHistoryModel([started(), begin(1), done(1), event("workflow.paused", { runId: "run-a" }), started("run-b", 2), begin(1, "run-b"), done(1, "unchanged", "run-b")]);
    assert.deepEqual(counts(nextRun), [1, 1]);
    assert.match(progress(nextRun)[0].workflowNotice.title, /Polling ended/);
});

test("missing or malformed control payloads still read sensibly and never throw", () => {
    const bare = type => formatWorkflowEventText({ eventType: type });
    assert.equal(bare("workflow.paused"), "⏸ Workflow paused.");
    assert.equal(bare("workflow.resumed"), "▶ Workflow resumed.");
    assert.equal(bare("workflow.vars_set"), "✎ Workflow variables updated.");
    assert.equal(bare("workflow.input_accepted"), "✉ Input accepted by the workflow; it waits for a receive state.");
    assert.equal(bare("workflow.recovered"), "↻ Recovery requested: recovery recorded.");
    assert.equal(bare("workflow.cancel_requested"), "⏹ Asked 0 running effects to stop. They may take a moment to end.");
    assert.equal(bare("workflow.parent_notified"), "✉ The parent session was told that the run ended.");
    assert.equal(bare("workflow.parent_notification_skipped"), "✉ The parent session was not told that the run ended.");
    for (const data of [null, "text", 7, [], [1, 2], { actor: 5, set: "a", deleted: { a: 1 }, effects: "x", claimedBy: 3, reason: ["r"], kvRevision: "4" }]) {
        for (const type of WORKFLOW_CONTROL_EVENT_TYPES) {
            assert.doesNotThrow(() => describeWorkflowEvent({ eventType: type, data }), `${type} ${JSON.stringify(data)}`);
            assert.equal(typeof formatWorkflowEventText({ eventType: type, data }), "string");
        }
    }
    assert.equal(formatWorkflowEventText(event("workflow.vars_set", { set: "a", deleted: { a: 1 }, kvRevision: "4" })), "✎ Workflow variables updated.");
    assert.match(formatWorkflowEventText(event("workflow.paused", { actor: { kind: "robot" } })), /^⏸ Workflow paused\.$/);
    assert.match(formatWorkflowEventText(event("workflow.paused", { actor: { kind: "user" } })), /paused by a user\./);
    assert.match(formatWorkflowEventText(event("workflow.vars_set", { set: ["a", "b", "c", "d", "e", "f", "g"] })), /set `a`, `b`, `c`, `d`, `e` and 2 more/);
});

test("untrusted text is an inline code span: no markup, no line break, bounded", () => {
    const hostile = "`x`\n<script>alert(1)</script> **bold** [l](javascript:1)";
    const paused = formatWorkflowEventText(event("workflow.paused", { actor: { kind: "user", subject: hostile }, reason: hostile }));
    assert.ok(!paused.includes("\n"));
    assert.equal((paused.match(/`/g) || []).length, 4, "two code spans, and no backtick of the payload survives");
    assert.ok(paused.includes("'x' <script>alert(1)</script> **bold** [l](javascript:1)`"));
    const keys = formatWorkflowEventText(event("workflow.vars_set", { set: [hostile, "k".repeat(200)] }));
    assert.ok(!keys.includes("\n"));
    assert.ok(!keys.includes("k".repeat(60)));
    const skipped = formatWorkflowEventText(event("workflow.parent_notification_skipped", { reason: "r".repeat(500) }));
    assert.ok(skipped.length < 300);
    assert.ok(skipped.endsWith("…`"));
    const failed = formatWorkflowEventText(runtimeError(2, "`bad`\ncode", hostile));
    assert.ok(!failed.includes("\n"));
    assert.equal((failed.match(/`/g) || []).length, 6, "state, outcome and error are each one code span");
});

test("the step notice colour follows the result kind, and legacy colours do not change", () => {
    const colour = row => describeWorkflowEvent(row).color;
    assert.equal(colour(done(1)), "green", "a v2 business result has no exit code and is a normal completion");
    assert.equal(colour(done(1, "changed")), "yellow");
    assert.equal(colour(done(1, "failure")), "yellow");
    assert.equal(colour(done(1, "unchanged", "run-a", { resultKind: "runtime_error" })), "red");
    assert.equal(colour(runtimeError(1)), "red");
    const legacy = extra => event("workflow.state_completed", { stateId: "poll", step: 1, outcome: "unchanged", ...extra });
    assert.equal(colour(legacy({ exitCode: 0 })), "green");
    assert.equal(colour(legacy({ resultSource: "reported" })), "green");
    assert.equal(colour(legacy({ exitCode: 1, resultSource: "exit" })), "yellow");
    assert.equal(colour(legacy({})), "yellow");
    assert.equal(describeWorkflowEvent(event("workflow.state_failed", { stateId: "poll", step: 1, error: "boom" })).summary, "poll could not run: boom");
    assert.equal(formatWorkflowEventText(event("workflow.state_failed", { stateId: "poll", step: 1, error: "boom" })), "✗ Step 1: `poll` could not run: boom");
});

test("a v2 runtime error with no error text names the effect or says nothing was recorded", () => {
    const effect = event("workflow.state_failed", { runId: "r", nodeExecutionId: "n", stateId: "poll", step: 2, effectStatus: "Failed", resultKind: "runtime_error" });
    assert.equal(formatWorkflowEventText(effect), "✗ Step 2: `poll` runtime error: `the effect Failed`");
    assert.equal(describeWorkflowEvent(effect).summary, "poll runtime error");
    const none = event("workflow.state_failed", { runId: "r", stateId: "poll", step: 2, outcome: "execution_failed", resultKind: "runtime_error" });
    assert.equal(formatWorkflowEventText(none), "✗ Step 2: `poll` runtime error `execution_failed`: `no error text was recorded`");
    assert.equal(describeWorkflowEvent(none).summary, "poll runtime error execution_failed");
});
