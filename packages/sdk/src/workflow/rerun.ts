import { type WorkflowIR, type WorkflowIRNode } from "./compiler.js";
import { isWorkflowControllerVersion, workflowControllerFeatures } from "./controller-features.js";
import { WORKFLOW_CONTROLLER_VERSION } from "./controller-version.js";
import {
    CATCH_ALL_ROUTE,
    ROOT_SCOPE,
    branchScopeId,
    parseBranchScope,
    selectRoute,
    type WorkflowRunStatus,
} from "./controller/runtime.js";
import { canonicalJson, isJsonObject, sha256Hex, type JsonValue } from "./json.js";
import type { WorkflowRunRow } from "./store.js";

/**
 * Maximum total byte size of copied visits in a single v1 re-run (256 MiB).
 * Enforced in Unit 3B's store copy (`RERUN_TOO_LARGE`) and `readWorkflowRerunPlan`.
 */
export const WORKFLOW_RERUN_MAX_COPY_BYTES = 256 * 1024 * 1024;

/** Pure deterministic node execution identity (matches store.ts › nodeExecutionIdFor without importing pg/store.ts). */
function rerunNodeExecutionIdFor(runId: string, scopeId: string, nodeId: string, ordinal: number): string {
    return `nx-${sha256Hex(canonicalJson([runId, scopeId, nodeId, ordinal])).slice(0, 40)}`;
}

/** Pure coded error thrown by rerun planning/mapping helpers (zero runtime dependency on store.ts/pg). */
export class WorkflowRerunError extends Error {
    constructor(readonly code: string, message: string, readonly details: JsonValue = null) {
        super(message);
        this.name = "WorkflowRerunError";
    }
}

export type WorkflowRerunMode = "run_again" | "continue";

export interface WorkflowRerunKey {
    nodeExecutionId: string;
    runId: string;
    scopeId: string;
    nodeId: string;
    ordinal: number;
    nodeType: string;
    predecessorId: string | null;
    arrivalRoute: string | null;
    state: string;
    outcome: string | null;
    resultKind: string | null;
    winner: string | null;
    kvRevision: number | null;
    enteredAt: Date;
    completedAt: Date | null;
    inputSha256: string;
    carrySha256: string | null;
    hasCarry: boolean;
    byteLength: number;
    reusedFromExecutionId: string | null;
    reusedFromRunId: string | null;
    reusedFromWorkflowSessionId: string | null;
    spawnChildWorkflowId: string | null;
}

export interface WorkflowRerunResume {
    v: 1;
    mode: WorkflowRerunMode;
    /** In run_again: exact coordinates of the dropped chosen visit in the new run. In continue: null (target revision routes next step). */
    stateId: string | null;
    ordinal: number | null;
    scopeId: "root";
    arrivalRoute: string | null;
    /** Mapped new nodeExecutionId of the last reused top-level visit. */
    predecessorId: string | null;
    /** KV revision at the cut (before optional Start vars R+1). */
    cutKvRevision: number;
    /** True when target irSha256 === source irSha256 (same compiled IR). */
    sameIr: boolean;
    expectedInputSha256: string | null;
    expectedCarrySha256: string | null;
    /** Always populated in run_again from the source's chosen visit so the Portal can flag & compare changed inputs. */
    recordedInputSha256: string | null;
    /** Human/agent-readable label of the chosen source visit, kept even if the source is later swept. */
    fromStateId: string;
    fromVisit: number;
    sourceRevision: number;
}

export interface WorkflowRerunProblem {
    code:
        | "step_missing"
        | "step_type_changed"
        | "step_moved"
        | "route_changed"
        | "no_route"
        | "catch_all_changed"
        | "catch_all_twice"
        | "carry_changed"
        | "parallel_changed"
        | "limit_too_low"
        | "controller_too_old";
    stateId: string | null;
    visit: number | null;
    message: string;
}

export interface WorkflowRerunWarning {
    code:
        | "step_runs_again"
        | "work_after_cut"
        | "messages_sent"
        | "children_started"
        | "approvals_asked"
        | "inputs_taken"
        | "reused_setup"
        | "reused_child_gone"
        | "changed_reused_step"
        | "agent_memory"
        | "approval_reused"
        | "decision_runs_again";
    stateId: string | null;
    message: string;
    details?: JsonValue;
}

export interface MappedRerunExecution {
    source: WorkflowRerunKey;
    newId: string;
    newScopeId: string;
    newPredecessorId: string | null;
}

export interface FlattenedRerunOrigin {
    executionId: string;
    runId: string;
    workflowSessionId: string;
}

/** Flattens multi-generation provenance (#1 -> #2 -> #3) to the visit that actually executed. */
export function flattenRerunOrigin(source: WorkflowRerunKey, sourceWorkflowSessionId: string): FlattenedRerunOrigin {
    return {
        executionId: source.reusedFromExecutionId ?? source.nodeExecutionId,
        runId: source.reusedFromRunId ?? source.runId,
        workflowSessionId: source.reusedFromWorkflowSessionId ?? sourceWorkflowSessionId,
    };
}

export interface BuildRerunWarningsInput {
    sourceNumber: number | null;
    targetIr: WorkflowIR;
    reused: readonly WorkflowRerunKey[];
    dropped: readonly (WorkflowRerunKey & { outputPreview?: string | null })[];
    chosen: WorkflowRerunKey;
    mode: WorkflowRerunMode;
    changedReusedSteps: ReadonlyArray<{ stateId: string; visits: number }>;
    deliveredOutboxExecIds: ReadonlySet<string>;
    droppedSpawnChildren: ReadonlyMap<string, { name: string | null; number: number | null; status: string | null }>;
    reusedSpawnNoticeChildIds: ReadonlySet<string>;
    droppedConsumedUncarriedExecIds: ReadonlySet<string>;
    reusedApprovals: ReadonlyArray<{ executionId: string; stateId: string; visit: number; question: string; outcome: string; decidedAt: string | null }>;
    droppedApprovals: ReadonlyArray<{ executionId: string; stateId: string; visit: number; question: string }>;
}

export interface BuildRerunResumeInput {
    mode: WorkflowRerunMode;
    chosen: WorkflowRerunKey;
    mappedPredecessorId: string | null;
    cutKvRevision: number;
    sourceRevision: number;
    sourceIrSha256: string;
    targetIrSha256: string;
}

export interface BuildRerunPlanInput {
    source: { workflowId: string; runId: string; revision: number; status: WorkflowRunStatus; number: number | null };
    chosen: WorkflowRerunKey;
    picked: string;
    mode: WorkflowRerunMode;
    modesAvailable: readonly WorkflowRerunMode[];
    revision: {
        target: number;
        newestValid: number | null;
        fits: boolean;
        problems: readonly WorkflowRerunProblem[];
        changedReusedSteps: ReadonlyArray<{ stateId: string; visits: number }>;
    };
    sourceRevisionFits: boolean;
    reused: readonly WorkflowRerunKey[];
    reusedRequests: ReadonlyArray<{ executionId: string; stateId: string; visit: number }>;
    dropped: ReadonlyArray<WorkflowRerunKey & { outputPreview: string | null }>;
    targetIr: WorkflowIR;
    warnings: readonly WorkflowRerunWarning[];
    allowed: boolean;
    blockedReason: string | null;
}

export interface WorkflowRerunPlan {
    of: { workflowId: string; runId: string; revision: number; status: WorkflowRunStatus; number: number | null };
    from: { executionId: string; stateId: string; visit: number; picked: string };
    mode: WorkflowRerunMode;
    modesAvailable: WorkflowRerunMode[];
    revision: {
        target: number;
        newestValid: number | null;
        fits: boolean;
        problems: WorkflowRerunProblem[];
        changedReusedSteps: Array<{ stateId: string; visits: number }>;
    };
    sourceRevisionFits: boolean;
    reused: {
        visits: number;
        bytes: number;
        steps: Array<{ stateId: string; visits: number }>;
        requests: Array<{ executionId: string; stateId: string; visit: number }>;
    };
    runs: {
        first: { stateId: string; visit: number } | null;
    };
    dropped: Array<{
        executionId: string;
        stateId: string;
        visit: number;
        type: string;
        outcome: string | null;
        outputPreview: string | null;
    }>;
    warnings: WorkflowRerunWarning[];
    allowed: boolean;
    blockedReason: string | null;
}

const RUN_END_CANCEL_WINNERS = new Set(["cancel", "delete", "stop", "deadline", "controller"]);

function isCancelledByRunEnd(visit: WorkflowRerunKey): boolean {
    if (visit.state !== "completed") return true;
    return visit.resultKind === "runtime_error"
        && visit.outcome === "cancelled"
        && RUN_END_CANCEL_WINNERS.has(visit.winner ?? "");
}

function modesAvailableFor(visit: WorkflowRerunKey): WorkflowRerunMode[] {
    const modes: WorkflowRerunMode[] = [];
    if (visit.predecessorId !== null) modes.push("run_again");
    if (visit.nodeType !== "terminal" && !isCancelledByRunEnd(visit)) modes.push("continue");
    return modes;
}

function orderedRootChain(keys: readonly WorkflowRerunKey[]): WorkflowRerunKey[] {
    const rootKeys = keys.filter(k => k.scopeId === ROOT_SCOPE);
    if (rootKeys.length <= 1) return [...rootKeys];
    const byPred = new Map<string | null, WorkflowRerunKey[]>();
    for (const k of rootKeys) {
        const list = byPred.get(k.predecessorId);
        if (list) list.push(k);
        else byPred.set(k.predecessorId, [k]);
    }
    const ordered: WorkflowRerunKey[] = [];
    const seen = new Set<string>();
    const roots = (byPred.get(null) ?? []).slice().sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime() || a.ordinal - b.ordinal);
    let current: WorkflowRerunKey | undefined = roots[0];
    while (current && !seen.has(current.nodeExecutionId)) {
        seen.add(current.nodeExecutionId);
        ordered.push(current);
        const nextList: WorkflowRerunKey[] | undefined = byPred.get(current.nodeExecutionId);
        current = nextList && nextList.length > 0
            ? nextList.slice().sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime() || a.ordinal - b.ordinal)[0]
            : undefined;
    }
    if (ordered.length < rootKeys.length) {
        const rest = rootKeys
            .filter(k => !seen.has(k.nodeExecutionId))
            .sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime() || a.ordinal - b.ordinal);
        ordered.push(...rest);
    }
    return ordered;
}

function validateVisitAndMode(chosen: WorkflowRerunKey, mode: WorkflowRerunMode): void {
    if (mode === "run_again" && chosen.predecessorId === null) {
        throw new WorkflowRerunError("RERUN_VISIT_NOT_ALLOWED", "Nothing would be reused. Use Run again.", {
            reason: "first_visit",
            executionId: chosen.nodeExecutionId,
            stateId: chosen.nodeId,
            visit: chosen.ordinal,
        });
    }
    if (mode === "continue" && chosen.nodeType === "terminal") {
        throw new WorkflowRerunError("RERUN_VISIT_NOT_ALLOWED", `${chosen.nodeId} · visit ${chosen.ordinal} is a terminal step and cannot continue.`, {
            reason: "terminal",
            executionId: chosen.nodeExecutionId,
            stateId: chosen.nodeId,
            visit: chosen.ordinal,
        });
    }
    if (mode === "continue" && isCancelledByRunEnd(chosen)) {
        throw new WorkflowRerunError("RERUN_VISIT_NOT_ALLOWED", `${chosen.nodeId} · visit ${chosen.ordinal} has no completed result to continue from. Use run_again.`, {
            reason: "no_result",
            executionId: chosen.nodeExecutionId,
            stateId: chosen.nodeId,
            visit: chosen.ordinal,
        });
    }
}

const TECHNICAL_RUN_ERROR_CODES = new Set(["timed_out", "controller_error", "controller_ended"]);

export function pickRerunTarget(
    run: Pick<WorkflowRunRow, "status" | "terminalNodeId" | "terminalOutcome" | "terminalError">,
    keys: readonly WorkflowRerunKey[],
    requested?: { executionId?: string | null; mode?: WorkflowRerunMode | null },
): { chosen: WorkflowRerunKey; mode: WorkflowRerunMode; picked: string; modesAvailable: WorkflowRerunMode[] } {
    const byId = new Map<string, WorkflowRerunKey>(keys.map(k => [k.nodeExecutionId, k]));
    const rootChain = orderedRootChain(keys);
    const reqExecId = requested?.executionId ?? null;
    const reqMode = requested?.mode ?? null;

    if (reqMode !== null && reqMode !== "run_again" && reqMode !== "continue") {
        throw new WorkflowRerunError("RERUN_ARGUMENT_REFUSED", `Invalid re-run mode "${String(reqMode)}". Expected "run_again" or "continue".`);
    }

    if (reqExecId !== null) {
        const found = byId.get(reqExecId);
        if (!found) {
            throw new WorkflowRerunError("RERUN_VISIT_NOT_FOUND", `Visit ${reqExecId} is not a step execution of this Workflow.`, {
                executionId: reqExecId,
            });
        }
        if (found.scopeId !== ROOT_SCOPE) {
            const parsed = parseBranchScope(found.scopeId);
            const parallel = parsed ? byId.get(parsed.parallelNodeExecutionId) ?? null : null;
            const targetLabel = parallel ? `${parallel.nodeId} · visit ${parallel.ordinal}` : "the parallel step";
            throw new WorkflowRerunError(
                "RERUN_VISIT_NOT_ALLOWED",
                `To re-run this lane, choose ${targetLabel}.`,
                {
                    reason: "inside_lane",
                    executionId: found.nodeExecutionId,
                    parallelExecutionId: parallel?.nodeExecutionId ?? parsed?.parallelNodeExecutionId ?? null,
                    parallelStateId: parallel?.nodeId ?? null,
                    parallelVisit: parallel?.ordinal ?? null,
                },
            );
        }
        const mode: WorkflowRerunMode = reqMode ?? "run_again";
        validateVisitAndMode(found, mode);
        return { chosen: found, mode, picked: "requested", modesAvailable: modesAvailableFor(found) };
    }

    const errObj = isJsonObject(run.terminalError) ? run.terminalError : null;
    const errCode = errObj && typeof errObj.code === "string" ? errObj.code : null;
    const errDetails = errObj && isJsonObject(errObj.details) ? errObj.details : null;
    const errNodeExecId = errDetails && typeof errDetails.nodeExecutionId === "string" ? errDetails.nodeExecutionId : null;

    let chosen: WorkflowRerunKey | null = null;
    let defaultMode: WorkflowRerunMode = "run_again";
    let picked = "last_visit";

    if (errCode === "limit_exceeded") {
        const last = rootChain.at(-1) ?? null;
        if (last) {
            chosen = last;
            // I5: if a lane hit limit_exceeded, finishRun cancelled the pending root parallel visit (winner="controller"),
            // so fall back to run_again when the last root visit has no real completed result.
            defaultMode = (last.state === "completed" && !isCancelledByRunEnd(last) && last.nodeType !== "terminal")
                ? "continue"
                : "run_again";
            picked = "limit_exceeded";
        }
    } else if (run.status === "failed" && errNodeExecId !== null && byId.has(errNodeExecId)) {
        const raw = byId.get(errNodeExecId)!;
        let lifted: WorkflowRerunKey;
        if (raw.scopeId === ROOT_SCOPE) {
            lifted = raw;
        } else {
            const parsed = parseBranchScope(raw.scopeId);
            const parallel = parsed ? byId.get(parsed.parallelNodeExecutionId) ?? null : null;
            if (!parallel) {
                throw new WorkflowRerunError(
                    "RERUN_VISIT_NOT_ALLOWED",
                    "To re-run this lane, choose the parallel step.",
                    {
                        reason: "inside_lane",
                        executionId: raw.nodeExecutionId,
                        parallelExecutionId: parsed?.parallelNodeExecutionId ?? null,
                        parallelStateId: null,
                        parallelVisit: null,
                    },
                );
            }
            lifted = parallel;
        }
        const isTechnicalFailure = (errCode !== null && TECHNICAL_RUN_ERROR_CODES.has(errCode))
            || raw.winner === "deadline"
            || lifted.winner === "deadline";
        const isFailure = raw.resultKind === "runtime_error"
            || raw.state !== "completed"
            || lifted.resultKind === "runtime_error"
            || RUN_END_CANCEL_WINNERS.has(raw.winner ?? "")
            || raw.winner === "fail_fast";
        if (isTechnicalFailure) {
            chosen = lifted;
            defaultMode = (lifted.state === "completed" && !isCancelledByRunEnd(lifted) && lifted.nodeType !== "terminal")
                ? "continue"
                : "run_again";
            picked = "last_visit";
        } else if (isFailure) {
            chosen = lifted;
            defaultMode = "run_again";
            picked = "failed_visit";
        } else if (lifted.resultKind === "business") {
            chosen = lifted;
            defaultMode = "continue";
            picked = "unrouted_outcome";
        }
    }

    if (chosen === null) {
        if (run.terminalNodeId !== null && run.terminalOutcome === "failed") {
            const termVisit = [...rootChain].reverse().find(k => k.nodeType === "terminal" && k.nodeId === run.terminalNodeId)
                ?? [...rootChain].reverse().find(k => k.nodeType === "terminal")
                ?? null;
            if (termVisit && termVisit.predecessorId) {
                let cursor: WorkflowRerunKey | undefined = byId.get(termVisit.predecessorId);
                const immediatePred = cursor ?? null;
                let failedAnc: WorkflowRerunKey | null = null;
                const seen = new Set<string>();
                while (cursor && !seen.has(cursor.nodeExecutionId)) {
                    seen.add(cursor.nodeExecutionId);
                    if (cursor.resultKind === "runtime_error" || (cursor.nodeType === "parallel" && cursor.outcome === "blocked")) {
                        failedAnc = cursor;
                        break;
                    }
                    cursor = cursor.predecessorId ? byId.get(cursor.predecessorId) : undefined;
                }
                chosen = failedAnc ?? immediatePred;
                defaultMode = "run_again";
                picked = "failed_visit";
            }
        } else if (
            run.terminalNodeId !== null
            && run.terminalOutcome !== null
            && (run.terminalOutcome === "succeeded" || run.terminalOutcome === "blocked" || run.terminalOutcome === "cancelled")
        ) {
            throw new WorkflowRerunError(
                "RERUN_VISIT_REQUIRED",
                `This Workflow ended ${run.terminalOutcome} with no failed step. Name the visit with execution_id.`,
                { outcome: run.terminalOutcome },
            );
        } else {
            const last = rootChain.at(-1) ?? null;
            if (!last) {
                throw new WorkflowRerunError("RERUN_VISIT_REQUIRED", "This Workflow has no recorded visits to re-run from.");
            }
            chosen = last;
            defaultMode = (last.state === "completed" && !isCancelledByRunEnd(last) && last.nodeType !== "terminal")
                ? "continue"
                : "run_again";
            picked = "last_visit";
        }
    }

    if (chosen === null) {
        throw new WorkflowRerunError("RERUN_VISIT_REQUIRED", "No suitable visit could be picked automatically. Name the visit with execution_id.");
    }

    const mode: WorkflowRerunMode = reqMode ?? defaultMode;
    validateVisitAndMode(chosen, mode);
    return { chosen, mode, picked, modesAvailable: modesAvailableFor(chosen) };
}

function orderLaneVisitsTopologically(lanes: readonly WorkflowRerunKey[], parallelIds: ReadonlySet<string>): WorkflowRerunKey[] {
    if (lanes.length <= 1) return [...lanes];
    const laneIds = new Set(lanes.map(k => k.nodeExecutionId));
    const remaining = new Map(lanes.map(k => [k.nodeExecutionId, k]));
    const ordered: WorkflowRerunKey[] = [];
    const placed = new Set<string>(parallelIds);
    while (remaining.size > 0) {
        const ready: WorkflowRerunKey[] = [];
        for (const k of remaining.values()) {
            if (k.predecessorId === null || placed.has(k.predecessorId) || !laneIds.has(k.predecessorId)) {
                ready.push(k);
            }
        }
        if (ready.length === 0) {
            const fallback = [...remaining.values()].sort(
                (a, b) => a.enteredAt.getTime() - b.enteredAt.getTime() || a.scopeId.localeCompare(b.scopeId) || a.ordinal - b.ordinal,
            );
            ordered.push(...fallback);
            break;
        }
        ready.sort((a, b) => a.scopeId.localeCompare(b.scopeId) || a.enteredAt.getTime() - b.enteredAt.getTime() || a.ordinal - b.ordinal);
        for (const k of ready) {
            ordered.push(k);
            placed.add(k.nodeExecutionId);
            remaining.delete(k.nodeExecutionId);
        }
    }
    return ordered;
}

export function partitionRerunVisits(
    keys: readonly WorkflowRerunKey[],
    chosenId: string,
    mode: WorkflowRerunMode,
): {
    reused: WorkflowRerunKey[];
    reusedTop: WorkflowRerunKey[];
    unwalkedCount: number;
    totalBytes: number;
    dropped: WorkflowRerunKey[];
    firstDroppedTop: WorkflowRerunKey | null;
} {
    const rootChain = orderedRootChain(keys);
    const chosenIndex = rootChain.findIndex(k => k.nodeExecutionId === chosenId);
    if (chosenIndex < 0) {
        throw new WorkflowRerunError("RERUN_VISIT_NOT_FOUND", `Visit ${chosenId} is not a top-level execution of this run.`, {
            executionId: chosenId,
        });
    }
    const split = mode === "run_again" ? chosenIndex : chosenIndex + 1;
    const reusedTop = rootChain.slice(0, split);
    const droppedTop = rootChain.slice(split);
    const reusedTopIds = new Set(reusedTop.map(k => k.nodeExecutionId));

    const rawReusedLanes: WorkflowRerunKey[] = [];
    const droppedLanes: WorkflowRerunKey[] = [];
    for (const k of keys) {
        if (k.scopeId === ROOT_SCOPE) continue;
        const parsed = parseBranchScope(k.scopeId);
        if (parsed && reusedTopIds.has(parsed.parallelNodeExecutionId)) {
            rawReusedLanes.push(k);
        } else {
            droppedLanes.push(k);
        }
    }
    const reusedLanes = orderLaneVisitsTopologically(rawReusedLanes, reusedTopIds);
    const reused = [...reusedTop, ...reusedLanes];
    const totalBytes = reused.reduce((sum, k) => sum + k.byteLength, 0);
    const dropped = [...droppedTop, ...droppedLanes];
    return {
        reused,
        reusedTop,
        unwalkedCount: reusedLanes.length,
        totalBytes,
        dropped,
        firstDroppedTop: droppedTop[0] ?? null,
    };
}

export function mapRerunExecutions(
    newRunId: string,
    reused: readonly WorkflowRerunKey[],
): MappedRerunExecution[] {
    for (const k of reused) {
        if (k.state !== "completed") {
            throw new WorkflowRerunError(
                "RERUN_VISIT_NOT_ALLOWED",
                `Visit ${k.nodeId} · visit ${k.ordinal} is not completed (state=${k.state}) and cannot be reused.`,
                { reason: "not_completed", executionId: k.nodeExecutionId, state: k.state },
            );
        }
    }

    const rootVisits = orderedRootChain(reused);
    const rootIds = new Set(rootVisits.map(k => k.nodeExecutionId));
    const laneVisits = orderLaneVisitsTopologically(
        reused.filter(k => k.scopeId !== ROOT_SCOPE),
        rootIds,
    );

    const idMap = new Map<string, string>();
    const mapped: MappedRerunExecution[] = [];

    for (const s of rootVisits) {
        const newId = rerunNodeExecutionIdFor(newRunId, ROOT_SCOPE, s.nodeId, s.ordinal);
        const newPredecessorId = s.predecessorId === null ? null : (idMap.get(s.predecessorId) ?? null);
        if (s.predecessorId !== null && newPredecessorId === null) {
            throw new WorkflowRerunError(
                "RERUN_VISIT_NOT_ALLOWED",
                `Reused visit ${s.nodeId} · visit ${s.ordinal} is missing its predecessor in the reused set.`,
                { reason: "missing_predecessor", executionId: s.nodeExecutionId, predecessorId: s.predecessorId },
            );
        }
        idMap.set(s.nodeExecutionId, newId);
        mapped.push({
            source: s,
            newId,
            newScopeId: ROOT_SCOPE,
            newPredecessorId,
        });
    }

    for (const s of laneVisits) {
        const parsed = parseBranchScope(s.scopeId);
        if (!parsed) {
            throw new WorkflowRerunError("RERUN_VISIT_NOT_ALLOWED", `Invalid lane scope "${s.scopeId}" on reused visit ${s.nodeExecutionId}.`, {
                reason: "invalid_scope",
                executionId: s.nodeExecutionId,
            });
        }
        const mappedParallelId = idMap.get(parsed.parallelNodeExecutionId);
        if (!mappedParallelId) {
            throw new WorkflowRerunError(
                "RERUN_VISIT_NOT_ALLOWED",
                `Lane visit ${s.nodeId} · visit ${s.ordinal} references an uncopied parallel visit.`,
                { reason: "missing_parallel", executionId: s.nodeExecutionId, parallelExecutionId: parsed.parallelNodeExecutionId },
            );
        }
        const newScopeId = branchScopeId(mappedParallelId, parsed.index);
        const newId = rerunNodeExecutionIdFor(newRunId, newScopeId, s.nodeId, s.ordinal);
        const newPredecessorId = s.predecessorId === null ? null : (idMap.get(s.predecessorId) ?? null);
        if (s.predecessorId !== null && newPredecessorId === null) {
            throw new WorkflowRerunError(
                "RERUN_VISIT_NOT_ALLOWED",
                `Reused lane visit ${s.nodeId} · visit ${s.ordinal} is missing its predecessor in the reused set.`,
                { reason: "missing_predecessor", executionId: s.nodeExecutionId, predecessorId: s.predecessorId },
            );
        }
        idMap.set(s.nodeExecutionId, newId);
        mapped.push({
            source: s,
            newId,
            newScopeId,
            newPredecessorId,
        });
    }

    return mapped;
}

function scopePlacementOf(ir: WorkflowIR): Map<string, string> {
    const place = new Map<string, string>();
    for (const node of Object.values(ir.nodes)) {
        if (node.type === "parallel") {
            if (node.branches) {
                for (const branch of node.branches) {
                    for (const stateId of branch.states) {
                        place.set(stateId, `parallel:${node.id}:branch:${branch.name}`);
                    }
                }
            } else {
                for (const stateId of node.body.states) {
                    place.set(stateId, `parallel:${node.id}:forEach`);
                }
            }
        }
    }
    for (const stateId of Object.keys(ir.nodes)) {
        if (!place.has(stateId)) place.set(stateId, ROOT_SCOPE);
    }
    return place;
}

function routeMatches(
    targetIr: WorkflowIR,
    fromVisit: WorkflowRerunKey,
    toNodeId: string,
    arrivalRoute: string | null,
): boolean {
    const tFrom = targetIr.nodes[fromVisit.nodeId];
    if (!tFrom) return false;
    if (arrivalRoute === CATCH_ALL_ROUTE) {
        if (fromVisit.resultKind !== "runtime_error") return false;
        if (targetIr.catchAll !== toNodeId) return false;
        if (tFrom.type === "terminal") return true;
        if (fromVisit.outcome === null) return false;
        return selectRoute(tFrom.next, { outcome: fromVisit.outcome, resultKind: "runtime_error" }) === null;
    }
    if (tFrom.type === "terminal") return false;
    if (arrivalRoute === null || fromVisit.outcome === null) return false;
    if (fromVisit.resultKind !== "business" && fromVisit.resultKind !== "runtime_error") return false;
    const pickedRoute = selectRoute(tFrom.next, { outcome: fromVisit.outcome, resultKind: fromVisit.resultKind });
    return pickedRoute === arrivalRoute && tFrom.next[arrivalRoute] === toNodeId;
}

function stripCosmeticAndRouting(node: WorkflowIRNode): JsonValue {
    const copy: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(node)) {
        if (k === "next" || k === "notes" || k === "description" || k === "routeNotes") continue;
        if (v !== undefined) copy[k] = v as JsonValue;
    }
    return copy;
}

export function checkRerunCompatibility(input: {
    sourceIr: WorkflowIR;
    targetIr: WorkflowIR;
    reused: readonly WorkflowRerunKey[];
    reusedTop: readonly WorkflowRerunKey[];
    chosen: WorkflowRerunKey;
    mode: WorkflowRerunMode;
    sourceControllerVersion: string | null;
}): {
    fits: boolean;
    problems: WorkflowRerunProblem[];
    changedReusedSteps: Array<{ stateId: string; visits: number }>;
} {
    const { sourceIr, targetIr, reused, reusedTop, chosen, mode, sourceControllerVersion } = input;
    const problems: WorkflowRerunProblem[] = [];

    // C9: controller version feature compatibility
    const latestFeatures = workflowControllerFeatures(WORKFLOW_CONTROLLER_VERSION);
    const sourceFeatures = sourceControllerVersion !== null && isWorkflowControllerVersion(sourceControllerVersion)
        ? workflowControllerFeatures(sourceControllerVersion)
        : null;
    if (
        !sourceFeatures
        || sourceFeatures.carry !== latestFeatures.carry
        || sourceFeatures.approval !== latestFeatures.approval
        || sourceFeatures.succession !== latestFeatures.succession
    ) {
        problems.push({
            code: "controller_too_old",
            stateId: null,
            visit: null,
            message: `Source controller version "${sourceControllerVersion ?? "unknown"}" does not match current controller features (${WORKFLOW_CONTROLLER_VERSION}).`,
        });
    }

    // Distinct reused step IDs (ordered by first appearance) and visit counts
    const reusedStepCounts = new Map<string, number>();
    for (const k of reused) {
        reusedStepCounts.set(k.nodeId, (reusedStepCounts.get(k.nodeId) ?? 0) + 1);
    }
    const reusedStepIds = [...reusedStepCounts.keys()];
    const sourcePlace = scopePlacementOf(sourceIr);
    const targetPlace = scopePlacementOf(targetIr);

    // C1 & C2 & C7 over reused steps
    const missingOrChangedType = new Set<string>();
    for (const id of reusedStepIds) {
        const sNode = sourceIr.nodes[id];
        const tNode = targetIr.nodes[id];
        if (!tNode) {
            missingOrChangedType.add(id);
            problems.push({
                code: "step_missing",
                stateId: id,
                visit: null,
                message: `Step ${id} is missing in the target revision.`,
            });
            continue;
        }
        if (
            !sNode
            || sNode.type !== tNode.type
            || (sNode.type === "messaging" && tNode.type === "messaging" && sNode.mode !== tNode.mode)
        ) {
            missingOrChangedType.add(id);
            const sKind = sNode?.type === "messaging" ? `${sNode.type}:${sNode.mode}` : (sNode?.type ?? "unknown");
            const tKind = tNode.type === "messaging" ? `${tNode.type}:${tNode.mode}` : tNode.type;
            problems.push({
                code: "step_type_changed",
                stateId: id,
                visit: null,
                message: `Step ${id} changed type from ${sKind} to ${tKind}.`,
            });
            continue;
        }
        // C2: scope placement
        if (sourcePlace.get(id) !== targetPlace.get(id)) {
            problems.push({
                code: "step_moved",
                stateId: id,
                visit: null,
                message: `Step ${id} moved between scopes (${sourcePlace.get(id)} -> ${targetPlace.get(id)}).`,
            });
        }
        // C7: parallel kind & named branch names
        if (sNode.type === "parallel" && tNode.type === "parallel") {
            const sHasBranches = sNode.branches !== undefined;
            const tHasBranches = tNode.branches !== undefined;
            const branchNamesMatch = sHasBranches === tHasBranches && (!sHasBranches || (
                sNode.branches!.length === tNode.branches!.length
                && sNode.branches!.every((b, idx) => b.name === tNode.branches![idx].name)
            ));
            if (!branchNamesMatch) {
                problems.push({
                    code: "parallel_changed",
                    stateId: id,
                    visit: null,
                    message: `Parallel step ${id} changed its branch structure or names.`,
                });
            }
        }
    }

    // C2: initial step must still match reusedTop[0]
    if (reusedTop.length > 0 && targetIr.initial !== reusedTop[0].nodeId) {
        problems.push({
            code: "step_moved",
            stateId: reusedTop[0].nodeId,
            visit: reusedTop[0].ordinal,
            message: `Initial step changed from ${reusedTop[0].nodeId} to ${targetIr.initial}.`,
        });
    }

    // C3: every adjacent pair (A, B) in reusedTop
    for (let i = 0; i < reusedTop.length - 1; i += 1) {
        const a = reusedTop[i];
        const b = reusedTop[i + 1];
        if (missingOrChangedType.has(a.nodeId) || missingOrChangedType.has(b.nodeId)) continue;
        if (!routeMatches(targetIr, a, b.nodeId, b.arrivalRoute)) {
            problems.push({
                code: "route_changed",
                stateId: a.nodeId,
                visit: a.ordinal,
                message: `Step ${a.nodeId} · visit ${a.ordinal} (${a.outcome ?? "unknown"}) no longer routes to ${b.nodeId} via ${b.arrivalRoute ?? "initial"}.`,
            });
        }
    }

    // C5: catchAll consistency & at-most-once
    const usedCatchAllInSource = reusedTop.some(
        k => k.arrivalRoute === CATCH_ALL_ROUTE || (sourceIr.catchAll !== null && k.nodeId === sourceIr.catchAll),
    );
    if (usedCatchAllInSource && targetIr.catchAll !== sourceIr.catchAll) {
        problems.push({
            code: "catch_all_changed",
            stateId: sourceIr.catchAll,
            visit: null,
            message: `Catch-all step changed from ${sourceIr.catchAll ?? "none"} to ${targetIr.catchAll ?? "none"} after a reused catch-all visit.`,
        });
    }
    if (targetIr.catchAll !== null) {
        const catchAllVisitsInReused = reusedTop.filter(k => k.nodeId === targetIr.catchAll).length;
        if (catchAllVisitsInReused > 1 || (mode === "run_again" && chosen.nodeId === targetIr.catchAll && catchAllVisitsInReused >= 1)) {
            problems.push({
                code: "catch_all_twice",
                stateId: targetIr.catchAll,
                visit: mode === "run_again" && chosen.nodeId === targetIr.catchAll ? chosen.ordinal : null,
                message: `Catch-all step ${targetIr.catchAll} can only be entered once per run.`,
            });
        }
    }

    // C4: cut routing
    if (mode === "run_again") {
        const tChosen = targetIr.nodes[chosen.nodeId];
        if (!tChosen) {
            if (!missingOrChangedType.has(chosen.nodeId)) {
                problems.push({
                    code: "step_missing",
                    stateId: chosen.nodeId,
                    visit: chosen.ordinal,
                    message: `Chosen step ${chosen.nodeId} is missing in the target revision.`,
                });
            }
        } else if (targetPlace.get(chosen.nodeId) !== ROOT_SCOPE) {
            problems.push({
                code: "step_moved",
                stateId: chosen.nodeId,
                visit: chosen.ordinal,
                message: `Chosen step ${chosen.nodeId} is no longer a top-level step in the target revision.`,
            });
        } else {
            const last = reusedTop.at(-1);
            if (last && !missingOrChangedType.has(last.nodeId) && !routeMatches(targetIr, last, chosen.nodeId, chosen.arrivalRoute)) {
                problems.push({
                    code: "route_changed",
                    stateId: last.nodeId,
                    visit: last.ordinal,
                    message: `Step ${last.nodeId} · visit ${last.ordinal} (${last.outcome ?? "unknown"}) no longer routes to ${chosen.nodeId} via ${chosen.arrivalRoute ?? "initial"}.`,
                });
            }
        }
    } else {
        // continue mode: target revision must route chosen's stored result (and must not re-enter an already-used catch-all)
        const tChosen = targetIr.nodes[chosen.nodeId];
        if (tChosen && !missingOrChangedType.has(chosen.nodeId)) {
            let hasRoute = false;
            let hitsCatchAllTwice = false;
            const catchAllAlreadyUsed = targetIr.catchAll !== null
                && reusedTop.some(k => k.arrivalRoute === CATCH_ALL_ROUTE || k.nodeId === targetIr.catchAll);
            if (tChosen.type !== "terminal" && chosen.outcome !== null && (chosen.resultKind === "business" || chosen.resultKind === "runtime_error")) {
                const direct = selectRoute(tChosen.next, { outcome: chosen.outcome, resultKind: chosen.resultKind });
                if (direct !== null) {
                    if (targetIr.catchAll !== null && tChosen.next[direct] === targetIr.catchAll && catchAllAlreadyUsed) {
                        hitsCatchAllTwice = true;
                    } else {
                        hasRoute = true;
                    }
                } else if (chosen.resultKind === "runtime_error" && targetIr.catchAll !== null) {
                    if (!catchAllAlreadyUsed) hasRoute = true;
                }
            }
            if (hitsCatchAllTwice) {
                problems.push({
                    code: "catch_all_twice",
                    stateId: targetIr.catchAll,
                    visit: chosen.ordinal,
                    message: `Step ${chosen.nodeId} · visit ${chosen.ordinal} routes to catch-all step ${targetIr.catchAll}, which already ran.`,
                });
            } else if (!hasRoute) {
                problems.push({
                    code: "no_route",
                    stateId: chosen.nodeId,
                    visit: chosen.ordinal,
                    message: `Target revision has no route from ${chosen.nodeId} · visit ${chosen.ordinal} for outcome "${chosen.outcome ?? "unknown"}".`,
                });
            }
        }
    }

    // C6: carry declaration on the last reused top-level visit before the cut
    const pred = reusedTop.at(-1);
    if (pred && !missingOrChangedType.has(pred.nodeId)) {
        const tPred = targetIr.nodes[pred.nodeId];
        if (tPred) {
            const targetHasCarry = tPred.type !== "terminal" && tPred.carry !== undefined;
            if (targetHasCarry !== pred.hasCarry) {
                problems.push({
                    code: "carry_changed",
                    stateId: pred.nodeId,
                    visit: pred.ordinal,
                    message: `Step ${pred.nodeId} ${targetHasCarry ? "added" : "removed"} carry before the cut.`,
                });
            }
        }
    }

    // C8: maxNodeExecutions
    if (reused.length >= targetIr.limits.maxNodeExecutions) {
        problems.push({
            code: "limit_too_low",
            stateId: null,
            visit: null,
            message: `Target revision limit maxNodeExecutions (${targetIr.limits.maxNodeExecutions}) must exceed the ${reused.length} reused visits.`,
        });
    }

    const fits = problems.length === 0;
    const changedReusedSteps: Array<{ stateId: string; visits: number }> = [];
    if (fits) {
        for (const id of reusedStepIds) {
            const sNode = sourceIr.nodes[id];
            const tNode = targetIr.nodes[id];
            if (!sNode || !tNode) continue;
            if (canonicalJson(stripCosmeticAndRouting(sNode)) !== canonicalJson(stripCosmeticAndRouting(tNode))) {
                changedReusedSteps.push({ stateId: id, visits: reusedStepCounts.get(id)! });
            }
        }
    }

    return { fits, problems, changedReusedSteps };
}

function reachableStateIds(ir: WorkflowIR, startIds: readonly string[]): Set<string> {
    const visited = new Set<string>();
    const queue = [...startIds];
    while (queue.length > 0) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        const node = ir.nodes[id];
        if (!node) continue;
        visited.add(id);
        if (node.type !== "terminal") {
            for (const target of Object.values(node.next)) {
                if (!visited.has(target)) queue.push(target);
            }
            if (node.type === "parallel") {
                for (const bodyState of node.body.states) {
                    if (!visited.has(bodyState)) queue.push(bodyState);
                }
            }
        }
        if (ir.catchAll && !visited.has(ir.catchAll)) queue.push(ir.catchAll);
    }
    return visited;
}

function nextTargetStateForContinue(ir: WorkflowIR, chosen: WorkflowRerunKey, reused: readonly WorkflowRerunKey[]): string | null {
    const node = ir.nodes[chosen.nodeId];
    if (!node || node.type === "terminal") return null;
    if (chosen.outcome === null || (chosen.resultKind !== "business" && chosen.resultKind !== "runtime_error")) return null;
    const route = selectRoute(node.next, { outcome: chosen.outcome, resultKind: chosen.resultKind });
    if (route !== null) return node.next[route] ?? null;
    if (chosen.resultKind === "runtime_error" && ir.catchAll !== null) {
        const used = reused.some(k => k.scopeId === ROOT_SCOPE && (k.arrivalRoute === CATCH_ALL_ROUTE || k.nodeId === ir.catchAll));
        if (!used) return ir.catchAll;
    }
    return null;
}

export function buildRerunWarnings(input: BuildRerunWarningsInput): WorkflowRerunWarning[] {
    const {
        sourceNumber,
        targetIr,
        reused,
        dropped,
        chosen,
        mode,
        changedReusedSteps,
        deliveredOutboxExecIds,
        droppedSpawnChildren,
        reusedSpawnNoticeChildIds,
        droppedConsumedUncarriedExecIds,
        reusedApprovals,
        droppedApprovals,
    } = input;
    const warnings: WorkflowRerunWarning[] = [];
    const srcLabel = sourceNumber !== null ? `#${sourceNumber}` : "the source Workflow";

    // 1. step_runs_again / 12. decision_runs_again
    if (mode === "run_again") {
        if (chosen.nodeType === "decision") {
            warnings.push({
                code: "decision_runs_again",
                stateId: chosen.nodeId,
                message: `The Decision step ${chosen.nodeId} asks the model again. Its answer can differ.`,
            });
        } else {
            // Only warn when the chosen visit actually started work (skip visits settled at entry such as exhausted or invalid_input).
            const settledAtEntry = chosen.winner === "controller"
                && (chosen.outcome === "exhausted" || chosen.outcome === "invalid_input");
            const targetNode = targetIr.nodes[chosen.nodeId];
            const isActiveMessaging = chosen.nodeType === "messaging"
                && (!targetNode || (targetNode.type === "messaging" && (targetNode.mode === "send" || targetNode.mode === "request")));
            if (!settledAtEntry && (chosen.nodeType === "script" || chosen.nodeType === "agent" || chosen.nodeType === "spawn" || isActiveMessaging)) {
                warnings.push({
                    code: "step_runs_again",
                    stateId: chosen.nodeId,
                    message: `${chosen.nodeId} runs again. If it did part of its work before it failed, it does that part again.`,
                });
            }
        }
    }

    // 2. work_after_cut
    const droppedWork = dropped.filter(k =>
        (k.nodeType === "script" || k.nodeType === "agent")
        && !(mode === "run_again" && k.nodeExecutionId === chosen.nodeExecutionId),
    );
    if (droppedWork.length > 0) {
        const names = [...new Set(droppedWork.map(k => k.nodeId))];
        warnings.push({
            code: "work_after_cut",
            stateId: null,
            message: `${droppedWork.length} ${droppedWork.length === 1 ? "step" : "steps"} ran after this point in ${srcLabel}: ${names.join(", ")}. What they did outside the Workflow stays.`,
            details: droppedWork.map(k => ({
                executionId: k.nodeExecutionId,
                stateId: k.nodeId,
                visit: k.ordinal,
                outcome: k.outcome,
                outputPreview: k.outputPreview ?? null,
            })),
        });
    }

    // 3. messages_sent
    const deliveredDropped = dropped.filter(k => deliveredOutboxExecIds.has(k.nodeExecutionId));
    if (deliveredDropped.length > 0) {
        warnings.push({
            code: "messages_sent",
            stateId: null,
            message: `${srcLabel} sent ${deliveredDropped.length} ${deliveredDropped.length === 1 ? "message" : "messages"} after this point. They are not taken back. The re-run may send them again.`,
            details: deliveredDropped.map(k => ({ executionId: k.nodeExecutionId, stateId: k.nodeId, visit: k.ordinal })),
        });
    }

    // 4. children_started
    const droppedSpawns = dropped.filter(k => k.nodeType === "spawn");
    if (droppedSpawns.length > 0) {
        const labels = droppedSpawns.map(k => {
            const info = droppedSpawnChildren.get(k.nodeExecutionId);
            if (!info) return k.nodeId;
            const num = info.number !== null ? ` #${info.number}` : "";
            const st = info.status ? `, ${info.status}` : "";
            return `${info.name ?? k.nodeId}${num}${st}`;
        });
        warnings.push({
            code: "children_started",
            stateId: null,
            message: `${srcLabel} started ${droppedSpawns.length} child ${droppedSpawns.length === 1 ? "Workflow" : "Workflows"} after this point: ${labels.join("; ")}. The re-run starts a new one.`,
            details: droppedSpawns.map(k => {
                const info = droppedSpawnChildren.get(k.nodeExecutionId);
                return {
                    executionId: k.nodeExecutionId,
                    stateId: k.nodeId,
                    visit: k.ordinal,
                    childWorkflowId: k.spawnChildWorkflowId,
                    name: info?.name ?? null,
                    number: info?.number ?? null,
                    status: info?.status ?? null,
                };
            }),
        });
    }

    // 5. approvals_asked
    if (droppedApprovals.length > 0) {
        for (const a of droppedApprovals) {
            warnings.push({
                code: "approvals_asked",
                stateId: a.stateId,
                message: `You were asked '${a.question}' after this point. The re-run asks again.`,
                details: { executionId: a.executionId, stateId: a.stateId, visit: a.visit, question: a.question },
            });
        }
    }

    // 6. inputs_taken
    if (droppedConsumedUncarriedExecIds.size > 0) {
        const count = droppedConsumedUncarriedExecIds.size;
        warnings.push({
            code: "inputs_taken",
            stateId: null,
            message: `${srcLabel} received ${count} ${count === 1 ? "message" : "messages"} after this point. Send ${count === 1 ? "it" : "them"} again if the re-run needs ${count === 1 ? "it" : "them"}.`,
            details: [...droppedConsumedUncarriedExecIds],
        });
    }

    // 7. reused_setup
    if (reused.some(k => k.nodeType === "script" || k.nodeType === "agent")) {
        warnings.push({
            code: "reused_setup",
            stateId: null,
            message: "Reused steps are not checked again. Something they set up, such as a lock or a branch, may be gone by now.",
        });
    }

    // 8. reused_child_gone
    for (const k of reused) {
        if (k.nodeType === "spawn" && k.spawnChildWorkflowId !== null && !reusedSpawnNoticeChildIds.has(k.spawnChildWorkflowId)) {
            warnings.push({
                code: "reused_child_gone",
                stateId: k.nodeId,
                message: `${k.nodeId} started a child Workflow (${k.spawnChildWorkflowId}) that has no end notice. A step that waits for it will time out. Choose ${k.nodeId} instead.`,
                details: { executionId: k.nodeExecutionId, stateId: k.nodeId, visit: k.ordinal, childWorkflowId: k.spawnChildWorkflowId },
            });
        }
    }

    // 9. changed_reused_step
    for (const entry of changedReusedSteps) {
        warnings.push({
            code: "changed_reused_step",
            stateId: entry.stateId,
            message: `Step ${entry.stateId} changed. Its ${entry.visits} reused ${entry.visits === 1 ? "result was" : "results were"} made by the old version.`,
            details: { stateId: entry.stateId, visits: entry.visits },
        });
    }

    // 10. agent_memory
    const startAtCut = mode === "run_again"
        ? [chosen.nodeId]
        : (() => {
            const nxt = nextTargetStateForContinue(targetIr, chosen, reused);
            return nxt ? [nxt] : [];
        })();
    const reachable = reachableStateIds(targetIr, startAtCut);
    const reusedAgentCounts = new Map<string, number>();
    for (const k of reused) {
        if (k.nodeType === "agent") {
            reusedAgentCounts.set(k.nodeId, (reusedAgentCounts.get(k.nodeId) ?? 0) + 1);
        }
    }
    for (const [stateId, visits] of reusedAgentCounts) {
        const node = targetIr.nodes[stateId];
        if (node && node.type === "agent" && node.session === "continue" && reachable.has(stateId)) {
            warnings.push({
                code: "agent_memory",
                stateId,
                message: `${stateId} gets a new agent session with a summary of its ${visits} reused ${visits === 1 ? "visit" : "visits"}. It does not remember the old session.`,
                details: { stateId, visits },
            });
        }
    }

    // 11. approval_reused
    for (const a of reusedApprovals) {
        const when = a.decidedAt ? `, given ${a.decidedAt}` : "";
        warnings.push({
            code: "approval_reused",
            stateId: a.stateId,
            message: `Reused: your ${a.outcome} decision on '${a.question}'${when}.`,
            details: { executionId: a.executionId, stateId: a.stateId, visit: a.visit, question: a.question, outcome: a.outcome, decidedAt: a.decidedAt },
        });
    }

    return warnings;
}

export function buildRerunResume(input: BuildRerunResumeInput): WorkflowRerunResume {
    const { mode, chosen, mappedPredecessorId, cutKvRevision, sourceRevision, sourceIrSha256, targetIrSha256 } = input;
    const sameIr = sourceIrSha256 === targetIrSha256;
    if (mode === "run_again") {
        return {
            v: 1,
            mode: "run_again",
            stateId: chosen.nodeId,
            ordinal: chosen.ordinal,
            scopeId: "root",
            arrivalRoute: chosen.arrivalRoute,
            predecessorId: mappedPredecessorId,
            cutKvRevision,
            sameIr,
            expectedInputSha256: sameIr ? chosen.inputSha256 : null,
            expectedCarrySha256: sameIr ? chosen.carrySha256 : null,
            recordedInputSha256: chosen.inputSha256,
            fromStateId: chosen.nodeId,
            fromVisit: chosen.ordinal,
            sourceRevision,
        };
    }
    return {
        v: 1,
        mode: "continue",
        stateId: null,
        ordinal: null,
        scopeId: "root",
        arrivalRoute: null,
        predecessorId: mappedPredecessorId,
        cutKvRevision,
        sameIr,
        expectedInputSha256: null,
        expectedCarrySha256: null,
        recordedInputSha256: null,
        fromStateId: chosen.nodeId,
        fromVisit: chosen.ordinal,
        sourceRevision,
    };
}

export function buildRerunPlan(input: BuildRerunPlanInput): WorkflowRerunPlan {
    const {
        source,
        chosen,
        picked,
        mode,
        modesAvailable,
        revision,
        sourceRevisionFits,
        reused,
        reusedRequests,
        dropped,
        targetIr,
        warnings,
        allowed,
        blockedReason,
    } = input;

    const stepCounts = new Map<string, number>();
    let totalBytes = 0;
    for (const k of reused) {
        totalBytes += k.byteLength;
        stepCounts.set(k.nodeId, (stepCounts.get(k.nodeId) ?? 0) + 1);
    }
    const steps = [...stepCounts.entries()].map(([stateId, visits]) => ({ stateId, visits }));

    let firstRun: { stateId: string; visit: number } | null = null;
    if (mode === "run_again") {
        firstRun = { stateId: chosen.nodeId, visit: chosen.ordinal };
    } else {
        const nextId = nextTargetStateForContinue(targetIr, chosen, reused);
        if (nextId !== null) {
            const priorVisits = reused.filter(k => k.scopeId === ROOT_SCOPE && k.nodeId === nextId).length;
            firstRun = { stateId: nextId, visit: priorVisits + 1 };
        }
    }

    return {
        of: {
            workflowId: source.workflowId,
            runId: source.runId,
            revision: source.revision,
            status: source.status,
            number: source.number,
        },
        from: {
            executionId: chosen.nodeExecutionId,
            stateId: chosen.nodeId,
            visit: chosen.ordinal,
            picked,
        },
        mode,
        modesAvailable: [...modesAvailable],
        revision: {
            target: revision.target,
            newestValid: revision.newestValid,
            fits: revision.fits,
            problems: [...revision.problems],
            changedReusedSteps: revision.changedReusedSteps.map(s => ({ ...s })),
        },
        sourceRevisionFits,
        reused: {
            visits: reused.length,
            bytes: totalBytes,
            steps,
            requests: reusedRequests.map(r => ({ ...r })),
        },
        runs: {
            first: firstRun,
        },
        dropped: dropped.map(k => ({
            executionId: k.nodeExecutionId,
            stateId: k.nodeId,
            visit: k.ordinal,
            type: k.nodeType,
            outcome: k.outcome,
            outputPreview: k.outputPreview ?? null,
        })),
        warnings: [...warnings],
        allowed,
        blockedReason,
    };
}
