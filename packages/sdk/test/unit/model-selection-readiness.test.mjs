import test from "node:test";
import assert from "node:assert/strict";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { findConfiguredModel, findSameProviderModel, matchesModel, isCompletedTurnOnModelAfter } from "../helpers/model-selection.mjs";

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
