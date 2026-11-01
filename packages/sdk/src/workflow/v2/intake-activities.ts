/**
 * Durable recipient intake (design docs/proposals/workflow-durable-intake.md
 * 5.2, 5.4 and section 8, amendment 2): the two activities a session on
 * orchestration 1.0.83 schedules, claimWorkflowIntake and
 * settleWorkflowIntake, as handlers over the workflow store. INACTIVE: no
 * worker registers them; only tests call registerWorkflowIntakeActivities, as
 * only tests register orchestration 1.0.83.
 *
 * - The claim renders the canonical item with the sender's own renderer
 *   (workflowSendPrompt and workflowSendClientMessageId), so the store, which
 *   does not import the runtime, admits exactly what a delivery queued.
 * - A transient store error is retried in the activity, after 1 s, 5 s and
 *   15 s. A worker without a workflow store, retries that run out and any
 *   other failure throw: the orchestration keeps the write and makes it again
 *   when it is due on its wake (intake-machine.ts).
 * - The store's refusal of a broken invariant or of a malformed input is an
 *   answer, not a failure: `{ ok: false, error }`, on which the execution
 *   fails visibly and dispatches nothing. Every other answer is
 *   `{ ok: true, result }`, the store's result as it returned it.
 */
import type { ActivityContext } from "duroxide";
import { isTransientCmsError } from "../../cms-retry.js";
import { WorkflowJsonError } from "./json.js";
import { INTAKE_MAX_HELD, IntakeShapeError, WORKFLOW_INTAKE_ACTIVITIES, intakeObject } from "./intake.js";
import { workflowSendClientMessageId, workflowSendPrompt, type WorkflowV2ActivityRuntime } from "./runtime.js";
import { WorkflowStoreError, type WorkflowIntakeRender, type WorkflowStore } from "./store.js";

/** The intake's activity names (design section 8), defined with the shared intake pieces. */
export { WORKFLOW_INTAKE_ACTIVITIES };

/** The in-activity waits before each retry of a transient store error (design 5.4, F9). */
export const WORKFLOW_INTAKE_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000];

/** The sender's own renderer: the text and client message id every delivery of the exchange queued. */
export const workflowIntakeRender: WorkflowIntakeRender = source => ({
    text: workflowSendPrompt(source),
    clientMessageId: workflowSendClientMessageId(source.workflowSessionId, source.runId, source.nodeExecutionId),
});

/** An intake write this worker cannot make now; the orchestration makes it again when it is due. */
export class WorkflowIntakeUnavailableError extends Error {
    readonly code = "WORKFLOW_INTAKE_UNAVAILABLE";
    constructor(message: string) {
        super(message);
        this.name = "WorkflowIntakeUnavailableError";
    }
}

/** An activity's answer: the store's result, or its refusal of a broken invariant or a malformed input. */
export type WorkflowIntakeAnswer = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

export interface WorkflowIntakeActivityDeps {
    /** The worker's workflow store; null on a worker that has none. */
    store: WorkflowStore | null;
    /** The waits before each retry of a transient store error; default WORKFLOW_INTAKE_RETRY_DELAYS_MS. */
    retryDelaysMs?: readonly number[];
    /** How a wait is made; default a timer. */
    sleep?: (ms: number) => Promise<void>;
}

function refusalOf(error: unknown): { code: string; message: string } | null {
    if (error instanceof WorkflowStoreError || error instanceof IntakeShapeError || error instanceof WorkflowJsonError) {
        return { code: error.code, message: error.message };
    }
    return null;
}

/**
 * Make one store write: its result or the store's refusal as the answer;
 * a transient error retried after each of the waits; anything else thrown.
 */
async function answer(deps: WorkflowIntakeActivityDeps, label: string, write: (store: WorkflowStore) => Promise<unknown>, log?: (message: string) => void)
    : Promise<WorkflowIntakeAnswer> {
    const store = deps.store;
    if (!store) throw new WorkflowIntakeUnavailableError(`${label}: this worker has no workflow store.`);
    const delays = deps.retryDelaysMs ?? WORKFLOW_INTAKE_RETRY_DELAYS_MS;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt += 1) {
        try {
            return { ok: true, result: await write(store) };
        } catch (error) {
            const refusal = refusalOf(error);
            if (refusal !== null) return { ok: false, error: refusal };
            if (!isTransientCmsError(error) || attempt >= delays.length) throw error;
            log?.(`[intake] ${label}: transient store error (attempt ${attempt + 1} of ${delays.length + 1}), retrying in ${delays[attempt]} ms: ${
                error instanceof Error ? error.message : String(error)}`);
            await sleep(delays[attempt]);
        }
    }
}

function text(value: unknown): string {
    // The store checks every id and value it is given; a value of another type reaches it as itself and is refused there.
    return value as string;
}

/** A list of 1 to INTAKE_MAX_HELD items with exactly `keys`. */
function listOf(raw: unknown, path: string, keys: readonly string[]): Array<Record<string, unknown>> {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > INTAKE_MAX_HELD) {
        throw new IntakeShapeError(path, `is not a list of 1 to ${INTAKE_MAX_HELD} items`);
    }
    return raw.map((item: unknown, index: number) => intakeObject(item, `${path}[${index}]`, keys));
}

/** The claim (design 5.2): `{ recipientSessionId, envelope, claimId, mode }`, rendered with the sender's own renderer. */
export async function runWorkflowIntakeClaim(deps: WorkflowIntakeActivityDeps, input: unknown, log?: (message: string) => void): Promise<WorkflowIntakeAnswer> {
    return answer(deps, WORKFLOW_INTAKE_ACTIVITIES.claim, store => {
        const value = intakeObject(input, "claim", ["recipientSessionId", "envelope", "claimId", "mode"]);
        let mode: "accept" | "refuse";
        if (value.mode === "accept") mode = "accept";
        else if (value.mode === "refuse") mode = "refuse";
        else throw new IntakeShapeError("claim.mode", "is not accept or refuse");
        return store.claimWorkflowIntake({
            recipientSessionId: text(value.recipientSessionId), envelope: value.envelope as Parameters<WorkflowStore["claimWorkflowIntake"]>[0]["envelope"],
            claimId: text(value.claimId), mode, render: workflowIntakeRender,
        });
    }, log);
}

/**
 * A settlement (design 5.2), by `op`:
 * - `bind` { recipientSessionId, invocationId, items: [{ exchangeId, claimId }] }
 * - `end` { recipientSessionId, invocationId, outcome, items: [{ exchangeId, claimId, cancelRequested }] }, items possibly empty
 * - `cancel_held` { recipientSessionId, items: [{ exchangeId, claimId }] }: each holding row cancelled
 * - `cancel_unsent` { recipientSessionId, invocationId, items }: each item of an unsent invocation not_dispatched (cancelled)
 * - `request_cancel` { recipientSessionId, invocationId, items }: each item of a sent invocation records cancel_requested
 * - `refuse` { recipientSessionId, exchangeId, claimId, outcome }: a holding row refused_full or refused_size
 * A list is settled item by item in its order; every settle is the same
 * result when repeated, so a retry repeats the whole list.
 */
export async function runWorkflowIntakeSettle(deps: WorkflowIntakeActivityDeps, input: unknown, log?: (message: string) => void)
    : Promise<WorkflowIntakeAnswer> {
    return answer(deps, WORKFLOW_INTAKE_ACTIVITIES.settle, async store => {
        const op: unknown = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>).op : undefined;
        if (op === "bind") {
            const value = intakeObject(input, "settle", ["op", "recipientSessionId", "invocationId", "items"]);
            const items = listOf(value.items, "settle.items", ["exchangeId", "claimId"]);
            return store.bindWorkflowIntake({
                recipientSessionId: text(value.recipientSessionId), invocationId: text(value.invocationId),
                items: items.map(item => ({ exchangeId: text(item.exchangeId), claimId: text(item.claimId) })),
            });
        }
        if (op === "end") {
            const value = intakeObject(input, "settle", ["op", "recipientSessionId", "invocationId", "outcome", "items"]);
            const rawItems = value.items;
            const items: Array<Record<string, unknown>> = Array.isArray(rawItems) && rawItems.length === 0
                ? [] : listOf(rawItems, "settle.items", ["exchangeId", "claimId", "cancelRequested"]);
            return store.endWorkflowIntake({
                recipientSessionId: text(value.recipientSessionId), invocationId: text(value.invocationId),
                outcome: value.outcome as Parameters<WorkflowStore["endWorkflowIntake"]>[0]["outcome"],
                items: items.map(item => ({ exchangeId: text(item.exchangeId), claimId: text(item.claimId), cancelRequested: item.cancelRequested as boolean })),
            });
        }
        if (op === "cancel_held") {
            const value = intakeObject(input, "settle", ["op", "recipientSessionId", "items"]);
            const items = listOf(value.items, "settle.items", ["exchangeId", "claimId"]);
            const results: Array<{ exchangeId: string; cancelled: boolean }> = [];
            for (const item of items) {
                const settled = await store.cancelHeldWorkflowIntake({
                    recipientSessionId: text(value.recipientSessionId), exchangeId: text(item.exchangeId), claimId: text(item.claimId),
                });
                results.push({ exchangeId: text(item.exchangeId), cancelled: settled.cancelled });
            }
            return { items: results };
        }
        if (op === "cancel_unsent" || op === "request_cancel") {
            const value = intakeObject(input, "settle", ["op", "recipientSessionId", "invocationId", "items"]);
            const items = listOf(value.items, "settle.items", ["exchangeId", "claimId"]);
            const results: Array<{ exchangeId: string; settled: boolean }> = [];
            for (const item of items) {
                const call = {
                    recipientSessionId: text(value.recipientSessionId), invocationId: text(value.invocationId),
                    exchangeId: text(item.exchangeId), claimId: text(item.claimId),
                };
                const settled = op === "cancel_unsent"
                    ? (await store.cancelUnsentWorkflowIntake(call)).cancelled
                    : (await store.requestCancelWorkflowIntake(call)).recorded;
                results.push({ exchangeId: call.exchangeId, settled });
            }
            return { items: results };
        }
        if (op === "refuse") {
            const value = intakeObject(input, "settle", ["op", "recipientSessionId", "exchangeId", "claimId", "outcome"]);
            return store.refuseHeldWorkflowIntake({
                recipientSessionId: text(value.recipientSessionId), exchangeId: text(value.exchangeId), claimId: text(value.claimId),
                outcome: value.outcome as Parameters<WorkflowStore["refuseHeldWorkflowIntake"]>[0]["outcome"],
            });
        }
        throw new IntakeShapeError("settle.op", "is not bind, end, cancel_held, cancel_unsent, request_cancel or refuse");
    }, log);
}

/**
 * Register the two intake activities on a runtime. Only tests call this
 * while the intake is inactive; a production worker registers neither.
 */
export function registerWorkflowIntakeActivities(runtime: Pick<WorkflowV2ActivityRuntime, "registerActivity">, deps: WorkflowIntakeActivityDeps): void {
    const traced = (actx: ActivityContext) => (message: string) => actx.traceWarn(message);
    runtime.registerActivity(WORKFLOW_INTAKE_ACTIVITIES.claim, (actx, input) => runWorkflowIntakeClaim(deps, input, traced(actx)));
    runtime.registerActivity(WORKFLOW_INTAKE_ACTIVITIES.settle, (actx, input) => runWorkflowIntakeSettle(deps, input, traced(actx)));
}
