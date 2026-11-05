import { metrics, type Meter } from "@opentelemetry/api";
import { performance } from "node:perf_hooks";
import type { TurnResult } from "./types.js";

type Result = "completed" | "error" | "cancelled" | "stopped" | "yielded";
type LifecycleResult = "completed" | "error" | "lossy_handoff" | "checkpoint_fallback" | "superseded" | "cancelled";
type Operation = "hydration" | "dehydration";
type Usage = { tokensInput: number; tokensOutput: number; tokensCacheRead: number; tokensCacheWrite: number };

export function turnMetricResult(result: TurnResult | null, cancelled = false): Result {
    if (cancelled || result?.type === "cancelled") return "cancelled";
    if (!result || result.type === "error") return "error";
    if (result.type === "stopped") return "stopped";
    return result.type === "completed" ? "completed" : "yielded";
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
    const histograms = env.PILOTSWARM_OTEL_HISTOGRAMS === "true";
    const turnDuration = histograms ? meter.createHistogram("pilotswarm.turn.duration", { unit: "s" }) : null;
    const lifecycleDuration = histograms ? meter.createHistogram("pilotswarm.lifecycle.duration", { unit: "s" }) : null;
    const enabled = () => env.OTEL_SDK_DISABLED?.trim().toLowerCase() !== "true" && env.OTEL_METRICS_EXPORTER !== "none";
    return {
        startTurn() {
            const started = now();
            let finished = false;
            return (result: TurnResult | null, usage: Usage, cancelled = false) => {
                if (finished) return;
                finished = true;
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
            };
        },
        toolCall(result: "success" | "error") {
            if (enabled()) tools.add(1, { result });
        },
        startLifecycle(operation: Operation) {
            const started = now();
            let finished = false;
            return (result: LifecycleResult) => {
                if (finished) return;
                finished = true;
                if (!enabled()) return;
                const attributes = { operation, result };
                lifecycle.add(1, attributes);
                lifecycleDuration?.record(Math.max(0, now() - started) / 1_000, attributes);
            };
        },
    };
}

let instance: ReturnType<typeof createRuntimeMetrics> | undefined;
export function runtimeMetrics() {
    return instance ??= createRuntimeMetrics();
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
