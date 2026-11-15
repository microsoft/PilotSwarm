import { afterEach, describe, expect, it, vi } from "vitest";
import { toolBindingHarness } from "../helpers/tool-binding-harness.mjs";
import { completeWorkflowNodeFromTool } from "../../src/workflow/agent-node-service.ts";
import { WorkflowToolAuthorityError } from "../../src/workflow/tool-policy.ts";
import { WorkflowPackageCheckError } from "../../src/workflow/package-pins.ts";
import { PilotSwarmWorker } from "../../src/worker.ts";
import { join } from "node:path";

const fixtures = [];
afterEach(async () => { while (fixtures.length) await fixtures.pop().close(); });

async function fixture({ named = false, published = false, step = false, mcp = false, policy, sibling = false,
    revision = "one" } = {}) {
    const h = toolBindingHarness();
    fixtures.push(h);
    const tool = { name: "registered_lookup", description: "Harmless registered lookup",
        parameters: { type: "object", properties: {} }, handler: vi.fn(async () => "found") };
    const source = { id: published ? "lookup-package" : "static:registered-tools", name: "lookup",
        source: published ? "published" : "static", scope: "shared", revision,
        tools: new Map([[tool.name, tool]]), mcpServers: {}, artifacts: [] };
    h.sources.push(source);
    if (sibling) source.tools.set("sibling_lookup", { ...tool, name: "sibling_lookup" });
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
            selections: [{ sourceId: source.id, tools: [...source.tools.keys()], mcpServers: [] }] });
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
    if (mcp) config.toolGrant.mcpSources = { lookup: source.id };
    const context = { workflowSessionId: "wf", nodeExecutionId: "visit" };
    let nodeState = "pending";
    if (step) {
        const { agentStepStateId, ...binding } = config.toolGrant;
        h.addSession("wf", "parent", { workflowToolBinding: { ...binding, agentStepBindings: { step: {
            capabilities: binding.capabilities, tools: binding.tools, sourceRevisions: binding.sourceRevisions,
            toolSources: binding.toolSources, packagePins: binding.packagePins, mcpSources: binding.mcpSources,
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

async function pinnedWorkerFixture() {
    const revision = "a".repeat(64);
    const h = await fixture({ published: true, revision });
    const worker = new PilotSwarmWorker({ sessionStateDir: join(h.directory, "snapshot-worker"),
        disableManagementAgents: true });
    fixtures.push({ close: () => worker.sessionManager.shutdown() });
    const pinnedId = `${h.source.id}@${revision}`;
    const newer = { ...h.tool, handler: vi.fn(async () => "wrong revision") };
    worker._catalog = h.catalog;
    worker._capabilitySources = [{ ...h.source, revision: "two", tools: new Map([[newer.name, newer]]) }];
    worker._pinnedCapabilitySources.set(pinnedId, h.source);
    worker._agentPackageToolsByPackage.set(pinnedId, h.source.tools);
    worker._packageDirOwners.set("fixture", { packageId: pinnedId, pinnedOf: h.source.id });
    Object.assign(h.packages.get(h.source.id), { active: { semver: "2.0.0", sha256: "two" },
        versions: [{ semver: "1.0.0", sha256: revision }, { semver: "2.0.0", sha256: "two" }] });
    h.manager.workerDefaults.getCapabilitySources = () => worker._getCapabilitySources();
    h.manager.workerDefaults.getWorkflowCapabilitySnapshot = (...args) => worker.getWorkflowCapabilitySnapshot(...args);
    h.manager.workerDefaults.getAgentPackagesEpoch = () => worker._agentPackagesEpoch;
    worker._agentPackagesEpoch = 1;
    return { ...h, worker, newer };
}

describe("delegated tool authority read budgets", () => {
    it("spawn preparation reads the parent row and effective owner once", async () => {
        const h = await fixture();
        h.reads.length = 0;
        await h.manager.captureSpawnTools("parent", { model: "fixture-model" }, undefined, undefined, null, false,
            () => h.turn("parent", 1));
        expect(h.reads).toHaveLength(3);
        expect(h.reads.filter(read => read.name === "getSession" && read.id === "parent")).toHaveLength(1);
    });

    it("script cold build reuses its admitted row without adding reads over the PR baseline", async () => {
        const h = await fixture({ published: true });
        const { agentStepStateId, ...binding } = h.config.toolGrant;
        h.addSession("script", "parent", { workflowToolBinding: binding });
        h.rows.get("script").sessionKind = "workflow";
        const capabilities = h.catalog.getSessionCapabilities;
        h.catalog.getSessionCapabilities = async id => {
            h.reads.push({ name: "getSessionCapabilities", id });
            return capabilities(id);
        };
        h.reads.length = 0;
        const executor = await h.manager.openWorkflowToolExecutor("script", binding, 0);
        try {
            const catalogReads = h.reads.filter(read => !["listAgentPackages", "getAgentPackage"].includes(read.name));
            expect(catalogReads).toHaveLength(10);
            expect(catalogReads.filter(read => read.name === "getSessionCreationConfig")).toHaveLength(1);
            expect(catalogReads.filter(read => read.name === "getSessionCapabilities")).toHaveLength(0);
        } finally {
            await executor.close();
        }
    });

    it("script admission preserves its pinned grant when the parent unloads after setup authorization", async () => {
        const h = await fixture({ published: true });
        const { agentStepStateId, ...binding } = h.config.toolGrant;
        h.addSession("script", "parent", { workflowToolBinding: binding });
        h.rows.get("script").sessionKind = "workflow";
        const getOrCreate = h.manager.getOrCreate.bind(h.manager);
        h.manager.getOrCreate = async (...args) => {
            h.catalog.getSessionCapabilities = async () => ({ revision: 2, selections: [] });
            return getOrCreate(...args);
        };
        const executor = await h.manager.openWorkflowToolExecutor("script", binding, 0);
        try {
            expect(h.opened.filter(open => open.handle.sessionId === "script")).toHaveLength(1);
        } finally { await executor.close(); }
    });

    it.each([
        ["ungranted_lookup", "Tool 'ungranted_lookup' is not uniquely admitted for this workflow."],
        ["spawn_agent", "Workflow control tool 'spawn_agent' is not permitted."],
        ["draw_canvas", "Canvas tool 'draw_canvas' needs a live agent session and cannot run in a Workflow script. Use an agent step, or send the update to the parent session."],
    ])("script resolver keeps b0's refusal class and message for %s", async (name, message) => {
        const h = await fixture();
        const { agentStepStateId, ...binding } = h.config.toolGrant;
        h.addSession("script", "parent", { workflowToolBinding: binding });
        h.rows.get("script").sessionKind = "workflow";
        const executor = await h.manager.openWorkflowToolExecutor("script", binding, 0);
        try {
            h.reads.length = 0;
            const error = await executor.call(name, {}).catch(error => error);
            expect(error.constructor).toBe(Error);
            expect(error.message).toBe(message);
            expect(h.reads).toHaveLength(3);
            expect(h.tool.handler).not.toHaveBeenCalled();
        } finally { await executor.close(); }
    });

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

    it.each(["disabled", "deleted", "private", "version_removed"])("published pins refresh only after the registry epoch changes: %s", async reason => {
        const h = await fixture({ published: true });
        h.reads.length = 0;
        await expect(h.call()).resolves.toBe("found");
        await h.turn("child", 1);
        expect(h.reads.filter(read => ["listAgentPackages", "getAgentPackage", "getSessionCreationConfig"].includes(read.name))).toEqual([]);
        if (reason === "deleted") h.packages.delete(h.source.id);
        else if (reason === "disabled") h.packages.get(h.source.id).enabled = false;
        else if (reason === "private") Object.assign(h.packages.get(h.source.id), {
            scope: "user", owner: { provider: "other", subject: "owner" },
        });
        else h.packages.get(h.source.id).versions = [];
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

    it("a pinned package tool keeps b0's same-name static schema refusal", async () => {
        const h = await fixture({ published: true });
        h.sources.push({ ...h.source, id: "static:namesake", source: "static",
            tools: new Map([[h.tool.name, { ...h.tool,
                parameters: { type: "object", properties: { conflicting: { type: "number" } } } }]]) });
        h.reads.length = 0;
        await expect(h.call()).rejects.toEqual(new WorkflowToolAuthorityError(
            `Tool '${h.tool.name}' is unavailable or its contract changed since workflow admission.`));
        expect(h.reads).toEqual([]);
        expect(h.tool.handler).not.toHaveBeenCalled();
    });

    it("a broken whole selection keeps b0's Error class and message", async () => {
        const h = await fixture({ published: true, sibling: true });
        h.source.tools.delete("sibling_lookup");
        h.reads.length = 0;
        const error = await h.call().catch(error => error);
        expect(error.constructor).toBe(Error);
        expect(error.message).toBe("Package tool changed or access was revoked; refresh session capabilities");
        expect(h.reads).toEqual([]);
        expect(h.tool.handler).not.toHaveBeenCalled();
    });

    it("spawn deletion keeps b0's authority error at the next turn", async () => {
        const h = await fixture();
        h.rows.get("child").deletedAt = new Date();
        await expect(h.nextTurn(1)).rejects.toEqual(
            new WorkflowToolAuthorityError("Workflow parent authority is no longer available."));
    });

    it("a cold package-read failure preserves the original error instead of wrapping it", async () => {
        const h = await fixture({ published: true });
        await h.manager.dropWarmSession("child");
        const error = new WorkflowPackageCheckError("registry", { package: null, version: null, revision: null },
            new Error("registry fixture unavailable"));
        h.manager.workerDefaults.getWorkflowCapabilitySnapshot = async () => { throw error; };
        await expect(h.nextTurn(1)).rejects.toBe(error);
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

    it("legacy Workflow children without composed grants do not require the agent store", async () => {
        const h = toolBindingHarness();
        fixtures.push(h);
        h.addSession("legacy-wf", "parent", {});
        h.reads.length = 0;
        await expect(h.manager.readWorkflowAgentBinding("legacy", {
            workflowSessionId: "legacy-wf", nodeExecutionId: "old-visit",
        })).resolves.toBeNull();
        expect(h.reads.map(read => read.name)).toEqual(["getSessionCreationConfig"]);
    });

    it.each(["parent", "wf", "child"])("a deleted %s reports delegation refusal inside the next agent-step turn", async id => {
        const h = await fixture({ step: true });
        h.rows.get(id).deletedAt = new Date();
        const child = await h.nextTurn(1);
        const reason = id === "child" ? "Workflow agent visit is no longer available." : "Workflow parent authority is no longer available.";
        expect(await child.runTurn("do the step", { turnIndex: 1, requiredTool: "missing_lookup" }))
            .toMatchObject({ type: "error", retryable: false,
                message: `Required tool "missing_lookup" is not available in this session. Passed tools were refused: ${reason}` });
    });

    it("a decided agent visit reports the original delegation refusal suffix", async () => {
        const h = await fixture({ step: true });
        h.setNodeState("completed");
        const child = await h.nextTurn(1);
        expect(await child.runTurn("do the step", { turnIndex: 1, requiredTool: "missing_lookup" }))
            .toMatchObject({ type: "error", retryable: false, message: 'Required tool "missing_lookup" is not available in this session.'
                + " Passed tools were refused: Workflow agent visit is no longer available." });
    });

    it("cold agent binding refusal builds the session and preserves the suffix", async () => {
        const h = await fixture({ step: true });
        await h.manager.dropWarmSession("child");
        h.manager.readWorkflowAgentBinding = async () => { throw new WorkflowToolAuthorityError("fixture authority refused"); };
        const child = await h.nextTurn(1);
        expect(await child.runTurn("do the step", { turnIndex: 1, requiredTool: "missing_lookup" }))
            .toMatchObject({ type: "error", retryable: false, message: 'Required tool "missing_lookup" is not available in this session.'
                + " Passed tools were refused: fixture authority refused" });
    });

    it("agent binding errors other than authority refusal still fail admission", async () => {
        const h = await fixture({ step: true });
        const error = new Error("fixture registry fault");
        h.manager.readWorkflowAgentBinding = async () => { throw error; };
        await expect(h.nextTurn(1)).rejects.toBe(error);
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
            await expect(h.call()).rejects.toEqual(new WorkflowToolAuthorityError("Workflow agent visit is no longer available."));
            expect(h.reads).toEqual([]);
            expect(h.tool.handler).not.toHaveBeenCalled();
        } finally { releaseWake(); await completion; }
    });

    it("abort closes an agent's tool admission without a catalog read", async () => {
        const h = await fixture({ step: true });
        h.opened.at(-1).handle.abort = () => {};
        h.child.abort();
        h.reads.length = 0;
        await expect(h.call()).rejects.toEqual(new WorkflowToolAuthorityError("Workflow agent visit is no longer available."));
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
        await expect(h.call()).rejects.toEqual(new WorkflowToolAuthorityError("Workflow agent visit is no longer available."));
        expect(await h.nextTurn(1)).toBe(h.child);
        await expect(h.call()).resolves.toBe("found");
        const tool = h.child.config.tools.find(candidate => candidate.name === h.tool.name);
        h.child.closeWorkflowTools();
        h.setNodeState("completed");
        const refused = await h.nextTurn(2);
        expect(() => refused.assertWorkflowToolsOpen()).toThrow(
            new WorkflowToolAuthorityError("Workflow agent visit is no longer available."));
        await expect(tool.handler({}, {})).rejects.toEqual(
            new WorkflowToolAuthorityError(refused === h.child
                ? "Workflow agent visit is no longer available."
                : "The delegated tool session is no longer available."));
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
        if (mutation === "server") await expect(permission(request)).resolves.toEqual({ kind: "reject",
            feedback: "The declared MCP server is unavailable or access was revoked." });
        expect(h.reads).toEqual([]);
    });

    it("MCP admission still applies the ancestor's permission handler", async () => {
        const policy = vi.fn(async () => ({ kind: "reject", feedback: "ancestor policy" }));
        const h = await fixture({ mcp: true, policy });
        await expect(h.opened.at(-1).config.onPermissionRequest({ kind: "mcp", serverName: "lookup", toolName: "read" }))
            .resolves.toMatchObject({ kind: "reject", feedback: "ancestor policy" });
        expect(policy).toHaveBeenCalledTimes(1);
    });

    it("agent-step MCP keeps the baseline temporary bundle-load refusal", async () => {
        const h = await fixture({ mcp: true, step: true });
        const permission = h.opened.at(-1).config.onPermissionRequest;
        const snapshot = h.manager.workflowSnapshots.get("child").snapshot;
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        const error = new WorkflowPackageCheckError("load",
            { package: "lookup", version: "1.0.0", revision: "one" }, new Error("fixture bundle load unavailable"));
        const loads = [];
        h.manager.cachedWorkflowSnapshot = async (_id, _binding, _creation, load) => {
            loads.push(load);
            if (!load) return snapshot;
            clock.mockReturnValue(now + 3000);
            throw error;
        };
        try {
            await expect(permission({ kind: "mcp", serverName: "lookup", toolName: "read" }))
                .resolves.toEqual({ kind: "reject", feedback: "Tool 'lookup-read' could not be checked just now: "
                    + "lookup 1.0.0 could not be loaded. The package is not lost. Call the tool again." });
            expect(loads).toEqual([false, true]);
        } finally { clock.mockRestore(); }
    });

    it("agent-step MCP keeps the unwrapped registry refusal before bundle loading", async () => {
        const h = await fixture({ mcp: true, step: true });
        const error = new WorkflowPackageCheckError("registry",
            { package: null, version: null, revision: null }, new Error("fixture registry unavailable once"));
        const read = vi.fn(async () => { throw error; });
        h.manager.cachedWorkflowSnapshot = read;
        await expect(h.opened.at(-1).config.onPermissionRequest({ kind: "mcp", serverName: "lookup", toolName: "read" }))
            .resolves.toEqual({ kind: "reject", feedback: error.message });
        expect(read).toHaveBeenCalledTimes(1);
        expect(read.mock.calls[0][3]).toBe(false);
    });

    it("an agent-step MCP call is fenced after completion with zero reads", async () => {
        const h = await fixture({ mcp: true, step: true });
        h.child.closeWorkflowTools();
        h.reads.length = 0;
        await expect(h.opened.at(-1).config.onPermissionRequest({ kind: "mcp", serverName: "lookup", toolName: "read" }))
            .resolves.toEqual({ kind: "reject", feedback: "Workflow agent visit is no longer available." });
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

    it("script authorization retains its fixed grant after parent unload, without repeated creation or package reads", async () => {
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
        await expect(h.manager.authorizeWorkflowTools("wf", binding, h.tool.name)).resolves.toBeDefined();
    });

    it.each(["destroy", "dehydrate", "drop", "forget-turn", "eviction", "stop"])("each handle cache is released on %s", async operation => {
        const h = await fixture({ published: true, step: true });
        const admission = h.child.captureWorkflowToolAdmission();
        expect(h.manager.workflowBindingRecords.has("child")).toBe(true);
        expect(h.manager.workflowSnapshots.has("child")).toBe(true);
        if (operation === "destroy") await h.manager.destroySession("child");
        if (operation === "dehydrate") await h.manager.dehydrate("child", "fixture");
        if (operation === "drop") await h.manager.dropWarmSession("child");
        if (operation === "forget-turn") h.manager._forgetTurnState("child");
        if (operation === "eviction") {
            h.manager.sessionLastTouchedAt.set("child", 0);
            h.manager.sessionStore = { checkpoint: async () => {}, dehydrate: async () => {} };
            await h.manager.sweepIdleSessions(60_000);
        }
        if (operation === "stop") await h.manager.shutdown();
        expect(h.manager.workflowBindingRecords.has("child")).toBe(false);
        expect(h.manager.workflowSnapshots.has("child")).toBe(false);
        expect(() => h.child.assertWorkflowToolsOpen()).toThrow("Workflow agent visit is no longer available.");
        expect(admission).toThrow("Workflow agent visit is no longer available.");
    });

    it("failed cold admission leaves neither cache behind", async () => {
        const h = await fixture({ published: true });
        await h.manager.dropWarmSession("child");
        h.manager.workerDefaults.getWorkflowCapabilitySnapshot = async () => { throw new Error("fixture cold failure"); };
        await expect(h.nextTurn(1)).rejects.toThrow("fixture cold failure");
        expect(h.manager.workflowBindingRecords.has("child")).toBe(false);
        expect(h.manager.workflowSnapshots.has("child")).toBe(false);
    });

    it("an in-flight snapshot refresh cannot restore an ended handle's cache", async () => {
        const h = await fixture({ published: true });
        const refresh = Promise.withResolvers();
        const prior = h.manager.workflowSnapshots.get("child").snapshot;
        h.manager.workerDefaults.getWorkflowCapabilitySnapshot = () => refresh.promise;
        h.advanceEpoch();
        const call = h.call();
        await h.manager.dropWarmSession("child");
        refresh.resolve(prior);
        await expect(call).rejects.toThrow("The delegated tool session is no longer available.");
        expect(h.manager.workflowBindingRecords.has("child")).toBe(false);
        expect(h.manager.workflowSnapshots.has("child")).toBe(false);
        expect(h.tool.handler).not.toHaveBeenCalled();
    });

    it.each(["replacement", "later-generation"])("a suspended call cannot borrow a %s admission", async transition => {
        const h = await fixture({ published: true, step: true });
        const prior = h.manager.workflowSnapshots.get("child").snapshot;
        const suspended = Promise.withResolvers();
        const read = h.manager.cachedWorkflowSnapshot.bind(h.manager);
        let first = true;
        h.manager.cachedWorkflowSnapshot = (...args) => {
            if (!first) return read(...args);
            first = false;
            return suspended.promise;
        };
        const result = h.call().then(value => ({ value }), error => ({ error }));
        h.child.closeWorkflowTools();
        if (transition === "replacement") await h.manager.dropWarmSession("child");
        const next = await h.nextTurn(1);
        expect(next === h.child).toBe(transition === "later-generation");
        h.reads.length = 0;
        suspended.resolve(prior);
        expect((await result).error).toBeInstanceOf(WorkflowToolAuthorityError);
        expect(h.tool.handler).not.toHaveBeenCalled();
        expect(h.reads).toEqual([]);
        await expect(next.config.tools.find(tool => tool.name === h.tool.name).handler({}, {})).resolves.toBe("found");
    });

    it("a new call through a retained handler captures the reopened handle without database reads", async () => {
        const h = await fixture({ published: true, step: true });
        const handler = h.child.config.tools.find(tool => tool.name === h.tool.name).handler;
        await h.manager.dropWarmSession("child");
        const next = await h.nextTurn(1);
        expect(next).not.toBe(h.child);
        h.reads.length = 0;
        await expect(handler({}, {})).resolves.toBe("found");
        expect(h.reads).toEqual([]);
        next.closeWorkflowTools();
        await expect(handler({}, {})).rejects.toThrow("Workflow agent visit is no longer available.");
        expect(h.reads).toEqual([]);
    });

    it("an MCP permission await cannot approve an earlier admission after a new turn opens", async () => {
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        const h = await fixture({ mcp: true, policy: async () => {
            entered.resolve();
            return release.promise;
        } });
        const permission = h.opened.at(-1).config.onPermissionRequest;
        const pending = permission({ kind: "mcp", serverName: "lookup", toolName: "read" }, {});
        await entered.promise;
        h.child.closeWorkflowTools();
        await h.nextTurn(1);
        h.reads.length = 0;
        release.resolve({ kind: "approve-for-session" });
        await expect(pending).resolves.toEqual({ kind: "reject", feedback: "Workflow agent visit is no longer available." });
        expect(h.reads).toEqual([]);
    });

    it.each([false, true])("a checked pinned revision loads without rereading its registry (concurrent=%s)", async concurrent => {
        const h = await pinnedWorkerFixture();
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        const list = h.catalog.listAgentPackages;
        h.catalog.listAgentPackages = async (...args) => {
            const value = await list(...args);
            entered.resolve();
            await release.promise;
            return value;
        };
        h.reads.length = 0;
        const weak = h.manager.cachedWorkflowSnapshot("child", h.config.toolGrant, undefined, false);
        await entered.promise;
        if (!concurrent) { release.resolve(); await weak; }
        const results = Promise.allSettled([h.call(), h.call()]);
        release.resolve();
        await weak;
        expect(await results).toEqual([{ status: "fulfilled", value: "found" }, { status: "fulfilled", value: "found" }]);
        expect(h.reads.map(read => read.name)).toEqual(["listAgentPackages", "getAgentPackage"]);
        expect(h.newer.handler).not.toHaveBeenCalled();
        h.reads.length = 0;
        await expect(h.call()).resolves.toBe("found");
        expect(h.reads).toEqual([]);
    });

    it("a failed pinned load retries its checked authority without registry rereads", async () => {
        const h = await pinnedWorkerFixture();
        h.reads.length = 0;
        await h.manager.cachedWorkflowSnapshot("child", h.config.toolGrant, undefined, false);
        const load = h.worker.ensurePinnedAgentPackageRevision.bind(h.worker);
        h.worker.ensurePinnedAgentPackageRevision = async () => { throw new Error("fixture load unavailable"); };
        await expect(h.manager.cachedWorkflowSnapshot("child", h.config.toolGrant))
            .rejects.toMatchObject({ name: "WorkflowPackageCheckError", stage: "load", message: "fixture load unavailable" });
        expect(h.manager.workflowSnapshots.get("child")).toMatchObject({ checked: true, loaded: false });
        expect(h.manager.workflowSnapshots.get("child").pending).toBeUndefined();
        h.worker.ensurePinnedAgentPackageRevision = load;
        await expect(h.call()).resolves.toBe("found");
        expect(h.manager.workflowSnapshots.get("child").snapshot.loadSources).toBeUndefined();
        expect(h.reads.map(read => read.name)).toEqual(["listAgentPackages", "getAgentPackage"]);
    });

    it("joined callers reject a changing epoch and observe revocation on the next check", async () => {
        const h = await pinnedWorkerFixture();
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        const list = h.catalog.listAgentPackages;
        h.catalog.listAgentPackages = async (...args) => {
            const packages = await list(...args);
            entered.resolve();
            await release.promise;
            return packages;
        };
        h.reads.length = 0;
        const weak = h.manager.cachedWorkflowSnapshot("child", h.config.toolGrant, undefined, false);
        await entered.promise;
        const results = Promise.allSettled([weak, h.manager.cachedWorkflowSnapshot("child", h.config.toolGrant)]);
        h.worker._agentPackagesEpoch++;
        release.resolve();
        for (const result of await results) expect(result).toMatchObject({
            status: "rejected", reason: { name: "WorkflowPackageCheckError", stage: "registry" },
        });
        h.packages.get(h.source.id).enabled = false;
        await expect(h.call()).rejects.toThrow(/disabled/);
        expect(h.reads.map(read => read.name)).toEqual([
            "listAgentPackages", "getAgentPackage", "listAgentPackages", "getAgentPackage",
        ]);
        expect(h.tool.handler).not.toHaveBeenCalled();
    });

    it.each(["destroy", "dehydrate", "drop", "forget-turn", "eviction", "stop"])
        ("an in-flight deferred load cannot restore the cache after %s", async operation => {
            const h = await pinnedWorkerFixture();
            await h.manager.cachedWorkflowSnapshot("child", h.config.toolGrant, undefined, false);
            expect(h.manager.workflowSnapshots.get("child").snapshot.loadSources).toBeTypeOf("function");
            const entered = Promise.withResolvers(), release = Promise.withResolvers();
            h.worker.ensurePinnedAgentPackageRevision = async () => { entered.resolve(); await release.promise; return true; };
            const results = Promise.allSettled([
                h.manager.cachedWorkflowSnapshot("child", h.config.toolGrant),
                h.manager.cachedWorkflowSnapshot("child", h.config.toolGrant),
            ]);
            await entered.promise;
            if (operation === "destroy") await h.manager.destroySession("child");
            if (operation === "dehydrate") await h.manager.dehydrate("child", "fixture");
            if (operation === "drop") await h.manager.dropWarmSession("child");
            if (operation === "forget-turn") h.manager._forgetTurnState("child");
            if (operation === "eviction") {
                h.manager.sessionLastTouchedAt.set("child", 0);
                h.manager.sessionStore = { checkpoint: async () => {}, dehydrate: async () => {} };
                await h.manager.sweepIdleSessions(60_000);
            }
            if (operation === "stop") await h.manager.shutdown();
            h.reads.length = 0;
            release.resolve();
            for (const result of await results) expect(result).toMatchObject({
                status: "rejected", reason: { message: "The delegated tool session is no longer available." },
            });
            expect(h.manager.workflowSnapshots.has("child")).toBe(false);
            expect(h.manager.workflowBindingRecords.has("child")).toBe(false);
            expect(h.reads).toEqual([]);
            expect(h.tool.handler).not.toHaveBeenCalled();
        });

    it("a deferred load from an old handle cannot overwrite its replacement snapshot", async () => {
        const h = await pinnedWorkerFixture();
        await h.manager.cachedWorkflowSnapshot("child", h.config.toolGrant, undefined, false);
        const entered = Promise.withResolvers(), release = Promise.withResolvers();
        const load = h.worker.ensurePinnedAgentPackageRevision.bind(h.worker);
        let first = true;
        h.worker.ensurePinnedAgentPackageRevision = async id => {
            if (first) { first = false; entered.resolve(); await release.promise; }
            return load(id);
        };
        const result = h.call().then(value => ({ value }), error => ({ error }));
        await entered.promise;
        await h.manager.dropWarmSession("child");
        const replacement = await h.nextTurn(1);
        const snapshot = h.manager.workflowSnapshots.get("child");
        h.reads.length = 0;
        release.resolve();
        expect((await result).error).toEqual(new WorkflowToolAuthorityError("The delegated tool session is no longer available."));
        expect(h.manager.workflowSnapshots.get("child")).toBe(snapshot);
        expect(h.tool.handler).not.toHaveBeenCalled();
        await expect(h.call()).rejects.toThrow("The delegated tool session is no longer available.");
        await expect(replacement.config.tools.find(tool => tool.name === h.tool.name).handler({}, {})).resolves.toBe("found");
        expect(h.reads).toEqual([]);
    });

    it("destroy failure still removes both caches and closes tool admission", async () => {
        const h = await fixture({ published: true, step: true });
        h.opened.at(-1).handle.disconnect = async () => { throw new Error("fixture disconnect failure"); };
        await expect(h.manager.destroySession("child")).rejects.toThrow("fixture disconnect failure");
        expect(h.manager.workflowBindingRecords.has("child")).toBe(false);
        expect(h.manager.workflowSnapshots.has("child")).toBe(false);
        expect(() => h.child.assertWorkflowToolsOpen()).toThrow("Workflow agent visit is no longer available.");
    });
});
