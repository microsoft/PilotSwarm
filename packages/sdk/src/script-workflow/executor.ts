import type { CompiledScriptWorkflow, ScriptWorkflowNode } from "./compiler.js";

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
    callTool: (call: ScriptToolCall) => Promise<unknown>;
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

function requireScriptResult(nodeId: string, value: unknown): ScriptExecutionResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ScriptWorkflowExecutionError(`Script node '${nodeId}' returned an invalid result.`);
    }
    const result = value as Partial<ScriptExecutionResult>;
    if (typeof result.outcome !== "string" || !result.outcome.trim() || !Object.hasOwn(result, "output")) {
        throw new ScriptWorkflowExecutionError(`Script node '${nodeId}' must return an outcome and output.`);
    }
    return { outcome: result.outcome, output: result.output };
}

/**
 * Execute a compiled workflow without side effects of its own.
 *
 * The durable adapter supplies a runner that invokes the selected script
 * runtime and routes tool requests through the workflow session's authorized
 * tool set. Keeping transitions here pure makes replay behavior testable.
 */
export async function executeScriptWorkflow(
    workflow: CompiledScriptWorkflow,
    inputs: Record<string, unknown>,
    execute: ScriptExecutor,
): Promise<ScriptWorkflowResult> {
    let nodeId = workflow.entry;
    let priorOutput: unknown = undefined;

    for (let transitions = 1; transitions <= SCRIPT_WORKFLOW_MAX_TRANSITIONS; transitions += 1) {
        const node = workflow.nodes[nodeId];
        if (!node) throw new ScriptWorkflowExecutionError(`Workflow entered unknown node '${nodeId}'.`);
        const result = requireScriptResult(nodeId, await execute({
            workflowName: workflow.name,
            node,
            inputs,
            priorOutput,
            callTool: async () => {
                throw new ScriptWorkflowExecutionError(
                    `Script node '${nodeId}' requested a tool but this executor does not provide tool routing.`,
                );
            },
        }));
        const target = node.next[result.outcome];
        if (target === undefined) {
            throw new ScriptWorkflowExecutionError(`Script node '${nodeId}' returned undeclared outcome '${result.outcome}'.`);
        }
        if (target === null) {
            return { outcome: result.outcome, output: result.output, transitions, terminalNodeId: nodeId };
        }
        nodeId = target;
        priorOutput = result.output;
    }

    throw new ScriptWorkflowExecutionError(
        `Workflow '${workflow.name}' exceeded ${SCRIPT_WORKFLOW_MAX_TRANSITIONS} transitions.`,
    );
}
