import { randomUUID } from "node:crypto";
import type {
    InitialSessionFactory,
    WorkflowRunInducerStore,
} from "./controller.js";
import { effectiveWorkflowGeneratorLeaseSeconds } from "./providers.js";

export interface WorkflowRunInducerOptions {
    store: WorkflowRunInducerStore;
    sessionFactory: InitialSessionFactory;
    workerId?: string;
    pollIntervalMs?: number;
    claimLimit?: number;
    leaseSeconds?: number;
    logger?: Pick<Console, "info" | "error" | "warn">;
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

export class WorkflowRunInducer {
    private readonly store: WorkflowRunInducerStore;
    private readonly sessionFactory: InitialSessionFactory;
    private readonly workerId: string;
    private readonly pollIntervalMs: number;
    private readonly claimLimit: number;
    private readonly leaseSeconds: number;
    private readonly logger: Pick<Console, "info" | "error" | "warn">;

    constructor(options: WorkflowRunInducerOptions) {
        this.store = options.store;
        this.sessionFactory = options.sessionFactory;
        this.workerId = options.workerId ?? `workflow-run-inducer-${randomUUID()}`;
        this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 15_000, "pollIntervalMs");
        this.claimLimit = positiveInteger(options.claimLimit ?? 10, "claimLimit");
        this.leaseSeconds = effectiveWorkflowGeneratorLeaseSeconds(
            options.leaseSeconds ?? 300,
            "leaseSeconds",
        );
        this.logger = options.logger ?? console;
    }

    async runOnce(): Promise<number> {
        const claims = await this.store.claimWorkflowRunsForInduction(
            this.workerId,
            this.claimLimit,
            this.leaseSeconds,
        );
        this.logger.info(`[workflow-run-inducer] poll claimed=${claims.length}`);
        let induced = 0;
        for (const claim of claims) {
            let sessionCreationAttempted = false;
            let failureRecorded = false;
            try {
                sessionCreationAttempted = true;
                await this.sessionFactory.createInitialSession({
                    definition: claim.definition,
                    workflowRun: claim.workflowRun,
                    association: claim.association,
                    executionAffinity: claim.executionAffinity,
                    onSessionCreated: async () => {
                        await this.store.attachWorkflowRunSession(
                            claim.workflowRun.workflowRunId,
                            claim.association.sessionId,
                            null,
                            this.workerId,
                        );
                        induced += 1;
                    },
                });
                await this.store.attachWorkflowRunSession(
                    claim.workflowRun.workflowRunId,
                    claim.association.sessionId,
                    null,
                    this.workerId,
                );
            } catch (error) {
                const failure = error instanceof Error ? error : new Error(String(error));
                try {
                    await this.store.failWorkflowRunSession(
                        claim.workflowRun.workflowRunId,
                        claim.association.sessionId,
                        null,
                        this.workerId,
                        failure.message,
                    );
                    failureRecorded = true;
                } catch (storeError) {
                    this.logger.error(
                        `[workflow-run-inducer] failed to record induction failure for ${claim.workflowRun.workflowRunId}`,
                        storeError,
                    );
                }
                if (sessionCreationAttempted && failureRecorded) {
                    try {
                        await this.sessionFactory.deleteInitialSession(
                            claim.association.sessionId,
                            `Initial session induction failed: ${failure.message}`,
                        );
                    } catch (cleanupError) {
                        this.logger.error(
                            `[workflow-run-inducer] failed to clean up initial session ${claim.association.sessionId}`,
                            cleanupError,
                        );
                    }
                }
                this.logger.error(
                    `[workflow-run-inducer] WorkflowRun induction failed ${claim.workflowRun.workflowRunId}`,
                    failure,
                );
            }
        }
        return induced;
    }

    async run(signal?: AbortSignal): Promise<void> {
        while (!signal?.aborted) {
            try {
                await this.runOnce();
            } catch (error) {
                this.logger.error("[workflow-run-inducer] polling failed", error);
            }
            if (signal?.aborted) break;
            await waitForPoll(this.pollIntervalMs, signal);
        }
    }
}
