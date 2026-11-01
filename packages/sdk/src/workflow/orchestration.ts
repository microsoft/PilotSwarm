import { WORKFLOW_WAIT_OUTCOME, type CompiledWorkflow, type WorkflowScriptState, type WorkflowTerminalOutcome } from "./compiler.js";
import {
    requireScriptResult,
    resolveTransition,
    terminalOutput,
    WORKFLOW_MAX_SCRIPT_RUNS_BETWEEN_WAITS,
    workflowSpinError,
} from "./executor.js";

export const WORKFLOW_SESSION_ORCHESTRATION_NAME = "workflow-session";
export const WORKFLOW_SESSION_LATEST_VERSION = "1.0.0";

/** State executions (script and wait) per orchestration execution before continue-as-new bounds history. */
export const WORKFLOW_STEPS_PER_EXECUTION = 20;

export const WORKFLOW_ACTIVITIES = {
    begin: "workflow.begin",
    runScript: "workflow.runScript",
    wait: "workflow.wait",
    finish: "workflow.finish",
} as const;

export interface WorkflowResumePoint {
    workflow: CompiledWorkflow;
    stateId: string;
    priorOutput: unknown;
    step: number;
    /** The latest output of each state that ran, for terminal `output` templates. */
    results: Record<string, unknown>;
    /** Script states run since the last wait (the spin limit counts these). */
    sinceWait?: number;
    /** How many times each state has run, for the views' loop counters. */
    visits?: Record<string, number>;
}

export interface WorkflowOrchestrationInput {
    sessionId: string;
    yaml: string;
    inputs: Record<string, unknown>;
    parentSessionId?: string;
    /** Wake the parent session with the result when the workflow ends. Default true for children. */
    notifyParent?: boolean;
    /** Set only by continue-as-new. */
    resume?: WorkflowResumePoint;
    /** Internal (tests): script runs allowed between waits. Default WORKFLOW_MAX_SCRIPT_RUNS_BETWEEN_WAITS. */
    maxScriptRunsBetweenWaits?: number;
}

export interface WorkflowBeginResult {
    workflow: CompiledWorkflow;
}

export interface WorkflowRunStateInput {
    sessionId: string;
    workflowName: string;
    stateId: string;
    node: WorkflowScriptState;
    inputs: Record<string, unknown>;
    priorOutput: unknown;
    step: number;
    /** This state's run count, this one included. */
    visit?: number;
}

export interface WorkflowWaitInput {
    sessionId: string;
    workflowName: string;
    stateId: string;
    step: number;
    seconds: number;
    /** When the wait ends, in epoch milliseconds (orchestration time). */
    until: number;
    visit: number;
}

export interface WorkflowRunStateResult {
    outcome: string;
    output: unknown;
}

/**
 * How a workflow run ended, as the session status. A run that reaches a
 * terminal state ends `completed`, `failed` or `cancelled` by that state's
 * outcome (`succeeded` and `blocked` are `completed`). A run stopped by a
 * command ends `cancelled`; "deleted" also removes the session.
 */
export type WorkflowEndStatus = "completed" | "failed" | "cancelled" | "deleted";

/** The command queue every session listens on; management and parents send `{ type: "cmd" }` here. */
export const WORKFLOW_COMMAND_QUEUE = "messages";

export interface WorkflowFinishInput {
    sessionId: string;
    parentSessionId?: string;
    notifyParent: boolean;
    workflowName: string | null;
    status: WorkflowEndStatus;
    /** The terminal state's outcome, when the run reached one. */
    outcome?: WorkflowTerminalOutcome;
    summary?: string;
    output?: unknown;
    /** The terminal state reached, or the state that was running when the run stopped or failed. */
    stateId?: string;
    steps: number;
    error?: string;
    /** Why a cancelled or deleted run stopped, and which session asked. */
    reason?: string;
    requestedBy?: string;
}

export interface WorkflowRunResult {
    status: WorkflowEndStatus;
    workflowName: string | null;
    outcome?: WorkflowTerminalOutcome;
    summary?: string;
    output?: unknown;
    stateId?: string;
    steps: number;
    error?: string;
    reason?: string;
}

/** The custom status the client and portal read; `status` follows session status words. */
export interface WorkflowCustomStatus {
    status: "running" | "completed" | "failed" | "cancelled";
    sessionKind: "workflow";
    workflow: {
        name: string | null;
        stateId: string | null;
        step: number;
        /** Set while a wait state is waiting: when it ends, in epoch milliseconds. */
        waitingUntil?: number;
        outcome?: string;
        error?: string;
    };
}

/** The session status a terminal outcome ends the run with. */
export function workflowStatusForOutcome(outcome: WorkflowTerminalOutcome): "completed" | "failed" | "cancelled" {
    return outcome === "failed" ? "failed" : outcome === "cancelled" ? "cancelled" : "completed";
}

/** duroxide-node prefixes activity errors; the person reading the result needs only the cause. */
const ACTIVITY_ERROR_PREFIX = /^Activity '[^']+' JS execution failed: [A-Za-z]+, (?:[A-Za-z]*Error: )?/;

export function workflowErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(ACTIVITY_ERROR_PREFIX, "");
}

/** A lifecycle command read from the command queue, or null for anything else. */
export function parseWorkflowCommand(raw: unknown): { cmd: "cancel" | "done" | "delete"; reason?: string; requestedBy?: string } | null {
    let message: any = raw;
    if (typeof message === "string") {
        try { message = JSON.parse(message); } catch { return null; }
    }
    if (!message || typeof message !== "object" || message.type !== "cmd") return null;
    if (message.cmd !== "cancel" && message.cmd !== "done" && message.cmd !== "delete") return null;
    const reason = typeof message.args?.reason === "string" && message.args.reason.trim() ? message.args.reason.trim() : undefined;
    const requestedBy = typeof message.requestedBy === "string" && message.requestedBy ? message.requestedBy : undefined;
    return { cmd: message.cmd, ...(reason ? { reason } : {}), ...(requestedBy ? { requestedBy } : {}) };
}

function publish(ctx: any, status: WorkflowCustomStatus): void {
    ctx.setCustomStatus(JSON.stringify(status));
}

/**
 * Durable controller for one workflow session.
 *
 * Determinism: the compiled graph comes from an activity (so a compiler
 * change cannot alter a replay), each script state runs in an activity, and
 * the next state is chosen here from recorded results only. A wait state is
 * a durable timer raced against the command queue, so a cancel ends a run
 * that is waiting, and a restarted worker resumes the timer where it was.
 * History is bounded by continuing as new every WORKFLOW_STEPS_PER_EXECUTION
 * states, carrying the compiled graph, the current state, its input, the
 * results terminal templates may read and the loop counters.
 */
export function* workflowSessionOrchestration_1_0_0(
    ctx: any,
    input: WorkflowOrchestrationInput,
): Generator<any, WorkflowRunResult | null, any> {
    const notifyParent = Boolean(input.parentSessionId) && input.notifyParent !== false;
    let workflow: CompiledWorkflow | null = input.resume?.workflow ?? null;
    let stateId: string | null = input.resume?.stateId ?? null;
    let priorOutput: unknown = input.resume?.priorOutput ?? null;
    let step = input.resume?.step ?? 0;
    let sinceWait = input.resume?.sinceWait ?? 0;
    const results: Record<string, unknown> = { ...(input.resume?.results ?? {}) };
    const visits: Record<string, number> = { ...(input.resume?.visits ?? {}) };
    const spinLimit = input.maxScriptRunsBetweenWaits ?? WORKFLOW_MAX_SCRIPT_RUNS_BETWEEN_WAITS;

    const finish = function* (result: Omit<WorkflowFinishInput, "sessionId" | "parentSessionId" | "notifyParent">) {
        // The end is recorded first, so a reader that sees the final status
        // also finds the end event in the session's log.
        yield ctx.scheduleActivityTyped(WORKFLOW_ACTIVITIES.finish, {
            sessionId: input.sessionId,
            ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
            notifyParent,
            ...result,
        } satisfies WorkflowFinishInput);
        publish(ctx, {
            status: result.status === "deleted" ? "cancelled" : result.status,
            sessionKind: "workflow",
            workflow: {
                name: result.workflowName,
                stateId: result.stateId ?? stateId,
                step: result.steps,
                ...(result.outcome ? { outcome: result.outcome } : {}),
                ...(result.error ? { error: result.error } : {}),
                ...(result.reason ? { error: result.reason } : {}),
            },
        });
        const run: WorkflowRunResult = {
            status: result.status,
            workflowName: result.workflowName,
            steps: result.steps,
            ...(result.outcome !== undefined ? { outcome: result.outcome } : {}),
            ...(result.summary !== undefined ? { summary: result.summary } : {}),
            ...(Object.hasOwn(result, "output") ? { output: result.output } : {}),
            ...(result.stateId ? { stateId: result.stateId } : {}),
            ...(result.error ? { error: result.error } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
        };
        return run;
    };

    try {
        if (!workflow) {
            publish(ctx, { status: "running", sessionKind: "workflow", workflow: { name: null, stateId: null, step: 0 } });
            const begun: WorkflowBeginResult = yield ctx.scheduleActivityTyped(WORKFLOW_ACTIVITIES.begin, {
                sessionId: input.sessionId,
                yaml: input.yaml,
                inputs: input.inputs,
            });
            workflow = begun.workflow;
            stateId = workflow.initial;
        }

        let stepsThisExecution = 0;
        while (true) {
            const state = workflow.states[stateId!];
            if (!state) throw new Error(`Workflow entered unknown state '${stateId}'.`);

            if (state.type === "terminal") {
                const output = terminalOutput(workflow, state.id, input.inputs, results);
                return yield* finish({
                    workflowName: workflow.name,
                    status: workflowStatusForOutcome(state.outcome),
                    outcome: state.outcome,
                    summary: state.summary,
                    output,
                    stateId: state.id,
                    steps: step,
                });
            }

            if (stepsThisExecution >= WORKFLOW_STEPS_PER_EXECUTION) {
                yield ctx.continueAsNewVersioned({
                    sessionId: input.sessionId,
                    yaml: input.yaml,
                    inputs: input.inputs,
                    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
                    ...(input.notifyParent !== undefined ? { notifyParent: input.notifyParent } : {}),
                    ...(input.maxScriptRunsBetweenWaits !== undefined ? { maxScriptRunsBetweenWaits: input.maxScriptRunsBetweenWaits } : {}),
                    resume: { workflow, stateId: stateId!, priorOutput, step, results, sinceWait, visits },
                } satisfies WorkflowOrchestrationInput, WORKFLOW_SESSION_LATEST_VERSION);
                return null;
            }

            if (state.type === "wait") {
                step += 1;
                stepsThisExecution += 1;
                sinceWait = 0;
                visits[state.id] = (visits[state.id] ?? 0) + 1;
                const startedAt: number = yield ctx.utcNow();
                const until = startedAt + state.seconds * 1000;
                publish(ctx, { status: "running", sessionKind: "workflow", workflow: { name: workflow.name, stateId: state.id, step, waitingUntil: until } });
                yield ctx.scheduleActivityTyped(WORKFLOW_ACTIVITIES.wait, {
                    sessionId: input.sessionId,
                    workflowName: workflow.name,
                    stateId: state.id,
                    step,
                    seconds: state.seconds,
                    until,
                    visit: visits[state.id],
                } satisfies WorkflowWaitInput);
                // The timer races the command queue, so cancel, complete and
                // delete end a run that is waiting. It ends at `until`, however
                // long the activity above or a worker restart took.
                while (true) {
                    const now: number = yield ctx.utcNow();
                    const remainingMs = until - now;
                    if (remainingMs <= 0) break;
                    const raced = yield ctx.race(ctx.scheduleTimer(remainingMs), ctx.dequeueEvent(WORKFLOW_COMMAND_QUEUE));
                    if (raced?.index === 0) break;
                    const command = parseWorkflowCommand(raced?.value);
                    if (command) {
                        return yield* finish({
                            workflowName: workflow.name,
                            status: command.cmd === "delete" ? "deleted" : "cancelled",
                            stateId: state.id,
                            steps: step,
                            reason: command.reason ?? (command.cmd === "delete" ? "Deleted" : command.cmd === "done" ? "Stopped" : "Cancelled"),
                            ...(command.requestedBy ? { requestedBy: command.requestedBy } : {}),
                        });
                    }
                    ctx.traceWarn?.(`[workflow] session=${input.sessionId} ignored a non-command message at wait ${state.id}`);
                }
                stateId = resolveTransition(workflow, state.id, WORKFLOW_WAIT_OUTCOME);
                continue;
            }

            if (sinceWait >= spinLimit) throw new Error(workflowSpinError(workflow.name, spinLimit));
            step += 1;
            stepsThisExecution += 1;
            sinceWait += 1;
            visits[state.id] = (visits[state.id] ?? 0) + 1;
            publish(ctx, { status: "running", sessionKind: "workflow", workflow: { name: workflow.name, stateId: state.id, step } });

            // The script races the command queue, so cancel, complete and
            // delete stop a running script: the losing activity is cancelled
            // and the runner kills its process tree.
            const raced = yield ctx.raceTyped(
                ctx.scheduleActivity(WORKFLOW_ACTIVITIES.runScript, {
                    sessionId: input.sessionId,
                    workflowName: workflow.name,
                    stateId: state.id,
                    node: state,
                    inputs: input.inputs,
                    priorOutput,
                    step,
                    visit: visits[state.id],
                } satisfies WorkflowRunStateInput),
                ctx.dequeueEvent(WORKFLOW_COMMAND_QUEUE),
            );
            if (raced?.index === 1) {
                const command = parseWorkflowCommand(raced.value);
                if (!command) {
                    // Workflow sessions take no other messages; the senders
                    // refuse them. One that slips through stopped the script,
                    // so the same state runs again from its start.
                    ctx.traceWarn?.(`[workflow] session=${input.sessionId} ignored a non-command message at state ${state.id}`);
                    step -= 1;
                    sinceWait -= 1;
                    visits[state.id] -= 1;
                    continue;
                }
                return yield* finish({
                    workflowName: workflow.name,
                    status: command.cmd === "delete" ? "deleted" : "cancelled",
                    stateId: state.id,
                    steps: step,
                    reason: command.reason ?? (command.cmd === "delete" ? "Deleted" : command.cmd === "done" ? "Stopped" : "Cancelled"),
                    ...(command.requestedBy ? { requestedBy: command.requestedBy } : {}),
                });
            }
            const raw = typeof raced?.value === "string" ? JSON.parse(raced.value) : raced?.value;
            const result = requireScriptResult(state.id, raw);
            const target = resolveTransition(workflow, state.id, result.outcome);
            results[state.id] = result.output;
            priorOutput = result.output;
            stateId = target;
        }
    } catch (error) {
        const message = workflowErrorMessage(error);
        ctx.traceWarn?.(`[workflow] session=${input.sessionId} failed: ${message}`);
        return yield* finish({
            workflowName: workflow?.name ?? null,
            status: "failed",
            ...(stateId ? { stateId } : {}),
            steps: step,
            error: message,
        });
    }
}

export const WORKFLOW_SESSION_ORCHESTRATION_REGISTRY: ReadonlyArray<{ version: string; handler: any }> = [
    { version: WORKFLOW_SESSION_LATEST_VERSION, handler: workflowSessionOrchestration_1_0_0 },
];
