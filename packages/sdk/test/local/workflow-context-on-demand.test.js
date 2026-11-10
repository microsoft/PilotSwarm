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
 * - A chat whose Workflows are on demand keeps enable_workflows declared once they are on ("already on"): the CLI refuses
 *   a call of a tool it was not declared, which the chat shows as a Failed row (the deployed UX check).
 * - Review RLR-F3: a lasting trigger saves with enable_workflows' revision-checked retry; a save that does not commit
 *   keeps them on and pending, and a later plain turn saves the flag, keeping every other field.
 * - Review RLR-F4: enable_workflows and native-task admission share one fence: closed before the task list is read and
 *   the flag saved, open again after a refusal, closed after a success; a task call already started refuses activation.
 *
 * No database: the catalog is an in-memory stand-in with the capability store's compare-and-set.
 *
 * Run: npx vitest run test/local/workflow-context-on-demand.test.js
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, bindingFingerprintDigest, buildBindingFingerprintInput } from "../../src/session-manager.ts";
import { ManagedSession } from "../../src/managed-session.ts";
import { normalizeCapabilityState, withWorkflowsOn, withWorkspaceLoad } from "../../src/capability-catalog.ts";
import { nextCapabilityState } from "../../src/capability-runtime.ts";
import {
    ENABLE_WORKFLOWS_TOOL_SPEC, WORKFLOW_CONTEXT_STUB, WORKFLOW_INSIDE_GUIDANCE, WORKFLOW_SCHEDULING_HINT, WORKFLOW_SCHEDULING_HINT_OFF, WORKFLOW_SESSION_GUIDANCE,
    WORKFLOW_SKILLS_DIR, WORKFLOW_TEST_MODE_SKILLS_DIR,
} from "../../src/workflow/guidance.ts";

const owner = { provider: "test", subject: "workflow-context-owner", email: null, displayName: null };
const WORKFLOW_TOOLS = ["workflow_definition", "update_workflow", "read_workflow", "send_workflow_input", "respond_session_request"];
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

function fixture({ catalogStorage = true, agentIdentity, sources = [], native = false, handle: makeHandle, workerDefaults = {} } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "ps-workflow-context-"));
    let state = { revision: 0, selections: [] };
    const saves = [];
    // A fault for the next saves: called before the compare-and-set; it may throw, wait, or return false (not committed).
    let fault = null;
    const row = { sessionId: "chat", owner, isSystem: false, parentSessionId: null, rootSessionId: "chat", ...(agentIdentity ? { agentId: agentIdentity } : {}) };
    const catalog = {
        getSession: async id => (id === row.sessionId ? row : null),
        getUserRole: async () => ({ role: "user", seenAt: new Date() }),
        recordEvents: async () => {},
        ...(catalogStorage ? {
            getSessionCapabilities: async () => structuredClone(state),
            saveSessionCapabilities: async (_id, expected, next) => {
                if (fault && await fault(expected, next) === false) return false;
                saves.push(structuredClone(next));
                if (state.revision !== expected) return false;
                state = structuredClone(next);
                return true;
            },
        } : {}),
    };
    const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "legacy base", nativeSubagents: native ? "sync" : "off", getCapabilitySources: () => sources,
        ...workerDefaults }, dir);
    manager.workflowScriptsEnabled = true;
    manager.setSessionCatalog(catalog);
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    const opened = [];
    const open = (kind, config) => {
        mkdirSync(join(dir, config.sessionId), { recursive: true });
        const handle = makeHandle ? makeHandle(config) : { sessionId: config.sessionId, disconnect: vi.fn(async () => {}), registerTools: vi.fn(),
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
    return { manager, opened, saves, turn, get state() { return state; }, set state(value) { state = value; },
        set fault(value) { fault = value; } };
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
        // Still declared, answered "already on": the CLI refuses a call of a tool it was not declared (a Failed row).
        expect(described(on.tools, "enable_workflows")).toMatch(/already on in this chat/);
        expect(on.prompt).toContain(inPrompt(WORKFLOW_SESSION_GUIDANCE.split("\n\n")[1]));
        expect(on.prompt).not.toContain(inPrompt(WORKFLOW_CONTEXT_STUB));
        for (const name of ["cron", "cron_at"]) expect(described(on.tools, name).endsWith(WORKFLOW_SCHEDULING_HINT)).toBe(true);
        // The binding changed with the declarations: the warm handle was replaced, not reused.
        expect(f.opened.at(-2).handle.disconnect).toHaveBeenCalled();
    });

    // Review L3 (per-session memory on TEST): the owns-check is a closure of the runTurn activity, so a saved config that
    // kept it held the whole scope of the session's last turn. It is used once by its turn and kept nowhere.
    it("L3: the owns-check decides its turn and is kept in neither the saved config nor the warm session's", async () => {
        const f = fixture();
        const owns = vi.fn(async () => true);
        const t = await f.turn(0, { workflowContextOwnsCheck: owns });
        expect(t.config.workflowContext).toBe("on");
        expect(owns).toHaveBeenCalledTimes(1);
        expect(f.manager.sessionConfigs.get("chat")).not.toHaveProperty("workflowContextOwnsCheck");
        expect(t.config).not.toHaveProperty("workflowContextOwnsCheck");
        expect(f.manager.sessions.get("chat").config).not.toHaveProperty("workflowContextOwnsCheck");
        // A later turn without one still finds Workflows on (the flag was saved), and calls no stale check.
        expect((await f.turn(1)).config.workflowContext).toBe("on");
        expect(owns).toHaveBeenCalledTimes(1);
    });

    // Review L2 (per-session memory on TEST): what the worker derived for a session's turns is forgotten when it lets the
    // session go (eviction, dehydrate, its end); the next turn sets it again. An in-process client's own config is kept
    // until the session ends.
    it("L2: eviction and dehydrate forget the turn config, prompt digests and the owns-none cache, keep the client's config; the session's end forgets it too", async () => {
        const f = fixture();
        const hooks = { onPreToolUse: vi.fn() };
        f.manager.setConfig("chat", { hooks });
        const owns = vi.fn(async () => false);
        const letGoes = [
            ["eviction", async () => {
                rmSync(join(f.manager.sessionStateDir, "chat"), { recursive: true, force: true });
                f.manager.sessionLastTouchedAt.set("chat", Date.now() - 60_000);
                expect(await f.manager.sweepIdleSessions(1_000)).toBe(1);
            }],
            ["dehydrate", async () => f.manager.dehydrate("chat", "l2-check")],
        ];
        for (const [index, [label, letGo]] of letGoes.entries()) {
            // Turn 0 each time: the fake client creates the session afresh (an evicted one has no files here to resume).
            const t = await f.turn(0, { workflowContextOwnsCheck: owns });
            expect(t.config.workflowContext, label).toBe("off");
            expect(t.config.hooks, label).toBe(hooks);
            expect(owns, label).toHaveBeenCalledTimes(index + 1);
            f.manager.promptSectionDigests.set("chat", { base: { sha: "abc", chars: 3 } });
            expect(f.manager.sessionConfigs.has("chat"), label).toBe(true);
            expect(f.manager.workflowContextOwnsNone.has("chat"), label).toBe(true);
            await letGo();
            expect(f.manager.sessionConfigs.has("chat"), label).toBe(false);
            expect(f.manager.promptSectionDigests.has("chat"), label).toBe(false);
            expect(f.manager.workflowContextOwnsNone.has("chat"), label).toBe(false);
            expect(f.manager.clientSessionConfigs.get("chat"), label).toEqual({ hooks });
        }
        // The next turn sets them again: the client's hooks are its base, and the owns-check is read again.
        const again = await f.turn(0, { workflowContextOwnsCheck: owns });
        expect(again.config.hooks).toBe(hooks);
        expect(owns).toHaveBeenCalledTimes(3);
        expect(f.manager.sessionConfigs.has("chat")).toBe(true);
        // The session's end forgets the client's config too.
        await f.manager.destroySession("chat");
        expect(f.manager.sessionConfigs.has("chat")).toBe(false);
        expect(f.manager.clientSessionConfigs.has("chat")).toBe(false);
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

    it("inside a Workflow: the inside guidance, and cron and cron_at without the Workflow hint (no Workflow starts there)", async () => {
        const f = fixture();
        const inside = await f.turn(0, { workflowInsideWorkflow: true, workflowAgentChild: true });
        expect(inside.prompt).toContain(inPrompt(WORKFLOW_INSIDE_GUIDANCE));
        for (const name of ["cron", "cron_at"]) {
            expect(described(inside.tools, name)).not.toContain(WORKFLOW_SCHEDULING_HINT);
            expect(described(inside.tools, name)).not.toContain(WORKFLOW_SCHEDULING_HINT_OFF);
        }
        const chat = await fixture().turn(0);
        expect(chat.prompt).not.toContain(inPrompt(WORKFLOW_INSIDE_GUIDANCE));
    });

    it("Agent Smith has them on; the read-only tuner gets neither the paragraph nor enable_workflows", async () => {
        const smith = fixture({ agentIdentity: "agent-manager" });
        const smithTurn = await smith.turn(0);
        expect(smithTurn.config.workflowContext).toBe("on");
        expect(smithTurn.names).not.toContain("enable_workflows");
        const tuner = fixture({ agentIdentity: "agent-tuner" });
        const t = await tuner.turn(0);
        expect(t.config.workflowContext).toBe("none");
        expect(none(t.names, ["enable_workflows", ...WORKFLOW_TOOLS])).toBe(true);
        expect(t.prompt).not.toContain("## Workflows");
        await expect(t.config.capabilityServices.enableWorkflows()).rejects.toThrow(/restricted session/);
    });
});

describe("Workflows on demand: the V2 skills index", () => {
    // The Workflow skills, as worker.ts registers them: a static source, not listed while Workflows are off.
    const WORKFLOW_SKILLS = { id: "static:workflow-skills", name: "PilotSwarm Workflow skills", source: "static", scope: "shared", revision: "r1",
        unlisted: true, tools: new Map(), mcpServers: {}, artifacts: [
            { kind: "skill", name: "workflow-authoring", description: "Load before you create a Workflow.", body: "BODY" },
            { kind: "skill", name: "workflow-tools", description: "Every argument of the Workflow tools.", body: "BODY" }] };
    const OTHER = { id: "static:canvas", name: "Canvas", source: "static", scope: "shared", revision: "r1", tools: new Map(), mcpServers: {},
        artifacts: [{ kind: "skill", name: "canvas-apps", description: "Canvas apps.", body: "BODY" }] };
    // The V2 index is the turn's dynamic section (config.baseV2CapabilityIndex), added to the prompt each turn.
    const indexOf = shown => shown.config.baseV2CapabilityIndex ?? "";

    it("off: the index does not list the Workflow skills (search and load still find them); on: it lists them", async () => {
        // Base Agent V2 (its index) comes with native tasks.
        const off = fixture({ sources: [WORKFLOW_SKILLS, OTHER], native: true });
        const shown = await off.turn(0);
        expect(shown.config.baseAgentPolicy?.version).toBe("v2");
        expect(indexOf(shown)).toContain("canvas-apps");
        expect(indexOf(shown)).not.toContain("workflow-authoring");
        const found = await shown.config.capabilityServices.search({ query: "workflow authoring", kinds: ["skill"] });
        expect(found.capabilities.map(item => item.name)).toContain("workflow-authoring");
        await shown.config.capabilityServices.enableWorkflows();
        const on = await off.turn(1);
        expect(on.config.workflowContext).toBe("on");
        expect(indexOf(on)).toContain("workflow-authoring");
        expect(indexOf(on)).toContain("workflow-tools");
    });
});

describe("Workflows on demand: the CLI's skill directories (its own `skill` tool)", () => {
    // As worker.ts gives them: the Workflow skill directories (_loadSdkSkillDir; test-mode ones with test mode) and a
    // deployment's own, to Base V1 (skillDirectories) and Base V2 (getBaseV2SkillDirectories).
    const OTHER = "/deployment/skills";
    const dirs = [WORKFLOW_SKILLS_DIR, WORKFLOW_TEST_MODE_SKILLS_DIR, OTHER];
    const workerDefaults = { skillDirectories: dirs, getBaseV2SkillDirectories: () => dirs };
    const given = f => f.opened.at(-1).config.skillDirectories;

    for (const native of [false, true]) {
        it(`Base ${native ? "V2" : "V1"}: off, the CLI is not given the Workflow skill directories; on, it is, on a fresh handle`, async () => {
            const f = fixture({ native, workerDefaults });
            const off = await f.turn(0);
            expect(off.config.workflowContext).toBe("off");
            expect(off.config.baseAgentPolicy?.version ?? "v1").toBe(native ? "v2" : "v1");
            expect(given(f)).toEqual([OTHER]);
            await off.config.capabilityServices.enableWorkflows();
            const before = f.opened.length;
            const on = await f.turn(1);
            expect(on.config.workflowContext).toBe("on");
            expect(given(f)).toEqual(dirs);
            expect(f.opened.length).toBe(before + 1);
            expect(f.opened.at(-2).handle.disconnect).toHaveBeenCalled();
        });
    }

    it("on in Agent Smith and inside a Workflow; never in the read-only tuner", async () => {
        const smith = fixture({ agentIdentity: "agent-manager", workerDefaults });
        await smith.turn(0);
        expect(given(smith)).toEqual(dirs);
        const inside = fixture({ workerDefaults });
        await inside.turn(0, { workflowInsideWorkflow: true, workflowAgentChild: true });
        expect(given(inside)).toEqual(dirs);
        const tuner = fixture({ agentIdentity: "agent-tuner", workerDefaults });
        expect((await tuner.turn(0)).config.workflowContext).toBe("none");
        expect(given(tuner)).toEqual([OTHER]);
    });

    it("the Workflow skill directories are part of a Base V1 chat's handle identity (V2's skill directories already are)", () => {
        const parts = { capabilityFingerprint: "cap", baseAgentPolicy: "v1", sdkSkillDirectories: [OTHER], boundAgentName: undefined,
            boundAgentSource: undefined, boundAgentCopy: undefined, mcpServers: {}, excludedTools: ["task"], tools: [{ name: "wait" }] };
        const off = buildBindingFingerprintInput(parts);
        expect(Object.hasOwn(off, "workflowSkillDirectories")).toBe(false);
        expect(Object.hasOwn(buildBindingFingerprintInput({ ...parts, workflowSkillDirectories: [] }), "workflowSkillDirectories")).toBe(false);
        const on = buildBindingFingerprintInput({ ...parts, workflowSkillDirectories: [WORKFLOW_SKILLS_DIR] });
        expect(on.workflowSkillDirectories).toEqual([WORKFLOW_SKILLS_DIR]);
        expect(bindingFingerprintDigest(on)).not.toBe(bindingFingerprintDigest(off));
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
                if (call.emit) { this.emit(...call.emit); continue; }
                const tool = this.registeredTools.find(item => item.name === call.name);
                this.results.push(await tool.handler(call.args ?? {}, { sessionId: this.sessionId }));
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

describe("Workflows on demand: an automatic save that does not commit (review RLR-F3)", () => {
    const SELECTION_STATE = () => {
        const used = nextCapabilityState({ revision: 4, selections: [] }, "src", { source_ref: "cap1.src", tools: ["lookup"], expected_revision: 4, request_id: "r-1" });
        return { ...used.state, loads: [{ kind: "skill", name: "notes", root: "home", path: "users/a/notes" }] };
    };
    const otherLoad = n => ({ kind: "skill", name: `other-${n}`, root: "home", path: `users/a/other-${n}` });

    for (const how of ["throws once", "loses every revision check to another writer"]) {
        it(`a lasting trigger whose save ${how}: the next plain turns stay on and save the flag, keeping every other field`, async () => {
            const f = fixture();
            f.state = SELECTION_STATE();
            const owns = vi.fn(async () => false);
            // A plain turn: the chat owns no definition; that is kept.
            expect((await f.turn(0, { workflowContextOwnsCheck: owns })).config.workflowContext).toBe("off");
            expect(owns).toHaveBeenCalledTimes(1);
            // The person saved a definition: its note is a lasting trigger. The save does not commit.
            const others = [];
            if (how === "throws once") {
                let thrown = false;
                f.fault = async () => { if (!thrown) { thrown = true; throw new Error("connection reset"); } };
            } else {
                // Another writer commits first every time (a load by path), so each compare-and-set fails.
                f.fault = async () => {
                    const load = otherLoad(others.length + 1);
                    others.push(load);
                    f.state = { ...f.state, revision: f.state.revision + 1, loads: [...f.state.loads, load] };
                    return false;
                };
            }
            const noted = await f.turn(1, { workflowContextTrigger: "lasting", workflowContextOwnsCheck: owns });
            expect(noted.config.workflowContext).toBe("on");
            expect(f.state.workflows).toBeUndefined();
            if (how !== "throws once") f.fault = null;
            // The note was consumed with that turn: the next turn has no trigger, and the chat's cached "owns none" is gone.
            expect(f.manager.workflowContextOwnsNone.has("chat")).toBe(false);
            const plain = await f.turn(2, { workflowContextOwnsCheck: owns });
            expect(plain.config.workflowContext).toBe("on");
            expect(has(plain.names, ["workflow_definition", "update_workflow", "read_workflow"])).toBe(true);
            expect(f.state.workflows).toBe(true);
            const expected = SELECTION_STATE();
            expect(f.state.selections).toEqual(expected.selections);
            expect(f.state.requests).toEqual(expected.requests);
            expect(f.state.loads).toEqual([...expected.loads, ...others]);
            // Saved: later turns are on from the flag, with no further save.
            const saves = f.saves.length;
            expect((await f.turn(3, { workflowContextOwnsCheck: owns })).config.workflowContext).toBe("on");
            expect(f.saves).toHaveLength(saves);
        });
    }

    it("a lasting trigger's save retries a lost revision check on the state read again", async () => {
        const f = fixture();
        f.state = SELECTION_STATE();
        let lost = false;
        f.fault = async () => {
            if (lost) return true;
            lost = true;
            f.state = { ...f.state, revision: f.state.revision + 1, loads: [...f.state.loads, otherLoad(1)] };
            return false;
        };
        expect((await f.turn(0, { workflowContextTrigger: "lasting" })).config.workflowContext).toBe("on");
        expect(f.state.workflows).toBe(true);
        expect(f.state.loads).toEqual([...SELECTION_STATE().loads, otherLoad(1)]);
        expect(f.state.selections).toEqual(SELECTION_STATE().selections);
    });
});

describe("enable_workflows and native-task admission share one fence (review RLR-F4)", () => {
    const TASK = { toolName: "task", toolArgs: { name: "probe", agent_type: "swarm-task", mode: "sync", description: "Run the tests", prompt: "Run the tests" } };
    // The native-task hook as the session manager wired it into the chat's CLI session (nativeSubagentHooks).
    const admit = (f, sessionId = "chat") => f.opened.at(-1).config.hooks.onPreToolUse({ ...TASK, sessionId, timestamp: new Date(), workingDirectory: "/" }, { sessionId });
    const admitted = decision => decision?.permissionDecision !== "deny" && decision?.modifiedArgs?.mode === "sync";
    const chatSession = calls => {
        const holder = {};
        return { holder, handle: config => {
            const session = new TurnSession(calls);
            session.sessionId = config.sessionId;
            holder.session = session;
            return session;
        } };
    };

    it("a task asked for while activation saves is refused, and after it; one flag write, one continuation, no task cancelled", async () => {
        const { holder, handle } = chatSession([{ name: "enable_workflows" }]);
        const f = fixture({ native: true, handle });
        await f.turn(0);
        const managed = f.manager.sessions.get("chat");
        expect(admitted(await admit(f))).toBe(true);
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        let saving;
        const started = new Promise(resolve => { saving = resolve; });
        f.fault = async () => { saving(); await gate; };
        const running = managed.runTurn("watch the build every minute");
        await started;
        // Activation read the task list (empty) and waits on its save: settle (2 reads), then activation's own.
        expect(holder.session.rpc.tasks.list).toHaveBeenCalledTimes(3);
        expect((await admit(f)).permissionDecision).toBe("deny");
        release();
        const result = await running;
        expect((await admit(f)).permissionDecision).toBe("deny");
        expect(result).toMatchObject({ type: "completed", content: "Workflows turned on in this chat." });
        expect(result.forceContinuePrompt).toMatch(/^Workflows are now on in this chat/);
        expect(result.queuedActions ?? []).toEqual([]);
        expect(f.saves).toHaveLength(1);
        expect(f.state.workflows).toBe(true);
        expect(holder.session.rpc.tasks.cancel).not.toHaveBeenCalled();
        expect(holder.session.rpc.tasks.remove).not.toHaveBeenCalled();
        // Turn end settled once (2 reads): no cleanup retry.
        expect(holder.session.rpc.tasks.list).toHaveBeenCalledTimes(5);
    });

    it("a task call already started (its admission may be in progress, the task not yet listed) refuses activation; the fence opens again", async () => {
        const { holder, handle } = chatSession([
            { emit: ["tool.execution_start", { toolCallId: "task-1", toolName: "task", arguments: TASK.toolArgs }] },
            { name: "enable_workflows" },
        ]);
        const f = fixture({ native: true, handle });
        await f.turn(0);
        const result = await f.manager.sessions.get("chat").runTurn("watch the build every minute");
        expect(holder.session.results[0]).toMatch(/finish native tasks before turning Workflows on/);
        expect(result.forceContinuePrompt).toBeUndefined();
        expect(f.saves).toEqual([]);
        expect(admitted(await admit(f))).toBe(true);
    });

    it("two calls in one response (run at the same time): one activation, one continuation", async () => {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const enable = vi.fn(async () => { await gate; return { changed: true, revision: 1 }; });
        const session = new TurnSession([]);
        session.send = async () => {
            queueMicrotask(async () => {
                const tool = session.registeredTools.find(item => item.name === "enable_workflows");
                const both = Promise.all([tool.handler({}, { sessionId: session.sessionId }), tool.handler({}, { sessionId: session.sessionId })]);
                release();
                session.results.push(...await both);
                session.emit("session.idle");
            });
        };
        const managed = new ManagedSession("turn-session", session, { workflowContext: "off", capabilityServices: services(enable) });
        const result = await managed.runTurn("watch it");
        expect(enable).toHaveBeenCalledOnce();
        expect(session.results.filter(text => String(text).startsWith('{"workflows":"on"}'))).toHaveLength(1);
        expect(session.results.some(text => /earlier enable_workflows call in this turn/.test(String(text)))).toBe(true);
        expect(result.forceContinuePrompt).toMatch(/^Workflows are now on/);
        expect(result.queuedActions ?? []).toEqual([]);
    });
});
