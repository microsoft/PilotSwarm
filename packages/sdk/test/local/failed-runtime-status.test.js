import { describe, it } from "vitest";
import {
    deriveSessionStatus, deriveStatusFromCmsAndRuntime, resolveStaleRunningRowRecovery, shouldRecordWorkflowControllerFailed, shouldSyncCompletedStatus,
    shouldSyncFailedStatus,
} from "../../src/session-status.ts";
import { PilotSwarmClient } from "../../src/client.ts";
import { PilotSwarmManagementClient } from "../../src/management-client.ts";
import { assertEqual } from "../helpers/assertions.js";

describe("Failed runtime status sync", () => {
    it("prefers orchestration failure over stale CMS and custom running state", () => {
        const status = deriveStatusFromCmsAndRuntime({
            row: {
                sessionId: "s1",
                orchestrationId: "session-s1",
                title: null,
                state: "idle",
                model: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                lastActiveAt: null,
                deletedAt: null,
                currentIteration: 0,
                lastError: null,
                waitReason: null,
                parentSessionId: null,
                isSystem: false,
                agentId: null,
                splash: null,
            },
            customStatus: {
                status: "running",
                iteration: 2,
            },
            orchestrationStatus: "Failed",
        });

        assertEqual(status, "failed", "failed runtime should win over stale catalog/custom status");
    });

    it("requests CMS sync when runtime failed but row was not yet marked failed", () => {
        assertEqual(
            shouldSyncFailedStatus({
                rowState: "idle",
                status: "running",
                orchestrationStatus: "Failed",
            }),
            true,
            "stale non-failed rows should self-heal to failed",
        );

        assertEqual(
            shouldSyncFailedStatus({
                rowState: "failed",
                status: "failed",
                orchestrationStatus: "Failed",
            }),
            false,
            "already-synced failed rows should not churn",
        );
    });

    it("prefers live running orchestration over stale CMS error state when no runtime error status is present", () => {
        const status = deriveStatusFromCmsAndRuntime({
            row: {
                sessionId: "s2",
                orchestrationId: "session-s2",
                title: null,
                state: "error",
                model: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                lastActiveAt: null,
                deletedAt: null,
                currentIteration: 0,
                lastError: "Session not found",
                waitReason: null,
                parentSessionId: null,
                isSystem: false,
                agentId: null,
                splash: null,
            },
            customStatus: {},
            orchestrationStatus: "Running",
        });

        assertEqual(status, "running", "live running runtime should override stale CMS error");
    });
});

describe("Stale error row recovery on a running orchestration", () => {
    it("recovers a stale error row when the runtime reports no status", () => {
        assertEqual(
            resolveStaleRunningRowRecovery({ rowState: "error", status: undefined, orchestrationStatus: "Running" }),
            "running",
            "no runtime status: the row is stale and should be recovered",
        );
    });

    it("recovers to the runtime's own non-error status", () => {
        assertEqual(
            resolveStaleRunningRowRecovery({ rowState: "failed", status: "waiting", orchestrationStatus: "Running" }),
            "waiting",
        );
    });

    it("leaves the row alone when the runtime itself reports the error", () => {
        // The worker just wrote this row for a turn that ended in error while
        // the orchestration keeps running (retries pending). The detail read
        // reports "error" to the caller; rewriting the row to "running" made
        // the row-based list disagree with it on every poll.
        assertEqual(
            resolveStaleRunningRowRecovery({ rowState: "error", status: "error", orchestrationStatus: "Running" }),
            null,
        );
        assertEqual(
            resolveStaleRunningRowRecovery({ rowState: "error", status: "failed", orchestrationStatus: "Running" }),
            null,
        );
    });

    it("never touches a row that is not parked on error/failed, or a non-running orchestration", () => {
        assertEqual(resolveStaleRunningRowRecovery({ rowState: "idle", status: undefined, orchestrationStatus: "Running" }), null);
        assertEqual(resolveStaleRunningRowRecovery({ rowState: "error", status: undefined, orchestrationStatus: "Completed" }), null);
    });

    it("F-C2: never rewrites a workflow session's row; an agent session's stale row is still recovered", () => {
        // The workflow store writes a workflow's row, and a failed one is its run's end. Its controller runs on for a moment
        // (it tells the parent first) with its status still "running": a read then used to rewrite the row to running.
        assertEqual(resolveStaleRunningRowRecovery({ rowState: "failed", status: "running", orchestrationStatus: "Running", sessionKind: "workflow" }), null);
        assertEqual(resolveStaleRunningRowRecovery({ rowState: "error", status: undefined, orchestrationStatus: "Running", sessionKind: "workflow" }), null);
        assertEqual(resolveStaleRunningRowRecovery({ rowState: "failed", status: "running", orchestrationStatus: "Running", sessionKind: "agent" }), "running");
    });
});

// F-C2: PilotSwarmClient._getSessionInfo, which a child's parent notification (sendToSession) runs on its parent, has the
// same recovery. A failed workflow row read while the workflow's controller still runs stays failed, with its lastError.
describe("F-C2: a session read while its orchestration still runs, with its row failed", () => {
    const LAST_ERROR = '{"code":"timed_out","message":"State \'summarize\' ended with runtime error \'timed_out\' and has no route for it."}';
    const rowOf = (sessionKind) => ({
        sessionId: "s-1", sessionKind, orchestrationId: "session-s-1", title: null, state: "failed", model: null,
        createdAt: new Date(), updatedAt: new Date(), lastActiveAt: null, deletedAt: null, currentIteration: 0,
        lastError: LAST_ERROR, waitReason: null, parentSessionId: "parent-1", isSystem: false, agentId: null, splash: null,
    });
    /** _getSessionInfo on a client whose store and runtime are stand-ins: the row, a Running orchestration whose status is "running". */
    function reader(row) {
        const updates = [];
        const sdk = {
            _catalog: {
                getSession: async () => row,
                updateSession: async (sessionId, patch) => { updates.push([sessionId, patch]); },
            },
            duroxideClient: {
                getStatus: async () => ({ status: "Running", customStatus: JSON.stringify({ status: "running", sessionKind: row.sessionKind }) }),
            },
            _getLatestResponse: async () => null,
        };
        return { updates, read: () => PilotSwarmClient.prototype._getSessionInfo.call(sdk, row.sessionId) };
    }

    it("leaves a failed workflow row failed, with its lastError, and answers failed with that error", async () => {
        const { updates, read } = reader(rowOf("workflow"));
        const info = await read();
        assertEqual(JSON.stringify(updates), "[]", "no write to the workflow's row");
        // The returned detail agrees with the row (and the session list) while the controller still runs.
        assertEqual(info.status, "failed", "returned status");
        assertEqual(info.error, LAST_ERROR, "returned error");
        assertEqual(info.sessionKind, "workflow");
    });

    it("still recovers an agent session's stale failed row to the runtime's status", async () => {
        const { updates, read } = reader(rowOf("agent"));
        const info = await read();
        assertEqual(JSON.stringify(updates), JSON.stringify([["s-1", { state: "running", lastError: null, waitReason: null }]]));
        assertEqual(info.status, "running", "an agent's live runtime still wins over its stale row");
    });

    it("a workflow's terminal row is its status whatever the runtime still publishes; an agent's is not", () => {
        for (const rowState of ["failed", "completed", "cancelled"]) {
            assertEqual(deriveSessionStatus({ sessionKind: "workflow", rowState, status: "running", orchestrationStatus: "Running" }), rowState);
        }
        assertEqual(deriveSessionStatus({ sessionKind: "workflow", rowState: "running", status: "running", orchestrationStatus: "Running" }), "running");
        assertEqual(deriveSessionStatus({ sessionKind: "agent", rowState: "failed", status: "running", orchestrationStatus: "Running" }), "running");
        // Adversarial review R2-RT-2: a controller that failed after the run's end was stored does not change that end; a
        // controller that failed before it, or an agent's orchestration, is still failed.
        for (const rowState of ["completed", "cancelled", "failed"]) {
            assertEqual(deriveSessionStatus({ sessionKind: "workflow", rowState, status: "completed", orchestrationStatus: "Failed" }), rowState);
            assertEqual(shouldSyncFailedStatus({ sessionKind: "workflow", rowState, orchestrationStatus: "Failed" }), false, rowState);
            assertEqual(shouldSyncCompletedStatus({ sessionKind: "workflow", parentSessionId: "p", rowState, status: "completed", orchestrationStatus: "Completed" }),
                false, rowState);
        }
        assertEqual(deriveSessionStatus({ sessionKind: "workflow", rowState: "running", orchestrationStatus: "Failed" }), "failed");
        // Re-check RC1: a workflow's row is never written back from a read's snapshot; its store records a failed controller.
        assertEqual(shouldSyncFailedStatus({ sessionKind: "workflow", rowState: "running", orchestrationStatus: "Failed" }), false);
        assertEqual(shouldSyncCompletedStatus({ sessionKind: "workflow", parentSessionId: "p", rowState: "running", status: "completed",
            orchestrationStatus: "Completed" }), false);
        assertEqual(shouldRecordWorkflowControllerFailed({ sessionKind: "workflow", rowState: "running", orchestrationStatus: "Failed" }), true);
        assertEqual(shouldRecordWorkflowControllerFailed({ sessionKind: "workflow", rowState: "completed", orchestrationStatus: "Failed" }), false);
        assertEqual(shouldRecordWorkflowControllerFailed({ sessionKind: "agent", rowState: "running", orchestrationStatus: "Failed" }), false);
        assertEqual(deriveSessionStatus({ sessionKind: "agent", rowState: "completed", orchestrationStatus: "Failed" }), "failed");
        assertEqual(shouldSyncFailedStatus({ sessionKind: "agent", rowState: "completed", orchestrationStatus: "Failed" }), true);
    });
});

// Adversarial review R2-RT-2: a workflow whose run ended (completed, cancelled or stopped) and whose controller then failed
// (its notice to the parent never got through) keeps its row: neither client's detail read answers failed or writes
// failed over it. An agent session's failed orchestration is still written back (the control).
describe("R2-RT-2: a workflow's ended row stands over a controller that failed after the end", () => {
    const rowOf = (sessionKind, state) => ({
        sessionId: "s-2", sessionKind, orchestrationId: "session-s-2", title: null, state, model: null,
        createdAt: new Date(), updatedAt: new Date(), lastActiveAt: null, deletedAt: null, currentIteration: 0,
        lastError: null, waitReason: null, parentSessionId: "parent-1", isSystem: false, agentId: null, splash: null,
    });
    /** Both clients' detail reads over stand-ins: the row, and an orchestration that failed (a workflow's last status, completed). */
    function readers(row) {
        const FAILED = { status: "Failed", customStatus: JSON.stringify({ status: row.sessionKind === "workflow" ? "completed" : "running", sessionKind: row.sessionKind }) };
        const updates = [];
        const catalog = { getSession: async () => row, updateSession: async (sessionId, patch) => { updates.push([sessionId, patch]); } };
        const sdk = { _catalog: catalog, duroxideClient: { getStatus: async () => FAILED }, _getLatestResponse: async () => null };
        const mgmt = {
            _ensureStarted() {}, _catalog: catalog, _readJsonValue: async () => null,
            _duroxideClient: { getInstanceInfo: async () => ({ status: "Failed", orchestrationVersion: "1.0.0" }), getStatus: async () => FAILED },
        };
        return {
            updates,
            client: () => PilotSwarmClient.prototype._getSessionInfo.call(sdk, row.sessionId),
            management: () => PilotSwarmManagementClient.prototype.getSession.call(mgmt, row.sessionId),
        };
    }

    it("both clients answer the run's end and write nothing, for a completed, cancelled or failed workflow row", async () => {
        for (const state of ["completed", "cancelled", "failed"]) {
            const h = readers(rowOf("workflow", state));
            assertEqual((await h.client()).status, state, `client ${state}`);
            assertEqual((await h.management()).status, state, `management client ${state}`);
            assertEqual(JSON.stringify(h.updates), "[]", `no write over the ${state} row`);
        }
    });

    it("an agent session's failed orchestration is still written back by both clients", async () => {
        const h = readers(rowOf("agent", "idle"));
        assertEqual((await h.client()).status, "failed");
        assertEqual((await h.management()).status, "failed");
        assertEqual(h.updates.map(([, patch]) => patch.state).join(","), "failed,failed");
    });
});

