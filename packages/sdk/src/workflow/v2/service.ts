import { randomUUID } from "node:crypto";
import type { SessionCatalog } from "../../cms.js";
import type { SessionOwnerInfo } from "../../types.js";
import type { WorkflowToolBinding } from "../tool-policy.js";
import { compileWorkflowV2, declaredSemver, WORKFLOW_V2_API_VERSION, type WorkflowCompileResult } from "./compiler.js";
import { boundedCanonicalJson, canonicalJson, isJsonObject, isStorableText, jsonSha256, type JsonValue } from "./json.js";
import { schemaSetFor } from "./schema.js";
import {
    WORKFLOW_V2_CONTROLLER_NAME,
    WORKFLOW_V2_CONTROLLER_VERSION,
    workflowLiveControllerInstanceId,
    type ControllerInput,
} from "./runtime.js";
import {
    ACTIVE_RUN_STATUSES,
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
    catalog: Pick<SessionCatalog, "getSession" | "getSessionCreationConfig" | "createWorkflowSessionV2">;
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

/** Operation ids are stored as TEXT and compared exactly; refuse text PostgreSQL would reject or rewrite. */
function requireOperationId(operationId: string): void {
    if (typeof operationId !== "string" || !operationId.trim() || operationId.length > 256 || !isStorableText(operationId)) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID",
            "operation_id must be 1-256 characters of valid Unicode text without NUL characters.");
    }
}

/** A definition is stored as TEXT; NUL or lone surrogates cannot be stored exactly, even as a draft. */
function requireStorableYaml(yaml: string): void {
    if (typeof yaml !== "string" || !isStorableText(yaml)) {
        throw new WorkflowStoreError("WORKFLOW_YAML_INVALID", "Workflow YAML must be valid Unicode text without NUL characters.");
    }
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

/**
 * Start (or re-dispatch, idempotently) the controller of an admitted run named
 * by a receipt. Safety does not rest on this check: a controller started for
 * a run that was cancelled or deleted meanwhile finds it inactive at begin,
 * under the session and run locks, and admits nothing.
 */
export async function dispatchWorkflowV2Run(host: WorkflowV2Host, receipt: WorkflowDefinitionReceipt): Promise<void> {
    const admitted = receipt.run;
    if (!admitted) return;
    const run = await host.store.readRun(admitted.runId);
    if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) return;
    const input: ControllerInput = { v: 2, workflowSessionId: receipt.workflowSessionId, runId: admitted.runId };
    await host.duroxideClient.startOrchestrationVersioned(admitted.controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME, input, WORKFLOW_V2_CONTROLLER_VERSION);
}

/** Create a workflow child: a draft by default; optionally published and started atomically. */
export async function createWorkflowV2(host: WorkflowV2Host, request: CreateWorkflowV2Request): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
    requireOperationId(request.operationId);
    requireStorableYaml(request.yaml);
    const compiled = compileWorkflowV2(request.yaml);
    const publish = request.publish === true || Boolean(request.start);
    const startInputs = request.start ? request.start.inputs : null;
    if (request.start) validateRunInputs(compiled, request.start.inputs);
    const requestSha256 = jsonSha256({
        kind: "create", yamlSha256: compiled.yamlSha256, publish, start: request.start ? { inputs: startInputs } : null,
        parentSessionId: request.parentSessionId, notifyParent: request.notifyParent !== false,
        owner: request.owner ? { provider: request.owner.provider, subject: request.owner.subject } : null,
        // The tool grant is part of the request: a retry with another grant is
        // another request, so it can never continue (or be told it created) this one.
        binding: request.binding ? jsonSha256(JSON.parse(JSON.stringify(request.binding))) : null,
    });
    // A deleted workflow keeps its definition tombstone; its id is never reused.
    const tombstone = await host.store.readDefinition(request.workflowSessionId);
    if (tombstone?.state === "deleted") throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow id was deleted and cannot be reused.");
    // The session row is claimed exclusively: an existing row of any kind,
    // or one a concurrent creator inserts first, is never modified here.
    if (!host.catalog.createWorkflowSessionV2) throw new WorkflowStoreError("WORKFLOW_V2_UNAVAILABLE", "This session catalog cannot create v2 workflows.");
    const claim = await host.catalog.createWorkflowSessionV2(request.workflowSessionId, {
        parentSessionId: request.parentSessionId,
        owner: request.owner ?? null,
        creationConfig: {
            workflowV2: { apiVersion: WORKFLOW_V2_API_VERSION, requestSha256, operationId: request.operationId },
            ...(request.binding ? { workflowToolBinding: request.binding } : {}),
        },
    });
    if (!claim.created) {
        // Only a retry of this exact creation (interrupted before its
        // definition or receipt) may continue on an existing row.
        const [row, creation] = await Promise.all([
            host.catalog.getSession(request.workflowSessionId),
            host.catalog.getSessionCreationConfig?.(request.workflowSessionId) ?? null,
        ]);
        const marker = creation?.workflowV2;
        if (!row || row.deletedAt || row.sessionKind !== "workflow" || (row.parentSessionId ?? null) !== request.parentSessionId
            || !isJsonObject(marker)) {
            throw new WorkflowStoreError("SESSION_EXISTS",
                `Session ${request.workflowSessionId} already exists and is not this parent's v2 workflow; nothing was changed.`);
        }
        if (marker.requestSha256 !== requestSha256 || marker.operationId !== request.operationId) {
            throw new WorkflowStoreError("WORKFLOW_EXISTS",
                `Workflow ${request.workflowSessionId} was created by a different request; use another key for another workflow.`);
        }
    }
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
        title: `Workflow: ${compiled.name ?? "draft"}`,
    });
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
    requireOperationId(context.operationId);
    let stored: StoredOperation<WorkflowDefinitionReceipt>;
    if (command.operation === "replace_definition") {
        requireStorableYaml(command.yaml);
        const compiled = compileWorkflowV2(command.yaml);
        stored = await host.store.replaceDraft({
            workflowSessionId, expectedRevision: command.expectedRevision, yaml: command.yaml, compiled,
            declaredSemver: compiled.version ?? declaredSemver(command.yaml), actor: context.actor, operationId: context.operationId,
            requestSha256: jsonSha256({ kind: "replace_definition", yamlSha256: compiled.yamlSha256, expectedRevision: command.expectedRevision }),
            title: `Workflow: ${compiled.name ?? "draft"}`,
        });
        return stored;
    }
    if (command.operation === "publish" || command.operation === "publish_and_start") {
        // The operation decides whether a run starts; any JSON input, null included, is a value.
        const startInputs: { value: JsonValue } | null = command.operation === "publish_and_start" ? { value: command.inputs } : null;
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
                ...(startInputs ? { inputs: canonicalJson(startInputs.value) } : {}) }),
            start: startInputs ? liveAdmission(workflowSessionId, startInputs.value) : null,
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
