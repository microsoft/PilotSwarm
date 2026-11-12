import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedSession } from "../../src/managed-session.ts";
import { registerActivities } from "../../src/session-proxy.ts";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";

const NOW = Date.parse("2026-11-12T00:00:00.000Z");
const deadlineAt = new Date(NOW + 60_000).toISOString();
const clock = { minute: 1, tz: "UTC", reason: "next look" };
const calls = [
    ["wait", { seconds: 60 }],
    ["wait_on_worker", { seconds: 60 }],
    ["cron", { seconds: 60, reason: "next look" }],
    ["cron_at", clock],
];

function tools(readDeadline) {
    const session = { abort() {} };
    const managed = new ManagedSession("child", session, {});
    const state = { session, pendingActions: [], queuedActions: [], waitThreshold: 0 };
    const handlers = managed.buildToolHandlers(state, {
        controlToolBridge: readDeadline ? { workflowScheduleDeadline: readDeadline } : {},
    });
    return { state, call: (name, args) => handlers.find(tool => tool.name === name).handler(args) };
}

describe("Workflow agent visit scheduling", () => {
    afterEach(() => vi.restoreAllMocks());

    it.each(calls)("%s refuses at the deadline before queuing a wake", async (name, args) => {
        vi.spyOn(Date, "now").mockReturnValue(NOW);
        const h = tools(async () => ({ deadlineAt }));
        const answer = await h.call(name, args);
        expect(answer).toContain(deadlineAt);
        expect(answer).toContain("shorter");
        expect(answer).toContain("sleep outcome");
        expect(h.state.pendingActions).toEqual([]);
        expect(h.state.queuedActions).toEqual([]);
    });

    it.each(calls)("%s accepts a first wake inside the deadline", async (name, args) => {
        vi.spyOn(Date, "now").mockReturnValue(NOW);
        const h = tools(async () => ({ deadlineAt: new Date(NOW + 60_001).toISOString() }));
        await h.call(name, args);
        expect(h.state.pendingActions.length + h.state.queuedActions.length).toBe(1);
    });

    it.each(calls)("%s leaves ordinary sessions unchanged", async (name, args) => {
        vi.spyOn(Date, "now").mockReturnValue(NOW);
        const h = tools();
        await h.call(name, args);
        expect(h.state.pendingActions.length + h.state.queuedActions.length).toBe(1);
    });

    it.each(["cron", "cron_at"])("%s cancellation works without reading an expired or unavailable visit", async name => {
        const read = vi.fn(async () => { throw new Error("must not read"); });
        const h = tools(read);
        expect(await h.call(name, { action: "cancel" })).toContain("cancelled");
        expect(read).not.toHaveBeenCalled();
        expect(h.state.queuedActions.every(action => action.action === "cancel")).toBe(true);
    });

    it.each(calls)("%s does not schedule when the deadline read fails", async (name, args) => {
        const h = tools(async () => { throw new Error("deadline read failed"); });
        await expect(h.call(name, args)).rejects.toThrow("deadline read failed");
        expect(h.state.pendingActions).toEqual([]);
        expect(h.state.queuedActions).toEqual([]);
    });

    it("reads the current time after the visit lookup, not before it", async () => {
        const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
        const h = tools(async () => {
            now.mockReturnValue(NOW + 30_000);
            return { deadlineAt };
        });
        expect(await h.call("wait", { seconds: 30 })).toContain(deadlineAt);
        expect(h.state.pendingActions).toEqual([]);
    });
});

const CHILD = "scheduled-child";
const OLD = `nx-${"31".repeat(20)}`;
const CURRENT = `nx-${"32".repeat(20)}`;

describe("the scheduling bridge uses this turn's visit", () => {
    it.each([
        ["continued child", 0, { nodeExecutionId: CURRENT, open: true, inherited: false }, CURRENT],
        ["fresh child", 0, null, OLD],
        ["descendant", 1, null, null],
    ])("%s", async (_name, distance, turnVisit, expectedVisit) => {
        const reads = [];
        let checked = false;
        const store = {
            readWorkflowLineage: async () => ({ level: 2 + distance, agentRoot: {
                childSessionId: CHILD, nodeExecutionId: OLD, workflowSessionId: "wf",
                controllingSessionId: "parent", distance,
            } }),
            readNodeExecution: async () => ({ nodeType: "agent", runId: "run", nodeId: "look", nodeExecutionId: OLD }),
            readRun: async () => ({ runId: "run", mode: "live", workflowSessionId: "wf" }),
            readAgentToolLimit: async () => null,
            readTurnVisit: async () => turnVisit,
            readAgentInvocation: async id => {
                reads.push(id);
                return { childSessionId: CHILD, deadlineAt: new Date(deadlineAt) };
            },
        };
        const h = makeRunTurnHarness({
            catalogExtras: {
                workflowStore: () => store, turnStart: async () => ({ stopped: false, controls: [] }),
                turnEnd: async () => ({ stopped: false, late: [] }),
            },
            turn: async opts => {
                checked = true;
                const reader = opts.controlToolBridge.workflowScheduleDeadline;
                if (expectedVisit) expect(await reader()).toEqual({ deadlineAt });
                else expect(reader).toBeUndefined();
                return { type: "completed", content: "done" };
            },
        });
        registerActivities({ registerActivity: (name, fn) => { h.handlers[name] = fn; } },
            h.sessionManager, null, undefined, h.catalog, undefined, "fixture://no-database");
        await h.runTurn(CHILD, { prompt: "look", clientMessageIds: [`workflow:wf:run:agent:${CURRENT}`] }, "runTurnV5");
        expect(checked).toBe(true);
        expect(reads).toEqual(expectedVisit ? [expectedVisit] : []);
    });
});
