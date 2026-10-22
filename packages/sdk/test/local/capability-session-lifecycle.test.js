import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PilotSwarmWorker } from "../../src/worker.ts";
import { SessionManager } from "../../src/session-manager.ts";
import { ManagedSession } from "../../src/managed-session.ts";
import { capabilityRef } from "../../src/capability-catalog.ts";

const owner = { provider: "test", subject: "capability-owner", email: null, displayName: null };
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

function packageSource() {
    const packageTool = { name: "package_lookup", description: "Look up package data", parameters: { type: "object" },
        handler: vi.fn(async () => "package-result") };
    return { id: "package-id", name: "incident-kit", source: "published", revision: "sha-1", scope: "user", owner,
        packageId: "package-id", artifacts: [
            { kind: "tool", name: packageTool.name, description: packageTool.description },
            { kind: "mcp", name: "package_mcp", description: "Package MCP" },
        ], tools: new Map([[packageTool.name, packageTool]]),
        mcpServers: { package_mcp: { type: "http", url: "https://example.test/mcp", tools: ["read"] } } };
}

async function fixture({ child = false, workerFactory, config: bindingConfig = {} } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "ps-capability-lifecycle-"));
    const worker = workerFactory?.(dir);
    const source = worker
        ? worker._getCapabilitySources().find(source => source.mcpServers.restricted_mcp)
        : packageSource();
    let state = { revision: 0, selections: [] };
    const row = { sessionId: "capability-session", owner, isSystem: false,
        parentSessionId: child ? "parent-session" : null, rootSessionId: child ? "parent-session" : "capability-session" };
    const rows = new Map([[row.sessionId, row], ["parent-session", { ...row, sessionId: "parent-session", parentSessionId: null }]]);
    const catalog = {
        getSession: async id => rows.get(id) ?? null,
        getUserRole: async () => ({ role: "user", seenAt: new Date() }),
        recordEvents: async () => {},
        getSessionCapabilities: async () => structuredClone(state),
        saveSessionCapabilities: async (_id, expected, next) => {
            if (state.revision !== expected) return false;
            state = structuredClone(next);
            return true;
        },
    };
    const manager = worker?.sessionManager ?? new SessionManager(undefined, null, {
        frameworkBasePrompt: "legacy base", nativeSubagents: "off", getCapabilitySources: () => [source],
    }, dir);
    manager.setSessionCatalog(catalog);
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    const opened = [];
    const open = config => {
        mkdirSync(join(worker?.config.sessionStateDir ?? dir, config.sessionId), { recursive: true });
        const handle = { sessionId: config.sessionId, disconnect: vi.fn(async () => {}), registerTools: vi.fn(),
            rpc: { tasks: { list: vi.fn(async () => ({ tasks: [] })) } } };
        opened.push({ config, handle });
        return handle;
    };
    manager.ensureClient = async () => ({ createSession: async config => open(config),
        resumeSession: async (_id, config) => open(config), deleteSession: async () => {} });
    cleanup.push(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        rmSync(dir, { recursive: true, force: true });
    });
    return { manager, opened, source, row, get state() { return state; }, async turn(index) {
        return manager.getOrCreate(row.sessionId, { model: "gpt-test", ...bindingConfig }, { turnIndex: index });
    } };
}

function restrictedWorker(dir, { allowedAgents, namespace = "fixture", name = "analyst", packageCopies = false }) {
    function plugin(folder, pluginNamespace, agentName, mcp) {
        const pluginDir = join(dir, folder);
        mkdirSync(join(pluginDir, "agents"), { recursive: true });
        writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: pluginNamespace, version: "1.0.0" }));
        writeFileSync(join(pluginDir, "agents", `${agentName}.agent.md`),
            `---\nschemaVersion: 2\nversion: 1.0.0\nname: ${agentName}\nmcpServers: []\ninheritDefaultMcpServers: false\n---\nSynthetic capability agent.\n`);
        if (mcp) writeFileSync(join(pluginDir, ".mcp.json"), JSON.stringify(mcp));
        return pluginDir;
    }
    const base = plugin("deployment", namespace, name, {
        restricted_mcp: { type: "http", url: "https://example.test/mcp", tools: ["read"], default: false, allowedAgents },
    });
    const modelProvidersPath = join(dir, "models.json");
    writeFileSync(modelProvidersPath, JSON.stringify({ providers: [
        { id: "fixture", type: "openai", baseUrl: "https://example.test/v1", apiKey: "synthetic", models: ["gpt-test"] },
    ] }));
    const worker = new PilotSwarmWorker({
        pluginDirs: [base], sessionStateDir: join(dir, "sessions"), nativeSubagents: "off", modelProvidersPath,
    });
    if (packageCopies) {
        const packages = [
            { packageId: "shared-analyst", scope: "shared", owner: null },
            { packageId: "private-analyst", scope: "user", owner },
            { packageId: "foreign-analyst", scope: "user", owner: { provider: "test", subject: "someone-else" } },
        ].map(copy => ({ ...copy, revision: "package-revision", dir: plugin(copy.packageId, namespace, name) }));
        worker._packageDirOwners = new Map(packages.map(({ dir, ...provenance }) => [dir, provenance]));
        worker._resetLoadedPluginState();
        worker.config.pluginDirs = [base, ...packages.map(copy => copy.dir)];
        worker._loadPlugins();
    }
    return worker;
}

describe("durable package capability lifecycle", () => {
    it.each(["analyst", "fixture:analyst"])("activates optional restricted MCP for a qualified deployment binding allowed by %s", async allowed => {
        const h = await fixture({
            workerFactory: dir => restrictedWorker(dir, { allowedAgents: [allowed] }),
            config: { boundAgentName: "fixture:analyst", boundAgentSource: "deployment" },
        });
        const first = await h.turn(0);
        expect(h.opened[0].config.mcpServers ?? {}).not.toHaveProperty("restricted_mcp");
        const sourceRef = capabilityRef(h.source.id, h.source.revision, "source");
        await expect(first.config.capabilityServices.use({ source_ref: sourceRef, mcp_servers: ["restricted_mcp"],
            expected_revision: 0, request_id: "restricted-attach" })).resolves.toEqual({ changed: true, revision: 1 });
        expect(h.state.selections).toEqual([expect.objectContaining({
            sourceId: h.source.id, sourceRef, mcpServers: ["restricted_mcp"],
        })]);
        const rebound = await h.turn(1);
        expect(h.opened[1].config.mcpServers).toHaveProperty("restricted_mcp.url", "https://example.test/mcp");
        await expect(rebound.config.capabilityServices.list()).resolves.toMatchObject({ revision: 1, unavailable: [] });
    });

    it.each([
        { allowed: "analyst", namespace: "fixture", name: "other" },
        { allowed: "fixture:analyst", namespace: "fixture", name: "other" },
        { allowed: "fixture:analyst", namespace: "lookalike", name: "analyst" },
    ])("denies a different selected deployment identity: $namespace:$name allowed by $allowed", async ({ allowed, namespace, name }) => {
        const h = await fixture({
            workerFactory: dir => restrictedWorker(dir, { allowedAgents: [allowed], namespace, name }),
            config: { boundAgentName: `${namespace}:${name}`, boundAgentSource: "deployment" },
        });
        const managed = await h.turn(0);
        await expect(managed.config.capabilityServices.use({
            source_ref: capabilityRef(h.source.id, h.source.revision, "source"), mcp_servers: ["restricted_mcp"],
            expected_revision: 0, request_id: "denied-attach",
        })).rejects.toThrow(/restricted/i);
        expect(h.state).toEqual({ revision: 0, selections: [] });
    });

    it.each([
        { packageId: "shared-analyst", allowed: "fixture:analyst", admitted: true },
        { packageId: "shared-analyst", allowed: "analyst", admitted: false },
        { packageId: "private-analyst", allowed: "fixture:analyst", admitted: false },
    ])("keeps exact package provenance for $packageId allowed by $allowed", async ({ packageId, allowed, admitted }) => {
        const h = await fixture({
            workerFactory: dir => restrictedWorker(dir, { allowedAgents: [allowed], packageCopies: true }),
            config: { boundAgentName: "analyst", boundAgentPackageId: packageId },
        });
        const managed = await h.turn(0);
        const activation = managed.config.capabilityServices.use({
            source_ref: capabilityRef(h.source.id, h.source.revision, "source"), mcp_servers: ["restricted_mcp"],
            expected_revision: 0, request_id: "package-attach",
        });
        if (admitted) {
            await expect(activation).resolves.toEqual({ changed: true, revision: 1 });
            await h.turn(1);
            expect(h.opened[1].config.mcpServers).toHaveProperty("restricted_mcp");
        } else {
            await expect(activation).rejects.toThrow(/restricted/i);
            expect(h.state).toEqual({ revision: 0, selections: [] });
        }
    });

    it("rejects an exact private copy owned by someone else before MCP activation", async () => {
        const h = await fixture({
            workerFactory: dir => restrictedWorker(dir, { allowedAgents: ["fixture:analyst"], packageCopies: true }),
            config: { boundAgentName: "analyst", boundAgentPackageId: "foreign-analyst" },
        });
        await expect(h.turn(0)).rejects.toMatchObject({ code: "BOUND_AGENT_PACKAGE_UNAVAILABLE" });
        expect(h.opened).toEqual([]);
        expect(h.state).toEqual({ revision: 0, selections: [] });
    });

    it("keeps discovery tools additive in V1 and rebinds the same session after an exact package selection", async () => {
        const h = await fixture();
        const first = await h.turn(0);
        const firstNames = h.opened[0].config.tools.map(tool => tool.name);
        expect(firstNames).toEqual(expect.arrayContaining([
            "search_capabilities", "load_agent_guidelines", "list_session_capabilities", "use_package", "load_skill",
        ]));
        expect(firstNames).not.toContain("package_lookup");

        const sourceRef = capabilityRef(h.source.id, h.source.revision, "source");
        await expect(first.config.capabilityServices.use({ source_ref: sourceRef, tools: ["package_lookup"],
            mcp_servers: ["package_mcp"], expected_revision: 0, request_id: "attach-1" }))
            .resolves.toEqual({ changed: true, revision: 1 });
        expect(h.state.selections[0]).toMatchObject({ sourceId: h.source.id, sourceRef,
            tools: ["package_lookup"], mcpServers: ["package_mcp"] });

        const rebound = await h.turn(1);
        expect(h.opened).toHaveLength(2);
        expect(h.opened[0].handle.disconnect).toHaveBeenCalledOnce();
        expect(h.opened[1].config.tools.map(tool => tool.name)).toContain("package_lookup");
        expect(h.opened[1].config.mcpServers).toHaveProperty("package_mcp.url", "https://example.test/mcp");
        const attachedTool = rebound.config.tools.find(tool => tool.name === "package_lookup");
        await expect(attachedTool.handler({}, {})).resolves.toBe("package-result");

        await rebound.config.capabilityServices.use({ source_ref: sourceRef, tools: ["package_lookup"],
            mcp_servers: ["package_mcp"], action: "remove", expected_revision: 1, request_id: "remove-1" });
        await h.turn(2);
        expect(h.opened).toHaveLength(3);
        expect(h.opened[2].config.tools.map(tool => tool.name)).not.toContain("package_lookup");
        expect(h.opened[2].config.mcpServers ?? {}).not.toHaveProperty("package_mcp");
    });

    it("refuses child-session activation without changing durable state", async () => {
        const h = await fixture({ child: true });
        const managed = await h.turn(0);
        await expect(managed.config.capabilityServices.use({
            source_ref: capabilityRef(h.source.id, h.source.revision, "source"), tools: ["package_lookup"],
            expected_revision: 0, request_id: "child-attach",
        })).rejects.toThrow(/parent session/i);
        expect(h.state).toEqual({ revision: 0, selections: [] });
    });

    it("invalidates an already-bound tool when ownership or source revision changes", async () => {
        const h = await fixture();
        const first = await h.turn(0);
        const sourceRef = capabilityRef(h.source.id, h.source.revision, "source");
        await first.config.capabilityServices.use({ source_ref: sourceRef, tools: ["package_lookup"],
            expected_revision: 0, request_id: "attach-1" });
        const rebound = await h.turn(1);
        const attachedTool = rebound.config.tools.find(tool => tool.name === "package_lookup");
        h.source.revision = "sha-2";
        await expect(attachedTool.handler({}, {})).rejects.toThrow(/changed|revoked/i);
        const refreshed = await h.turn(2);
        expect(refreshed.config.tools.map(tool => tool.name)).not.toContain("package_lookup");
        await expect(refreshed.config.capabilityServices.list()).resolves.toMatchObject({ unavailable: [h.source.id] });
    });

    it("acknowledges a committed retry even when its exact source revision later becomes stale", async () => {
        const h = await fixture();
        const first = await h.turn(0);
        const sourceRef = capabilityRef(h.source.id, h.source.revision, "source");
        const request = { source_ref: sourceRef, tools: ["package_lookup"],
            expected_revision: 0, request_id: "attach-1" };
        await expect(first.config.capabilityServices.use(request)).resolves.toEqual({ changed: true, revision: 1 });
        h.source.revision = "sha-2";
        await expect(first.config.capabilityServices.use(request)).resolves.toEqual({ changed: false, revision: 1 });
    });

    it("invalidates a bound handler replaced under an unchanged source revision", async () => {
        const h = await fixture();
        const first = await h.turn(0);
        const sourceRef = capabilityRef(h.source.id, h.source.revision, "source");
        await first.config.capabilityServices.use({ source_ref: sourceRef, tools: ["package_lookup"],
            expected_revision: 0, request_id: "attach-1" });
        const rebound = await h.turn(1);
        const attachedTool = rebound.config.tools.find(tool => tool.name === "package_lookup");
        h.source.tools.set("package_lookup", { ...h.source.tools.get("package_lookup"), handler: vi.fn(async () => "replacement") });
        await expect(attachedTool.handler({}, {})).rejects.toThrow(/changed|revoked/i);
    });
});

class CapabilityTurnSession {
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
                this.results.push(await tool.handler(call.args, { sessionId: "turn-session" }));
            }
            this.emit("assistant.message", { content: "model tried to continue" });
            this.emit("session.idle");
        });
    }
    abort() {}
    async disconnect() {}
}

describe("use_package turn boundary", () => {
    it("commits one activation, blocks later tools in the turn, and returns an automatic continuation", async () => {
        const use = vi.fn(async () => ({ changed: true, revision: 1 }));
        const search = vi.fn(async () => ({ capabilities: [] }));
        const session = new CapabilityTurnSession([
            { name: "use_package", args: { source_ref: "cap1.source", tools: ["lookup"], expected_revision: 0, request_id: "one" } },
            { name: "search_capabilities", args: { query: "later" } },
        ]);
        const managed = new ManagedSession("turn-session", session, { capabilityServices: {
            use, search, load: vi.fn(), list: vi.fn(),
        } });

        const result = await managed.runTurn("attach the package");

        expect(use).toHaveBeenCalledOnce();
        expect(search).not.toHaveBeenCalled();
        expect(session.results[1]).toMatch(/not executed.*previous control tool/i);
        expect(result).toMatchObject({ type: "completed", content: "Package capability selections updated." });
        expect(result.forceContinuePrompt).toMatch(/same session has refreshed/i);
    });

    it("refuses activation while a native agent is active", async () => {
        const use = vi.fn(async () => ({ changed: true, revision: 1 }));
        const tasks = [{ id: "native-1", type: "agent", status: "running" }];
        const session = new CapabilityTurnSession([
            { name: "use_package", args: { source_ref: "cap1.source", tools: ["lookup"], expected_revision: 0, request_id: "one" } },
        ], tasks);
        // The pre-turn cleanup sees no restored task. The handler then sees a
        // running task; the final cleanup sees it completed naturally.
        session.rpc.tasks.list
            .mockResolvedValueOnce({ tasks: [] })
            .mockResolvedValueOnce({ tasks: [] })
            .mockResolvedValueOnce({ tasks })
            .mockResolvedValue({ tasks: [] });
        const managed = new ManagedSession("turn-session", session, { nativeSubagents: "sync", capabilityServices: {
            use, search: vi.fn(), load: vi.fn(), list: vi.fn(),
        } });

        const result = await managed.runTurn("attach after native work");

        expect(use).not.toHaveBeenCalled();
        expect(session.results[0]).toMatch(/finish native tasks/i);
        expect(result).toMatchObject({ type: "completed", content: "model tried to continue" });
    });
});
