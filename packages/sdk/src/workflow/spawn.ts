import type { SessionOwnerInfo } from "../types.js";
import type { WorkflowToolBinding } from "./tool-policy.js";
import { isWorkflowParentContextUnavailable, WORKFLOW_PARENT_CONTEXT_UNAVAILABLE, WORKFLOW_PARENT_CONTEXT_UNAVAILABLE_MESSAGE } from "./tool-policy.js";
import type { SpawnWorkflowToolArgs } from "./tool-spec.js";
import { declaresWorkflow, WORKFLOW_API_VERSION } from "./compiler.js";
import { sha256Hex } from "./json.js";
import { workflowDefinitionToolsRefusal } from "./input-policy.js";
import { workflowToolErrorPayload, type WorkflowToolHost } from "./tools.js";
import { spawnWorkflowCompatFromTool } from "./definition-tool.js";
import { WorkflowStoreError } from "./store.js";
import { requireWorkflowScriptsInYaml } from "./scripts-gate.js";

export interface SpawnWorkflowDeps {
    /** The agent session calling spawn_workflow; it becomes the workflow's parent. */
    parentSessionId: string;
    /** Stage 2.4: its nesting level (spawn_agent's depth limit applies to a Workflow it starts). */
    nestingLevel?: number | null;
    enabled: () => boolean;
    resolveOwner: () => Promise<SessionOwnerInfo | null>;
    captureToolBinding: () => Promise<WorkflowToolBinding>;
    /** Workflow persistence and dispatch (definitions, revisions, runs). Absent: every document is refused. */
    workflowHost?: () => Promise<WorkflowToolHost>;
    /**
     * A1 (Workflow Simplified, spec 14): whether the calling session is inside a Workflow (an agent node's session or one
     * of its sub-agents), by its stored lineage; then every spawn_workflow is refused, in words. Absent: never refused.
     */
    definitionToolsRefused?: () => Promise<boolean>;
}

/** The refusal of a document in any other format: its code, and the one apiVersion a Workflow takes. */
export const WORKFLOW_API_VERSION_REFUSED = "WORKFLOW_API_VERSION";
export const WORKFLOW_API_VERSION_REFUSAL_TEXT = `A Workflow's YAML must say apiVersion: ${WORKFLOW_API_VERSION}. `
    + "No other format is taken, and there is no converter: write the Workflow in this format and call spawn_workflow again.";

/**
 * spawn_workflow, behind the inline control bridge. Every outcome is the
 * workflow tools' JSON answer for the model; nothing here throws into the turn.
 */
export async function spawnWorkflowFromTool(
    args: SpawnWorkflowToolArgs,
    call: { toolCallId?: string } | undefined,
    deps: SpawnWorkflowDeps,
): Promise<string> {
    try {
        // A1: inside a Workflow no definition tool works at all; it reads only the stored lineage.
        if (deps.definitionToolsRefused && await deps.definitionToolsRefused()) return workflowDefinitionToolsRefusal();
        if (!declaresWorkflow(args.yaml)) {
            return JSON.stringify({ ok: false, error: { code: WORKFLOW_API_VERSION_REFUSED, message: WORKFLOW_API_VERSION_REFUSAL_TEXT } });
        }
        // The scripts gate from the YAML alone, on this worker's setting (deps.enabled), before the host is made, the owner or
        // the tool binding is read, or anything else (e02ec6f8 run).
        requireWorkflowScriptsInYaml(deps.enabled(), args.yaml, args.start === true ? "start" : "save");
        if (!deps.workflowHost) return JSON.stringify({ ok: false, error: { code: "WORKFLOW_UNAVAILABLE", message: "This worker cannot store Workflows." } });
        const slug = typeof args.key === "string" && args.key.trim() ? `key:${args.key.trim()}` : `call:${call?.toolCallId ?? ""}`;
        if (slug === "call:") return JSON.stringify({ ok: false, error: { code: "WORKFLOW_COMMAND_INVALID", message: "spawn_workflow needs a key or a tool call id." } });
        // Stage 2.1 (D2): spawn_workflow saves a revision of the session's definition of this name and, with start, starts
        // that revision (definition-tool.ts). The scripts gate decides first there (d52e5ed2); the session's owner and tool
        // binding are read after it, and only for a start.
        // The operation is the key (or the call) and the YAML (aa5bb84a run, coordinator 07:1xZ): an exact repeat is
        // answered from its receipt, and a corrected YAML under the same key is a new save (the next revision) and a new
        // start, not a conflict with the first.
        return await spawnWorkflowCompatFromTool(args, {
            callerSessionId: deps.parentSessionId,
            nestingLevel: deps.nestingLevel ?? null,
            operationId: `spawn:${slug}:${sha256Hex(String(args.yaml)).slice(0, 32)}`,
            owner: () => deps.resolveOwner(),
            binding: async () => {
                try {
                    return await deps.captureToolBinding();
                } catch (error) {
                    if (!isWorkflowParentContextUnavailable(error)) throw error;
                    throw new WorkflowStoreError(WORKFLOW_PARENT_CONTEXT_UNAVAILABLE, WORKFLOW_PARENT_CONTEXT_UNAVAILABLE_MESSAGE);
                }
            },
            host: await deps.workflowHost(),
        });
    } catch (error) {
        if (isWorkflowParentContextUnavailable(error)) {
            return `[SYSTEM: spawn_workflow refused (${WORKFLOW_PARENT_CONTEXT_UNAVAILABLE}) — ${WORKFLOW_PARENT_CONTEXT_UNAVAILABLE_MESSAGE}]`;
        }
        // Adversarial review R2-SF-4: never an error's own text. A failure (its owner, its tool binding or its host could not
        // be had) is the workflow tools' coded answer, its secrets hidden.
        return workflowToolErrorPayload(error);
    }
}
