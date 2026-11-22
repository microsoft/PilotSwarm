/**
 * The agent `decide` tool: one typed Decision question, answered inside the turn (docs/proposals/agent-decide-tool.md).
 *
 * - The same question shape and validator as the Workflow Decision node, and the same execution core
 *   (decision-call.ts), so the tool and the node give the same answer for the same provider response.
 * - Availability and the model are resolved when the tool is CALLED, from the CMS (a cache of at most 5 s), never from
 *   a prompt or a worker cache: the `model` argument if it is a live shared Decision model, else the Cluster Decision
 *   Default.
 * - Every call is admitted against the budget and claimed in the inference ledger under `decide:<session>:<tool call>`
 *   before the one provider call, so a tool call makes at most one provider call and one ledger row.
 * - The answer is advice. The tool writes nothing but the ledger and grants nothing.
 *
 * @module
 * @internal
 */
import { Buffer } from "node:buffer";
import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import { executeDecisionCall, type DecisionCallCode, type DecisionCallFailureReason, type DecisionCallHost } from "./decision-call.js";
import type { DecisionNodeOutput, DecisionUsage } from "./decision-provider.js";
import type { ModelProviderRegistry } from "./model-providers.js";
import { resolveClusterDecisionCapability, resolveRuntimeDecisionProviderBinding, runtimeDecisionModels } from "./provider-catalog.js";
import type { DefaultTuple, ProviderCredential, ProviderStore } from "./provider-store.js";
import { validateDecisionQuestion } from "./workflow/compiler.js";
import { canonicalJson, type JsonValue } from "./workflow/json.js";

export const DECIDE_TOOL_NAME = "decide";
export const DECIDE_MAX_CALLS_PER_TURN = 20;
export const DECIDE_MAX_CONTEXT_BYTES = 64 * 1024;
export const DECIDE_DEFAULT_TIMEOUT_SECONDS = 30;
export const DECIDE_MAX_TIMEOUT_SECONDS = 120;
/** How long a worker may reuse one read of the provider rows and the Cluster Decision Default. */
export const DECIDE_CATALOG_CACHE_MS = 5_000;
export const DECIDE_LEDGER_PURPOSE = "Agent decide tool";
export const DECIDE_TELEMETRY_PURPOSE = "agent_decide_tool";

export const DECIDE_TOOL_DESCRIPTION = "Ask a Decision model one typed question and get a calibrated answer with probabilities: "
    + "choice (pick one labelled option), noul (yes or no) or score (a level on an ordered scale), over context you supply. "
    + "Use it for a bounded classification or check. The answer is advice: it never approves an action or grants a permission. "
    + "Availability and the model are checked when you call it; an error says what is missing and whether a retry can help.";

export const DECIDE_TOOL_PARAMETERS = {
    type: "object",
    properties: {
        question: {
            type: "object",
            description: "type, instructions, criteria. choice: {label: description}, 2+ labels; noul: {true, false} or omit; "
                + "score: ordered level labels, 2+. A label starts with a letter: letters, digits, _ or -.",
            properties: {
                type: { type: "string", enum: ["choice", "noul", "score"] },
                instructions: { type: "string" },
                criteria: { description: "See question" },
            },
            required: ["type", "instructions"],
        },
        context: { description: "JSON the question is about (64 KiB at most)" },
        minimum_probability: { type: "number", description: "0-1; a lower confidence answers uncertain. Not for score" },
        model: { type: "string", description: "A Decision model provider:model; omit for the cluster default" },
        timeout_seconds: { type: "integer", description: "1-120, default 30" },
    },
    required: ["question"],
} as const;

/** The worker's Decision host, with what the tool also reads: provider rows, the Cluster Decision Default and the type catalog. */
export interface DecideToolHost extends DecisionCallHost {
    providerStore: DecisionCallHost["providerStore"] & Pick<ProviderStore, "allCredentials" | "getClusterDecisionDefault">;
    /** The worker's provider-type catalog, or null before it loads. */
    providerTypes(): ModelProviderRegistry | null;
}

export interface DecisionCatalogSnapshot {
    credentials: ProviderCredential[];
    decisionDefault: DefaultTuple;
}

/**
 * One read of the provider rows and the Cluster Decision Default, reused for at most `ttlMs` (never more than 5 s, on a
 * monotonic clock). A failed read is not kept.
 */
export function createDecisionCatalogReader(host: Pick<DecideToolHost, "providerStore">, options: { ttlMs?: number; now?: () => number } = {})
    : () => Promise<DecisionCatalogSnapshot> {
    const ttlMs = Math.min(options.ttlMs ?? DECIDE_CATALOG_CACHE_MS, DECIDE_CATALOG_CACHE_MS);
    const now = options.now ?? (() => performance.now());
    let cached: { at: number; value: Promise<DecisionCatalogSnapshot> } | null = null;
    return () => {
        if (cached && now() - cached.at < ttlMs) return cached.value;
        const value = Promise.all([host.providerStore.allCredentials(), host.providerStore.getClusterDecisionDefault()])
            .then(([credentials, decisionDefault]) => ({ credentials, decisionDefault }));
        const entry = { at: now(), value };
        cached = entry;
        value.catch(() => { if (cached === entry) cached = null; });
        return value;
    };
}

export type DecideErrorCode = DecisionCallCode | "decision_model_unavailable";

export type DecideToolResult =
    | {
        ok: true; decision: DecisionNodeOutput; model_source: "explicit" | "cluster_decision_default";
        usage: DecisionUsage | null; latency_ms: number;
    }
    | { ok: false; error: { code: DecideErrorCode; reason: string | null; message: string; retryable: boolean; action: string } };

const RETRYABLE = new Set<DecideErrorCode>(["unavailable", "timed_out", "invalid_output"]);

const ACTIONS: Record<DecideErrorCode, string> = {
    decision_model_unavailable: "Ask an administrator to set the Cluster Decision Default (Admin Settings, or set_model_default with scope cluster and purpose decision).",
    invalid_input: "Fix the arguments and call again.",
    budget_exceeded: "Do not retry now: wait for the provider budget to reset or ask its owner to raise it.",
    forbidden: "Ask an administrator to check the Decision provider's credential.",
    unavailable: "Retry once later; if it fails again, ask an administrator to check the Decision provider.",
    timed_out: "Retry once, with a larger timeout_seconds if the question or context is large.",
    cancelled: "The turn was stopped; do not retry.",
    invalid_output: "Retry once; if it fails again, decide without it.",
    execution_failed: "Do not retry; report the error.",
};

function refuse(code: DecideErrorCode, message: string, reason: string | null = null, action?: string): DecideToolResult {
    return { ok: false, error: { code, reason, message, retryable: RETRYABLE.has(code), action: action ?? ACTIONS[code] } };
}

/**
 * The words the tool shows for a core failure. A provider adapter's own errors are written for people and never carry a
 * key, token, HTTP status or body, so they pass through; everything else (a database, factory or unexpected error) gets
 * fixed words, never the underlying exception's text.
 */
const FIXED_FAILURE_WORDS: Partial<Record<DecisionCallFailureReason, string>> = {
    admission_failed: "The budget check for the Decision provider could not be made.",
    provider_unresolved: "The Decision provider could not be prepared.",
    unexpected: "The Decision call failed unexpectedly.",
};

const ARGUMENTS = new Set(["question", "context", "minimum_probability", "model", "timeout_seconds"]);

type CheckedArguments = {
    question: NonNullable<ReturnType<typeof validateDecisionQuestion>["question"]>;
    state: JsonValue;
    minimumProbability: number | null;
    model: string | null;
    timeoutSeconds: number;
};

/** The arguments as the Decision node would take them, or the invalid_input words. */
export function checkDecideArguments(args: unknown): CheckedArguments | { error: string } {
    if (typeof args !== "object" || args === null || Array.isArray(args)) return { error: "decide takes an object with a question." };
    const given = args as Record<string, unknown>;
    const unknown = Object.keys(given).filter(key => !ARGUMENTS.has(key));
    if (unknown.length) return { error: `Unknown argument ${unknown.map(key => `'${key}'`).join(", ")} (allowed: ${[...ARGUMENTS].join(", ")}).` };
    const checked = validateDecisionQuestion(given.question, "question");
    if (checked.question === null) return { error: checked.errors.join(" ") };
    const question = checked.question;

    let minimumProbability: number | null = null;
    if (given.minimum_probability !== undefined && given.minimum_probability !== null) {
        if (question.type === "score") return { error: "A score question does not take minimum_probability; it always answers scored." };
        const value = given.minimum_probability;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
            return { error: "minimum_probability must be a finite number from 0 to 1." };
        }
        minimumProbability = value;
    }

    let timeoutSeconds = DECIDE_DEFAULT_TIMEOUT_SECONDS;
    if (given.timeout_seconds !== undefined && given.timeout_seconds !== null) {
        const value = given.timeout_seconds;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > DECIDE_MAX_TIMEOUT_SECONDS) {
            return { error: `timeout_seconds must be an integer from 1 to ${DECIDE_MAX_TIMEOUT_SECONDS}; the default is ${DECIDE_DEFAULT_TIMEOUT_SECONDS}.` };
        }
        timeoutSeconds = value;
    }

    let model: string | null = null;
    if (given.model !== undefined && given.model !== null) {
        if (typeof given.model !== "string" || !given.model.trim()) return { error: "model must be a Decision model as provider:model, or be omitted." };
        model = given.model.trim();
    }

    const state = (given.context === undefined ? {} : given.context) as JsonValue;
    let text: string;
    try {
        text = canonicalJson(state);
    } catch {
        return { error: "context must be JSON (objects, arrays, strings, finite numbers, booleans and null)." };
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > DECIDE_MAX_CONTEXT_BYTES) {
        return { error: `context is ${bytes.toLocaleString("en-US")} bytes as JSON; the limit is ${DECIDE_MAX_CONTEXT_BYTES.toLocaleString("en-US")}.` };
    }
    return { question, state, minimumProbability, model, timeoutSeconds };
}

type Resolved = {
    qualified: string; source: "explicit" | "cluster_decision_default"; providerInstanceId: string; providerTypeId: string;
};

/** The model for this call, read live. Never a chat model, a personal provider or a cached capability. */
export function resolveDecideModel(types: ModelProviderRegistry | null, snapshot: DecisionCatalogSnapshot, requested: string | null)
    : Resolved | { refusal: DecideToolResult } {
    const credentials = [...snapshot.credentials].sort((a, b) => a.name.localeCompare(b.name));
    let qualified: string;
    let source: Resolved["source"];
    if (requested !== null) {
        const eligible = runtimeDecisionModels(types, credentials).map(model => model.qualifiedName);
        if (!eligible.includes(requested)) {
            const shown = eligible.slice(0, 10);
            return { refusal: refuse("decision_model_unavailable",
                `${requested} is not a Decision model that a shared provider serves now.`, "model_not_eligible",
                shown.length ? `Omit model to use the Cluster Decision Default, or use one of: ${shown.join(", ")}${eligible.length > shown.length ? ", ..." : ""}.`
                    : "No shared Decision model is available. Ask an administrator to configure one.") };
        }
        qualified = requested;
        source = "explicit";
    } else {
        const capability = resolveClusterDecisionCapability(types, credentials, snapshot.decisionDefault);
        if (!capability.available || !capability.defaultModel) {
            const reason = capability.reason ?? "cluster_decision_default_ineligible";
            return { refusal: reason === "no_cluster_decision_default"
                ? refuse("decision_model_unavailable", "No Cluster Decision Default is configured.", reason)
                : refuse("decision_model_unavailable", "The Cluster Decision Default is not an eligible shared Decision model now.", reason,
                    "Ask an administrator to replace the Cluster Decision Default with an eligible shared Decision model.") };
        }
        qualified = capability.defaultModel;
        source = "cluster_decision_default";
    }
    const binding = resolveRuntimeDecisionProviderBinding(types, credentials, qualified);
    if (!binding) {
        return { refusal: refuse("decision_model_unavailable", `${qualified} is not served by a shared provider now.`, "model_not_eligible") };
    }
    return { qualified, source, providerInstanceId: binding.providerInstanceId, providerTypeId: binding.providerTypeId };
}

export interface CreateDecideToolOptions {
    sessionId: string;
    /** The session's agent, recorded on each ledger row. */
    agentId: string | null;
    host: DecideToolHost;
    /** Live provider rows and Cluster Decision Default (createDecisionCatalogReader). */
    readCatalog: () => Promise<DecisionCatalogSnapshot>;
    /** Count one call in the current turn and return the count, this call included. */
    countCall: () => number;
    warn?: (message: string) => void;
}

const NEVER = new AbortController().signal;

/** The invocation a turn gives a tool: the SDK's call id and signal, and the turn's own stop signal (managed-session.ts). */
export type DecideInvocation = { toolCallId?: string; signal?: AbortSignal; turnSignal?: AbortSignal };

/** The `decide` tool for one session: its declaration and handler in one object, so neither can exist without the other. */
export function createDecideTool(options: CreateDecideToolOptions): Tool<any> {
    return defineTool(DECIDE_TOOL_NAME, {
        description: DECIDE_TOOL_DESCRIPTION,
        parameters: DECIDE_TOOL_PARAMETERS as any,
        handler: async (args: unknown, invocation?: DecideInvocation) => runDecide(options, args, invocation),
    });
}

/** One `decide` call. Exported for tests; the tool's handler is exactly this. Never throws: every failure is coded. */
export async function runDecide(options: CreateDecideToolOptions, args: unknown, invocation?: DecideInvocation): Promise<DecideToolResult> {
    try {
        return await decideOnce(options, args, invocation);
    } catch {
        return refuse("execution_failed", FIXED_FAILURE_WORDS.unexpected!, "unexpected");
    }
}

async function decideOnce(options: CreateDecideToolOptions, args: unknown, invocation?: DecideInvocation): Promise<DecideToolResult> {
    const toolCallId = typeof invocation?.toolCallId === "string" ? invocation.toolCallId.trim() : "";
    if (!toolCallId) return refuse("execution_failed", "The call has no tool call id, so it cannot be recorded once.", "no_tool_call_id");
    if (options.countCall() > DECIDE_MAX_CALLS_PER_TURN) {
        return refuse("budget_exceeded", `This turn already made ${DECIDE_MAX_CALLS_PER_TURN} decide calls, the limit for one turn.`,
            "per_turn_limit", "Finish this turn without more decide calls.");
    }
    const checked = checkDecideArguments(args);
    if ("error" in checked) return refuse("invalid_input", checked.error);

    // The turn's stop and the SDK's request signal both cancel the call; timeout_seconds bounds the whole call.
    const signals = [invocation?.signal, invocation?.turnSignal].filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
    const signal = signals.length === 0 ? NEVER : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    const timeoutMs = checked.timeoutSeconds * 1_000;
    const deadlineAt = performance.now() + timeoutMs;
    const stoppedOrLate = (): DecideToolResult | null => {
        const timedOut = performance.now() >= deadlineAt
            || (signal.aborted && (signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError");
        if (timedOut) return refuse("timed_out", "The call ran out of time before it reached the Decision provider.", "deadline_before_call");
        return signal.aborted ? refuse("cancelled", "The turn was stopped before the call.", "stopped_before_call") : null;
    };
    const early = stoppedOrLate();
    if (early) return early;
    let snapshot: DecisionCatalogSnapshot;
    let bound: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
        // A stop or the deadline ends the wait for the catalog read too.
        const stopped = new Promise<"stopped">(resolve => {
            bound = setTimeout(() => resolve("stopped"), Math.max(0, deadlineAt - performance.now()));
            onAbort = () => resolve("stopped");
            signal.addEventListener("abort", onAbort, { once: true });
        });
        const read = await Promise.race([options.readCatalog(), stopped]);
        if (read === "stopped") return stoppedOrLate() ?? refuse("timed_out", "The call ran out of time before it reached the Decision provider.", "deadline_before_call");
        snapshot = read;
    } catch {
        return refuse("unavailable", "The Decision model catalog could not be read.", "catalog_unavailable");
    } finally {
        if (bound !== undefined) clearTimeout(bound);
        if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    const types = options.host.providerTypes();
    if (!types) return refuse("unavailable", "This worker has not loaded its model catalog yet.", "catalog_unavailable");
    const resolved = resolveDecideModel(types, snapshot, checked.model);
    if ("refusal" in resolved) return resolved.refusal;
    const late = stoppedOrLate();
    if (late) return late;

    const operationId = `decide:${options.sessionId}:${toolCallId}`;
    const called = await executeDecisionCall(options.host, {
        sessionId: options.sessionId,
        operationId, attempt: 1,
        purpose: DECIDE_LEDGER_PURPOSE,
        telemetryPurpose: DECIDE_TELEMETRY_PURPOSE,
        agentId: options.agentId,
        qualified: resolved.qualified,
        deployment: resolved.qualified.slice(resolved.qualified.indexOf(":") + 1),
        providerInstanceId: resolved.providerInstanceId, providerTypeId: resolved.providerTypeId,
        question: checked.question,
        confidence: checked.minimumProbability === null ? null : { minimumProbability: checked.minimumProbability },
        state: checked.state,
        timeoutMs,
        signal,
        refuseStoppedBeforeClaim: true,
        deadlineAt,
        messages: {
            paused: "The Decision provider's budget is paused for this session's owner.",
            noPayingProvider: "No paying shared provider serves this Decision model.",
            replaced: "The Decision provider was replaced during the call.",
            alreadyClaimed: "This tool call was already recorded, or the Decision provider changed during the call; no second provider call was made.",
        },
        settleLabel: `decide.settleInferenceOperation operation=${operationId}`,
        warn: options.warn,
    });
    if (!called.ok) return refuse(called.code, FIXED_FAILURE_WORDS[called.reason] ?? called.message, called.reason);
    return { ok: true, decision: called.output, model_source: resolved.source, usage: called.usage, latency_ms: called.latencyMs };
}
