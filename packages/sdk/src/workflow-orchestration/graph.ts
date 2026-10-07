import type { WorkflowDefinitionSource, WorkflowSessionResult } from "../types.js";

export type WorkflowStateId = string;

export interface WorkflowStateExecutionResult<TOutput = unknown> {
    outcome: string;
    output: TOutput;
}

export interface WorkflowStateExecutionContext<TInputs = Record<string, unknown>> {
    sessionId: string;
    stateId: WorkflowStateId;
    workflowInputs: Readonly<TInputs>;
    recordedStateOutputs: Readonly<Record<WorkflowStateId, WorkflowStateExecutionResult>>;
}

export interface WorkflowTransitionContext<
    TInputs = Record<string, unknown>,
    TOutput = unknown,
> {
    workflowInputs: Readonly<TInputs>;
    currentStateId: WorkflowStateId;
    stateOutcome: string;
    stateOutput: TOutput;
    recordedStateOutputs: Readonly<Record<WorkflowStateId, WorkflowStateExecutionResult>>;
}

export interface WorkflowTerminalContext<TInputs = Record<string, unknown>> {
    workflowInputs: Readonly<TInputs>;
    recordedStateOutputs: Readonly<Record<WorkflowStateId, WorkflowStateExecutionResult>>;
}

export interface InMemoryWorkflowExecutableState {
    type: "activity";
    allowedOutcomes: readonly string[];
    allowedTargets: readonly WorkflowStateId[];
    execute(
        context: WorkflowStateExecutionContext,
    ): Promise<WorkflowStateExecutionResult> | WorkflowStateExecutionResult;
    transition(context: WorkflowTransitionContext): WorkflowStateId;
}

export interface InMemoryWorkflowTerminalState {
    type: "terminal";
    outcome: WorkflowSessionResult["outcome"];
    summary: string;
    result?: (context: WorkflowTerminalContext) => unknown;
}

export type InMemoryWorkflowState =
    | InMemoryWorkflowExecutableState
    | InMemoryWorkflowTerminalState;

export interface InMemoryWorkflowGraph {
    id: string;
    initialState: WorkflowStateId;
    states: Readonly<Record<WorkflowStateId, InMemoryWorkflowState>>;
    maxTransitions?: number;
}

const graphs = new Map<string, InMemoryWorkflowGraph>();
const terminalOutcomes = new Set(["succeeded", "blocked", "failed", "cancelled"]);

function workflowGraphError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

function requireNonEmptyStrings(values: readonly string[], label: string): void {
    if (values.length === 0 || values.some(value => typeof value !== "string" || value.length === 0)) {
        throw workflowGraphError(`${label} must contain at least one non-empty value.`, "WORKFLOW_GRAPH_INVALID");
    }
}

function deepFreeze<T>(value: T): T {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
        deepFreeze(nested);
    }
    return value;
}

function validateGraph(graph: InMemoryWorkflowGraph): void {
    if (!graph || typeof graph !== "object") {
        throw workflowGraphError("Workflow graph must be an object.", "WORKFLOW_GRAPH_INVALID");
    }
    if (typeof graph.id !== "string" || graph.id.length === 0) {
        throw workflowGraphError("Workflow graph id is required.", "WORKFLOW_GRAPH_INVALID");
    }
    if (!Number.isInteger(graph.maxTransitions ?? 100) || (graph.maxTransitions ?? 100) < 1) {
        throw workflowGraphError("Workflow graph maxTransitions must be a positive integer.", "WORKFLOW_GRAPH_INVALID");
    }
    const stateEntries = Object.entries(graph.states ?? {});
    if (stateEntries.length === 0) {
        throw workflowGraphError("Workflow graph must declare at least one state.", "WORKFLOW_GRAPH_INVALID");
    }
    if (!graph.states[graph.initialState]) {
        throw workflowGraphError(
            `Workflow graph initial state '${graph.initialState}' does not exist.`,
            "WORKFLOW_GRAPH_INVALID",
        );
    }
    for (const [stateId, state] of stateEntries) {
        if (state.type === "terminal") {
            if (!terminalOutcomes.has(state.outcome)) {
                throw workflowGraphError(
                    `Terminal state '${stateId}' has invalid outcome '${state.outcome}'.`,
                    "WORKFLOW_GRAPH_INVALID",
                );
            }
            if (typeof state.summary !== "string" || state.summary.length === 0) {
                throw workflowGraphError(
                    `Terminal state '${stateId}' must declare a summary.`,
                    "WORKFLOW_GRAPH_INVALID",
                );
            }
            continue;
        }
        if (state.type !== "activity") {
            throw workflowGraphError(
                `Workflow state '${stateId}' has unsupported type '${(state as { type?: unknown }).type}'.`,
                "WORKFLOW_GRAPH_INVALID",
            );
        }
        requireNonEmptyStrings(state.allowedOutcomes, `Workflow state '${stateId}' allowedOutcomes`);
        requireNonEmptyStrings(state.allowedTargets, `Workflow state '${stateId}' allowedTargets`);
        if (typeof state.execute !== "function" || typeof state.transition !== "function") {
            throw workflowGraphError(
                `Workflow state '${stateId}' must declare execute and transition functions.`,
                "WORKFLOW_GRAPH_INVALID",
            );
        }
        for (const target of state.allowedTargets) {
            if (!graph.states[target]) {
                throw workflowGraphError(
                    `Workflow state '${stateId}' targets unknown state '${target}'.`,
                    "WORKFLOW_GRAPH_INVALID",
                );
            }
        }
    }
}

export function registerInMemoryWorkflowGraph(
    graph: InMemoryWorkflowGraph,
): Extract<WorkflowDefinitionSource, { kind: "in-memory" }> {
    validateGraph(graph);
    if (graphs.has(graph.id)) {
        throw workflowGraphError(
            `Workflow graph '${graph.id}' is already registered.`,
            "WORKFLOW_GRAPH_ALREADY_REGISTERED",
        );
    }
    graphs.set(graph.id, deepFreeze(graph));
    return { kind: "in-memory", graphId: graph.id };
}

export function unregisterInMemoryWorkflowGraph(graphId: string): boolean {
    return graphs.delete(graphId);
}

export function resolveInMemoryWorkflowGraph(graphId: string): InMemoryWorkflowGraph {
    const graph = graphs.get(graphId);
    if (!graph) {
        throw workflowGraphError(
            `Workflow graph '${graphId}' is not registered in this worker process.`,
            "WORKFLOW_GRAPH_NOT_REGISTERED",
        );
    }
    return graph;
}

export function clearInMemoryWorkflowGraphs(): void {
    graphs.clear();
}
