import assert from "node:assert/strict";
import test from "node:test";
import { PilotSwarmClient } from "../../dist/client.js";
import { PgSessionCatalog } from "../../dist/cms.js";

function createCatalogHarness() {
    const queries = [];
    const client = {
        async query(sql, args) {
            queries.push({ sql, args });
            if (sql.includes("RETURNING routing_config")) {
                return { rows: [{ matches: true }] };
            }
            return { rows: [] };
        },
        release() {},
    };
    const catalog = new PgSessionCatalog({
        async connect() {
            return client;
        },
    }, "test");
    catalog.supportsVisibilityCreate = async () => false;
    catalog.supportsCreationConfig = async () => false;
    catalog.supportsRoutingConfig = async () => true;
    catalog.supportsSplashMobileCreate = async () => false;
    catalog.supportsProviderSessionModelValidation = async () => true;
    return { catalog, queries };
}

test("owner-affinitized creation defers exact model credential validation to the worker", async () => {
    const client = Object.create(PilotSwarmClient.prototype);

    const resolved = await client._resolveCreationModel({
        model: "github-copilot:claude-sonnet-5",
        reasoningEffort: "medium",
        requireOwnerAffinity: true,
    }, false);

    assert.deepEqual(resolved, {
        provider: "github-copilot",
        model: "github-copilot:claude-sonnet-5",
        reasoning: "medium",
        context: null,
        source: "explicit",
    });
});

test("owner-affinitized creation still requires an exact provider:model value", async () => {
    const client = Object.create(PilotSwarmClient.prototype);

    await assert.rejects(
        client._resolveCreationModel({
            model: "claude-sonnet-5",
            requireOwnerAffinity: true,
        }, false),
        /exact provider:model/,
    );
});

test("agent-bound creation preserves the resolved owner-affinity contract", async () => {
    const client = Object.create(PilotSwarmClient.prototype);
    client.config = { allowedAgentNames: ["reviewer"] };
    let createConfig;
    client.createSession = async config => {
        createConfig = config;
        return { sessionId: "agent-devbox" };
    };
    client._catalog = {
        async updateSession() {},
    };

    await client.createSessionForAgent("reviewer", {
        model: "github-copilot-ambient:claude-sonnet-5",
        repo: "sqltelemetry",
        requireOwnerAffinity: true,
    });

    assert.equal(createConfig.requireOwnerAffinity, true);
    assert.equal(createConfig.model, "github-copilot-ambient:claude-sonnet-5");
    assert.equal(createConfig.repo, "sqltelemetry");
});

test("owner-affinitized session persistence defers provider validation to the selected worker", async () => {
    const { catalog, queries } = createCatalogHarness();

    await catalog.createSession("ambient-devbox", {
        model: "github-copilot-ambient:claude-sonnet-5",
        modelResolutionSource: "explicit",
        owner: { provider: "entra", subject: "alice" },
        routing: { ownerAffinityRequired: true },
    });

    assert.equal(
        queries.some(({ sql }) => sql.includes("cms_provider_assert_session_model")),
        false,
    );
    assert.equal(
        queries.some(({ sql }) => sql.includes("RETURNING routing_config")),
        true,
    );
});

test("non-owner-affinitized session persistence still requires central provider validation", async () => {
    const { catalog, queries } = createCatalogHarness();

    await catalog.createSession("cluster-session", {
        model: "github-copilot:claude-sonnet-5",
        modelResolutionSource: "explicit",
        owner: { provider: "entra", subject: "alice" },
    });

    assert.equal(
        queries.some(({ sql }) => sql.includes("cms_provider_assert_session_model")),
        true,
    );
});

test("service-owned creation defers exact model credential validation to the shared worker", async () => {
    const client = Object.create(PilotSwarmClient.prototype);

    const resolved = await client._resolveCreationModel({
        model: "azure-foundry:gpt-5.6-sol",
        reasoningEffort: "medium",
        owner: { provider: "system", subject: "system" },
    }, false);

    assert.deepEqual(resolved, {
        provider: "azure-foundry",
        model: "azure-foundry:gpt-5.6-sol",
        reasoning: "medium",
        context: null,
        source: "explicit",
    });
});

test("service-owned creation still requires an exact provider:model value", async () => {
    const client = Object.create(PilotSwarmClient.prototype);

    await assert.rejects(
        client._resolveCreationModel({
            model: "gpt-5.6-sol",
            owner: { provider: "system", subject: "system" },
        }, false),
        /exact provider:model/,
    );
});
