import { validateHeaderName, validateHeaderValue } from "node:http";

function configError(key: string): Error {
    return new Error(`[otel] Invalid ${key} configuration.`);
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
    const raw = env[key] ?? String(fallback);
    if (!/^[1-9]\d*$/.test(raw)) throw configError(key);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > 2_147_483_647) throw configError(key);
    return value;
}

function signal(env: NodeJS.ProcessEnv, key: string, fallback: "otlp" | "none"): "otlp" | "none" {
    const value = env[key] ?? fallback;
    if (value !== "otlp" && value !== "none") throw configError(key);
    return value;
}

export type TelemetryConfig = {
    endpoint: string;
    headers: Record<string, string>;
    metrics: "otlp" | "none";
    traces: "otlp" | "none";
    interval: number;
    timeout: number;
    metricTimeout: number;
};

/** Read the opt-in OTLP configuration without exposing values in errors. */
export function telemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig | null {
    if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true" || !env.OTEL_EXPORTER_OTLP_ENDPOINT) {
        return null;
    }
    let endpoint: URL;
    try {
        endpoint = new URL(env.OTEL_EXPORTER_OTLP_ENDPOINT);
    } catch {
        throw configError("OTEL_EXPORTER_OTLP_ENDPOINT");
    }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password
        || endpoint.search || endpoint.hash) throw configError("OTEL_EXPORTER_OTLP_ENDPOINT");

    const metrics = signal(env, "OTEL_METRICS_EXPORTER", "otlp");
    const traces = signal(env, "OTEL_TRACES_EXPORTER", "none");
    if (env.OTEL_LOGS_EXPORTER && env.OTEL_LOGS_EXPORTER !== "none") throw configError("OTEL_LOGS_EXPORTER");
    if (env.PILOTSWARM_OTEL_HISTOGRAMS && !["true", "false"].includes(env.PILOTSWARM_OTEL_HISTOGRAMS)) {
        throw configError("PILOTSWARM_OTEL_HISTOGRAMS");
    }
    const interval = positiveInteger(env, "OTEL_METRIC_EXPORT_INTERVAL", 30_000);
    const timeout = positiveInteger(env, "OTEL_EXPORTER_OTLP_TIMEOUT", 5_000);
    const metricTimeout = positiveInteger(env, "OTEL_METRIC_EXPORT_TIMEOUT", 5_000);
    if (metrics === "otlp" && metricTimeout > interval) throw configError("OTEL_METRIC_EXPORT_TIMEOUT");
    const headers: Record<string, string> = {};
    for (const entry of (env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",").filter(value => value.trim())) {
        const equal = entry.indexOf("=");
        if (equal < 1) throw configError("OTEL_EXPORTER_OTLP_HEADERS");
        try {
            const name = entry.slice(0, equal).trim();
            const value = decodeURIComponent(entry.slice(equal + 1).trim());
            validateHeaderName(name);
            validateHeaderValue(name, value);
            headers[name] = value;
        } catch {
            throw configError("OTEL_EXPORTER_OTLP_HEADERS");
        }
    }
    return { endpoint: endpoint.href.replace(/\/+$/, ""), headers, metrics, traces, interval, timeout, metricTimeout };
}
