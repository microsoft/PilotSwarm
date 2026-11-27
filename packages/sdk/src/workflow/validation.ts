import type { ClusterDecisionCapability } from "../provider-catalog.js";
import { workflowSaveCompilation } from "./agent-models.js";
import { compileWorkflow, type WorkflowDiagnostic } from "./compiler.js";
import { WORKFLOW_SCRIPTS_DISABLED, workflowScriptNodes, workflowScriptsDisabledText } from "./scripts-gate.js";
import { workflowToolDiagnostics } from "./tool-requirements.js";
import { workflowGraphJson } from "./tools.js";

export interface WorkflowValidationDiagnostic {
    code: string;
    path: string;
    message: string;
    line?: number;
}

export interface WorkflowValidationResult {
    valid: boolean;
    name: string | null;
    errors: WorkflowValidationDiagnostic[];
    warnings: WorkflowValidationDiagnostic[];
    graph: {
        initial: string;
        notes?: string;
        states: Array<Record<string, unknown>>;
        inputsSchema: Record<string, unknown> | null;
    } | null;
    inputsSchema: Record<string, unknown> | null;
}

function toValidationDiagnostic(d: WorkflowDiagnostic): WorkflowValidationDiagnostic {
    return {
        code: d.code,
        path: d.path,
        message: d.message,
        ...(Number.isSafeInteger(d.line) ? { line: d.line as number } : {}),
    };
}

/**
 * Pure, no-write validation of a Workflow YAML document against the compiler and host-level
 * scripts / Decision capability posture. Session-bound checks (WORKFLOW_NAME_MISMATCH,
 * AGENT_HAS_WORKFLOWS, WORKFLOW_SPAWN_DEFINITION_MISSING, session tool grants, and REVISION_STALE)
 * run only at save or start on a specific session.
 */
export async function validateWorkflowYaml(
    yaml: string,
    options?: {
        scripts?: boolean;
        decisionCapability?: () => Promise<ClusterDecisionCapability>;
    },
): Promise<WorkflowValidationResult> {
    const compiled = compileWorkflow(yaml);
    if (!compiled.ir) {
        const errors = compiled.diagnostics.filter(d => d.severity !== "warning").map(toValidationDiagnostic);
        const warnings = compiled.diagnostics.filter(d => d.severity === "warning").map(toValidationDiagnostic);
        return { valid: false, name: compiled.name, errors, warnings, graph: null, inputsSchema: null };
    }

    const extraDiagnostics: WorkflowDiagnostic[] = [];
    if (options?.scripts === false) {
        const scriptNodes = workflowScriptNodes(compiled.ir);
        if (scriptNodes.length > 0) {
            extraDiagnostics.push({
                severity: "error",
                code: WORKFLOW_SCRIPTS_DISABLED,
                path: `states.${scriptNodes[0]}.type`,
                message: workflowScriptsDisabledText(scriptNodes, "save"),
            });
        }
    }

    const toolDiagnostics = workflowToolDiagnostics(compiled.ir, null, false)
        .filter(d => !(
            d.code === "WORKFLOW_TOOLS_UNCHECKED"
            && d.path.endsWith(".source")
            && d.message.includes("could not be checked at Save")
        ));
    extraDiagnostics.push(...toolDiagnostics);

    const persisted = await workflowSaveCompilation(compiled, options?.decisionCapability, extraDiagnostics);
    const errors = persisted.diagnostics.filter(d => d.severity !== "warning").map(toValidationDiagnostic);
    const warnings = persisted.diagnostics.filter(d => d.severity === "warning").map(toValidationDiagnostic);
    const valid = persisted.valid && errors.length === 0;

    if (!valid || !persisted.ir) {
        return { valid: false, name: persisted.name, errors, warnings, graph: null, inputsSchema: null };
    }

    const { revision: _revision, ...graphRest } = workflowGraphJson(persisted.ir, 0);
    const graph = graphRest as unknown as NonNullable<WorkflowValidationResult["graph"]>;
    const inputsSchema = (graph.inputsSchema as Record<string, unknown> | null) ?? null;
    return { valid: true, name: persisted.name, errors, warnings, graph, inputsSchema };
}
