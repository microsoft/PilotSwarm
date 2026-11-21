// Workflow Simplified stage 2.1c, FU-19: the screens say a failed step's words as the server made them from the whole
// stored error (`errorWords` on a read's visit, a failed run and a `workflow.state_failed` event), and read them from the
// error preview only for a read or an event of an earlier build. HN #2's shape: a preview cut before the script's error
// line still reads in the server's words.
//
// Run: node --test packages/app/ui/core/test/workflow-server-error-words.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { workflowServerErrorWords, workflowErrorWords } from "../src/workflow-error-words.js";
import { workflowFailure } from "../src/workflow-owner.js";
import { workflowNodeNow, workflowNodeResult } from "../src/workflow-node-summary.js";
import { projectWorkflow } from "../src/workflow-view.js";
import { readModel } from "./workflow-fixtures.mjs";

process.env.TZ = "UTC";

const WORDS = "the script stopped with an error: Unknown model: gpt-imaginary";
// A preview cut at 500 characters before the error line (keys in sorted order: details.stderr first, its stack first).
const CUT = JSON.stringify(JSON.stringify({ code: "execution_failed", details: { exitCode: 1, stderr: `${"    at frame (file:///x.mjs:1:1)\n".repeat(30)}Error: Unknown model: gpt-imaginary` },
    message: "The script exited with code 1." })).slice(0, 499) + "…";

test("the server's words first; the preview's only without them", () => {
    assert.equal(workflowServerErrorWords({ errorWords: WORDS, errorPreview: CUT }), WORDS);
    assert.notEqual(workflowErrorWords(CUT), WORDS, "the cut preview alone cannot say the line");
    assert.equal(workflowServerErrorWords({ errorPreview: "\"{\\\"code\\\":\\\"timed_out\\\",\\\"message\\\":\\\"Too slow.\\\"}\"" }), "Too slow.");
    assert.equal(workflowServerErrorWords({ errorWords: WORDS, error: "x" }, "error"), WORDS);
    assert.equal(workflowServerErrorWords({ error: "the feed did not answer" }, "error"), "the feed did not answer");
    assert.equal(workflowServerErrorWords(null), null);
});

test("a failed run's headline and the Node panel's result say the server's words; Now says the shortest reason (OF-S2-2)", () => {
    const states = [
        { id: "poll", type: "script", outcomes: ["ok"], next: { ok: "done" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
    ];
    const visit = { nodeExecutionId: "nx-poll-1", stateId: "poll", ordinal: 1, state: "completed", outcome: "execution_failed", resultKind: "runtime_error",
        winner: "effect", attempts: 0, kvRevision: 1, enteredAt: "2026-11-07T05:00:00.000Z", endedAt: "2026-11-07T05:00:02.000Z", errorPreview: CUT, errorWords: WORDS };
    const run = { runId: "run-1", mode: "live", status: "failed", outcome: null, terminalState: null, output: null, kvRevision: 1, kv: "{}",
        error: JSON.stringify({ code: "execution_failed", message: "State poll failed.", details: { nodeExecutionId: "nx-poll-1" } }),
        errorWords: "State poll failed.", nodeExecutions: [visit], inbox: [], outbox: [] };
    const failure = workflowFailure(run);
    assert.equal(failure.headline, `poll failed: ${WORDS}`);
    assert.equal(failure.executionId, "nx-poll-1");
    const model = readModel({ graph: { revision: 1, initial: "poll", states }, runs: [{ runId: "run-1", mode: "live", status: "failed", revision: 1, outcome: null }], run });
    const node = projectWorkflow({ readModel: model }).nodes.find(item => item.id === "poll");
    assert.equal(node.current?.errorWords ?? node.executions?.at(-1)?.errorWords, WORDS);
    // The words are said once, in the result; Now says the shortest reason and the time.
    assert.match(workflowNodeNow(node, node.current ?? node.executions.at(-1)), /^Failed · execution failed · \S/);
    assert.match(workflowNodeResult(node, node.current ?? node.executions.at(-1)).text, new RegExp(`^${WORDS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("a step's failure event carries its words to the graph before its read", () => {
    const states = [
        { id: "poll", type: "script", outcomes: ["ok"], next: { ok: "done" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
    ];
    const at = "2026-11-07T05:00:00.000Z";
    const events = [
        { seq: 1, eventType: "workflow.started", createdAt: at, data: { runId: "run-1", mode: "live", revision: 1, definitionHash: "h", name: "n", version: "1.0.0",
            initial: "poll", states } },
        { seq: 2, eventType: "workflow.state_started", createdAt: at, data: { runId: "run-1", nodeExecutionId: "nx-poll-1", stateId: "poll", step: 1 } },
        { seq: 3, eventType: "workflow.state_failed", createdAt: at, data: { runId: "run-1", nodeExecutionId: "nx-poll-1", stateId: "poll", step: 1,
            outcome: "execution_failed", resultKind: "runtime_error", error: CUT, errorWords: WORDS } },
    ];
    const projection = projectWorkflow({ definition: { initial: "poll", states }, events });
    const node = projection.nodes.find(item => item.id === "poll");
    const execution = node.current ?? node.executions?.at(-1);
    assert.equal(execution?.errorWords, WORDS);
});
