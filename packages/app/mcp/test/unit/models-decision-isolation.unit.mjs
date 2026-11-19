#!/usr/bin/env node
import test from "node:test";
import assert from "node:assert/strict";
import { registerModelTools } from "../../dist/src/tools/models.js";

function listModelsHandler(mgmt) {
    const tools = new Map();
    registerModelTools({ registerTool(name, _spec, handler) { tools.set(name, handler); } }, { mgmt, admin: false });
    return tools.get("list_models");
}

const CHAT = { qualifiedName: "team:chat", modelName: "chat", providerId: "team", providerType: "openai", description: "chat" };
const DECISION = { qualifiedName: "team-decision:route", modelName: "route", providerId: "team-decision", providerType: "foundry-wif" };

test("optional Decision model and default failures do not hide the chat model list", async () => {
    const handler = listModelsHandler({
        listRuntimeModels: async () => [CHAT],
        listRuntimeDecisionModels: async () => { throw new Error("Decision catalog unavailable"); },
        getModelDefaults: async () => { throw new Error("Decision default unavailable"); },
        getDefaultModel: async () => { throw new Error("legacy default unavailable"); },
    });
    const answer = await handler({ group_by_provider: false });
    assert.notEqual(answer.isError, true);
    const body = JSON.parse(answer.content[0].text);
    assert.deepEqual(body.models.map(model => model.qualified_name), ["team:chat"]);
    assert.equal(body.default_model, null);
    assert.equal(Object.hasOwn(body, "decision_models"), false);
});

test("the Decision catalog remains optional on an older transport", async () => {
    const handler = listModelsHandler({
        listRuntimeModels: async () => [CHAT],
        getModelDefaults: async () => ({
            userSession: { effective: { model: "team:chat" } },
            clusterSession: { effective: null },
        }),
    });
    const answer = await handler({ group_by_provider: true });
    assert.notEqual(answer.isError, true);
    const body = JSON.parse(answer.content[0].text);
    assert.equal(body.providers[0].models[0].qualified_name, "team:chat");
    assert.equal(Object.hasOwn(body, "decision_models"), false);
});

test("a Decision-list failure is isolated from a healthy default and a chat-list failure is not swallowed", async () => {
    const healthy = listModelsHandler({
        listRuntimeModels: async () => [CHAT],
        listRuntimeDecisionModels: async () => [DECISION],
        getModelDefaults: async () => ({
            userSession: { effective: { model: "team:chat" } },
            clusterSession: { effective: null },
            clusterDecision: { configured: { provider: null, model: null }, effective: null },
        }),
    });
    const body = JSON.parse((await healthy({})).content[0].text);
    assert.deepEqual(body.decision_models.map(model => model.qualified_name), [DECISION.qualifiedName]);

    const brokenChat = listModelsHandler({
        listRuntimeModels: async () => { throw new Error("chat catalog failed"); },
        listRuntimeDecisionModels: async () => [DECISION],
        getModelDefaults: async () => null,
    });
    assert.equal((await brokenChat({})).isError, true);
});
