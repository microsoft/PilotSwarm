/**
 * FB-034, review F1: a failed session delete must be FAILED to the people looking at it.
 *
 * The first version of FB-034 changed the orchestration's output string to "failed" and stopped there. That string
 * is the orchestration's OUTPUT, and an orchestration that returns it has still COMPLETED, so no reader derives a
 * failure from it: `deriveSessionStatus` never sees orchestration output at all. The portal and every client kept
 * showing the session as it was before - or, for a child that had completed a turn earlier, as completed.
 *
 * These tests work on `deriveSessionStatus` directly, because that is the one function every status surface goes
 * through: the client's getInfo, the management API's list and the portal's rendering all derive from it. They pin
 * the two shapes the review named - a retained ROOT, and a CHILD with an earlier completed response - plus the
 * cases that must NOT change.
 *
 * Run: npx vitest run test/local/session-delete-failed-status.test.js
 */
import { describe, it, expect } from "vitest";
import { deriveSessionStatus, isCompletedTerminalSession, shouldSyncFailedStatus } from "../../src/session-status.ts";

/**
 * A session as a status read sees it after the live orchestration failed to delete it: the orchestration itself
 * COMPLETED (it returned the string "failed"), and the delete branch wrote failed custom status and failed row
 * state. `status` is the custom status, `rowState` the CMS row.
 */
const afterFailedDelete = (over = {}) => ({
    isSystem: false,
    orchestrationStatus: "Completed",
    status: "failed",
    rowState: "failed",
    ...over,
});

describe("FB-034 F1: a failed delete is failed on every status surface", () => {
    it("a retained ROOT session reads as failed, not as whatever it was before", () => {
        // The review's first shape. A root has no parent, so the completed-terminal inference never applied to it;
        // what failed it before was that NOTHING was written, so the read fell through to its previous state.
        const root = afterFailedDelete({ parentSessionId: null });
        expect(deriveSessionStatus(root)).toBe("failed");
    });

    it("a CHILD with an earlier completed response reads as failed, not completed", () => {
        // The review's second shape, and the one that needed more than writing the state. A child whose
        // orchestration has ended and whose earlier turn answered "completed" is INFERRED to be completed. That
        // inference used to outrank the failure we just recorded, so the deletion failure was invisible on exactly
        // the sessions most likely to be deleted.
        const child = afterFailedDelete({ parentSessionId: "parent-1", latestResponseType: "completed" });
        expect(isCompletedTerminalSession(child), "the inference must yield to the recorded verdict").toBe(false);
        expect(deriveSessionStatus(child)).toBe("failed");
    });

    it("the same child by turn result, not just by latest response", () => {
        const child = afterFailedDelete({ parentSessionId: "parent-1", turnResultType: "completed" });
        expect(deriveSessionStatus(child)).toBe("failed");
    });

    it("failed custom status alone is enough, and failed row state alone is enough", () => {
        // They are written by different calls to different stores, and either can be the one that lands - the row
        // write is best effort. Neither may depend on the other to be believed.
        const statusOnly = afterFailedDelete({ parentSessionId: "parent-1", rowState: null, latestResponseType: "completed" });
        expect(deriveSessionStatus(statusOnly), "custom status alone").toBe("failed");

        const rowOnly = afterFailedDelete({ parentSessionId: "parent-1", status: null, latestResponseType: "completed" });
        expect(deriveSessionStatus(rowOnly), "row state alone").toBe("failed");
    });

    it("a failed delete is written back by a status read", () => {
        // shouldSyncFailedStatus keys on the RUNTIME status being Failed, which this is not: our orchestration
        // completed. The row we wrote ourselves is what carries it, so the read has nothing left to repair.
        const child = afterFailedDelete({ parentSessionId: "parent-1", latestResponseType: "completed" });
        expect(shouldSyncFailedStatus(child), "nothing to sync: the row already says failed").toBe(false);
        expect(child.rowState, "because the delete branch wrote it").toBe("failed");
    });

    // ── The cases that must NOT change ────────────────────────────────────

    it("an ordinary completed child is still completed", () => {
        const done = {
            isSystem: false, parentSessionId: "parent-1", orchestrationStatus: "Completed",
            status: null, rowState: null, latestResponseType: "completed",
        };
        expect(isCompletedTerminalSession(done)).toBe(true);
        expect(deriveSessionStatus(done)).toBe("completed");
    });

    it("an explicitly completed session is still completed even with a failed row", () => {
        // The recorded-completion check comes first and keeps its precedence: this test exists so that the new
        // recorded-failure check cannot be widened later without someone noticing it moved this line.
        const done = {
            isSystem: false, parentSessionId: "parent-1", orchestrationStatus: "Completed",
            status: "completed", rowState: "failed",
        };
        expect(isCompletedTerminalSession(done)).toBe(true);
    });

    it("a workflow session's own terminal row still wins", () => {
        // workflowOwnsTerminalRow is checked before anything else in the derivation and is not ours to disturb.
        const wf = {
            sessionKind: "workflow", rowState: "completed", isSystem: false,
            parentSessionId: "parent-1", orchestrationStatus: "Completed", status: "failed",
        };
        expect(deriveSessionStatus(wf)).toBe("completed");
    });

    it("a running session with a failed row is still running", () => {
        // The Running branch exists for a session that was repaired and started again; a stale failed row must not
        // resurrect as a verdict.
        const running = {
            isSystem: false, parentSessionId: "parent-1", orchestrationStatus: "Running",
            status: null, rowState: "failed",
        };
        expect(deriveSessionStatus(running)).toBe("running");
    });
});
