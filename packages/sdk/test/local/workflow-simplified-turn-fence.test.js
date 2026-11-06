/**
 * The turn-to-visit fence of a chat that continues (review RT-2 and RT-3; design wfs-rt1-3-fence-design.md, accepted with
 * the parent's decisions; formal t1 requirements (a) to (c)). The runTurn activity (runTurnV5, a workflow worker's turn)
 * runs with a fake session manager, model session, catalog and workflow store (no database):
 * - the turn visit is read right after turn start; a turn whose visit is decided does not run, whether its prompt names
 *   that visit (a late prompt) or it inherits it (a timer or a sub-agent's update between visits);
 * - a Stop naming another visit of the chat is not applied to the turn, at turn start or live, in both directions (an
 *   older visit's Stop on a newer visit's turn, a newer visit's Stop on an older visit's late turn); a Stop naming the
 *   turn's own visit, and a person's Stop, are applied;
 * - the reminder and the completion are given the turn's own visit.
 * The store's half (readTurnVisit, the reminder and the completion bound to it) is in workflow-simplified-chat-continue.
 */
import { describe, expect, it, vi } from "vitest";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";

const CHAT = "chat-continued";
const NX1 = "nx-1111111111111111111111111111111111111111";
const NX2 = "nx-2222222222222222222222222222222222222222";
const promptId = nx => `workflow:wf-1:run-1:agent:${nx}`;
const control = (seq, kind, text = `${kind}-${seq}`) => ({ seq, kind, text, createdAt: new Date().toISOString() });

/**
 * A workflow store whose chat continues; `visit` is the turn visit readTurnVisit answers; `requestIds` the Stops' ids;
 * `failIds` makes readControlRequestIds fail; `dropped` records the Stops given their outcome as not this turn's (D3).
 */
function fenceStore({ visit, requestIds = new Map(), failIds = false }) {
    const reads = [];
    const dropped = [];
    return {
        reads,
        dropped,
        store: {
            readWorkflowLineage: async sessionId => ({ sessionId, level: 2,
                agentRoot: { childSessionId: CHAT, nodeExecutionId: NX2, workflowSessionId: "wf-1", controllingSessionId: "parent", distance: 0 } }),
            readNodeExecution: async () => ({ nodeType: "agent", runId: "run-1", nodeId: "talk", nodeExecutionId: NX2 }),
            readRun: async () => ({ runId: "run-1", mode: "live", workflowSessionId: "wf-1" }),
            readTurnVisit: async (sessionId, ids) => { reads.push(["readTurnVisit", sessionId, ids]); return visit; },
            readControlRequestIds: async (sessionId, seqs) => {
                reads.push(["readControlRequestIds", sessionId, seqs]);
                if (failIds) throw new Error("the stops' ids could not be read");
                return new Map(seqs.map(seq => [seq, requestIds.get(seq) ?? null]));
            },
            recordStopNotForTurn: async (sessionId, seq, turn) => { dropped.push([sessionId, seq, turn]); return { recorded: true }; },
        },
    };
}

function harness({ visit, start = { stopped: false, controls: [] }, requestIds, turn, failIds = false, writeback = false } = {}) {
    const fence = fenceStore({ visit, requestIds, failIds });
    const calls = [];
    const aborts = [];
    const h = makeRunTurnHarness({
        testOptions: { workflowIntakeTurns: true, workflowRequests: true },
        catalogExtras: {
            workflowStore: () => fence.store,
            turnStart: vi.fn(async (...args) => { calls.push(["turnStart", ...args]); return start; }),
            completeTurnWriteback: vi.fn(async () => writeback),
            turnEnd: vi.fn(async (...args) => { calls.push(["turnEnd", ...args]); return { stopped: false, late: [] }; }),
        },
        managerExtras: {
            abortWarmSessionTurn: vi.fn(async (sessionId, options) => { aborts.push([sessionId, options.reason]); return { outcome: "aborted" }; }),
        },
        turn,
    });
    return { h, fence, calls, aborts };
}

/** A model session with an open send gate: the turn takes `controls` live, then ends; `failed` records a failed turn. */
const liveTurn = (controls, failed = []) => async opts => {
    let gate = "pending";
    opts.turnControl.attach({ gate: () => gate, close: () => { gate = "closed"; }, sendSteer: async () => {}, failTurn: error => { failed.push(error); } });
    gate = "open";
    opts.turnControl.gateOpened();
    await opts.turnControl.enqueue(controls);
    await new Promise(resolve => setTimeout(resolve, 20));
    opts.turnControl.detach();
    return { type: "completed", content: "ok" };
};

describe("the turn-to-visit fence of a chat that continues", () => {
    it("a late prompt whose visit is decided does not run: no model call, one line naming the visit", async () => {
        const { h, fence } = harness({ visit: { nodeExecutionId: NX1, open: false, inherited: false } });
        const result = await h.runTurn(CHAT, { turnIndex: 4, clientMessageIds: [promptId(NX1)] }, "runTurnV5");
        expect(result).toMatchObject({ type: "stopped", reason: `The workflow already ended cycle ${NX1}; this turn was not run.` });
        expect(h.session.runTurn).not.toHaveBeenCalled();
        expect(fence.reads[0]).toEqual(["readTurnVisit", CHAT, [promptId(NX1)]]);
        expect(h.traces.info.filter(line => line.includes(`not run: its workflow visit ${NX1} is decided`))).toHaveLength(1);
    });

    it("an inherited turn (a timer, a sub-agent's update) whose visit is decided does not run either", async () => {
        const { h } = harness({ visit: { nodeExecutionId: NX1, open: false, inherited: true } });
        const result = await h.runTurn(CHAT, { turnIndex: 5, prompt: "[SYSTEM: a timer fired]" }, "runTurnV5");
        expect(result.type).toBe("stopped");
        expect(h.session.runTurn).not.toHaveBeenCalled();
    });

    it("an open visit's turn runs; a Stop recorded for another visit before it started is not applied, its own visit's is", async () => {
        // Wrong-turn case at turn start: visit 1's late :sent Stop was recorded while visit 2's turn starts.
        const other = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false },
            start: { stopped: false, controls: [control(41, "stop", "The workflow ended this cycle of step talk (timed_out).")] },
            requestIds: new Map([[41, `workflow-cycle-stop:${NX1}:sent`]]) });
        const ran = await other.h.runTurn(CHAT, { turnIndex: 6, clientMessageIds: [promptId(NX2)] }, "runTurnV5");
        expect(ran.type).toBe("completed");
        expect(other.h.session.runTurn).toHaveBeenCalledTimes(1);
        // D3: the Stop that is not this turn's gets its outcome now, so a later failure of the turn is not ended as stopped.
        expect(other.fence.dropped).toEqual([[CHAT, 41, 6]]);
        // The turn's own visit's Stop ends it at turn start (a turn that starts after its Stop: t1's third path).
        const own = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false },
            start: { stopped: false, controls: [control(42, "stop", "cycle ended")] }, requestIds: new Map([[42, `workflow-cycle-stop:${NX2}`]]) });
        expect(await own.h.runTurn(CHAT, { turnIndex: 6, clientMessageIds: [promptId(NX2)] }, "runTurnV5")).toMatchObject({ type: "stopped", reason: "cycle ended" });
        expect(own.h.session.runTurn).not.toHaveBeenCalled();
    });

    it("live: an older visit's Stop does not abort a newer visit's turn, and a newer visit's Stop does not abort an older visit's late turn", async () => {
        const ids = new Map([[51, `workflow-cycle-stop:${NX1}`], [52, `workflow-cycle-stop:${NX2}:sent`]]);
        // Visit 2's turn: visit 1's Stop lands on it (the wrong-turn case).
        const newer = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false }, requestIds: ids, turn: liveTurn([control(51, "stop")]) });
        expect((await newer.h.runTurn(CHAT, { turnIndex: 7, clientMessageIds: [promptId(NX2)] }, "runTurnV5")).type).toBe("completed");
        expect(newer.aborts).toEqual([]);
        expect(newer.fence.dropped).toEqual([[CHAT, 51, 7]]);
        // Visit 1's late turn (its visit open when it started): visit 2's Stop lands on it (the other direction).
        const older = harness({ visit: { nodeExecutionId: NX1, open: true, inherited: false }, requestIds: ids, turn: liveTurn([control(52, "stop")]) });
        expect((await older.h.runTurn(CHAT, { turnIndex: 8, clientMessageIds: [promptId(NX1)] }, "runTurnV5")).type).toBe("completed");
        expect(older.aborts).toEqual([]);
        // Its own visit's Stop aborts it (the skipped-stop case: a late old turn is still stopped).
        const own = harness({ visit: { nodeExecutionId: NX1, open: true, inherited: false }, requestIds: ids, turn: liveTurn([control(51, "stop", "cycle 1 ended")]) });
        await own.h.runTurn(CHAT, { turnIndex: 8, clientMessageIds: [promptId(NX1)] }, "runTurnV5");
        expect(own.aborts).toEqual([[CHAT, "cycle 1 ended"]]);
    });

    it("D2: a Stop whose visit cannot be read fails the turn (it is retried); it is never applied as every Stop", async () => {
        // At turn start: the activity fails, so the turn is retried; no model run, no Stop applied.
        const atStart = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false }, failIds: true,
            start: { stopped: false, controls: [control(81, "stop", "cycle ended")] } });
        await expect(atStart.h.runTurn(CHAT, { turnIndex: 10, clientMessageIds: [promptId(NX2)] }, "runTurnV5"))
            .rejects.toThrow("the stops' ids could not be read");
        expect(atStart.h.session.runTurn).not.toHaveBeenCalled();
        // Live: the turn is failed (not aborted as a Stop).
        const failed = [];
        const live = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false }, failIds: true,
            turn: liveTurn([control(82, "stop", "cycle ended")], failed) });
        await live.h.runTurn(CHAT, { turnIndex: 11, clientMessageIds: [promptId(NX2)] }, "runTurnV5");
        expect(live.aborts).toEqual([]);
        expect(failed.map(error => error.message)).toEqual(["the stops' ids could not be read"]);
        expect(live.fence.dropped).toEqual([]);
    });

    it("a person's Stop still applies to a continued chat's turn", async () => {
        const person = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false }, requestIds: new Map([[61, "portal-stop-123"]]),
            turn: liveTurn([control(61, "stop", "Stopped by user")]) });
        await person.h.runTurn(CHAT, { turnIndex: 9, clientMessageIds: [promptId(NX2)] }, "runTurnV5");
        expect(person.aborts).toEqual([[CHAT, "Stopped by user"]]);
        const atStart = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false },
            start: { stopped: false, controls: [control(62, "stop", "Stopped by user")] }, requestIds: new Map([[62, null]]) });
        expect((await atStart.h.runTurn(CHAT, { turnIndex: 9, clientMessageIds: [promptId(NX2)] }, "runTurnV5")).type).toBe("stopped");
    });

    it("a session that does not continue a chat (readTurnVisit: null) runs and takes every Stop as before", async () => {
        const plain = harness({ visit: null, requestIds: new Map([[71, `workflow-cycle-stop:${NX1}`]]), turn: liveTurn([control(71, "stop", "stop")]) });
        await plain.h.runTurn("chat-new", { turnIndex: 1, clientMessageIds: [promptId(NX1)] }, "runTurnV5");
        expect(plain.h.session.runTurn).toHaveBeenCalledTimes(1);
        expect(plain.aborts).toEqual([["chat-new", "stop"]]);
        expect(plain.fence.reads.filter(([name]) => name === "readControlRequestIds")).toEqual([]);
    });

    // Review RT-D2 (C1): turn end gets the visit fence, exactly the turn visit live admission used (inherited included;
    // a null visit when the chat names none), and only for a continued chat's turn.
    describe("RT-D2 (C1): turn end carries the turn's visit fence", () => {
        const endArgs = calls => calls.filter(([name]) => name === "turnEnd").map(call => call.slice(1));
        it("a direct visit's turn and an inherited one end with their own visit; a chat that does not continue ends without a fence", async () => {
            const direct = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false }, writeback: true });
            await direct.h.runTurn(CHAT, { turnIndex: 12, clientMessageIds: [promptId(NX2)] }, "runTurnV5");
            expect(endArgs(direct.calls)).toEqual([[CHAT, 12, 0, "other", [], { visitFence: { visit: NX2 } }]]);
            const inherited = harness({ visit: { nodeExecutionId: NX1, open: true, inherited: true }, writeback: true });
            await inherited.h.runTurn(CHAT, { turnIndex: 13, prompt: "[SYSTEM: a timer fired]" }, "runTurnV5");
            expect(endArgs(inherited.calls)).toEqual([[CHAT, 13, 0, "other", [], { visitFence: { visit: NX1 } }]]);
            const plain = harness({ visit: null, writeback: true });
            await plain.h.runTurn("chat-new", { turnIndex: 2 }, "runTurnV5");
            expect(endArgs(plain.calls)).toEqual([["chat-new", 2, 0, "other", []]]);
        });

        it("a continued chat that names no visit: a workflow Stop is too_late live, and its end fences with a null visit", async () => {
            const none = harness({ visit: { nodeExecutionId: null, open: false, inherited: true }, writeback: true,
                requestIds: new Map([[91, `workflow-cycle-stop:${NX1}`]]), turn: liveTurn([control(91, "stop", "cycle ended")]) });
            const result = await none.h.runTurn(CHAT, { turnIndex: 14, prompt: "a sub-agent's update" }, "runTurnV5");
            expect(result.type).toBe("completed");
            expect(none.aborts).toEqual([]);
            expect(none.fence.dropped).toEqual([[CHAT, 91, 14]]);
            expect(endArgs(none.calls)).toEqual([[CHAT, 14, 0, "other", [], { visitFence: { visit: null } }]]);
        });
    });
});

