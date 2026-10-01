import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkerTimelineSwimlane } from "../src/index.js";

const workerNodeId = "pod-hide";

// Two independent WorkflowRuns that ran back-to-back on the same worker. WorkflowRun A occupies
// the 10:00 window; WorkflowRun B occupies the 11:00 window an hour later. Hiding one or
// the other must redraw the swimlane against only the visible WorkflowRun — including a
// reset of the range boundaries to the surviving window.
function twoWorkflowRunEntries() {
    return [
        {
            timelineId: "a:start",
            at: "2026-09-02T10:00:00.000Z",
            kind: "session_event",
            eventType: "session.turn_started",
            workerNodeId,
            workflowRunId: "workflowRun-a",
            workflowRunKey: "wi-a",
            stateName: "FixProposed",
            sessionId: "s-a",
            details: {},
        },
        {
            timelineId: "a:end",
            at: "2026-09-02T10:05:00.000Z",
            kind: "session_event",
            eventType: "session.turn_completed",
            workerNodeId,
            workflowRunId: "workflowRun-a",
            workflowRunKey: "wi-a",
            stateName: "FixProposed",
            sessionId: "s-a",
            details: {},
        },
        {
            timelineId: "b:start",
            at: "2026-09-02T11:00:00.000Z",
            kind: "session_event",
            eventType: "session.turn_started",
            workerNodeId,
            workflowRunId: "workflowRun-b",
            workflowRunKey: "wi-b",
            stateName: "FixProposed",
            sessionId: "s-b",
            details: {},
        },
        {
            timelineId: "b:end",
            at: "2026-09-02T11:05:00.000Z",
            kind: "session_event",
            eventType: "session.turn_completed",
            workerNodeId,
            workflowRunId: "workflowRun-b",
            workflowRunKey: "wi-b",
            stateName: "FixProposed",
            sessionId: "s-b",
            details: {},
        },
    ];
}

const now = Date.parse("2026-09-02T12:00:00.000Z");

function workflowRunLanes(swimlane) {
    return swimlane.lanes.filter((lane) => lane.kind === "workflowRun");
}

test("baseline: both WorkflowRuns get a lane and the range spans both windows", () => {
    const swimlane = buildWorkerTimelineSwimlane(twoWorkflowRunEntries(), { now, workerNodeId });
    const lanes = workflowRunLanes(swimlane);
    assert.equal(lanes.length, 2, "both WorkflowRuns are laned when nothing is hidden");
    assert.deepEqual(lanes.map((lane) => lane.workflowRunId).sort(), ["workflowRun-a", "workflowRun-b"]);
    assert.equal(swimlane.hiddenWorkflowRunCount, 0);
    assert.deepEqual(swimlane.hiddenWorkflowRunIds, []);
    assert.deepEqual(swimlane.hiddenWorkflowRuns, []);
    // Range covers WorkflowRun A's start through WorkflowRun B's end.
    assert.equal(swimlane.startAt, "2026-09-02T10:00:00.000Z");
    assert.equal(swimlane.endAt, "2026-09-02T11:05:00.000Z");
});

test("hiding a WorkflowRun redraws the swimlane and resets the range to the visible WorkflowRun", () => {
    const baseline = buildWorkerTimelineSwimlane(twoWorkflowRunEntries(), { now, workerNodeId });
    const hidden = buildWorkerTimelineSwimlane(twoWorkflowRunEntries(), {
        now,
        workerNodeId,
        hiddenWorkflowRunIds: ["workflowRun-b"],
    });

    const lanes = workflowRunLanes(hidden);
    assert.equal(lanes.length, 1, "only the visible WorkflowRun keeps a lane");
    assert.equal(lanes[0].workflowRunId, "workflowRun-a");

    // Boundaries reset to WorkflowRun A's window — the whole range no longer reaches
    // WorkflowRun B's 11:05 end. This is the "reset timestamp boundaries" guarantee.
    assert.equal(hidden.startAt, "2026-09-02T10:00:00.000Z");
    assert.equal(hidden.endAt, "2026-09-02T10:05:00.000Z");
    assert.ok(
        hidden.durationMs < baseline.durationMs,
        "the redrawn range is shorter than the two-WorkflowRun range",
    );
    assert.ok(
        Date.parse(hidden.displayEndAt) < Date.parse(baseline.displayEndAt),
        "the display window also shrinks to the visible WorkflowRun",
    );

    // Hidden metadata still describes the dropped WorkflowRun so the UI can label it.
    assert.equal(hidden.hiddenWorkflowRunCount, 1);
    assert.deepEqual(hidden.hiddenWorkflowRunIds, ["workflowRun-b"]);
    assert.equal(hidden.hiddenWorkflowRuns[0].workflowRunId, "workflowRun-b");
    assert.equal(hidden.hiddenWorkflowRuns[0].workflowRunKey, "wi-b");
});

test("hiding every WorkflowRun yields an empty swimlane with full hidden metadata", () => {
    const swimlane = buildWorkerTimelineSwimlane(twoWorkflowRunEntries(), {
        now,
        workerNodeId,
        hiddenWorkflowRunIds: ["workflowRun-a", "workflowRun-b"],
    });
    assert.deepEqual(swimlane.lanes, []);
    assert.equal(swimlane.startAt, null);
    assert.equal(swimlane.endAt, null);
    assert.equal(swimlane.durationMs, 0);
    assert.equal(swimlane.hiddenWorkflowRunCount, 2);
    assert.deepEqual(swimlane.hiddenWorkflowRunIds.sort(), ["workflowRun-a", "workflowRun-b"]);
});

test("a hidden-id that matches no WorkflowRun is ignored", () => {
    const swimlane = buildWorkerTimelineSwimlane(twoWorkflowRunEntries(), {
        now,
        workerNodeId,
        hiddenWorkflowRunIds: ["workflowRun-ghost"],
    });
    assert.equal(workflowRunLanes(swimlane).length, 2, "no real WorkflowRun is dropped");
    assert.equal(swimlane.hiddenWorkflowRunCount, 0, "an unmatched id is not counted as hidden");
    assert.deepEqual(swimlane.hiddenWorkflowRunIds, []);
});

test("hiddenWorkflowRunIds accepts a Set as well as an array", () => {
    const swimlane = buildWorkerTimelineSwimlane(twoWorkflowRunEntries(), {
        now,
        workerNodeId,
        hiddenWorkflowRunIds: new Set(["workflowRun-a"]),
    });
    const lanes = workflowRunLanes(swimlane);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].workflowRunId, "workflowRun-b");
    assert.equal(swimlane.hiddenWorkflowRunCount, 1);
    assert.deepEqual(swimlane.hiddenWorkflowRunIds, ["workflowRun-a"]);
});
