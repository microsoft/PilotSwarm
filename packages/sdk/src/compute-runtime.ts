/**
 * Driving an agent runtime that runs outside the worker
 * (docs/proposals/compute-providers.md, "One remote turn").
 *
 * The worker stays the trusted side. Two pieces keep model credentials
 * there while the runtime runs on a compute host:
 *
 *   redactProviderSecrets       the model provider config sent to the runtime
 *                               carries placeholders, not keys
 *   RemoteRuntimeRequestHandler every model request the runtime makes comes
 *                               back through the worker, which swaps the
 *                               placeholders for the real credentials
 * Native state capture/import lives in the common host, not filesystem RPC.
 *
 * None of this depends on the compute type.
 */
import { randomBytes } from "node:crypto";
import type { CopilotRequestContext, CopilotWebSocketHandler } from "@github/copilot-sdk";
import { ByokRequestCompatibility } from "./copilot-client.js";

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
 * unique per session and per binding and cannot be guessed. A warm binding
 * may reuse stand-ins, but never its previous credential resolvers.
 */
export function redactProviderSecrets<T extends Record<string, any> | undefined>(
    provider: T,
    sessionId: string,
    providerName = "default",
    previousPlaceholders?: ReadonlyMap<string, string>,
): { provider: T; secrets: RemoteSecretMap; placeholders: Map<string, string> } {
    const secrets: RemoteSecretMap = new Map();
    const placeholders = new Map<string, string>();
    if (!provider) return { provider, secrets, placeholders };
    const out: Record<string, any> = { ...provider };
    const nonce = randomBytes(16).toString("hex");
    const tag = (field: string) => {
        const value = previousPlaceholders?.get(field) ?? `${PLACEHOLDER_PREFIX}-${field}-${sessionId}-${nonce}`;
        placeholders.set(field, value);
        return value;
    };
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
    return { provider: out as T, secrets, placeholders };
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
        private readonly admit?: (sessionId: string | undefined, operation: () => Promise<Response>) => Promise<Response>,
    ) {
        super(toolCatalog);
    }

    protected override async sendRequest(request: Request, context: CopilotRequestContext): Promise<Response> {
        const send = async () => {
            const grant = this.grantFor(context.sessionId);
            if (!grant) throw new Error("refusing a model request: no session on this runtime matches it");
            checkModelRequest(request, grant);
            const injected = await injectSecrets(request, grant.secrets);
            return super.sendRequest(new Request(injected, { redirect: "error" }), context);
        };
        return this.admit ? this.admit(context.sessionId, send) : send();
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
