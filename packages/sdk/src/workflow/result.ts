/**
 * How a finished workflow reports to its parent: a doorbell and a data
 * channel.
 *
 * - The doorbell is a short system notice with only fields the runtime
 *   vouches for: the workflow session id, its status, its terminal outcome
 *   (one of the compiler's fixed values) and its step count. No script
 *   output, error text, summary, reason or workflow name is ever put in it,
 *   because text relayed inside a `[SYSTEM: ...]` frame would get
 *   runtime-level trust.
 * - The data is the full result, saved with the session's end record and
 *   read with `read_workflow_result`, whose tool result is JSON built with
 *   JSON.stringify: a tool result is its own message role, and the
 *   serializer escapes every quote, bracket and newline, so the output
 *   cannot break out of it.
 *
 * The same issue for sub-agent results: https://github.com/microsoft/PilotSwarm/issues/245
 */
import type { SessionCatalog } from "../cms.js";
import { WORKFLOW_TERMINAL_OUTCOMES } from "./compiler.js";
import type { WorkflowFinishInput } from "./orchestration.js";

/** The events that end a workflow run; exactly one is recorded per run. */
export const WORKFLOW_END_EVENT_TYPES = ["workflow.completed", "workflow.failed", "workflow.cancelled"] as const;

/** The parent notice's sender: a constant, never the (model-written) workflow name. */
export const WORKFLOW_NOTICE_SENDER = { kind: "system", display: "workflow" } as const;

/** The stable id the parent's queue dedupes a repeated notice by (after a crash or a retry). */
export function workflowTerminalClientMessageId(sessionId: string): string {
    return `workflow:${sessionId}:terminal`;
}

/** The full result of a finished run, saved with its end record. */
export interface WorkflowResultRecord {
    sessionId: string;
    status: WorkflowFinishInput["status"];
    outcome: string | null;
    stateId: string | null;
    steps: number;
    endedAt: string;
    summary: string | null;
    output: unknown;
    error: string | null;
    reason: string | null;
}

export function buildWorkflowResultRecord(input: WorkflowFinishInput, endedAt: Date): WorkflowResultRecord {
    const stopped = input.status === "deleted" || (input.status === "cancelled" && input.outcome === undefined);
    return {
        sessionId: input.sessionId,
        status: input.status,
        outcome: input.outcome ?? null,
        stateId: input.stateId ?? null,
        steps: input.steps,
        endedAt: endedAt.toISOString(),
        summary: input.summary ?? null,
        output: input.outcome !== undefined ? (input.output ?? null) : null,
        error: input.error ?? null,
        reason: stopped ? (input.reason ?? input.status) : null,
    };
}

function stepCount(steps: unknown): string {
    const n = typeof steps === "number" && Number.isSafeInteger(steps) && steps >= 0 ? steps : 0;
    return `${n} ${n === 1 ? "step" : "steps"}`;
}

/** A terminal outcome only when it is one of the compiler's fixed values. */
function vouchedOutcome(outcome: unknown): string | null {
    return typeof outcome === "string" && (WORKFLOW_TERMINAL_OUTCOMES as readonly string[]).includes(outcome) ? outcome : null;
}

/** The session id only when it is the runtime's id shape; otherwise the notice names none. */
function vouchedId(sessionId: unknown): string {
    return typeof sessionId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(sessionId) ? sessionId : "(unknown)";
}

/**
 * The parent's notice: runtime-vouched fields only. Read the rest with
 * read_workflow_result.
 */
export function buildParentNotification(input: Pick<WorkflowFinishInput, "sessionId" | "status" | "outcome" | "steps">): string {
    const id = vouchedId(input.sessionId);
    const steps = stepCount(input.steps);
    const read = ` Read its result with read_workflow_result("${id}").`;
    const outcome = vouchedOutcome(input.outcome);
    if (input.status === "deleted") return `[SYSTEM: Workflow ${id} was deleted after ${steps}.]`;
    if (outcome) {
        const status = input.status === "failed" || input.status === "cancelled" ? input.status : "completed";
        return `[SYSTEM: Workflow ${id} finished: ${status}, outcome "${outcome}", ${steps}.${read}]`;
    }
    if (input.status === "cancelled") return `[SYSTEM: Workflow ${id} was cancelled after ${steps}.${read}]`;
    if (input.status === "completed") return `[SYSTEM: Workflow ${id} finished: completed, ${steps}.${read}]`;
    return `[SYSTEM: Workflow ${id} failed after ${steps}.${read}]`;
}

type ResultCatalog = Pick<SessionCatalog, "getSession" | "getSessionEvents"> & Partial<Pick<SessionCatalog, "getSessionEventsBefore">>;

function iso(value: unknown): string | null {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string" || typeof value === "number") {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    return null;
}

/**
 * read_workflow_result for `callerSessionId`. Only the agent session that
 * started the workflow may read it. Always a JSON-serializable object.
 */
export async function readWorkflowResult(catalog: ResultCatalog, callerSessionId: string, rawSessionId: unknown): Promise<Record<string, unknown>> {
    const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim().replace(/^session-/, "") : "";
    if (!sessionId) return { error: "read_workflow_result needs session_id, the workflow session id from spawn_workflow." };
    const row = await catalog.getSession(sessionId);
    if (!row || row.sessionKind !== "workflow" || row.parentSessionId !== callerSessionId) {
        return {
            sessionId,
            error: "read_workflow_result refused: only the agent session that started this workflow can read its result, "
                + "and this session did not start a workflow with that id.",
        };
    }
    const [started] = await catalog.getSessionEvents(sessionId, 0, 1, ["workflow.started"]);
    const startedAt = started ? iso((started as any).createdAt) : null;
    const [end] = await catalog.getSessionEvents(sessionId, 0, 1, [...WORKFLOW_END_EVENT_TYPES]);
    if (end) {
        const data = ((end as any).data ?? {}) as Record<string, any>;
        const saved = (data.result && typeof data.result === "object" ? data.result : {}) as Partial<WorkflowResultRecord>;
        return {
            sessionId,
            status: saved.status ?? (end.eventType === "workflow.completed" ? "completed" : end.eventType === "workflow.failed" ? "failed" : "cancelled"),
            outcome: saved.outcome ?? data.outcome ?? null,
            stateId: saved.stateId ?? data.stateId ?? null,
            steps: saved.steps ?? data.steps ?? 0,
            ...(startedAt ? { startedAt } : {}),
            endedAt: saved.endedAt ?? iso((end as any).createdAt),
            summary: saved.summary ?? data.summary ?? null,
            output: Object.hasOwn(saved, "output") ? saved.output : null,
            error: saved.error ?? data.error ?? null,
            reason: saved.reason ?? data.reason ?? null,
            ...(row.deletedAt ? { deleted: true } : {}),
        };
    }
    const progress = ["workflow.state_started", "workflow.state_waiting", "workflow.state_completed"];
    const latest = typeof catalog.getSessionEventsBefore === "function"
        ? (await catalog.getSessionEventsBefore(sessionId, Number.MAX_SAFE_INTEGER, 1, progress))[0]
        : (await catalog.getSessionEvents(sessionId, 0, 5_000, progress)).at(-1);
    const data = ((latest as any)?.data ?? {}) as Record<string, any>;
    return {
        sessionId,
        status: "running",
        stateId: typeof data.stateId === "string" ? data.stateId : null,
        steps: typeof data.step === "number" ? data.step : 0,
        ...(startedAt ? { startedAt } : {}),
    };
}
