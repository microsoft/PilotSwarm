/**
 * Workflow v2: who did what, why a run or a step ended, and the sessions under a step (owner decision q14; mocks M09
 * "Inspect audit", M14 "Inspect cancellation", "View owned subtree"):
 *   - the activity is the workflow session's own events, newest first, in plain words, with who acted where the event
 *     names them, for one run and, in a step's details, one visit
 *   - a run that ended says why (completed, failed, cancelled with its reason and who asked, deleted, stopped with what
 *     the time to finish cut off); a visit that ended says why (its time limit, the run's cancel or stop, its outcome, a
 *     runtime error with its message) and how its agent chat ended
 *   - an agent step lists the sessions its chat started, as loaded, each openable read-only
 *
 * Run: node --test test/workflow-v2-activity.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowViewModal } from "../src/index.js";
import {
    projectWorkflowV2, workflowEventText, workflowV2Activity, workflowV2ActorText, workflowV2EventTime, workflowV2RunEnding, workflowV2SessionSubtree, workflowV2VisitEnding,
} from "../src/workflow-v2-view.js";
import { WorkflowV2NodeContent, WorkflowV2RunActivity } from "../../react/src/workflow-v2-panels.js";
import { RUN, done, readModel } from "./workflow-v2-fixtures.mjs";

// Times are shown in the reader's own time zone (owner decision local-time-20261104): this file fixes it to UTC, so no
// result depends on the zone of the machine that runs it.
process.env.TZ = "UTC";

const at = minute => `2026-11-03T08:${String(minute).padStart(2, "0")}:00.000Z`;
const event = (seq, eventType, data, minute = seq) => ({ seq, eventType, data: { runId: RUN, ...data }, createdAt: at(minute) });
const ALICE = { kind: "user", provider: "test", subject: "alice", displayName: "Alice" };
const EVENTS = [
    event(1, "workflow.started", { mode: "live", revision: 1 }),
    event(2, "workflow.state_started", { nodeExecutionId: "nx-poll-1", stateId: "poll", ordinal: 1 }),
    event(3, "workflow.paused", { actor: ALICE, reason: "lunch" }),
    event(4, "workflow.vars_set", { actor: { kind: "agent", sessionId: "parent-1234567890" }, set: ["a", "b"], deleted: ["c"] }),
    event(5, "workflow.state_failed", { nodeExecutionId: "nx-poll-1", stateId: "poll", outcome: "cancelled",
        error: JSON.stringify({ code: "cancelled", message: "The workflow run was cancelled." }) }),
    event(6, "workflow.cancelled", { reason: "No longer needed", command: "cancel" }),
    { seq: 7, eventType: "workflow.paused", data: { runId: "run-2", actor: ALICE }, createdAt: at(7) },
    { seq: 8, eventType: "session.idle", data: {}, createdAt: at(8) },
];

test("the activity lists who did what, newest first, for one run and one visit", () => {
    // Stage 2.4: each row also names its event and the visit it is about (the replay links them), checked below.
    assert.deepEqual(workflowV2Activity(EVENTS, { runId: RUN }).map(({ eventType: _type, nodeExecutionId: _visit, ...row }) => row), [
        // OF-S2-2 part 2: the time without its zone (the zone is in atTitle), a mark for a state change, the node first.
        { seq: 6, at: "2026-11-03 08:06:00", atTitle: "2026-11-03 08:06:00 UTC", what: "⊘ Canceled: No longer needed", who: null, level: "warning", title: "Canceled at once" },
        { seq: 5, at: "2026-11-03 08:05:00", atTitle: "2026-11-03 08:05:00 UTC", what: "⊘ poll canceled: The workflow run was cancelled.", who: null, level: "warning" },
        { seq: 4, at: "2026-11-03 08:04:00", atTitle: "2026-11-03 08:04:00 UTC", what: "Variables · set a, b · removed c", who: "an agent", level: "info" },
        { seq: 3, at: "2026-11-03 08:03:00", atTitle: "2026-11-03 08:03:00 UTC", what: "Paused: lunch", who: "Alice", level: "warning" },
        { seq: 2, at: "2026-11-03 08:02:00", atTitle: "2026-11-03 08:02:00 UTC", what: "● poll started", who: null, level: "info" },
        { seq: 1, at: "2026-11-03 08:01:00", atTitle: "2026-11-03 08:01:00 UTC", what: "● Started · revision 1", who: null, level: "info" },
    ]);
    assert.deepEqual(workflowV2Activity(EVENTS, { runId: RUN, nodeExecutionId: "nx-poll-1" }).map(row => row.seq), [5, 2]);
    assert.deepEqual(workflowV2Activity(EVENTS, { runId: RUN }).map(row => [row.seq, row.eventType, row.nodeExecutionId]).filter(([seq]) => seq === 2 || seq === 3),
        [[3, "workflow.paused", null], [2, "workflow.state_started", "nx-poll-1"]]);
    assert.deepEqual(workflowV2Activity(EVENTS, { runId: RUN, limit: 2 }).map(row => row.seq), [6, 5]);
    assert.deepEqual(workflowV2Activity(EVENTS, { runId: "run-2" }).map(row => [row.what, row.who]), [["Paused", "Alice"]]);
    assert.deepEqual(workflowV2Activity(null), []);
    assert.equal(workflowV2ActorText({ kind: "user", subject: "bob" }), "bob");
    assert.equal(workflowV2ActorText({ kind: "system", name: "sweeper" }), "sweeper");
    assert.equal(workflowV2ActorText(null), null);
    assert.equal(workflowV2EventTime("not a time"), null);
    // Each kind of event the list knows, in plain words.
    const one = (type, data) => workflowV2Activity([event(1, type, data)], { runId: RUN })[0]?.what;
    assert.equal(one("workflow.stop_requested", { deadlineAt: "2026-11-03T09:00:00Z", reason: "release" }),
        "Stop asked · started nodes may finish until 2026-11-03 09:00:00: release");
    // Review 18:45Z (D-W1): a stop either way reads Canceled; how is the line's tooltip.
    assert.equal(one("workflow.stopped", { graceExpired: true, cancelledCount: 2 }), "⊘ Canceled · 2 started nodes canceled");
    assert.equal(workflowV2Activity([event(1, "workflow.stopped", { graceExpired: true, cancelledCount: 2 })], { runId: RUN })[0].title,
        "Canceled after started nodes finished; 2 were still running when the time to finish ended");
    assert.equal(one("workflow.stopped", { reason: "release" }), "⊘ Canceled: release");
    assert.equal(workflowV2Activity([event(1, "workflow.cancelled", {})], { runId: RUN })[0].title, "Canceled at once");
    assert.equal(one("workflow.cancelled", { command: "delete", deleted: true }), "⊘ Canceled · deleted");
    assert.equal(one("workflow.agent_spawned", { stateId: "review", childSessionId: "child-1234567890", deadline: "2026-11-03T10:00:00Z" }),
        "review · chat started · limit 2026-11-03 10:00:00");
    assert.equal(one("workflow.agent_ended", { stateId: "review", end: "cancel" }), "review · chat ended · canceled");
    assert.equal(one("workflow.request_delivered", { contract: "Review@1", responderSessionId: "reviewer-1", deadlineAt: "2026-11-03T10:00:00Z" }),
        "Ask Review@1 sent · answer by 2026-11-03 10:00:00");
    assert.equal(one("workflow.response_wake_abandoned", {}), "Answer arrived · the Workflow takes it next");
    assert.equal(one("workflow.state_completed", { stateId: "review", outcome: "accepted" }), "✓ review · accepted");
    assert.equal(one("workflow.state_failed", { stateId: "review", outcome: "timed_out", error: "{\"message\":\"Too slow.\"}" }), "✕ review · limit: Too slow.");
    assert.equal(one("workflow.completed", { outcome: "succeeded", stateId: "done" }), "✓ Completed at done");
    assert.equal(one("workflow.unknown_kind", {}), undefined);
    // ui-05: a failed step with no error text says what happened to its action, as the step log does.
    assert.equal(one("workflow.state_failed", { stateId: "poll", effectStatus: "Failed", resultKind: "runtime_error" }), "✕ poll · error: the action Failed");
});

test("Q2: a step's reminder has a line in the workflow's activity and in the agent chat's activity", () => {
    const reminded = event(1, "workflow.agent_reminded", { nodeExecutionId: "nx-review-1", stateId: "review", childSessionId: "child-1", turn: 2, n: 1, max: 3 });
    assert.equal(workflowV2Activity([reminded], { runId: RUN })[0].what, "review · reminded to finish · 1/3");
    // In the step's details, for its visit only.
    assert.equal(workflowV2Activity([reminded], { runId: RUN, nodeExecutionId: "nx-review-1" }).length, 1);
    assert.equal(workflowV2Activity([reminded], { runId: RUN, nodeExecutionId: "nx-other" }).length, 0);
    // Words (Workflow Simplified 03): a node, not a step.
    assert.equal(workflowEventText("workflow.agent_reminded", {}, "short").text, "A node · reminded to finish");
    // The agent chat's own activity: the reminder it got inside its turn, one gray line.
    const { activity, chat } = buildHistoryModel([{ seq: 7, sessionId: "child-1", eventType: "runtime.workflow_step_reminded", createdAt: at(7),
        data: { stateId: "review", n: 2, max: 3, sessionId: "child-1" } }]);
    assert.equal(activity.length, 1);
    assert.match(activity[0].text, /\[workflow\] Reminded to finish step 'review' \(2 of 3\)$/);
    assert.deepEqual(activity[0].line.slice(-2).map(run => run.color), ["gray", "gray"], "a gray line");
    assert.equal(chat.length, 0);
    const bare = buildHistoryModel([{ seq: 8, sessionId: "child-1", eventType: "runtime.workflow_step_reminded", createdAt: at(8), data: {} }]).activity;
    assert.match(bare[0].text, /\[workflow\] Reminded to finish its step$/);
});

test("one sentence table: each event says the same thing on every screen that shows it, and only those screens show it (ui-05)", () => {
    // Activity-only events have no step-log line; log-only events have no activity line; the run's control events have both.
    // A stop asked and a run stopped are control events: the step log shows them too (adversarial review R2-UI-6).
    assert.equal(workflowEventText("workflow.cancelled", {}, "long"), null);
    assert.equal(workflowEventText("workflow.parent_notified", {}, "short"), null);
    for (const type of ["workflow.paused", "workflow.resumed", "workflow.vars_set", "workflow.input_accepted", "workflow.recovered", "workflow.cancel_requested",
        "workflow.stop_requested", "workflow.stopped"]) {
        assert.ok(workflowEventText(type, {}, "short")?.text, `${type} short`);
        assert.ok(workflowEventText(type, {}, "long")?.text, `${type} long`);
    }
    // The pause both screens show names the same person.
    assert.equal(workflowEventText("workflow.paused", { actor: ALICE, reason: "lunch" }, "long").text, "⏸ Workflow paused by `Alice`: `lunch`");
    assert.equal(workflowV2Activity([event(1, "workflow.paused", { actor: ALICE, reason: "lunch" })], { runId: RUN })[0].who, "Alice");
    assert.equal(workflowEventText("workflow.unknown_kind", {}, "short"), null);
    assert.equal(workflowEventText("workflow.paused", null, "other"), null);
    assert.equal(workflowEventText(7, {}, "short"), null);
});

test("D-R1: the activity line of a skipped run-end notice says when an earlier attempt may have told the parent", () => {
    const skip = data => workflowV2Activity([{ seq: 1, eventType: "workflow.parent_notification_skipped", createdAt: "2026-11-04T08:00:00Z", data: { runId: "r", ...data } }])[0];
    assert.equal(skip({ reason: "parent is gone", earlierAttempt: true }).what, "Parent not told: parent is gone. An earlier attempt may have told it.");
    assert.equal(skip({ reason: "notifications are off" }).what, "Parent not told: notifications are off.");
    assert.equal(skip({ reason: "parent is gone", earlierAttempt: true }).level, "warning");
});

// Review 19:27Z (rows 18 to 20): the kind of cancel in the line, who asked by name (never an id), the one short time; a
// reason that is only a state word is left out.
const NAMES = id => ({ "parent-1234567890": "Release chat" })[id] ?? null;

test("a run that ended says why: completed, failed, cancelled with its reason and who asked, deleted, stopped", () => {
    assert.equal(workflowV2RunEnding({ runId: RUN, status: "running" }, EVENTS), null);
    const envelope = JSON.stringify({ code: "cancelled", message: "No longer needed", details: { command: "cancel", requestedBy: "parent-1234567890" } });
    assert.deepEqual(workflowV2RunEnding({ runId: RUN, status: "cancelled", error: envelope }, EVENTS, NAMES), {
        status: "cancelled", why: "Canceled at once: No longer needed", who: "Release chat", at: "2026-11-03 08:06:00",
        text: "Why it ended: Canceled at once: No longer needed · by Release chat · 2026-11-03 08:06:00" });
    assert.equal(workflowV2RunEnding({ runId: RUN, status: "cancelled", error: envelope }, EVENTS).who, null, "no name loaded: nobody named, never an id");
    assert.equal(workflowV2RunEnding({ runId: RUN, status: "cancelled" }, [event(1, "workflow.cancelled", { command: "delete", deleted: true })]).why,
        "Canceled · deleted");
    assert.equal(workflowV2RunEnding({ runId: RUN, status: "cancelled" }, [event(1, "workflow.cancelled", { reason: "Stopped" })]).why, "Canceled at once",
        "never 'Canceled at once: Stopped'");
    assert.equal(workflowV2RunEnding({ runId: RUN, status: "completed", terminalState: "done", outcome: "succeeded" }, []).text,
        "Why it ended: Reached done · succeeded");
    assert.equal(workflowV2RunEnding({ runId: RUN, status: "failed", error: JSON.stringify({ code: "timed_out", message: "The run's time limit passed." }) }, []).why,
        "Error · limit: The run's time limit passed.");
    assert.equal(workflowV2RunEnding({ runId: RUN, status: "failed", terminalState: "failed", outcome: "rejected" }, []).why, "Reached failed · rejected");
    const stopped = workflowV2RunEnding({ runId: RUN, status: "stopped", stop: { reason: "release freeze" } }, [
        event(1, "workflow.stop_requested", { actor: ALICE, reason: "release freeze" }),
        event(2, "workflow.stopped", { reason: "release freeze", graceExpired: true, cancelledCount: 1 }),
    ]);
    assert.equal(stopped.text, "Why it ended: Canceled after started nodes finished: release freeze · 1 started node canceled when the time to finish ended "
        + "· by Alice · 2026-11-03 08:02:00");
});

test("a visit that ended says why, and how its agent chat ended", () => {
    assert.equal(workflowV2VisitEnding({ status: "pending" }), null);
    assert.equal(workflowV2VisitEnding({ status: "completed", outcome: "timed_out", resultKind: "runtime_error", winner: "controller",
        errorPreview: JSON.stringify({ code: "timed_out", message: "The agent did not finish in 600 s." }), agent: { end: "cancel" } }).text,
    "Its limit passed: The agent did not finish in 600 s. Chat ended · canceled.");
    assert.equal(workflowV2VisitEnding({ status: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "cancel",
        errorPreview: JSON.stringify({ code: "cancelled", message: "The workflow run was cancelled." }) }).text, "The Workflow was canceled while it ran.");
    assert.equal(workflowV2VisitEnding({ status: "completed", outcome: "accepted", resultKind: "business", winner: "agent", agent: { end: "done" } }).text,
        "Done · accepted. Chat ended · result taken.");
    assert.equal(workflowV2VisitEnding({ status: "completed", outcome: "crashed", resultKind: "runtime_error", winner: "controller",
        errorPreview: JSON.stringify({ code: "crashed", message: "exit code 1" }) }).text, "Error · crashed: exit code 1.");
    assert.equal(workflowV2VisitEnding({ status: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "fail_fast" }).why,
        "Another item failed, so this one was canceled");
});

const SESSIONS = {
    wf: { sessionId: "wf", sessionKind: "workflow", title: "Workflow: review", status: "running", parentSessionId: "parent" },
    child: { sessionId: "child", title: "Workflow step: review", status: "idle", parentSessionId: "wf" },
    helper: { sessionId: "helper", title: "Helper", status: "running", parentSessionId: "child" },
    nested: { sessionId: "nested", title: null, status: "completed", parentSessionId: "helper" },
    other: { sessionId: "other", title: "Other", status: "idle", parentSessionId: "parent" },
};

test("the sessions under a step are its agent chat and every session started under it, in tree order", () => {
    assert.deepEqual(workflowV2SessionSubtree(SESSIONS, "child"), [
        { sessionId: "child", title: "Workflow step: review", status: "idle", depth: 0 },
        { sessionId: "helper", title: "Helper", status: "running", depth: 1 },
        { sessionId: "nested", title: null, status: "completed", depth: 2 },
    ]);
    assert.deepEqual(workflowV2SessionSubtree(SESSIONS, "missing"), [{ sessionId: "missing", title: null, status: "not loaded", depth: 0 }]);
    assert.deepEqual(workflowV2SessionSubtree(SESSIONS, "child", 2).map(entry => entry.sessionId), ["child", "helper"]);
    assert.deepEqual(workflowV2SessionSubtree(null, "child"), []);
});

const cancelledModel = () => readModel({
    run: { status: "cancelled", error: JSON.stringify({ code: "cancelled", message: "No longer needed", details: { command: "cancel", requestedBy: "parent-1234567890" } }) },
    nodeExecutions: [done("poll", 1, "cancelled", { resultKind: "runtime_error", winner: "cancel",
        errorPreview: JSON.stringify({ code: "cancelled", message: "The workflow run was cancelled." }) })],
});

test("the portal says why the run ended and lists its activity; a step's details say why its visit ended, with that visit's activity", () => {
    const projected = projectWorkflowV2({ readModel: cancelledModel(), events: EVENTS });
    assert.equal(projected.ending.text, "Why it ended: Canceled at once: No longer needed · 2026-11-03 08:06:00");
    assert.equal(projectWorkflowV2({ readModel: cancelledModel(), events: EVENTS, sessionName: NAMES }).ending.who, "Release chat");
    assert.equal(projectWorkflowV2({ readModel: readModel(), events: EVENTS }).ending, null, "a running run has none");

    const html = renderToStaticMarkup(React.createElement(WorkflowV2RunActivity, { ending: projected.ending, events: EVENTS, runId: RUN }));
    assert.match(html, /<section class="ps-workflow-run-activity" aria-label="Run activity"/);
    assert.match(html, /<p role="status" data-ending="cancelled"[^>]*>Why it ended: Canceled at once: No longer needed/);
    assert.match(html, /<summary>Activity of this run \(6\)<\/summary>/);
    assert.match(html, /<li data-level="warning"[^>]*>2026-11-03 08:03:00 · Paused: lunch · by Alice<\/li>/);
    assert.equal(renderToStaticMarkup(React.createElement(WorkflowV2RunActivity, { ending: null, events: [], runId: RUN })), "");

    const poll = projected.nodes.find(node => node.id === "poll");
    const details = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, { tab: "details", selected: poll, nodes: projected.nodes, select: () => {},
        runOutput: null, runError: null, runId: RUN, events: EVENTS }));
    assert.match(details, /<span>Why it ended<\/span><strong>The Workflow was canceled while it ran\.<\/strong>/);
    assert.match(details, /<summary>Activity of this visit \(2\)<\/summary>/);
});

test("an agent step lists the sessions its chat started, each openable read-only", () => {
    const states = [{ id: "review", type: "agent", invoke: { source: "prompt" }, outcomes: ["accepted"], next: { accepted: "done" } },
        { id: "done", type: "terminal", outcome: "succeeded" }];
    const model = readModel({ graph: { revision: 1, initial: "review", states },
        nodeExecutions: [{ nodeExecutionId: "nx-review-1", stateId: "review", ordinal: 1, state: "pending", outcome: null, resultKind: null, winner: null,
            attempts: 0, kvRevision: 1, agent: { childSessionId: "child", spawned: true, end: null } }] });
    const projected = projectWorkflowV2({ readModel: model });
    const review = projected.nodes.find(node => node.id === "review");
    const html = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, { tab: "details", selected: review, nodes: projected.nodes, select: () => {},
        runOutput: null, runError: null, runId: RUN, openSession: () => {}, sessionsById: SESSIONS }));
    assert.match(html, /aria-label="Sessions under this step"><h3>Sessions under this step \(2\)<\/h3>/);
    assert.match(html, /<li data-session="helper"[^>]*>Helper · running<button[^>]*data-action="open-session"[^>]*>Open \(read-only\)<\/button><\/li>/);
    assert.match(html, /<li data-session="nested"[^>]*>nested · completed/);
    // Only the transition buttons and the agent's own chat use the transition class; the session buttons do not.
    assert.equal([...html.matchAll(/class="ps-workflow-transition"/g)].length, 2);
});

test("the TUI says why the run and the visit shown ended, lists that visit's activity and the sessions under an agent chat", () => {
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "local" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: watch-v2", status: "cancelled", sessionKind: "workflow" },
        { sessionId: "parent-1234567890", title: "Release chat", status: "idle" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel(EVENTS) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: cancelledModel(), readModelRunId: null } });
    store.dispatch({ type: "ui/modal", modal: { type: "workflowView", sessionId: "wf", selectedNodeId: "poll", detailsScroll: 0 } });
    new PilotSwarmUiController({ store, transport: {} });
    const lines = selectWorkflowViewModal(store.getState(), 160, 80).detailsLines.map(line => line.text.trim());
    const text = lines.join(" ");
    // Review 19:27Z (row 20): who asked, by the session's name.
    assert.ok(text.includes("Why it ended: Canceled at once: No longer needed · by Release chat · 2026-11-03 08:06:00"), lines.join("\n"));
    assert.ok(!text.includes("parent-1"), "never the session's id");
    assert.ok(lines.includes("Why it ended: The Workflow was canceled while it ran."), lines.join("\n"));
    assert.ok(lines.includes("Activity of this visit · newest first:"), lines.join("\n"));
    assert.ok(lines.includes("2026-11-03 08:05:00 · ⊘ poll canceled: The workflow run was cancelled."), lines.join("\n"));
});
