/**
 * Retired Workflow settings: a deployment that still sets one, to any value, is ignored, with one warning per setting
 * per process (as 0.8.10 retired PILOTSWARM_NATIVE_SUBAGENTS=off). The worker, the portal and the MCP server call
 * warnRetiredWorkflowsSetting at start.
 * - PILOTSWARM_WORKFLOWS (owner decision 2026-11-08T08:03Z): Workflows are always on.
 * - PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT (owner decision 2026-11-08T15:30Z): every worker runs the full Workflow
 *   engine (the Workflow controller and session orchestration 1.0.83, the latest version), and every deployment takes a
 *   person's workflow commands.
 * PILOTSWARM_WORKFLOW_SCRIPTS (script nodes) and PILOTSWARM_WORKFLOW_TEST_MODE (test mode) are unchanged.
 */

/** The retired setting that switched Workflows on. */
export const RETIRED_WORKFLOWS_VARIABLE = "PILOTSWARM_WORKFLOWS";

/** The warning a process that still sets it logs once. */
export const RETIRED_WORKFLOWS_WARNING = "PILOTSWARM_WORKFLOWS is ignored: Workflows are always on. Remove it from the deployment's settings.";

/** The retired setting that switched the full Workflow engine on in an isolated test environment. */
export const RETIRED_WORKFLOW_TEST_ENVIRONMENT_VARIABLE = "PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT";

/** The warning a process that still sets it logs once. */
export const RETIRED_WORKFLOW_TEST_ENVIRONMENT_WARNING = "PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT is ignored: every worker runs the full "
    + "Workflow engine. Remove it from the deployment's settings.";

/** Every retired Workflow setting and its warning, in the order a process warns. */
export const RETIRED_WORKFLOW_SETTINGS: ReadonlyArray<{ variable: string; warning: string }> = [
    { variable: RETIRED_WORKFLOWS_VARIABLE, warning: RETIRED_WORKFLOWS_WARNING },
    { variable: RETIRED_WORKFLOW_TEST_ENVIRONMENT_VARIABLE, warning: RETIRED_WORKFLOW_TEST_ENVIRONMENT_WARNING },
];

const warned = new Set<string>();

/**
 * Warns once per process for each retired Workflow setting that `env` still sets (any value that is not empty), and
 * changes nothing. Returns whether this call warned.
 */
export function warnRetiredWorkflowsSetting(env: Record<string, string | undefined> = process.env,
    warn: (message: string) => void = message => console.warn(message)): boolean {
    let any = false;
    for (const { variable, warning } of RETIRED_WORKFLOW_SETTINGS) {
        const value = env[variable];
        if (warned.has(variable) || value === undefined || value.trim() === "") continue;
        warned.add(variable);
        warn(warning);
        any = true;
    }
    return any;
}

/** Test hook: let the next call warn again. */
export function resetRetiredWorkflowsSettingWarning(): void { warned.clear(); }
