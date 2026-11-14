/**
 * FB-058: a failed status read must never be reported as a successful deletion.
 *
 * HALF of this is already fixed at this base. Valkyrie's delete cascade (6a229b64) added a failOnReadError
 * parameter to the settle wait and the delete path passes `true` POSITIONALLY - which is why grepping for the
 * NAME finds only its declaration. So a failed READ no longer reads as absence: SessionDeleteBudget propagates
 * it with its own code. What remains, and what these tests pin, is the OTHER half.
 *
 * `PilotSwarmManagementClient.deleteSession` sends the lifecycle command and then waits for the session row to
 * disappear. Two defects made that wait lie:
 *
 *   1. `_waitForSession` did `getSession(...).catch(() => null)`, and delete's predicate is `current == null`.
 *      So a transient database error satisfied "the session is gone" on the FIRST poll, and the caller was told
 *      the delete had succeeded while the row was still there. The TUI then removed the session and displayed
 *      `Deleted` (node-sdk-transport.js deleteSession → the controller), as do the API and web adapters.
 *   2. The command id was built inline and discarded, so the truthful reply FB-034 now writes — an error when
 *      the delete failed — reached nobody.
 *
 * Defect 1 is Valkyrie's to claim. Defect 2 is this change: the command id is kept, and a truthful negative
 * reply is preferred over the settle error, because it names the real cause rather than a generic timeout.
 *
 * These tests drive the real `PilotSwarmManagementClient.deleteSession` and `_waitForSession` with stand-in
 * stores, which is where the defect lives — this is client and API behaviour, with no orchestration involved.
 *
 * Run: node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run test/local/delete-read-error-honesty.test.js
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { PilotSwarmManagementClient } from "../../src/management-client.ts";

const SESSION = "11111111-2222-3333-4444-555555555555";

/**
 * Fake timers, so a case that reaches the settle loop costs milliseconds rather than the production 65s
 * constant. The PRODUCTION timeout is untouched - the test controls the clock, the client does not take an
 * injectable deadline. (An earlier version of this comment said two cases "legitimately wait it out" for 65
 * real seconds. At this base every scripted failure rejects immediately, so none of them do; that was true of
 * a superseded branch. Review F4.)
 */
async function withFastClock(run) {
    vi.useFakeTimers();
    try {
        const settled = run().then(v => ({ ok: true, v }), e => ({ ok: false, e }));
        await vi.runAllTimersAsync();
        return await settled;
    } finally {
        vi.useRealTimers();
    }
}

afterEach(() => { vi.useRealTimers(); });

/** A visible, deletable, non-system session as getSession would return it. */
const liveView = () => ({
    sessionId: SESSION,
    isSystem: false,
    status: "running",
    orchestrationStatus: "Running",
    sessionKind: "agent",
});

/**
 * A management client whose reads and replies are scripted. Everything else is stubbed to the minimum
 * `deleteSession` touches, so the test exercises the real method rather than a copy of it.
 *
 * `reads` is consumed one entry per getSession call: a view, null for genuinely absent, or an Error to throw.
 */
function mgmtWith({ reads, reply = null, onCommand = () => {} }) {
    const queue = [...reads];
    const sent = [];
    const lookups = [];
    const mgmt = Object.create(PilotSwarmManagementClient.prototype);
    Object.assign(mgmt, {
        _ensureStarted() {},
        async getSession() {
            const next = queue.length > 1 ? queue.shift() : queue[0];
            if (next instanceof Error) throw next;
            return next;
        },
        async _sendLifecycleCommand(sessionId, command) {
            sent.push(command);
            onCommand(command);
        },
        // Keyed, not static (review R2): the stub used to ignore its arguments and return the same reply for
        // any id, so a lookup with the WRONG command id - or no lookup at all - passed just as well. It now
        // answers only for the id that was actually sent, and records what it was asked for.
        async getCommandResponse(askedSession, askedId) {
            lookups.push({ askedSession, askedId });
            const sentId = sent[0]?.id;
            if (askedSession !== SESSION || !sentId || askedId !== sentId) return null;
            return reply;
        },
        _workflowStoreOrNull: () => null,
        _factStore: null,
        _duroxideClient: null,
        _catalog: null,
    });
    return { mgmt, sent, lookups };
}

describe("FB-058: a delete is only 'done' when the session is actually gone", () => {
    it("a failed delete plus an unreadable database is NEVER reported as deleted", async () => {
        // THE DEFECT. Before the fix the first read threw, .catch turned it into null, the predicate accepted
        // null, and deleteSession resolved — telling the caller the session was gone while it was still there.
        const { mgmt } = mgmtWith({
            reads: [liveView(), new Error("terminating connection due to administrator command")],
            reply: { id: "x", cmd: "delete", error: "Failed to delete session: deadlock detected" },
        });

        const outcome = await withFastClock(() => mgmt.deleteSession(SESSION, "FB-058 test"));
        expect(outcome.ok, "deleteSession must NOT resolve when the database could not be read").toBe(false);
    });

    it("and the error it reports is the delete's real cause, not a settle timeout", async () => {
        const { mgmt } = mgmtWith({
            reads: [liveView(), new Error("connection terminated unexpectedly")],
            reply: { id: "x", cmd: "delete", error: "Failed to delete session: deadlock detected" },
        });

        const outcome = await withFastClock(() => mgmt.deleteSession(SESSION, "FB-058 test"));
        expect(outcome.ok).toBe(false);
        expect(String(outcome.e?.message)).toMatch(/deadlock detected/);
    });

    it("an unreadable database with no reply available still fails", async () => {
        // No reply to consult: the caller must still not be told the session was deleted. The WORDING of the
        // failure is Valkyrie's to own at this base - SessionDeleteBudget raises its own coded errors - so this
        // asserts only that the call does not resolve. Asserting her message text here would make this test
        // fail the next time she changes it, for no gain: what FB-058 cares about is that it does not succeed.
        const { mgmt } = mgmtWith({
            reads: [liveView(), new Error("server closed the connection unexpectedly")],
            reply: null,
        });

        const outcome = await withFastClock(() => mgmt.deleteSession(SESSION, "FB-058 test"));
        expect(outcome.ok, "a read failure is never reported as a successful deletion").toBe(false);
    });

    it("a REAL success still resolves: the row is genuinely gone", async () => {
        // The control that matters as much as the defect. The obvious over-fix - treat any read problem as
        // failure - would break every ordinary delete, so this pins that a clean absence still succeeds.
        const { mgmt, sent } = mgmtWith({
            reads: [liveView(), null],
            reply: { id: "x", cmd: "delete", result: { ok: true, message: "Session deleted" } },
        });

        await expect(mgmt.deleteSession(SESSION, "FB-058 test")).resolves.toBeUndefined();
        expect(sent[0]?.cmd, "the lifecycle delete command was sent").toBe("delete");
    });

    it("a success with no readable reply still resolves", async () => {
        // The reply is best effort for this caller: the row being gone is the outcome. A delete must not start
        // failing merely because the response channel could not be read afterwards.
        const { mgmt } = mgmtWith({ reads: [liveView(), null], reply: null });
        await expect(mgmt.deleteSession(SESSION, "FB-058 test")).resolves.toBeUndefined();
    });

    it("the row went, but the reply says the delete failed: the caller is told", async () => {
        // A row that disappeared for some other reason while the delete itself failed. The reply is
        // authoritative over the absence.
        const { mgmt } = mgmtWith({
            reads: [liveView(), null],
            reply: { id: "x", cmd: "delete", error: "Failed to delete session: permission denied" },
        });

        await expect(mgmt.deleteSession(SESSION, "FB-058 test"))
            .rejects.toThrow(/permission denied/);
    });

    it("the reply is looked up under the id that was actually SENT", async () => {
        // Review R2. The previous version of this case only checked that a delete-prefixed id was generated -
        // which the UNFIXED code also does, since it built one inline before discarding it. So it passed at
        // base and proved nothing. What the fix is actually about is that the id is KEPT and used, so this
        // asserts the correlation: the lookup happened, for this session, with exactly the id that was sent.
        const { mgmt, sent, lookups } = mgmtWith({
            reads: [liveView(), null],
            reply: { id: "ignored-by-the-keyed-stub", cmd: "delete", result: { ok: true } },
        });

        await mgmt.deleteSession(SESSION, "FB-058 test");

        expect(lookups.length, "a reply lookup happened at all").toBeGreaterThan(0);
        expect(lookups[0].askedSession, "for this session").toBe(SESSION);
        expect(lookups[0].askedId, "with the id that was sent, not a fresh one").toBe(sent[0].id);
    });

});
