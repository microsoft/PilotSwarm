/**
 * The workflow engines this worker runs, by the document's `apiVersion`.
 *
 * spawn_workflow and createWorkflowSession read `apiVersion` first and route
 * through this one table. A later engine registers here (for example a v2
 * with its own apiVersion) without changing spawn_workflow; a document for
 * an engine this worker lacks is refused up front with a clear message.
 */
import { parse } from "yaml";
import { compileWorkflow, WORKFLOW_API_VERSION, type CompiledWorkflow } from "./compiler.js";

export interface WorkflowEngine {
    apiVersion: string;
    /** Compile and validate a document of this apiVersion. Throws WorkflowCompileError. */
    compile: (yaml: string) => CompiledWorkflow;
}

/** The routing table: apiVersion → engine. */
export const WORKFLOW_ENGINES: ReadonlyMap<string, WorkflowEngine> = new Map([
    [WORKFLOW_API_VERSION, { apiVersion: WORKFLOW_API_VERSION, compile: (yaml: string) => compileWorkflow(yaml) }],
]);

export const WORKFLOW_API_VERSION_UNSUPPORTED = "WORKFLOW_API_VERSION_UNSUPPORTED";

const TOP_LEVEL_API_VERSION = /^apiVersion[ \t]*:[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^#\n]*?))[ \t]*(?:#.*)?$/m;

/**
 * The document's top-level `apiVersion`, read without compiling it: from a
 * top-level `apiVersion:` line, or else from a plain YAML parse.
 * `malformed` when the document cannot be parsed at all.
 */
export function readWorkflowApiVersion(yaml: unknown): { apiVersion: string | null; malformed?: true } {
    if (typeof yaml !== "string") return { apiVersion: null, malformed: true };
    const line = TOP_LEVEL_API_VERSION.exec(yaml);
    if (line) {
        const value = (line[1] ?? line[2] ?? line[3] ?? "").trim();
        return { apiVersion: value || null };
    }
    try {
        const root = parse(yaml);
        const value = root && typeof root === "object" && !Array.isArray(root) ? (root as Record<string, unknown>).apiVersion : undefined;
        return { apiVersion: typeof value === "string" && value.trim() ? value.trim() : null };
    } catch {
        return { apiVersion: null, malformed: true };
    }
}

export type WorkflowEngineRoute =
    | { ok: true; engine: WorkflowEngine }
    | { ok: false; code: typeof WORKFLOW_API_VERSION_UNSUPPORTED; message: string };

/**
 * The engine for a document. A document that cannot be parsed goes to the
 * current engine, so its compiler reports the error as before.
 */
export function routeWorkflowApiVersion(yaml: unknown): WorkflowEngineRoute {
    const { apiVersion, malformed } = readWorkflowApiVersion(yaml);
    const current = WORKFLOW_ENGINES.get(WORKFLOW_API_VERSION)!;
    if (malformed) return { ok: true, engine: current };
    const engine = apiVersion ? WORKFLOW_ENGINES.get(apiVersion) : undefined;
    if (engine) return { ok: true, engine };
    return {
        ok: false,
        code: WORKFLOW_API_VERSION_UNSUPPORTED,
        message: `This worker does not support workflow apiVersion ${apiVersion ?? "(missing)"}. `
            + `Supported: ${[...WORKFLOW_ENGINES.keys()].join(", ")}.`,
    };
}
