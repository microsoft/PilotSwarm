/**
 * Shared durable-session orchestration version constants.
 *
 * The latest version is the canonical target for new starts and every
 * continue-as-new handoff. Frozen orchestration files keep their own
 * CURRENT_ORCHESTRATION_VERSION for replay/tracing, but must not hard-code
 * the latest target themselves.
 *
 * The compatibility floor documents the oldest orchestration input wire
 * format that the latest handler must continue to normalize while that
 * version remains registered in the repo.
 *
 * @internal
 */
export const DURABLE_SESSION_LATEST_VERSION = "1.0.82";
export const DURABLE_SESSION_COMPATIBILITY_FLOOR_VERSION = "1.0.47";

/**
 * Session workspaces: the first orchestration version that applies the
 * results of set_session_workspace and the spawn `workspace` parameter.
 */
export const WORKSPACE_ORCHESTRATION_MIN_VERSION = "1.0.80";

/**
 * The durable workflow intake's session orchestration (orchestration_1_0_83;
 * INACTIVE): not in the registry and never the latest version. Only a worker
 * created with the test option `workflowRequests` serves it, and starts the
 * children of workflow agent states at it (their turns can complete their
 * state). With the Workflow V2 test environment switch on, the portal's and
 * the MCP server's direct-mode clients also start new sessions at it
 * (test-environment.ts). See PilotSwarmWorkerOptions.testOptions.
 */
export const DURABLE_SESSION_INTAKE_VERSION = "1.0.83";
