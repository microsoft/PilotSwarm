/**
 * What a model default is for. A default has a `scope` (whose default: the cluster's or a user's) and a `purpose` (what it
 * picks a model for). The `set_model_default` tools, on MCP and in session, take their purposes from this one table and
 * resolve each scope and purpose to a setter through it, so a later purpose (a summarization or regen default) is one
 * more entry here plus the setter it names; a scope a purpose does not list is refused before any write.
 *
 * @module
 */

export type ModelDefaultScope = "cluster" | "user";
export const MODEL_DEFAULT_SCOPES = ["cluster", "user"] as const satisfies readonly ModelDefaultScope[];

/** The management client's setModelDefault scopes, which the tools call; storage and the HTTP API keep these names. */
export type ModelDefaultSetter = "cluster" | "user" | "cluster_decision";

export const MODEL_DEFAULT_PURPOSE_NAMES = ["chat", "decision"] as const;
export type ModelDefaultPurpose = (typeof MODEL_DEFAULT_PURPOSE_NAMES)[number];
export const DEFAULT_MODEL_DEFAULT_PURPOSE: ModelDefaultPurpose = "chat";

export interface ModelDefaultPurposeSpec {
    /** The model catalog the default names: chat models, or Decision models. */
    modelKind: "chat" | "decision";
    /** Whether a reasoning effort and a context tier apply. */
    reasoningAndContext: boolean;
    /** The setter for each scope this purpose has. A scope it lacks is refused: `user` here is the user override. */
    setters: Partial<Record<ModelDefaultScope, ModelDefaultSetter>>;
    /** What the default picks a model for, for the tool descriptions. */
    what: string;
}

export const MODEL_DEFAULT_PURPOSES: Record<ModelDefaultPurpose, ModelDefaultPurposeSpec> = {
    chat: {
        modelKind: "chat",
        reasoningAndContext: true,
        setters: { cluster: "cluster", user: "user" },
        what: "the model of new ordinary sessions",
    },
    decision: {
        modelKind: "decision",
        reasoningAndContext: false,
        setters: { cluster: "cluster_decision" },
        what: "the Cluster Decision Default that Workflow save and Start use, an exact shared Decision model provider:model",
    },
};

/** Whether a user may set their own default for this purpose. */
export function modelDefaultUserOverride(purpose: ModelDefaultPurpose): boolean {
    return MODEL_DEFAULT_PURPOSES[purpose].setters.user !== undefined;
}

/** The purposes for a tool description, one clause each. */
export function modelDefaultPurposesDescription(): string {
    return MODEL_DEFAULT_PURPOSE_NAMES.map(name => {
        const spec = MODEL_DEFAULT_PURPOSES[name];
        const notes = [
            ...(name === DEFAULT_MODEL_DEFAULT_PURPOSE ? ["the default"] : []),
            ...(spec.reasoningAndContext ? [] : ["no reasoning or context"]),
            ...(modelDefaultUserOverride(name) ? [] : ["cluster only"]),
        ];
        return `'${name}': ${spec.what}${notes.length ? ` (${notes.join("; ")})` : ""}`;
    }).join("; ");
}

/**
 * The setter for a scope and purpose (an omitted purpose is chat), or the words that refuse them before any read or
 * write: an unknown scope or purpose, or a scope the purpose has no setter for.
 */
export function modelDefaultSetter(scope: unknown, purpose: unknown): { setter: ModelDefaultSetter } | { refusal: string } {
    if (scope !== "cluster" && scope !== "user") return { refusal: "scope must be cluster or user." };
    const name = purpose ?? DEFAULT_MODEL_DEFAULT_PURPOSE;
    if (typeof name !== "string" || !(MODEL_DEFAULT_PURPOSE_NAMES as readonly string[]).includes(name)) {
        return { refusal: `purpose must be one of: ${MODEL_DEFAULT_PURPOSE_NAMES.join(", ")}.` };
    }
    const setter = MODEL_DEFAULT_PURPOSES[name as ModelDefaultPurpose].setters[scope];
    if (!setter) return { refusal: `There is no ${scope} default for purpose ${name} yet: set it for the cluster (scope cluster).` };
    return { setter };
}
