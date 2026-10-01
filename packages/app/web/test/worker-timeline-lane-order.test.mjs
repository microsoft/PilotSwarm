import assert from "node:assert/strict";
import test from "node:test";
import {
    reconcileWorkerTimelineLaneOrder,
    reorderWorkerTimelineLane,
} from "../../ui/react/src/worker-timeline-lane-order.js";

const lanes = [
    { key: "overhead" },
    { key: "idle" },
    { key: "workflowRun:1" },
    { key: "workflowRun:2" },
];

test("worker timeline lane order preserves known choices and appends new lanes", () => {
    assert.deepEqual(
        reconcileWorkerTimelineLaneOrder(lanes, ["workflowRun:2", "idle", "removed", "workflowRun:2"]),
        ["workflowRun:2", "idle", "overhead", "workflowRun:1"],
    );
});

test("worker timeline lanes move before or after a drop target", () => {
    const order = lanes.map((lane) => lane.key);
    assert.deepEqual(
        reorderWorkerTimelineLane(order, "workflowRun:2", "idle", "before"),
        ["overhead", "workflowRun:2", "idle", "workflowRun:1"],
    );
    assert.deepEqual(
        reorderWorkerTimelineLane(order, "overhead", "workflowRun:2", "after"),
        ["idle", "workflowRun:1", "workflowRun:2", "overhead"],
    );
});
