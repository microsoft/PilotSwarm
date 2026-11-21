/**
 * Script nodes are gated on their own (Workflow Simplified stage 2.0, coordinator 03:02Z). Workflows are always on (owner
 * 2026-11-08T08:03Z), and script nodes are on by default (owner 2026-11-08T15:45Z, pse/decision/scripts-default-on):
 * PILOTSWARM_WORKFLOW_SCRIPTS is an opt-out that only decides whether script nodes run. A host that
 * knows its workers run no scripts (`scripts: false`) refuses a definition with a script node when it is saved and when it
 * is started, in words that name the setting, before anything is written. A host that does not know (`scripts` absent: a
 * portal or MCP server whose own process does not set the variable) does not refuse; such a run fails at its first script
 * node, with the same setting named (runtime.ts).
 */
import { compileWorkflow, type WorkflowIR } from "./compiler.js";
import { WorkflowStoreError } from "./store.js";

export const WORKFLOW_SCRIPTS_DISABLED = "WORKFLOW_SCRIPTS_DISABLED";

/** Why a script state fails on a worker whose scripts are off. */
export const WORKFLOW_SCRIPTS_DISABLED_MESSAGE =
    "Workflow scripts are turned off on this worker: an operator turned them off with PILOTSWARM_WORKFLOW_SCRIPTS=0 "
    + "(or the worker option workflowScripts.enabled: false).";

/** The setting that turns script nodes off (an opt-out since 2026-11-08T15:45Z). */
export const WORKFLOW_SCRIPTS_VARIABLE = "PILOTSWARM_WORKFLOW_SCRIPTS";
const SCRIPTS_OFF_VALUES = new Set(["0", "false", "no", "off"]);
const SCRIPTS_ON_VALUES = new Set(["1", "true", "yes"]);

/** The warning a process logs once when PILOTSWARM_WORKFLOW_SCRIPTS holds a value it does not know (script nodes stay on). */
export const WORKFLOW_SCRIPTS_UNKNOWN_VALUE_WARNING = "PILOTSWARM_WORKFLOW_SCRIPTS has a value this build does not know, so script nodes "
    + "are on. Use 0, false, no or off to turn them off.";

let warnedUnknownScriptsValue = false;

/**
 * Whether script nodes run, from `env`'s PILOTSWARM_WORKFLOW_SCRIPTS: unset or empty, on (the default); 0, false, no or off,
 * off; 1, true or yes, on; any other value, on, with one warning per process (the value is not echoed). The worker, the
 * management client's option (workflowScriptsOptionFromEnv), the portal and the MCP server all read it here.
 */
export function workflowScriptsEnabledFromEnv(env: Record<string, string | undefined> = process.env,
    warn: (message: string) => void = message => console.warn(message)): boolean {
    const raw = env[WORKFLOW_SCRIPTS_VARIABLE];
    if (raw === undefined || raw.trim() === "") return true;
    const flag = raw.trim().toLowerCase();
    if (SCRIPTS_OFF_VALUES.has(flag)) return false;
    if (SCRIPTS_ON_VALUES.has(flag)) return true;
    if (!warnedUnknownScriptsValue) {
        warnedUnknownScriptsValue = true;
        warn(WORKFLOW_SCRIPTS_UNKNOWN_VALUE_WARNING);
    }
    return true;
}

/** Test hook: let the next unknown value warn again. */
export function resetWorkflowScriptsWarning(): void { warnedUnknownScriptsValue = false; }

/**
 * A management client's `workflowScripts` option from this process's PILOTSWARM_WORKFLOW_SCRIPTS: what its workers do by
 * the same setting (workflowScriptsEnabledFromEnv), so unset now gives `{ workflowScripts: true }`.
 */
export function workflowScriptsOptionFromEnv(env: Record<string, string | undefined> = process.env): { workflowScripts?: boolean } {
    return { workflowScripts: workflowScriptsEnabledFromEnv(env) };
}

/** The ids of a definition's script nodes (parallel bodies included: their members are nodes of the IR), in IR order. */
export function workflowScriptNodes(ir: Pick<WorkflowIR, "nodes"> | null | undefined): string[] {
    if (!ir || typeof ir.nodes !== "object" || ir.nodes === null) return [];
    return Object.values(ir.nodes).filter(node => node?.type === "script").map(node => String(node.id));
}

/** The refusal's words: the script nodes, the setting, and what was not done. */
export function workflowScriptsDisabledText(nodes: readonly string[], when: "save" | "start" | "test"): string {
    const list = nodes.slice(0, 5).join(", ") + (nodes.length > 5 ? `, and ${nodes.length - 5} more` : "");
    return `This workflow has script node${nodes.length === 1 ? "" : "s"} (${list}), and script nodes are turned off on this server: `
        + "an operator turned them off with PILOTSWARM_WORKFLOW_SCRIPTS=0. "
        + (when === "save" ? "Nothing was saved." : when === "test" ? "Nothing was tested." : "Nothing was started.");
}

/**
 * Refuses (WORKFLOW_SCRIPTS_DISABLED) a definition with a script node on a host whose workers run no scripts. `scripts`
 * absent: not known here, no refusal. An IR that is not there (a definition that does not compile) has no node to refuse.
 */
export function requireWorkflowScripts(host: { scripts?: boolean }, ir: Pick<WorkflowIR, "nodes"> | null | undefined, when: "save" | "start" | "test"): void {
    if (host.scripts !== false) return;
    const nodes = workflowScriptNodes(ir);
    if (!nodes.length) return;
    throw new WorkflowStoreError(WORKFLOW_SCRIPTS_DISABLED, workflowScriptsDisabledText(nodes, when), { scriptNodes: nodes, setting: "PILOTSWARM_WORKFLOW_SCRIPTS" });
}

/**
 * The scripts gate decided from the YAML alone (the e02ec6f8 run: a definition with a script node on a worker that runs no
 * scripts answered WORKFLOW_ERROR, because the turn's workflow host could not be made there, and the gate came after it).
 * With `scripts` false, a YAML that compiles with a script node is refused (WORKFLOW_SCRIPTS_DISABLED) before the host is
 * made, the owner or the tool binding is read, or anything else is done; `scripts` true or absent, or a YAML that does not
 * compile, is left to the call's own checks (the host's compile then says what is wrong). Its compile takes every node
 * type, so it finds the script nodes whatever else the definition has; whether the host takes those types is decided by
 * the host's own compile after it.
 */
export function requireWorkflowScriptsInYaml(scripts: boolean | undefined, yaml: unknown, when: "save" | "start"): void {
    if (scripts !== false || typeof yaml !== "string" || !yaml.trim()) return;
    let ir: WorkflowIR | null = null;
    try { ir = compileWorkflow(yaml).ir; } catch { return; }
    requireWorkflowScripts({ scripts }, ir, when);
}
