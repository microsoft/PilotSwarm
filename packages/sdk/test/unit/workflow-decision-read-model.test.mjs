import test from "node:test";
import assert from "node:assert/strict";

import { workflowDecisionReadSummary } from "../../dist/workflow/tools.js";

test("Decision read summaries keep valid long semantic output structured and allow-list their fields", () => {
    const level = `Critical ${"x".repeat(620)}`;
    const output = {
        questionType: "score",
        outcome: "scored",
        score: 2.37,
        levels: [
            { label: "Cosmetic", probability: 0.01 },
            { label: "Minor", probability: 0.07 },
            { label: "Major", probability: 0.5 },
            { label: level, probability: 0.42 },
        ],
        model: { qualified: "decision:review" },
        attemptId: "attempt-secret",
        requestId: "request-secret",
        providerPayload: { raw: "provider-secret" },
        latencyMs: 321,
        usage: { total: 77 },
    };
    assert.ok(JSON.stringify(output).length > 500);
    const summary = workflowDecisionReadSummary(output);
    assert.deepEqual(summary, {
        questionType: "score", outcome: "scored", selection: null, confidence: null, score: 2.37,
        probabilities: [], levels: output.levels, policy: null, model: "decision:review", truncated: false,
    });
    assert.doesNotMatch(JSON.stringify(summary), /attempt|request|providerPayload|latency|usage|secret/i);
});

test("Decision read summaries explicitly truncate bounded semantic text", () => {
    const output = {
        questionType: "score", outcome: "scored", score: 8,
        levels: [{ label: `Critical ${"z".repeat(12_000)}`, probability: 1 }],
        model: { qualified: "decision:review" },
    };
    const summary = workflowDecisionReadSummary(output);
    assert.equal(summary.truncated, true);
    assert.equal(summary.score, 8);
    assert.equal(summary.levels.length, 1);
    assert.ok(summary.levels[0].label.endsWith("…"));
    assert.ok(Buffer.byteLength(JSON.stringify(summary), "utf8") <= 4 * 1024);
});
