import type { WorkflowDefinitionSource } from "./types.js";

export const WORKFLOW_TOOLS_MIN_ORCHESTRATION_VERSION = "1.0.81";

export const SPAWN_WORKFLOW_TOOL_SPEC = {
    description:
        "Start a registered workflow as a child of this session. " +
        "The workflow starts asynchronously at the durable turn boundary, and its workflow_session_id is returned in the follow-up context.",
    parameters: {
        type: "object",
        properties: {
            definition: {
                type: "object",
                description: "Workflow definition source.",
                properties: {
                    kind: {
                        type: "string",
                        enum: ["registered"],
                        description: "Registered workflows are immutable definitions previously published from source control.",
                    },
                    definition_id: {
                        type: "string",
                        description: "Immutable registered workflow definition ID.",
                    },
                },
                required: ["kind", "definition_id"],
            },
            inputs: {
                type: "object",
                description: "JSON inputs passed unchanged to the workflow controller.",
            },
        },
        required: ["definition"],
    },
} as const;

export const CHECK_WORKFLOWS_TOOL_SPEC = {
    description:
        "Check workflow children started by this conversation. " +
        "Returns current status and any terminal results already written by their workflow controllers.",
    parameters: {
        type: "object",
        properties: {
            workflow_ids: {
                type: "array",
                items: { type: "string" },
                description: "Optional workflow session IDs to check. If omitted, checks every tracked workflow.",
            },
        },
    },
} as const;

export const WAIT_FOR_WORKFLOWS_TOOL_SPEC = {
    description:
        "Suspend this conversation until all selected workflow children return terminal results. " +
        "If workflow_ids is omitted, waits for every currently running workflow started by this conversation.",
    parameters: {
        type: "object",
        properties: {
            workflow_ids: {
                type: "array",
                items: { type: "string" },
                description: "Optional workflow session IDs to wait for. If omitted, waits for all running workflows.",
            },
        },
    },
} as const;

export type SpawnWorkflowToolArgs = {
    definition?: {
        kind?: unknown;
        definition_id?: unknown;
    };
    inputs?: unknown;
};

export function parseSpawnWorkflowToolArgs(args: SpawnWorkflowToolArgs):
    | { ok: true; definition: WorkflowDefinitionSource; inputs: Record<string, unknown> }
    | { ok: false; error: string } {
    const raw = args?.definition;
    if (!raw || typeof raw !== "object") {
        return { ok: false, error: "definition is required." };
    }
    if (raw.kind === "registered") {
        const definitionId = typeof raw.definition_id === "string"
            ? raw.definition_id.trim()
            : "";
        if (!definitionId) {
            return {
                ok: false,
                error: "definition_id is required when definition.kind is registered.",
            };
        }
        return {
            ok: true,
            definition: { kind: "registered", definitionId },
            inputs: isRecord(args.inputs) ? args.inputs : {},
        };
    }
    return { ok: false, error: "definition.kind must be registered." };
}

export function orchestrationSupportsWorkflowTools(version: unknown): boolean {
    const parse = (value: unknown) => {
        const match = typeof value === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim()) : null;
        return match ? match.slice(1).map(Number) : null;
    };
    const have = parse(version);
    const need = parse(WORKFLOW_TOOLS_MIN_ORCHESTRATION_VERSION)!;
    if (!have) return true;
    for (let index = 0; index < 3; index += 1) {
        if (have[index] !== need[index]) return have[index] > need[index];
    }
    return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
