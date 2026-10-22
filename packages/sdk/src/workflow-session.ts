import type { ChildOutcomeRow } from "./cms.js";
import type { WorkflowSessionResult } from "./types.js";

export interface WorkflowResultWaitOptions {
    timeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
}

type ChildOutcomeReader = (sessionId: string) => Promise<ChildOutcomeRow | null>;

function workflowError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

export function toWorkflowResult<TResult>(
    sessionId: string,
    parentSessionId: string,
    row: ChildOutcomeRow,
): WorkflowSessionResult<TResult> | null {
    if (!row.completedAt || !row.resultJson) return null;
    const result = row.resultJson as Record<string, unknown>;
    const outcome = result.outcome;
    if (outcome !== "succeeded" && outcome !== "blocked" && outcome !== "failed" && outcome !== "cancelled") {
        throw workflowError(
            `Workflow session ${sessionId} completed with an invalid result outcome.`,
            "WORKFLOW_RESULT_INVALID",
        );
    }
    if (typeof result.summary !== "string") {
        throw workflowError(
            `Workflow session ${sessionId} completed without a result summary.`,
            "WORKFLOW_RESULT_INVALID",
        );
    }
    return {
        sessionId,
        parentSessionId,
        outcome,
        summary: result.summary,
        ...(Object.prototype.hasOwnProperty.call(result, "result") ? { result: result.result as TResult } : {}),
        completedAt: row.completedAt.toISOString(),
        ...(result.metadata && typeof result.metadata === "object"
            ? { metadata: result.metadata as Record<string, unknown> }
            : {}),
    };
}

/**
 * A controller-backed session handle. It intentionally exposes no chat methods.
 * The workflow controller writes the terminal child outcome consumed here.
 */
export class WorkflowSession<TResult = unknown> {
    constructor(
        readonly sessionId: string,
        readonly parentSessionId: string | undefined,
        private readonly readChildOutcome: ChildOutcomeReader,
    ) {}

    async waitForResult(options: WorkflowResultWaitOptions = {}): Promise<WorkflowSessionResult<TResult>> {
        if (!this.parentSessionId) {
            throw workflowError(
                "Only child workflow sessions return a result to a parent caller.",
                "WORKFLOW_RESULT_PARENT_REQUIRED",
            );
        }
        const timeoutMs = options.timeoutMs ?? 0;
        const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 1_000);
        const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;

        while (true) {
            if (options.signal?.aborted) {
                throw options.signal.reason instanceof Error
                    ? options.signal.reason
                    : workflowError("Workflow result wait was aborted.", "WORKFLOW_RESULT_WAIT_ABORTED");
            }
            const row = await this.readChildOutcome(this.sessionId);
            if (row) {
                const result = toWorkflowResult<TResult>(this.sessionId, this.parentSessionId, row);
                if (result) return result;
            }
            if (deadline !== null && Date.now() >= deadline) {
                throw workflowError(
                    `Timed out waiting for workflow session ${this.sessionId} to return a result.`,
                    "WORKFLOW_RESULT_WAIT_TIMEOUT",
                );
            }
            await new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                    clearTimeout(timer);
                    reject(options.signal!.reason instanceof Error
                        ? options.signal!.reason
                        : workflowError("Workflow result wait was aborted.", "WORKFLOW_RESULT_WAIT_ABORTED"));
                };
                const timer = setTimeout(() => {
                    options.signal?.removeEventListener("abort", onAbort);
                    resolve();
                }, pollIntervalMs);
                options.signal?.addEventListener("abort", onAbort, { once: true });
            });
        }
    }
}
