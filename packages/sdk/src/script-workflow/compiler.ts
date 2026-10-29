import { parseDocument } from "yaml";

export const SCRIPT_WORKFLOW_API_VERSION = "pilotswarm.dev/v1alpha1";
export const SCRIPT_WORKFLOW_KIND = "ScriptWorkflow";
export const SCRIPT_WORKFLOW_MAX_NODES = 100;

export type ScriptRuntime = "node" | "python" | "powershell";

export interface ScriptWorkflowNode {
    id: string;
    runtime: ScriptRuntime;
    source: string;
    next: Record<string, string | null>;
}

export interface CompiledScriptWorkflow {
    name: string;
    entry: string;
    nodes: Record<string, ScriptWorkflowNode>;
}

export class ScriptWorkflowCompileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ScriptWorkflowCompileError";
    }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ScriptWorkflowCompileError(`${path} must be a mapping.`);
    }
    return value as Record<string, unknown>;
}

function requireText(value: unknown, path: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new ScriptWorkflowCompileError(`${path} must be a non-empty string.`);
    }
    return value.trim();
}

function parseNext(value: unknown, path: string, nodeIds: Set<string>): Record<string, string | null> {
    const next = requireRecord(value ?? {}, path);
    const result: Record<string, string | null> = {};
    for (const [outcome, target] of Object.entries(next)) {
        if (!outcome.trim()) throw new ScriptWorkflowCompileError(`${path} has an empty outcome.`);
        if (target === null) {
            result[outcome] = null;
            continue;
        }
        const targetId = requireText(target, `${path}.${outcome}`);
        if (!nodeIds.has(targetId)) {
            throw new ScriptWorkflowCompileError(`${path}.${outcome} references unknown node '${targetId}'.`);
        }
        result[outcome] = targetId;
    }
    return result;
}

/**
 * Compile the deliberately small, script-only workflow language.
 *
 * Each script emits exactly one JSON object on stdout:
 * `{ "outcome": "success", "output": <JSON value> }`.
 * The outcome chooses a key in `next`; `null` ends the workflow.
 */
export function compileScriptWorkflow(yaml: string): CompiledScriptWorkflow {
    if (typeof yaml !== "string" || !yaml.trim()) {
        throw new ScriptWorkflowCompileError("Workflow YAML must be a non-empty string.");
    }

    let parsed: unknown;
    try {
        const document = parseDocument(yaml, { prettyErrors: false });
        if (document.errors.length > 0) {
            throw new ScriptWorkflowCompileError(document.errors[0].message);
        }
        parsed = document.toJS();
    } catch (error) {
        if (error instanceof ScriptWorkflowCompileError) throw error;
        throw new ScriptWorkflowCompileError(`Workflow YAML is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }

    const root = requireRecord(parsed, "workflow");
    if (root.apiVersion !== SCRIPT_WORKFLOW_API_VERSION) {
        throw new ScriptWorkflowCompileError(`apiVersion must be '${SCRIPT_WORKFLOW_API_VERSION}'.`);
    }
    if (root.kind !== SCRIPT_WORKFLOW_KIND) {
        throw new ScriptWorkflowCompileError(`kind must be '${SCRIPT_WORKFLOW_KIND}'.`);
    }

    const metadata = requireRecord(root.metadata, "metadata");
    const spec = requireRecord(root.spec, "spec");
    const rawNodes = requireRecord(spec.nodes, "spec.nodes");
    const entries = Object.entries(rawNodes);
    if (entries.length === 0 || entries.length > SCRIPT_WORKFLOW_MAX_NODES) {
        throw new ScriptWorkflowCompileError(`spec.nodes must contain between 1 and ${SCRIPT_WORKFLOW_MAX_NODES} nodes.`);
    }

    const nodeIds = new Set(entries.map(([id]) => id));
    const entry = requireText(spec.entry, "spec.entry");
    if (!nodeIds.has(entry)) throw new ScriptWorkflowCompileError(`spec.entry references unknown node '${entry}'.`);

    const nodes: Record<string, ScriptWorkflowNode> = {};
    for (const [id, rawNode] of entries) {
        if (!id.trim()) throw new ScriptWorkflowCompileError("spec.nodes has an empty node id.");
        const node = requireRecord(rawNode, `spec.nodes.${id}`);
        if (node.type !== "script") {
            throw new ScriptWorkflowCompileError(`spec.nodes.${id}.type must be 'script'; agent nodes are not supported.`);
        }
        const runtime = requireText(node.runtime, `spec.nodes.${id}.runtime`);
        if (runtime !== "node" && runtime !== "python" && runtime !== "powershell") {
            throw new ScriptWorkflowCompileError(`spec.nodes.${id}.runtime must be node, python, or powershell.`);
        }
        nodes[id] = {
            id,
            runtime,
            source: requireText(node.source, `spec.nodes.${id}.source`),
            next: parseNext(node.next, `spec.nodes.${id}.next`, nodeIds),
        };
    }

    return {
        name: requireText(metadata.name, "metadata.name"),
        entry,
        nodes,
    };
}
