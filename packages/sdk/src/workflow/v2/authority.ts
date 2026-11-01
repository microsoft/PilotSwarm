import type { SessionCatalog, SessionRow } from "../../cms.js";
import type { WorkflowStore } from "./store.js";

/**
 * Who may give a workflow v2 run typed input (send_workflow_input), and who a
 * receive state may name as its sender. One rule serves both:
 * - the workflow's parent (trusted lineage) may;
 * - another session may unless it crosses a user ownership boundary: both
 *   sessions owned by users, and by different users. Session messages only
 *   annotate such a crossing; typed input refuses it, because no grant
 *   mechanism for cross-owner input exists in this release (T067). System
 *   and unowned sessions are deployment infrastructure, as in session
 *   messages, and never cross it;
 * - a session that does not exist, or was deleted, may not.
 * A session id is never permission by itself: the sender is the session the
 * runtime names as the caller, never a field of the request.
 */
export type TypedInputAuthority = "allowed" | "unknown" | "cross_owner";

/** A comparable key for a session's user owner, or null for system and unowned sessions. */
export function userOwnerKey(row: Pick<SessionRow, "isSystem" | "owner"> | null | undefined): string | null {
    if (!row || row.isSystem) return null;
    const provider = String(row.owner?.provider || "").trim();
    const subject = String(row.owner?.subject || "").trim();
    return provider && subject ? `${provider}\u0000${subject}` : null;
}

export async function typedInputAuthority(
    catalog: Pick<SessionCatalog, "getSession">,
    store: Pick<WorkflowStore, "readDefinition">,
    workflowSessionId: string,
    senderSessionId: string,
): Promise<TypedInputAuthority> {
    const [workflow, sender, definition] = await Promise.all([
        catalog.getSession(workflowSessionId), catalog.getSession(senderSessionId), store.readDefinition(workflowSessionId),
    ]);
    if (!workflow || workflow.deletedAt || workflow.sessionKind !== "workflow" || !sender || sender.deletedAt || !definition) return "unknown";
    if (definition.parentSessionId === senderSessionId) return "allowed";
    const senderOwner = userOwnerKey(sender);
    const workflowOwner = userOwnerKey(workflow);
    return senderOwner && workflowOwner && senderOwner !== workflowOwner ? "cross_owner" : "allowed";
}
