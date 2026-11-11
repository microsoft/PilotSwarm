import fs from "node:fs";
import path from "node:path";
import {
    isRuntimeRoute, WORKFLOW_INTERFACE_NAME_PATTERN, WORKFLOW_INTERFACE_VERSION_PATTERN, WORKFLOW_ID_PATTERN, type WorkflowIR, type WorkflowIRAgent,
} from "./compiler.js";
import { assertJsonValue, canonicalJson, isJsonObject, sha256Hex, type JsonValue } from "./json.js";
import { normalizeSchema, schemaReferences, WorkflowSchemaError, WorkflowSchemaSet } from "./schema.js";

/**
 * A package agent's workflow interface (design 04 "Package-agent I/O export",
 * design 03 package agents, design 09 `interface: name@version`; R09, T011,
 * T071, mock M17 CONTRACT_MISMATCH).
 *
 * An agent file declares it in its front matter (agent schemaVersion 5, so a
 * loader that does not know it skips the agent instead of dropping the
 * contract):
 *
 *     workflowInterface:
 *       name: review_change
 *       version: "1"
 *       inputSchema: ./contracts/review-input.schema.json
 *       outputSchema: ./contracts/review-result.schema.json
 *       outcomes: [accepted, changes_required]
 *
 * The package validator reads the schema files inside the package (never a
 * path outside it, a link or a remote reference), checks them as workflow
 * JSON Schemas that stand alone (no $ref), and exports the interface in the
 * package manifest: the schemas themselves, the outcomes and a digest of all
 * of it. The agent registry keeps that manifest with each published version,
 * so the interface of an exact revision never changes.
 *
 * A workflow names it on an agent state (`invoke.agent: { name, package,
 * interface: review_change@1 }`). At publication,
 * the state's contract must match the exported interface exactly: the same
 * name and version, the same outcomes, the same output schema, and, when the
 * interface declares one, the same input schema. Nothing is inferred and no
 * schema narrowing is assumed safe. A mismatch, an agent that exports no
 * interface, or an interface record that is not well formed refuses the
 * publication (CONTRACT_MISMATCH); a match pins the interface's name, version
 * and digest with the agent's exact revision.
 */

/** The largest interface schema file. */
export const WORKFLOW_INTERFACE_SCHEMA_MAX_BYTES = 64 * 1024;
const OUTCOME_LIMIT = 32;

/** An interface as an agent file declares it: its schemas as package-relative files. */
export interface WorkflowInterfaceDeclaration {
    name: string;
    version: string;
    inputSchema?: string;
    outputSchema: string;
    outcomes: string[];
}

/** An interface as a package manifest exports it (and the agent registry keeps it): the schemas themselves, and its digest. */
export interface WorkflowInterfaceExport {
    name: string;
    version: string;
    inputSchema: JsonValue | null;
    outputSchema: JsonValue;
    outcomes: string[];
    digest: string;
}

export interface WorkflowInterfaceIssue {
    code: "invalid_workflow_interface" | "workflow_interface_schema";
    message: string;
}

/** sha256 of the canonical JSON of an interface's name, version, schemas and outcomes. */
export function workflowInterfaceDigest(value: { name: string; version: string; inputSchema: JsonValue | null; outputSchema: JsonValue; outcomes: string[] }): string {
    return sha256Hex(canonicalJson({ name: value.name, version: value.version, inputSchema: value.inputSchema ?? null,
        outputSchema: value.outputSchema, outcomes: value.outcomes }));
}

const isOutcomeList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= OUTCOME_LIMIT
    && value.every(item => typeof item === "string" && WORKFLOW_ID_PATTERN.test(item) && !isRuntimeRoute(item))
    && new Set(value).size === value.length;

/** What is wrong with a declaration's own fields (its files are read by exportWorkflowInterface); empty when nothing is. */
export function checkWorkflowInterfaceDeclaration(declared: unknown): string[] {
    if (!isJsonObject(declared)) return ["workflowInterface must be a mapping of name, version, outputSchema, outcomes and optionally inputSchema"];
    const problems: string[] = [];
    for (const key of Object.keys(declared)) {
        if (!["name", "version", "inputSchema", "outputSchema", "outcomes"].includes(key)) problems.push(`workflowInterface has an unknown field '${key}'`);
    }
    if (typeof declared.name !== "string" || !WORKFLOW_INTERFACE_NAME_PATTERN.test(declared.name)) {
        problems.push("workflowInterface.name must start with a letter, then up to 63 letters, digits, '_', '.' or '-'");
    }
    if (typeof declared.version !== "string" || !WORKFLOW_INTERFACE_VERSION_PATTERN.test(declared.version)) {
        problems.push("workflowInterface.version must be a short version label such as \"1\" (quote it)");
    }
    if (typeof declared.outputSchema !== "string" || !declared.outputSchema) problems.push("workflowInterface.outputSchema must name a schema file in the package");
    if (declared.inputSchema !== undefined && (typeof declared.inputSchema !== "string" || !declared.inputSchema)) {
        problems.push("workflowInterface.inputSchema, when given, must name a schema file in the package");
    }
    if (!isOutcomeList(declared.outcomes)) {
        problems.push(`workflowInterface.outcomes must list 1 to ${OUTCOME_LIMIT} distinct outcome labels (a letter, then letters, digits, '_' or '-'; not a runtime route)`);
    }
    return problems;
}

/** A normalized workflow schema that stands alone and compiles; throws WorkflowSchemaError otherwise. */
function standaloneSchema(value: unknown, at: string): JsonValue {
    const normalized = normalizeSchema(value, at);
    if (schemaReferences(normalized).length > 0) throw new WorkflowSchemaError("an interface schema stands alone: it may not use $ref", at);
    try {
        new WorkflowSchemaSet({ interface: normalized }).compileAll();
    } catch (error) {
        throw error instanceof WorkflowSchemaError ? error : new WorkflowSchemaError(error instanceof Error ? error.message : String(error), at);
    }
    return normalized;
}

/** One schema file a declaration names: a relative path inside the package, an ordinary file, a JSON workflow schema. */
function readInterfaceSchema(rootDir: string, ref: string, field: string, issues: WorkflowInterfaceIssue[]): JsonValue | undefined {
    const fail = (message: string) => { issues.push({ code: "workflow_interface_schema", message: `workflowInterface.${field} '${ref}': ${message}` }); return undefined; };
    if (ref.includes("\0") || ref.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref) || path.isAbsolute(ref)) {
        return fail("must be a relative path inside the package (no absolute path, URL or backslash)");
    }
    const parts = ref.split("/").filter(part => part !== "" && part !== ".");
    if (parts.length === 0 || parts.some(part => part === "..")) return fail("must be a file inside the package (no '..')");
    const root = path.resolve(rootDir);
    const resolved = path.resolve(root, ...parts);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return fail("must be a file inside the package");
    let stat: fs.Stats;
    try { stat = fs.lstatSync(resolved); } catch { return fail("is not in the package"); }
    if (stat.isSymbolicLink() || !stat.isFile()) return fail("must be an ordinary file");
    try {
        const realRoot = fs.realpathSync(root);
        const realFile = fs.realpathSync(resolved);
        const realRelative = path.relative(realRoot, realFile);
        if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) return fail("must be a file inside the package");
    } catch {
        return fail("could not be read");
    }
    if (stat.size > WORKFLOW_INTERFACE_SCHEMA_MAX_BYTES) return fail(`is larger than ${WORKFLOW_INTERFACE_SCHEMA_MAX_BYTES} bytes`);
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(resolved, "utf8")); } catch (error) {
        return fail(`is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    try {
        // `$` is the file's own root: a problem names where in the file it is. Plain JSON data first (finite numbers, at
        // most 64 levels deep), so a schema that is not cannot reach the digest.
        assertJsonValue(parsed, "$");
        return standaloneSchema(parsed, "$");
    } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
}

/**
 * The interface a package exports for one agent's declaration: its schema files read from inside `rootDir` (the
 * package root), checked, and digested. Issues name what is wrong; there is no export when there is any.
 */
export function exportWorkflowInterface(rootDir: string, declared: unknown): { exported: WorkflowInterfaceExport | null; issues: WorkflowInterfaceIssue[] } {
    const issues = checkWorkflowInterfaceDeclaration(declared).map((message): WorkflowInterfaceIssue => ({ code: "invalid_workflow_interface", message }));
    if (issues.length > 0) return { exported: null, issues };
    const declaration = declared as unknown as WorkflowInterfaceDeclaration;
    const outputSchema = readInterfaceSchema(rootDir, declaration.outputSchema, "outputSchema", issues);
    const inputSchema = declaration.inputSchema === undefined ? null : readInterfaceSchema(rootDir, declaration.inputSchema, "inputSchema", issues);
    if (issues.length > 0 || outputSchema === undefined || inputSchema === undefined) return { exported: null, issues };
    const body = { name: declaration.name, version: declaration.version, inputSchema, outputSchema, outcomes: [...declaration.outcomes] };
    return { exported: { ...body, digest: workflowInterfaceDigest(body) }, issues };
}

/** An exported interface as the agent registry keeps it, checked again (shape, schemas and digest); null when it is not well formed. */
export function readWorkflowInterfaceExport(value: unknown): WorkflowInterfaceExport | null {
    if (!isJsonObject(value)) return null;
    const { name, version, inputSchema, outputSchema, outcomes, digest } = value as Record<string, unknown>;
    if (typeof name !== "string" || !WORKFLOW_INTERFACE_NAME_PATTERN.test(name) || typeof version !== "string"
        || !WORKFLOW_INTERFACE_VERSION_PATTERN.test(version) || !isOutcomeList(outcomes) || typeof digest !== "string") return null;
    try {
        assertJsonValue(value, "workflowInterface");
        const output = standaloneSchema(outputSchema, "workflowInterface.outputSchema");
        const input = inputSchema === null || inputSchema === undefined ? null : standaloneSchema(inputSchema, "workflowInterface.inputSchema");
        const body = { name, version, inputSchema: input, outputSchema: output, outcomes: [...outcomes] };
        return workflowInterfaceDigest(body) === digest ? { ...body, digest } : null;
    } catch {
        return null;
    }
}

/**
 * Why an agent state's contract does not match the interface its agent exports (empty when it matches): the
 * interface it names (`wanted`), the exact outcomes, the exact output schema, and the exact input schema when the
 * interface declares one. `exported` is what the registry keeps for the agent's pinned revision (undefined: none).
 */
export function workflowInterfaceMismatches(node: Pick<WorkflowIRAgent, "outcomes" | "inputSchema" | "outputSchema">, ir: Pick<WorkflowIR, "schemaDefs">,
    wanted: { name: string; version: string }, exported: unknown): string[] {
    if (exported === undefined || exported === null) return [`its agent exports no workflow interface (expected ${wanted.name}@${wanted.version})`];
    const iface = readWorkflowInterfaceExport(exported);
    if (!iface) return ["its agent's workflow interface record is not well formed"];
    if (iface.name !== wanted.name || iface.version !== wanted.version) {
        return [`its agent exports ${iface.name}@${iface.version}, not ${wanted.name}@${wanted.version}`];
    }
    const problems: string[] = [];
    const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every(item => right.includes(item));
    if (!same(node.outcomes, iface.outcomes)) {
        problems.push(`its outcomes [${node.outcomes.join(", ")}] are not the interface's [${iface.outcomes.join(", ")}]`);
    }
    const schemaOf = (name: string | null) => (name !== null && Object.hasOwn(ir.schemaDefs, name) ? ir.schemaDefs[name] : undefined);
    const output = schemaOf(node.outputSchema);
    if (output === undefined || canonicalJson(output) !== canonicalJson(iface.outputSchema)) {
        problems.push("its outputSchema is not exactly the interface's output schema");
    }
    if (iface.inputSchema !== null) {
        const input = schemaOf(node.inputSchema);
        if (input === undefined || canonicalJson(input) !== canonicalJson(iface.inputSchema)) {
            problems.push("its inputSchema is not exactly the interface's input schema");
        }
    }
    return problems;
}
