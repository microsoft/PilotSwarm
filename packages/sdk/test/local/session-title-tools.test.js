import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedSession } from "../../src/managed-session.ts";
import { PilotSwarmClient } from "../../src/client.ts";
import { createSessionManagerProxy, registerActivities } from "../../src/session-proxy.ts";
import { handleSubAgentAction } from "../../src/orchestration/agents.ts";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";

function tools(bridge) {
    const session = { abort() {} };
    const managed = new ManagedSession("parent", session, {});
    const state = { session, pendingActions: [], queuedActions: [], waitThreshold: 0 };
    const handlers = managed.buildToolHandlers(state, { controlToolBridge: bridge });
    return { state, handlers, call: (name, args) => handlers.find(tool => tool.name === name).handler(args) };
}

const agent = { name: "analyst", id: "analyst", title: "Ops: Analyst", prompt: "Analyze.", initialPrompt: "Analyze." };
const owner = { provider: "test", subject: "title-owner", email: null, displayName: null };

function activities({ row = { sessionId: "parent", title: "Old", owner }, lineage = null, turn } = {}) {
    const h = makeRunTurnHarness({
        turn,
        catalogExtras: {
            getSession: vi.fn(async id => id === "parent" ? row : null),
            workflowStore: () => ({ readWorkflowLineage: async () => lineage }),
            listChildren: async () => [],
        },
        managerExtras: {
            resolveModelSwitchConfigForSession: vi.fn(async (_id, model) => ({ model, reasoningEffort: null })),
        },
    });
    registerActivities({ registerActivity: (name, fn) => { h.handlers[name] = fn; } },
        h.sessionManager, null, undefined, h.catalog, undefined, "fixture://titles",
        undefined, undefined, undefined, undefined, undefined, [agent]);
    return h;
}

function mockClient() {
    const enqueueEvent = vi.fn(async () => {});
    const send = vi.fn(async () => {});
    vi.spyOn(PilotSwarmClient.prototype, "start").mockImplementation(async function () {
        this.duroxideClient = { enqueueEvent };
    });
    vi.spyOn(PilotSwarmClient.prototype, "stop").mockResolvedValue(undefined);
    const createSession = vi.spyOn(PilotSwarmClient.prototype, "createSession")
        .mockImplementation(async opts => ({ sessionId: opts.sessionId ?? "child", send }));
    return { enqueueEvent, createSession, send };
}

afterEach(() => vi.restoreAllMocks());

describe("session title tool boundaries", () => {
    it.each([
        [{ title: "Keep this" }, true],
        [{ title: "Keep this", lock_title: false }, false],
        [{}, false],
        [{ lock_title: true }, true],
    ])("queues normalized spawn lock for %j", async (args, expected) => {
        const h = tools();
        await h.call("spawn_agent", { task: "Analyze.", ...args });
        expect(h.state.pendingActions[0]).toMatchObject({ type: "spawn_agent", lockTitle: expected });
    });

    it("normalizes the lock before the immediate spawn bridge", async () => {
        const spawnAgent = vi.fn(async () => "created");
        const h = tools({ spawnAgent });
        await h.call("spawn_agent", { task: "Analyze.", title: "Keep this" });
        expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ lock_title: true }));
        expect(h.state.pendingActions).toEqual([]);
    });

    it.each([{}, { reasoning_effort: "high" }, { title: 12 }, { title: "   " }])("refuses invalid title/model request %j", async args => {
        const setSessionModel = vi.fn();
        const h = tools({ setSessionModel });
        expect(await h.call("set_session_model", args)).toContain("Error:");
        expect(setSessionModel).not.toHaveBeenCalled();
        expect(h.state.pendingActions).toEqual([]);
    });

    it.each(["Session title updated.", "Error: title update failed."])("title-only keeps the turn open: %s", async response => {
        const setSessionModel = vi.fn(async () => response);
        const h = tools({ setSessionModel });
        expect(await h.call("set_session_model", { title: "New" })).toBe(response);
        expect(setSessionModel).toHaveBeenCalledWith({ title: "New" });
        expect(h.state.pendingActions).toEqual([]);
        expect(h.state.queuedActions).toEqual([]);
    });

    it("forwards empty title to unlock without ending the turn", async () => {
        const setSessionModel = vi.fn(async () => "Title unlocked.");
        const h = tools({ setSessionModel });
        await h.call("set_session_model", { title: "" });
        expect(setSessionModel).toHaveBeenCalledWith({ title: "" });
        expect(h.state.pendingActions).toEqual([]);
    });

    it.each([undefined, "New"])("model changes keep their turn boundary with title %j", async title => {
        const h = tools({ setSessionModel: async () => "[SYSTEM: Model switch accepted.]" });
        await h.call("set_session_model", { model: "fixture:model", ...(title !== undefined ? { title } : {}) });
        expect(h.state.pendingActions).toEqual([expect.objectContaining({ type: "completed" })]);
    });
});

describe("self title persistence", () => {
    it.each([
        [{ title: "New" }, { title: "Ops: Analyst: New", titleLocked: true }],
        [{ title: "" }, { titleLocked: false }],
    ])("updates only its own title metadata for %j", async (args, patch) => {
        let answer;
        const h = activities({
            row: { sessionId: "parent", title: "Ops: Analyst: Old", agentId: "analyst", owner, titleLocked: true },
            turn: async opts => {
                answer = await opts.controlToolBridge.setSessionModel(args);
                return { type: "completed", content: "still running" };
            },
        });
        await h.runTurn("parent");
        expect(answer).not.toMatch(/failed|Error:/);
        expect(h.catalog.updateSession).toHaveBeenCalledWith("parent", patch);
        expect(h.sessionManager.resolveModelSwitchConfigForSession).not.toHaveBeenCalled();
    });

    it.each([
        [{ isSystem: true }, null],
        [{ sessionKind: "workflow" }, null],
        [{}, { agentRoot: { childSessionId: "parent", distance: 0 } }],
        [{}, { agentRoot: { childSessionId: "ancestor", distance: 1 } }],
    ])("refuses protected title changes %j", async (extra, lineage) => {
        let answer;
        const h = activities({
            row: { sessionId: "parent", title: "Protected", owner, ...extra },
            lineage,
            turn: async opts => {
                answer = await opts.controlToolBridge.setSessionModel({ title: "New" });
                return { type: "completed", content: "done" };
            },
        });
        await h.runTurn("parent");
        expect(answer).toMatch(/system|Workflow/i);
        expect(h.catalog.updateSession.mock.calls.filter(([, patch]) => "title" in patch || "titleLocked" in patch)).toEqual([]);
    });

    it("preserves model-only behavior and combines model and title", async () => {
        const { enqueueEvent } = mockClient();
        const h = activities({
            turn: async opts => {
                expect(await opts.controlToolBridge.setSessionModel({ model: "fixture:model", title: "New" })).toContain("Model switch accepted");
                return { type: "completed", content: "done" };
            },
        });
        await h.runTurn("parent");
        expect(h.catalog.updateSession).toHaveBeenCalledWith("parent", { title: "New", titleLocked: true });
        expect(enqueueEvent).toHaveBeenCalledWith("session-parent", "messages", expect.stringContaining('"cmd":"set_model"'));
    });

    it("a locked title skips the summarizer before reading messages", async () => {
        const h = activities({ row: { sessionId: "parent", title: "Locked", titleLocked: true } });
        h.catalog.getSessionEvents = vi.fn();
        expect(await h.handlers.summarizeSession({ traceInfo() {} }, { sessionId: "parent" })).toBe("Locked");
        expect(h.catalog.getSessionEvents).not.toHaveBeenCalled();
        expect(h.catalog.updateSession).not.toHaveBeenCalled();
    });
});

describe("spawn title persistence", () => {
    it.each([true, false])("immediate named spawn keeps its prefix with lock %j", async lock_title => {
        mockClient();
        const h = activities({
            turn: async opts => {
                expect(await opts.controlToolBridge.spawnAgent({ agent_name: "analyst", title: "Investigation", lock_title }))
                    .not.toMatch(/failed/i);
                return { type: "completed", content: "done" };
            },
        });
        await h.runTurn("parent");
        expect(h.catalog.updateSession).toHaveBeenCalledWith("child", expect.objectContaining({
            title: "Ops: Analyst: Investigation", titleLocked: lock_title,
        }));
    });

    it.each([undefined, true, false])("durable spawn preserves old absence or new lock %j", async lockTitle => {
        mockClient();
        const h = activities();
        await h.handlers.spawnChildSession({ traceInfo() {} }, {
            parentSessionId: "parent", config: { boundAgentName: "analyst", boundAgentSource: "deployment" },
            task: "Analyze.", title: "Investigation", titleIsExplicit: true, agentId: "analyst",
            ...(lockTitle !== undefined ? { lockTitle } : {}),
        });
        const patch = h.catalog.updateSession.mock.calls.find(([, patch]) => "title" in patch)[1];
        if (lockTitle === undefined) {
            expect(patch.title).toBe("Investigation");
            expect(patch).not.toHaveProperty("titleLocked");
        } else {
            expect(patch).toMatchObject({ title: "Ops: Analyst: Investigation", titleLocked: lockTitle });
        }
    });
});

describe("spawn replay payload compatibility", () => {
    function scheduledSpawn(action) {
        const scheduleActivity = vi.fn((name, input) => ({ name, input }));
        const manager = createSessionManagerProxy({ scheduleActivity });
        const runtime = {
            ctx: { traceInfo() {} }, input: { sessionId: "parent" },
            state: { subAgents: [], config: {} }, options: { nestingLevel: 0 },
            manager,
        };
        const gen = handleSubAgentAction(runtime, { type: "spawn_agent", task: "Analyze.", title: "Old explicit title", ...action });
        const step = gen.next();
        expect(step.value.name).toBe("spawnChildSession");
        return step.value.input;
    }

    it.each([undefined, { root: "repo", folder: "src" }])("old recorded spawn input stays byte-identical with workspace %j", workspace => {
        const input = scheduledSpawn(workspace ? { workspace } : {});
        const scheduleActivity = vi.fn((_name, input) => input);
        const old = createSessionManagerProxy({ scheduleActivity }).spawnChildSession(
            "parent", input.config, "Analyze.", 1, false, "Old explicit title", undefined, undefined, true, undefined,
            ...(workspace ? [true] : []),
        );
        expect(JSON.stringify(input)).toBe(JSON.stringify(old));
        expect(input).not.toHaveProperty("lockTitle");
    });

    it.each([
        [{ lockTitle: true }, { lockTitle: true }],
        [{ lockTitle: false }, { lockTitle: false }],
        [{ workspace: { root: "repo" } }, { workspaceChosen: true }],
        [{ workspace: { root: "repo" }, lockTitle: true }, { workspaceChosen: true, lockTitle: true }],
    ])("keeps optional lock and workspace positions distinct: %j", (action, expected) => {
        const input = scheduledSpawn(action);
        expect(input).toMatchObject(expected);
        if (!action.workspace) expect(input).not.toHaveProperty("workspaceChosen");
        if (action.lockTitle === undefined) expect(input).not.toHaveProperty("lockTitle");
    });
});
