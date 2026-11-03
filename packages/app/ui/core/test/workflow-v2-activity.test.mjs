/**
 * Workflow v2: who did what, why a run or a step ended, and the sessions under a step (owner decision q14; mocks M09
 * "Inspect audit", M14 "Inspect cancellation", "View owned subtree"):
 *   - the activity is the workflow session's own events, newest first, in plain words, with who acted where the event
 *     names them, for one run and, in a step's details, one visit
 *   - a run that ended says why (completed, failed, cancelled with its reason and who asked, deleted, stopped with what
 *     the grace period cut off); a visit that ended says why (its time limit, the run's cancel or stop, its outcome, a
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
    projectWorkflowV2, workflowV2Activity, workflowV2ActorText, workflowV2EventTime, workflowV2RunEnding, workflowV2SessionSubtree, workflowV2VisitEnding,
} from "../src/workflow-v2-view.js";
import { WorkflowV2NodeContent, WorkflowV2RunActivity } from "../../react/src/workflow-v2-panels.js";
import { RUN, done, readModel } from "./workflow-v2-fixtures.mjs";

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
    assert.deepEqual(workflowV2Activity(EVENTS, { runId: RUN }), [
        { seq: 6, at: "2026-11-03 08:06:00 UTC", what: "Run cancelled: No longer needed", who: null, level: "warning" },
        { seq: 5, at: "2026-11-03 08:05:00 UTC", what: "Step 'poll' failed (cancelled): The workflow run was cancelled.", who: null, level: "error" },
        { seq: 4, at: "2026-11-03 08:04:00 UTC", what: "Variables changed: set a, b; removed c", who: "agent session parent-1", level: "info" },
        { seq: 3, at: "2026-11-03 08:03:00 UTC", what: "Paused: lunch", who: "Alice", level: "warning" },
        { seq: 2, at: "2026-11-03 08:02:00 UTC", what: "Step 'poll' started (visit 1)", who: null, level: "info" },
        { seq: 1, at: "2026-11-03 08:01:00 UTC", what: "Run started (revision 1)", who: null, level: "info" },
    ]);
    assert.deepEqual(workflowV2Activity(EVENTS, { runId: RUN, nodeExecutionId: "nx-poll-1" }).map(row => row.seq), [5, 2]);
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
        "Stop asked; steps already started may finish until 2026-11-03T09:00:00Z: release");
    assert.equal(one("workflow.stopped", { graceExpired: true, cancelledCount: 2 }), "Run stopped; 2 steps still running when the grace period ended were cancelled");
    assert.equal(one("workflow.cancelled", { command: "delete", deleted: true }), "Run cancelled (the workflow was deleted)");
    assert.equal(one("workflow.agent_spawned", { stateId: "review", childSessionId: "child-1234567890", deadline: "2026-11-03T10:00:00Z" }),
        "Agent chat for step 'review' created (session child-12); its time limit is 2026-11-03T10:00:00Z");
    assert.equal(one("workflow.agent_ended", { stateId: "review", end: "cancel" }), "Agent chat for step 'review' ended (cancelled)");
    assert.equal(one("workflow.request_delivered", { contract: "Review@1", responderSessionId: "reviewer-1", deadlineAt: "2026-11-03T10:00:00Z" }),
        "Request Review@1 sent to session reviewer; answer due by 2026-11-03T10:00:00Z");
    assert.equal(one("workflow.response_wake_abandoned", {}), "An answer arrived, but waking the run was not confirmed; the run collects the answer later");
    assert.equal(one("workflow.state_completed", { stateId: "review", outcome: "accepted" }), "Step 'review' ended 'accepted'");
    assert.equal(one("workflow.completed", { outcome: "succeeded", stateId: "done" }), "Run ended succeeded at 'done'");
    assert.equal(one("workflow.unknown_kind", {}), undefined);
});

test("a run that ended says why: completed, failed, cancelled with its reason and who asked, deleted, stopped", () => {
    assert.equal(workflowV2RunEnding({ runId: RUN, status: "running" }, EVENTS), null);
    const envelope = JSON.stringify({ code: "cancelled", message: "No longer needed", details: { command: "cancel", requestedBy: "parent-1234567890" } });
    assert.deepEqual(workflowV2RunEnding({ runId: RUN, status: "cancelled", error: envelope }, EVENTS), {
        status: "cancelled", why: "It was cancelled: No longer needed", who: "session parent-1", at: "2026-11-03 08:06:00 UTC",
        text: "Why it ended: It was cancelled: No longer needed. Asked by session parent-1. (2026-11-03 08:06:00 UTC)" });
    assert.equal(workflowV2RunEnding({ runId: RUN, status: "cancelled" }, [event(1, "workflow.cancelled", { command: "delete", deleted: true })]).why,
        "The workflow was deleted");
    assert.equal(workflowV2RunEnding({ runId: RUN, status: "completed", terminalState: "done", outcome: "succeeded" }, []).text,
        "Why it ended: It reached 'done' (succeeded).");
    assert.equal(workflowV2RunEnding({ runId: RUN, status: "failed", error: JSON.stringify({ code: "timed_out", message: "The run's time limit passed." }) }, []).why,
        "A runtime error (timed_out): The run's time limit passed.");
    assert.equal(workflowV2RunEnding({ runId: RUN, status: "failed", terminalState: "failed", outcome: "rejected" }, []).why, "It reached 'failed' (rejected)");
    const stopped = workflowV2RunEnding({ runId: RUN, status: "stopped", stop: { reason: "release freeze" } }, [
        event(1, "workflow.stop_requested", { actor: ALICE, reason: "release freeze" }),
        event(2, "workflow.stopped", { reason: "release freeze", graceExpired: true, cancelledCount: 1 }),
    ]);
    assert.equal(stopped.text, "Why it ended: It was stopped: release freeze; 1 step still running when the grace period ended was cancelled. "
        + "Asked by Alice. (2026-11-03 08:02:00 UTC)");
});

test("a visit that ended says why, and how its agent chat ended", () => {
    assert.equal(workflowV2VisitEnding({ status: "pending" }), null);
    assert.equal(workflowV2VisitEnding({ status: "completed", outcome: "timed_out", resultKind: "runtime_error", winner: "controller",
        errorPreview: JSON.stringify({ code: "timed_out", message: "The agent did not finish in 600 s." }), agent: { end: "cancel" } }).text,
    "Its time limit passed. The agent did not finish in 600 s. Its agent chat ended (cancelled).");
    assert.equal(workflowV2VisitEnding({ status: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "cancel",
        errorPreview: JSON.stringify({ code: "cancelled", message: "The workflow run was cancelled." }) }).text, "The run was cancelled while it ran.");
    assert.equal(workflowV2VisitEnding({ status: "completed", outcome: "accepted", resultKind: "business", winner: "agent", agent: { end: "done" } }).text,
        "It ended 'accepted'. Its agent chat ended (its result was taken).");
    assert.equal(workflowV2VisitEnding({ status: "completed", outcome: "crashed", resultKind: "runtime_error", winner: "controller",
        errorPreview: JSON.stringify({ code: "crashed", message: "exit code 1" }) }).text, "A runtime error (crashed). exit code 1");
    assert.equal(workflowV2VisitEnding({ status: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "fail_fast" }).why,
        "Another branch failed, so this one was cancelled");
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
    assert.equal(projected.ending.text, "Why it ended: It was cancelled: No longer needed. Asked by session parent-1. (2026-11-03 08:06:00 UTC)");
    assert.equal(projectWorkflowV2({ readModel: readModel(), events: EVENTS }).ending, null, "a running run has none");

    const html = renderToStaticMarkup(React.createElement(WorkflowV2RunActivity, { ending: projected.ending, events: EVENTS, runId: RUN }));
    assert.match(html, /<section class="ps-workflow-run-activity" aria-label="Run activity"/);
    assert.match(html, /<p role="status" data-ending="cancelled"[^>]*>Why it ended: It was cancelled: No longer needed\./);
    assert.match(html, /<summary>Activity of this run \(6\)<\/summary>/);
    assert.match(html, /<li data-level="warning"[^>]*>2026-11-03 08:03:00 UTC · Paused: lunch · by Alice<\/li>/);
    assert.equal(renderToStaticMarkup(React.createElement(WorkflowV2RunActivity, { ending: null, events: [], runId: RUN })), "");

    const poll = projected.nodes.find(node => node.id === "poll");
    const details = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, { tab: "details", selected: poll, nodes: projected.nodes, select: () => {},
        runOutput: null, runError: null, runId: RUN, events: EVENTS }));
    assert.match(details, /<span>Why it ended<\/span><strong>The run was cancelled while it ran\.<\/strong>/);
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
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: watch-v2", status: "cancelled", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel(EVENTS) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: cancelledModel(), readModelRunId: null } });
    store.dispatch({ type: "ui/modal", modal: { type: "workflowView", sessionId: "wf", selectedNodeId: "poll", detailsScroll: 0 } });
    new PilotSwarmUiController({ store, transport: {} });
    const lines = selectWorkflowViewModal(store.getState(), 160, 80).detailsLines.map(line => line.text.trim());
    const text = lines.join(" ");
    assert.ok(text.includes("Why it ended: It was cancelled: No longer needed. Asked by session parent-1. (2026-11-03 08:06:00 UTC)"), lines.join("\n"));
    assert.ok(lines.includes("Why it ended: The run was cancelled while it ran."), lines.join("\n"));
    assert.ok(lines.includes("Activity of this visit (newest first):"), lines.join("\n"));
    assert.ok(lines.includes("2026-11-03 08:05:00 UTC · Step 'poll' failed (cancelled): The workflow run was cancelled."), lines.join("\n"));
});
