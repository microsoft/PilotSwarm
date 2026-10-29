import type { CompiledScriptWorkflow } from "./compiler.js";
import {
    requireScriptResult,
    resolveTransition,
    SCRIPT_WORKFLOW_MAX_TRANSITIONS,
} from "./executor.js";

export const SCRIPT_WORKFLOW_ORCHESTRATION_NAME = "script-workflow";
export const SCRIPT_WORKFLOW_LATEST_VERSION = "1.0.0";

/** Node executions per orchestration execution before continue-as-new bounds history. */
export const SCRIPT_WORKFLOW_STEPS_PER_EXECUTION = 20;

export const SCRIPT_WORKFLOW_ACTIVITIES = {
    begin: "scriptWorkflow.begin",
    runNode: "scriptWorkflow.runNode",
    finish: "scriptWorkflow.finish",
} as const;

export interface ScriptWorkflowResumePoint {
    workflow: CompiledScriptWorkflow;
    nodeId: string;
    priorOutput: unknown;
    step: number;
}

export interface ScriptWorkflowOrchestrationInput {
    sessionId: string;
    yaml: string;
    inputs: Record<string, unknown>;
    parentSessionId?: string;
    /** Wake the parent session with the result when the workflow ends. Default true for children. */
    notifyParent?: boolean;
    /** Set only by continue-as-new. */
    resume?: ScriptWorkflowResumePoint;
}

export interface ScriptWorkflowBeginResult {
    workflow: CompiledScriptWorkflow;
}

export interface ScriptWorkflowRunNodeInput {
    sessionId: string;
    workflowName: string;
    nodeId: string;
    node: CompiledScriptWorkflow["nodes"][string];
    inputs: Record<string, unknown>;
    priorOutput: unknown;
    step: number;
}

export interface ScriptWorkflowRunNodeResult {
    outcome: string;
    output: unknown;
}

export interface ScriptWorkflowFinishInput {
    sessionId: string;
    parentSessionId?: string;
    notifyParent: boolean;
    workflowName: string | null;
    status: "completed" | "failed";
    outcome?: string;
    output?: unknown;
    terminalNodeId?: string;
    steps: number;
    error?: string;
}

export interface ScriptWorkflowTerminalResult {
    status: "completed" | "failed";
    workflowName: string | null;
    outcome?: string;
    output?: unknown;
    terminalNodeId?: string;
    steps: number;
    error?: string;
}

/** The custom status the client and portal read; `status` follows session status words. */
export interface ScriptWorkflowCustomStatus {
    status: "running" | "completed" | "failed";
    sessionKind: "workflow";
    workflow: {
        name: string | null;
        nodeId: string | null;
        step: number;
        outcome?: string;
        error?: string;
    };
}

/** duroxide-node prefixes activity errors; the person reading the result needs only the cause. */
const ACTIVITY_ERROR_PREFIX = /^Activity '[^']+' JS execution failed: [A-Za-z]+, (?:[A-Za-z]*Error: )?/;

export function workflowErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(ACTIVITY_ERROR_PREFIX, "");
}

function publish(ctx: any, status: ScriptWorkflowCustomStatus): void {
    ctx.setCustomStatus(JSON.stringify(status));
}

/**
 * Durable controller for one script workflow session.
 *
 * Determinism: the compiled graph comes from an activity (so a compiler
 * change cannot alter a replay), each node runs in an activity, and the
 * transition table is evaluated here from recorded results only. History is
 * bounded by continuing as new every SCRIPT_WORKFLOW_STEPS_PER_EXECUTION
 * nodes, carrying the compiled graph, the current node and its input.
 */
export function* scriptWorkflowOrchestration_1_0_0(
    ctx: any,
    input: ScriptWorkflowOrchestrationInput,
): Generator<any, ScriptWorkflowTerminalResult | null, any> {
    const notifyParent = Boolean(input.parentSessionId) && input.notifyParent !== false;
    let workflow: CompiledScriptWorkflow | null = input.resume?.workflow ?? null;
    let nodeId: string | null = input.resume?.nodeId ?? null;
    let priorOutput: unknown = input.resume?.priorOutput ?? null;
    let step = input.resume?.step ?? 0;

    const finish = function* (result: Omit<ScriptWorkflowFinishInput, "sessionId" | "parentSessionId" | "notifyParent">) {
        publish(ctx, {
            status: result.status,
            sessionKind: "workflow",
            workflow: {
                name: result.workflowName,
                nodeId: result.terminalNodeId ?? nodeId,
                step: result.steps,
                ...(result.outcome ? { outcome: result.outcome } : {}),
                ...(result.error ? { error: result.error } : {}),
            },
        });
        yield ctx.scheduleActivityTyped(SCRIPT_WORKFLOW_ACTIVITIES.finish, {
            sessionId: input.sessionId,
            ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
            notifyParent,
            ...result,
        } satisfies ScriptWorkflowFinishInput);
        const terminal: ScriptWorkflowTerminalResult = {
            status: result.status,
            workflowName: result.workflowName,
            steps: result.steps,
            ...(result.outcome !== undefined ? { outcome: result.outcome } : {}),
            ...(Object.hasOwn(result, "output") ? { output: result.output } : {}),
            ...(result.terminalNodeId ? { terminalNodeId: result.terminalNodeId } : {}),
            ...(result.error ? { error: result.error } : {}),
        };
        return terminal;
    };

    try {
        if (!workflow) {
            publish(ctx, { status: "running", sessionKind: "workflow", workflow: { name: null, nodeId: null, step: 0 } });
            const begun: ScriptWorkflowBeginResult = yield ctx.scheduleActivityTyped(SCRIPT_WORKFLOW_ACTIVITIES.begin, {
                sessionId: input.sessionId,
                yaml: input.yaml,
            });
            workflow = begun.workflow;
            nodeId = workflow.entry;
        }

        let stepsThisExecution = 0;
        while (true) {
            if (step >= SCRIPT_WORKFLOW_MAX_TRANSITIONS) {
                throw new Error(`Workflow '${workflow.name}' exceeded ${SCRIPT_WORKFLOW_MAX_TRANSITIONS} node executions.`);
            }
            if (stepsThisExecution >= SCRIPT_WORKFLOW_STEPS_PER_EXECUTION) {
                yield ctx.continueAsNewVersioned({
                    sessionId: input.sessionId,
                    yaml: input.yaml,
                    inputs: input.inputs,
                    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
                    ...(input.notifyParent !== undefined ? { notifyParent: input.notifyParent } : {}),
                    resume: { workflow, nodeId: nodeId!, priorOutput, step },
                } satisfies ScriptWorkflowOrchestrationInput, SCRIPT_WORKFLOW_LATEST_VERSION);
                return null;
            }

            step += 1;
            stepsThisExecution += 1;
            const node = workflow.nodes[nodeId!];
            if (!node) throw new Error(`Workflow entered unknown node '${nodeId}'.`);
            publish(ctx, { status: "running", sessionKind: "workflow", workflow: { name: workflow.name, nodeId: node.id, step } });

            const raw: ScriptWorkflowRunNodeResult = yield ctx.scheduleActivityTyped(SCRIPT_WORKFLOW_ACTIVITIES.runNode, {
                sessionId: input.sessionId,
                workflowName: workflow.name,
                nodeId: node.id,
                node,
                inputs: input.inputs,
                priorOutput,
                step,
            } satisfies ScriptWorkflowRunNodeInput);
            const result = requireScriptResult(node.id, raw);
            const target = resolveTransition(workflow, node.id, result.outcome);
            if (target === null) {
                return yield* finish({
                    workflowName: workflow.name,
                    status: "completed",
                    outcome: result.outcome,
                    output: result.output,
                    terminalNodeId: node.id,
                    steps: step,
                });
            }
            nodeId = target;
            priorOutput = result.output;
        }
    } catch (error) {
        const message = workflowErrorMessage(error);
        ctx.traceWarn?.(`[script-workflow] session=${input.sessionId} failed: ${message}`);
        return yield* finish({
            workflowName: workflow?.name ?? null,
            status: "failed",
            ...(nodeId ? { terminalNodeId: nodeId } : {}),
            steps: step,
            error: message,
        });
    }
}

export const SCRIPT_WORKFLOW_ORCHESTRATION_REGISTRY: ReadonlyArray<{ version: string; handler: any }> = [
    { version: SCRIPT_WORKFLOW_LATEST_VERSION, handler: scriptWorkflowOrchestration_1_0_0 },
];
