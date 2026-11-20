import { metrics, SpanKind, SpanStatusCode, trace as otelTrace, type Meter, type Span, type Tracer } from "@opentelemetry/api";
import { performance } from "node:perf_hooks";
import type { TurnResult } from "./types.js";
import { otelBoolean } from "./telemetry-config.js";

type Result = "completed" | "error" | "cancelled" | "stopped" | "yielded";
type LifecycleResult = "completed" | "error" | "lossy_handoff" | "checkpoint_fallback" | "superseded" | "cancelled";
type Operation = "hydration" | "dehydration";
export type RuntimeMetricUsage = { tokensInput: number; tokensOutput: number; tokensCacheRead: number; tokensCacheWrite: number };
export type InferenceMetricUsage = { inputTokens: number; outputTokens: number };
export type InferenceHttpStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx";
export type InferenceErrorCode = "invalid_input" | "invalid_output" | "timed_out" | "cancelled" | "forbidden" | "unavailable" | "execution_failed";
export type InferenceCallContext = {
    provider: string;
    model: string;
    operationId: string;
    attempt: number;
    purpose: string;
    workflowRunId: string;
    nodeExecutionId: string;
};
export type InferenceCallObservation = {
    result: "success" | "error";
    errorCode?: InferenceErrorCode;
    httpStatusClass?: InferenceHttpStatusClass;
    usage?: InferenceMetricUsage | null;
};

const INFERENCE_ERROR_CODES = new Set<InferenceErrorCode>([
    "invalid_input", "invalid_output", "timed_out", "cancelled", "forbidden", "unavailable", "execution_failed",
]);
const HTTP_STATUS_CLASSES = new Set<InferenceHttpStatusClass>(["1xx", "2xx", "3xx", "4xx", "5xx"]);

export function turnMetricResult(result: TurnResult | null, cancelled = false): Result {
    if (cancelled || result?.type === "cancelled") return "cancelled";
    if (!result || result.type === "error") return "error";
    if (result.type === "stopped") return "stopped";
    return result.type === "completed" ? "completed" : "yielded";
}

/** Telemetry is observational: a metric or trace failure must never change runtime behaviour. */
function observe(record: () => void): void {
    try { record(); } catch {}
}

function safeText(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function safeInferenceErrorCode(value: unknown): InferenceErrorCode | null {
    return typeof value === "string" && INFERENCE_ERROR_CODES.has(value as InferenceErrorCode)
        ? value as InferenceErrorCode : null;
}

function safeHttpStatusClass(value: unknown): InferenceHttpStatusClass | null {
    return typeof value === "string" && HTTP_STATUS_CLASSES.has(value as InferenceHttpStatusClass)
        ? value as InferenceHttpStatusClass : null;
}

function recordUsage(
    counter: ReturnType<Meter["createCounter"]> | null,
    usage: InferenceMetricUsage | null | undefined,
): void {
    if (!counter || !usage) return;
    for (const [direction, count] of [["input", usage.inputTokens], ["output", usage.outputTokens]] as const) {
        if (Number.isSafeInteger(count) && count > 0) {
            observe(() => counter.add(count, { direction }));
        }
    }
}

function setSpanAttribute(span: Span, key: string, value: unknown): void {
    if (typeof value === "string" && value.length > 0 || typeof value === "number" && Number.isFinite(value)) {
        observe(() => span.setAttribute(key, value as string | number));
    }
}

/** Internal metrics use only closed attribute sets. No caller-supplied labels. */
export function createRuntimeMetrics(
    meter?: Meter,
    env: NodeJS.ProcessEnv = process.env,
    now: () => number = () => performance.now(),
    tracer?: Tracer,
) {
    let resolvedMeter: Meter | undefined = meter;
    if (!resolvedMeter) {
        observe(() => { resolvedMeter = metrics.getMeter("pilotswarm-runtime"); });
    }
    const counter = (name: string): ReturnType<Meter["createCounter"]> | null => {
        let instrument: ReturnType<Meter["createCounter"]> | undefined;
        observe(() => { instrument = resolvedMeter?.createCounter(name); });
        return instrument ?? null;
    };
    const histogram = (name: string): ReturnType<Meter["createHistogram"]> | null => {
        let instrument: ReturnType<Meter["createHistogram"]> | undefined;
        observe(() => { instrument = resolvedMeter?.createHistogram(name, { unit: "s" }); });
        return instrument ?? null;
    };
    const turns = counter("pilotswarm.turns");
    const tokens = counter("pilotswarm.tokens");
    const tools = counter("pilotswarm.tool.calls");
    const lifecycle = counter("pilotswarm.lifecycle.operations");
    const inferenceCalls = counter("pilotswarm.inference.calls");
    const histograms = otelBoolean(env, "PILOTSWARM_OTEL_HISTOGRAMS");
    const turnDuration = histograms ? histogram("pilotswarm.turn.duration") : null;
    const lifecycleDuration = histograms ? histogram("pilotswarm.lifecycle.duration") : null;
    const inferenceDuration = histograms ? histogram("pilotswarm.inference.duration") : null;
    const metricsEnabled = () => env.OTEL_SDK_DISABLED?.trim().toLowerCase() !== "true"
        && env.OTEL_METRICS_EXPORTER?.trim().toLowerCase() !== "none";
    const tracesEnabled = () => env.OTEL_SDK_DISABLED?.trim().toLowerCase() !== "true"
        && env.OTEL_TRACES_EXPORTER?.trim().toLowerCase() === "otlp";
    const inferenceTracer = (): Tracer | null => {
        if (!tracesEnabled()) return null;
        if (tracer) return tracer;
        let resolved: Tracer | undefined;
        observe(() => { resolved = otelTrace.getTracer("pilotswarm-inference"); });
        return resolved ?? null;
    };
    return {
        startTurn() {
            let started = 0;
            observe(() => { started = now(); });
            let finished = false;
            return (result: TurnResult | null, usage: RuntimeMetricUsage, cancelled = false) => {
                if (finished) return;
                finished = true;
                observe(() => {
                    if (!metricsEnabled() || !turns) return;
                    const attributes = { result: turnMetricResult(result, cancelled) };
                    turns.add(1, attributes);
                    turnDuration?.record(Math.max(0, now() - started) / 1_000, attributes);
                    for (const [direction, count] of [
                        ["input", usage.tokensInput], ["output", usage.tokensOutput],
                        ["cache_read", usage.tokensCacheRead], ["cache_write", usage.tokensCacheWrite],
                    ] as const) {
                        if (Number.isFinite(count) && count > 0) tokens?.add(count, { direction });
                    }
                });
            };
        },
        toolCall(result: "success" | "error") {
            observe(() => { if (metricsEnabled()) tools?.add(1, { result }); });
        },
        startLifecycle(operation: Operation) {
            let started = 0;
            observe(() => { started = now(); });
            let finished = false;
            return (result: LifecycleResult) => {
                if (finished) return;
                finished = true;
                observe(() => {
                    if (!metricsEnabled() || !lifecycle) return;
                    const attributes = { operation, result };
                    lifecycle.add(1, attributes);
                    lifecycleDuration?.record(Math.max(0, now() - started) / 1_000, attributes);
                });
            };
        },
        startInferenceCall(context: InferenceCallContext) {
            const capability = "decision";
            const provider = safeText(context.provider);
            const model = safeText(context.model);
            const operationId = safeText(context.operationId);
            const purpose = safeText(context.purpose);
            const workflowRunId = safeText(context.workflowRunId);
            const nodeExecutionId = safeText(context.nodeExecutionId);
            let started: number | null = null;
            observe(() => { started = now(); });
            let span: Span | null = null;
            observe(() => {
                span = inferenceTracer()?.startSpan("pilotswarm.inference.call", {
                    kind: SpanKind.CLIENT,
                    attributes: {
                        "pilotswarm.inference.capability": capability,
                        ...(provider ? { "pilotswarm.inference.provider": provider } : {}),
                        ...(model ? { "pilotswarm.inference.model": model } : {}),
                        ...(operationId ? { "pilotswarm.inference.operation_id": operationId } : {}),
                        ...(Number.isSafeInteger(context.attempt) && context.attempt > 0
                            ? { "pilotswarm.inference.attempt": context.attempt } : {}),
                        ...(purpose ? { "pilotswarm.inference.purpose": purpose } : {}),
                        ...(workflowRunId ? { "pilotswarm.workflow_run_id": workflowRunId } : {}),
                        ...(nodeExecutionId ? { "pilotswarm.node_execution_id": nodeExecutionId } : {}),
                    },
                }) ?? null;
            });
            let finished = false;
            return (observation: InferenceCallObservation) => {
                if (finished) return;
                finished = true;
                const result = observation.result === "success" ? "success" : "error";
                const errorCode = result === "error" ? safeInferenceErrorCode(observation.errorCode) : null;
                const httpStatusClass = safeHttpStatusClass(observation.httpStatusClass);
                observe(() => {
                    if (metricsEnabled()) {
                        inferenceCalls?.add(1, { capability, result });
                        recordUsage(tokens, observation.usage);
                    }
                });
                let latencyMs: number | null = null;
                observe(() => {
                    if (started !== null) latencyMs = Math.max(0, now() - started);
                });
                observe(() => {
                    if (metricsEnabled() && latencyMs !== null) inferenceDuration?.record(latencyMs / 1_000, { capability, result });
                });
                if (span) {
                    observe(() => {
                        setSpanAttribute(span!, "pilotswarm.inference.result", result);
                        if (errorCode) setSpanAttribute(span!, "error.type", errorCode);
                        if (httpStatusClass) setSpanAttribute(span!, "http.response.status_class", httpStatusClass);
                        if (latencyMs !== null) setSpanAttribute(span!, "pilotswarm.inference.latency_ms", latencyMs);
                        if (Number.isSafeInteger(observation.usage?.inputTokens) && observation.usage!.inputTokens >= 0) {
                            setSpanAttribute(span!, "pilotswarm.inference.tokens_input", observation.usage!.inputTokens);
                        }
                        if (Number.isSafeInteger(observation.usage?.outputTokens) && observation.usage!.outputTokens >= 0) {
                            setSpanAttribute(span!, "pilotswarm.inference.tokens_output", observation.usage!.outputTokens);
                        }
                        span!.setStatus({ code: result === "success" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
                    });
                    observe(() => span!.end());
                }
            };
        },
    };
}

let instance: ReturnType<typeof createRuntimeMetrics> | undefined;
const noopRuntimeMetrics: ReturnType<typeof createRuntimeMetrics> = {
    startTurn: () => () => {},
    toolCall: () => {},
    startLifecycle: () => () => {},
    startInferenceCall: () => () => {},
};

export function runtimeMetrics(): ReturnType<typeof createRuntimeMetrics> {
    if (!instance) {
        try {
            instance = createRuntimeMetrics();
        } catch {
            instance = noopRuntimeMetrics;
        }
    }
    return instance;
}

export async function measureLifecycle<T>(
    operation: Operation,
    run: () => Promise<T>,
    classify: (value: T) => LifecycleResult = () => "completed",
): Promise<T> {
    const finish = runtimeMetrics().startLifecycle(operation);
    let result: LifecycleResult = "error";
    try {
        const value = await run();
        result = classify(value);
        return value;
    } finally {
        finish(result);
    }
}
