import { WORKFLOW_COMMAND_QUEUE } from "../orchestration.js";
import { workflowStoreFailure } from "./failure.js";
import { jsonbSafeText, type JsonValue } from "./json.js";
import { ACTIVE_RUN_STATUSES, type WorkflowStore } from "./store.js";

/**
 * Workflow v2 request states: the responder's tool and the durable wake
 * dispatcher (design workflow-messaging-request.md sections 5, 6 and 8.3).
 * INACTIVE: only a test registers the tool (on a 1.0.83 turn) and starts a
 * dispatcher; no worker does.
 */

/** The tool an agent session answers a workflow's request with (design 6, 8.3). */
export const RESPOND_SESSION_REQUEST_TOOL = "respond_session_request";

/** The respond_session_request tool's description and parameters. */
export const RESPOND_SESSION_REQUEST_TOOL_SPEC = {
    description:
        "Answer a typed request that a workflow sent you, once, before its deadline. "
        + "request_id is the requestId of the request; operation_id is an id you choose for this answer: repeat the same call with it to retry, "
        + "and you get the same receipt. Give exactly one of response (a JSON value that matches the request's response schema) "
        + "or decline ({ \"reason\": a short text } when you will not or cannot answer). Chat text is not an answer. "
        + "Returns the receipt as JSON, or a refusal: REQUEST_NOT_FOUND (no such request is open to you), REQUEST_EXPIRED (its deadline passed), "
        + "REQUEST_CLOSED (it was cancelled or ended), RESPONSE_CONFLICT (another answer was accepted first), "
        + "OPERATION_CONFLICT (this operation_id gave another answer), RESPONSE_INVALID (the value does not match), "
        + "or OPERATION_LIMIT (too many operations for this request).",
    parameters: {
        type: "object",
        properties: {
            request_id: { type: "string", description: "The requestId of the workflow's request." },
            operation_id: { type: "string", description: "Your idempotency id for this answer." },
            response: { description: "The response: a JSON value that matches the request's response schema." },
            decline: {
                type: "object",
                description: "A declared refusal instead of a response.",
                properties: { reason: { type: "string", description: "Why, in 1 to 2,000 characters." } },
                required: ["reason"],
                additionalProperties: false,
            },
        },
        required: ["request_id", "operation_id"],
    },
} as const;

/** The durable client calls a wake dispatch makes. */
export interface WorkflowWakeClient {
    getStatus(instanceId: string): Promise<{ status: string }>;
    enqueueEvent(instanceId: string, queueName: string, data: string): Promise<void>;
}

/** How often a dispatcher passes over the due wakes, and how many one pass leases at most (design 5). */
export const WORKFLOW_V2_WAKE_PASS_MS = 2_000;
export const WORKFLOW_V2_WAKE_PASS_LIMIT = 20;
/** duroxide statuses after which an orchestration does no more work. */
const TERMINAL_STATUSES: readonly string[] = ["Completed", "Failed", "Terminated"];

/**
 * The durable wake intents' dispatcher (design 5): a pass abandons the due
 * wakes that used every attempt (one event each), leases at most
 * WORKFLOW_V2_WAKE_PASS_LIMIT due ones, and settles each by its lease: the
 * run ended or its controller in a terminal status is moot; a failed or
 * unknown lifecycle read (a missing run or controller included) is retried
 * with backoff, never moot; otherwise the wake is enqueued on the
 * controller's command queue (a hint: the controller collects the stored
 * result) and dispatched. One pass at a time; stop() waits for the pass in
 * flight. The controller's backstop still collects a result whose wake is
 * lost.
 */
export class WorkflowResponseWakeDispatcher {
    private timer: ReturnType<typeof setInterval> | null = null;
    private inFlight: Promise<void> | null = null;
    private stopped = false;

    constructor(
        private readonly store: WorkflowStore,
        private readonly client: WorkflowWakeClient,
        private readonly options: { intervalMs?: number; limit?: number; onError?: (error: unknown) => void } = {},
    ) {}

    /** Pass every interval until stop(). */
    start(): void {
        if (this.timer !== null || this.stopped) return;
        this.timer = setInterval(() => { void this.pass(); }, this.options.intervalMs ?? WORKFLOW_V2_WAKE_PASS_MS);
        this.timer.unref?.();
    }

    /** Stop passing, and wait for the pass in flight. */
    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
        await this.inFlight;
    }

    /** One pass over the due wakes; a pass already running is joined, and none starts after stop(). */
    pass(): Promise<void> {
        if (this.inFlight !== null) return this.inFlight;
        if (this.stopped) return Promise.resolve();
        this.inFlight = this.runPass().finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    /** The responding worker's immediate try: lease the one wake of this request, if due, and settle it. */
    async dispatchNow(exchangeId: string): Promise<void> {
        for (const wake of await this.store.leaseResponseWakes({ limit: 1, exchangeId })) await this.dispatch(wake);
    }

    private async runPass(): Promise<void> {
        try {
            const limit = this.options.limit ?? WORKFLOW_V2_WAKE_PASS_LIMIT;
            await this.store.abandonResponseWakes(limit);
            for (const wake of await this.store.leaseResponseWakes({ limit })) await this.dispatch(wake);
        } catch (error) {
            this.options.onError?.(error);
        }
    }

    private async dispatch(wake: { exchangeId: string; runId: string; controllerInstanceId: string; leaseToken: string }): Promise<void> {
        let outcome: { kind: "dispatched" | "moot" } | { kind: "retry"; error: string };
        try {
            const run = await this.store.readRun(wake.runId);
            if (run === null) outcome = { kind: "retry", error: `Run ${wake.runId} was not found.` };
            else if (!ACTIVE_RUN_STATUSES.includes(run.status)) outcome = { kind: "moot" };
            else {
                const status = (await this.client.getStatus(wake.controllerInstanceId)).status;
                if (TERMINAL_STATUSES.includes(status)) outcome = { kind: "moot" };
                else if (status === "NotFound") outcome = { kind: "retry", error: `Controller ${wake.controllerInstanceId} was not found.` };
                else {
                    await this.client.enqueueEvent(wake.controllerInstanceId, WORKFLOW_COMMAND_QUEUE,
                        JSON.stringify({ type: "workflow-wake", runId: wake.runId, nodeExecutionId: wake.exchangeId, reason: "response" }));
                    outcome = { kind: "dispatched" };
                }
            }
        } catch (error) {
            outcome = { kind: "retry", error: error instanceof Error ? error.message : String(error) };
        }
        await this.store.settleResponseWake(wake.exchangeId, wake.leaseToken, outcome);
    }
}

function payload(value: { [key: string]: JsonValue }): string {
    return JSON.stringify(value);
}

/**
 * The respond_session_request tool (design 6, 7): the caller is the tool's
 * host session, from the worker's trusted context, never an argument. The
 * store decides everything under the session locks
 * (WorkflowStore.respondToRequest): authorization first, a uniform
 * REQUEST_NOT_FOUND for anything it cannot establish. An accepted new answer
 * is followed by the responding worker's immediate wake dispatch (an
 * optimization; its failure changes nothing: the dispatcher's passes and
 * the controller's backstop remain).
 */
/**
 * respond_session_request's answer for a failure (re-check S-SF-F3 of adversarial review R2-SF-4): the shared workflow
 * failure (workflowStoreFailure: a refusal keeps its code, with the secrets in its message and details hidden; anything
 * else is coded, with its message sanitized), never an error's own text. For the tool's handler and the bridge that runs it.
 */
export function workflowRespondFailure(error: unknown): string {
    const failure = workflowStoreFailure(error);
    return payload({ ok: false, error: { code: failure.code, message: jsonbSafeText(failure.message, 2_000), details: failure.details ?? null } });
}

export async function respondSessionRequestFromTool(args: Record<string, unknown>, context: {
    callerSessionId: string; store: WorkflowStore; dispatcher?: Pick<WorkflowResponseWakeDispatcher, "dispatchNow"> | null;
}): Promise<string> {
    try {
        const requestId = typeof args.request_id === "string" ? args.request_id : "";
        const call: { response?: unknown; decline?: unknown } = {};
        if (Object.hasOwn(args, "response")) call.response = args.response;
        if (Object.hasOwn(args, "decline")) call.decline = args.decline;
        const result = await context.store.respondToRequest({
            exchangeId: requestId, actorSessionId: context.callerSessionId, operationId: args.operation_id as string, call,
        });
        if (result.kind === "accepted") {
            if (!result.replayed && context.dispatcher) await context.dispatcher.dispatchNow(requestId).catch(() => undefined);
            return payload({ ok: true, replayed: result.replayed, status: result.status, receipt: result.receipt as unknown as JsonValue });
        }
        return payload({
            ok: false, replayed: result.replayed, status: result.status, currentStatus: result.currentStatus,
            error: { code: result.code, message: refusalMessage(result.code) },
        });
    } catch (error) {
        // Adversarial review R2-SF-4: the shared workflow failure, with the secrets in its message and details hidden; any
        // other error is coded too, with its message sanitized, never its own text.
        return workflowRespondFailure(error);
    }
}

function refusalMessage(code: "REQUEST_EXPIRED" | "REQUEST_CLOSED" | "RESPONSE_CONFLICT" | "OPERATION_CONFLICT"): string {
    switch (code) {
        case "REQUEST_EXPIRED": return "The request's deadline passed; nothing was accepted.";
        case "REQUEST_CLOSED": return "The request was cancelled or its run ended; nothing was accepted.";
        case "RESPONSE_CONFLICT": return "Another answer was accepted first; it stands.";
        case "OPERATION_CONFLICT": return "This operation_id gave another answer; repeat it with that answer, or use a new operation_id.";
    }
}
