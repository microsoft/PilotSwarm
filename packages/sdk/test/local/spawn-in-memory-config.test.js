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

    it.each([{ grant: "none" }, { ceiling: [] }])("grant and ceiling narrow memory tools: %j", async options => {
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
});
