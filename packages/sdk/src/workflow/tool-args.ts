import { WorkflowStoreError } from "./store.js";

/**
 * The top-level arguments of one workflow tool, as its handler reads them on any turn: every property of every declared
 * variant, and the arguments its handler takes without declaring them (update_workflow's definition commands).
 */
export interface WorkflowToolArguments {
    tool: string;
    accepted: readonly string[];
    /** Arguments the tool cannot run without; a call missing one is refused naming the arguments it did receive. */
    required: readonly string[];
    /** The refusal code of this tool's call-shape errors. */
    code: string;
    /** Where a misplaced field belongs (complete_workflow_node: output), for a key that is not an argument at all. */
    fieldsGoIn?: string;
}

/** At most this many argument names, each at most this long, in a refusal: the whole stays inside the 2,000-character reply. */
export const TOOL_ARG_NAMES_SHOWN = 8;
export const TOOL_ARG_NAME_MAX_CHARS = 64;

const shownName = (name: string): string => (name.length > TOOL_ARG_NAME_MAX_CHARS ? `${name.slice(0, TOOL_ARG_NAME_MAX_CHARS)}…` : name);

function namesWords(names: readonly string[], each: (name: string) => string = shownName): string {
    const shown = names.slice(0, TOOL_ARG_NAMES_SHOWN).map(each).join(", ");
    return names.length > TOOL_ARG_NAMES_SHOWN ? `${shown} and ${names.length - TOOL_ARG_NAMES_SHOWN} more` : shown;
}

const squashed = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The argument a misspelled key most likely means, or null: the one accepted argument equal to it ignoring case and
 * separators (workflowId, RUNID, run-id), else the one accepted argument it ends (kvRevision: expected_kv_revision).
 * Never a name the tool does not take.
 */
export function workflowToolArgumentMeant(key: string, accepted: readonly string[]): string | null {
    const wanted = squashed(key);
    if (!wanted) return null;
    const same = accepted.filter(name => squashed(name) === wanted);
    if (same.length === 1) return same[0];
    if (wanted.length < 4) return null;
    const ending = accepted.filter(name => squashed(name).endsWith(wanted));
    return ending.length === 1 ? ending[0] : null;
}

/**
 * Refuse a call whose top-level keys a model misnamed, before anything is read: a key with a capital letter (results say
 * workflowId; arguments are workflow_id), or a key that is not an argument but plainly means one (runid, run-id). Both were
 * ignored before, so a misnamed run id acted on the live run. Other unknown lowercase keys stay ignored, as they were.
 * Then a call missing a required argument is refused naming the keys it did send. Nested values are the handler's to check.
 */
export function refuseMisnamedToolArgs(spec: WorkflowToolArguments, args: Record<string, unknown>): void {
    const accepted = new Set(spec.accepted);
    const keys = Object.keys(args);
    const misnamed = keys.filter(key => !accepted.has(key) && (/[A-Z]/.test(key) || workflowToolArgumentMeant(key, spec.accepted) !== null));
    if (misnamed.length) {
        const words = namesWords(misnamed, key => {
            const meant = workflowToolArgumentMeant(key, spec.accepted);
            if (meant) return `${shownName(key)} (did you mean ${meant}?)`;
            return spec.fieldsGoIn ? `${shownName(key)} (a field of ${spec.fieldsGoIn} goes inside ${spec.fieldsGoIn})` : shownName(key);
        });
        throw new WorkflowStoreError(spec.code, `Use the argument names ${spec.tool} declares (snake_case; its results are camelCase). `
            + `Not ${misnamed.length === 1 ? "an argument" : "arguments"} of ${spec.tool}: ${words}.`);
    }
    const missing = spec.required.find(name => args[name] === undefined || args[name] === null);
    if (missing) {
        throw new WorkflowStoreError(spec.code, `${missing} is required. `
            + (keys.length ? `Received: ${namesWords(keys)}.` : "Received no arguments."));
    }
}
