import {
    resolveWorkflowTemplate,
    WORKFLOW_WAIT_OUTCOME,
    type CompiledWorkflow,
    type WorkflowScriptState,
    type WorkflowTerminalOutcome,
    type WorkflowWaitState,
} from "./compiler.js";

/**
 * Hard ceiling on script-state executions between two waits, across
 * continue-as-new. A run that waits between checks may go on until it is
 * cancelled; one that loops without waiting fails here.
 */
export const WORKFLOW_MAX_SCRIPT_RUNS_BETWEEN_WAITS = 1_000;

/** The failure for a run that ran too many script states without a wait. */
export function workflowSpinError(workflowName: string, limit: number): string {
    return `Workflow '${workflowName}' ran ${limit} script states without reaching a wait state; `
        + "a loop must pass through a wait state.";
}

export interface ScriptToolCall {
    name: string;
    arguments: Record<string, unknown>;
}

export interface ScriptExecutionRequest {
    workflowName: string;
    node: WorkflowScriptState;
    inputs: Record<string, unknown>;
    priorOutput: unknown;
    step: number;
}

export interface ScriptExecutionResult {
    outcome: string;
    output: unknown;
}

/** How an in-process run ended: at a terminal state, with its outcome and resolved output. */
export interface WorkflowExecutionResult {
    outcome: WorkflowTerminalOutcome;
    summary: string;
    output: unknown;
    transitions: number;
    terminalStateId: string;
}

export type ScriptExecutor = (request: ScriptExecutionRequest) => Promise<ScriptExecutionResult>;

export class WorkflowExecutionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkflowExecutionError";
    }
}

export function requireScriptResult(stateId: string, value: unknown): ScriptExecutionResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new WorkflowExecutionError(`Script state '${stateId}' returned an invalid result.`);
    }
    const result = value as Partial<ScriptExecutionResult>;
    if (typeof result.outcome !== "string" || !result.outcome.trim() || !Object.hasOwn(result, "output")) {
        throw new WorkflowExecutionError(`Script state '${stateId}' must return an outcome and output.`);
    }
    return { outcome: result.outcome, output: result.output };
}

/** The state an outcome leads to. An outcome the state did not declare fails the run. */
export function resolveTransition(workflow: CompiledWorkflow, stateId: string, outcome: string): string {
    const state = workflow.states[stateId];
    if (!state) throw new WorkflowExecutionError(`Workflow entered unknown state '${stateId}'.`);
    if (state.type === "terminal") throw new WorkflowExecutionError(`State '${stateId}' is terminal and has no transitions.`);
    if (state.type === "wait") {
        if (outcome !== WORKFLOW_WAIT_OUTCOME) throw new WorkflowExecutionError(`Wait state '${stateId}' has only the outcome '${WORKFLOW_WAIT_OUTCOME}'.`);
        return state.next[WORKFLOW_WAIT_OUTCOME];
    }
    const target = state.next[outcome];
    if (target === undefined) {
        throw new WorkflowExecutionError(
            `Script state '${stateId}' returned undeclared outcome '${outcome}' (declared: ${state.outcomes.join(", ")}).`,
        );
    }
    return target;
}

/** A terminal state's result: its `output` template resolved, or null when it declares none. */
export function terminalOutput(
    workflow: CompiledWorkflow,
    stateId: string,
    inputs: Record<string, unknown>,
    results: Record<string, unknown>,
): unknown {
    const state = workflow.states[stateId];
    if (!state || state.type !== "terminal" || !state.hasOutput) return null;
    return resolveWorkflowTemplate(state.output, `states.${stateId}.output`, {
        inputs,
        configuration: workflow.configuration,
        results,
    });
}

export interface ExecuteWorkflowOptions {
    /** Called for each wait state. Default: return at once (no real waiting). */
    wait?: (state: WorkflowWaitState, step: number) => Promise<void>;
    /** Stop a run that has not ended after this many steps. Default 10,000. */
    maxSteps?: number;
    /** Default WORKFLOW_MAX_SCRIPT_RUNS_BETWEEN_WAITS. */
    maxScriptRunsBetweenWaits?: number;
}

/**
 * Run a compiled workflow in process. The durable controller uses the same
 * helpers step by step; this loop exists for tests and local tooling.
 */
export async function executeWorkflow(
    workflow: CompiledWorkflow,
    inputs: Record<string, unknown>,
    execute: ScriptExecutor,
    options: ExecuteWorkflowOptions = {},
): Promise<WorkflowExecutionResult> {
    const maxSteps = options.maxSteps ?? 10_000;
    const spinLimit = options.maxScriptRunsBetweenWaits ?? WORKFLOW_MAX_SCRIPT_RUNS_BETWEEN_WAITS;
    let stateId = workflow.initial;
    let priorOutput: unknown = null;
    let sinceWait = 0;
    const results: Record<string, unknown> = {};

    for (let step = 1; step <= maxSteps + 1; step += 1) {
        const state = workflow.states[stateId];
        if (!state) throw new WorkflowExecutionError(`Workflow entered unknown state '${stateId}'.`);
        if (state.type === "terminal") {
            return {
                outcome: state.outcome,
                summary: state.summary,
                output: terminalOutput(workflow, stateId, inputs, results),
                transitions: step - 1,
                terminalStateId: stateId,
            };
        }
        if (step > maxSteps) break;
        if (state.type === "wait") {
            sinceWait = 0;
            await options.wait?.(state, step);
            stateId = resolveTransition(workflow, stateId, WORKFLOW_WAIT_OUTCOME);
            continue;
        }
        if (sinceWait >= spinLimit) throw new WorkflowExecutionError(workflowSpinError(workflow.name, spinLimit));
        sinceWait += 1;
        const result = requireScriptResult(stateId, await execute({
            workflowName: workflow.name,
            node: state,
            inputs,
            priorOutput,
            step,
        }));
        results[stateId] = result.output;
        priorOutput = result.output;
        stateId = resolveTransition(workflow, stateId, result.outcome);
    }

    throw new WorkflowExecutionError(`Workflow '${workflow.name}' did not end within ${maxSteps} steps.`);
}
