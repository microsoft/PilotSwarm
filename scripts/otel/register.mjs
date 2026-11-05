import { telemetryConfig } from "./config.mjs";

const config = telemetryConfig();
const providers = [];
let shutdownPromise;
let shuttingDown = false;
let shutdownExportFailed = false;

export const telemetryEnabled = Boolean(config && (config.metrics === "otlp" || config.traces === "otlp"));

if (telemetryEnabled) {
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

/** Call after draining the worker, before process.exit. Repeated calls share the same flush. */
export function shutdownTelemetry() {
    shuttingDown = true;
    shutdownPromise ??= Promise.all(providers.map(provider => provider.shutdown())).then(
        () => {
            // The periodic reader reports export failures through diagnostics, not rejection.
            if (shutdownExportFailed) throw new Error("[otel] Telemetry shutdown failed.");
        },
        () => { throw new Error("[otel] Telemetry shutdown failed."); },
    );
    return shutdownPromise;
}
