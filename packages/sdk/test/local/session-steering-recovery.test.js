import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { createTestEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { createManagementClient, defineTool } from "../helpers/local-workers.js";
import { setClusterFeature, withScriptedModel } from "../helpers/scripted-workers.js";
import { messageText } from "../helpers/scripted-model.mjs";
import { assignSteeringTestOwner, STEER_AUTHOR } from "../helpers/steering-ledger.js";
import { decodeSteeringTarget, steeringContentHash } from "../../src/steering.ts";
import { within } from "../helpers/steering-cli.mjs";

function heldTool(name, result) {
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    return {
        entered: entered.promise,
        release: released.resolve,
        tool: defineTool(name, {
            description: "Controlled recovery fault boundary.",
            parameters: { type: "object", properties: {} },
            handler: async () => { entered.resolve(); await released.promise; return result; },
        }),
    };
}

function receiptAfterEvent(session, catalog, requestId, predicate) {
    const result = Promise.withResolvers();
    const check = async () => {
        const receipt = await catalog.steerGet(session.sessionId, requestId);
        if (receipt && predicate(receipt)) result.resolve(receipt);
    };
    const unsubscribe = session.on((event) => {
        if (event.eventType === "session.steering_updated") void check().catch(result.reject);
    });
    void check().catch(result.reject);
    return { promise: result.promise, unsubscribe };
}

describe.concurrent("session steering recovery lineage gates", () => {
    it("ST-I12/ST-C07: activity-local SDK-loss recovery cannot use dirty raw resume as an inclusion oracle", { timeout: 120_000 }, async () => {
        const env = createTestEnv("steering-recovery");
        const first = heldTool("first_recovery_hold", "first-hold-finished");
        const recovered = heldTool("recovered_turn_hold", "recovered-hold-finished");
        const label = "activity-local-recovery-fixture";
        const guidance = "dirty-guidance-not-yet-saved";
        const respond = (body, position) => {
            const messages = body.messages ?? [];
            const recovering = messages.some((message) => messageText(message).includes("runtime recovered this session after the live Copilot session was lost"));
            if (recovering && !messages.some((message) => message.role === "tool" && messageText(message).includes("recovered-hold-finished"))) {
                return { tools: [{ name: "recovered_turn_hold", args: {} }] };
            }
            if (recovering) return { content: "recovered reply" };
            if (position.lastUserText.includes(label) && !messages.some((message) => message.role === "tool" && messageText(message).includes("first-hold-finished"))) {
                return { tools: [{ name: "first_recovery_hold", args: {} }] };
            }
            if (messages.some((message) => message.role === "user" && messageText(message).includes(guidance))) return { content: "first steered reply" };
            return { content: "committed baseline reply" };
        };
        try {
            await setClusterFeature(env, "sessions.steering", true, { allowUserOverride: false });
            await withScriptedModel(env, { respond, tools: [first.tool, recovered.tool] }, async ({ client, worker, qualifiedModel }) => {
                const catalog = await createCatalog(env);
                const mgmt = await createManagementClient(env);
                let faultedSession;
                let originalRun;
                let requestWait;
                let recoveryWait;
                let windowUnsubscribe;
                let sessionId;
                let turnSent = false;
                try {
                    const session = await client.createSession({ model: qualifiedModel, tools: [first.tool, recovered.tool] });
                    sessionId = session.sessionId;
                    await assignSteeringTestOwner(env, session.sessionId);
                    assertEqual(await session.sendAndWait("baseline-before-recovery", 30_000), "committed baseline reply");
                    const manager = worker.sessionManager;
                    const store = manager.sessionStore;
                    const base = await store.probeSnapshot(session.sessionId);
                    assertEqual(base.version, 1);
                    faultedSession = manager.get(session.sessionId);
                    originalRun = faultedSession.runTurn;
                    const cut = Promise.withResolvers();
                    // Exact fault cut: positive delivery and local SDK completion, before the activity's snapshot CAS.
                    faultedSession.runTurn = async function (prompt, options) {
                        const result = await originalRun.call(this, prompt, options);
                        assert(result.steering?.delivered?.length === 1, "the first attempt observed the actual steer event");
                        cut.resolve(result.steering.delivered[0].sdkMessageId);
                        return { type: "error", message: "Session not found", steering: result.steering };
                    };
                    const opened = Promise.withResolvers();
                    windowUnsubscribe = session.on((event) => {
                        if (event.eventType === "session.steering_window_changed" && event.data?.state === "open") opened.resolve();
                    });
                    await session.send(label);
                    turnSent = true;
                    await within(first.entered, "first model/tool boundary", 30_000);
                    await within(opened.promise, "actual steering window open", 30_000);
                    const state = await catalog.steerState(session.sessionId);
                    assert(state.steerable, "the actual worker opened the steering window");
                    const target = decodeSteeringTarget(state.expectedTarget);
                    const accepted = await catalog.steerAccept({
                        sessionId: session.sessionId, requestId: randomUUID(), idempotencyKey: randomUUID(),
                        actor: STEER_AUTHOR, content: guidance, contentHash: steeringContentHash(guidance), ...target,
                    });
                    assertEqual(accepted.outcome, "accepted");
                    const requestId = accepted.receipt.requestId;
                    requestWait = receiptAfterEvent(session, catalog, requestId, (receipt) => receipt.status === "submitted");
                    await within(requestWait.promise, "first handoff", 30_000);
                    requestWait.unsubscribe();
                    recoveryWait = receiptAfterEvent(session, catalog, requestId, (receipt) =>
                        receipt.inclusion.state === "included" || receipt.attempts.total > 1
                        || receipt.recoveryFlags.includes("redelivery_pending")
                        || receipt.recoveryFlags.includes("recovery_unconfirmed"));
                    first.release();
                    await within(cut.promise, "injected post-delivery SDK loss", 30_000);
                    await within(recovered.entered, "activity-local recovery tool boundary", 30_000);
                    const observed = await within(recoveryWait.promise, "recovery disposition", 30_000);
                    const saved = await store.probeSnapshot(session.sessionId);
                    assertEqual(saved.version, base.version, "the failed attempt has not published any snapshot");
                    assert(observed.inclusion.state !== "included",
                        "raw-resumed dirty conversation is not a stored-snapshot inclusion oracle");
                } finally {
                    requestWait?.unsubscribe();
                    recoveryWait?.unsubscribe();
                    windowUnsubscribe?.();
                    try {
                        if (sessionId && turnSent) await mgmt.stopSessionTurn(sessionId, { reason: "Recovery fixture cleanup" });
                    } finally {
                        first.release();
                        recovered.release();
                        if (faultedSession && originalRun) faultedSession.runTurn = originalRun;
                        await mgmt.stop();
                        await catalog.close();
                    }
                }
            });
        } finally {
            first.release();
            recovered.release();
            await env.cleanup();
        }
    });
});
