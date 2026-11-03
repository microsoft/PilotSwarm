import type { PilotSwarmWorkerOptions } from "../../types.js";
import { DURABLE_SESSION_INTAKE_VERSION } from "../../orchestration-version.js";

/**
 * Workflow V2 in an isolated test environment (INACTIVE everywhere else):
 * one explicit switch, read from the environment by the deployed entry
 * points (the headless worker, the portal and its embedded workers, the MCP
 * server), that passes the test-only options which already exist:
 *
 * - every worker: `testOptions.workflowRequests` (controller 1.9.0 for
 *   request, agent and parallel states, and the durable session
 *   orchestration 1.0.83 its agent children start at; milestone-worker.ts);
 * - the management client of the portal and of the MCP server's direct
 *   mode: `workflowCommands: { requests: true }` (a person's workflow
 *   commands, stop and the test operations included);
 * - the session client of the portal and of the MCP server's direct mode:
 *   new sessions start at 1.0.83 (`sessionStartVersion`), whose turns take
 *   request, agent and parallel states, so a person's own chat can create
 *   such a workflow; and a sub-agent a chat spawns starts there too (its
 *   worker has `workflowRequests`; session-proxy spawnChildSession). A
 *   session started before keeps its version: one started at 1.0.82 stays
 *   there, and its spawn_workflow refuses those states as before. System
 *   agents and their children start at the latest version.
 *
 * It is on only when PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT is exactly
 * `isolated-test-only` (no trimming, no other spelling). Unset, empty or any
 * other value: off, and every option is exactly as without it. It is not an
 * activation: production defaults, DURABLE_SESSION_LATEST_VERSION and the
 * orchestration registry do not change. Duroxide cannot route orchestration
 * items by version, so every worker that can fetch this environment's work
 * must run the same image with the same switch; an older worker would fetch
 * and fail 1.9.0 and 1.0.83 items. Script states still need
 * PILOTSWARM_WORKFLOW_SCRIPTS (unchanged).
 */
export const WORKFLOW_V2_TEST_ENVIRONMENT_VARIABLE = "PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT";

/** The one value that turns the switch on. */
export const WORKFLOW_V2_TEST_ENVIRONMENT_ENABLED = "isolated-test-only";

/** What the switch passes when it is on. */
export interface WorkflowV2TestEnvironment {
    /** For every worker of the environment (PilotSwarmWorkerOptions.testOptions). */
    workerTestOptions: { workflowRequests: true };
    /** For the management client of the portal and of the MCP server's direct mode. */
    workflowCommands: { requests: true };
    /** For the session client of the portal and of the MCP server's direct mode: where new sessions start (PilotSwarmClient._startSessionsAt). */
    sessionStartVersion: typeof DURABLE_SESSION_INTAKE_VERSION;
}

/** The switch as `env` sets it: null (off) unless it is exactly the enabling value. Pure. */
export function workflowV2TestEnvironmentFromEnv(env: Record<string, string | undefined> = process.env): WorkflowV2TestEnvironment | null {
    return env[WORKFLOW_V2_TEST_ENVIRONMENT_VARIABLE] === WORKFLOW_V2_TEST_ENVIRONMENT_ENABLED
        ? { workerTestOptions: { workflowRequests: true }, workflowCommands: { requests: true }, sessionStartVersion: DURABLE_SESSION_INTAKE_VERSION }
        : null;
}

/**
 * A worker's options with the switch applied: the same object, unchanged, when it is off; otherwise a copy with
 * `testOptions.workflowRequests` set (other test options kept). Pure.
 */
export function workerOptionsForWorkflowV2TestEnvironment<T extends Pick<PilotSwarmWorkerOptions, "testOptions">>(options: T,
    env: Record<string, string | undefined> = process.env): T {
    const test = workflowV2TestEnvironmentFromEnv(env);
    return test ? { ...options, testOptions: { ...(options.testOptions ?? {}), ...test.workerTestOptions } } : options;
}

/** One startup line about the switch, for an entry point's log: what it does when on, that a set value is ignored when it is not the enabling value; null when unset. */
export function workflowV2TestEnvironmentNotice(env: Record<string, string | undefined> = process.env): string | null {
    const value = env[WORKFLOW_V2_TEST_ENVIRONMENT_VARIABLE];
    if (value === undefined || value === "") return null;
    return value === WORKFLOW_V2_TEST_ENVIRONMENT_ENABLED
        ? `Workflow V2 test environment ON (${WORKFLOW_V2_TEST_ENVIRONMENT_VARIABLE}=${WORKFLOW_V2_TEST_ENVIRONMENT_ENABLED}): controller 1.9.0 and session orchestration 1.0.83 are served, new sessions start at 1.0.83, and people's workflow commands are taken. Test-only; every worker must run the same switch.`
        : `${WORKFLOW_V2_TEST_ENVIRONMENT_VARIABLE} is set but not to ${WORKFLOW_V2_TEST_ENVIRONMENT_ENABLED}: ignored, Workflow V2 test environment OFF.`;
}
