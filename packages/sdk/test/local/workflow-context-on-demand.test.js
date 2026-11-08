/**
 * Workflows on demand (owner 2026-11-08T16:55Z): a chat carries the Workflow tools and guidance only when they are on in it.
 *
 * - Off (a chat's default on a 1.0.83 turn): a short paragraph and enable_workflows in place of the guidance and the
 *   Workflow tools; cron and cron_at point to enable_workflows.
 * - enable_workflows saves the chat's flag (with its capability state, revision-checked) and ends the turn; the turn's
 *   result carries the continuation, so the next turn starts at once, on a fresh binding, with the Workflow tools.
 * - On without asking: a saved flag; a lasting trigger (saved too); a trigger that could not be read (this turn only); a
 *   chat that owns a definition or a Workflow (saved; a chat that owns none is not read again); a session inside a
 *   Workflow; Agent Smith; a frozen 1.0.82 turn; a session manager without durable capability storage.
 * - None: the read-only tuner and service sessions get neither the paragraph nor enable_workflows.
 *
 * No database: the catalog is an in-memory stand-in with the capability store's compare-and-set.
 *
 * Run: npx vitest run test/local/workflow-context-on-demand.test.js
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../src/session-manager.ts";
import { ManagedSession } from "../../src/managed-session.ts";
import { normalizeCapabilityState, withWorkflowsOn, withWorkspaceLoad } from "../../src/capability-catalog.ts";
import { nextCapabilityState } from "../../src/capability-runtime.ts";
import {
    ENABLE_WORKFLOWS_TOOL_SPEC, WORKFLOW_CONTEXT_STUB, WORKFLOW_SCHEDULING_HINT, WORKFLOW_SCHEDULING_HINT_OFF, WORKFLOW_SESSION_GUIDANCE,
} from "../../src/workflow/guidance.ts";

const owner = { provider: "test", subject: "workflow-context-owner", email: null, displayName: null };
const WORKFLOW_TOOLS = ["workflow_definition", "update_workflow", "read_workflow", "send_workflow_input", "respond_session_request"];
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

function fixture({ catalogStorage = true, agentIdentity } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "ps-workflow-context-"));
    let state = { revision: 0, selections: [] };
    const saves = [];
    const row = { sessionId: "chat", owner, isSystem: false, parentSessionId: null, rootSessionId: "chat", ...(agentIdentity ? { agentId: agentIdentity } : {}) };
    const catalog = {
        getSession: async id => (id === row.sessionId ? row : null),
        getUserRole: async () => ({ role: "user", seenAt: new Date() }),
        recordEvents: async () => {},
        ...(catalogStorage ? {
            getSessionCapabilities: async () => structuredClone(state),
            saveSessionCapabilities: async (_id, expected, next) => {
                saves.push(structuredClone(next));
                if (state.revision !== expected) return false;
                state = structuredClone(next);
                return true;
            },
        } : {}),
    };
    const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "legacy base", nativeSubagents: "off", getCapabilitySources: () => [] }, dir);
    manager.workflowScriptsEnabled = true;
    manager.setSessionCatalog(catalog);
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    const opened = [];
    const open = (kind, config) => {
        mkdirSync(join(dir, config.sessionId), { recursive: true });
        const handle = { sessionId: config.sessionId, disconnect: vi.fn(async () => {}), registerTools: vi.fn(),
            rpc: { tasks: { list: vi.fn(async () => ({ tasks: [] })) } } };
        opened.push({ kind, config, handle });
        return handle;
    };
    manager.ensureClient = async () => ({ createSession: async config => open("create", config),
        resumeSession: async (_id, config) => open("resume", config), deleteSession: async () => {} });
    cleanup.push(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        rmSync(dir, { recursive: true, force: true });
    });
    const turn = async (index, extra = {}) => {
        const session = await manager.getOrCreate(row.sessionId, { model: "gpt-test", workflowMilestoneTurn: true,
            ...(agentIdentity ? { agentIdentity } : {}), ...extra }, { turnIndex: index });
        const last = opened.at(-1).config;
        return { config: session.config, names: last.tools.map(tool => tool.name), tools: last.tools, prompt: JSON.stringify(last.systemMessage ?? null) };
    };
    return { manager, opened, saves, turn, get state() { return state; }, set state(value) { state = value; } };
}

const has = (names, list) => list.every(name => names.includes(name));
const none = (names, list) => list.every(name => !names.includes(name));
const described = (tools, name) => tools.find(tool => tool.name === name)?.description ?? "";
const inPrompt = text => JSON.stringify(text).slice(1, -1);

describe("Workflows on demand: declarations and instructions", () => {
    it("off by default on a 1.0.83 turn: the paragraph and enable_workflows, no Workflow tool or guidance, cron points to enable_workflows", async () => {
        const f = fixture();
        const t = await f.turn(0);
        expect(t.config.workflowContext).toBe("off");
        expect(t.names).toContain("enable_workflows");
        expect(none(t.names, [...WORKFLOW_TOOLS, "spawn_workflow"])).toBe(true);
        expect(t.prompt).toContain(inPrompt(WORKFLOW_CONTEXT_STUB));
        expect(t.prompt).not.toContain(inPrompt(WORKFLOW_SESSION_GUIDANCE.split("\n\n")[1]));
        for (const name of ["cron", "cron_at"]) expect(described(t.tools, name).endsWith(WORKFLOW_SCHEDULING_HINT_OFF)).toBe(true);
        // The paragraph and the tool together stay under 1,000 characters.
        const enable = t.tools.find(tool => tool.name === "enable_workflows");
        expect(WORKFLOW_CONTEXT_STUB.length + enable.description.length + JSON.stringify(enable.parameters).length).toBeLessThanOrEqual(1000);
        expect(f.saves).toEqual([]);
    });

    it("enable_workflows saves the flag once, keeps the rest of the state, and the next turn binds afresh with the Workflow tools", async () => {
        const f = fixture();
        f.state = { revision: 3, selections: [], loads: [{ kind: "skill", name: "notes", root: "home", path: "users/a/notes" }] };
        const off = await f.turn(0);
        const service = off.config.capabilityServices;
        expect(await service.enableWorkflows()).toEqual({ changed: true, revision: 4 });
        expect(f.state).toEqual({ revision: 4, selections: [], loads: [{ kind: "skill", name: "notes", root: "home", path: "users/a/notes" }], workflows: true });
        expect(await service.enableWorkflows()).toEqual({ changed: false, revision: 4 });
        expect(f.saves).toHaveLength(1);
        const before = f.opened.length;
        const on = await f.turn(1);
        expect(on.config.workflowContext).toBe("on");
        expect(f.opened.length).toBe(before + 1);
        expect(has(on.names, ["workflow_definition", "update_workflow", "read_workflow", "send_workflow_input", "respond_session_request"])).toBe(true);
        expect(on.names).not.toContain("enable_workflows");
        expect(on.prompt).toContain(inPrompt(WORKFLOW_SESSION_GUIDANCE.split("\n\n")[1]));
        expect(on.prompt).not.toContain(inPrompt(WORKFLOW_CONTEXT_STUB));
        for (const name of ["cron", "cron_at"]) expect(described(on.tools, name).endsWith(WORKFLOW_SCHEDULING_HINT)).toBe(true);
        // The binding changed with the declarations: the warm handle was replaced, not reused.
        expect(f.opened.at(-2).handle.disconnect).toHaveBeenCalled();
    });

    it("a lasting trigger turns them on and saves the flag; a trigger that could not be read turns them on for this turn only", async () => {
        const lasting = fixture();
        expect((await lasting.turn(0, { workflowContextTrigger: "lasting" })).config.workflowContext).toBe("on");
        expect(lasting.state.workflows).toBe(true);
        expect((await lasting.turn(1)).config.workflowContext).toBe("on");
        const once = fixture();
        expect((await once.turn(0, { workflowContextTrigger: "turn" })).config.workflowContext).toBe("on");
        expect(once.state.workflows).toBeUndefined();
        expect((await once.turn(1)).config.workflowContext).toBe("off");
    });

    it("a chat that owns a definition or a Workflow turns them on and saves; one that owns none is not read again; a failed read is on", async () => {
        const owns = fixture();
        const yes = vi.fn(async () => true);
        expect((await owns.turn(0, { workflowContextOwnsCheck: yes })).config.workflowContext).toBe("on");
        expect(owns.state.workflows).toBe(true);
        const nothing = fixture();
        const no = vi.fn(async () => false);
        expect((await nothing.turn(0, { workflowContextOwnsCheck: no })).config.workflowContext).toBe("off");
        expect((await nothing.turn(1, { workflowContextOwnsCheck: no })).config.workflowContext).toBe("off");
        expect(no).toHaveBeenCalledTimes(1);
        const failing = fixture();
        const broken = vi.fn(async () => { throw new Error("store unavailable"); });
        expect((await failing.turn(0, { workflowContextOwnsCheck: broken })).config.workflowContext).toBe("on");
        expect(failing.state.workflows).toBeUndefined();
        expect((await failing.turn(1, { workflowContextOwnsCheck: broken })).config.workflowContext).toBe("on");
        expect(broken).toHaveBeenCalledTimes(2);
    });

    it("on without a save: inside a Workflow, an agent node's chat, a frozen 1.0.82 turn, no durable capability storage", async () => {
        for (const extra of [{ workflowInsideWorkflow: true }, { workflowAgentChild: true }, { workflowMilestoneTurn: false }]) {
            const f = fixture();
            const t = await f.turn(0, extra);
            expect(t.config.workflowContext, JSON.stringify(extra)).toBe("on");
            expect(t.names).not.toContain("enable_workflows");
            expect(f.saves).toEqual([]);
        }
        const standalone = fixture({ catalogStorage: false });
        expect((await standalone.turn(0)).config.workflowContext).toBe("on");
    });

    it("Agent Smith has them on; the read-only tuner gets neither the paragraph nor enable_workflows", async () => {
        const smith = fixture({ agentIdentity: "agent-manager" });
        expect((await smith.turn(0)).config.workflowContext).toBe("on");
        const tuner = fixture({ agentIdentity: "agent-tuner" });
        const t = await tuner.turn(0);
        expect(t.config.workflowContext).toBe("none");
        expect(none(t.names, ["enable_workflows", ...WORKFLOW_TOOLS])).toBe(true);
        expect(t.prompt).not.toContain("## Workflows");
        await expect(t.config.capabilityServices.enableWorkflows()).rejects.toThrow(/restricted session/);
    });
});

describe("Workflows on demand: the capability state", () => {
    it("the flag survives normalizing, a package change and a load by path; anything but a boolean is refused", () => {
        const on = withWorkflowsOn({ revision: 2, selections: [] });
        expect(on).toEqual({ revision: 3, selections: [], workflows: true });
        expect(withWorkflowsOn(on)).toBe(on);
        expect(normalizeCapabilityState(on)).toEqual(on);
        expect(normalizeCapabilityState({ revision: 1, selections: [], workflows: false })).toEqual({ revision: 1, selections: [] });
        expect(() => normalizeCapabilityState({ revision: 1, selections: [], workflows: "yes" })).toThrow(/workflows flag/);
        const used = nextCapabilityState(on, "src", { source_ref: "cap1.src", tools: ["lookup"], expected_revision: 3, request_id: "r-1" });
        expect(used.state.workflows).toBe(true);
        const loaded = withWorkspaceLoad(on, { add: { kind: "skill", name: "notes", root: "home", path: "users/a/notes" } });
        expect(loaded.workflows).toBe(true);
    });
});

class TurnSession {
    sessionId = "turn-session";
    registeredTools = [];
    listeners = new Map();
    catchAll = [];
    results = [];
    constructor(calls, tasks = []) {
        this.calls = calls;
        this.rpc = { tasks: { list: vi.fn(async () => ({ tasks })), cancel: vi.fn(async () => {}), remove: vi.fn(async () => {}) } };
    }
    registerTools(tools) { this.registeredTools = tools; }
    on(eventType, handler) {
        if (typeof eventType === "function") {
            this.catchAll.push(eventType);
            return () => { this.catchAll = this.catchAll.filter(item => item !== eventType); };
        }
        const handlers = this.listeners.get(eventType) ?? [];
        handlers.push(handler);
        this.listeners.set(eventType, handlers);
        return () => this.listeners.set(eventType, (this.listeners.get(eventType) ?? []).filter(item => item !== handler));
    }
    emit(type, data = {}) {
        for (const handler of this.catchAll) handler({ type, data });
        for (const handler of this.listeners.get(type) ?? []) handler({ data });
    }
    async send() {
        queueMicrotask(async () => {
            for (const call of this.calls) {
                const tool = this.registeredTools.find(item => item.name === call.name);
                this.results.push(await tool.handler(call.args ?? {}, { sessionId: "turn-session" }));
            }
            this.emit("assistant.message", { content: "model tried to continue" });
            this.emit("session.idle");
        });
    }
    abort() {}
    async disconnect() {}
}

const services = enableWorkflows => ({ use: vi.fn(), search: vi.fn(async () => ({ capabilities: [] })), load: vi.fn(), list: vi.fn(), enableWorkflows });

describe("enable_workflows in a turn", () => {
    it("turns them on, blocks later tools in the turn, and returns the automatic continuation", async () => {
        const enable = vi.fn(async () => ({ changed: true, revision: 1 }));
        const session = new TurnSession([{ name: "enable_workflows" }, { name: "search_capabilities", args: { query: "later" } }]);
        const managed = new ManagedSession("turn-session", session, { workflowContext: "off", capabilityServices: services(enable) });
        const result = await managed.runTurn("watch the build every minute");
        expect(enable).toHaveBeenCalledOnce();
        expect(session.results[0]).toMatch(/^\{"workflows":"on"\}\n\[SYSTEM: enable_workflows acknowledged/);
        expect(session.results[1]).toMatch(/not executed.*previous control tool/i);
        expect(result).toMatchObject({ type: "completed", content: "Workflows turned on in this chat." });
        expect(result.forceContinuePrompt).toMatch(/^Workflows are now on in this chat/);
        expect(ENABLE_WORKFLOWS_TOOL_SPEC.description).toMatch(/continues your task/);
    });

    it("is idempotent where they are on: nothing is saved and the turn goes on", async () => {
        const enable = vi.fn(async () => ({ changed: false, revision: 1 }));
        const session = new TurnSession([{ name: "enable_workflows" }]);
        const managed = new ManagedSession("turn-session", session, { workflowContext: "on", capabilityServices: services(enable) });
        const result = await managed.runTurn("again");
        expect(enable).not.toHaveBeenCalled();
        expect(session.results[0]).toMatch(/already on in this chat/);
        expect(result).toMatchObject({ type: "completed", content: "model tried to continue" });
        expect(result.forceContinuePrompt).toBeUndefined();
    });

    it("is refused while a native task runs, and without durable storage", async () => {
        const enable = vi.fn(async () => ({ changed: true, revision: 1 }));
        const tasks = [{ id: "native-1", type: "agent", status: "running" }];
        const session = new TurnSession([{ name: "enable_workflows" }], tasks);
        session.rpc.tasks.list
            .mockResolvedValueOnce({ tasks: [] })
            .mockResolvedValueOnce({ tasks: [] })
            .mockResolvedValueOnce({ tasks })
            .mockResolvedValue({ tasks: [] });
        const managed = new ManagedSession("turn-session", session, { workflowContext: "off", nativeSubagents: "sync", capabilityServices: services(enable) });
        const result = await managed.runTurn("watch it");
        expect(enable).not.toHaveBeenCalled();
        expect(session.results[0]).toMatch(/finish native tasks before turning Workflows on/);
        expect(result.forceContinuePrompt).toBeUndefined();
        const bare = new TurnSession([{ name: "enable_workflows" }]);
        await new ManagedSession("turn-session", bare, { workflowContext: "off" }).runTurn("watch it");
        expect(bare.results[0]).toBe("Error: Workflows cannot be turned on in this session.");
    });
});
