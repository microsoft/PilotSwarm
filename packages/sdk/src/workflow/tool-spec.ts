/**
 * spawn_workflow — the declaration and the per-turn handler both build from
 * this one spec, so the schema the model sees cannot drift from the one the
 * handler accepts. Kept one release (D2); its declaration carries its contract
 * only (owner 2026-11-08T16:55Z).
 */
export const SPAWN_WORKFLOW_TOOL_SPEC = {
    description:
        "Kept for one release; prefer workflow_definition. The yaml (apiVersion pilotswarm.dev/v1) is saved as the next revision of "
        + "this session's definition its metadata.name names; with state: published and start: true that revision also starts. "
        + "key makes a repeated call return the same Workflow. Returns the Workflow's session id; its result arrives when it ends unless "
        + "notify_on_completion is false.",
    parameters: {
        type: "object",
        properties: {
            yaml: { type: "string", description: "The whole Workflow YAML." },
            inputs: { type: "object", description: "With start: the run's inputs." },
            notify_on_completion: { type: "boolean", description: "Default true." },
            key: { type: "string", description: "Optional idempotency key." },
            state: { type: "string", enum: ["draft", "published"], description: "draft (default) or published." },
            start: { type: "boolean", description: "With state: published: also start it." },
            vars: { type: "object", description: "With start: the run's initial variables." },
            agent_models: { type: "object", description: "With start: only when the person asks for a model." },
        },
        required: ["yaml"],
    },
} as const;

/** spawn_workflow on a 1.0.83 turn: the same declaration (its handler takes every state the host runs). */
export const SPAWN_WORKFLOW_MILESTONE_TOOL_SPEC = SPAWN_WORKFLOW_TOOL_SPEC;

export interface SpawnWorkflowToolArgs {
    yaml: string;
    /** With start: the run's inputs. */
    inputs?: Record<string, unknown>;
    notify_on_completion?: boolean;
    key?: string;
    state?: "draft" | "published";
    /** With state: published. */
    start?: boolean;
    /** With start: the run's initial open KV. */
    vars?: Record<string, unknown>;
    /** With start (OF-S2-7): agent node models by state id. */
    agent_models?: Record<string, unknown>;
}
