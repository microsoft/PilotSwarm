import { afterEach, describe, expect, it, vi } from "vitest";
import { toolBindingHarness } from "../helpers/tool-binding-harness.mjs";
import { completeWorkflowNodeFromTool } from "../../src/workflow/agent-node-service.ts";

const fixtures = [];
afterEach(async () => { while (fixtures.length) await fixtures.pop().close(); });

async function fixture({ named = false, published = false, step = false } = {}) {
    const h = toolBindingHarness();
    fixtures.push(h);
    const tool = { name: "registered_lookup", description: "Harmless registered lookup",
        parameters: { type: "object", properties: {} }, handler: vi.fn(async () => "found") };
    const source = { id: published ? "lookup-package" : "static:registered-tools", name: "lookup",
        source: published ? "published" : "static", scope: "shared", revision: "one",
        tools: new Map([[tool.name, tool]]), mcpServers: {}, artifacts: [] };
    h.sources.push(source);
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
    await h.turn("parent");
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
});
