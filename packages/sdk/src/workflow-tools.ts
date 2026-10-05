import type { WorkflowDefinitionSource } from "./types.js";

export const WORKFLOW_TOOLS_MIN_ORCHESTRATION_VERSION = "1.0.81";

export const SPAWN_WORKFLOW_TOOL_SPEC = {
    description:
        "Start a controller-backed workflow as a child of this session. " +
        "The workflow starts asynchronously at the durable turn boundary, and its workflow_session_id is returned in the follow-up context. " +
        "Use a package reference for a published workflow or inline YAML while developing a workflow.",
    parameters: {
        type: "object",
        properties: {
            definition: {
                type: "object",
                description: "Workflow definition source.",
                properties: {
                    kind: {
                        type: "string",
                        enum: ["package", "inline"],
                        description: "Use package for a published workflow or inline for YAML supplied in this call.",
                    },
                    package_name: { type: "string", description: "Package containing the workflow. Required when kind is package." },
                    workflow_name: { type: "string", description: "Workflow name within the package. Required when kind is package." },
                    version: { type: "string", description: "Optional package workflow version." },
                    yaml: { type: "string", description: "Inline workflow YAML. Required when kind is inline." },
                },
                required: ["kind"],
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
        package_name?: unknown;
        workflow_name?: unknown;
        version?: unknown;
        yaml?: unknown;
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
    if (raw.kind === "package") {
        const packageName = typeof raw.package_name === "string" ? raw.package_name.trim() : "";
        const workflowName = typeof raw.workflow_name === "string" ? raw.workflow_name.trim() : "";
        if (!packageName || !workflowName) {
            return { ok: false, error: "package_name and workflow_name are required when definition.kind is package." };
        }
        const version = typeof raw.version === "string" ? raw.version.trim() : "";
        return {
            ok: true,
            definition: {
                kind: "package",
                packageName,
                workflowName,
                ...(version ? { version } : {}),
            },
            inputs: isRecord(args.inputs) ? args.inputs : {},
        };
    }
    if (raw.kind === "inline") {
        const yaml = typeof raw.yaml === "string" ? raw.yaml.trim() : "";
        if (!yaml) {
            return { ok: false, error: "yaml is required when definition.kind is inline." };
        }
        return {
            ok: true,
            definition: { kind: "inline", yaml },
            inputs: isRecord(args.inputs) ? args.inputs : {},
        };
    }
    return { ok: false, error: "definition.kind must be package or inline." };
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
