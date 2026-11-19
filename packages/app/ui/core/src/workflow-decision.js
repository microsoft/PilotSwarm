const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonBlank = value => typeof value === "string" && value.trim() ? value.trim() : null;
const finiteProbability = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const KNOWN_UNAVAILABLE_REASONS = new Set(["no_cluster_decision_default", "cluster_decision_default_ineligible"]);

/** The Decision capability as the mounted UI trusts it. A partial or contradictory answer fails closed. */
export function normalizeWorkflowDecisionCapability(raw) {
    const reason = raw && KNOWN_UNAVAILABLE_REASONS.has(raw.reason) ? raw.reason : null;
    const models = Array.isArray(raw?.models) ? [...new Set(raw.models.map(nonBlank).filter(Boolean))] : [];
    const defaultModel = nonBlank(raw?.defaultModel);
    if (raw?.available === true && raw?.reason === null && defaultModel && models.includes(defaultModel)) {
        return { available: true, defaultModel, models, reason: null };
    }
    return {
        available: false,
        defaultModel: null,
        models: [],
        reason: reason ?? "no_cluster_decision_default",
    };
}

/** A concise action for an unavailable Decision node. The UI never sends a person to a chat-model fallback. */
export function workflowDecisionUnavailableText(capability, { admin = false } = {}) {
    const normalized = normalizeWorkflowDecisionCapability(capability);
    if (normalized.available) return null;
    if (normalized.reason === "no_cluster_decision_default") {
        return admin
            ? "Configure an eligible Cluster Decision Default in Admin Settings or replace or remove the Decision node."
            : "Ask an administrator to configure an eligible Cluster Decision Default in Admin Settings, or replace or remove the Decision node.";
    }
    return admin
        ? "Choose another eligible model in Admin Settings for the Cluster Decision Default, or replace or remove the Decision node."
        : "Ask an administrator to choose another eligible Cluster Decision Default in Admin Settings, or replace or remove the Decision node.";
}

function choiceOf(chosen, stateId) {
    const entry = isRecord(chosen) && isRecord(chosen[stateId]) ? chosen[stateId] : null;
    return nonBlank(entry?.model);
}

/** Decision entries for the Start dialog; agent/session model choices never participate. */
export function workflowDecisionStartModels(states, { capability = null, chosen = null } = {}) {
    const normalized = normalizeWorkflowDecisionCapability(capability);
    return (Array.isArray(states) ? states : [])
        .filter(state => state?.type === "decision" && typeof state?.id === "string")
        .map(state => {
            const saved = choiceOf(chosen, state.id);
            const model = saved ?? normalized.defaultModel;
            const eligible = normalized.available && Boolean(model) && normalized.models.includes(model);
            const reason = eligible ? null : saved && normalized.available
                ? `The saved Decision model ${model} is no longer eligible. Choose another eligible Cluster Decision Default or replace this node.`
                : workflowDecisionUnavailableText(normalized);
            return {
                id: state.id,
                kind: "decision",
                model,
                choices: eligible || normalized.available ? [...normalized.models] : [],
                available: eligible,
                reason,
                selected: saved,
                text: eligible
                    ? `${state.id}: ${model} · ${saved ? "chosen at start" : "Cluster Decision Default"}`
                    : `${state.id}: unavailable · ${reason}`,
            };
        });
}

/** The explicit per-node map sent at Start. Empty or ineligible values mean “use the Cluster Decision Default.” */
export function workflowDecisionOverrideMap(models, selectedByNode = null) {
    const selected = isRecord(selectedByNode) ? selectedByNode : {};
    const out = {};
    for (const entry of Array.isArray(models) ? models : []) {
        if (entry?.kind !== "decision" || entry.available !== true || typeof entry.id !== "string") continue;
        const model = nonBlank(selected[entry.id]);
        if (!model || !entry.choices.includes(model)) continue;
        out[entry.id] = { model };
    }
    return out;
}

/** Keep only the semantic provider-independent Decision result. */
export function workflowDecisionOutputSummary(raw) {
    let value = raw;
    if (typeof value === "string") {
        try { value = JSON.parse(value); } catch { return null; }
    }
    if (!isRecord(value) || !["choice", "noul", "score"].includes(value.questionType)) return null;
    const policy = isRecord(value.policy) ? value.policy : null;
    const threshold = policy?.minimumProbability === null || finiteProbability(policy?.minimumProbability)
        ? policy.minimumProbability : undefined;
    const uncertain = typeof policy?.uncertain === "boolean" ? policy.uncertain : null;
    const model = nonBlank(value?.model?.qualified);
    const outcome = nonBlank(value.outcome);
    if (!outcome || threshold === undefined || uncertain === null || !model) return null;

    if (value.questionType === "score") {
        if (typeof value.score !== "number" || !Number.isFinite(value.score) || !Array.isArray(value.levels)
            || value.levels.some(level => !isRecord(level) || !nonBlank(level.level) || !finiteProbability(level.probability))) return null;
        return {
            questionType: "score",
            outcome,
            selection: null,
            confidence: null,
            probabilities: [],
            threshold,
            uncertain,
            model,
            score: value.score,
            levels: value.levels.map(level => ({ label: level.level.trim(), probability: level.probability })),
        };
    }

    const selection = nonBlank(value.selection);
    const confidence = typeof value.confidence === "number" && finiteProbability(value.confidence) ? value.confidence : null;
    const probabilities = isRecord(value.probabilities)
        ? Object.entries(value.probabilities).map(([label, probability]) => ({ label, probability })) : [];
    if (!selection || confidence === null || probabilities.length === 0
        || probabilities.some(entry => !nonBlank(entry.label) || !finiteProbability(entry.probability))) return null;
    return {
        questionType: value.questionType,
        outcome,
        selection,
        confidence,
        probabilities,
        threshold,
        uncertain,
        model,
        score: null,
        levels: [],
    };
}

/** A settled or provider-returned result exposes only closed, transport-neutral status words. */
function decisionErrorSummary(execution) {
    let raw = execution?.errorPreview;
    if (typeof raw === "string") {
        try { raw = JSON.parse(raw); } catch { raw = null; }
    }
    const code = nonBlank(execution?.outcome) ?? (isRecord(raw) ? nonBlank(raw.code) : null) ?? "execution_failed";
    const message = {
        invalid_input: "The Decision input could not be used.",
        invalid_output: "The Decision provider returned a result the Workflow could not use.",
        forbidden: "The Decision provider refused access.",
        unavailable: "The Decision provider is unavailable. Try again later.",
        timed_out: "The Decision provider did not answer before the limit.",
        budget_exceeded: "The Decision provider call exceeded the configured budget.",
        cancelled: "The Decision call was canceled.",
        execution_failed: "The Decision node failed. See its failure route.",
    }[code] ?? "The Decision node failed. See its failure route.";
    return { code, message };
}

export function workflowDecisionPercentage(value) {
    if (!finiteProbability(value)) return null;
    const percent = value * 100;
    return `${Number.isInteger(percent) ? percent : Number(percent.toFixed(2))}%`;
}

/** Safe ledger evidence for UI warnings. Operation, provider, model and token values never survive this boundary. */
export function workflowDecisionInferenceEvidence(raw) {
    const rows = Array.isArray(raw) ? raw : isRecord(raw) ? [raw] : [];
    let attempt = null;
    let usageKnown = null;
    for (const row of rows) {
        if (!isRecord(row)) continue;
        const value = Number.isSafeInteger(row.attempt) ? row.attempt
            : Number.isSafeInteger(row.effectAttempt) ? row.effectAttempt
                : Number.isSafeInteger(row.effectAttempts) ? row.effectAttempts
                    : Number.isSafeInteger(row.attempts) ? row.attempts : null;
        if (value !== null) attempt = attempt === null ? value : Math.max(attempt, value);
        let rowUsageKnown = null;
        if (typeof row.usageKnown === "boolean") rowUsageKnown = row.usageKnown;
        else if (row.usageUnknown === true) rowUsageKnown = false;
        else {
            const settled = row.settledAt ?? row.settled_at;
            const total = Object.hasOwn(row, "tokensTotal") ? row.tokensTotal
                : Object.hasOwn(row, "tokens_total") ? row.tokens_total : undefined;
            if (settled !== null && settled !== undefined && total === null) rowUsageKnown = false;
            else if (settled !== null && settled !== undefined && typeof total === "number" && Number.isFinite(total)) rowUsageKnown = true;
        }
        if (rowUsageKnown === false) usageKnown = false;
        else if (rowUsageKnown === true && usageKnown === null) usageKnown = true;
    }
    return attempt !== null || usageKnown !== null ? { attempt, usageKnown } : null;
}

export function workflowDecisionInferenceWarning(evidence) {
    const normalized = workflowDecisionInferenceEvidence(evidence);
    if (!normalized) return null;
    const parts = [];
    if (normalized.attempt !== null && normalized.attempt >= 2) parts.push("A second provider call was used.");
    if (normalized.usageKnown === false) parts.push("Usage was not reported.");
    return parts.length ? parts.join(" ") : null;
}

function modelOf(node, output) {
    return output?.model ?? nonBlank(node?.decisionModel?.qualified) ?? nonBlank(node?.model?.qualified)
        ?? nonBlank(node?.model?.words) ?? null;
}

/** One presentation model for Portal and TUI. It accepts no provider payload, request id, timing or usage into its output. */
export function workflowDecisionSummary(node, execution = node?.current ?? null) {
    const output = workflowDecisionOutputSummary(execution?.outputPreview);
    const failure = !output && execution?.resultKind === "runtime_error" ? decisionErrorSummary(execution) : null;
    const questionType = output?.questionType ?? nonBlank(node?.question?.type);
    const threshold = output ? output.threshold : finiteProbability(node?.confidence?.minimumProbability)
        ? node.confidence.minimumProbability : null;
    const outcome = output
        ? output.outcome === "uncertain" ? "Uncertain" : output.outcome
        : failure ? "Failure" : "Not run";
    const model = modelOf(node, output);
    const warning = workflowDecisionInferenceWarning(execution?.decisionInference ?? execution?.inference ?? execution ?? null);
    const confidence = output?.confidence === null || output?.confidence === undefined ? null
        : workflowDecisionPercentage(output.confidence);
    const probabilityText = output?.probabilities?.length
        ? output.probabilities.map(item => `${item.label} ${workflowDecisionPercentage(item.probability)}`).join(" · ") : null;
    const levelText = output?.levels?.length
        ? output.levels.map(item => `${item.label} ${workflowDecisionPercentage(item.probability)}`).join(" · ") : null;
    let text;
    if (output?.questionType === "choice") {
        text = `${outcome} · selected ${output.selection} · ${confidence} confidence`
            + `${threshold === null ? "" : ` · threshold ${workflowDecisionPercentage(threshold)}`}`
            + (probabilityText ? ` · ${probabilityText}` : "");
    } else if (output?.questionType === "noul") {
        text = `${outcome} · selected ${output.selection} · ${confidence} confidence`
            + `${threshold === null ? "" : ` · threshold ${workflowDecisionPercentage(threshold)}`}`
            + (probabilityText ? ` · ${probabilityText}` : "");
    } else if (output?.questionType === "score") {
        text = `Scored · score ${output.score}${levelText ? ` · ${levelText}` : ""}`;
    } else if (failure) {
        text = `Failure · ${failure.code} — ${failure.message}`;
    } else {
        text = "No Decision result yet.";
    }
    return {
        type: "Decision",
        questionType,
        model,
        threshold,
        uncertain: output ? output.uncertain : null,
        outcome,
        failure: failure?.code ?? null,
        confidence,
        probabilities: output?.probabilities ?? [],
        score: output?.score ?? null,
        levels: output?.levels ?? [],
        warning,
        text,
    };
}

/** A normalized node binding, used for the effective model fact before a result arrives. */
export function workflowDecisionModel(raw) {
    const qualified = nonBlank(raw?.model) ?? nonBlank(raw);
    if (!qualified) return null;
    return {
        source: "start",
        qualified,
        words: qualified,
        value: `${qualified} · chosen at start`,
        text: `Model: ${qualified} · chosen at start`,
        now: false,
    };
}
