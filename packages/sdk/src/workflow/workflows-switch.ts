/**
 * Workflows can be switched off (Workflow Simplified stage 2.0; spec "switch", decision D1). One switch (coordinator 03:02Z):
 * it alone gives the workflow tools and screens; PILOTSWARM_WORKFLOW_SCRIPTS decides only whether script nodes run, and a
 * definition with one is refused at save and Start where they do not (v2/scripts-gate.ts).
 *
 * One deployment setting decides whether Workflows exist at all: PILOTSWARM_WORKFLOWS, exactly `on`. Unset, empty or any
 * other value: off, the default. PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT=isolated-test-only (test-environment.ts) implies
 * on, so a test environment needs no change. The portal, every worker and the MCP server read it; the portal tells its
 * clients through the bootstrap (`workflows.enabled`), never from its own build.
 *
 * Off:
 * - agents: spawn_workflow, update_workflow, read_workflow and send_workflow_input are not declared, and a call answers
 *   WORKFLOWS_DISABLED; the base instructions carry no Workflow guidance;
 * - the management client (Web API, MCP's direct mode): the workflow create, read and command calls answer
 *   WORKFLOWS_DISABLED (404), and the Workflow lookups on a person's prompt, the access check and cancel, done and delete
 *   are skipped;
 * - the bootstrap and MCP capabilities say `enabled: false` and nothing else about Workflows; the portal and the terminal
 *   UI then show no Workflow button, tab, pane, key or rows; MCP registers no workflow tool.
 * Still runs when off: the migrations and their trigger (a schema must not differ by setting), the Workflow orchestrations'
 * registrations (an older instance still replays) and the general runtime changes that are not about Workflows.
 *
 * On: the four tools are declared and the guidance given, whether or not the worker runs scripts.
 */
import { WORKFLOW_V2_TEST_ENVIRONMENT_ENABLED, WORKFLOW_V2_TEST_ENVIRONMENT_VARIABLE } from "./v2/test-environment.js";

export const WORKFLOWS_VARIABLE = "PILOTSWARM_WORKFLOWS";

/** The one value that turns Workflows on. */
export const WORKFLOWS_ENABLED_VALUE = "on";

/** The code every refused workflow call carries while Workflows are off. */
export const WORKFLOWS_DISABLED = "WORKFLOWS_DISABLED";

/** The refusal's words. */
export const WORKFLOWS_DISABLED_TEXT = "Workflows are turned off on this server. An operator turns them on with PILOTSWARM_WORKFLOWS=on.";

/** The agent tools that exist only while Workflows are on. */
export const WORKFLOW_AGENT_TOOL_NAMES: readonly string[] = ["workflow_definition", "spawn_workflow", "update_workflow", "read_workflow", "send_workflow_input"];

/** Whether Workflows are on in `env`: PILOTSWARM_WORKFLOWS exactly `on`, or the Workflow V2 test environment switch. Pure. */
export function workflowsEnabledFromEnv(env: Record<string, string | undefined> = process.env): boolean {
    return env[WORKFLOWS_VARIABLE] === WORKFLOWS_ENABLED_VALUE
        || env[WORKFLOW_V2_TEST_ENVIRONMENT_VARIABLE] === WORKFLOW_V2_TEST_ENVIRONMENT_ENABLED;
}

/** A host's or option's setting: its own boolean when it says, otherwise the deployment setting. */
export function resolveWorkflowsEnabled(value: boolean | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
    return typeof value === "boolean" ? value : workflowsEnabledFromEnv(env);
}

/** One startup line about the setting, for an entry point's log. */
export function workflowsNotice(env: Record<string, string | undefined> = process.env): string {
    const value = env[WORKFLOWS_VARIABLE];
    if (workflowsEnabledFromEnv(env)) {
        return value === WORKFLOWS_ENABLED_VALUE
            ? `Workflows ON (${WORKFLOWS_VARIABLE}=${WORKFLOWS_ENABLED_VALUE}).`
            : `Workflows ON (implied by ${WORKFLOW_V2_TEST_ENVIRONMENT_VARIABLE}=${WORKFLOW_V2_TEST_ENVIRONMENT_ENABLED}).`;
    }
    return value === undefined || value === ""
        ? `Workflows OFF (${WORKFLOWS_VARIABLE} is not set).`
        : `${WORKFLOWS_VARIABLE} is set but not to ${WORKFLOWS_ENABLED_VALUE}: ignored, Workflows OFF.`;
}

/**
 * A management client's `workflowScripts` option from this process's PILOTSWARM_WORKFLOW_SCRIPTS (stage 2.0, scripts-gate.ts):
 * `{ workflowScripts: true }` for 1, true or yes (as a worker reads it), `{ workflowScripts: false }` for any other value that
 * is set, and `{}` when the variable is unset or empty (not known here: a person's save or Start is not refused for script
 * nodes; such a run fails at its first script node). Pure.
 */
export function workflowScriptsOptionFromEnv(env: Record<string, string | undefined> = process.env): { workflowScripts?: boolean } {
    const raw = env.PILOTSWARM_WORKFLOW_SCRIPTS;
    if (raw === undefined || raw.trim() === "") return {};
    const flag = raw.trim().toLowerCase();
    return { workflowScripts: flag === "1" || flag === "true" || flag === "yes" };
}

/** The error a management call answers while Workflows are off: 404, so a client reads it as a surface that is not there. */
export function workflowsDisabledError(): Error & { code: string; status: number } {
    return Object.assign(new Error(WORKFLOWS_DISABLED_TEXT), { code: WORKFLOWS_DISABLED, status: 404 });
}

/** An agent tool's answer while Workflows are off: JSON with the code (`line`: the one-line [SYSTEM: …] form spawn_workflow uses). */
export function workflowsDisabledRefusal(tool: string, options: { line?: boolean } = {}): string {
    return options.line === true
        ? `[SYSTEM: ${tool} refused — ${WORKFLOWS_DISABLED_TEXT} (${WORKFLOWS_DISABLED})]`
        : JSON.stringify({ ok: false, error: { code: WORKFLOWS_DISABLED, message: WORKFLOWS_DISABLED_TEXT } });
}
