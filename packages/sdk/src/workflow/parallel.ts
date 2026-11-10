import { FAILURE_ROUTE, PARALLEL_BLOCKED, WORKFLOW_PARALLEL_MAX_ITEMS, type WorkflowIR, type WorkflowIRNode, type WorkflowIRParallel } from "./compiler.js";
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

/**
 * IR 11: the names of branch scopes, each from its OWN fork (the parallel node execution its scope id names), never from
 * another scope's, so the cuts of two forks never mix names. `forks` maps a parallel node execution id to its state's IR
 * node. A scope of a For each, or of a fork not given, has no name. Pure.
 */
export function branchScopeNames(scopeIds: readonly string[], forks: ReadonlyMap<string, WorkflowIRNode | undefined>): Map<string, string> {
    const names = new Map<string, string>();
    for (const scopeId of scopeIds) {
        const scope = parseBranchScope(scopeId);
        const node = scope === null ? undefined : forks.get(scope.parallelNodeExecutionId);
        if (scope !== null && node?.type === "parallel" && node.branches !== undefined) names.set(scopeId, node.branches[scope.index]?.name ?? String(scope.index));
    }
    return names;
}

/** The names of `scopeIds` in their order when every one has a name (branchScopeNames); otherwise none (null). */
export function branchScopeNameList(scopeIds: readonly string[], names: ReadonlyMap<string, string>): string[] | null {
    return scopeIds.length > 0 && scopeIds.every(scopeId => names.has(scopeId)) ? scopeIds.map(scopeId => names.get(scopeId)!) : null;
}

/** The branch scopes of a parallel state's node execution that runs `total` branches, in index order. */
export function branchScopeIds(parallelNodeExecutionId: string, total: number): string[] {
    return Array.from({ length: Math.max(0, Math.min(total, WORKFLOW_PARALLEL_MAX_ITEMS)) }, (_, index) => branchScopeId(parallelNodeExecutionId, index));
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

/**
 * How one branch ended, for a parallel state's report: at its terminal, by a
 * result no route takes, cancelled, or never started. IR 9 adds `finished`:
 * its last state's result was stored and takes a route, but its next state
 * was never admitted; that result is kept (owner decision join-k-of-n, J1b).
 * `running` is a state of it still running; a decided report never has one,
 * because the decision cancels that state first.
 */
export interface ParallelBranchEnd {
    index: number;
    ended: "terminal" | "error" | "cancelled" | "not_started" | "finished" | "running";
    nodeExecutionId: string | null;
    /** The node execution that ended it, as stored (none for a branch never started, or cancelled between two states). */
    row?: Pick<WorkflowNodeExecutionRow, "outcome" | "resultKind" | "output" | "error"> | undefined;
    /** IR 9: why a cancelled branch was cancelled (another branch under failFast, the join, or the time limit). */
    cancelledBy?: BranchCancelReason;
    /** IR 9: a success committed after the state's time limit; it did not count toward the join. */
    late?: true;
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
 * needed, and whether the state's own time limit ended it. IR 9 adds, only
 * where they apply, why a cancelled branch was cancelled (`cancelledBy`) and
 * that a success came after the time limit (`late`); `succeeded` is then the
 * successes that counted. Bounded canonical JSON, at most `maxBytes`. A
 * state's outputSchema checks only its joined output, never a report.
 */
export function parallelReportText(input: { total: number; needed: number; failFast: boolean; timedOut: boolean; branches: ParallelBranchEnd[]; succeeded?: number;
    /** IR 11: the branches' names, by index (a named-branch state's report names each branch). */
    names?: readonly string[] },
    what: string, maxBytes = WORKFLOW_PAYLOAD_MAX_BYTES): string {
    const succeeded = input.succeeded ?? input.branches.filter(branchSucceeded).length;
    const report = (full: boolean): JsonValue => ({
        joined: false, timedOut: input.timedOut, total: input.total, needed: input.needed, succeeded, failFast: input.failFast,
        branches: [...input.branches].sort((a, b) => a.index - b.index).map(item => ({
            index: item.index, ...(input.names?.[item.index] !== undefined ? { name: input.names[item.index] } : {}),
            ended: item.ended, nodeExecutionId: item.nodeExecutionId,
            outcome: item.row?.outcome ?? null, resultKind: item.row?.resultKind ?? null,
            ...(full && item.row !== undefined ? (item.row.resultKind === "business" ? { output: item.row.output } : { error: item.row.error }) : {}),
            ...(item.cancelledBy !== undefined ? { cancelledBy: item.cancelledBy } : {}),
            ...(item.late ? { late: true } : {}),
        })),
        ...(full ? {} : { truncated: true }),
    });
    try { return boundedCanonicalJson(report(true), what, maxBytes); }
    catch (error) {
        if (!(error instanceof WorkflowJsonError)) throw error;
        return boundedCanonicalJson(report(false), what, maxBytes);
    }
}

/** The route a stored result of a body state takes, as the controller selects it (selectRoute); null when none does. */
function routeOf(next: Record<string, string>, row: WorkflowNodeExecutionRow): string | null {
    if (row.outcome === null || row.resultKind === null) return null;
    if (Object.hasOwn(next, row.outcome)) return row.outcome;
    return row.resultKind === "runtime_error" && Object.hasOwn(next, FAILURE_ROUTE) ? FAILURE_ROUTE : null;
}

/**
 * Where a stored result sits in the store's commit order (the rank of its
 * completed_at among the branches' states; equal times share a rank), and
 * whether it was committed at or before the parallel state's time limit
 * (always, without one). Read in the deciding transaction.
 */
export interface ParallelCommit {
    rank: number;
    inTime: boolean;
}

/** One branch as a parallel state's join or time limit sees it (IR 9; owner decision join-k-of-n, J1b). */
export interface ParallelBranchState extends ParallelBranchEnd {
    /** It ended, or ends once its terminal is admitted, at a terminal with outcome succeeded. */
    success: boolean;
    /** A success whose terminal was admitted and decided succeeded: its output is the branch's output. */
    confirmed: boolean;
    /** It can no longer succeed. */
    failure: boolean;
    /** It ended for its controller: at its terminal, by a result no route takes, cancelled, or never to start. */
    done: boolean;
    /** When the result that decides it was committed: its last work state's (a terminal adds no time of its own). */
    commit: ParallelCommit | null;
}

/**
 * The last state of one branch, from its own states (`states`, every node
 * execution of its scope): the one no other state of the scope names as its
 * predecessor (review J1-R1). A branch admits its states one after another,
 * each naming the one before it (its first names the parallel state), so
 * exactly one is last; admission times are not used, because two states
 * admitted in the same millisecond would read as one instant. A scope that
 * does not form one chain (corrupt) falls back to the latest admitted of
 * its ends, then the greatest id.
 */
export function branchLastState(states: readonly WorkflowNodeExecutionRow[]): WorkflowNodeExecutionRow {
    const named = new Set(states.flatMap(row => typeof row.predecessorId === "string" ? [row.predecessorId] : []));
    const ends = states.filter(row => !named.has(row.nodeExecutionId));
    if (ends.length === 1) return ends[0];
    return (ends.length > 0 ? ends : states).slice().sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime()
        || (a.nodeExecutionId < b.nodeExecutionId ? -1 : a.nodeExecutionId > b.nodeExecutionId ? 1 : 0)).at(-1)!;
}

/**
 * How each branch of a parallel state stands, from the store's rows of its
 * branch scopes (`rows`, every node execution of them) and the pinned
 * definition's routes; the store's one count for the join and the time
 * limit (formal finding H1: admitted or not). A branch with no state has not
 * started (`notStarted`: its controller will not start it). One whose state
 * a branch cancellation decided was cancelled, with why. Its last state is
 * the end of its predecessor chain (branchLastState). One whose last state
 * is its terminal ended there, when decided; a terminal admitted but not yet
 * decided stands as the state before it (its predecessor) left it. One whose
 * last state still runs is running. One whose last state's result takes no
 * route ended by that error. One whose last state's result takes a route is
 * finished: a success when that route leads to a terminal with outcome
 * succeeded, a failure when it leads to another terminal, neither while it
 * leads to a state that may still run.
 */
export function parallelBranchStates(ir: WorkflowIR, parallelNodeExecutionId: string, total: number, rows: WorkflowNodeExecutionRow[],
    committed: ReadonlyMap<string, ParallelCommit>, notStarted: ReadonlySet<number>): ParallelBranchState[] {
    const byScope = new Map<string, WorkflowNodeExecutionRow[]>();
    for (const row of rows) {
        if (!byScope.has(row.scopeId)) byScope.set(row.scopeId, []);
        byScope.get(row.scopeId)!.push(row);
    }
    const commitOf = (row: WorkflowNodeExecutionRow | undefined): ParallelCommit | null => (row === undefined ? null : committed.get(row.nodeExecutionId) ?? null);
    return branchScopeIds(parallelNodeExecutionId, total).map((scopeId, index): ParallelBranchState => {
        const states = byScope.get(scopeId) ?? [];
        if (states.length === 0) {
            return { index, ended: "not_started", nodeExecutionId: null, success: false, confirmed: false, failure: false, done: notStarted.has(index), commit: null };
        }
        const cut = states.find(row => row.state === "completed" && row.winner !== null && BRANCH_CANCEL_WINNER_VALUES.includes(row.winner));
        if (cut) {
            return { index, ended: "cancelled", nodeExecutionId: cut.nodeExecutionId, row: cut, cancelledBy: branchCancelReasonOf(cut.winner),
                success: false, confirmed: false, failure: true, done: true, commit: commitOf(cut) };
        }
        const last = branchLastState(states);
        const node = ir.nodes[last.nodeId];
        if (node?.type === "terminal") {
            const before = states.find(row => row.nodeExecutionId === last.predecessorId);
            const commit = commitOf(before) ?? commitOf(last);
            if (last.state === "completed") {
                const success = last.resultKind === "business" && last.outcome === "succeeded";
                return { index, ended: "terminal", nodeExecutionId: last.nodeExecutionId, row: last, success, confirmed: success, failure: !success, done: true, commit };
            }
            const success = node.outcome === "succeeded";
            return { index, ended: "finished", nodeExecutionId: (before ?? last).nodeExecutionId, row: before,
                success, confirmed: false, failure: !success, done: false, commit };
        }
        if (last.state !== "completed" || node === undefined || node.type === "parallel") {
            return { index, ended: "running", nodeExecutionId: last.nodeExecutionId, success: false, confirmed: false, failure: false, done: false, commit: null };
        }
        const route = routeOf(node.next, last);
        if (route === null) {
            return { index, ended: "error", nodeExecutionId: last.nodeExecutionId, row: last, success: false, confirmed: false, failure: true, done: true,
                commit: commitOf(last) };
        }
        const target = ir.nodes[node.next[route]];
        const success = target?.type === "terminal" && target.outcome === "succeeded";
        return { index, ended: "finished", nodeExecutionId: last.nodeExecutionId, row: last, success, confirmed: false,
            failure: target?.type === "terminal" && !success, done: false, commit: commitOf(last) };
    });
}

/** A branch as its report lists it: `late` for a success committed after the time limit. */
export function parallelBranchEnd(branch: ParallelBranchState): ParallelBranchEnd {
    return {
        index: branch.index, ended: branch.ended, nodeExecutionId: branch.nodeExecutionId, row: branch.row,
        ...(branch.cancelledBy !== undefined ? { cancelledBy: branch.cancelledBy } : {}),
        ...(branch.success && branch.commit !== null && !branch.commit.inTime ? { late: true as const } : {}),
    };
}

/**
 * The branches that count toward a parallel state's join, in the store's
 * commit order (ties by branch index): every success committed at or before
 * the state's time limit, admitted or not (formal finding H1).
 */
export function parallelSuccesses(branches: ParallelBranchState[]): ParallelBranchState[] {
    return branches.filter(branch => branch.success && branch.commit !== null && branch.commit.inTime)
        .sort((a, b) => a.commit!.rank - b.commit!.rank || a.index - b.index);
}

/**
 * What a parallel state's join or its time limit decides (IR 9; owner
 * decision join-k-of-n with formal questions Q1 to Q3 and finding H1): one
 * count for both. With k successes (parallelSuccesses): joined with the
 * first k in commit order (every branch in index order for a join of all)
 * when each of them was admitted and decided at its terminal and the join
 * asks; otherwise, past the time limit, join_due (its controller admits
 * their terminals, then joins), and before it, wait. Fewer: past the time
 * limit, blocked when k could no longer happen by then (failures committed
 * by the time limit; Q3, the report says timedOut), else timed_out. Before
 * it, blocked when k can no longer happen and either failFast holds (its
 * other branches are cancelled at once) or every branch ended; else wait.
 */
export type ParallelVerdict =
    | { kind: "wait" }
    | { kind: "join_due"; winners: number[] }
    | { kind: "joined"; winners: ParallelBranchState[] }
    | { kind: "blocked"; timedOut: boolean; cancel: BranchCancelReason }
    | { kind: "timed_out" };

export function parallelVerdict(input: { join: WorkflowIRParallel["join"]; failFast: boolean; total: number; branches: ParallelBranchState[];
    pastDeadline: boolean; timeLimit: boolean }): ParallelVerdict {
    const needed = parallelNeeded(input.join, input.total);
    const successes = parallelSuccesses(input.branches);
    if (successes.length >= needed) {
        const winners = typeof input.join === "object" ? successes.slice(0, needed) : [...successes].sort((a, b) => a.index - b.index);
        if (!input.timeLimit && winners.every(branch => branch.confirmed)) return { kind: "joined", winners };
        return input.pastDeadline ? { kind: "join_due", winners: winners.map(branch => branch.index) } : { kind: "wait" };
    }
    // A cancellation by the time limit is no failure before it.
    const failures = input.branches.filter(branch => branch.failure && branch.cancelledBy !== "timeout" && branch.commit !== null && branch.commit.inTime).length;
    const impossible = failures > input.total - needed;
    if (input.pastDeadline) return impossible ? { kind: "blocked", timedOut: true, cancel: "timeout" } : { kind: "timed_out" };
    if (impossible && (input.failFast || input.branches.every(branch => branch.done))) return { kind: "blocked", timedOut: false, cancel: "failFast" };
    return { kind: "wait" };
}

/** Why the controller cuts a decided parallel state's remaining branches, read from its stored result. */
export function parallelCutOf(row: Pick<WorkflowNodeExecutionRow, "outcome" | "resultKind" | "output">): BranchCancelReason {
    if (row.outcome === "timed_out" && row.resultKind === "runtime_error") return "timeout";
    if (row.outcome === PARALLEL_BLOCKED && row.resultKind === "business") {
        const report = row.output;
        return report !== null && typeof report === "object" && !Array.isArray(report) && report.timedOut === true ? "timeout" : "failFast";
    }
    return "join";
}

/** The message of a parallel state's timed_out error. */
export const PARALLEL_TIMEOUT_MESSAGE = "The parallel state's time limit passed before its join.";

/**
 * The result a parallel state records when its own time limit passes first:
 * the runtime error timed_out, decided by the controller's rule (winner
 * controller), with its report as the error's details.
 */
export function parallelTimeoutResult(parallel: WorkflowIRParallel, total: number, branches: ParallelBranchEnd[], succeeded?: number): NodeResultInput {
    // The envelope adds its code and message around the report: keep room for them.
    const report = parallelReportText({ total, needed: parallelNeeded(parallel.join, total), failFast: parallel.failFast, timedOut: true, branches,
        ...(succeeded !== undefined ? { succeeded } : {}), ...parallelNames(parallel) }, "The timed-out parallel state's report", WORKFLOW_PAYLOAD_MAX_BYTES - 8 * 1024);
    return {
        outcome: "timed_out", resultKind: "runtime_error", winner: "controller",
        valueText: canonicalJson({ code: "timed_out", message: PARALLEL_TIMEOUT_MESSAGE, details: JSON.parse(report) as JsonValue }),
    };
}

/** IR 11: a named-branch state's branch names, by index, for its report; nothing for a For each. */
export function parallelNames(parallel: Pick<WorkflowIRParallel, "branches">): { names?: string[] } {
    return parallel.branches !== undefined ? { names: parallel.branches.map(branch => branch.name) } : {};
}

/**
 * The joined output of a parallel state from its winners (`{ index, output }`): IR 11, a named-branch state's
 * `{ <name>: output }` (for a join of the first k, its winners only); a For each's outputs in index order, or for a join
 * of the first k `[{ index, output }]` in the order given (the store's commit order).
 */
export function parallelJoinedOutput(parallel: Pick<WorkflowIRParallel, "branches" | "join">, winners: ReadonlyArray<{ index: number; output: JsonValue }>)
    : JsonValue {
    if (parallel.branches !== undefined) {
        const named: { [name: string]: JsonValue } = {};
        for (const winner of winners) named[parallel.branches[winner.index]?.name ?? String(winner.index)] = winner.output;
        return named;
    }
    return typeof parallel.join === "object" ? winners.map(winner => ({ index: winner.index, output: winner.output })) : winners.map(winner => winner.output);
}

/** The result of a blocked parallel state (business outcome blocked, its report as its output), decided by the controller's rule. */
export function parallelBlockedResult(parallel: WorkflowIRParallel, total: number, branches: ParallelBranchEnd[], timedOut: boolean, succeeded?: number): NodeResultInput {
    const valueText = parallelReportText({ total, needed: parallelNeeded(parallel.join, total), failFast: parallel.failFast, timedOut, branches,
        ...(succeeded !== undefined ? { succeeded } : {}), ...parallelNames(parallel) }, "The blocked join's report");
    return { outcome: PARALLEL_BLOCKED, resultKind: "business", valueText, winner: "controller" };
}
