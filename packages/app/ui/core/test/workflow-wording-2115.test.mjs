/**
 * The coordinator's read-only check of the wording at aa51346d (2026-11-07T21:15Z): eight lines broke the rules set at 18:45Z
 * and 19:10Z. Each says it now in the Workflow's words:
 * - the For each node's "Time limit" row reads "Limit" (its tooltip "Time limit"), its deadline "Limit ends" (in
 *   workflow-v2-join-limit.test.mjs);
 * - a node canceled when a stop's time to finish ended: the Workflow "was canceled after started nodes finished", never
 *   "was stopped";
 * - a version 1 node's panel header says its state in words ("Canceled"), never the raw "cancelled";
 * - the graph checks say "node", never "step" (in workflow-v2-view.test.mjs);
 * - a stale save begins "Revision not saved:" (in workflow-chat-definitions.test.mjs), and the refusals of a save, delete,
 *   copy, update and start begin with what was not done ("Delete refused:", "Copy refused:", "Update refused:",
 *   "Start refused:").
 *
 * Run: node --test test/workflow-wording-2115.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { workflowV2VisitEnding } from "../src/workflow-v2-view.js";
import { workflowRefusalText, workflowV1NodeWords } from "../src/workflow-words.js";
import { RunNodePanel } from "../../react/src/workflow-tab.js";

test("a node canceled when a stop's time to finish ended: the Workflow was canceled after started nodes finished", () => {
    const ending = workflowV2VisitEnding({ status: "completed", resultKind: "runtime_error", outcome: "cancelled", winner: "stop" });
    assert.equal(ending.why, "The Workflow was canceled after started nodes finished; this node had not finished when the time to finish ended");
    assert.doesNotMatch(ending.text, /stopped/i);
});

test("a version 1 node's state in words, never raw", () => {
    assert.equal(workflowV1NodeWords({ type: "script", state: "cancelled" }).state, "Canceled");
    assert.equal(workflowV1NodeWords({ type: "script", state: "done", outcome: "changed" }).state, "Done · changed");
    assert.equal(workflowV1NodeWords({ type: "script", state: "idle" }).state, "Not reached");
    assert.equal(workflowV1NodeWords({ type: "terminal", state: "done", outcome: "succeeded" }).label, "End · succeeded");
    const html = renderToStaticMarkup(React.createElement(RunNodePanel, { controller: null, child: { sessionId: "s", view: {}, projection: null },
        selected: { id: "poll", type: "script", state: "cancelled" } }));
    assert.match(html, /<strong>poll<\/strong> · Script · Canceled/);
    assert.doesNotMatch(html, /cancelled/);
});

test("a refusal begins with what was not done; the server's words follow, or the fallback", () => {
    assert.equal(workflowRefusalText("Start refused", "Revision 3 has errors.", "the Workflow was not started."), "Start refused: Revision 3 has errors.");
    assert.equal(workflowRefusalText("Start refused", null, "the Workflow was not started."), "Start refused: the Workflow was not started.");
    assert.equal(workflowRefusalText("Delete refused", "  ", "it was not deleted."), "Delete refused: it was not deleted.");
    assert.equal(workflowRefusalText("Revision not saved", "Revision not saved: revision 4 was saved by Ada.", "x"), "Revision not saved: revision 4 was saved by Ada.");
});
