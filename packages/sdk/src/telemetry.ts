import { telemetryConfig } from "./telemetry-config.js";
import { createTelemetryShutdown } from "./telemetry-shutdown.js";

const config = telemetryConfig();
// Third-party SDKs loaded after this preload can honor the shared endpoint
// independently. Do not let malformed PilotSwarm configuration send data
// through an unintended exporter.
if (!config && process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
}
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
    const { MeterProvider, PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
    const { BasicTracerProvider, BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
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
        const provider = new MeterProvider({
            resource,
            readers: [new PeriodicExportingMetricReader({
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
        const provider = new BasicTracerProvider({
            resource,
            spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({
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
        void shutdownTelemetry();
    });
}

/** Call after an application drains its worker, before terminating the process. */
export function shutdownTelemetry(): Promise<void> {
    shuttingDown = true;
    // The periodic reader reports export failures through diagnostics, not rejection.
    return shutdownProviders();
}
