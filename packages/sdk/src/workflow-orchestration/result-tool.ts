import { defineTool } from "@github/copilot-sdk";
import type { SessionCatalog } from "../cms.js";
import {
    SUBMIT_WORKFLOW_RESULT_TOOL,
    WORKFLOW_RESULT_QUEUE_PREFIX,
    workflowResultQueueName,
    type WorkflowExecutionBinding,
    type WorkflowResultEvent,
} from "../workflow-orchestration_1_0_0/contracts.js";

export {
    SUBMIT_WORKFLOW_RESULT_TOOL,
    WORKFLOW_RESULT_QUEUE_PREFIX,
    workflowResultQueueName,
    type WorkflowExecutionBinding,
    type WorkflowResultEvent,
};

function resultToolError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

function executionBinding(value: unknown): WorkflowExecutionBinding | null {
    if (!value || typeof value !== "object") return null;
    const binding = value as Partial<WorkflowExecutionBinding>;
    if (
        binding.kind !== "workflow-state-execution"
        || typeof binding.workflowSessionId !== "string"
        || typeof binding.graphId !== "string"
        || typeof binding.stateId !== "string"
        || !Number.isInteger(binding.executionSequence)
        || (binding.executionSequence ?? 0) < 1
        || !Array.isArray(binding.allowedOutcomes)
        || binding.allowedOutcomes.some(outcome => typeof outcome !== "string")
    ) {
        return null;
    }
    return binding as WorkflowExecutionBinding;
}

export function createSubmitWorkflowResultTool(options: {
    catalog: Pick<
        SessionCatalog,
        "getSession" | "getSessionCreationConfig" | "getChildOutcome"
    >;
    duroxideClient: {
        enqueueEvent(instanceId: string, queue: string, payload: string): Promise<unknown>;
    };
}) {
    return defineTool(SUBMIT_WORKFLOW_RESULT_TOOL, {
        description:
            "Complete the workflow state assigned to this agent. Submit exactly one declared outcome and its structured JSON output. " +
            "The workflow controller validates the result and selects the next state; do not name a target state.",
        parameters: {
            type: "object" as const,
            properties: {
                outcome: {
                    type: "string",
                    description: "One outcome declared by the assigned workflow state.",
                },
                output: {
                    type: "object",
                    description: "Structured JSON output for the assigned workflow state.",
                },
            },
            required: ["outcome", "output"],
        },
        handler: async (
            args: { outcome?: unknown; output?: unknown },
            invocation: any,
        ) => {
            const childSessionId = invocation?.durableSessionId;
            if (!childSessionId) {
                throw resultToolError(
                    "The workflow result tool requires a durable session identity.",
                    "WORKFLOW_RESULT_CALLER_REQUIRED",
                );
            }

            const child = await options.catalog.getSession(childSessionId);
            const creationConfig = await options.catalog.getSessionCreationConfig?.(childSessionId);
            const binding = executionBinding(creationConfig?.childContract);
            if (!child || !binding || child.parentSessionId !== binding.workflowSessionId) {
                throw resultToolError(
                    `Session '${childSessionId}' is not bound to a workflow state execution.`,
                    "WORKFLOW_RESULT_BINDING_REQUIRED",
                );
            }
            const workflow = await options.catalog.getSession(binding.workflowSessionId);
            if (!workflow || workflow.sessionKind !== "workflow") {
                throw resultToolError(
                    `Workflow session '${binding.workflowSessionId}' is unavailable.`,
                    "WORKFLOW_RESULT_WORKFLOW_REQUIRED",
                );
            }
            if (typeof args.outcome !== "string" || !binding.allowedOutcomes.includes(args.outcome)) {
                throw resultToolError(
                    `Outcome '${String(args.outcome)}' is not declared for workflow state '${binding.stateId}'.`,
                    "WORKFLOW_STATE_OUTCOME_INVALID",
                );
            }
            if (!Object.prototype.hasOwnProperty.call(args, "output")) {
                throw resultToolError(
                    "Workflow result output is required.",
                    "WORKFLOW_STATE_RESULT_INVALID",
                );
            }

            const existing = await options.catalog.getChildOutcome(childSessionId);
            if (existing?.completedAt) {
                return JSON.stringify({
                    accepted: true,
                    duplicate: true,
                    workflowSessionId: binding.workflowSessionId,
                    executionSequence: binding.executionSequence,
                });
            }

            const event: WorkflowResultEvent = {
                workflowSessionId: binding.workflowSessionId,
                childSessionId,
                graphId: binding.graphId,
                stateId: binding.stateId,
                executionSequence: binding.executionSequence,
                outcome: args.outcome,
                output: args.output,
            };
            await options.duroxideClient.enqueueEvent(
                `session-${binding.workflowSessionId}`,
                workflowResultQueueName(binding.executionSequence),
                JSON.stringify(event),
            );

            return JSON.stringify({
                submitted: true,
                workflowSessionId: binding.workflowSessionId,
                executionSequence: binding.executionSequence,
            });
        },
    });
}
