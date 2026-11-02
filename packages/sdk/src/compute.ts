/**
 * Compute providers and compute targets (docs/proposals/compute-providers.md).
 *
 * Terms:
 *   compute type      a kind of place a session's agent runtime can run
 *   compute provider  the worker plug-in for one compute type (`kind`)
 *   compute target    a registered instance of a compute type, stored in the
 *                     CMS; users pick one per session
 *   host              the concrete runtime a session tree is bound to
 *
 * The worker stays trusted: it keeps the orchestration, PilotSwarm tools,
 * model credentials and session state. A provider only places the agent
 * runtime somewhere and tells the worker how to reach it. Nothing here knows
 * about any particular platform; the built-in `local` provider is today's
 * behaviour, a runtime the worker starts as its own child process.
 */
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { RuntimeConnection } from "@github/copilot-sdk";
import { COMPUTE_HANDSHAKE_FAILED, type ComputeHandshakeCredential } from "./compute-handshake.js";

export const LOCAL_COMPUTE_KIND = "local";

/**
 * The part of a target's name the administrator registering it chooses.
 * Kept deliberately plain: it ends up in URLs.
 */
export const COMPUTE_TARGET_LABEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/**
 * A full compute target name, `<owner>/<label>`.
 *
 * Every target is named after whoever it belongs to. Today that is always
 * the reserved word `shared`: a target an administrator registers for
 * everyone. PilotSwarm builds the owner part itself; a registrant supplies
 * only the label. Keeping the owner part in the name now means a later
 * change can add targets with another owner without renaming anything.
 *
 * The owner part allows no slash, which separates the two parts.
 */
export const COMPUTE_TARGET_OWNER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._%+@-]{0,126}$/;
export const COMPUTE_TARGET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._%+@-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/** The owner part of every target an administrator registers for everyone. */
export const SHARED_COMPUTE_TARGET_OWNER = "shared";
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
    /**
     * The worker and the host did not prove to each other that they hold
     * this binding's secret, or the provider gave the worker no secret to
     * prove it with. Nothing of the session crossed the connection.
     */
    HANDSHAKE_FAILED: COMPUTE_HANDSHAKE_FAILED,
} as const;

export type ComputeTargetClass = "shared";

/** A registered compute target, as the CMS stores it. `config` belongs to the provider of `kind`. */
export interface ComputeTarget {
    /** Never reused, unlike the name. */
    id: string;
    name: string;
    kind: string;
    class: ComputeTargetClass;
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

/**
 * What a provider says about the hosts it creates. Fixed in provider code,
 * the same for every target of that kind.
 *
 * One field, because one field is all PilotSwarm acts on: whether the worker
 * may let a remote session's file tools reach the worker's own folders.
 * Anything else a provider wants to say about its hosts belongs where it is
 * used, not here.
 */
export interface ComputeCapabilities {
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

export type ComputeFailure = {
    ok: false;
    code: string;
    message: string;
    retryAfterMs?: number;
};

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
 * How the worker reaches the agent runtime.
 *   local  the worker starts the runtime as its own child process (today)
 *   uri    a runtime already listening at `address` ("host:port" or a URL),
 *          reachable from the worker, with the token the runtime expects.
 *   pipe   the provider opens the connection itself (`openConnection`); the
 *          worker puts a bridge on this machine in front of it and talks to
 *          that. `details` is whatever the provider needs to open it again,
 *          and the worker never reads it.
 *
 * The worker sends prompts, tool results and the token over this
 * connection, so for `uri` it accepts only loopback addresses by default: a
 * provider that reaches a host elsewhere secures that path itself and hands
 * back a local address. A worker can opt in to other addresses
 * (`computeAllowNonLoopbackEndpoints`) when its network secures them. A
 * `pipe` endpoint satisfies that rule by construction — its bridge only
 * ever listens on this machine.
 *
 * Both remote transports carry `handshake`: this binding's id and secret,
 * which the worker uses to prove itself to the host component and to make
 * the host prove itself back, over every connection, before anything of
 * the session crosses. The secret is fresh for every new binding, held
 * only in the worker's memory, and never stored or logged. A remote
 * endpoint without one cannot be used (COMPUTE_HANDSHAKE_FAILED).
 */
export type ComputeRuntimeEndpoint =
    | { transport: "local" }
    | { transport: "uri"; address: string; connectionToken?: string; handshake?: ComputeHandshakeCredential }
    | { transport: "pipe"; connectionToken?: string; details?: Record<string, unknown>; handshake?: ComputeHandshakeCredential };

export type ComputeConnectResult =
    | {
        ok: true;
        endpoint: ComputeRuntimeEndpoint;
        /** The folders as the host sees them. */
        workspace: ComputeWorkspacePaths;
    }
    | ComputeFailure;

/**
 * How a provider's hosts are reached. One per provider, fixed in provider
 * code: a host never chooses, and a target never carries transport code.
 *
 *   direct  the host is reachable at an address and the worker connects to
 *           it itself. The provider writes no transport code; `connect`
 *           returns a `uri` endpoint.
 *   pipe    the provider opens the connection itself, in `openConnection`.
 *           `connect` returns a `pipe` endpoint: the host's folders and
 *           whatever opaque details opening it needs, never an address.
 */
export type ComputeTransport = "direct" | "pipe";

/** What `openConnection` must hand back: a two-way byte stream to one host's runtime. */
export type ComputePipe = Duplex;

export interface ComputeOpenConnectionRequest extends ComputeCall {
    target: ComputeTarget;
    host: ComputeHostRef;
    /** Exactly what this host's `connect` put on its endpoint. */
    details: Record<string, unknown>;
}

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
 * runs before every turn, possibly on another worker.
 *
 * `release` says PilotSwarm no longer needs this host for this session. It
 * never means stop or destroy it: what happens to a host nobody needs is
 * the provider's decision alone — keep it, clean it and hold it ready for
 * the next workload, or discard it and make a fresh one. It is best effort
 * and called once per session that leaves a host on this worker, and
 * several sessions of a tree share a host, so a host is only free of
 * PilotSwarm once no session uses it. A worker can crash without
 * releasing, so a provider also needs its own expiry.
 *
 * A host may take a new workload only with nothing left over from an
 * earlier one — files, logins, running processes, secrets. That is the
 * provider's guarantee to make.
 *
 * Every call has a deadline (`signal`). A failure uses the workspace
 * provider shape (`code`, `message`, `retryAfterMs`); the turn then fails
 * and is retried like any failed turn.
 */
export interface ComputeProvider {
    readonly kind: string;
    readonly capabilities: ComputeCapabilities;
    /**
     * How this provider's hosts are reached. One way, for every host it
     * ever makes. Absent means `direct`, which is what the built-in
     * providers do. A provider that says `pipe` must have
     * `openConnection`, and one that says `direct` must not: the registry
     * refuses anything else, so the worker never has to guess.
     */
    readonly transport?: ComputeTransport;
    /**
     * Open a connection to one host's runtime. Only for a `pipe` provider,
     * and the only place transport code lives — it arrives with the
     * installed provider, never from a registered target.
     *
     * What the pipe must be: a two-way byte stream; reliable and ordered,
     * losing, reordering and duplicating nothing; quick enough for a
     * conversation, which is many round trips per turn with output arriving
     * as it is produced; visibly broken when it breaks, by closing or
     * erroring rather than going quiet; connected to this host's runtime and
     * nothing else; and, whenever what it crosses cannot be trusted, private
     * and tamper-proof from end to end. That last one is the provider's
     * work: the worker cannot check it.
     *
     * The worker calls it again when a connection breaks, and may hold
     * several at once. It must honour the deadline on `signal`.
     */
    openConnection?(req: ComputeOpenConnectionRequest): Promise<ComputePipe>;
    validateTarget?(req: ComputeValidateRequest): Promise<{ ok: true } | ComputeFailure>;
    bind(req: ComputeBindRequest): Promise<{ ok: true; host: ComputeHostRef } | ComputeFailure>;
    connect(req: ComputeConnectRequest): Promise<ComputeConnectResult>;
    release?(req: ComputeReleaseRequest): Promise<void>;
    /**
     * PilotSwarm is still using this host, and asks for it to be held for
     * `leaseMs` longer. Called on a timer, bounded and best effort, for as
     * long as a worker holds the binding; renewals that stop mean nobody
     * is using the host any more, whether a worker released it, crashed or
     * was taken away. A provider that does not need the signal may leave
     * it out, and a provider that refuses a renewal is saying the host is
     * gone — the next turn will find that out through `connect`.
     */
    renew?(req: ComputeRenewRequest): Promise<{ ok: true } | ComputeFailure>;
    /**
     * This session tree is finished with the host. Exactly one notice is
     * sent per binding, from whichever worker notices the tree has ended,
     * including a tree that ended while no worker had it loaded, so a
     * provider learns about hosts that no `release` would ever cover.
     *
     * It still does not mean destroy: what happens to a host nobody needs
     * is the provider's decision alone. It must be safe to receive twice,
     * since a worker can record the notice and then fail.
     */
    done?(req: ComputeDoneRequest): Promise<{ ok: true } | ComputeFailure>;
}

/**
 * PilotSwarm is still using this host. Sent on a timer for as long as a
 * worker holds the binding; when the renewals stop, nobody is using it.
 */
export interface ComputeRenewRequest extends ComputeCall {
    target: ComputeTarget;
    host: ComputeHostRef;
    /** Hosts are bound per (target, session tree). */
    rootSessionId: string;
    workerNodeId: string;
    /** How long PilotSwarm is asking the host to be held for, from now. */
    leaseMs: number;
}

/**
 * This session tree is finished with the host: it ended, or it was
 * deleted. Sent once per binding, from whichever worker notices, including
 * for trees that ended while no worker had them loaded.
 */
export interface ComputeDoneRequest extends ComputeCall {
    target: ComputeTarget;
    host: ComputeHostRef;
    rootSessionId: string;
    workerNodeId: string;
    reason: "ended" | "deleted";
}

/** The built-in provider: the runtime runs as the worker's child process, as today. */
export function createLocalComputeProvider(): ComputeProvider {
    return {
        kind: LOCAL_COMPUTE_KIND,
        capabilities: { files: "worker-local" },
        async bind(req) {
            return { ok: true, host: { kind: LOCAL_COMPUTE_KIND, id: req.workerNodeId, incarnation: req.workerNodeId } };
        },
        async connect(req) {
            return { ok: true, endpoint: { transport: "local" }, workspace: { ...req.workspace } };
        },
    };
}

/**
 * The compute providers a worker has, by kind. `local` is always present.
 *
 * A provider is a plug-in loaded into the worker: the application passes
 * it in the worker options, or registers it later. They are registered
 * once at start and stay.
 */
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
        // One transport per provider, and no doubt about which it is. A
        // provider whose declaration and code disagree never reaches a turn.
        const transport = provider.transport ?? "direct";
        if (transport !== "direct" && transport !== "pipe") {
            throw new Error(`compute provider "${provider.kind}" declares an unknown transport "${transport}"`);
        }
        if (transport === "pipe" && typeof provider.openConnection !== "function") {
            throw new Error(`compute provider "${provider.kind}" says it opens its own connections but has no openConnection`);
        }
        if (transport === "direct" && typeof provider.openConnection === "function") {
            throw new Error(`compute provider "${provider.kind}" is reached directly, so it must not have openConnection`);
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

/**
 * Check a whole target name, `<owner>/<label>`. A bare label is not a name:
 * it is shorthand a caller may use (`resolveComputeTargetName`), not
 * something stored.
 */
export function validateComputeTargetName(name: unknown): { ok: true; name: string } | ComputeFailure {
    if (typeof name !== "string" || !COMPUTE_TARGET_NAME_PATTERN.test(name.trim())) {
        return {
            ok: false,
            code: COMPUTE_ERROR_CODES.INVALID,
            message: 'A compute target is named "shared/<label>", where the label uses letters, numbers, dot, dash and underscore (at most 64 characters).',
        };
    }
    return { ok: true, name: name.trim() };
}

/** The label part a registrant chooses; PilotSwarm adds the owner part itself. */
export function validateComputeTargetLabel(label: unknown): { ok: true; label: string } | ComputeFailure {
    if (typeof label !== "string" || !COMPUTE_TARGET_LABEL_PATTERN.test(label.trim())) {
        return {
            ok: false,
            code: COMPUTE_ERROR_CODES.INVALID,
            message: "A compute target label uses letters, numbers, dot, dash and underscore (at most 64 characters) and starts with a letter or number.",
        };
    }
    return { ok: true, label: label.trim() };
}

/** The two parts of a target's name, or null when it is not a whole name. */
export function parseComputeTargetName(name: unknown): { owner: string; label: string } | null {
    if (typeof name !== "string") return null;
    const trimmed = name.trim();
    if (!COMPUTE_TARGET_NAME_PATTERN.test(trimmed)) return null;
    const at = trimmed.lastIndexOf("/");
    return { owner: trimmed.slice(0, at), label: trimmed.slice(at + 1) };
}

/**
 * The name a target would have. The owner part is never taken from what a
 * caller sends: PilotSwarm puts every target an administrator registers in
 * the shared space.
 */
export function computeTargetNameFor(
    label: unknown,
): { ok: true; name: string } | ComputeFailure {
    const checked = validateComputeTargetLabel(label);
    if (!checked.ok) return checked;
    return { ok: true, name: `${SHARED_COMPUTE_TARGET_OWNER}/${checked.label}` };
}

/**
 * What a caller means by a target name. A whole name is taken as it is; a
 * bare label is shorthand for the shared target of that label.
 */
export function resolveComputeTargetName(name: unknown): string[] {
    if (typeof name !== "string" || !name.trim()) return [];
    const trimmed = name.trim();
    if (COMPUTE_TARGET_NAME_PATTERN.test(trimmed)) return [trimmed];
    if (!COMPUTE_TARGET_LABEL_PATTERN.test(trimmed)) return [];
    return [`${SHARED_COMPUTE_TARGET_OWNER}/${trimmed}`];
}

/** The Copilot SDK connection for an endpoint. */
export function runtimeConnectionFor(endpoint: ComputeRuntimeEndpoint | undefined): RuntimeConnection {
    if (!endpoint || endpoint.transport === "local") return RuntimeConnection.forStdio();
    if (endpoint.transport === "pipe") {
        // A pipe is reached through its bridge; the worker replaces it with
        // that bridge's address before anything tries to connect.
        throw new Error("a pipe compute endpoint must be bridged before it is connected to");
    }
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
 *
 * A pipe endpoint is bridged before it gets here, and its bridge's address
 * is what the key covers — so a replaced bridge is a different connection
 * and gets a client of its own.
 */
export function runtimeEndpointKey(endpoint: ComputeRuntimeEndpoint | undefined, host?: ComputeHostRef): string {
    if (!endpoint || endpoint.transport === "local") return "";
    const address = endpoint.transport === "uri" ? endpoint.address : "";
    const digest = createHash("sha256")
        .update(JSON.stringify([address, endpoint.connectionToken ?? "", host?.kind ?? "", host?.id ?? "", host?.incarnation ?? ""]))
        .digest("hex")
        .slice(0, 32);
    return `uri\0${digest}`;
}

/**
 * How a host is named across workers: the provider's id plus which
 * incarnation, so a replaced host is a different binding.
 *
 * The two parts are joined with the unit separator, which a provider's own
 * identifiers will not hold and which a text column can store — unlike
 * NUL, which PostgreSQL refuses.
 */
export function computeHostKey(host: Pick<ComputeHostRef, "id" | "incarnation">): string {
    return `${host.id}\u001f${host.incarnation}`;
}

/**
 * One binding, as the worker holds it in memory: the target and the host,
 * so that every session of a tree bound to the same host shares what
 * belongs to that host and a replaced host gets its own.
 */
export function computeBindingKey(targetId: string, host: Pick<ComputeHostRef, "id" | "incarnation">): string {
    return `${targetId}\u001f${computeHostKey(host)}`;
}

/**
 * Host leases: how long one is worth and how often it is renewed.
 *
 * A worker renews while it holds a binding, so a provider reads renewals
 * that stop as "nobody is using this host" — which covers a worker that
 * crashed or was taken away as well as one that let go properly. The
 * lease must therefore outlast more than one renewal: a single slow or
 * failed renewal is not an absent worker. This clamps a caller's numbers
 * to that rule rather than trusting them.
 */
export const DEFAULT_COMPUTE_LEASE_MS = 3 * 60_000;
export const DEFAULT_COMPUTE_LEASE_RENEW_MS = 60_000;
/** The shortest lease and renewal worth having; anything under is a mistake. */
export const MIN_COMPUTE_LEASE_MS = 5_000;
export const MIN_COMPUTE_LEASE_RENEW_MS = 1_000;

export function computeLeaseSchedule(
    options: { leaseMs?: number; renewMs?: number } = {},
): { leaseMs: number; renewMs: number } {
    const wantedLease = Number(options.leaseMs);
    const leaseMs = Math.max(MIN_COMPUTE_LEASE_MS,
        Number.isFinite(wantedLease) && wantedLease > 0 ? Math.trunc(wantedLease) : DEFAULT_COMPUTE_LEASE_MS);
    const wantedRenew = Number(options.renewMs);
    const asked = Math.max(MIN_COMPUTE_LEASE_RENEW_MS,
        Number.isFinite(wantedRenew) && wantedRenew > 0 ? Math.trunc(wantedRenew) : DEFAULT_COMPUTE_LEASE_RENEW_MS);
    // At least two renewals inside a lease, so one that is late or fails
    // never reads as a worker that has gone.
    return { leaseMs, renewMs: Math.max(MIN_COMPUTE_LEASE_RENEW_MS, Math.min(asked, Math.floor(leaseMs / 2))) };
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
