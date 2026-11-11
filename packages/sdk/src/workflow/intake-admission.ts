/**
 * Durable recipient intake: the worker's admission of an attempt's include
 * (exposure protocol revision 2, section 4; decision
 * intake-exposure-r2-implementation). Only runTurnV5 (every worker registers
 * it for orchestration 1.0.83's turns) calls it, and only for a turn that
 * carries an intake invocation: durable intake is off unless the deployment
 * capability is on.
 *
 * Before a model request may include an invocation's items, the store
 * records that they were possibly seen, or refuses
 * (WorkflowStore.exposeWorkflowIntake, migration 0088). The request names
 * the recipient from the activity's own session, the attempt's id and
 * `sentBefore` as the orchestration recorded them, and each item's exchange
 * and claim with the hash of the exact text the request would include,
 * computed here from that text; the store compares it with its stored
 * canonical text's hash.
 *
 * - An answer, allowed or a typed refusal (`exposed`, `settled`), is returned
 *   as the store gave it.
 * - A transient store failure is asked again in place, with the same
 *   request: a COMMIT whose answer was lost is reconfirmed under the same
 *   attempt id, never taken as a rollback. Nothing may be sent before a
 *   positive answer.
 * - Every other outcome throws WorkflowIntakeAdmissionError, and nothing may
 *   be sent: not retryable when no retry can fix it (the store's refusal of
 *   a broken invariant or a malformed request, a programming error, a
 *   PostgreSQL error of class 22, 23 or 42, an answer of another shape);
 *   retryable otherwise (the transient retries ran out, an unknown failure,
 *   a worker without a workflow store, a run that stopped waiting).
 */
import { isTransientCmsError } from "../cms-retry.js";
import { IntakeShapeError } from "./intake.js";
import { sha256Hex, WorkflowJsonError } from "./json.js";
import { WorkflowStoreError, type WorkflowIntakeAdmission, type WorkflowStore } from "./store.js";

/** The in-place waits before each new ask after a transient store failure, as the intake activities wait (design 5.4, F9). */
export const WORKFLOW_INTAKE_ADMISSION_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000];

/** An admission that gave no answer: nothing may be sent. `retryable` is false when no retry can fix it. */
export class WorkflowIntakeAdmissionError extends Error {
    readonly code = "WORKFLOW_INTAKE_ADMISSION_FAILED";
    constructor(message: string, readonly retryable: boolean, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "WorkflowIntakeAdmissionError";
    }
}

/** What an attempt asks to include: its invocation, its id, whether it is the invocation's own retry, and each item's exact text. */
export interface WorkflowIntakeAdmissionRequest {
    recipientSessionId: string;
    invocationId: string;
    attemptId: string;
    sentBefore: boolean;
    /** The items in batch order, each with the exact text the request would include. */
    items: ReadonlyArray<{ exchangeId: string; claimId: string; text: string }>;
}

/** PostgreSQL error classes whose failure does not change between attempts: data exception, integrity constraint violation, syntax error or access rule violation. */
const NON_RETRYABLE_SQL_CLASSES: ReadonlySet<string> = new Set(["22", "23", "42"]);

/** Whether no retry can fix a failure: the store's refusal, a malformed value, a programming error or a deterministic SQL error. */
function deterministic(error: unknown): boolean {
    if (error instanceof WorkflowStoreError || error instanceof IntakeShapeError || error instanceof WorkflowJsonError) return true;
    if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || error instanceof SyntaxError) return true;
    const code: unknown = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && NON_RETRYABLE_SQL_CLASSES.has(code.slice(0, 2));
}

function stoppedWaiting(): WorkflowIntakeAdmissionError {
    return new WorkflowIntakeAdmissionError("Workflow intake admission: the run stopped waiting for an answer.", true);
}

/** Wait `ms`, or reject as soon as `signal` is aborted. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(stoppedWaiting());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(stoppedWaiting());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        (timer as any).unref?.();
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** The store's answer, checked: allowed, or a refusal with its reason; anything else is a broken protocol. */
function admissionOf(raw: unknown): WorkflowIntakeAdmission {
    const value = raw as { allowed?: unknown; reason?: unknown } | null;
    if (value !== null && typeof value === "object") {
        const keys = Object.keys(value).sort().join(",");
        if (keys === "allowed" && value.allowed === true) return { allowed: true };
        if (keys === "allowed,reason" && value.allowed === false && (value.reason === "exposed" || value.reason === "settled")) {
            return { allowed: false, reason: value.reason };
        }
    }
    throw new WorkflowIntakeAdmissionError(
        `Workflow intake admission: the store answered ${JSON.stringify(raw) ?? String(raw)}, which is not an admission.`, false);
}

/**
 * Ask the store to admit the attempt's include (see the module comment).
 * `signal`, when aborted, ends the in-place retries: the run no longer waits.
 */
export async function admitWorkflowIntake(
    store: Pick<WorkflowStore, "exposeWorkflowIntake"> | null,
    request: WorkflowIntakeAdmissionRequest,
    options: { signal?: AbortSignal; delaysMs?: readonly number[] } = {},
): Promise<WorkflowIntakeAdmission> {
    if (store === null) throw new WorkflowIntakeAdmissionError("Workflow intake admission: this worker has no workflow store.", true);
    const call = {
        recipientSessionId: request.recipientSessionId,
        invocationId: request.invocationId,
        attemptId: request.attemptId,
        sentBefore: request.sentBefore,
        items: request.items.map(item => ({ exchangeId: item.exchangeId, claimId: item.claimId, textSha256: sha256Hex(item.text) })),
    };
    const delays = options.delaysMs ?? WORKFLOW_INTAKE_ADMISSION_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt += 1) {
        if (options.signal?.aborted) throw stoppedWaiting();
        let raw: unknown = undefined;
        try {
            raw = await store.exposeWorkflowIntake(call);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (deterministic(error)) {
                throw new WorkflowIntakeAdmissionError(`Workflow intake admission failed, and no retry can fix it: ${message}`, false, { cause: error });
            }
            if (!isTransientCmsError(error) || attempt >= delays.length) {
                throw new WorkflowIntakeAdmissionError(`Workflow intake admission failed: ${message}`, true, { cause: error });
            }
            await pause(delays[attempt], options.signal);
            continue;
        }
        return admissionOf(raw);
    }
}
