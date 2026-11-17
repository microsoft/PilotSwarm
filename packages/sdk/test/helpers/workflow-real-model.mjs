/**
 * The workflow real-model test's plan and records (test layer M; design 06 "A separate real-model scenario"), as pure
 * functions, so that what the test reads from its environment and what it records are unit-tested without a model, a
 * credential or a database (test/unit/workflow-real-model.test.mjs). The test itself is
 * test/local/workflow-agent-real-model.test.js.
 *
 * Nothing here reads a secret's value into a message: a missing setting is named by its variable, never echoed, and the
 * target database's connection string is passed through, never copied into a plan's text or a record.
 */

/** The environment variables the test reads. Values are the variables' names. */
export const REAL_MODEL_ENV = Object.freeze({
    model: "PS_WORKFLOW_REAL_MODEL_REF",
    effort: "PS_WORKFLOW_REAL_MODEL_EFFORT",
    samples: "PS_WORKFLOW_REAL_MODEL_SAMPLES",
    receipt: "PS_WORKFLOW_REAL_MODEL_RECEIPT",
    target: "PS_WORKFLOW_REAL_MODEL_TARGET",
    targetStore: "PS_WORKFLOW_TARGET_STORE",
    targetDuroxideSchema: "PS_WORKFLOW_TARGET_DUROXIDE_SCHEMA",
    targetCmsSchema: "PS_WORKFLOW_TARGET_CMS_SCHEMA",
    targetFactsSchema: "PS_WORKFLOW_TARGET_FACTS_SCHEMA",
    targetReviewer: "PS_WORKFLOW_TARGET_PACKAGED_REVIEWER",
    targetOwner: "PS_WORKFLOW_TARGET_OWNER",
});

/** The declared evaluation budget: samples per invocation (each is one run of the workflow: two agent states). */
export const REAL_MODEL_MAX_SAMPLES = 5;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SCHEMA = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

const text = value => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * Every included real-model test runs. Bad or missing settings return `{ state: "blocked", reason }`, which the
 * test reports as a failure, never a skip; a usable model returns `{ state: "run", ... }`.
 *
 * `registry` (local target only): the model catalog the local worker uses (loadModelProviders()), to resolve the model
 * and check that its credential is present. The deployed target's workers use their own catalog, so there the model
 * must be named exactly (provider:model) and nothing about its credential is known here.
 */
export function realModelPlan(env, { registry = null, githubToken = null } = {}) {
    const blocked = reason => ({ state: "blocked", reason: `no usable model: ${reason}` });
    const target = text(env[REAL_MODEL_ENV.target]) ?? "local";
    if (target !== "local" && target !== "deployed") return blocked(`${REAL_MODEL_ENV.target} must be "local" or "deployed".`);

    const samplesText = text(env[REAL_MODEL_ENV.samples]) ?? "1";
    const samples = /^[0-9]+$/.test(samplesText) ? Number(samplesText) : NaN;
    if (!Number.isSafeInteger(samples) || samples < 1 || samples > REAL_MODEL_MAX_SAMPLES) {
        return blocked(`${REAL_MODEL_ENV.samples} must be a whole number from 1 to ${REAL_MODEL_MAX_SAMPLES} (the declared evaluation budget).`);
    }
    const effort = text(env[REAL_MODEL_ENV.effort]);
    if (effort !== null && !EFFORTS.has(effort)) return blocked(`${REAL_MODEL_ENV.effort} must be one of ${[...EFFORTS].join(", ")}.`);
    const receiptPath = text(env[REAL_MODEL_ENV.receipt]);
    const named = text(env[REAL_MODEL_ENV.model]) ?? text(env.PS_TEST_FORCE_MODEL);

    if (target === "deployed") {
        const required = [REAL_MODEL_ENV.targetStore, REAL_MODEL_ENV.targetDuroxideSchema, REAL_MODEL_ENV.targetCmsSchema,
            REAL_MODEL_ENV.targetFactsSchema, REAL_MODEL_ENV.targetReviewer];
        const missing = required.filter(name => text(env[name]) === null);
        if (named === null) missing.unshift(REAL_MODEL_ENV.model);
        if (missing.length) return blocked(`The deployed target needs ${missing.join(", ")}.`);
        if (!/^[^:\s]+:[^:\s]+$/.test(named)) return blocked(`${REAL_MODEL_ENV.model} must name the deployed workers' model as provider:model.`);
        for (const name of [REAL_MODEL_ENV.targetDuroxideSchema, REAL_MODEL_ENV.targetCmsSchema, REAL_MODEL_ENV.targetFactsSchema]) {
            if (!SCHEMA.test(text(env[name]))) return blocked(`${name} must be a schema name.`);
        }
        const reviewer = text(env[REAL_MODEL_ENV.targetReviewer]).split("/");
        if (reviewer.length !== 2 || !reviewer.every(part => NAME.test(part))) {
            return blocked(`${REAL_MODEL_ENV.targetReviewer} must be <package>/<agent>, a package agent already published in the target.`);
        }
        const ownerText = text(env[REAL_MODEL_ENV.targetOwner]);
        let owner = null;
        if (ownerText !== null) {
            const at = ownerText.indexOf("/");
            if (at <= 0 || at === ownerText.length - 1) return blocked(`${REAL_MODEL_ENV.targetOwner} must be <provider>/<subject>.`);
            owner = { provider: ownerText.slice(0, at), subject: ownerText.slice(at + 1) };
        }
        return {
            state: "run", target, samples, effort, receiptPath,
            model: { ref: named, provider: named.slice(0, named.indexOf(":")), name: named.slice(named.indexOf(":") + 1), type: null },
            deployed: {
                store: text(env[REAL_MODEL_ENV.targetStore]),
                duroxideSchema: text(env[REAL_MODEL_ENV.targetDuroxideSchema]),
                cmsSchema: text(env[REAL_MODEL_ENV.targetCmsSchema]),
                factsSchema: text(env[REAL_MODEL_ENV.targetFactsSchema]),
                reviewer: { package: reviewer[0], name: reviewer[1] },
                owner,
            },
        };
    }

    if (!registry) return blocked("No model catalog is configured for the local worker (PS_MODEL_PROVIDERS_PATH).");
    const ref = registry.normalize(named ?? undefined);
    if (!ref) {
        return blocked(named ? `${REAL_MODEL_ENV.model} names a model the local catalog does not have (a provider without its credential is left out of it).`
            : "The local catalog has no default model.");
    }
    const resolved = registry.resolve(ref);
    if (!resolved) return blocked(`The local catalog cannot resolve ${ref} (its provider has no endpoint).`);
    const credential = resolved.type === "github"
        ? Boolean(resolved.githubToken || githubToken)
        : resolved.usesWorkloadIdentity === true || Boolean(resolved.sdkProvider?.apiKey);
    if (!credential) return blocked(`The credential of provider ${resolved.providerId} is not in this environment.`);
    const supported = registry.getDescriptor?.(ref)?.supportedReasoningEfforts;
    if (effort !== null && Array.isArray(supported) && supported.length && !supported.includes(effort)) {
        return blocked(`${ref} does not take reasoning effort ${effort} (it takes ${supported.join(", ")}).`);
    }
    return {
        state: "run", target, samples, effort, receiptPath,
        model: { ref, provider: resolved.providerId, name: resolved.modelName, type: resolved.type },
        deployed: null,
    };
}

/** Whether a model a usage event reports is the model asked for: its name or its qualified name. */
export function servesModel(observed, model) {
    return typeof observed === "string" && (observed === model.name || observed === model.ref);
}

/** A tool result's text: a string, or the content of an object result, or its JSON. */
function resultText(result) {
    if (typeof result === "string") return result;
    if (result && typeof result === "object" && typeof result.content === "string") return result.content;
    try { return JSON.stringify(result ?? null); } catch { return ""; }
}

function parsed(value) {
    try { return JSON.parse(value); } catch { return null; }
}

/**
 * What one agent state's child did, from its session row and its events: the model and effort it was created with,
 * the models its API calls reported (assistant.usage), the number of those calls and their tokens, its turns, every
 * tool it started (by name, counted), each complete_workflow_node call's answer (accepted, or refused with its code),
 * and its session errors (bounded text). Pure.
 */
export function childRecord(row, events) {
    const usage = [];
    const tools = {};
    const completions = [];
    const errors = [];
    let turns = 0;
    for (const event of Array.isArray(events) ? events : []) {
        const data = event?.data ?? {};
        switch (event?.eventType) {
            case "assistant.usage":
                usage.push({ model: typeof data.model === "string" ? data.model : null, inputTokens: Number(data.inputTokens) || 0,
                    outputTokens: Number(data.outputTokens) || 0, isByok: data.isByok === true });
                break;
            case "assistant.turn_start":
                turns += 1;
                break;
            case "tool.execution_start":
                if (typeof data.toolName === "string") tools[data.toolName] = (tools[data.toolName] ?? 0) + 1;
                break;
            case "tool.execution_complete": {
                if (data.toolName !== "complete_workflow_node") break;
                const answer = parsed(resultText(data.result));
                completions.push(answer?.ok === true
                    ? { accepted: true, outcome: answer.outcome ?? null, replayed: answer.replayed === true }
                    : { accepted: false, code: answer?.error?.code ?? (data.success === false ? "TOOL_FAILED" : "UNREADABLE"),
                        attemptsLeft: Number.isSafeInteger(answer?.error?.attemptsLeft) ? answer.error.attemptsLeft : null });
                break;
            }
            case "session.error":
                errors.push(String(data.message ?? data.error ?? "session error").slice(0, 300));
                break;
            default:
                break;
        }
    }
    return {
        sessionId: row?.sessionId ?? null,
        model: row?.model ?? null,
        reasoningEffort: row?.reasoningEffort ?? null,
        observedModels: [...new Set(usage.map(entry => entry.model).filter(Boolean))],
        requests: usage.length,
        inputTokens: usage.reduce((sum, entry) => sum + entry.inputTokens, 0),
        outputTokens: usage.reduce((sum, entry) => sum + entry.outputTokens, 0),
        byok: usage.some(entry => entry.isByok),
        turns,
        tools,
        completions,
        refusedCompletions: completions.filter(entry => !entry.accepted).length,
        errors,
    };
}

/** The review's typed output contract, as the workflow declares it (REVIEW_RESULT). */
export const REVIEW_OUTCOMES = Object.freeze(["approve", "request_changes"]);

/**
 * The problems of a review result against the contract, checked here independently of the runtime's own validation:
 * verdict one of REVIEW_OUTCOMES, summary text of 1 to 600 characters, risks at most five texts of 1 to 200 characters,
 * and nothing else. Empty when it holds. Pure.
 */
export function reviewResultProblems(output) {
    if (!output || typeof output !== "object" || Array.isArray(output)) return ["the output is not an object"];
    const problems = [];
    const extra = Object.keys(output).filter(key => !["verdict", "summary", "risks"].includes(key));
    if (extra.length) problems.push(`unexpected fields: ${extra.join(", ")}`);
    if (!REVIEW_OUTCOMES.includes(output.verdict)) problems.push("verdict is not approve or request_changes");
    if (typeof output.summary !== "string" || output.summary.length < 1 || output.summary.length > 600) problems.push("summary is not text of 1 to 600 characters");
    if (!Array.isArray(output.risks) || output.risks.length > 5
        || output.risks.some(risk => typeof risk !== "string" || risk.length < 1 || risk.length > 200)) {
        problems.push("risks is not a list of at most five texts of 1 to 200 characters");
    }
    return problems;
}

/** The migration versions `expected` names that `applied` lacks, in order: what a client's start would apply to a target. */
export function missingMigrations(expected, applied) {
    const have = new Set(applied);
    return expected.filter(version => !have.has(version));
}
