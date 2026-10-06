import { describe, expect, it } from "vitest";
import { createCmsSteeringChannel, createSteeringAuthorizer } from "../../src/steering-channel.ts";
import { SteeringPump } from "../../src/steering-pump.ts";
import { evaluateSessionAccess } from "../../api/src/session-authz.js";
import { withSteeringLedger, STEER_OTHER, STEER_AUTHOR } from "../helpers/steering-ledger.js";
import { barrier, makeSteeringTurnHarness } from "../helpers/steering-turn-harness.mjs";
import { within } from "../helpers/steering-cli.mjs";
import { assertEqual } from "../helpers/assertions.js";

describe.concurrent("steering original-author reauthorization", () => {
    for (const recovery of [false, true]) {
        it(`ST-C11/ST-A04: revoked writer cannot ${recovery ? "redo a delivered attempt" : "hand off accepted input"}`, { timeout: 120_000 }, async () => {
            await withSteeringLedger(async (h) => {
                await h.catalog.grantSessionShare(h.sessionId, STEER_OTHER, "write", STEER_AUTHOR);
                await h.open();
                const accepted = await h.accept({ actor: STEER_OTHER });
                if (recovery) {
                    await h.catalog.steerClaim(h.sessionId, h.target.owner, 1);
                    const attemptId = await h.catalog.steerMarkSubmitting(accepted.requestId, h.target.owner);
                    await h.catalog.steerMarkSubmitted(attemptId, h.target.owner, "historical-sdk-id");
                    await h.catalog.steerMarkDelivered(attemptId, "historical-sdk-id", "steering");
                    await h.catalog.steerWindowQuiesce(h.sessionId, h.target.owner);
                }
                const originalAttempts = await h.attempts(accepted.requestId);
                const authCut = barrier();
                const refused = Promise.withResolvers();
                const authorization = createSteeringAuthorizer({
                    sessionId: h.sessionId,
                    getSessionAccess: (sessionId, actor) => h.catalog.getSessionAccess(sessionId, actor),
                    isAdmin: async () => false,
                    decide: (snapshot, isAdmin) => evaluateSessionAccess("session:write", snapshot, { isAdmin }).allowed,
                });
                const channel = createCmsSteeringChannel(h.catalog, h.sessionId, {
                    epoch: h.target.epoch, turnIndex: h.target.turn, incarnation: h.target.incarnation,
                }, "replacement-owner", { recoverySource: "restored" });
                const sdk = makeSteeringTurnHarness();
                const pump = new SteeringPump(sdk.copilot, channel, {
                    stopping: () => false, turnBoundaryScheduled: () => false,
                    quiesceWarmSession: async () => { throw new Error("revoked never-invoked input must not require SDK quiescence"); },
                    authorize: async (row) => { await authCut.hold(); return await authorization(row); },
                    trace: (message) => { if (message.includes("author no longer has write access")) refused.resolve(); },
                });
                try {
                    pump.noteMainPrompt(await sdk.copilot.send({ prompt: "original prompt" }));
                    await within(authCut.entered, "authorization before handoff", 10_000);
                    await h.catalog.revokeSessionShare(h.sessionId, STEER_OTHER);
                    authCut.release();
                    await within(refused.promise, "production predicate refused the recorded original actor", 10_000);
                    sdk.emit("session.idle");
                    await pump.reconcileAfterIdle({ guards: [] });
                    const manifest = await pump.settle({ stopping: false });
                    assertEqual(sdk.copilot.send.mock.calls.filter(([input]) => input.mode === "immediate").length, 0,
                        "current authorization prevents new SDK invocation");
                    expect(await h.attempts(accepted.requestId)).toEqual(originalAttempts,
                        "revocation does not rewrite positive historical evidence");
                    expect(manifest.delivered).toEqual([]);
                    await h.catalog.steerTurnFinalize(h.sessionId, channel.target, channel.ownerToken, "published", [], 2);
                    const receipt = await h.catalog.steerGet(h.sessionId, accepted.requestId);
                    assertEqual(receipt.status, "closed");
                    assertEqual(receipt.inclusion.state, "not_included");
                    assertEqual(receipt.attempts.total, recovery ? 1 : 0);
                    assertEqual(receipt.disposition, recovery ? "delivered_current_turn" : "not_delivered_turn_ended");
                } finally {
                    authCut.release();
                    pump.dispose();
                }
            });
        });
    }
});
