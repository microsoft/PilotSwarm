import { describe, it, expect } from "vitest";
import { PilotSwarmManagementClient } from "../../src/management-client.js";
import { stopTurnQueueName } from "../../src/types.js";

/**
 * PilotSwarmManagementClient.stopSessionTurn on a legacy turn (moved from
 * stop-turn.test.js): CMS pre-check, turn-scoped stop queue addressing,
 * command-response polling, timeout. The fake catalog answers every Stop
 * with `legacy_turn`, as for a turn of orchestration 1.0.80 or older; the
 * turn-control path is covered by turn-control-management.test.js.
 *
 * No live LLM, database, or duroxide runtime required.
 */

// ─── Management client stopSessionTurn ───────────────────────────

function createMgmtHarness({ row, response } = {}) {
    const mgmt = new PilotSwarmManagementClient({});
    mgmt._started = true;
    const enqueues = [];
    mgmt._duroxideClient = {
        enqueueEvent: async (orchestrationId, queue, payload) => {
            enqueues.push({ orchestrationId, queue, payload: JSON.parse(payload) });
        },
    };
    const controls = [];
    mgmt._catalog = {
        getSession: async () => row ?? null,
        turnControlAdd: async (sessionId, kind, text, requestId) => {
            controls.push({ sessionId, kind, text, requestId });
            return { refused: "legacy_turn" };
        },
    };
    mgmt._assertOrchestrationLive = async () => {};
    mgmt._readJsonValue = async (_sessionId, key) => {
        if (response && enqueues.length > 0 && key === `command.response.${enqueues[0].payload.id}`) {
            return { schemaVersion: 1, version: 1, emittedAt: Date.now(), id: enqueues[0].payload.id, cmd: "stop_turn", ...response };
        }
        return null;
    };
    return { mgmt, enqueues, controls };
}

describe("PilotSwarmManagementClient.stopSessionTurn", () => {
    it("returns no_active_turn without enqueueing when the session is not running", async () => {
        const { mgmt, enqueues } = createMgmtHarness({
            row: { sessionId: "s1", state: "idle", activeTurnIndex: null, deletedAt: null },
        });
        const result = await mgmt.stopSessionTurn("s1");
        expect(result.outcome).toBe("no_active_turn");
        expect(enqueues.length).toBe(0);
    });

    it("returns no_active_turn when the session does not exist", async () => {
        const { mgmt, enqueues } = createMgmtHarness({ row: null });
        const result = await mgmt.stopSessionTurn("missing");
        expect(result.outcome).toBe("no_active_turn");
        expect(enqueues.length).toBe(0);
    });

    it("enqueues on the turn-scoped stop queue and returns the polled outcome", async () => {
        const { mgmt, enqueues } = createMgmtHarness({
            row: { sessionId: "s2", state: "running", activeTurnIndex: 4, deletedAt: null },
            response: { result: { outcome: "stopped", turnIndex: 4 } },
        });
        const result = await mgmt.stopSessionTurn("s2", { reason: "test stop" });

        expect(enqueues.length).toBe(1);
        expect(enqueues[0].orchestrationId).toBe("session-s2");
        expect(enqueues[0].queue).toBe(stopTurnQueueName(4));
        expect(enqueues[0].queue).toBe("stopTurn.4");
        expect(typeof enqueues[0].payload.id).toBe("string");
        expect(enqueues[0].payload.reason).toBe("test stop");

        expect(result.outcome).toBe("stopped");
        expect(result.turnIndex).toBe(4);
    });

    it("asks the catalog first and falls back to the legacy path only on legacy_turn", async () => {
        const { mgmt, enqueues, controls } = createMgmtHarness({
            row: { sessionId: "s4", state: "running", activeTurnIndex: 2, deletedAt: null },
            response: { result: { outcome: "stop_forced", turnIndex: 2 } },
        });
        const result = await mgmt.stopSessionTurn("s4", { reason: "legacy", requestId: "req-legacy" });
        expect(controls).toEqual([{ sessionId: "s4", kind: "stop", text: "legacy", requestId: "req-legacy" }]);
        expect(enqueues.map((e) => e.queue)).toEqual(["stopTurn.2"]);
        expect(result).toEqual({ outcome: "stop_forced", turnIndex: 2 });
    });

    it("times out honestly when no response ever lands (stale-stop window)", async () => {
        const { mgmt, enqueues } = createMgmtHarness({
            row: { sessionId: "s3", state: "running", activeTurnIndex: 1, deletedAt: null },
            // no response — the turn ended between the CMS read and the enqueue
        });
        const result = await mgmt.stopSessionTurn("s3", { timeoutMs: 300 });
        expect(enqueues.length).toBe(1);
        expect(result.outcome).toBe("timeout");
        expect(result.turnIndex).toBe(1);
    });
});
