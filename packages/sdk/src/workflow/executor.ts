import {
    resolveWorkflowTemplate,
    type CompiledWorkflow,
    type WorkflowScriptState,
    type WorkflowTerminalOutcome,
} from "./compiler.js";

/** Hard ceiling on script-state executions in one workflow run, across continue-as-new. */
export const WORKFLOW_MAX_TRANSITIONS = 1_000;

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
    if (state.type !== "script") throw new WorkflowExecutionError(`State '${stateId}' is terminal and has no transitions.`);
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

/**
 * Run a compiled workflow in process. The durable controller uses the same
 * helpers step by step; this loop exists for tests and local tooling.
 */
export async function executeWorkflow(
    workflow: CompiledWorkflow,
    inputs: Record<string, unknown>,
    execute: ScriptExecutor,
): Promise<WorkflowExecutionResult> {
    let stateId = workflow.initial;
    let priorOutput: unknown = null;
    const results: Record<string, unknown> = {};

    for (let step = 1; step <= WORKFLOW_MAX_TRANSITIONS + 1; step += 1) {
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
        if (step > WORKFLOW_MAX_TRANSITIONS) break;
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

    throw new WorkflowExecutionError(`Workflow '${workflow.name}' exceeded ${WORKFLOW_MAX_TRANSITIONS} transitions.`);
}
