/**
 * Decision availability is a required cluster default, not a chat fallback or a provider-type switch.
 * Run after the SDK build: node --test test/unit/workflow-decision-availability.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as catalog from "../../dist/provider-catalog.js";
import { workflowCapabilities, WORKFLOW_CAPABILITIES_SCHEMA } from "../../dist/workflow/human-commands.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { ProviderStore } from "../../dist/provider-store.js";

const NONE = { provider: null, model: null, reasoning: null, context: null };
const DEFAULT = { provider: "team", model: "team:decision-model", reasoning: null, context: null };
const UNSET = { available: false, defaultModel: null, models: [], reason: "no_cluster_decision_default" };
const STALE = { available: false, defaultModel: null, models: [], reason: "cluster_decision_default_ineligible" };
const AVAILABLE = { available: true, defaultModel: DEFAULT.model,
    models: ["team:decision-model", "spare:decision-model"], reason: null };

const types = catalog.loadProviderTypes({ providers: [
    { id: "mixed-type", type: "openai", baseUrl: "https://type.example.invalid/openai/v1", apiKey: "type-test-key",
        models: ["chat-model"], decisionModels: [{ name: "decision-model" }] },
    { id: "chat-only-type", type: "openai", baseUrl: "https://chat.example.invalid/v1", models: ["chat-model"] },
    { id: "endpointless-type", type: "openai", models: [], decisionModels: [{ name: "decision-model" }] },
], defaultModel: "mixed-type:chat-model" });

const credential = (name, over = {}) => ({ name, typeId: "mixed-type", class: "shared", ownerUserId: null,
    baseUrl: null, secretRef: { kind: "apiKey", value: "instance-test-key" }, ...over });
const instances = [
    credential("team"), credential("spare"),
    credential("personal", { class: "personal", ownerUserId: 7, systemUseEnabled: true }),
    credential("chat-only", { typeId: "chat-only-type" }),
    credential("uncredentialed", { secretRef: {} }),
    credential("unqualified", { secretRef: { kind: "workloadIdentity" } }),
    credential("no-endpoint", { typeId: "endpointless-type" }),
    credential("removed-type", { typeId: "removed-type" }),
];

function capability(tuple = NONE, providers = instances, registry = types) {
    assert.equal(typeof catalog.resolveClusterDecisionCapability, "function",
        "the provider catalog must resolve the Cluster Decision Default separately from chat");
    return catalog.resolveClusterDecisionCapability(registry, providers, tuple);
}

function select(input, providers = instances) {
    assert.equal(typeof catalog.resolveRuntimeDecisionModelSelection, "function",
        "Decision selection needs its own default-gated catalog resolver");
    return catalog.resolveRuntimeDecisionModelSelection(types, providers, input);
}

test("an unset Cluster Decision Default is unavailable even with eligible Decision models and a chat default", () => {
    assert.deepEqual(capability(), UNSET);
    assert.deepEqual(capability(null), UNSET);
    assert.equal(types.defaultModel, "mixed-type:chat-model");
    assert.ok(types.allDecisionModels.length > 0, "the default, not catalog presence, is the gate");
});

test("a configured default advertises only qualified, credentialed shared Decision instances without requiring foundry-wif", () => {
    assert.deepEqual(capability(DEFAULT), AVAILABLE);
    assert.deepEqual(capability(DEFAULT, [...instances].reverse(), types).models,
        [DEFAULT.model, "spare:decision-model"], "the configured default is first for a stable picker order");
    assert.equal(instances[0].typeId, "mixed-type");
    assert.equal(types.allProviders.find(provider => provider.id === "mixed-type").type, "openai");
    assert.equal(types.allProviders.some(provider => provider.type === "foundry-wif"), false);
});

test("default eligibility rejects adapter-incompatible endpoints and authentication", () => {
    const registry = catalog.loadProviderTypes({ providers: [
        { id: "plain-v1", type: "openai", baseUrl: "https://plain.example.invalid/v1", models: ["chat-model"],
            decisionModels: [{ name: "decision-model" }] },
        { id: "azure-sdk", type: "azure", baseUrl: "https://azure.example.invalid/openai", models: ["chat-model"],
            decisionModels: [{ name: "decision-model" }] },
        { id: "other-wif", type: "anthropic-wif", baseUrl: "https://plain.example.invalid/openai/v1",
            models: ["chat-model"], decisionModels: [{ name: "decision-model" }] },
    ] });
    const providers = [
        credential("plain", { typeId: "plain-v1" }),
        credential("azure", { typeId: "azure-sdk" }),
        credential("wif", { typeId: "other-wif", secretRef: { kind: "workloadIdentity" } }),
    ];
    assert.deepEqual(catalog.runtimeDecisionModels(registry, providers), []);
    for (const [provider, model] of providers.map(item => [item.name, `${item.name}:decision-model`])) {
        assert.deepEqual(capability({ provider, model, reasoning: null, context: null }, providers, registry), STALE);
    }
});

test("Foundry API-key and workload-identity providers qualify for default admission", () => {
    const registry = catalog.loadProviderTypes({ providers: [
        { id: "foundry-key", type: "openai", baseUrl: "https://foundry.example.invalid/openai/v1",
            models: [], decisionModels: [{ name: "decision-model" }] },
        { id: "foundry-wif", type: "foundry-wif", baseUrl: "https://foundry.example.invalid/openai/v1",
            models: [], decisionModels: [{ name: "decision-model" }] },
    ] });
    for (const provider of [
        credential("key", { typeId: "foundry-key" }),
        credential("wif", { typeId: "foundry-wif", secretRef: { kind: "workloadIdentity" } }),
    ]) {
        const model = `${provider.name}:decision-model`;
        assert.deepEqual(capability({ provider: provider.name, model, reasoning: null, context: null },
            [provider], registry), { available: true, defaultModel: model, models: [model], reason: null });
    }
});

for (const [name, tuple] of [
    ["personal even when system-enabled", { ...DEFAULT, provider: "personal", model: "personal:decision-model" }],
    ["chat-only model", { ...DEFAULT, model: "team:chat-model" }],
    ["missing provider", { ...DEFAULT, provider: "missing", model: "missing:decision-model" }],
    ["provider type instead of an instance", { ...DEFAULT, provider: "mixed-type", model: "mixed-type:decision-model" }],
    ["missing model", { ...DEFAULT, model: "team:missing" }],
    ["bare model", { ...DEFAULT, model: "decision-model" }],
    ["mismatched provider prefix", { ...DEFAULT, model: "spare:decision-model" }],
    ["missing credential", { ...DEFAULT, provider: "uncredentialed", model: "uncredentialed:decision-model" }],
    ["unqualified credential", { ...DEFAULT, provider: "unqualified", model: "unqualified:decision-model" }],
    ["missing endpoint", { ...DEFAULT, provider: "no-endpoint", model: "no-endpoint:decision-model" }],
    ["removed provider type", { ...DEFAULT, provider: "removed-type", model: "removed-type:decision-model" }],
    ["partial tuple", { ...NONE, provider: "team" }],
]) {
    test(`an ineligible default (${name}) fails closed instead of using another eligible Decision model`, () => {
        assert.deepEqual(capability(tuple), STALE);
    });
}

test("removing the default's model from the catalog or its provider from the instance list revokes availability", () => {
    const withoutModel = catalog.loadProviderTypes({ providers: [{ id: "mixed-type", type: "openai",
        baseUrl: "https://type.example.invalid/openai/v1", models: ["chat-model"], decisionModels: [] }] });
    assert.deepEqual(capability(DEFAULT, instances, withoutModel), STALE);
    assert.deepEqual(capability(DEFAULT, instances.filter(instance => instance.name !== "team")), STALE);
});

test("an explicit Decision model cannot bypass an unset or stale Cluster Decision Default", () => {
    for (const clusterDecisionDefault of [NONE, null, { ...DEFAULT, model: "team:removed" }]) {
        assert.throws(() => select({ clusterDecisionDefault, requestedModel: "spare:decision-model" }), error => {
            assert.ok(error instanceof catalog.ModelUnresolvedError);
            assert.match(error.message, /cluster decision default/i);
            return true;
        });
    }
});

test("Decision selection uses the Decision default or an eligible qualified override, never chat settings", () => {
    const inheritedChatSettings = { requestedReasoning: "high", requestedContext: "long_context" };
    assert.deepEqual(select({ clusterDecisionDefault: DEFAULT, ...inheritedChatSettings }), {
        ...DEFAULT, source: "cluster_decision_default",
    });
    assert.deepEqual(select({ clusterDecisionDefault: DEFAULT, requestedModel: "spare:decision-model", ...inheritedChatSettings }), {
        provider: "spare", model: "spare:decision-model", reasoning: null, context: null, source: "explicit",
    });
    assert.throws(() => select({ defaults: [{ source: "cluster_default", tuple: {
        provider: "team", model: "team:chat-model", reasoning: "high", context: "long_context",
    } }] }), catalog.ModelUnresolvedError);
});

for (const model of ["decision-model", "team:chat-model", "personal:decision-model", "unqualified:decision-model", "mixed-type:decision-model", "team:missing"]) {
    test(`Decision override ${model} is refused without substituting the configured default`, () => {
        assert.throws(() => select({ clusterDecisionDefault: DEFAULT, requestedModel: model }), catalog.ModelUnresolvedError);
    });
}

test("workflowCapabilities advertises an explicit unavailable Decision object by default, without disabling Workflows", () => {
    for (const commands of [null, undefined, {}, { testMode: false }, { testMode: true }]) {
        const result = workflowCapabilities({ read: true, commands });
        assert.deepEqual(result.decision, UNSET);
        assert.equal(result.enabled, true);
        assert.equal(result.read, true);
    }
});

test("a failed optional Decision default read leaves chat defaults intact", async () => {
    const chat = { cluster_provider: "chat", cluster_model: "chat:gpt", my_provider: "chat", my_model: "chat:gpt" };
    const store = new ProviderStore({
        query: async sql => {
            if (sql.includes("cms_provider_get_defaults")) return { rows: [chat] };
            if (sql.includes("provider_cluster_settings")) throw new Error("Decision columns unavailable");
            throw new Error(`unexpected query: ${sql}`);
        },
    }, "decision_default_failure");
    const defaults = await store.getDefaults(7);
    assert.equal(defaults.cluster.model, "chat:gpt");
    assert.equal(defaults.mine.model, "chat:gpt");
    assert.deepEqual(defaults.clusterDecision, NONE);
});

test("workflow capability publication survives an optional Decision catalog read failure", async () => {
    const fake = {
        _catalog: {
            workflowStore() { return {}; },
            providers: {
                allCredentials: async () => { throw new Error("Decision provider list failed"); },
                getClusterDecisionDefault: async () => DEFAULT,
            },
        },
        _modelProviders: types,
        config: { workflowCommands: {} },
    };
    const result = await PilotSwarmManagementClient.prototype.getWorkflowCapabilities.call(fake);
    assert.equal(result.enabled, true);
    assert.equal(result.read, true);
    assert.deepEqual(result.decision, STALE);
});

test("workflowCapabilities carries configured and stale Decision support independently of commands and test mode", () => {
    for (const decision of [AVAILABLE, STALE, UNSET]) {
        for (const commands of [null, {}, { testMode: true }]) {
            const result = workflowCapabilities({ read: true, commands, decision });
            assert.deepEqual(result.decision, decision);
            assert.equal(result.commands.available, commands !== null);
        }
    }
    const answer = workflowCapabilities({ read: true, commands: {}, decision: AVAILABLE });
    answer.decision.models.push("forged:model");
    assert.deepEqual(workflowCapabilities({ read: true, commands: {}, decision: AVAILABLE }).decision, AVAILABLE,
        "a caller cannot mutate the next advertisement");
});

test("the additive Decision advertisement keeps the current capability schema and chat/controller versions", () => {
    assert.equal(WORKFLOW_CAPABILITIES_SCHEMA, 1, "this optional advertisement does not redefine existing capability fields");
    const absent = workflowCapabilities({ read: true, commands: {} });
    const configured = workflowCapabilities({ read: true, commands: {}, decision: AVAILABLE });
    const { decision: ignoredAbsent, ...oldAbsent } = absent;
    const { decision: ignoredConfigured, ...oldConfigured } = configured;
    assert.deepEqual(oldConfigured, oldAbsent);
    assert.equal(configured.apiVersion, "pilotswarm.dev/v1");
});
