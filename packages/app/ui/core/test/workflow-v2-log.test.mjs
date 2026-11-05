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
    // Re-check UI-RC2-1: runs can run at the same time (test runs beside each other and the live run), so another run's start
    // does not end a summary; its own run's end does.
    assert.match(progress(both)[0].workflowNotice.title, /Waiting for changes/, "the earlier run's summary goes on when another run starts");
    const bothEnded = buildHistoryModel([
        started("run-a", 1), begin(1), done(1), begin(2), done(2),
        started("run-b", 2, next2), begin(1, "run-b"), done(1, "unchanged", "run-b"),
        event("workflow.completed", { runId: "run-a", outcome: "succeeded", stateId: "end" }),
    ]);
    assert.match(progress(bothEnded)[0].workflowNotice.title, /Polling ended/, "its own run's end closes it");
    assert.match(progress(bothEnded)[1].workflowNotice.title, /Waiting for changes/, "and not the other run's");

    // The next run's start is not among the loaded events: its steps are shown singly, never added to the earlier run.
    const unbound = buildHistoryModel([started("run-a", 1), begin(1), done(1), begin(2), done(2), begin(1, "run-b"), done(1, "unchanged", "run-b")]);
    assert.deepEqual(counts(unbound), [2]);
    assert.equal(unbound.chat.length, 4);
    assert.ok(unbound.chat.slice(2).every(item => !item.workflowProgress));

    // Re-check UI-RC2-1: two test runs at the same time, their steps interleaved: each run keeps its own summary; one run's
    // steps never end the other's, and each takes its own run's definition.
    const together = buildHistoryModel([
        started("run-a", 1), begin(1), started("run-b", 2, next2), done(1), begin(1, "run-b"), begin(2),
        done(1, "retry", "run-b"), done(2), begin(2, "run-b"), done(2, "retry", "run-b"),
    ]);
    assert.deepEqual(progress(together).map(item => [item.workflowProgress.runId, item.workflowProgress.count, item.workflowProgress.outcome]),
        [["run-a", 2, "unchanged"], ["run-b", 2, "retry"]]);
    assert.ok(progress(together).every(item => /Waiting for changes/.test(item.workflowNotice.title)), "both still poll");
    const live = [started("run-a", 1), begin(1), started("run-b", 2, next2), done(1), begin(1, "run-b"), begin(2),
        done(1, "retry", "run-b"), done(2), begin(2, "run-b"), done(2, "retry", "run-b")].reduce(appendEventToHistory, buildHistoryModel());
    assert.deepEqual(progress(live).map(item => item.text), progress(together).map(item => item.text));
    // The same state of another run with the same step numbers is not dropped as a duplicate.
    const again = buildHistoryModel([started("run-a"), begin(1), done(1), begin(1, "run-b"), done(1, "unchanged", "run-b")]);
    assert.deepEqual(counts(again), [1]);
    assert.equal(again.chat.length, 4);
    assert.match(again.chat.at(-1).text, /Step `poll` → \*\*unchanged\*\*/);
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
    // An explicit unknown kind is not rescued by legacy fields, and an empty kind is explicit too.
    for (const resultKind of ["unexpected", "", "Business"]) {
        const rescued = buildHistoryModel([started(), begin(1), done(1), begin(2),
            done(2, "unchanged", "run-a", { resultKind, exitCode: 0, resultSource: "reported" })]);
        assert.deepEqual(counts(rescued), [1], JSON.stringify(resultKind));
        assert.equal(rescued.chat.length, 3);
        assert.equal(rescued.chat.at(-1).workflowNotice.color, "yellow", JSON.stringify(resultKind));
    }
    // A null kind is absent: the legacy rule still applies.
    const nullKind = buildHistoryModel([legacy(), lstart(1), ldone(1, { resultKind: null }), lstart(2), ldone(2, { resultKind: null })]);
    assert.deepEqual(counts(nullKind), [2]);
});

test("the nine control events are workflow events, in the history paging types, and each is logged from its real payload", () => {
    assert.deepEqual(WORKFLOW_CONTROL_EVENT_TYPES, [
        "workflow.paused", "workflow.resumed", "workflow.vars_set", "workflow.input_accepted", "workflow.recovered",
        "workflow.cancel_requested", "workflow.stop_requested", "workflow.parent_notified", "workflow.parent_notification_skipped",
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
        [event("workflow.paused", { runId: "r", actor: user, reason: "maintenance" }), "⏸ Workflow paused by `u-1`: `maintenance`", "paused", "yellow"],
        [event("workflow.resumed", { runId: "r", actor: { kind: "agent", sessionId: "abcdef12-3456" } }), "▶ Workflow resumed by `agent session abcdef12`.", "resumed", "gray"],
        [event("workflow.vars_set", { runId: "r", kvRevision: 4, set: ["a", "b"], deleted: ["c"], actor: { kind: "system", name: "controller" } }),
            "✎ Workflow variables updated by `controller` (revision 4): set `a`, `b`; removed `c`.", "variables updated", "gray"],
        [event("workflow.input_accepted", { runId: "r", messageId: "m1", contract: "Ack@1", senderSessionId: "1234567890", claimedBy: null }),
            "✉ Input `Ack@1` from `12345678` accepted by the workflow; it waits for a receive step.", "input accepted", "gray"],
        [event("workflow.input_accepted", { runId: "r", messageId: "m1", contract: "Ack@1", senderSessionId: "1234567890", claimedBy: "nx-1" }),
            "a waiting receive step took it", "input accepted and taken", "gray"],
        [event("workflow.recovered", { runId: "r", action: "dispatched", requestedBy: "abcdef1234", operationId: "op" }),
            "↻ Recovery requested by `abcdef12`: a restart of the run was recorded; this does not show that it has started.", "recovery requested", "yellow"],
        [event("workflow.cancel_requested", { runId: "r", effects: [{ nodeExecutionId: "n", instanceId: "i", status: "Running" }, { nodeExecutionId: "m", instanceId: "j", status: "Suspended" }] }),
            "⏹ Asked 2 running actions to stop.", "2 actions asked to stop", "yellow"],
        // Adversarial review R2-UI-6: a graceful stop's request.
        [event("workflow.stop_requested", { runId: "r", actor: user, graceSeconds: 60, reason: "release freeze" }),
            "⏹ Stop asked by `u-1`: steps already started may finish. Reason: `release freeze`", "stop asked", "yellow"],
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
    assert.match(cancelled.chat.at(-1).text, /Asked 1 running action to stop/);
    // The next run's start still closes the earlier summary when a control row sits between them.
    const nextRun = buildHistoryModel([started(), begin(1), done(1), event("workflow.paused", { runId: "run-a" }), started("run-b", 2), begin(1, "run-b"), done(1, "unchanged", "run-b")]);
    assert.deepEqual(counts(nextRun), [1, 1]);
    assert.match(progress(nextRun)[0].workflowNotice.title, /Polling ended/);
});

// Adversarial review R2-UI-6: a graceful stop's request and the run's stopped end are in the step log, in the first
// history, in a live append and in an older page (the paging types), and the stop ends a summary still waiting.
test("R2-UI-6: a graceful stop is logged from its request to its end, and closes a waiting poll summary", () => {
    for (const type of ["workflow.stop_requested", "workflow.stopped"]) {
        assert.ok(WORKFLOW_EVENT_TYPES.includes(type), type);
        assert.ok(CHAT_HISTORY_EVENT_TYPES.includes(type), type);
        assert.equal(isWorkflowEvent({ eventType: type }), true);
    }
    assert.ok(WORKFLOW_CONTROL_EVENT_TYPES.includes("workflow.stop_requested"));
    assert.ok(!WORKFLOW_CONTROL_EVENT_TYPES.includes("workflow.stopped"), "the end of the run is not a control row");
    const rows = [started(), begin(1), done(1), begin(2), done(2),
        event("workflow.stop_requested", { runId: "run-a", actor: { kind: "agent", sessionId: "abcdef12-3456" }, graceSeconds: 600 }),
        event("workflow.stopped", { runId: "run-a", name: "watch-v2", graceExpired: true, cancelledCount: 1, cancelled: ["nx-run-a-3"], reason: "done for today" })];
    // The first history: the request does not split the summary; the stopped end closes it.
    const history = buildHistoryModel(rows);
    assert.deepEqual(history.chat.map(item => item.workflowEvent), ["workflow.started", "workflow.state_completed", "workflow.stop_requested", "workflow.stopped"]);
    assert.deepEqual(counts(history), [2]);
    assert.equal(progress(history)[0].workflowProgress.waiting, false);
    assert.match(progress(history)[0].workflowNotice.title, /Polling ended/);
    const stopped = describeWorkflowEvent(rows.at(-1));
    assert.deepEqual([stopped.kind, stopped.title, stopped.color], ["card", "Workflow stopped", "yellow"]);
    assert.equal(formatWorkflowEventText(rows.at(-1)),
        "⏹ Workflow stopped: `done for today`; 1 step was still running when the time to finish ended, so it was cancelled.");
    assert.match(formatWorkflowEventText(rows.at(-2)), /^⏹ Stop asked by `agent session abcdef12`: steps already started may finish\.$/);
    // A live append gives the same transcript.
    let live = buildHistoryModel(rows.slice(0, 3));
    for (const next of rows.slice(3)) live = appendEventToHistory(live, next);
    assert.deepEqual(live.chat, history.chat);
    // An older page asks for the paging types: the stop rows are in it, other workflow events are not asked for.
    const page = [...rows.slice(0, 5), event("workflow.branches_cancelled", { runId: "run-a", cancelled: [] }), ...rows.slice(5)]
        .filter(row => CHAT_HISTORY_EVENT_TYPES.includes(row.eventType));
    assert.deepEqual(buildHistoryModel(page).chat.map(item => item.workflowEvent), history.chat.map(item => item.workflowEvent));
    // A stop while a check runs ends that check's summary too.
    const pending = buildHistoryModel([started(), begin(1), done(1), begin(2), done(2), begin(3),
        event("workflow.stop_requested", { runId: "run-a" }), event("workflow.stopped", { runId: "run-a" })]);
    assert.equal(progress(pending)[0].workflowProgress.pending, false);
    assert.equal(progress(pending)[0].workflowProgress.waiting, false);
    assert.equal(formatWorkflowEventText({ eventType: "workflow.stopped" }), "⏹ Workflow stopped.");
});

test("missing or malformed control payloads still read sensibly and never throw", () => {
    const bare = type => formatWorkflowEventText({ eventType: type });
    assert.equal(bare("workflow.paused"), "⏸ Workflow paused.");
    assert.equal(bare("workflow.resumed"), "▶ Workflow resumed.");
    assert.equal(bare("workflow.vars_set"), "✎ Workflow variables updated.");
    assert.equal(bare("workflow.input_accepted"), "✉ Input accepted by the workflow; it waits for a receive step.");
    assert.equal(bare("workflow.recovered"), "↻ Recovery requested: recovery recorded.");
    assert.equal(formatWorkflowEventText(event("workflow.recovered", { action: "other" })), "↻ Recovery requested: action `other` recorded.");
    assert.ok(!/started again|was started/.test(formatWorkflowEventText(event("workflow.recovered", { action: "dispatched" }))), "the event is recorded before the start, so it never claims one");
    assert.equal(bare("workflow.cancel_requested"), "⏹ Asked 0 running actions to stop. They may take a moment to end.");
    assert.equal(bare("workflow.parent_notified"), "✉ The parent session was told that the run ended.");
    assert.equal(bare("workflow.parent_notification_skipped"), "✉ The parent session was not told that the run ended.");
    // D-R1: a skip after an earlier attempt that may have queued the notice says so; the reason stays.
    assert.equal(formatWorkflowEventText(event("workflow.parent_notification_skipped", { runId: "r", reason: "parent is gone", earlierAttempt: true })),
        "✉ The parent session was not told that the run ended: `parent is gone`. An earlier attempt may have told the parent.");
    assert.equal(formatWorkflowEventText(event("workflow.parent_notification_skipped", { earlierAttempt: true })),
        "✉ The parent session was not told that the run ended. An earlier attempt may have told the parent.");
    assert.ok(!formatWorkflowEventText(event("workflow.parent_notification_skipped", { reason: "parent is gone", earlierAttempt: "yes" })).includes("earlier attempt"));
    for (const data of [null, "text", 7, [], [1, 2], { actor: 5, set: "a", deleted: { a: 1 }, effects: "x", claimedBy: 3, reason: ["r"], kvRevision: "4" }]) {
        for (const type of WORKFLOW_CONTROL_EVENT_TYPES) {
            assert.doesNotThrow(() => describeWorkflowEvent({ eventType: type, data }), `${type} ${JSON.stringify(data)}`);
            assert.equal(typeof formatWorkflowEventText({ eventType: type, data }), "string");
        }
    }
    assert.equal(formatWorkflowEventText(event("workflow.vars_set", { set: "a", deleted: { a: 1 }, kvRevision: "4" })), "✎ Workflow variables updated.");
    assert.match(formatWorkflowEventText(event("workflow.paused", { actor: { kind: "robot" } })), /^⏸ Workflow paused\.$/);
    assert.match(formatWorkflowEventText(event("workflow.paused", { actor: { kind: "user" } })), /paused by a person\./);
    // A person is named as the activity list names them: display name, else email, else subject.
    assert.match(formatWorkflowEventText(event("workflow.paused", { actor: { kind: "user", subject: "u-1", email: "ada@example.com", displayName: "Ada" } })),
        /paused by `Ada`\./);
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
    for (const resultKind of ["unexpected", ""]) {
        assert.equal(colour(done(1, "unchanged", "run-a", { resultKind, exitCode: 0, resultSource: "reported" })), "yellow", JSON.stringify(resultKind));
    }
    assert.equal(colour(event("workflow.state_completed", { stateId: "poll", step: 1, outcome: "unchanged", resultKind: null, exitCode: 0 })), "green", "a null kind is absent");
    assert.equal(colour(runtimeError(1)), "red");
    const legacy = extra => event("workflow.state_completed", { stateId: "poll", step: 1, outcome: "unchanged", ...extra });
    assert.equal(colour(legacy({ exitCode: 0 })), "green");
    assert.equal(colour(legacy({ resultSource: "reported" })), "green");
    assert.equal(colour(legacy({ exitCode: 1, resultSource: "exit" })), "yellow");
    assert.equal(colour(legacy({})), "yellow");
    assert.equal(describeWorkflowEvent(event("workflow.state_failed", { stateId: "poll", step: 1, error: "boom" })).summary, "poll could not run: boom");
    assert.equal(formatWorkflowEventText(event("workflow.state_failed", { stateId: "poll", step: 1, error: "boom" })), "✗ Step 1: `poll` could not run: boom");
});

test("an explicit runtime error recorded as a completion reads as a runtime error, not a success", () => {
    const contradictory = done(2, "invalid_output", "run-a", { resultKind: "runtime_error", outputPreview: '{"detail":"x"}' });
    const text = formatWorkflowEventText(contradictory);
    // A version 2 step is named by its step, with its visit after the first; a legacy one keeps its run's step number.
    assert.equal(text, "✗ Step `poll` (visit 2) runtime error `invalid_output`, recorded as a completion: `{\"detail\":\"x\"}`");
    assert.ok(!text.includes("✓") && !text.includes("→ **"));
    const view = describeWorkflowEvent(contradictory);
    assert.deepEqual([view.color, view.summary, view.title], ["red", "poll runtime error invalid_output", "◇ Step (visit 2)"]);
    assert.equal(describeWorkflowEvent(done(1)).title, "◇ Step");
    assert.equal(formatWorkflowEventText(done(2, "x", "run-a", { resultKind: "runtime_error", outputPreview: undefined })), "✗ Step `poll` (visit 2) runtime error `x`, recorded as a completion");
    assert.match(formatWorkflowEventText(done(2, "x", "run-a", { resultKind: "runtime_error", error: "`bad`\nline" })), /: `'bad' line`$/);
    // Business results, including a business "failure", and legacy completions keep their text.
    assert.equal(formatWorkflowEventText(done(3, "failure")), "✓ Step `poll` (visit 3) → **failure**.\nOutput: `{\"n\":1}`");
    assert.match(formatWorkflowEventText(event("workflow.state_completed", { stateId: "poll", step: 1, outcome: "unchanged", exitCode: 1 })), /^✓ Step 1: `poll` → \*\*unchanged\*\*\.$/);
    const history = buildHistoryModel([started(), begin(1), done(1), begin(2), contradictory]);
    assert.equal(history.chat.at(-1).workflowNotice.color, "red");
    assert.match(history.chat.at(-1).text, /^✗ Step `poll` \(visit 2\) runtime error `invalid_output`, recorded as a completion/);
});

test("a v2 step is named by its type and its step; a v2 run's end says no step count it does not have (flow-06)", () => {
    // Each step's own type: a wait, an agent and a terminal step do not claim to be scripts.
    for (const type of ["wait", "agent", "terminal", "script"]) {
        const begun = event("workflow.state_started", { runId: "r", nodeExecutionId: `nx-${type}`, stateId: type, ordinal: 1, type, step: 1 });
        assert.equal(formatWorkflowEventText(begun), `▶ Step \`${type}\` started (${type}).`);
        assert.equal(describeWorkflowEvent(begun).summary, `${type} started (${type})`);
    }
    const ended = event("workflow.completed", { runId: "r", name: "ux-check", outcome: "succeeded", stateId: "done" });
    assert.equal(formatWorkflowEventText(ended), "■ Workflow **ux-check** reached `done`: outcome **succeeded**.");
    // A legacy run's end keeps its step count, as before.
    assert.match(formatWorkflowEventText(event("workflow.completed", { name: "legacy", outcome: "succeeded", stateId: "done", steps: 0 })),
        /reached `done` after 0 steps: outcome/);
});

test("a v2 runtime error with no error text names the effect or says nothing was recorded", () => {
    const effect = event("workflow.state_failed", { runId: "r", nodeExecutionId: "n", stateId: "poll", step: 2, effectStatus: "Failed", resultKind: "runtime_error" });
    assert.equal(formatWorkflowEventText(effect), "✗ Step `poll` (visit 2) runtime error: `the action Failed`");
    assert.equal(describeWorkflowEvent(effect).summary, "poll runtime error");
    const none = event("workflow.state_failed", { runId: "r", stateId: "poll", step: 2, outcome: "execution_failed", resultKind: "runtime_error" });
    assert.equal(formatWorkflowEventText(none), "✗ Step 2: `poll` runtime error `execution_failed`: `no error text was recorded`");
    assert.equal(describeWorkflowEvent(none).summary, "poll runtime error execution_failed");
});
