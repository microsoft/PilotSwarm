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
function fakeRuntime({ deleteFails, deleteFailuresBeforeSuccess = null, cmsStateFails = false }) {
    const traced = [];
    const values = new Map();
    /** What happened, in order: the command response write and the delete attempt. */
    const order = [];
    /** Every custom status published, and every CMS row state written. */
    const customStatuses = [];
    const cmsStates = [];
    let deleteAttempts = 0;
    return {
        traced, values, order, customStatuses, cmsStates,
        get deleteAttempts() { return deleteAttempts; },
        /**
         * Every command response the generator wrote. writeCommandResponse stores the payload - including its
         * result.ok - in a CONTEXT VALUE, not in the session event (the event carries only the command's id and
         * kind), so this reads the values the fake context collected.
         */
        get commandResponses() {
            // Every response, not only ones carrying `result`. A FAILED delete answers with `error` and no
            // `result`, and filtering on `result` made that answer invisible here - the harness would have
            // reported "no response written" for the very case this file exists to check.
            return [...values.values()]
                .map(raw => { try { return JSON.parse(raw); } catch { return null; } })
                .filter(value => value && typeof value === "object" && (value.result || value.error) && value.cmd);
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
            setCustomStatus: raw => {
                order.push("status-published");
                try { customStatuses.push(JSON.parse(raw)); } catch { customStatuses.push(raw); }
            },
            utcNow: () => Date.now(),
            getValue: key => values.get(key) ?? null,
            setValue: (key, value) => {
                values.set(key, value);
                try {
                    const parsed = JSON.parse(value);
                    if (parsed?.cmd && (parsed.result || parsed.error)) order.push("response-written");
                } catch { /* counters and other values are not responses */ }
            },
        },
        manager: {
            updateCmsState: async (sessionId, state, lastError) => {
                order.push("cms-state-written");
                cmsStates.push({ sessionId, state, lastError });
                if (cmsStateFails) throw new Error("cms row write failed");
            },
            listChildSessions: async () => "[]",
            getDescendantSessionIds: async () => [],
            sendCommandToSession: async () => {},
            publishStatus: async () => {},
            recordSessionEvent: async () => {},
            recordSessionEvents: async () => {},
            deleteSession: async () => {
                order.push("delete-attempted");
                deleteAttempts += 1;
                // The ACTIVITY retries internally; this fake stands in for the activity as a whole, so
                // deleteFailuresBeforeSuccess models retries that eventually succeed, and deleteFails models
                // exhaustion (or a non-transient failure), which is what reaches the generator's catch.
                if (deleteFailuresBeforeSuccess !== null) {
                    if (deleteAttempts <= deleteFailuresBeforeSuccess) throw DEADLOCK();
                    return;
                }
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

    // The SECOND half of FB-034, now DONE. This test used to assert the opposite and said so: "when the version
    // lands, invert it." 1.0.85 is that version, and it is unshipped, so the yield order may change. Inverted.
    it("answers the caller only after the attempt, and says the delete failed", { timeout: 30_000 }, async () => {
        const failing = fakeRuntime({ deleteFails: true });
        await drive(cancelSession(failing, "tidy up", "cmd-early", true));

        // ORDER, not just the final value. A final error alone would also be satisfied by a response written
        // before the attempt and corrected afterwards, which is a different shape with different observers.
        expect(failing.order.indexOf("delete-attempted"),
            "the delete is attempted before anything is said about it").toBeLessThan(
            failing.order.indexOf("response-written"));
        expect(failing.commandResponses.map(r => r.result?.ok),
            "and no success is ever written").not.toContain(true);
    });

    it("records the failure where readers actually look: custom status AND the CMS row", { timeout: 30_000 }, async () => {
        const failing = fakeRuntime({ deleteFails: true });
        await drive(cancelSession(failing, "tidy up", "cmd-state", true));

        // Review F1: the result string is the orchestration's OUTPUT, and an orchestration returning "failed" has
        // still COMPLETED, so no reader derives a failure from it. These two writes are what readers see.
        expect(failing.customStatuses.map(s => s.status), "the live status says failed").toContain("failed");
        expect(failing.cmsStates.map(s => s.state), "and so does the row a later read derives from").toContain("failed");
        const published = failing.customStatuses.find(s => s.status === "failed");
        expect(published.error, "with the reason attached").toContain("deadlock detected");
    });

    it("a delete that succeeds says so, once, and publishes no failure", { timeout: 30_000 }, async () => {
        const ok = fakeRuntime({ deleteFails: false });
        await drive(cancelSession(ok, "tidy up", "cmd-ok2", true));
        expect(ok.commandResponses.map(r => r.result?.ok), "success is still reported").toEqual([true]);
        expect(ok.customStatuses.map(s => s.status), "and nothing claims it failed").not.toContain("failed");
        expect(ok.cmsStates.map(s => s.state), "nor does the row").not.toContain("failed");
    });

    it("a delete that the activity's retries rescued is reported as success", { timeout: 30_000 }, async () => {
        // At THIS level a retried-then-succeeded delete is simply a delete that worked: the generator calls the
        // activity once, and the retrying happens inside it (session-proxy's deleteSession, via cmsRetryCritical).
        // My first version of this test had the fake throw twice and then succeed, which the generator never sees -
        // it models the activity as a whole. The retry schedule itself is covered in delete-activity-retry.test.js.
        const recovered = fakeRuntime({ deleteFails: false });
        await drive(cancelSession(recovered, "tidy up", "cmd-retry", true));
        expect(recovered.deleteAttempts, "the generator attempts the delete exactly once").toBe(1);
        expect(recovered.state.orchestrationResult, "it ends as deleted").toBe("deleted");
        expect(recovered.commandResponses.map(r => r.result?.ok), "and the caller is told it worked").toEqual([true]);
        expect(recovered.customStatuses.map(s => s.status), "with no failure published").not.toContain("failed");
    });

    it("a failed CMS row write still leaves the caller answered", { timeout: 30_000 }, async () => {
        // The row write is the SECOND of two records. If it throws, the caller must still learn the delete failed -
        // losing the answer is the defect FB-034 is about, and a best-effort record must not cause it.
        const failing = fakeRuntime({ deleteFails: true, cmsStateFails: true });
        await drive(cancelSession(failing, "tidy up", "cmd-cms-bad", true));
        expect(failing.commandResponses.map(r => r.result?.ok), "no success is claimed").not.toContain(true);
        expect(failing.state.orchestrationResult, "and the orchestration still ends failed").toBe("failed");
        expect(failing.traced.some(l => l.includes("failed to record failed state")),
            "the row failure is traced rather than swallowed silently").toBe(true);
    });

    it("a plain cancel is unchanged: answered immediately, and not a delete", { timeout: 30_000 }, async () => {
        // The response move is scoped to the DELETE path. A cancel is finished when it is written, so it keeps
        // answering where it did, and must not acquire delete's failure records.
        const cancelled = fakeRuntime({ deleteFails: true });
        await drive(cancelSession(cancelled, "tidy up", "cmd-cancel", false));
        expect(cancelled.commandResponses.map(r => r.result?.message), "it still says cancelled").toEqual(["Session cancelled"]);
        expect(cancelled.order, "and never attempts a delete").not.toContain("delete-attempted");
        expect(cancelled.state.orchestrationResult).toBe("cancelled");
    });
});
