/**
 * Script nodes are gated on their own (Workflow Simplified stage 2.0, coordinator 03:02Z: one switch). PILOTSWARM_WORKFLOWS
 * alone gives the workflow tools and screens; PILOTSWARM_WORKFLOW_SCRIPTS only decides whether script nodes run. A host that
 * knows its workers run no scripts (`scripts: false`) refuses a definition with a script node when it is saved and when it
 * is started, in words that name the setting, before anything is written. A host that does not know (`scripts` absent: a
 * portal or MCP server whose own process does not set the variable) does not refuse; such a run fails at its first script
 * node, with the same setting named (runtime.ts).
 */
import { compileWorkflowV2, type WorkflowIR } from "./compiler.js";
import { WorkflowStoreError } from "./store.js";

export const WORKFLOW_SCRIPTS_DISABLED = "WORKFLOW_SCRIPTS_DISABLED";

/** The ids of a definition's script nodes (parallel bodies included: their members are nodes of the IR), in IR order. */
export function workflowV2ScriptNodes(ir: Pick<WorkflowIR, "nodes"> | null | undefined): string[] {
    if (!ir || typeof ir.nodes !== "object" || ir.nodes === null) return [];
    return Object.values(ir.nodes).filter(node => node?.type === "script").map(node => String(node.id));
}

/** The refusal's words: the script nodes, the setting, and what was not done. */
export function workflowScriptsDisabledText(nodes: readonly string[], when: "save" | "start" | "test"): string {
    const list = nodes.slice(0, 5).join(", ") + (nodes.length > 5 ? `, and ${nodes.length - 5} more` : "");
    return `This workflow has script node${nodes.length === 1 ? "" : "s"} (${list}), and script nodes are turned off on this server. `
        + "An operator turns them on with PILOTSWARM_WORKFLOW_SCRIPTS=1 on every worker. "
        + (when === "save" ? "Nothing was saved." : when === "test" ? "Nothing was tested." : "Nothing was started.");
}

/**
 * Refuses (WORKFLOW_SCRIPTS_DISABLED) a definition with a script node on a host whose workers run no scripts. `scripts`
 * absent: not known here, no refusal. An IR that is not there (a definition that does not compile) has no node to refuse.
 */
export function requireWorkflowScripts(host: { scripts?: boolean }, ir: Pick<WorkflowIR, "nodes"> | null | undefined, when: "save" | "start" | "test"): void {
    if (host.scripts !== false) return;
    const nodes = workflowV2ScriptNodes(ir);
    if (!nodes.length) return;
    throw new WorkflowStoreError(WORKFLOW_SCRIPTS_DISABLED, workflowScriptsDisabledText(nodes, when), { scriptNodes: nodes, setting: "PILOTSWARM_WORKFLOW_SCRIPTS" });
}

/** Every node type a host may take: a definition's script nodes are found whichever other node types it has. */
const EVERY_NODE_TYPE = { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true, enableClockWaits: true } as const;

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
    try { ir = compileWorkflowV2(yaml, EVERY_NODE_TYPE).ir; } catch { return; }
    requireWorkflowScripts({ scripts }, ir, when);
}
