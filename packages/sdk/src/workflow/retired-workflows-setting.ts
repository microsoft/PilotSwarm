/**
 * Workflows are always on (owner decision 2026-11-08T08:03Z). The PILOTSWARM_WORKFLOWS setting that switched them on is
 * retired: a deployment that still sets it, to any value, is ignored, with one warning per process (as 0.8.10 retired
 * PILOTSWARM_NATIVE_SUBAGENTS=off). PILOTSWARM_WORKFLOW_SCRIPTS (script nodes) and PILOTSWARM_WORKFLOW_TEST_MODE (test
 * mode) are unchanged.
 */

/** The retired setting. */
export const RETIRED_WORKFLOWS_VARIABLE = "PILOTSWARM_WORKFLOWS";

/** The warning a process that still sets it logs once. */
export const RETIRED_WORKFLOWS_WARNING = "PILOTSWARM_WORKFLOWS is ignored: Workflows are always on. Remove it from the deployment's settings.";

let warned = false;

/**
 * Warns once per process when `env` still sets PILOTSWARM_WORKFLOWS (any value that is not empty), and changes nothing.
 * Returns whether this call warned. The worker, the portal and the MCP server call it at start.
 */
export function warnRetiredWorkflowsSetting(env: Record<string, string | undefined> = process.env,
    warn: (message: string) => void = message => console.warn(message)): boolean {
    const value = env[RETIRED_WORKFLOWS_VARIABLE];
    if (warned || value === undefined || value.trim() === "") return false;
    warned = true;
    warn(RETIRED_WORKFLOWS_WARNING);
    return true;
}

/** Test hook: let the next call warn again. */
export function resetRetiredWorkflowsSettingWarning(): void { warned = false; }
