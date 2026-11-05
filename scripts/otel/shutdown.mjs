/** Every provider must finish before a failed shutdown can terminate the worker. */
export function createTelemetryShutdown(providers, exportFailed = () => false) {
    let shutdownPromise;
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
