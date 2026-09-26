/**
 * Worker extension modules: application code a stock worker loads at start
 * (docs/proposals/session-workspaces.md, section 12.1). The worker entry
 * point reads `PILOTSWARM_EXTENSION_MODULES`, a comma-separated list of
 * module paths or package names, and calls this before `worker.start()`.
 *
 *   PILOTSWARM_EXTENSION_MODULES=/app/examples/repo-workspaces/index.js
 *
 * Each module exports `register(worker, context)`, as a named export or on
 * its default export. It may call `worker.setWorkspaceProvider(...)` and
 * `worker.registerTools(...)`. Modules load in list order; one that fails
 * to load or has no `register` stops the worker, because a half-configured
 * worker would run sessions without the extension.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface ExtensionModuleContext {
    /** The module specifier as listed. */
    specifier: string;
    env: NodeJS.ProcessEnv;
    log: (message: string) => void;
}

/** Split the environment value into module specifiers. */
export function parseExtensionModules(value: string | undefined): string[] {
    return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Import each module and call its `register(worker, context)`. Returns the
 * specifiers that loaded. Throws on the first module that fails.
 */
export async function loadExtensionModules(
    worker: unknown,
    specifiers: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv; log?: (message: string) => void } = {},
): Promise<string[]> {
    const log = opts.log ?? (() => {});
    const loaded: string[] = [];
    for (const specifier of specifiers) {
        // A path (absolute, ./ or ../) loads as a file; anything else is a package name.
        const isPath = path.isAbsolute(specifier) || specifier.startsWith("./") || specifier.startsWith("../");
        const target = isPath ? pathToFileURL(path.resolve(opts.cwd ?? process.cwd(), specifier)).href : specifier;
        let mod: any;
        try {
            mod = await import(target);
        } catch (error: any) {
            throw new Error(`extension module ${specifier} failed to load: ${error?.message ?? error}`);
        }
        const register = typeof mod?.register === "function" ? mod.register
            : typeof mod?.default?.register === "function" ? mod.default.register
            : typeof mod?.default === "function" ? mod.default
            : null;
        if (!register) throw new Error(`extension module ${specifier} exports no register(worker) function`);
        try {
            await register(worker, { specifier, env: opts.env ?? process.env, log } satisfies ExtensionModuleContext);
        } catch (error: any) {
            throw new Error(`extension module ${specifier} failed in register(): ${error?.message ?? error}`);
        }
        log(`extension module loaded: ${specifier}`);
        loaded.push(specifier);
    }
    return loaded;
}
