/**
 * Keeping model credentials on the worker while the Copilot runtime runs somewhere else.
 *
 * The worker stays the trusted side. Two pieces:
 *
 *   redactProviderSecrets       the model provider config sent to the remote runtime carries placeholders, not keys
 *   RemoteRuntimeRequestHandler every model request the runtime makes comes back through the worker, which checks it against the session's grant, swaps the
 *                               placeholders for the real credentials and sends it; anything outside the grant is refused, never sent
 *
 * The handler extends the worker's own `ByokRequestCompatibility` (copilot-client.ts), so the OpenAI-compatible tool-catalog adaptation applies to a remote runtime
 * exactly as it does to a local one. None of this depends on the provider of the compute host.
 */
import { randomBytes } from "node:crypto";
import type { CopilotRequestContext, CopilotWebSocketHandler } from "@github/copilot-sdk";
import { ByokRequestCompatibility } from "./copilot-client.js";
import { RemoteRuntimeError } from "./remote-runtime.js";

const PLACEHOLDER_PREFIX = "pilotswarm-worker-secret";

/** Fields permitted in a model provider config forwarded to an untrusted remote runtime (strict allowlist). */
const ALLOWED_REMOTE_PROVIDER_KEYS = new Set([
    "type",
    "baseUrl",
    "wireApi",
    "azure",
    "apiKey",
    "bearerToken",
    "bearerTokenProvider",
    "headers",
]);
const ALLOWED_REMOTE_AZURE_KEYS = new Set(["apiVersion"]);

/** Header names allowed to receive substituted `apiKey` or `bearerToken` placeholders (lowercase). */
const API_KEY_ALLOWED_HEADERS = Object.freeze(["authorization", "api-key", "x-api-key"] as const);
const BEARER_ALLOWED_HEADERS = Object.freeze(["authorization"] as const);

/** What the worker keeps for one placeholder: how to resolve the real credential and which header names may carry it. */
export interface RemoteSecretEntry {
    readonly resolve: () => Promise<string> | string;
    readonly allowedHeaders: readonly string[];
}

/** What the worker keeps for one session: placeholder → secret entry. */
export type RemoteSecretMap = Map<string, RemoteSecretEntry>;

/**
 * What a remote session's model requests may do: reach one origin under one path prefix (the session's model provider), with these placeholders swapped for real
 * credentials in their permitted headers only. Anything else is refused.
 */
export interface RemoteSessionGrant {
    secrets: RemoteSecretMap;
    origin: string;
    pathPrefix: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Allowlist and redact a provider config before sending it to a remote runtime. Unknown fields (which might carry credentials) are refused rather than forwarded.
 * Placeholders carry the session id and a fresh random nonce and are bound to the exact header name(s) allowed to receive the real credential.
 */
export function redactProviderSecrets<T extends Record<string, any> | undefined>(
    provider: T,
    sessionId: string,
): { provider: T; secrets: RemoteSecretMap } {
    const secrets: RemoteSecretMap = new Map();
    if (!provider) return { provider, secrets };
    if (!isPlainRecord(provider)) {
        throw new RemoteRuntimeError("REMOTE_RUNTIME_REFUSED", "remote model provider config must be a plain object");
    }
    for (const key of Object.keys(provider)) {
        if (!ALLOWED_REMOTE_PROVIDER_KEYS.has(key)) {
            throw new RemoteRuntimeError("REMOTE_RUNTIME_REFUSED", `remote model provider field "${key}" is not allowed on a remote runtime`);
        }
    }
    const out: Record<string, any> = {};
    if (provider.type !== undefined) out.type = provider.type;
    if (provider.baseUrl !== undefined) out.baseUrl = provider.baseUrl;
    if (provider.wireApi !== undefined) out.wireApi = provider.wireApi;
    if (provider.azure !== undefined) {
        if (!isPlainRecord(provider.azure)) {
            throw new RemoteRuntimeError("REMOTE_RUNTIME_REFUSED", "remote model provider azure options must be a plain object");
        }
        const safeAzure: Record<string, unknown> = {};
        for (const key of Object.keys(provider.azure)) {
            if (!ALLOWED_REMOTE_AZURE_KEYS.has(key)) {
                throw new RemoteRuntimeError("REMOTE_RUNTIME_REFUSED", `remote model provider azure field "${key}" is not allowed on a remote runtime`);
            }
            safeAzure[key] = provider.azure[key];
        }
        out.azure = safeAzure;
    }

    const nonce = randomBytes(16).toString("hex");
    const tag = (field: string) => `${PLACEHOLDER_PREFIX}-${field}-${sessionId}-${nonce}`;
    if (provider.apiKey !== undefined) {
        if (typeof provider.apiKey !== "string") {
            throw new RemoteRuntimeError("REMOTE_RUNTIME_REFUSED", "remote model provider apiKey must be a string");
        }
        if (provider.apiKey) {
            const real = provider.apiKey;
            out.apiKey = tag("apiKey");
            secrets.set(out.apiKey, { resolve: () => real, allowedHeaders: API_KEY_ALLOWED_HEADERS });
        }
    }
    if (provider.bearerToken !== undefined) {
        if (typeof provider.bearerToken !== "string") {
            throw new RemoteRuntimeError("REMOTE_RUNTIME_REFUSED", "remote model provider bearerToken must be a string");
        }
        if (provider.bearerToken) {
            const real = provider.bearerToken;
            out.bearerToken = tag("bearerToken");
            secrets.set(out.bearerToken, { resolve: () => real, allowedHeaders: BEARER_ALLOWED_HEADERS });
        }
    }
    if (provider.bearerTokenProvider !== undefined) {
        if (typeof provider.bearerTokenProvider !== "function") {
            throw new RemoteRuntimeError("REMOTE_RUNTIME_REFUSED", "remote model provider bearerTokenProvider must be a function");
        }
        const real = provider.bearerTokenProvider;
        const placeholder = tag("bearerTokenProvider");
        // The runtime still asks for a token per request; it gets the placeholder, and the worker substitutes a fresh real token.
        out.bearerTokenProvider = async () => placeholder;
        secrets.set(placeholder, { resolve: () => real(), allowedHeaders: BEARER_ALLOWED_HEADERS });
    }
    if (provider.headers !== undefined) {
        if (!isPlainRecord(provider.headers)) {
            throw new RemoteRuntimeError("REMOTE_RUNTIME_REFUSED", "remote model provider headers must be a plain object");
        }
        // Fixed request headers may carry credentials too; treat every value as one and pin it to that exact header name.
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(provider.headers)) {
            if (typeof value !== "string") {
                throw new RemoteRuntimeError("REMOTE_RUNTIME_REFUSED", `remote model provider header "${name}" must be a string`);
            }
            if (!value) continue;
            const lower = name.toLowerCase();
            const placeholder = tag(`header-${lower}`);
            headers[name] = placeholder;
            secrets.set(placeholder, { resolve: () => value, allowedHeaders: Object.freeze([lower]) });
        }
        out.headers = headers;
    }
    return { provider: out as T, secrets };
}

/** `localhost` (and its subdomains), `127.0.0.0/8` and `::1`: a model provider on the worker's own host. */
function isLoopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]") return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The grant for a session's model provider: its base URL pins the origin and path prefix. A provider config without a usable base URL gets no grant.
 * The URL must be `https:` (plain `http:` is accepted only for a loopback host), must not carry credentials, and must not carry query strings or fragments
 * (which could hold API keys such as `?api-key=` or `?code=` that would otherwise cross verbatim into the remote runtime).
 */
export function remoteSessionGrant(baseUrl: unknown, secrets: RemoteSecretMap): RemoteSessionGrant | null {
    if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
    let url: URL;
    try {
        url = new URL(baseUrl.trim());
    } catch {
        return null;
    }
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) return null;
    const pathPrefix = url.pathname.replace(/\/+$/, "") + "/";
    return { secrets, origin: url.origin, pathPrefix };
}

/** Whether a string still holds a worker placeholder (it must never leave the worker unswapped). */
export function containsWorkerPlaceholder(value: string): boolean {
    return value.includes(PLACEHOLDER_PREFIX);
}

function hasPathTraversal(rawPathname: string): boolean {
    if (/(^|\/)\.\.?(\/|$)|\\/.test(rawPathname)) return true;
    let decoded: string;
    try {
        decoded = decodeURIComponent(rawPathname);
    } catch {
        return true;
    }
    return /(^|\/)\.\.?(\/|$)|\\/.test(decoded) || /%2e|%2f|%5c/i.test(rawPathname);
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
    if (hasPathTraversal(url.pathname)) {
        throw new Error("refusing a model request outside this session's model provider path");
    }
    const pathname = url.pathname.replace(/\/+$/, "") + "/";
    if (!pathname.startsWith(grant.pathPrefix)) {
        throw new Error("refusing a model request outside this session's model provider path");
    }
    if (request.method !== "POST" && request.method !== "GET") {
        throw new Error(`refusing a model request with method ${request.method}`);
    }
}

/**
 * The request handler for a remote runtime. When constructed with `expectedSessionId`, it refuses any request whose runtime-reported `context.sessionId`
 * differs from the bound session (so a shared host cannot cross-access another bound session's grant). For each model request it checks the destination
 * against the session's grant, swaps placeholders strictly in their permitted headers, and forwards with redirects refused. WebSocket transports are refused.
 */
export class RemoteRuntimeRequestHandler extends ByokRequestCompatibility {
    constructor(
        private readonly grantFor: (sessionId: string | undefined) => RemoteSessionGrant | undefined,
        toolCatalog?: ConstructorParameters<typeof ByokRequestCompatibility>[0],
        private readonly expectedSessionId?: string,
    ) {
        super(toolCatalog);
    }

    protected override async sendRequest(request: Request, context: CopilotRequestContext): Promise<Response> {
        if (this.expectedSessionId !== undefined && context.sessionId !== this.expectedSessionId) {
            throw new Error("refusing a model request: session does not match this runtime's bound session");
        }
        const sessionId = this.expectedSessionId ?? context.sessionId;
        const grant = this.grantFor(sessionId);
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
        const lowerName = name.toLowerCase();
        let next = value;
        for (const [placeholder, entry] of secrets ?? []) {
            if (!next.includes(placeholder)) continue;
            if (!entry.allowedHeaders.includes(lowerName)) {
                throw new Error(`refusing a model request: credential placeholder is not allowed in header "${name}"`);
            }
            next = next.split(placeholder).join(await entry.resolve());
        }
        if (containsWorkerPlaceholder(next)) {
            throw new Error(`refusing a model request: header "${name}" holds a credential placeholder this worker cannot resolve`);
        }
        headers ??= new Headers(request.headers);
        headers.set(name, next);
    }
    return headers ? new Request(request, { headers }) : request;
}
