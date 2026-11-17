import { WorkflowStoreError } from "./store.js";

/** At most this many argument names, each at most this long, in a refusal's words: a caller's keys are its own text. */
export const TOOL_ARG_NAMES_SHOWN = 20;
export const TOOL_ARG_NAME_MAX_CHARS = 64;

const shownName = (name: string): string => (name.length > TOOL_ARG_NAME_MAX_CHARS ? `${name.slice(0, TOOL_ARG_NAME_MAX_CHARS)}…` : name);

/** Names, capped in count and length, with how many more were left out. */
function namesWords(names: readonly string[], each: (name: string) => string = shownName): string {
    const shown = names.slice(0, TOOL_ARG_NAMES_SHOWN).map(each).join(", ");
    return names.length > TOOL_ARG_NAMES_SHOWN ? `${shown} and ${names.length - TOOL_ARG_NAMES_SHOWN} more` : shown;
}

/** The arguments a call received, for a refusal that says one is missing: their names only, never their values. */
export function receivedArgumentsWords(args: Record<string, unknown>): string {
    const received = Object.keys(args);
    return received.length ? `Received: ${namesWords(received)}.` : "Received no arguments.";
}

/** snake_case of a camelCase name; a run of capitals is one word (runID: run_id, HTTPHeaders: http_headers). */
export function snakeCaseOf(name: string): string {
    return name
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase();
}

/**
 * The workflow tools' arguments are snake_case, while their results say workflowId, runId and definitionId. A model that
 * copies a result key into its next call would otherwise have it ignored: "workflow_id is required" for a valid id, or a
 * runId dropped so the command acts on the live run. Every camelCase top-level argument is refused, WORKFLOW_COMMAND_INVALID
 * naming the argument meant. Nested values (agent_models, payload, response) are the callee's to check.
 */
export function refuseCamelCaseToolArgs(tool: string, args: Record<string, unknown>): void {
    const misnamed = Object.keys(args).filter(key => /[A-Z]/.test(key));
    if (!misnamed.length) return;
    const meant = namesWords(misnamed, key => `${shownName(key)} (did you mean ${shownName(snakeCaseOf(key))}?)`);
    throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID",
        `Not ${misnamed.length === 1 ? "an argument" : "arguments"} of ${tool}: ${meant}. Its arguments are snake_case; only its results are camelCase.`);
}
