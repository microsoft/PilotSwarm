import type { CompiledScriptWorkflow, ScriptWorkflowNode } from "./compiler.js";

/** Hard ceiling on node executions in one workflow run, across continue-as-new. */
export const SCRIPT_WORKFLOW_MAX_TRANSITIONS = 1_000;

export interface ScriptToolCall {
    name: string;
    arguments: Record<string, unknown>;
}

export interface ScriptExecutionRequest {
    workflowName: string;
    node: ScriptWorkflowNode;
    inputs: Record<string, unknown>;
    priorOutput: unknown;
    step: number;
}

export interface ScriptExecutionResult {
    outcome: string;
    output: unknown;
}

export interface ScriptWorkflowResult {
    outcome: string;
    output: unknown;
    transitions: number;
    terminalNodeId: string;
}

export type ScriptExecutor = (request: ScriptExecutionRequest) => Promise<ScriptExecutionResult>;

export class ScriptWorkflowExecutionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ScriptWorkflowExecutionError";
    }
}

export function requireScriptResult(nodeId: string, value: unknown): ScriptExecutionResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ScriptWorkflowExecutionError(`Script node '${nodeId}' returned an invalid result.`);
    }
    const result = value as Partial<ScriptExecutionResult>;
    if (typeof result.outcome !== "string" || !result.outcome.trim() || !Object.hasOwn(result, "output")) {
        throw new ScriptWorkflowExecutionError(`Script node '${nodeId}' must return an outcome and output.`);
    }
    return { outcome: result.outcome, output: result.output };
}

/** The next node for an outcome, or null when the outcome ends the workflow. */
export function resolveTransition(
    workflow: CompiledScriptWorkflow,
    nodeId: string,
    outcome: string,
): string | null {
    const node = workflow.nodes[nodeId];
    if (!node) throw new ScriptWorkflowExecutionError(`Workflow entered unknown node '${nodeId}'.`);
    const target = node.next[outcome];
    if (target === undefined) {
        const declared = Object.keys(node.next);
        throw new ScriptWorkflowExecutionError(
            `Script node '${nodeId}' returned undeclared outcome '${outcome}'`
            + (declared.length ? ` (declared: ${declared.join(", ")}).` : " (it declares no outcomes)."),
        );
    }
    return target;
}

/**
 * Run a compiled workflow in process. The durable controller uses the same
 * helpers step by step; this loop exists for tests and local tooling.
 */
export async function executeScriptWorkflow(
    workflow: CompiledScriptWorkflow,
    inputs: Record<string, unknown>,
    execute: ScriptExecutor,
): Promise<ScriptWorkflowResult> {
    let nodeId = workflow.entry;
    let priorOutput: unknown = null;

    for (let step = 1; step <= SCRIPT_WORKFLOW_MAX_TRANSITIONS; step += 1) {
        const node = workflow.nodes[nodeId];
        if (!node) throw new ScriptWorkflowExecutionError(`Workflow entered unknown node '${nodeId}'.`);
        const result = requireScriptResult(nodeId, await execute({
            workflowName: workflow.name,
            node,
            inputs,
            priorOutput,
            step,
        }));
        const target = resolveTransition(workflow, nodeId, result.outcome);
        if (target === null) {
            return { outcome: result.outcome, output: result.output, transitions: step, terminalNodeId: nodeId };
        }
        nodeId = target;
        priorOutput = result.output;
    }

    throw new ScriptWorkflowExecutionError(
        `Workflow '${workflow.name}' exceeded ${SCRIPT_WORKFLOW_MAX_TRANSITIONS} transitions.`,
    );
}
