import { WORKFLOW_REQUEST_CAPABILITY } from "../../activity-routing.js";
import { PilotSwarmClient } from "../../client.js";
import type { SessionCatalog } from "../../cms.js";
import { isReasoningEffort } from "../../model-providers.js";
import { DURABLE_SESSION_ORCHESTRATION_NAME } from "../../orchestration-registry.js";
import { DURABLE_SESSION_INTAKE_VERSION } from "../../orchestration-version.js";
import { CURRENT_ORCHESTRATION_VERSION, createRuntime, runLoop } from "../../orchestration_1_0_83/runtime.js";
import type { OrchestrationInput, PilotSwarmClientOptions } from "../../types.js";
import { clientWorkflowAgentChildCreator, createWorkflowAgentNodeHost, type WorkflowAgentSessionClient } from "./agent-host.js";
import { createWorkflowAgentResolver, type WorkflowHostAgents } from "./agent-resolver.js";
import { registerWorkflowIntakeActivities } from "./intake-activities.js";
import type { WorkflowAgentNodeHost } from "./runtime.js";
import type { WorkflowStore } from "./store.js";

/**
 * What a worker created with the test option `workflowRequests` serves
 * (INACTIVE; PilotSwarmWorkerOptions.testOptions). No deployment sets the
 * option, nothing reads it from the environment, and the worker loads this
 * module only when it is set; no other source imports it.
 *
 * - The workflow-request activity tag: controller 1.9.0's activities and the
 *   turn and intake activities of orchestration 1.0.83 are routed with it.
 * - Orchestration 1.0.83 under the durable session name, continuing as new to
 *   itself, with its intake activities (claim and settle) and its turn
 *   activities (registerActivities' test options below). A session started at
 *   1.0.83 stays there; a session started at the latest version (1.0.82) runs
 *   and continues as new exactly as before.
 * - The agent host of agent states (agent-host.ts): the child's definition
 *   from the registry-backed resolver over the agent registry and this
 *   worker's own agents (agent-resolver.ts), as the worker's publications pin
 *   them; the child created through a PilotSwarm client that starts it at
 *   1.0.83, so that its turns can complete its state (complete_workflow_node).
 *
 * Activation stays gated (request design 8.4): duroxide cannot route
 * orchestration items by version, so every worker that can fetch this work
 * must serve it; a worker without the option would fetch and fail 1.9.0 and
 * 1.0.83 items.
 */

/** The activity tags such a worker adds to its defaults. */
export const WORKFLOW_MILESTONE_WORKER_TAGS: readonly string[] = [WORKFLOW_REQUEST_CAPABILITY];

/** registerActivities' test options on such a worker: 1.0.83's turns, with the request and agent-state tools. */
export function workflowMilestoneActivityOptions(): { workflowIntakeTurns: true; workflowRequests: true } {
    return { workflowIntakeTurns: true, workflowRequests: true };
}

/** 1.0.83 continuing as new to itself: the sessions such a worker starts at it stay at it. */
function* durableSessionIntakeOrchestration(ctx: any, input: OrchestrationInput): Generator<any, string, any> {
    const runtime = yield* createRuntime(ctx, input, { currentVersion: CURRENT_ORCHESTRATION_VERSION, latestVersion: CURRENT_ORCHESTRATION_VERSION });
    if (runtime.state.orchestrationResult !== null) return runtime.state.orchestrationResult;
    return yield* runLoop(runtime);
}

/**
 * Register orchestration 1.0.83 and its intake activities. Call it after the
 * registry's session versions: duroxide takes an orchestration's versions in
 * ascending order.
 */
export function registerWorkflowMilestoneSessions(runtime: {
    registerOrchestrationVersioned(name: string, version: string, handler: (ctx: any, input: any) => Generator<any, any, any>): void;
    registerActivity(name: string, handler: (ctx: any, input: any) => Promise<unknown>): void;
}, deps: { store: WorkflowStore | null }): void {
    if (CURRENT_ORCHESTRATION_VERSION !== DURABLE_SESSION_INTAKE_VERSION) {
        throw new Error(`The intake orchestration is ${CURRENT_ORCHESTRATION_VERSION}, not ${DURABLE_SESSION_INTAKE_VERSION}.`);
    }
    runtime.registerOrchestrationVersioned(DURABLE_SESSION_ORCHESTRATION_NAME, DURABLE_SESSION_INTAKE_VERSION, durableSessionIntakeOrchestration);
    registerWorkflowIntakeActivities(runtime, { store: deps.store });
}

/**
 * A PilotSwarm client of the worker's own store that starts sessions at
 * 1.0.83, as the child creator uses it. The controlling session's reasoning
 * effort is plain text on its row: the child takes it only when it names one.
 */
function childSessionClient(options: PilotSwarmClientOptions): WorkflowAgentSessionClient {
    const client = new PilotSwarmClient(options);
    client._startSessionsAt(DURABLE_SESSION_INTAKE_VERSION);
    return {
        start: () => client.start(),
        stop: () => client.stop(),
        createSession: ({ reasoningEffort, ...config }) => client.createSession({
            ...config, ...(isReasoningEffort(reasoningEffort) ? { reasoningEffort } : {}),
        }),
    };
}

/**
 * The worker's agent host: definitions from the agent registry and the
 * worker's agents (read at each spawn), children created through a client of
 * the worker's own store (`clientOptions`) that starts them at 1.0.83.
 */
export function workflowMilestoneAgentNodes(deps: {
    catalog: Pick<SessionCatalog, "getSession" | "getAgentPackagesInstallManifest" | "updateSession">;
    deploymentAgents: () => WorkflowHostAgents;
    clientOptions: PilotSwarmClientOptions;
}): WorkflowAgentNodeHost {
    return createWorkflowAgentNodeHost({
        getSession: sessionId => deps.catalog.getSession(sessionId),
        resolveAgent: createWorkflowAgentResolver({ catalog: deps.catalog, deploymentAgents: deps.deploymentAgents }),
        createChild: clientWorkflowAgentChildCreator(() => childSessionClient(deps.clientOptions), deps.catalog),
    });
}
