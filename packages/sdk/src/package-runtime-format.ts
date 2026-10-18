import { parse } from "acorn";
import { posix } from "node:path";
import { readAgentPackageTarGz, agentPackageTarSha256 } from "./agent-package-format.js";

export interface VerifiedPackageRuntime {
    policy: 1;
    artifactSha256: string;
    module: string | null;
    mcp: Record<string, { entry: string; args: string[]; env: Record<string, string> }>;
    files: string[];
    builtins: string[];
}

const BUILTINS = new Set(["node:fs", "node:fs/promises", "node:path", "node:os", "node:crypto",
    "node:util", "node:process", "node:timers", "node:timers/promises", "node:events", "node:buffer",
    "node:readline", "node:stream", "node:url", "node:assert", "node:assert/strict"]);
const FORBIDDEN = new Set(["require", "eval", "Function", "AsyncFunction", "WebAssembly", "Worker",
    "module", "exports",
    "getBuiltinModule", "dlopen", "mainModule", "binding", "_linkedBinding", "constructor",
    "__proto__", "prototype", "getPrototypeOf", "setPrototypeOf", "Reflect", "globalThis", "global"]);

/** Conservative executable dependency policy, NOT a sandbox for approved code. */
export function verifyPackageRuntime(artifact: Buffer, sha256: string): VerifiedPackageRuntime {
    if (agentPackageTarSha256(artifact) !== sha256) throw new Error("Executable artifact digest mismatch");
    const entries = readAgentPackageTarGz(artifact);
    const files = new Map(entries.map(e => [e.name, e.body.toString("utf8")]));
    const builtins = new Set<string>();
    const module = files.has("tools/worker-module.js") ? "tools/worker-module.js"
        : files.has("tools/worker-module.mjs") ? "tools/worker-module.mjs" : null;
    const code = [...files.keys()].filter(f => /\.(?:js|mjs)$/.test(f));
    for (const [name, source] of files) {
        if (name.split("/").some(part => part.toLowerCase() === "node_modules")
            || !(/\.(?:js|mjs|md|txt|json|ya?ml|csv|tsv|svg|png|jpe?g|gif|webp|ico|pdf)$/i.test(name)
                || /(?:^|\/)(?:LICENSE(?:\.[a-z0-9-]+)?|NOTICE|COPYING|README|CHANGELOG|\.gitignore|\.gitattributes|\.editorconfig|\.npmignore)$/i.test(name))) {
            throw new Error(`Unsupported executable/dependency: ${name}`);
        }
        if (posix.basename(name) === "package.json") {
            const metadata = JSON.parse(source);
            if (Object.keys(metadata).some(k => !["name", "version", "description", "license", "type"].includes(k))
                || (metadata.type != null && metadata.type !== "module")) {
                throw new Error(`Unsupported dependency/runtime manifest: ${name}`);
            }
        }
    }
    for (const name of code) {
        if (name.endsWith(".js")) {
            let dir = posix.dirname(name), explicitModule = false;
            for (;;) {
                const manifest = dir === "." ? "package.json" : `${dir}/package.json`;
                if (files.has(manifest)) {
                    explicitModule = JSON.parse(files.get(manifest)!).type === "module";
                    break;
                }
                if (dir === ".") break;
                dir = posix.dirname(dir);
            }
            if (!explicitModule) throw new Error(`Unverifiable ambient module configuration for ${name}; use .mjs or packaged type:module`);
        }
        const ast: any = parse(files.get(name)!, { ecmaVersion: "latest", sourceType: "module" });
        const visit = (node: any): void => {
            if (!node || typeof node !== "object") return;
            if (name === module && node.type === "ExportNamedDeclaration") {
                const names = [node.declaration?.id?.name,
                    ...(node.declaration?.declarations ?? []).map((d: any) => d.id?.name),
                    ...(node.specifiers ?? []).map((d: any) => d.exported?.name ?? d.exported?.value)];
                if (names.some(value => /^(?:prechecks?|handlers?|commands?|scripts)$/i.test(value ?? ""))) {
                    throw new Error("Unsupported free-form callback export");
                }
            }
            if (name === module && node.type === "ExportDefaultDeclaration" && node.declaration?.type === "ObjectExpression"
                && node.declaration.properties.some((p: any) => /^(?:prechecks?|handlers?|commands?|scripts)$/i.test(p.key?.name ?? p.key?.value ?? ""))) {
                throw new Error("Unsupported free-form callback export");
            }
            if (node.type === "ImportExpression" || node.type === "WithStatement"
                || (node.type === "MemberExpression" && node.computed)
                || ((node.type === "Identifier" || node.type === "Literal")
                    && FORBIDDEN.has(String(node.name ?? node.value)))) {
                throw new Error(`Unsupported dynamic executable/dependency shape in ${name}`);
            }
            if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) {
                const spec = String(node.source.value);
                if (BUILTINS.has(spec)) builtins.add(spec);
                else {
                    const resolved = posix.normalize(posix.join(posix.dirname(name), spec));
                    if (!spec.startsWith("./") && !spec.startsWith("../")
                        || resolved.startsWith("../") || !files.has(resolved) || !code.includes(resolved)) {
                        throw new Error(`Unverifiable executable dependency ${spec} in ${name}`);
                    }
                }
            }
            for (const value of Object.values(node)) {
                if (Array.isArray(value)) value.forEach(visit);
                else if (value && typeof value === "object") visit(value);
            }
        };
        visit(ast);
    }
    const mcp: VerifiedPackageRuntime["mcp"] = {};
    if (files.has(".mcp.json")) {
        const parsed = JSON.parse(files.get(".mcp.json")!);
        const servers = parsed.mcpServers ?? parsed;
        for (const [name, value] of Object.entries(servers)) {
            const cfg = value as any;
            const [entry, ...args] = cfg.args ?? [];
            if (cfg.command !== "node" || typeof entry !== "string" || entry.startsWith("/")
                || entry.includes("\\") || !code.includes(entry.replace(/^\.\//, ""))
                || !args.every((arg: unknown) => typeof arg === "string")
                || Object.keys(cfg).some(k => !["command", "args", "env", "type"].includes(k))
                || cfg.type && cfg.type !== "stdio"
                || Object.entries(cfg.env ?? {}).some(([key, val]) =>
                    typeof val !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(key)
                    || /^(?:NODE_|LD_|DYLD_|OPENSSL_|PATH$|COMSPEC$|SYSTEMROOT$)/i.test(key))) {
                throw new Error(`Unsupported or unverifiable package MCP configuration: ${name}`);
            }
            mcp[name] = { entry: entry.replace(/^\.\//, ""), args, env: cfg.env ?? {} };
        }
    }
    const plugin = JSON.parse(files.get("plugin.json") ?? "{}");
    if ((plugin.tools != null && plugin.tools !== module)
        || plugin.workerModule != null) throw new Error("Unsupported noncanonical worker module declaration");
    if (["handlers", "commands", "command", "scripts", "prechecks", "precheck", "workerModules"]
        .some(key => plugin[key] != null)) throw new Error("Unsupported free-form executable manifest declaration");
    if (!module && !Object.keys(mcp).length) throw new Error("No supported supervised executable entry point");
    return { policy: 1, artifactSha256: sha256, module, mcp, files: code.sort(), builtins: [...builtins].sort() };
}
