import type { CompiledWorkflow, WorkflowScriptState, WorkflowTerminalOutcome } from "./compiler.js";
import {
    requireScriptResult,
    resolveTransition,
    terminalOutput,
    WORKFLOW_MAX_TRANSITIONS,
} from "./executor.js";

export const WORKFLOW_SESSION_ORCHESTRATION_NAME = "workflow-session";
export const WORKFLOW_SESSION_LATEST_VERSION = "1.0.0";

/** Script-state executions per orchestration execution before continue-as-new bounds history. */
export const WORKFLOW_STEPS_PER_EXECUTION = 20;

export const WORKFLOW_ACTIVITIES = {
    begin: "workflow.begin",
    runScript: "workflow.runScript",
    finish: "workflow.finish",
} as const;

export interface WorkflowResumePoint {
    workflow: CompiledWorkflow;
    stateId: string;
    priorOutput: unknown;
    step: number;
    /** The latest output of each state that ran, for terminal `output` templates. */
    results: Record<string, unknown>;
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
 * the next state is chosen here from recorded results only. History is
 * bounded by continuing as new every WORKFLOW_STEPS_PER_EXECUTION script
 * states, carrying the compiled graph, the current state, its input and the
 * results terminal templates may read.
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
    const results: Record<string, unknown> = { ...(input.resume?.results ?? {}) };

    const finish = function* (result: Omit<WorkflowFinishInput, "sessionId" | "parentSessionId" | "notifyParent">) {
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
        yield ctx.scheduleActivityTyped(WORKFLOW_ACTIVITIES.finish, {
            sessionId: input.sessionId,
            ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
            notifyParent,
            ...result,
        } satisfies WorkflowFinishInput);
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

            if (step >= WORKFLOW_MAX_TRANSITIONS) {
                throw new Error(`Workflow '${workflow.name}' exceeded ${WORKFLOW_MAX_TRANSITIONS} state executions.`);
            }
            if (stepsThisExecution >= WORKFLOW_STEPS_PER_EXECUTION) {
                yield ctx.continueAsNewVersioned({
                    sessionId: input.sessionId,
                    yaml: input.yaml,
                    inputs: input.inputs,
                    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
                    ...(input.notifyParent !== undefined ? { notifyParent: input.notifyParent } : {}),
                    resume: { workflow, stateId: stateId!, priorOutput, step, results },
                } satisfies WorkflowOrchestrationInput, WORKFLOW_SESSION_LATEST_VERSION);
                return null;
            }

            step += 1;
            stepsThisExecution += 1;
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
