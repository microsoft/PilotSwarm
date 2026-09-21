import type { SessionCatalog, UserPrincipal } from "./cms.js";
import type { ContextTier, ModelProviderRegistry, ReasoningEffort } from "./model-providers.js";
import { createEphemeralSessionRunner, type EphemeralSessionDependencies } from "./ephemeral-session.js";

export interface EphemeralNativeChildAssignment {
    /** Unique task name for this execution; never reused for a repair. */
    id: string;
    /** Opaque host-owned references, not transcript content. */
    sessionRefs: string[];
}

export interface EphemeralNativeChildrenOptions {
    /** Integer 1..20. Excess launches are denied, not queued. */
    maxConcurrent: number;
    assignments: EphemeralNativeChildAssignment[];
    /** Ordered stages; a child cannot move backwards. */
    progressStages: string[];
}

export interface EphemeralNativeChildProgress {
    assignmentId: string;
    childId: string;
    /** Cumulative, agent-reported work; not verified artifact coverage. */
    completedSessionRefs: string[];
    stage: string;
    /** Increasing across all children for this execution. */
    sequence: number;
    /** Parent iteration in which this child was launched. */
    iteration: number;
    updatedAt: string;
}

/** Only query data crosses the borrow boundary, never a pg client or pool. */
export interface CmsQueryResult<Row = Record<string, unknown>> {
    rows: Row[];
    rowCount: number | null;
}

export interface CmsConnection {
    /**
     * Parameterized SQL for trusted host code. Like pg, a multi-statement
     * simple query returns one result per statement.
     */
    query<Row = Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
    ): Promise<CmsQueryResult<Row> | CmsQueryResult<Row>[]>;
}

export type CmsConnectionCallback<T> = (connection: CmsConnection, schema: string) => T | Promise<T>;
export type WithCmsConnection = <T>(callback: CmsConnectionCallback<T>) => Promise<T>;

/** A server-derived provider namespace; no display identity or credentials. */
export type HostPrincipal = Pick<UserPrincipal, "provider" | "subject">;

/** Unknown counters remain null rather than becoming an apparent zero. */
export interface EphemeralSessionUsage {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    apiCalls: number | null;
}

/** Fixed, content-free explanations for gaps in observed usage. */
export type EphemeralUsageUnknownReason =
    | "no_usage_observed"
    | "missing_counter"
    | "conflicting_counter"
    | "missing_call_identity"
    | "interrupted_call"
    | "missing_compaction_usage"
    | "invalid_counter";

export interface EphemeralSessionUsageDiagnostics {
    /** Correlated observed calls, not a guarantee that all provider calls emitted events. */
    observedApiCalls: number;
    apiCallCountReasons: EphemeralUsageUnknownReason[];
    counterReasons: {
        inputTokens: EphemeralUsageUnknownReason[];
        outputTokens: EphemeralUsageUnknownReason[];
        cacheReadTokens: EphemeralUsageUnknownReason[];
        cacheWriteTokens: EphemeralUsageUnknownReason[];
    };
}

/**
 * Reserved trusted-server contract, not a browser/RPC operation. Implementors
 * must reauthorize this actor's provider namespace without creating a durable
 * session or recording provider consumption. Callers own usage reporting and
 * cannot supply credentials, endpoints, tools, runtime settings or new limits.
 */
export interface EphemeralSessionRequest {
    actor: HostPrincipal;
    /** Caller correlation only, not a durable idempotency or replay guard. */
    executionId: string;
    /** The selected existing provider:model, with no fallback. */
    model: string;
    /** Omitted/null uses existing defaults; selection checks model support. */
    reasoningEffort?: ReasoningEffort | null;
    contextTier?: ContextTier | null;
    /** Private, host-approved workspace; never a browser/model-selected path. */
    workingDirectory: string;
    systemMessage: string;
    prompt: string;
    signal?: AbortSignal;
    progressStages?: string[];
    onProgress?: (event: EphemeralSessionProgress) => Promise<void>;
    /** Omit to retain synchronous native tasks and parent-only progress. */
    nativeChildren?: EphemeralNativeChildrenOptions;
    onChildProgress?: (event: EphemeralNativeChildProgress) => Promise<void>;
    /** In-memory observations only. The SDK does not persist them or charge provider meters. */
    onUsage?: (update: EphemeralSessionUsageUpdate) => Promise<void>;
    onResponse: (response: EphemeralSessionResponse) => Promise<EphemeralSessionDecision>;
    /**
     * Opt in to host-driven inter-batch context resets. Registers the internal
     * reset tool the runtime needs to honour a clear, and allows onResponse to
     * return `{ action: "clear_context", prompt }`.
     *
     * Absent or false, the session behaves exactly as before. Incompatible
     * with `nativeChildren`. Works on every provider
     * transport, because the reset uses only the runtime's own RPC and never
     * synthesizes provider traffic.
     */
    contextReset?: boolean;
}

export interface EphemeralSessionProgress {
    stage: string;
    completed: number;
    total: number | null;
    sequence: number;
    updatedAt: string;
    iteration: number;
}

export interface EphemeralSessionUsageUpdate {
    /** Correlates this execution/iteration's observations, not a stored invocation. */
    invocationId: string;
    iteration: number;
    resolvedModel: string;
    usage: EphemeralSessionUsage;
    /** Replace together with usage for this invocation; absent on older hosts. */
    usageDiagnostics?: EphemeralSessionUsageDiagnostics;
    completed: boolean;
    usageUncertain: boolean;
}

export interface EphemeralSessionResponse {
    text: string;
    iteration: number;
    resolvedModel: string;
    usage: EphemeralSessionUsage;
    usageDiagnostics?: EphemeralSessionUsageDiagnostics;
}

export type EphemeralSessionDecision =
    { action: "complete" }
    | { action: "continue"; prompt: string }
    /**
     * Reuse this session for the next batch after discarding the conversation
     * the previous batches built. `prompt` is the host's next batch prompt and
     * is delivered as an ordinary turn once the reset is proven; it is never
     * handed to the runtime's reseed.
     *
     * This is not total isolation. CLI 1.0.85 applies a clear one turn late,
     * so the SDK spends an internal turn on a fixed neutral seed and that
     * turn's assistant reply — written while the finished batch was still in
     * view — is the one message that survives into the next batch's window. It
     * can therefore mention previous work. Everything else is gone: every
     * earlier prompt, every earlier assistant and tool message, and the seed
     * itself. The internal turn performs real inference, and its usage is
     * reported with the batch it precedes.
     *
     * Requires `contextReset: true` and a qualified runtime, and is refused
     * with EPHEMERAL_RESET_UNSUPPORTED otherwise. Fails with
     * EPHEMERAL_RESET_FAILED rather than continuing on an unproven window.
     */
    | { action: "clear_context"; prompt: string };

export interface EphemeralSessionResult {
    text: string;
    resolvedModel: string;
    reasoningEffort?: ReasoningEffort;
    contextTier?: ContextTier;
    usage: EphemeralSessionUsage;
    usageDiagnostics?: EphemeralSessionUsageDiagnostics;
    usageUncertain: boolean;
    turnCount: number;
}

export type EphemeralSessionRunner = (request: EphemeralSessionRequest) => Promise<EphemeralSessionResult>;

export interface PilotSwarmHostServices {
    /**
     * Borrow the host's initialized CMS connection only for this callback.
     * Finish transactions and await queries before returning. Do not perform
     * inference or other long-running work inside the callback.
     */
    readonly withCmsConnection: WithCmsConnection;
    /**
     * Optional on CMS-only hosts. An unqualified native runtime version rejects
     * with EPHEMERAL_RUNTIME_UNQUALIFIED; presence alone is not authorization.
     */
    readonly runEphemeralSession?: EphemeralSessionRunner;
}

const HOST_SERVICE_ERRORS = {
    HOST_NOT_STARTED: "Host services require a started host.",
    HOST_SERVICES_EXPIRED: "These host services belong to a stopped host.",
    CMS_UNSUPPORTED: "This host does not support borrowed CMS connections.",
    CMS_NOT_INITIALIZED: "Borrowed CMS connections require an initialized catalog.",
    CMS_CONNECTION_RELEASED: "The borrowed CMS connection is no longer available.",
    CMS_QUERY_INVALID: "CMS queries require SQL text and an optional values array.",
} as const;

export type HostServicesErrorCode = keyof typeof HOST_SERVICE_ERRORS;

export class HostServicesError extends Error {
    constructor(readonly code: HostServicesErrorCode) {
        super(HOST_SERVICE_ERRORS[code]);
        this.name = "HostServicesError";
    }
}

/** @internal Host shutdown cancels and drains owned ephemeral work before CMS closes. */
export class HostEphemeralLifecycle {
    private controller = new AbortController();
    private readonly active = new Set<Promise<EphemeralSessionResult>>();
    get signal(): AbortSignal { return this.controller.signal; }
    reset(): void {
        if (this.active.size) throw new HostServicesError("HOST_SERVICES_EXPIRED");
        this.controller = new AbortController();
    }
    track(operation: Promise<EphemeralSessionResult>): Promise<EphemeralSessionResult> {
        this.active.add(operation);
        void operation.then(() => this.active.delete(operation), () => this.active.delete(operation));
        return operation;
    }
    async stop(): Promise<void> {
        this.controller.abort();
        await Promise.allSettled([...this.active]);
    }
}

/** @internal Bind existing handles; never initialize, replace or close them. */
export function createHostServices(
    isStarted: () => boolean,
    getCatalog: () => SessionCatalog | null,
    getProviderTypes?: () => ModelProviderRegistry | null,
    lifecycle?: HostEphemeralLifecycle,
    runtime: Pick<EphemeralSessionDependencies, "turnTimeoutMs" | "turnInactivityTimeoutMs"> = {},
): PilotSwarmHostServices {
    if (!isStarted()) throw new HostServicesError("HOST_NOT_STARTED");
    const catalog = getCatalog();
    if (typeof catalog?.withCmsConnection !== "function") throw new HostServicesError("CMS_UNSUPPORTED");
    const borrow = catalog.withCmsConnection.bind(catalog);
    const assertCurrent = () => {
        if (!isStarted() || getCatalog() !== catalog) throw new HostServicesError("HOST_SERVICES_EXPIRED");
    };
    const invoker = getProviderTypes && getProviderTypes() && catalog.providers
        ? createEphemeralSessionRunner({
            providers: catalog.providers,
            getUserRole: actor => catalog.getUserRole(actor),
        }, () => {
            assertCurrent();
            return getProviderTypes();
        }, { ...runtime, signal: lifecycle?.signal }) : undefined;
    return Object.freeze({
        withCmsConnection: async <T>(callback: CmsConnectionCallback<T>): Promise<T> => {
            assertCurrent();
            return borrow(callback);
        },
        ...(invoker ? { runEphemeralSession: async (request: EphemeralSessionRequest): Promise<EphemeralSessionResult> => {
            assertCurrent();
            const operation = invoker(request);
            return lifecycle ? lifecycle.track(operation) : operation;
        } } : {}),
    });
}
