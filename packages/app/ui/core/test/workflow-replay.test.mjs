/**
 * Stage 2.4 (spec "Andrew's feedback": the replay): a read view over a run's stored visits, with no new storage. The
 * frames are the visits' entries in the order they ran; the graph at a frame shows each node as it stood then (a visit
 * entered later is not there; one that ended later is still running); a replay before the last visit ended is not
 * ended and names its time; at the last moment it is the run as it is.
 *
 * Run: node --test ui/core/test/workflow-replay.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    projectWorkflow, workflowExecutionsAt, workflowLastMoment, workflowReplayFrames, workflowReplayLabel,
} from "../src/workflow-view.js";
import { RUN, row, done, readModel } from "./workflow-fixtures.mjs";

process.env.TZ = "UTC";

const T = minutes => new Date(Date.parse("2026-11-07T15:00:00.000Z") + minutes * 60_000).toISOString();
// poll#1 changed... no: poll#1 unchanged (0–1), pause#1 (1–2), poll#2 changed (2–3), notify#1 sent (3–4), await_ack#1 pending (4–).
const VISITS = [
    done("poll", 1, "unchanged", { enteredAt: T(0), endedAt: T(1) }),
    done("pause", 1, "elapsed", { enteredAt: T(1), endedAt: T(2) }),
    done("poll", 2, "changed", { enteredAt: T(2), endedAt: T(3) }),
    done("notify", 1, "sent", { enteredAt: T(3), endedAt: T(4) }),
    row("await_ack", 1, "pending", { enteredAt: T(4) }),
];
const byId = (projection, id) => projection.nodes.find(node => node.id === id);

test("the frames are the visits' entries in the order they ran, each in words", () => {
    const projection = projectWorkflow({ readModel: readModel({ nodeExecutions: VISITS }) });
    const frames = workflowReplayFrames(projection.allExecutions);
    assert.deepEqual(frames.map(frame => [frame.stateId, frame.ordinal]), [["poll", 1], ["pause", 1], ["poll", 2], ["notify", 1], ["await_ack", 1]]);
    assert.equal(frames[2].atMs, Date.parse(T(2)));
    // OF-S2-2 part 2: the local time without its zone (the clock on the same day), the node's run, its item.
    assert.match(workflowReplayLabel(frames[2]), /^(\d{4}-\d{2}-\d{2} )?15:02:00 · poll visit 2$/);
    assert.match(workflowReplayLabel({ ...frames[2], branchIndex: 2 }), /^(\d{4}-\d{2}-\d{2} )?15:02:00 · poll visit 2 · item 3$/);
    // A visit with no entry time is not a frame.
    assert.deepEqual(workflowReplayFrames([{ id: "x", stateId: "poll" }, null]), []);
    assert.equal(workflowLastMoment(projection.allExecutions), Date.parse(T(4)));
    assert.equal(workflowLastMoment([]), -Infinity);
});

test("the visits as they stood at a moment: later entries are not there, later ends are still running", () => {
    const projection = projectWorkflow({ readModel: readModel({ nodeExecutions: VISITS }) });
    const at = workflowExecutionsAt(projection.allExecutions, Date.parse(T(2)) + 30_000);
    assert.deepEqual(at.map(item => [item.stateId, item.ordinal, item.status, item.outcome ?? null]),
        [["poll", 1, "completed", "unchanged"], ["pause", 1, "completed", "elapsed"], ["poll", 2, "pending", null]]);
});

test("the graph at a frame shows each node as it stood then; a replay before the end names its time; at the end it is the run as it is", () => {
    const model = readModel({ nodeExecutions: VISITS });
    const live = projectWorkflow({ readModel: model });
    assert.equal(byId(live, "notify").state, "done");
    assert.equal(byId(live, "await_ack").state, "running");
    // At poll's second visit (15:02:30): poll runs, pause is done, notify and await_ack are not reached.
    const replay = projectWorkflow({ readModel: model, asOf: Date.parse(T(2)) + 30_000 });
    assert.equal(replay.asOf, Date.parse(T(2)) + 30_000);
    assert.equal(byId(replay, "poll").state, "running");
    assert.equal(byId(replay, "pause").state, "done");
    assert.equal(byId(replay, "notify").phase, "not-reached");
    assert.equal(byId(replay, "await_ack").phase, "not-reached");
    assert.match(replay.status.label, /^Replay · 2026-11-07 15:02:30 UTC$/);
    assert.equal(replay.status.ended, false);
    // Every loaded visit stays in allExecutions (the frames do not shrink with the replay).
    assert.equal(replay.allExecutions.length, VISITS.length);
    // A completed run replayed at its first visit is not ended; at its last moment it is the run as it is.
    const finished = readModel({ run: { status: "completed", outcome: "succeeded", terminalState: "done" },
        nodeExecutions: [...VISITS.slice(0, 4), done("await_ack", 1, "received", { enteredAt: T(4), endedAt: T(5) }),
            done("done", 1, "succeeded", { enteredAt: T(5), endedAt: T(5) })] });
    const early = projectWorkflow({ readModel: finished, asOf: Date.parse(T(0)) });
    assert.equal(early.status.ended, false);
    assert.equal(byId(early, "done").phase, "not-reached");
    const end = projectWorkflow({ readModel: finished, asOf: Date.parse(T(5)) });
    assert.equal(end.status.label, projectWorkflow({ readModel: finished }).status.label);
    assert.equal(byId(end, "done").state, "done");
    // No asOf, or no visits: no replay.
    assert.equal(live.asOf, null);
    assert.equal(projectWorkflow({ readModel: readModel({ nodeExecutions: [] }), asOf: Date.parse(T(1)) }).asOf, null);
});

test("a visit that ran in a branch is a frame with its branch", () => {
    const frames = workflowReplayFrames([{ id: "nx-b-2", stateId: "check", ordinal: 1, enteredAt: T(1), branch: { index: 1, item: "b" } },
        { id: "nx-b-1", stateId: "check", ordinal: 1, enteredAt: T(1), branch: { index: 0, item: "a" } }]);
    assert.deepEqual(frames.map(frame => [frame.nodeExecutionId, frame.branchIndex]), [["nx-b-1", 0], ["nx-b-2", 1]]);
    assert.equal(RUN.length > 0, true);
});

// Review S2UI-F6: a send's delivery (and the recipient's later check) is shown only from when it happened.
test("a replay shows a send still delivering before its delivery time, and the recipient's check only from its time", () => {
    const notify = done("notify", 1, "sent", { enteredAt: T(3), endedAt: T(4) });
    const model = readModel({
        nodeExecutions: [...VISITS.slice(0, 3), notify, row("await_ack", 1, "pending", { enteredAt: T(5) })],
        outbox: [{ exchangeId: "ex-1", nodeExecutionId: notify.nodeExecutionId, state: "delivered", attempts: 1, recipientSessionId: "parent-1",
            recipientKind: "parent", contract: "Alert@1", deliveredAt: T(4), payloadPreview: "{}", intakeOutcome: "refused_full", intakeOutcomeAt: T(4.5) }],
    });
    const live = projectWorkflow({ readModel: model });
    assert.equal(byId(live, "notify").stateLabel, "Done · sent, queued at recipient");
    assert.equal(live.allExecutions.find(item => item.stateId === "notify").outbox.intake.kind, "refused_full");
    // 15:03:30: the send has started, its delivery (15:04) has not happened.
    const before = projectWorkflow({ readModel: model, asOf: Date.parse(T(3)) + 30_000 });
    const sending = byId(before, "notify").current;
    assert.equal(sending.status, "pending");
    assert.equal(sending.outbox.state, "pending");
    assert.equal(sending.outbox.deliveredAt, null);
    assert.equal(sending.outbox.intake, undefined);
    assert.equal(byId(before, "notify").stateLabel, "Sending");
    // 15:04: delivered; the recipient's check (15:04:30) is later.
    const delivered = projectWorkflow({ readModel: model, asOf: Date.parse(T(4)) });
    const sent = byId(delivered, "notify").current;
    assert.equal(sent.outbox.state, "delivered");
    assert.equal(sent.outbox.intake, undefined);
    assert.equal(byId(delivered, "notify").stateLabel, "Done · sent, queued at recipient");
    // 15:05: the check is shown.
    const checked = projectWorkflow({ readModel: model, asOf: Date.parse(T(5)) });
    assert.equal(byId(checked, "notify").current.outbox.intake.kind, "refused_full");
    // A pending send delivered with no recorded time is not shown delivered in a replay, nor a failure before the visit ended.
    const [unknown] = workflowExecutionsAt([row("notify", 2, "pending", { enteredAt: T(6), outbox: { state: "delivered", deliveredAt: null } })], Date.parse(T(7)));
    assert.equal(unknown.outbox.state, "pending");
    const [failing] = workflowExecutionsAt([{ ...done("notify", 3, "failed", { enteredAt: T(6), endedAt: T(8) }), status: "completed",
        outbox: { state: "failed" } }], Date.parse(T(7)));
    assert.equal(failing.outbox.state, "pending");
    // A message a receive took is not shown taken while the visit was still waiting.
    const [waiting] = workflowExecutionsAt([{ ...done("await_ack", 2, "received", { enteredAt: T(6), endedAt: T(8) }), status: "completed",
        inbox: { messageId: "m-1", claimedAt: T(8) } }], Date.parse(T(7)));
    assert.equal(waiting.inbox, undefined);
});
