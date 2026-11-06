/**
 * Workflow Simplified, owner feedback 2026-11-06T13:43Z: the Workflow tab's header and toolbar buttons are icons whose
 * tooltip reads "name — explanation" (F1), and the count of a definition's Workflows is in the Workflow picker, not
 * beside the definition (F2): one group labelled with the count, newest first, each option "#7 · Running · 05:38:01",
 * and the closed picker "#7 of 7".
 *
 * Run: node --test ui/core/test/workflow-simplified-icons-picker.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    workflowElapsedText, workflowPickerFace, workflowPickerGroupLabel, workflowPickerOptionLabel, workflowRunTimes, workflowTabButtonTip,
} from "../src/workflow-owner.js";

test("the Workflow picker's group says the count, each option its number, state and start, and the closed picker '#n of count'", () => {
    assert.equal(workflowPickerGroupLabel(7), "7 Workflows");
    assert.equal(workflowPickerGroupLabel(1), "1 Workflow");
    assert.equal(workflowPickerGroupLabel(undefined), "0 Workflows");
    assert.equal(workflowPickerOptionLabel({ number: 7, state: "Running", started: "05:38:01" }), "#7 · Running · 05:38:01");
    // A part not known yet is left out, never shown as a placeholder.
    assert.equal(workflowPickerOptionLabel({ number: 3, state: "Completed" }), "#3 · Completed");
    assert.equal(workflowPickerOptionLabel({ number: 2, state: null, started: "" }), "#2");
    assert.equal(workflowPickerFace(7, 7), "#7 of 7");
    assert.equal(workflowPickerFace(2, 7), "#2 of 7");
    assert.equal(workflowPickerFace(1, 0), "#1");
});

test("a Workflow's start and elapsed time come from its live run's own events; a test run's are left out", () => {
    const at = seconds => new Date(Date.UTC(2026, 10, 6, 13, 38, seconds)).toISOString();
    const events = [
        { eventType: "workflow.started", createdAt: at(1), data: { runId: "run-test", mode: "test" } },
        { eventType: "workflow.started", createdAt: at(2), data: { runId: "run-1" } },
        { eventType: "workflow.completed", createdAt: at(50), data: { runId: "run-test", mode: "test" } },
    ];
    const running = workflowRunTimes(events, "run-1", Date.parse(at(2)) + 165_000);
    assert.equal(running.started, Date.parse(at(2)));
    assert.equal(workflowElapsedText(running.took), "2:45", "still running: up to now");
    const ended = workflowRunTimes([...events, { eventType: "workflow.failed", createdAt: at(32), data: { runId: "run-1" } }], "run-1");
    assert.equal(workflowElapsedText(ended.took), "0:30");
    assert.deepEqual(workflowRunTimes([], null), { started: null, took: null });
    assert.equal(workflowElapsedText(3_725_000), "1:02:05");
    assert.equal(workflowElapsedText(null), null);
});

test("each icon button of the Workflow tab has its explanation, for a tooltip that reads 'name — explanation'", () => {
    assert.equal(workflowTabButtonTip("pause"), "no new step starts; running steps finish");
    assert.equal(workflowTabButtonTip("start", { number: 8 }), "start Workflow #8 from this definition");
    assert.equal(workflowTabButtonTip("start-another", { name: "watch-v2", number: 3 }), "ask the chat to start watch-v2 #3 from this definition");
    assert.equal(workflowTabButtonTip("save", { revision: 4 }), "save as a new revision after revision 4");
    for (const kind of ["definition", "workflows", "start", "start-another", "yaml", "compare", "pause", "resume", "stop", "save", "discard"]) {
        const tip = workflowTabButtonTip(kind);
        assert.ok(typeof tip === "string" && tip.length > 0 && tip.length <= 80, `${kind}: a short explanation`);
        assert.equal(tip[0], tip[0].toLowerCase(), `${kind}: it follows "name — "`);
    }
    assert.equal(workflowTabButtonTip("nothing"), null);
});
