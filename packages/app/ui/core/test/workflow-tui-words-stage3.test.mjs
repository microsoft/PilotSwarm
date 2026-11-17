/**
 * Workflow Simplified wording pass, stage 3: the TUI (coordinator review 2026-11-07T19:27Z, rows A1 to A33, the text no row
 * covered, and the clearer items). What the other TUI and step-log tests do not already pin:
 * - D-W12: the marks are the words module's (✓ ● ✕ ⊘); ✗ is gone; ○ for a node not reached is the TUI's own;
 * - D-W13: the title's state is one word; its detail is a notice line ("Canceled at once", "Started work and timers continue");
 * - no ids in TUI lines: a session by its name (an agent node's session "review · agent"), else words, never its id;
 * - the session list under a session in words; a status in its one word;
 * - the words module's state word for a raw status, and a server reason that is only a state word is left out;
 * - the step log's Visit table and the whole value's preview line.
 *
 * Run: node --test test/workflow-tui-words-stage3.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController, appReducer, buildHistoryModel, createInitialState, createStore, formatWorkflowEventText, selectWorkflowViewModal } from "../src/index.js";
import { WORKFLOW_STATE_MARKS, workflowReasonShown, workflowRunStateWord } from "../src/workflow-words.js";
import { workflowExecutionValueKey } from "../src/workflow-view.js";
import { RUN, done, readModel, row } from "./workflow-fixtures.mjs";

const AGENT_STATES = [
    { id: "review", type: "agent", invoke: { source: "agent", name: "code-reviewer" }, timeoutSeconds: 600, outcomes: ["accepted"],
        next: { accepted: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
];

/** The TUI's view of the workflow session wf over `model`, with `sessions` loaded besides it; `node` selected. */
function view(model, { sessions = [], node = "poll", events = [] } = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: watch-flow", status: "running", sessionKind: "workflow", parentSessionId: "chat" },
        { sessionId: "chat", title: "Release session", status: "idle" }, ...sessions] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel(events) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model, readModelRunId: null } });
    store.dispatch({ type: "ui/modal", modal: { type: "workflowView", sessionId: "wf", selectedNodeId: node, detailsScroll: 0 } });
    new PilotSwarmUiController({ store, transport: {} });
    const shown = selectWorkflowViewModal(store.getState(), 160, 80);
    return { shown, lines: shown.detailsLines.map(line => line.text.trim()), rows: shown.rows.map(cells => cells.map(cell => cell.text).join("")) };
}

test("D-W12: the rows' marks are the words module's: ✕ for a failed node, never ✗; ○ for one not reached", () => {
    const failed = readModel({ nodeExecutions: [row("poll", 1, "completed", { outcome: "timed_out", resultKind: "runtime_error", winner: "controller" })] });
    const { rows } = view(failed);
    const poll = rows.find(text => text.includes(" poll "));
    assert.ok(poll.includes(`${WORKFLOW_STATE_MARKS.failed.glyph} poll`), poll);
    assert.equal(WORKFLOW_STATE_MARKS.failed.glyph, "✕");
    assert.ok(!rows.some(text => text.includes("✗")), rows.join("\n"));
    assert.ok(rows.find(text => text.includes(" done ")).includes("○ done"), "a node not reached");
});

test("D-W13: one word in the title; Canceled at once and Paused say their detail on a notice line", () => {
    const pausing = view(readModel({ run: { status: "paused", pausedFrom: "running", pauseSettled: false }, nodeExecutions: [row("poll", 1, "pending")] }));
    assert.equal(pausing.shown.title, "Workflow: watch-flow · Paused");
    assert.ok(pausing.lines.includes("! Started work and timers continue"), pausing.lines.join("\n"));
    const canceled = view(readModel({ run: { status: "cancelled" } }));
    assert.equal(canceled.shown.title, "Workflow: watch-flow · Canceled");
    // Why it ended carries the kind: "Canceled at once", with no server reason that is only the state word.
    assert.ok(canceled.lines.some(line => line.startsWith("Why it ended: Canceled at once")), canceled.lines.join("\n"));
    const stopped = view(readModel({ run: { status: "stopped" } }));
    assert.equal(stopped.shown.title, "Workflow: watch-flow · Canceled");
    assert.ok(stopped.lines.some(line => line.startsWith("Why it ended: Canceled after started nodes finished")), stopped.lines.join("\n"));
    assert.ok(!stopped.lines.some(line => /Stopped/.test(line)), "never Stopped");
});

test("no ids: a received message, a send and an agent node's session say the session's name; unloaded, words", () => {
    const inbox = sender => [{ messageId: "m1", contract: "Ack@1", senderSessionId: sender, claimedBy: "nx-await_ack-1", acceptedAt: "2026-11-02T09:00:00Z" }];
    const received = readModel({ nodeExecutions: [done("await_ack", 1, "received")], inbox: inbox("chat") });
    assert.ok(view(received, { node: "await_ack" }).lines.includes("Received Ack@1 from Release session."), view(received, { node: "await_ack" }).lines.join("\n"));
    const unknown = readModel({ nodeExecutions: [done("await_ack", 1, "received")], inbox: inbox("gone-123456") });
    const lines = view(unknown, { node: "await_ack" }).lines;
    assert.ok(lines.includes("Received Ack@1."), lines.join("\n"));
    assert.ok(!lines.some(line => line.includes("gone-123456")));

    const agentModel = readModel({ graph: { revision: 1, initial: "review", states: AGENT_STATES },
        nodeExecutions: [row("review", 1, "pending", { agent: { childSessionId: "child-1", spawned: true, end: null } })] });
    const agentSessions = view(agentModel, { node: "review", sessions: [
        { sessionId: "child-1", title: "Workflow step: review", status: "running", parentSessionId: "wf" },
        { sessionId: "helper-1", title: "Helper", status: "cancelled", parentSessionId: "child-1" },
        { sessionId: "helper-2", title: null, status: "idle", parentSessionId: "child-1" },
    ] }).lines;
    assert.ok(agentSessions.includes("▸ visit 1 · ● running · review · agent"), agentSessions.join("\n"));
    // C: "2 sessions under this agent session:", each by its title and its status in one word.
    assert.ok(agentSessions.includes("2 sessions under this agent session:"), agentSessions.join("\n"));
    assert.ok(agentSessions.includes("Helper · Canceled"), agentSessions.join("\n"));
    assert.ok(agentSessions.includes("untitled session · Waiting"), agentSessions.join("\n"));
    assert.ok(!agentSessions.some(line => /child-1|helper-2/.test(line)), "no session id");
});

test("a status in its one word, never raw; a server reason that is only a state word is left out", () => {
    assert.equal(workflowRunStateWord("cancelled"), "Canceled");
    assert.equal(workflowRunStateWord("stopped"), "Canceled");
    assert.equal(workflowRunStateWord("admitted"), "Running");
    assert.equal(workflowRunStateWord("completed"), "Completed");
    assert.equal(workflowRunStateWord("mystery"), "Not certain");
    assert.equal(workflowRunStateWord(""), null);
    for (const reason of ["Stopped", "stopped.", "cancelled", "Canceled"]) assert.equal(workflowReasonShown(reason), null, reason);
    assert.equal(workflowReasonShown(" release freeze "), "release freeze");
    // The step log's Workflow end: "⊘ … canceled", the reason only when it says more.
    assert.equal(formatWorkflowEventText({ eventType: "workflow.cancelled", data: { runId: RUN, name: "x", reason: "Stopped" } }), "⊘ Workflow **x** canceled.");
    assert.equal(formatWorkflowEventText({ eventType: "workflow.stopped", data: { reason: "Stopped" } }), "⊘ Workflow canceled after started nodes finished.");
});

test("the step log's table counts visits, never steps or runs; a preview too long for one read says so with no parentheses", () => {
    let seq = 0;
    const event = (eventType, data) => ({ sessionId: "wf", seq: ++seq, eventType, data, createdAt: new Date(Date.UTC(2026, 10, 2, 9, 0, seq)) });
    // A script that returns to itself (a loop of one node) is summarised; its table's rows are visits.
    const rows = [event("workflow.started", { runId: RUN, name: "w", initial: "poll", states: [{ id: "poll", type: "script", runtime: "node", next: { changed: "end", retry: "poll" } },
        { id: "end", type: "terminal", outcome: "succeeded" }] })];
    for (const step of [1, 2, 3]) {
        rows.push(event("workflow.state_started", { runId: RUN, nodeExecutionId: `n${step}`, stateId: "poll", step }));
        rows.push(event("workflow.state_completed", { runId: RUN, nodeExecutionId: `n${step}`, stateId: "poll", step, outcome: "retry", resultKind: "business", durationMs: 5 }));
    }
    const progress = buildHistoryModel(rows).chat.find(item => item.workflowProgress);
    assert.ok(progress, "a summary");
    assert.match(progress.text, /\| (Visit|Check) \| Outcome \| Time \| Tools \|/);
    assert.ok(!/\| Step \|/.test(progress.text), progress.text);
    assert.match(progress.workflowNotice.summary, /^\d+ (visits?|checks?)\b/);
    assert.ok(!/\bruns?\b/.test(progress.workflowNotice.summary), progress.workflowNotice.summary);

    const whole = readModel({ nodeExecutions: [done("poll", 1, "changed", { outputPreview: "{\"a\":1" })] });
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: watch-flow", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: whole, readModelRunId: null,
        executionValues: { [workflowExecutionValueKey(RUN, "nx-poll-1")]: { runId: RUN, executionId: "nx-poll-1", phase: "loaded",
            result: { kind: "output", bytes: 2_000_000, whole: false, limitBytes: 1_048_576, preview: "{\"a\":1" } } } } });
    store.dispatch({ type: "ui/modal", modal: { type: "workflowView", sessionId: "wf", selectedNodeId: "poll", detailsScroll: 0 } });
    new PilotSwarmUiController({ store, transport: {} });
    const lines = selectWorkflowViewModal(store.getState(), 160, 80).detailsLines.map(line => line.text.trim());
    assert.ok(lines.includes("Larger than one read · 1,048,576 bytes · start shown:"), lines.join("\n"));
    assert.ok(!lines.some(line => /^Its stored|is more than a read returns/.test(line)));
});
