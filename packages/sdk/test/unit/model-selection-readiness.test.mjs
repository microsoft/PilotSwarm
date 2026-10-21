import test from "node:test";
import assert from "node:assert/strict";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { findConfiguredModel, findSameProviderModel, matchesModel, isCompletedTurnOnModelAfter, assertRootTurnModel, selectFixtureModel } from "../helpers/model-selection.mjs";

const registry = new ModelProviderRegistry({
    providers: [
        {
            id: "fixture",
            type: "github",
            models: [
                "medium", "high", "model-b-mini",
                ...["model-a", "model-b"].map((name) => ({
                    name, supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium",
                })),
            ],
        },
        { id: "other", type: "github", models: ["high", "model-b"] },
    ],
});
const medium = registry.getDescriptor("fixture:medium");
const high = registry.getDescriptor("fixture:high");
const target = registry.getDescriptor("fixture:model-b");

test("configured models named medium and high remain distinct identities", () => {
    assert.equal(medium.modelName, "medium");
    assert.equal(high.modelName, "high");
    assert.equal(matchesModel("fixture:medium", high), false);
    assert.equal(matchesModel("fixture:high", medium), false);
    assert.equal(matchesModel("fixture:medium", medium), true);
    assert.equal(matchesModel("medium", medium), true);
    assert.equal(matchesModel("fixture:high", high), true);
    assert.equal(matchesModel("high", high), true);
});

test("configured discovery uses exact qualified or bare model names", () => {
    for (const reference of ["fixture:medium", "medium", "other:high", "high"]) {
        assert.equal(findConfiguredModel(registry.allModels, reference), registry.getDescriptor(reference));
    }
    assert.equal(findConfiguredModel(registry.allModels, "fixture:model-b:medium"), undefined);
    assert.equal(findConfiguredModel(registry.allModels, "missing:high"), undefined);
});

test("same-provider discovery does not skip a valid medium to high switch", () => {
    const models = [registry.getDescriptor("other:high"), medium, high];
    assert.equal(findSameProviderModel(models, medium), high);
    assert.equal(findSameProviderModel(models, high), medium);
    assert.equal(findSameProviderModel([medium, registry.getDescriptor("other:high")], medium), undefined);
});

test("two models sharing medium reasoning effort cannot match the wrong identity", () => {
    assert.equal(registry.getDescriptor("fixture:model-a").defaultReasoningEffort, "medium");
    assert.equal(target.defaultReasoningEffort, "medium");
    assert.equal(matchesModel("fixture:model-a", target), false);
    assert.equal(matchesModel("model-a", target), false);
    assert.equal(matchesModel("fixture:model-b", target), true);
    assert.equal(matchesModel("model-b", target), true);
});

test("model comparison rejects prefixes, wrong providers, display labels and empty identities", () => {
    assert.equal(matchesModel("fixture:model-b-mini", target), false);
    assert.equal(matchesModel("other:model-b", target), false);
    assert.equal(matchesModel("fixture:model-b:medium", target), false);
    assert.equal(matchesModel("model-b:medium", target), false);
    assert.equal(matchesModel("", target), false);
    assert.equal(matchesModel(null, target), false);
    assert.equal(matchesModel("fixture:model-b", undefined), false);
});

test("continuation readiness requires the actual target model, a new turn and completion", () => {
    const completed = { turnIndex: 3, model: "fixture:model-a", reasoningEffort: "medium", resultType: "completed" };
    assert.equal(isCompletedTurnOnModelAfter(completed, target, 2), false);
    assert.equal(isCompletedTurnOnModelAfter({ ...completed, model: target.qualifiedName }, target, 2), true);
    assert.equal(isCompletedTurnOnModelAfter({ ...completed, model: target.modelName }, target, 2), true);
    assert.equal(isCompletedTurnOnModelAfter({ ...completed, model: target.qualifiedName, turnIndex: 2 }, target, 2), false);
    assert.equal(isCompletedTurnOnModelAfter({ ...completed, model: target.qualifiedName, resultType: "error" }, target, 2), false);
    assert.equal(isCompletedTurnOnModelAfter({ ...completed, model: medium.qualifiedName }, high, 2), false);
    assert.equal(isCompletedTurnOnModelAfter({ ...completed, model: high.qualifiedName }, high, 2), true);
});

const rootUsage = (model, data = {}, event = {}) => ({
    eventType: "assistant.usage",
    data: { model, interactionType: "conversation-agent", ...data },
    ...event,
});

test("root API usage must match the requested descriptor, not echoed configuration", () => {
    assert.deepEqual(assertRootTurnModel([rootUsage(target.modelName)], target), [target.modelName]);
    assert.throws(() => assertRootTurnModel([
        { eventType: "assistant.turn_start", data: { model: target.modelName } },
        { eventType: "session.model_changed", data: { toModel: target.qualifiedName } },
        rootUsage("model-a"),
    ], target), /requested fixture:model-b.*observed model-a/);
});

test("configuration, turn-start metadata and model self-description are not served-model evidence", () => {
    assert.throws(() => assertRootTurnModel([
        { eventType: "assistant.turn_start", data: { model: target.modelName } },
        { eventType: "assistant.message", data: { content: target.modelName } },
    ], target), /No attributable root API usage/);
});

test("child and auxiliary API usage cannot satisfy or contaminate the root model assertion", () => {
    const auxiliary = [
        rootUsage("model-a", {}, { agentId: "child" }),
        rootUsage("model-a", { nativeAgentId: "child" }),
        rootUsage("model-a", { parentToolCallId: "task-call" }),
        rootUsage("model-a", { initiator: "mcp-sampling" }),
        rootUsage("model-a", { interactionType: "conversation-compaction" }),
        rootUsage("model-a", { interactionType: "conversation-background" }),
        rootUsage("model-a", { interactionType: "conversation-subagent" }),
    ];
    assert.deepEqual(assertRootTurnModel([...auxiliary, rootUsage(target.qualifiedName)], target), [target.qualifiedName]);
    assert.throws(() => assertRootTurnModel(auxiliary, target), /No attributable root API usage/);
    assert.throws(() => assertRootTurnModel([
        rootUsage("model-a"),
        rootUsage(target.modelName, { nativeAgentId: "child" }),
    ], target), /observed model-a/);
});

test("every attributable root call must report an exact identity", () => {
    assert.throws(() => assertRootTurnModel([rootUsage(target.modelName), rootUsage("model-a")], target), /observed model-a/);
    assert.throws(() => assertRootTurnModel([rootUsage(undefined)], target), /observed/);
    assert.throws(() => assertRootTurnModel([rootUsage("other:model-b")], target), /observed other:model-b/);
    assert.throws(() => assertRootTurnModel([rootUsage(target.modelName, { isByok: true })], target), /observed BYOK usage/);
    assert.deepEqual(assertRootTurnModel([rootUsage(target.modelName, { interactionType: undefined })], target), [target.modelName]);
});

test("fixture selection prefers the approved order and retains configured BYOK identities", () => {
    const models = new ModelProviderRegistry({
        providers: [
            { id: "copilot", type: "github", models: ["gpt-current", "gpt-next", "gpt-5.4"] },
            { id: "byok", type: "openai", apiKey: "unit-test-key", models: ["gpt-5.4", "claude-legacy"] },
        ],
    });
    assert.equal(selectFixtureModel(models, ["gpt-current", "gpt-next"], "gpt-"), "gpt-current");
    assert.equal(selectFixtureModel(models, ["gpt-absent"], "gpt-"), "byok:gpt-5.4");
    assert.equal(selectFixtureModel(models, ["claude-current"], "claude-"), "byok:claude-legacy");
    assert.equal(selectFixtureModel(models, ["gpt-current"], "gpt-", "byok:gpt-5.4"), "byok:gpt-5.4");
    assert.equal(selectFixtureModel(null, ["gpt-current"], "gpt-"), "gpt-current");
    assert.equal(selectFixtureModel(registry, ["gpt-current"], "gpt-"), "gpt-current");
});
