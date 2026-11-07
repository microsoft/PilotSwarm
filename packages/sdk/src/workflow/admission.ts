import type { WorkflowOrchestrationInput } from "./orchestration.js";
import { WORKFLOW_TOOL_POLICY } from "./tool-policy.js";

export interface WorkflowAdmission {
    policy: typeof WORKFLOW_TOOL_POLICY;
    workflowName: string;
    input: WorkflowOrchestrationInput;
}

export function readWorkflowAdmission(value: unknown): WorkflowAdmission | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "object" || !("policy" in value) || value.policy !== WORKFLOW_TOOL_POLICY
        || !("workflowName" in value) || typeof value.workflowName !== "string"
        || !("input" in value) || !value.input || typeof value.input !== "object") {
        throw new Error("Invalid persisted workflow admission.");
    }
    const input = value.input;
    if (!("sessionId" in input) || typeof input.sessionId !== "string"
        || !("yaml" in input) || typeof input.yaml !== "string"
        || !("inputs" in input) || !input.inputs || typeof input.inputs !== "object" || Array.isArray(input.inputs)
        || !("parentSessionId" in input) || typeof input.parentSessionId !== "string"
        || !("executionPolicy" in input) || input.executionPolicy !== WORKFLOW_TOOL_POLICY
        || ("notifyParent" in input && typeof input.notifyParent !== "boolean")
        || "resume" in input) {
        throw new Error("Invalid persisted workflow start input.");
    }
    return value as WorkflowAdmission;
}
