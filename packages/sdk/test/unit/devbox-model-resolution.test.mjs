import assert from "node:assert/strict";
import test from "node:test";
import { PilotSwarmClient } from "../../dist/client.js";

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
