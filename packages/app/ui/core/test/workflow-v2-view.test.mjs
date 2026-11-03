import test from "node:test";
import assert from "node:assert/strict";
import {
    workflowDefinition, workflowNodeViews, layoutWorkflowGraph, workflowShape, workflowV2Definition,
    projectWorkflowV2, projectWorkflowV2ReadModel, compactWorkflowV2Executions, formatWorkflowValue, workflowV2RouteKind,
    workflowV2WaitingReplies, workflowV2WaitingRepliesLabel, workflowV2WaitingRepliesNotice,
} from "../src/workflow-view.js";
import {
    RUN, states, requestStates, startedData, legacyStartedData, ev, started, completed, runtimeError, ended, row, done, readModel,
} from "./workflow-v2-fixtures.mjs";

const definition = workflowDefinition(startedData);
const byId = (projection, id) => projection.nodes.find(node => node.id === id);

test("shape discrimination keeps legacy payloads legacy and refuses mixed or unsupported v2 payloads", () => {
    assert.equal(workflowShape(startedData), "v2");
    assert.equal(workflowShape(legacyStartedData), "legacy");
    assert.equal(workflowShape(null), "unknown");
    const legacy = workflowDefinition(legacyStartedData);
    assert.equal(legacy.shape, undefined);
    assert.deepEqual(legacy.states, legacyStartedData.states);
    assert.equal(definition.shape, "v2");
    assert.deepEqual(definition.states, states);
    assert.equal(definition.name, "watch-v2");
    assert.throws(() => workflowDefinition({ ...startedData, states: [...states, { id: "x", type: "teleport", next: {} }] }), /invalid or unsupported step/);
    assert.throws(() => workflowDefinition({ ...startedData, states: [{ id: "poll", type: "script", runtime: "node", next: {} }, states[4]] }), /valid script step/);
    assert.throws(() => workflowDefinition({ ...startedData, states: [{ ...states[0], next: { changed: "nowhere" } }] }), /step that is not defined/);
    assert.throws(() => workflowDefinition({ ...startedData, states: [states[2], states[4], states[5]], initial: "elsewhere" }), /first step/);
    assert.throws(() => workflowV2Definition({ states: [{ id: "m", type: "messaging", mode: "teleport", contract: "A@1", outcomes: [], next: {} }] }), /messaging mode/);
});

test("legacy node views keep their old meaning with and without the new optional argument", () => {
    const legacy = workflowDefinition(legacyStartedData);
    const events = [ev("workflow.state_completed", { stateId: "poll", step: 1, outcome: "changed", exitCode: 1 })];
    assert.equal(workflowNodeViews(legacy, events)[0].state, "failed");
    assert.equal(workflowNodeViews(legacy, events, null, { readModel: readModel() })[0].state, "failed");
    assert.equal(workflowNodeViews(legacy, [ev("workflow.state_completed", { stateId: "poll", step: 1, exitCode: 0 })])[0].state, "done");
});

test("a v2 business result is done, not failed, and a runtime error is told apart from a business outcome", () => {
    const business = projectWorkflowV2({ definition, events: [started("poll", 1), completed("poll", 1, "changed", '{"n":1}')] });
    assert.equal(byId(business, "poll").state, "done");
    assert.equal(byId(business, "poll").stateLabel, "Done · changed");
    assert.equal(byId(business, "poll").resultKind, "business");
    const failedOutcome = projectWorkflowV2({ definition, events: [completed("poll", 1, "failure")] });
    assert.equal(byId(failedOutcome, "poll").state, "done", "a business outcome named failure is not a runtime error");
    const error = projectWorkflowV2({ definition, events: [completed("poll", 1, "changed"), runtimeError("poll", 2, "timed_out", "Script timed out")] });
    assert.equal(byId(error, "poll").state, "failed");
    assert.equal(byId(error, "poll").stateLabel, "Runtime error · timed_out");
    assert.equal(byId(error, "poll").result.errorPreview, "Script timed out");
    assert.equal(workflowNodeViews(definition, [completed("poll", 1, "changed")])[0].state, "done");
});

test("run status separates a workflow's own terminal outcome from a runtime or controller failure", () => {
    const succeeded = projectWorkflowV2({ readModel: readModel({ run: { status: "completed", outcome: "succeeded", terminalState: "done" } }) });
    assert.equal(succeeded.status.label, "Completed · succeeded");
    assert.equal(byId(succeeded, "done").state, "done");
    assert.equal(byId(succeeded, "done").stateLabel, "Ended · succeeded");
    const blocked = projectWorkflowV2({ readModel: readModel({ run: { status: "completed", outcome: "blocked", terminalState: "done" } }) });
    assert.equal(blocked.status.label, "Completed · blocked");
    const business = projectWorkflowV2({ readModel: readModel({ run: { status: "failed", outcome: "failed", terminalState: "failed" } }) });
    assert.equal(business.status.label, "Failed · ended at 'failed' (failed)");
    assert.equal(byId(business, "failed").state, "failed");
    assert.equal(byId(business, "failed").resultKind, "business");
    const runtime = projectWorkflowV2({ readModel: readModel({ run: { status: "failed", outcome: null, terminalState: "poll", error: '{"code":"invalid_output"}' } }) });
    assert.equal(runtime.status.label, "Failed · runtime error");
    assert.equal(byId(runtime, "failed").state, "idle");
    const controller = projectWorkflowV2({ definition, events: [ended("workflow.failed", { code: "controller_ended", error: "The controller ended." })] });
    assert.equal(controller.status.label, "Failed · controller_ended");
    assert.equal(projectWorkflowV2({ definition, events: [ended("workflow.cancelled", { reason: "Stopped" })] }).status.label, "Cancelled");
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
    const view = projectWorkflowV2({ readModel: model });
    const wait = byId(view, "pause");
    assert.deepEqual([wait.state, wait.phase, wait.stateLabel], ["running", "waiting", "Waiting"]);
    assert.deepEqual(wait.description, ["Waiting until 2026-11-01T12:00:30.000Z."]);
    assert.equal(wait.label, "wait · 30 s");
    const receive = byId(view, "await_ack");
    assert.equal(receive.stateLabel, "Waiting for message");
    assert.equal(receive.description[0], "Waiting for Ack@1 from any permitted sender.");
    assert.match(receive.description[1], /routes on 'elapsed' after 2026-11-01T12:10:00.000Z/);
    const send = byId(view, "notify");
    assert.equal(send.stateLabel, "Sent · queued at recipient");
    assert.equal(send.description[0], "Alert@1 was delivered to the queue of parent-1.");
    assert.match(send.description[1], /does not show that the recipient read, answered or acted on it/);
    assert.ok(!/\bread by\b|\backnowledged\b/i.test(send.stateLabel));
    assert.equal(send.current.outbox.state, "delivered");
    const delivering = projectWorkflowV2({ readModel: readModel({ nodeExecutions: [row("notify", 1, "pending")],
        outbox: [{ exchangeId: "nx-notify-1", nodeExecutionId: "nx-notify-1", recipientSessionId: "parent-1", state: "pending", attempts: 0 }] }) });
    assert.equal(byId(delivering, "notify").stateLabel, "Delivering");
    const failedSend = projectWorkflowV2({ readModel: readModel({ nodeExecutions: [done("notify", 1, "delivery_failed", { resultKind: "runtime_error" })] }) });
    assert.equal(byId(failedSend, "notify").stateLabel, "Runtime error · delivery_failed");
    const elapsed = projectWorkflowV2({ definition, events: [completed("await_ack", 1, "elapsed", "null")] });
    assert.equal(byId(elapsed, "await_ack").stateLabel, "Wait elapsed · no message");
    assert.equal(byId(elapsed, "await_ack").state, "done");
    const received = projectWorkflowV2({ definition, events: [completed("await_ack", 1, "received", '{"ok":true}', { messageId: "m1", contract: "Ack@1", senderSessionId: "parent-1" })] });
    assert.equal(byId(received, "await_ack").description[0], "Received Ack@1 from parent-1.");
});

test("a request state is shown only when the read model carries it, with its own responded and declined results", () => {
    const requestGraph = { revision: 1, initial: "ask", states: requestStates };
    const model = readModel({ graph: requestGraph, nodeExecutions: [row("ask", 1, "pending")],
        outbox: [{ exchangeId: "nx-ask-1", nodeExecutionId: "nx-ask-1", recipientSessionId: "reviewer-1", state: "delivered", attempts: 1 }] });
    const pending = projectWorkflowV2({ readModel: model });
    assert.equal(byId(pending, "ask").label, "request · Review@1");
    assert.equal(byId(pending, "ask").stateLabel, "Awaiting response");
    assert.equal(byId(pending, "ask").description[0], "Awaiting a response to Review@1 from reviewer-1.");
    const declined = projectWorkflowV2({ readModel: readModel({ graph: requestGraph, nodeExecutions: [done("ask", 1, "declined", { responderSessionId: "reviewer-1" })] }) });
    assert.equal(byId(declined, "ask").stateLabel, "Declined");
    assert.equal(byId(declined, "ask").state, "done", "a declined request is a business result, not a runtime error");
    const timedOut = projectWorkflowV2({ readModel: readModel({ graph: requestGraph, nodeExecutions: [done("ask", 1, "timed_out", { resultKind: "runtime_error" })] }) });
    assert.equal(byId(timedOut, "ask").state, "failed");
    assert.equal(workflowV2RouteKind(requestStates[0], "timed_out"), "error");
    assert.equal(workflowV2RouteKind(requestStates[0], "declined"), "outcome");
});

test("admitted, paused, pausing, pending and ended runs keep their own labels", () => {
    const admitted = projectWorkflowV2({ readModel: readModel({ run: { status: "admitted" } }) });
    assert.equal(admitted.status.label, "Waiting to start");
    assert.equal(byId(admitted, "poll").stateLabel, "Not reached");
    const pausing = projectWorkflowV2({ readModel: readModel({ run: { status: "paused", pausedFrom: "running", pauseSettled: false },
        nodeExecutions: [row("poll", 1, "pending")] }) });
    assert.equal(pausing.status.phase, "pausing");
    assert.equal(pausing.status.label, "Pausing · waiting for running steps to finish");
    assert.equal(byId(pausing, "poll").stateLabel, "Running");
    const paused = projectWorkflowV2({ readModel: readModel({ run: { status: "paused", pausedFrom: "running", pauseSettled: true },
        nodeExecutions: [row("pause", 1, "pending")] }) });
    assert.equal(paused.status.label, "Paused");
    assert.equal(byId(paused, "pause").stateLabel, "Pending · run paused");
    assert.equal(byId(paused, "pause").state, "idle");
    assert.equal(projectWorkflowV2({ readModel: readModel({ run: { status: "paused", pausedFrom: "admitted", pauseSettled: true } }) }).status.label, "Paused before it started");
    const cancelled = projectWorkflowV2({ readModel: readModel({ run: { status: "cancelled" }, nodeExecutions: [row("poll", 1, "pending")] }) });
    assert.equal(cancelled.status.label, "Cancelled");
    assert.equal(byId(cancelled, "poll").state, "cancelled");
    assert.equal(byId(cancelled, "poll").stateLabel, "Run ended first");
    assert.equal(projectWorkflowV2({ readModel: readModel({ run: { status: "running", mode: "test" } }) }).status.label, "Test run · Running");
    const fromEvents = projectWorkflowV2({ definition, events: [started("poll", 1), ev("workflow.paused", { runId: RUN })] });
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
    const paused = projectWorkflowV2({ now, readModel: readModel({ run: { ...pausedRun, openInbox: [reply("m-open"), reply("m-1")] },
        inbox: [reply("m-1"), taken, expired] }) });
    assert.equal(paused.status.label, "Paused · 2 replies waiting");
    assert.deepEqual(paused.banners.filter(banner => banner.text.startsWith("Repl")), [
        { level: "info", text: "Replies waiting: 2 replies arrived while the run is paused. The run uses them once it resumes." }]);
    const one = projectWorkflowV2({ now, readModel: readModel({ run: pausedRun, inbox: [reply("m-1"), taken] }) });
    assert.equal(one.status.label, "Paused · 1 reply waiting");
    assert.ok(one.banners.some(banner => banner.text === "Reply waiting: 1 reply arrived while the run is paused. The run uses it once it resumes."));
    const admitted = projectWorkflowV2({ now, readModel: readModel({ run: { status: "admitted" }, inbox: [reply("m-1")] }) });
    assert.equal(admitted.status.label, "Waiting to start · 1 reply waiting");
    assert.ok(admitted.banners.some(banner => banner.text
        === "Reply waiting: 1 reply arrived before the run started. The run uses it when it reaches the step that takes it."));
    const running = projectWorkflowV2({ now, readModel: readModel({ run: { status: "running" }, inbox: [reply("m-1"), reply("m-2")] }) });
    assert.equal(running.status.label, "Running · 2 replies waiting");
    assert.ok(running.banners.some(banner => banner.text === "Replies waiting: 2 replies have arrived and wait for the step that takes them."));
    // None: only taken or expired replies, a run that ended, or one that is stopping (it takes no new step).
    const quiet = [
        projectWorkflowV2({ now, readModel: readModel({ run: pausedRun, inbox: [taken, expired] }) }),
        projectWorkflowV2({ now, readModel: readModel({ run: { status: "completed", outcome: "succeeded" }, inbox: [reply("m-1")] }) }),
        projectWorkflowV2({ now, readModel: readModel({ run: { status: "running", stop: { deadline: "2026-11-03T07:05:00Z" } }, inbox: [reply("m-1")] }) }),
    ];
    for (const projection of quiet) {
        assert.ok(!projection.status.label.includes("waiting"), projection.status.label);
        assert.ok(!projection.banners.some(banner => banner.text.startsWith("Repl")), JSON.stringify(projection.banners));
    }
    assert.equal(quiet[0].status.label, "Paused");
    assert.equal(workflowV2WaitingReplies(null, now).length, 0);
    assert.equal(workflowV2WaitingRepliesLabel(0), "");
    assert.equal(workflowV2WaitingRepliesNotice({ status: "paused" }, 0), null);
});

test("durable events outrank a stale canvas tick, and a stale read model never reverts a completed execution", () => {
    const stale = { step: 99, current: "poll", status: "running", nodes: { poll: { state: "running", runs: 5 } } };
    const events = [started("poll", 1), completed("poll", 1, "changed")];
    assert.equal(workflowNodeViews(definition, events, stale)[0].state, "done");
    const eventsNewer = projectWorkflowV2({ readModel: readModel({ nodeExecutions: [row("poll", 1, "pending")] }), events });
    assert.equal(byId(eventsNewer, "poll").stateLabel, "Done · changed");
    const readNewer = projectWorkflowV2({ readModel: readModel({ nodeExecutions: [done("poll", 1, "changed")] }), events: [started("poll", 1)] });
    assert.equal(byId(readNewer, "poll").stateLabel, "Done · changed");
    const endedByEvent = projectWorkflowV2({ readModel: readModel({ run: { status: "running" } }),
        events: [ended("workflow.completed", { stateId: "done", outcome: "succeeded" })] });
    assert.equal(endedByEvent.status.label, "Completed · succeeded");
});

test("draft, invalid and no-run read models say so instead of drawing or inventing a run", () => {
    const invalid = readModel({ noRun: true, graph: null, definition: { state: "draft", currentRevision: 2, publishedRevision: null, publishedDefinitionHash: null },
        revision: { revision: 2, valid: false, irSha256: null, diagnostics: [{ severity: "error", code: "WORKFLOW_ROUTE_RENAMED", path: "states[1]", message: "route renamed", line: 12 }] } });
    const view = projectWorkflowV2({ readModel: invalid });
    assert.equal(view.modelStatus, "invalid");
    assert.equal(view.definition, null);
    assert.deepEqual(view.nodes, []);
    assert.equal(view.banners[0].text, "Revision 2 has 1 error and cannot run.");
    assert.equal(view.banners[1].text, "No run yet.");
    assert.deepEqual(view.diagnostics, [{ severity: "error", code: "WORKFLOW_ROUTE_RENAMED", path: "states[1]", message: "route renamed", line: 12 }]);
    assert.equal(view.status.label, "No run yet");
    const draft = projectWorkflowV2({ readModel: readModel({ noRun: true, definition: { state: "draft", publishedRevision: null, publishedDefinitionHash: null } }) });
    assert.equal(draft.modelStatus, "draft");
    assert.deepEqual(draft.banners.map(banner => banner.text), ["Draft revision 1 · not published.", "No run yet."]);
    assert.ok(draft.nodes.every(node => node.state === "idle" && node.stateLabel === "No run"));
    const olderPublished = projectWorkflowV2ReadModel(readModel({ noRun: true, revision: { revision: 2, valid: false, diagnostics: [] }, definition: { currentRevision: 2 } }));
    assert.match(olderPublished.banners[0].text, /Revision 2 has unlisted errors and cannot run\. Showing revision 1\./);
    assert.ok(olderPublished.definition);
    const unavailable = projectWorkflowV2ReadModel(readModel({ graph: null, noRun: true }));
    assert.equal(unavailable.status, "unavailable");
});

test("payloads of the wrong shape are refused with a reason, never read as another version", () => {
    for (const junk of [startedData, legacyStartedData, { workflowId: "w" }, "text"]) {
        const model = projectWorkflowV2ReadModel(junk);
        assert.equal(model.ok, false);
        assert.equal(model.status, "unrecognized");
        assert.match(model.banners[0].text, /has an unknown format/);
    }
    const badGraph = projectWorkflowV2ReadModel(readModel({ graph: { revision: 1, initial: "x", states: [{ id: "x", type: "teleport" }] } }));
    assert.equal(badGraph.status, "invalid-graph");
    const bad = projectWorkflowV2({ definition: workflowDefinition(legacyStartedData), readModel: { nope: true } });
    assert.equal(bad.definition, null, "a legacy definition is never shown as v2");
    const legacyEvents = projectWorkflowV2({ definition, events: [ev("workflow.state_completed", { stateId: "poll", step: 1, outcome: "changed", exitCode: 0 })] });
    assert.equal(byId(legacyEvents, "poll").state, "idle");
    assert.equal(legacyEvents.banners[0].text, "1 workflow event had an unknown format and was ignored.");
    const rows = projectWorkflowV2({ readModel: readModel({ nodeExecutions: [{ nodeExecutionId: "x", stateId: "poll", state: "mystery" }] }) });
    assert.equal(rows.banners.at(-1).text, "1 visit had an unknown format and was ignored.");
});

test("a run of another revision is not drawn over the graph, and other runs' events are ignored", () => {
    const mismatch = readModel({ runs: [{ runId: RUN, mode: "live", status: "running", revision: 2, outcome: null }],
        nodeExecutions: [done("poll", 1, "changed")] });
    const view = projectWorkflowV2({ readModel: mismatch });
    assert.ok(view.banners.some(banner => banner.text === "This run used revision 2; the graph shows revision 1, so its step status is not shown on the graph."));
    assert.ok(view.nodes.every(node => node.state === "idle"));
    const other = projectWorkflowV2({ readModel: readModel(), events: [{ eventType: "workflow.state_completed",
        data: { runId: "run-other", nodeExecutionId: "nx-o", stateId: "poll", step: 1, outcome: "changed", resultKind: "business" } }] });
    assert.equal(byId(other, "poll").stateLabel, "Not reached");
    const unknownState = projectWorkflowV2({ definition, events: [completed("ghost", 1, "x")] });
    assert.ok(unknownState.banners.some(banner => /not in this graph/.test(banner.text)));
});

test("history counts are marked partial unless the whole run is loaded, and truncated previews are flagged", () => {
    const eventsOnly = projectWorkflowV2({ definition, events: [started("poll", 29), completed("poll", 29, "unchanged")] });
    assert.equal(byId(eventsOnly, "poll").runs, 29);
    assert.equal(byId(eventsOnly, "poll").partial, true);
    const whole = projectWorkflowV2({ readModel: readModel({ nodeExecutions: [1, 2, 3, 4, 5].map(n => done("poll", n, "unchanged")) }) });
    assert.equal(byId(whole, "poll").runs, 5);
    assert.equal(byId(whole, "poll").partial, false);
    assert.equal(byId(whole, "pause").partial, false);
    const many = Array.from({ length: 200 }, (_, i) => done("poll", i + 1, "unchanged"));
    const bounded = projectWorkflowV2({ readModel: readModel({ nodeExecutions: many }) });
    assert.equal(byId(bounded, "poll").partial, true);
    assert.ok(bounded.banners.some(banner => /first 200 visits/.test(banner.text)));
    assert.deepEqual(formatWorkflowValue("abc…"), { text: "abc…", truncated: true });
    assert.deepEqual(formatWorkflowValue('{"a":1}'), { text: '{\n  "a": 1\n}', truncated: false });
    assert.deepEqual(formatWorkflowValue("<b>not json</b>"), { text: "<b>not json</b>", truncated: false });
});

test("loops keep the visit count, the last outcome and a compact history while the raw executions stay available", () => {
    const events = [
        completed("poll", 1, "unchanged", '{"v":1}'), completed("poll", 2, "unchanged", '{"v":1}'), completed("poll", 3, "unchanged", '{"v":1}'),
        started("poll", 4),
    ];
    const view = projectWorkflowV2({ definition, events });
    const poll = byId(view, "poll");
    assert.equal(poll.runs, 4);
    assert.equal(poll.state, "running");
    assert.equal(poll.outcome, "unchanged", "a revisit keeps showing the previous outcome");
    assert.equal(poll.executions.length, 4);
    assert.deepEqual(poll.executions.map(item => item.ordinal), [4, 3, 2, 1]);
    const rows = compactWorkflowV2Executions(poll.executions);
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[1].count, rows[1].from, rows[1].to], [3, 1, 3]);
    const changed = compactWorkflowV2Executions([completed("poll", 3, "changed", "1"), completed("poll", 2, "unchanged", "1"), completed("poll", 1, "unchanged", "1")]
        .map(event => ({ status: "completed", ordinal: event.data.step, outcome: event.data.outcome, resultKind: "business", outputPreview: event.data.outputPreview })));
    assert.deepEqual(changed.map(item => item.count), [1, 2]);
});

test("v2 graphs keep real branches, loops and reconvergence, mark runtime-error routes, and draw no edges out of terminals", () => {
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
    const legacy = layoutWorkflowGraph(workflowDefinition(legacyStartedData), 390);
    assert.ok(legacy.edges.every(edge => edge.kind === undefined));
});

test("no overlay of any kind is painted unless the run is bound to the graph's revision", () => {
    const completedRun = { status: "completed", outcome: "succeeded", terminalState: "done", output: '{"ok":true}' };
    const mismatched = projectWorkflowV2({
        readModel: readModel({ runs: [{ runId: RUN, mode: "live", status: "completed", revision: 2, outcome: "succeeded" }],
            run: completedRun, nodeExecutions: [done("poll", 1, "changed")] }),
        events: [completed("poll", 1, "changed"), ended("workflow.completed", { stateId: "done", outcome: "succeeded" })],
    });
    assert.equal(mismatched.bound, false);
    assert.equal(mismatched.status.label, "Revision 2 run · Completed · succeeded");
    assert.equal(mismatched.status.terminalState, null);
    assert.ok(mismatched.nodes.every(node => node.state === "idle" && node.stateLabel === "Not shown on the graph" && node.runs === 0));
    assert.equal(mismatched.output, null);
    const bound = projectWorkflowV2({ readModel: readModel({ run: completedRun, nodeExecutions: [done("poll", 1, "changed")] }) });
    assert.equal(bound.bound, true);
    assert.equal(byId(bound, "done").state, "done");
    assert.equal(byId(bound, "poll").stateLabel, "Done · changed");
    const unlisted = projectWorkflowV2({ readModel: readModel({ runs: [{ runId: RUN, mode: "live", status: "running", outcome: null }],
        nodeExecutions: [done("poll", 1, "changed")] }) });
    assert.ok(unlisted.banners.some(banner => banner.text === "This run's revision is not listed, so its step status is not shown on the graph."));
    assert.ok(unlisted.nodes.every(node => node.state === "idle"));
});

test("historical events are not painted onto a graph when the read model selects no run", () => {
    const history = [started("poll", 1), completed("poll", 1, "changed"), ended("workflow.completed", { stateId: "done", outcome: "succeeded" })];
    const none = projectWorkflowV2({ readModel: readModel({ noRun: true, definition: { state: "draft", publishedRevision: null, publishedDefinitionHash: null } }), events: history });
    assert.equal(none.runId, null);
    assert.equal(none.status.label, "No run yet");
    assert.deepEqual(none.banners.map(banner => banner.text), ["Draft revision 1 · not published.", "No run yet."]);
    assert.ok(none.nodes.every(node => node.state === "idle" && node.stateLabel === "No run"));
    const others = projectWorkflowV2({ readModel: readModel({ noRun: true, runs: [{ runId: "old", mode: "test", status: "completed", revision: 1, outcome: "succeeded" }] }), events: history });
    assert.equal(others.status.label, "No live run selected");
    assert.ok(others.banners.some(banner => banner.text === "No live run is selected; 1 other run exists."));
    assert.ok(others.nodes.every(node => node.state === "idle"));
    const invalid = projectWorkflowV2({ readModel: readModel({ noRun: true, graph: null, revision: { revision: 2, valid: false, diagnostics: [] } }), events: history });
    assert.equal(invalid.runId, null);
    assert.equal(invalid.status.label, "No run yet");
    const withStart = (revision, events) => [ev("workflow.started", { ...startedData, revision }), ...events];
    const events = [completed("poll", 1, "changed")];
    const other = projectWorkflowV2({ definition, events: withStart(2, events) });
    assert.equal(other.bound, false);
    assert.equal(other.status.label, "Revision 2 run · Running");
    assert.ok(other.nodes.every(node => node.state === "idle"));
    assert.ok(other.banners.some(banner => /used revision 2; the graph shows revision 1/.test(banner.text)));
    const same = projectWorkflowV2({ definition, events: withStart(1, events) });
    assert.equal(same.bound, true);
    assert.equal(byId(same, "poll").state, "done");
});

test("a read model that contradicts a pause or resume event is reported as unverified, in both directions", () => {
    const paused = seq => ({ ...ev("workflow.paused", { runId: RUN }), seq });
    const resumed = seq => ({ ...ev("workflow.resumed", { runId: RUN }), seq });
    const running = nodeExecutions => readModel({ nodeExecutions });
    const pausedModel = readModel({ run: { status: "paused", pausedFrom: "running", pauseSettled: true } });
    const a = projectWorkflowV2({ readModel: running([row("poll", 1, "pending")]), events: [paused(5)] });
    assert.equal(a.status.phase, "unverified");
    assert.equal(a.status.label, "Status not certain · its data says running, latest event says paused");
    assert.ok(a.banners.some(banner => banner.text === "Run status is not certain: the workflow's data says running but its latest event says paused. Refresh to read it again."));
    assert.equal(byId(a, "poll").stateLabel, "Pending · run status not certain");
    assert.equal(byId(a, "poll").state, "idle");
    const b = projectWorkflowV2({ readModel: pausedModel, events: [resumed(6)] });
    assert.equal(b.status.label, "Status not certain · its data says paused, latest event says resumed");
    const pausing = projectWorkflowV2({ readModel: readModel({ run: { status: "paused", pausedFrom: "running", pauseSettled: false } }), events: [resumed(6)] });
    assert.equal(pausing.status.phase, "unverified");
    assert.equal(projectWorkflowV2({ readModel: running([]), events: [paused(5), resumed(6)] }).status.label, "Running");
    assert.equal(projectWorkflowV2({ readModel: pausedModel, events: [paused(5)] }).status.label, "Paused");
    assert.equal(projectWorkflowV2({ readModel: running([]) }).status.label, "Running");
    assert.equal(projectWorkflowV2({ readModel: readModel({ run: { status: "admitted" } }), events: [resumed(2)] }).status.label, "Waiting to start");
    assert.equal(projectWorkflowV2({ readModel: readModel({ run: { status: "admitted" } }), events: [paused(2)] }).status.phase, "unverified");
    const status = (afterSeq, event) => projectWorkflowV2({ readModel: running([]), events: [event], readModelAfterSeq: afterSeq }).status;
    assert.equal(status(7, paused(5)).label, "Running", "an event older than the snapshot cannot contradict it");
    assert.equal(status(5, paused(5)).label, "Running");
    assert.equal(status(4, paused(5)).phase, "unverified", "an event that may be newer still contradicts it");
    assert.equal(status(7, ev("workflow.paused", { runId: RUN })).phase, "unverified", "an event with no sequence is never ordered");
    assert.equal(status("7", paused(5)).phase, "unverified", "an unusable watermark is not trusted");
    const ended = projectWorkflowV2({ readModel: readModel({ run: { status: "completed", outcome: "succeeded", terminalState: "done" } }), events: [paused(9)] });
    assert.equal(ended.status.label, "Completed · succeeded");
});
