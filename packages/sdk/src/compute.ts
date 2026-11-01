/**
 * Compute providers and compute targets (docs/proposals/compute-providers.md).
 *
 * Terms:
 *   compute type      a kind of place a session's GHCP runtime can run
 *   compute provider  the worker plug-in for one compute type (`kind`)
 *   compute target    a registered instance of a compute type, stored in the
 *                     CMS; users pick one per session
 *   host              the concrete runtime a session tree is bound to
 *
 * The worker stays trusted: it keeps the orchestration, PilotSwarm tools,
 * model credentials and session state. A provider only places the GHCP
 * runtime somewhere and tells the worker how to reach it. Nothing here knows
 * about any particular platform; the built-in `local` provider is today's
 * behaviour, a runtime the worker starts as its own child process.
 */
import { createHash } from "node:crypto";
import { RuntimeConnection } from "@github/copilot-sdk";

export const LOCAL_COMPUTE_KIND = "local";

/** A compute target name: the same shape as a model provider name. */
export const COMPUTE_TARGET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/** A compute provider kind. */
export const COMPUTE_KIND_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const COMPUTE_ERROR_CODES = {
    INVALID: "COMPUTE_TARGET_INVALID",
    FORBIDDEN: "COMPUTE_TARGET_FORBIDDEN",
    NOT_FOUND: "COMPUTE_TARGET_NOT_FOUND",
    CONFLICT: "COMPUTE_TARGET_CONFLICT",
    DISABLED: "COMPUTE_TARGET_DISABLED",
    /** The worker has no provider for the target's kind. */
    KIND_UNKNOWN: "COMPUTE_KIND_UNKNOWN",
    /** bind or connect failed, or did not answer in time; may carry retryAfterMs. */
    UNAVAILABLE: "COMPUTE_UNAVAILABLE",
    /** The session cannot run on a remote target as configured (for example its model). */
    UNSUPPORTED: "COMPUTE_UNSUPPORTED",
    /** The provider returned a runtime address this worker does not accept. */
    ENDPOINT_REFUSED: "COMPUTE_ENDPOINT_REFUSED",
} as const;

export type ComputeTargetClass = "shared" | "personal";

/** A registered compute target, as the CMS stores it. `config` belongs to the provider of `kind`. */
export interface ComputeTarget {
    /** Never reused, unlike the name. */
    id: string;
    name: string;
    kind: string;
    class: ComputeTargetClass;
    ownerUserId: number | null;
    displayName: string | null;
    config: Record<string, unknown>;
    enabled: boolean;
}

/** Who acts: a signed-in principal, or none for system work. */
export interface ComputePrincipal {
    provider: string;
    subject: string;
    email?: string | null;
}

/** What a provider says about the hosts it creates. Descriptive; used for policy and display. */
export interface ComputeCapabilities {
    /** Operating systems of its hosts, as Node names them ("linux", "win32", "darwin", ...). */
    os: string[];
    /** Whether the host is an isolation boundary for model-chosen code. */
    sandboxed: boolean;
    /** How PilotSwarm tools in the worker reach the host's files. */
    files: "worker-local" | "shared-mount" | "provider-api" | "none";
}

/**
 * An opaque handle to a host. `id` is stable for the host's life;
 * `incarnation` changes whenever the host is replaced. The worker keeps it
 * in memory for the binding and never reads `data`.
 */
export interface ComputeHostRef {
    kind: string;
    id: string;
    incarnation: string;
    /** Provider-private details. */
    data?: Record<string, unknown>;
}

export type ComputeFailure = { ok: false; code: string; message: string; retryAfterMs?: number };

/** Every provider call carries a deadline; a provider should stop work when it fires. */
interface ComputeCall {
    signal: AbortSignal;
}

export interface ComputeValidateRequest extends ComputeCall {
    target: ComputeTarget;
    /** Who will use the target: the session tree's owner, or null for system sessions. */
    principal: ComputePrincipal | null;
}

export interface ComputeBindRequest extends ComputeCall {
    target: ComputeTarget;
    sessionId: string;
    /** The session tree: hosts are bound per (target, tree). */
    rootSessionId: string;
    owner: ComputePrincipal | null;
    workerNodeId: string;
}

/** Folders as the worker sees them; the provider maps them to the host. */
export interface ComputeWorkspacePaths {
    cwd?: string;
    additionalDirectories?: string[];
}

export interface ComputeConnectRequest extends ComputeCall {
    target: ComputeTarget;
    host: ComputeHostRef;
    sessionId: string;
    rootSessionId: string;
    workerNodeId: string;
    turnIndex: number;
    workspace: ComputeWorkspacePaths;
}

/**
 * How the worker reaches the GHCP runtime.
 *   local  the worker starts the runtime as its own child process (today)
 *   uri    a runtime already listening at `address` ("host:port" or a URL),
 *          reachable from the worker, with the token the runtime expects.
 *
 * The worker sends prompts, tool results and the token over this
 * connection, so by default it accepts only loopback addresses: a provider
 * that reaches a host elsewhere secures that path itself and hands back a
 * local address. A worker can opt in to other addresses
 * (`computeAllowNonLoopbackEndpoints`) when its network secures them.
 */
export type ComputeRuntimeEndpoint =
    | { transport: "local" }
    | { transport: "uri"; address: string; connectionToken?: string };

export type ComputeConnectResult =
    | {
        ok: true;
        endpoint: ComputeRuntimeEndpoint;
        /** The folders as the host sees them. */
        workspace: ComputeWorkspacePaths;
    }
    | ComputeFailure;

/**
 * Why a session leaves its host:
 *   ended    the session ended
 *   moved    the session left this worker and stays open
 *   evicted  the worker dropped the idle session
 *   shutdown the worker is shutting down
 *   failed   bind succeeded but the session could not use the host
 */
export type ComputeReleaseReason = "ended" | "moved" | "evicted" | "shutdown" | "failed";

export interface ComputeReleaseRequest extends ComputeCall {
    target: ComputeTarget;
    host: ComputeHostRef;
    sessionId: string;
    rootSessionId: string;
    workerNodeId: string;
    reason: ComputeReleaseReason;
}

/**
 * A compute provider: the worker plug-in for one compute type.
 *
 * Experimental: this interface may change before it is released.
 *
 * `validateTarget` runs before every bind: may this principal use what the
 * target's config points at? `bind` must be idempotent per (target, tree):
 * called again, it returns the same host while that host lives. `connect`
 * runs before every turn, possibly on another worker. `release` is best
 * effort and called once per session that leaves a host on this worker;
 * several sessions of a tree share a host, so a provider stops it only when
 * no session uses it. A worker can crash without releasing, so a provider
 * that holds costly hosts also needs its own expiry.
 *
 * Every call has a deadline (`signal`). A failure uses the workspace
 * provider shape (`code`, `message`, `retryAfterMs`); the turn then fails
 * and is retried like any failed turn.
 */
export interface ComputeProvider {
    readonly kind: string;
    readonly capabilities: ComputeCapabilities;
    validateTarget?(req: ComputeValidateRequest): Promise<{ ok: true } | ComputeFailure>;
    bind(req: ComputeBindRequest): Promise<{ ok: true; host: ComputeHostRef } | ComputeFailure>;
    connect(req: ComputeConnectRequest): Promise<ComputeConnectResult>;
    release?(req: ComputeReleaseRequest): Promise<void>;
}

/** The built-in provider: the runtime runs as the worker's child process, as today. */
export function createLocalComputeProvider(): ComputeProvider {
    return {
        kind: LOCAL_COMPUTE_KIND,
        capabilities: { os: [process.platform], sandboxed: false, files: "worker-local" },
        async bind(req) {
            return { ok: true, host: { kind: LOCAL_COMPUTE_KIND, id: req.workerNodeId, incarnation: req.workerNodeId } };
        },
        async connect(req) {
            return { ok: true, endpoint: { transport: "local" }, workspace: { ...req.workspace } };
        },
    };
}

/** The compute providers a worker has, by kind. `local` is always present. */
export class ComputeProviderRegistry {
    private readonly providers = new Map<string, ComputeProvider>();

    constructor(providers: ComputeProvider[] = []) {
        this.register(createLocalComputeProvider());
        for (const provider of providers) this.register(provider, { replace: provider.kind === LOCAL_COMPUTE_KIND });
    }

    register(provider: ComputeProvider, opts: { replace?: boolean } = {}): void {
        if (!provider || typeof provider.kind !== "string" || !COMPUTE_KIND_PATTERN.test(provider.kind)) {
            throw new Error(`compute provider kind must match ${COMPUTE_KIND_PATTERN}`);
        }
        if (typeof provider.bind !== "function" || typeof provider.connect !== "function") {
            throw new Error(`compute provider "${provider.kind}" must implement bind and connect`);
        }
        if (this.providers.has(provider.kind) && !opts.replace) {
            throw new Error(`compute provider "${provider.kind}" is registered twice`);
        }
        this.providers.set(provider.kind, provider);
    }

    get(kind: string): ComputeProvider | undefined {
        return this.providers.get(kind);
    }

    kinds(): string[] {
        return [...this.providers.keys()].sort();
    }
}

export function validateComputeTargetName(name: unknown): { ok: true; name: string } | ComputeFailure {
    if (typeof name !== "string" || !COMPUTE_TARGET_NAME_PATTERN.test(name.trim())) {
        return {
            ok: false,
            code: COMPUTE_ERROR_CODES.INVALID,
            message: "A compute target name uses letters, numbers, dot, dash and underscore (at most 64 characters) and starts with a letter or number.",
        };
    }
    return { ok: true, name: name.trim() };
}

/** The Copilot SDK connection for an endpoint. */
export function runtimeConnectionFor(endpoint: ComputeRuntimeEndpoint | undefined): RuntimeConnection {
    if (!endpoint || endpoint.transport === "local") return RuntimeConnection.forStdio();
    if (endpoint.transport === "uri") {
        if (typeof endpoint.address !== "string" || !endpoint.address.trim()) {
            throw new Error("a uri compute endpoint needs an address");
        }
        return RuntimeConnection.forUri(endpoint.address.trim(),
            endpoint.connectionToken ? { connectionToken: endpoint.connectionToken } : undefined);
    }
    throw new Error(`unknown compute transport "${(endpoint as { transport?: unknown }).transport}"`);
}

/**
 * A key for the client pool: one Copilot client per runtime connection.
 * It covers the address, the token, and the host and its incarnation, so a
 * replaced host or a rotated token gets a fresh client. The token itself is
 * never part of the key.
 */
export function runtimeEndpointKey(endpoint: ComputeRuntimeEndpoint | undefined, host?: ComputeHostRef): string {
    if (!endpoint || endpoint.transport === "local") return "";
    const digest = createHash("sha256")
        .update(JSON.stringify([endpoint.address, endpoint.connectionToken ?? "", host?.kind ?? "", host?.id ?? "", host?.incarnation ?? ""]))
        .digest("hex")
        .slice(0, 32);
    return `uri\0${digest}`;
}

/** Whether an endpoint address names this machine (localhost, 127.0.0.0/8 or ::1). */
export function isLoopbackAddress(address: string): boolean {
    let host = address.trim();
    try {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = new URL(host).hostname;
        else host = new URL(`tcp://${host}`).hostname;
    } catch {
        return false;
    }
    host = host.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
