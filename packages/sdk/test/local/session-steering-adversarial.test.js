import { describe, expect, it, vi } from "vitest";
import { SteeringPump } from "../../src/steering-pump.ts";
import { closeStoppedSteering } from "../../src/steering-channel.ts";
import { assertEqual } from "../helpers/assertions.js";
import { makeSteeringTurnHarness } from "../helpers/steering-turn-harness.mjs";
import { within } from "../helpers/steering-cli.mjs";
import { withSteeringLedger } from "../helpers/steering-ledger.js";

describe.concurrent("session steering adversarial R2 failures", () => {
    it("ST-U05/ST-C03: an unknown delivery kind cannot release a live late SDK run", async () => {
        let lateRunActive = false;
        const h = makeSteeringTurnHarness({
            send: async ({ cut, emit }) => {
                await cut.hold();
                lateRunActive = true;
                emit("user.message", { messageId: "sdk-steer-a", content: "Keep this guidance separate" });
                return "sdk-steer-a";
            },
        });
        const quiesce = vi.fn(async () => { lateRunActive = false; return true; });
        const pump = new SteeringPump(h.copilot, h.channel, {
            stopping: () => false, turnBoundaryScheduled: () => false,
            quiesceWarmSession: quiesce, settleMs: 50,
        });
        try {
            pump.noteMainPrompt(await h.copilot.send({ prompt: "original prompt" }));
            await within(h.cut.entered, "registered SDK send");
            h.emit("session.idle");
            h.cut.release();
            await within(h.submitted, "late SDK response");
            await pump.reconcileAfterIdle({ guards: [] });
            await pump.settle({ stopping: false });
            assertEqual(lateRunActive, false, "missing delivery kind is not evidence that the late run already ended");
            expect(quiesce).toHaveBeenCalledTimes(1);
        } finally {
            h.cut.release();
            pump.dispose();
        }
    });

    it("ST-C06: a blocked Stop-close write cannot outlive the bounded storage phase", { timeout: 25_000 }, async () => {
        const entered = Promise.withResolvers();
        const released = Promise.withResolvers();
        const catalog = {
            supportsSteering: async () => true,
            steerCloseStopped: async () => { entered.resolve(); return await released.promise; },
        };
        // The retry budget does not bound the individual I/O unless the helper enforces it.
        const closure = closeStoppedSteering(catalog, "fixture-session", 1, () => {});
        try {
            await entered.promise;
            const closed = await within(closure, "bounded Stop-close result", 20_000);
            assertEqual(closed, false, "a hung fast path reports failure; durable Stop backstop owns closure");
        } finally {
            released.resolve();
            await closure;
        }
    });

    it("ST-C04/ST-C05: explicit uncertain handoff is visible before the target finalizes", { timeout: 120_000 }, async () => {
        await withSteeringLedger(async (h) => {
            await h.open();
            const accepted = await h.accept();
            await h.proc("cms_steer_claim", [h.sessionId, h.target.owner, 1]);
            const attemptId = await h.submitting(accepted.requestId);
            await h.proc("cms_steer_mark_submitted", [attemptId, h.target.owner, "sdk-unconfirmed"]);
            await h.proc("cms_steer_mark_unconfirmed", [attemptId, h.target.owner]);
            const receipt = await h.catalog.steerGet(h.sessionId, accepted.requestId);
            assertEqual(receipt.attempts.items[0].outcome, "unconfirmed");
            assertEqual(receipt.disposition, "delivery_unconfirmed", "uncertainty must not remain Waiting for a safe point");
            await h.proc("cms_steer_mark_delivered", [attemptId, "sdk-unconfirmed", "steering"]);
            const corrected = await h.catalog.steerGet(h.sessionId, accepted.requestId);
            assertEqual(corrected.disposition, "delivered_current_turn", "later positive evidence corrects live uncertainty");
            assertEqual(corrected.attempts.items[0].outcome, "delivered");
        });
    });

    it("ST-M04: cluster enablement refuses an eligible worker without steering capability", { timeout: 120_000 }, async () => {
        await withSteeringLedger(async (h) => {
            await h.catalog.workerHeartbeat({
                workerNodeId: "incapable-worker-fixture", phase: "ready", pool: "test-pool",
                info: { sdkVersion: "fixture-old-build", consumes: ["feature-flags"], capabilities: { "sessions.steering": false } },
            });
            const definition = (await h.catalog.features.revisions()).find((row) => row.featureKey === "sessions.steering");
            const enable = h.catalog.features.mutate({
                principal: { provider: "test", subject: "fixture-admin" }, isAdmin: true,
            }, "cluster", {
                featureKey: "sessions.steering", expectedRevision: definition.revision,
                requestId: "mixed-capability-enable-fixture", enabled: true, allowUserOverride: false,
            });
            await expect(enable).rejects.toThrow(/worker|capabil|unsupported|incompatible/i);
            const snapshot = await h.catalog.features.snapshot(["sessions.steering"]);
            assertEqual(snapshot.settings.find((row) => row.scope === "cluster").enabled, false);
        });
    });
});
