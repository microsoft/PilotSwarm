import { parse } from "acorn";
import type { WorkflowDiagnostic, WorkflowIR } from "./compiler.js";
import { WorkflowStoreError } from "./store.js";
import {
    admittedWorkflowToolGrant, isWorkflowControlTool, isWorkflowLiveSessionTool, workflowLiveSessionToolMessage,
    type WorkflowToolBinding,
} from "./tool-policy.js";

interface SyntaxNode {
    type: string;
    [key: string]: unknown;
}

const isNode = (value: unknown): value is SyntaxNode =>
    value !== null && typeof value === "object" && "type" in value && typeof value.type === "string";
const children = (node: SyntaxNode): SyntaxNode[] =>
    Object.values(node).flatMap(value => Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : []);
const isFunction = (node: SyntaxNode): boolean =>
    ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type);

function bindsCallTool(pattern: unknown): boolean {
    if (!isNode(pattern)) return false;
    if (pattern.type === "Identifier") return pattern.name === "callTool";
    if (pattern.type === "Property") return bindsCallTool(pattern.value);
    if (pattern.type === "AssignmentPattern") return bindsCallTool(pattern.left);
    return children(pattern).some(bindsCallTool);
}

function declaresCallTool(node: SyntaxNode): boolean {
    if (node.type === "VariableDeclaration") {
        return Array.isArray(node.declarations) && node.declarations.some(item => isNode(item) && bindsCallTool(item.id));
    }
    if (["FunctionDeclaration", "ClassDeclaration"].includes(node.type)) return bindsCallTool(node.id);
    if (node.type === "ImportDeclaration") {
        return Array.isArray(node.specifiers) && node.specifiers.some(item => isNode(item) && bindsCallTool(item.local));
    }
    if (node.type.startsWith("Export") && isNode(node.declaration)) return declaresCallTool(node.declaration);
    return false;
}

function hasVarCallTool(node: SyntaxNode): boolean {
    return (node.type === "VariableDeclaration" && node.kind === "var" && declaresCallTool(node))
        || children(node).some(child => !isFunction(child) && hasVarCallTool(child));
}

function shadowsCallTool(node: SyntaxNode): boolean {
    if (isFunction(node)) {
        return bindsCallTool(node.id) || (Array.isArray(node.params) && node.params.some(bindsCallTool))
            || (isNode(node.body) && hasVarCallTool(node.body));
    }
    if (node.type === "Program" || node.type === "BlockStatement" || node.type === "StaticBlock") {
        return (node.type === "Program" && hasVarCallTool(node))
            || (Array.isArray(node.body) && node.body.some(item => isNode(item) && declaresCallTool(item)));
    }
    if (["ForStatement", "ForOfStatement", "ForInStatement"].includes(node.type)) {
        const declaration = node.init ?? node.left;
        return isNode(declaration) && declaresCallTool(declaration);
    }
    if (node.type === "CatchClause") return bindsCallTool(node.param);
    if (node.type === "SwitchStatement" && Array.isArray(node.cases)) {
        return node.cases.some(item => isNode(item) && Array.isArray(item.consequent)
            && item.consequent.some(statement => isNode(statement) && declaresCallTool(statement)));
    }
    return node.type === "ClassExpression" && bindsCallTool(node.id);
}

/** Syntax only: never execute a script or evaluate a dynamic tool name. */
export function scriptToolRequirements(source: string): { tools: string[]; dynamic: boolean; unchecked: boolean } {
    let tree: unknown;
    try {
        tree = parse(source, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true });
    } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return { tools: [], dynamic: false, unchecked: true };
    }
    const tools = new Set<string>();
    let dynamic = false;
    const visit = (node: SyntaxNode, shadowed: boolean): void => {
        const local = shadowed || shadowsCallTool(node);
        if (!local && node.type === "CallExpression" && isNode(node.callee)
            && node.callee.type === "Identifier" && node.callee.name === "callTool") {
            const first: unknown = Array.isArray(node.arguments) ? node.arguments[0] : null;
            if (isNode(first) && first.type === "Literal" && typeof first.value === "string") tools.add(first.value);
            else if (isNode(first) && first.type === "TemplateLiteral" && Array.isArray(first.expressions)
                && first.expressions.length === 0 && Array.isArray(first.quasis) && isNode(first.quasis[0])) {
                const value = first.quasis[0].value;
                if (value !== null && typeof value === "object" && "cooked" in value && typeof value.cooked === "string") tools.add(value.cooked);
                else dynamic = true;
            } else dynamic = true;
        }
        for (const child of children(node)) visit(child, local);
    };
    if (isNode(tree)) visit(tree, false);
    return { tools: [...tools], dynamic, unchecked: false };
}

export function scriptToolWarnings(source: string, path: string): WorkflowDiagnostic[] {
    const requirements = scriptToolRequirements(source);
    const warnings: WorkflowDiagnostic[] = [];
    if (requirements.dynamic) warnings.push({
        severity: "warning", code: "WORKFLOW_TOOLS_DYNAMIC", path,
        message: "This script uses a dynamic callTool name. Save and Start cannot check which tool it will use; it must be in the captured grant when the call runs.",
    });
    if (requirements.unchecked) warnings.push({
        severity: "warning", code: "WORKFLOW_TOOLS_UNCHECKED", path,
        message: "The script's syntax could not be analyzed for tool names. Save and Start cannot check its tool requirements; run-time tool checks still apply.",
    });
    return warnings;
}

export function workflowToolDiagnostics(ir: Pick<WorkflowIR, "nodes"> | null | undefined,
    binding: WorkflowToolBinding | null, grantKnown = true): WorkflowDiagnostic[] {
    const diagnostics: WorkflowDiagnostic[] = [];
    for (const node of Object.values(ir?.nodes ?? {})) {
        if (node.type !== "script") continue;
        const path = `states.${node.id}.source`;
        const requirements = scriptToolRequirements(node.source);
        diagnostics.push(...scriptToolWarnings(node.source, path));
        for (const tool of requirements.tools) {
            if (isWorkflowLiveSessionTool(tool)) {
                diagnostics.push({ severity: "warning", code: "WORKFLOW_TOOL_LIVE_SESSION", path, message: workflowLiveSessionToolMessage(tool) });
            } else if (isWorkflowControlTool(tool)) {
                diagnostics.push({ severity: "warning", code: "WORKFLOW_TOOL_NOT_GRANTED", path, message: `Workflow control tool '${tool}' cannot run in a script.` });
            } else if (grantKnown) {
                try { admittedWorkflowToolGrant(tool, binding?.tools ?? [], binding?.excludedTools ?? []); }
                catch {
                    diagnostics.push({ severity: "warning", code: "WORKFLOW_TOOL_NOT_GRANTED", path,
                        message: `Tool '${tool}' is not uniquely available in this session's captured tool grant. Attach or enable it before Start.` });
                }
            }
        }
        if (!grantKnown && requirements.tools.length) diagnostics.push({
            severity: "warning", code: "WORKFLOW_TOOLS_UNCHECKED", path,
            message: "This session's tool grant could not be checked at Save. Start will check its captured grant before creating a Workflow.",
        });
    }
    return diagnostics;
}

/** Check new admissions and resumed claims, never replace the grant of an already admitted Workflow. */
export function requireWorkflowToolRequirements(ir: Pick<WorkflowIR, "nodes"> | null | undefined,
    binding: WorkflowToolBinding | null, name: string): WorkflowDiagnostic[] {
    const diagnostics = workflowToolDiagnostics(ir, binding);
    const missing = diagnostics.filter(item => ["WORKFLOW_TOOL_NOT_GRANTED", "WORKFLOW_TOOL_LIVE_SESSION"].includes(item.code));
    if (missing.length) {
        throw new WorkflowStoreError("WORKFLOW_TOOLS_UNAVAILABLE", `${name} was not started: `
            + missing.slice(0, 10).map(item => `${item.path}: ${item.message}`).join(" ")
            + (missing.length > 10 ? ` And ${missing.length - 10} more tool requirements.` : "")
            + " Nothing was started.", { diagnostics: missing.map(item => ({ code: item.code, path: item.path, message: item.message })) });
    }
    return diagnostics;
}
