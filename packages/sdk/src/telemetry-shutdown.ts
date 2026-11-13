/** Every provider must finish before a telemetry failure is reported and ignored. */
export function createTelemetryShutdown(
    providers: Array<{ shutdown(): Promise<void> | void }>,
    exportFailed: () => boolean = () => false,
    report: () => void = () => console.warn("[otel] Telemetry shutdown failed."),
): () => Promise<void> {
    let shutdownPromise: Promise<void> | undefined;
    return () => {
        shutdownPromise ??= Promise.allSettled(
            providers.map(provider => Promise.resolve().then(() => provider.shutdown())),
        ).then(results => {
            if (exportFailed() || results.some(result => result.status === "rejected")) {
                report();
            }
        });
        return shutdownPromise;
    };
}
