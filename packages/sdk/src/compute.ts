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
import { RuntimeConnection } from "@github/copilot-sdk";
import { computeFailureError } from "./compute-failures.js";
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
     * This worker will not run an agent runtime as its own child process,
     * and this session has no compute target to run on.
     */
    REQUIRED: "COMPUTE_REQUIRED",
    /**
     * The worker and the host did not prove to each other that they hold
     * this binding's secret, or the provider gave the worker no secret to
     * prove it with. Nothing of the session crossed the connection.
     */
    HANDSHAKE_FAILED: COMPUTE_HANDSHAKE_FAILED,
} as const;

/**
 * Why a GitHub Copilot model cannot run on a compute host yet.
 *
 * Those models authenticate inside the runtime with a GitHub token. A
 * runtime on somebody else's machine must not hold the worker's token, and
 * asking the worker for each request is not built. Said in one place so
 * creation, a model switch, the model list and the worker's own start all
 * say the same thing.
 */
export const COMPUTE_GITHUB_MODEL_REFUSAL =
    "GitHub Copilot models cannot run on a remote compute target yet; choose a model from a configured provider";

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
 * What the worker knows about the place this turn's agent runtime is
 * running, when that place is not the worker's own child process.
 *
 * It travels with the session's configuration for one turn and is never
 * stored: the parts of the worker that must behave differently for a
 * runtime they do not own read it instead of guessing from a path or a
 * process id. The rule it encodes is a single one — a process the worker
 * did not start is not the worker's to inspect, signal or name.
 */
export interface ComputeRuntimeContext {
    /** The target this session's tree runs on, for messages a person reads. */
    targetName: string;
    hostId: string;
    hostIncarnation: string;
    /** What this host's provider says about reaching its files from the worker. */
    files: ComputeCapabilities["files"];
    /**
     * Whether the worker and the host see the same bytes in the session's
     * folders. False means a worker path is not a path on the host, and a
     * file mode of a PilotSwarm tool has nothing to read.
     */
    sharesWorkerFiles: boolean;
}

/** Whether a provider's files capability means the worker can reach the host's folders. */
export function computeSharesWorkerFiles(files: ComputeCapabilities["files"] | undefined): boolean {
    return files === "worker-local" || files === "shared-mount";
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
 *
 * Every host is reached at an address: the worker opens the connection
 * itself. Hosts that cannot be dialled — a host that can only reach
 * outwards — are left for later (the proposal's future work).
 *
 * The worker sends prompts, tool results and the token over this
 * connection, so it accepts only loopback addresses by default: a provider
 * that reaches a host elsewhere secures that path itself and hands back a
 * local address. A worker can opt in to other addresses
 * (`computeAllowNonLoopbackEndpoints`) when its network secures them.
 *
 * A remote endpoint carries `handshake`: this binding's id and secret,
 * which the worker uses to prove itself to the host component and to make
 * the host prove itself back, over every connection, before anything of
 * the session crosses. The secret is fresh for every new binding, held
 * only in the worker's memory, and never stored or logged. A remote
 * endpoint without one cannot be used (COMPUTE_HANDSHAKE_FAILED), and so
 * cannot one without a `connectionToken`: see `checkRemoteEndpoint`.
 */
export type ComputeRuntimeEndpoint =
    | { transport: "local" }
    | { transport: "uri"; address: string; connectionToken?: string; handshake?: ComputeHandshakeCredential };

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
 * runs before every turn, possibly on another worker.
 *
 * `release` says PilotSwarm no longer needs this host for this session. It
 * never means stop or destroy it: what happens to a host nobody needs is
 * the provider's decision alone — keep it, clean it and hold it ready for
 * the next workload, or discard it and make a fresh one. It is best effort
 * and called once per session that leaves a host on this worker, and
 * several sessions of a tree share a host, so a host is only free of
 * PilotSwarm once no session uses it.
 *
 * `bind` and `release` are per (session, worker), not per session. A
 * session moves between workers while it stays open, and more than one
 * worker can hold sessions of the same tree on the same host at the same
 * time. A provider that counts its users by session id alone will have one
 * worker's release take a host away from another worker that is still
 * using it. Count `(workerNodeId, sessionId)` pairs: both calls carry
 * `workerNodeId` for exactly this.
 *
 * A provider must not rely on PilotSwarm to clean up a host. `release` is
 * a hint and may never arrive: a worker can crash, a session can move, a
 * network can go away. What does arrive is the host component's idle
 * shutdown — it ends itself after a set time with no connection — so the
 * runtime should run under that component, as its child for example, and
 * the component's exit should end the whole host. A provider that cannot
 * arrange that needs an expiry of its own.
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
    validateTarget?(req: ComputeValidateRequest): Promise<{ ok: true } | ComputeFailure>;
    bind(req: ComputeBindRequest): Promise<{ ok: true; host: ComputeHostRef } | ComputeFailure>;
    connect(req: ComputeConnectRequest): Promise<ComputeConnectResult>;
    release?(req: ComputeReleaseRequest): Promise<void>;
}

/**
 * What a remote endpoint must carry before the worker will use it.
 *
 * The handshake proves which host is at the other end: an endpoint
 * without a secret names a host the worker would have no way of
 * recognizing.
 *
 * The connection token is what makes reaching the bridge worth nothing.
 * The bridge listens on the worker's own machine and serves whoever
 * connects to it, and a session that runs on the worker is model-chosen
 * code on that same machine. Without a token such a session could open a
 * proven connection to another session's host and drive its runtime,
 * which reaches that host's shell. So both are required, and a provider
 * that leaves either out is refused here rather than at the socket.
 */
export function checkRemoteEndpoint(endpoint: ComputeRuntimeEndpoint | undefined, providerKind: string): void {
    if (!endpoint || endpoint.transport === "local") return;
    if (!endpoint.handshake) {
        throw computeFailureError({
            code: COMPUTE_ERROR_CODES.HANDSHAKE_FAILED,
            message: `the compute provider "${providerKind}" gave this binding no handshake secret, so the host at the other end cannot be recognized`,
        });
    }
    if (typeof endpoint.connectionToken !== "string" || !endpoint.connectionToken.trim()) {
        throw computeFailureError({
            code: COMPUTE_ERROR_CODES.ENDPOINT_REFUSED,
            message: `the compute provider "${providerKind}" returned a runtime with no connection token; without one anything else on this machine could drive that runtime`,
        });
    }
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
        // Every host this build reaches is reached at an address, and the
        // worker opens the connection itself. A provider written against
        // the older interface, where a provider could open its own
        // connections, is refused here rather than registered and then
        // never asked to open one.
        const legacy = provider as { transport?: unknown; openConnection?: unknown };
        if (legacy.transport !== undefined || typeof legacy.openConnection === "function") {
            throw new Error(
                `compute provider "${provider.kind}" opens its own connections; this build reaches every host at an address, so connect must return one`);
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
 * A remote endpoint is bridged before it gets here, and its bridge's
 * address is what the key covers — so a replaced bridge is a different
 * connection and gets a client of its own.
 */
export function runtimeEndpointKey(endpoint: ComputeRuntimeEndpoint | undefined, host?: ComputeHostRef): string {
    if (!endpoint || endpoint.transport === "local") return "";
    const address = endpoint.address;
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
 * One binding, as the worker holds it in memory: the session tree, the
 * target and the host, so that every session of a tree bound to the same
 * host shares what belongs to that host and a replaced host gets its own.
 *
 * The tree is in the key because everything shared per host — the bridge,
 * its address, its pooled client and the reach it reads, secret included —
 * hangs off it. A provider is meant to give one host to one tree, but if
 * it ever hands the same host to two, leaving the tree out would make
 * them share all of that: whichever connected last would overwrite the
 * other's secret, and two trees, possibly of two different people, would
 * run down one control connection. With the tree in the key that cannot
 * happen on this worker whatever a provider does.
 */
export function computeBindingKey(
    targetId: string,
    host: Pick<ComputeHostRef, "id" | "incarnation">,
    rootSessionId: string,
): string {
    return `${rootSessionId}\u001f${targetId}\u001f${computeHostKey(host)}`;
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
