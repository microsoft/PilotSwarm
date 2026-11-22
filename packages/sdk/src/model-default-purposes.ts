/**
 * What a model default is for. A default has a `scope` (whose default: the cluster's or a user's) and a `purpose` (what it
 * picks a model for). The `set_model_default` tools, on MCP and in session, take their purposes from this one table, so
 * a later purpose (a summarization or regen default) is one more entry here plus the setter it maps to.
 *
 * @module
 */

export type ModelDefaultScope = "cluster" | "user";
export const MODEL_DEFAULT_SCOPES: readonly ModelDefaultScope[] = ["cluster", "user"];

export interface ModelDefaultPurposeSpec {
    /** The model catalog the default names: chat models, or Decision models. */
    modelKind: "chat" | "decision";
    /** Whether a user may set their own default for this purpose (scope `user`). */
    userOverride: boolean;
    /** Whether a reasoning effort and a context tier apply. */
    reasoningAndContext: boolean;
    /** One line for the tool descriptions. */
    summary: string;
}

export const MODEL_DEFAULT_PURPOSES = {
    chat: {
        modelKind: "chat",
        userOverride: true,
        reasoningAndContext: true,
        summary: "'chat' (the default): the model of new ordinary sessions",
    },
    decision: {
        modelKind: "decision",
        userOverride: false,
        reasoningAndContext: false,
        summary: "'decision': the Cluster Decision Default that Workflow save and Start use, an exact shared Decision model "
            + "provider:model with no reasoning or context (cluster only)",
    },
} as const satisfies Record<string, ModelDefaultPurposeSpec>;

export type ModelDefaultPurpose = keyof typeof MODEL_DEFAULT_PURPOSES;
export const MODEL_DEFAULT_PURPOSE_NAMES = Object.keys(MODEL_DEFAULT_PURPOSES) as ModelDefaultPurpose[];
export const DEFAULT_MODEL_DEFAULT_PURPOSE: ModelDefaultPurpose = "chat";

/** The purposes for a tool description, one clause each. */
export function modelDefaultPurposesDescription(): string {
    return MODEL_DEFAULT_PURPOSE_NAMES.map(name => MODEL_DEFAULT_PURPOSES[name].summary).join("; ");
}

/**
 * Why a scope and purpose cannot be set, in words for the caller, or null when they can. Checked before any read or
 * write: an unknown scope or purpose, and a user default for a purpose users cannot set yet.
 */
export function modelDefaultTargetRefusal(scope: unknown, purpose: unknown): string | null {
    if (scope !== "cluster" && scope !== "user") return "scope must be cluster or user.";
    const name = purpose ?? DEFAULT_MODEL_DEFAULT_PURPOSE;
    if (typeof name !== "string" || !Object.hasOwn(MODEL_DEFAULT_PURPOSES, name)) {
        return `purpose must be one of: ${MODEL_DEFAULT_PURPOSE_NAMES.join(", ")}.`;
    }
    if (scope === "user" && !MODEL_DEFAULT_PURPOSES[name as ModelDefaultPurpose].userOverride) {
        return `There is no user default for purpose ${name} yet: set it for the cluster (scope cluster).`;
    }
    return null;
}
