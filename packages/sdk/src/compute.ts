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
    /** bind or connect failed; may carry retryAfterMs. */
    UNAVAILABLE: "COMPUTE_UNAVAILABLE",
} as const;

export type ComputeTargetClass = "shared" | "personal";

/** A registered compute target, as the CMS stores it. `config` belongs to the provider of `kind`. */
export interface ComputeTarget {
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
    os: Array<"linux" | "windows">;
    /** Whether the host is an isolation boundary for model-chosen code. */
    sandboxed: boolean;
    /** How PilotSwarm tools in the worker reach the host's files. */
    files: "worker-local" | "shared-mount" | "provider-api" | "none";
}

/** An opaque handle to a host. `id` is stable for the host's life; `incarnation` changes when it is replaced. */
export interface ComputeHostRef {
    kind: string;
    id: string;
    incarnation: string;
    /** Provider-private details; PilotSwarm stores and returns them unread. */
    data?: Record<string, unknown>;
}

export type ComputeFailure = { ok: false; code: string; message: string; retryAfterMs?: number };

export interface ComputeValidateRequest {
    config: Record<string, unknown>;
    class: ComputeTargetClass;
    registeredBy: ComputePrincipal | null;
}

export interface ComputeBindRequest {
    target: ComputeTarget;
    sessionId: string;
    /** The session tree: hosts are bound per tree. */
    rootSessionId: string;
    owner: ComputePrincipal | null;
    workerNodeId: string;
}

/** Folders as the worker sees them; the provider maps them to the host. */
export interface ComputeWorkspacePaths {
    cwd?: string;
    additionalDirectories?: string[];
}

export interface ComputeConnectRequest {
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
 *          reachable from the worker. A provider that needs a tunnel or a
 *          relay runs it and hands back a local address.
 */
export type ComputeRuntimeEndpoint =
    | { transport: "local" }
    | { transport: "uri"; address: string; connectionToken?: string };

export type ComputeConnectResult =
    | {
        ok: true;
        endpoint: ComputeRuntimeEndpoint;
        /** The folders as the host sees them. */
        workspace: ComputeWorkspacePaths & { convention?: "posix" | "windows" };
    }
    | ComputeFailure;

export interface ComputeHostState {
    phase: "pending" | "ready" | "stopped" | "failed" | "gone" | "unknown";
    detail?: string;
    observedAt: string;
}

/**
 * Why a host is released:
 *   ended    the session tree ended
 *   moved    the session left this worker and stays open
 *   evicted  the worker dropped the idle session
 *   shutdown the worker is shutting down
 */
export type ComputeReleaseReason = "ended" | "moved" | "evicted" | "shutdown";

/**
 * A compute provider: the worker plug-in for one compute type.
 *
 * `bind` runs once per session tree and must be idempotent: called again
 * for the same tree, it returns the same host while that host lives.
 * `connect` runs before every turn, possibly on another worker. Failures
 * use the workspace provider shape, so the same hold-and-retry applies.
 */
export interface ComputeProvider {
    readonly kind: string;
    readonly capabilities: ComputeCapabilities;
    /** At registration: is this config valid, and may the principal use what it points at? */
    validateTarget?(req: ComputeValidateRequest): Promise<{ ok: true } | ComputeFailure>;
    bind(req: ComputeBindRequest): Promise<{ ok: true; host: ComputeHostRef } | ComputeFailure>;
    connect(req: ComputeConnectRequest): Promise<ComputeConnectResult>;
    /** Trusted state from the host's own control plane. */
    hostState?(host: ComputeHostRef): Promise<ComputeHostState>;
    /**
     * Best effort. Called once per session that leaves the host; several
     * sessions of one tree can share a host, so a provider stops it only
     * when its last session has left.
     */
    release?(req: { host: ComputeHostRef; sessionId: string; reason: ComputeReleaseReason }): Promise<void>;
}

/** The built-in provider: the runtime runs as the worker's child process, as today. */
export function createLocalComputeProvider(): ComputeProvider {
    return {
        kind: LOCAL_COMPUTE_KIND,
        capabilities: { os: [process.platform === "win32" ? "windows" : "linux"], sandboxed: false, files: "worker-local" },
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

/** A stable key for a client pool: one Copilot client per runtime endpoint. */
export function runtimeEndpointKey(endpoint: ComputeRuntimeEndpoint | undefined): string {
    if (!endpoint || endpoint.transport === "local") return "";
    return `uri\0${endpoint.address}`;
}
