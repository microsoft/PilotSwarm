import { FAILURE_ROUTE, WORKFLOW_V2_PARALLEL_MAX_ITEMS, type WorkflowIR, type WorkflowIRParallel } from "./compiler.js";
import { boundedCanonicalJson, canonicalJson, WORKFLOW_PAYLOAD_MAX_BYTES, WorkflowJsonError, type JsonValue } from "./json.js";
import type { NodeResultInput, WorkflowNodeExecutionRow } from "./store.js";

/**
 * A parallel state's branches and its join, as the controller, the store and
 * the read model share them (IR 8 and 9; design 02 parallel scope and join;
 * owner decision join-k-of-n). Pure: nothing here reads or writes anything.
 */

/** The scope of branch `index` of the parallel state's node execution `parallelNodeExecutionId`. */
export function branchScopeId(parallelNodeExecutionId: string, index: number): string {
    return `${parallelNodeExecutionId}#${index}`;
}

/** A branch scope's parallel node execution and index; null for the root scope (or any other text). */
export function parseBranchScope(scopeId: string): { parallelNodeExecutionId: string; index: number } | null {
    const match = /^(nx-[0-9a-f]+)#(0|[1-9]\d{0,5})$/.exec(scopeId);
    return match ? { parallelNodeExecutionId: match[1], index: Number(match[2]) } : null;
}

/** The branch scopes of a parallel state's node execution that runs `total` branches, in index order. */
export function branchScopeIds(parallelNodeExecutionId: string, total: number): string[] {
    return Array.from({ length: Math.max(0, Math.min(total, WORKFLOW_V2_PARALLEL_MAX_ITEMS)) }, (_, index) => branchScopeId(parallelNodeExecutionId, index));
}

/** How many successes a parallel state's join needs of its `total` branches: k of `{ first: k }`, else every branch. */
export function parallelNeeded(join: WorkflowIRParallel["join"], total: number): number {
    return typeof join === "object" ? join.first : total;
}

/**
 * Why the remaining branches of a parallel state were cancelled, as each
 * cancelled branch state's winner records it: another branch did not succeed
 * under failFast (`fail_fast`), the join had its successes (`join`), or the
 * state's own time limit passed (`join_timeout`).
 */
export const BRANCH_CANCEL_WINNERS = { failFast: "fail_fast", join: "join", timeout: "join_timeout" } as const;
export type BranchCancelReason = keyof typeof BRANCH_CANCEL_WINNERS;
export const BRANCH_CANCEL_WINNER_VALUES: readonly string[] = Object.values(BRANCH_CANCEL_WINNERS);

/** Why a branch state with this winner was cancelled (failFast for any winner that is not a join's or a time limit's). */
export function branchCancelReasonOf(winner: string | null): BranchCancelReason {
    return winner === BRANCH_CANCEL_WINNERS.join ? "join" : winner === BRANCH_CANCEL_WINNERS.timeout ? "timeout" : "failFast";
}

/** The error a branch state cancelled for `reason` records. */
export function branchCancelError(reason: BranchCancelReason): { code: "cancelled"; message: string } {
    const message = reason === "join"
        ? "The parallel state's join had the successes it needs, so this branch was cancelled."
        : reason === "timeout"
            ? "The parallel state's time limit passed before its join, so this branch was cancelled."
            : "Another branch of this parallel state did not succeed, and its failFast policy cancelled this branch.";
    return { code: "cancelled", message };
}

/** How one branch ended, for a parallel state's report: at its terminal, by a result no route takes, cancelled, or never started. */
export interface ParallelBranchEnd {
    index: number;
    ended: "terminal" | "error" | "cancelled" | "not_started";
    nodeExecutionId: string | null;
    /** The node execution that ended it, as stored (none for a branch never started, or cancelled between two states). */
    row?: Pick<WorkflowNodeExecutionRow, "outcome" | "resultKind" | "output" | "error"> | undefined;
}

/** Whether a branch ended at its terminal with outcome succeeded. */
export function branchSucceeded(branch: ParallelBranchEnd): boolean {
    return branch.ended === "terminal" && branch.row?.resultKind === "business" && branch.row.outcome === "succeeded";
}

/**
 * A parallel state's report when it is not joined (blocked, or timed_out):
 * every branch in index order with how it ended, the node execution that
 * ended it, its outcome and its output or error (each dropped, with
 * `truncated` true, when the report would not fit), the successes the join
 * needed, and whether the state's own time limit ended it. Bounded canonical
 * JSON, at most `maxBytes`.
 */
export function parallelReportText(input: { total: number; needed: number; failFast: boolean; timedOut: boolean; branches: ParallelBranchEnd[] },
    what: string, maxBytes = WORKFLOW_PAYLOAD_MAX_BYTES): string {
    const succeeded = input.branches.filter(branchSucceeded).length;
    const report = (full: boolean): JsonValue => ({
        joined: false, timedOut: input.timedOut, total: input.total, needed: input.needed, succeeded, failFast: input.failFast,
        branches: [...input.branches].sort((a, b) => a.index - b.index).map(item => ({
            index: item.index, ended: item.ended, nodeExecutionId: item.nodeExecutionId,
            outcome: item.row?.outcome ?? null, resultKind: item.row?.resultKind ?? null,
            ...(full && item.row !== undefined ? (item.row.resultKind === "business" ? { output: item.row.output } : { error: item.row.error }) : {}),
        })),
        ...(full ? {} : { truncated: true }),
    });
    try { return boundedCanonicalJson(report(true), what, maxBytes); }
    catch (error) {
        if (!(error instanceof WorkflowJsonError)) throw error;
        return boundedCanonicalJson(report(false), what, maxBytes);
    }
}

/** Whether a stored result of a body state takes a route of that state (the branch goes on), as the controller routes it. */
function routed(next: Record<string, string>, row: WorkflowNodeExecutionRow): boolean {
    if (row.outcome === null) return false;
    if (Object.hasOwn(next, row.outcome)) return true;
    return row.resultKind === "runtime_error" && Object.hasOwn(next, FAILURE_ROUTE);
}

/**
 * How each branch of a parallel state stood when its own time limit passed,
 * read from the store's rows in one transaction (the store decides the time
 * limit; the controller is not asked): `rows` are every node execution of
 * its branch scopes, the ones just cancelled among them (`cancelled`). A
 * branch with no state is not started; one whose pending state was cancelled
 * now, or earlier by another branch-cancelling decision, was cancelled; one
 * whose last state is its terminal ended there; one whose last state's
 * result takes no route ended by that result; one whose last state was
 * routed and whose next state was not admitted yet was cancelled between
 * two states (no state of it was running).
 */
export function timedOutBranches(ir: WorkflowIR, parallelNodeExecutionId: string, total: number, rows: WorkflowNodeExecutionRow[],
    cancelled: ReadonlySet<string>): ParallelBranchEnd[] {
    const byScope = new Map<string, WorkflowNodeExecutionRow[]>();
    for (const row of rows) {
        if (!byScope.has(row.scopeId)) byScope.set(row.scopeId, []);
        byScope.get(row.scopeId)!.push(row);
    }
    return branchScopeIds(parallelNodeExecutionId, total).map((scopeId, index): ParallelBranchEnd => {
        const states = (byScope.get(scopeId) ?? []).slice()
            .sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime() || (a.nodeExecutionId < b.nodeExecutionId ? -1 : a.nodeExecutionId > b.nodeExecutionId ? 1 : 0));
        if (states.length === 0) return { index, ended: "not_started", nodeExecutionId: null };
        const cut = states.find(row => cancelled.has(row.nodeExecutionId) || (row.winner !== null && BRANCH_CANCEL_WINNER_VALUES.includes(row.winner)));
        if (cut) return { index, ended: "cancelled", nodeExecutionId: cut.nodeExecutionId, row: cut };
        const last = states[states.length - 1];
        const node = ir.nodes[last.nodeId];
        if (last.state === "completed" && node?.type === "terminal") return { index, ended: "terminal", nodeExecutionId: last.nodeExecutionId, row: last };
        if (last.state === "completed" && node && node.type !== "terminal" && !routed(node.next, last)) {
            return { index, ended: "error", nodeExecutionId: last.nodeExecutionId, row: last };
        }
        return { index, ended: "cancelled", nodeExecutionId: null };
    });
}

/** The message of a parallel state's timed_out error. */
export const PARALLEL_TIMEOUT_MESSAGE = "The parallel state's time limit passed before its join.";

/**
 * The result a parallel state records when its own time limit passes first:
 * the runtime error timed_out, decided by the controller's rule (winner
 * controller), with its report as the error's details.
 */
export function parallelTimeoutResult(parallel: WorkflowIRParallel, total: number, branches: ParallelBranchEnd[]): NodeResultInput {
    // The envelope adds its code and message around the report: keep room for them.
    const report = parallelReportText({ total, needed: parallelNeeded(parallel.join, total), failFast: parallel.failFast, timedOut: true, branches },
        "The timed-out parallel state's report", WORKFLOW_PAYLOAD_MAX_BYTES - 8 * 1024);
    return {
        outcome: "timed_out", resultKind: "runtime_error", winner: "controller",
        valueText: canonicalJson({ code: "timed_out", message: PARALLEL_TIMEOUT_MESSAGE, details: JSON.parse(report) as JsonValue }),
    };
}
