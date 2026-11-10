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
