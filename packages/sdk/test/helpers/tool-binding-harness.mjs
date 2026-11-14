import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../../src/session-manager.ts";
import { PilotSwarmWorker } from "../../src/worker.ts";
import { resolveWorkflowCapabilitySnapshot } from "../../src/workflow/package-pins.ts";

/** Real manager and grant composition, with an in-memory catalog and no CLI/model process. */
export function toolBindingHarness() {
    const directory = mkdtempSync(join(tmpdir(), "ps-tool-binding-"));
    const owner = { provider: "fixture", subject: randomUUID() };
    const rows = new Map(), configs = new Map(), opened = [], reads = [];
    const sources = [], packages = new Map(), lookup = {};
    let epoch = 0;
    const record = (name, read) => async (...args) => {
        reads.push({ name, id: args[0] });
        return read(...args);
    };
    const catalog = {
        getSession: record("getSession", id => rows.get(id) ?? null),
        getSessionCreationConfig: record("getSessionCreationConfig", id => structuredClone(configs.get(id) ?? null)),
        getSessionCapabilities: record("getSessionCapabilities", () => ({ revision: 0, selections: [] })),
        getUserRole: record("getUserRole", () => ({ role: "user", seenAt: new Date() })),
        listAgentPackages: record("listAgentPackages", () => [...packages.values()]),
        getAgentPackage: record("getAgentPackage", name => [...packages.values()].find(pkg => pkg.name === name) ?? null),
        recordEvents: async () => {},
    };
    const manager = new SessionManager(undefined, null, {
        frameworkBasePrompt: "", nativeSubagents: "off", agentPromptLookup: lookup,
        getCapabilitySources: () => sources,
        getAgentPackagesEpoch: () => epoch,
        getWorkflowCapabilitySnapshot: (binding, labels) =>
            resolveWorkflowCapabilitySnapshot(binding, labels, catalog, sources),
    }, directory);
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    manager.setSessionCatalog(catalog);
    manager.setToolRegistry(new Map(), { byPackage: new Map(), staticNames: new Set() });
    const open = config => {
        mkdirSync(join(directory, config.sessionId), { recursive: true });
        const handle = {
            sessionId: config.sessionId, disconnect: async () => {}, registerTools() {},
            rpc: {
                tasks: { list: async () => ({ tasks: [] }) },
                tools: {
                    initializeAndValidate: async () => {},
                    getCurrentMetadata: async () => ({ tools: config.tools.map(tool => ({
                        name: tool.name, input_schema: tool.parameters ?? { type: "object", properties: {} },
                    })) }),
                },
            },
        };
        opened.push({ config, handle });
        return handle;
    };
    manager.ensureClient = async () => ({
        createSession: async config => open(config),
        resumeSession: async (_id, config) => open(config),
        deleteSession: async () => {},
    });
    const worker = Object.create(PilotSwarmWorker.prototype);
    worker.sessionManager = manager;
    const addSession = (id, parentSessionId = null, config = {}) => {
        rows.set(id, { sessionId: id, owner, parentSessionId, state: "idle", sessionKind: "agent" });
        configs.set(id, { model: "fixture-model", ...config });
    };
    addSession("parent");
    const turn = (id, index = 0, options = {}) => manager.getOrCreate(id, configs.get(id), { turnIndex: index, ...options });
    const spawn = async (parent = "parent", id = "child", { grant, ceiling, agent } = {}) => {
        const config = { model: "fixture-model", ...(agent ? {
            boundAgentName: agent.name, boundAgentSource: "deployment", toolNames: agent.tools ?? [],
        } : {}) };
        const captured = await manager.captureSpawnTools(parent, config, grant, ceiling, agent ?? null);
        addSession(id, parent, { ...config, ...captured });
        return configs.get(id);
    };
    return {
        owner, manager, worker, rows, configs, catalog, sources, packages, lookup, opened, reads, addSession, turn, spawn,
        advanceEpoch() { epoch++; },
        async close() {
            for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
            rmSync(directory, { recursive: true, force: true });
        },
    };
}
