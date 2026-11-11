import test from "node:test";
import assert from "node:assert/strict";
import { workflowDefinition, layoutWorkflowGraph, projectWorkflow, projectWorkflowReadModel, compactWorkflowExecutions, formatWorkflowValue, workflowRouteKind, workflowWaitingReplies, workflowWaitingRepliesLabel, workflowWaitingRepliesNotice } from "../src/workflow-view.js";
import {
    RUN, states, requestStates, startedData, ev, started, completed, runtimeError, ended, row, done, readModel,
} from "./workflow-fixtures.mjs";

// Times are shown in the reader's own time zone (owner decision local-time-20261104): this file fixes it to UTC, so no
// result depends on the zone of the machine that runs it.
process.env.TZ = "UTC";

const definition = workflowDefinition(startedData);
const byId = (projection, id) => projection.nodes.find(node => node.id === id);

test("a definition is checked: unsupported or mixed payloads are refused with a reason", () => {
    assert.deepEqual(definition.states, states);
    assert.equal(definition.name, "watch-flow");
    assert.throws(() => workflowDefinition({ ...startedData, states: [...states, { id: "x", type: "teleport", next: {} }] }), /invalid or unsupported node/);
    assert.throws(() => workflowDefinition({ ...startedData, states: [{ id: "poll", type: "script", runtime: "node", next: {} }, states[4]] }), /valid script node/);
    assert.throws(() => workflowDefinition({ ...startedData, states: [{ ...states[0], next: { changed: "nowhere" } }] }), /node that is not defined/);
    assert.throws(() => workflowDefinition({ ...startedData, states: [states[2], states[4], states[5]], initial: "elsewhere" }), /start node/);
    assert.throws(() => workflowDefinition({ states: [{ id: "m", type: "messaging", mode: "teleport", contract: "A@1", outcomes: [], next: {} }] }), /messaging mode/);
    // A payload that names no outcomes for its script state is not a Workflow's.
    assert.throws(() => workflowDefinition({ name: "watch", initial: "poll", states: [
        { id: "poll", type: "script", runtime: "node", next: { changed: "end" } }, { id: "end", type: "terminal", outcome: "succeeded" }] }), /lists no outcomes/);
});

test("a business result is done, not failed, and a runtime error is told apart from a business outcome", () => {
    const business = projectWorkflow({ definition, events: [started("poll", 1), completed("poll", 1, "changed", '{"n":1}')] });
    assert.equal(byId(business, "poll").state, "done");
    assert.equal(byId(business, "poll").stateLabel, "Done · changed");
    assert.equal(byId(business, "poll").resultKind, "business");
    const failedOutcome = projectWorkflow({ definition, events: [completed("poll", 1, "failure")] });
    assert.equal(byId(failedOutcome, "poll").state, "done", "a business outcome named failure is not a runtime error");
    const error = projectWorkflow({ definition, events: [completed("poll", 1, "changed"), runtimeError("poll", 2, "timed_out", "Script timed out")] });
    assert.equal(byId(error, "poll").state, "failed");
    assert.equal(byId(error, "poll").stateLabel, "Failed · limit");
    assert.equal(byId(error, "poll").result.errorPreview, "Script timed out");
});

test("run status separates a workflow's own terminal outcome from a runtime or controller failure", () => {
    const succeeded = projectWorkflow({ readModel: readModel({ run: { status: "completed", outcome: "succeeded", terminalState: "done" } }) });
    assert.equal(succeeded.status.label, "Completed");
    assert.equal(byId(succeeded, "done").state, "done");
    assert.equal(byId(succeeded, "done").stateLabel, "Reached · succeeded");
    const blocked = projectWorkflow({ readModel: readModel({ run: { status: "completed", outcome: "blocked", terminalState: "done" } }) });
    assert.equal(blocked.status.label, "Completed · blocked");
    const business = projectWorkflow({ readModel: readModel({ run: { status: "failed", outcome: "failed", terminalState: "failed" } }) });
    // Review 19:27Z (row 3): one word; why it failed is its own line.
    assert.equal(business.status.label, "Failed");
    assert.equal(byId(business, "failed").state, "failed");
    assert.equal(byId(business, "failed").resultKind, "business");
    const runtime = projectWorkflow({ readModel: readModel({ run: { status: "failed", outcome: null, terminalState: "poll", error: '{"code":"invalid_output"}' } }) });
    assert.equal(runtime.status.label, "Failed");
    assert.equal(byId(runtime, "failed").state, "idle");
    const controller = projectWorkflow({ definition, events: [ended("workflow.failed", { code: "controller_ended", error: "The controller ended." })] });
    assert.equal(controller.status.label, "Failed");
    assert.ok(!/controller_ended|runtime error/.test(controller.status.label), "never a raw code");
    assert.equal(projectWorkflow({ definition, events: [ended("workflow.cancelled", { reason: "Stopped" })] }).status.label, "Canceled");
});

test("wait, receive and send states say what they wait for or did, and never claim the recipient read a message", () => {
    const model = readModel({
        nodeExecutions: [
            row("pause", 1, "pending", { deadline: "2026-11-01T12:00:30.000Z" }),
            row("await_ack", 1, "pending", { deadline: "2026-11-01T12:10:00.000Z", receive: { contract: "Ack@1", from: null, correlation: {} } }),
            done("notify", 1, "sent"),
        ],
        outbox: [{ exchangeId: "nx-notify-1", nodeExecutionId: "nx-notify-1", recipientSessionId: "parent-1", recipientKind: "agent",
            contract: "Alert@1", state: "delivered", attempts: 1, createdAt: "t0", deliveredAt: "t1", payloadPreview: '{"k":1}' }],
    });
    const view = projectWorkflow({ readModel: model });
    const wait = byId(view, "pause");
    assert.deepEqual([wait.state, wait.phase, wait.stateLabel], ["running", "waiting", "Waiting"]);
    assert.deepEqual(wait.description, ["Waiting until 2026-11-01 12:00:30."]);
    assert.equal(wait.label, "Wait · 30 s");
    const receive = byId(view, "await_ack");
    assert.equal(receive.stateLabel, "Waiting · for a message");
    assert.equal(receive.description[0], "Waiting for Ack@1 from any permitted sender.");
    assert.match(receive.description[1], /If none arrives by 2026-11-01 12:10:00, the node continues on elapsed\./);
    const send = byId(view, "notify");
    assert.equal(send.stateLabel, "Done · sent, queued at recipient");
    // Review 19:27Z (rows 21 to 23): a session by its name, never its id; without one, "the parent session" (its recipient is the parent) or "its recipient".
    assert.equal(send.description[0], "Alert@1 was delivered to the queue of the parent session.");
    assert.match(send.description[1], /does not show that the recipient read, answered or acted on it/);
    assert.ok(!/\bread by\b|\backnowledged\b/i.test(send.stateLabel));
    assert.equal(send.current.outbox.state, "delivered");
    const delivering = projectWorkflow({ readModel: readModel({ nodeExecutions: [row("notify", 1, "pending")],
        outbox: [{ exchangeId: "nx-notify-1", nodeExecutionId: "nx-notify-1", recipientSessionId: "parent-1", state: "pending", attempts: 0 }] }) });
    assert.equal(byId(delivering, "notify").stateLabel, "Sending");
    const failedSend = projectWorkflow({ readModel: readModel({ nodeExecutions: [done("notify", 1, "delivery_failed", { resultKind: "runtime_error" })] }) });
    assert.equal(byId(failedSend, "notify").stateLabel, "Failed · delivery failed");
    const elapsed = projectWorkflow({ definition, events: [completed("await_ack", 1, "elapsed", "null")] });
    assert.equal(byId(elapsed, "await_ack").stateLabel, "Done · elapsed, no message");
    assert.equal(byId(elapsed, "await_ack").state, "done");
    const received = projectWorkflow({ definition, events: [completed("await_ack", 1, "received", '{"ok":true}', { messageId: "m1", contract: "Ack@1", senderSessionId: "parent-1" })] });
    assert.equal(byId(received, "await_ack").description[0], "Received Ack@1.");
    const named = projectWorkflow({ definition, events: [completed("await_ack", 1, "received", '{"ok":true}', { messageId: "m1", contract: "Ack@1", senderSessionId: "parent-1" })],
        sessionName: id => (id === "parent-1" ? "Release session" : null) });
    assert.equal(byId(named, "await_ack").description[0], "Received Ack@1 from Release session.");
});

test("a request state is shown only when the read model carries it, with its own responded and declined results", () => {
    const requestGraph = { revision: 1, initial: "ask", states: requestStates };
    const model = readModel({ graph: requestGraph, nodeExecutions: [row("ask", 1, "pending")],
        outbox: [{ exchangeId: "nx-ask-1", nodeExecutionId: "nx-ask-1", recipientSessionId: "reviewer-1", state: "delivered", attempts: 1 }] });
    const pending = projectWorkflow({ readModel: model });
    assert.equal(byId(pending, "ask").label, "Ask · Review@1");
    assert.equal(byId(pending, "ask").stateLabel, "Waiting · answer");
    assert.equal(byId(pending, "ask").description[0], "Waiting for an answer to Review@1 from its recipient.");
    assert.equal(byId(projectWorkflow({ readModel: model, sessionName: id => (id === "reviewer-1" ? "Reviewer" : null) }), "ask").description[0],
        "Waiting for an answer to Review@1 from Reviewer.");
    const declined = projectWorkflow({ readModel: readModel({ graph: requestGraph, nodeExecutions: [done("ask", 1, "declined", { responderSessionId: "reviewer-1" })] }) });
    assert.equal(byId(declined, "ask").stateLabel, "✕ declined");
    assert.equal(byId(declined, "ask").state, "done", "a declined request is a business result, not a runtime error");
    const timedOut = projectWorkflow({ readModel: readModel({ graph: requestGraph, nodeExecutions: [done("ask", 1, "timed_out", { resultKind: "runtime_error" })] }) });
    assert.equal(byId(timedOut, "ask").state, "failed");
    assert.equal(workflowRouteKind(requestStates[0], "timed_out"), "error");
    assert.equal(workflowRouteKind(requestStates[0], "declined"), "outcome");
});

test("admitted, paused, pausing, pending and ended runs keep their own labels", () => {
    const admitted = projectWorkflow({ readModel: readModel({ run: { status: "admitted" } }) });
    assert.equal(admitted.status.label, "Running");
    assert.equal(byId(admitted, "poll").stateLabel, "Not reached");
    const pausing = projectWorkflow({ readModel: readModel({ run: { status: "paused", pausedFrom: "running", pauseSettled: false },
        nodeExecutions: [row("poll", 1, "pending")] }) });
    assert.equal(pausing.status.phase, "pausing");
    // Review 19:27Z (D-W13): one word; the detail is the TUI's notice line.
    assert.equal(pausing.status.label, "Pausing");
    assert.equal(pausing.status.detail, "Pausing · waiting for started nodes to finish");
    assert.equal(byId(pausing, "poll").stateLabel, "Running");
    const paused = projectWorkflow({ readModel: readModel({ run: { status: "paused", pausedFrom: "running", pauseSettled: true },
        nodeExecutions: [row("pause", 1, "pending")] }) });
    assert.equal(paused.status.label, "Paused");
    assert.equal(byId(paused, "pause").stateLabel, "Paused");
    assert.equal(byId(paused, "pause").state, "idle");
    assert.equal(projectWorkflow({ readModel: readModel({ run: { status: "paused", pausedFrom: "admitted", pauseSettled: true } }) }).status.label, "Paused · not started");
    const cancelled = projectWorkflow({ readModel: readModel({ run: { status: "cancelled" }, nodeExecutions: [row("poll", 1, "pending")] }) });
    assert.equal(cancelled.status.label, "Canceled");
    assert.equal(byId(cancelled, "poll").state, "cancelled");
    assert.equal(byId(cancelled, "poll").stateLabel, "Canceled · the Workflow ended first");
    assert.equal(projectWorkflow({ readModel: readModel({ run: { status: "running", mode: "test" } }) }).status.label, "Test · Running");
    const fromEvents = projectWorkflow({ definition, events: [started("poll", 1), ev("workflow.paused", { runId: RUN })] });
    assert.equal(fromEvents.status.label, "Paused");
});

test("q15 (mock M16): replies that arrived before the run was ready show beside its status and say why; taken, expired and ended ones do not", () => {
    const now = Date.parse("2026-11-03T07:00:00Z");
    const reply = (messageId, extra = {}) => ({ messageId, contract: "Ack@1", senderSessionId: "parent-1", correlation: null,
        acceptedAt: "2026-11-03T06:30:00Z", expiresAt: "2026-11-03T08:00:00Z", claimedBy: null, claimedAt: null, payloadPreview: "{\"ok\":true}", ...extra });
    const taken = reply("m-taken", { claimedBy: "nx-await_ack-1", claimedAt: "2026-11-03T06:31:00Z" });
    const expired = reply("m-expired", { expiresAt: "2026-11-03T07:00:00Z" });
    const pausedRun = { status: "paused", pausedFrom: "running", pauseSettled: true };
    // The page and the open rows the read lists apart, one row per message; a taken or expired reply waits no more.
    const paused = projectWorkflow({ now, readModel: readModel({ run: { ...pausedRun, openInbox: [reply("m-open"), reply("m-1")] },
        inbox: [reply("m-1"), taken, expired] }) });
    assert.equal(paused.status.label, "Paused · 2 replies waiting");
    assert.deepEqual(paused.banners.filter(banner => banner.text.startsWith("Repl")), [
        { level: "info", text: "Replies waiting: 2 replies arrived while the Workflow is paused. It uses them once it resumes." }]);
    const one = projectWorkflow({ now, readModel: readModel({ run: pausedRun, inbox: [reply("m-1"), taken] }) });
    assert.equal(one.status.label, "Paused · 1 reply waiting");
    assert.ok(one.banners.some(banner => banner.text === "Reply waiting: 1 reply arrived while the Workflow is paused. It uses it once it resumes."));
    const admitted = projectWorkflow({ now, readModel: readModel({ run: { status: "admitted" }, inbox: [reply("m-1")] }) });
    assert.equal(admitted.status.label, "Running · 1 reply waiting");
    assert.ok(admitted.banners.some(banner => banner.text
        === "Reply waiting: 1 reply arrived before the Workflow started. It uses it when it reaches the node that takes it."));
    const running = projectWorkflow({ now, readModel: readModel({ run: { status: "running" }, inbox: [reply("m-1"), reply("m-2")] }) });
    assert.equal(running.status.label, "Running · 2 replies waiting");
    assert.ok(running.banners.some(banner => banner.text === "Replies waiting: 2 replies have arrived and wait for the node that takes them."));
    // None: only taken or expired replies, a run that ended, or one that is stopping (it takes no new step).
    const quiet = [
        projectWorkflow({ now, readModel: readModel({ run: pausedRun, inbox: [taken, expired] }) }),
        projectWorkflow({ now, readModel: readModel({ run: { status: "completed", outcome: "succeeded" }, inbox: [reply("m-1")] }) }),
        projectWorkflow({ now, readModel: readModel({ run: { status: "running", stop: { deadline: "2026-11-03T07:05:00Z" } }, inbox: [reply("m-1")] }) }),
    ];
    for (const projection of quiet) {
        assert.ok(!projection.status.label.includes("waiting"), projection.status.label);
        assert.ok(!projection.banners.some(banner => banner.text.startsWith("Repl")), JSON.stringify(projection.banners));
    }
    assert.equal(quiet[0].status.label, "Paused");
    assert.equal(workflowWaitingReplies(null, now).length, 0);
    assert.equal(workflowWaitingRepliesLabel(0), "");
    assert.equal(workflowWaitingRepliesNotice({ status: "paused" }, 0), null);
});

test("a stale read model never reverts a completed execution", () => {
    const events = [started("poll", 1), completed("poll", 1, "changed")];
    const eventsNewer = projectWorkflow({ readModel: readModel({ nodeExecutions: [row("poll", 1, "pending")] }), events });
    assert.equal(byId(eventsNewer, "poll").stateLabel, "Done · changed");
    const readNewer = projectWorkflow({ readModel: readModel({ nodeExecutions: [done("poll", 1, "changed")] }), events: [started("poll", 1)] });
    assert.equal(byId(readNewer, "poll").stateLabel, "Done · changed");
    const endedByEvent = projectWorkflow({ readModel: readModel({ run: { status: "running" } }),
        events: [ended("workflow.completed", { stateId: "done", outcome: "succeeded" })] });
    assert.equal(endedByEvent.status.label, "Completed");
});

test("draft, invalid and no-run read models say so instead of drawing or inventing a run", () => {
    const invalid = readModel({ noRun: true, graph: null, definition: { state: "draft", currentRevision: 2, publishedRevision: null, publishedDefinitionHash: null },
        revision: { revision: 2, valid: false, irSha256: null, diagnostics: [{ severity: "error", code: "WORKFLOW_ROUTE_RENAMED", path: "states[1]", message: "route renamed", line: 12 }] } });
    const view = projectWorkflow({ readModel: invalid });
    assert.equal(view.modelStatus, "invalid");
    assert.equal(view.definition, null);
    assert.deepEqual(view.nodes, []);
    assert.equal(view.banners[0].text, "Revision 2 has 1 error and cannot run.");
    assert.equal(view.banners[1].text, "Not started yet.");
    assert.deepEqual(view.diagnostics, [{ severity: "error", code: "WORKFLOW_ROUTE_RENAMED", path: "states[1]", message: "route renamed", line: 12 }]);
    assert.equal(view.status.label, "Not started");
    const draft = projectWorkflow({ readModel: readModel({ noRun: true, definition: { state: "draft", publishedRevision: null, publishedDefinitionHash: null } }) });
    assert.equal(draft.modelStatus, "draft");
    assert.deepEqual(draft.banners.map(banner => banner.text), ["Draft revision 1 · not published.", "Not started yet."]);
    assert.ok(draft.nodes.every(node => node.state === "idle" && node.stateLabel === "Not started"));
    const olderPublished = projectWorkflowReadModel(readModel({ noRun: true, revision: { revision: 2, valid: false, diagnostics: [] }, definition: { currentRevision: 2 } }));
    assert.match(olderPublished.banners[0].text, /Revision 2 has unlisted errors and cannot run\. Showing revision 1\./);
    assert.ok(olderPublished.definition);
    const unavailable = projectWorkflowReadModel(readModel({ graph: null, noRun: true }));
    assert.equal(unavailable.status, "unavailable");
});

test("payloads of the wrong shape are refused with a reason, never read as another version", () => {
    for (const junk of [startedData, { workflowId: "w" }, "text"]) {
        const model = projectWorkflowReadModel(junk);
        assert.equal(model.ok, false);
        assert.equal(model.status, "unrecognized");
        assert.match(model.banners[0].text, /has an unknown format/);
    }
    const badGraph = projectWorkflowReadModel(readModel({ graph: { revision: 1, initial: "x", states: [{ id: "x", type: "teleport" }] } }));
    assert.equal(badGraph.status, "invalid-graph");
    // An event that names no run is not drawn: it is counted and said.
    const runless = projectWorkflow({ definition, events: [ev("workflow.state_completed", { stateId: "poll", step: 1, outcome: "changed" })] });
    assert.equal(byId(runless, "poll").state, "idle");
    assert.equal(runless.banners[0].text, "1 workflow event had an unknown format and was ignored.");
    const rows = projectWorkflow({ readModel: readModel({ nodeExecutions: [{ nodeExecutionId: "x", stateId: "poll", state: "mystery" }] }) });
    assert.equal(rows.banners.at(-1).text, "1 visit had an unknown format and was ignored.");
});

test("a run of another revision is not drawn over the graph, and other runs' events are ignored", () => {
    const mismatch = readModel({ runs: [{ runId: RUN, mode: "live", status: "running", revision: 2, outcome: null }],
        nodeExecutions: [done("poll", 1, "changed")] });
    const view = projectWorkflow({ readModel: mismatch });
    assert.ok(view.banners.some(banner => banner.text === "This Workflow ran revision 2; the graph shows revision 1, so node states are not shown."));
    assert.ok(view.nodes.every(node => node.state === "idle"));
    const other = projectWorkflow({ readModel: readModel(), events: [{ eventType: "workflow.state_completed",
        data: { runId: "run-other", nodeExecutionId: "nx-o", stateId: "poll", step: 1, outcome: "changed", resultKind: "business" } }] });
    assert.equal(byId(other, "poll").stateLabel, "Not reached");
    const unknownState = projectWorkflow({ definition, events: [completed("ghost", 1, "x")] });
    assert.ok(unknownState.banners.some(banner => /not in this graph/.test(banner.text)));
});

test("history counts are marked partial unless the whole run is loaded, and truncated previews are flagged", () => {
    const eventsOnly = projectWorkflow({ definition, events: [started("poll", 29), completed("poll", 29, "unchanged")] });
    assert.equal(byId(eventsOnly, "poll").runs, 29);
    assert.equal(byId(eventsOnly, "poll").partial, true);
    const whole = projectWorkflow({ readModel: readModel({ nodeExecutions: [1, 2, 3, 4, 5].map(n => done("poll", n, "unchanged")) }) });
    assert.equal(byId(whole, "poll").runs, 5);
    assert.equal(byId(whole, "poll").partial, false);
    assert.equal(byId(whole, "pause").partial, false);
    assert.deepEqual(formatWorkflowValue("abc…"), { text: "abc…", truncated: true });
    assert.deepEqual(formatWorkflowValue('{"a":1}'), { text: '{\n  "a": 1\n}', truncated: false });
    assert.deepEqual(formatWorkflowValue("<b>not json</b>"), { text: "<b>not json</b>", truncated: false });
});

test("loops keep the visit count, the last outcome and a compact history while the raw executions stay available", () => {
    const events = [
        completed("poll", 1, "unchanged", '{"v":1}'), completed("poll", 2, "unchanged", '{"v":1}'), completed("poll", 3, "unchanged", '{"v":1}'),
        started("poll", 4),
    ];
    const view = projectWorkflow({ definition, events });
    const poll = byId(view, "poll");
    assert.equal(poll.runs, 4);
    assert.equal(poll.state, "running");
    assert.equal(poll.outcome, "unchanged", "a revisit keeps showing the previous outcome");
    assert.equal(poll.executions.length, 4);
    assert.deepEqual(poll.executions.map(item => item.ordinal), [4, 3, 2, 1]);
    const rows = compactWorkflowExecutions(poll.executions);
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[1].count, rows[1].from, rows[1].to], [3, 1, 3]);
    const changed = compactWorkflowExecutions([completed("poll", 3, "changed", "1"), completed("poll", 2, "unchanged", "1"), completed("poll", 1, "unchanged", "1")]
        .map(event => ({ status: "completed", ordinal: event.data.step, outcome: event.data.outcome, resultKind: "business", outputPreview: event.data.outputPreview })));
    assert.deepEqual(changed.map(item => item.count), [1, 2]);
});

test("graphs keep real branches, loops and reconvergence, mark runtime-error routes, and draw no edges out of terminals", () => {
    for (const width of [300, 390, 1440]) {
        const layout = layoutWorkflowGraph(definition, width);
        assert.equal(layout.positions.size, 6);
        assert.equal(layout.edges.length, 7);
        assert.deepEqual(layout.edges.filter(edge => edge.from === "done" || edge.from === "failed"), []);
        assert.ok(layout.edges.every(edge => !edge.path.includes("NaN")));
        const edge = (from, to) => layout.edges.find(item => item.from === from && item.to === to);
        assert.equal(edge("poll", "failed").kind, "error");
        assert.equal(edge("poll", "failed").outcome, "failure / timed_out");
        assert.equal(edge("notify", "failed").kind, "error");
        assert.equal(edge("poll", "notify").kind, "outcome");
        assert.equal(edge("await_ack", "done").outcome, "received / elapsed");
        assert.ok(edge("pause", "poll"), "the loop back to poll is an edge");
        for (const box of layout.positions.values()) assert.ok(box.x >= 0 && box.x + box.width <= layout.width);
    }
});

test("no overlay of any kind is painted unless the run is bound to the graph's revision", () => {
    const completedRun = { status: "completed", outcome: "succeeded", terminalState: "done", output: '{"ok":true}' };
    const mismatched = projectWorkflow({
        readModel: readModel({ runs: [{ runId: RUN, mode: "live", status: "completed", revision: 2, outcome: "succeeded" }],
            run: completedRun, nodeExecutions: [done("poll", 1, "changed")] }),
        events: [completed("poll", 1, "changed"), ended("workflow.completed", { stateId: "done", outcome: "succeeded" })],
    });
    assert.equal(mismatched.bound, false);
    assert.equal(mismatched.status.label, "Revision 2 · Completed");
    assert.equal(mismatched.status.terminalState, null);
    assert.ok(mismatched.nodes.every(node => node.state === "idle" && node.stateLabel === "Not shown on the graph" && node.runs === 0));
    assert.equal(mismatched.output, null);
    const bound = projectWorkflow({ readModel: readModel({ run: completedRun, nodeExecutions: [done("poll", 1, "changed")] }) });
    assert.equal(bound.bound, true);
    assert.equal(byId(bound, "done").state, "done");
    assert.equal(byId(bound, "poll").stateLabel, "Done · changed");
    const unlisted = projectWorkflow({ readModel: readModel({ runs: [{ runId: RUN, mode: "live", status: "running", outcome: null }],
        nodeExecutions: [done("poll", 1, "changed")] }) });
    assert.ok(unlisted.banners.some(banner => banner.text === "This Workflow's revision is not listed, so node states are not shown."));
    assert.ok(unlisted.nodes.every(node => node.state === "idle"));
});

test("historical events are not painted onto a graph when the read model selects no run", () => {
    const history = [started("poll", 1), completed("poll", 1, "changed"), ended("workflow.completed", { stateId: "done", outcome: "succeeded" })];
    const none = projectWorkflow({ readModel: readModel({ noRun: true, definition: { state: "draft", publishedRevision: null, publishedDefinitionHash: null } }), events: history });
    assert.equal(none.runId, null);
    assert.equal(none.status.label, "Not started");
    assert.deepEqual(none.banners.map(banner => banner.text), ["Draft revision 1 · not published.", "Not started yet."]);
    assert.ok(none.nodes.every(node => node.state === "idle" && node.stateLabel === "Not started"));
    const others = projectWorkflow({ readModel: readModel({ noRun: true, runs: [{ runId: "old", mode: "test", status: "completed", revision: 1, outcome: "succeeded" }] }), events: history });
    assert.equal(others.status.label, "No Workflow selected");
    assert.ok(others.banners.some(banner => banner.text === "No Workflow selected · 1 other"));
    assert.ok(others.nodes.every(node => node.state === "idle"));
    const invalid = projectWorkflow({ readModel: readModel({ noRun: true, graph: null, revision: { revision: 2, valid: false, diagnostics: [] } }), events: history });
    assert.equal(invalid.runId, null);
    assert.equal(invalid.status.label, "Not started");
    const withStart = (revision, events) => [ev("workflow.started", { ...startedData, revision }), ...events];
    const events = [completed("poll", 1, "changed")];
    const other = projectWorkflow({ definition, events: withStart(2, events) });
    assert.equal(other.bound, false);
    assert.equal(other.status.label, "Revision 2 · Running");
    assert.ok(other.nodes.every(node => node.state === "idle"));
    assert.ok(other.banners.some(banner => /ran revision 2; the graph shows revision 1/.test(banner.text)));
    const same = projectWorkflow({ definition, events: withStart(1, events) });
    assert.equal(same.bound, true);
    assert.equal(byId(same, "poll").state, "done");
});

test("a read model that contradicts a pause or resume event is reported as unverified, in both directions", () => {
    const paused = seq => ({ ...ev("workflow.paused", { runId: RUN }), seq });
    const resumed = seq => ({ ...ev("workflow.resumed", { runId: RUN }), seq });
    const running = nodeExecutions => readModel({ nodeExecutions });
    const pausedModel = readModel({ run: { status: "paused", pausedFrom: "running", pauseSettled: true } });
    const a = projectWorkflow({ readModel: running([row("poll", 1, "pending")]), events: [paused(5)] });
    assert.equal(a.status.phase, "unverified");
    // Review 19:27Z (D-W13): one word; its reason is a detail line.
    assert.equal(a.status.label, "Not certain");
    assert.equal(a.status.detail, "Not certain · its data says running, its latest event says paused");
    assert.ok(a.banners.some(banner => banner.text === "Not certain: its data says running, its latest event says paused. Refresh to read it again."));
    assert.equal(byId(a, "poll").stateLabel, "Waiting · Workflow status not certain");
    assert.equal(byId(a, "poll").state, "idle");
    const b = projectWorkflow({ readModel: pausedModel, events: [resumed(6)] });
    assert.equal(b.status.label, "Not certain");
    assert.equal(b.status.detail, "Not certain · its data says paused, its latest event says resumed");
    const pausing = projectWorkflow({ readModel: readModel({ run: { status: "paused", pausedFrom: "running", pauseSettled: false } }), events: [resumed(6)] });
    assert.equal(pausing.status.phase, "unverified");
    assert.equal(projectWorkflow({ readModel: running([]), events: [paused(5), resumed(6)] }).status.label, "Running");
    assert.equal(projectWorkflow({ readModel: pausedModel, events: [paused(5)] }).status.label, "Paused");
    assert.equal(projectWorkflow({ readModel: running([]) }).status.label, "Running");
    assert.equal(projectWorkflow({ readModel: readModel({ run: { status: "admitted" } }), events: [resumed(2)] }).status.label, "Running");
    assert.equal(projectWorkflow({ readModel: readModel({ run: { status: "admitted" } }), events: [paused(2)] }).status.phase, "unverified");
    const status = (afterSeq, event) => projectWorkflow({ readModel: running([]), events: [event], readModelAfterSeq: afterSeq }).status;
    assert.equal(status(7, paused(5)).label, "Running", "an event older than the snapshot cannot contradict it");
    assert.equal(status(5, paused(5)).label, "Running");
    assert.equal(status(4, paused(5)).phase, "unverified", "an event that may be newer still contradicts it");
    assert.equal(status(7, ev("workflow.paused", { runId: RUN })).phase, "unverified", "an event with no sequence is never ordered");
    assert.equal(status("7", paused(5)).phase, "unverified", "an unusable watermark is not trusted");
    const ended = projectWorkflow({ readModel: readModel({ run: { status: "completed", outcome: "succeeded", terminalState: "done" } }), events: [paused(9)] });
    assert.equal(ended.status.label, "Completed");
});
