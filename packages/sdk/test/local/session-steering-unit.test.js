import { describe, expect, it } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import { makeSteeringTurnHarness } from "../helpers/steering-turn-harness.mjs";
import { within } from "../helpers/steering-cli.mjs";

describe.concurrent("session steering product admission and settlement", () => {
    for (const block of ["claim", "submitting"]) {
        for (const close of ["idle", "Stop", "abort", "forceSettleTurn"]) {
            it(`ST-U04/ST-C03: ${close} while ${block} awaits prevents SDK invocation`, async () => {
                const h = makeSteeringTurnHarness({ block });
                const turn = h.run();
                await within(h.cut.entered, `${block} product barrier`);
                if (close === "idle") h.answer();
                else if (close === "forceSettleTurn") h.managed.forceSettleTurn("fixture force settle");
                else {
                    if (close === "Stop") h.managed.requestStop("fixture Stop");
                    h.managed.abort();
                }
                h.cut.release(block === "claim" ? [h.row] : { attemptId: "attempt-a" });
                const result = await turn;
                assertEqual(h.copilot.send.mock.calls.filter(([input]) => input.mode === "immediate").length, 0, "no post-close handoff");
                if (close === "Stop" || close === "forceSettleTurn") assertEqual(result.type, "stopped");
                if (block === "submitting") expect(h.channel.markReleased).toHaveBeenCalledWith("attempt-a");
                assertEqual(h.channel.markDelivered.mock.calls.length, 0);
            });
        }
    }

    it("ST-U04/ST-C03: late startup after normal idle cannot arm a sender", async () => {
        const h = makeSteeringTurnHarness({ block: "open" });
        const turn = h.run();
        await within(h.cut.entered, "startup product barrier");
        h.answer();
        h.cut.release({ ok: true, recovered: [] });
        await turn;
        assertEqual(h.channel.claim.mock.calls.length, 0, "closed startup never starts claiming");
        assertEqual(h.channel.renew.mock.calls.length, 0, "closed startup never rearms the lease");
        assertEqual(h.copilot.send.mock.calls.length, 1, "only the original prompt was sent");
    });

    it("ST-U05: user.message before send response binds by SDK id exactly once", async () => {
        const h = makeSteeringTurnHarness();
        const turn = h.run();
        await within(h.delivered, "early-event delivery correlation");
        h.emit("user.message", { messageId: "sdk-steer-a", delivery: "steering", content: h.row.text });
        h.answer();
        const result = await turn;
        assertEqual(h.channel.markDelivered.mock.calls.length, 1, "duplicate event is not another delivery");
        expect(h.channel.markDelivered.mock.calls[0]).toEqual(["attempt-a", "sdk-steer-a", "steering"]);
        expect(result.steering.delivered).toEqual([{
            requestId: h.row.requestId, attemptId: "attempt-a", sdkMessageId: "sdk-steer-a", kind: "steering",
        }]);
        const send = h.copilot.send.mock.calls.find(([input]) => input.mode === "immediate")[0];
        assertEqual(send.displayPrompt, h.row.text);
        assertEqual(send.mode, "immediate");
        assert(h.calls.findIndex(([name]) => name === "submitting") < h.calls.findIndex(([name, mode]) => name === "send" && mode === "immediate"), "write-ahead precedes invocation");
    });

    it("ST-U05: matching text with a foreign SDK id is never delivery evidence", async () => {
        const h = makeSteeringTurnHarness({
            send: async ({ emit }) => {
                emit("user.message", { messageId: "unrelated-sdk-id", delivery: "steering", content: "Keep this guidance separate" });
                return "sdk-steer-a";
            },
        });
        const turn = h.run();
        await within(h.submitted, "SDK acknowledgment");
        // Supply the actual positive evidence before the bounded settlement path.
        assertEqual(h.channel.markDelivered.mock.calls.length, 0, "text equality grants no correlation");
        h.emit("user.message", { messageId: "sdk-steer-a", delivery: "steering", content: h.row.text });
        await within(h.delivered, "matching SDK delivery correlation");
        h.answer();
        await turn;
        assertEqual(h.channel.markDelivered.mock.calls.length, 1);
    });

    it("ST-U06: first idle does not release ownership of an already-issued late send", async () => {
        const h = makeSteeringTurnHarness({
            send: async ({ cut }) => await cut.hold(),
        });
        let settled = false;
        const turn = h.run().then((result) => { settled = true; return result; });
        await within(h.cut.entered, "registered late send");
        h.answer("earlier response");
        h.cut.release("sdk-steer-a");
        await within(h.submitted, "late SDK acknowledgment");
        h.emit("user.message", { messageId: "sdk-steer-a", delivery: "idle", content: h.row.text });
        await within(h.delivered, "late idle delivery correlation");
        assertEqual(settled, false, "late owned run has not reached its idle");
        h.answer("later response");
        const result = await turn;
        assertEqual(result.steering.delivered[0].kind, "idle");
        assertEqual(h.copilot.abort.mock.calls.length, 0, "normal idle continuation does not abort");
    });

    it("ST-U04: abort-before-wake cannot invoke a new immediate send", async () => {
        const h = makeSteeringTurnHarness({ block: "claim" });
        const turn = h.run();
        await within(h.cut.entered, "abort-before-wake claim barrier");
        h.managed.abort();
        h.wake();
        h.cut.release([h.row]);
        await turn;
        assertEqual(h.copilot.send.mock.calls.filter(([input]) => input.mode === "immediate").length, 0);
        expect(h.calls.filter(([name]) => name === "abort")).toHaveLength(1);
    });
});
