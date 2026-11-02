/**
 * What a session's MCP servers look like when its agent runs somewhere
 * else (docs/proposals/compute-providers.md, "Skills and MCP servers on
 * remote sessions").
 *
 * A session on the worker gets one map of servers and the runtime starts
 * them all. A session on a compute host cannot: half of that map is the
 * deployment's own code, configured with the deployment's own credentials,
 * and the other half is code out of an agent package, which is no more
 * trusted than the model that asked for it.
 *
 * So the map is split by where the server's code came from:
 *
 * - **A package's server** runs on the host, started by the runtime out
 *   of the copied package folder. It is built from the entry as it was
 *   written, never from the entry the worker resolved: a package server
 *   gets the environment the host gives it and nothing of the worker's.
 *   An entry that asks for a worker value is not quietly emptied — it is
 *   unavailable, with the field that asked for it in the reason.
 *
 * - **A deployment's server** stays on the trusted side, started and
 *   configured exactly as it is today, credentials and all. The runtime
 *   reaches it as a remote server: a small PilotSwarm relay on the host
 *   for one that speaks over its own input and output, a local address on
 *   the host component for one that speaks over HTTP. Neither the
 *   server's command, its environment, its headers nor its address ever
 *   leaves the worker.
 *
 * Every restriction a session's map already carries — which tools, the
 * deployment default set, `allowedAgents`, package name collisions, the
 * exact selections of `use_package`, quarantine — is applied before this
 * point and is not touched here. This module only decides where a server
 * that is already in the map runs, and refuses the ones that cannot run
 * anywhere without breaking the boundary.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { mcpConfigWorkerValueFields } from "./mcp-loader.js";

/** Where a server in a session's map came from, and what the deployment said about it. */
export interface McpServerOrigin {
    origin: "deployment" | "package";
    /** The folder whose `.mcp.json` defined it. */
    dir: string;
    packageId?: string | null;
    /** The entry as written, with no worker value resolved into it. */
    raw?: unknown;
    /**
     * Deployment entries only. `false` keeps the server away from sessions
     * whose agent runs elsewhere. Servers are available by default.
     */
    remote?: boolean;
}

/** What the host component told the worker about itself. */
export interface RemoteMcpHostFacts {
    /** Where each copied folder ended up, by the name the worker gave it. */
    placements: Record<string, string>;
    /** How the runtime starts the relay for a server that speaks over input and output. */
    relay: { command: string; args: string[] } | null;
    /** The address on the host that stands in for a server reached over HTTP. */
    httpBase: string | null;
    /** The host's path separator, so a copied folder's paths are written the host's way. */
    separator: string;
}

export interface RemoteMcpRefusal {
    name: string;
    reason: string;
}

export interface RemoteMcpResult {
    servers: Record<string, any>;
    unavailable: RemoteMcpRefusal[];
    /** The tickets minted for this map, each naming one server. */
    tickets: Array<{ ticket: string; server: string }>;
}

/** A stable, plain name for the copy of one folder. */
export function computeCopyName(prefix: string, source: string): string {
    return `${prefix}-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
}

/** The package folders a session's remote map needs copied, each one once. */
export function packageMcpFolders(
    servers: Record<string, unknown>,
    origins: (name: string) => McpServerOrigin | undefined,
): Array<{ name: string; source: string }> {
    const folders = new Map<string, string>();
    for (const name of Object.keys(servers ?? {})) {
        const origin = origins(name);
        if (!origin || origin.origin !== "package" || !origin.dir) continue;
        folders.set(computeCopyName("package", origin.dir), origin.dir);
    }
    return [...folders].map(([item, source]) => ({ name: item, source }));
}

function isStdio(config: any): boolean {
    return typeof config?.command === "string" && config.command.length > 0;
}

/** Fields PilotSwarm reads itself and never lets reach a runtime. */
const WORKER_ONLY_FIELDS = ["default", "allowedAgents", "remote"];

function withoutWorkerOnlyFields<T extends Record<string, any>>(config: T): T {
    const copy: Record<string, any> = { ...config };
    for (const field of WORKER_ONLY_FIELDS) delete copy[field];
    return copy as T;
}

/**
 * Rewrite one path of a package's entry so it names the copy on the host.
 *
 * A relative path is left alone: it is resolved against the entry's own
 * folder, which on the host is the copy. An absolute path inside the
 * package folder becomes the matching path inside the copy. An absolute
 * path anywhere else is not the package's to name — it would be a path on
 * the worker — and the caller refuses the entry.
 */
function remapPath(value: string, packageDir: string, hostDir: string, separator: string): string | null {
    if (!path.isAbsolute(value)) return value;
    const relative = path.relative(packageDir, value);
    if (!relative) return hostDir;
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return hostDir + separator + relative.split(path.sep).join(separator);
}

/**
 * The map a remote runtime is given, and the servers it cannot have.
 *
 * `mintTicket` is asked for one opaque ticket per server that stays on the
 * trusted side. A ticket is what the host hands back when it forwards, so
 * the worker knows which session asked and for which server; nothing else
 * about the server crosses.
 */
export function remoteMcpServers(
    servers: Record<string, any>,
    origins: (name: string) => McpServerOrigin | undefined,
    host: RemoteMcpHostFacts,
    mintTicket: (server: string) => string,
): RemoteMcpResult {
    const out: Record<string, any> = {};
    const unavailable: RemoteMcpRefusal[] = [];
    const tickets: Array<{ ticket: string; server: string }> = [];
    const separator = host.separator || "/";

    for (const [name, configured] of Object.entries(servers ?? {})) {
        const origin = origins(name);
        if (!origin) {
            unavailable.push({ name, reason: "the worker cannot tell whose code this server is, so it cannot decide where it may run" });
            continue;
        }

        if (origin.origin === "deployment") {
            if (origin.remote === false) {
                unavailable.push({ name, reason: "this deployment keeps this server away from sessions whose agent runs elsewhere" });
                continue;
            }
            const base = withoutWorkerOnlyFields(configured ?? {});
            const kept: Record<string, any> = {};
            if (Array.isArray(base.tools)) kept.tools = base.tools;
            if (typeof base.timeout === "number") kept.timeout = base.timeout;
            if (isStdio(base)) {
                if (!host.relay) {
                    unavailable.push({ name, reason: "this host has no relay, so a server that speaks over its input and output cannot be reached from it" });
                    continue;
                }
                const ticket = mintTicket(name);
                tickets.push({ ticket, server: name });
                out[name] = { ...kept, type: "local", command: host.relay.command, args: [...host.relay.args, "--ticket", ticket] };
                continue;
            }
            if (typeof base.url === "string" && base.url) {
                if (!host.httpBase) {
                    unavailable.push({ name, reason: "this host has no local address for a forwarded server, so a server reached over HTTP cannot be reached from it" });
                    continue;
                }
                const ticket = mintTicket(name);
                tickets.push({ ticket, server: name });
                // No headers: whatever the deployment configured stays on
                // the trusted side and is applied there, so a credential in
                // the configuration never reaches the host.
                out[name] = { ...kept, type: base.type === "sse" ? "sse" : "http", url: `${host.httpBase}${ticket}` };
                continue;
            }
            unavailable.push({ name, reason: "this server's configuration is neither a command nor an address, so there is nothing to reach" });
            continue;
        }

        // A package's own server: built from the entry as written.
        const raw = (origin.raw ?? null) as any;
        if (!raw || typeof raw !== "object") {
            unavailable.push({ name, reason: "the worker no longer has this server's configuration as it was written, so it cannot be built without worker values" });
            continue;
        }
        const asks = mcpConfigWorkerValueFields(withoutWorkerOnlyFields(raw));
        if (asks.length > 0) {
            unavailable.push({ name, reason: `its configuration asks for a value from the worker (${asks.join(", ")}), and a session's host is never given one` });
            continue;
        }
        const entry = withoutWorkerOnlyFields(raw);
        if (isStdio(entry)) {
            const item = computeCopyName("package", origin.dir);
            const hostDir = host.placements[item];
            if (!hostDir) {
                unavailable.push({ name, reason: "its package folder could not be copied to the host" });
                continue;
            }
            const command = entry.command.includes("/") || entry.command.includes("\\") || path.isAbsolute(entry.command)
                ? remapPath(entry.command, origin.dir, hostDir, separator)
                : entry.command;
            if (command === null) {
                unavailable.push({ name, reason: "its command is a path outside its own package folder, which is a path on the worker" });
                continue;
            }
            const args: string[] = [];
            let refused: string | null = null;
            for (const raw of Array.isArray(entry.args) ? entry.args : []) {
                const value = String(raw ?? "");
                const mapped = remapPath(value, origin.dir, hostDir, separator);
                if (mapped === null) {
                    refused = `one of its arguments is a path outside its own package folder (${value})`;
                    break;
                }
                args.push(mapped);
            }
            if (refused) {
                unavailable.push({ name, reason: refused });
                continue;
            }
            const cwd = typeof entry.cwd === "string" ? remapPath(entry.cwd, origin.dir, hostDir, separator) : hostDir;
            if (cwd === null) {
                unavailable.push({ name, reason: "its working folder is outside its own package folder, which is a folder on the worker" });
                continue;
            }
            out[name] = {
                ...(entry.type ? { type: entry.type } : {}),
                command, args, cwd,
                ...(Array.isArray(entry.tools) ? { tools: entry.tools } : {}),
                // Only what the entry itself states. The worker's own
                // environment is never spread in, here or anywhere below.
                ...(entry.env && typeof entry.env === "object" ? { env: { ...entry.env } } : {}),
                ...(typeof entry.timeout === "number" ? { timeout: entry.timeout } : {}),
            };
            continue;
        }
        if (typeof entry.url === "string" && entry.url) {
            // Nothing to start and nothing to copy: the host reaches it
            // itself, with only what the entry states.
            out[name] = {
                type: entry.type === "sse" ? "sse" : "http",
                url: entry.url,
                ...(Array.isArray(entry.tools) ? { tools: entry.tools } : {}),
                ...(entry.headers && typeof entry.headers === "object" ? { headers: { ...entry.headers } } : {}),
                ...(typeof entry.timeout === "number" ? { timeout: entry.timeout } : {}),
            };
            continue;
        }
        unavailable.push({ name, reason: "this server's configuration is neither a command nor an address, so there is nothing to reach" });
    }

    return { servers: out, unavailable, tickets };
}

/**
 * The same transformation over a list of agent definitions that carry
 * their own server maps.
 *
 * A nested map is as much a grant as the top-level one, so it is not left
 * behind with worker paths and worker values in it.
 */
export function remoteMcpCustomAgents<T extends { mcpServers?: Record<string, any> }>(
    agents: T[] | undefined,
    origins: (name: string) => McpServerOrigin | undefined,
    host: RemoteMcpHostFacts,
    mintTicket: (server: string) => string,
): { agents: T[]; unavailable: RemoteMcpRefusal[]; tickets: Array<{ ticket: string; server: string }> } {
    const unavailable: RemoteMcpRefusal[] = [];
    const tickets: Array<{ ticket: string; server: string }> = [];
    const out = (agents ?? []).map((agent) => {
        if (!agent?.mcpServers || Object.keys(agent.mcpServers).length === 0) return agent;
        const result = remoteMcpServers(agent.mcpServers, origins, host, mintTicket);
        unavailable.push(...result.unavailable.map((refusal) => ({ ...refusal, name: `${refusal.name} (agent ${String((agent as any).name ?? "")})` })));
        tickets.push(...result.tickets);
        return { ...agent, mcpServers: result.servers };
    });
    return { agents: out, unavailable, tickets };
}

/** The package folders the nested maps need copied too. */
export function packageMcpFoldersForAgents<T extends { mcpServers?: Record<string, any> }>(
    agents: T[] | undefined,
    origins: (name: string) => McpServerOrigin | undefined,
): Array<{ name: string; source: string }> {
    const folders = new Map<string, string>();
    for (const agent of agents ?? []) {
        for (const entry of packageMcpFolders(agent?.mcpServers ?? {}, origins)) folders.set(entry.name, entry.source);
    }
    return [...folders].map(([name, source]) => ({ name, source }));
}
