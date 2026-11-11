import { validateHeaderName, validateHeaderValue } from "node:http";

const DEFAULT_INTERVAL = 30_000;
const DEFAULT_TIMEOUT = 5_000;
const MAX_TIMEOUT = 2_147_483_647;

function warn(key: string, reason: string): void {
    console.warn(`[otel] ${key}: ${reason}.`);
}

const unsupportedSignalSpecificSettings = [
    "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE",
    "OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE",
    "OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE",
    "OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE",
    "OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY",
    "OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY",
] as const;

function hasUnsupportedSignalSpecificSettings(env: NodeJS.ProcessEnv): boolean {
    let found = false;
    for (const key of unsupportedSignalSpecificSettings) {
        if (env[key]?.trim()) {
            warn(key, "unsupported signal-specific configuration disables telemetry");
            found = true;
        }
    }
    return found;
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    if (!/^[1-9]\d*$/.test(raw)) {
        warn(key, "invalid numeric value uses the default");
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > MAX_TIMEOUT) {
        warn(key, "out-of-range numeric value uses the default");
        return fallback;
    }
    return value;
}

function signal(env: NodeJS.ProcessEnv, key: string, fallback: "otlp" | "none"): "otlp" | "none" {
    const value = env[key]?.trim().toLowerCase();
    if (!value) return fallback;
    if (value !== "otlp" && value !== "none") {
        warn(key, "unrecognized value uses the default");
        return fallback;
    }
    return value;
}

/** OpenTelemetry booleans enable only a case-insensitive `true`. */
export function otelBoolean(env: NodeJS.ProcessEnv, key: string, fallback = false): boolean {
    const value = env[key]?.trim().toLowerCase();
    if (!value) return fallback;
    if (value === "true") return true;
    if (value === "false") return false;
    warn(key, "invalid boolean value uses false");
    return false;
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
    const endpointValue = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
    if (!endpointValue) return null;
    if (otelBoolean(env, "OTEL_SDK_DISABLED")) {
        return null;
    }
    if (hasUnsupportedSignalSpecificSettings(env)) return null;
    let endpoint: URL;
    try {
        endpoint = new URL(endpointValue);
    } catch {
        warn("OTEL_EXPORTER_OTLP_ENDPOINT", "invalid endpoint disables telemetry");
        return null;
    }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password
        || endpoint.search || endpoint.hash) {
        warn("OTEL_EXPORTER_OTLP_ENDPOINT", "unsafe endpoint disables telemetry");
        return null;
    }

    const metrics = signal(env, "OTEL_METRICS_EXPORTER", "otlp");
    const traces = signal(env, "OTEL_TRACES_EXPORTER", "none");
    const logs = env.OTEL_LOGS_EXPORTER?.trim();
    if (logs && logs.toLowerCase() !== "none") {
        warn("OTEL_LOGS_EXPORTER", "unsupported logs exporter is ignored");
    }
    const interval = positiveInteger(env, "OTEL_METRIC_EXPORT_INTERVAL", DEFAULT_INTERVAL);
    const timeout = positiveInteger(env, "OTEL_EXPORTER_OTLP_TIMEOUT", DEFAULT_TIMEOUT);
    let metricTimeout = positiveInteger(env, "OTEL_METRIC_EXPORT_TIMEOUT", DEFAULT_TIMEOUT);
    if (metrics === "otlp" && metricTimeout > interval) {
        warn("OTEL_METRIC_EXPORT_TIMEOUT", "value exceeds the metric interval and is clamped");
        metricTimeout = interval;
    }
    const headers: Record<string, string> = {};
    for (const entry of (env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",").filter(value => value.trim())) {
        const equal = entry.indexOf("=");
        if (equal < 1) {
            warn("OTEL_EXPORTER_OTLP_HEADERS", "malformed headers disable telemetry");
            return null;
        }
        try {
            const name = entry.slice(0, equal).trim();
            const value = decodeURIComponent(entry.slice(equal + 1).trim());
            validateHeaderName(name);
            validateHeaderValue(name, value);
            headers[name] = value;
        } catch {
            warn("OTEL_EXPORTER_OTLP_HEADERS", "malformed headers disable telemetry");
            return null;
        }
    }
    return { endpoint: endpoint.href.replace(/\/+$/, ""), headers, metrics, traces, interval, timeout, metricTimeout };
}
