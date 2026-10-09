import {
    resolveWorkflowTemplate,
    type CompiledWorkflowAgentStateManifest,
} from "./compiler.js";
import type {
    WorkflowExecutionRecord,
    WorkflowStateExecutionResult,
} from "./graph.js";
import {
    createAgentStateDispatchPlan,
    type AgentStateDispatchPlan,
} from "../workflow-orchestration_1_0_0/agent-dispatch.js";

export function createCompiledAgentStateDispatchPlan(input: {
    workflowSessionId: string;
    graphId: string;
    stateId: string;
    executionSequence: number;
    childSessionId: string;
    workflowInputs: Record<string, unknown>;
    configuration: Record<string, unknown>;
    latestStateOutputs: Record<string, WorkflowStateExecutionResult>;
    executionHistory: WorkflowExecutionRecord[];
    state: CompiledWorkflowAgentStateManifest;
}): AgentStateDispatchPlan {
    const resolvedInput = resolveWorkflowTemplate(
        input.state.input,
        `states.${input.stateId}.input`,
        {
            inputs: input.workflowInputs,
            configuration: input.configuration,
            latestStateOutputs: input.latestStateOutputs,
        },
    );
    const task = [
        `Execute workflow state '${input.stateId}' for '${input.graphId}'.`,
        "",
        "Input:",
        JSON.stringify(resolvedInput, null, 2),
        "",
        `Submit exactly one declared outcome (${input.state.completion.outcomes.join(", ")}) using submit_workflow_result.`,
        `The output must satisfy result schema '${input.state.resultSchema}'.`,
    ].join("\n");

    return createAgentStateDispatchPlan({
        workflowSessionId: input.workflowSessionId,
        graphId: input.graphId,
        stateId: input.stateId,
        executionSequence: input.executionSequence,
        childSessionId: input.childSessionId,
        workflowInputs: input.workflowInputs,
        latestStateOutputs: input.latestStateOutputs,
        executionHistory: input.executionHistory,
        state: {
            agent: input.state.agent,
            prompt: task,
            allowedOutcomes: input.state.completion.outcomes,
        },
    });
}
