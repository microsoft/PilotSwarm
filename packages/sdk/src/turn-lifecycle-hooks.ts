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

export interface SessionConfigurationOverrides {
    enableConfigDiscovery?: boolean;
    mcpServers?: Record<string, unknown>;
}

export type ConfigureSessionHook<Config = unknown> = (
    context: TurnLifecycleContext<Config>,
) =>
    | SessionConfigurationOverrides
    | undefined
    | Promise<SessionConfigurationOverrides | undefined>;

export type BeforeTurnHook<Config = unknown> = (
    context: TurnLifecycleContext<Config>,
) => void | Promise<void>;

export type AfterTurnHook<Config = unknown, Result = unknown> = (
    context: AfterTurnContext<Config, Result>,
) => void | Promise<void>;

export interface TurnLifecycleHooks<Config = unknown, Result = unknown> {
    beforeTurn?: BeforeTurnHook<Config>;
    afterTurn?: AfterTurnHook<Config, Result>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value)
        && typeof value === "object"
        && !Array.isArray(value);
}

export function validateSessionConfigurationOverrides(
    value: unknown,
): SessionConfigurationOverrides {
    if (value === undefined) return {};
    if (!isRecord(value)) {
        throw new TypeError(
            "configureSession must return an object or undefined.",
        );
    }
    const supportedKeys = new Set([
        "enableConfigDiscovery",
        "mcpServers",
    ]);
    for (const key of Object.keys(value)) {
        if (!supportedKeys.has(key)) {
            throw new TypeError(
                `configureSession returned unsupported field ${JSON.stringify(key)}.`,
            );
        }
    }
    if (
        value.enableConfigDiscovery !== undefined
        && typeof value.enableConfigDiscovery !== "boolean"
    ) {
        throw new TypeError(
            "configureSession.enableConfigDiscovery must be a boolean.",
        );
    }
    if (value.mcpServers !== undefined && !isRecord(value.mcpServers)) {
        throw new TypeError(
            "configureSession.mcpServers must be an object.",
        );
    }
    return {
        ...(value.enableConfigDiscovery === undefined
            ? {}
            : { enableConfigDiscovery: value.enableConfigDiscovery }),
        ...(value.mcpServers === undefined
            ? {}
            : { mcpServers: value.mcpServers }),
    };
}

export interface RunWithTurnLifecycleHooksOptions<Config, Result>
    extends TurnLifecycleHooks<Config, Result> {
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
 * Run one turn attempt with process-local lifecycle hooks.
 *
 * `beforeTurn` runs once before the body. If it fails, neither the body nor
 * `afterTurn` runs. After a successful pre-hook, `afterTurn` runs once from a
 * `finally` path for completion, cancellation, and turn failures.
 *
 * Exactly-once applies to one activity invocation. Durable activity retries
 * are separate attempts and invoke the hooks again.
 */
export async function runWithTurnLifecycleHooks<Config, Result>(
    options: RunWithTurnLifecycleHooksOptions<Config, Result>,
): Promise<Result> {
    const {
        beforeTurn,
        afterTurn,
        context,
        run,
        isCancelled = hasCancelledTurnType,
        isFailed = hasFailedTurnType,
    } = options;

    await beforeTurn?.(context);

    let result: Result | undefined;
    let turnError: unknown;
    let turnFailed = false;
    try {
        result = await run();
        return result;
    } catch (error) {
        turnError = error;
        turnFailed = true;
        throw error;
    } finally {
        if (afterTurn) {
            const status: TurnLifecycleStatus = turnFailed
                ? "failed"
                : isCancelled(result as Result)
                    ? "cancelled"
                    : isFailed(result as Result)
                        ? "failed"
                        : "completed";
            try {
                await afterTurn({
                    ...context,
                    status,
                    ...(turnFailed ? { error: turnError } : { result: result as Result }),
                });
            } catch (afterError) {
                if (turnFailed) {
                    throw new AggregateError(
                        [turnError, afterError],
                        "Turn and afterTurn hook both failed",
                    );
                }
                throw afterError;
            }
        }
    }
}
