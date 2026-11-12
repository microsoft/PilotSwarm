import { metrics, type Meter } from "@opentelemetry/api";
import { performance } from "node:perf_hooks";
import type { TurnResult } from "./types.js";
import { otelBoolean } from "./telemetry-config.js";

type Result = "completed" | "error" | "cancelled" | "stopped" | "yielded";
type LifecycleResult = "completed" | "error" | "lossy_handoff" | "checkpoint_fallback" | "superseded" | "cancelled";
type Operation = "hydration" | "dehydration";
export type RuntimeMetricUsage = { tokensInput: number; tokensOutput: number; tokensCacheRead: number; tokensCacheWrite: number };

export function turnMetricResult(result: TurnResult | null, cancelled = false): Result {
    if (cancelled || result?.type === "cancelled") return "cancelled";
    if (!result || result.type === "error") return "error";
    if (result.type === "stopped") return "stopped";
    return result.type === "completed" ? "completed" : "yielded";
}

/** Telemetry is observational: a metric failure must never change runtime behaviour. */
function observe(record: () => void): void {
    try { record(); } catch {}
}

/** Internal metrics use only closed attribute sets. No caller-supplied labels. */
export function createRuntimeMetrics(
    meter: Meter = metrics.getMeter("pilotswarm-runtime"),
    env: NodeJS.ProcessEnv = process.env,
    now: () => number = () => performance.now(),
) {
    const turns = meter.createCounter("pilotswarm.turns");
    const tokens = meter.createCounter("pilotswarm.tokens");
    const tools = meter.createCounter("pilotswarm.tool.calls");
    const lifecycle = meter.createCounter("pilotswarm.lifecycle.operations");
    const histograms = otelBoolean(env, "PILOTSWARM_OTEL_HISTOGRAMS");
    const turnDuration = histograms ? meter.createHistogram("pilotswarm.turn.duration", { unit: "s" }) : null;
    const lifecycleDuration = histograms ? meter.createHistogram("pilotswarm.lifecycle.duration", { unit: "s" }) : null;
    const enabled = () => env.OTEL_SDK_DISABLED?.trim().toLowerCase() !== "true"
        && env.OTEL_METRICS_EXPORTER?.trim().toLowerCase() !== "none";
    return {
        startTurn() {
            let started = 0;
            observe(() => { started = now(); });
            let finished = false;
            return (result: TurnResult | null, usage: RuntimeMetricUsage, cancelled = false) => {
                if (finished) return;
                finished = true;
                observe(() => {
                    if (!enabled()) return;
                    const attributes = { result: turnMetricResult(result, cancelled) };
                    turns.add(1, attributes);
                    turnDuration?.record(Math.max(0, now() - started) / 1_000, attributes);
                    for (const [direction, count] of [
                        ["input", usage.tokensInput], ["output", usage.tokensOutput],
                        ["cache_read", usage.tokensCacheRead], ["cache_write", usage.tokensCacheWrite],
                    ] as const) {
                        if (Number.isFinite(count) && count > 0) tokens.add(count, { direction });
                    }
                });
            };
        },
        toolCall(result: "success" | "error") {
            observe(() => { if (enabled()) tools.add(1, { result }); });
        },
        startLifecycle(operation: Operation) {
            let started = 0;
            observe(() => { started = now(); });
            let finished = false;
            return (result: LifecycleResult) => {
                if (finished) return;
                finished = true;
                observe(() => {
                    if (!enabled()) return;
                    const attributes = { operation, result };
                    lifecycle.add(1, attributes);
                    lifecycleDuration?.record(Math.max(0, now() - started) / 1_000, attributes);
                });
            };
        },
    };
}

let instance: ReturnType<typeof createRuntimeMetrics> | undefined;
const noopRuntimeMetrics: ReturnType<typeof createRuntimeMetrics> = {
    startTurn: () => () => {},
    toolCall: () => {},
    startLifecycle: () => () => {},
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
