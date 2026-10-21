import test from "node:test";
import assert from "node:assert/strict";
import { modelShort, matchesModel, isCompletedTurnOnModelAfter } from "../helpers/model-selection.mjs";

test("model identity excludes the provider and recognized reasoning label", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
        assert.equal(modelShort(`fixture:model-a:${effort}`), "model-a");
        assert.equal(modelShort(`model-a:${effort}`), "model-a");
    }
    assert.equal(modelShort("fixture:model-a"), "model-a");
    assert.equal(modelShort("model-a"), "model-a");
    assert.equal(modelShort("fixture:model-a:custom"), "model-a:custom");
});

test("two different models sharing medium cannot match the target identity", () => {
    const target = "fixture:model-b:medium";
    assert.equal(matchesModel("fixture:model-a:medium", target), false);
    assert.equal(matchesModel("model-a:medium", target), false);
    assert.equal(matchesModel("fixture:model-b:medium", target), true);
    assert.equal(matchesModel("model-b:medium", target), true);
    assert.equal(matchesModel("model-b", target), true);
});

test("model comparison rejects prefixes, wrong providers and empty identities", () => {
    assert.equal(matchesModel("fixture:model-b-mini:medium", "fixture:model-b:medium"), false);
    assert.equal(matchesModel("other:model-b:medium", "fixture:model-b:medium"), false);
    assert.equal(matchesModel("fixture:model-b", ""), false);
    assert.equal(matchesModel(null, "fixture:model-b"), false);
});

test("continuation readiness requires the actual target model, a new turn and completion", () => {
    const target = "fixture:model-b:medium";
    const completed = { turnIndex: 3, model: "fixture:model-a:medium", resultType: "completed" };
    assert.equal(isCompletedTurnOnModelAfter(completed, target, 2), false);
    assert.equal(isCompletedTurnOnModelAfter({ ...completed, model: target }, target, 2), true);
    assert.equal(isCompletedTurnOnModelAfter({ ...completed, model: target, turnIndex: 2 }, target, 2), false);
    assert.equal(isCompletedTurnOnModelAfter({ ...completed, model: target, resultType: "error" }, target, 2), false);
});
