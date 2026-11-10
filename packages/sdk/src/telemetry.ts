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

type TelemetryConfig = {
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

/** Every provider must finish before a failed shutdown can terminate the application. */
export function createTelemetryShutdown(
    providers: Array<{ shutdown(): Promise<void> | void }>,
    exportFailed: () => boolean = () => false,
): () => Promise<void> {
    let shutdownPromise: Promise<void> | undefined;
    return () => {
        shutdownPromise ??= Promise.allSettled(
            providers.map(provider => Promise.resolve().then(() => provider.shutdown())),
        ).then(results => {
            if (exportFailed() || results.some(result => result.status === "rejected")) {
                throw new Error("[otel] Telemetry shutdown failed.");
            }
        });
        return shutdownPromise;
    };
}

const config = telemetryConfig();
const providers: Array<{ shutdown(): Promise<void> | void }> = [];
let shuttingDown = false;
let shutdownExportFailed = false;
const shutdownProviders = createTelemetryShutdown(providers, () => shutdownExportFailed);

/**
 * Whether this process registered a metrics or trace provider.
 * Import this module with `node --import pilotswarm-sdk/telemetry` before the
 * SDK or application modules that acquire meters or tracers.
 */
export const telemetryEnabled = Boolean(config && (config.metrics === "otlp" || config.traces === "otlp"));

if (config && telemetryEnabled) {
    const { diag, DiagLogLevel, metrics, trace } = await import("@opentelemetry/api");
    const { metrics: sdkMetrics, tracing: sdkTracing } = await import("@opentelemetry/sdk-node");
    const { envDetector, resourceFromAttributes } = await import("@opentelemetry/resources");
    // Exporter diagnostics can contain URLs and headers. Never print their arguments.
    diag.setLogger({
        error: () => {
            if (shuttingDown) shutdownExportFailed = true;
            console.error("[otel] Telemetry export failed.");
        },
        warn: () => console.warn("[otel] Telemetry warning."),
        info() {}, debug() {}, verbose() {},
    }, DiagLogLevel.WARN);
    const attributes = envDetector.detect().attributes;
    const resource = resourceFromAttributes({
        "service.name": "pilotswarm-worker",
        ...(process.env.POD_NAME ? { "service.instance.id": process.env.POD_NAME } : {}),
        ...attributes,
    });

    if (config.metrics === "otlp") {
        const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
        const provider = new sdkMetrics.MeterProvider({
            resource,
            readers: [new sdkMetrics.PeriodicExportingMetricReader({
                exporter: new OTLPMetricExporter({
                    url: `${config.endpoint}/v1/metrics`,
                    headers: config.headers,
                    timeoutMillis: config.timeout,
                }),
                exportIntervalMillis: config.interval,
                exportTimeoutMillis: config.metricTimeout,
            })],
        });
        if (!metrics.setGlobalMeterProvider(provider)) throw new Error("[otel] Meter provider already registered.");
        providers.push(provider);
    }
    if (config.traces === "otlp") {
        const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
        const provider = new sdkTracing.BasicTracerProvider({
            resource,
            spanProcessors: [new sdkTracing.BatchSpanProcessor(new OTLPTraceExporter({
                url: `${config.endpoint}/v1/traces`,
                headers: config.headers,
                timeoutMillis: config.timeout,
            }), { exportTimeoutMillis: config.timeout })],
        });
        if (!trace.setGlobalTracerProvider(provider)) throw new Error("[otel] Tracer provider already registered.");
        providers.push(provider);
    }
    console.info("[otel] Worker telemetry enabled.");
    process.once("beforeExit", () => {
        void shutdownTelemetry().catch(() => {
            console.error("[otel] Telemetry shutdown failed.");
            process.exitCode = 1;
        });
    });
}

/** Call after an application drains its worker, before terminating the process. */
export function shutdownTelemetry(): Promise<void> {
    shuttingDown = true;
    // The periodic reader reports export failures through diagnostics, not rejection.
    return shutdownProviders();
}
