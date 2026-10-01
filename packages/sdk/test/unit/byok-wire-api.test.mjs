/**
 * A BYOK provider's `wireApi` reaches the SDK provider config.
 *
 * WHY THIS EXISTS — gpt-5.6 tools + reasoning bug:
 * The GPT-5.6 model family returns HTTP 400 on the completions wire when a
 * request carries BOTH function tools and a non-`none` `reasoning_effort`:
 *   "Function tools with reasoning_effort are not supported for gpt-5.6-* in
 *    /v1/chat/completions. To use function tools, use /v1/responses or set
 *    reasoning_effort to 'none'."
 * This is an upstream OpenAI constraint (reproduces against raw Azure Foundry
 * AND GitHub Copilot CAPI). The only remedy that keeps reasoning is to route
 * the BYOK provider through `/v1/responses`, which the copilot-sdk selects via
 * ProviderConfig.wireApi = "responses". PilotSwarm never emitted that field, so
 * every BYOK request defaulted to the completions wire and 400'd. These tests
 * pin that the catalog `wireApi` now survives into `sdkProvider`, for both
 * key-mode and workload-identity (foundry-wif) Foundry providers, and that a
 * provider without it is byte-identical to before.
 *
 * Run: node --test test/unit/byok-wire-api.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { needsByokRequestCompatibility } from "../../dist/copilot-client.js";

const BASE = "https://example.invalid/openai/v1";

function resolveWith(provider) {
    return new ModelProviderRegistry({ providers: [provider] }).resolve("p:gpt-5.6-sol");
}

test("wireApi:responses reaches sdkProvider on a key-mode BYOK provider", () => {
    const r = resolveWith({
        id: "p", type: "openai", baseUrl: BASE, apiKey: "k",
        wireApi: "responses", models: [{ name: "gpt-5.6-sol" }],
    });
    assert.equal(r.sdkProvider.type, "openai");
    assert.equal(r.sdkProvider.wireApi, "responses");
    assert.equal(r.sdkProvider.apiKey, "k");
    // The responses wire does not want the completions-only snippy shim.
    assert.equal(needsByokRequestCompatibility(r.sdkProvider), false);
});

test("wireApi survives on a workload-identity (foundry-wif) provider — no apiKey, still routed", () => {
    const r = resolveWith({
        id: "p", type: "foundry-wif", baseUrl: BASE,
        wireApi: "responses", models: [{ name: "gpt-5.6-sol" }],
    });
    assert.equal(r.usesWorkloadIdentity, true);
    assert.equal(r.sdkProvider.type, "openai");   // foundry-wif maps to openai on the wire
    assert.equal(r.sdkProvider.wireApi, "responses");
    assert.equal("apiKey" in r.sdkProvider, false);
});

test("no wireApi — the field is omitted and the provider still takes the completions shim", () => {
    const r = resolveWith({
        id: "p", type: "openai", baseUrl: BASE, apiKey: "k",
        models: [{ name: "gpt-5.6-sol" }],
    });
    assert.equal("wireApi" in r.sdkProvider, false);
    assert.equal(needsByokRequestCompatibility(r.sdkProvider), true);
});

test("wireApi:completions is carried through explicitly and still takes the shim", () => {
    const r = resolveWith({
        id: "p", type: "openai", baseUrl: BASE, apiKey: "k",
        wireApi: "completions", models: [{ name: "gpt-5.6-sol" }],
    });
    assert.equal(r.sdkProvider.wireApi, "completions");
    assert.equal(needsByokRequestCompatibility(r.sdkProvider), true);
});

test("the github/CAPI path is unaffected — no sdkProvider to route", () => {
    const r = new ModelProviderRegistry({
        providers: [{ id: "gh", type: "github", githubToken: "t", models: [{ name: "gpt-5.6-sol" }] }],
    }).resolve("gh:gpt-5.6-sol");
    assert.equal(r.type, "github");
    assert.equal(r.sdkProvider, undefined);
});
