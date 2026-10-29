import { parseDocument } from "yaml";

export const SCRIPT_WORKFLOW_API_VERSION = "pilotswarm.dev/v1alpha1";
export const SCRIPT_WORKFLOW_KIND = "ScriptWorkflow";
export const SCRIPT_WORKFLOW_MAX_NODES = 100;
export const SCRIPT_NODE_DEFAULT_TIMEOUT_SECONDS = 300;
export const SCRIPT_NODE_MAX_TIMEOUT_SECONDS = 3_600;
export const SCRIPT_WORKFLOW_MAX_YAML_BYTES = 256 * 1024;
const NODE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export type ScriptRuntime = "node" | "python" | "powershell";

export interface ScriptWorkflowNode {
    id: string;
    runtime: ScriptRuntime;
    source: string;
    timeoutSeconds: number;
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

function parseTimeout(value: unknown, path: string): number {
    if (value === undefined || value === null) return SCRIPT_NODE_DEFAULT_TIMEOUT_SECONDS;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > SCRIPT_NODE_MAX_TIMEOUT_SECONDS) {
        throw new ScriptWorkflowCompileError(`${path} must be an integer from 1 to ${SCRIPT_NODE_MAX_TIMEOUT_SECONDS}.`);
    }
    return value;
}

/**
 * Compile the deliberately small, script-only workflow language.
 *
 * Every node runs one script. The script reports an outcome (see the runner
 * for the result protocol); the outcome chooses a key in `next`, and a
 * `null` target ends the workflow with that outcome.
 */
export function compileScriptWorkflow(yaml: string): CompiledScriptWorkflow {
    if (typeof yaml !== "string" || !yaml.trim()) {
        throw new ScriptWorkflowCompileError("Workflow YAML must be a non-empty string.");
    }
    if (Buffer.byteLength(yaml, "utf8") > SCRIPT_WORKFLOW_MAX_YAML_BYTES) {
        throw new ScriptWorkflowCompileError(`Workflow YAML must be at most ${SCRIPT_WORKFLOW_MAX_YAML_BYTES} bytes.`);
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
        if (!NODE_ID_PATTERN.test(id)) {
            throw new ScriptWorkflowCompileError(`spec.nodes.${id} must use a letter followed by up to 63 letters, digits, '_' or '-'.`);
        }
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
            timeoutSeconds: parseTimeout(node.timeoutSeconds, `spec.nodes.${id}.timeoutSeconds`),
            next: parseNext(node.next, `spec.nodes.${id}.next`, nodeIds),
        };
    }

    return {
        name: requireText(metadata.name, "metadata.name"),
        entry,
        nodes,
    };
}
