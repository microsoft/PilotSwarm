const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function modelIdentity(reference) {
    const parts = String(reference || "").trim().split(":");
    // Reuse the sequence-label grammar: only a recognized reasoning suffix
    // is a label, not the model. The remaining reference is provider:model.
    if (parts.length > 1 && REASONING_EFFORTS.has(parts.at(-1).toLowerCase())) parts.pop();
    const provider = parts.length > 1 ? parts.shift() : null;
    return { provider, model: parts.join(":") };
}

export function modelShort(reference) {
    return modelIdentity(reference).model;
}

export function matchesModel(actual, expected) {
    const actualIdentity = modelIdentity(actual);
    const expectedIdentity = modelIdentity(expected);
    return expectedIdentity.model.length > 0
        && actualIdentity.model === expectedIdentity.model
        && (!actualIdentity.provider || !expectedIdentity.provider
            || actualIdentity.provider === expectedIdentity.provider);
}

export function isCompletedTurnOnModelAfter(turn, model, turnIndex) {
    return turn.turnIndex > turnIndex
        && matchesModel(turn.model, model)
        && turn.resultType === "completed";
}
