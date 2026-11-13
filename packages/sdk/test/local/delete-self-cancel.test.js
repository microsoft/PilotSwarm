/**
 * FB-034 R4: a session deleting ITSELF must not cancel the orchestration that is waiting on the delete.
 *
 * Keeper's finding, on duroxide core v0.1.32. The delete activity calls PilotSwarmClient.deleteSession, whose
 * _deleteOneSession soft-deletes CMS and then cancels the instance. When the session being deleted IS the caller,
 * that cancel lands on the caller: a CancelInstance work item becomes OrchestrationCancelRequested in the turn that
 * dequeues it (replay_engine.rs 394-417), and finalize_turn (1061-1068) then returns Cancelled - which takes
 * precedence over Completed, over continue-as-new, and over the generator's own return value. No error is thrown
 * in; the generator simply runs until it blocks and the turn ends Cancelled.
 *
 * So the reply written after the delete is never persisted. Not sometimes - ALWAYS, on every successful
 * self-delete. `yield ctx.utcNow()` inside writeCommandResponse is a real activity, and the Cancelled branch builds
 * no worker items, so it is never dispatched and nothing after it runs.
 *
 * The fix is an OPTIONAL `selfDelete` input on the deleteSession activity which suppresses the cancel for the
 * target itself and only for it. The constraints are Keeper's, and these tests pin them:
 *
 *   - ABSENT must mean today's exact behaviour AND today's exact input bytes. Replay compares activity input
 *     byte-exact (action_matches_event_kind 1879-1895), so the key is OMITTED rather than sent as false; sending
 *     `selfDelete: false` on every delete would change the recorded action for every descendant and other-session
 *     delete that exists today.
 *   - Descendants are still cancelled. They are other orchestrations, and nothing inside them is waiting to
 *     answer anyone.
 *   - Frozen 1.0.84 never sends the flag, so its self-delete keeps ending Cancelled, with its reply already
 *     delivered in an earlier turn.
 *
 * Deliberately NOT covered here: the end-to-end behaviour through a real duroxide instance (Completed, reply in
 * KV, row soft-deleted). That needs a live runtime, and the whole point of Keeper's finding is that a mock delete
 * activity cannot show it - a fake that never cancels anything looks identical whether or not the fix is present.
 * That test is the live one and is tracked separately.
 *
 * Run: npx vitest run test/local/delete-self-cancel.test.js
 */
import { describe, it, expect, vi } from "vitest";
import { createSessionManagerProxy } from "../../src/session-proxy.ts";

/** Capture exactly what the orchestration schedules, which is what replay compares. */
function scheduled() {
    const calls = [];
    const scheduleActivity = vi.fn((name, input) => { calls.push({ name, input }); return { name, input }; });
    return { calls, manager: createSessionManagerProxy({ scheduleActivity }) };
}

describe("FB-034 R4: the self-delete flag, and the bytes everyone else still sends", () => {
    it("a descendant delete sends EXACTLY what it sent before: no selfDelete key at all", () => {
        const { calls, manager } = scheduled();
        manager.deleteSession("child-1", "Ancestor parent-1 deleted: tidy up");
        expect(calls[0].name).toBe("deleteSession");
        // Byte-exact, not merely equivalent: an added key with a falsy value is still a different action.
        expect(JSON.stringify(calls[0].input))
            .toBe(JSON.stringify({ sessionId: "child-1", reason: "Ancestor parent-1 deleted: tidy up" }));
        expect(calls[0].input).not.toHaveProperty("selfDelete");
    });

    it("an explicit false is treated as absent, so a caller cannot change the bytes by being explicit", () => {
        const { calls, manager } = scheduled();
        manager.deleteSession("other-1", "by request", false);
        expect(JSON.stringify(calls[0].input))
            .toBe(JSON.stringify({ sessionId: "other-1", reason: "by request" }));
        expect(calls[0].input).not.toHaveProperty("selfDelete");
    });

    it("only a self-delete carries the flag", () => {
        const { calls, manager } = scheduled();
        manager.deleteSession("me-1", "Deleted by user", true);
        expect(calls[0].input).toMatchObject({ sessionId: "me-1", reason: "Deleted by user", selfDelete: true });
    });

    it("the two-argument call frozen 1.0.84 makes is unchanged", () => {
        // orchestration_1_0_84/agents.ts:606 and :613 both call the two-argument form. The frozen tree is byte
        // identical to its base and must stay so; this pins the shape it depends on from the live proxy side.
        const { calls, manager } = scheduled();
        manager.deleteSession("frozen-1", "Deleted by user");
        expect(JSON.stringify(calls[0].input))
            .toBe(JSON.stringify({ sessionId: "frozen-1", reason: "Deleted by user" }));
    });

    it("a reasonless delete is also unchanged", () => {
        const { calls, manager } = scheduled();
        manager.deleteSession("no-reason-1");
        expect(JSON.stringify(calls[0].input)).toBe(JSON.stringify({ sessionId: "no-reason-1" }));
    });
});
