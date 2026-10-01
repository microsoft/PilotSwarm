import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
    AfterRunTurnHook,
    BeforeRunTurnHook,
    SerializableSessionConfig,
    TurnResult,
} from "./types.js";
import type {
    AfterTurnHook,
    BeforeTurnHook,
    ConfigureSessionHook,
    TurnLifecycleHooks,
} from "./turn-lifecycle-hooks.js";

export const TURN_LIFECYCLE_HOOK_MODULE_ENV =
    "PILOTSWARM_TURN_LIFECYCLE_HOOK_MODULE";

type WorkerTurnLifecycleHooks = TurnLifecycleHooks<
    SerializableSessionConfig,
    TurnResult
> & {
    configureSession?: ConfigureSessionHook<SerializableSessionConfig>;
    beforeRunTurn?: BeforeRunTurnHook;
    afterRunTurn?: AfterRunTurnHook;
};

interface HookModuleExports {
    beforeTurn?: unknown;
    afterTurn?: unknown;
    configureSession?: unknown;
    beforeRunTurn?: unknown;
    afterRunTurn?: unknown;
}

export interface LoadTurnLifecycleHookModuleOptions {
    cwd?: string;
    importModule?: (specifier: string) => Promise<HookModuleExports>;
}

function resolveModuleSpecifier(value: string, cwd: string): string {
    if (value.startsWith("file:")) return value;
    if (path.isAbsolute(value) || value.startsWith(".")) {
        return pathToFileURL(path.resolve(cwd, value)).href;
    }
    return value;
}

function optionalHook<T>(
    moduleName: string,
    exportName: string,
    value: unknown,
): T | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "function") {
        throw new TypeError(
            `Turn lifecycle hook module ${JSON.stringify(moduleName)} export `
            + `${exportName} must be a function.`,
        );
    }
    return value as T;
}

/**
 * Load process-local turn hooks for the standard worker entrypoint.
 *
 * The module may export process-local `beforeTurn` / `afterTurn` hooks,
 * provider-neutral `configureSession`, and/or specialized preparation hooks.
 * Relative file paths resolve from the worker process cwd; absolute paths,
 * file URLs, and package specifiers are also supported.
 */
export async function loadTurnLifecycleHooksFromEnv(
    env: NodeJS.ProcessEnv = process.env,
    options: LoadTurnLifecycleHookModuleOptions = {},
): Promise<WorkerTurnLifecycleHooks | undefined> {
    const moduleName = env[TURN_LIFECYCLE_HOOK_MODULE_ENV]?.trim();
    if (!moduleName) return undefined;

    const specifier = resolveModuleSpecifier(
        moduleName,
        options.cwd ?? process.cwd(),
    );
    const importModule = options.importModule
        ?? ((value: string) => import(value) as Promise<HookModuleExports>);

    let loaded: HookModuleExports;
    try {
        loaded = await importModule(specifier);
    } catch (error) {
        throw new Error(
            `Failed to load turn lifecycle hook module ${JSON.stringify(moduleName)}.`,
            { cause: error },
        );
    }

    const beforeTurn = optionalHook<
        BeforeTurnHook<SerializableSessionConfig>
    >(moduleName, "beforeTurn", loaded.beforeTurn);
    const afterTurn = optionalHook<
        AfterTurnHook<SerializableSessionConfig, TurnResult>
    >(moduleName, "afterTurn", loaded.afterTurn);
    const configureSession = optionalHook<
        ConfigureSessionHook<SerializableSessionConfig>
    >(moduleName, "configureSession", loaded.configureSession);
    const beforeRunTurn = optionalHook<BeforeRunTurnHook>(
        moduleName,
        "beforeRunTurn",
        loaded.beforeRunTurn,
    );
    const afterRunTurn = optionalHook<AfterRunTurnHook>(
        moduleName,
        "afterRunTurn",
        loaded.afterRunTurn,
    );
    if (
        !beforeTurn
        && !afterTurn
        && !configureSession
        && !beforeRunTurn
        && !afterRunTurn
    ) {
        throw new TypeError(
            `Turn lifecycle hook module ${JSON.stringify(moduleName)} must `
            + "export beforeTurn, afterTurn, configureSession, beforeRunTurn, "
            + "or afterRunTurn.",
        );
    }
    return {
        beforeTurn,
        afterTurn,
        configureSession,
        beforeRunTurn,
        afterRunTurn,
    };
}
