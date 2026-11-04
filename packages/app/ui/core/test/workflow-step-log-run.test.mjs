/**
 * Adversarial review UI-8: a workflow's step log shows the entries of the run the person chose (else the run the
 * workflow's read model shows), and the session's own notices; another run's entries are left out.
 *
 * Run: node --test test/workflow-step-log-run.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoryModel } from "../src/history.js";
import { workflowStepLogHistory, workflowStepLogRunId } from "../src/workflow-view.js";

const SID = "wf-log";
let seq = 0;
const event = (eventType, data) => ({ seq: ++seq, sessionId: SID, eventType, data, createdAt: new Date(1788800000000 + seq * 1000).toISOString() });
const STATES = [{ id: "work", type: "script", runtime: "node", next: { ok: "done" } }, { id: "done", type: "terminal", outcome: "succeeded" }];
const runEvents = (runId, output) => [
    event("workflow.started", { runId, mode: "test", revision: 1, name: "w", version: "1.0.0", initial: "work", states: STATES }),
    event("workflow.state_completed", { runId, stateId: "work", step: 1, outcome: "ok", resultKind: "business", outputPreview: output }),
    event("workflow.completed", { runId, stateId: "done", outcome: "succeeded", steps: 1 }),
];

test("a step log shows only the chosen run's entries and the session's own notices", () => {
    const history = buildHistoryModel([...runEvents("run-old", "{\"v\":\"old\"}"), ...runEvents("run-new", "{\"v\":\"new\"}"),
        event("workflow.recovered", { action: "none" })]);
    const runs = new Set(history.chat.map(item => item.workflowRunId).filter(Boolean));
    assert.deepEqual([...runs].sort(), ["run-new", "run-old"]);
    const old = workflowStepLogHistory(history, "run-old");
    assert.ok(old.chat.length > 0);
    assert.ok(old.chat.every(item => !item.workflowRunId || item.workflowRunId === "run-old"));
    assert.ok(!JSON.stringify(old.chat).includes('\\"new\\"'));
    assert.ok(old.chat.some(item => !item.workflowRunId), "the session's own notice stays");
    // No run chosen, or nothing to leave out: the same history.
    assert.equal(workflowStepLogHistory(history, null), history);
    assert.equal(workflowStepLogHistory(old, "run-old"), old);
});

test("the log's run: the person's choice, else the read model's run, else none", () => {
    assert.equal(workflowStepLogRunId({ selectedRunId: "run-a", readModel: { run: { runId: "run-b" } } }), "run-a");
    assert.equal(workflowStepLogRunId({ readModel: { run: { runId: "run-b" } }, readModelRunId: null }), "run-b");
    assert.equal(workflowStepLogRunId({ readModel: { runs: [], run: null } }), null);
    assert.equal(workflowStepLogRunId(null), null);
    assert.equal(workflowStepLogRunId({ definition: { states: [] } }), null);
});
