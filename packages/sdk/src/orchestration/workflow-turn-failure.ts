/**
 * Orchestration 1.0.83 (changed in place; PR 270): the report of a Workflow agent session's failed turn
 * (workflow/agent-turn-failure.ts). A turn that fails for good (its retries spent, a non-retryable error, a
 * credential failure) of a session that has an agent session's id owes one report, made at once, before the session idles.
 * The report decides every visit the turn worked on that is still pending (execution_failed) and wakes the Workflow.
 *
 * - Owed only at a turn's terminal failure: never while its retry is owed (a retry's continue-as-new owes none), and
 *   never for a turn that succeeded. One report per failed turn: an owed report that is not sent yet takes a later
 *   failed turn's prompt ids too (one report, both turns), so at most one is owed.
 * - Made at once; when its activity fails, it stays owed (state.workflowTurnFailure), every continue-as-new carries it
 *   (lifecycle.ts versionedContinueAsNew), and it is made again at the start of each execution (runtime.ts runLoop) and
 *   before the next turn (turn.ts processPrompt), until it is made.
 * - A turn that succeeds drops an owed report (turn.ts handleTurnResult): the session recovered, so its visit goes on.
 * - A session without an agent session's id owes nothing and makes no report: its history is unchanged.
 */
import { isWorkflowAgentSessionIdShape } from "../workflow/agent-ids.js";
import type { DurableSessionRuntime } from "./state.js";

/** The owed report: the failed turns' prompt ids and the last failure's words. */
export interface WorkflowTurnFailureReport {
    clientMessageIds: string[];
    cause: string;
}

const MAX_IDS = 64;
const MAX_CAUSE = 2_000;

/** The owed report an input carries (`workflowTurnFailure`), or null; a malformed one is dropped (it decides only pending visits). */
export function restoreWorkflowTurnFailure(raw: unknown): WorkflowTurnFailureReport | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as { clientMessageIds?: unknown; cause?: unknown };
    const ids = Array.isArray(value.clientMessageIds)
        ? value.clientMessageIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(-MAX_IDS)
        : [];
    const cause = typeof value.cause === "string" && value.cause ? value.cause.slice(0, MAX_CAUSE) : "The turn failed.";
    return { clientMessageIds: ids, cause };
}

/**
 * A turn of this session failed for good (turn.ts: its retries spent, a non-retryable error, a credential failure, a lost
 * connection with no durable handoff). A session with an agent session's id owes the report and makes it now.
 */
export function* oweWorkflowTurnFailure(runtime: DurableSessionRuntime, clientMessageIds: string[] | undefined, cause: string): Generator<any, void, any> {
    if (!isWorkflowAgentSessionIdShape(runtime.input.sessionId)) return;
    const { state } = runtime;
    const prior = state.workflowTurnFailure;
    const ids = [...new Set([...(prior?.clientMessageIds ?? []), ...(clientMessageIds ?? [])])].slice(-MAX_IDS);
    state.workflowTurnFailure = { clientMessageIds: ids, cause: String(cause || "The turn failed.").slice(0, MAX_CAUSE) };
    yield* settleWorkflowTurnFailure(runtime);
}

/** Make the owed report, if any. Made: no longer owed. Its activity failed: still owed, and made again later. */
export function* settleWorkflowTurnFailure(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { state } = runtime;
    const owed = state.workflowTurnFailure;
    if (!owed) return;
    try {
        const result: any = yield runtime.manager.reportWorkflowAgentTurnFailure({
            sessionId: runtime.input.sessionId, clientMessageIds: owed.clientMessageIds, cause: owed.cause,
        });
        state.workflowTurnFailure = null;
        runtime.ctx.traceInfo(`[orch] workflow agent turn failure reported: ${String(result?.reason ?? "done")}`);
    } catch (err: any) {
        runtime.ctx.traceInfo(`[orch] workflow agent turn failure report failed; it stays owed: ${String(err?.message ?? err)}`);
    }
}

/** A turn that succeeded: the session recovered, so an owed report is dropped (no report after a success). */
export function dropWorkflowTurnFailure(runtime: DurableSessionRuntime): void {
    if (runtime.state.workflowTurnFailure) {
        runtime.state.workflowTurnFailure = null;
        runtime.ctx.traceInfo("[orch] a turn succeeded; the owed workflow agent turn failure report is dropped");
    }
}
