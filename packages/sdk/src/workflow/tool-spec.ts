/**
 * spawn_workflow — the declaration and the per-turn handler both build from
 * this one spec, so the schema the model sees cannot drift from the one the
 * handler accepts. Kept one release (D2); its declaration carries its contract
 * only (owner 2026-11-08T16:55Z).
 */
export const SPAWN_WORKFLOW_TOOL_SPEC = {
    description:
        "Kept for one release; prefer workflow_definition. A version 2 yaml (pilotswarm.dev/v2-draft) is saved as the next revision of "
        + "this chat's definition its metadata.name names; with state: published and start: true that revision also starts. A version 1 "
        + "yaml (pilotswarm.dev/v1alpha1) starts a version 1 Workflow child. key makes a repeated call return the same Workflow. Returns "
        + "the Workflow's session id; its result arrives when it ends unless notify_on_completion is false.",
    parameters: {
        type: "object",
        properties: {
            yaml: { type: "string", description: "The whole Workflow YAML." },
            inputs: { type: "object" },
            notify_on_completion: { type: "boolean", description: "Default true." },
            key: { type: "string", description: "Optional idempotency key." },
            state: { type: "string", enum: ["draft", "published"], description: "v2: draft (default) or published." },
            start: { type: "boolean", description: "v2, with state: published: also start it." },
            vars: { type: "object", description: "v2, with start: the run's initial variables." },
            agent_models: { type: "object", description: "v2, with start: only when the person asks for a model." },
        },
        required: ["yaml"],
    },
} as const;

/** spawn_workflow on a 1.0.83 turn: the same declaration (its handler takes every state the host runs). */
export const SPAWN_WORKFLOW_MILESTONE_TOOL_SPEC = SPAWN_WORKFLOW_TOOL_SPEC;

export interface SpawnWorkflowToolArgs {
    yaml: string;
    inputs?: Record<string, unknown>;
    notify_on_completion?: boolean;
    key?: string;
    /** v2 documents only. */
    state?: "draft" | "published";
    /** v2 documents only, with state: published. */
    start?: boolean;
    /** v2 documents only, with start: the run's initial open KV. */
    vars?: Record<string, unknown>;
    /** v2 documents only, with start (OF-S2-7): agent node models by state id. */
    agent_models?: Record<string, unknown>;
}
