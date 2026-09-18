import test from "node:test";
import assert from "node:assert/strict";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { buildRuntimeRegistry, resolveProviderCredential } from "../../dist/provider-catalog.js";
import { SessionManager } from "../../dist/session-manager.js";

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
