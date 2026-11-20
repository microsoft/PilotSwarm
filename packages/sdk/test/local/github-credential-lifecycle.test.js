import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "../../src/session-manager.ts";
import { ManagedSession } from "../../src/managed-session.ts";
import { runRegenDistill } from "../../src/regen-worker.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { bootstrapProviders, buildRuntimeRegistry, resolveProviderCredential } from "../../src/provider-catalog.ts";
import { sendCopilotPrompt } from "../../src/copilot-client.js";
import { createTempSessionLayout } from "../helpers/temp-session-layout.js";

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
const layouts = [];
const managers = [];
function credential(generation = "one", extra = {}) {
    return { token: `synthetic-${generation}`, generation, scopeId: "inference-scope",
        expiresAtMs: Date.now() + 60 * 60_000, ...extra };
}
function nativeSession() {
    return { on: () => () => {}, registerTools: vi.fn(),
        disconnect: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
}
function harness(overrides = {}) {
    const layout = createTempSessionLayout("github-credentials-");
    layouts.push(layout);
    const authority = { providerName: "shared-native", typeId: "github-type", scopeId: "inference-scope",
        acquire: vi.fn(async () => credential()), ...overrides };
    const registry = buildRuntimeRegistry(types, [instance], "shared-native:native");
    const manager = new SessionManager("legacy-worker-token", null, {
        modelProviders: registry, githubCredentialProvider: authority,
    }, layout.sessionStateDir);
    managers.push(manager);
    manager.setFactStore({ readFacts: async () => ({ facts: [] }) });
    manager.setSessionCatalog({ getSession: async () => ({ owner: { provider: "test", subject: "person" } }),
        getUserGitHubCopilotKey: vi.fn(async () => "legacy-personal-token") });
    return { manager, authority, registry };
}
afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.shutdown();
    for (const layout of layouts.splice(0)) layout.cleanup();
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
    it("requests thirty minutes and fails closed without an authority or personal fallback", async () => {
        const { manager, authority } = harness();
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        expect(token).toBe("synthetic-one");
        expect(authority.acquire).toHaveBeenCalledWith(30 * 60_000);
        expect(manager.sessionCatalog.getUserGitHubCopilotKey).not.toHaveBeenCalled();
        const client = await manager.ensureClient(token);
        expect(client.options.gitHubToken).toBe(token);
        expect(client.options.useLoggedInUser).toBe(false);
        manager.githubCredentials = undefined;
        await expect(manager._resolveSessionGitHubToken("other", {}, "shared-native:native"))
            .rejects.toThrow(/authority is not configured/);
        expect(manager.sessionCatalog.getUserGitHubCopilotKey).not.toHaveBeenCalled();
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

    it("does not retire a discovery lease while startup or its model-list request is in flight", async () => {
        let current = credential();
        const { manager } = harness({ acquire: async () => current });
        const pending = Promise.withResolvers();
        const ready = Promise.withResolvers();
        const discovering = manager.withModelClient("shared-native:native", 60_000, async () => {
            ready.resolve();
            await pending.promise;
            return "models";
        });
        await ready.promise;
        const old = fake.clients[0];
        current = credential("two");
        await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        await manager.retireGitHubClients();
        expect(old.stop).not.toHaveBeenCalled();
        pending.resolve();
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
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const firstClient = await manager.ensureClient(token);
        const firstSession = nativeSession();
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
        nextClient.resumeSession = vi.fn(async () => nativeSession());
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
        const config = { model: "shared-native:native", toolNames: [] };
        const token = await manager._resolveSessionGitHubToken("s", {}, config.model);
        const client = await manager.ensureClient(token);
        client.createSession = vi.fn(async () => nativeSession());
        if (warm) await manager.getOrCreate("s", config, { turnIndex: 0 });
        else fs.mkdirSync(path.join(manager.sessionStateDir, "s"), { recursive: true });

        const native = {
            ...nativeSession(),
            send: vi.fn(async () => { throw new Error("unexpected model send after credential expiry"); }),
        };
        const resetEntered = Promise.withResolvers();
        const resetHeld = Promise.withResolvers();
        const setupEntered = Promise.withResolvers();
        const setupHeld = Promise.withResolvers();
        const activeEntered = Promise.withResolvers();
        const activeHeld = Promise.withResolvers();
        manager.sessionStore = { exists: async () => false,
            delete: vi.fn(async () => { resetEntered.resolve(); await resetHeld.promise; }) };
        client.createSession.mockImplementation(async () => { setupEntered.resolve(); await setupHeld.promise; return native; });
        const turn = manager.withRunTurnLock("s", "runTurn", async () => {
            const managed = await manager.getOrCreate("s", config, { ...options, lockHeld: true });
            activeEntered.resolve();
            await activeHeld.promise;
            return managed.runTurn("must reject the old credential", {
                beforeModelExecution: () => manager.assertSessionGitHubCredential("s"),
            });
        });
        try {
            await resetEntered.promise;
            const resetBinding = manager.sessionClientKeys.get("s");
            current = credential("two");
            await manager.withModelClient(config.model, 60_000, async () => {});
            const stoppedDuringReset = client.stop.mock.calls.length;
            resetHeld.resolve();
            await setupEntered.promise;
            const setupBinding = manager.sessionClientKeys.get("s");
            current = credential("three");
            await manager.withModelClient(config.model, 60_000, async () => {});
            const stoppedDuringSetup = client.stop.mock.calls.length;
            setupHeld.resolve();
            await activeEntered.promise;
            const activeBinding = manager.sessionClientKeys.get("s");
            await manager.retireGitHubClients();
            const stoppedDuringActive = client.stop.mock.calls.length;
            clock += 60_000;
            activeHeld.resolve();
            const result = await turn;
            expect({ resetBinding, setupBinding, activeBinding, stoppedDuringReset, stoppedDuringSetup, stoppedDuringActive })
                .toEqual({ resetBinding: token, setupBinding: token, activeBinding: token,
                    stoppedDuringReset: 0, stoppedDuringSetup: 0, stoppedDuringActive: 0 });
            expect(result).toMatchObject({ type: "error", message: expect.stringContaining("remaining validity") });
            expect(native.send).not.toHaveBeenCalled();
            expect(client.stop).toHaveBeenCalledOnce();
        } finally {
            resetHeld.resolve();
            setupHeld.resolve();
            activeHeld.resolve();
            await turn.catch(() => {});
        }
    });

    it("public reset clears the old admission binding and warm handle", async () => {
        const fixed = credential();
        const { manager } = harness({ acquire: async () => fixed });
        manager.sessionCatalog = null;
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const client = await manager.ensureClient(token);
        client.createSession = vi.fn(async () => nativeSession());
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
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const firstClient = await manager.ensureClient(token);
        const session = nativeSession();
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
        manager.authorizeWorkflowTools = vi.fn(async () => null);
        const config = { model: "shared-native:native", toolNames: [] };
        const binding = { policy: "node-parent-tools-v1", parentSessionId: "parent",
            owner: { provider: "test", subject: "person" }, config,
            tools: [], excludedTools: [], capabilities: { revision: 0, selections: [] } };
        const native = () => ({
            ...nativeSession(),
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

    it("keeps an active turn generation until the enclosing operation releases its lock", async () => {
        let current = credential();
        const { manager } = harness({ acquire: async () => current });
        const token = await manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const old = await manager.ensureClient(token);
        const warm = { destroy: vi.fn(async () => {}), closeWorkflowTools() {}, getWorkspaceState: () => ({}) };
        manager.sessions.set("s", warm);
        manager.sessionClientKeys.set("s", token);
        const holding = Promise.withResolvers();
        const entered = Promise.withResolvers();
        const turn = manager.withRunTurnLock("s", "runTurn", async () => { entered.resolve(); await holding.promise; });
        await entered.promise;
        current = credential("two");
        await manager.withModelClient("shared-native:native", 60_000, async () => {});
        expect(warm.destroy).not.toHaveBeenCalled();
        expect(old.stop).not.toHaveBeenCalled();
        holding.resolve();
        await turn;
        expect(warm.destroy).toHaveBeenCalledOnce();
        expect(old.stop).toHaveBeenCalledOnce();
    });

    it("waits for discovery to finish before final client shutdown", async () => {
        const fixed = credential();
        const { manager } = harness({ acquire: async () => fixed });
        const holding = Promise.withResolvers();
        const entered = Promise.withResolvers();
        const discovery = manager.withModelClient("shared-native:native", 60_000, async () => { entered.resolve(); await holding.promise; });
        await entered.promise;
        const client = fake.clients[0];
        const stopping = manager.shutdown();
        await Promise.resolve();
        expect(client.stop).not.toHaveBeenCalled();
        holding.resolve();
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
        let active = 0, maximum = 0, calls = 0;
        const gate = Promise.withResolvers();
        const { manager } = harness({ acquire: async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            const generation = String(++calls);
            if (calls === 1) await gate.promise;
            active -= 1;
            return credential(generation, { expiresAtMs: now + 30 * 60_000 });
        } });
        const first = manager._resolveSessionGitHubToken("s", {}, "shared-native:native");
        const second = manager._resolveSessionGitHubToken("t", {}, "shared-native:native");
        const checkedFirst = expect(first).rejects.toThrow(/short-lived/);
        const checkedSecond = expect(second).rejects.toThrow(/short-lived/);
        await Promise.resolve();
        clock += 1;
        gate.resolve();
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
        const turnGate = Promise.withResolvers();
        const turnEntered = Promise.withResolvers();
        const detachGate = Promise.withResolvers();
        const detachEntered = Promise.withResolvers();
        manager.sessions.set("a", { destroy: vi.fn(async () => {}), closeWorkflowTools() {}, getWorkspaceState: () => ({}) });
        manager.sessions.set("b", { destroy: vi.fn(async () => { detachEntered.resolve(); await detachGate.promise; }),
            closeWorkflowTools() {}, getWorkspaceState: () => ({}) });
        const turn = manager.withRunTurnLock("a", "runTurn", async () => { turnEntered.resolve(); await turnGate.promise; });
        await turnEntered.promise;
        current = credential("two");
        await manager._resolveSessionGitHubToken("other", {}, "shared-native:native");
        const retirement = manager.retireGitHubClients();
        await detachEntered.promise;
        turnGate.resolve();
        await vi.waitFor(() => expect(manager.sessionLocks.has("a")).toBe(false));
        detachGate.resolve();
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
        const disconnected = Promise.withResolvers();
        const native = new CopilotSession("s", { sendRequest: vi.fn(() => disconnected.promise) });
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
            disconnected.resolve({ success: true });
            await Promise.all([retiring, unrelated]);
            vi.useRealTimers();
        }
    });
});
