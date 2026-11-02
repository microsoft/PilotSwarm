/**
 * Driving an agent runtime that runs outside the worker
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
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CopilotRequestContext, CopilotWebSocketHandler, SessionFsFileInfo, SessionFsProvider } from "@github/copilot-sdk";
import { ByokRequestCompatibility } from "./copilot-client.js";

/** The virtual root the runtime sees for session state. */
export const REMOTE_SESSION_STATE_ROOT = "/pilotswarm/session-state";

const PLACEHOLDER_PREFIX = "pilotswarm-worker-secret";

/** What the worker keeps for one session: placeholder → how to get the real value. */
export type RemoteSecretMap = Map<string, () => Promise<string> | string>;

/**
 * What a remote session's model requests may do: reach one origin under one
 * path prefix (the session's model provider), with these placeholders
 * swapped for real credentials. Anything else is refused.
 */
export interface RemoteSessionGrant {
    secrets: RemoteSecretMap;
    origin: string;
    pathPrefix: string;
}

/**
 * Replace every credential in a provider config with a placeholder. The
 * runtime only ever sees the placeholders; the request handler swaps them.
 * Placeholders carry the session id and a fresh random nonce, so they are
 * unique per session and per binding and cannot be guessed.
 */
export function redactProviderSecrets<T extends Record<string, any> | undefined>(
    provider: T,
    sessionId: string,
    providerName = "default",
): { provider: T; secrets: RemoteSecretMap } {
    const secrets: RemoteSecretMap = new Map();
    if (!provider) return { provider, secrets };
    const out: Record<string, any> = { ...provider };
    const nonce = randomBytes(16).toString("hex");
    const tag = (field: string) => `${PLACEHOLDER_PREFIX}-${field}-${sessionId}-${nonce}`;
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
        secrets.set(placeholder, () => real({ providerName }));
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

/**
 * The grant for a session's model provider: its base URL pins the origin and
 * path prefix. A provider config without a base URL gets no grant.
 */
export function remoteSessionGrant(baseUrl: unknown, secrets: RemoteSecretMap): RemoteSessionGrant | null {
    if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
    let url: URL;
    try {
        url = new URL(baseUrl.trim());
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const pathPrefix = url.pathname.replace(/\/+$/, "") + "/";
    return { secrets, origin: url.origin, pathPrefix };
}

/** Whether a string still holds a worker placeholder (it must never leave the worker unswapped). */
export function containsWorkerPlaceholder(value: string): boolean {
    return value.includes(PLACEHOLDER_PREFIX);
}

/** @internal exported for tests. Throws when the request is outside the grant. */
export function checkModelRequest(request: Request, grant: RemoteSessionGrant): void {
    let url: URL;
    try {
        url = new URL(request.url);
    } catch {
        throw new Error("refusing a model request: its URL does not parse");
    }
    if (url.origin !== grant.origin) {
        throw new Error(`refusing a model request to ${url.origin}: this session's model provider is ${grant.origin}`);
    }
    if (url.username || url.password) throw new Error("refusing a model request: its URL carries credentials");
    const pathname = url.pathname.replace(/\/+$/, "") + "/";
    if (!pathname.startsWith(grant.pathPrefix) || /(^|\/)\.\.?(\/|$)/.test(url.pathname)) {
        throw new Error("refusing a model request outside this session's model provider path");
    }
    if (request.method !== "POST" && request.method !== "GET") {
        throw new Error(`refusing a model request with method ${request.method}`);
    }
}

/**
 * The request handler for a remote runtime. It serves only the sessions this
 * worker bound to that runtime (`grantFor` answers per connection). For each
 * model request it checks the destination against the session's grant,
 * swaps placeholders in the headers for real credentials, and forwards it
 * with redirects refused. A request outside the grant, or with a
 * placeholder it cannot resolve, is refused rather than sent. WebSocket
 * model transports are refused.
 */
export class RemoteRuntimeRequestHandler extends ByokRequestCompatibility {
    constructor(
        private readonly grantFor: (sessionId: string | undefined) => RemoteSessionGrant | undefined,
        toolCatalog?: ConstructorParameters<typeof ByokRequestCompatibility>[0],
    ) {
        super(toolCatalog);
    }

    protected override async sendRequest(request: Request, context: CopilotRequestContext): Promise<Response> {
        const grant = this.grantFor(context.sessionId);
        if (!grant) throw new Error("refusing a model request: no session on this runtime matches it");
        checkModelRequest(request, grant);
        const injected = await injectSecrets(request, grant.secrets);
        return super.sendRequest(new Request(injected, { redirect: "error" }), context);
    }

    protected override async openWebSocket(_context: CopilotRequestContext): Promise<CopilotWebSocketHandler> {
        throw new Error("refusing a model WebSocket from a remote runtime: not supported");
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


/** The most one SessionFs write may carry. */
export const SESSION_FS_MAX_WRITE_BYTES = 64 * 1024 * 1024;
/**
 * The most a session's whole state folder may hold, before a deployment
 * says otherwise.
 *
 * A runtime on a host writes its session state back through this, and the
 * folder it writes into is on the worker. One write is bounded; without a
 * total, a runtime that keeps writing fills the worker's disk, and the
 * worker's disk is shared with every other session on it.
 */
export const SESSION_FS_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** How long a count of a session's folder stands before it is taken again. */
export const SESSION_FS_COUNT_FRESH_MS = 2_000;

function refused(message: string): Error {
    return Object.assign(new Error(message), { code: "EACCES" });
}

/**
 * A SessionFs provider over a directory on the worker: the runtime's
 * session-state root (REMOTE_SESSION_STATE_ROOT) maps to `dir`, whose last
 * path segment is the session id. The runtime is untrusted, so:
 *   - only the virtual root, the runtime's own `<home>/session-state/<id>`
 *     form and relative paths are accepted; any other absolute path is
 *     refused
 *   - every path stays inside `dir`, and no symbolic link inside `dir` is
 *     followed
 *   - one write carries at most SESSION_FS_MAX_WRITE_BYTES
 */
export class WorkerDirectorySessionFs implements SessionFsProvider {
    private readonly maxTotalBytes: number;
    /** What the folder held when it was last counted, and when that was. */
    private held = 0;
    private countedAt = 0;

    constructor(
        private readonly dir: string,
        private readonly virtualRoot = REMOTE_SESSION_STATE_ROOT,
        options: { maxTotalBytes?: number } = {},
    ) {
        const limit = Number(options.maxTotalBytes);
        this.maxTotalBytes = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SESSION_FS_MAX_TOTAL_BYTES;
    }

    /**
     * What this session's folder holds now.
     *
     * Counted by walking it, and remembered for a moment: a turn writes
     * many small files, and walking the folder for every one of them
     * would cost more than the limit is worth. The remembered figure is
     * only ever used to let a write through when the folder is well under
     * the limit, so a short delay in noticing cannot take it far past.
     */
    private async totalBytes(): Promise<number> {
        if (Date.now() - this.countedAt < SESSION_FS_COUNT_FRESH_MS) return this.held;
        let total = 0;
        const walk = async (dir: string): Promise<void> => {
            let entries: Awaited<ReturnType<typeof fs.readdir>>;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true }) as never;
            } catch {
                return;
            }
            for (const entry of entries as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { await walk(full); continue; }
                if (!entry.isFile()) continue;
                try { total += (await fs.lstat(full)).size; } catch { /* gone while counting */ }
            }
        };
        await walk(this.dir);
        this.held = total;
        this.countedAt = Date.now();
        return total;
    }

    /** Room for this many more bytes, or the write is refused. */
    private async checkRoom(adding: number): Promise<void> {
        const total = await this.totalBytes();
        if (total + adding <= this.maxTotalBytes) {
            // Count it as written: the next write sees it without walking.
            this.held = total + adding;
            return;
        }
        // Count again before refusing, in case what is remembered is old.
        this.countedAt = 0;
        const fresh = await this.totalBytes();
        if (fresh + adding <= this.maxTotalBytes) {
            this.held = fresh + adding;
            return;
        }
        throw Object.assign(
            new Error(`this session's files already hold the ${this.maxTotalBytes} bytes one session may`),
            { code: "EDQUOT" });
    }

    private relative(p: string): string {
        const posix = String(p).replace(/\\/g, "/");
        const homeMarker = `/session-state/${path.basename(this.dir)}`;
        const homeAt = posix.indexOf(homeMarker + "/");
        if (posix === this.virtualRoot) return "";
        if (posix.startsWith(this.virtualRoot + "/")) return posix.slice(this.virtualRoot.length + 1);
        // The runtime also names some session files by its own home.
        if (posix.endsWith(homeMarker)) return "";
        if (homeAt >= 0) return posix.slice(homeAt + homeMarker.length + 1);
        if (posix.startsWith("/") || /^[a-zA-Z]:\//.test(posix)) throw refused(`path outside the session directory: ${p}`);
        return posix;
    }

    private async real(p: string): Promise<string> {
        const resolved = path.resolve(this.dir, this.relative(p));
        if (resolved !== this.dir && !resolved.startsWith(this.dir + path.sep)) {
            throw refused(`path outside the session directory: ${p}`);
        }
        let current = this.dir;
        for (const part of path.relative(this.dir, resolved).split(path.sep).filter(Boolean)) {
            current = path.join(current, part);
            try {
                if ((await fs.lstat(current)).isSymbolicLink()) throw refused(`path crosses a link in the session directory: ${p}`);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
                throw error;
            }
        }
        return resolved;
    }

    private checkSize(content: string): void {
        if (Buffer.byteLength(content, "utf8") > SESSION_FS_MAX_WRITE_BYTES) {
            throw Object.assign(new Error(`a session file write is larger than ${SESSION_FS_MAX_WRITE_BYTES} bytes`), { code: "EFBIG" });
        }
    }

    async readFile(p: string): Promise<string> {
        return fs.readFile(await this.real(p), "utf8");
    }

    async writeFile(p: string, content: string, mode?: number): Promise<void> {
        this.checkSize(content);
        const target = await this.real(p);
        // What this write adds, which is not what it carries when it
        // replaces a file that is already there.
        let replacing = 0;
        try { replacing = (await fs.lstat(target)).size; } catch { /* a new file */ }
        await this.checkRoom(Math.max(0, Buffer.byteLength(content, "utf8") - replacing));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, mode !== undefined ? { mode } : undefined);
    }

    async appendFile(p: string, content: string, mode?: number): Promise<void> {
        this.checkSize(content);
        const target = await this.real(p);
        await this.checkRoom(Buffer.byteLength(content, "utf8"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.appendFile(target, content, mode !== undefined ? { mode } : undefined);
    }

    async exists(p: string): Promise<boolean> {
        try {
            await fs.lstat(await this.real(p));
            return true;
        } catch {
            return false;
        }
    }

    async stat(p: string): Promise<SessionFsFileInfo> {
        const st = await fs.lstat(await this.real(p));
        return {
            isFile: st.isFile(),
            isDirectory: st.isDirectory(),
            size: st.size,
            mtime: st.mtime.toISOString(),
            birthtime: st.birthtime.toISOString(),
        };
    }

    async mkdir(p: string, recursive: boolean, mode?: number): Promise<void> {
        await fs.mkdir(await this.real(p), { recursive, ...(mode !== undefined ? { mode } : {}) });
    }

    async readdir(p: string): Promise<string[]> {
        return fs.readdir(await this.real(p));
    }

    async readdirWithTypes(p: string): Promise<Array<{ name: string; type: "file" | "directory" }>> {
        const entries = await fs.readdir(await this.real(p), { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
    }

    async rm(p: string, recursive: boolean, force: boolean): Promise<void> {
        await fs.rm(await this.real(p), { recursive, force });
        // The folder is smaller than it was; count it again rather than
        // leaving a session unable to write after it has cleaned up.
        this.countedAt = 0;
    }

    async rename(src: string, dest: string): Promise<void> {
        const from = await this.real(src);
        const target = await this.real(dest);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(from, target);
    }
}
