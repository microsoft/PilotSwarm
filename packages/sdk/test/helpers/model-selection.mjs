export function findConfiguredModel(models, reference) {
    return models.find((model) => model.qualifiedName === reference)
        ?? models.find((model) => model.modelName === reference);
}

export function findSameProviderModel(models, fromModel) {
    return models.find((model) =>
        model.providerId === fromModel.providerId
        && model.modelName !== fromModel.modelName);
}

export function matchesModel(actual, expected) {
    // CMS, turn metrics and model_changed keep reasoning effort separate
    // from identity, unlike token-bucket labels and runtime notice text.
    return Boolean(expected?.modelName && expected?.qualifiedName)
        && (actual === expected.modelName || actual === expected.qualifiedName);
}

export function isCompletedTurnOnModelAfter(turn, model, turnIndex) {
    return turn.turnIndex > turnIndex
        && matchesModel(turn.model, model)
        && turn.resultType === "completed";
}

export function assertRootTurnModel(events, expected) {
    // assistant.usage describes an API call. Turn-start/configuration echoes do
    // not prove serving, and shared subscriptions also carry child/auxiliary usage.
    const rootUsage = events.filter(event => {
        const data = event.data ?? {};
        return event.eventType === "assistant.usage"
            && !event.agentId && !data.nativeAgentId && !data.parentToolCallId
            && !data.initiator
            && (data.interactionType == null
                || data.interactionType === "conversation-agent"
                || data.interactionType === "conversation-user");
    });
    assert.ok(rootUsage.length > 0, "No attributable root API usage; configured/selected model is not serving evidence");
    for (const { data } of rootUsage) {
        assert.ok(expected?.providerType !== "github" || data?.isByok !== true,
            `Root API provider mismatch: requested ${expected?.qualifiedName}; observed BYOK usage`);
        assert.ok(matchesModel(data?.model, expected),
            `Root API model mismatch: requested ${expected?.qualifiedName}; observed ${data?.model ?? "(missing)"}`);
    }
    return rootUsage.map(event => event.data.model);
}
import assert from "node:assert/strict";

export function selectFixtureModel(registry, candidates, family, forcedModel) {
    if (forcedModel) return forcedModel;
    if (!registry) return candidates[0];
    const preferred = candidates.find(model => registry.normalize(model));
    if (preferred) return preferred;
    // Copilot retirement does not retire a separately configured BYOK deployment.
    return registry.allModels.find(model =>
        model.providerType !== "github" && model.modelName.startsWith(family))?.qualifiedName
        ?? candidates[0];
}
