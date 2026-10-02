import type { WorkflowDefinitionSource } from "../types.js";

export const WORKFLOW_ORCHESTRATION_VERSION = "1.0.0";

export interface WorkflowOrchestrationInput {
    sessionId: string;
    parentSessionId?: string;
    definition: WorkflowDefinitionSource;
    inputs: Record<string, unknown>;
}

export class WorkflowControllerNotImplementedError extends Error {
    readonly code = "WORKFLOW_CONTROLLER_NOT_IMPLEMENTED";

    constructor() {
        super("Workflow session controller is not implemented.");
        this.name = "WorkflowControllerNotImplementedError";
    }
}

/**
 * Durable workflow-session orchestration entry point.
 *
 * The state machine is intentionally absent. Registering this handler reserves
 * a separate replay/version boundary without routing workflow sessions through
 * the conversation-backed durable-session orchestration.
 *
 * @internal
 */
export function* durableWorkflowSessionOrchestration_1_0_0(
    _ctx: unknown,
    _input: WorkflowOrchestrationInput,
): Generator<unknown, never, unknown> {
    throw new WorkflowControllerNotImplementedError();
}
