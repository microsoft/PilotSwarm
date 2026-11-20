import test from "node:test";
import assert from "node:assert/strict";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import * as providerCatalog from "../../dist/provider-catalog.js";

const {
    buildRuntimeRegistry,
    firstRuntimeModel,
    loadProviderTypes,
    ModelUnresolvedError,
    resolveProviderCredential,
    resolveQualifiedDecisionProviderCredential,
    resolveRuntimeDecisionProvider,
    resolveRuntimeModelSelection,
} = providerCatalog;

const mixedProvider = (over = {}) => ({
    id: "mixed-type", type: "openai", baseUrl: "https://type.example.invalid/openai/v1",
    models: [{ name: "chat-model", description: "For chat" }],
    decisionModels: [{ name: "decision-model", description: "For Workflow decisions" }],
    ...over,
});

function credentialFor(typeId, over = {}) {
    return {
        name: `shared-${typeId}`, typeId, class: "shared", ownerUserId: null,
        baseUrl: "https://instance.example.invalid/openai/v1",
        secretRef: { kind: "apiKey", value: "instance-test-key" }, ...over,
    };
}

test("a provider config validates separate chat and Decision model lists", () => {
    const config = { providers: [mixedProvider()], defaultModel: "mixed-type:chat-model" };
    let registry;
    assert.doesNotThrow(() => { registry = loadProviderTypes(config); });
    assert.deepEqual(registry.allModels.map(model => model.qualifiedName), ["mixed-type:chat-model"]);
    assert.deepEqual(registry.allDecisionModels, [{
        qualifiedName: "mixed-type:decision-model", modelName: "decision-model",
        providerId: "mixed-type", providerType: "openai", description: "For Workflow decisions",
    }]);
});

test("every chat registry API excludes Decision models", () => {
    const registry = new ModelProviderRegistry({
        providers: [mixedProvider({ apiKey: "type-test-key" })],
        defaultModel: "mixed-type:chat-model",
    });
    assert.deepEqual(registry.allModels.map(model => model.qualifiedName), ["mixed-type:chat-model"]);
    assert.deepEqual(registry.getModelsByProvider().flatMap(group => group.models)
        .map(model => model.qualifiedName), ["mixed-type:chat-model"]);
    assert.match(registry.getModelSummaryForLLM(), /mixed-type:chat-model/);
    assert.doesNotMatch(registry.getModelSummaryForLLM(), /decision-model|For Workflow decisions/);
    for (const ref of ["chat-model", "mixed-type:chat-model"]) {
        assert.equal(registry.hasModel(ref), true);
        assert.equal(registry.normalize(ref), "mixed-type:chat-model");
        assert.equal(registry.getDescriptor(ref).modelName, "chat-model");
        assert.equal(registry.resolve(ref).modelName, "chat-model");
    }
    for (const ref of ["decision-model", "mixed-type:decision-model"]) {
        assert.equal(registry.hasModel(ref), false);
        assert.equal(registry.normalize(ref), undefined);
        assert.equal(registry.getDescriptor(ref), undefined);
        assert.equal(registry.resolve(ref), undefined);
    }
});

test("Decision registry APIs enumerate and resolve only Decision models", () => {
    const registry = new ModelProviderRegistry({
        providers: [mixedProvider({ apiKey: "type-test-key" })],
    });
    assert.deepEqual(registry.allDecisionModels.map(model => model.qualifiedName),
        ["mixed-type:decision-model"]);
    assert.deepEqual(registry.getDecisionModelsByProvider().flatMap(group => group.models)
        .map(model => model.qualifiedName), ["mixed-type:decision-model"]);
    for (const ref of ["decision-model", "mixed-type:decision-model"]) {
        assert.equal(registry.hasDecisionModel(ref), true);
        assert.equal(registry.normalizeDecision(ref), "mixed-type:decision-model");
        assert.equal(registry.getDecisionDescriptor(ref).modelName, "decision-model");
        const resolved = registry.resolveDecision(ref);
        assert.equal(resolved.providerId, "mixed-type");
        assert.equal(resolved.modelName, "decision-model");
    }
    for (const ref of ["chat-model", "mixed-type:chat-model"]) {
        assert.equal(registry.hasDecisionModel(ref), false);
        assert.equal(registry.normalizeDecision(ref), undefined);
        assert.equal(registry.getDecisionDescriptor(ref), undefined);
        assert.equal(registry.resolveDecision(ref), undefined);
    }
});

test("chat and Decision bare aliases use independent lookup tables", () => {
    const registry = loadProviderTypes({ providers: [
        mixedProvider({ id: "decisions-first", models: [], decisionModels: [{ name: "shared-name" }] }),
        mixedProvider({ id: "chat-second", models: [{ name: "shared-name" }], decisionModels: [] }),
    ] });
    assert.equal(registry.normalize("shared-name"), "chat-second:shared-name");
    assert.equal(registry.normalizeDecision("shared-name"), "decisions-first:shared-name");
    assert.equal(registry.getDescriptor("shared-name").providerId, "chat-second");
    assert.equal(registry.getDecisionDescriptor("shared-name").providerId, "decisions-first");
});

test("Decision resolution inherits neither the chat default nor the first Decision model", () => {
    const registry = loadProviderTypes({
        providers: [mixedProvider()], defaultModel: "mixed-type:chat-model",
    });
    assert.equal(registry.defaultModel, "mixed-type:chat-model");
    assert.equal(registry.normalize(), "mixed-type:chat-model");
    assert.equal(registry.normalizeDecision(), undefined);
    assert.equal(registry.getDecisionDescriptor(), undefined);
    assert.equal(registry.resolveDecision(), undefined);
});

test("a Decision entry cannot be configured as the chat default", () => {
    assert.throws(() => loadProviderTypes({
        providers: [mixedProvider()], defaultModel: "mixed-type:decision-model",
    }), /Invalid defaultModel/);
});

for (const omitModels of [false, true]) {
    test(`a Decision-only type is representable with ${omitModels ? "omitted" : "empty"} chat models`, () => {
        const provider = mixedProvider({ id: "decision-only", models: [], baseUrl: undefined });
        if (omitModels) delete provider.models;
        const types = loadProviderTypes({ providers: [provider] });
        assert.deepEqual(types.allProviders.map(type => type.id), ["decision-only"]);
        assert.deepEqual(types.allModels, []);
        assert.deepEqual(types.allDecisionModels.map(model => model.qualifiedName),
            ["decision-only:decision-model"]);
        assert.equal(types.defaultModel, undefined);
    });
}

test("a Decision-only type gains an instance-qualified runtime catalog without a chat model", () => {
    const types = loadProviderTypes({ providers: [
        mixedProvider({ id: "decision-only", models: [], baseUrl: undefined }),
    ] });
    const instance = credentialFor("decision-only");
    const runtime = buildRuntimeRegistry(types, [instance]);
    assert.deepEqual(runtime.allProviders.map(provider => provider.id), [instance.name]);
    assert.deepEqual(runtime.allModels, []);
    assert.equal(runtime.defaultModel, undefined);
    assert.deepEqual(runtime.allDecisionModels.map(model => model.qualifiedName),
        ["shared-decision-only:decision-model"]);
    assert.equal(runtime.normalize("decision-model"), undefined);
    assert.equal(runtime.getDecisionDescriptor("decision-only:decision-model"), undefined);
    const resolved = runtime.resolveDecision("shared-decision-only:decision-model");
    assert.equal(resolved.providerId, instance.name);
    assert.equal(resolved.modelName, "decision-model");
});

test("a runtime instance preserves both catalogs without using the type id as its provider name", () => {
    const types = loadProviderTypes({ providers: [mixedProvider()] });
    const runtime = buildRuntimeRegistry(types, [credentialFor("mixed-type")]);
    assert.deepEqual(runtime.allModels.map(model => model.qualifiedName), ["shared-mixed-type:chat-model"]);
    assert.deepEqual(runtime.allDecisionModels.map(model => model.qualifiedName),
        ["shared-mixed-type:decision-model"]);
    assert.equal(runtime.resolve("shared-mixed-type:decision-model"), undefined);
    assert.equal(runtime.resolveDecision("shared-mixed-type:chat-model"), undefined);
    assert.equal(runtime.normalizeDecision("mixed-type:decision-model"), undefined);
});

test("the chat credential resolver refuses a Decision model", () => {
    const types = loadProviderTypes({ providers: [mixedProvider()] });
    const instance = credentialFor("mixed-type");
    assert.equal(resolveProviderCredential(types, instance, "chat-model").sdkProvider.apiKey,
        "instance-test-key");
    assert.equal(resolveProviderCredential(types, instance, "decision-model"), null);
});

test("the separate Decision credential resolver qualifies only Decision models on the instance", () => {
    const types = loadProviderTypes({ providers: [mixedProvider({ apiKey: "type-test-key" })] });
    const instance = credentialFor("mixed-type");
    const resolveDecision = providerCatalog.resolveDecisionProviderCredential;
    assert.equal(typeof resolveDecision, "function");
    const resolved = resolveDecision(types, instance, "decision-model");
    assert.equal(resolved.providerId, instance.name);
    assert.equal(resolved.modelName, "decision-model");
    assert.equal(resolveDecision(types, instance, "chat-model"), null);
    assert.equal(resolveDecision(types, credentialFor("mixed-type", { secretRef: {} }), "decision-model"), null,
        "a runtime instance must not inherit the type's credential");
    const endpointless = loadProviderTypes({ providers: [mixedProvider({ baseUrl: undefined })] });
    assert.equal(resolveDecision(endpointless, credentialFor("mixed-type", { baseUrl: null }), "decision-model"), null);
});

test("live Decision resolution requires the admitted shared row and exact credential version", () => {
    const types = loadProviderTypes({ providers: [mixedProvider()] });
    const expectedId = "00000000-0000-4000-8000-000000000001";
    const expectedVersion = "2026-11-19T00:00:00+00:00";
    const credential = credentialFor("mixed-type", {
        instanceId: expectedId, updatedAt: expectedVersion,
    });
    const qualified = "shared-mixed-type:decision-model";
    assert.equal(resolveRuntimeDecisionProvider(types, credential, qualified, expectedId, expectedVersion).providerId,
        "shared-mixed-type");
    assert.equal(resolveRuntimeDecisionProvider(types, credential, qualified,
        "00000000-0000-4000-8000-000000000002", expectedVersion), null);
    assert.equal(resolveRuntimeDecisionProvider(types, credential, qualified, expectedId,
        "2026-11-19T00:00:01+00:00"), null);
    assert.equal(resolveRuntimeDecisionProvider(types,
        { ...credential, class: "personal", ownerUserId: 42 }, qualified, expectedId, expectedVersion), null);
    assert.equal(resolveRuntimeDecisionProvider(types, credential,
        "another-name:decision-model", expectedId, expectedVersion), null);
});

test("runtime registries keep personal chat but never expose a personal Decision deployment", () => {
    const types = loadProviderTypes({ providers: [mixedProvider()] });
    const personal = credentialFor("mixed-type", {
        name: "personal-mixed-type", class: "personal", ownerUserId: 42,
    });
    const runtime = buildRuntimeRegistry(types, [personal]);
    assert.deepEqual(runtime.allModels.map(model => model.qualifiedName), ["personal-mixed-type:chat-model"]);
    assert.deepEqual(runtime.allDecisionModels, []);
    assert.equal(runtime.resolveDecision("personal-mixed-type:decision-model"), undefined);
});

test("runtime Decision catalogs drop instances whose own credentials do not resolve", () => {
    const types = loadProviderTypes({ providers: [mixedProvider({ apiKey: "type-test-key" })] });
    const runtime = buildRuntimeRegistry(types, [
        credentialFor("mixed-type", { name: "missing-key", secretRef: {} }),
        credentialFor("mixed-type", { name: "qualified" }),
    ]);
    assert.deepEqual(runtime.allDecisionModels.map(model => model.qualifiedName), ["qualified:decision-model"]);
    assert.equal(runtime.resolveDecision("missing-key:decision-model"), undefined);
});

test("runtime Decision admission requires concrete adapter qualification and leaves chat usable", () => {
    for (const [id, type, credential] of [
        ["plain-v1", { type: "openai", baseUrl: "https://plain.example.invalid/v1" }, { baseUrl: null }],
        ["azure-sdk", { type: "azure", baseUrl: "https://azure.example.invalid/openai" }, { baseUrl: null }],
        ["other-wif", { type: "anthropic-wif", baseUrl: "https://plain.example.invalid/openai/v1" },
            { baseUrl: null, secretRef: { kind: "workloadIdentity" } }],
    ]) {
        const types = loadProviderTypes({ providers: [mixedProvider({ id, ...type })] });
        const instance = credentialFor(id, { name: `shared-${id}`, ...credential });
        assert.ok(providerCatalog.resolveDecisionProviderCredential(types, instance, "decision-model"), id);
        assert.equal(resolveQualifiedDecisionProviderCredential(types, instance, "decision-model"), null, id);
        assert.deepEqual(providerCatalog.runtimeDecisionModels(types, [instance]), [], id);

        const runtime = buildRuntimeRegistry(types, [instance]);
        assert.deepEqual(runtime.allModels.map(model => model.qualifiedName), [`shared-${id}:chat-model`], id);
        assert.deepEqual(runtime.allDecisionModels, [], id);
        assert.equal(runtime.resolveDecision(`shared-${id}:decision-model`), undefined, id);
        assert.equal(runtime.resolve(`shared-${id}:chat-model`).providerId, `shared-${id}`, id);
    }
});

test("Foundry API-key and workload-identity instances remain Decision-admissible", () => {
    for (const [id, type, secretRef] of [
        ["foundry-key", { type: "openai", baseUrl: "https://foundry.example.invalid/openai/v1" },
            { kind: "apiKey", value: "instance-test-key" }],
        ["foundry-wif", { type: "foundry-wif", baseUrl: "https://foundry.example.invalid/openai/v1" },
            { kind: "workloadIdentity" }],
    ]) {
        const types = loadProviderTypes({ providers: [mixedProvider({ id, ...type })] });
        const instance = credentialFor(id, { name: `shared-${id}`, baseUrl: null, secretRef });
        assert.ok(resolveQualifiedDecisionProviderCredential(types, instance, "decision-model"), id);
        assert.deepEqual(providerCatalog.runtimeDecisionModels(types, [instance]).map(model => model.qualifiedName),
            [`shared-${id}:decision-model`], id);
        const runtime = buildRuntimeRegistry(types, [instance]);
        assert.deepEqual(runtime.allModels.map(model => model.qualifiedName), [`shared-${id}:chat-model`], id);
        assert.deepEqual(runtime.allDecisionModels.map(model => model.qualifiedName),
            [`shared-${id}:decision-model`], id);
        assert.equal(runtime.resolveDecision(`shared-${id}:decision-model`).providerId, `shared-${id}`, id);
    }
});

test("first-available and implicit chat defaults skip a leading Decision-only provider", () => {
    const types = loadProviderTypes({ providers: [
        mixedProvider({ id: "decision-only", models: [] }),
        mixedProvider({ id: "chat-type", decisionModels: [] }),
    ] });
    const instances = [credentialFor("decision-only"), credentialFor("chat-type")];
    const expected = {
        provider: "shared-chat-type", model: "shared-chat-type:chat-model", reasoning: null, context: null,
    };
    assert.deepEqual(firstRuntimeModel(types, instances, () => true), expected);
    assert.equal(buildRuntimeRegistry(types, instances).defaultModel, expected.model);
    assert.deepEqual(resolveRuntimeModelSelection(types, instances, { eligible: () => true }),
        { ...expected, source: "first_available" });
});

test("a stale chat default on a Decision-only instance keeps healthy chat and Decision catalogs", () => {
    const types = loadProviderTypes({ providers: [
        mixedProvider({ id: "decision-only", models: [] }),
        mixedProvider({ id: "chat-type", decisionModels: [] }),
    ] });
    const instances = [
        credentialFor("decision-only", { instanceId: "00000000-0000-4000-8000-000000000001" }),
        credentialFor("chat-type", { instanceId: "00000000-0000-4000-8000-000000000002" }),
    ];
    const runtime = buildRuntimeRegistry(types, instances, "shared-decision-only:retired-chat");
    assert.equal(runtime.defaultModel, "shared-chat-type:chat-model");
    assert.equal(runtime.resolve("shared-chat-type:chat-model").providerId, "shared-chat-type");
    assert.equal(runtime.resolveDecision("shared-decision-only:decision-model").providerId, "shared-decision-only");
    assert.equal(runtime.resolveDecision("shared-decision-only:decision-model").providerInstanceId,
        "00000000-0000-4000-8000-000000000001");
    assert.equal(runtime.resolve("shared-decision-only:retired-chat"), undefined);
});

test("a stale shared chat default never becomes a personal provider with the replacement name", () => {
    const types = loadProviderTypes({ providers: [
        mixedProvider({ id: "shared-chat", decisionModels: [] }),
        mixedProvider({ id: "personal-chat", decisionModels: [] }),
    ] });
    const personal = credentialFor("personal-chat", {
        name: "former-shared", class: "personal", ownerUserId: 42,
    });
    const shared = credentialFor("shared-chat", { name: "healthy-shared" });
    const runtime = buildRuntimeRegistry(types, [personal, shared], "former-shared:chat-model");
    assert.equal(runtime.defaultModel, "healthy-shared:chat-model");
});

test("a Decision-only catalog cannot supply a first-available chat model", () => {
    const types = loadProviderTypes({ providers: [mixedProvider({ id: "decision-only", models: [] })] });
    const instances = [credentialFor("decision-only")];
    assert.equal(firstRuntimeModel(types, instances, () => true), null);
    assert.equal(buildRuntimeRegistry(types, instances).defaultModel, undefined);
    assert.throws(() => resolveRuntimeModelSelection(types, instances, { eligible: () => true }),
        ModelUnresolvedError);
});

test("explicit and persisted chat selections reject Decision models instead of falling back", () => {
    const types = loadProviderTypes({ providers: [mixedProvider()] });
    const instance = credentialFor("mixed-type");
    for (const input of [
        { requestedModel: "decision-model" },
        { requestedModel: "shared-mixed-type:decision-model" },
        { defaults: [{ source: "cluster_default", tuple: {
            provider: instance.name, model: "shared-mixed-type:decision-model", reasoning: null, context: null,
        } }] },
    ]) {
        assert.throws(() => resolveRuntimeModelSelection(types, [instance], {
            ...input, eligible: () => true,
        }), ModelUnresolvedError);
    }
});

for (const [key, value] of [
    ["auth", { kind: "apiKey" }],
    ["apiKey", "entry-test-key"],
    ["githubToken", "entry-test-token"],
    ["secretRef", { kind: "apiKey", value: "entry-test-key" }],
    ["baseURL", "https://entry.example.invalid"],
    ["baseUrl", "https://entry.example.invalid"],
    ["endpoint", "https://entry.example.invalid"],
    ["protocol", "decision-v1"],
    ["servedModel", "server-model"],
    ["wireApi", "responses"],
    ["cost", "low"],
    ["toolCatalog", { maxDeclarations: 10, overflowStrategy: "typed-dispatch" }],
]) {
    test(`Decision entries reject ${key}; only name and description belong on a model`, () => {
        const config = { providers: [mixedProvider({
            decisionModels: [{ name: "decision-model", description: "For Workflow decisions", [key]: value }],
        })] };
        for (const load of [
            () => new ModelProviderRegistry(config),
            () => loadProviderTypes(config),
        ]) {
            assert.throws(load, error => {
                assert.match(error.message, /decision/i);
                assert.ok(error.message.includes(key), `the diagnostic must identify ${key}`);
                return true;
            });
        }
    });
}
