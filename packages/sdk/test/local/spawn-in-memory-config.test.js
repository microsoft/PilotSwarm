import { afterEach, describe, expect, it, vi } from "vitest";
import { toolBindingHarness } from "../helpers/tool-binding-harness.mjs";

const fixtures = [];
afterEach(async () => { while (fixtures.length) await fixtures.pop().close(); });
const fixture = () => { const h = toolBindingHarness(); fixtures.push(h); return h; };
const memoryTool = () => ({
    name: "memory_lookup", description: "Read a harmless in-memory fixture.",
    parameters: { type: "object", properties: { key: { type: "string" } } },
    handler: vi.fn(async args => `memory:${args.key}`),
});
const offered = managed => managed.config.tools.find(tool => tool.name === "memory_lookup");

describe("spawn inherits session-attached config by ancestor reference", () => {
    it("an owned parent's tool reaches its child and grandchild", async () => {
        const h = fixture(), tool = memoryTool();
        h.worker.setSessionConfig("parent", { tools: [tool] });
        await h.turn("parent");
        const childConfig = await h.spawn();
        expect(childConfig.toolGrant.inMemory).toMatchObject({
            ancestorSessionId: "parent", tools: [{ name: tool.name, schemaHash: expect.any(String) }],
        });
        const child = await h.turn("child");
        await expect(offered(child).handler({ key: "child" }, {})).resolves.toBe("memory:child");
        await expect(h.manager.captureWorkflowToolBinding("child")).rejects.toThrow(/in-memory/i);
        const grandchildConfig = await h.spawn("child", "grandchild");
        expect(grandchildConfig.toolGrant.inMemory.ancestorSessionId).toBe("parent");
        const grandchild = await h.turn("grandchild");
        await expect(offered(grandchild).handler({ key: "grandchild" }, {})).resolves.toBe("memory:grandchild");
        expect(tool.handler).toHaveBeenCalledTimes(2);
    });

    it.each([{ tools: [] }, { tools: ["memory_lookup"] }])("a named agent receives only its declared tools: $tools", async ({ tools }) => {
        const h = fixture(), tool = memoryTool();
        const agent = { name: "reader", tools };
        h.lookup.reader = { prompt: "Fixture reader", toolNames: tools };
        h.worker.setSessionConfig("parent", { tools: [tool] });
        await h.turn("parent");
        const config = await h.spawn("parent", "child", { agent });
        const child = await h.turn("child");
        expect(Boolean(offered(child))).toBe(tools.length > 0);
        expect(config.toolGrant.inMemory?.tools ?? []).toHaveLength(tools.length);
    });

    it.each([{ grant: "none" }, { ceiling: "none" }])("grant and ceiling narrow memory tools: %j", async options => {
        const h = fixture();
        h.worker.setSessionConfig("parent", { tools: [memoryTool()] });
        await h.turn("parent");
        await h.spawn("parent", "child", options);
        expect(offered(await h.turn("child"))).toBeUndefined();
    });

    it("passes the original permission handler and hooks into the child handle", async () => {
        const h = fixture();
        const permission = vi.fn(async () => ({ kind: "reject", feedback: "ancestor policy" }));
        const hook = vi.fn(async () => ({ permissionDecision: "deny", permissionDecisionReason: "ancestor hook" }));
        h.worker.setSessionConfig("parent", { tools: [memoryTool()],
            hooks: { onPreToolUse: hook }, onPermissionRequest: permission });
        await h.turn("parent");
        const config = await h.spawn();
        expect(config.toolGrant.inMemory.policy).toBe(true);
        await h.turn("child");
        const sdkConfig = h.opened.at(-1).config;
        const request = { kind: "read", path: "/fixture" };
        await expect(sdkConfig.onPermissionRequest(request)).resolves.toMatchObject({ kind: "reject", feedback: "ancestor policy" });
        await expect(sdkConfig.hooks.onPreToolUse({ toolName: "memory_lookup", toolArgs: {} }, {}))
            .resolves.toMatchObject({ permissionDecision: "deny" });
        expect(permission).toHaveBeenCalledWith(request);
        expect(hook).toHaveBeenCalledTimes(1);
    });

    it.each(["hooks", "permission", "both"])("missing ancestor %s refuses the child turn", async policy => {
        const h = fixture();
        h.worker.setSessionConfig("parent", {
            ...(policy !== "permission" ? { hooks: { onPreToolUse: async () => ({}) } } : {}),
            ...(policy !== "hooks" ? { onPermissionRequest: async () => ({ kind: "approve-once" }) } : {}),
        });
        await h.turn("parent");
        await h.spawn();
        h.worker.setSessionConfig("parent", {});
        await expect(h.turn("child")).rejects.toThrow(/in-memory.*policy.*parent.*unavailable/i);
        expect(h.opened).toHaveLength(1);
    });

    it("a warm child uses a replaced ancestor policy on its next turn", async () => {
        const h = fixture();
        h.worker.setSessionConfig("parent", { onPermissionRequest: async () => ({ kind: "approve-once" }) });
        await h.turn("parent");
        await h.spawn();
        const child = await h.turn("child");
        const hook = vi.fn(async () => ({ permissionDecision: "deny" }));
        h.worker.setSessionConfig("parent", { hooks: { onPreToolUse: hook },
            onPermissionRequest: async () => ({ kind: "reject", feedback: "replacement policy" }) });
        expect(await h.turn("child", 1)).not.toBe(child);
        const sdkConfig = h.opened.at(-1).config;
        await expect(sdkConfig.onPermissionRequest({ kind: "read", path: "/fixture" }))
            .resolves.toMatchObject({ kind: "reject", feedback: "replacement policy" });
        await expect(sdkConfig.hooks.onPreToolUse({ toolName: "memory_lookup", toolArgs: {} }, {}))
            .resolves.toMatchObject({ permissionDecision: "deny" });
    });

    it.each(["removed", "changed"])("a %s memory tool stays offered and refuses the call", async change => {
        const h = fixture(), tool = memoryTool();
        h.worker.setSessionConfig("parent", { tools: [tool] });
        await h.turn("parent");
        await h.spawn();
        if (change === "removed") h.worker.setSessionConfig("parent", {});
        else tool.parameters = { type: "object", properties: { other: { type: "number" } } };
        const child = await h.turn("child");
        expect(offered(child)).toBeDefined();
        await expect(offered(child).handler({ key: "child" }, {}))
            .rejects.toThrow(change === "removed" ? /memory_lookup.*unavailable/i : /memory_lookup.*contract changed/i);
        expect(tool.handler).not.toHaveBeenCalled();
    });

    it("dropping the parent's warm handle preserves app config, but ending it revokes inherited tools", async () => {
        const h = fixture(), tool = memoryTool();
        h.worker.setSessionConfig("parent", { tools: [tool] });
        await h.turn("parent");
        await h.spawn();
        await h.manager.dropWarmSession("parent");
        const child = await h.turn("child");
        await expect(offered(child).handler({ key: "warm" }, {})).resolves.toBe("memory:warm");
        h.worker.setSessionConfig("parent", {});
        await expect(offered(child).handler({ key: "gone" }, {})).rejects.toThrow(/memory_lookup.*unavailable/i);
    });

    it.each([{}, { hooks: {} }, { onPermissionRequest: undefined }, { hooks: { onPreToolUse: undefined } }])
        ("empty or undefined policy keys do not block spawning: %j", async config => {
            const h = fixture();
            h.worker.setSessionConfig("parent", config);
            await h.turn("parent");
            const childConfig = await h.spawn();
            expect(childConfig.toolGrant.inMemory).toBeUndefined();
            await expect(h.turn("child")).resolves.toBeDefined();
        });

    it("Workflow delegation still refuses process-local tools and policy", async () => {
        for (const config of [{ tools: [memoryTool()] }, { onPermissionRequest: async () => ({ kind: "approve-once" }) }]) {
            const h = fixture();
            h.worker.setSessionConfig("parent", config);
            await h.turn("parent");
            await expect(h.manager.captureWorkflowToolBinding("parent")).rejects.toThrow(/in-memory/i);
        }
    });

    it("a named declaration keeps the parent's in-memory tool ahead of a registered name collision", async () => {
        const h = fixture(), tool = memoryTool();
        const registered = { ...tool, handler: vi.fn(async () => "wrong registry handler") };
        h.sources.push({ id: "static:registered-tools", name: "Worker tools", source: "static", scope: "shared",
            revision: "one", tools: new Map([[tool.name, registered]]), mcpServers: {}, artifacts: [] });
        h.manager.setToolRegistry(new Map([[tool.name, registered]]), {
            byPackage: new Map(), staticNames: new Set([tool.name]),
        });
        h.lookup.reader = { prompt: "Fixture reader", toolNames: [tool.name] };
        h.worker.setSessionConfig("parent", { tools: [tool] });
        await h.turn("parent");
        await h.spawn("parent", "child", { agent: { name: "reader", tools: [tool.name] } });
        await expect(offered(await h.turn("child")).handler({ key: "child" }, {})).resolves.toBe("memory:child");
        expect(registered.handler).not.toHaveBeenCalled();
    });
});
