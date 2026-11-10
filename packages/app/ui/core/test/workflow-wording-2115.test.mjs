/**
 * The coordinator's read-only check of the wording at aa51346d (2026-11-07T21:15Z): lines broke the rules set at 18:45Z
 * and 19:10Z. Each says it now in the Workflow's words:
 * - the For each node's "Time limit" row reads "Limit" (its tooltip "Time limit"), its deadline "Limit ends" (in
 *   workflow-join-limit.test.mjs);
 * - a node canceled when a stop's time to finish ended: the Workflow "was canceled after started nodes finished", never
 *   "was stopped";
 * - the graph checks say "node", never "step" (in workflow-view.test.mjs);
 * - a stale save begins "Revision not saved:" (in workflow-session-definitions.test.mjs), and the refusals of a save, delete,
 *   copy, update and start begin with what was not done ("Delete refused:", "Copy refused:", "Update refused:",
 *   "Start refused:").
 *
 * Run: node --test test/workflow-wording-2115.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { workflowVisitEnding } from "../src/workflow-view.js";
import { workflowRefusalText } from "../src/workflow-words.js";

test("a node canceled when a stop's time to finish ended: the Workflow was canceled after started nodes finished", () => {
    const ending = workflowVisitEnding({ status: "completed", resultKind: "runtime_error", outcome: "cancelled", winner: "stop" });
    assert.equal(ending.why, "The Workflow was canceled after started nodes finished; this node had not finished when the time to finish ended");
    assert.doesNotMatch(ending.text, /stopped/i);
});

test("a refusal begins with what was not done; the server's words follow, or the fallback", () => {
    assert.equal(workflowRefusalText("Start refused", "Revision 3 has errors.", "the Workflow was not started."), "Start refused: Revision 3 has errors.");
    assert.equal(workflowRefusalText("Start refused", null, "the Workflow was not started."), "Start refused: the Workflow was not started.");
    assert.equal(workflowRefusalText("Delete refused", "  ", "it was not deleted."), "Delete refused: it was not deleted.");
    assert.equal(workflowRefusalText("Revision not saved", "Revision not saved: revision 4 was saved by Ada.", "x"), "Revision not saved: revision 4 was saved by Ada.");
});
