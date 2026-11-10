import { WORKFLOW_REQUEST_CAPABILITY } from "../../activity-routing.js";
import { PilotSwarmClient } from "../../client.js";
import type { SessionCatalog } from "../../cms.js";
import type { FactStore } from "../../facts-store.js";
import { isReasoningEffort } from "../../model-providers.js";
import type { PilotSwarmClientOptions } from "../../types.js";
import { clientWorkflowAgentChildCreator, createWorkflowAgentNodeHost, type WorkflowAgentSessionClient } from "./agent-host.js";
import { createWorkflowAgentResolver, type WorkflowHostAgents } from "./agent-resolver.js";
import { registerWorkflowAgentTurnFailureActivity } from "./agent-turn-failure.js";
import { registerWorkflowIntakeActivities } from "./intake-activities.js";
import type { WorkflowAgentNodeHost } from "./runtime.js";
import type { WorkflowStore } from "./store.js";

/**
 * What every worker serves for the full Workflow engine (owner decision 2026-11-08T15:30Z,
 * pse/decision/always-on-scope-20261108T1530: session orchestration 1.0.83 is the latest version and the Workflow work is
 * on every deployment). The worker (worker.ts) uses all of it, always:
 *
 * - The workflow-request activity tag: the Workflow controller's activities and the turn and intake activities of orchestration
 *   1.0.83 are routed with it, so a worker of an older image (which does not declare the tag) never fetches them.
 * - The intake activities (claim and settle) of orchestration 1.0.83, which the registry registers as the latest version.
 *   Its turn activities are registered by registerActivities (session-proxy.ts).
 * - The report of a Workflow agent chat's failed turn (agent-turn-failure.ts), which orchestration 1.0.83 schedules.
 * - The agent host of agent states (agent-host.ts): the child's definition from the registry-backed resolver over the
 *   agent registry and this worker's own agents (agent-resolver.ts), as the worker's publications pin them; the child
 *   created through a PilotSwarm client of the worker's own store, at the latest version (1.0.83), so that its turns can
 *   complete its state (complete_workflow_node).
 *
 * Duroxide cannot route orchestration items by version: during a rolling deployment a worker of an older image that
 * fetches a 1.0.83 or Workflow controller item has no such version registered and abandons it with duroxide's
 * unregistered-version backoff, so a worker of this image takes it (design.md, "Rolling deployment and rollback").
 */

/** The activity tags every worker adds to its defaults. */
export const WORKFLOW_MILESTONE_WORKER_TAGS: readonly string[] = [WORKFLOW_REQUEST_CAPABILITY];

/** Register orchestration 1.0.83's intake activities and its failed-turn report (the orchestration itself is in the registry). */
export function registerWorkflowMilestoneSessions(runtime: {
    registerActivity(name: string, handler: (ctx: any, input: any) => Promise<unknown>): void;
}, deps: { store: WorkflowStore | null }): void {
    registerWorkflowIntakeActivities(runtime, { store: deps.store });
    registerWorkflowAgentTurnFailureActivity(runtime, { store: deps.store });
}

/**
 * The worker's own duroxide provider, session catalog and fact store, lent to the clients that create agent-step children
 * (PilotSwarmClient._startOnShared): no client opens pools or runs migrations of its own, and stopping one leaves them open.
 */
export interface WorkflowChildSharedStorage {
    provider: unknown;
    catalog: SessionCatalog;
    factStore: FactStore;
}

/**
 * A PilotSwarm client of the worker's own store (new sessions at the latest version, 1.0.83), as the child creator uses
 * it. The controlling session's reasoning effort is plain text on its row: the child takes it only when it names one.
 * Review L4: with `shared` (every worker that has all three), the client borrows the worker's storage instead of
 * starting its own duroxide provider, CMS and facts pools for each child (stop() never closed the provider).
 */
function childSessionClient(options: PilotSwarmClientOptions, shared: WorkflowChildSharedStorage | null): WorkflowAgentSessionClient {
    const client = new PilotSwarmClient(options);
    return {
        start: () => (shared ? client._startOnShared(shared) : client.start()),
        stop: () => client.stop(),
        createSession: ({ reasoningEffort, contextTier, ...config }) => client.createSession({
            ...config, ...(isReasoningEffort(reasoningEffort) ? { reasoningEffort } : {}),
            // OF-S2-7: the chat's (or the chosen) context tier, when it names a known one.
            ...(contextTier === "default" || contextTier === "long_context" ? { contextTier } : {}),
        }),
    };
}

/**
 * The worker's agent host: definitions from the agent registry and the
 * worker's agents (read at each spawn), children created through a client of
 * the worker's own store (`clientOptions`), at the latest version.
 */
export function workflowMilestoneAgentNodes(deps: {
    catalog: Pick<SessionCatalog, "getSession" | "getAgentPackagesInstallManifest" | "updateSession">;
    deploymentAgents: () => WorkflowHostAgents;
    clientOptions: PilotSwarmClientOptions;
    /** Review L4: the worker's own storage, lent to each child's client; null starts each client on its own (tests). */
    shared?: WorkflowChildSharedStorage | null;
}): WorkflowAgentNodeHost {
    return createWorkflowAgentNodeHost({
        getSession: sessionId => deps.catalog.getSession(sessionId),
        resolveAgent: createWorkflowAgentResolver({ catalog: deps.catalog, deploymentAgents: deps.deploymentAgents }),
        createChild: clientWorkflowAgentChildCreator(() => childSessionClient(deps.clientOptions, deps.shared ?? null), deps.catalog),
    });
}
