import { randomUUID } from "node:crypto";
import { systemChildAgentUUID } from "../agent-loader.js";
import type { WorkflowSessionConfig, SessionOwnerInfo } from "../types.js";
import { WORKFLOW_SCRIPTS_DISABLED_MESSAGE } from "./activities.js";
import { compileWorkflow, validateWorkflowInputs } from "./compiler.js";
import type { SpawnWorkflowToolArgs } from "./tool-spec.js";

export interface SpawnWorkflowDeps {
    /** The agent session calling spawn_workflow; it becomes the workflow's parent. */
    parentSessionId: string;
    enabled: () => boolean;
    getSession: (sessionId: string) => Promise<{ title?: string | null; state?: string | null } | null>;
    resolveOwner: () => Promise<SessionOwnerInfo | null>;
    createWorkflowSession: (config: WorkflowSessionConfig & { notifyParent?: boolean }) => Promise<{ sessionId: string; workflowName: string }>;
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
        let workflowName: string;
        try {
            const compiled = compileWorkflow(args.yaml);
            validateWorkflowInputs(compiled, args.inputs ?? {});
            workflowName = compiled.name;
        } catch (error) {
            return `[SYSTEM: spawn_workflow refused — the workflow is not valid: ${error instanceof Error ? error.message : String(error)} `
                + "Fix it and call spawn_workflow again.]";
        }
        const workflowSessionId = workflowChildSessionId(deps.parentSessionId, args.key, call?.toolCallId);
        const existing = await deps.getSession(workflowSessionId).catch(() => null);
        if (existing) {
            return `[SYSTEM: spawn_workflow found the existing workflow session ${workflowSessionId} for this key `
                + `("${existing.title ?? workflowName}", state ${existing.state ?? "unknown"}). Nothing new was started; pass a different key for another run.]`;
        }
        const owner = await deps.resolveOwner().catch(() => null);
        const notify = args.notify_on_completion !== false;
        await deps.createWorkflowSession({
            sessionId: workflowSessionId,
            yaml: args.yaml,
            inputs: args.inputs ?? {},
            parentSessionId: deps.parentSessionId,
            ...(owner ? { owner } : {}),
            notifyParent: notify,
        });
        return `[SYSTEM: started workflow session ${workflowSessionId} running "${workflowName}". `
            + (notify
                ? "You will receive its result as a system message when it ends; do not poll for it. "
                : "You will not be told when it ends; check it with read_session_info or list_sessions. ")
            + "The user can follow each step in the portal, under this session.]";
    } catch (error) {
        return `[SYSTEM: spawn_workflow failed — ${error instanceof Error ? error.message : String(error)}]`;
    }
}
