import assert from "node:assert/strict";
import test from "node:test";
import { describeWorkflowRunTransitionBookkeepingEvent } from "../../ui/react/src/workflow-run-transition-bookkeeping.js";

test("transition bookkeeping keeps lifecycle durability events", () => {
    assert.deepEqual(
        describeWorkflowRunTransitionBookkeepingEvent("session.system_wait_started"),
        { label: "Observed-condition wait parked", kind: "wait" },
    );
    assert.deepEqual(
        describeWorkflowRunTransitionBookkeepingEvent("session.dehydrated"),
        { label: "Session dehydrated", kind: "session" },
    );
    assert.deepEqual(
        describeWorkflowRunTransitionBookkeepingEvent("session.error"),
        { label: "Session error", kind: "error" },
    );
});

test("transition bookkeeping excludes model, tool, hook, and message activity", () => {
    for (const eventType of [
        "assistant.message",
        "assistant.reasoning",
        "model.call_start",
        "tool.execution_start",
        "tool.execution_complete",
        "external_tool.requested",
        "external_tool.completed",
        "hook.start",
        "hook.end",
    ]) {
        assert.equal(describeWorkflowRunTransitionBookkeepingEvent(eventType), null, eventType);
    }
});
