import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedSession } from "../../src/managed-session.ts";
import { PilotSwarmClient } from "../../src/client.ts";
import { createSessionManagerProxy, registerActivities } from "../../src/session-proxy.ts";
import { handleSubAgentAction } from "../../src/orchestration/agents.ts";
import { handleSubAgentAction as handleHistoricalSubAgentAction } from "../../src/orchestration_1_0_82/agents.ts";
import { handleSubAgentAction as handleFrozen84SubAgentAction } from "../../src/orchestration_1_0_84/agents.ts";
import { detectFailedModelSwitch } from "../../src/orchestration/turn.ts";
import * as copilotClient from "../../src/copilot-client.ts";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";
import { runRegenDistill } from "../../src/regen-worker.ts";

function tools(bridge) {
    const session = { abort() {} };
    const managed = new ManagedSession("parent", session, {});
    const state = { session, pendingActions: [], queuedActions: [], waitThreshold: 0 };
    const handlers = managed.buildToolHandlers(state, { controlToolBridge: bridge });
    return { state, handlers, call: (name, args) => handlers.find(tool => tool.name === name).handler(args) };
}

const agent = { name: "analyst", id: "analyst", title: "Ops: Analyst", prompt: "Analyze.", initialPrompt: "Analyze." };
const owner = { provider: "test", subject: "title-owner", email: null, displayName: null };

function activities({ row = { sessionId: "parent", title: "Old", owner }, lineage = null, turn, catalogAvailable = true, agents = [agent] } = {}) {
    const h = makeRunTurnHarness({
        turn,
        catalogExtras: {
            getSession: vi.fn(async id => id === "parent" ? row : null),
            workflowStore: () => ({
                readWorkflowLineage: async () => lineage,
                readAgentToolLimit: async () => null,
                readAgentRequiredTools: async () => [],
                readAgentMissingTools: async () => [],
                readNodeExecution: async () => ({ nodeType: "agent", runId: "run" }),
                readRun: async () => ({ runId: "run", mode: "live" }),
                readTurnVisit: async () => null,
            }),
            listChildren: async () => [],
        },
        managerExtras: {
            resolveModelSwitchConfigForSession: vi.fn(async (_id, model) => ({ model, reasoningEffort: null, contextTier: null })),
            normalizeModelRef: model => model,
        },
    });
    registerActivities({ registerActivity: (name, fn) => { h.handlers[name] = fn; } },
        h.sessionManager, null, undefined, catalogAvailable ? h.catalog : null, undefined, "fixture://titles",
        undefined, undefined, undefined, undefined, undefined, agents);
    return h;
}

function mockClient() {
    const enqueueEvent = vi.fn(async () => {});
    const send = vi.fn(async () => {});
    vi.spyOn(PilotSwarmClient.prototype, "start").mockImplementation(async function () {
        this.duroxideClient = { enqueueEvent };
    });
    vi.spyOn(PilotSwarmClient.prototype, "stop").mockResolvedValue(undefined);
    vi.spyOn(PilotSwarmClient.prototype, "listSessions").mockResolvedValue([]);
    const createSession = vi.spyOn(PilotSwarmClient.prototype, "createSession")
        .mockImplementation(async opts => ({ sessionId: opts.sessionId ?? "child", send }));
    return { enqueueEvent, createSession, send };
}

function mockSummaryModel() {
    const listeners = {};
    const createSession = vi.fn(async () => ({
        on: (name, fn) => { listeners[name] = fn; },
        send: () => {
            listeners["assistant.message"]({ data: { content: "Generated summary" } });
            listeners["session.idle"]();
        },
    }));
    const factory = vi.spyOn(copilotClient, "createCopilotClient").mockReturnValue({
        start: async () => {},
        stop: async () => {},
        createSession,
    });
    return { factory, createSession };
}

afterEach(() => vi.restoreAllMocks());

describe("session title tool boundaries", () => {
    it.each([
        [{ title: "Keep this" }, true],
        [{ title: "Keep this", lock_title: false }, false],
        [{}, false],
        [{ agent_name: "analyst", lock_title: true }, true],
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

    it.each([{}, { reasoning_effort: "high" }, { context_tier: "long_context" }, { title: 12 }, { title: "   " }, { title: "New", reasoning_effort: "high" }, { title: "New", context_tier: "long_context" }, { model: "", title: "New" }, { model: null }, { model: "fixture:model", context_tier: "huge" }])("refuses invalid title/model request %j", async args => {
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

    it("forwards an explicit context tier with the model switch", async () => {
        const setSessionModel = vi.fn(async () => "[SYSTEM: Model switch accepted.]");
        const h = tools({ setSessionModel });
        await h.call("set_session_model", { model: "fixture:model", context_tier: "long_context" });
        expect(setSessionModel).toHaveBeenCalledWith({ model: "fixture:model", context_tier: "long_context" });
    });

    it("a refused model switch still ends the turn", async () => {
        const h = tools({ setSessionModel: async () => "[SYSTEM: set_session_model failed: unknown model.]" });
        await h.call("set_session_model", { model: "fixture:missing" });
        expect(h.state.pendingActions).toEqual([expect.objectContaining({ type: "completed" })]);
    });

    it("declares both new arguments without requiring a model", () => {
        const h = tools();
        const model = h.handlers.find(tool => tool.name === "set_session_model").parameters;
        const spawn = h.handlers.find(tool => tool.name === "spawn_agent").parameters;
        expect(model.properties.title.type).toBe("string");
        expect(model.properties.context_tier.enum).toEqual(["default", "long_context"]);
        expect(model.required ?? []).not.toContain("model");
        expect(spawn.properties.lock_title.type).toBe("boolean");
    });

    it("refuses an anonymous spawn with nothing to lock", async () => {
        const h = tools();
        expect(await h.call("spawn_agent", { task: "Analyze.", lock_title: true })).toContain("requires a title");
        expect(h.state.pendingActions).toEqual([]);
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
        expect(answer).toContain("SESSION_TITLE_REFUSED:");
        expect(detectFailedModelSwitch([{ eventType: "tool.execution_complete", data: { result: answer } }])).toBeNull();
        expect(h.catalog.updateSession.mock.calls.filter(([, patch]) => "title" in patch || "titleLocked" in patch)).toEqual([]);
    });

    it("a title storage failure is visible without a false model-switch retry", async () => {
        let answer;
        const h = activities({
            turn: async opts => {
                answer = await opts.controlToolBridge.setSessionModel({ title: "New" });
                return { type: "completed", content: "done" };
            },
        });

        const update = h.catalog.updateSession;
        h.catalog.updateSession = vi.fn(async (id, patch) => {
            if ("titleLocked" in patch) throw new Error("title storage rejected the write");
            await update(id, patch);
        });
        await h.runTurn("parent");
        expect(answer).toContain("title storage rejected the write");
        expect(detectFailedModelSwitch([{ eventType: "tool.execution_complete", data: { result: answer } }])).toBeNull();
    });

    it("refuses a title change when catalog storage is unavailable", async () => {
        const h = activities({
            catalogAvailable: false,
            turn: async opts => {
                expect(await opts.controlToolBridge.setSessionModel({ title: "New" })).toContain("title storage is unavailable");
                return { type: "completed", content: "done" };
            },
        });
        await h.runTurn("parent");
    });

    it.each([
        [{ agentId: "analyst", title: "Old unprefixed" }, { title: "Ops: Analyst: New", titleLocked: true }],
        [{ agentId: "missing", title: "Old unprefixed" }, null],
    ])("keeps a named prefix rather than silently dropping it: %j", async (row, expected) => {
        let answer;
        const h = activities({
            row: { sessionId: "parent", owner, ...row },
            turn: async opts => {
                answer = await opts.controlToolBridge.setSessionModel({ title: "New" });
                return { type: "completed", content: "done" };
            },
        });
        await h.runTurn("parent");
        if (expected) expect(h.catalog.updateSession).toHaveBeenCalledWith("parent", expected);
        else {
            expect(answer).toContain("prefix is unavailable");
            expect(h.catalog.updateSession.mock.calls.filter(([, patch]) => "titleLocked" in patch)).toEqual([]);
        }
    });

    it.each([{ isSystem: true }, { sessionKind: "workflow" }])("does not refuse existing model-only calls on %j", async extra => {
        const { enqueueEvent } = mockClient();
        const h = activities({
            row: { sessionId: "parent", title: "Protected", owner, ...extra },
            turn: async opts => {
                expect(await opts.controlToolBridge.setSessionModel({ model: "fixture:model" })).toContain("Model switch accepted");
                return { type: "completed", content: "done" };
            },
        });
        await h.runTurn("parent");
        expect(enqueueEvent).toHaveBeenCalledOnce();
        expect(h.catalog.updateSession.mock.calls.filter(([, patch]) => "title" in patch || "titleLocked" in patch)).toEqual([]);
    });

    it("validates a combined model request before changing the title", async () => {
        let answer;
        const h = activities({
            turn: async opts => {
                answer = await opts.controlToolBridge.setSessionModel({ model: "fixture:missing", title: "New" });
                return { type: "completed", content: "done" };
            },
        });
        h.sessionManager.resolveModelSwitchConfigForSession.mockRejectedValue(new Error("unknown model"));
        await h.runTurn("parent");
        expect(answer).toContain("unknown model");
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
        const command = JSON.parse(enqueueEvent.mock.calls[0][2]);
        expect(command.args.contextTier).toBe(null);
    });

    it("a locked title skips the summarizer before reading messages", async () => {
        const h = activities({ row: { sessionId: "parent", title: "Locked", titleLocked: true } });
        h.catalog.getSessionEvents = vi.fn();
        expect(await h.handlers.summarizeSession({ traceInfo() {} }, { sessionId: "parent" })).toBe("Locked");
        expect(h.catalog.getSessionEvents).not.toHaveBeenCalled();
        expect(h.catalog.updateSession).not.toHaveBeenCalled();
    });

    it("unlock preserves the text and makes the next summary eligible", async () => {
        let row = { sessionId: "parent", title: "Old locked title", titleLocked: true, owner };
        const h = activities({
            turn: async opts => {
                expect(await opts.controlToolBridge.setSessionModel({ title: "" })).toContain("unlocked");
                return { type: "completed", content: "done" };
            },
        });
        h.catalog.getSession.mockImplementation(async () => row);
        h.catalog.updateSession.mockImplementation(async (_id, patch) => { row = { ...row, ...patch }; });
        h.catalog.updateSessionTitleIfUnlocked = vi.fn(async (_id, title) => {
            row = { ...row, title };
            return true;
        });
        h.catalog.getSessionEvents = async () => [{ eventType: "user.message", data: { content: "Analyze replication lag" } }];
        h.sessionManager.resolveDefaultProvider = () => ({ modelName: "fixture:model", sdkProvider: {} });
        const summarize = mockSummaryModel();
        await h.runTurn("parent");
        expect(row).toMatchObject({ title: "Old locked title", titleLocked: false });
        await h.handlers.summarizeSession({ traceInfo() {} }, { sessionId: "parent" });
        expect(summarize.factory).toHaveBeenCalledOnce();
        expect(summarize.createSession).toHaveBeenCalledWith(expect.objectContaining({ availableTools: [] }));
        expect(row).toMatchObject({ title: "Generated summary", titleLocked: false });
    });

    it.each([
        { title: "New locked title", titleLocked: true },
        { title: "System title", isSystem: true },
        null,
    ])("rechecks a changed session before persisting the summary: %j", async latest => {
        const h = activities({ row: { sessionId: "parent", title: "Old", titleLocked: false } });
        h.catalog.getSession.mockResolvedValueOnce({ sessionId: "parent", title: "Old", titleLocked: false })
            .mockResolvedValue(latest);
        h.catalog.getSessionEvents = vi.fn(async () => [{ eventType: "user.message", data: { content: "Analyze replication lag" } }]);
        h.sessionManager.resolveDefaultProvider = () => ({ modelName: "fixture:model", sdkProvider: {} });
        mockSummaryModel();
        await h.handlers.summarizeSession({ traceInfo() {} }, { sessionId: "parent" });
        expect(h.catalog.getSession.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(h.catalog.updateSession).not.toHaveBeenCalled();
    });
});

describe("spawn title persistence", () => {
    it("keeps unlocked metadata best-effort and still bootstraps the child", async () => {
        const { send } = mockClient();
        const h = activities({
            turn: async opts => {
                expect(await opts.controlToolBridge.spawnAgent({ task: "Analyze.", lock_title: false })).toContain("spawned successfully");
                return { type: "completed", content: "done" };
            },
        });
        const update = h.catalog.updateSession;
        h.catalog.updateSession = vi.fn(async (id, patch) => {
            if ("titleLocked" in patch) throw new Error("title storage rejected the write");
            await update(id, patch);
        });
        await h.runTurn("parent");
        expect(send).toHaveBeenCalledOnce();
    });

    it.each(["false", 1, null])("refuses an invalid bridge lock %j before creating a child", async lock_title => {
        const { createSession } = mockClient();
        const h = activities({
            turn: async opts => {
                expect(await opts.controlToolBridge.spawnAgent({ task: "Analyze.", lock_title })).toContain("must be a boolean");
                return { type: "completed", content: "done" };
            },
        });
        await h.runTurn("parent");
        expect(createSession).not.toHaveBeenCalled();
    });

    it.each([
        { args: { task: "Analyze.", lock_title: true }, catalogAvailable: true, error: "requires a title" },
        { args: { task: "Analyze.", title: "Locked", lock_title: true }, catalogAvailable: false, error: "title storage is unavailable" },
    ])("refuses a lock with no title or no storage: %j", async ({ args, catalogAvailable, error }) => {
        const { createSession } = mockClient();
        const h = activities({
            catalogAvailable,
            turn: async opts => {
                expect(await opts.controlToolBridge.spawnAgent(args)).toContain(error);
                return { type: "completed", content: "done" };
            },
        });
        await h.runTurn("parent");
        expect(createSession).not.toHaveBeenCalled();
    });

    it.each([true, false])("limits the suffix to 100 characters without trimming a long named prefix (lock %j)", async lock_title => {
        mockClient();
        const displayTitle = `Ops: ${"a".repeat(110)}`;
        const h = activities({
            agents: [{ ...agent, title: displayTitle }],
            turn: async opts => {
                await opts.controlToolBridge.spawnAgent({ agent_name: "analyst", title: "z".repeat(110), lock_title });
                await opts.controlToolBridge.spawnAgent({ task: "Analyze.", title: "z".repeat(110), lock_title });
                return { type: "completed", content: "done" };
            },
        });
        await h.runTurn("parent");
        expect(h.catalog.updateSession).toHaveBeenCalledWith("child", expect.objectContaining({ title: `${displayTitle}: ${"z".repeat(100)}` }));
        expect(h.catalog.updateSession).toHaveBeenCalledWith("child", expect.objectContaining({ title: "z".repeat(100) }));
    });

    it("does not bootstrap a child when its requested lock cannot be saved", async () => {
        const { send } = mockClient();
        let answer;
        const h = activities({
            turn: async opts => {
                answer = await opts.controlToolBridge.spawnAgent({ task: "Analyze.", title: "Locked", lock_title: true });
                return { type: "completed", content: "done" };
            },
        });
        const update = h.catalog.updateSession;
        h.catalog.updateSession = vi.fn(async (id, patch) => {
            if ("titleLocked" in patch) throw new Error("title storage rejected the write");
            await update(id, patch);
        });
        await h.runTurn("parent");
        expect(answer).toContain("title storage rejected the write");
        expect(answer).toContain("Child session child already exists; do not repeat this spawn.");
        expect(send).not.toHaveBeenCalled();
    });

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

    it.each(["false", 1, null])("refuses an invalid durable lock %j before creation", async lockTitle => {
        const { createSession } = mockClient();
        const h = activities();
        await expect(h.handlers.spawnChildSession({ traceInfo() {} }, {
            parentSessionId: "parent", config: {}, task: "Analyze.", title: "New", lockTitle,
        })).rejects.toThrow("must be a boolean");
        expect(createSession).not.toHaveBeenCalled();
    });
});

describe("spawn replay payload compatibility", () => {
    function scheduledSpawn(action, handler = handleSubAgentAction) {
        const scheduleActivity = vi.fn((name, input) => ({ name, input }));
        const manager = createSessionManagerProxy({ scheduleActivity });
        const runtime = {
            ctx: { traceInfo() {} }, input: { sessionId: "parent" },
            state: { subAgents: [], config: {} }, options: { nestingLevel: 0 },
            session: { captureSpawnTools: () => ({ name: "captureSpawnTools" }) },
            manager,
        };
        const gen = handler(runtime, { type: "spawn_agent", task: "Analyze.", title: "Old explicit title", ...action });
        let step = gen.next();
        if (handler !== handleHistoricalSubAgentAction) {
            expect(step.value.name).toBe("captureSpawnTools");
            step = gen.next({});
        }
        expect(step.value.name).toBe("spawnChildSession");
        return step.value.input;
    }

    it.each([undefined, { root: "repo", folder: "src" }])("old recorded spawn input stays byte-identical with workspace %j", workspace => {
        const input = scheduledSpawn(workspace ? { workspace } : {});
        const old = scheduledSpawn(workspace ? { workspace } : {}, handleHistoricalSubAgentAction);
        expect(JSON.stringify(input)).toBe(JSON.stringify(old));
        expect(JSON.parse(JSON.stringify(input))).toEqual({
            parentSessionId: "parent",
            config: input.config,
            task: "Analyze.",
            nestingLevel: 1,
            isSystem: false,
            title: "Old explicit title",
            titleIsExplicit: true,
            ...(workspace ? { workspaceChosen: true } : {}),
        });
        expect(input).not.toHaveProperty("lockTitle");
    });

    // Review N1: an explicit `workspace: null` with the lock both on and off, through a JSON round trip. null is
    // the interesting value because the live handler passes positional arguments - [true, lockTitle] for a real
    // workspace record, [undefined, lockTitle] otherwise - and a null in that slot must mean "no workspace
    // chosen", never "attach one". The round trip is the point: the activity input is persisted as JSON, so a
    // property that serializes differently is a replay difference, not a style difference.
    it.each([true, false])("explicit workspace: null serializes identically with lockTitle %s", lockTitle => {
        const input = scheduledSpawn({ workspace: null, lockTitle });
        const roundTripped = JSON.parse(JSON.stringify(input));
        expect(roundTripped, "a null workspace never asks for one to be attached").not.toHaveProperty("workspaceChosen");
        expect(roundTripped.lockTitle, "and the lock still travels").toBe(lockTitle);
        // The same shape the frozen handler would have recorded, apart from the new lock field it never had.
        const old = scheduledSpawn({ workspace: null }, handleHistoricalSubAgentAction);
        const { lockTitle: _dropped, ...withoutLock } = roundTripped;
        expect(JSON.stringify(withoutLock), "everything else is byte-identical to the old recording")
            .toBe(JSON.stringify(JSON.parse(JSON.stringify(old))));
    });

    it("carries the tool's pending action through the live handler and durable activity", async () => {
        const tool = tools();
        await tool.call("spawn_agent", { task: "Analyze.", title: "Persistent task" });
        const input = scheduledSpawn(tool.state.pendingActions[0]);
        expect(input.lockTitle).toBe(true);
        mockClient();
        const h = activities();
        await h.handlers.spawnChildSession({ traceInfo() {} }, input);
        expect(h.catalog.updateSession).toHaveBeenCalledWith(expect.any(String),
            expect.objectContaining({ title: "Persistent task", titleLocked: true }));
    });

    it.each([undefined, { root: "repo", folder: "src" }])("replays a frozen 1.0.84 payload with no lockTitle through the current activity: %j", async workspace => {
        const action = workspace ? { workspace } : {};
        const old = scheduledSpawn(action, handleFrozen84SubAgentAction);
        const replayed = JSON.parse(JSON.stringify(old));
        expect(JSON.stringify(scheduledSpawn(action))).toBe(JSON.stringify(old));
        expect(replayed).not.toHaveProperty("lockTitle");
        expect(JSON.stringify(scheduledSpawn({ ...action, lockTitle: true }, handleFrozen84SubAgentAction)))
            .toBe(JSON.stringify(old));
        mockClient();
        const h = activities();
        const root = workspace ? mkdtempSync(join(tmpdir(), "session-replay-workspace-")) : null;
        try {
            if (root) {
                mkdirSync(join(root, "src"));
                h.sessionManager.getWorkspaceProvider.mockReturnValue({
                    listRoots: async () => [{ name: "repo", path: root }],
                    ensureAttached: async () => ({ ok: true, path: join(root, "src") }),
                });
            }
            await h.handlers.spawnChildSession({ traceInfo() {} }, replayed);
            const patch = h.catalog.updateSession.mock.calls.find(([, value]) => "title" in value)[1];
            expect(patch).toMatchObject({ title: "Old explicit title" });
            expect(patch).not.toHaveProperty("titleLocked");
        } finally {
            if (root) rmSync(root, { recursive: true, force: true });
        }
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

    // The locked path fills the workspace position with undefined when no workspace record is chosen; a durable
    // history stores the input as JSON, so check the stored form, including an explicit workspace: null.
    it.each([
        [{ lockTitle: true }],
        [{ lockTitle: false }],
        [{ workspace: null, lockTitle: true }],
        [{ workspace: null, lockTitle: false }],
        [{ workspace: null }],
    ])("a recorded spawn input survives its JSON round trip with no workspace record: %j", async action => {
        const recorded = JSON.parse(JSON.stringify(scheduledSpawn(action)));
        expect(recorded).not.toHaveProperty("workspaceChosen");
        if (action.lockTitle === undefined) expect(recorded).not.toHaveProperty("lockTitle");
        else expect(recorded.lockTitle).toBe(action.lockTitle);
        mockClient();
        const h = activities();
        await h.handlers.spawnChildSession({ traceInfo() {} }, recorded);
        const patch = h.catalog.updateSession.mock.calls.find(([, value]) => "title" in value)[1];
        expect(patch).toMatchObject({ title: "Old explicit title" });
        if (action.lockTitle === undefined) expect(patch).not.toHaveProperty("titleLocked");
        else expect(patch.titleLocked).toBe(action.lockTitle);
        expect(h.sessionManager.getWorkspaceProvider).not.toHaveBeenCalled();
    });
});

describe("one-shot Copilot tool boundaries", () => {
    it("the production regeneration distiller is created with no runtime tools", async () => {
        const previous = process.env.PILOTSWARM_REGEN_LLM_DISTILLER;
        process.env.PILOTSWARM_REGEN_LLM_DISTILLER = "1";
        const listeners = {};
        const response = {
            mission: "Continue the migration work.", standingInstructions: [], currentState: "Distilled.",
            workingSet: [], commitments: [], childRoster: [], factsMap: [], artifactsMap: [], workspaceMap: [],
            pitfalls: [], openQuestions: [], recentTail: "USER: Continue.",
        };
        const createSession = vi.fn(async () => ({
            id: "ephemeral-distiller",
            on: (name, fn) => { listeners[name] = fn; },
            send: () => {
                listeners["assistant.message"]({ data: { content: JSON.stringify(response) } });
                listeners["session.idle"]();
            },
        }));
        const stop = vi.fn(async () => {});
        const deleteSession = vi.fn(async () => {});
        vi.spyOn(copilotClient, "createCopilotClient").mockReturnValue({
            start: vi.fn(async () => {}), stop, createSession, deleteSession,
        });
        const artifactStore = { listArtifacts: vi.fn(async () => []), uploadArtifact: vi.fn(async () => {}) };
        const catalog = {
            getSessionEventsBefore: vi.fn(async () => []), getSessionEvents: vi.fn(async () => []),
            getDescendantSessionIds: vi.fn(async () => []),
        };
        try {
            await runRegenDistill({
                artifactStore, catalog, trace: vi.fn(),
                resolveModelOptions: vi.fn(() => ({ model: "fixture-model" })),
            }, { sessionId: "source-session", epoch: 1, attemptId: "attempt-1", distillerModel: "fixture:model" });
            expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ availableTools: [] }));
            expect(deleteSession).toHaveBeenCalledWith("ephemeral-distiller");
            expect(stop).toHaveBeenCalledOnce();
        } finally {
            if (previous === undefined) delete process.env.PILOTSWARM_REGEN_LLM_DISTILLER;
            else process.env.PILOTSWARM_REGEN_LLM_DISTILLER = previous;
        }
    });
});
