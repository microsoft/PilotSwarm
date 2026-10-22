/**
 * Stop-turn live integration (docs/proposals-impl/stop-button-turn-abort-plan.md).
 *
 * Runs real workers + real duroxide + a real LLM:
 *  1. Stop a running turn mid-flight (blocking tool) → outcome stopped,
 *     CMS idle (not cancelled/completed/failed), session.turn_stopped event,
 *     and the session accepts and completes a follow-up prompt. On
 *     orchestration 1.0.81 (session turn control) the Stop is a user.stop
 *     event with one `stopped` outcome and no "Turn stopped by user."
 *     system message (P22); a session pinned to 1.0.80 takes the earlier
 *     event path and keeps that system message.
 *  2. Stop with no active turn → idempotent no_active_turn, and a subsequent
 *     prompt completes (stale-stop leak check).
 *  3. A stale stop event enqueued for an already-finished turn index can never
 *     kill a later turn (turn-scoped queue contract).
 *
 * Run: npx vitest run test/local/stop-turn-live.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient, createManagementClient, defineTool } from "../helpers/local-workers.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { stopTurnQueueName } from "../../src/types.js";
import { pinSessionStartVersion, sessionOrchestrationVersion } from "../helpers/pinned-start.mjs";
import { waitFor, waitForStoppedTurn } from "../helpers/stop-turn-readiness.mjs";

const TIMEOUT = 240_000;
const getEnv = useSuiteEnv(import.meta.url);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBlockingTool(tracker) {
    let release;
    tracker.release = () => release?.();
    const gate = new Promise((resolve) => { release = resolve; });
    return defineTool("test_block", {
        description: "Blocks until the test releases it. Call it when asked to run the blocking step.",
        parameters: { type: "object", properties: {} },
        handler: async () => {
            tracker.started = true;
            // Cap the block so an assertion failure can never leave a dangling
            // handle past the test timeout.
            await Promise.race([gate, sleep(120_000)]);
            return "released";
        },
    });
}

async function testStopsRunningTurnMidFlight(env, { legacy = false } = {}) {
    const tracker = {};
    const blockTool = createBlockingTool(tracker);

    await withClient(env, { tools: [blockTool] }, async (client) => {
        const mgmt = await createManagementClient(env);
        const pin = legacy ? pinSessionStartVersion(client, "1.0.80") : null;
        try {
            const session = await client.createSession({
                tools: [blockTool],
                systemMessage: {
                    mode: "replace",
                    content: "You have a test_block tool. When asked to run the blocking step, call test_block.",
                },
            });

            console.log("  Sending blocking prompt…");
            await session.send("Run the blocking step now.", { requiredTool: "test_block" });

            const started = await waitFor(() => tracker.started === true, 120_000);
            assert(started, "test_block tool never started — cannot exercise mid-flight stop");
            const version = await sessionOrchestrationVersion(client, session.sessionId);
            console.log(`  Turn is mid-flight (blocking tool executing) on orchestration ${version}. Stopping…`);
            assertEqual(version, legacy ? "1.0.80" : "1.0.81", "session runs the intended orchestration version");
            if (!legacy) {
                const detail = await mgmt.getSession(session.sessionId);
                assertEqual(detail.acceptsTurnControl, true, "a 1.0.81 turn accepts controls while it runs");
            }

            const result = await mgmt.stopSessionTurn(session.sessionId, { reason: "Stopped by test", requestId: `stop-live-${legacy ? "legacy" : "v81"}` });
            console.log(`  stopSessionTurn → ${JSON.stringify(result)}`);
            if (legacy) {
                assert(
                    result.outcome === "stopped" || result.outcome === "stop_forced",
                    `expected stopped/stop_forced, got ${result.outcome} (${result.detail ?? ""})`,
                );
            } else {
                assertEqual(result.outcome, "stopped", `turn-control Stop outcome (${result.detail ?? ""})`);
                assert(Number.isFinite(result.controlSeq), "the accepted Stop reports its control seq");
            }

            const stoppedReady = await waitForStoppedTurn(mgmt, session.sessionId, result.turnIndex, 30_000);
            const row = await mgmt._catalog.getSession(session.sessionId);
            assert(stoppedReady, `Stop readiness requires CMS idle and persisted session.turn_stopped for turn ${result.turnIndex}; CMS state: ${row?.state}`);
            assert(row.state !== "cancelled" && row.state !== "completed" && row.state !== "failed",
                `stop must not change lifecycle state (got ${row.state})`);
            assertEqual(row.activeTurnIndex, null, "active_turn_index should be cleared after stop");

            const events = await mgmt.getSessionEvents(session.sessionId);
            const stopped = events.filter((e) => e.eventType === "session.turn_stopped");
            assert(stopped.length >= 1, "session.turn_stopped event should be recorded");
            const notice = events.filter((e) =>
                e.eventType === "system.message"
                && String(e.data?.content ?? "").includes("Turn stopped by user"));
            const userStops = events.filter((e) => e.eventType === "user.stop");
            if (legacy) {
                assert(notice.length >= 1, "visible 'Turn stopped by user.' system message should be recorded");
                assertEqual(userStops.length, 0, "a legacy Stop records no user.stop control");
            } else {
                assertEqual(notice.length, 0, "1.0.81 writes no 'Turn stopped by user.' system message (P22)");
                assertEqual(userStops.length, 1, "exactly one user.stop line");
                assertEqual(userStops[0].seq, result.controlSeq, "the user.stop is the accepted control");
                assertEqual(userStops[0].data?.requestId, "stop-live-v81", "the request id is recorded unchanged");
                const outcomes = events.filter((e) => e.eventType === "session.control_outcome" && e.data?.seq === userStops[0].seq);
                assertEqual(outcomes.length, 1, "exactly one outcome for the Stop");
                assertEqual(outcomes[0].data?.outcome, "stopped", "the Stop's outcome is stopped");
                assertEqual(stopped[0].data?.interrupt, "turn-result", "1.0.81 records the stopped turn result");
            }

            // Session stays usable: a follow-up prompt completes normally.
            tracker.release();
            console.log("  Sending follow-up prompt after stop…");
            const followup = await session.sendAndWait(
                "Reply with exactly the word: alive",
                TIMEOUT,
            );
            console.log(`  Follow-up response: "${followup}"`);
            assert(/alive/i.test(followup), `follow-up turn should complete normally, got: ${followup}`);
        } finally {
            pin?.restore();
            tracker.release?.();
            await mgmt.stop?.();
        }
    });
}

async function testStopIdleSessionIsNoop(env) {
    await withClient(env, async (client) => {
        const mgmt = await createManagementClient(env);
        try {
            const session = await client.createSession({
                systemMessage: { mode: "replace", content: "Answer with one word only." },
            });
            const first = await session.sendAndWait("Say: one", TIMEOUT);
            console.log(`  First turn: "${first}"`);

            const result = await mgmt.stopSessionTurn(session.sessionId);
            console.log(`  stopSessionTurn on idle → ${JSON.stringify(result)}`);
            assertEqual(result.outcome, "no_active_turn", "stop on an idle session must be a no-op");

            // Stale-stop leak check: the no-op must not poison the next turn.
            const second = await session.sendAndWait("Say: two", TIMEOUT);
            console.log(`  Second turn after no-op stop: "${second}"`);
            assert(second && second.length > 0, "turn after a no-op stop should complete normally");
        } finally {
            await mgmt.stop?.();
        }
    });
}

async function testStaleStopCannotKillLaterTurn(env) {
    await withClient(env, async (client) => {
        const mgmt = await createManagementClient(env);
        try {
            const session = await client.createSession({
                systemMessage: { mode: "replace", content: "Answer with one word only." },
            });
            const first = await session.sendAndWait("Say: alpha", TIMEOUT);
            console.log(`  Turn 0: "${first}"`);

            // Forge a stale stop for the already-finished turn 0, bypassing the
            // client-side pre-check. Turn-scoped queues mean nothing ever
            // dequeues it and later turns are structurally unaffected.
            await mgmt._duroxideClient.enqueueEvent(
                `session-${session.sessionId}`,
                stopTurnQueueName(0),
                JSON.stringify({ id: "stale-stop-test", reason: "too late", requestedAt: Date.now() }),
            );
            console.log("  Enqueued stale stop for turn 0; running the next turn…");

            const second = await session.sendAndWait("Say: beta", TIMEOUT);
            console.log(`  Turn 1 with stale stop pending: "${second}"`);
            assert(/beta/i.test(second), `later turn must complete despite the stale stop, got: ${second}`);

            const events = await mgmt.getSessionEvents(session.sessionId);
            const stopped = events.filter((e) => e.eventType === "session.turn_stopped");
            assertEqual(stopped.length, 0, "a stale stop must never stop any turn");
        } finally {
            await mgmt.stop?.();
        }
    });
}

describe("Stop turn — live", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("stops a running turn mid-flight and the session stays usable", { timeout: TIMEOUT * 2 }, async () => {
        await testStopsRunningTurnMidFlight(getEnv());
    });
    it("a session pinned to 1.0.80 still stops through the earlier event path", { timeout: TIMEOUT * 2 }, async () => {
        await testStopsRunningTurnMidFlight(getEnv(), { legacy: true });
    });
    it("is an idempotent no-op on an idle session", { timeout: TIMEOUT * 2 }, async () => {
        await testStopIdleSessionIsNoop(getEnv());
    });
    it("a stale stop for a finished turn cannot kill a later turn", { timeout: TIMEOUT * 2 }, async () => {
        await testStaleStopCannotKillLaterTurn(getEnv());
    });
});
