import test from "node:test";
import assert from "node:assert/strict";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { buildRuntimeRegistry, resolveProviderCredential } from "../../dist/provider-catalog.js";
import { SessionManager } from "../../dist/session-manager.js";
import { needsByokRequestCompatibility } from "../../dist/copilot-client.js";

for (const wireApi of ["responses", "completions", undefined]) {
    test(`provider API format survives catalog and session resolution: ${wireApi ?? "default"}`, () => {
        const types = new ModelProviderRegistry({
            providers: [{
                id: "foundry", type: "openai", baseUrl: "https://example.invalid/openai/v1",
                apiKey: "type-key", models: ["test-model"],
                ...(wireApi ? { wireApi } : {}),
            }],
        });
        const credential = {
            name: "shared-foundry", typeId: "foundry", class: "shared", ownerUserId: null,
            baseUrl: null, secretRef: { kind: "apiKey", value: "instance-key" },
        };
        const direct = types.resolve("foundry:test-model").sdkProvider;
        const resolved = resolveProviderCredential(types, credential, "test-model").sdkProvider;
        const runtime = buildRuntimeRegistry(types, [credential], "shared-foundry:test-model");
        const manager = new SessionManager(undefined, null, { modelProviders: runtime });
        const session = manager._resolveProviderConfig("shared-foundry:test-model").provider;
        for (const provider of [direct, resolved, session]) {
            assert.equal(provider.wireApi, wireApi);
            if (!wireApi) assert.equal(Object.hasOwn(provider, "wireApi"), false);
        }
        assert.equal(session.apiKey, "instance-key");
    });
}

// ─── Per-model wireApi ───────────────────────────────────────────

/**
 * The SDK provider for one model on all three paths: the file's own
 * resolve(), resolveProviderCredential() for a database provider, and the
 * runtime registry a worker hands to SessionManager.
 */
function resolveOnEveryPath(providerConfig, modelName) {
    const types = new ModelProviderRegistry({ providers: [providerConfig] });
    const credential = {
        name: `shared-${providerConfig.id}`, typeId: providerConfig.id, class: "shared", ownerUserId: null,
        baseUrl: null, secretRef: { kind: "apiKey", value: "instance-key" },
    };
    const runtime = buildRuntimeRegistry(types, [credential], `${credential.name}:${modelName}`);
    const manager = new SessionManager(undefined, null, { modelProviders: runtime });
    return {
        direct: types.resolve(`${providerConfig.id}:${modelName}`).sdkProvider,
        credential: resolveProviderCredential(types, credential, modelName).sdkProvider,
        session: manager._resolveProviderConfig(`${credential.name}:${modelName}`).provider,
    };
}

function assertWireApiOnEveryPath(paths, expected) {
    for (const [name, provider] of Object.entries(paths)) {
        assert.equal(provider.wireApi, expected, `${name} path`);
        if (!expected) assert.equal(Object.hasOwn(provider, "wireApi"), false, `${name} path`);
    }
}

const foundry = (over = {}) => ({
    id: "foundry", type: "openai", baseUrl: "https://example.invalid/openai/v1", apiKey: "type-key", ...over,
});

test("a model's wireApi applies when the provider sets none; a sibling without one leaves the key out", () => {
    const config = foundry({ models: [{ name: "gpt-5.6", wireApi: "responses" }, { name: "plain" }] });
    assertWireApiOnEveryPath(resolveOnEveryPath(config, "gpt-5.6"), "responses");
    assertWireApiOnEveryPath(resolveOnEveryPath(config, "plain"), undefined);
});

test("a model's wireApi wins over the provider's; siblings without one inherit it", () => {
    const config = foundry({
        wireApi: "responses",
        models: [{ name: "gpt-5.4", wireApi: "completions" }, { name: "object-model" }, "string-model"],
    });
    assertWireApiOnEveryPath(resolveOnEveryPath(config, "gpt-5.4"), "completions");
    assertWireApiOnEveryPath(resolveOnEveryPath(config, "object-model"), "responses");
    assertWireApiOnEveryPath(resolveOnEveryPath(config, "string-model"), "responses");
});

test("two models of one azure provider get different formats, and only the completions one gets the shim", () => {
    const config = {
        id: "azure-foundry", type: "azure", baseUrl: "https://example.invalid/openai", apiKey: "type-key",
        wireApi: "completions",
        models: [{ name: "gpt-5.6", wireApi: "responses" }, { name: "gpt-5.4" }],
    };
    const responses = resolveOnEveryPath(config, "gpt-5.6");
    const completions = resolveOnEveryPath(config, "gpt-5.4");
    assertWireApiOnEveryPath(responses, "responses");
    assertWireApiOnEveryPath(completions, "completions");
    for (const provider of Object.values(responses)) {
        assert.equal(provider.type, "azure");
        assert.equal(needsByokRequestCompatibility(provider), false);
    }
    for (const provider of Object.values(completions)) {
        assert.equal(needsByokRequestCompatibility(provider), true);
    }
});

for (const keepUncredentialed of [false, true]) {
    test(`a bad per-model wireApi fails when the registry is built (keepUncredentialed ${keepUncredentialed})`, () => {
        const build = (config) => new ModelProviderRegistry({ providers: [config] }, { keepUncredentialed });
        assert.throws(
            () => build(foundry({ models: [{ name: "m", wireApi: "websockets" }] })),
            /Invalid wireApi "websockets" on model foundry:m/,
        );
        for (const type of ["github", "anthropic", "anthropic-wif"]) {
            assert.throws(
                () => build({
                    id: `p-${type}`, type, baseUrl: "https://example.invalid", apiKey: "k",
                    models: [{ name: "m", wireApi: "responses" }],
                }),
                new RegExp(`Invalid wireApi on model p-${type}:m: provider type "${type}"`),
            );
        }
        for (const type of ["openai", "openai-proxy", "azure"]) {
            const registry = build({
                id: `p-${type}`, type, baseUrl: "https://example.invalid", apiKey: "k",
                models: [{ name: "m", wireApi: "responses" }],
            });
            assert.equal(registry.getDescriptor(`p-${type}:m`).wireApi, "responses");
        }
    });
}
