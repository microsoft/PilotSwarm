import { randomUUID } from "node:crypto";
import type {
    WorkflowRunExternalOperationRow,
    WorkflowRunWaitObserverSelector,
    WorkflowRunWaitRow,
    SessionCatalog,
} from "./cms.js";

export interface WorkflowRunWaitSignalSender {
    sendSystemSignal(sessionId: string, signalKey: string, payload?: unknown): Promise<void>;
}

export type WorkflowRunWaitSchedulerStore = Pick<
    SessionCatalog,
    | "claimDueWorkflowRunWaits"
    | "completeWorkflowRunWaitCheck"
    | "getWorkflowRunExternalOperation"
    | "claimWorkflowRunExternalOperationSignals"
    | "markWorkflowRunExternalOperationSignalDelivered"
    | "markWorkflowRunExternalOperationSignalFailed"
>;

export interface WorkflowRunWaitObservation {
    disposition: "pending" | "satisfied" | "failed";
    observation?: unknown;
    cursor?: string | null;
    evidence?: unknown;
    result?: unknown;
    error?: string | null;
    nextCheckAt?: Date;
}

export interface WorkflowRunWaitObserver {
    readonly provider: string;
    readonly kind?: string;
    observe(input: {
        wait: WorkflowRunWaitRow;
        operation: WorkflowRunExternalOperationRow;
    }): Promise<WorkflowRunWaitObservation>;
}

export interface WorkflowRunWaitSchedulerOptions {
    store: WorkflowRunWaitSchedulerStore;
    signalSender: WorkflowRunWaitSignalSender;
    observers?: Iterable<WorkflowRunWaitObserver>;
    workerId?: string;
    pollIntervalMs?: number;
    defaultCheckIntervalMs?: number;
    retryDelayMs?: number;
    maxRetryDelayMs?: number;
    claimLimit?: number;
    leaseSeconds?: number;
    logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface WorkflowRunWaitSchedulerRunResult {
    checked: number;
    pending: number;
    satisfied: number;
    failed: number;
    timedOut: number;
    checkFailed: number;
    delivered: number;
    deliveryFailed: number;
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return value;
}

function waitForPoll(intervalMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, intervalMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

function observerIdentifier(value: string, label: string): string {
    const normalized = value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_.-]*$/.test(normalized)) {
        throw new Error(`WorkflowRunWait observer ${label} must be a lowercase identifier`);
    }
    return normalized;
}

function observerKey(provider: string, kind?: string): string {
    const normalizedProvider = observerIdentifier(provider, "provider");
    const normalizedKind = kind === undefined
        ? "*"
        : observerIdentifier(kind, "kind");
    return `${normalizedProvider}:${normalizedKind}`;
}

export class MockWorkflowRunWaitObserver implements WorkflowRunWaitObserver {
    readonly provider = "mock";

    async observe(input: {
        wait: WorkflowRunWaitRow;
        operation: WorkflowRunExternalOperationRow;
    }): Promise<WorkflowRunWaitObservation> {
        const requestedOutcome = input.operation.request.outcome;
        const pendingChecks = Number(input.operation.request.pendingChecks ?? 0);
        if (Number.isInteger(pendingChecks) && pendingChecks >= input.wait.checkAttempts) {
            return {
                disposition: "pending",
                observation: {
                    mock: true,
                    provider: input.operation.provider,
                    kind: input.operation.kind,
                    correlationId: input.operation.correlationId,
                    checkAttempt: input.wait.checkAttempts,
                },
                cursor: String(input.wait.checkAttempts),
            };
        }

        const outcome = requestedOutcome === undefined || requestedOutcome === "succeeded"
            ? "succeeded"
            : "failed";
        const invalidOutcome = requestedOutcome !== undefined
            && requestedOutcome !== "succeeded"
            && requestedOutcome !== "failed";
        const result = input.operation.request.result ?? {
            mock: true,
            provider: input.operation.provider,
            kind: input.operation.kind,
            correlationId: input.operation.correlationId,
            outcome,
        };
        const evidence = input.operation.request.evidence ?? {
            mock: true,
            provider: input.operation.provider,
            kind: input.operation.kind,
            correlationId: input.operation.correlationId,
        };
        return {
            disposition: outcome === "succeeded" ? "satisfied" : "failed",
            observation: result,
            result,
            evidence,
            error: outcome === "failed"
                ? String(
                    invalidOutcome
                        ? "Mock external operation outcome must be succeeded or failed"
                        : input.operation.request.error
                            || `Mock ${input.operation.kind} operation failed`,
                )
                : null,
        };
    }
}

export class WorkflowRunWaitScheduler {
    private readonly store: WorkflowRunWaitSchedulerStore;
    private readonly signalSender: WorkflowRunWaitSignalSender;
    private readonly observers = new Map<string, WorkflowRunWaitObserver>();
    private readonly observerSelectors: WorkflowRunWaitObserverSelector[];
    private readonly workerId: string;
    private readonly pollIntervalMs: number;
    private readonly defaultCheckIntervalMs: number;
    private readonly retryDelayMs: number;
    private readonly maxRetryDelayMs: number;
    private readonly claimLimit: number;
    private readonly leaseSeconds: number;
    private readonly logger: Pick<Console, "info" | "warn" | "error">;

    constructor(options: WorkflowRunWaitSchedulerOptions) {
        this.store = options.store;
        this.signalSender = options.signalSender;
        this.workerId = options.workerId ?? `workflow-run-wait-scheduler-${randomUUID()}`;
        this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 500, "pollIntervalMs");
        this.defaultCheckIntervalMs = positiveInteger(
            options.defaultCheckIntervalMs ?? 5_000,
            "defaultCheckIntervalMs",
        );
        this.retryDelayMs = positiveInteger(options.retryDelayMs ?? 1_000, "retryDelayMs");
        this.maxRetryDelayMs = positiveInteger(
            options.maxRetryDelayMs ?? 60_000,
            "maxRetryDelayMs",
        );
        if (this.maxRetryDelayMs < this.retryDelayMs) {
            throw new Error("maxRetryDelayMs must be greater than or equal to retryDelayMs");
        }
        this.claimLimit = positiveInteger(options.claimLimit ?? 25, "claimLimit");
        this.leaseSeconds = positiveInteger(options.leaseSeconds ?? 30, "leaseSeconds");
        this.logger = options.logger ?? console;
        for (const observer of options.observers ?? []) {
            const provider = observerIdentifier(observer.provider, "provider");
            const kind = observer.kind === undefined
                ? undefined
                : observerIdentifier(observer.kind, "kind");
            const key = observerKey(provider, kind);
            if (this.observers.has(key)) {
                throw new Error(`Duplicate WorkflowRunWait observer: ${key}`);
            }
            this.observers.set(key, observer);
        }
        this.observerSelectors = [...this.observers.values()].map((observer) => ({
            provider: observerIdentifier(observer.provider, "provider"),
            ...(observer.kind === undefined
                ? {}
                : { kind: observerIdentifier(observer.kind, "kind") }),
        }));
    }

    private retryAt(attempt: number): Date {
        const exponent = Math.max(0, Math.min(30, attempt - 1));
        const delay = Math.min(this.maxRetryDelayMs, this.retryDelayMs * (2 ** exponent));
        return new Date(Date.now() + delay);
    }

    private pendingAt(observation: WorkflowRunWaitObservation): Date {
        if (observation.nextCheckAt) {
            if (!Number.isFinite(observation.nextCheckAt.getTime())) {
                throw new Error("WorkflowRunWait observer returned an invalid nextCheckAt");
            }
            return observation.nextCheckAt;
        }
        return new Date(Date.now() + this.defaultCheckIntervalMs);
    }

    private async checkWait(wait: WorkflowRunWaitRow): Promise<WorkflowRunWaitObservation["disposition"] | "timed_out"> {
        if (!wait.externalOperationId) {
            throw new Error("Observed-condition WorkflowRunWait has no external operation");
        }
        const operation = await this.store.getWorkflowRunExternalOperation(
            wait.sessionId,
            wait.externalOperationId,
        );
        if (!operation) {
            throw new Error(`External operation not found: ${wait.externalOperationId}`);
        }
        const observer = this.observers.get(observerKey(operation.provider, operation.kind))
            ?? this.observers.get(observerKey(operation.provider));
        if (!observer) {
            throw new Error(
                `No WorkflowRunWait observer registered for provider/kind: `
                + `${operation.provider}/${operation.kind}`,
            );
        }
        const observation = await observer.observe({ wait, operation });
        if (
            observation.disposition !== "pending"
            && observation.disposition !== "satisfied"
            && observation.disposition !== "failed"
        ) {
            throw new Error("WorkflowRunWait observer returned an invalid disposition");
        }

        const completed = await this.store.completeWorkflowRunWaitCheck({
            waitId: wait.waitId,
            workerId: this.workerId,
            disposition: observation.disposition,
            observation: observation.observation,
            providerCursor: observation.cursor,
            evidence: observation.evidence,
            result: observation.result,
            error: observation.error,
            nextCheckAt: observation.disposition === "pending"
                ? this.pendingAt(observation)
                : undefined,
        });
        if (completed?.status === "timed_out") return "timed_out";
        return observation.disposition;
    }

    async runOnce(): Promise<WorkflowRunWaitSchedulerRunResult> {
        const result: WorkflowRunWaitSchedulerRunResult = {
            checked: 0,
            pending: 0,
            satisfied: 0,
            failed: 0,
            timedOut: 0,
            checkFailed: 0,
            delivered: 0,
            deliveryFailed: 0,
        };
        const waits = await this.store.claimDueWorkflowRunWaits(
            this.workerId,
            this.claimLimit,
            this.leaseSeconds,
            this.observerSelectors,
        );
        for (const wait of waits) {
            try {
                const disposition = await this.checkWait(wait);
                result.checked += 1;
                if (disposition === "pending") result.pending += 1;
                else if (disposition === "satisfied") result.satisfied += 1;
                else if (disposition === "failed") result.failed += 1;
                else result.timedOut += 1;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(`[workflow-run-wait] check failed wait=${wait.waitId}: ${message}`);
                let timedOut = false;
                try {
                    const completed = await this.store.completeWorkflowRunWaitCheck({
                        waitId: wait.waitId,
                        workerId: this.workerId,
                        disposition: "pending",
                        observation: wait.latestObservation,
                        providerCursor: wait.providerCursor,
                        error: message,
                        nextCheckAt: this.retryAt(wait.consecutiveCheckFailures + 1),
                    });
                    timedOut = completed?.status === "timed_out";
                } catch (markError) {
                    this.logger.warn(
                        `[workflow-run-wait] check retry bookkeeping failed wait=${wait.waitId}: `
                        + `${markError instanceof Error ? markError.message : String(markError)}`,
                    );
                }
                if (timedOut) {
                    result.checked += 1;
                    result.timedOut += 1;
                } else {
                    result.checkFailed += 1;
                }
            }
        }

        const signals = await this.store.claimWorkflowRunExternalOperationSignals(
            this.workerId,
            this.claimLimit,
            this.leaseSeconds,
        );
        for (const operation of signals) {
            try {
                await this.signalSender.sendSystemSignal(
                    operation.sessionId,
                    operation.signalKey,
                    {
                        operationId: operation.operationId,
                        correlationId: operation.correlationId,
                        provider: operation.provider,
                        kind: operation.kind,
                        status: operation.status,
                        result: operation.result,
                        evidence: operation.evidence,
                        error: operation.error,
                    },
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    `[workflow-run-wait] signal delivery failed operation=${operation.operationId}: ${message}`,
                );
                try {
                    await this.store.markWorkflowRunExternalOperationSignalFailed(
                        operation.operationId,
                        this.workerId,
                        message,
                        new Date(Date.now() + this.retryDelayMs),
                    );
                } catch (markError) {
                    this.logger.warn(
                        `[workflow-run-wait] signal retry bookkeeping failed operation=${operation.operationId}: `
                        + `${markError instanceof Error ? markError.message : String(markError)}`,
                    );
                }
                result.deliveryFailed += 1;
                continue;
            }
            try {
                await this.store.markWorkflowRunExternalOperationSignalDelivered(
                    operation.operationId,
                    this.workerId,
                );
                result.delivered += 1;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(
                    `[workflow-run-wait] signal delivery bookkeeping failed operation=${operation.operationId}: ${message}`,
                );
            }
        }
        return result;
    }

    async run(signal?: AbortSignal): Promise<void> {
        while (!signal?.aborted) {
            try {
                await this.runOnce();
            } catch (error) {
                this.logger.error("[workflow-run-wait] scheduler poll failed", error);
            }
            if (signal?.aborted) break;
            await waitForPoll(this.pollIntervalMs, signal);
        }
    }
}

export type WorkflowRunExternalOperationSignalSender = WorkflowRunWaitSignalSender;
export type WorkflowRunExternalOperationProducerStore = WorkflowRunWaitSchedulerStore;
export type MockWorkflowRunExternalOperationProducerOptions = Omit<WorkflowRunWaitSchedulerOptions, "observers">;

/**
 * Compatibility wrapper for callers that previously enabled the mock-only producer.
 */
export class MockWorkflowRunExternalOperationProducer extends WorkflowRunWaitScheduler {
    constructor(options: MockWorkflowRunExternalOperationProducerOptions) {
        super({ ...options, observers: [new MockWorkflowRunWaitObserver()] });
    }
}
