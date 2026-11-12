import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";
import { makeSessionLayout } from "../helpers/snapshot-conformance.js";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { registerActivities } from "../../src/session-proxy.ts";
import { createInitialState, deriveOptions } from "../../src/orchestration/state.ts";
import { processPrompt } from "../../src/orchestration/turn.ts";

const published = vi.hoisted(() => ({ active: false }));
vi.mock("../../src/client.js", () => ({
    PilotSwarmClient: class {
        async start() {}
        async stop() {}
        _getDuroxideClient() {
            return { getStatus: async () => ({ customStatus: { cronActive: published.active } }) };
        }
        _workflowAgentModelCheck() { return async () => null; }
    },
}));

const CHILD = "continued-agent";
const NX1 = `nx-${"11".repeat(20)}`;
const NX2 = `nx-${"22".repeat(20)}`;
const promptId = nx => `workflow:wf-1:run-1:agent:${nx}`;
const CANCEL = { type: "cron", action: "cancel" };
const schedules = [
    { type: "cron", action: "set", intervalSeconds: 15, reason: "visit one" },
    { type: "cron_at", action: "set", schedule: { minute: 5, tz: "UTC", reason: "visit one" } },
];

// Real activity + real orchestration turn path, with a virtual clock and scripted model/store.
function harness({ stopped = false, descendant = false, lifecycle = null } = {}) {
    const invocation = { visit: { nodeExecutionId: NX1, open: true, inherited: false }, outcome: null };
    const reminders = [];
    let model = async () => ({ type: "completed", content: "ok" });
    const store = {
        readWorkflowLineage: async () => ({ level: descendant ? 3 : 2, agentRoot: {
            childSessionId: CHILD, nodeExecutionId: NX1, workflowSessionId: "wf-1",
            controllingSessionId: "parent", distance: descendant ? 1 : 0,
        } }),
        readNodeExecution: async () => ({ nodeType: "agent", runId: "run-1", nodeId: "look", nodeExecutionId: NX1 }),
        readRun: async () => ({ runId: "run-1", mode: "live", workflowSessionId: "wf-1" }),
        readAgentToolLimit: async () => null,
        readTurnVisit: async () => invocation.visit,
        recordAgentReminder: async request => {
            reminders.push(request);
            return { recorded: true, n: 1, max: 3, stateId: "look", cycle: request.visit };
        },
    };
    const h = makeRunTurnHarness({
        ...(lifecycle ? { sessionStore: lifecycle.store, sessionStateDir: lifecycle.sessionStateDir } : {}),
        catalogExtras: {
            workflowStore: () => store,
            turnStart: async () => ({ stopped: false, controls: [] }),
            completeTurnWriteback: async () => stopped,
            turnEnd: async () => ({ stopped, late: [] }),
        },
        turn: opts => model(opts),
    });
    registerActivities({ registerActivity: (name, fn) => { h.handlers[name] = fn; } },
        h.sessionManager, lifecycle?.store ?? null, undefined, h.catalog, undefined, "fixture://no-database");
    const input = { sessionId: CHILD, config: {}, iteration: 0, blobEnabled: false };
    const options = deriveOptions(input);
    const state = createInitialState(input, options);
    const effects = [];
    let now = Date.UTC(2026, 10, 12);
    const values = new Map();
    const runtime = {
        input, options, state, versions: { currentVersion: "1.0.83", latestVersion: "1.0.83" },
        ctx: {
            traceInfo() {}, traceWarn() {}, setCustomStatus() {},
            getValue: key => values.get(key) ?? null, setValue: (key, value) => values.set(key, value),
            clearValue: key => values.delete(key),
            utcNow: () => ({ effect: "now" }),
            newGuid: () => ({ effect: "guid" }),
            scheduleTimer: ms => ({ effect: "timer", ms }),
            hasQueuedEvents: () => false,
        },
        session: { runTurn: (prompt, bootstrap, turnIndex, opts) => ({ effect: "turn", prompt, bootstrap, turnIndex, opts }) },
        manager: new Proxy({}, { get: (_t, method) => (...args) => ({ effect: `manager.${String(method)}`, args }) }),
    };
    async function step({ named = false, scheduleFire = false } = {}) {
        // A timer that fires or is interrupted is consumed before processPrompt.
        state.activeTimer = null;
        published.active = Boolean(state.cronSchedule || state.cronAtSchedule);
        const gen = processPrompt(runtime, scheduleFire ? "[SYSTEM: scheduled look]" : "look",
            false, undefined, named ? [promptId(invocation.visit.nodeExecutionId)] : undefined,
            scheduleFire ? (state.cronAtSchedule ? "cron_at" : "cron") : undefined);
        let answer;
        for (let n = 0; n < 300; n++) {
            const next = gen.next(answer);
            if (next.done) return;
            const effect = next.value;
            effects.push(effect);
            switch (effect?.effect) {
                case "turn":
                    answer = await h.runTurn(CHILD, { prompt: effect.prompt, bootstrap: effect.bootstrap,
                        turnIndex: effect.turnIndex, ...effect.opts }, "runTurnV5");
                    break;
                case "now": answer = now; break;
                case "guid": answer = "guid-1"; break;
                case "manager.computeCronAtNextFire":
                    answer = { nextFireAtMs: now + 60_000, occurrenceKey: "2026-11-12T00:05" }; break;
                case "manager.listChildSessions": answer = []; break;
                default: answer = undefined;
            }
        }
        throw new Error("turn did not settle in 300 effects");
    }
    return { h, state, invocation, reminders, effects, step,
        setModel: fn => { model = fn; },
        decide: outcome => { invocation.outcome = outcome; invocation.visit = { ...invocation.visit, open: false, inherited: true }; },
        nextVisit: () => { invocation.visit = { nodeExecutionId: NX2, open: true, inherited: false }; },
        advance: () => { now += 60_000; },
    };
}

describe("FB-026: a continued agent's schedule belongs to its visit", () => {
    const roots = [];
    afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
    for (const schedule of schedules) {
        for (const outcome of ["completed", "timed_out", "cancelled"]) {
            it(`${schedule.type}: ${outcome} permits one fenced fire, then no old schedule in the next cycle`, async () => {
                const h = harness();
                h.setModel(async () => ({ type: "completed", content: "scheduled", queuedActions: [schedule] }));
                await h.step({ named: true });
                expect(Boolean(h.state.cronSchedule || h.state.cronAtSchedule)).toBe(true);
                h.decide(outcome);
                h.advance();
                await h.step({ scheduleFire: true });
                expect(h.h.session.runTurn).toHaveBeenCalledTimes(1);
                expect(h.state.cronSchedule).toBeUndefined();
                expect(h.state.cronAtSchedule).toBeUndefined();
                expect(h.state.activeTimer).toBeNull();
                h.nextVisit();
                h.setModel(async opts => {
                    expect(await opts.stepReminder.check({ scheduleCancelled: false })).toMatchObject({ remind: true, cycle: NX2 });
                    return { type: "completed", content: "next look" };
                });
                await h.step({ named: true });
                expect(h.h.session.runTurn).toHaveBeenCalledTimes(2);
                expect(h.reminders).toMatchObject([{ visit: NX2 }]);
                expect(h.state.activeTimer).toBeNull();
            });
        }
        it(`${schedule.type}: next cycle before the old fire cancels it and still gets its reminder`, async () => {
            const h = harness();
            h.setModel(async () => ({ type: "completed", content: "scheduled", queuedActions: [schedule] }));
            await h.step({ named: true });
            h.decide("completed");
            h.nextVisit();
            h.setModel(async opts => {
                expect(await opts.stepReminder.check({ scheduleCancelled: false })).toMatchObject({ remind: true, cycle: NX2 });
                return { type: "completed", content: "done" };
            });
            await h.step({ named: true });
            expect(h.state.cronSchedule).toBeUndefined();
            expect(h.state.cronAtSchedule).toBeUndefined();
            expect(h.state.activeTimer).toBeNull();
        });
        it(`${schedule.type}: the new cycle can set its own schedule after the reset`, async () => {
            const h = harness();
            h.setModel(async () => ({ type: "completed", content: "scheduled", queuedActions: [schedule] }));
            await h.step({ named: true });
            h.nextVisit();
            const replacement = schedule.type === "cron" ? { ...schedule, reason: "visit two" }
                : { ...schedule, schedule: { ...schedule.schedule, reason: "visit two" } };
            h.setModel(async () => ({ type: "completed", content: "new schedule", queuedActions: [replacement] }));
            await h.step({ named: true });
            expect(h.state.cronSchedule?.reason ?? h.state.cronAtSchedule?.reason).toBe("visit two");
        });
    }

    it("a turn end reported stopped keeps the fenced turn's cancellation", async () => {
        const h = harness({ stopped: true });
        h.decide("timed_out");
        expect(await h.h.runTurn(CHILD, {}, "runTurnV5")).toMatchObject({ type: "stopped", queuedActions: [CANCEL] });
        expect(h.h.session.runTurn).not.toHaveBeenCalled();
    });

    it("an inherited turn inside the same open visit does not clear its schedule", async () => {
        const h = harness();
        h.invocation.visit.inherited = true;
        const result = await h.h.runTurn(CHILD, {}, "runTurnV5");
        expect(result.queuedActions).toBeUndefined();
    });

    it("a new-session agent without a continued visit keeps its ordinary result", async () => {
        const h = harness();
        h.invocation.visit = null;
        const result = await h.h.runTurn(CHILD, {}, "runTurnV5");
        expect(result.queuedActions).toBeUndefined();
    });

    it("a first turn converted to stopped keeps only the reset, never its new schedule", async () => {
        const h = harness({ stopped: true });
        h.setModel(async () => ({ type: "completed", content: "scheduled", queuedActions: [schedules[0]] }));
        expect(await h.h.runTurn(CHILD, { clientMessageIds: [promptId(NX1)] }, "runTurnV5"))
            .toMatchObject({ type: "stopped", queuedActions: [CANCEL] });
    });

    it("a saved first-turn result replays its cancellation even after the inherited visit changes", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-workflow-cron-"));
        roots.push(root);
        const sessionStateDir = path.join(root, "session-state");
        fs.mkdirSync(sessionStateDir, { recursive: true });
        const lifecycle = { sessionStateDir, store: new FilesystemSessionStore(path.join(root, "store"), sessionStateDir) };
        const h = harness({ stopped: true, lifecycle });
        let failures = 3;
        h.h.catalog.turnEnd = async () => {
            if (failures-- > 0) throw new Error("turn-end fixture failure");
            return { stopped: true, late: [] };
        };
        h.setModel(async () => {
            makeSessionLayout(sessionStateDir, CHILD);
            return { type: "completed", content: "scheduled", queuedActions: [schedules[0]] };
        });
        const input = { turnIndex: 1, clientMessageIds: [promptId(NX1)], snapshot: { turnKey: "first" } };
        await expect(h.h.runTurn(CHILD, input, "runTurnV5")).rejects.toThrow("turn-end fixture failure");
        h.nextVisit();
        h.invocation.visit.inherited = true;
        const result = await h.h.runTurn(CHILD, input, "runTurnV5");
        expect(result).toMatchObject({ type: "stopped", queuedActions: [CANCEL] });
        expect(h.h.session.runTurn).toHaveBeenCalledTimes(1);
    });

    it("a descendant's cron is not a direct agent-child visit (documented scope limit)", async () => {
        const h = harness({ descendant: true });
        h.decide("completed");
        const result = await h.h.runTurn("nested-agent", {}, "runTurnV5");
        expect(result.type).toBe("completed");
        expect(result.queuedActions).toBeUndefined();
        expect(h.h.session.runTurn).toHaveBeenCalledTimes(1);
    });
});
