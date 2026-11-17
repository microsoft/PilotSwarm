import { WorkflowStoreError } from "./store.js";

const snakeCaseOf = (name: string): string => name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

/**
 * The workflow tools' arguments are snake_case, while their results say workflowId, runId and definitionId. A model that
 * copies a result key into its next call would otherwise have it ignored: "workflow_id is required" for a valid id, or a
 * runId dropped so the command acts on the live run. Every camelCase top-level argument is refused, WORKFLOW_COMMAND_INVALID
 * naming the argument meant. Nested values (agent_models, payload, response) are the callee's to check.
 */
export function refuseCamelCaseToolArgs(tool: string, args: Record<string, unknown>): void {
    const misnamed = Object.keys(args).filter(key => /[A-Z]/.test(key));
    if (!misnamed.length) return;
    const meant = misnamed.map(key => `${key} (did you mean ${snakeCaseOf(key)}?)`).join(", ");
    throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID",
        `Not ${misnamed.length === 1 ? "an argument" : "arguments"} of ${tool}: ${meant}. Its arguments are snake_case; only its results are camelCase.`);
}
