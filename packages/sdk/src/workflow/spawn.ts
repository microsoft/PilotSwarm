import { randomUUID } from "node:crypto";
import { systemChildAgentUUID } from "../agent-loader.js";
import type { WorkflowSessionConfig, SessionOwnerInfo } from "../types.js";
import { WORKFLOW_SCRIPTS_DISABLED_MESSAGE } from "./activities.js";
import { compileWorkflow, validateWorkflowInputs, validateNodeWorkflowAdmission } from "./compiler.js";
import type { WorkflowToolBinding } from "./tool-policy.js";
import { isWorkflowParentContextUnavailable, WORKFLOW_PARENT_CONTEXT_UNAVAILABLE, WORKFLOW_PARENT_CONTEXT_UNAVAILABLE_MESSAGE } from "./tool-policy.js";
import type { SpawnWorkflowToolArgs } from "./tool-spec.js";
import { declaresWorkflowV2 } from "./v2/compiler.js";
import { sanitizeWorkflowErrorText } from "./v2/failure.js";
import { workflowDefinitionToolsRefusal } from "./v2/input-policy.js";
import { spawnWorkflowV2FromTool, workflowToolErrorPayload, type WorkflowToolHost } from "./v2/tools.js";

export interface SpawnWorkflowDeps {
    /** The agent session calling spawn_workflow; it becomes the workflow's parent. */
    parentSessionId: string;
    enabled: () => boolean;
    getSession: (sessionId: string) => Promise<{ title?: string | null; state?: string | null } | null>;
    resolveOwner: () => Promise<SessionOwnerInfo | null>;
    captureToolBinding: () => Promise<WorkflowToolBinding>;
    createWorkflowSession: (config: WorkflowSessionConfig & { notifyParent?: boolean }, binding: WorkflowToolBinding) => Promise<{ sessionId: string; workflowName: string }>;
    /** Workflow v2 persistence and dispatch (drafts, publication, runs). Absent: v2 documents are refused. */
    workflowV2Host?: () => Promise<WorkflowToolHost>;
    /**
     * A1 (Workflow Simplified, spec 14): whether the calling session is inside a Workflow (an agent node's chat or one
     * of its sub-agents), by its stored lineage; then every spawn_workflow is refused, in words. Absent: never refused.
     */
    definitionToolsRefused?: () => Promise<boolean>;
}

/**
 * The workflow child's session id. The same key in the same parent always
 * gives the same id; without a key the tool call id is used, so each call is
 * a new run while a re-sent call is not.
 */
export function workflowChildSessionId(parentSessionId: string, key: string | undefined, toolCallId: string | undefined): string {
    const slug = typeof key === "string" && key.trim()
        ? `key:${key.trim()}`
        : `call:${toolCallId || randomUUID()}`;
    return systemChildAgentUUID(parentSessionId, `workflow:${slug}`);
}

/**
 * spawn_workflow, behind the inline control bridge. Every outcome is a
 * `[SYSTEM: ...]` line for the model; nothing here throws into the turn.
 */
export async function spawnWorkflowFromTool(
    args: SpawnWorkflowToolArgs,
    call: { toolCallId?: string } | undefined,
    deps: SpawnWorkflowDeps,
): Promise<string> {
    try {
        if (!deps.enabled()) {
            return `[SYSTEM: spawn_workflow refused — ${WORKFLOW_SCRIPTS_DISABLED_MESSAGE}]`;
        }
        if (deps.definitionToolsRefused && await deps.definitionToolsRefused()) {
            let v2 = false;
            try { v2 = declaresWorkflowV2(args.yaml); } catch { /* answered as a version 1 document */ }
            return workflowDefinitionToolsRefusal("spawn_workflow", { line: !v2 });
        }
        if (declaresWorkflowV2(args.yaml)) {
            if (!deps.workflowV2Host) return JSON.stringify({ ok: false, error: { code: "WORKFLOW_V2_UNAVAILABLE", message: "This worker cannot store v2 workflows." } });
            const slug = typeof args.key === "string" && args.key.trim() ? `key:${args.key.trim()}` : `call:${call?.toolCallId ?? ""}`;
            if (slug === "call:") return JSON.stringify({ ok: false, error: { code: "WORKFLOW_COMMAND_INVALID", message: "spawn_workflow needs a key or a tool call id." } });
            const owner = await deps.resolveOwner();
            let binding: WorkflowToolBinding;
            try {
                binding = await deps.captureToolBinding();
            } catch (error) {
                if (!isWorkflowParentContextUnavailable(error)) throw error;
                return JSON.stringify({ ok: false, error: { code: WORKFLOW_PARENT_CONTEXT_UNAVAILABLE, message: WORKFLOW_PARENT_CONTEXT_UNAVAILABLE_MESSAGE } });
            }
            return spawnWorkflowV2FromTool(args, {
                callerSessionId: deps.parentSessionId,
                workflowSessionId: workflowChildSessionId(deps.parentSessionId, args.key, call?.toolCallId),
                operationId: `spawn:${slug}`,
                owner,
                binding,
                host: await deps.workflowV2Host(),
            });
        }
        if (args.state !== undefined || args.start !== undefined || args.vars !== undefined) {
            return "[SYSTEM: spawn_workflow refused — state, start and vars apply to apiVersion pilotswarm.dev/v2-draft workflows only.]";
        }
        let workflowName: string;
        try {
            const compiled = compileWorkflow(args.yaml, { allowOutcomeDelay: true });
            validateNodeWorkflowAdmission(compiled);
            validateWorkflowInputs(compiled, args.inputs ?? {});
            workflowName = compiled.name;
        } catch (error) {
            // Re-check S-SF-F4: the reason, sanitized as every workflow failure's is (no URL or secret value, one line, bounded).
            return `[SYSTEM: spawn_workflow refused — the workflow is not valid: ${sanitizeWorkflowErrorText(error) || "no reason was given"} `
                + "Fix it and call spawn_workflow again.]";
        }
        const workflowSessionId = workflowChildSessionId(deps.parentSessionId, args.key, call?.toolCallId);
        const existing = await deps.getSession(workflowSessionId);
        const owner = await deps.resolveOwner().catch(() => null);
        const notify = args.notify_on_completion !== false;
        const binding = await deps.captureToolBinding();
        await deps.createWorkflowSession({
            sessionId: workflowSessionId,
            yaml: args.yaml,
            inputs: args.inputs ?? {},
            parentSessionId: deps.parentSessionId,
            ...(owner ? { owner } : {}),
            notifyParent: notify,
        }, binding);
        if (existing && existing.state !== "pending") {
            return `[SYSTEM: spawn_workflow found the existing workflow session ${workflowSessionId} for this key `
                + `("${existing.title ?? workflowName}", state ${existing.state ?? "unknown"}). Nothing new was started; pass a different key for another run.]`;
        }
        return `[SYSTEM: started workflow session ${workflowSessionId} running "${workflowName}". `
            + (notify
                ? "You will receive its result as a system message when it ends; do not poll for it. "
                : "You will not be told when it ends; check it with read_session_info or list_sessions. ")
            + "The user can follow each step in the portal, under this session.]";
    } catch (error) {
        if (isWorkflowParentContextUnavailable(error)) {
            return `[SYSTEM: spawn_workflow refused (${WORKFLOW_PARENT_CONTEXT_UNAVAILABLE}) — ${WORKFLOW_PARENT_CONTEXT_UNAVAILABLE_MESSAGE}]`;
        }
        // Adversarial review R2-SF-4: never an error's own text. A v2 document's failure (its owner, its tool binding or its
        // host could not be had) is the v2 tools' coded answer, its secrets hidden; a v1 one keeps its sentence, its message
        // sanitized the same way.
        let v2 = false;
        try { v2 = declaresWorkflowV2(args.yaml); } catch { /* a v1 answer */ }
        if (v2) return workflowToolErrorPayload(error);
        return `[SYSTEM: spawn_workflow failed — ${sanitizeWorkflowErrorText(error) || "no reason was given"}]`;
    }
}
