import path from "node:path";
import { pathToFileURL } from "node:url";

import type { PilotSwarmWorkerOptions } from "./types.js";

export const WORKER_STARTUP_MODULE_ENV =
    "PILOTSWARM_WORKER_STARTUP_MODULE";

type StartupWorkerOptions = Pick<
    PilotSwarmWorkerOptions,
    "mcpServers" | "mcpServerHeadersProvider"
>;

export interface WorkerStartupContext {
    env: NodeJS.ProcessEnv;
    pluginDirs: readonly string[];
    trace: (message: string) => void;
}

export interface WorkerStartupResult {
    additionalPluginDirs?: string[];
    workerOptions?: StartupWorkerOptions;
    shutdown?: () => void | Promise<void>;
}

interface WorkerStartupModuleExports {
    initialize?: unknown;
}

export interface LoadWorkerStartupModuleOptions {
    cwd?: string;
    importModule?: (
        specifier: string,
    ) => Promise<WorkerStartupModuleExports>;
}

function resolveModuleSpecifier(value: string, cwd: string): string {
    if (value.startsWith("file:")) return value;
    if (path.isAbsolute(value) || value.startsWith(".")) {
        return pathToFileURL(path.resolve(cwd, value)).href;
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value)
        && typeof value === "object"
        && !Array.isArray(value);
}

function validateResult(
    moduleName: string,
    value: unknown,
): WorkerStartupResult {
    if (value === undefined) return {};
    if (!isRecord(value)) {
        throw new TypeError(
            `Worker startup module ${JSON.stringify(moduleName)} initialize `
            + "must return an object or undefined.",
        );
    }

    const supportedResultKeys = new Set([
        "additionalPluginDirs",
        "workerOptions",
        "shutdown",
    ]);
    for (const key of Object.keys(value)) {
        if (!supportedResultKeys.has(key)) {
            throw new TypeError(
                `Worker startup module ${JSON.stringify(moduleName)} returned `
                + `unsupported field ${JSON.stringify(key)}.`,
            );
        }
    }

    let additionalPluginDirs: string[] | undefined;
    if (value.additionalPluginDirs !== undefined) {
        if (
            !Array.isArray(value.additionalPluginDirs)
            || value.additionalPluginDirs.some(
                (entry) => typeof entry !== "string" || !entry.trim(),
            )
        ) {
            throw new TypeError(
                `Worker startup module ${JSON.stringify(moduleName)} `
                + "additionalPluginDirs must be an array of non-empty strings.",
            );
        }
        additionalPluginDirs = [
            ...new Set(value.additionalPluginDirs.map((entry) => entry.trim())),
        ];
    }

    let workerOptions: StartupWorkerOptions | undefined;
    if (value.workerOptions !== undefined) {
        if (!isRecord(value.workerOptions)) {
            throw new TypeError(
                `Worker startup module ${JSON.stringify(moduleName)} `
                + "workerOptions must be an object.",
            );
        }
        const supportedOptionKeys = new Set([
            "mcpServers",
            "mcpServerHeadersProvider",
        ]);
        for (const key of Object.keys(value.workerOptions)) {
            if (!supportedOptionKeys.has(key)) {
                throw new TypeError(
                    `Worker startup module ${JSON.stringify(moduleName)} `
                    + `cannot override worker option ${JSON.stringify(key)}.`,
                );
            }
        }
        const { mcpServers, mcpServerHeadersProvider } = value.workerOptions;
        if (mcpServers !== undefined && !isRecord(mcpServers)) {
            throw new TypeError(
                `Worker startup module ${JSON.stringify(moduleName)} `
                + "workerOptions.mcpServers must be an object.",
            );
        }
        if (
            mcpServerHeadersProvider !== undefined
            && typeof mcpServerHeadersProvider !== "function"
        ) {
            throw new TypeError(
                `Worker startup module ${JSON.stringify(moduleName)} `
                + "workerOptions.mcpServerHeadersProvider must be a function.",
            );
        }
        workerOptions = {
            ...(mcpServers === undefined ? {} : { mcpServers }),
            ...(mcpServerHeadersProvider === undefined
                ? {}
                : {
                    mcpServerHeadersProvider:
                        mcpServerHeadersProvider as StartupWorkerOptions[
                            "mcpServerHeadersProvider"
                        ],
                }),
        };
    }

    if (value.shutdown !== undefined && typeof value.shutdown !== "function") {
        throw new TypeError(
            `Worker startup module ${JSON.stringify(moduleName)} shutdown `
            + "must be a function.",
        );
    }

    return {
        ...(additionalPluginDirs ? { additionalPluginDirs } : {}),
        ...(workerOptions ? { workerOptions } : {}),
        ...(value.shutdown
            ? { shutdown: value.shutdown as WorkerStartupResult["shutdown"] }
            : {}),
    };
}

export async function loadWorkerStartupModuleFromEnv(
    context: WorkerStartupContext,
    options: LoadWorkerStartupModuleOptions = {},
): Promise<WorkerStartupResult | undefined> {
    const moduleName = context.env[WORKER_STARTUP_MODULE_ENV]?.trim();
    if (!moduleName) return undefined;

    const specifier = resolveModuleSpecifier(
        moduleName,
        options.cwd ?? process.cwd(),
    );
    const importModule = options.importModule
        ?? ((value: string) =>
            import(value) as Promise<WorkerStartupModuleExports>);

    let loaded: WorkerStartupModuleExports;
    try {
        loaded = await importModule(specifier);
    } catch (error) {
        throw new Error(
            `Failed to load worker startup module ${JSON.stringify(moduleName)}.`,
            { cause: error },
        );
    }
    if (typeof loaded.initialize !== "function") {
        throw new TypeError(
            `Worker startup module ${JSON.stringify(moduleName)} must export `
            + "an initialize function.",
        );
    }

    const result = await loaded.initialize({
        env: context.env,
        pluginDirs: [...context.pluginDirs],
        trace: context.trace,
    });
    return validateResult(moduleName, result);
}
