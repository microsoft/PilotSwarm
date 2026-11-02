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
import type { Duplex } from "node:stream";
import { RuntimeConnection } from "@github/copilot-sdk";
import { COMPUTE_HANDSHAKE_FAILED, type ComputeHandshakeCredential } from "./compute-handshake.js";

export const LOCAL_COMPUTE_KIND = "local";

/**
 * The part of a target's name the person registering it chooses. Kept
 * deliberately plain: it ends up in a model name and in URLs.
 */
export const COMPUTE_TARGET_LABEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/**
 * A full compute target name, `<owner>/<label>`.
 *
 * Every target is named after whoever it belongs to, so two people can both
 * have a target called `sandbox` and neither can take a name the other, or
 * an administrator, needs. The owner part is the registrant's sign-in
 * address for a personal target, and the reserved word `shared` for a
 * target administrators register for everyone. PilotSwarm builds that part
 * itself from whoever is signed in; a registrant supplies only the label.
 *
 * The owner part allows what a sign-in address holds and nothing more: no
 * slash (which separates the two parts) and no colon (which separates a
 * target from one of its models).
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
    /** The provider service a target's kind is served by could not be used. */
    SERVICE_UNAVAILABLE: "COMPUTE_SERVICE_UNAVAILABLE",
    /** The provider service did not present the identity its registration pins. */
    SERVICE_IDENTITY: "COMPUTE_SERVICE_IDENTITY",
    /** Refusals from the registered-services table (administrators only). */
    SERVICE_INVALID: "COMPUTE_SERVICE_INVALID",
    SERVICE_FORBIDDEN: "COMPUTE_SERVICE_FORBIDDEN",
    SERVICE_NOT_FOUND: "COMPUTE_SERVICE_NOT_FOUND",
    SERVICE_CONFLICT: "COMPUTE_SERVICE_CONFLICT",
    SERVICE_IN_USE: "COMPUTE_SERVICE_IN_USE",
    /**
     * The session's model is one of the target's own, and the target no
     * longer offers it (or may not offer models at all).
     */
    HOST_MODEL_UNAVAILABLE: "COMPUTE_HOST_MODEL_UNAVAILABLE",
} as const;

/** The most an advertisement may take once stored, after shaping. */
export const MAX_COMPUTE_ADVERTISEMENT_BYTES = 16 * 1024;
/** The most models one target may offer. */
export const MAX_COMPUTE_HOST_MODELS = 200;

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
    /** What the target last advertised, or null before it has advertised anything. */
    advertised?: ComputeTargetAdvertisement | null;
}

/** A model the host offers with its own model access, by the name the host uses. */
export interface ComputeHostModel {
    id: string;
    name?: string;
}

/**
 * What a target says it offers. Advertised by the target's host and refreshed
 * as the worker reaches it, so it may be out of date: it shapes the options a
 * user sees (for example when creating a session or listing models), and is
 * never used to decide who may do what.
 *
 * It comes from the host, which is untrusted. The worker keeps only the
 * well-formed parts (normalizeAdvertisement) and caps what it stores.
 */
export interface ComputeAdvertisement {
    /**
     * Models the host offers with its own model access. Only personal
     * targets may offer models; for a shared target they are dropped. A
     * session names one `@<target>:<model>` (targetModelRef); its calls go
     * from the host, not through the worker, so PilotSwarm's budgets and
     * credentials do not apply to them.
     */
    models?: ComputeHostModel[];
    /** The host's operating system, as Node names it ("linux", "win32", "darwin", ...). */
    os?: string;
    /** Other facts the provider wants users to see, such as installed tools. */
    details?: Record<string, string>;
}

/** An advertisement as PilotSwarm stores it. */
export interface ComputeTargetAdvertisement extends ComputeAdvertisement {
    /** When it was last refreshed. */
    observedAt: string;
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
    /**
     * Whether hosts of this kind can have model access of their own. When
     * true, the worker asks the host's runtime which models it offers and
     * advertises them for personal targets.
     */
    offersModels?: boolean;
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
    /**
     * Whether retrying this failure cannot help. A provider may set it on
     * a failure of its own, and only on one: a built-in code's kind is
     * decided by PilotSwarm, which is the only way a provider cannot talk
     * a permanent failure into looking retryable or the other way round.
     */
    permanent?: boolean;
};

/** Whether a code is one PilotSwarm defines, rather than a provider's own. */
export function isBuiltInComputeCode(code: unknown): boolean {
    return typeof code === "string" && (Object.values(COMPUTE_ERROR_CODES) as string[]).includes(code);
}

/**
 * One compute failure as the single line a turn carries: `CODE: message`.
 *
 * A provider's own code may say which kind it is — `CODE: [permanent]
 * message` or `CODE: [temporary] message` — so that `permanent` is not
 * lost between the provider and whatever reads the turn's error. A
 * built-in code never carries the marker, however the provider set
 * `permanent`: PilotSwarm classifies its own codes, and a provider may
 * not talk one into a different kind.
 *
 * Every compute error thrown from a provider failure goes through this,
 * so there is one format and one place to change it.
 *
 * TEMPORARY: this is a stand-in for `formatComputeFailure` in
 * `compute-failures.ts`, which arrives with the failure-reasons work
 * (Spec B) and classifies codes as well as formatting them. The output is
 * the same by construction; at integration this is deleted and the import
 * points at that module instead.
 */
export function formatComputeFailure(failure: Pick<ComputeFailure, "code" | "message" | "permanent">): string {
    const code = typeof failure?.code === "string" && failure.code.trim() ? failure.code.trim() : COMPUTE_ERROR_CODES.UNAVAILABLE;
    const message = typeof failure?.message === "string" ? failure.message.trim() : "";
    const kind = typeof failure?.permanent === "boolean" && !isBuiltInComputeCode(code)
        ? (failure.permanent ? "[permanent] " : "[temporary] ")
        : "";
    return `${code}: ${kind}${message}`;
}

/**
 * The message of a failure that is being re-raised from an error which
 * already carries its own code, with that prefix taken off.
 *
 * A compute failure is raised once and may be caught and re-raised
 * further out. Without this it would be formatted twice and read
 * `CODE: CODE: ...`.
 */
export function computeFailureMessage(code: string, raw: unknown): string {
    const text = String((raw as Error)?.message ?? raw ?? "").trim();
    const prefix = new RegExp(`^${code.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}:\\s*(\\[(?:permanent|temporary)\\]\\s*)?`);
    return text.replace(prefix, "");
}

/**
 * The same failure as an Error to throw, carrying the parts the rest of
 * the worker acts on: the code, how long to wait, and whether retrying
 * can help at all.
 */
export function computeFailureError(failure: Pick<ComputeFailure, "code" | "message" | "retryAfterMs" | "permanent">): Error {
    const code = typeof failure?.code === "string" && failure.code.trim() ? failure.code.trim() : COMPUTE_ERROR_CODES.UNAVAILABLE;
    return Object.assign(new Error(formatComputeFailure(failure)), {
        code,
        ...(failure?.retryAfterMs ? { retryAfterMs: failure.retryAfterMs } : {}),
        ...(typeof failure?.permanent === "boolean" && !isBuiltInComputeCode(code) ? { permanent: failure.permanent } : {}),
    });
}

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
 * Why a session leaves its host (`probe` is a short test connection made
 * when a target is registered or checked, with no session behind it):
 *   ended    the session ended
 *   moved    the session left this worker and stays open
 *   evicted  the worker dropped the idle session
 *   shutdown the worker is shutting down
 *   failed   bind succeeded but the session could not use the host
 */
export type ComputeReleaseReason = "ended" | "moved" | "evicted" | "shutdown" | "failed" | "probe";

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
    /**
     * Facts about a host for its target's advertisement (operating system,
     * installed tools, ...). Models are not listed here: the worker asks the
     * host's runtime for those when `capabilities.offersModels` is set.
     */
    describeHost?(req: ComputeDescribeRequest): Promise<Omit<ComputeAdvertisement, "models">>;
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

export interface ComputeDescribeRequest extends ComputeCall {
    target: ComputeTarget;
    host: ComputeHostRef;
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
        capabilities: { os: [process.platform], sandboxed: false, files: "worker-local" },
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
 * Two sorts live here. Providers built into the worker are registered once
 * at start and stay. Providers that stand for a registered provider
 * service come and go as an administrator changes the register, and are
 * replaced as a set (`setServiceProviders`) each time the worker re-reads
 * it. A service never shadows a provider the worker was built with: if
 * both offer a kind, the built-in one answers.
 */
export class ComputeProviderRegistry {
    private readonly providers = new Map<string, ComputeProvider>();
    /** The kinds currently answered by a registered provider service. */
    private readonly fromServices = new Set<string>();

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
        if (this.providers.has(provider.kind) && !opts.replace && !this.fromServices.has(provider.kind)) {
            throw new Error(`compute provider "${provider.kind}" is registered twice`);
        }
        // A provider built into the worker takes the kind back from a service.
        this.fromServices.delete(provider.kind);
        this.providers.set(provider.kind, provider);
    }

    /**
     * Replace every provider that stands for a registered service with
     * this set. Kinds that have gone from the register stop being served
     * at once, which is what makes disabling a service take effect; kinds
     * the worker was built with are left alone.
     */
    setServiceProviders(providers: ComputeProvider[]): void {
        const next = new Set<string>();
        for (const provider of providers) {
            // Held to the same rules as a built-in provider, but a
            // malformed one is skipped rather than thrown: one bad service
            // must not stop the worker reading the rest of the register.
            if (!COMPUTE_KIND_PATTERN.test(provider?.kind ?? "")) continue;
            if (typeof provider.bind !== "function" || typeof provider.connect !== "function") continue;
            const transport = provider.transport ?? "direct";
            if (transport === "pipe" && typeof provider.openConnection !== "function") continue;
            if (transport === "direct" && typeof provider.openConnection === "function") continue;
            // A built-in provider wins: a registered service cannot take
            // over a kind this worker already answers itself.
            if (this.providers.has(provider.kind) && !this.fromServices.has(provider.kind)) continue;
            this.providers.set(provider.kind, provider);
            next.add(provider.kind);
        }
        for (const kind of this.fromServices) {
            if (!next.has(kind)) this.providers.delete(kind);
        }
        this.fromServices.clear();
        for (const kind of next) this.fromServices.add(kind);
    }

    get(kind: string): ComputeProvider | undefined {
        return this.providers.get(kind);
    }

    kinds(): string[] {
        return [...this.providers.keys()].sort();
    }

    /** Which kinds are answered by a registered service rather than built in. */
    serviceKinds(): string[] {
        return [...this.fromServices].sort();
    }
}

/**
 * Check a whole target name, `<owner>/<label>`. A bare label is not a name:
 * it is shorthand a caller may use, resolved against who they are
 * (`resolveComputeTargetName`), not something stored.
 */
export function validateComputeTargetName(name: unknown): { ok: true; name: string } | ComputeFailure {
    if (typeof name !== "string" || !COMPUTE_TARGET_NAME_PATTERN.test(name.trim())) {
        return {
            ok: false,
            code: COMPUTE_ERROR_CODES.INVALID,
            message: 'A compute target is named "<owner>/<label>": the owner\'s sign-in address, or "shared" for one an administrator registers for everyone, then a label of letters, numbers, dot, dash and underscore (at most 64 characters).',
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
 * caller sends: a personal target is named after the person registering
 * it, and only an administrator's target is in the shared space.
 *
 * A personal registrant with no sign-in address on record gets a refusal
 * rather than an invented owner part.
 */
export function computeTargetNameFor(
    cls: ComputeTargetClass,
    label: unknown,
    registrant: { email?: string | null } | null,
): { ok: true; name: string } | ComputeFailure {
    const checked = validateComputeTargetLabel(label);
    if (!checked.ok) return checked;
    if (cls === "shared") return { ok: true, name: `${SHARED_COMPUTE_TARGET_OWNER}/${checked.label}` };
    const owner = typeof registrant?.email === "string" ? registrant.email.trim().toLowerCase() : "";
    if (!owner || !COMPUTE_TARGET_OWNER_PATTERN.test(owner) || owner === SHARED_COMPUTE_TARGET_OWNER) {
        return {
            ok: false,
            code: COMPUTE_ERROR_CODES.INVALID,
            message: "A compute target of your own is named after your sign-in address, and this account has none on record. Ask an administrator to add one, or register the target as a shared one.",
        };
    }
    return { ok: true, name: `${owner}/${checked.label}` };
}

/**
 * What a caller means by a target name. A whole name is taken as it is. A
 * bare label is shorthand: the caller's own target first, then the shared
 * one of that label — which is the order that cannot surprise anyone,
 * since a person's own target is the one they registered.
 */
export function resolveComputeTargetName(
    name: unknown,
    caller: { email?: string | null } | null,
): string[] {
    if (typeof name !== "string" || !name.trim()) return [];
    const trimmed = name.trim();
    if (COMPUTE_TARGET_NAME_PATTERN.test(trimmed)) return [trimmed];
    if (!COMPUTE_TARGET_LABEL_PATTERN.test(trimmed)) return [];
    const own = computeTargetNameFor("personal", trimmed, caller);
    return [
        ...(own.ok ? [own.name] : []),
        `${SHARED_COMPUTE_TARGET_OWNER}/${trimmed}`,
    ];
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

/**
 * A model a target offers is named `@<target>:<model>`, so it can sit next
 * to PilotSwarm's own `provider:model` names without colliding: a model
 * provider's name never starts with "@".
 *
 * The target's own name holds no colon, so the first colon is always the
 * one that separates the target from the model — and a model name may
 * hold as many more as it likes.
 */
export function targetModelRef(targetName: string, modelId: string): string {
    return `@${targetName}:${modelId}`;
}

/** The target and model of a `@<target>:<model>` name, or null for any other name. */
export function parseTargetModelRef(ref: unknown): { target: string; model: string } | null {
    if (typeof ref !== "string" || !ref.startsWith("@")) return null;
    const at = ref.indexOf(":");
    if (at < 2 || at === ref.length - 1) return null;
    const target = ref.slice(1, at);
    const model = ref.slice(at + 1);
    if (!COMPUTE_TARGET_NAME_PATTERN.test(target) || !model.trim()) return null;
    return { target, model };
}

/**
 * Keep only the well-formed parts of an advertisement and cap what is kept:
 * a host may send anything, it is stored, and it is shown to users.
 *
 * Unknown fields are dropped, every string is bounded, duplicate model ids
 * are collapsed, and the result as a whole stays under
 * MAX_COMPUTE_ADVERTISEMENT_BYTES — models are dropped from the end until
 * it fits, so a host cannot grow a row without limit.
 */
export function normalizeAdvertisement(input: unknown): ComputeAdvertisement {
    const out: ComputeAdvertisement = {};
    if (!input || typeof input !== "object" || Array.isArray(input)) return out;
    const raw = input as Record<string, unknown>;
    if (Array.isArray(raw.models)) {
        const models: ComputeHostModel[] = [];
        const seen = new Set<string>();
        for (const entry of raw.models) {
            const m: Record<string, unknown> = entry && typeof entry === "object"
                ? entry as Record<string, unknown>
                : { id: entry };
            const id = typeof m.id === "string" ? m.id.trim() : "";
            if (!id || id.length > 200 || seen.has(id)) continue;
            seen.add(id);
            const name = typeof m.name === "string" && m.name.trim() ? m.name.trim().slice(0, 200) : undefined;
            models.push(name ? { id, name } : { id });
            if (models.length >= MAX_COMPUTE_HOST_MODELS) break;
        }
        out.models = models;
    }
    if (typeof raw.os === "string" && raw.os.trim()) out.os = raw.os.trim().slice(0, 40);
    if (raw.details && typeof raw.details === "object" && !Array.isArray(raw.details)) {
        const details: Record<string, string> = {};
        for (const [key, value] of Object.entries(raw.details as Record<string, unknown>).slice(0, 50)) {
            if (typeof value === "string" && key.length <= 100) details[key] = value.slice(0, 500);
        }
        if (Object.keys(details).length) out.details = details;
    }
    const size = () => Buffer.byteLength(JSON.stringify(out), "utf8");
    while (size() > MAX_COMPUTE_ADVERTISEMENT_BYTES && out.models?.length) out.models.pop();
    if (size() > MAX_COMPUTE_ADVERTISEMENT_BYTES) delete out.details;
    return out;
}

/**
 * Whether a target may offer models of its own: its provider's hosts can
 * have model access (a provider capability, fixed in provider code) and the
 * target is one person's own (rule M1). A shared target never offers
 * models, however it advertises itself.
 */
export function targetMayOfferHostModels(
    target: Pick<ComputeTarget, "class"> | null | undefined,
    capabilities: ComputeCapabilities | undefined,
): boolean {
    return Boolean(target && target.class === "personal" && capabilities?.offersModels === true);
}

/** The host models a target currently offers, after rule M1. */
export function advertisedHostModels(
    target: Pick<ComputeTarget, "class" | "advertised"> | null | undefined,
): ComputeHostModel[] {
    if (!target || target.class !== "personal") return [];
    return target.advertised?.models ?? [];
}
