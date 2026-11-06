/**
 * Workflow test mode, hidden (Workflow Simplified, spec 16; owner decisions E1, O2).
 *
 * Testing a workflow (update_workflow operations test, test_respond and test_advance; a person's same commands over
 * the Web API and MCP) leaves every surface people and agents use. Its code and its tests stay. One deployment flag
 * shows it again: PILOTSWARM_WORKFLOW_TEST_MODE, exactly `on`. Unset, empty or any other value: off.
 *
 * Off:
 * - the agent tool declares no test operation, and the handler answers one as an operation that does not exist (the unknown
 *   operation's refusal, with no word of testing; review SF-7; tools.ts);
 * - a person's commands (Web API, MCP) answer them as operations that do not exist (the unknown operation's refusal,
 *   with no word of testing), the bootstrap capabilities and a read model's personCommands do not list them
 *   (human-commands.ts), so the portal and the terminal UI show no test controls and no test runs;
 * - the MCP update_workflow tool does not name them;
 * - the base guidance does not mention them (guidance.ts).
 *
 * The flag is separate from the Workflow V2 test environment switch (test-environment.ts): it changes nothing else,
 * and test operations still need a host that runs controller 1.9.0. Stored test runs are kept, not shown.
 */
export const WORKFLOW_TEST_MODE_VARIABLE = "PILOTSWARM_WORKFLOW_TEST_MODE";

/** The one value that turns test mode on. */
export const WORKFLOW_TEST_MODE_ENABLED = "on";

/** The operations test mode adds to update_workflow (with stop, the milestone operations of a 1.9.0 host). */
export const WORKFLOW_TEST_MODE_OPERATIONS: readonly string[] = ["test", "test_respond", "test_advance"];

/** Words about testing being off, for an operator's log line; no surface answers a test operation with them (review SF-7). */
export const WORKFLOW_TEST_MODE_OFF_TEXT = "Testing workflows is turned off on this server.";

/** Whether test mode is on in `env`: exactly `on`. Pure. */
export function workflowTestModeFromEnv(env: Record<string, string | undefined> = process.env): boolean {
    return env[WORKFLOW_TEST_MODE_VARIABLE] === WORKFLOW_TEST_MODE_ENABLED;
}

/** A host's or option's test mode: its own boolean when it says, otherwise the deployment flag. */
export function resolveWorkflowTestMode(value: boolean | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
    return typeof value === "boolean" ? value : workflowTestModeFromEnv(env);
}

/** One startup line about the flag, for an entry point's log; null when it is unset. */
export function workflowTestModeNotice(env: Record<string, string | undefined> = process.env): string | null {
    const value = env[WORKFLOW_TEST_MODE_VARIABLE];
    if (value === undefined || value === "") return null;
    return value === WORKFLOW_TEST_MODE_ENABLED
        ? `Workflow test mode ON (${WORKFLOW_TEST_MODE_VARIABLE}=${WORKFLOW_TEST_MODE_ENABLED}): people and agents can test workflows.`
        : `${WORKFLOW_TEST_MODE_VARIABLE} is set but not to ${WORKFLOW_TEST_MODE_ENABLED}: ignored, workflow test mode OFF.`;
}
