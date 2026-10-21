import * as modules from "node:module";
import { Buffer } from "node:buffer";

export interface PackageSourceSnapshot {
    sources: Record<string, string>;
    builtins: string[];
}

/** Trusted bootstrap only: package resolution never falls through to the filesystem. */
export function installPackageSourceSnapshot(snapshot: PackageSourceSnapshot): void {
    if (typeof modules.registerHooks !== "function") throw new Error("Package execution requires synchronous Node module.registerHooks");
    if (!snapshot || !Array.isArray(snapshot.builtins) || !snapshot.sources) throw new Error("Verified source snapshot required");
    const sources = new Map(Object.entries(snapshot.sources).map(([url, source]) => [url, Buffer.from(source, "base64")]));
    const builtins = new Set(snapshot.builtins);
    modules.registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier.startsWith("node:") && builtins.has(specifier)) return nextResolve(specifier, context);
            if (!specifier.startsWith("file:") && !specifier.startsWith("./") && !specifier.startsWith("../")) {
                throw new Error(`Package import outside verified snapshot: ${specifier}`);
            }
            const url = new URL(specifier, context.parentURL).href;
            if (!sources.has(url)) throw new Error(`Package import outside verified snapshot: ${url}`);
            return { url, format: "module", shortCircuit: true };
        },
        load(url, context, nextLoad) {
            const source = sources.get(url);
            if (source) return { format: "module", source, shortCircuit: true };
            if (url.startsWith("node:") && builtins.has(url)) return nextLoad(url, context);
            throw new Error(`Package load outside verified snapshot: ${url}`);
        },
    });
}
