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
            const savedEligible = Boolean(saved && normalized.models.includes(saved));
            const stale = Boolean(saved && !savedEligible);
            const available = normalized.available;
            const reason = stale && available
                ? `The saved Decision model ${saved} is no longer eligible. Use the current Cluster Decision Default or choose another eligible Decision model.`
                : available ? null : workflowDecisionUnavailableText(normalized);
            return {
                id: state.id,
                kind: "decision",
                model,
                defaultModel: normalized.defaultModel,
                choices: available ? [...normalized.models] : [],
                available,
                stale,
                reason,
                selected: saved,
                text: available
                    ? stale
                        ? `${state.id}: ${saved} · saved Decision model is no longer eligible; use ${normalized.defaultModel}`
                        : `${state.id}: ${model} · ${saved ? "pinned effective Decision model" : "Cluster Decision Default"}`
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

/**
 * Reconcile a mounted Start dialog selection with a new revision or catalog. A revision change starts from its saved bindings;
 * otherwise eligible choices survive, while a removed choice becomes visible stale evidence and uses the blank default selection.
 */
export function reconcileWorkflowDecisionOverrideSelection(models, previous = null, { revision = null } = {}) {
    const entries = (Array.isArray(models) ? models : []).filter(entry => entry?.kind === "decision" && typeof entry.id === "string");
    const priorValues = isRecord(previous?.values) ? previous.values : {};
    const priorStale = isRecord(previous?.stale) ? previous.stale : {};
    const sameRevision = previous !== null && previous?.revision === revision;
    const values = {};
    const stale = {};
    for (const entry of entries) {
        const hasPriorValue = sameRevision && Object.hasOwn(priorValues, entry.id);
        const hasPriorStale = sameRevision && Object.hasOwn(priorStale, entry.id);
        const priorValue = hasPriorValue ? nonBlank(priorValues[entry.id]) : null;
        const priorStaleValue = hasPriorStale ? nonBlank(priorStale[entry.id]) : null;
        const candidate = priorValue ?? priorStaleValue ?? (sameRevision ? null : nonBlank(entry.selected));
        if (candidate && entry.available === true && Array.isArray(entry.choices) && entry.choices.includes(candidate)) {
            values[entry.id] = candidate;
        } else {
            values[entry.id] = "";
            if (candidate) stale[entry.id] = candidate;
        }
    }
    return { revision, values, stale };
}

/** Keep only the semantic provider-independent Decision result, from raw output or a server-side structured summary. */
export function workflowDecisionOutputSummary(raw) {
    let value = raw;
    if (typeof value === "string") {
        try { value = JSON.parse(value); } catch { return null; }
    }
    if (!isRecord(value) || !["choice", "noul", "score"].includes(value.questionType)) return null;
    const model = nonBlank(value.model) ?? nonBlank(value?.model?.qualified);
    const outcome = nonBlank(value.outcome);
    const truncated = value.truncated === true;
    if (!outcome || !model) return null;

    if (value.questionType === "score") {
        if (outcome !== "scored" || typeof value.score !== "number" || !Number.isFinite(value.score) || !Array.isArray(value.levels)
            || value.levels.some(level => !isRecord(level) || !nonBlank(level.label) || !finiteProbability(level.probability))) return null;
        return {
            questionType: "score",
            outcome,
            selection: null,
            confidence: null,
            probabilities: [],
            threshold: null,
            uncertain: null,
            model,
            score: value.score,
            levels: value.levels.map(level => ({ label: level.label.trim(), probability: level.probability })),
            truncated,
        };
    }

    // A read's summary gives `policy`; this function's own result gives `threshold` and `uncertain` instead (a visit's
    // summary is normalized when its row is read, then read again for its Node details), and is taken as it is.
    const policy = isRecord(value.policy) ? value.policy
        : !Object.hasOwn(value, "policy") && Object.hasOwn(value, "threshold")
            ? { minimumProbability: value.threshold, uncertain: value.uncertain } : null;
    const threshold = policy?.minimumProbability === null || finiteProbability(policy?.minimumProbability)
        ? policy.minimumProbability : undefined;
    const uncertain = typeof policy?.uncertain === "boolean" ? policy.uncertain : null;
    if (threshold === undefined || uncertain === null) return null;

    const selection = nonBlank(value.selection);
    const confidence = typeof value.confidence === "number" && finiteProbability(value.confidence) ? value.confidence : null;
    const probabilities = Array.isArray(value.probabilities)
        ? value.probabilities.map(item => isRecord(item) ? { label: item.label, probability: item.probability } : null)
        : isRecord(value.probabilities)
            ? Object.entries(value.probabilities).map(([label, probability]) => ({ label, probability })) : [];
    // A bounded summary that was cut short may keep none of its probabilities; it still says its selection and confidence.
    if (!selection || confidence === null || (probabilities.length === 0 && !truncated)
        || probabilities.some(entry => !entry || !nonBlank(entry.label) || !finiteProbability(entry.probability))) return null;
    return {
        questionType: value.questionType,
        outcome,
        selection,
        confidence,
        probabilities: probabilities.map(entry => ({ label: entry.label.trim(), probability: entry.probability })),
        threshold,
        uncertain,
        model,
        score: null,
        levels: [],
        truncated,
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

const DECISION_USAGE_STATES = new Set(["known", "not_reported", "pending", "settlement_incomplete"]);
const decisionUsagePriority = { known: 0, pending: 1, not_reported: 2, settlement_incomplete: 3 };

/**
 * Safe ledger evidence for UI warnings and the provider call's latency (owner 2026-11-20). Operation, provider, model and
 * token values never survive this boundary. latencyMs is the latest attempt's recorded call time, present only when known.
 */
export function workflowDecisionInferenceEvidence(raw) {
    const rows = Array.isArray(raw) ? raw : isRecord(raw) ? [raw] : [];
    let attempt = null;
    let usageKnown = null;
    let usageState = null;
    let latencyMs = null;
    let latencyAttempt = -Infinity;
    for (const row of rows) {
        if (!isRecord(row)) continue;
        const value = Number.isSafeInteger(row.attempt) ? row.attempt
            : Number.isSafeInteger(row.effectAttempt) ? row.effectAttempt
                : Number.isSafeInteger(row.effectAttempts) ? row.effectAttempts
                    : Number.isSafeInteger(row.attempts) ? row.attempts : null;
        if (value !== null) attempt = attempt === null ? value : Math.max(attempt, value);
        if (Number.isSafeInteger(row.latencyMs) && row.latencyMs >= 0 && (value ?? 0) >= latencyAttempt) {
            latencyMs = row.latencyMs;
            latencyAttempt = value ?? 0;
        }

        let rowUsageKnown = null;
        let rowUsageState = DECISION_USAGE_STATES.has(row.usageState) ? row.usageState : null;
        if (typeof row.usageKnown === "boolean") rowUsageKnown = row.usageKnown;
        else if (row.usageUnknown === true) rowUsageKnown = false;
        else {
            const settled = row.settledAt ?? row.settled_at;
            const hasTotal = Object.hasOwn(row, "tokensTotal") || Object.hasOwn(row, "tokens_total");
            const total = Object.hasOwn(row, "tokensTotal") ? row.tokensTotal
                : Object.hasOwn(row, "tokens_total") ? row.tokens_total : undefined;
            if (settled !== null && settled !== undefined && total === null) rowUsageKnown = false;
            else if (settled !== null && settled !== undefined && typeof total === "number" && Number.isFinite(total)) rowUsageKnown = true;
            else if (hasTotal && settled === null) rowUsageState = row.state === "completed" ? "settlement_incomplete" : "pending";
        }
        if (rowUsageState === "known" || rowUsageKnown === true) rowUsageState = "known";
        else if (rowUsageState === "not_reported" || rowUsageKnown === false) rowUsageState = "not_reported";
        else if (rowUsageState === "settlement_incomplete" || (row.usageKnown === null
            && Object.hasOwn(row, "usageKnown") && row.state === "completed")) rowUsageState = "settlement_incomplete";
        else if (rowUsageState === null && rowUsageKnown === null && row.state === "pending") rowUsageState = "pending";

        if (rowUsageKnown === false) usageKnown = false;
        else if (rowUsageKnown === true && usageKnown === null) usageKnown = true;
        if (rowUsageState && (usageState === null || decisionUsagePriority[rowUsageState] > decisionUsagePriority[usageState])) usageState = rowUsageState;
    }
    return attempt !== null || usageKnown !== null || usageState !== null || latencyMs !== null
        ? { attempt, usageKnown, usageState, ...(latencyMs !== null ? { latencyMs } : {}) } : null;
}

/** A provider call's latency in words: "379 ms" under a second, else seconds with one decimal ("2.4 s"). */
export function workflowDecisionLatencyText(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

export function workflowDecisionInferenceWarning(evidence) {
    const normalized = workflowDecisionInferenceEvidence(evidence);
    if (!normalized) return null;
    const parts = [];
    if (normalized.attempt !== null && normalized.attempt >= 2) parts.push("A second provider call was used.");
    if (normalized.usageState === "settlement_incomplete") {
        parts.push("Usage settlement is incomplete. This call may be missing from usage totals.");
    } else if (normalized.usageKnown === false || normalized.usageState === "not_reported") {
        parts.push("Usage was not reported.");
    }
    return parts.length ? parts.join(" ") : null;
}

function modelOf(node, output) {
    return output?.model ?? nonBlank(node?.decisionModel?.qualified) ?? nonBlank(node?.model?.qualified)
        ?? nonBlank(node?.model?.words) ?? null;
}

/**
 * One presentation model for Portal and TUI. It accepts no provider payload, request id or usage into its output; the only
 * timing is the ledger's recorded provider-call latency (`latency`, words), never a value taken from the node output.
 */
export function workflowDecisionSummary(node, execution = node?.current ?? null) {
    const structured = execution?.decisionSummary === undefined ? null
        : workflowDecisionOutputSummary(execution.decisionSummary);
    const output = structured ?? workflowDecisionOutputSummary(execution?.outputPreview);
    const failure = !output && execution?.resultKind === "runtime_error" ? decisionErrorSummary(execution) : null;
    const completedBusiness = !output && !failure && (execution?.status === "completed" || execution?.state === "completed")
        && execution?.resultKind === "business";
    const needsWholeValue = Boolean(output?.truncated || completedBusiness);
    const questionType = output?.questionType ?? nonBlank(node?.question?.type);
    const threshold = output ? output.threshold : finiteProbability(node?.confidence?.minimumProbability)
        ? node.confidence.minimumProbability : null;
    const outcome = output
        ? output.outcome === "uncertain" ? "Uncertain" : output.outcome
        : failure ? "Failure" : completedBusiness ? "Completed" : "Not run";
    const model = modelOf(node, output);
    const inference = execution?.decisionInference ?? execution?.inference ?? execution ?? null;
    const warning = workflowDecisionInferenceWarning(inference);
    const latency = workflowDecisionLatencyText(workflowDecisionInferenceEvidence(inference)?.latencyMs ?? NaN);
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
    } else if (completedBusiness) {
        text = "Completed · the Decision result needs its whole value to be shown.";
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
        ...(latency ? { latency } : {}),
        truncated: needsWholeValue,
        needsWholeValue,
        text,
    };
}

/** A normalized node binding, pinned for this run and independent from the session's chat model. */
export function workflowDecisionModel(raw) {
    const qualified = nonBlank(raw?.model) ?? nonBlank(raw);
    if (!qualified) return null;
    return {
        source: "start",
        qualified,
        words: qualified,
        value: `${qualified} · pinned effective Decision model`,
        text: `Model: ${qualified} · pinned effective Decision model`,
        now: false,
    };
}

// ── A Decision node's definition as written (owner 2026-11-20: "the node tab should display, like the script node, full
// info (maybe collapsed) on the decision prompts") ─────────────────────────────────────────────────────────────────────

/** The three Decision question types in words, the same in the Portal and the TUI (never the YAML's own type names). */
export const WORKFLOW_DECISION_TYPE_LABELS = Object.freeze({ choice: "Choice", noul: "Yes or no", score: "Score" });

/** A question type in words ("Yes or no"), or null for a type that is not known. */
export function workflowDecisionTypeLabel(type) {
    return typeof type === "string" && Object.hasOwn(WORKFLOW_DECISION_TYPE_LABELS, type) ? WORKFLOW_DECISION_TYPE_LABELS[type] : null;
}

const counted = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const writtenText = value => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Seconds as the Workflow viewer says them (formatSeconds): "30 s", "2 min 5 s", "1 h 3 min". */
function decisionSeconds(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    if (value < 60) return `${value} s`;
    const total = Math.round(value);
    if (total < 3600) return `${Math.floor(total / 60)} min${total % 60 ? ` ${total % 60} s` : ""}`;
    const minutes = Math.floor((total % 3600) / 60);
    return `${Math.floor(total / 3600)} h${minutes ? ` ${minutes} min` : ""}`;
}

/** A question's criteria as rows of two columns, with the words that head them and a note when they need one. */
function decisionCriteria(question) {
    const row = (key, name, text) => ({ key, name, text, line: text ? `${name} — ${text}` : name });
    if (question?.type === "choice") {
        const rows = (isRecord(question.criteria) ? Object.entries(question.criteria) : [])
            .map(([label, description]) => row(label, label, writtenText(description)));
        return { heading: "Options", columns: ["Option", "Description"], rows, note: rows.length ? null : "No options are written." };
    }
    if (question?.type === "noul") {
        const criteria = isRecord(question.criteria) ? question.criteria : null;
        const yes = writtenText(criteria?.true);
        const no = writtenText(criteria?.false);
        if (!yes && !no) {
            return { heading: "Answers", columns: ["Answer", "Description"], rows: [],
                note: "No descriptions of yes and no: the instructions alone decide." };
        }
        return { heading: "Answers", columns: ["Answer", "Description"], rows: [row("yes", "Yes", yes), row("no", "No", no)], note: null };
    }
    if (question?.type === "score") {
        const levels = Array.isArray(question.criteria) ? question.criteria.map(label => (typeof label === "string" ? label : String(label))) : [];
        const rows = levels.map((label, index) => ({ ...row(String(index), String(index), label), index }));
        const last = levels.length - 1;
        return { heading: "Levels", columns: ["Score", "Level"], rows,
            note: levels.length >= 2 ? `The score is a number from 0 (${levels[0]}) to ${last} (${levels[last]}).` : levels.length ? null : "No levels are written." };
    }
    return { heading: "Criteria", columns: ["Criterion", "Description"], rows: [], note: null };
}

/**
 * The model a Decision node uses, with where it comes from: the model `pinned` for the shown run, else the Cluster Decision
 * Default from the Workflow capability (null: not known here).
 */
function decisionDefinitionModel(pinned, capability) {
    const source = "Cluster Decision Default";
    const fromRun = nonBlank(pinned) ?? nonBlank(pinned?.qualified);
    if (fromRun) {
        return { name: fromRun, source: "this run", text: `${fromRun} · this run`, title: "The Decision model this run uses." };
    }
    const title = "Start uses the Cluster Decision Default unless another eligible Decision model is chosen.";
    if (capability === null || capability === undefined) return { name: null, source, text: source, title };
    const normalized = normalizeWorkflowDecisionCapability(capability);
    return normalized.available
        ? { name: normalized.defaultModel, source, text: `${normalized.defaultModel} · ${source}`, title }
        : { name: null, source, text: `No eligible ${source}`, title: workflowDecisionUnavailableText(normalized) };
}

/**
 * What a Decision node asks, as its definition says it, for the Node panel and the TUI (one model; the same words in both):
 * - type ("choice", "noul", "score") and typeLabel ("Choice", "Yes or no", "Score"); summary, the closed line of its
 *   section ("Decision question · Choice · 3 options");
 * - instructions, whole, as written;
 * - criteria: { heading, columns, rows: [{ key, name, text, line }], note }: a choice's options and their descriptions, a
 *   yes-or-no question's Yes and No descriptions (or a note that it has none), a score's levels in order with their
 *   place, 0 first, and a note on what the score means;
 * - confidence: { threshold, text } ("Below 80% confidence → uncertain", "No confidence threshold"), null for a score;
 * - timeout: { seconds, text } ("30 s"), null when the node has none;
 * - model: { name, source, text, title }: `model`, the model pinned for the shown run ("this run"), else the Cluster
 *   Decision Default from `capability` (the Workflow capability; null: not known here, the source alone is said).
 * Pure; reads no output, so a run's provider fields never reach it.
 */
export function workflowDecisionDefinition(node, { model = null, capability = null } = {}) {
    const question = isRecord(node?.question) ? node.question : null;
    const type = ["choice", "noul", "score"].includes(question?.type) ? question.type : null;
    const typeLabel = workflowDecisionTypeLabel(type);
    const criteria = decisionCriteria(question);
    const size = type === "choice" ? counted(criteria.rows.length, "option", "options")
        : type === "score" ? counted(criteria.rows.length, "level", "levels") : null;
    const threshold = finiteProbability(node?.confidence?.minimumProbability) ? node.confidence.minimumProbability : null;
    const seconds = typeof node?.timeoutSeconds === "number" && Number.isFinite(node.timeoutSeconds) ? node.timeoutSeconds : null;
    const instructions = writtenText(question?.instructions);
    return {
        type,
        typeLabel,
        summary: ["Decision question", typeLabel, size].filter(Boolean).join(" · "),
        instructions,
        criteria,
        confidence: type === "score" ? null : threshold === null ? { threshold: null, text: "No confidence threshold" }
            : { threshold, text: `Below ${workflowDecisionPercentage(threshold)} confidence → uncertain` },
        timeout: seconds === null ? null : { seconds, text: decisionSeconds(seconds) },
        model: decisionDefinitionModel(model, capability),
    };
}
