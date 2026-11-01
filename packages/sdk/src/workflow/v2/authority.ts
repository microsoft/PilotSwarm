import type { SessionCatalog, SessionRow } from "../../cms.js";
import type { WorkflowStore } from "./store.js";

/**
 * Who may give a workflow v2 run typed input (send_workflow_input), and who
 * a receive state may name as its sender. One rule serves both, and it fails
 * closed:
 * - the workflow session must exist and be live, and so must the sender;
 *   otherwise "unavailable";
 * - the workflow's trusted parent may: the sender is the parent in both the
 *   workflow's session row and its definition, and is live;
 * - any other sender may only when both sessions are owned by a user and by
 *   the same user: provider and subject present, not blank and exactly
 *   equal, and neither session a system session. Unknown, partial, blank or
 *   system ownership on either side grants nothing ("forbidden"), and so
 *   does another user's ownership (T067). This release has no explicit grant
 *   for other senders (infrastructure included).
 * A session id is never permission by itself: the sender is the session the
 * runtime names as the caller, never a field of the request.
 */
export type TypedInputAuthority = "allowed" | "unavailable" | "forbidden";

/**
 * A comparable key for a session's user owner, or null for system, unowned,
 * partly owned and blank-owned sessions. The key is the exact stored provider
 * and subject, untrimmed: two sessions have the same owner only when both
 * strings are equal.
 */
export function userOwnerKey(row: Pick<SessionRow, "isSystem" | "owner"> | null | undefined): string | null {
    if (!row || row.isSystem) return null;
    const provider = row.owner?.provider;
    const subject = row.owner?.subject;
    if (typeof provider !== "string" || typeof subject !== "string" || !provider.trim() || !subject.trim()) return null;
    return JSON.stringify([provider, subject]);
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
    if (!workflow || workflow.deletedAt || workflow.sessionKind !== "workflow" || !definition) return "unavailable";
    if (!sender || sender.deletedAt) return "unavailable";
    if (workflow.parentSessionId === senderSessionId && definition.parentSessionId === senderSessionId) return "allowed";
    const senderOwner = userOwnerKey(sender);
    const workflowOwner = userOwnerKey(workflow);
    return senderOwner !== null && workflowOwner !== null && senderOwner === workflowOwner ? "allowed" : "forbidden";
}
