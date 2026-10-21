import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as summary from "../../../../scripts/test-model-summary.mjs";

const credential = "unit-test-credential-not-real";
const catalog = {
    providers: [{
        id: "copilot",
        type: "github",
        githubToken: "env:TEST_COPILOT_TOKEN",
        models: ["gpt-5.6-sol", { name: "gpt-6-sol" }, "claude-sonnet-5"],
    }],
    defaultModel: "copilot:gpt-5.6-sol",
};
const advertised = catalog.providers[0].models.map(model => ({
    id: typeof model === "string" ? model : model.name,
    policy: { state: "enabled" },
}));

function clientFixture(models = advertised, { authenticated = true, discoveryError } = {}) {
    const calls = { created: 0, stopped: 0, listed: 0 };
    return {
        calls,
        createClient: async options => {
            calls.created++;
            assert.equal(options.gitHubToken, credential);
            assert.equal(options.useLoggedInUser, false);
            return {
                start: async () => {},
                getAuthStatus: async () => ({ isAuthenticated: authenticated }),
                listModels: async () => {
                    calls.listed++;
                    if (discoveryError) throw discoveryError;
                    return models;
                },
                stop: async () => { calls.stopped++; },
            };
        },
    };
}

function check(fixture, overrides = {}) {
    return summary.validateTestModels({
        catalog,
        env: { TEST_COPILOT_TOKEN: credential },
        createClient: fixture.createClient,
        ...overrides,
    });
}

test("live fixture contains only the approved default, distinct target and Claude model", () => {
    const actual = JSON.parse(readFileSync(new URL("../fixtures/model-providers.test.json", import.meta.url)));
    assert.equal(actual.defaultModel, "github-copilot:gpt-5.6-sol");
    assert.deepEqual(actual.providers[0].models.map(model => model.name), advertised.map(model => model.id));
    for (const model of actual.providers[0].models) {
        assert.equal(model.defaultReasoningEffort, "medium");
        assert.ok(model.supportedReasoningEfforts.includes("medium"));
    }
});

test("catalog selection matches SDK Vitest, including workspace-relative PS overrides", () => {
    const cwd = resolve("fixture-root");
    assert.equal(summary.testModelCatalogPath({ PS_MODEL_PROVIDERS_PATH: "primary.json", MODEL_PROVIDERS_PATH: "legacy.json" }, cwd), resolve(cwd, "packages/sdk/primary.json"));
    assert.equal(summary.testModelCatalogPath({ PS_MODEL_PROVIDERS_PATH: resolve(cwd, "explicit.json") }, cwd), resolve(cwd, "explicit.json"));
    assert.equal(summary.testModelCatalogPath({ MODEL_PROVIDERS_PATH: "legacy.json" }, cwd), resolve(cwd, "packages/sdk/test/fixtures/model-providers.test.json"));
    assert.equal(summary.testModelCatalogPath({}, cwd), resolve(cwd, "packages/sdk/test/fixtures/model-providers.test.json"));
});

test("available configured Copilot models are checked once and the client is stopped", async () => {
    const fixture = clientFixture();
    const result = await check(fixture);
    assert.equal(result.status, "passed");
    assert.deepEqual(result.checkedModels, advertised.map(model => `copilot:${model.id}`));
    assert.deepEqual(fixture.calls, { created: 1, stopped: 1, listed: 1 });
});

test("a configured retired model fails as not advertised, not as authentication denial", async () => {
    const fixture = clientFixture();
    const retired = { providers: [{ ...catalog.providers[0], models: ["gpt-5.4"] }], defaultModel: "copilot:gpt-5.4" };
    await assert.rejects(check(fixture, { catalog: retired }), error => {
        assert.equal(error.code, "COPILOT_MODEL_UNAVAILABLE");
        assert.match(error.message, /copilot:gpt-5\.4.*not advertised/);
        assert.doesNotMatch(error.message, /authentication failed/i);
        return true;
    });
    assert.equal(fixture.calls.stopped, 1);
});

test("every configured model is checked, not just the default", async () => {
    const fixture = clientFixture(advertised.filter(model => model.id !== "gpt-6-sol"));
    await assert.rejects(check(fixture), /copilot:gpt-6-sol.*not advertised/);
});

for (const state of ["disabled", "unconfigured"]) {
    test(`explicit ${state} policy fails even when the model is advertised`, async () => {
        const fixture = clientFixture(advertised.map(model => model.id === "gpt-6-sol" ? { ...model, policy: { state } } : model));
        await assert.rejects(check(fixture), new RegExp(`copilot:gpt-6-sol.*${state}`));
    });
}

test("absent optional policy metadata is not invented as a disabled policy", async () => {
    const fixture = clientFixture(advertised.map(({ id }) => ({ id })));
    assert.equal((await check(fixture)).status, "passed");
});

test("credential-free unit-only checks explicitly skip without starting a native client", async () => {
    const fixture = clientFixture();
    const result = await check(fixture, { env: {}, unitOnly: true });
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "credential-free-unit-only");
    assert.equal(fixture.calls.created, 0);
});

test("live checks without credentials fail rather than silently skipping", async () => {
    const fixture = clientFixture();
    await assert.rejects(check(fixture, { env: {} }), { code: "COPILOT_CREDENTIAL_MISSING" });
    assert.equal(fixture.calls.created, 0);
});

test("native authentication failure is distinct from unavailable models", async () => {
    const fixture = clientFixture([], { authenticated: false });
    await assert.rejects(check(fixture), { code: "COPILOT_AUTHENTICATION" });
    assert.deepEqual(fixture.calls, { created: 1, stopped: 1, listed: 0 });
});

test("discovery errors do not leak raw native errors or claim model absence", async () => {
    const fixture = clientFixture([], { discoveryError: new Error(`native response containing ${credential}`) });
    await assert.rejects(check(fixture), error => {
        assert.equal(error.code, "COPILOT_DISCOVERY");
        assert.doesNotMatch(error.message, /unit-test-credential|not advertised/);
        return true;
    });
    assert.equal(fixture.calls.stopped, 1);
});

test("non-Copilot catalogs are not sent to Copilot or renamed", async () => {
    const fixture = clientFixture();
    const byok = { providers: [{ id: "byok", type: "openai", models: ["gpt-5.4"] }], defaultModel: "byok:gpt-5.4" };
    const before = JSON.stringify(byok);
    const result = await check(fixture, { catalog: byok, env: {} });
    assert.equal(result.status, "not-applicable");
    assert.equal(fixture.calls.created, 0);
    assert.equal(JSON.stringify(byok), before);
});

test("supported forced and interrupt-model overrides must resolve in the effective catalog", async () => {
    for (const key of ["PS_TEST_FORCE_MODEL", "TEST_FORCE_MODEL", "PS_INTERRUPT_TEST_MODEL"]) {
        const fixture = clientFixture();
        assert.equal((await check(fixture, { env: { TEST_COPILOT_TOKEN: credential, [key]: "copilot:gpt-6-sol" } })).status, "passed");
        await assert.rejects(check(clientFixture(), { env: { TEST_COPILOT_TOKEN: credential, [key]: "gpt-5.4" } }), /gpt-5\.4.*not configured/);
    }
    assert.equal((await check(clientFixture(), { env: {
        TEST_COPILOT_TOKEN: credential, PS_TEST_FORCE_MODEL: "gpt-6-sol", TEST_FORCE_MODEL: "shadowed-invalid-model",
    } })).status, "passed");
});

test("unit-only cannot bypass a credentialed live preflight", async () => {
    const fixture = clientFixture();
    await assert.rejects(check(fixture, { unitOnly: true }), { code: "TEST_MODEL_UNIT_CREDENTIAL" });
    assert.equal(fixture.calls.created, 0);
});

test("mixed catalogs keep BYOK model names out of Copilot discovery checks", async () => {
    const fixture = clientFixture();
    const mixed = {
        ...catalog,
        providers: [...catalog.providers, { id: "byok", type: "openai", models: ["gpt-5.4"] }],
    };
    assert.deepEqual((await check(fixture, { catalog: mixed })).checkedModels, advertised.map(model => `copilot:${model.id}`));
});
