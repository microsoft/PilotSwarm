import { describe, it, expect } from "vitest";
import { normalizeRacedTurnValue } from "../../src/orchestration/turn.js";

/**
 * normalizeRacedTurnValue (moved verbatim from stop-turn.test.js): the
 * duroxide-node select bridge flattens activity failures into raw error
 * strings; the orchestration must be able to tell them apart from
 * TurnResult payloads.
 *
 * No live LLM, database, or duroxide runtime required.
 */

// ─── Raced turn value normalization ──────────────────────────────

describe("normalizeRacedTurnValue", () => {
    it("passes through structured TurnResult objects", () => {
        const raced = normalizeRacedTurnValue({ type: "completed", content: "done" });
        expect(raced.kind).toBe("result");
        expect(raced.result.type).toBe("completed");
    });

    it("parses JSON-encoded TurnResult strings", () => {
        const raced = normalizeRacedTurnValue(JSON.stringify({ type: "wait", seconds: 60, reason: "poll" }));
        expect(raced.kind).toBe("result");
        expect(raced.result.type).toBe("wait");
    });

    it("classifies flattened activity error strings as errors", () => {
        // duroxide-node's select bridge maps a failed activity branch to its
        // raw error string (Ok(v) => v, Err(e) => e) instead of throwing.
        const raced = normalizeRacedTurnValue("live Copilot connection closed unexpectedly");
        expect(raced.kind).toBe("error");
        expect(raced.message).toContain("connection closed");
    });

    it("classifies non-TurnResult JSON payloads as errors", () => {
        const raced = normalizeRacedTurnValue(JSON.stringify({ oops: true }));
        expect(raced.kind).toBe("error");
    });
});
