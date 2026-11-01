import { randomUUID } from "node:crypto";
import type { SessionCatalog } from "../../cms.js";
import type { SessionOwnerInfo } from "../../types.js";
import type { WorkflowToolBinding } from "../tool-policy.js";
import { compileWorkflowV2, declaredSemver, WORKFLOW_V2_API_VERSION, type WorkflowCompileResult } from "./compiler.js";
import { boundedCanonicalJson, canonicalJson, jsonSha256, type JsonValue } from "./json.js";
import { schemaSetFor } from "./schema.js";
import {
    WORKFLOW_V2_CONTROLLER_NAME,
    WORKFLOW_V2_CONTROLLER_VERSION,
    workflowLiveControllerInstanceId,
    type ControllerInput,
} from "./runtime.js";
import {
    WorkflowStoreError,
    type RunAdmission,
    type StoredOperation,
    type WorkflowActor,
    type WorkflowDefinitionReceipt,
    type WorkflowStore,
} from "./store.js";

/**
 * Workflow v2 commands shared by the agent tools, the SDK and (later) the
 * Web API. The caller supplies a host-derived actor; nothing here trusts an
 * actor claim from request JSON. Authorization of that actor against the
 * workflow container is the caller's adapter's job and is checked before
 * these functions run.
 */

export interface WorkflowV2Host {
    catalog: Pick<SessionCatalog, "createSession" | "getSession" | "updateSession">;
    store: WorkflowStore;
    duroxideClient: { startOrchestrationVersioned(instanceId: string, name: string, input: unknown, version: string): Promise<void> };
}

export interface CreateWorkflowV2Request {
    workflowSessionId: string;
    parentSessionId: string | null;
    owner?: SessionOwnerInfo | null;
    yaml: string;
    actor: WorkflowActor;
    operationId: string;
    /** Publish revision 1 now (requires a valid definition). */
    publish?: boolean;
    /** Start the live run now (requires publish). */
    start?: { inputs: JsonValue } | null;
    notifyParent?: boolean;
    /** Host-captured tool grant for scripts; never from YAML or a public payload. */
    binding?: WorkflowToolBinding | null;
}

function validateRunInputs(compiled: WorkflowCompileResult, inputs: JsonValue): void {
    if (!compiled.ir || !compiled.irSha256 || !compiled.ir.inputsSchema) return;
    const problems = schemaSetFor(compiled.irSha256, compiled.ir.schemaDefs).validate(compiled.ir.inputsSchema, inputs);
    if (problems.length) {
        throw new WorkflowStoreError("WORKFLOW_INPUT_INVALID", "Workflow inputs do not match inputs.schema.",
            problems.map(problem => ({ path: problem.path, message: problem.message })));
    }
}

function liveAdmission(workflowSessionId: string, inputs: JsonValue): RunAdmission {
    return {
        runId: randomUUID(), mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
        inputsText: boundedCanonicalJson(inputs, "Workflow inputs"), testAgentMode: null,
    };
}

/** Start (or re-dispatch, idempotently) the controller of an admitted run named by a receipt. */
export async function dispatchWorkflowV2Run(host: WorkflowV2Host, receipt: WorkflowDefinitionReceipt): Promise<void> {
    const run = receipt.run;
    if (!run) return;
    const input: ControllerInput = { v: 2, workflowSessionId: receipt.workflowSessionId, runId: run.runId };
    await host.duroxideClient.startOrchestrationVersioned(run.controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME, input, WORKFLOW_V2_CONTROLLER_VERSION);
    if (run.mode === "live") await host.catalog.updateSession(receipt.workflowSessionId, { orchestrationId: run.controllerInstanceId });
}

/** Create a workflow child: a draft by default; optionally published and started atomically. */
export async function createWorkflowV2(host: WorkflowV2Host, request: CreateWorkflowV2Request): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
    const compiled = compileWorkflowV2(request.yaml);
    const publish = request.publish === true || Boolean(request.start);
    const startInputs = request.start ? request.start.inputs : null;
    if (request.start) validateRunInputs(compiled, request.start.inputs);
    const requestSha256 = jsonSha256({
        kind: "create", yamlSha256: compiled.yamlSha256, publish, start: request.start ? { inputs: startInputs } : null,
        parentSessionId: request.parentSessionId, notifyParent: request.notifyParent !== false,
    });
    // A deleted workflow keeps its definition tombstone; its id is never reused
    // (the catalog would otherwise revive a soft-deleted session row).
    const tombstone = await host.store.readDefinition(request.workflowSessionId);
    if (tombstone?.state === "deleted") throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow id was deleted and cannot be reused.");
    const existing = await host.catalog.getSession(request.workflowSessionId);
    if (existing && existing.sessionKind !== "workflow") {
        throw new WorkflowStoreError("SESSION_EXISTS", `Session ${request.workflowSessionId} exists and is not a workflow.`);
    }
    if (existing?.deletedAt) throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow id was deleted and cannot be reused.");
    await host.catalog.createSession(request.workflowSessionId, {
        sessionKind: "workflow",
        ...(request.parentSessionId ? { parentSessionId: request.parentSessionId } : {}),
        ...(request.owner ? { owner: request.owner } : {}),
        creationConfig: {
            workflowV2: { apiVersion: WORKFLOW_V2_API_VERSION },
            ...(request.binding ? { workflowToolBinding: request.binding } : {}),
        },
    });
    const stored = await host.store.createDefinition({
        workflowSessionId: request.workflowSessionId,
        parentSessionId: request.parentSessionId,
        notifyParent: request.notifyParent !== false,
        yaml: request.yaml,
        compiled,
        actor: request.actor,
        operationId: request.operationId,
        requestSha256,
        publish,
        start: request.start ? liveAdmission(request.workflowSessionId, request.start.inputs) : null,
    });
    if (!stored.replayed) {
        await host.catalog.updateSession(request.workflowSessionId, {
            title: `Workflow: ${compiled.name ?? "draft"}`, titleLocked: true, state: stored.receipt.run ? "pending" : "idle",
        });
    }
    await dispatchWorkflowV2Run(host, stored.receipt);
    return stored;
}

export type WorkflowV2Command =
    | { operation: "replace_definition"; yaml: string; expectedRevision: number }
    | { operation: "publish"; expectedRevision: number; definitionHash: string }
    | { operation: "publish_and_start"; expectedRevision: number; definitionHash: string; inputs: JsonValue }
    | { operation: "start"; definitionHash: string; inputs: JsonValue };

/** Apply one typed definition-lifecycle command with idempotency by operation id. */
export async function updateWorkflowV2(
    host: WorkflowV2Host,
    workflowSessionId: string,
    command: WorkflowV2Command,
    context: { actor: WorkflowActor; operationId: string },
): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
    let stored: StoredOperation<WorkflowDefinitionReceipt>;
    if (command.operation === "replace_definition") {
        const compiled = compileWorkflowV2(command.yaml);
        stored = await host.store.replaceDraft({
            workflowSessionId, expectedRevision: command.expectedRevision, yaml: command.yaml, compiled,
            declaredSemver: compiled.version ?? declaredSemver(command.yaml), actor: context.actor, operationId: context.operationId,
            requestSha256: jsonSha256({ kind: "replace_definition", yamlSha256: compiled.yamlSha256, expectedRevision: command.expectedRevision }),
        });
        if (!stored.replayed) await host.catalog.updateSession(workflowSessionId, { title: `Workflow: ${compiled.name ?? "draft"}`, titleLocked: true });
        return stored;
    }
    if (command.operation === "publish" || command.operation === "publish_and_start") {
        const inputs = command.operation === "publish_and_start" ? command.inputs : null;
        if (command.operation === "publish_and_start") {
            const revision = await host.store.readRevision(workflowSessionId, command.expectedRevision);
            if (revision?.valid && revision.irSha256) {
                const ir = await host.store.readRevisionIr(workflowSessionId, command.expectedRevision, revision.irSha256);
                const problems = ir.inputsSchema ? schemaSetFor(revision.irSha256, ir.schemaDefs).validate(ir.inputsSchema, command.inputs) : [];
                if (problems.length) {
                    throw new WorkflowStoreError("WORKFLOW_INPUT_INVALID", "Workflow inputs do not match inputs.schema.",
                        problems.map(problem => ({ path: problem.path, message: problem.message })));
                }
            }
        }
        stored = await host.store.publish({
            workflowSessionId, expectedRevision: command.expectedRevision, definitionHash: command.definitionHash,
            operationId: context.operationId,
            requestSha256: jsonSha256({ kind: command.operation, expectedRevision: command.expectedRevision, definitionHash: command.definitionHash,
                inputs: inputs === null ? null : canonicalJson(inputs) }),
            start: inputs === null ? null : liveAdmission(workflowSessionId, inputs),
        });
    } else {
        const definition = await host.store.readDefinition(workflowSessionId);
        if (definition?.state === "published" && definition.publishedRevision !== null && definition.publishedIrSha256) {
            const ir = await host.store.readRevisionIr(workflowSessionId, definition.publishedRevision, definition.publishedIrSha256);
            const problems = ir.inputsSchema ? schemaSetFor(definition.publishedIrSha256, ir.schemaDefs).validate(ir.inputsSchema, command.inputs) : [];
            if (problems.length) {
                throw new WorkflowStoreError("WORKFLOW_INPUT_INVALID", "Workflow inputs do not match inputs.schema.",
                    problems.map(problem => ({ path: problem.path, message: problem.message })));
            }
        }
        stored = await host.store.startLive({
            workflowSessionId, definitionHash: command.definitionHash, operationId: context.operationId,
            requestSha256: jsonSha256({ kind: "start", definitionHash: command.definitionHash, inputs: canonicalJson(command.inputs) }),
            start: liveAdmission(workflowSessionId, command.inputs),
        });
    }
    if (stored.receipt.run) await dispatchWorkflowV2Run(host, stored.receipt);
    return stored;
}
