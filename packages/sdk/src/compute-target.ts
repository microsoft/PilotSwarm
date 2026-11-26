/**
 * Compute targets and providers: the neutral, provider-independent description of where a session's Copilot runtime can run outside the worker.
 *
 * A TARGET is trusted worker configuration validated at construction. A session only NAMES one, by id, in its creation config:
 * `computeTarget: { targetId }`. Nothing else about the target is ever read from a session.
 *
 * A PROVIDER implements a compute backend identified by `kind` (for example `my-provider`) and declares which `statePolicy` values it supports.
 * Workers resolve `session.computeTarget.targetId -> target.kind -> provider` through `ComputeRegistry` and validate all enabled targets fail-closed at startup.
 */

/** A kind is a short lowercase label for the provider family (for example `my-provider`). */
export const COMPUTE_KIND_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A target id is opaque: letters, digits and `._:-`, starting with a letter or digit. Never reused, unlike the name. */
export const COMPUTE_TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Supported remote-compute state policies. */
export const COMPUTE_STATE_POLICIES = Object.freeze(["store-owned"] as const);
export type ComputeStatePolicy = (typeof COMPUTE_STATE_POLICIES)[number];

/** Maximum opaque archive size (16 MiB) a store-owned target may allow; a target may configure only a lower cap. */
export const COMPUTE_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;

/** How long each phase of a store-owned turn may take before it is abandoned (the turn body has its own timeouts). */
export interface StoreOwnedDeadlinesMs {
    open: number;
    read: number;
    dehydrate: number;
    commit: number;
}

export const STORE_OWNED_DEFAULT_DEADLINES_MS: Readonly<StoreOwnedDeadlinesMs> = Object.freeze({
    open: 120_000,
    read: 60_000,
    dehydrate: 120_000,
    commit: 60_000,
});
const MAX_DEADLINE_MS = 60 * 60 * 1000;

export interface StoreOwnedTargetSettings {
    /** Optional lower cap on the opaque archive size, in bytes (1 to 16 MiB). */
    maxArchiveBytes?: number;
    /** Optional per-phase deadlines, in milliseconds (1 ms to 1 h). */
    deadlinesMs?: Partial<StoreOwnedDeadlinesMs>;
}

export interface ComputeTarget {
    /** Never reused, unlike the name. */
    id: string;
    name: string;
    kind: string;
    class: "shared";
    /** Explicit state durability policy for sessions running on this target. */
    statePolicy: ComputeStatePolicy;
    displayName?: string | null;
    enabled: boolean;
    /** Optional PilotSwarm-owned bounds when `statePolicy === "store-owned"`. */
    storeOwned?: StoreOwnedTargetSettings;
    /** Provider-owned settings, plain JSON data. */
    config: Record<string, unknown>;
}

/** Validated, frozen compute target with resolved PilotSwarm-owned bounds. */
export interface ParsedComputeTarget {
    readonly target: Readonly<ComputeTarget>;
    /** The archive cap for this target: the hard cap, or a lower configured one. */
    readonly maxArchiveBytes: number;
    readonly deadlinesMs: Readonly<StoreOwnedDeadlinesMs>;
}

/** What a session's creation config holds: the id of the target it runs on, and nothing else. */
export interface SessionComputeTargetRef {
    targetId: string;
}

/** Why PilotSwarm asks a compute provider to release a session's cached resources on this worker. */
export type ComputeSessionReleaseReason = "ended" | "deleted" | "evicted" | "worker_shutdown";

export interface ComputeSessionReleaseRequest {
    readonly sessionId: string;
    readonly targetId?: string;
    readonly reason: ComputeSessionReleaseReason;
}

/**
 * A provider-neutral compute backend registered on a worker.
 *
 * Each provider owns one unique `kind` and declares which `statePolicy` values it implements. State-policy-specific execution methods are optional so a provider only
 * implements the modes it declares.
 */
export interface ComputeProvider {
    readonly kind: string;
    readonly supportedStatePolicies: readonly ComputeStatePolicy[];
    /** Mode 1 (`statePolicy: "store-owned"`): open a per-turn lease to a remote runtime. */
    openStoreOwned?(request: import("./remote-store-owned.js").RemoteStoreOwnedOpenRequest): Promise<import("./remote-store-owned.js").RemoteStoreOwnedLease>;
    /** Best-effort cleanup when a session ends or is destroyed on this worker. */
    releaseSession?(request: ComputeSessionReleaseRequest): Promise<void> | void;
    /** Called when the worker stops to release provider-owned resources (slots, listeners, caches). */
    dispose?(): Promise<void> | void;
}

export interface ResolvedComputeTarget {
    readonly parsed: Readonly<ParsedComputeTarget>;
    readonly target: Readonly<ComputeTarget>;
    readonly provider: ComputeProvider;
}

export class ComputeTargetError extends Error {
    readonly code = "COMPUTE_TARGET_INVALID" as const;
    constructor(message: string) {
        super(`COMPUTE_TARGET_INVALID: ${message}`);
        this.name = "ComputeTargetError";
    }
}

function isPlain(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
    return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function isComputeStatePolicy(value: unknown): value is ComputeStatePolicy {
    return typeof value === "string" && (COMPUTE_STATE_POLICIES as readonly string[]).includes(value);
}

/** Recursively validate and deep-clone plain JSON data (refusing functions, symbols, undefined, BigInt, non-finite numbers, class instances and cycles), then deep-freeze. */
function cloneAndFreezeJsonValue(value: unknown, seen: Set<object>): unknown {
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new ComputeTargetError("compute target config must contain only finite JSON numbers");
        return value;
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) throw new ComputeTargetError("compute target config must not contain circular references");
        seen.add(value);
        try {
            return Object.freeze(value.map((entry) => cloneAndFreezeJsonValue(entry, seen)));
        } finally {
            seen.delete(value);
        }
    }
    if (isPlain(value)) {
        if (seen.has(value)) throw new ComputeTargetError("compute target config must not contain circular references");
        seen.add(value);
        try {
            const out: Record<string, unknown> = {};
            for (const key of Object.keys(value)) {
                if (key === "__proto__" || key === "constructor" || key === "prototype") {
                    throw new ComputeTargetError(`compute target config must not use reserved key ${key}`);
                }
                const entry = ownValue(value, key);
                if (entry === undefined) throw new ComputeTargetError(`compute target config key ${key} must not be undefined`);
                out[key] = cloneAndFreezeJsonValue(entry, seen);
            }
            return Object.freeze(out);
        } finally {
            seen.delete(value);
        }
    }
    throw new ComputeTargetError("compute target config must be plain JSON data");
}

/** A session's compute target reference, exactly `{ targetId }` with an opaque id; `undefined` when the session names none. Anything else is refused. */
export function parseSessionComputeTargetRef(value: unknown): Readonly<SessionComputeTargetRef> | undefined {
    if (value === undefined) return undefined;
    if (!isPlain(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "targetId")) {
        throw new ComputeTargetError("a session's compute target is exactly { targetId }");
    }
    const targetId = ownValue(value, "targetId");
    if (typeof targetId !== "string" || !COMPUTE_TARGET_ID_PATTERN.test(targetId)) {
        throw new ComputeTargetError("a session's compute target id is not an opaque id");
    }
    return Object.freeze({ targetId });
}

/** Validate and deep-freeze a trusted worker compute target record. */
export function parseComputeTarget(target: ComputeTarget): Readonly<ParsedComputeTarget> {
    if (!isPlain(target)) {
        throw new ComputeTargetError("a compute target must be a plain object");
    }
    const raw = target as unknown as Record<string, unknown>;
    const id = ownValue(raw, "id");
    const name = ownValue(raw, "name");
    const kind = ownValue(raw, "kind");
    const targetClass = ownValue(raw, "class");
    const statePolicy = ownValue(raw, "statePolicy");
    const displayName = ownValue(raw, "displayName");
    const enabled = ownValue(raw, "enabled");
    const rawConfig = ownValue(raw, "config");
    if (typeof id !== "string" || !COMPUTE_TARGET_ID_PATTERN.test(id)
        || typeof name !== "string" || name.length === 0
        || typeof kind !== "string" || !COMPUTE_KIND_PATTERN.test(kind)
        || targetClass !== "shared"
        || !isComputeStatePolicy(statePolicy)
        || typeof enabled !== "boolean"
        || !isPlain(rawConfig)) {
        throw new ComputeTargetError("a compute target needs an opaque id, a name, a kind, class shared, a valid statePolicy, boolean enabled and a plain config");
    }
    let maxArchiveBytes = COMPUTE_ARCHIVE_MAX_BYTES;
    const deadlinesMs: StoreOwnedDeadlinesMs = { ...STORE_OWNED_DEFAULT_DEADLINES_MS };
    const storeOwned = ownValue(raw, "storeOwned");
    if (storeOwned !== undefined) {
        if (statePolicy !== "store-owned") {
            throw new ComputeTargetError("storeOwned settings are valid only when statePolicy is store-owned");
        }
        if (!isPlain(storeOwned) || Object.keys(storeOwned).some((key) => key !== "maxArchiveBytes" && key !== "deadlinesMs")) {
            throw new ComputeTargetError("storeOwned is exactly { maxArchiveBytes?, deadlinesMs? }");
        }
        const requestedCap = ownValue(storeOwned, "maxArchiveBytes");
        if (requestedCap !== undefined) {
            if (typeof requestedCap !== "number" || !Number.isInteger(requestedCap) || requestedCap < 1 || requestedCap > COMPUTE_ARCHIVE_MAX_BYTES) {
                throw new ComputeTargetError(`storeOwned.maxArchiveBytes must be an integer from 1 to ${COMPUTE_ARCHIVE_MAX_BYTES}`);
            }
            maxArchiveBytes = requestedCap;
        }
        const deadlines = ownValue(storeOwned, "deadlinesMs");
        if (deadlines !== undefined) {
            if (!isPlain(deadlines) || Object.keys(deadlines).some((key) => !Object.hasOwn(deadlinesMs, key))) {
                throw new ComputeTargetError("storeOwned.deadlinesMs holds only open, read, dehydrate and commit");
            }
            for (const key of Object.keys(deadlines) as Array<keyof StoreOwnedDeadlinesMs>) {
                const ms = ownValue(deadlines, key);
                if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 1 || ms > MAX_DEADLINE_MS) {
                    throw new ComputeTargetError(`the ${key} deadline is an integer from 1 to ${MAX_DEADLINE_MS} milliseconds`);
                }
                deadlinesMs[key] = ms;
            }
        }
    }
    const configCopy = cloneAndFreezeJsonValue(rawConfig, new Set()) as Record<string, unknown>;
    const frozenTarget: Readonly<ComputeTarget> = Object.freeze({
        id,
        name,
        kind,
        class: "shared" as const,
        statePolicy,
        displayName: typeof displayName === "string" ? displayName : null,
        enabled,
        ...(storeOwned !== undefined ? { storeOwned: Object.freeze({ maxArchiveBytes, deadlinesMs: Object.freeze({ ...deadlinesMs }) }) } : {}),
        config: configCopy,
    });
    return Object.freeze({
        target: frozenTarget,
        maxArchiveBytes,
        deadlinesMs: Object.freeze(deadlinesMs),
    });
}

interface RegisteredProviderEntry {
    readonly kind: string;
    readonly supportedStatePolicies: readonly ComputeStatePolicy[];
    readonly provider: ComputeProvider;
}

function validateAndSnapshotComputeProvider(provider: ComputeProvider): RegisteredProviderEntry {
    if (!provider || typeof provider !== "object") {
        throw new ComputeTargetError("a compute provider must be an object");
    }
    const kind = provider.kind;
    if (typeof kind !== "string" || !COMPUTE_KIND_PATTERN.test(kind)) {
        throw new ComputeTargetError("a compute provider needs a lowercase kind matching COMPUTE_KIND_PATTERN");
    }
    const policies = provider.supportedStatePolicies;
    if (!Array.isArray(policies) || policies.length === 0 || !policies.every(isComputeStatePolicy)) {
        throw new ComputeTargetError(`compute provider ${kind} must declare at least one valid supportedStatePolicies entry`);
    }
    if (provider.openStoreOwned !== undefined && typeof provider.openStoreOwned !== "function") {
        throw new ComputeTargetError(`compute provider ${provider.kind} openStoreOwned must be a function when set`);
    }
    if (provider.releaseSession !== undefined && typeof provider.releaseSession !== "function") {
        throw new ComputeTargetError(`compute provider ${kind} releaseSession must be a function when set`);
    }
    if (provider.dispose !== undefined && typeof provider.dispose !== "function") {
        throw new ComputeTargetError(`compute provider ${kind} dispose must be a function when set`);
    }
    return Object.freeze({
        kind,
        supportedStatePolicies: Object.freeze([...new Set(policies)]),
        provider,
    });
}

export interface ComputeRegistryOptions {
    targets?: readonly ComputeTarget[];
    providers?: readonly ComputeProvider[];
}

/**
 * Worker-scoped registry pairing trusted compute targets with registered compute providers.
 */
export class ComputeRegistry {
    private readonly targets = new Map<string, Readonly<ParsedComputeTarget>>();
    private readonly providers = new Map<string, RegisteredProviderEntry>();
    private sealed = false;

    constructor(options: ComputeRegistryOptions = {}) {
        if (options.targets !== undefined) {
            if (!Array.isArray(options.targets)) throw new ComputeTargetError("computeTargets must be an array");
            for (const target of options.targets) this.addTarget(target);
        }
        if (options.providers !== undefined) {
            if (!Array.isArray(options.providers)) throw new ComputeTargetError("computeProviders must be an array");
            for (const provider of options.providers) this.registerProvider(provider);
        }
    }

    /** Seal the registry against further target or provider mutations (called synchronously at worker start). */
    seal(): void {
        this.sealed = true;
    }

    isSealed(): boolean {
        return this.sealed;
    }

    addTarget(target: ComputeTarget): Readonly<ParsedComputeTarget> {
        if (this.sealed) throw new ComputeTargetError("cannot add compute targets after the registry is sealed");
        const parsed = parseComputeTarget(target);
        if (this.targets.has(parsed.target.id)) {
            throw new ComputeTargetError(`compute target ${parsed.target.id} is configured twice`);
        }
        this.targets.set(parsed.target.id, parsed);
        return parsed;
    }

    registerProvider(provider: ComputeProvider): void {
        if (this.sealed) throw new ComputeTargetError("cannot register compute providers after the registry is sealed");
        const entry = validateAndSnapshotComputeProvider(provider);
        if (this.providers.has(entry.kind)) {
            throw new ComputeTargetError(`compute provider for kind ${entry.kind} is already registered`);
        }
        this.providers.set(entry.kind, entry);
    }

    hasTargets(): boolean {
        return this.targets.size > 0;
    }

    hasProviders(): boolean {
        return this.providers.size > 0;
    }

    targetIds(): string[] {
        return [...this.targets.keys()];
    }

    providerKinds(): string[] {
        return [...this.providers.keys()];
    }

    getTarget(targetId: string): Readonly<ParsedComputeTarget> | undefined {
        return this.targets.get(targetId);
    }

    getProvider(kind: string): ComputeProvider | undefined {
        return this.providers.get(kind)?.provider;
    }

    /**
     * Resolve an enabled target to its provider. Returns `undefined` when the target id is not registered or is disabled.
     * Throws `ComputeTargetError` when an enabled target has no matching provider or its provider does not support the target's statePolicy.
     */
    resolveTarget(targetId: string): ResolvedComputeTarget | undefined {
        const parsed = this.targets.get(targetId);
        if (!parsed || !parsed.target.enabled) return undefined;
        const entry = this.providers.get(parsed.target.kind);
        if (!entry) {
            throw new ComputeTargetError(`compute target ${parsed.target.id} requires unregistered provider kind ${parsed.target.kind}`);
        }
        if (!entry.supportedStatePolicies.includes(parsed.target.statePolicy)) {
            throw new ComputeTargetError(`compute provider ${entry.kind} does not support statePolicy ${parsed.target.statePolicy} required by target ${parsed.target.id}`);
        }
        return Object.freeze({ parsed, target: parsed.target, provider: entry.provider });
    }

    /**
     * Fail-closed startup validation: verifies every enabled target has a registered provider supporting its statePolicy,
     * and runs an optional caller check (e.g. policy-specific method and store checks).
     */
    validateForStart(verifyTarget?: (resolved: ResolvedComputeTarget) => void): void {
        for (const parsed of this.targets.values()) {
            if (!parsed.target.enabled) continue;
            const resolved = this.resolveTarget(parsed.target.id)!;
            verifyTarget?.(resolved);
        }
    }

    /** Best-effort session release notification to the matching provider (or all providers when targetId is absent). */
    async releaseSession(request: ComputeSessionReleaseRequest): Promise<void> {
        const entries: RegisteredProviderEntry[] = [];
        if (request.targetId) {
            const parsed = this.targets.get(request.targetId);
            const entry = parsed ? this.providers.get(parsed.target.kind) : undefined;
            if (entry && typeof entry.provider.releaseSession === "function") entries.push(entry);
        } else {
            for (const entry of this.providers.values()) {
                if (typeof entry.provider.releaseSession === "function") entries.push(entry);
            }
        }
        const results = await Promise.allSettled(
            entries.map((entry) => Promise.resolve().then(() => entry.provider.releaseSession!(request))),
        );
        for (let i = 0; i < results.length; i++) {
            const result = results[i]!;
            if (result.status === "rejected") {
                const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
                console.warn(`[ComputeRegistry] releaseSession failed for provider ${entries[i]!.kind}: ${msg}`);
            }
        }
    }

    /** Dispose every registered provider that implements `dispose()`. Runs all providers even if one fails, then throws the first failure. */
    async disposeAll(): Promise<void> {
        const results = await Promise.allSettled(
            [...this.providers.values()]
                .filter((entry) => typeof entry.provider.dispose === "function")
                .map((entry) => Promise.resolve().then(() => entry.provider.dispose!())),
        );
        for (const result of results) {
            if (result.status === "rejected") throw result.reason;
        }
    }
}

export function createComputeRegistry(options: ComputeRegistryOptions = {}): ComputeRegistry {
    return new ComputeRegistry(options);
}
