import type { SessionOwnerInfo } from "../../types.js";
import type { WorkflowToolBinding } from "../tool-policy.js";
import { assertJsonValue, isJsonObject, jsonbSafeText, previewJson, type JsonValue } from "./json.js";
import { describeWorkflowV2States } from "./runtime.js";
import { createWorkflowV2, reconcileWorkflowV2Run, updateWorkflowV2, type WorkflowV2Command, type WorkflowV2Host } from "./service.js";
import { diagnosticsJson, WorkflowStoreError, type WorkflowActor, type WorkflowDefinitionReceipt, type WorkflowStore } from "./store.js";

/**
 * Agent tool adapters for workflow v2. Each returns one JSON payload; the
 * calling agent's session id comes from the host, never from arguments.
 */

export const UPDATE_WORKFLOW_TOOL_SPEC = {
    description:
        "Change a workflow child you created with spawn_workflow (apiVersion pilotswarm.dev/v2-draft). "
        + "operation: replace_definition (yaml + expected_revision; drafts only, same metadata.version), "
        + "publish (expected_revision + definition_hash of the exact reviewed revision; does not start), "
        + "publish_and_start (publish fields + inputs), or start (definition_hash + inputs; one live run per workflow child). "
        + "operation_id makes the call idempotent: repeating it returns the original receipt; reusing it for a different request fails. "
        + "Published definitions never change; a new version needs a new workflow child. Returns JSON.",
    parameters: {
        type: "object",
        properties: {
            workflow_id: { type: "string", description: "The workflow session id from spawn_workflow." },
            operation: { type: "string", enum: ["replace_definition", "publish", "publish_and_start", "start"] },
            operation_id: { type: "string", description: "Idempotency id for this change." },
            yaml: { type: "string", description: "replace_definition: the complete new Workflow YAML." },
            expected_revision: { type: "integer", description: "replace_definition/publish: the draft revision you reviewed." },
            definition_hash: { type: "string", description: "publish/start: the yamlSha256 of the reviewed revision." },
            inputs: { type: "object", description: "publish_and_start/start: static run inputs checked against inputs.schema." },
        },
        required: ["workflow_id", "operation", "operation_id"],
    },
} as const;

export const READ_WORKFLOW_TOOL_SPEC = {
    description:
        "Read a workflow child you created with spawn_workflow (v2): definition state, current revision and diagnostics, "
        + "the graph, runs, and the node executions of one run (default: the live run). Returns JSON. Reading changes nothing.",
    parameters: {
        type: "object",
        properties: {
            workflow_id: { type: "string", description: "The workflow session id." },
            run_id: { type: "string", description: "Optional run id; default the live run." },
            include_yaml: { type: "boolean", description: "Include the current revision's YAML. Default false." },
        },
        required: ["workflow_id"],
    },
} as const;

export type WorkflowToolHost = WorkflowV2Host;

function payload(value: { [key: string]: JsonValue }): string {
    return JSON.stringify(value);
}

function errorPayload(error: unknown): string {
    if (error instanceof WorkflowStoreError) {
        return payload({ ok: false, error: { code: error.code, message: jsonbSafeText(error.message, 2_000), details: error.details } });
    }
    const message = error instanceof Error ? error.message : String(error);
    return payload({ ok: false, error: { code: "WORKFLOW_ERROR", message: jsonbSafeText(message, 2_000) } });
}

function receiptJson(receipt: WorkflowDefinitionReceipt, replayed: boolean): { [key: string]: JsonValue } {
    return {
        workflowId: receipt.workflowSessionId, operation: receipt.operation, replayed, state: receipt.state,
        revision: receipt.revision, definitionHash: receipt.yamlSha256, valid: receipt.valid, irSha256: receipt.irSha256,
        diagnostics: diagnosticsJson(receipt.diagnostics), publishedRevision: receipt.publishedRevision,
        run: receipt.run ? { runId: receipt.run.runId, mode: receipt.run.mode, revision: receipt.run.revision } : null,
    };
}

/** The calling agent must be the workflow's parent, by catalog lineage and the definition's own record. */
async function authorizeParent(host: WorkflowToolHost, workflowSessionId: string, callerSessionId: string): Promise<void> {
    const [row, definition] = await Promise.all([host.catalog.getSession(workflowSessionId), host.store.readDefinition(workflowSessionId)]);
    if (!row || row.deletedAt || row.sessionKind !== "workflow" || !definition) {
        throw new WorkflowStoreError("WORKFLOW_NOT_FOUND", `No v2 workflow ${workflowSessionId} is visible to this session.`);
    }
    if (row.parentSessionId !== callerSessionId || definition.parentSessionId !== callerSessionId) {
        throw new WorkflowStoreError("FORBIDDEN", "Only the agent that created this workflow may change or read it with this tool.");
    }
}

function optionalString(args: Record<string, unknown>, name: string): string | null {
    const value = args[name];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || !value.trim()) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `${name} must be a non-empty string.`);
    return value;
}

function requiredString(args: Record<string, unknown>, name: string): string {
    const value = optionalString(args, name);
    if (value === null) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `${name} is required.`);
    return value;
}

function revisionArg(args: Record<string, unknown>): number {
    const value = args.expected_revision;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "expected_revision must be a positive integer.");
    }
    return value;
}

function inputsArg(args: Record<string, unknown>): JsonValue {
    const value = args.inputs === undefined ? {} : args.inputs;
    if (!isJsonObject(value)) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "inputs must be a JSON object.");
    assertJsonValue(value, "inputs");
    return value;
}

/** Parse update_workflow arguments into a typed command. */
export function parseUpdateWorkflowArgs(args: Record<string, unknown>): { workflowSessionId: string; operationId: string; command: WorkflowV2Command } {
    const workflowSessionId = requiredString(args, "workflow_id");
    const operationId = requiredString(args, "operation_id");
    const operation = args.operation;
    let command: WorkflowV2Command;
    if (operation === "replace_definition") command = { operation, yaml: requiredString(args, "yaml"), expectedRevision: revisionArg(args) };
    else if (operation === "publish") command = { operation, expectedRevision: revisionArg(args), definitionHash: requiredString(args, "definition_hash") };
    else if (operation === "publish_and_start") {
        command = { operation, expectedRevision: revisionArg(args), definitionHash: requiredString(args, "definition_hash"), inputs: inputsArg(args) };
    } else if (operation === "start") command = { operation, definitionHash: requiredString(args, "definition_hash"), inputs: inputsArg(args) };
    else throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "operation must be replace_definition, publish, publish_and_start or start.");
    return { workflowSessionId, operationId, command };
}

export async function updateWorkflowFromTool(args: Record<string, unknown>, context: { callerSessionId: string; host: WorkflowToolHost }): Promise<string> {
    try {
        const { workflowSessionId, operationId, command } = parseUpdateWorkflowArgs(args);
        await authorizeParent(context.host, workflowSessionId, context.callerSessionId);
        const actor: WorkflowActor = { kind: "agent", sessionId: context.callerSessionId };
        const stored = await updateWorkflowV2(context.host, workflowSessionId, command, { actor, operationId });
        return payload({ ok: true, ...receiptJson(stored.receipt, stored.replayed) });
    } catch (error) {
        return errorPayload(error);
    }
}

/** A bounded JSON view of a workflow child for tools and clients. */
export async function readWorkflowV2View(store: WorkflowStore, workflowSessionId: string, options: { runId?: string | null; includeYaml?: boolean } = {}): Promise<{ [key: string]: JsonValue }> {
    const definition = await store.readDefinition(workflowSessionId);
    if (!definition) throw new WorkflowStoreError("WORKFLOW_NOT_FOUND", `No v2 workflow ${workflowSessionId}.`);
    const revision = await store.readRevision(workflowSessionId, definition.currentRevision);
    if (!revision) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "The current revision is missing.");
    const graphRevision = definition.publishedRevision ?? definition.currentRevision;
    const graphRow = graphRevision === revision.revision ? revision : await store.readRevision(workflowSessionId, graphRevision);
    const ir = graphRow?.valid && graphRow.irSha256 ? await store.readRevisionIr(workflowSessionId, graphRow.revision, graphRow.irSha256) : null;
    const runs = await store.listRuns(workflowSessionId);
    const selected = options.runId ? runs.find(run => run.runId === options.runId) : runs.find(run => run.mode === "live");
    if (options.runId && !selected) throw new WorkflowStoreError("RUN_NOT_FOUND", `Run ${options.runId} is not a run of this workflow.`);
    const nodes = selected ? await store.listNodeExecutions(selected.runId, 200) : [];
    return {
        workflowId: workflowSessionId,
        definition: {
            state: definition.state, semver: definition.semver, currentRevision: definition.currentRevision,
            publishedRevision: definition.publishedRevision, publishedDefinitionHash: definition.publishedYamlSha256,
        },
        revision: {
            revision: revision.revision, definitionHash: revision.yamlSha256, valid: revision.valid, irSha256: revision.irSha256,
            name: revision.name, diagnostics: diagnosticsJson(revision.diagnostics),
            ...(options.includeYaml ? { yaml: jsonbSafeText(revision.yaml) } : {}),
        },
        graph: ir ? { revision: graphRevision, initial: ir.initial, states: describeWorkflowV2States(ir) } : null,
        runs: runs.map(run => ({ runId: run.runId, mode: run.mode, status: run.status, revision: run.revision, outcome: run.terminalOutcome })),
        run: selected ? {
            runId: selected.runId, mode: selected.mode, status: selected.status, outcome: selected.terminalOutcome,
            terminalState: selected.terminalNodeId,
            output: selected.terminalOutput === null ? null : previewJson(selected.terminalOutput, 2_000),
            error: selected.terminalError === null ? null : previewJson(selected.terminalError, 2_000),
            nodeExecutions: nodes.map(node => ({
                nodeExecutionId: node.nodeExecutionId, stateId: node.nodeId, ordinal: node.ordinal, state: node.state,
                outcome: node.outcome, resultKind: node.resultKind, winner: node.winner, attempts: node.effectAttempts,
                ...(node.resultKind === "business" ? { outputPreview: previewJson(node.output, 500) } : {}),
                ...(node.resultKind === "runtime_error" ? { errorPreview: previewJson(node.error, 500) } : {}),
            })),
        } : null,
    };
}

export async function readWorkflowFromTool(args: Record<string, unknown>, context: { callerSessionId: string; host: WorkflowToolHost }): Promise<string> {
    try {
        const workflowSessionId = requiredString(args, "workflow_id");
        await authorizeParent(context.host, workflowSessionId, context.callerSessionId);
        // A run whose controller can no longer end it is ended (or re-dispatched) before it is shown.
        for (const run of await context.host.store.listRuns(workflowSessionId)) await reconcileWorkflowV2Run(context.host, run.runId);
        const view = await readWorkflowV2View(context.host.store, workflowSessionId, {
            runId: optionalString(args, "run_id"), includeYaml: args.include_yaml === true,
        });
        return payload({ ok: true, ...view });
    } catch (error) {
        return errorPayload(error);
    }
}

/** spawn_workflow for a v2 document: a draft by default, or published (and started) when asked. */
export async function spawnWorkflowV2FromTool(
    args: { yaml: string; inputs?: Record<string, unknown>; notify_on_completion?: boolean; key?: string; state?: string; start?: boolean },
    context: {
        callerSessionId: string;
        workflowSessionId: string;
        operationId: string;
        owner: SessionOwnerInfo | null;
        binding: WorkflowToolBinding;
        host: WorkflowToolHost;
    },
): Promise<string> {
    try {
        if (args.state !== undefined && args.state !== "draft" && args.state !== "published") {
            throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "state must be draft or published.");
        }
        const publish = args.state === "published";
        if (args.start === true && !publish) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "start needs state: published.");
        const inputs = args.inputs === undefined ? {} : args.inputs;
        if (!isJsonObject(inputs)) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "inputs must be a JSON object.");
        const stored = await createWorkflowV2(context.host, {
            workflowSessionId: context.workflowSessionId, parentSessionId: context.callerSessionId, owner: context.owner,
            yaml: args.yaml, actor: { kind: "agent", sessionId: context.callerSessionId }, operationId: context.operationId,
            publish, start: args.start === true ? { inputs } : null, notifyParent: args.notify_on_completion !== false,
            binding: context.binding,
        });
        return payload({
            ok: true, ...receiptJson(stored.receipt, stored.replayed),
            next: stored.receipt.run ? "The live run started; its result arrives as a system message when it ends."
                : stored.receipt.state === "published" ? "Published; start it with update_workflow operation start."
                    : stored.receipt.valid ? "Draft saved; nothing runs. Review it, then update_workflow publish or publish_and_start with this definitionHash."
                        : "Draft saved with diagnostics; nothing runs. Fix it with update_workflow replace_definition.",
        });
    } catch (error) {
        return errorPayload(error);
    }
}
