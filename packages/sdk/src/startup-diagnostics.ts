export interface StartupStageOptions {
    prefix: string;
    category?: string;
    heartbeatMs?: number;
    log?: (message: string) => void;
    logError?: (message: string, error: unknown) => void;
}

function stageMessage(options: StartupStageOptions, name: string, detail: string): string {
    return `${options.prefix} ${options.category ?? "startup stage"} "${name}" ${detail}`;
}

export async function runStartupStage<T>(
    name: string,
    operation: () => Promise<T>,
    options: StartupStageOptions,
): Promise<T> {
    const startedAt = Date.now();
    const log = options.log ?? console.log;
    const logError = options.logError ?? console.error;
    const heartbeatMs = options.heartbeatMs ?? 30_000;
    log(stageMessage(options, name, "started"));
    const heartbeat = heartbeatMs > 0
        ? setInterval(() => {
            log(stageMessage(
                options,
                name,
                `still running after ${Date.now() - startedAt}ms`,
            ));
        }, heartbeatMs)
        : undefined;
    heartbeat?.unref();
    try {
        const result = await operation();
        log(stageMessage(
            options,
            name,
            `completed in ${Date.now() - startedAt}ms`,
        ));
        return result;
    } catch (error) {
        logError(stageMessage(
            options,
            name,
            `failed after ${Date.now() - startedAt}ms`,
        ), error);
        throw error;
    } finally {
        if (heartbeat) clearInterval(heartbeat);
    }
}

export function runStartupStageSync<T>(
    name: string,
    operation: () => T,
    options: Omit<StartupStageOptions, "heartbeatMs">,
): T {
    const startedAt = Date.now();
    const log = options.log ?? console.log;
    const logError = options.logError ?? console.error;
    log(stageMessage(options, name, "started"));
    try {
        const result = operation();
        log(stageMessage(
            options,
            name,
            `completed in ${Date.now() - startedAt}ms`,
        ));
        return result;
    } catch (error) {
        logError(stageMessage(
            options,
            name,
            `failed after ${Date.now() - startedAt}ms`,
        ), error);
        throw error;
    }
}
