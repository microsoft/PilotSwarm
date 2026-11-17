import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "../../src/session-manager.ts";
import { ManagedSession } from "../../src/managed-session.ts";
import { runRegenDistill } from "../../src/regen-worker.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { bootstrapProviders, buildRuntimeRegistry, resolveProviderCredential } from "../../src/provider-catalog.ts";
import { sendCopilotPrompt } from "../../src/copilot-client.js";

const fake = vi.hoisted(() => ({ clients: [] }));
vi.mock("../../src/copilot-client.js", async original => ({
    ...await original(),
    createCopilotClient: (options) => {
        const client = { options, start: vi.fn(async () => {}), stop: vi.fn(async () => []),
            listModels: vi.fn(async () => []), deleteSession: vi.fn(async () => {}) };
        fake.clients.push(client);
        return client;
    },
}));

const types = new ModelProviderRegistry({ providers: [
    { id: "github-type", type: "github", models: ["native"] },
    { id: "byok", type: "anthropic", baseUrl: "https://example.invalid", apiKey: "legacy", models: ["other"] },
] }, { keepUncredentialed: true });
const marker = { kind: "externalGithubCredential", source: "config-file", scopeId: "inference-scope" };
const instance = { name: "shared-native", typeId: "github-type", class: "shared", secretRef: marker };
const directories = [];
const managers = [];
function credential(generation = "one", extra = {}) {
    return { token: `synthetic-${generation}`, generation, scopeId: "inference-scope",
        expiresAtMs: Date.now() + 60 * 60_000, ...extra };
}
function harness(overrides = {}) {
    const root = path.resolve(".credential-lifecycle-tests", String(directories.length));
    fs.mkdirSync(root, { recursive: true });
    directories.push(root);
    const authority = { providerName: "shared-native", typeId: "github-type", scopeId: "inference-scope",
        acquire: vi.fn(async () => credential()), ...overrides };
    const registry = buildRuntimeRegistry(types, [instance], "shared-native:native");
    const manager = new SessionManager("legacy-worker-token", null, {
        modelProviders: registry, githubCredentialProvider: authority,
    }, path.join(root, "session-state"));
    managers.push(manager);
    manager.setSessionCatalog({ getSession: async () => ({ owner: { provider: "test", subject: "person" } }),
        getUserGitHubCopilotKey: vi.fn(async () => "legacy-personal-token") });
    return { manager, authority, registry };
}
afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.shutdown();
    for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.resolve(".credential-lifecycle-tests"), { recursive: true, force: true });
    fake.clients.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe("shared auxiliary model prompts", () => {
    function session(send) {
        const listeners = new Map();
        return {
            on: (name, handler) => listeners.set(name, handler),
            emit: (name, data) => listeners.get(name)?.({ data }),
            send: vi.fn(send),
            abort: vi.fn(async () => {}),
        };
    }

    it("waits for idle and returns the last assistant message", async () => {
        const model = session(async () => {
            model.emit("assistant.message", { content: " draft " });
            model.emit("assistant.message", { content: " final title " });
            model.emit("session.idle");
        });
        expect(await sendCopilotPrompt(model, "title")).toBe("final title");
        expect(model.send).toHaveBeenCalledExactlyOnceWith({ prompt: "title" });
    });

    it("rejects a failed send", async () => {
        const model = session(async () => { throw new Error("send failed"); });
        await expect(sendCopilotPrompt(model, "title")).rejects.toThrow("send failed");
    });

    it("rejects a runtime error without leaking its contents", async () => {
        const model = session(async () => model.emit("session.error", { message: "private runtime diagnostic" }));
        await expect(sendCopilotPrompt(model, "title")).rejects.toThrow("Auxiliary model session failed");
    });

    it("aborts a timed-out prompt", async () => {
        vi.useFakeTimers();
        try {
            const model = session(async () => {});
            const failed = expect(sendCopilotPrompt(model, "title", 60_000)).rejects.toThrow(/timed out/);
            await vi.advanceTimersByTimeAsync(60_000);
            await failed;
            expect(model.abort).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("external GitHub authority registration", () => {
    it("atomically seeds only a non-secret marker and resolves it in runtime and management", async () => {
        const source = harness().authority;
        const store = { bootstrap: vi.fn(async () => ({ claimed: true, created: 1 })),
            allCredentials: async () => [instance] };
        await bootstrapProviders(store, { providers: types.allProviders }, source);
        const seeded = store.bootstrap.mock.calls[0][0].find(row => row.name === source.providerName);
        expect(seeded).toEqual({ name: source.providerName, typeId: source.typeId,
            secretRef: marker, baseUrl: null });
        expect(source.acquire).not.toHaveBeenCalled();
        expect(JSON.stringify(store.bootstrap.mock.calls)).not.toContain("synthetic-");
        expect(resolveProviderCredential(types, instance, "native")?.externalGithubCredentialScopeId).toBe("inference-scope");
        expect(buildRuntimeRegistry(types, [instance]).resolve("shared-native:native")?.externalGithubCredentialScopeId)
            .toBe("inference-scope");
        expect(buildRuntimeRegistry(types, [{ ...instance, class: "personal" }]).allModels).toHaveLength(0);
    });

    it("refuses a missing authority when its provider-name receipt prevents reseeding", async () => {
        const source = harness().authority;
        await expect(bootstrapProviders({ bootstrap: async () => ({ claimed: false, created: 0 }),
            allCredentials: async () => [] }, { providers: types.allProviders }, source))
            .rejects.toThrow(/initial.*bootstrap/i);
    });
});

describe("renewable GitHub credentials", () => {
    it("requests thirty minutes for a default turn and never reads the personal fallback", async () => {
        const { manager, authority } = harness();
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        expect(token).toBe("synthetic-one");
        expect(authority.acquire).toHaveBeenCalledWith(30 * 60_000);
        expect(manager.sessionCatalog.getUserGitHubCopilotKey).not.toHaveBeenCalled();
        const client = await manager.ensureClient(token);
        expect(client.options.gitHubToken).toBe(token);
        expect(client.options.useLoggedInUser).toBe(false);
    });

    it.each([
        ["expired", () => credential("one", { expiresAtMs: Date.now() - 1 })],
        ["too short", () => credential("one", { expiresAtMs: Date.now() + 29 * 60_000 })],
        ["wrong scope", () => credential("one", { scopeId: "repo-write" })],
        ["empty", () => credential("one", { token: "" })],
        ["missing", () => null],
    ])("fails closed for %s credentials", async (_, value) => {
        const { manager } = harness({ acquire: async () => value() });
        await expect(manager._resolveSessionGitHubToken("s", {}, "shared-native:native"))
            .rejects.toThrow(/GitHub credential/);
        expect(fake.clients).toHaveLength(0);
    });

    it.each([0, -1, Infinity, NaN, 41 * 60_000])("rejects unsafe turn timeout %s", async turnTimeoutMs => {
        const { manager } = harness();
        await expect(manager._resolveSessionGitHubToken("s", { turnTimeoutMs }, "shared-native:native"))
            .rejects.toThrow(/timeout/i);
    });

    it("rejects changed token or expiry under an existing generation and does not expose callback errors", async () => {
        const first = credential();
        const { manager, authority } = harness({ acquire: vi.fn(async () => first) });
        await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        authority.acquire.mockResolvedValue({ ...first, token: "other-token" });
        await expect(manager._resolveSessionGitHubToken("s", {}, "shared-native:native")).rejects.toThrow(/generation/);
        authority.acquire.mockRejectedValue(new Error("secret-bearing-source-error"));
        await expect(manager._resolveSessionGitHubToken("s", {}, "shared-native:native"))
            .rejects.toThrow(/^GitHub credential acquisition failed$/);
    });

    it("rejects relabeling a historical token with a new generation and later expiry", async () => {
        const first = credential();
        const { manager, authority } = harness({ acquire: vi.fn(async () => first) });
        await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        authority.acquire.mockResolvedValue(credential("two"));
        await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        authority.acquire.mockResolvedValue({ ...first, generation: "three", expiresAtMs: first.expiresAtMs + 60 * 60_000 });
        await expect(manager._resolveSessionGitHubToken("s", {}, "shared-native:native")).rejects.toThrow(/generation/);
    });

    it("applies authority to auxiliary inference and propagates errors instead of provider fallback", async () => {
        const { manager, authority } = harness();
        const options = await manager.acquireModelSessionOptions("shared-native:native", 60_000);
        expect(options.gitHubToken).toBe("synthetic-one");
        expect(options.model).toBe("native");
        expect(authority.acquire).toHaveBeenCalledWith(11 * 60_000);
        authority.acquire.mockRejectedValue(new Error("offline"));
        await expect(manager.acquireModelSessionOptions("shared-native:native", 60_000)).rejects.toThrow(/acquisition failed/);
    });

    it("keeps legacy and BYOK provider resolution unchanged", async () => {
        const { manager, authority } = harness();
        manager.setModelProviders(new ModelProviderRegistry({ providers: [
            { id: "static", type: "github", githubToken: "static-token", models: ["native"] },
            types.allProviders[1],
        ] }));
        expect(await manager._resolveSessionGitHubToken("s", {}, "static:native")).toBe("static-token");
        expect(await manager._resolveSessionGitHubToken("s", {}, "byok:other")).toBeUndefined();
        expect(manager.resolveModelSessionOptions("byok:other").provider.apiKey).toBe("legacy");
        expect(authority.acquire).not.toHaveBeenCalled();
    });

    it("retires idle old generations but not locked sessions, discovery or workflow owners", async () => {
        let current = credential();
        const { manager } = harness({ acquire: async () => current });
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const old = await manager.ensureClient(token);
        const warm = { destroy: vi.fn(async () => {}), closeWorkflowTools: vi.fn(), getWorkspaceState: () => ({}) };
        manager.sessions.set("s", warm);
        manager.sessionClientKeys.set("s", token);
        current = credential("two");
        await manager._resolveSessionGitHubToken("other", {}, "shared-native:native");
        manager.sessionLocks.set("s", Promise.resolve());
        await manager.retireGitHubClients();
        expect(old.stop).not.toHaveBeenCalled();
        manager.sessionLocks.delete("s");
        manager.workflowToolHolders.set("s", {});
        await manager.retireGitHubClients();
        expect(old.stop).not.toHaveBeenCalled();
        manager.workflowToolHolders.delete("s");
        await manager.retireGitHubClients();
        expect(warm.destroy).toHaveBeenCalledOnce();
        expect(old.stop).toHaveBeenCalledOnce();
        expect(manager.clients.has(token)).toBe(false);
        expect(manager.sessionClientKeys.has("s")).toBe(false);
    });

    it("does not retire a discovery lease while startup or its model-list request is in flight", async () => {
        let current = credential();
        const { manager } = harness({ acquire: async () => current });
        let finish;
        const pending = new Promise(resolve => { finish = resolve; });
        let entered;
        const ready = new Promise(resolve => { entered = resolve; });
        const discovering = manager.withModelClient("shared-native:native", 60_000, async () => {
            entered();
            await pending;
            return "models";
        });
        await ready;
        const old = fake.clients[0];
        current = credential("two");
        await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        await manager.retireGitHubClients();
        expect(old.stop).not.toHaveBeenCalled();
        finish();
        expect(await discovering).toBe("models");
        expect(old.stop).toHaveBeenCalledOnce();
    });

    it("rechecks validity after slow native startup instead of starting inference", async () => {
        const now = Date.now();
        let clock = now;
        vi.spyOn(Date, "now").mockImplementation(() => clock);
        const { manager } = harness({ acquire: async () => credential("one", { expiresAtMs: now + 30 * 60_000 }) });
        const inference = vi.fn(async () => {});
        const native = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const client = await manager.ensureClient(native);
        client.start.mockImplementation(async () => { clock += 25 * 60_000; });
        await expect(manager.withModelClient("shared-native:native", 60_000, inference))
            .rejects.toThrow(/remaining validity/);
        expect(inference).not.toHaveBeenCalled();
    });

    it("rechecks the exact session generation after setup even if a newer generation exists", async () => {
        const now = Date.now();
        let clock = now;
        vi.spyOn(Date, "now").mockImplementation(() => clock);
        let current = credential("one", { expiresAtMs: now + 30 * 60_000 });
        const { manager } = harness({ acquire: async () => current });
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        manager.sessionClientKeys.set("s", token);
        manager.sessionConfigs.set("s", {});
        current = credential("two");
        await manager._resolveSessionGitHubToken("other", {}, "shared-native:native");
        clock += 60_000;
        expect(() => manager.assertSessionGitHubCredential("s")).toThrow(/remaining validity/);
    });

    it("uses the selected provider for one-shot summaries and checks validity after session creation", async () => {
        const now = Date.now();
        let clock = now;
        vi.spyOn(Date, "now").mockImplementation(() => clock);
        const { manager } = harness({ acquire: async () => credential("one", { expiresAtMs: now + 11 * 60_000 }) });
        const token = await manager._resolveSessionGitHubToken("s", { turnTimeoutMs: 60_000 }, "shared-native:native");
        const client = await manager.ensureClient(token);
        const session = { on: vi.fn(), send: vi.fn(), abort: vi.fn(async () => {}),
            disconnect: vi.fn(async () => {}) };
        client.createSession = vi.fn(async () => { clock += 60_000; return session; });
        await expect(manager.runModelPrompt("shared-native:native", "summary", 60_000)).rejects.toThrow(/remaining validity/);
        expect(client.createSession.mock.calls[0][0].model).toBe("native");
        expect(session.send).not.toHaveBeenCalled();
        expect(session.disconnect).toHaveBeenCalledOnce();
    });

    it("reserves the native client before asynchronous startup and resumes warm disk state after rotation", async () => {
        let current = credential();
        const { manager } = harness({ acquire: async () => current });
        manager.sessionCatalog = null;
        manager.setFactStore({ readFacts: async () => ({ facts: [] }) });
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const firstClient = await manager.ensureClient(token);
        const firstSession = { on: () => () => {}, registerTools() {}, disconnect: vi.fn(async () => {}) };
        firstClient.createSession = vi.fn(async () => firstSession);
        firstClient.start.mockImplementation(async () => {
            expect(manager.sessionClientKeys.get("s")).toBe(token);
            expect(manager.sessionLocks.has("s")).toBe(true);
        });
        await manager.getOrCreate("s", { model: "shared-native:native", toolNames: [] }, { turnIndex: 0 });
        fs.mkdirSync(path.join(manager.sessionStateDir, "s"), { recursive: true });
        current = credential("two");
        const nextToken = await manager._resolveSessionGitHubToken("other", {}, "shared-native:native");
        const nextClient = await manager.ensureClient(nextToken);
        nextClient.resumeSession = vi.fn(async () => ({ on: () => () => {}, registerTools() {} }));
        await manager.getOrCreate("s", { model: "shared-native:native", toolNames: [] }, { turnIndex: 1 });
        expect(firstSession.disconnect).toHaveBeenCalledOnce();
        expect(nextClient.resumeSession).toHaveBeenCalledOnce();
        expect(firstClient.stop).toHaveBeenCalledOnce();
        expect(manager.clients.size).toBe(1);
    });

    it.each([
        ["epoch-start", { turnIndex: 1, transcriptEpoch: 1, epochStart: true }, false],
        ["stale persisted turn-zero", { turnIndex: 0 }, false],
        ["stale warm turn-zero", { turnIndex: 0 }, true],
    ])("preserves admission across %s reset through native execution", async (_, options, warm) => {
        let clock = Date.now();
        vi.spyOn(Date, "now").mockImplementation(() => clock);
        let current = credential("one", { expiresAtMs: clock + 30 * 60_000 });
        const { manager } = harness({ acquire: async () => current });
        manager.sessionCatalog = null;
        manager.setFactStore({ readFacts: async () => ({ facts: [] }) });
        const config = { model: "shared-native:native", toolNames: [] };
        const token = await manager._resolveSessionGitHubToken("s", {}, config.model);
        const client = await manager.ensureClient(token);
        client.createSession = vi.fn(async () => ({
            on: () => () => {}, registerTools() {}, disconnect: vi.fn(async () => {}),
        }));
        if (warm) await manager.getOrCreate("s", config, { turnIndex: 0 });
        else fs.mkdirSync(path.join(manager.sessionStateDir, "s"), { recursive: true });

        const native = {
            on: () => () => {},
            registerTools() {}, disconnect: vi.fn(async () => {}), abort: vi.fn(async () => {}),
            send: vi.fn(async () => { throw new Error("unexpected model send after credential expiry"); }),
        };
        let enterReset, finishReset, enterSetup, finishSetup, enterActive, finishActive;
        const resetEntered = new Promise(resolve => { enterReset = resolve; });
        const resetHeld = new Promise(resolve => { finishReset = resolve; });
        const setupEntered = new Promise(resolve => { enterSetup = resolve; });
        const setupHeld = new Promise(resolve => { finishSetup = resolve; });
        const activeEntered = new Promise(resolve => { enterActive = resolve; });
        const activeHeld = new Promise(resolve => { finishActive = resolve; });
        manager.sessionStore = { exists: async () => false,
            delete: vi.fn(async () => { enterReset(); await resetHeld; }) };
        client.createSession.mockImplementation(async () => { enterSetup(); await setupHeld; return native; });
        const turn = manager.withRunTurnLock("s", "runTurn", async () => {
            const managed = await manager.getOrCreate("s", config, { ...options, lockHeld: true });
            enterActive();
            await activeHeld;
            return managed.runTurn("must reject the old credential", {
                beforeModelExecution: () => manager.assertSessionGitHubCredential("s"),
            });
        });
        try {
            await resetEntered;
            const resetBinding = manager.sessionClientKeys.get("s");
            current = credential("two");
            await manager.withModelClient(config.model, 60_000, async () => {});
            const stoppedDuringReset = client.stop.mock.calls.length;
            finishReset();
            await setupEntered;
            const setupBinding = manager.sessionClientKeys.get("s");
            current = credential("three");
            await manager.withModelClient(config.model, 60_000, async () => {});
            const stoppedDuringSetup = client.stop.mock.calls.length;
            finishSetup();
            await activeEntered;
            const activeBinding = manager.sessionClientKeys.get("s");
            await manager.retireGitHubClients();
            const stoppedDuringActive = client.stop.mock.calls.length;
            clock += 60_000;
            finishActive();
            const result = await turn;
            expect({ resetBinding, setupBinding, activeBinding, stoppedDuringReset, stoppedDuringSetup, stoppedDuringActive })
                .toEqual({ resetBinding: token, setupBinding: token, activeBinding: token,
                    stoppedDuringReset: 0, stoppedDuringSetup: 0, stoppedDuringActive: 0 });
            expect(result).toMatchObject({ type: "error", message: expect.stringContaining("remaining validity") });
            expect(native.send).not.toHaveBeenCalled();
            expect(client.stop).toHaveBeenCalledOnce();
        } finally {
            finishReset();
            finishSetup();
            finishActive();
            await turn.catch(() => {});
        }
    });

    it("public reset clears the old admission binding and warm handle", async () => {
        const fixed = credential();
        const { manager } = harness({ acquire: async () => fixed });
        manager.sessionCatalog = null;
        manager.setFactStore({ readFacts: async () => ({ facts: [] }) });
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const client = await manager.ensureClient(token);
        client.createSession = vi.fn(async () => ({
            on: () => () => {}, registerTools() {}, disconnect: vi.fn(async () => {}),
        }));
        await manager.getOrCreate("s", { model: "shared-native:native", toolNames: [] }, { turnIndex: 0 });
        expect(manager.sessionClientKeys.get("s")).toBe(token);
        await manager.resetSessionState("s");
        expect(manager.sessionClientKeys.has("s")).toBe(false);
        expect(manager.sessions.has("s")).toBe(false);
        expect(client.deleteSession).toHaveBeenCalledWith("s");
    });

    it("does not recycle a warm handle still held by workflow tools on a credential change", async () => {
        let current = credential();
        const { manager } = harness({ acquire: async () => current });
        manager.sessionCatalog = null;
        manager.setFactStore({ readFacts: async () => ({ facts: [] }) });
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const firstClient = await manager.ensureClient(token);
        const session = { on: () => () => {}, registerTools() {}, disconnect: vi.fn(async () => {}) };
        firstClient.createSession = vi.fn(async () => session);
        await manager.getOrCreate("s", { model: "shared-native:native", toolNames: [] }, { turnIndex: 0 });
        manager.workflowToolHolders.set("s", {});
        current = credential("two");
        await expect(manager.getOrCreate("s", { model: "shared-native:native", toolNames: [] }, { turnIndex: 0 }))
            .rejects.toThrow(/workflow tools/i);
        expect(session.disconnect).not.toHaveBeenCalled();
        expect(firstClient.stop).not.toHaveBeenCalled();
    });

    it("rotates a cold workflow reopening after its real previous share teardown", async () => {
        let current = credential();
        let checkColdOpening = false;
        const { manager } = harness({ acquire: async () => {
            if (checkColdOpening) {
                expect(manager.workflowToolHolders.has("s")).toBe(true);
                expect(manager.sessions.has("s")).toBe(false);
                expect(manager.sessionClientKeys.get("s")).toBe(firstToken);
            }
            return current;
        } });
        manager.setFactStore({ readFacts: async () => ({ facts: [] }) });
        manager.authorizeWorkflowTools = vi.fn(async () => null);
        const config = { model: "shared-native:native", toolNames: [] };
        const binding = { policy: "node-parent-tools-v1", parentSessionId: "parent",
            owner: { provider: "test", subject: "person" }, config,
            tools: [], excludedTools: [], capabilities: { revision: 0, selections: [] } };
        const native = () => ({
            on: () => () => {}, registerTools: vi.fn(), disconnect: vi.fn(async () => {}),
            abort: vi.fn(async () => {}),
            rpc: { tools: { initializeAndValidate: vi.fn(async () => {}),
                getCurrentMetadata: vi.fn(async () => ({ tools: [] })) },
            tasks: { list: vi.fn(async () => ({ tasks: [] })) } },
        });
        const firstToken = await manager._resolveSessionGitHubToken("s", {}, config.model);
        const firstClient = await manager.ensureClient(firstToken);
        const firstNative = native();
        firstClient.createSession = vi.fn(async () => firstNative);
        const previous = await manager.openWorkflowToolExecutor("s", binding, 1);
        await previous.close();
        expect(firstNative.disconnect).toHaveBeenCalledOnce();
        expect(manager.sessions.has("s")).toBe(false);
        expect(manager.workflowToolHolders.has("s")).toBe(false);
        expect(manager.sessionClientKeys.get("s")).toBe(firstToken);

        current = credential("two");
        const nextToken = await manager._resolveSessionGitHubToken("other", {}, config.model);
        const nextClient = await manager.ensureClient(nextToken);
        const nextNative = native();
        nextClient.createSession = vi.fn(async () => nextNative);
        checkColdOpening = true;
        const next = await manager.openWorkflowToolExecutor("s", binding, 2);
        checkColdOpening = false;
        try {
            expect(nextClient.createSession).toHaveBeenCalledOnce();
            expect(manager.sessionClientKeys.get("s")).toBe(nextToken);
            expect(firstClient.stop).toHaveBeenCalledOnce();
            current = credential("three");
            await manager._resolveSessionGitHubToken("other", {}, config.model);
            await manager.retireGitHubClients();
            expect(nextNative.disconnect).not.toHaveBeenCalled();
            expect(nextClient.stop).not.toHaveBeenCalled();
        } finally {
            await next.close();
        }
        expect(nextNative.disconnect).toHaveBeenCalledOnce();
        expect(nextClient.stop).toHaveBeenCalledOnce();
    });

    it("refuses the actual native send when setup consumed the credential lifetime margin", async () => {
        const handlers = [];
        const native = {
            on: (name, fn) => { if (typeof name === "function") handlers.push(name); return () => {}; },
            registerTools() {},
            send: vi.fn(async () => { for (const fn of handlers) fn({ type: "session.idle", data: {} }); }),
            abort: vi.fn(async () => {}),
        };
        const managed = new ManagedSession("expired-before-send", native, {});
        const result = await managed.runTurn("must not reach inference", {
            beforeModelExecution: () => { throw new Error("credential lifetime exhausted after setup"); },
        });
        expect(result).toMatchObject({ type: "error", message: expect.stringContaining("credential lifetime exhausted") });
        expect(native.send).not.toHaveBeenCalled();
    });

    it("keeps running owners intact on source failure and rejects missing authority without user fallback", async () => {
        const { manager, authority } = harness();
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const client = await manager.ensureClient(token);
        manager.sessionLocks.set("s", Promise.resolve());
        authority.acquire.mockRejectedValue(new Error("source offline"));
        await expect(manager._resolveSessionGitHubToken("other", {}, "shared-native:native"))
            .rejects.toThrow(/acquisition failed/);
        await manager.retireGitHubClients();
        expect(client.stop).not.toHaveBeenCalled();
        manager.sessionLocks.delete("s");
        manager.githubCredentials = undefined;
        await expect(manager._resolveSessionGitHubToken("other", {}, "shared-native:native"))
            .rejects.toThrow(/authority is not configured/);
        expect(manager.sessionCatalog.getUserGitHubCopilotKey).not.toHaveBeenCalled();
    });

    it("keeps an active turn generation until the enclosing operation releases its lock", async () => {
        let current = credential();
        const { manager } = harness({ acquire: async () => current });
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const old = await manager.ensureClient(token);
        const warm = { destroy: vi.fn(async () => {}), closeWorkflowTools() {}, getWorkspaceState: () => ({}) };
        manager.sessions.set("s", warm);
        manager.sessionClientKeys.set("s", token);
        let finish, enter;
        const holding = new Promise(resolve => { finish = resolve; });
        const entered = new Promise(resolve => { enter = resolve; });
        const turn = manager.withRunTurnLock("s", "runTurn", async () => { enter(); await holding; });
        await entered;
        current = credential("two");
        await manager.withModelClient("shared-native:native", 60_000, async () => {});
        expect(warm.destroy).not.toHaveBeenCalled();
        expect(old.stop).not.toHaveBeenCalled();
        finish();
        await turn;
        expect(warm.destroy).toHaveBeenCalledOnce();
        expect(old.stop).toHaveBeenCalledOnce();
    });

    it("waits for discovery to finish before final client shutdown", async () => {
        const fixed = credential();
        const { manager } = harness({ acquire: async () => fixed });
        let finish, enter;
        const holding = new Promise(resolve => { finish = resolve; });
        const entered = new Promise(resolve => { enter = resolve; });
        const discovery = manager.withModelClient("shared-native:native", 60_000, async () => { enter(); await holding; });
        await entered;
        const client = fake.clients[0];
        const stopping = manager.shutdown();
        await Promise.resolve();
        expect(client.stop).not.toHaveBeenCalled();
        finish();
        await Promise.all([discovery, stopping]);
        expect(client.stop).toHaveBeenCalledOnce();
    });

    it("force-stops an idle retired client when SDK stop returns cleanup errors", async () => {
        let current = credential();
        const { manager } = harness({ acquire: async () => current });
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const client = await manager.ensureClient(token);
        client.stop.mockResolvedValue([new Error("native cleanup failed")]);
        client.forceStop = vi.fn(async () => {});
        current = credential("two");
        await manager._resolveSessionGitHubToken("other", {}, "shared-native:native");
        await manager.retireGitHubClients();
        expect(client.forceStop).toHaveBeenCalledOnce();
        expect(manager.clients.has(token)).toBe(false);
    });

    it("serializes concurrent source calls and checks remaining validity after a slow acquisition", async () => {
        const now = Date.now();
        let clock = now;
        vi.spyOn(Date, "now").mockImplementation(() => clock);
        let active = 0, maximum = 0, calls = 0, finish;
        const gate = new Promise(resolve => { finish = resolve; });
        const { manager } = harness({ acquire: async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            const generation = String(++calls);
            if (calls === 1) await gate;
            active -= 1;
            return credential(generation, { expiresAtMs: now + 30 * 60_000 });
        } });
        const first = manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const second = manager._resolveSessionGitHubToken("t", {}, "shared-native:native");
        const checkedFirst = expect(first).rejects.toThrow(/short-lived/);
        const checkedSecond = expect(second).rejects.toThrow(/short-lived/);
        await Promise.resolve();
        clock += 1;
        finish();
        await Promise.all([checkedFirst, checkedSecond]);
        expect(maximum).toBe(1);
        expect(fake.clients).toHaveLength(0);
    });

    it("revisits an owner released while another client's retirement is awaiting detachment", async () => {
        let current = credential();
        const { manager } = harness({ acquire: async () => current });
        const token = await manager._resolveSessionGitHubToken("a", {}, "shared-native:native");
        const clientA = await manager.ensureClient(token, false, "workspace-a");
        const clientB = await manager.ensureClient(token, false, "workspace-b");
        for (const [id, client] of [["a", clientA], ["b", clientB]]) {
            const key = [...manager.clients].find(([, candidate]) => candidate === client)[0];
            manager.sessionClientKeys.set(id, key);
        }
        let endTurn, enterTurn, endDetach, enterDetach;
        const turnGate = new Promise(resolve => { endTurn = resolve; });
        const turnEntered = new Promise(resolve => { enterTurn = resolve; });
        const detachGate = new Promise(resolve => { endDetach = resolve; });
        const detachEntered = new Promise(resolve => { enterDetach = resolve; });
        manager.sessions.set("a", { destroy: vi.fn(async () => {}), closeWorkflowTools() {}, getWorkspaceState: () => ({}) });
        manager.sessions.set("b", { destroy: vi.fn(async () => { enterDetach(); await detachGate; }),
            closeWorkflowTools() {}, getWorkspaceState: () => ({}) });
        const turn = manager.withRunTurnLock("a", "runTurn", async () => { enterTurn(); await turnGate; });
        await turnEntered;
        current = credential("two");
        await manager._resolveSessionGitHubToken("other", {}, "shared-native:native");
        const retirement = manager.retireGitHubClients();
        await detachEntered;
        endTurn();
        await vi.waitFor(() => expect(manager.sessionLocks.has("a")).toBe(false));
        endDetach();
        await Promise.all([turn, retirement]);
        expect(clientA.stop).toHaveBeenCalledOnce();
        expect(clientB.stop).toHaveBeenCalledOnce();
        expect(manager.clients.size).toBe(0);
    });

    it("does not replace an unavailable selected/default source with the worker's static token", async () => {
        const { manager, authority } = harness();
        manager.setModelProviders(new ModelProviderRegistry({ providers: [] }, { keepUncredentialed: true }));
        expect(await manager.acquireModelSessionOptions(undefined, 60_000)).toBeNull();
        expect(authority.acquire).not.toHaveBeenCalled();
        expect(fake.clients).toHaveLength(0);
    });

    it("regeneration selects the requested session provider and passes its actual operation timeout", async () => {
        vi.stubEnv("PILOTSWARM_REGEN_LLM_DISTILLER", "1");
        const resolveModelOptions = vi.fn(async () => { throw new Error("GitHub credential acquisition failed"); });
        const uploadArtifact = vi.fn();
        await expect(runRegenDistill({
            catalog: { getSessionEventsBefore: async () => [], getSessionEvents: async () => [],
                getDescendantSessionIds: async () => [] },
            artifactStore: { listArtifacts: async () => [], uploadArtifact },
            resolveModelOptions, trace() {},
        }, { sessionId: "s", epoch: 1, attemptId: "attempt", sessionModel: "shared-native:native" }))
            .rejects.toThrow("GitHub credential acquisition failed");
        expect(resolveModelOptions).toHaveBeenCalledExactlyOnceWith("shared-native:native", 90_000);
        expect(uploadArtifact).not.toHaveBeenCalled();
        expect(fake.clients).toHaveLength(0);
    });

    it("uses the same authority for model discovery and selected-model vision capabilities", async () => {
        const fixed = credential();
        const { manager, authority } = harness({ acquire: vi.fn(async () => fixed) });
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const client = await manager.ensureClient(token);
        client.listModels.mockResolvedValue([{ id: "native", capabilities: {
            supports: { vision: true }, limits: { vision: { max_prompt_images: 3 } },
        } }]);
        expect(await manager.listExternalGitHubModels()).toHaveLength(1);
        expect(await manager.getModelVisionInfo("shared-native:native", { sessionId: "s" }))
            .toMatchObject({ modelId: "native", known: true, vision: true, maxImages: 3 });
        expect(authority.acquire.mock.calls.map(args => args[0])).toEqual([30 * 60_000, 11 * 60_000, 11 * 60_000]);
        expect(manager.sessionCatalog.getUserGitHubCopilotKey).not.toHaveBeenCalled();
        expect(fake.clients).toHaveLength(1);
    });

    it("acquires for ownerless system sessions without borrowing the System user's legacy key", async () => {
        const fixed = credential();
        const { manager, authority } = harness({ acquire: vi.fn(async () => fixed) });
        const row = { isSystem: true, owner: null };
        expect(await manager._resolveSessionGitHubToken("system", {}, "shared-native:native", row)).toBe(fixed.token);
        expect(authority.acquire).toHaveBeenCalledWith(30 * 60_000);
        expect(manager.sessionCatalog.getUserGitHubCopilotKey).not.toHaveBeenCalled();
    });

    it("does not grow the idle client/process pool across successive historical generations", async () => {
        let current = credential("0");
        const { manager } = harness({ acquire: async () => current });
        for (let generation = 0; generation < 7; generation += 1) {
            current = credential(String(generation));
            await manager.withModelClient("shared-native:native", 60_000, async () => {});
            expect(manager.clients.size).toBe(1);
        }
        expect(fake.clients.filter(client => client.stop.mock.calls.length === 0)).toHaveLength(1);
        expect(fake.clients.slice(0, -1).every(client => client.stop.mock.calls.length === 1)).toBe(true);
    });

    it("bounds a real SDK disconnect hang without losing its binding or blocking shutdown", async () => {
        const { CopilotSession } = await import("@github/copilot-sdk");
        vi.useFakeTimers();
        let current = credential();
        const { manager } = harness({ acquire: async () => current });
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const client = await manager.ensureClient(token);
        let releaseDisconnect;
        const disconnected = new Promise(resolve => { releaseDisconnect = resolve; });
        const native = new CopilotSession("s", { sendRequest: vi.fn(() => disconnected) });
        const warm = new ManagedSession("s", native, {});
        manager.sessions.set("s", warm);
        manager.sessionClientKeys.set("s", token);
        current = credential("two");
        await manager._resolveSessionGitHubToken("other", {}, "shared-native:native");
        const retiring = manager.retireGitHubClients();
        let returned = false;
        const unrelated = manager.withRunTurnLock("other", "runTurn", async () => {})
            .then(() => { returned = true; });
        try {
            await vi.advanceTimersByTimeAsync(20_000);
            expect(returned).toBe(true);
            await unrelated;
            expect(manager.sessionClientKeys.get("s")).toBe(token);
            expect(manager.sessions.get("s")).toBe(warm);
            expect(client.stop).not.toHaveBeenCalled();
            await manager.shutdown();
            expect(client.stop).toHaveBeenCalledOnce();
        } finally {
            releaseDisconnect({ success: true });
            await Promise.all([retiring, unrelated]);
            vi.useRealTimers();
        }
    });
});
