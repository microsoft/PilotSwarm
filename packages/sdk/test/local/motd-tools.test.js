import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MOTD_OPERATION_SPECS, motdToolParameters, runMotdStoreOperation, createMotdTools } from "../../src/motd-tools.ts";
import { reservedPlatformToolNames } from "../../src/reserved-tool-names.ts";
import { SessionManager } from "../../src/session-manager.ts";
import { FEATURE_OPERATION_SPECS } from "../../src/feature-tools.ts";

const viewer = { principal: { provider: "test", subject: "alice" }, isAdmin: true };
const names = MOTD_OPERATION_SPECS.map(spec => spec.name);
const readNames = MOTD_OPERATION_SPECS.filter(spec => spec.access === "authed").map(spec => spec.name);
const request = { fromAt: "2020-01-01T00:00:00Z", toAt: "2090-01-01T00:00:00Z", bodyMd: "Hello", requestId: "one" };
describe("shared MoTD operation list", () => {
    it("dispatches all six operations through the store", async () => {
        const calls = [];
        const store = Object.fromEntries(["current", "dismiss", "image", "list", "create", "delete"].map(kind =>
            [kind, async (...args) => { calls.push({ kind, args }); return {}; }]));
        for (const spec of MOTD_OPERATION_SPECS) {
            await runMotdStoreOperation(store, spec, viewer, { ...request, motdId: "42", mobile: true, limit: 2, before: "20" });
            expect(calls.at(-1).kind).toBe(spec.kind);
            expect(calls.at(-1).args[0]).toBe(viewer);
            expect(motdToolParameters(spec).additionalProperties).toBe(false);
        }
        expect(calls.find(c => c.kind === "list").args.slice(1)).toEqual([2, "20"]);
        expect(calls.find(c => c.kind === "image").args.slice(1)).toEqual(["42", true]);
    });
    it("reserves all names regardless of role or storage", () => {
        for (const name of names) expect(reservedPlatformToolNames().has(name)).toBe(true);
    });
    it("lets authenticated non-admin agent tools read history without mutation declarations", async () => {
        const reader = { ...viewer, isAdmin: false };
        const store = { list: vi.fn(async actor => { expect(actor).toEqual(reader); return [{ motdId: "1", status: "ended" }]; }) };
        const tools = createMotdTools(store, async () => reader, vi.fn(), { includeAdmin: false });
        expect(tools.map(tool => tool.name)).toEqual(readNames);
        expect(await tools.find(tool => tool.name === "list_motds").handler({})).toContain('"status":"ended"');
        expect(tools.some(tool => ["create_motd", "delete_motd"].includes(tool.name))).toBe(false);
        const unauthenticated = createMotdTools(store, async () => ({ principal: null, isAdmin: true }), vi.fn());
        await expect(unauthenticated.find(tool => tool.name === "list_motds").handler({})).rejects.toMatchObject({ status: 403 });
    });
    it("reads artifact pictures outside model context and rechecks admin", async () => {
        let admin = true;
        const store = { create: vi.fn(async () => ({ motdId: "1" })), image: async () => ({ base64: "do-not-return", contentType: "image/png", alt: "Picture" }) };
        const read = vi.fn(async () => ({ base64: "AAAA", contentType: "image/png", alt: "Picture" }));
        const tools = createMotdTools(store, async () => ({ ...viewer, isAdmin: admin }), read);
        const create = tools.find(t => t.name === "create_motd");
        const image = { sessionId: "source", filename: "picture.png", alt: "Picture" };
        await create.handler({ ...request, image });
        expect(read).toHaveBeenCalledWith(image, viewer);
        expect(store.create.mock.calls[0][1].image.base64).toBe("AAAA");
        expect(await tools.find(t => t.name === "get_motd_image").handler({ motdId: "1" })).not.toContain("do-not-return");
        await expect(create.handler({ ...request, image: { base64: "AAAA" } })).rejects.toMatchObject({ code: "MOTD_INVALID" });
        admin = false;
        await expect(create.handler({ ...request, isAdmin: true })).rejects.toMatchObject({ status: 403 });
        expect(store.create).toHaveBeenCalledTimes(1);
    });
});

async function sessionFixture(run) {
    const home = mkdtempSync(join(tmpdir(), "ps-motd-session-"));
    const id = randomUUID();
    let role = "user";
    let row = { sessionId: id, owner: viewer.principal, isSystem: false };
    const configs = [];
    const catalog = { getSession: async () => row, getUserRole: async () => ({ role, seenAt: new Date() }),
        getSessionAccess: vi.fn(async () => ({ rootSessionId: id, isSystem: false, visibility: "private", viewerIsOwner: false, viewerShareAccess: null })),
        recordEvents: async () => {}, motds: { create: vi.fn(async () => ({ motdId: "1" })) } };
    const manager = new SessionManager(undefined, null, { nativeSubagents: "off" }, join(home, "session-state"));
    manager.setSessionCatalog(catalog); manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    const create = config => {
        configs.push(config); mkdirSync(join(home, "session-state", id), { recursive: true });
        return { sessionId: id, disconnect: vi.fn(async () => {}), registerTools: vi.fn() };
    };
    manager.client = { createSession: async config => create(config), resumeSession: async (_id, config) => create(config), stop: async () => {} };
    try { await run({ manager, id, configs, catalog, setRole: value => { role = value; }, setRow: value => { row = value; } }); }
    finally { await manager.shutdown(); rmSync(home, { recursive: true, force: true }); }
}
describe("MoTD declarations and artifact access in sessions", () => {
    it.each(["agent-manager", "generic-superagent"])("gates %s by current role, then rebinds a warm session on role change", async agentIdentity => {
        await sessionFixture(async ({ manager, id, configs, setRole }) => {
            const config = { model: "gpt-5.6-terra", agentIdentity };
            const declared = () => configs.at(-1).tools.filter(t => names.includes(t.name));
            await manager.getOrCreate(id, config, { turnIndex: 0 }); expect(declared().map(tool => tool.name)).toEqual(readNames);
            setRole("admin");
            await manager.getOrCreate(id, config, { turnIndex: 1 }); expect(declared().map(t => t.name)).toEqual(names);
            const create = declared().find(t => t.name === "create_motd");
            setRole("user");
            await expect(create.handler(request)).rejects.toMatchObject({ status: 403 });
            await manager.getOrCreate(id, config, { turnIndex: 2 }); expect(declared().map(tool => tool.name)).toEqual(readNames);
            setRole("admin");
            await manager.getOrCreate(id, { ...config, agentIdentity: "ordinary" }, { turnIndex: 3 });
            expect(declared()).toEqual([]);
        });
    });
    it.each(["pilotswarm", "resourcemgr", "ordinary"])("does not attach MoTD tools to %s or permit reserved-name shadowing", async agentIdentity => {
        await sessionFixture(async ({ manager, id, configs, setRole, catalog }) => {
            setRole("admin");
            catalog.features = {};
            const collision = vi.fn();
            manager.setConfig(id, { tools: names.map(name => ({
                name, description: "A shadowing tool", parameters: { type: "object" }, handler: collision,
            })) });
            await manager.getOrCreate(id, { model: "gpt-5.6-terra", agentIdentity }, { turnIndex: 0 });
            expect(configs[0].tools.filter(tool => names.includes(tool.name))).toEqual([]);
            const featureNames = FEATURE_OPERATION_SPECS.map(spec => spec.name);
            expect(configs[0].tools.filter(tool => featureNames.includes(tool.name)).map(tool => tool.name))
                .toEqual(agentIdentity === "ordinary" ? [] : featureNames);
            for (const name of names) expect(reservedPlatformToolNames().has(name)).toBe(true);
            expect(collision).not.toHaveBeenCalled();
        });
    });
    it.each([false, true])("does not let cluster administration bypass a private source session (system agent session: %s)", async systemAgent => {
        await sessionFixture(async ({ manager, id, configs, setRole, setRow, catalog }) => {
            if (systemAgent) setRow({ sessionId: id, owner: viewer.principal, isSystem: true });
            setRole("admin");
            manager.adminScope = "cluster";
            manager.artifactStore = { statArtifact: vi.fn(), downloadArtifact: vi.fn() };
            await manager.getOrCreate(id, { model: "gpt-5.6-terra", agentIdentity: "agent-manager" }, { turnIndex: 0 });
            const create = configs[0].tools.find(t => t.name === "create_motd");
            await expect(create.handler({ ...request, image: { sessionId: "private-source", filename: "image.png", alt: "Picture" } })).rejects.toMatchObject({ status: 403 });
            expect(catalog.getSessionAccess).toHaveBeenCalled();
            expect(manager.artifactStore.downloadArtifact).not.toHaveBeenCalled();
        });
    });
});
