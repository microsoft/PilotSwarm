import type { SessionCatalog } from "../cms.js";
import { userOwnerKey, type AuthoritySession } from "./authority.js";
import { WORKFLOW_LINEAGE_MAX_DEPTH, WorkflowStoreError, type WorkflowStore } from "./store.js";

/**
 * I2: who may read or control a Workflow with the agent tools (read_workflow, update_workflow), decided by one rule on the
 * stored session rows and the agent states' invocation records, never by a caller's claim:
 *
 * | Caller | read | control (pause, resume, stop, cancel, set_vars, recover) | definition (save, test, start) |
 * |---|---|---|---|
 * | The parent: the Workflow's session row and its definition both name it | yes | yes | yes |
 * | An ancestor: above the parent, every session between live, all of the Workflow's owner | yes | yes | no |
 * | The Workflow's own agent step, or a session under one (its sub-agents) | yes | no | no |
 * | Anyone else | no | no | no |
 *
 * A session above a deleted session is not an ancestor any more: the chain is broken there. Owners compare exactly: the
 * same user, both system, or both without an owner; anything else is another owner. So an all-unowned chain grants an
 * ancestor read and control, and a system root (is_system) is another owner to the System-principal sessions it spawns:
 * it is refused below its direct child (owner decision 2026-11-26: kept as it is).
 */
export type WorkflowAccess = "read" | "control" | "definition";

/** How the caller is related to the Workflow, when it is. */
export type WorkflowRelation = "parent" | "ancestor" | "agent_step";

type CatalogReader = Pick<SessionCatalog, "getSession">;
type StoreReader = Pick<WorkflowStore, "readDefinition"> & Partial<Pick<WorkflowStore, "readWorkflowLineage" | "readSessionAncestry">>;
type AccessHost = { catalog: CatalogReader; store: StoreReader };

/** One session of a chain: what the rule reads about it. */
type Link = Pick<AuthoritySession, "deleted" | "isSystem" | "owner" | "parentSessionId"> & { sessionId: string };

/** The refusals, each naming its rule. */
export const WORKFLOW_ACCESS_REFUSALS = {
    unrelated: "Only a session above this Workflow (the session that started it, or one above that) may read or control it with this tool; "
        + "its own agent steps may read it.",
    definition: "Only the session that started this Workflow may save or start its definition, or test it.",
    agentStep: "An agent step, and a session under it, may read its own Workflow but not control it.",
    deleted: "A session between this session and the Workflow was deleted, so this session may no longer read or control it.",
    otherOwner: "This session belongs to another owner than the Workflow, so it may not read or control it.",
} as const;

export type WorkflowAccessDecision =
    | { allowed: true; relation: WorkflowRelation }
    | { allowed: false; reason: keyof typeof WORKFLOW_ACCESS_REFUSALS };

/** An owner identity to compare: a user's exact provider and subject, "system", "none" without an owner, or null when unreadable. */
function ownerIdentity(link: Pick<Link, "isSystem" | "owner">): string | null {
    if (link.isSystem) return "system";
    if (!link.owner) return "none";
    return userOwnerKey(link);
}

function sameOwner(a: Pick<Link, "isSystem" | "owner">, b: Pick<Link, "isSystem" | "owner">): boolean {
    const left = ownerIdentity(a);
    return left !== null && left === ownerIdentity(b);
}

/**
 * A session and the sessions above it, nearest first, up to its root; null when that chain is not whole: a cycle, a missing
 * row, or a root further than WORKFLOW_LINEAGE_MAX_DEPTH sessions up. The rule refuses on null, so stored links that loop can
 * never make a session below a Workflow look like one above it. The store's read includes deleted rows (a deleted link is
 * seen as deleted); a catalog without it (a test double) shows only live rows, so a deleted link makes the chain not whole,
 * which refuses the same callers.
 */
async function chainFrom(host: AccessHost, sessionId: string): Promise<Link[] | null> {
    let rows: Link[];
    if (typeof host.store.readSessionAncestry === "function") {
        rows = await host.store.readSessionAncestry(sessionId);
    } else {
        rows = [];
        let cursor: string | null = sessionId;
        while (cursor !== null && rows.length <= WORKFLOW_LINEAGE_MAX_DEPTH) {
            const row = await host.catalog.getSession(cursor);
            if (!row) break;
            rows.push({ sessionId: cursor, deleted: Boolean(row.deletedAt), isSystem: row.isSystem === true,
                owner: row.owner ? { provider: row.owner.provider, subject: row.owner.subject } : null, parentSessionId: row.parentSessionId ?? null });
            cursor = row.parentSessionId ?? null;
        }
    }
    const seen = new Set<string>();
    const chain: Link[] = [];
    let expected: string = sessionId;
    for (const row of rows) {
        if (row.sessionId !== expected || seen.has(row.sessionId)) return null;
        seen.add(row.sessionId);
        chain.push(row);
        if (row.parentSessionId === null) return chain;
        expected = row.parentSessionId;
    }
    return null;
}

/** Whether a stretch of a chain is live and all of `owner`'s owner; the reason it is not, else null. */
function brokenLink(links: readonly Link[], owner: Pick<Link, "isSystem" | "owner">): "deleted" | "otherOwner" | null {
    if (links.some(link => link.deleted)) return "deleted";
    if (links.some(link => !sameOwner(link, owner))) return "otherOwner";
    return null;
}

/**
 * Decide the caller's relation to a live Workflow. Throws WORKFLOW_NOT_FOUND when `workflowSessionId` is not a live Workflow;
 * otherwise answers allowed with the relation, or the reason it is refused.
 */
export async function decideWorkflowAccess(host: AccessHost, workflowSessionId: string, callerSessionId: string): Promise<WorkflowAccessDecision> {
    const [row, definition] = await Promise.all([host.catalog.getSession(workflowSessionId), host.store.readDefinition(workflowSessionId)]);
    if (!row || row.deletedAt || row.sessionKind !== "workflow" || !definition) {
        throw new WorkflowStoreError("WORKFLOW_NOT_FOUND", `No Workflow ${workflowSessionId} is visible to this session.`);
    }
    const parentSessionId = row.parentSessionId ?? null;
    if (parentSessionId === callerSessionId && definition.parentSessionId === callerSessionId) return { allowed: true, relation: "parent" };
    // An ancestor: the caller is above the Workflow's trusted parent (its session row and its definition agree on it).
    if (parentSessionId !== null && parentSessionId !== callerSessionId && definition.parentSessionId === parentSessionId) {
        const chain = await chainFrom(host, workflowSessionId);
        const at = chain ? chain.findIndex(link => link.sessionId === callerSessionId) : -1;
        if (chain && chain[1]?.sessionId === parentSessionId && at >= 2) {
            const broken = brokenLink(chain.slice(1, at + 1), chain[0]);
            return broken ? { allowed: false, reason: broken } : { allowed: true, relation: "ancestor" };
        }
    }
    // The Workflow's own agent step, or a session under one: the nearest agent state at or above the caller (its invocation
    // record) is this Workflow's, and the caller's chain reaches the Workflow right above that step, live and of its owner.
    const lineage = typeof host.store.readWorkflowLineage === "function" ? await host.store.readWorkflowLineage(callerSessionId) : null;
    if (lineage && !lineage.deleted && lineage.level !== null && lineage.agentRoot?.workflowSessionId === workflowSessionId) {
        const chain = await chainFrom(host, callerSessionId);
        const at = lineage.agentRoot.distance + 1;
        if (chain && chain[at]?.sessionId === workflowSessionId && chain[at - 1]?.sessionId === lineage.agentRoot.childSessionId) {
            const broken = brokenLink(chain.slice(0, at), chain[at]);
            return broken ? { allowed: false, reason: broken } : { allowed: true, relation: "agent_step" };
        }
    }
    return { allowed: false, reason: "unrelated" };
}

/** Whether a relation grants an access (the table above). */
function grants(relation: WorkflowRelation, access: WorkflowAccess): boolean {
    if (relation === "parent") return true;
    if (relation === "ancestor") return access !== "definition";
    return access === "read";
}

/**
 * The one authorization of the Workflow agent tools: returns the caller's relation, or throws WORKFLOW_NOT_FOUND (no live
 * Workflow) or FORBIDDEN with the rule that refuses it.
 */
export async function authorizeWorkflowAccess(host: AccessHost, workflowSessionId: string, callerSessionId: string,
    access: WorkflowAccess): Promise<WorkflowRelation> {
    const decision = await decideWorkflowAccess(host, workflowSessionId, callerSessionId);
    if (!decision.allowed) throw new WorkflowStoreError("FORBIDDEN", WORKFLOW_ACCESS_REFUSALS[decision.reason]);
    if (grants(decision.relation, access)) return decision.relation;
    throw new WorkflowStoreError("FORBIDDEN",
        decision.relation === "agent_step" ? WORKFLOW_ACCESS_REFUSALS.agentStep : WORKFLOW_ACCESS_REFUSALS.definition);
}

/**
 * A cleaned-up Workflow's kept outcome (session_child_outcomes) is readable by the session it is kept with (the Workflow's
 * parent) and by every session above that parent, by the same rule: a live chain of the parent's owner.
 */
export async function mayReadRetainedWorkflow(host: AccessHost, retainedParentSessionId: string, callerSessionId: string): Promise<boolean> {
    if (retainedParentSessionId === callerSessionId) return true;
    const chain = await chainFrom(host, retainedParentSessionId);
    const at = chain ? chain.findIndex(link => link.sessionId === callerSessionId) : -1;
    return chain !== null && at >= 1 && brokenLink(chain.slice(0, at + 1), chain[0]) === null;
}
