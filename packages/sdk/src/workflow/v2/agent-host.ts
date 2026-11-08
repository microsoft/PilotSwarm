import { resolveEffectiveSpawnOwner } from "../../cms.js";
import { workflowAgentModelWords } from "./agent-models.js";
import type { SessionOwnerInfo } from "../../types.js";
import type { MessageSender } from "../../message-sender.js";
import type { WorkflowAgentModelUsed, WorkflowAgentNodeHost, WorkflowAgentSpawnRequest } from "./runtime.js";
import { WORKFLOW_V2_MAX_DESCENDANT_LEVEL } from "./input-policy.js";
import { pinnedAgentPackageId } from "../../agent-package-pins.js";
import type { JsonValue } from "./json.js";

/**
 * Workflow v2 agent states (IR 8; design 03 agent node, R09 to R11, R16):
 * the host that creates an agent state's child, an ordinary agent session.
 * Every worker builds one (milestone-worker.ts workflowMilestoneAgentNodes).
 *
 * The child:
 * - is a child session of the workflow (its parent in the session tree), at
 *   the workflow's level plus one, which is at most
 *   WORKFLOW_V2_MAX_DESCENDANT_LEVEL (root 0: parent 0, workflow 1, node agent
 *   2 and its child 3); a deeper child is refused (forbidden);
 * - is owned as any spawned child is (the lineage's effective owner,
 *   resolveEffectiveSpawnOwner) and uses the controlling parent agent's
 *   model when the workflow names one;
 * - for an inline prompt, has the standard base and no named agent; for a
 *   named agent, is bound to the definition the workflow's owner sees by
 *   that name (an unknown or invisible one is refused unavailable, a
 *   worker-managed system agent forbidden; a pinned package or version
 *   that does not match is refused unavailable). A task pinned to an exact
 *   package revision (R18) is bound to that revision (agent-package-pins.ts)
 *   whatever version the package is at now, as long as the owner still sees
 *   the agent in that same package; a worker installs the revision when the
 *   child's turn runs;
 * - gets one first prompt, the host-generated wrapper, sent as the
 *   workflow (never as a human), with the state's stable client message id.
 *
 * A repeated spawn of the same node execution names the same session (its
 * id is derived from the node execution) and sends the same client message
 * id, so a retry after a crash finds the session and the child drops the
 * repeated prompt while that id is among its most recent ones.
 */

export { WORKFLOW_V2_MAX_DESCENDANT_LEVEL };
/** The display name of the sender of an agent state's first prompt. */
export const WORKFLOW_AGENT_PROMPT_SENDER = "workflow node invocation";

/** The session rows the host reads: lineage, owner and model. */
export interface WorkflowAgentHostSessionRow {
    parentSessionId?: string | null;
    owner?: SessionOwnerInfo | null;
    isSystem?: boolean;
    model?: string | null;
    reasoningEffort?: string | null;
    /** OF-S2-7: the chat's context tier, which an agent node it owns inherits with its model and reasoning effort. */
    contextTier?: string | null;
    sessionKind?: string | null;
}

/** An agent definition as the host may bind a child to it (session-proxy ResolvedAgentDefinition's fields that matter here). */
export interface WorkflowAgentDefinition {
    name: string;
    namespace?: string;
    tools?: string[];
    system?: boolean;
    creatable?: boolean;
    id?: string;
    title?: string;
    packageId?: string;
    /** The package's name and version, when the definition came from a package and they are known. */
    packageName?: string;
    packageVersion?: string;
    /** The content hash of the package's active version, when known. */
    packageRevision?: string;
    /**
     * The workflow interface the package agent exports at that revision, as
     * the agent registry keeps it in the package manifest (unchecked here;
     * package-interface.ts readWorkflowInterfaceExport checks it). Absent
     * when it exports none.
     */
    workflowInterface?: JsonValue;
    /** Stage 2.3 (A2): the agent names Workflow Definitions; an agent state may not use it. */
    bringsWorkflows?: boolean;
}

/** What the host asks its client to create: the child session and its first prompt. */
export interface WorkflowAgentChildSpec {
    sessionId: string;
    parentSessionId: string;
    nestingLevel: number;
    owner: SessionOwnerInfo | null;
    model?: string;
    reasoningEffort?: string;
    contextTier?: string;
    /** A named agent's binding; absent for an inline prompt. */
    boundAgentName?: string;
    boundAgentPackageId?: string;
    agentId?: string;
    toolNames?: string[];
    title: string;
    prompt: string;
    clientMessageId: string;
    sender: MessageSender;
}

export interface WorkflowAgentHostDeps {
    getSession(sessionId: string): Promise<WorkflowAgentHostSessionRow | null>;
    /**
     * The agent definition the workflow's owner sees by this name (as
     * spawn_agent resolves it for a session of that owner), among the agents
     * of `packageName` when the state names one, or null. A worker's host
     * (milestone-worker.ts) resolves with the registry-backed resolver that
     * its publications pin with (agent-resolver.ts).
     */
    resolveAgent(name: string, callerSessionId: string, packageName?: string | null): Promise<WorkflowAgentDefinition | null>;
    /**
     * Create the child session (an existing one with this id is reused as it
     * is) and send its first prompt with its client message id. Throws on a
     * failure a retry may fix.
     */
    createChild(spec: WorkflowAgentChildSpec): Promise<void>;
}

/** A session's level: 0 for a root, one more per parent; null when its lineage is missing, cyclic or deeper than any allowed. */
export async function sessionLevel(getSession: WorkflowAgentHostDeps["getSession"], sessionId: string, maxDepth = 16): Promise<number | null> {
    const seen = new Set<string>();
    let cursor: string | null = sessionId;
    for (let level = 0; level <= maxDepth && cursor !== null; level += 1) {
        if (seen.has(cursor)) return null;
        seen.add(cursor);
        const row = await getSession(cursor);
        if (!row) return null;
        const parent = row.parentSessionId ?? null;
        if (parent === null) return level;
        cursor = parent;
    }
    return null;
}

export function createWorkflowAgentNodeHost(deps: WorkflowAgentHostDeps): WorkflowAgentNodeHost {
    return {
        async spawn(request: WorkflowAgentSpawnRequest) {
            const workflowLevel = await sessionLevel(deps.getSession, request.workflowSessionId);
            if (workflowLevel === null) {
                return { refused: { code: "unavailable" as const, message: `The lineage of workflow ${request.workflowSessionId} cannot be read.` } };
            }
            const level = workflowLevel + 1;
            if (level > WORKFLOW_V2_MAX_DESCENDANT_LEVEL) {
                // Spec 14 (stage 1 keeps the limit and says each refusal in words).
                return { refused: { code: "forbidden" as const, message: `Node ${request.stateId} cannot start its agent: its chat would be at `
                    + `level ${level} (the top-level chat is level 0), and sessions inside a Workflow stop at level ${WORKFLOW_V2_MAX_DESCENDANT_LEVEL}. `
                    + "Start this Workflow from a session nearer the top." } };
            }
            const owner = await resolveEffectiveSpawnOwner(id => deps.getSession(id), request.workflowSessionId);
            const controlling = request.controllingSessionId ? await deps.getSession(request.controllingSessionId) : null;
            // OF-S2-7: a model chosen at start for this node; else the owning chat's model, reasoning effort AND context tier.
            const chosen = request.agentModel ?? null;
            const spec: WorkflowAgentChildSpec = {
                sessionId: request.childSessionId, parentSessionId: request.workflowSessionId, nestingLevel: level,
                owner: owner ? { provider: owner.provider, subject: owner.subject, email: owner.email ?? null, displayName: owner.displayName ?? null } : null,
                ...(chosen ? {
                    model: chosen.model,
                    ...(chosen.reasoningEffort ? { reasoningEffort: chosen.reasoningEffort } : {}),
                    ...(chosen.contextTier ? { contextTier: chosen.contextTier } : {}),
                } : {
                    ...(controlling?.model ? { model: controlling.model } : {}),
                    ...(controlling?.reasoningEffort ? { reasoningEffort: controlling.reasoningEffort } : {}),
                    ...(controlling?.contextTier ? { contextTier: controlling.contextTier } : {}),
                }),
                title: `Workflow step: ${request.stateId}`,
                prompt: request.prompt, clientMessageId: request.clientMessageId,
                sender: { kind: "agent", sessionId: request.workflowSessionId, display: WORKFLOW_AGENT_PROMPT_SENDER },
            };
            if (request.task.source === "agent") {
                const task = request.task;
                const definition = await deps.resolveAgent(task.name, request.controllingSessionId ?? request.workflowSessionId, task.package);
                if (!definition) {
                    return { refused: { code: "unavailable" as const, message: `Agent "${task.name}" is not available to this workflow's owner.` } };
                }
                if (definition.system && definition.creatable === false) {
                    return { refused: { code: "forbidden" as const, message: `Agent "${task.name}" is a worker-managed system agent; a workflow cannot run it.` } };
                }
                if (task.package !== null && definition.packageName !== task.package) {
                    return { refused: { code: "unavailable" as const, message: `Agent "${task.name}" is not available from package "${task.package}".` } };
                }
                // R18 (T070): a task pinned to an exact revision runs that revision, also after its package is republished,
                // when the owner still sees the agent in that same package. Without a revision, only the pinned version.
                const pinnedRevision = task.packageId !== undefined && task.revision !== undefined;
                if (pinnedRevision && definition.packageId !== task.packageId) {
                    return { refused: { code: "unavailable" as const, message: `Agent "${task.name}" is no longer available from the package `
                        + `its workflow's publication pinned${task.package ? ` ("${task.package}")` : ""}.` } };
                }
                if (!pinnedRevision && task.version !== null && definition.packageVersion !== task.version) {
                    return { refused: { code: "unavailable" as const, message: `Agent "${task.name}" from package "${task.package}" is not available at version ${task.version}.` } };
                }
                let pinnedId: string | null = null;
                if (pinnedRevision) {
                    try {
                        pinnedId = pinnedAgentPackageId(task.packageId!, task.revision!);
                    } catch {
                        return { refused: { code: "unavailable" as const, message: `The pinned revision of agent "${task.name}" does not name a package version.` } };
                    }
                }
                spec.boundAgentName = !definition.packageId && definition.namespace ? `${definition.namespace}:${definition.name}` : definition.name;
                if (pinnedId !== null) spec.boundAgentPackageId = pinnedId;
                else if (definition.packageId) spec.boundAgentPackageId = definition.packageId;
                spec.agentId = definition.id ?? definition.name;
                // As spawn_agent binds a named definition: its own tools only, never the parent's package tools. A pinned
                // revision's own declarations come with its copy; the active version's are not its own.
                spec.toolNames = pinnedRevision ? [] : definition.tools ?? [];
                if (definition.title) spec.title = `${definition.title} (workflow node: ${request.stateId})`;
            }
            try {
                await deps.createChild(spec);
            } catch (error) {
                // OF-S2-7: a model chosen at start that this owner can no longer use fails the node in words; it never falls
                // back to another model, and a retry cannot change it.
                const code = (error as { code?: unknown })?.code;
                if (chosen && (code === "MODEL_UNRESOLVED" || code === "MODEL_AMBIGUOUS")) {
                    return { refused: { code: "unavailable" as const, message: `Node ${request.stateId} cannot start its agent: the model chosen at start, `
                        + `${workflowAgentModelWords(chosen)}, cannot be used now: `
                        + `${String((error as Error).message ?? error)}` } };
                }
                throw error;
            }
            // OF7-R8: what this visit's chat runs on, as its session row says now that it is made (best effort: none when unread).
            // Review D7: "chosen at start" only when the chat runs the model the start chose (a continued chat may have been
            // switched since); else it is the chat's.
            const made = await deps.getSession(request.childSessionId).catch(() => null);
            const used: WorkflowAgentModelUsed | null = typeof made?.model === "string" && made.model
                ? { model: made.model, reasoningEffort: made.reasoningEffort ?? null, contextTier: made.contextTier ?? null,
                    source: chosen && made.model === chosen.model ? "start" : "chat" }
                : null;
            return { spawned: true as const, ...(used ? { used } : {}) };
        },
    };
}

/** The part of a PilotSwarm client that creates a child session and sends its first prompt. */
export interface WorkflowAgentSessionClient {
    start(): Promise<void>;
    stop(): Promise<void>;
    createSession(config: {
        sessionId: string; parentSessionId: string; nestingLevel: number; owner: SessionOwnerInfo | null;
        model?: string; reasoningEffort?: string; contextTier?: string; boundAgentName?: string; boundAgentPackageId?: string; agentId?: string;
        toolNames?: string[];
    }): Promise<{ send(prompt: string, opts: { clientMessageIds: string[]; sender: MessageSender }): Promise<void> }>;
}

/**
 * createChild through a PilotSwarm client, as the spawnChildSession
 * activity creates a child: the catalog row and creation config, then the
 * first prompt (which starts the child's orchestration). A client is
 * started for each child and stopped after it. The title is set when the
 * catalog can.
 */
export function clientWorkflowAgentChildCreator(
    createClient: () => WorkflowAgentSessionClient,
    catalog?: { updateSession(sessionId: string, update: { title?: string; agentId?: string }): Promise<unknown> } | null,
): WorkflowAgentHostDeps["createChild"] {
    return async (spec: WorkflowAgentChildSpec): Promise<void> => {
        const client = createClient();
        await client.start();
        try {
            const session = await client.createSession({
                sessionId: spec.sessionId, parentSessionId: spec.parentSessionId, nestingLevel: spec.nestingLevel, owner: spec.owner,
                ...(spec.model ? { model: spec.model } : {}),
                ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
                ...(spec.contextTier ? { contextTier: spec.contextTier } : {}),
                ...(spec.boundAgentName ? { boundAgentName: spec.boundAgentName } : {}),
                ...(spec.boundAgentPackageId ? { boundAgentPackageId: spec.boundAgentPackageId } : {}),
                ...(spec.agentId ? { agentId: spec.agentId } : {}),
                ...(spec.toolNames ? { toolNames: spec.toolNames } : {}),
            });
            if (catalog) await catalog.updateSession(spec.sessionId, { title: spec.title });
            await session.send(spec.prompt, { clientMessageIds: [spec.clientMessageId], sender: spec.sender });
        } finally {
            await client.stop();
        }
    };
}
