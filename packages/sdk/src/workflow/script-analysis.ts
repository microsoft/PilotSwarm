import { parse } from "acorn";

export const WORKFLOW_TOOL_CONCURRENCY_MESSAGE = "Concurrent workflow tool calls are not supported. "
    + "Await each callTool call one at a time; use a for...of loop instead of Promise.all.";
const stackOverflow = (error: unknown): error is RangeError =>
    error instanceof RangeError && /call stack|too much recursion/i.test(error.message);

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

function binds(pattern: unknown, name: string): boolean {
    if (!isNode(pattern)) return false;
    if (pattern.type === "Identifier") return pattern.name === name;
    if (pattern.type === "Property") return binds(pattern.value, name);
    if (pattern.type === "AssignmentPattern") return binds(pattern.left, name);
    return children(pattern).some(child => binds(child, name));
}

function declares(node: SyntaxNode, name: string): boolean {
    if (node.type === "VariableDeclaration") {
        return Array.isArray(node.declarations) && node.declarations.some(item => isNode(item) && binds(item.id, name));
    }
    if (["FunctionDeclaration", "ClassDeclaration"].includes(node.type)) return binds(node.id, name);
    if (node.type === "ImportDeclaration") {
        return Array.isArray(node.specifiers) && node.specifiers.some(item => isNode(item) && binds(item.local, name));
    }
    if (node.type.startsWith("Export") && isNode(node.declaration)) return declares(node.declaration, name);
    return false;
}

function hasVar(node: SyntaxNode, name: string): boolean {
    return (node.type === "VariableDeclaration" && node.kind === "var" && declares(node, name))
        || children(node).some(child => !isFunction(child) && child.type !== "StaticBlock" && hasVar(child, name));
}

function shadows(node: SyntaxNode, name: string): boolean {
    if (isFunction(node)) {
        return binds(node.id, name) || (Array.isArray(node.params) && node.params.some(param => binds(param, name)));
    }
    if (node.type === "Program" || node.type === "BlockStatement" || node.type === "StaticBlock") {
        return ((node.type === "Program" || node.type === "StaticBlock") && hasVar(node, name))
            || (Array.isArray(node.body) && node.body.some(item => isNode(item) && declares(item, name)));
    }
    if (["ForStatement", "ForOfStatement", "ForInStatement"].includes(node.type)) {
        const declaration = node.init ?? node.left;
        return isNode(declaration) && declares(declaration, name);
    }
    if (node.type === "CatchClause") return binds(node.param, name);
    if (node.type === "SwitchStatement" && Array.isArray(node.cases)) {
        return node.cases.some(item => isNode(item) && Array.isArray(item.consequent)
            && item.consequent.some(statement => isNode(statement) && declares(statement, name)));
    }
    return node.type === "ClassExpression" && binds(node.id, name);
}

function parallelPromise(node: SyntaxNode): boolean {
    if (node.type !== "CallExpression" || !isNode(node.callee) || node.callee.type !== "MemberExpression") return false;
    const member = node.callee;
    if (!isNode(member.object) || member.object.type !== "Identifier" || member.object.name !== "Promise" || !isNode(member.property)) return false;
    const name = member.computed ? member.property.type === "Literal" ? member.property.value : null : member.property.name;
    return name === "all" || name === "allSettled";
}

/** Syntax only: never execute a script or evaluate a dynamic tool name. */
export function scriptToolRequirements(source: string): {
    tools: string[]; dynamic: boolean; unchecked: boolean; syntaxError?: string; concurrent?: boolean;
} {
    let tree: unknown;
    try {
        tree = parse(source, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true });
    } catch (error) {
        if (stackOverflow(error)) return { tools: [], dynamic: false, unchecked: true };
        if (!(error instanceof SyntaxError)) throw error;
        return { tools: [], dynamic: false, unchecked: true, syntaxError: error.message };
    }
    const tools = new Set<string>();
    let dynamic = false;
    let concurrent = false;
    const visit = (node: SyntaxNode, toolShadowed: boolean, promiseShadowed: boolean, parallel: boolean): void => {
        const switchScope = node.type === "SwitchStatement";
        const localTool = toolShadowed || (!switchScope && shadows(node, "callTool"));
        const localPromise = promiseShadowed || (!switchScope && shadows(node, "Promise"));
        const localParallel = parallel || (!localPromise && parallelPromise(node));
        if (!localTool && node.type === "CallExpression" && isNode(node.callee)
            && node.callee.type === "Identifier" && node.callee.name === "callTool") {
            if (localParallel) concurrent = true;
            const first: unknown = Array.isArray(node.arguments) ? node.arguments[0] : null;
            if (isNode(first) && first.type === "Literal" && typeof first.value === "string") tools.add(first.value);
            else if (isNode(first) && first.type === "TemplateLiteral" && Array.isArray(first.expressions)
                && first.expressions.length === 0 && Array.isArray(first.quasis) && isNode(first.quasis[0])) {
                const value = first.quasis[0].value;
                if (value !== null && typeof value === "object" && "cooked" in value && typeof value.cooked === "string") tools.add(value.cooked);
                else dynamic = true;
            } else dynamic = true;
        }
        for (const child of children(node)) {
            // Function body vars are not in the environment that evaluates default parameters.
            const body = isFunction(node) && child === node.body;
            const cases = switchScope && child !== node.discriminant;
            visit(child, localTool || (body && hasVar(child, "callTool")) || (cases && shadows(node, "callTool")),
                localPromise || (body && hasVar(child, "Promise")) || (cases && shadows(node, "Promise")), localParallel);
        }
    };
    try { if (isNode(tree)) visit(tree, false, false, false); }
    catch (error) {
        if (!stackOverflow(error)) throw error;
        return { tools: [], dynamic: false, unchecked: true };
    }
    return { tools: [...tools], dynamic, unchecked: false, ...(concurrent ? { concurrent } : {}) };
}
