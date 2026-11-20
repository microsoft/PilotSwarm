/**
 * The Workflow Decision provider boundary (design v11, docs/proposals/workflow-decision-node.md): the provider-neutral
 * DecisionProvider contract, the confidence policy that turns a normalized answer into the semantic node output, and
 * the one v1 adapter, which speaks the Microsoft Foundry systemone Decision protocol.
 *
 * Workflow core never sees a provider type, endpoint or credential mode. The adapter owns the endpoint derivation, the
 * credential (the instance's key, or foundry-wif workload identity; never a fallback from one to the other), exactly
 * one HTTP call with no retry, the mapping onto existing Workflow runtime error codes, and strict normalization of the
 * answer. Usage is returned beside the answer, never inside it, and no transport evidence enters the result.
 */
import { foundryBearerTokenProvider } from "./foundry-credentials.js";
import type { ResolvedProvider } from "./model-providers.js";
import type { RuntimeErrorCode, WorkflowIRDecision, WorkflowIRDecisionQuestion } from "./workflow/compiler.js";
import type { JsonValue } from "./workflow/json.js";

// ─── Contract ────────────────────────────────────────────────────

export type DecisionQuestion = WorkflowIRDecisionQuestion;

export type DecisionRequest = {
    /** The provider's deployment name for the Decision model. */
    model: string;
    state: JsonValue;
    question: DecisionQuestion;
    timeoutMs: number;
    signal: AbortSignal;
};

export type DecisionChoiceAnswer = { questionType: "choice"; selection: string; probabilities: Record<string, number> };
export type DecisionNoulAnswer = { questionType: "noul"; probability: number; probabilities: { yes: number; no: number } };
export type DecisionScoreLevel = { label: string; probability: number };
export type DecisionScoreAnswer = { questionType: "score"; score: number; levels: DecisionScoreLevel[] };
export type DecisionAnswer = DecisionChoiceAnswer | DecisionNoulAnswer | DecisionScoreAnswer;

/** Reported token counts; null when usage is missing or is not two whole, non-negative counts (unknown). */
export type DecisionUsage = { inputTokens: number; outputTokens: number };
export type DecisionHttpStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx";

/** Optional transport evidence for runtime telemetry only; it never enters the semantic node output. */
export type DecisionProviderTelemetry = { httpStatusClass?: DecisionHttpStatusClass };

export type DecisionResponse = {
    answer: DecisionAnswer;
    usage: DecisionUsage | null;
    telemetry?: DecisionProviderTelemetry;
};

export interface DecisionProvider {
    decide(input: DecisionRequest): Promise<DecisionResponse>;
}

export type DecisionFetch = (input: string, init: RequestInit) => Promise<Response>;

export type DecisionProviderDeps = {
    fetch?: DecisionFetch;
    /** The workload-identity bearer token source. Defaults to the Foundry credential helper. */
    getAccessToken?: () => Promise<string>;
};

export type DecisionAuth = "api-key" | "workload-identity";
export type DecisionQualificationFailure = "unsupported_base_url" | "unsupported_auth";
export type DecisionQualification =
    | { qualified: true; endpoint: string; auth: DecisionAuth }
    | { qualified: false; reason: DecisionQualificationFailure };

/** The existing Workflow runtime error codes a Decision provider call can end with. */
export type DecisionProviderErrorCode = Extract<RuntimeErrorCode,
    "invalid_output" | "timed_out" | "cancelled" | "forbidden" | "unavailable" | "execution_failed">;

/** A Decision provider failure. Its message never carries a key, token, request ID, HTTP status or provider body. */
export class DecisionProviderError extends Error {
    readonly code: DecisionProviderErrorCode;
    /** Why the provider is not qualified, on the `unavailable` error that createDecisionProvider throws. */
    readonly reason?: DecisionQualificationFailure;
    /** Optional transport evidence for runtime telemetry only; never a raw provider error. */
    readonly telemetry?: DecisionProviderTelemetry;
    /** Independently normalized usage, even when the semantic answer is invalid. */
    readonly usage?: DecisionUsage | null;

    constructor(code: DecisionProviderErrorCode, message: string,
        options: { reason?: DecisionQualificationFailure; cause?: unknown; telemetry?: DecisionProviderTelemetry;
            usage?: DecisionUsage | null } = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "DecisionProviderError";
        this.code = code;
        if (options.reason !== undefined) this.reason = options.reason;
        if (options.telemetry !== undefined) this.telemetry = options.telemetry;
        if (options.usage !== undefined) this.usage = options.usage;
    }
}

// ─── Confidence policy and semantic node output ──────────────────

export type DecisionPolicy = { minimumProbability: number | null; uncertain: boolean };
export type DecisionModelIdentity = { qualified: string };

export type DecisionChoiceOutput = {
    questionType: "choice";
    outcome: string;
    selection: string;
    confidence: number;
    probabilities: Record<string, number>;
    policy: DecisionPolicy;
    model: DecisionModelIdentity;
};

export type DecisionNoulOutput = {
    questionType: "noul";
    outcome: "yes" | "no" | "uncertain";
    selection: "yes" | "no";
    confidence: number;
    probability: number;
    probabilities: { yes: number; no: number };
    policy: DecisionPolicy;
    model: DecisionModelIdentity;
};

export type DecisionScoreOutput = {
    questionType: "score";
    outcome: "scored";
    score: number;
    levels: DecisionScoreLevel[];
    model: DecisionModelIdentity;
};

export type DecisionNodeOutput = DecisionChoiceOutput | DecisionNoulOutput | DecisionScoreOutput;

export type DecisionPolicyInput = {
    question: DecisionQuestion;
    confidence?: WorkflowIRDecision["confidence"];
    answer: DecisionAnswer;
    /** The qualified Decision model (`provider:model`) the node ran with. */
    model: string;
};

/**
 * The semantic node output for a normalized answer. The provider's selection is authoritative: choice confidence is
 * the selected option's probability; noul selects yes at p >= 0.5 with confidence max(p, 1 - p); either routes
 * `uncertain` only when confidence is strictly below minimumProbability. Score always routes `scored`. Nothing is
 * re-sorted or re-derived, and the input is not changed.
 */
export function applyDecisionPolicy(input: DecisionPolicyInput): DecisionNodeOutput {
    const { question, confidence, answer, model } = input;
    if (answer.questionType !== question.type) {
        throw new DecisionProviderError("invalid_output", "The Decision answer does not match the question type.");
    }
    const identity = { qualified: model };
    if (answer.questionType === "score") {
        return {
            questionType: "score",
            outcome: "scored",
            score: answer.score,
            levels: answer.levels.map(level => ({ label: level.label, probability: level.probability })),
            model: identity,
        };
    }
    const minimumProbability = confidence?.minimumProbability ?? null;
    const policyFor = (value: number): DecisionPolicy => ({
        minimumProbability,
        uncertain: minimumProbability !== null && value < minimumProbability,
    });
    if (answer.questionType === "choice") {
        const value = Object.hasOwn(answer.probabilities, answer.selection) ? answer.probabilities[answer.selection] : undefined;
        if (!isProbability(value)) {
            throw new DecisionProviderError("invalid_output", "The choice answer has no probability for its selection.");
        }
        const policy = policyFor(value);
        return {
            questionType: "choice",
            outcome: policy.uncertain ? "uncertain" : answer.selection,
            selection: answer.selection,
            confidence: value,
            probabilities: { ...answer.probabilities },
            policy,
            model: identity,
        };
    }
    const probability = answer.probability;
    if (!isProbability(probability)) {
        throw new DecisionProviderError("invalid_output", "The noul answer has no probability from 0 to 1.");
    }
    const selection = probability >= 0.5 ? "yes" : "no";
    const value = Math.max(probability, 1 - probability);
    const policy = policyFor(value);
    return {
        questionType: "noul",
        outcome: policy.uncertain ? "uncertain" : selection,
        selection,
        confidence: value,
        probability,
        probabilities: { yes: answer.probabilities.yes, no: answer.probabilities.no },
        policy,
        model: identity,
    };
}

// ─── Foundry systemone adapter (v1) ──────────────────────────────

const FOUNDRY_OPENAI_V1 = "/openai/v1";
const FOUNDRY_DECISION_PATH = "/providers/microsoft/v1/systemone";
/** A longer setTimeout delay fires at once. A Workflow decision allows at most one day. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** Raw provider bodies are bounded at the existing 1 MiB Workflow RPC body limit. */
export const DECISION_RESPONSE_MAX_BYTES = 1024 * 1024;

type FoundryTarget =
    | { endpoint: string; auth: "api-key"; apiKey: string }
    | { endpoint: string; auth: "workload-identity" };

type FoundryCredential =
    | { auth: "api-key"; apiKey: string }
    | { auth: "workload-identity"; getAccessToken: () => Promise<string> };

type FoundryCall = {
    endpoint: string;
    credential: FoundryCredential;
    send: DecisionFetch;
    /** The provider type's fixed, non-credential headers (ModelProviderConfig.headers). */
    typeHeaders: Record<string, string> | undefined;
};

/** The HTTPS resource root: the base without exactly `/openai/v1`, after at most one trailing slash is removed. */
function foundryRoot(baseUrl: string): string | null {
    const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    if (!base.endsWith(FOUNDRY_OPENAI_V1)) return null;
    const root = base.slice(0, -FOUNDRY_OPENAI_V1.length);
    if (/[?#\s]/.test(root)) return null;
    let url: URL;
    try {
        url = new URL(root);
    } catch {
        return null;
    }
    return url.protocol === "https:" && !url.username && !url.password ? root : null;
}

function qualify(resolved: ResolvedProvider): FoundryTarget | DecisionQualificationFailure {
    if ((resolved.usesWorkloadIdentity === true) !== (resolved.type === "foundry-wif")) return "unsupported_auth";
    const sdk = resolved.sdkProvider;
    if (!sdk || sdk.type !== "openai" || typeof sdk.baseUrl !== "string") return "unsupported_base_url";
    const root = foundryRoot(sdk.baseUrl);
    if (root === null) return "unsupported_base_url";
    const endpoint = `${root}${FOUNDRY_DECISION_PATH}`;
    if (resolved.usesWorkloadIdentity === true) return { endpoint, auth: "workload-identity" };
    const apiKey = sdk.apiKey;
    return typeof apiKey === "string" && apiKey.trim() !== "" ? { endpoint, auth: "api-key", apiKey } : "unsupported_auth";
}

/**
 * Whether this resolved provider can serve Workflow decisions, and how. Only an HTTPS base ending in `/openai/v1`
 * (one trailing slash allowed) has a known systemone endpoint, and only an instance key or foundry-wif workload
 * identity is a supported credential. A provider with no SDK config (GitHub) is unqualified, not an error. The
 * credential itself is never reported.
 */
export function qualifyDecisionProvider(resolved: ResolvedProvider): DecisionQualification {
    const target = qualify(resolved);
    return typeof target === "string"
        ? { qualified: false, reason: target }
        : { qualified: true, endpoint: target.endpoint, auth: target.auth };
}

/** A DecisionProvider for a qualified provider. An unqualified one throws `unavailable` before any call or token. */
export function createDecisionProvider(resolved: ResolvedProvider, deps: DecisionProviderDeps = {}): DecisionProvider {
    const target = qualify(resolved);
    if (typeof target === "string") {
        throw new DecisionProviderError("unavailable",
            `Provider ${JSON.stringify(resolved.providerId)} cannot serve Workflow decisions: ${target}.`, { reason: target });
    }
    const credential: FoundryCredential = target.auth === "api-key"
        ? { auth: "api-key", apiKey: target.apiKey }
        : { auth: "workload-identity", getAccessToken: deps.getAccessToken ?? foundryBearerTokenProvider() };
    const call: FoundryCall = {
        endpoint: target.endpoint,
        credential,
        send: deps.fetch ?? ((input, init) => fetch(input, init)),
        typeHeaders: resolved.sdkProvider?.headers,
    };
    return { decide: request => foundryDecide(call, request) };
}

async function foundryDecide(call: FoundryCall, request: DecisionRequest): Promise<DecisionResponse> {
    const { model, state, question, timeoutMs, signal } = request;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
        throw new DecisionProviderError("execution_failed", "The Decision provider call needs a positive timeout.");
    }
    let body: string;
    try {
        body = JSON.stringify({ model, state, questions: { decision: question } });
    } catch {
        throw new DecisionProviderError("execution_failed", "The Decision request could not be encoded as JSON.");
    }
    if (signal.aborted) throw stopped(false, signal.reason);

    const controller = new AbortController();
    let timedOut = false;
    let statusClass: DecisionHttpStatusClass | null = null;
    const timer = setTimeout(() => {
        if (controller.signal.aborted) return;
        timedOut = true;
        controller.abort(new DOMException("The Decision provider call timed out.", "TimeoutError"));
    }, timeoutMs);
    const forward = () => controller.abort(signal.reason);
    signal.addEventListener("abort", forward, { once: true });
    try {
        const headers = await requestHeaders(call, controller.signal);
        const response = await call.send(call.endpoint, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
            // Never follow a redirect: the credential goes to the qualified endpoint only.
            redirect: "manual",
        });
        statusClass = httpStatusClass(response.status);
        if (!response.ok) {
            void response.body?.cancel().catch(() => undefined);
            throw statusError(response.status);
        }
        const normalized = parseDecisionResponse(question, await readDecisionResponse(response, controller.signal));
        return { ...normalized, ...(statusClass ? { telemetry: { httpStatusClass: statusClass } } : {}) };
    } catch (error) {
        if (error instanceof DecisionProviderError) throw withTelemetry(error, statusClass);
        if (controller.signal.aborted) throw stopped(timedOut, signal.reason, statusClass);
        // The Fetch standard's network error. Request construction cannot raise one here: the endpoint is qualified
        // and the headers are already built.
        if (error instanceof TypeError) {
            throw new DecisionProviderError("unavailable", "The Decision provider could not be reached.", {
                cause: error, telemetry: statusClass ? { httpStatusClass: statusClass } : undefined,
            });
        }
        throw new DecisionProviderError("execution_failed", "The Decision provider call failed unexpectedly.", {
            telemetry: statusClass ? { httpStatusClass: statusClass } : undefined,
        });
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", forward);
    }
}

async function requestHeaders(call: FoundryCall, signal: AbortSignal): Promise<Headers> {
    let name: string;
    let value: string;
    if (call.credential.auth === "api-key") {
        name = "api-key";
        value = call.credential.apiKey;
    } else {
        const { getAccessToken } = call.credential;
        let token: unknown;
        try {
            token = await untilAborted(Promise.resolve().then(() => getAccessToken()), signal);
        } catch (error) {
            if (signal.aborted) throw error;
            throw new DecisionProviderError("execution_failed",
                "The workload-identity token for the Decision provider could not be acquired.", { cause: error });
        }
        if (typeof token !== "string" || token === "") {
            throw new DecisionProviderError("execution_failed", "The workload-identity token for the Decision provider is empty.");
        }
        name = "authorization";
        value = `Bearer ${token}`;
    }
    try {
        const headers = new Headers(call.typeHeaders);
        headers.set("content-type", "application/json");
        headers.set(name, value);
        return headers;
    } catch {
        // No cause: a header error can quote the credential.
        throw new DecisionProviderError("execution_failed", "The Decision provider request headers are invalid.");
    }
}

/** `work`, unless `signal` aborts first. A token source takes no signal, but the call's deadline still covers it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        work.then(
            value => { signal.removeEventListener("abort", abort); resolve(value); },
            error => { signal.removeEventListener("abort", abort); reject(error); },
        );
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
    });
}

function httpStatusClass(status: number): DecisionHttpStatusClass | null {
    const hundred = Number.isInteger(status) ? Math.trunc(status / 100) : 0;
    return hundred >= 1 && hundred <= 5 ? `${hundred}xx` as DecisionHttpStatusClass : null;
}

function withTelemetry(error: DecisionProviderError, statusClass: DecisionHttpStatusClass | null): DecisionProviderError {
    if (!statusClass || error.telemetry?.httpStatusClass === statusClass) return error;
    return new DecisionProviderError(error.code, error.message, {
        ...(error.reason ? { reason: error.reason } : {}),
        ...(error.cause !== undefined ? { cause: error.cause } : {}),
        ...(error.usage !== undefined ? { usage: error.usage } : {}),
        telemetry: { httpStatusClass: statusClass },
    });
}

/** The adapter's own timeout, or the caller's signal: a deadline (TimeoutError) is timed_out, anything else cancelled. */
function stopped(timedOut: boolean, reason: unknown, statusClass: DecisionHttpStatusClass | null = null): DecisionProviderError {
    const telemetry = statusClass ? { httpStatusClass: statusClass } : undefined;
    if (timedOut) return new DecisionProviderError("timed_out", "The Decision provider did not answer within the timeout.", { telemetry });
    const name = typeof reason === "object" && reason !== null ? (reason as { name?: unknown }).name : undefined;
    return name === "TimeoutError"
        ? new DecisionProviderError("timed_out", "The Decision deadline passed before the provider answered.", { telemetry })
        : new DecisionProviderError("cancelled", "The Decision provider call was cancelled.", { telemetry });
}

function statusError(status: number): DecisionProviderError {
    const statusClass = httpStatusClass(status);
    const telemetry = statusClass ? { httpStatusClass: statusClass } : undefined;
    if (status === 401 || status === 403) {
        return new DecisionProviderError("forbidden", "The Decision provider refused the credential.", { telemetry });
    }
    if (status === 404 || status === 422) {
        return new DecisionProviderError("unavailable", "The Decision provider does not serve this model or route.", { telemetry });
    }
    if (status === 429) return new DecisionProviderError("unavailable", "The Decision provider is throttling requests.", { telemetry });
    if (status >= 500 && status <= 599) {
        return new DecisionProviderError("unavailable", "The Decision provider failed to answer.", { telemetry });
    }
    return new DecisionProviderError("execution_failed", "The Decision provider rejected the request.", { telemetry });
}

// ─── Response normalization ──────────────────────────────────────

async function readDecisionResponse(response: Response, signal: AbortSignal): Promise<string> {
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > DECISION_RESPONSE_MAX_BYTES) {
        void response.body?.cancel().catch(() => undefined);
        throw invalid(`the body exceeds the ${DECISION_RESPONSE_MAX_BYTES}-byte limit.`);
    }
    const body = response.body;
    if (!body) return "";

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > DECISION_RESPONSE_MAX_BYTES) {
                void reader.cancel().catch(() => undefined);
                throw invalid(`the body exceeds the ${DECISION_RESPONSE_MAX_BYTES}-byte limit.`);
            }
            chunks.push(value);
        }
    } catch (error) {
        if (error instanceof DecisionProviderError || signal.aborted) throw error;
        if (error instanceof TypeError) {
            throw new DecisionProviderError("unavailable", "The Decision provider response could not be read.");
        }
        throw new DecisionProviderError("execution_failed", "The Decision provider response could not be processed.");
    } finally {
        reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}

function invalid(detail: string): DecisionProviderError {
    return new DecisionProviderError("invalid_output", `The Decision provider returned an invalid answer: ${detail}`);
}

function parseDecisionResponse(question: DecisionQuestion, text: string): DecisionResponse {
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        throw invalid("the body is not JSON.");
    }
    return normalizeDecisionResponse(question, body);
}

/** Normalize one raw systemone body; live HTTP responses and test fixtures use this exact parser. */
export function normalizeDecisionResponse(question: DecisionQuestion, body: unknown): DecisionResponse {
    const usage = isRecord(body) ? normalizeUsage(body.usage) : null;
    try {
        if (!isRecord(body)) throw invalid("the body is not a JSON object.");
        const answers = body.answers;
        if (!isRecord(answers) || !hasExactKeys(answers, ["decision"])) throw invalid("answers must hold exactly the decision answer.");
        const answer = answers.decision;
        if (!isRecord(answer) || answer.type !== question.type) {
            throw invalid(`the decision answer must be an object of type ${question.type}.`);
        }
        return { answer: normalizeAnswer(question, answer), usage };
    } catch (error) {
        if (error instanceof DecisionProviderError && error.code === "invalid_output") {
            throw new DecisionProviderError(error.code, error.message, {
                ...(error.cause !== undefined ? { cause: error.cause } : {}),
                usage,
            });
        }
        throw error;
    }
}

function normalizeAnswer(question: DecisionQuestion, answer: Record<string, unknown>): DecisionAnswer {
    if (question.type === "choice") {
        const labels = Object.keys(question.criteria);
        const selection = answer.choice;
        if (typeof selection !== "string" || !Object.hasOwn(question.criteria, selection)) {
            throw invalid("choice must name a declared option.");
        }
        const values = exactProbabilities(answer.probabilities, labels);
        if (!values) throw invalid("choice probabilities must give each declared option, and no other, a probability from 0 to 1.");
        return {
            questionType: "choice",
            selection,
            probabilities: Object.fromEntries(labels.map((label, index): [string, number] => [label, values[index]])),
        };
    }
    if (question.type === "noul") {
        const probability = answer.noul;
        if (!isProbability(probability)) throw invalid("noul must be a probability from 0 to 1.");
        const values = exactProbabilities(answer.probabilities, ["true", "false"]);
        if (!values) throw invalid("noul probabilities must have exactly true and false, each from 0 to 1.");
        return { questionType: "noul", probability, probabilities: { yes: values[0], no: values[1] } };
    }
    const levels = question.criteria;
    const indexes = levels.map((_, index) => String(index));
    const last = levels.length - 1;
    const score = answer.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > last) {
        throw invalid(`score must be a number from 0 to ${last}.`);
    }
    const values = exactProbabilities(answer.probabilities, indexes);
    if (!values) throw invalid(`score probabilities must have exactly the level indexes 0 to ${last}, each from 0 to 1.`);
    if (!legendMatches(answer.legend, levels, indexes)) throw invalid("the score legend must name the declared levels in order.");
    return { questionType: "score", score, levels: levels.map((label, index) => ({ label, probability: values[index] })) };
}

/** The probabilities of exactly `keys`, in that order, each finite and from 0 to 1; null for any other shape. */
function exactProbabilities(value: unknown, keys: readonly string[]): number[] | null {
    if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
    const result: number[] = [];
    for (const key of keys) {
        const probability = value[key];
        if (!isProbability(probability)) return null;
        result.push(probability);
    }
    return result;
}

/** An optional legend: an array of the level labels, or an object of level index to label, matching the criteria. */
function legendMatches(legend: unknown, levels: readonly string[], indexes: readonly string[]): boolean {
    if (legend === undefined || legend === null) return true;
    if (Array.isArray(legend)) {
        const labels: unknown[] = legend;
        return labels.length === levels.length && levels.every((label, index) => labels[index] === label);
    }
    if (!isRecord(legend) || !hasExactKeys(legend, indexes)) return false;
    const named = legend;
    return levels.every((label, index) => named[indexes[index]] === label);
}

function normalizeUsage(usage: unknown): DecisionUsage | null {
    if (!isRecord(usage)) return null;
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    return isTokenCount(inputTokens) && isTokenCount(outputTokens) ? { inputTokens, outputTokens } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key));
}

function isProbability(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isTokenCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
