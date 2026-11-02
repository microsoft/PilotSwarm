import { resolveEffectiveSpawnOwner } from "../../cms.js";
import type { SessionOwnerInfo } from "../../types.js";
import type { MessageSender } from "../../message-sender.js";
import type { WorkflowAgentNodeHost, WorkflowAgentSpawnRequest } from "./runtime.js";

/**
 * Workflow v2 agent states (IR 8; design 03 agent node, R09 to R11, R16):
 * the host that creates an agent state's child, an ordinary agent session.
 * INACTIVE: no worker builds one; only tests do.
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
 *   that does not match is refused unavailable);
 * - gets one first prompt, the host-generated wrapper, sent as the
 *   workflow (never as a human), with the state's stable client message id.
 *
 * A repeated spawn of the same node execution names the same session (its
 * id is derived from the node execution) and sends the same client message
 * id, so a retry after a crash finds the session and the child drops the
 * repeated prompt while that id is among its most recent ones.
 */

/** The deepest level of a workflow descendant: parent 0, workflow 1, node agent 2 and its child 3 (R16, D02). */
export const WORKFLOW_V2_MAX_DESCENDANT_LEVEL = 3;
/** The display name of the sender of an agent state's first prompt. */
export const WORKFLOW_AGENT_PROMPT_SENDER = "workflow node invocation";

/** The session rows the host reads: lineage, owner and model. */
export interface WorkflowAgentHostSessionRow {
    parentSessionId?: string | null;
    owner?: SessionOwnerInfo | null;
    isSystem?: boolean;
    model?: string | null;
    reasoningEffort?: string | null;
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
}

/** What the host asks its client to create: the child session and its first prompt. */
export interface WorkflowAgentChildSpec {
    sessionId: string;
    parentSessionId: string;
    nestingLevel: number;
    owner: SessionOwnerInfo | null;
    model?: string;
    reasoningEffort?: string;
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
    /** The agent definition the workflow's owner sees by this name (as spawn_agent resolves it for a session of that owner), or null. */
    resolveAgent(name: string, callerSessionId: string): Promise<WorkflowAgentDefinition | null>;
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
                return { refused: { code: "forbidden" as const, message: `An agent state's session would be at level ${level}; `
                    + `a workflow's descendants stop at level ${WORKFLOW_V2_MAX_DESCENDANT_LEVEL}.` } };
            }
            const owner = await resolveEffectiveSpawnOwner(id => deps.getSession(id), request.workflowSessionId);
            const controlling = request.controllingSessionId ? await deps.getSession(request.controllingSessionId) : null;
            const spec: WorkflowAgentChildSpec = {
                sessionId: request.childSessionId, parentSessionId: request.workflowSessionId, nestingLevel: level,
                owner: owner ? { provider: owner.provider, subject: owner.subject, email: owner.email ?? null, displayName: owner.displayName ?? null } : null,
                ...(controlling?.model ? { model: controlling.model } : {}),
                ...(controlling?.reasoningEffort ? { reasoningEffort: controlling.reasoningEffort } : {}),
                title: `Workflow node: ${request.stateId}`,
                prompt: request.prompt, clientMessageId: request.clientMessageId,
                sender: { kind: "agent", sessionId: request.workflowSessionId, display: WORKFLOW_AGENT_PROMPT_SENDER },
            };
            if (request.task.source === "agent") {
                const task = request.task;
                const definition = await deps.resolveAgent(task.name, request.controllingSessionId ?? request.workflowSessionId);
                if (!definition) {
                    return { refused: { code: "unavailable" as const, message: `Agent "${task.name}" is not available to this workflow's owner.` } };
                }
                if (definition.system && definition.creatable === false) {
                    return { refused: { code: "forbidden" as const, message: `Agent "${task.name}" is a worker-managed system agent; a workflow cannot run it.` } };
                }
                if (task.package !== null && definition.packageName !== task.package) {
                    return { refused: { code: "unavailable" as const, message: `Agent "${task.name}" is not available from package "${task.package}".` } };
                }
                if (task.version !== null && definition.packageVersion !== task.version) {
                    return { refused: { code: "unavailable" as const, message: `Agent "${task.name}" from package "${task.package}" is not available at version ${task.version}.` } };
                }
                spec.boundAgentName = !definition.packageId && definition.namespace ? `${definition.namespace}:${definition.name}` : definition.name;
                if (definition.packageId) spec.boundAgentPackageId = definition.packageId;
                spec.agentId = definition.id ?? definition.name;
                // As spawn_agent binds a named definition: its own tools only, never the parent's package tools.
                spec.toolNames = definition.tools ?? [];
                if (definition.title) spec.title = `${definition.title} (workflow node: ${request.stateId})`;
            }
            await deps.createChild(spec);
            return { spawned: true as const };
        },
    };
}

/** The part of a PilotSwarm client that creates a child session and sends its first prompt. */
export interface WorkflowAgentSessionClient {
    start(): Promise<void>;
    stop(): Promise<void>;
    createSession(config: {
        sessionId: string; parentSessionId: string; nestingLevel: number; owner: SessionOwnerInfo | null;
        model?: string; reasoningEffort?: string; boundAgentName?: string; boundAgentPackageId?: string; agentId?: string; toolNames?: string[];
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
