import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "../../dist/session-manager.js";

function byokRegistry(count) {
    const allModels = Array.from({ length: count }, (_, index) => ({
        qualifiedName: `byok:model-${index}`,
        modelName: `model-${index}`,
        providerType: "openai",
    }));
    return {
        allModels,
        defaultModel: allModels[0]?.qualifiedName,
        resolve(qualifiedName) {
            return allModels.some((model) => model.qualifiedName === qualifiedName)
                ? { type: "openai", sdkProvider: { apiKey: "test-key" } }
                : null;
        },
    };
}

function githubRegistry(token) {
    const descriptor = {
        qualifiedName: "github-copilot:claude-sonnet-5",
        modelName: "claude-sonnet-5",
        providerType: "github",
    };
    return {
        allModels: [descriptor],
        defaultModel: descriptor.qualifiedName,
        resolve(qualifiedName) {
            return qualifiedName === descriptor.qualifiedName
                ? { type: "github", ...(token ? { githubToken: token } : {}) }
                : null;
        },
    };
}

test("advertised models are a subset of the bounded routing universe", async () => {
    const manager = new SessionManager(undefined, null, {
        modelProviders: byokRegistry(65),
    });

    const configured = manager.configuredWorkerModels();
    const advertised = await manager.refreshWorkerModels();

    assert.equal(configured.length, 64);
    assert.deepEqual(advertised.available, configured);
    assert.ok(advertised.available.every((model) => configured.includes(model)));
    assert.equal(advertised.available.includes("byok:model-64"), false);
});

test("provider refresh cannot advertise a model outside the startup routing universe", async () => {
    const manager = new SessionManager(undefined, null, {
        modelProviders: byokRegistry(1),
    });
    assert.deepEqual(manager.configuredWorkerModels(), ["byok:model-0"]);

    const replacement = byokRegistry(2);
    replacement.allModels = [{
        qualifiedName: "replacement:model",
        modelName: "model",
        providerType: "openai",
    }];
    replacement.defaultModel = "replacement:model";
    replacement.resolve = (qualifiedName) => (
        qualifiedName === "replacement:model"
            ? { type: "openai", sdkProvider: { apiKey: "replacement-key" } }
            : null
    );
    manager.setModelProviders(replacement);

    assert.deepEqual(manager.configuredWorkerModels(), ["byok:model-0"]);
    assert.deepEqual(await manager.refreshWorkerModels(), { available: [] });
});

test("equivalent provider reconciliation preserves the advertised snapshot", async () => {
    const manager = new SessionManager(undefined, null, {
        modelProviders: byokRegistry(1),
    });
    await manager.refreshWorkerModels();
    const fetchedAt = manager.workerModelCache.fetchedAt;

    manager.setModelProviders(byokRegistry(1));

    assert.deepEqual(manager.currentWorkerModels(), {
        defaultModel: "byok:model-0",
        available: ["byok:model-0"],
    });
    assert.equal(manager.workerModelCache.fetchedAt, fetchedAt);
});

test("provider removal immediately filters the advertised snapshot", async () => {
    const manager = new SessionManager(undefined, null, {
        modelProviders: byokRegistry(2),
    });
    await manager.refreshWorkerModels();

    manager.setModelProviders(byokRegistry(1));

    assert.deepEqual(manager.currentWorkerModels(), {
        defaultModel: "byok:model-0",
        available: ["byok:model-0"],
    });
    assert.equal(manager.workerModelCache.fetchedAt, 0);
});

test("concurrent capability refreshes share one discovery request", async () => {
    const manager = new SessionManager(undefined, null, {
        modelProviders: byokRegistry(1),
    });
    let discoveries = 0;
    let release;
    manager._discoverWorkerModels = async () => {
        discoveries += 1;
        await new Promise((resolve) => {
            release = resolve;
        });
        return { available: ["byok:model-0"] };
    };

    const first = manager.refreshWorkerModels();
    const second = manager.refreshWorkerModels();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(discoveries, 1);
    release();
    assert.deepEqual(await first, { available: ["byok:model-0"] });
    assert.deepEqual(await second, { available: ["byok:model-0"] });
});

test("transient GitHub discovery failure preserves the last successful snapshot", async () => {
    const manager = new SessionManager("test-token", null, {
        modelProviders: githubRegistry(),
    });
    const previous = {
        defaultModel: "github-copilot:claude-sonnet-5",
        available: ["github-copilot:claude-sonnet-5"],
    };
    manager.workerModelCache = { fetchedAt: 0, value: previous };
    manager._discoverGitHubWorkerModelIds = async () => {
        throw new Error("temporary discovery failure");
    };

    const refreshed = await manager.refreshWorkerModels();

    assert.deepEqual(refreshed, previous);
    assert.deepEqual(manager.currentWorkerModels(), previous);
    assert.ok(manager.workerModelCache.fetchedAt > 0);
});

test("GitHub capability discovery uses the provider instance credential", async () => {
    const manager = new SessionManager(undefined, null, {
        modelProviders: githubRegistry("provider-token"),
    });
    const tokens = [];
    manager._discoverGitHubWorkerModelIds = async (token) => {
        tokens.push(token);
        return new Set(["claude-sonnet-5"]);
    };

    assert.deepEqual(await manager.refreshWorkerModels(), {
        defaultModel: "github-copilot:claude-sonnet-5",
        available: ["github-copilot:claude-sonnet-5"],
    });
    assert.deepEqual(tokens, ["provider-token"]);
});

test("provider instance credentials take precedence over the worker fallback token", async () => {
    const manager = new SessionManager("worker-token", null, {
        modelProviders: githubRegistry("provider-token"),
    });
    const tokens = [];
    manager._discoverGitHubWorkerModelIds = async (token) => {
        tokens.push(token);
        return new Set(["claude-sonnet-5"]);
    };

    await manager.refreshWorkerModels();

    assert.deepEqual(tokens, ["provider-token"]);
});

test("owner-affinitized in-session model switching stays within advertised capabilities", async () => {
    const manager = new SessionManager(undefined, null, {
        modelProviders: byokRegistry(2),
    });
    manager.setSessionCatalog({
        providers: null,
        async getSessionRouting() {
            return { repo: "sample-repo", ownerAffinityRequired: true };
        },
    });
    manager.workerModelCache = {
        fetchedAt: Date.now(),
        value: {
            defaultModel: "byok:model-0",
            available: ["byok:model-0"],
        },
    };
    manager.normalizeModelRefForSession = async (_sessionId, model) => model;

    await assert.rejects(
        manager.resolveModelSwitchConfigForSession("session-1", "byok:model-1"),
        /not advertised by this owner-affinitized worker/,
    );
});
