/**
 * Driving a GHCP runtime that runs outside the worker
 * (docs/proposals/compute-providers.md, "One remote turn").
 *
 * The worker stays the trusted side. Three pieces keep secrets and state
 * there while the runtime runs on a compute host:
 *
 *   redactProviderSecrets       the model provider config sent to the runtime
 *                               carries placeholders, not keys
 *   RemoteRuntimeRequestHandler every model request the runtime makes comes
 *                               back through the worker, which swaps the
 *                               placeholders for the real credentials
 *   WorkerDirectorySessionFs    the runtime's session-state files live in the
 *                               worker's own session directory, so dehydrate
 *                               and hydrate are unchanged
 *
 * None of this depends on the compute type.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { CopilotRequestContext, SessionFsFileInfo, SessionFsProvider } from "@github/copilot-sdk";
import { ByokRequestCompatibility } from "./copilot-client.js";

/** The virtual root the runtime sees for session state. */
export const REMOTE_SESSION_STATE_ROOT = "/pilotswarm/session-state";

const PLACEHOLDER_PREFIX = "pilotswarm-worker-secret";

/** What the worker keeps for one session: placeholder → how to get the real value. */
export type RemoteSecretMap = Map<string, () => Promise<string> | string>;

/**
 * Replace every credential in a provider config with a placeholder. The
 * runtime only ever sees the placeholders; the request handler swaps them.
 * Placeholders are unique per session so one session can never receive
 * another session's key.
 */
export function redactProviderSecrets<T extends Record<string, any> | undefined>(
    provider: T,
    sessionId: string,
): { provider: T; secrets: RemoteSecretMap } {
    const secrets: RemoteSecretMap = new Map();
    if (!provider) return { provider, secrets };
    const out: Record<string, any> = { ...provider };
    const tag = (field: string) => `${PLACEHOLDER_PREFIX}-${field}-${sessionId}`;
    if (typeof out.apiKey === "string" && out.apiKey) {
        const real = out.apiKey;
        out.apiKey = tag("apiKey");
        secrets.set(out.apiKey, () => real);
    }
    if (typeof out.bearerToken === "string" && out.bearerToken) {
        const real = out.bearerToken;
        out.bearerToken = tag("bearerToken");
        secrets.set(out.bearerToken, () => real);
    }
    if (typeof out.bearerTokenProvider === "function") {
        const real = out.bearerTokenProvider;
        const placeholder = tag("bearerTokenProvider");
        // The runtime still asks for a token per request; it gets the
        // placeholder, and the worker substitutes a fresh real token.
        out.bearerTokenProvider = async () => placeholder;
        secrets.set(placeholder, () => real({ providerName: "default" }));
    }
    if (out.headers && typeof out.headers === "object") {
        // Fixed request headers may carry credentials too; treat every value as one.
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(out.headers as Record<string, unknown>)) {
            if (typeof value !== "string" || !value) continue;
            const placeholder = tag(`header-${name.toLowerCase()}`);
            headers[name] = placeholder;
            secrets.set(placeholder, () => value);
        }
        out.headers = headers;
    }
    return { provider: out as T, secrets };
}

/** Whether a string still holds a worker placeholder (it must never leave the worker unswapped). */
export function containsWorkerPlaceholder(value: string): boolean {
    return value.includes(PLACEHOLDER_PREFIX);
}

/**
 * The request handler for a remote runtime. For each model request it
 * swaps placeholders in the headers for the session's real credentials,
 * then forwards as the BYOK compatibility handler does. A request that
 * still carries an unknown placeholder is refused rather than sent.
 */
export class RemoteRuntimeRequestHandler extends ByokRequestCompatibility {
    constructor(
        private readonly secretsFor: (sessionId: string | undefined) => RemoteSecretMap | undefined,
        toolCatalog?: ConstructorParameters<typeof ByokRequestCompatibility>[0],
    ) {
        super(toolCatalog);
    }

    protected override async sendRequest(request: Request, context: CopilotRequestContext): Promise<Response> {
        return super.sendRequest(await injectSecrets(request, this.secretsFor(context.sessionId)), context);
    }
}

/** @internal exported for tests */
export async function injectSecrets(request: Request, secrets: RemoteSecretMap | undefined): Promise<Request> {
    let headers: Headers | null = null;
    for (const [name, value] of request.headers) {
        if (!containsWorkerPlaceholder(value)) continue;
        let next = value;
        for (const [placeholder, resolve] of secrets ?? []) {
            if (next.includes(placeholder)) next = next.split(placeholder).join(await resolve());
        }
        if (containsWorkerPlaceholder(next)) {
            throw new Error(`refusing a model request: header "${name}" holds a credential placeholder this worker cannot resolve`);
        }
        headers ??= new Headers(request.headers);
        headers.set(name, next);
    }
    return headers ? new Request(request, { headers }) : request;
}

/**
 * A SessionFs provider over a directory on the worker: the runtime's
 * session-state root (REMOTE_SESSION_STATE_ROOT) maps to `dir`. Every path
 * is confined to `dir`.
 */
export class WorkerDirectorySessionFs implements SessionFsProvider {
    constructor(private readonly dir: string, private readonly virtualRoot = REMOTE_SESSION_STATE_ROOT) {}

    private real(p: string): string {
        const posix = p.replace(/\\/g, "/");
        const rel = posix === this.virtualRoot ? ""
            : posix.startsWith(this.virtualRoot + "/") ? posix.slice(this.virtualRoot.length + 1)
                : posix.replace(/^\/+/, "");
        const resolved = path.resolve(this.dir, rel);
        if (resolved !== this.dir && !resolved.startsWith(this.dir + path.sep)) {
            throw Object.assign(new Error(`path outside the session directory: ${p}`), { code: "EACCES" });
        }
        return resolved;
    }

    async readFile(p: string): Promise<string> {
        return fs.readFile(this.real(p), "utf8");
    }

    async writeFile(p: string, content: string, mode?: number): Promise<void> {
        const target = this.real(p);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, mode !== undefined ? { mode } : undefined);
    }

    async appendFile(p: string, content: string, mode?: number): Promise<void> {
        const target = this.real(p);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.appendFile(target, content, mode !== undefined ? { mode } : undefined);
    }

    async exists(p: string): Promise<boolean> {
        try {
            await fs.access(this.real(p));
            return true;
        } catch {
            return false;
        }
    }

    async stat(p: string): Promise<SessionFsFileInfo> {
        const st = await fs.stat(this.real(p));
        return {
            isFile: st.isFile(),
            isDirectory: st.isDirectory(),
            size: st.size,
            mtime: st.mtime.toISOString(),
            birthtime: st.birthtime.toISOString(),
        };
    }

    async mkdir(p: string, recursive: boolean, mode?: number): Promise<void> {
        await fs.mkdir(this.real(p), { recursive, ...(mode !== undefined ? { mode } : {}) });
    }

    async readdir(p: string): Promise<string[]> {
        return fs.readdir(this.real(p));
    }

    async readdirWithTypes(p: string): Promise<Array<{ name: string; type: "file" | "directory" }>> {
        const entries = await fs.readdir(this.real(p), { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
    }

    async rm(p: string, recursive: boolean, force: boolean): Promise<void> {
        await fs.rm(this.real(p), { recursive, force });
    }

    async rename(src: string, dest: string): Promise<void> {
        const target = this.real(dest);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(this.real(src), target);
    }
}
