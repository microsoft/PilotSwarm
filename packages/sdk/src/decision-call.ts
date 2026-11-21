/**
 * One Decision provider call, shared by the Workflow Decision node (workflow/runtime.ts runDecision) and the agent
 * `decide` tool (decision-tools.ts): budget admission, the provider pin check, the adapter, the provider's own question
 * limits, the ledger claim, exactly one provider call, the confidence policy and, once claimed, settlement.
 *
 * The callers keep what differs: the node its entry, attempt cap, run binding, liveness and durable completion; the
 * tool its live model resolution, limits and result shape. Both get the same semantic output for the same
 * provider response, because both run this function (docs/proposals/agent-decide-tool.md).
 *
 * @module
 * @internal
 */
import { cmsRetryBestEffort } from "./cms-retry.js";
import {
    applyDecisionPolicy, DecisionProviderError, type DecisionNodeOutput, type DecisionProvider, type DecisionProviderErrorCode,
    type DecisionQuestion, type DecisionUsage,
} from "./decision-provider.js";
import type { DecisionProviderAdmission, ProviderStore } from "./provider-store.js";
import { runtimeMetrics } from "./runtime-metrics.js";
import { workflowErrorMessage } from "./workflow/commands.js";
import type { JsonValue } from "./workflow/json.js";

/** The worker's Decision host: the ledger and admission store, and the adapter for one pinned provider incarnation. */
export interface DecisionCallHost {
    providerStore: Pick<ProviderStore, "checkDecision" | "claimInferenceOperation" | "settleInferenceOperation">;
    /** A provider for this exact shared incarnation and credential version, or null when it changed or serves no such model. */
    providerFor(qualifiedModel: string, providerInstanceId: string, providerUpdatedAt: string | null)
        : DecisionProvider | null | Promise<DecisionProvider | null>;
}

/** The caller's wording for the refusals whose cause it names (the node says "this Workflow session"; the tool does not). */
export interface DecisionCallMessages {
    paused: string;
    noPayingProvider: string;
    replaced: string;
    alreadyClaimed: string;
}

export interface DecisionCallRequest {
    sessionId: string;
    /** Ledger key: (operationId, attempt) is claimed once, before the call. */
    operationId: string;
    attempt: number;
    /** Ledger purpose, for people reading usage. */
    purpose: string;
    /** Telemetry purpose (pilotswarm.inference.purpose). */
    telemetryPurpose: string;
    agentId?: string | null;
    workflowRunId?: string | null;
    nodeExecutionId?: string | null;
    /** The exact `provider:model`. */
    qualified: string;
    /** The provider's deployment name (the model part of `qualified`). */
    deployment: string;
    /** The pinned incarnation and type; a different admitted provider fails closed. Null: not pinned (never for a call). */
    providerInstanceId: string | null;
    providerTypeId: string | null;
    question: DecisionQuestion;
    confidence?: { minimumProbability: number } | null;
    state: JsonValue;
    timeoutMs: number;
    signal: AbortSignal;
    /**
     * The tool's own bounds before any claim: a stopped signal is `cancelled` and a passed deadline (performance.now()
     * milliseconds) is `timed_out`, with no claim and no call; the provider call gets the time left. The Workflow node
     * sets neither: its result is unchanged.
     */
    refuseStoppedBeforeClaim?: boolean;
    deadlineAt?: number;
    messages: DecisionCallMessages;
    /** Settlement is retried best-effort; its label and warnings go here. Settlement never changes the result. */
    settleLabel: string;
    /** The warning when settlement fails outside the retry policy. */
    settleFailure?: (detail: string) => string;
    warn?: (message: string) => void;
    /**
     * Caller lifecycle: `onProviderReady` once a provider is resolved, before its question check, claim and call;
     * `onCallEnd` after that, before settlement (only if onProviderReady ran). The node starts and stops its liveness
     * check here, where it always did.
     */
    onProviderReady?: () => void;
    onCallEnd?: () => void;
}

/** Why a call failed, for the caller's mapping (a node records `code`; the tool reports `reason` too). */
export type DecisionCallFailureReason =
    | "admission_failed" | "budget_paused" | "no_paying_provider" | "provider_replaced" | "provider_unresolved"
    | "no_provider" | "stopped_before_call" | "deadline_before_call" | "already_claimed" | "provider_error" | "unexpected";

export type DecisionCallCode = DecisionProviderErrorCode | "budget_exceeded";

export type DecisionCallResult =
    | { ok: true; output: DecisionNodeOutput; usage: DecisionUsage | null; latencyMs: number; admission: DecisionProviderAdmission }
    | {
        ok: false; code: DecisionCallCode; reason: DecisionCallFailureReason; message: string;
        usage: DecisionUsage | null; latencyMs: number | null; claimed: boolean;
    };

const errorText = workflowErrorMessage;

const DECISION_HTTP_STATUS_CLASSES = new Set(["1xx", "2xx", "3xx", "4xx", "5xx"]);

/** Optional provider evidence is telemetry-only: malformed or throwing access is silently ignored. */
export function decisionHttpStatusClassOf(value: unknown): "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | undefined {
    try {
        const telemetry = typeof value === "object" && value !== null ? (value as { telemetry?: unknown }).telemetry : undefined;
        const statusClass = typeof telemetry === "object" && telemetry !== null
            ? (telemetry as { httpStatusClass?: unknown }).httpStatusClass : undefined;
        return typeof statusClass === "string" && DECISION_HTTP_STATUS_CLASSES.has(statusClass)
            ? statusClass as "1xx" | "2xx" | "3xx" | "4xx" | "5xx" : undefined;
    } catch {
        return undefined;
    }
}

/** The tool's stop or deadline, if either has come: a stop whose reason is a timeout counts as the deadline. */
function stoppedOrLate(request: DecisionCallRequest): DecisionCallResult | null {
    if (!request.refuseStoppedBeforeClaim) return null;
    const timedOut = (request.deadlineAt !== undefined && performance.now() >= request.deadlineAt)
        || (request.signal.aborted && (request.signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError");
    if (timedOut) return failure("timed_out", "deadline_before_call", "The call ran out of time before it reached the Decision provider.");
    if (request.signal.aborted) return failure("cancelled", "stopped_before_call", "The call was stopped before it reached the Decision provider.");
    return null;
}

function failure(code: DecisionCallCode, reason: DecisionCallFailureReason, message: string,
    extra: { usage?: DecisionUsage | null; latencyMs?: number | null; claimed?: boolean } = {}): DecisionCallResult {
    return { ok: false, code, reason, message, usage: extra.usage ?? null, latencyMs: extra.latencyMs ?? null, claimed: extra.claimed === true };
}

/**
 * Run one Decision provider call. Never throws for a provider, admission or ledger failure: each is a coded result whose
 * message carries no key, token, HTTP status or provider body. A claimed call is settled in every case, with unknown
 * usage stored as unknown.
 */
export async function executeDecisionCall(host: DecisionCallHost, request: DecisionCallRequest): Promise<DecisionCallResult> {
    let admission: DecisionProviderAdmission;
    try {
        admission = await host.providerStore.checkDecision(request.sessionId, request.qualified, request.providerInstanceId);
    } catch (error) {
        return failure("execution_failed", "admission_failed", `The Decision provider admission failed: ${errorText(error)}`);
    }
    if (admission.verdict === "paused") return failure("budget_exceeded", "budget_paused", request.messages.paused);
    if (admission.verdict === "no_provider" || admission.providerName === null
        || admission.providerInstanceId === null || admission.providerClass !== "shared") {
        return failure("unavailable", "no_paying_provider", request.messages.noPayingProvider);
    }
    if ((request.providerInstanceId !== null && request.providerInstanceId !== admission.providerInstanceId)
        || (request.providerTypeId !== null && request.providerTypeId !== admission.providerTypeId)) {
        return failure("unavailable", "provider_replaced", request.messages.replaced);
    }

    let provider: DecisionProvider | null;
    try {
        provider = await host.providerFor(request.qualified, admission.providerInstanceId, admission.providerUpdatedAt);
    } catch (error) {
        return error instanceof DecisionProviderError
            ? failure(error.code, "provider_error", error.message)
            : failure("execution_failed", "provider_unresolved", `The Decision provider could not be resolved: ${errorText(error)}`);
    }
    if (provider === null) return failure("unavailable", "no_provider", "No Decision provider serves this model.");

    let claimed = false;
    let usage: DecisionUsage | null = null;
    let latencyMs: number | null = null;
    request.onProviderReady?.();
    try {
        // A question this provider cannot take (its own limits) fails here, with no claim and no call.
        provider.validate?.(request.question);
        const before = stoppedOrLate(request);
        if (before) return before;
        const first = await host.providerStore.claimInferenceOperation({
            operationId: request.operationId, attempt: request.attempt, capability: "decision",
            purpose: request.purpose,
            sessionId: request.sessionId,
            workflowRunId: request.workflowRunId ?? null, nodeExecutionId: request.nodeExecutionId ?? null,
            providerName: admission.providerName, providerInstanceId: admission.providerInstanceId,
            providerUpdatedAt: admission.providerUpdatedAt, modelQualified: request.qualified,
            ownerUserId: admission.ownerUserId,
            chargeClass: admission.exempt ? "system" : "user",
            ...(request.agentId ? { agentId: request.agentId } : {}),
        });
        // The claim also refuses a provider row changed since it was pinned (renamed, or its key replaced).
        if (!first) return failure("execution_failed", "already_claimed", request.messages.alreadyClaimed);
        claimed = true;
        // A stop or the deadline while the claim was written: the claimed call is settled, and nothing is sent.
        const late = stoppedOrLate(request);
        if (late) return { ...late, claimed: true } as DecisionCallResult;
        const finishInferenceCall = runtimeMetrics().startInferenceCall({
            provider: admission.providerName, model: request.qualified,
            operationId: request.operationId, attempt: request.attempt,
            purpose: request.telemetryPurpose,
            ...(request.workflowRunId ? { workflowRunId: request.workflowRunId } : {}),
            ...(request.nodeExecutionId ? { nodeExecutionId: request.nodeExecutionId } : {}),
        });
        let response: Awaited<ReturnType<DecisionProvider["decide"]>>;
        const callStarted = performance.now();
        try {
            const timeoutMs = request.deadlineAt === undefined ? request.timeoutMs
                : Math.max(1, Math.min(request.timeoutMs, Math.ceil(request.deadlineAt - performance.now())));
            response = await provider.decide({
                model: request.deployment, state: request.state, question: request.question,
                timeoutMs, signal: request.signal,
            });
            latencyMs = Math.max(0, Math.round(performance.now() - callStarted));
            usage = response.usage;
            const httpStatusClass = decisionHttpStatusClassOf(response);
            finishInferenceCall({ result: "success", usage: response.usage, ...(httpStatusClass ? { httpStatusClass } : {}) });
        } catch (error) {
            latencyMs = Math.max(0, Math.round(performance.now() - callStarted));
            const httpStatusClass = decisionHttpStatusClassOf(error);
            if (error instanceof DecisionProviderError && error.usage !== undefined) usage = error.usage;
            finishInferenceCall({
                result: "error",
                errorCode: error instanceof DecisionProviderError ? error.code : "execution_failed",
                ...(usage ? { usage } : {}),
                ...(httpStatusClass ? { httpStatusClass } : {}),
            });
            throw error;
        }
        const output = applyDecisionPolicy({ question: request.question, confidence: request.confidence ?? undefined,
            answer: response.answer, model: request.qualified });
        return { ok: true, output, usage, latencyMs, admission };
    } catch (error) {
        return error instanceof DecisionProviderError
            ? failure(error.code, "provider_error", error.message, { usage, latencyMs, claimed })
            : failure("execution_failed", "unexpected", errorText(error), { usage, latencyMs, claimed });
    } finally {
        try { request.onCallEnd?.(); } catch { /* A caller hook must not alter the Decision result. */ }
        if (claimed) {
            const warn = (message: string) => {
                try { request.warn?.(message); } catch { /* Settlement must not alter the Decision result. */ }
            };
            try {
                await cmsRetryBestEffort(request.settleLabel, () => host.providerStore.settleInferenceOperation({
                    operationId: request.operationId, attempt: request.attempt,
                    tokensInput: usage?.inputTokens ?? null,
                    tokensOutput: usage?.outputTokens ?? null,
                    tokensCacheRead: null, tokensCacheWrite: null, latencyMs,
                }), warn);
            } catch (error) {
                warn(request.settleFailure ? request.settleFailure(errorText(error))
                    : `[decision] ${request.settleLabel}: settlement failed outside the retry policy: ${errorText(error)}`);
            }
        }
    }
}
