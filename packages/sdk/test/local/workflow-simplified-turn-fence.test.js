/**
 * The turn-to-visit fence of a session that continues (review RT-2 and RT-3; design wfs-rt1-3-fence-design.md, accepted with
 * the parent's decisions; formal t1 requirements (a) to (c)). The runTurn activity (runTurnV5, a workflow worker's turn)
 * runs with a fake session manager, model session, catalog and workflow store (no database):
 * - the turn visit is read right after turn start; a turn whose visit is decided does not run, whether its prompt names
 *   that visit (a late prompt) or it inherits it (a timer or a sub-agent's update between visits);
 * - a Stop naming another visit of the session is not applied to the turn, at turn start or live, in both directions (an
 *   older visit's Stop on a newer visit's turn, a newer visit's Stop on an older visit's late turn); a Stop naming the
 *   turn's own visit, and a person's Stop, are applied;
 * - the reminder and the completion are given the turn's own visit.
 * The store's half (readTurnVisit, the reminder and the completion bound to it) is in workflow-simplified-session-continue.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";
import { makeSessionLayout } from "../helpers/snapshot-conformance.js";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { savedTurnVisitFence } from "../../src/session-lifecycle.ts";

const AGENT_SESSION = "agent-continued";
const NX1 = "nx-1111111111111111111111111111111111111111";
const NX2 = "nx-2222222222222222222222222222222222222222";
const promptId = nx => `workflow:wf-1:run-1:agent:${nx}`;
const control = (seq, kind, text = `${kind}-${seq}`) => ({ seq, kind, text, createdAt: new Date().toISOString() });

/**
 * A workflow store whose session continues; `visit` is the turn visit readTurnVisit answers; `requestIds` the Stops' ids;
 * `failIds` makes readControlRequestIds fail; `dropped` records the Stops given their outcome as not this turn's (D3).
 */
function fenceStore({ visit, requestIds = new Map(), failIds = false }) {
    const reads = [];
    const dropped = [];
    const fence = {
        reads,
        dropped,
        // The turn visit readTurnVisit answers now (a test may change it between attempts).
        visit,
        store: {
            readWorkflowLineage: async sessionId => ({ sessionId, level: 2,
                agentRoot: { childSessionId: AGENT_SESSION, nodeExecutionId: NX2, workflowSessionId: "wf-1", controllingSessionId: "parent", distance: 0 } }),
            readNodeExecution: async () => ({ nodeType: "agent", runId: "run-1", nodeId: "talk", nodeExecutionId: NX2 }),
            readRun: async () => ({ runId: "run-1", mode: "live", workflowSessionId: "wf-1" }),
            // FU-17 (stage 2.1c): an agent state's session reads its tool limit before the turn; this state limits nothing.
            readAgentToolLimit: async () => null,
            readTurnVisit: async (sessionId, ids) => { reads.push(["readTurnVisit", sessionId, ids]); return fence.visit; },
            readControlRequestIds: async (sessionId, seqs) => {
                reads.push(["readControlRequestIds", sessionId, seqs]);
                if (failIds) throw new Error("the stops' ids could not be read");
                return new Map(seqs.map(seq => [seq, requestIds.get(seq) ?? null]));
            },
            recordStopNotForTurn: async (sessionId, seq, turn) => { dropped.push([sessionId, seq, turn]); return { recorded: true }; },
        },
    };
    return fence;
}

function harness({ visit, start = { stopped: false, controls: [] }, requestIds, turn, failIds = false, writeback = false, turnEnd = null,
    lifecycle = null } = {}) {
    const fence = fenceStore({ visit, requestIds, failIds });
    const calls = [];
    const aborts = [];
    const h = makeRunTurnHarness({
        catalogExtras: {
            workflowStore: () => fence.store,
            turnStart: vi.fn(async (...args) => { calls.push(["turnStart", ...args]); return start; }),
            completeTurnWriteback: vi.fn(async () => writeback),
            turnEnd: vi.fn(async (...args) => { calls.push(["turnEnd", ...args]); return turnEnd ? turnEnd(...args) : { stopped: false, late: [] }; }),
        },
        ...(lifecycle ? { sessionStore: lifecycle.store, sessionStateDir: lifecycle.sessionStateDir } : {}),
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

describe("the turn-to-visit fence of a session that continues", () => {
    it("a late prompt whose visit is decided does not run: no model call, one line naming the visit", async () => {
        const { h, fence } = harness({ visit: { nodeExecutionId: NX1, open: false, inherited: false } });
        const result = await h.runTurn(AGENT_SESSION, { turnIndex: 4, clientMessageIds: [promptId(NX1)] }, "runTurnV5");
        expect(result).toMatchObject({ type: "stopped", reason: `The workflow already ended cycle ${NX1}; this turn was not run.` });
        expect(h.session.runTurn).not.toHaveBeenCalled();
        expect(fence.reads[0]).toEqual(["readTurnVisit", AGENT_SESSION, [promptId(NX1)]]);
        expect(h.traces.info.filter(line => line.includes(`not run: its workflow visit ${NX1} is decided`))).toHaveLength(1);
    });

    it("an inherited turn (a timer, a sub-agent's update) whose visit is decided does not run either", async () => {
        const { h } = harness({ visit: { nodeExecutionId: NX1, open: false, inherited: true } });
        const result = await h.runTurn(AGENT_SESSION, { turnIndex: 5, prompt: "[SYSTEM: a timer fired]" }, "runTurnV5");
        expect(result.type).toBe("stopped");
        expect(h.session.runTurn).not.toHaveBeenCalled();
    });

    it("an open visit's turn runs; a Stop recorded for another visit before it started is not applied, its own visit's is", async () => {
        // Wrong-turn case at turn start: visit 1's late :sent Stop was recorded while visit 2's turn starts.
        const other = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false },
            start: { stopped: false, controls: [control(41, "stop", "The workflow ended this cycle of step talk (timed_out).")] },
            requestIds: new Map([[41, `workflow-cycle-stop:${NX1}:sent`]]) });
        const ran = await other.h.runTurn(AGENT_SESSION, { turnIndex: 6, clientMessageIds: [promptId(NX2)] }, "runTurnV5");
        expect(ran.type).toBe("completed");
        expect(other.h.session.runTurn).toHaveBeenCalledTimes(1);
        // D3: the Stop that is not this turn's gets its outcome now, so a later failure of the turn is not ended as stopped.
        expect(other.fence.dropped).toEqual([[AGENT_SESSION, 41, 6]]);
        // The turn's own visit's Stop ends it at turn start (a turn that starts after its Stop: t1's third path).
        const own = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false },
            start: { stopped: false, controls: [control(42, "stop", "cycle ended")] }, requestIds: new Map([[42, `workflow-cycle-stop:${NX2}`]]) });
        expect(await own.h.runTurn(AGENT_SESSION, { turnIndex: 6, clientMessageIds: [promptId(NX2)] }, "runTurnV5")).toMatchObject({ type: "stopped", reason: "cycle ended" });
        expect(own.h.session.runTurn).not.toHaveBeenCalled();
    });

    it("live: an older visit's Stop does not abort a newer visit's turn, and a newer visit's Stop does not abort an older visit's late turn", async () => {
        const ids = new Map([[51, `workflow-cycle-stop:${NX1}`], [52, `workflow-cycle-stop:${NX2}:sent`]]);
        // Visit 2's turn: visit 1's Stop lands on it (the wrong-turn case).
        const newer = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false }, requestIds: ids, turn: liveTurn([control(51, "stop")]) });
        expect((await newer.h.runTurn(AGENT_SESSION, { turnIndex: 7, clientMessageIds: [promptId(NX2)] }, "runTurnV5")).type).toBe("completed");
        expect(newer.aborts).toEqual([]);
        expect(newer.fence.dropped).toEqual([[AGENT_SESSION, 51, 7]]);
        // Visit 1's late turn (its visit open when it started): visit 2's Stop lands on it (the other direction).
        const older = harness({ visit: { nodeExecutionId: NX1, open: true, inherited: false }, requestIds: ids, turn: liveTurn([control(52, "stop")]) });
        expect((await older.h.runTurn(AGENT_SESSION, { turnIndex: 8, clientMessageIds: [promptId(NX1)] }, "runTurnV5")).type).toBe("completed");
        expect(older.aborts).toEqual([]);
        // Its own visit's Stop aborts it (the skipped-stop case: a late old turn is still stopped).
        const own = harness({ visit: { nodeExecutionId: NX1, open: true, inherited: false }, requestIds: ids, turn: liveTurn([control(51, "stop", "cycle 1 ended")]) });
        await own.h.runTurn(AGENT_SESSION, { turnIndex: 8, clientMessageIds: [promptId(NX1)] }, "runTurnV5");
        expect(own.aborts).toEqual([[AGENT_SESSION, "cycle 1 ended"]]);
    });

    it("D2: a Stop whose visit cannot be read fails the turn (it is retried); it is never applied as every Stop", async () => {
        // At turn start: the activity fails, so the turn is retried; no model run, no Stop applied.
        const atStart = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false }, failIds: true,
            start: { stopped: false, controls: [control(81, "stop", "cycle ended")] } });
        await expect(atStart.h.runTurn(AGENT_SESSION, { turnIndex: 10, clientMessageIds: [promptId(NX2)] }, "runTurnV5"))
            .rejects.toThrow("the stops' ids could not be read");
        expect(atStart.h.session.runTurn).not.toHaveBeenCalled();
        // Live: the turn is failed (not aborted as a Stop).
        const failed = [];
        const live = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false }, failIds: true,
            turn: liveTurn([control(82, "stop", "cycle ended")], failed) });
        await live.h.runTurn(AGENT_SESSION, { turnIndex: 11, clientMessageIds: [promptId(NX2)] }, "runTurnV5");
        expect(live.aborts).toEqual([]);
        expect(failed.map(error => error.message)).toEqual(["the stops' ids could not be read"]);
        expect(live.fence.dropped).toEqual([]);
    });

    it("a person's Stop still applies to a continued session's turn", async () => {
        const person = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false }, requestIds: new Map([[61, "portal-stop-123"]]),
            turn: liveTurn([control(61, "stop", "Stopped by user")]) });
        await person.h.runTurn(AGENT_SESSION, { turnIndex: 9, clientMessageIds: [promptId(NX2)] }, "runTurnV5");
        expect(person.aborts).toEqual([[AGENT_SESSION, "Stopped by user"]]);
        const atStart = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false },
            start: { stopped: false, controls: [control(62, "stop", "Stopped by user")] }, requestIds: new Map([[62, null]]) });
        expect((await atStart.h.runTurn(AGENT_SESSION, { turnIndex: 9, clientMessageIds: [promptId(NX2)] }, "runTurnV5")).type).toBe("stopped");
    });

    it("a session that does not continue a session (readTurnVisit: null) runs and takes every Stop as before", async () => {
        const plain = harness({ visit: null, requestIds: new Map([[71, `workflow-cycle-stop:${NX1}`]]), turn: liveTurn([control(71, "stop", "stop")]) });
        await plain.h.runTurn("agent-new", { turnIndex: 1, clientMessageIds: [promptId(NX1)] }, "runTurnV5");
        expect(plain.h.session.runTurn).toHaveBeenCalledTimes(1);
        expect(plain.aborts).toEqual([["agent-new", "stop"]]);
        expect(plain.fence.reads.filter(([name]) => name === "readControlRequestIds")).toEqual([]);
    });

    // Review RT-D2 (C1): turn end gets the visit fence, exactly the turn visit live admission used (inherited included;
    // a null visit when the session names none), and only for a continued session's turn.
    describe("RT-D2 (C1): turn end carries the turn's visit fence", () => {
        const endArgs = calls => calls.filter(([name]) => name === "turnEnd").map(call => call.slice(1));
        it("a direct visit's turn and an inherited one end with their own visit; a session that does not continue ends without a fence", async () => {
            const direct = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false }, writeback: true });
            await direct.h.runTurn(AGENT_SESSION, { turnIndex: 12, clientMessageIds: [promptId(NX2)] }, "runTurnV5");
            expect(endArgs(direct.calls)).toEqual([[AGENT_SESSION, 12, 0, "other", [], { visitFence: { visit: NX2 } }]]);
            const inherited = harness({ visit: { nodeExecutionId: NX1, open: true, inherited: true }, writeback: true });
            await inherited.h.runTurn(AGENT_SESSION, { turnIndex: 13, prompt: "[SYSTEM: a timer fired]" }, "runTurnV5");
            expect(endArgs(inherited.calls)).toEqual([[AGENT_SESSION, 13, 0, "other", [], { visitFence: { visit: NX1 } }]]);
            const plain = harness({ visit: null, writeback: true });
            await plain.h.runTurn("agent-new", { turnIndex: 2 }, "runTurnV5");
            expect(endArgs(plain.calls)).toEqual([["agent-new", 2, 0, "other", []]]);
        });

        it("a continued session that names no visit: a workflow Stop is too_late live, and its end fences with a null visit", async () => {
            const none = harness({ visit: { nodeExecutionId: null, open: false, inherited: true }, writeback: true,
                requestIds: new Map([[91, `workflow-cycle-stop:${NX1}`]]), turn: liveTurn([control(91, "stop", "cycle ended")]) });
            const result = await none.h.runTurn(AGENT_SESSION, { turnIndex: 14, prompt: "a sub-agent's update" }, "runTurnV5");
            expect(result.type).toBe("completed");
            expect(none.aborts).toEqual([]);
            expect(none.fence.dropped).toEqual([[AGENT_SESSION, 91, 14]]);
            expect(endArgs(none.calls)).toEqual([[AGENT_SESSION, 14, 0, "other", [], { visitFence: { visit: null } }]]);
        });
    });

    // Review O-L1 (formal t4b, C1): a turn end from a saved result fences with the visit the live turn read, saved with
    // that result; it is not read again, so a newer named prompt recorded between the attempts cannot change it.
    describe("O-L1: the pre-saved retry fences with the visit saved with the result", () => {
        const roots = [];
        afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
        const lifecycleDirs = () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-wfs-fence-"));
            roots.push(root);
            const sessionStateDir = path.join(root, "session-state");
            fs.mkdirSync(sessionStateDir, { recursive: true });
            return { sessionStateDir, store: new FilesystemSessionStore(path.join(root, "session-store"), sessionStateDir) };
        };

        it("an inherited-visit turn's saved result keeps its visit: that visit's own Stop still stops the retried end", async () => {
            const dirs = lifecycleDirs();
            const sessionId = `${AGENT_SESSION}-${randomUUID()}`;
            let failures = 3;
            // Turn end as the catalog decides it: visit 1's own Stop is open; another visit's fence makes it too_late.
            const turnEnd = (_s, _turn, _cursor, _kind, _carried, options) => {
                if (failures > 0) { failures -= 1; throw new Error("database unavailable"); }
                return { stopped: !options?.visitFence || options.visitFence.visit === NX1, late: [] };
            };
            const { h, fence, calls } = harness({ visit: { nodeExecutionId: NX1, open: true, inherited: true }, writeback: true, turnEnd,
                lifecycle: dirs, turn: async () => { makeSessionLayout(dirs.sessionStateDir, sessionId); return { type: "error", message: "the model failed" }; } });
            const input = { turnIndex: 15, prompt: "a sub-agent's update", snapshot: { turnKey: "k15" } };
            await expect(h.runTurn(sessionId, input, "runTurnV5")).rejects.toThrow(/database unavailable/);
            // Between the attempts a newer visit's prompt is recorded: the session's inherited visit is now visit 2.
            fence.visit = { nodeExecutionId: NX2, open: true, inherited: true };
            const retried = await h.runTurn(sessionId, input, "runTurnV5");
            expect(h.session.runTurn).toHaveBeenCalledTimes(1);
            const ends = calls.filter(([name]) => name === "turnEnd").map(call => call[6]);
            expect(ends.at(-1)).toEqual({ visitFence: { visit: NX1 } });
            expect(retried.type).toBe("stopped");
            expect(fence.reads.filter(([name]) => name === "readTurnVisit")).toHaveLength(1);
        });

        it("a result saved without the fence (an older build) falls back to reading the turn visit again", () => {
            expect(savedTurnVisitFence({ type: "completed", turnVisitFence: { turn: 3, visit: NX1 } }, 3)).toEqual({ visit: NX1 });
            expect(savedTurnVisitFence({ type: "completed", turnVisitFence: { turn: 3, visit: null } }, 3)).toEqual({ visit: null });
            expect(savedTurnVisitFence({ type: "completed", turnVisitFence: { turn: 2, visit: NX1 } }, 3)).toBeUndefined();
            expect(savedTurnVisitFence({ type: "completed" }, 3)).toBeUndefined();
            expect(savedTurnVisitFence({ type: "completed", turnVisitFence: { turn: 3, visit: 7 } }, 3)).toBeUndefined();
            expect(savedTurnVisitFence(null, 3)).toBeUndefined();
        });
    });

    // Review RT-F1: when the model session reports a run aborted after a turn-control failure as unsettled, the activity
    // drops its warm session (destroyed, so the CLI stops and flushes) before turn end; a settled run keeps it.
    it("RT-F1: an unsettled run after a control failure drops the warm session before turn end; a settled one keeps it", async () => {
        for (const [unsettled, dropped] of [[true, 1], [false, 0]]) {
            const order = [];
            const { h, calls } = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false }, writeback: true,
                turn: async () => ({ type: "error", message: "canceling statement due to statement timeout" }) });
            h.session.takeUnsettledRun = vi.fn(() => unsettled);
            h.sessionManager.invalidateWarmSession = vi.fn(async (...args) => { order.push(["invalidateWarmSession", ...args]); });
            h.catalog.turnEnd.mockImplementation(async (...args) => { order.push(["turnEnd"]); calls.push(["turnEnd", ...args]); return { stopped: false, late: [] }; });
            const result = await h.runTurn(AGENT_SESSION, { turnIndex: 16, clientMessageIds: [promptId(NX2)] }, "runTurnV5");
            expect(result.type).toBe("error");
            expect(h.session.takeUnsettledRun).toHaveBeenCalledTimes(1);
            expect(h.sessionManager.invalidateWarmSession).toHaveBeenCalledTimes(dropped);
            if (dropped) expect(order.map(([name]) => name)).toEqual(["invalidateWarmSession", "turnEnd"]);
            if (dropped) expect(order[0].slice(1)).toEqual([AGENT_SESSION, { lockHeld: true }]);
        }
    });

    // Review RT-F1-L1: when dropping the unsettled warm session fails, the attempt fails (retryable) before any turn end or
    // save, so nothing of the unsettled run is committed; the manager forgets the handle whatever fails (session-manager).
    it("RT-F1-L1: a failed drop of the unsettled warm session fails the attempt before turn end; nothing is committed", async () => {
        const { h, calls } = harness({ visit: { nodeExecutionId: NX2, open: true, inherited: false }, writeback: true,
            turn: async () => ({ type: "error", message: "canceling statement due to statement timeout" }) });
        h.session.takeUnsettledRun = vi.fn(() => true);
        h.sessionManager.invalidateWarmSession = vi.fn(async () => { throw new Error("the CLI did not answer the disconnect"); });
        await expect(h.runTurn(AGENT_SESSION, { turnIndex: 17, clientMessageIds: [promptId(NX2)] }, "runTurnV5"))
            .rejects.toThrow(/could not be dropped cleanly: the CLI did not answer the disconnect\. The turn is retried\./);
        expect(h.sessionManager.invalidateWarmSession).toHaveBeenCalledTimes(1);
        expect(calls.filter(([name]) => name === "turnEnd")).toEqual([]);
        expect(h.catalog.completeTurnWriteback).not.toHaveBeenCalled();
    });
});

