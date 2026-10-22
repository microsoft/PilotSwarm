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
