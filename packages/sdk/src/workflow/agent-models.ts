/**
 * OF-S2-7 (owner, 2026-11-07T21:32Z): per-node models. "We don't hard code models to preserve portability between
 * deployments. But when instantiating a workflow, the spawn workflow call should take an optional parameter which maps each
 * agent node to a concrete provider / model / reasoning / context length. If not supplied it should inherit from the parent."
 *
 * A Workflow Definition never names a model. A start may give `agentModels`: a map keyed by an agent node's state id (its
 * key under `states:`, unique across the Workflow, bodies included; an agent node in a For each body is one key for all
 * its items) to { model: "provider:model", reasoningEffort?, contextTier? }. It is checked at start against exactly the
 * revision being started (an unknown id or a node that is not an agent is refused in words, never ignored) and against the
 * owning session's model catalog (review OF7-R1: the catalog of the identity that spends, the owner of the session that owns the
 * Workflow, never the caller's); an explicit effort or tier must be one the chosen model lists (OF7-R6). A host that cannot
 * check a model refuses a map (fail closed). The map is stored with the run (migration 0088) and read at each spawn; a
 * stored map that cannot be read fails the node in words, it never inherits silently. A node the map leaves out inherits
 * model, reasoning effort and context tier from the session that owns the Workflow.
 */
import type { SessionOwnerInfo } from "../types.js";
import type { ClusterDecisionCapability, RuntimeDecisionProviderBinding } from "../provider-catalog.js";
import { WORKFLOW_MAX_NODES, type WorkflowCompileResult, type WorkflowDiagnostic, type WorkflowIR } from "./compiler.js";
import { canonicalJson, isJsonObject, jsonSha256, type JsonValue } from "./json.js";
import { WorkflowStoreError } from "./store.js";

export const WORKFLOW_AGENT_MODEL_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
export const WORKFLOW_AGENT_MODEL_CONTEXT_TIERS = Object.freeze(["default", "long_context"] as const);
export type WorkflowAgentModelEffort = typeof WORKFLOW_AGENT_MODEL_EFFORTS[number];
export type WorkflowAgentModelContextTier = typeof WORKFLOW_AGENT_MODEL_CONTEXT_TIERS[number];

/** One agent node's model, as a start chose it. */
export interface WorkflowAgentModelChoice {
    /** An exact provider:model from the owning session's catalog (list_available_models). */
    model: string;
    reasoningEffort?: WorkflowAgentModelEffort;
    contextTier?: WorkflowAgentModelContextTier;
}

/** The choices of a start, by agent node state id. */
export type WorkflowAgentModels = { [stateId: string]: WorkflowAgentModelChoice };
/** Private run-bound provider incarnations for Decision states. */
export type WorkflowDecisionProviderBindings = { [stateId: string]: RuntimeDecisionProviderBinding };

/**
 * Whether `owner` (the owner of the session that owns the Workflow: its agent nodes spend as them) may use `choice` (their
 * catalog: an eligible provider serves the model, and an explicit effort or tier is one that model lists): null when they
 * may, else the reason in words. A host without one refuses every map (requireUsableAgentModels).
 */
export type WorkflowAgentModelCheck = (choice: WorkflowAgentModelChoice, owner: SessionOwnerInfo | null) => Promise<string | null>;

/** At most this many entries: a Workflow has far fewer agent nodes. */
export const WORKFLOW_AGENT_MODELS_MAX = 64;
export const WORKFLOW_DECISION_MODEL_UNAVAILABLE = "WORKFLOW_DECISION_MODEL_UNAVAILABLE";
export const WORKFLOW_DECISION_CAPABILITY_UNREADABLE = "WORKFLOW_DECISION_CAPABILITY_UNREADABLE";
const MODEL_MAX = 200;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const invalid = (message: string) => new WorkflowStoreError("AGENT_MODELS_INVALID", message);

const capabilityReadFailure = () => new WorkflowStoreError(WORKFLOW_DECISION_CAPABILITY_UNREADABLE,
    "The current shared Decision capability could not be read. Nothing was changed; try again.", { retryable: true });

function validDecisionCapability(value: unknown): value is ClusterDecisionCapability {
    if (!isJsonObject(value) || typeof value.available !== "boolean"
        || !(value.defaultModel === null || typeof value.defaultModel === "string")
        || !Array.isArray(value.models) || !value.models.every(model => typeof model === "string")
        || !(value.reason === null || value.reason === "no_cluster_decision_default"
            || value.reason === "cluster_decision_default_ineligible")) return false;
    return true;
}

/** A missing host reader means no configured default; a reader that fails is an unreadable state, never an ineligible one. */
export async function readWorkflowDecisionCapability(
    getCapability: (() => Promise<ClusterDecisionCapability>) | undefined,
): Promise<ClusterDecisionCapability> {
    if (!getCapability) {
        return { available: false, defaultModel: null, models: [], reason: "no_cluster_decision_default" };
    }
    try {
        const capability = await getCapability();
        if (!validDecisionCapability(capability)) throw new Error("invalid Decision capability");
        return { ...capability, models: [...capability.models] };
    } catch {
        throw capabilityReadFailure();
    }
}

export function usableWorkflowDecisionCapability(capability: ClusterDecisionCapability): boolean {
    return capability.available === true && typeof capability.defaultModel === "string" && capability.defaultModel.length > 0
        && capability.models.includes(capability.defaultModel);
}

export function workflowDecisionNodes(ir: WorkflowIR | null | undefined): string[] {
    return Object.values(ir?.nodes ?? {}).filter(node => node.type === "decision").map(node => node.id);
}

/** The caller's model intent for a Decision revision, independent of the capability's materialized default. */
export function workflowDecisionModelRequestDigest(ir: WorkflowIR | null | undefined, intent: {
    explicit: boolean;
    models?: unknown;
    runAgainOf?: string | null;
}): string | undefined {
    if (!workflowDecisionNodes(ir).length) return undefined;
    if (intent.explicit) {
        // Session Starts pass null for no source. Direct operations cannot Run again and retain their existing envelope.
        const models = canonicalAgentModels(parseWorkflowAgentModels(intent.models)) ?? {};
        return jsonSha256({ explicit: true, models: models as unknown as JsonValue,
            ...(intent.runAgainOf !== undefined ? { runAgainOf: intent.runAgainOf } : {}) });
    }
    return intent.runAgainOf
        ? jsonSha256({ runAgainOf: intent.runAgainOf })
        : jsonSha256({ default: true });
}

/** The Decision entries of a compatibility model map, identified from the exact revision rather than by model naming. */
export function workflowDecisionModelsForRevision(models: WorkflowAgentModels | null | undefined,
    ir: WorkflowIR | null | undefined): WorkflowAgentModels | null {
    if (!models || !ir) return null;
    const decisions = new Set(workflowDecisionNodes(ir));
    const selected = Object.fromEntries(Object.entries(models).filter(([id]) => decisions.has(id)));
    return Object.keys(selected).length ? selected : null;
}

export async function workflowDecisionSaveDiagnostics(ir: WorkflowIR | null, getCapability: (() => Promise<ClusterDecisionCapability>) | undefined)
    : Promise<WorkflowDiagnostic[]> {
    const nodes = workflowDecisionNodes(ir);
    if (!nodes.length) return [];
    const capability = await readWorkflowDecisionCapability(getCapability);
    if (usableWorkflowDecisionCapability(capability)) return [];
    const stale = capability.reason === "cluster_decision_default_ineligible";
    // A revision saved now stays invalid after the default is fixed: say so, so the author saves it again.
    const again = " Then save this definition again: this revision stays invalid.";
    const message = stale
        ? `Decision nodes are unavailable because the configured Cluster Decision Default is no longer eligible. Replace it in Admin Settings, or replace this node.${again}`
        : `Decision nodes are unavailable because no eligible Cluster Decision Default is configured. Configure one in Admin Settings, or replace this node.${again}`;
    return nodes.map(node => ({ severity: "error" as const, code: WORKFLOW_DECISION_MODEL_UNAVAILABLE, path: `states.${node}.type`, message }));
}

/** Apply save-time host diagnostics without mutating structural compilation, and never retain IR for an invalid save. */
export async function workflowSaveCompilation(compiled: WorkflowCompileResult,
    getCapability: (() => Promise<ClusterDecisionCapability>) | undefined, diagnostics: WorkflowDiagnostic[] = []): Promise<WorkflowCompileResult> {
    const saveDiagnostics = [...diagnostics, ...await workflowDecisionSaveDiagnostics(compiled.ir, getCapability)];
    const allDiagnostics = [...compiled.diagnostics, ...saveDiagnostics];
    const decisionInvalid = allDiagnostics.some(item => item.code === WORKFLOW_DECISION_MODEL_UNAVAILABLE && item.severity === "error");
    const valid = compiled.valid && !decisionInvalid;
    return { ...compiled, valid, ir: valid ? compiled.ir : null, irSha256: valid ? compiled.irSha256 : null, diagnostics: allDiagnostics };
}


const MODEL_PROVENANCE_FIELD = "$workflowModelProvenance";

function readDecisionAliasProvenance(raw: object, allowProvenance: boolean): boolean {
    if (!Object.hasOwn(raw, MODEL_PROVENANCE_FIELD)) return false;
    const provenance = (raw as { [key: string]: unknown })[MODEL_PROVENANCE_FIELD];
    if (!allowProvenance || !isJsonObject(provenance) || Object.keys(provenance).length !== 1
        || provenance.decisionAlias !== true) {
        throw invalid("agentModels contains an invalid model field provenance marker.");
    }
    return true;
}

function markDecisionAlias(choice: WorkflowAgentModelChoice): void {
    (choice as unknown as { [key: string]: unknown })[MODEL_PROVENANCE_FIELD] = { decisionAlias: true };
}

function canonicalAgentModelChoice(choice: WorkflowAgentModelChoice): WorkflowAgentModelChoice {
    return { model: choice.model,
        ...(typeof choice.reasoningEffort === "string" ? { reasoningEffort: choice.reasoningEffort } : {}),
        ...(typeof choice.contextTier === "string" ? { contextTier: choice.contextTier } : {}) };
}

function canonicalAgentModels(models: WorkflowAgentModels | null): WorkflowAgentModels | null {
    if (!models) return null;
    return Object.fromEntries(Object.entries(models).map(([id, choice]) => [id, canonicalAgentModelChoice(choice)]));
}

function parseWorkflowModels(value: unknown, decisionAlias: boolean, max = WORKFLOW_AGENT_MODELS_MAX,
    allowProvenance = true, stored = false): WorkflowAgentModels | null {
    if (value === undefined || value === null) return null;
    if (!isJsonObject(value)) {
        throw invalid("agentModels must be an object of agent node ids to { model, reasoningEffort?, contextTier? }.");
    }
    const limit = stored ? WORKFLOW_MAX_NODES : max;
    const entries = Object.entries(value);
    if (entries.length === 0) return null;
    if (entries.length > limit) throw invalid(`agentModels names ${entries.length} nodes; at most ${limit}.`);
    const out: WorkflowAgentModels = {};
    for (const [key, raw] of entries) {
        if (!KEY_PATTERN.test(key)) throw invalid(`agentModels key "${key.slice(0, 80)}" is not a node id.`);
        if (!isJsonObject(raw)) throw invalid(`agentModels.${key} must be { model, reasoningEffort?, contextTier? }.`);
        const allowed = new Set(decisionAlias
            ? ["model", MODEL_PROVENANCE_FIELD]
            : ["model", "reasoningEffort", "reasoning_effort", "contextTier", "context_tier", MODEL_PROVENANCE_FIELD]);
        if (!allowProvenance) allowed.delete(MODEL_PROVENANCE_FIELD);
        const extra = Object.keys(raw).find(field => !allowed.has(field));
        if (extra) {
            const takes = decisionAlias ? "it takes model only" : "it takes model, reasoningEffort and contextTier";
            throw invalid(`${decisionAlias ? "decisionModels" : "agentModels"}.${key} has an unknown field "${extra.slice(0, 40)}"; ${takes}.`);
        }
        const carriedAlias = readDecisionAliasProvenance(raw, allowProvenance);
        const model = typeof raw.model === "string" ? raw.model.trim() : "";
        if (!model || model.length > MODEL_MAX || !/^[^:\s]+:\S+$/.test(model)) {
            throw invalid(`${decisionAlias ? "decisionModels" : "agentModels"}.${key}.model must be an exact provider:model from list_available_models.`);
        }
        // OF7-R7: each non-null setting is one text value (either spelling). Null remains an own field until revision
        // validation, so a JSON clone cannot erase evidence that it was explicitly supplied for a Decision node.
        const setting = (camel: string, snake: string, accepted: readonly string[])
            : { present: boolean; value: string | null } => {
            const given = raw[camel] !== undefined ? raw[camel] : raw[snake];
            if (given === undefined) return { present: false, value: null };
            if (given === null) return { present: true, value: null };
            if (typeof given !== "string" || !accepted.includes(given)) {
                throw invalid(`agentModels.${key}.${camel} must be one of ${accepted.join(", ")}, as text.`);
            }
            return { present: true, value: given };
        };
        if (raw.reasoningEffort !== undefined && raw.reasoning_effort !== undefined) throw invalid(`agentModels.${key} gives reasoningEffort twice.`);
        if (raw.contextTier !== undefined && raw.context_tier !== undefined) throw invalid(`agentModels.${key} gives contextTier twice.`);
        const effort = setting("reasoningEffort", "reasoning_effort", WORKFLOW_AGENT_MODEL_EFFORTS);
        const tier = setting("contextTier", "context_tier", WORKFLOW_AGENT_MODEL_CONTEXT_TIERS);
        const choice = { model,
            ...(effort.present ? { reasoningEffort: effort.value } : {}),
            ...(tier.present ? { contextTier: tier.value } : {}) } as unknown as WorkflowAgentModelChoice;
        if (decisionAlias || carriedAlias) markDecisionAlias(choice);
        out[key] = choice;
    }
    return out;
}

/** Parse the canonical start map, which stores Agent and Decision choices in the same run column. */
export function parseWorkflowAgentModels(value: unknown, options: { stored?: boolean } = {}): WorkflowAgentModels | null {
    return parseWorkflowModels(value, false, WORKFLOW_AGENT_MODELS_MAX, true, options.stored === true);
}

/** Parse the additive tool alias. Decision choices take only model, even when an Agent setting is explicitly null. */
export function parseWorkflowDecisionModels(value: unknown): WorkflowAgentModels | null {
    return parseWorkflowModels(value, true);
}

/** Merge the two tool maps without changing the canonical Agent-map wire shape. */
export function mergeWorkflowAgentModels(agentModels: WorkflowAgentModels | null, decisionModels: WorkflowAgentModels | null)
    : WorkflowAgentModels | null {
    if (!agentModels) return decisionModels;
    if (!decisionModels) return agentModels;
    const overlap = Object.keys(decisionModels).find(key => Object.hasOwn(agentModels, key));
    if (overlap) throw invalid(`agent_models and decision_models both name ${overlap}; give that node in only one map.`);
    const entries = { ...agentModels, ...decisionModels };
    if (Object.keys(entries).length > WORKFLOW_AGENT_MODELS_MAX) {
        throw invalid(`agentModels names ${Object.keys(entries).length} nodes; at most ${WORKFLOW_AGENT_MODELS_MAX}.`);
    }
    return entries;
}

/**
 * Every key of `models` names an Agent or Decision node of exactly the revision being started (`ir`; `what` names it in
 * words, "revision 3 of hn-top-watch"): an unknown id or a node of another type is refused in words, never ignored
 * (AGENT_MODELS_INVALID). Alias origin and explicitly present settings are JSON data carried with the parsed choice, not
 * process-local WeakMap state, so revision validation still refuses them after clone/reparse.
 */
export function requireAgentModelsForRevision(models: WorkflowAgentModels | null, ir: WorkflowIR, what: string): void {
    if (!models) return;
    const hasDecision = Object.values(ir.nodes).some(node => node.type === "decision");
    for (const [key, choice] of Object.entries(models)) {
        const node = ir.nodes[key];
        if (!node) {
            const nodes = hasDecision ? "model-bearing nodes" : "agent nodes";
            throw invalid(`agentModels names ${key}, which is not a node of ${what}. Use the ${nodes}' ids (their keys under states:).`);
        }
        if (readDecisionAliasProvenance(choice, true) && node.type !== "decision") {
            throw invalid(`decision_models names ${key}, a ${node.type} node of ${what}; decision_models takes only Decision nodes.`);
        }
        if (node.type !== "agent" && node.type !== "decision") {
            const only = hasDecision ? "only Agent and Decision nodes take a model." : "only agent nodes take a model.";
            throw invalid(`agentModels names ${key}, a ${node.type} node of ${what}; ${only}`);
        }
        const hasSetting = ["reasoningEffort", "reasoning_effort", "contextTier", "context_tier"]
            .some(field => Object.hasOwn(choice, field));
        if (node.type === "decision" && hasSetting) {
            throw invalid(`agentModels names ${key}, a Decision node of ${what}; Decision models take only model, not reasoningEffort or contextTier.`);
        }
    }
}

/**
 * Every choice is usable by `owner`, the owner of the session that owns the Workflow (`check`, the host's catalog), else the
 * start is refused in words (AGENT_MODEL_UNAVAILABLE), naming the node and the model. A host without a checker refuses a
 * map at all (fail closed: a choice is never left to the spawn to find out).
 */
export async function requireUsableAgentModels(models: WorkflowAgentModels | null, check: WorkflowAgentModelCheck | undefined,
    owner: SessionOwnerInfo | null): Promise<void> {
    if (!models) return;
    if (!check) {
        throw new WorkflowStoreError("AGENT_MODEL_UNAVAILABLE", "This host cannot check models against the owning session's catalog, so it takes "
            + "no agentModels. Leave them out so every agent node uses the session's model.");
    }
    for (const [key, choice] of Object.entries(models)) {
        const canonicalChoice = canonicalAgentModelChoice(choice);
        const reason = await check(canonicalChoice, owner);
        if (reason) {
            throw new WorkflowStoreError("AGENT_MODEL_UNAVAILABLE", `The model chosen for ${key}, ${workflowAgentModelWords(choice)}, cannot be used `
                + `with the owning session's catalog: ${reason} Choose one from list_available_models, or leave the node out so it uses the session's model.`);
        }
    }
}

/** The stored form of a start's choices (canonical JSON), or null without any. */
export function workflowAgentModelsText(models: WorkflowAgentModels | null): string | null {
    const canonical = canonicalAgentModels(models);
    return canonical && Object.keys(canonical).length ? canonicalJson(canonical as unknown as JsonValue) : null;
}

const PROVIDER_INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function workflowDecisionProviderBindingsText(bindings: WorkflowDecisionProviderBindings | null): string | null {
    return bindings && Object.keys(bindings).length ? canonicalJson(bindings as unknown as JsonValue) : null;
}

export function readStoredDecisionProviderBindings(value: unknown): { bindings: WorkflowDecisionProviderBindings | null } | { error: string } {
    if (value === undefined || value === null || value === "") return { bindings: null };
    try {
        const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
        if (!isJsonObject(parsed)) throw new Error("the value must be an object");
        const bindings: WorkflowDecisionProviderBindings = {};
        for (const [stateId, raw] of Object.entries(parsed)) {
            if (!KEY_PATTERN.test(stateId) || !isJsonObject(raw)
                || Object.keys(raw).sort().join(",") !== "modelQualified,providerInstanceId,providerName,providerTypeId"
                || typeof raw.providerInstanceId !== "string" || !PROVIDER_INSTANCE_ID.test(raw.providerInstanceId)
                || typeof raw.providerName !== "string" || raw.providerName.length === 0
                || typeof raw.providerTypeId !== "string" || raw.providerTypeId.length === 0
                || typeof raw.modelQualified !== "string" || raw.modelQualified.length === 0) {
                throw new Error(`the binding for ${stateId} is invalid`);
            }
            bindings[stateId] = raw as unknown as RuntimeDecisionProviderBinding;
        }
        return { bindings };
    } catch (error) {
        return { error: `The Decision provider bindings stored with this run cannot be read: ${error instanceof Error ? error.message : String(error)}` };
    }
}

/** The stored choices read back, from their JSON (a run row's `agentModels`), for display; never throws: anything else reads as none. */
export function readWorkflowAgentModels(value: unknown): WorkflowAgentModels | null {
    const read = readStoredAgentModels(value);
    return "models" in read ? read.models : null;
}

/**
 * The stored choices as a spawn reads them: { models } (null: none stored), or { error } in words when a stored value cannot
 * be read (review ruling: the node fails, it never inherits silently).
 */
export function readStoredAgentModels(value: unknown): { models: WorkflowAgentModels | null } | { error: string } {
    if (value === undefined || value === null) return { models: null };
    try {
        return { models: parseWorkflowModels(typeof value === "string" ? JSON.parse(value) : value, false,
            WORKFLOW_MAX_NODES, false, true) };
    } catch (error) {
        return { error: `The agent models stored with this run cannot be read (AGENT_MODELS_INVALID): ${error instanceof Error ? error.message : String(error)}` };
    }
}

/** A request digest's part for the choices: absent without any, so an earlier request keeps the digest it had. */
export function agentModelsDigestPart(models: WorkflowAgentModels | null | undefined): { agentModels?: string } {
    const text = workflowAgentModelsText(models ?? null);
    return text ? { agentModels: text } : {};
}

/** A context tier in words. */
const CONTEXT_TIER_WORDS: { [tier: string]: string } = { default: "default context", long_context: "long context" };

/**
 * A choice in words, as the start receipt and every refusal say it: "azure:gpt-5 · low · long context" (the model exact, its
 * reasoning effort and its context tier when chosen).
 */
export function workflowAgentModelWords(choice: WorkflowAgentModelChoice): string {
    const tier = choice.contextTier ? CONTEXT_TIER_WORDS[choice.contextTier] ?? choice.contextTier : null;
    return [choice.model, choice.reasoningEffort, tier].filter(Boolean).join(" · ");
}

/**
 * A start's compatibility model map in words. `decisionModels` is the additive Decision-only subset; removing its ids from
 * `models` keeps the Agent wording and fallback scoped to Agent nodes. Older callers that do not have the subset retain the
 * previous Agent-map interpretation, while new receipts never describe Decision models as chat inheritance.
 */
export function workflowChosenModelsWords(models: WorkflowAgentModels | null | undefined,
    decisionModels: WorkflowAgentModels | null | undefined = null): string {
    const decisionIds = new Set(Object.keys(decisionModels ?? {}));
    const agents = models ? Object.entries(models).filter(([id]) => !decisionIds.has(id))
        .map(([id, choice]) => `${id}: ${workflowAgentModelWords(choice)}`) : [];
    const decisions = decisionModels ? Object.entries(decisionModels)
        .map(([id, choice]) => `${id}: ${choice.model}`) : [];
    const parts: string[] = [];
    if (agents.length) {
        parts.push(`Agent nodes with a model chosen at start: ${agents.join("; ")}; the others use this session's model.`);
    }
    if (decisions.length) {
        parts.push(`Decision nodes use their pinned effective Decision models (the Cluster Decision Default when no override was chosen): `
            + `${decisions.join("; ")}; no Decision node inherits the session's chat model.`);
    }
    return parts.length ? `${parts.join(" ")} ` : "";
}
