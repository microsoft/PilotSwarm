import type { OrchestrationContext, ScheduledTask } from "duroxide";
import { WORKFLOW_CONTROLLER_VERSION as WORKFLOW_CONTROLLER_LATEST_VERSION } from "../controller-version.js";
import {
    ACTIVE_RUN_STATUSES,
    BRANCH_ROUTE,
    type BranchCancelReason,
    CATCH_ALL_ROUTE,
    type CollectedResult,
    type ControllerCursor,
    type ControllerInput,
    type ControllerOwedCut,
    type ControllerParallel,
    type ControllerPlan,
    type ControllerResult,
    type ControllerState,
    PARALLEL_JOINED,
    ROOT_SCOPE,
    WORKFLOW_ACTIVITIES,
    WORKFLOW_ADMISSIONS_PER_EXECUTION,
    WORKFLOW_AGENT_NAME,
    WORKFLOW_AGENT_VERSION,
    WORKFLOW_COMMAND_POLL_MS,
    WORKFLOW_COMMAND_QUEUE,
    WORKFLOW_COMMAND_READ_BATCH,
    WORKFLOW_EFFECT_NAME,
    WORKFLOW_EFFECT_VERSION,
    WORKFLOW_FINALIZE_DELAYS_MS,
    WORKFLOW_IDLE_WAITS_PER_EXECUTION,
    WORKFLOW_REQUEST_CAPABILITY,
    WORKFLOW_REQUEST_NAME,
    WORKFLOW_REQUEST_VERSION,
    WORKFLOW_SEND_NAME,
    WORKFLOW_SEND_VERSION,
    WORKFLOW_STORE_RETRY_DELAYS_MS,
    type WorkflowActivityKey,
    branchScopeId,
    expect,
    isRecord,
    parallelBranchInitial,
    parseBegin,
    parseBranchCancel,
    parseBranchScope,
    parseCollectedWithStop,
    parseControllerInput,
    parseElapse,
    parseEndResult,
    parseEnter,
    parseExpire,
    parseJoinAnswer,
    parseNow,
    parseObservedEnd,
    parsePlan,
    parseRace,
    parseStopFinish,
    parseTerminalFinish,
    parseWorkflowCommand,
    record,
    selectRoute,
    workflowAgentInstanceId,
    workflowEffectInstanceId,
    workflowErrorMessage,
    workflowRequestInstanceId,
    workflowSendInstanceId,
} from "./runtime.js";

// ─── Controller orchestration ───────────────────────────────────────

function publishStatus(ctx: OrchestrationContext, input: ControllerInput, plan: ControllerPlan | null, state: ControllerState | null, status: string): void {
    const cursor = state?.cursors[0];
    ctx.setCustomStatus(JSON.stringify({
        status,
        sessionKind: "workflow",
        workflow: {
            v: 1,
            runId: input.runId,
            name: plan?.name ?? null,
            stateId: cursor?.nodeId ?? null,
            step: state?.steps ?? 0,
        },
    }));
}

/** One activity with the workflow-request capability tag; a runtime that cannot express the tag fails closed. */
function taggedActivity(ctx: OrchestrationContext, name: string, input: unknown): ScheduledTask {
    const task = ctx.scheduleActivityTyped(name, input) as ScheduledTask & { withTag?: (tag: string) => ScheduledTask };
    if (typeof task.withTag !== "function") throw new Error("Workflow requests require Duroxide activity tag routing support.");
    return task.withTag(WORKFLOW_REQUEST_CAPABILITY);
}

/** A tagged store activity with five attempts on durable timers; the last failure propagates. */
function* storeTagged(ctx: OrchestrationContext, name: string, input: unknown): Generator<ScheduledTask, unknown, unknown> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return yield taggedActivity(ctx, name, input);
        } catch (error) {
            if (attempt >= WORKFLOW_STORE_RETRY_DELAYS_MS.length) throw error;
            yield ctx.scheduleTimer(WORKFLOW_STORE_RETRY_DELAYS_MS[attempt]);
        }
    }
}

/**
 * Run a tagged store activity that must not be lost: each attempt is storeTagged's, and attempts are separated by
 * durable timers (WORKFLOW_FINALIZE_DELAYS_MS). The last failure propagates.
 */
function* persistentlyTagged(ctx: OrchestrationContext, name: string, input: unknown): Generator<ScheduledTask, unknown, unknown> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return yield* storeTagged(ctx, name, input);
        } catch (error) {
            if (attempt >= WORKFLOW_FINALIZE_DELAYS_MS.length) throw error;
            ctx.traceWarn(`[workflow] ${name} attempt ${attempt + 1} failed; retrying: ${workflowErrorMessage(error)}`);
            yield ctx.scheduleTimer(WORKFLOW_FINALIZE_DELAYS_MS[attempt]);
        }
    }
}

/** A store write of the controller that must not be lost (persistentlyTagged). */
function persist(ctx: OrchestrationContext, name: WorkflowActivityKey, input: unknown): Generator<ScheduledTask, unknown, unknown> {
    return persistentlyTagged(ctx, WORKFLOW_ACTIVITIES[name], input);
}

/**
 * After the run ended, before its parent is told: the children of its decided agent states are ended. A child
 * that could not be ended after every attempt does not keep the run's end from being reported: the invocation shows no
 * end (read_workflow), and the failure is traced.
 */
function* endRunChildren(ctx: OrchestrationContext, runId: string): Generator<ScheduledTask, void, unknown> {
    try {
        yield* persistentlyTagged(ctx, WORKFLOW_ACTIVITIES.endAgents, { runId });
    } catch (error) {
        ctx.traceWarn(`[workflow] run=${runId} agent children were not all ended: ${workflowErrorMessage(error)}`);
    }
}

/** Tell the parent that the run ended (at least once) and publish its final status. */
function* reportEnded(ctx: OrchestrationContext, runId: string, result: ControllerResult): Generator<ScheduledTask, ControllerResult, unknown> {
    yield* endRunChildren(ctx, runId);
    yield* persist(ctx, "notifyParent", { runId });
    // A stopped run shows as cancelled, as its session row does (the session statuses have no "stopped").
    ctx.setCustomStatus(JSON.stringify({ status: result.status === "failed" ? "failed" : result.status === "cancelled" || result.status === "stopped" ? "cancelled" : "completed",
        sessionKind: "workflow", workflow: { v: 1, runId, outcome: result.outcome } }));
    return result;
}

/** End the run as failed with a cause that is not a terminal state's result. */
function* finishRun(
    ctx: OrchestrationContext,
    runId: string,
    request: { failure: { nodeId: string | null; nodeExecutionId: string | null; code: string; message: string } },
): Generator<ScheduledTask, ControllerResult, unknown> {
    const finished = parseEndResult(yield* persist(ctx, "finish", { runId, ...request }));
    // S7-DX3 (N-1): another writer ended the run first: its end is reconciled as any other observed end.
    if (finished.elsewhere) return yield* endedElsewhere(ctx, runId);
    return yield* reportEnded(ctx, runId, finished.result);
}

/**
 * The controller's technical failure path: a store, protocol or input fault
 * ends the run as failed with its cause. This is not the workflow's catch-all
 * state (a business route for unhandled node errors); it never runs workflow
 * code.
 */
function* failRun(ctx: OrchestrationContext, runId: string, message: string): Generator<ScheduledTask, ControllerResult, unknown> {
    ctx.traceError(`[workflow] run=${runId} controller error: ${message}`);
    return yield* finishRun(ctx, runId, { failure: { nodeId: null, nodeExecutionId: null, code: "controller_error", message } });
}

/** The controller orchestration (1.0.0): controlRun, and a fault ends its run visibly (failRun). */
export function* workflowController_1_0_0(ctx: OrchestrationContext, rawInput: unknown): Generator<ScheduledTask, ControllerResult | null, unknown> {
    let input: ControllerInput;
    try {
        input = parseControllerInput(rawInput);
    } catch (error) {
        // Fail closed: when the input still names a run, that run ends visibly.
        const runId = isRecord(rawInput) && typeof rawInput.runId === "string" ? rawInput.runId : null;
        if (runId === null) throw error;
        return yield* failRun(ctx, runId, `The controller input is invalid: ${workflowErrorMessage(error)}`);
    }
    try {
        return yield* controlRun(ctx, input);
    } catch (error) {
        return yield* failRun(ctx, input.runId, workflowErrorMessage(error));
    }
}

type QueuedWorkflowCommand = NonNullable<ReturnType<typeof parseWorkflowCommand>>;

/**
 * Read the messages already queued, without waiting for more, at most WORKFLOW_COMMAND_READ_BATCH of them (review
 * DX-2): the first lifecycle command, or null when the 10 ms poll found the queue empty or the batch ended first (the pass
 * goes on to its store activities, and the next pass reads on). A message is only a hint since S7-DX2: an accepted cancel,
 * done or delete has already ended the run in the store, which every store call of the controller finds; a command read
 * here (also one an older build queued) is applied to the run as it is (applyCommand), and wakes are dropped.
 */
function* takeQueuedCommand(ctx: OrchestrationContext): Generator<ScheduledTask, QueuedWorkflowCommand | null, unknown> {
    for (let read = 0; read < WORKFLOW_COMMAND_READ_BATCH; read += 1) {
        const polled = parseRace(yield ctx.race(ctx.dequeueEvent(WORKFLOW_COMMAND_QUEUE), ctx.scheduleTimer(WORKFLOW_COMMAND_POLL_MS)));
        if (polled.index === 1) return null;
        const command = parseWorkflowCommand(polled.value);
        if (command) return command;
    }
    return null;
}

/**
 * The one reconciliation of a run that another writer ended (S7-DX2, S7-DX3 N-1, N-2), whichever store call of this
 * controller found it: an admission, a collection, the finish of a terminal or a failure, a command's
 * cancel, the stop's end or the run deadline's end. The ender may be an accepted cancel or done (any entry point), the
 * workflow's deletion, the run deadline, or a recover. observeEnd asks the effects of every node that end cancelled to
 * stop (repeat-safe). Then, for any end but a deletion, the run's end is reported as this controller reports its own
 * (reportEnded: its agent children are ended, the parent is told by the requester the stored end records, never by a
 * command that lost, and the final status is published); a deletion ends the children only, as before.
 */
function* endedElsewhere(ctx: OrchestrationContext, runId: string): Generator<ScheduledTask, ControllerResult, unknown> {
    const observed = parseObservedEnd(yield* persist(ctx, "observeEnd", { runId }));
    const result: ControllerResult = { runId: observed.runId, status: observed.status, outcome: observed.outcome };
    if (!observed.deleted) return yield* reportEnded(ctx, runId, result);
    yield* endRunChildren(ctx, runId);
    return result;
}

/** Apply one lifecycle command (cancel, done or delete) and end the controller. */
function* applyCommand(ctx: OrchestrationContext, input: ControllerInput, command: QueuedWorkflowCommand)
    : Generator<ScheduledTask, ControllerResult, unknown> {
    const applied = parseEndResult(yield* persist(ctx, "cancel", {
        runId: input.runId, command: command.cmd, reason: command.reason ?? null, requestedBy: command.requestedBy ?? null,
    }));
    // S7-DX3 (N-2): another writer ended the run first (an accepted cancel or done, a deletion, a finish): the notice and the
    // status follow that stored end, never this command's requester.
    if (applied.elsewhere) return yield* endedElsewhere(ctx, input.runId);
    const ended = applied.result;
    // The children of the agent states this end decided are cancelled.
    yield* endRunChildren(ctx, input.runId);
    if (command.cmd !== "delete") {
        yield* persist(ctx, "notifyParent", { runId: input.runId, requestedBy: command.requestedBy ?? null });
    }
    ctx.setCustomStatus(JSON.stringify({ status: ended.status === "cancelled" ? "cancelled" : ended.status === "failed" ? "failed" : "completed",
        sessionKind: "workflow", workflow: { v: 1, runId: input.runId, outcome: ended.outcome } }));
    return ended;
}

/**
 * The controller's loop (design workflow-messaging-request.md 4, 8.1, 8.5). Every activity is tagged (storeTagged,
 * persistentlyTagged). A request admitted pending starts its delivery orchestration (WORKFLOW_REQUEST_NAME) and waits
 * on this controller's timers for its deadline, as a wait does: the elapse activity decides it timed_out
 * (store.elapseRequest), the only producer of that result. While a request waits, its responder is observed once per
 * backstop period (the observe activity, store.observeRequestResponder). It continues as new at the latest version. A
 * response decides the request's node in its own transaction; its wake, or the backstop, makes this controller collect it.
 *
 * Graceful stop (design 02 run lifecycle, D03; migration 0088): once the
 * run has an accepted stop (an admission refused "stopping", or a
 * collection that reports it), this controller admits nothing and routes
 * no result: the work it admitted settles (its results are stored and
 * kept), commands still apply, and when none is pending, or at the stop's
 * deadline by the store's clock, the stop activity ends the run stopped,
 * cancelling what is still pending then, and the parent is told as for any
 * end. The stop is read from the store again after a continue-as-new.
 *
 * Pause (adversarial reviews RT-6 and R2-RT-1): once an admission is
 * refused "paused", or a collection reports the run paused (read after its
 * results; this is how a run whose every cursor waits on work finds it),
 * this controller admits nothing and routes no result until the resume: no
 * branch ends, no failFast cancellation, join or run end follows from a
 * result. Deadlines still decide (the run's, each pending state's, and a
 * parallel state's own time limit, whose decision cuts its branches), an
 * agent state's child is ended once its state is decided and its end is
 * tried again until recorded, and commands still apply. Its node limit ends
 * the run only where it would admit, so not while paused. A stop goes
 * before a pause. A pause committed after a collection's read takes effect
 * at the next admission or collection.
 */
function* controlRun(ctx: OrchestrationContext, input: ControllerInput): Generator<ScheduledTask, ControllerResult | null, unknown> {
    const R = WORKFLOW_ACTIVITIES;
    let restored = input.state ?? null;
    if (!restored) {
        publishStatus(ctx, input, null, null, "running");
        const begun = parseBegin(yield* storeTagged(ctx, R.begin, { runId: input.runId }));
        if (!ACTIVE_RUN_STATUSES.includes(begun.status)) return { runId: input.runId, status: begun.status, outcome: begun.outcome };
        restored = {
            irSha256: begun.irSha256, steps: 0, ordinals: {}, catchAllEntered: false,
            cursors: [{ scopeId: ROOT_SCOPE, nodeId: begun.initial, predecessorId: null, arrivalRoute: null, pending: null, deadlineMs: null }],
        };
    }
    const state: ControllerState = restored;
    const plan = parsePlan(yield* storeTagged(ctx, R.plan, { runId: input.runId, irSha256: state.irSha256 }));
    let admittedThisExecution = 0;
    let idleWaits = 0;
    // The agent states whose child this execution ended while the run was paused (RT-6 verification; not carried by
    // continue-as-new: ending a child again is a no-op).
    const pausedEnded = new Set<string>();
    // When the waiting requests' responders were last observed (once per backstop period; not carried by continue-as-new).
    let observedAtMs: number | null = null;
    // When the owed stops and ends of cut branches were last tried (J1d; once per backstop period; not carried by
    // continue-as-new: the next execution tries them at its first pass, J1e).
    let owedTriedAtMs: number | null = null;
    // The run's accepted stop, as the store last reported its deadline (not carried by continue-as-new: a stop is never
    // withdrawn, and the next execution reads it again at its first admission or collection).
    let stopping: { deadlineMs: number } | null = null;
    // The run's deadline (limits.timeoutSeconds, migration 0088) on this controller's timers: a live run's, as the store wrote
    // it when the run began, moved later while the store's clock has not reached it. A test run's is on its virtual clock and
    // is not timed here: its admissions and collections report it.
    let runDeadlineMs: number | null = plan.deadlineMs ?? null;
    /** Have the store end the run at its deadline (its clock decides); null while that clock has not reached it. */
    const expireRun = function* (): Generator<ScheduledTask, ControllerResult | null, unknown> {
        const expiry = parseExpire(yield* persistentlyTagged(ctx, R.expire, { runId: input.runId }));
        if (!expiry.ended) {
            if (plan.test !== true) runDeadlineMs = parseNow(yield ctx.utcNow()) + expiry.remainingMs;
            return null;
        }
        // Another end decided the run first (a cancel, a deletion): it is done, as when an admission finds it so.
        if (!expiry.expired) return yield* endedElsewhere(ctx, input.runId);
        return yield* reportEnded(ctx, input.runId, expiry.result);
    };
    // S7-DX2: a lifecycle command is store state, not a queued message, so continue-as-new may drop unread wakes.
    // FB-064: every continue-as-new moves the run to the latest controller, as the session orchestration does. Duroxide does
    // not replay the target, and every version reads this ControllerInput (it only gains optional fields).
    const continueAsNew = function* (): Generator<ScheduledTask, null, unknown> {
        yield ctx.continueAsNewVersioned({ v: 1, workflowSessionId: input.workflowSessionId, runId: input.runId, state } satisfies ControllerInput,
            WORKFLOW_CONTROLLER_LATEST_VERSION);
        return null;
    };

    // ── Parallel states (design 02 parallel scope and join) ──
    const parallels = (): ControllerParallel[] => (state.parallels ??= []);
    const branchesOf = (parallel: ControllerParallel) => state.cursors.filter(item => parseBranchScope(item.scopeId)?.parallelNodeExecutionId === parallel.nodeExecutionId);
    /** Start branches of `parallel` while fewer than its concurrency are active (each a cursor at the body's initial state). */
    const startBranches = (parallel: ControllerParallel): void => {
        const spec = plan.nodes[parallel.nodeId]?.parallel;
        expect(spec !== undefined, `plan state ${parallel.nodeId} is not a parallel state`);
        let room = spec.concurrency - branchesOf(parallel).length;
        while (room > 0 && parallel.nextIndex < parallel.total && !parallel.cancelled) {
            // A named branch starts at its own initial.
            state.cursors.push({ scopeId: branchScopeId(parallel.nodeExecutionId, parallel.nextIndex),
                nodeId: parallelBranchInitial(spec, parallel.nextIndex, parallel.total),
                predecessorId: parallel.nodeExecutionId, arrivalRoute: BRANCH_ROUTE, pending: null, deadlineMs: null });
            parallel.nextIndex += 1;
            room -= 1;
        }
    };
    /**
     * Join `parallel` once every branch ended: the join decides its node (joined or blocked) for its cursor to collect
     * (a join of every branch without a time limit).
     */
    const joinIfDone = function* (parallel: ControllerParallel): Generator<ScheduledTask, void, unknown> {
        if (parallel.results.length < parallel.total) return;
        yield* persistentlyTagged(ctx, R.join, { runId: input.runId, parallelNodeExecutionId: parallel.nodeExecutionId, results: parallel.results });
        state.parallels = parallels().filter(item => item !== parallel);
    };
    /**
     * Whether the store decides this parallel state's join (a join of the first k, or a state with its own time limit).
     * Review NB-R5: a named fork's join always: its verdict, the cut of its other branches and its own decision are
     * one store transaction. A For each keeps its recorded schedule.
     */
    const storeJoins = (parallel: ControllerParallel): boolean => {
        const spec = plan.nodes[parallel.nodeId]?.parallel;
        return spec !== undefined && (spec.first !== undefined || spec.timeLimit === true || spec.branches !== undefined);
    };
    /** Node executions whose branches a cancellation dropped in this pass (their results go nowhere). */
    const dropped = new Set<string>();
    const owedCuts = (): ControllerOwedCut[] => state.owedCuts ?? [];
    /** Record the branches of `scopeIds` whose stop or end is still owed (J1d), each once; none owed clears them. */
    const owe = (scopeIds: readonly string[], reason: BranchCancelReason, tried: readonly string[] = scopeIds): void => {
        const kept = owedCuts().filter(item => !tried.includes(item.scopeId));
        const added = scopeIds.filter(scopeId => !kept.some(item => item.scopeId === scopeId)).map(scopeId => ({ scopeId, reason }));
        const next = [...kept, ...added];
        if (next.length > 0) state.owedCuts = next;
        else delete state.owedCuts;
    };
    /**
     * Cut the branches of `scopeIds` (review J1C-1 and J1d): the store decides their pending work cancelled for `reason`
     * (failFast when absent), which is retried until it is stored, as before. Then
     * every effect is asked to stop and every agent child is ended, each once: one that could not be is owed, and the
     * controller goes on at once (retryOwedCuts tries it again; a run's end ends every owed child). The controller no
     * longer waits, for up to half an hour, for a child that cannot be ended.
     */
    const cutWork = function* (scopeIds: string[], reason?: Exclude<BranchCancelReason, "failFast">): Generator<ScheduledTask, void, unknown> {
        const answer = parseBranchCancel(yield* persistentlyTagged(ctx, R.cancelBranches, { runId: input.runId, scopeIds, ...(reason ? { reason } : {}) }));
        if (answer.owedScopeIds.length > 0) {
            ctx.traceWarn(`[workflow] run=${input.runId} cut branches ${answer.owedScopeIds.join(", ")} still owe a stop or an end; tried again later`);
        }
        owe(answer.owedScopeIds, reason ?? "failFast", scopeIds);
    };
    /**
     * Try the owed stops and ends of cut branches again (J1d), at most once per backstop period, active, stopping or paused:
     * one store attempt per reason (its short retries), never more. What is still owed stays owed; a failure is traced, and
     * the controller goes on (the store already decided their work; nothing of theirs is routed). Every pass of the loop
     * asks (review J1d-R1, J1e), so a run that always has a ready result, or continues as new, still tries them; with
     * nothing owed it yields nothing, so a history without owed cuts replays as recorded.
     */
    const retryOwedCuts = function* (): Generator<ScheduledTask, void, unknown> {
        if (owedCuts().length === 0) return;
        const current = parseNow(yield ctx.utcNow());
        if (owedTriedAtMs !== null && current - owedTriedAtMs < plan.wakeBackstopMs) return;
        owedTriedAtMs = current;
        for (const reason of ["failFast", "join", "timeout"] as const) {
            const scopeIds = owedCuts().filter(item => item.reason === reason).map(item => item.scopeId);
            if (scopeIds.length === 0) continue;
            try {
                const answer = parseBranchCancel(yield* storeTagged(ctx, R.cancelBranches, { runId: input.runId, scopeIds, ...(reason !== "failFast" ? { reason } : {}) }));
                owe(answer.owedScopeIds, reason, scopeIds);
            } catch (error) {
                ctx.traceWarn(`[workflow] run=${input.runId} the owed stops and ends of cut branches were not tried yet: ${workflowErrorMessage(error)}`);
            }
        }
    };
    /**
     * Cancel the branches of `parallel` that still run (their pending work is decided cancelled for `reason`; failFast
     * when absent) and record the queued ones not started: their cursors are
     * dropped, and their results go nowhere.
     */
    const cutBranches = function* (parallel: ControllerParallel, reason?: Exclude<BranchCancelReason, "failFast">): Generator<ScheduledTask, void, unknown> {
        parallel.cancelled = true;
        const others = branchesOf(parallel);
        if (others.length > 0) yield* cutWork(others.map(item => item.scopeId), reason);
        for (const other of others) {
            parallel.results.push({ index: parseBranchScope(other.scopeId)!.index, nodeExecutionId: other.pending, via: "cancelled" });
            if (other.pending !== null) dropped.add(other.pending);
        }
        state.cursors = state.cursors.filter(item => !others.includes(item));
        closeBranches(parallel);
    };
    /** Start no queued branch of `parallel` any more: each is recorded not started. */
    const closeBranches = (parallel: ControllerParallel): void => {
        parallel.cancelled = true;
        for (let index = parallel.nextIndex; index < parallel.total; index += 1) parallel.results.push({ index, nodeExecutionId: null, via: "not_started" });
        parallel.nextIndex = parallel.total;
    };
    /**
     * Ask the store to decide `parallel`'s join (its one count of the successes committed, admitted or not, by the
     * state's time limit; formal finding H1). Decided (now, or before by its time limit): the branches still running are
     * cut for the reason the decision gives (PJ-C3), and the state's own cursor collects its result. Otherwise nothing
     * changes here: its winners' terminals are still to be admitted, or its branches still run.
     */
    const askJoin = function* (parallel: ControllerParallel): Generator<ScheduledTask, boolean, unknown> {
        const answer = parseJoinAnswer(yield* persistentlyTagged(ctx, R.join,
            { runId: input.runId, parallelNodeExecutionId: parallel.nodeExecutionId, results: parallel.results }));
        if (!answer.decided) return false;
        yield* cutBranches(parallel, answer.cut === "failFast" ? undefined : answer.cut);
        state.parallels = parallels().filter(item => item !== parallel);
        const own = state.cursors.find(item => item.pending === parallel.nodeExecutionId);
        if (own !== undefined) own.deadlineMs = null;
        return true;
    };
    /** The running parallel state that a branch cursor belongs to. */
    const parallelOf = (cursor: ControllerCursor): ControllerParallel => {
        const scope = parseBranchScope(cursor.scopeId);
        const parallel = scope === null ? undefined : parallels().find(item => item.nodeExecutionId === scope.parallelNodeExecutionId);
        expect(parallel !== undefined, `cursor ${cursor.scopeId} is not a running branch`);
        return parallel;
    };
    /**
     * A branch ended (at its terminal, by an error no route takes, or cut by its state's time limit or decision, or
     * refused before its first state): record how, drop its cursor, then decide. A join of every branch without a time
     * limit: cancel the others when it did not succeed under failFast, start the next ones, and join when all ended. A
     * join of the first k or a time limit: the store decides the join (askJoin); until it does, the next
     * ones start.
     */
    const endBranch = function* (cursor: ControllerCursor, via: "terminal" | "error" | "cancelled" | "not_started", nodeExecutionId: string | null,
        succeeded: boolean): Generator<ScheduledTask, void, unknown> {
        const parallel = parallelOf(cursor);
        const index = parseBranchScope(cursor.scopeId)!.index;
        state.cursors = state.cursors.filter(item => item !== cursor);
        parallel.results.push({ index, nodeExecutionId, via });
        if (storeJoins(parallel)) {
            if (!(yield* askJoin(parallel)) && !parallel.cancelled) startBranches(parallel);
            return;
        }
        const spec = plan.nodes[parallel.nodeId]?.parallel;
        if (!succeeded && spec?.failFast === true && !parallel.cancelled) yield* cutBranches(parallel);
        else startBranches(parallel);
        yield* joinIfDone(parallel);
    };
    /**
     * The parallel states among `due` whose time limit the store found passed (not reported not due): each one's
     * timer has nothing left to do, and its join is asked (askJoin) after every due state was settled here, so a cut of
     * its branches never meets a cursor this pass still reads.
     */
    const askTimedJoins = function* (due: string[], notDue: Array<{ nodeExecutionId: string }>): Generator<ScheduledTask, void, unknown> {
        for (const nodeExecutionId of due) {
            if (notDue.some(wait => wait.nodeExecutionId === nodeExecutionId)) continue;
            const parallel = (state.parallels ?? []).find(item => item.nodeExecutionId === nodeExecutionId);
            if (parallel === undefined) continue;
            const own = state.cursors.find(cursor => cursor.pending === nodeExecutionId);
            if (own !== undefined) own.deadlineMs = null;
            yield* askJoin(parallel);
        }
    };
    /**
     * A branch cursor whose work its state's time limit or decision cut (that work's effect or child is asked to
     * stop, as at any cut: the store already decided the work), or that may admit nothing more: its branch ends.
     */
    const cutBranch = function* (cursor: ControllerCursor, nodeExecutionId: string | null): Generator<ScheduledTask, void, unknown> {
        const parallel = parallelOf(cursor);
        closeBranches(parallel);
        if (nodeExecutionId !== null) yield* cutWork([cursor.scopeId], "timeout");
        const first = nodeExecutionId === null && cursor.arrivalRoute === BRANCH_ROUTE && cursor.predecessorId === parallel.nodeExecutionId;
        yield* endBranch(cursor, first ? "not_started" : "cancelled", nodeExecutionId, false);
    };
    /**
     * One pass of the paused collector (1a; nothing is admitted and no result is routed until the resume). The
     * deadlines keep running (adversarial review RT-6 and its verification): the run's (D03), and each pending state's own.
     * A pending state past its deadline is elapsed now (the store's clock decides); a parallel state whose time limit
     * passed is asked for its join (askTimedJoins). An agent state decided while paused (its typed completion, or its
     * deadline) is collected now and its child is ended now; its result is routed after the resume, as any other. Until its
     * child's end is recorded the state is collected again at each wake (at most a backstop period apart), so a failed end
     * is tried again while paused. The paused timer wakes at the nearest deadline. A refused admission finds the pause
     * (`seen` null: the pass collects the agent states), or, review R2-RT-1, a collection does, also when every cursor waits
     * on work and no admission is tried: `seen` is what it collected, which this pass takes instead of collecting again.
     * Returns the controller's result when the run ended (or its controller continued as new), else null.
     */
    const pausedPass = function* (seen: CollectedResult[] | null): Generator<ScheduledTask, { result: ControllerResult | null } | null, unknown> {
        publishStatus(ctx, input, plan, state, "waiting");
        // J1d: the owed stops and ends of cut branches are tried again while paused too, at the top of each pass (J1e).
        let pausedTimerMs = plan.wakeBackstopMs;
        const realAgent = (nodeId: string): boolean => plan.nodes[nodeId]?.type === "agent" && (plan.test !== true || plan.realAgents === true);
        if (seen !== null) {
            // A state the collection found decided has no deadline left to decide; an agent state's is cleared below, once
            // its child's end is recorded.
            for (const result of seen) {
                const owner = state.cursors.find(cursor => cursor.pending === result.nodeExecutionId);
                if (owner !== undefined && !realAgent(owner.nodeId)) owner.deadlineMs = null;
            }
        }
        const pendingAgents = state.cursors.flatMap(cursor => cursor.pending !== null && realAgent(cursor.nodeId) && !pausedEnded.has(cursor.pending)
            ? [cursor.pending] : []);
        if (pendingAgents.length > 0) {
            let decided: CollectedResult[];
            if (seen !== null) decided = seen.filter(result => pendingAgents.includes(result.nodeExecutionId));
            else {
                // A stop is seen by the next admission or collection; only the results and the run's own deadline matter here.
                const collection = parseCollectedWithStop(yield* storeTagged(ctx, R.collect, { runId: input.runId, nodeExecutionIds: pendingAgents }));
                if (collection.ended) return { result: yield* endedElsewhere(ctx, input.runId) };
                if (collection.expired) {
                    const expired = yield* expireRun();
                    return expired !== null ? { result: expired } : null;
                }
                decided = collection.collected;
            }
            for (const result of decided) {
                try {
                    yield* storeTagged(ctx, R.endAgent, { runId: input.runId, nodeExecutionId: result.nodeExecutionId });
                } catch (error) {
                    ctx.traceWarn(`[workflow] run=${input.runId} the child of ${result.nodeExecutionId} was not ended yet: ${workflowErrorMessage(error)}`);
                    continue;
                }
                pausedEnded.add(result.nodeExecutionId);
                // Its end is recorded: its deadline has nothing left to decide.
                const owner = state.cursors.find(cursor => cursor.pending === result.nodeExecutionId);
                if (owner !== undefined) owner.deadlineMs = null;
            }
        }
        const nodeDeadlines = state.cursors.flatMap(cursor => cursor.pending !== null && cursor.deadlineMs !== null
            ? [{ nodeExecutionId: cursor.pending, deadlineMs: cursor.deadlineMs }] : []);
        if (runDeadlineMs !== null || nodeDeadlines.length > 0) {
            const current = parseNow(yield ctx.utcNow());
            if (runDeadlineMs !== null && current >= runDeadlineMs) {
                const expired = yield* expireRun();
                return expired !== null ? { result: expired } : null;
            }
            const due = nodeDeadlines.filter(wait => wait.deadlineMs <= current).map(wait => wait.nodeExecutionId);
            if (due.length > 0) {
                const notDue = parseElapse(yield* storeTagged(ctx, R.elapse, { runId: input.runId, nodeExecutionIds: due }));
                const reported = notDue.length > 0 ? parseNow(yield ctx.utcNow()) : current;
                for (const nodeExecutionId of due) {
                    const owner = state.cursors.find(cursor => cursor.pending === nodeExecutionId);
                    expect(owner !== undefined, `elapsed ${nodeExecutionId} is not pending`);
                    const later = notDue.find(wait => wait.nodeExecutionId === nodeExecutionId);
                    if (later) {
                        owner.deadlineMs = reported + later.remainingMs;
                        continue;
                    }
                    // Decided by its deadline: its result waits for the resume. An agent state's child is ended by the
                    // collection above, at once (the loop goes on), and again at each wake until its end is recorded.
                    owner.deadlineMs = null;
                }
                // Q2: a parallel state whose time limit passed is asked for its join now: its branches are cut at
                // once when the time limit decided it, and its join may be due; its route waits for the resume.
                yield* askTimedJoins(due, notDue);
                return null;
            }
            if (runDeadlineMs !== null) pausedTimerMs = Math.min(pausedTimerMs, runDeadlineMs - current);
            for (const wait of nodeDeadlines) pausedTimerMs = Math.min(pausedTimerMs, wait.deadlineMs - current);
            pausedTimerMs = Math.max(1, pausedTimerMs);
        }
        const raced = parseRace(yield ctx.race(ctx.dequeueEvent(WORKFLOW_COMMAND_QUEUE), ctx.scheduleTimer(pausedTimerMs)));
        if (raced.index === 0) {
            const command = parseWorkflowCommand(raced.value);
            if (command) return { result: yield* applyCommand(ctx, input, command) };
        }
        idleWaits += 1;
        if (idleWaits >= WORKFLOW_IDLE_WAITS_PER_EXECUTION) return { result: yield* continueAsNew() };
        return null;
    };

    for (;;) {
        // 0. Commands first.
        if (state.cursors.some(cursor => cursor.pending === null)) {
            const command = yield* takeQueuedCommand(ctx);
            if (command) return yield* applyCommand(ctx, input, command);
        }
        // 0a. The owed stops and ends of cut branches (J1d), at most once per backstop period: every pass comes here (a pass
        // with ready results, a reroute, a paused or stopping pass, an idle wait's wake), and the first pass of an execution
        // after continue-as-new tries them at once (review J1d-R1, J1e).
        yield* retryOwedCuts();

        // 1. Admit the next node of every cursor that is not waiting on work (none while the run is stopping). A branch's
        // end may add or drop cursors: this pass goes over the cursors it started with that are still there.
        // Invariant (duroxide issue 78, microsoft/duroxide#78): duroxide does not start the detached orchestrations started in
        // a turn that ends in continue-as-new (its ContinueAsNew branch does not enqueue them). Every detached start below (an
        // effect, a send, a request or an agent helper) is followed by a store activity before any continueAsNew: the next
        // cursor's enter, or this pass's collection (step 2), which every continueAsNew of this loop follows. So a helper is
        // always started in a turn that does not continue as new. Keep it so when this loop changes.
        let rerouted = false;
        let paused = false;
        dropped.clear();
        for (const cursor of [...state.cursors]) {
            if (cursor.pending !== null || stopping !== null || !state.cursors.includes(cursor)) continue;
            const node: ControllerPlan["nodes"][string] | undefined = plan.nodes[cursor.nodeId];
            expect(node !== undefined, `plan has no state ${cursor.nodeId}`);
            if (state.steps >= plan.maxNodeExecutions) {
                // Review R2-RT-1: the limit ends the run where it would admit, so a run read now as past its deadline,
                // stopping or paused is not ended by it here (an admission's order); a paused one at its limit ends after the resume.
                const seen = parseCollectedWithStop(yield* storeTagged(ctx, R.collect, { runId: input.runId, nodeExecutionIds: [] }));
                if (seen.ended) return yield* endedElsewhere(ctx, input.runId);
                if (seen.expired) {
                    const expired = yield* expireRun();
                    if (expired !== null) return expired;
                    break;
                }
                if (seen.stopping !== null) { stopping = seen.stopping; break; }
                if (seen.paused) { paused = true; break; }
                return yield* finishRun(ctx, input.runId, { failure: {
                    nodeId: cursor.nodeId, nodeExecutionId: null, code: "limit_exceeded",
                    message: `The run reached its limit of ${plan.maxNodeExecutions} node executions.`,
                } });
            }
            const key = `${cursor.scopeId}/${cursor.nodeId}`;
            const ordinal = (state.ordinals[key] ?? 0) + 1;
            publishStatus(ctx, input, plan, state, "running");
            const entered = parseEnter(yield* storeTagged(ctx, R.enter, {
                runId: input.runId, scopeId: cursor.scopeId, nodeId: cursor.nodeId, ordinal,
                predecessorId: cursor.predecessorId, arrivalRoute: cursor.arrivalRoute,
            }));
            if (!entered.admitted) {
                // A branch whose parallel state was decided, or whose time limit passed (by the store's clock or a test
                // run's), admits nothing more but its terminal: the branch ends, no queued branch starts, and the join is asked.
                if (entered.cut) {
                    yield* cutBranch(cursor, null);
                    rerouted = true;
                    continue;
                }
                // A run past its deadline admits nothing (stopping, paused or not): the store ends it, or reports the time left.
                if (entered.expired) {
                    const expired = yield* expireRun();
                    if (expired !== null) return expired;
                    break;
                }
                // A stopping run admits nothing (paused or not); its admitted work settles below.
                if (entered.stopping !== null) { stopping = entered.stopping; break; }
                if (entered.status === "paused") { paused = true; break; }
                // Another end decided the run (an accepted cancel or done, a deletion): its post-end work (S7-DX2).
                return yield* endedElsewhere(ctx, input.runId);
            }
            state.ordinals[key] = ordinal;
            state.steps += 1;
            admittedThisExecution += 1;
            if (cursor.nodeId === plan.catchAll) state.catchAllEntered = true;
            // A branch's terminal ends its branch (its output, checked against its own schema, is its result), not the run.
            if (node.type === "terminal" && cursor.scopeId !== ROOT_SCOPE) {
                const ended = record(yield* persistentlyTagged(ctx, R.endBranch, { runId: input.runId, nodeExecutionId: entered.nodeExecutionId }), "branch end");
                yield* endBranch(cursor, "terminal", entered.nodeExecutionId, ended.succeeded === true);
                rerouted = true;
                continue;
            }
            if (node.type === "terminal") {
                const catchAll = !state.catchAllEntered ? plan.catchAll : null;
                const finished = parseTerminalFinish(yield* persistentlyTagged(ctx, R.finish, {
                    runId: input.runId, terminalNodeExecutionId: entered.nodeExecutionId, ...(catchAll !== null ? { routeOutputErrors: true } : {}),
                }));
                if (!finished.routed) {
                    // S7-DX3 (N-1): another writer ended the run before this finish: its end is reconciled.
                    if (finished.elsewhere) return yield* endedElsewhere(ctx, input.runId);
                    return yield* reportEnded(ctx, input.runId, finished.result);
                }
                expect(catchAll !== null && finished.nodeExecutionId === entered.nodeExecutionId, "finish routed an output error the controller did not offer");
                state.catchAllEntered = true;
                cursor.nodeId = catchAll;
                cursor.predecessorId = entered.nodeExecutionId;
                cursor.arrivalRoute = CATCH_ALL_ROUTE;
                rerouted = true;
                continue;
            }
            cursor.pending = entered.nodeExecutionId;
            if (node.type === "wait") {
                cursor.deadlineMs = entered.state === "pending" ? entered.deadlineMs : null;
                expect(entered.state !== "pending" || cursor.deadlineMs !== null, `wait ${entered.nodeExecutionId} has no deadline`);
                continue;
            }
            if (node.type === "messaging") {
                cursor.deadlineMs = entered.state === "pending" ? entered.deadlineMs : null;
                // A test run intercepts a send's delivery and a request's exchange (migration 0088): its parent, or a fixture,
                // answers the interception, and a request's deadline runs on the run's virtual clock.
                if (plan.test === true && node.mode !== "receive" && entered.state === "pending") {
                    yield* persistentlyTagged(ctx, R.intercept, { runId: input.runId, nodeExecutionId: entered.nodeExecutionId });
                    continue;
                }
                if (node.mode === "send" && entered.state === "pending") {
                    yield ctx.startOrchestrationVersioned(WORKFLOW_SEND_NAME, WORKFLOW_SEND_VERSION,
                        workflowSendInstanceId(entered.nodeExecutionId),
                        { runId: input.runId, nodeExecutionId: entered.nodeExecutionId, controllerInstanceId: ctx.instanceId });
                }
                // A request waits for its response, decided in the response's own transaction, until its deadline.
                if (node.mode === "request" && entered.state === "pending") {
                    expect(cursor.deadlineMs !== null, `request ${entered.nodeExecutionId} has no deadline`);
                    yield ctx.startOrchestrationVersioned(WORKFLOW_REQUEST_NAME, WORKFLOW_REQUEST_VERSION,
                        workflowRequestInstanceId(entered.nodeExecutionId),
                        { runId: input.runId, nodeExecutionId: entered.nodeExecutionId, controllerInstanceId: ctx.instanceId });
                }
                continue;
            }
            // A parallel state waits for its join: its branches run as cursors of their own, at most its concurrency at
            // a time; each starts at the body's initial state with its manifest item. Its own time limit is a deadline on
            // this controller's timers, as a wait's (the store's clock decides it); a join of the first k that has fewer than k
            // items starts no branch and the store blocks it at once.
            if (node.type === "parallel") {
                cursor.deadlineMs = entered.state === "pending" ? entered.deadlineMs : null;
                if (entered.state === "pending" && !parallels().some(item => item.nodeExecutionId === entered.nodeExecutionId)) {
                    expect(entered.branches !== null, `parallel ${entered.nodeExecutionId} reported no branches`);
                    const first = node.parallel?.first;
                    const parallel: ControllerParallel = { nodeExecutionId: entered.nodeExecutionId, nodeId: cursor.nodeId, total: entered.branches,
                        nextIndex: 0, results: [], cancelled: false };
                    parallels().push(parallel);
                    if (storeJoins(parallel)) {
                        if (first !== undefined && first > parallel.total) closeBranches(parallel);
                        else startBranches(parallel);
                        if (parallel.results.length >= parallel.total) yield* askJoin(parallel);
                    } else {
                        startBranches(parallel);
                        yield* joinIfDone(parallel);
                    }
                    rerouted = true;
                }
                continue;
            }
            // An agent state waits for its child's typed completion, decided in the completion's own transaction,
            // until its outer deadline on this controller's timers, as a request does. Its agent orchestration creates the
            // child, and wakes this controller only when the state fails there.
            if (node.type === "agent") {
                cursor.deadlineMs = entered.state === "pending" ? entered.deadlineMs : null;
                if (entered.state === "pending") {
                    expect(cursor.deadlineMs !== null, `agent state ${entered.nodeExecutionId} has no deadline`);
                    // A test run's agent is mocked (migration 0088): no child is created; its parent, or a fixture, answers.
                    // A real-agent test run's agent state gets its child as a live run's does (migration 0088).
                    if (plan.test === true && plan.realAgents !== true) {
                        yield* persistentlyTagged(ctx, R.intercept, { runId: input.runId, nodeExecutionId: entered.nodeExecutionId });
                        continue;
                    }
                    yield ctx.startOrchestrationVersioned(WORKFLOW_AGENT_NAME, WORKFLOW_AGENT_VERSION,
                        workflowAgentInstanceId(entered.nodeExecutionId),
                        { runId: input.runId, nodeExecutionId: entered.nodeExecutionId, controllerInstanceId: ctx.instanceId });
                }
                continue;
            }
            if (entered.state === "pending") {
                yield ctx.startOrchestrationVersioned(WORKFLOW_EFFECT_NAME, WORKFLOW_EFFECT_VERSION,
                    workflowEffectInstanceId(entered.nodeExecutionId),
                    { runId: input.runId, nodeExecutionId: entered.nodeExecutionId, controllerInstanceId: ctx.instanceId });
            }
        }
        if (rerouted) continue;

        // 1a. Paused, found by a refused admission: the paused collector (pausedPass) collects its agent states.
        if (paused) {
            const passed = yield* pausedPass(null);
            if (passed !== null) return passed.result;
            continue;
        }

        // 2. Elapse the due waits and requests (the store's clock decides), observe the waiting requests' responders once
        // per backstop period, then route every pending node execution that has a stored result.
        const waits = () => state.cursors.flatMap(cursor => cursor.pending !== null && cursor.deadlineMs !== null
            ? [{ nodeExecutionId: cursor.pending, deadlineMs: cursor.deadlineMs }] : []);
        let now: number | null = null;
        if (waits().length > 0) {
            const current = parseNow(yield ctx.utcNow());
            now = current;
            const due = waits().filter(wait => wait.deadlineMs <= current).map(wait => wait.nodeExecutionId);
            if (due.length > 0) {
                const notDue = parseElapse(yield* storeTagged(ctx, R.elapse, { runId: input.runId, nodeExecutionIds: due }));
                if (notDue.length > 0) {
                    const reported = parseNow(yield ctx.utcNow());
                    now = reported;
                    for (const wait of notDue) {
                        const owner = state.cursors.find(cursor => cursor.pending === wait.nodeExecutionId);
                        expect(owner !== undefined && due.includes(wait.nodeExecutionId), `elapse reported ${wait.nodeExecutionId}, which it was not asked about`);
                        owner.deadlineMs = reported + wait.remainingMs;
                    }
                }
                // A parallel state whose time limit passed is asked for its join before any result is collected, so a
                // decision cuts its branches first (PJ-C5), and a join that is due waits for its winners' terminals.
                yield* askTimedJoins(due, notDue);
            }
            // A test run's requests are intercepted: no responder is observed.
            const requests = plan.test === true ? []
                : state.cursors.flatMap(cursor => cursor.pending !== null && plan.nodes[cursor.nodeId]?.mode === "request" ? [cursor.pending] : []);
            if (requests.length > 0 && (observedAtMs === null || now - observedAtMs >= plan.wakeBackstopMs)) {
                yield* storeTagged(ctx, R.observe, { runId: input.runId, nodeExecutionIds: requests });
                observedAtMs = now;
            }
        }
        const pendingIds = state.cursors.flatMap(cursor => cursor.pending === null ? [] : [cursor.pending]);
        const collection = parseCollectedWithStop(yield* storeTagged(ctx, R.collect, { runId: input.runId, nodeExecutionIds: pendingIds }));
        // S7-DX2: a run that another transaction ended (an accepted cancel or done, a deletion) routes none of its results.
        if (collection.ended) return yield* endedElsewhere(ctx, input.runId);
        // A run past its deadline (read after the results): the store ends it before any of them is routed.
        if (collection.expired) {
            const expired = yield* expireRun();
            if (expired !== null) return expired;
        }
        const collected = collection.collected;
        if (stopping === null) stopping = collection.stopping;
        // Review R2-RT-1: a paused run, read with these results (after them), routes none of them, whether or not an
        // admission found the pause (when every cursor waits on work, none is tried): no branch ends, no failFast cancels,
        // no join is asked, no run ends, until the resume. Its deadlines still decide (above, and on the paused collector's
        // timer), and a parallel state its time limit decided still has its branches cut (below). A stopping run's results
        // settle instead (2a): a stop goes before a pause, as at an admission.
        const pausedNow = stopping === null && collection.paused;
        // An agent state's child is ended once its state is decided (done after its typed completion, cancel after
        // anything else), before the result goes anywhere.
        // A child that could not be ended now is ended when the run ends (afterEnd); its result is routed either way. While
        // paused, the paused collector ends it, and tries a failed end again until it is recorded.
        for (const result of pausedNow ? [] : collected) {
            const owner = state.cursors.find(item => item.pending === result.nodeExecutionId);
            // A test run's mocked agents have no child to end; a real-agent test run's children are ended as a live run's are.
            if (owner !== undefined && plan.nodes[owner.nodeId]?.type === "agent" && (plan.test !== true || plan.realAgents === true)) {
                try {
                    yield* storeTagged(ctx, R.endAgent, { runId: input.runId, nodeExecutionId: result.nodeExecutionId });
                } catch (error) {
                    ctx.traceWarn(`[workflow] run=${input.runId} the child of ${result.nodeExecutionId} was not ended yet: ${workflowErrorMessage(error)}`);
                }
            }
        }
        // A parallel state decided while its branches still run (its own time limit by a test run's clock, which no
        // elapse here reported) has its branches cut now: their pending work is cancelled with their effects and children,
        // and no result of theirs is routed. Only its time limit decides a state so (timed_out, or blocked); a join, and a
        // time limit this controller elapsed, remove the state's branches first (askJoin).
        dropped.clear();
        for (const result of collected) {
            const parallel = (state.parallels ?? []).find(item => item.nodeExecutionId === result.nodeExecutionId);
            if (parallel === undefined) continue;
            yield* cutBranches(parallel, result.outcome === PARALLEL_JOINED ? "join" : "timeout");
            state.parallels = parallels().filter(item => item !== parallel);
        }
        if (pausedNow) {
            const passed = yield* pausedPass(collected);
            if (passed !== null) return passed.result;
            continue;
        }
        if (stopping !== null) {
            // 2a. Stopping: a result settles its cursor, which goes nowhere (its result is stored and kept). When no work is
            // pending, or at the stop's deadline, the stop activity asks the store to end the run (its clock decides the
            // deadline, and it cancels what is still pending then); before that it reports the time left.
            for (const result of collected) {
                const owner = state.cursors.find(item => item.pending === result.nodeExecutionId);
                if (owner === undefined && dropped.has(result.nodeExecutionId)) continue;
                expect(owner !== undefined, `collected ${result.nodeExecutionId} is not pending`);
                owner.pending = null;
                owner.deadlineMs = null;
            }
            const current = now ?? parseNow(yield ctx.utcNow());
            now = current;
            // A parallel state waits on its branches, not on work of its own.
            if (!state.cursors.some(cursor => cursor.pending !== null && plan.nodes[cursor.nodeId]?.type !== "parallel") || current >= stopping.deadlineMs) {
                const finished = parseStopFinish(yield* persistentlyTagged(ctx, R.stop, { runId: input.runId }));
                if (finished.ended) {
                    // Another end decided the run first (a cancel, a deletion): it is done, as when an admission finds it so.
                    if (finished.result.status !== "stopped") return yield* endedElsewhere(ctx, input.runId);
                    return yield* reportEnded(ctx, input.runId, finished.result);
                }
                const read = parseNow(yield ctx.utcNow());
                now = read;
                stopping = { deadlineMs: read + finished.remainingMs };
            }
        } else if (collected.length > 0) {
            for (const result of collected) {
                const owner = state.cursors.find(item => item.pending === result.nodeExecutionId);
                // A branch a cancellation dropped in this pass: its result goes nowhere (the join, or the time limit's report, says so).
                if (owner === undefined && dropped.has(result.nodeExecutionId)) continue;
                expect(owner !== undefined, `collected ${result.nodeExecutionId} is not pending`);
                const next = plan.nodes[owner.nodeId].next;
                const route = selectRoute(next, result);
                // In a branch: its routes stay in its body; an error no route takes ends the branch (not the run, and never at
                // the workflow's catch-all state). Work its parallel state's time limit cancelled before the state was
                // decided (its join is due) goes nowhere: the branch ends.
                if (owner.scopeId !== ROOT_SCOPE) {
                    if (result.cut === true) {
                        yield* cutBranch(owner, result.nodeExecutionId);
                        continue;
                    }
                    if (route === null) {
                        yield* endBranch(owner, "error", result.nodeExecutionId, false);
                        continue;
                    }
                    owner.nodeId = next[route];
                    owner.arrivalRoute = route;
                    owner.predecessorId = result.nodeExecutionId;
                    owner.pending = null;
                    owner.deadlineMs = null;
                    continue;
                }
                let target: { nodeId: string; arrivalRoute: string } | null = null;
                if (route !== null) target = { nodeId: next[route], arrivalRoute: route };
                else if (result.resultKind === "runtime_error" && plan.catchAll !== null && !state.catchAllEntered) {
                    target = { nodeId: plan.catchAll, arrivalRoute: CATCH_ALL_ROUTE };
                }
                if (target === null) {
                    const handled = plan.catchAll !== null && result.resultKind === "runtime_error" ? " The workflow's catch-all state already ran in this run." : "";
                    return yield* finishRun(ctx, input.runId, { failure: {
                        nodeId: owner.nodeId, nodeExecutionId: result.nodeExecutionId, code: result.outcome,
                        message: `State '${owner.nodeId}' ended with ${result.resultKind === "business" ? "undeclared outcome" : "runtime error"} '${result.outcome}' and has no route for it.${handled}`,
                    } });
                }
                if (target.nodeId === plan.catchAll) {
                    if (state.catchAllEntered) {
                        return yield* finishRun(ctx, input.runId, { failure: {
                            nodeId: owner.nodeId, nodeExecutionId: result.nodeExecutionId, code: result.outcome,
                            message: `State '${owner.nodeId}' ended with ${result.resultKind === "business" ? "outcome" : "runtime error"} '${result.outcome}'; `
                                + `its route '${target.arrivalRoute}' leads to the catch-all state '${plan.catchAll}', which already ran in this run.`,
                        } });
                    }
                    state.catchAllEntered = true;
                }
                owner.nodeId = target.nodeId;
                owner.arrivalRoute = target.arrivalRoute;
                owner.predecessorId = result.nodeExecutionId;
                owner.pending = null;
                owner.deadlineMs = null;
            }
            if (admittedThisExecution >= WORKFLOW_ADMISSIONS_PER_EXECUTION) return yield* continueAsNew();
            continue;
        }

        // 3. Nothing is ready: wait for a wake (a response's included), a lifecycle command or the nearest deadline (a
        // stopping run's stop deadline included). The wait is at most a backstop period, so the next pass (0a) tries the
        // owed stops and ends of cut branches about that often.
        publishStatus(ctx, input, plan, state, "running");
        const deadlines = waits().map(wait => wait.deadlineMs);
        if (stopping !== null) deadlines.push(stopping.deadlineMs);
        // The run's deadline: past it by this clock, the store decides (its clock may not have reached it yet).
        if (runDeadlineMs !== null) {
            const current = now ?? parseNow(yield ctx.utcNow());
            now = current;
            if (current >= runDeadlineMs) {
                const expired = yield* expireRun();
                if (expired !== null) return expired;
                continue;
            }
            deadlines.push(runDeadlineMs);
        }
        const nearest = now === null || deadlines.length === 0 ? null : Math.min(...deadlines) - now;
        const timerMs = nearest === null ? plan.wakeBackstopMs : Math.max(1, Math.min(plan.wakeBackstopMs, nearest));
        const raced = parseRace(yield ctx.race(ctx.dequeueEvent(WORKFLOW_COMMAND_QUEUE), ctx.scheduleTimer(timerMs)));
        // A command is applied first, so a continue-as-new never drops one it dequeued. Any other wait, the timer or a wake
        // (a hint: the next pass collects what it was for, from the store), is an idle wait, as the paused pass counts it, so
        // a run whose work all waits continues as new under a steady stream of wakes too (V-2 diagnosis, 2026-11-08).
        if (raced.index === 0) {
            const command = parseWorkflowCommand(raced.value);
            if (command) return yield* applyCommand(ctx, input, command);
        }
        idleWaits += 1;
        if (idleWaits >= WORKFLOW_IDLE_WAITS_PER_EXECUTION) return yield* continueAsNew();
    }
}
