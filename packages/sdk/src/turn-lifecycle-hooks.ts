export type TurnLifecycleStatus = "completed" | "cancelled" | "failed";

export interface TurnLifecycleContext<Config = unknown> {
    sessionId: string;
    turnIndex?: number;
    config: Config;
    trace: (message: string) => void;
}

export interface AfterTurnContext<Config = unknown, Result = unknown>
    extends TurnLifecycleContext<Config> {
    status: TurnLifecycleStatus;
    result?: Result;
    error?: unknown;
}

export type BeforeTurnHook<Config = unknown> = (
    context: TurnLifecycleContext<Config>,
) => void | Promise<void>;

export type AfterTurnHook<Config = unknown, Result = unknown> = (
    context: AfterTurnContext<Config, Result>,
) => void | Promise<void>;

export interface TurnLifecycleProvider<Config = unknown, Result = unknown> {
    name?: string;
    beforeTurn?: BeforeTurnHook<Config>;
    afterTurn?: AfterTurnHook<Config, Result>;
}

export interface RunWithTurnLifecycleProvidersOptions<Config, Result> {
    providers?: readonly TurnLifecycleProvider<Config, Result>[];
    context: TurnLifecycleContext<Config>;
    run: () => Result | Promise<Result>;
    isCancelled?: (result: Result) => boolean;
    isFailed?: (result: Result) => boolean;
}

function hasCancelledTurnType(result: unknown): boolean {
    if (!result || typeof result !== "object") return false;
    const type = (result as { type?: unknown }).type;
    return type === "cancelled" || type === "stopped";
}

function hasFailedTurnType(result: unknown): boolean {
    return Boolean(
        result
        && typeof result === "object"
        && (result as { type?: unknown }).type === "error",
    );
}

/**
 * Run one turn attempt with process-local lifecycle providers.
 *
 * Providers enter in registration order and unwind in reverse order. If a
 * provider fails to enter, the turn does not run and previously entered
 * providers are unwound. Every entered provider receives a cleanup attempt,
 * even when another cleanup fails.
 *
 * Exactly-once applies to one activity invocation. Durable activity retries
 * are separate attempts and invoke the providers again.
 */
export async function runWithTurnLifecycleProviders<Config, Result>(
    options: RunWithTurnLifecycleProvidersOptions<Config, Result>,
): Promise<Result> {
    const {
        context,
        run,
        isCancelled = hasCancelledTurnType,
        isFailed = hasFailedTurnType,
    } = options;
    const providers = [...(options.providers ?? [])];
    if (providers.length === 0) return await run();

    const entered: TurnLifecycleProvider<Config, Result>[] = [];
    let result: Result | undefined;
    let primaryError: unknown;
    let primaryFailed = false;
    let status: TurnLifecycleStatus = "completed";
    try {
        for (const provider of providers) {
            await provider.beforeTurn?.(context);
            entered.push(provider);
        }
        result = await run();
        status = isCancelled(result)
            ? "cancelled"
            : isFailed(result)
                ? "failed"
                : "completed";
        return result;
    } catch (error) {
        primaryError = error;
        primaryFailed = true;
        status = "failed";
        throw error;
    } finally {
        const cleanupErrors: unknown[] = [];
        for (const provider of entered.reverse()) {
            try {
                await provider.afterTurn?.({
                    ...context,
                    status,
                    ...(primaryFailed
                        ? { error: primaryError }
                        : { result: result as Result }),
                });
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        if (cleanupErrors.length > 0) {
            if (!primaryFailed && cleanupErrors.length === 1) {
                throw cleanupErrors[0];
            }
            throw new AggregateError(
                [
                    ...(primaryFailed ? [primaryError] : []),
                    ...cleanupErrors,
                ],
                primaryFailed
                    ? "Turn and lifecycle cleanup failed"
                    : "Turn lifecycle cleanup failed",
            );
        }
    }
}
