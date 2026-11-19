import type { SessionCatalog, SessionRow } from "../cms.js";
import type { WorkflowStore } from "./store.js";

/**
 * Who may give a workflow run typed input (send_workflow_input), and who
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
 *
 * For a fresh input and for a receive's admission, the decision that
 * counts is the store's: it is made in the transaction that accepts the
 * input (store.acceptInput) or admits the receive (store.enterNode), on the
 * session rows it locks (decideTypedInputAuthority), so a sender deleted
 * before that transaction is refused. typedInputAuthority applies the same
 * rule to the catalog's rows: send_workflow_input refuses earlier with it,
 * and it alone decides whether a repeat of an accepted input is answered.
 */
export type TypedInputAuthority = "allowed" | "unavailable" | "forbidden";

/** What the rule reads about one session. */
export interface AuthoritySession {
    deleted: boolean;
    isSystem: boolean;
    sessionKind: string | null;
    parentSessionId: string | null;
    owner: { provider?: string | null; subject?: string | null } | null;
}

/** The error text of each refusal, the same for the catalog's check and the store's. */
export const TYPED_INPUT_REFUSALS: Readonly<Record<Exclude<TypedInputAuthority, "allowed">, string>> = {
    unavailable: "The sending session or the workflow session is not available.",
    forbidden: "Only the workflow's parent, or a session of the same user as the workflow, may give it input; "
        + "a session with unknown or system ownership, or of another user, may not.",
};

/**
 * A comparable key for a session's user owner, or null for system, unowned,
 * partly owned and blank-owned sessions. The key is the exact stored provider
 * and subject, untrimmed: two sessions have the same owner only when both
 * strings are equal.
 */
export function userOwnerKey(row: Pick<AuthoritySession, "isSystem" | "owner"> | null | undefined): string | null {
    if (!row || row.isSystem) return null;
    const provider = row.owner?.provider;
    const subject = row.owner?.subject;
    if (typeof provider !== "string" || typeof subject !== "string" || !provider.trim() || !subject.trim()) return null;
    return JSON.stringify([provider, subject]);
}

/** The rule, on the workflow's session, its definition (null when it has none) and the sender's session (null when missing). */
export function decideTypedInputAuthority(input: {
    workflow: AuthoritySession | null;
    definition: { parentSessionId: string | null } | null;
    sender: AuthoritySession | null;
    senderSessionId: string;
}): TypedInputAuthority {
    const { workflow, definition, sender, senderSessionId } = input;
    if (!workflow || workflow.deleted || workflow.sessionKind !== "workflow" || !definition) return "unavailable";
    if (!sender || sender.deleted) return "unavailable";
    if (workflow.parentSessionId === senderSessionId && definition.parentSessionId === senderSessionId) return "allowed";
    const senderOwner = userOwnerKey(sender);
    const workflowOwner = userOwnerKey(workflow);
    return senderOwner !== null && workflowOwner !== null && senderOwner === workflowOwner ? "allowed" : "forbidden";
}

/**
 * Who may answer a request state's request, or read its closed status or a
 * stored receipt (the request rule, design workflow-messaging-request.md
 * section 6): only the request's frozen responder, live, and related to the
 * requesting workflow as the typed-input rule relates a sender, on the rows
 * as they are now, except that the requesting workflow may be soft-deleted
 * (its session row and definition are kept). A requester whose rows are
 * gone or that is not a workflow, a responder that is missing or deleted,
 * any other actor and any other relationship are refused, all alike. The
 * global typed-input rule is unchanged. A deleted requester gets read-only
 * answers only; that is the store's to decide.
 */
export function decideRequestAuthority(input: {
    requester: AuthoritySession | null;
    definition: { parentSessionId: string | null } | null;
    actor: AuthoritySession | null;
    actorSessionId: string;
    responderSessionId: string;
}): "allowed" | "refused" {
    if (input.actorSessionId !== input.responderSessionId || input.requester === null) return "refused";
    return decideTypedInputAuthority({
        workflow: { ...input.requester, deleted: false }, definition: input.definition, sender: input.actor, senderSessionId: input.actorSessionId,
    }) === "allowed" ? "allowed" : "refused";
}

function authoritySessionOf(row: SessionRow | null): AuthoritySession | null {
    if (!row) return null;
    return {
        deleted: Boolean(row.deletedAt), isSystem: row.isSystem, sessionKind: row.sessionKind, parentSessionId: row.parentSessionId,
        owner: row.owner ? { provider: row.owner.provider, subject: row.owner.subject } : null,
    };
}

/** The rule on the catalog's current rows (an earlier refusal; the store decides again in its transaction). */
export async function typedInputAuthority(
    catalog: Pick<SessionCatalog, "getSession">,
    store: Pick<WorkflowStore, "readDefinition">,
    workflowSessionId: string,
    senderSessionId: string,
): Promise<TypedInputAuthority> {
    const [workflow, sender, definition] = await Promise.all([
        catalog.getSession(workflowSessionId), catalog.getSession(senderSessionId), store.readDefinition(workflowSessionId),
    ]);
    return decideTypedInputAuthority({
        workflow: authoritySessionOf(workflow), definition: definition ? { parentSessionId: definition.parentSessionId } : null,
        sender: authoritySessionOf(sender), senderSessionId,
    });
}
