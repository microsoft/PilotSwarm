/**
 * Provider services: a compute provider that runs outside the worker
 * (docs/proposals/compute-providers.md, "Provider services and
 * registration").
 *
 * A real provider needs rights on whatever it makes hosts out of. Putting
 * that in every worker would spread those rights across the fleet, so a
 * provider runs as its own service instead, and the worker reaches it
 * through one generic adapter that holds no rights of its own and knows
 * nothing about any platform.
 *
 * An administrator registers each service first. The registration is the
 * trust anchor and says three things: where the service is, what identity
 * the worker must see from it, and which kinds it serves. Nothing secret
 * is registered: the credential the worker presents comes from a
 * deployment hook, never from the database.
 *
 * Both ends recognize each other on every call:
 *
 *   the worker recognizes the service   by the TLS identity the
 *                                       registration pins — an expected
 *                                       server name, a certificate
 *                                       fingerprint, or both. Anything
 *                                       else is refused before a request
 *                                       body is sent.
 *   the service recognizes PilotSwarm   by the credential the deployment's
 *                                       hook supplies on every request
 *                                       (`computeServiceCredentials`). The
 *                                       service checks it however its
 *                                       deployment agreed: a bearer token,
 *                                       a signed assertion, a client
 *                                       certificate. PilotSwarm does not
 *                                       prescribe one.
 *
 * The protocol is small, versioned in its path, and carries JSON:
 *
 *   POST /v1/describe       what this service serves
 *   POST /v1/validate       may this principal use this target?
 *   POST /v1/bind           a host for this session tree
 *   POST /v1/connect        how to reach it this turn
 *   POST /v1/release        this session no longer needs it here
 *   POST /v1/renew          PilotSwarm is still using it
 *   POST /v1/done           this session tree is finished with it
 *   POST /v1/describeHost   facts about a host, for its target
 *
 * Every request carries the protocol version, a deadline and which worker
 * is asking. Every refusal uses the same shape as an in-worker provider's
 * (`ComputeFailure`): a code, a message, and optionally how long to wait.
 *
 * `connect` answers with a per-binding handshake secret as well as the way
 * to the host. That secret is the only secret the protocol carries: it
 * lives in the worker's memory for the binding, is never written to the
 * CMS and must never be logged.
 */
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest, type ServerOptions as HttpsServerOptions } from "node:https";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import {
    COMPUTE_ERROR_CODES,
    type ComputeAdvertisement,
    type ComputeCapabilities,
    type ComputeFailure,
    type ComputeHostRef,
    type ComputePrincipal,
    type ComputeProvider,
    type ComputeReleaseReason,
    type ComputeTarget,
    type ComputeTransport,
    type ComputeWorkspacePaths,
} from "./compute.js";
import type { ComputeHandshakeCredential } from "./compute-handshake.js";
import { openComputeWebSocket, serveComputeWebSocket } from "./compute-websocket.js";

/** The protocol version this build speaks to a provider service. */
export const COMPUTE_SERVICE_PROTOCOL_VERSION = 1;
/** The path a `pipe` service serves its connections on. */
export const COMPUTE_SERVICE_PIPE_PATH = "/v1/pipe";
/** Deadlines, matching the worker's own provider-call deadlines. */
export const COMPUTE_SERVICE_CALL_TIMEOUT_MS = 2 * 60_000;
/** The most one answer may take, so a service cannot make a worker buffer. */
export const COMPUTE_SERVICE_MAX_ANSWER_BYTES = 1024 * 1024;

/** What identity a worker must see from a service, as the administrator registered it. */
export interface ComputeServiceIdentity {
    /** The TLS server name the certificate must be good for. */
    serverName?: string | null;
    /** Lowercase hex SHA-256 of the service's certificate, no separators. */
    certificateSha256?: string | null;
}

/** A registered provider service, as the CMS stores it. Holds nothing secret. */
export interface ComputeProviderService {
    /** Never reused, unlike the name. */
    id: string;
    name: string;
    /** `https:`, or `http:` only for a service on this machine (tests). */
    baseUrl: string;
    identity: ComputeServiceIdentity;
    enabled: boolean;
    /** What it last said it serves, and when it said so. */
    kinds: string[];
    transport: ComputeTransport;
    capabilities: ComputeCapabilities | null;
    protocolVersion: number | null;
    describedAt: string | null;
    registeredBy: number | null;
    createdAt?: string | null;
    updatedAt?: string | null;
}

/** What a service says about itself. */
export interface ComputeServiceDescription {
    protocolVersion: number;
    kinds: string[];
    transport: ComputeTransport;
    capabilities: ComputeCapabilities;
}

/**
 * How the deployment proves PilotSwarm to a service. Nothing is stored in
 * the CMS: the hook reaches whatever the deployment uses for machine
 * identity and returns request headers, per service and per call, so a
 * short-lived credential can be minted fresh.
 */
export type ComputeServiceCredentials =
    (service: Pick<ComputeProviderService, "id" | "name" | "baseUrl">) => Promise<{ headers: Record<string, string> }>;

/** A service that did not present the identity its registration pins. */
export class ComputeServiceIdentityError extends Error {
    readonly code = COMPUTE_ERROR_CODES.SERVICE_IDENTITY;
    constructor(message: string) {
        super(message);
        this.name = "ComputeServiceIdentityError";
    }
}

function normalizeFingerprint(value: unknown): string {
    return String(value ?? "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

function isLoopbackHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Check a base URL before anything is sent to it. `https:` everywhere; a
 * plain `http:` service is accepted only on this machine, which is what
 * the tests use and what nothing in a deployment should ever be.
 */
export function checkComputeServiceUrl(baseUrl: unknown): { ok: true; url: URL } | ComputeFailure {
    let url: URL;
    try {
        url = new URL(String(baseUrl ?? "").trim());
    } catch {
        return { ok: false, code: COMPUTE_ERROR_CODES.INVALID, message: "a provider service needs a URL" };
    }
    if (url.protocol === "https:") return { ok: true, url };
    if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return { ok: true, url };
    return {
        ok: false,
        code: COMPUTE_ERROR_CODES.INVALID,
        message: 'a provider service is reached over "https:"; plain "http:" is accepted only for a service on this machine',
    };
}

/**
 * Does the certificate a service presented match what the administrator
 * registered for it?
 *
 * Only reached when a fingerprint is pinned. A pinned certificate is the
 * identity, and the exact bytes are what is compared: a service with a
 * different certificate is a different service, however good that
 * certificate is and whoever signed it. A connection with no certificate
 * at all is refused for the same reason.
 */
export function checkComputeServiceCertificate(
    identity: ComputeServiceIdentity | null | undefined,
    peer: { fingerprint256?: string } | null | undefined,
    serviceName = "this provider service",
): { ok: true } | ComputeFailure {
    const pinned = normalizeFingerprint(identity?.certificateSha256);
    if (!pinned) return { ok: true };
    const got = normalizeFingerprint(peer?.fingerprint256);
    if (!got) {
        return {
            ok: false,
            code: COMPUTE_ERROR_CODES.SERVICE_IDENTITY,
            message: `the provider service "${serviceName}" presented no certificate, and this deployment has registered one for it`,
        };
    }
    if (got !== pinned) {
        return {
            ok: false,
            code: COMPUTE_ERROR_CODES.SERVICE_IDENTITY,
            message: `the provider service "${serviceName}" presented a certificate this deployment has not registered for it`,
        };
    }
    return { ok: true };
}

/**
 * The worker's end of the protocol: one client per registered service.
 *
 * Every call presents the deployment's credential and checks the service's
 * identity against the registration before it believes an answer. A
 * service that answers from a certificate the registration does not pin is
 * not that service, whatever it says.
 */
export class ComputeServiceClient {
    private readonly base: URL;

    constructor(
        private readonly service: ComputeProviderService,
        private readonly credentials: ComputeServiceCredentials | null,
        private readonly options: { timeoutMs?: number } = {},
    ) {
        const checked = checkComputeServiceUrl(service.baseUrl);
        if (!checked.ok) throw new Error(checked.message);
        this.base = checked.url;
    }

    get name(): string {
        return this.service.name;
    }

    private async headers(): Promise<Record<string, string>> {
        if (!this.credentials) return {};
        const supplied = await this.credentials({ id: this.service.id, name: this.service.name, baseUrl: this.service.baseUrl });
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(supplied?.headers ?? {})) {
            if (typeof value === "string") headers[key] = value;
        }
        return headers;
    }

    /** The TLS checks this service's registration pins. */
    private tlsOptions(): { servername?: string; rejectUnauthorized?: boolean } {
        const serverName = this.service.identity?.serverName?.trim();
        const pinned = normalizeFingerprint(this.service.identity?.certificateSha256);
        return {
            ...(serverName ? { servername: serverName } : {}),
            // With a certificate pinned, that exact certificate is the
            // identity and is checked below on the live socket. Without
            // one, ordinary TLS validation is the identity.
            ...(pinned ? { rejectUnauthorized: false } : {}),
        };
    }

    /**
     * Watch the TLS socket and refuse a certificate the registration does
     * not pin, before any answer is read.
     */
    private pinCertificate(socket: TLSSocket, fail: (error: Error) => void): void {
        if (!normalizeFingerprint(this.service.identity?.certificateSha256)) return;
        socket.on("secureConnect", () => {
            const checked = checkComputeServiceCertificate(
                this.service.identity, socket.getPeerCertificate(), this.service.name);
            if (!checked.ok) {
                const error = new ComputeServiceIdentityError(checked.message);
                fail(error);
                socket.destroy(error);
            }
        });
    }

    /** One call. Throws a coded error; a provider's own refusal comes back as a value. */
    async call<T>(op: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
        const timeoutMs = this.options.timeoutMs ?? COMPUTE_SERVICE_CALL_TIMEOUT_MS;
        const headers = await this.headers();
        const payload = Buffer.from(JSON.stringify({
            protocolVersion: COMPUTE_SERVICE_PROTOCOL_VERSION,
            op,
            deadlineMs: timeoutMs,
            ...body,
        }), "utf8");
        const secure = this.base.protocol === "https:";
        const path = `${this.base.pathname.replace(/\/+$/, "")}/v1/${op}`;
        return new Promise<T>((resolve, reject) => {
            let identityFailure: Error | null = null;
            const send = secure ? httpsRequest : httpRequest;
            const req = send({
                protocol: this.base.protocol,
                hostname: this.base.hostname,
                port: this.base.port || (secure ? 443 : 80),
                path,
                method: "POST",
                headers: {
                    ...headers,
                    "content-type": "application/json",
                    "content-length": String(payload.length),
                },
                ...(secure ? this.tlsOptions() : {}),
            });
            let settled = false;
            const give = (error: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { req.destroy(); } catch { /* already gone */ }
                reject(identityFailure ?? error);
            };
            const timer = setTimeout(() => give(Object.assign(
                new Error(`the provider service "${this.service.name}" did not answer ${op} within ${timeoutMs} ms`),
                { code: COMPUTE_ERROR_CODES.SERVICE_UNAVAILABLE, retryAfterMs: 5_000 })), timeoutMs);
            signal?.addEventListener("abort", () => give(new Error(`the call to "${this.service.name}" was abandoned`)), { once: true });
            if (secure) req.on("socket", (socket) => this.pinCertificate(socket as TLSSocket, (error) => { identityFailure = error; }));
            req.on("error", (error) => give(Object.assign(
                new Error(`the provider service "${this.service.name}" could not be reached: ${error.message}`),
                { code: COMPUTE_ERROR_CODES.SERVICE_UNAVAILABLE, retryAfterMs: 5_000 })));
            req.on("response", (res: IncomingMessage) => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > COMPUTE_SERVICE_MAX_ANSWER_BYTES) {
                        give(Object.assign(new Error(`the provider service "${this.service.name}" answered ${op} with more than this worker reads`),
                            { code: COMPUTE_ERROR_CODES.SERVICE_UNAVAILABLE }));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on("end", () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    const text = Buffer.concat(chunks).toString("utf8");
                    if ((res.statusCode ?? 0) >= 400) {
                        reject(Object.assign(
                            new Error(`the provider service "${this.service.name}" refused ${op} (${res.statusCode}): ${text.slice(0, 300)}`),
                            { code: COMPUTE_ERROR_CODES.SERVICE_UNAVAILABLE }));
                        return;
                    }
                    try {
                        resolve(JSON.parse(text) as T);
                    } catch {
                        reject(Object.assign(new Error(`the provider service "${this.service.name}" answered ${op} with something unreadable`),
                            { code: COMPUTE_ERROR_CODES.SERVICE_UNAVAILABLE }));
                    }
                });
            });
            req.end(payload);
        });
    }

    /** Open a connection the service's `connect` named, with the same credentials. */
    async openPipe(url: string, signal: AbortSignal): Promise<Duplex> {
        const headers = await this.headers();
        return openComputeWebSocket(url, {
            headers,
            tls: this.tlsOptions(),
            signal,
        });
    }

    describe(signal?: AbortSignal): Promise<ComputeServiceDescription> {
        return this.call<ComputeServiceDescription>("describe", {}, signal);
    }
}

/** What crosses the wire for a target: everything its provider owns, nothing internal. */
function wireTarget(target: ComputeTarget): Record<string, unknown> {
    return {
        id: target.id,
        name: target.name,
        kind: target.kind,
        class: target.class,
        displayName: target.displayName ?? null,
        config: target.config ?? {},
        enabled: target.enabled !== false,
    };
}

function wirePrincipal(principal: ComputePrincipal | null): Record<string, unknown> | null {
    return principal ? { provider: principal.provider, subject: principal.subject, email: principal.email ?? null } : null;
}

function failure(code: string, message: string, retryAfterMs?: number): ComputeFailure {
    return { ok: false, code, message, ...(retryAfterMs ? { retryAfterMs } : {}) };
}

/** Whatever a service answered, as a failure this worker can act on. */
function asFailure(answer: unknown, service: string, op: string): ComputeFailure | null {
    if (!answer || typeof answer !== "object") {
        return failure(COMPUTE_ERROR_CODES.SERVICE_UNAVAILABLE, `the provider service "${service}" answered ${op} with something unreadable`);
    }
    const value = answer as Record<string, unknown>;
    if (value.ok === true) return null;
    const code = typeof value.code === "string" && value.code.startsWith("COMPUTE_") ? value.code : COMPUTE_ERROR_CODES.UNAVAILABLE;
    const message = typeof value.message === "string" && value.message.trim()
        ? value.message.trim()
        : `the provider service "${service}" refused ${op}`;
    const retryAfterMs = typeof value.retryAfterMs === "number" && value.retryAfterMs > 0 ? value.retryAfterMs : undefined;
    return failure(code, message, retryAfterMs);
}

function wireHandshake(value: unknown): ComputeHandshakeCredential | undefined {
    if (!value || typeof value !== "object") return undefined;
    const { bindingId, secret } = value as Record<string, unknown>;
    if (typeof bindingId !== "string" || !bindingId.trim() || typeof secret !== "string" || !secret) return undefined;
    return { bindingId: bindingId.trim(), secret };
}

/**
 * The built-in adapter: one `ComputeProvider` per kind a registered
 * service serves, forwarding every call to that service.
 *
 * It is entirely generic. It holds no rights, knows no platform, and reads
 * nothing a service sends except the shapes the protocol defines. A
 * service's `connect` answer decides how its hosts are reached, and the
 * two ways it may answer are the two transports: an address PilotSwarm
 * connects to, or a URL PilotSwarm opens a connection on.
 */
export function createRemoteComputeProvider(
    service: ComputeProviderService,
    kind: string,
    client: ComputeServiceClient,
): ComputeProvider {
    const transport: ComputeTransport = service.transport === "pipe" ? "pipe" : "direct";
    const capabilities: ComputeCapabilities = service.capabilities ?? { os: [], sandboxed: true, files: "none" };
    const base: ComputeProvider = {
        kind,
        capabilities,
        ...(transport === "pipe" ? { transport: "pipe" as const } : {}),

        async validateTarget(req) {
            const answer = await client.call<Record<string, unknown>>("validate", {
                target: wireTarget(req.target),
                principal: wirePrincipal(req.principal),
            }, req.signal);
            return asFailure(answer, service.name, "validate") ?? { ok: true };
        },

        async bind(req) {
            const answer = await client.call<Record<string, unknown>>("bind", {
                target: wireTarget(req.target),
                sessionId: req.sessionId,
                rootSessionId: req.rootSessionId,
                owner: wirePrincipal(req.owner),
                workerNodeId: req.workerNodeId,
            }, req.signal);
            const refused = asFailure(answer, service.name, "bind");
            if (refused) return refused;
            const host = (answer as { host?: unknown }).host as ComputeHostRef | undefined;
            if (!host || typeof host.id !== "string" || typeof host.incarnation !== "string") {
                return failure(COMPUTE_ERROR_CODES.SERVICE_UNAVAILABLE, `the provider service "${service.name}" bound a host it did not name`);
            }
            return { ok: true, host: { ...host, kind } };
        },

        async connect(req) {
            const answer = await client.call<Record<string, unknown>>("connect", {
                target: wireTarget(req.target),
                host: req.host,
                sessionId: req.sessionId,
                rootSessionId: req.rootSessionId,
                workerNodeId: req.workerNodeId,
                turnIndex: req.turnIndex,
                workspace: req.workspace,
            }, req.signal);
            const refused = asFailure(answer, service.name, "connect");
            if (refused) return refused;
            const endpoint = (answer as { endpoint?: Record<string, unknown> }).endpoint ?? {};
            const workspace = ((answer as { workspace?: ComputeWorkspacePaths }).workspace ?? {}) as ComputeWorkspacePaths;
            const connectionToken = typeof endpoint.connectionToken === "string" ? endpoint.connectionToken : undefined;
            const handshake = wireHandshake(endpoint.handshake);
            if (transport === "pipe") {
                const url = typeof endpoint.url === "string" ? endpoint.url.trim() : "";
                if (!url) {
                    return failure(COMPUTE_ERROR_CODES.SERVICE_UNAVAILABLE,
                        `the provider service "${service.name}" opens its own connections but named none for this host`);
                }
                return {
                    ok: true,
                    endpoint: {
                        transport: "pipe",
                        details: { url },
                        ...(connectionToken ? { connectionToken } : {}),
                        ...(handshake ? { handshake } : {}),
                    },
                    workspace,
                };
            }
            const address = typeof endpoint.address === "string" ? endpoint.address.trim() : "";
            if (!address) {
                return failure(COMPUTE_ERROR_CODES.SERVICE_UNAVAILABLE,
                    `the provider service "${service.name}" returned no address for this host`);
            }
            return {
                ok: true,
                endpoint: {
                    transport: "uri",
                    address,
                    ...(connectionToken ? { connectionToken } : {}),
                    ...(handshake ? { handshake } : {}),
                },
                workspace,
            };
        },

        async describeHost(req) {
            const answer = await client.call<Record<string, unknown>>("describeHost", {
                target: wireTarget(req.target),
                host: req.host,
            }, req.signal);
            const advertisement = (answer as { advertisement?: ComputeAdvertisement })?.advertisement;
            const { models: _dropped, ...rest } = (advertisement ?? {}) as ComputeAdvertisement;
            return rest;
        },

        async release(req) {
            await client.call("release", {
                target: wireTarget(req.target),
                host: req.host,
                sessionId: req.sessionId,
                rootSessionId: req.rootSessionId,
                workerNodeId: req.workerNodeId,
                reason: req.reason satisfies ComputeReleaseReason,
            }, req.signal).catch(() => { /* best effort, as release always is */ });
        },

        async renew(req) {
            const answer = await client.call<Record<string, unknown>>("renew", {
                target: wireTarget(req.target),
                host: req.host,
                rootSessionId: req.rootSessionId,
                workerNodeId: req.workerNodeId,
                leaseMs: req.leaseMs,
            }, req.signal);
            return asFailure(answer, service.name, "renew") ?? { ok: true };
        },

        async done(req) {
            const answer = await client.call<Record<string, unknown>>("done", {
                target: wireTarget(req.target),
                host: req.host,
                rootSessionId: req.rootSessionId,
                workerNodeId: req.workerNodeId,
                reason: req.reason,
            }, req.signal);
            return asFailure(answer, service.name, "done") ?? { ok: true };
        },
    };
    if (transport !== "pipe") return base;
    return {
        ...base,
        async openConnection(req) {
            const url = typeof req.details.url === "string" ? req.details.url : "";
            return client.openPipe(url, req.signal);
        },
    };
}

/**
 * A stand-in for a kind whose service could not be reached, or did not
 * present the identity its registration pins.
 *
 * Without it the worker would simply have no provider for the kind, and a
 * session on one of its targets would be told "this worker has no provider
 * of kind x" — true, and useless. With it the turn fails saying which
 * service is the trouble and what sort of trouble it is.
 */
export function createUnreachableComputeProvider(
    serviceName: string,
    kind: string,
    reason: { code: string; message: string },
): ComputeProvider {
    const refuse = async (): Promise<ComputeFailure> => failure(
        reason.code,
        `the compute provider service "${serviceName}" is not usable: ${reason.message}`,
        reason.code === COMPUTE_ERROR_CODES.SERVICE_UNAVAILABLE ? 30_000 : undefined);
    return {
        kind,
        capabilities: { os: [], sandboxed: true, files: "none" },
        validateTarget: refuse,
        bind: refuse,
        connect: refuse,
    };
}

/**
 * Build the worker's provider for every kind the registered services
 * serve: ask each service what it serves, record the answer, and make one
 * adapter per kind. A service that will not answer, or answers from an
 * identity the registration does not pin, contributes refusing stand-ins
 * for the kinds it last said it served, so its targets fail clearly
 * instead of silently having no provider.
 */
export async function buildComputeServiceProviders(
    services: ComputeProviderService[],
    options: {
        credentials: ComputeServiceCredentials | null;
        describeTimeoutMs?: number;
        recordDescription?: (serviceId: string, described: ComputeServiceDescription) => Promise<unknown>;
        onProblem?: (service: ComputeProviderService, error: Error) => void;
    },
): Promise<ComputeProvider[]> {
    const built: ComputeProvider[] = [];
    for (const service of services) {
        if (!service.enabled) continue;
        let client: ComputeServiceClient;
        try {
            client = new ComputeServiceClient(service, options.credentials,
                { timeoutMs: options.describeTimeoutMs ?? COMPUTE_SERVICE_CALL_TIMEOUT_MS });
        } catch (error) {
            options.onProblem?.(service, error as Error);
            for (const kind of service.kinds) {
                built.push(createUnreachableComputeProvider(service.name, kind,
                    { code: COMPUTE_ERROR_CODES.SERVICE_INVALID, message: String((error as Error)?.message ?? error) }));
            }
            continue;
        }
        let described: ComputeServiceDescription | null = null;
        try {
            described = await client.describe();
            if (described?.protocolVersion !== COMPUTE_SERVICE_PROTOCOL_VERSION) {
                throw new Error(`it speaks protocol version ${String(described?.protocolVersion)}, this worker speaks ${COMPUTE_SERVICE_PROTOCOL_VERSION}`);
            }
            await options.recordDescription?.(service.id, described);
        } catch (error) {
            options.onProblem?.(service, error as Error);
            const code = (error as { code?: string })?.code === COMPUTE_ERROR_CODES.SERVICE_IDENTITY
                ? COMPUTE_ERROR_CODES.SERVICE_IDENTITY
                : COMPUTE_ERROR_CODES.SERVICE_UNAVAILABLE;
            for (const kind of service.kinds) {
                built.push(createUnreachableComputeProvider(service.name, kind,
                    { code, message: String((error as Error)?.message ?? error) }));
            }
            continue;
        }
        const current: ComputeProviderService = {
            ...service,
            kinds: described.kinds ?? [],
            transport: described.transport === "pipe" ? "pipe" : "direct",
            capabilities: described.capabilities ?? null,
            protocolVersion: described.protocolVersion,
        };
        for (const kind of current.kinds) {
            built.push(createRemoteComputeProvider(current, kind, client));
        }
    }
    return built;
}

/**
 * Serve an in-process `ComputeProvider` as a provider service, for the
 * people writing providers and for the tests that drive one end to end.
 *
 * It is the other half of the protocol, written once so a provider author
 * does not have to: give it a provider and how to recognize PilotSwarm,
 * and it answers everything the worker's adapter asks. A provider that
 * opens its own connections is served over a WebSocket at
 * `/v1/pipe`, with the same credential check as every other call.
 */
export interface ServeComputeProviderOptions {
    /**
     * How this service recognizes PilotSwarm. It sees the request headers
     * the deployment's hook filled in, and says whether to go on. There is
     * no default: a service with no check would serve anyone.
     */
    auth: (headers: Record<string, string | string[] | undefined>) => boolean | Promise<boolean>;
    /** TLS for the service. Without it the service serves plain HTTP, for tests on one machine. */
    tls?: HttpsServerOptions;
    host?: string;
    port?: number;
    /** What a lease the service grants is worth, in milliseconds, when it grants one. */
    leaseMs?: number;
}

export interface ComputeProviderServiceHandle {
    /** Where the service listens, as a base URL. */
    readonly baseUrl: string;
    readonly port: number;
    /** The calls it has answered, by operation. Diagnostics and tests. */
    readonly calls: Readonly<Record<string, number>>;
    close(): Promise<void>;
}

export async function serveComputeProvider(
    provider: ComputeProvider,
    options: ServeComputeProviderOptions,
): Promise<ComputeProviderServiceHandle> {
    const transport: ComputeTransport = provider.transport ?? "direct";
    const calls: Record<string, number> = {};
    // What an open connection needs, kept here rather than handed to the
    // worker: the worker gets an opaque ticket in the URL and nothing else.
    const tickets = new Map<string, { target: ComputeTarget; host: ComputeHostRef; details: Record<string, unknown> }>();
    const server: Server = options.tls
        ? createHttpsServer(options.tls)
        : createHttpServer();

    const deadline = (body: Record<string, unknown>): AbortSignal => {
        const ms = typeof body.deadlineMs === "number" && body.deadlineMs > 0 ? body.deadlineMs : COMPUTE_SERVICE_CALL_TIMEOUT_MS;
        return AbortSignal.timeout(ms);
    };

    async function handle(op: string, body: Record<string, unknown>): Promise<unknown> {
        calls[op] = (calls[op] ?? 0) + 1;
        const signal = deadline(body);
        const target = body.target as ComputeTarget;
        const host = body.host as ComputeHostRef;
        switch (op) {
            case "describe":
                return {
                    protocolVersion: COMPUTE_SERVICE_PROTOCOL_VERSION,
                    kinds: [provider.kind],
                    transport,
                    capabilities: provider.capabilities,
                };
            case "validate":
                return provider.validateTarget
                    ? await provider.validateTarget({ target, principal: (body.principal ?? null) as ComputePrincipal | null, signal })
                    : { ok: true };
            case "bind":
                return await provider.bind({
                    target,
                    sessionId: String(body.sessionId ?? ""),
                    rootSessionId: String(body.rootSessionId ?? ""),
                    owner: (body.owner ?? null) as ComputePrincipal | null,
                    workerNodeId: String(body.workerNodeId ?? ""),
                    signal,
                });
            case "connect": {
                const connected = await provider.connect({
                    target, host,
                    sessionId: String(body.sessionId ?? ""),
                    rootSessionId: String(body.rootSessionId ?? ""),
                    workerNodeId: String(body.workerNodeId ?? ""),
                    turnIndex: Number(body.turnIndex ?? 0),
                    workspace: (body.workspace ?? {}) as ComputeWorkspacePaths,
                    signal,
                });
                if (!connected.ok) return connected;
                const { endpoint, workspace } = connected;
                if (endpoint.transport === "pipe") {
                    const ticket = randomUUID();
                    tickets.set(ticket, { target, host, details: endpoint.details ?? {} });
                    return {
                        ok: true,
                        endpoint: {
                            transport: "pipe",
                            url: `${baseUrl().replace(/^http/, "ws")}${COMPUTE_SERVICE_PIPE_PATH}?c=${ticket}`,
                            ...(endpoint.connectionToken ? { connectionToken: endpoint.connectionToken } : {}),
                            ...(endpoint.handshake ? { handshake: endpoint.handshake } : {}),
                        },
                        workspace,
                    };
                }
                if (endpoint.transport === "local") {
                    return failure(COMPUTE_ERROR_CODES.UNSUPPORTED,
                        "a provider served as a service cannot answer with a runtime inside the worker");
                }
                return {
                    ok: true,
                    endpoint: {
                        transport: "direct",
                        address: endpoint.address,
                        ...(endpoint.connectionToken ? { connectionToken: endpoint.connectionToken } : {}),
                        ...(endpoint.handshake ? { handshake: endpoint.handshake } : {}),
                    },
                    workspace,
                };
            }
            case "describeHost":
                return {
                    ok: true,
                    advertisement: provider.describeHost ? await provider.describeHost({ target, host, signal }) : {},
                };
            case "release":
                for (const [ticket, held] of tickets) {
                    if (held.host.id === host?.id && held.host.incarnation === host?.incarnation) tickets.delete(ticket);
                }
                await provider.release?.({
                    target, host,
                    sessionId: String(body.sessionId ?? ""),
                    rootSessionId: String(body.rootSessionId ?? ""),
                    workerNodeId: String(body.workerNodeId ?? ""),
                    reason: String(body.reason ?? "ended") as ComputeReleaseReason,
                    signal,
                });
                return { ok: true };
            case "renew":
                return provider.renew
                    ? await provider.renew({
                        target, host,
                        rootSessionId: String(body.rootSessionId ?? ""),
                        workerNodeId: String(body.workerNodeId ?? ""),
                        leaseMs: Number(body.leaseMs ?? options.leaseMs ?? 0),
                        signal,
                    })
                    : { ok: true };
            case "done":
                return provider.done
                    ? await provider.done({
                        target, host,
                        rootSessionId: String(body.rootSessionId ?? ""),
                        workerNodeId: String(body.workerNodeId ?? ""),
                        reason: String(body.reason ?? "ended") as "ended" | "deleted",
                        signal,
                    })
                    : { ok: true };
            default:
                return failure(COMPUTE_ERROR_CODES.UNSUPPORTED, `this provider service does not serve "${op}"`);
        }
    }

    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
            const path = (req.url ?? "").split("?")[0];
            const match = /^\/v1\/([a-zA-Z]+)$/.exec(path);
            if (req.method !== "POST" || !match) {
                res.writeHead(404).end();
                return;
            }
            if (!await Promise.resolve(options.auth(req.headers)).catch(() => false)) {
                res.writeHead(401, { "content-type": "application/json" })
                    .end(JSON.stringify({ ok: false, code: COMPUTE_ERROR_CODES.FORBIDDEN, message: "this provider service does not recognize the caller" }));
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of req) {
                size += (chunk as Buffer).length;
                if (size > COMPUTE_SERVICE_MAX_ANSWER_BYTES) {
                    res.writeHead(413).end();
                    return;
                }
                chunks.push(chunk as Buffer);
            }
            let body: Record<string, unknown>;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
            } catch {
                res.writeHead(400, { "content-type": "application/json" })
                    .end(JSON.stringify(failure(COMPUTE_ERROR_CODES.INVALID, "the request is not readable")));
                return;
            }
            if (body.protocolVersion !== COMPUTE_SERVICE_PROTOCOL_VERSION) {
                res.writeHead(400, { "content-type": "application/json" })
                    .end(JSON.stringify(failure(COMPUTE_ERROR_CODES.UNSUPPORTED,
                        `this provider service speaks protocol version ${COMPUTE_SERVICE_PROTOCOL_VERSION}`)));
                return;
            }
            let answer: unknown;
            try {
                answer = await handle(match[1], body);
            } catch (error) {
                answer = failure(COMPUTE_ERROR_CODES.UNAVAILABLE, String((error as Error)?.message ?? error), 5_000);
            }
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
        })().catch(() => { try { res.writeHead(500).end(); } catch { /* already answered */ } });
    });

    if (transport === "pipe") {
        serveComputeWebSocket(server, {
            path: COMPUTE_SERVICE_PIPE_PATH,
            authorize: (req) => options.auth(req.headers),
            onConnection: async (stream, req) => {
                const ticket = new URL(req.url ?? "", "http://service.invalid").searchParams.get("c") ?? "";
                const held = tickets.get(ticket);
                if (!held || typeof provider.openConnection !== "function") {
                    stream.destroy(new Error("this connection is not one this service opened"));
                    return;
                }
                try {
                    const pipe = await provider.openConnection({
                        target: held.target, host: held.host, details: held.details,
                        signal: AbortSignal.timeout(COMPUTE_SERVICE_CALL_TIMEOUT_MS),
                    });
                    const close = () => { stream.destroy(); pipe.destroy(); };
                    stream.on("error", close);
                    pipe.on("error", close);
                    stream.on("close", close);
                    pipe.on("close", close);
                    stream.pipe(pipe);
                    pipe.pipe(stream);
                } catch (error) {
                    stream.destroy(error as Error);
                }
            },
        });
    }

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen({ host: options.host ?? "127.0.0.1", port: options.port ?? 0 }, () => {
            server.removeListener("error", onError);
            resolve();
        });
    });
    server.on("error", () => { /* surfaced through the calls */ });
    const bound = server.address() as AddressInfo;
    const scheme = options.tls ? "https" : "http";
    const baseUrl = () => `${scheme}://${options.host ?? "127.0.0.1"}:${bound.port}`;

    return {
        get baseUrl() { return baseUrl(); },
        get port() { return bound.port; },
        get calls() { return { ...calls }; },
        async close() {
            tickets.clear();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
