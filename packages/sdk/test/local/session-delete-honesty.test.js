/**
 * FB-034: a session delete that fails must not be reported as done.
 *
 * cancelSession(..., deleteAfterCancel = true) is dishonest about failure in two places, and the second is worse
 * than the first:
 *
 *   1. it writes the command response ok:true "Session deleted" BEFORE it attempts the deletion at all
 *      (orchestration/agents.ts, the response block precedes the delete block);
 *   2. it then catches any error from deleteSession, traces it, and sets orchestrationResult = "deleted"
 *      unconditionally.
 *
 * So a delete that loses a database deadlock - or fails for any other reason - tells the caller it succeeded, twice,
 * while the session row is still there. Nothing retries it and nothing notices afterwards: the Sweeper only removes
 * sessions whose orchestration is already terminal and never re-issues an end. The ordinary complete and cancel
 * paths go through cmsRetryCritical, which already lists 40P01 as transient, so a deadlock there is retried and
 * invisible. Delete has neither the retry nor the honesty, and it is the one path where the caller is told the
 * session is gone.
 *
 * ON THE DRIVER, because the first version of this test was wrong in a way worth recording. It awaited each yielded
 * promise but never forwarded a rejection into the generator. The fake deleteSession rejected, so the DRIVER
 * rejected while cancelSession was still suspended at its yield: the production catch, its trace and its
 * unconditional "deleted" were never reached, and an expected-failure marker accepted that unrelated driver
 * rejection as the expected failure. The test passed for the wrong reason and would have stayed green even if the
 * defect were fixed. drive() now forwards rejections with generator.throw, and the control case below exists
 * precisely to prove the injected failure reaches the generator's own catch.
 *
 * Run: npx vitest run test/local/session-delete-honesty.test.js
 */
import { describe, it, expect } from "vitest";
import { cancelSession } from "../../src/orchestration/agents.ts";

const DEADLOCK = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });

/** The smallest runtime the delete branch touches. `deleteFails` makes deleteSession reject as a victim would. */
function fakeRuntime({ deleteFails }) {
    const traced = [];
    const values = new Map();
    /** What happened, in order: the command response write and the delete attempt. */
    const order = [];
    return {
        traced, values, order,
        /**
         * Every command response the generator wrote. writeCommandResponse stores the payload - including its
         * result.ok - in a CONTEXT VALUE, not in the session event (the event carries only the command's id and
         * kind), so this reads the values the fake context collected.
         */
        get commandResponses() {
            return [...values.values()]
                .map(raw => { try { return JSON.parse(raw); } catch { return null; } })
                .filter(value => value && typeof value === "object" && value.result);
        },
        input: { sessionId: "session-under-test" },
        options: {},
        state: {
            pendingShutdown: null, waitingForAgentIds: null, activeTimer: null, carriedSteers: [],
            subAgents: [], orchestrationResult: null, iteration: 1,
        },
        session: { destroy: async () => {} },
        ctx: {
            traceInfo: message => traced.push(String(message)),
            utcNow: () => Date.now(),
            getValue: key => values.get(key) ?? null,
            setValue: (key, value) => {
                values.set(key, value);
                try {
                    if (JSON.parse(value)?.result) order.push("response-written");
                } catch { /* counters and other values are not responses */ }
            },
        },
        manager: {
            updateCmsState: async () => {},
            listChildSessions: async () => "[]",
            getDescendantSessionIds: async () => [],
            sendCommandToSession: async () => {},
            publishStatus: async () => {},
            recordSessionEvent: async () => {},
            recordSessionEvents: async () => {},
            deleteSession: async () => {
                order.push("delete-attempted");
                if (deleteFails) throw DEADLOCK();
            },
        },
    };
}

/**
 * Drive a generator to completion. A rejected yield is forwarded INTO the generator with .throw, which is what makes
 * the generator's own try/catch run; awaiting without forwarding would abandon the generator mid-yield and test
 * nothing. The same shape the existing orchestration generator tests use.
 */
async function drive(generator) {
    let next = generator.next();
    while (!next.done) {
        let settled;
        try {
            settled = await next.value;
        } catch (error) {
            next = generator.throw(error);
            continue;
        }
        next = generator.next(settled);
    }
}

describe("FB-034: a session delete that fails is reported as done", () => {
    it("control: a delete that succeeds reports deleted and says so once", { timeout: 30_000 }, async () => {
        const ok = fakeRuntime({ deleteFails: false });
        await drive(cancelSession(ok, "tidy up", "cmd-ok", true));
        expect(ok.state.orchestrationResult, "a delete that worked reports deleted").toBe("deleted");
        expect(ok.commandResponses.map(r => r.result?.ok), "and tells the caller it succeeded").toEqual([true]);
    });

    it("control: the injected failure really reaches the generator's own catch", { timeout: 30_000 }, async () => {
        // This is the control the first version of this test lacked. Without it, a driver that abandoned the
        // generator would look identical to a defect, and the expected-failure case below would be meaningless.
        const failing = fakeRuntime({ deleteFails: true });
        await drive(cancelSession(failing, "tidy up", "cmd-caught", true));
        expect(failing.traced.some(line => line.includes("failed to delete")),
            "the generator caught the failure and traced it, so its error path ran").toBe(true);
    });

    it("does not record a failed delete as deleted", { timeout: 30_000 }, async () => {
        const failing = fakeRuntime({ deleteFails: true });
        await drive(cancelSession(failing, "tidy up", "cmd-bad", true));

        // THE FIX. A delete that failed is no longer recorded as done.
        expect(failing.state.orchestrationResult, "a failed delete is not reported as deleted").not.toBe("deleted");
        // Non-null on purpose: the run loop ends on a non-null result, so an unset value would not make the
        // orchestration honest, it would make it keep running.
        expect(failing.state.orchestrationResult, "and the orchestration still ends").toBe("failed");
    });

    // The SECOND half of FB-034, still unfixed and deliberately so: the command response ok:true "Session deleted"
    // is written BEFORE the delete is attempted, so the caller is told it succeeded whatever happens afterwards.
    // Making that honest means moving the response after the attempt, which moves two yields and two recorded
    // context writes - a replay-order change that needs a new session orchestration version, coordinated with the
    // lead's version plan. This records the remaining defect rather than leaving it undescribed; when the version
    // lands, invert it.
    it("still tells the caller it succeeded before trying (FB-034, second half, needs a version bump)",
        { timeout: 30_000 }, async () => {
            const failing = fakeRuntime({ deleteFails: true });
            await drive(cancelSession(failing, "tidy up", "cmd-early", true));

            // ORDER, not just the final value. A final ok:true alone would also be satisfied by a dishonest success
            // written AFTER the attempt, which is a different defect with a different fix; this pins that the
            // response is written first, which is what makes it unfixable without moving a yield.
            expect(failing.order[0], "the response is written before the delete is attempted").toBe("response-written");
            expect(failing.order, "and the delete is attempted after it").toContain("delete-attempted");
            expect(failing.commandResponses.map(r => r.result?.ok),
                "and what it says is that the delete succeeded").toEqual([true]);
        });
});
