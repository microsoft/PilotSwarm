import { afterEach, describe, expect, it, vi } from "vitest";
import { toolBindingHarness } from "../helpers/tool-binding-harness.mjs";
import { completeWorkflowNodeFromTool } from "../../src/workflow/agent-node-service.ts";

const fixtures = [];
afterEach(async () => { while (fixtures.length) await fixtures.pop().close(); });

async function fixture({ named = false, published = false, step = false, mcp = false, policy } = {}) {
    const h = toolBindingHarness();
    fixtures.push(h);
    const tool = { name: "registered_lookup", description: "Harmless registered lookup",
        parameters: { type: "object", properties: {} }, handler: vi.fn(async () => "found") };
    const source = { id: published ? "lookup-package" : "static:registered-tools", name: "lookup",
        source: published ? "published" : "static", scope: "shared", revision: "one",
        tools: new Map([[tool.name, tool]]), mcpServers: {}, artifacts: [] };
    h.sources.push(source);
    if (mcp) {
        source.mcpServers.lookup = { type: "stdio", command: "not-executed", tools: ["read"] };
        h.manager.workerDefaults.mcpServers = source.mcpServers;
        h.catalog.getSessionCapabilities = async () => ({ revision: 1,
            selections: [{ sourceId: source.id, tools: [tool.name], mcpServers: ["lookup"] }] });
    }
    if (published) {
        const version = { semver: "1.0.0", sha256: source.revision };
        h.packages.set(source.id, { packageId: source.id, name: source.name, scope: "shared", enabled: true,
            active: version, versions: [version] });
        h.catalog.getSessionCapabilities = async () => ({ revision: 1,
            selections: [{ sourceId: source.id, tools: [tool.name], mcpServers: [] }] });
    }
    h.manager.setToolRegistry(new Map([[tool.name, tool]]), {
        byPackage: published ? new Map([[source.id, source.tools]]) : new Map(),
        staticNames: new Set(published ? [] : [tool.name]),
    });
    h.configs.set("parent", { model: "fixture-model", ...(published ? {} : { toolNames: [tool.name] }) });
    if (named) h.lookup.reader = { prompt: "Reader", toolNames: [tool.name] };
    if (policy) h.worker.setSessionConfig("parent", { onPermissionRequest: policy });
    await h.turn("parent");
    if (mcp) {
        const rpc = h.opened.at(-1).handle.rpc.tools;
        const metadata = await rpc.getCurrentMetadata();
        rpc.getCurrentMetadata = async () => ({ tools: [...metadata.tools, {
            name: "lookup-read", namespacedName: "lookup/read", mcpServerName: "lookup", mcpToolName: "read",
            input_schema: { type: "object", properties: {} },
        }] });
    }
    const config = await h.spawn("parent", "child", named ? { agent: { name: "reader", tools: [tool.name] } } : {});
    const context = { workflowSessionId: "wf", nodeExecutionId: "visit" };
    let nodeState = "pending";
    if (step) {
        const { agentStepStateId, ...binding } = config.toolGrant;
        h.addSession("wf", "parent", { workflowToolBinding: { ...binding, agentStepBindings: { step: {
            capabilities: binding.capabilities, tools: binding.tools, sourceRevisions: binding.sourceRevisions,
            toolSources: binding.toolSources, packagePins: binding.packagePins,
        } } } });
        h.rows.get("wf").sessionKind = "workflow";
        h.addSession("child", "wf", { workflowAgentChild: true, workflowInsideWorkflow: true });
        h.catalog.workflowStore = () => ({
            readAgentInvocation: async () => {
                h.reads.push({ name: "readAgentInvocation" });
                return { childSessionId: "child", workflowSessionId: "wf" };
            },
            readNodeExecution: async () => {
                h.reads.push({ name: "readNodeExecution" });
                return { nodeId: "step", state: nodeState };
            },
        });
    }
    const nextTurn = index => h.turn("child", index, step ? { workflowAgentTools: context } : {});
    const child = await nextTurn(0);
    return { ...h, tool, source, config, child, nextTurn, setNodeState(state) { nodeState = state; },
        call: () => child.config.tools.find(candidate => candidate.name === tool.name).handler({}, {}) };
}

describe("delegated tool authority read budgets", () => {
    it.each([false, true])("registered child tool dispatch performs no catalog reads (named=%s)", async named => {
        const h = await fixture({ named });
        h.reads.length = 0;
        await expect(h.call()).resolves.toBe("found");
        await expect(h.call()).resolves.toBe("found");
        expect(h.reads).toEqual([]);
    });

    it("a warm turn does not reread the immutable creation grant or the spawn parent", async () => {
        const h = await fixture();
        h.reads.length = 0;
        await h.turn("child", 1);
        expect(h.reads.filter(read => read.name === "getSessionCreationConfig" || read.id === "parent")).toEqual([]);
    });

    it("the cold admission deduplicates the creation read and does not read a spawn parent", async () => {
        const h = await fixture();
        await h.manager.dropWarmSession("child");
        h.reads.length = 0;
        await h.turn("child", 1);
        expect(h.reads.filter(read => read.name === "getSessionCreationConfig")).toHaveLength(1);
        expect(h.reads.filter(read => read.name === "getSession" && read.id === "parent")).toEqual([]);
        const creation = h.reads.findIndex(read => read.name === "getSessionCreationConfig");
        expect(h.reads.slice(0, creation).filter(read => read.name === "getSession")).toHaveLength(1);
    });

    it.each(["disabled", "deleted"])("published pins refresh only after the registry epoch changes: %s", async reason => {
        const h = await fixture({ published: true });
        h.reads.length = 0;
        await expect(h.call()).resolves.toBe("found");
        await h.turn("child", 1);
        expect(h.reads.filter(read => ["listAgentPackages", "getAgentPackage", "getSessionCreationConfig"].includes(read.name))).toEqual([]);
        if (reason === "deleted") h.packages.delete(h.source.id);
        else h.packages.get(h.source.id).enabled = false;
        h.reads.length = 0;
        await expect(h.call()).resolves.toBe("found");
        expect(h.reads).toEqual([]);
        h.advanceEpoch();
        await expect(h.call()).rejects.toMatchObject({ name: "WorkflowPackageToolError", details: { reason } });
        expect(h.tool.handler).toHaveBeenCalledTimes(2);
    });

    it("a changed registered schema is refused without catalog reads", async () => {
        const h = await fixture();
        h.tool.parameters = { type: "object", properties: { changed: { type: "number" } } };
        h.reads.length = 0;
        await expect(h.call()).rejects.toThrow(/contract changed/);
        expect(h.reads).toEqual([]);
        expect(h.tool.handler).not.toHaveBeenCalled();
    });

    it("the next turn refuses a deleted child instead of reusing its handle", async () => {
        const h = await fixture();
        h.rows.get("child").deletedAt = new Date();
        await expect(h.turn("child", 1)).rejects.toThrow(/authority.*available|deleted/);
    });

    it("an agent step checks its visit at admission, not during tool dispatch", async () => {
        const h = await fixture({ step: true });
        h.reads.length = 0;
        await expect(h.call()).resolves.toBe("found");
        expect(h.reads).toEqual([]);
        await h.nextTurn(1);
        expect(h.reads.filter(read => read.name === "getSessionCreationConfig")).toEqual([]);
        expect(h.reads.filter(read => read.name === "readNodeExecution")).toHaveLength(1);
    });

    it.each(["parent", "wf", "child"])("a deleted %s refuses the next agent-step turn", async id => {
        const h = await fixture({ step: true });
        h.rows.get(id).deletedAt = new Date();
        await expect(h.nextTurn(1)).rejects.toThrow(/authority|visit/i);
    });

    it("a decided agent visit refuses the next turn", async () => {
        const h = await fixture({ step: true });
        h.setNodeState("completed");
        await expect(h.nextTurn(1)).rejects.toThrow(/visit.*no longer available/);
    });

    it("completion closes tool admission before its controller wake finishes", async () => {
        const h = await fixture({ step: true });
        let releaseWake;
        const wake = new Promise(resolve => { releaseWake = resolve; });
        const onDecided = vi.fn(() => h.child.closeWorkflowTools());
        const completion = completeWorkflowNodeFromTool({ operation_id: "complete", outcome: "done" }, {
            callerSessionId: "child", onDecided,
            store: { completeAgentNode: async () => ({ kind: "accepted", replayed: false,
                controllerInstanceId: "controller", receipt: { nodeExecutionId: "visit", runId: "run" } }) },
            client: { enqueueEvent: () => wake },
        });
        await Promise.resolve();
        h.reads.length = 0;
        try {
            expect(onDecided).toHaveBeenCalledTimes(1);
            await expect(h.call()).rejects.toThrow(/closed|ended/i);
            expect(h.reads).toEqual([]);
            expect(h.tool.handler).not.toHaveBeenCalled();
        } finally { releaseWake(); await completion; }
    });

    it("abort closes an agent's tool admission without a catalog read", async () => {
        const h = await fixture({ step: true });
        h.opened.at(-1).handle.abort = () => {};
        h.child.abort();
        h.reads.length = 0;
        await expect(h.call()).rejects.toThrow(/closed|ended/i);
        expect(h.reads).toEqual([]);
    });

    it("cold row and creation reads are actually in flight together", async () => {
        const h = await fixture();
        await h.manager.dropWarmSession("child");
        const row = Promise.withResolvers(), creation = Promise.withResolvers();
        const getRow = h.catalog.getSession, getCreation = h.catalog.getSessionCreationConfig;
        const rowRead = vi.fn(id => id === "child" ? row.promise : getRow(id));
        h.catalog.getSession = rowRead;
        h.catalog.getSessionCreationConfig = vi.fn(() => creation.promise);
        const turn = h.nextTurn(1);
        for (let i = 0; i < 8; i++) await Promise.resolve();
        try {
            expect(rowRead).toHaveBeenCalledWith("child");
            expect(h.catalog.getSessionCreationConfig).toHaveBeenCalledWith("child");
        } finally {
            row.resolve(h.rows.get("child"));
            creation.resolve(await getCreation("child"));
            await turn;
        }
    });

    it.each(["OUTPUT_INVALID", "OPERATION_CONFLICT"])("a %s completion leaves tools open", async code => {
        const h = await fixture({ step: true });
        const onDecided = vi.fn(() => h.child.closeWorkflowTools());
        await completeWorkflowNodeFromTool({}, {
            callerSessionId: "child", onDecided,
            store: { completeAgentNode: async () => ({ kind: "refused", code, problems: null, attemptsLeft: 1 }) },
        });
        expect(onDecided).not.toHaveBeenCalled();
        h.reads.length = 0;
        await expect(h.call()).resolves.toBe("found");
        expect(h.reads).toEqual([]);
    });

    it("a new admitted visit reopens the warm handle, but a closed visit does not", async () => {
        const h = await fixture({ step: true });
        h.child.closeWorkflowTools();
        await expect(h.call()).rejects.toThrow(/closed|ended/i);
        expect(await h.nextTurn(1)).toBe(h.child);
        await expect(h.call()).resolves.toBe("found");
        h.child.closeWorkflowTools();
        h.setNodeState("completed");
        await expect(h.nextTurn(2)).rejects.toThrow(/visit/);
        await expect(h.call()).rejects.toThrow(/closed|ended/i);
    });

    it.each(["tools", "server", "allowlist"])("MCP checks live static %s policy without reads", async mutation => {
        const h = await fixture({ mcp: true });
        const permission = h.opened.at(-1).config.onPermissionRequest;
        const request = { kind: "mcp", serverName: "lookup", toolName: "read" };
        h.reads.length = 0;
        await expect(permission(request)).resolves.toMatchObject({ kind: "approve-once" });
        h.sources[0] = { ...h.source, mcpServers: mutation === "server" ? {} : {
            lookup: { ...h.source.mcpServers.lookup, ...(mutation === "tools" ? { tools: ["other"] } : { allowedAgents: [] }) },
        } };
        await expect(permission(request)).resolves.toMatchObject({ kind: "reject" });
        expect(h.reads).toEqual([]);
    });

    it("MCP admission still applies the ancestor's permission handler", async () => {
        const policy = vi.fn(async () => ({ kind: "reject", feedback: "ancestor policy" }));
        const h = await fixture({ mcp: true, policy });
        await expect(h.opened.at(-1).config.onPermissionRequest({ kind: "mcp", serverName: "lookup", toolName: "read" }))
            .resolves.toMatchObject({ kind: "reject", feedback: "ancestor policy" });
        expect(policy).toHaveBeenCalledTimes(1);
    });

    it("an agent-step MCP call is fenced after completion with zero reads", async () => {
        const h = await fixture({ mcp: true, step: true });
        h.child.closeWorkflowTools();
        h.reads.length = 0;
        await expect(h.opened.at(-1).config.onPermissionRequest({ kind: "mcp", serverName: "lookup", toolName: "read" }))
            .resolves.toMatchObject({ kind: "reject", feedback: expect.stringMatching(/closed|ended/i) });
        expect(h.reads).toEqual([]);
    });

    it("a legacy snapshot keeps recovered provider labels across an epoch change", async () => {
        const h = await fixture({ published: true });
        const binding = structuredClone(h.config.toolGrant);
        delete binding.toolSources;
        delete binding.packagePins;
        binding.capabilities.selections = [];
        h.addSession("legacy", "parent", { toolGrant: binding });
        const first = await h.manager.cachedWorkflowSnapshot("legacy", binding);
        expect(first.labels.toolSources[h.tool.name]).toBe(h.source.id);
        h.packages.delete(h.source.id);
        h.sources.length = 0;
        h.advanceEpoch();
        const current = await h.manager.cachedWorkflowSnapshot("legacy", binding);
        expect(() => h.manager.checkWorkflowTool(binding, current, h.tool.name))
            .toThrow(/deleted|no longer available/);
    });

    it("an epoch change during a package read reports a retryable check, then recovers", async () => {
        const h = await fixture({ published: true });
        const original = h.manager.workerDefaults.getWorkflowCapabilitySnapshot;
        h.manager.workerDefaults.getWorkflowCapabilitySnapshot = async (...args) => {
            const value = await original(...args);
            h.advanceEpoch();
            return value;
        };
        h.advanceEpoch();
        await expect(h.manager.cachedWorkflowSnapshot("child", h.config.toolGrant))
            .rejects.toMatchObject({ name: "WorkflowPackageCheckError" });
        h.manager.workerDefaults.getWorkflowCapabilitySnapshot = original;
        await expect(h.call()).resolves.toBe("found");
    });

    it("script authorization retains main's parent revocation check, without repeated creation or package reads", async () => {
        const h = await fixture({ published: true });
        const binding = structuredClone(h.config.toolGrant);
        delete binding.agentStepStateId;
        h.addSession("wf", "parent", { workflowToolBinding: binding });
        h.rows.get("wf").sessionKind = "workflow";
        await h.manager.authorizeWorkflowTools("wf", binding, h.tool.name);
        h.reads.length = 0;
        await h.manager.authorizeWorkflowTools("wf", binding, h.tool.name);
        expect(h.reads.filter(read => ["getSessionCreationConfig", "listAgentPackages", "getAgentPackage"].includes(read.name))).toEqual([]);
        h.catalog.getSessionCapabilities = async () => ({ revision: 2, selections: [] });
        await expect(h.manager.authorizeWorkflowTools("wf", binding, h.tool.name)).rejects.toThrow(/capability was revoked/);
    });
});
