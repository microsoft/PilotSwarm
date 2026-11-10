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
import type { WorkflowIR } from "./compiler.js";
import { canonicalJson, isJsonObject, type JsonValue } from "./json.js";
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

/**
 * Whether `owner` (the owner of the session that owns the Workflow: its agent nodes spend as them) may use `choice` (their
 * catalog: an eligible provider serves the model, and an explicit effort or tier is one that model lists): null when they
 * may, else the reason in words. A host without one refuses every map (requireUsableAgentModels).
 */
export type WorkflowAgentModelCheck = (choice: WorkflowAgentModelChoice, owner: SessionOwnerInfo | null) => Promise<string | null>;

/** At most this many entries: a Workflow has far fewer agent nodes. */
export const WORKFLOW_AGENT_MODELS_MAX = 64;
const MODEL_MAX = 200;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const invalid = (message: string) => new WorkflowStoreError("AGENT_MODELS_INVALID", message);

/**
 * A start's `agentModels` as given (the tool's snake_case `reasoning_effort` and `context_tier` too), checked for its shape:
 * null when absent or empty. Refused in words (AGENT_MODELS_INVALID) when it is not an object of agent node ids to
 * { model: "provider:model", reasoningEffort?, contextTier? }. Pure.
 */
export function parseWorkflowAgentModels(value: unknown): WorkflowAgentModels | null {
    if (value === undefined || value === null) return null;
    if (!isJsonObject(value)) {
        throw invalid("agentModels must be an object of agent node ids to { model, reasoningEffort?, contextTier? }.");
    }
    const entries = Object.entries(value);
    if (entries.length === 0) return null;
    if (entries.length > WORKFLOW_AGENT_MODELS_MAX) throw invalid(`agentModels names ${entries.length} nodes; at most ${WORKFLOW_AGENT_MODELS_MAX}.`);
    const out: WorkflowAgentModels = {};
    for (const [key, raw] of entries) {
        if (!KEY_PATTERN.test(key)) throw invalid(`agentModels key "${key.slice(0, 80)}" is not a node id.`);
        if (!isJsonObject(raw)) throw invalid(`agentModels.${key} must be { model, reasoningEffort?, contextTier? }.`);
        const allowed = new Set(["model", "reasoningEffort", "reasoning_effort", "contextTier", "context_tier"]);
        const extra = Object.keys(raw).find(field => !allowed.has(field));
        if (extra) throw invalid(`agentModels.${key} has an unknown field "${extra.slice(0, 40)}"; it takes model, reasoningEffort and contextTier.`);
        const model = typeof raw.model === "string" ? raw.model.trim() : "";
        if (!model || model.length > MODEL_MAX || !/^[^:\s]+:\S+$/.test(model)) {
            throw invalid(`agentModels.${key}.model must be an exact provider:model from list_available_models.`);
        }
        // OF7-R7: each setting is one text value (either spelling), never an array, object, number or boolean.
        const setting = (camel: string, snake: string, allowed: readonly string[]): string | null => {
            const given = raw[camel] !== undefined ? raw[camel] : raw[snake];
            if (given === undefined || given === null) return null;
            if (typeof given !== "string" || !allowed.includes(given)) {
                throw invalid(`agentModels.${key}.${camel} must be one of ${allowed.join(", ")}, as text.`);
            }
            return given;
        };
        if (raw.reasoningEffort !== undefined && raw.reasoning_effort !== undefined) throw invalid(`agentModels.${key} gives reasoningEffort twice.`);
        if (raw.contextTier !== undefined && raw.context_tier !== undefined) throw invalid(`agentModels.${key} gives contextTier twice.`);
        const effort = setting("reasoningEffort", "reasoning_effort", WORKFLOW_AGENT_MODEL_EFFORTS);
        const tier = setting("contextTier", "context_tier", WORKFLOW_AGENT_MODEL_CONTEXT_TIERS);
        out[key] = { model, ...(effort ? { reasoningEffort: effort as WorkflowAgentModelEffort } : {}),
            ...(tier ? { contextTier: tier as WorkflowAgentModelContextTier } : {}) };
    }
    return out;
}

/**
 * Every key of `models` names an agent node of exactly the revision being started (`ir`; `what` names it in words,
 * "revision 3 of hn-top-watch"): an unknown id or a node of another type is refused in words, never ignored
 * (AGENT_MODELS_INVALID). Pure.
 */
export function requireAgentModelsForRevision(models: WorkflowAgentModels | null, ir: WorkflowIR, what: string): void {
    if (!models) return;
    for (const key of Object.keys(models)) {
        const node = ir.nodes[key];
        if (!node) {
            throw invalid(`agentModels names ${key}, which is not a node of ${what}. Use the agent nodes' ids (their keys under states:).`);
        }
        if (node.type !== "agent") throw invalid(`agentModels names ${key}, a ${node.type} node of ${what}; only agent nodes take a model.`);
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
        const reason = await check(choice, owner);
        if (reason) {
            throw new WorkflowStoreError("AGENT_MODEL_UNAVAILABLE", `The model chosen for ${key}, ${workflowAgentModelWords(choice)}, cannot be used `
                + `with the owning session's catalog: ${reason} Choose one from list_available_models, or leave the node out so it uses the session's model.`);
        }
    }
}

/** The stored form of a start's choices (canonical JSON), or null without any. */
export function workflowAgentModelsText(models: WorkflowAgentModels | null): string | null {
    return models && Object.keys(models).length ? canonicalJson(models as unknown as JsonValue) : null;
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
        return { models: parseWorkflowAgentModels(typeof value === "string" ? JSON.parse(value) : value) };
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
 * A start's chosen agent node models in words, for the start receipt: "Agent nodes with a model chosen at start: classify:
 * azure:gpt-5 · low · long context; the others use this session's model. " (empty without any).
 */
export function workflowChosenModelsWords(models: WorkflowAgentModels | null | undefined): string {
    const chosen = models ? Object.entries(models).map(([id, choice]) => `${id}: ${workflowAgentModelWords(choice)}`) : [];
    return chosen.length ? `Agent nodes with a model chosen at start: ${chosen.join("; ")}; the others use this session's model. ` : "";
}
