import { randomUUID } from "node:crypto";
import type { SessionCatalog } from "../../cms.js";
import type { SessionOwnerInfo } from "../../types.js";
import type { WorkflowToolBinding } from "../tool-policy.js";
import { compileWorkflowV2, declaredSemver, WORKFLOW_V2_API_VERSION, type WorkflowCompileResult } from "./compiler.js";
import { boundedCanonicalJson, canonicalJson, isJsonObject, isStorableText, jsonbSafeText, jsonSha256, WorkflowJsonError, type JsonValue } from "./json.js";
import { TYPED_INPUT_REFUSALS, typedInputAuthority } from "./authority.js";
import { schemaSetFor } from "./schema.js";
import {
    correlationTextOf,
    WORKFLOW_V2_CONTROLLER_NAME,
    WORKFLOW_V2_CONTROLLER_VERSION,
    WORKFLOW_V2_MAX_CORRELATION_BYTES,
    WORKFLOW_V2_NOTIFY_NAME,
    WORKFLOW_V2_NOTIFY_VERSION,
    workflowLiveControllerInstanceId,
    workflowNotifyInstanceId,
    type ControllerInput,
} from "./runtime.js";
import { WORKFLOW_COMMAND_QUEUE } from "../orchestration.js";
import {
    ACTIVE_RUN_STATUSES,
    ADMITTING_RUN_STATUSES,
    checkedKvText,
    isKvKey,
    parseSessionCommandReceipt,
    runNotBegun,
    WorkflowStoreError,
    type RunAdmission,
    type StoredOperation,
    type WorkflowActor,
    type WorkflowDefinitionReceipt,
    type WorkflowInboxLimits,
    type WorkflowInputReceipt,
    type WorkflowRunCommandReceipt,
    type WorkflowRunRow,
    type WorkflowRunStatus,
    type WorkflowSessionCommandReceipt,
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
    duroxideClient: {
        startOrchestrationVersioned(instanceId: string, name: string, input: unknown, version: string): Promise<void>;
        getStatus(instanceId: string): Promise<{ status: string; error?: string }>;
        enqueueEvent(instanceId: string, queueName: string, data: string): Promise<void>;
    };
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
    /** inputs: static run inputs; vars: the initial open KV map (revision 1). */
    start?: { inputs: JsonValue; vars?: { [key: string]: JsonValue } } | null;
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

function liveAdmission(workflowSessionId: string, inputs: JsonValue, vars: { [key: string]: JsonValue } | null): RunAdmission {
    return {
        runId: randomUUID(), mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
        inputsText: boundedCanonicalJson(inputs, "Workflow inputs"), kvText: checkedKvText(vars ?? {}), testAgentMode: null,
    };
}

/**
 * Initial KV as part of a request digest: absent when empty, so a request
 * without vars keeps the digest earlier builds recorded for it.
 */
function varsDigestPart(vars: { [key: string]: JsonValue } | null | undefined): { vars?: string } {
    return vars && Object.keys(vars).length > 0 ? { vars: canonicalJson(vars) } : {};
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

/** duroxide statuses after which an orchestration does no more work. */
const ENDED_ORCHESTRATION_STATUSES: readonly string[] = ["Completed", "Failed", "Terminated"];

/** What a run's controller says about the run, without changing anything. */
export interface WorkflowV2ControllerView {
    status: string;
    error: string | null;
    /**
     * The run is active but its controller can no longer end it (it ended,
     * or its instance is gone), or the run was admitted and never started.
     * update_workflow operation recover acts on it.
     */
    needsRecovery: boolean;
}

export async function inspectWorkflowV2Controller(host: Pick<WorkflowV2Host, "duroxideClient">, run: WorkflowRunRow): Promise<WorkflowV2ControllerView> {
    const controller = await host.duroxideClient.getStatus(run.controllerInstanceId);
    const ended = controller.status === "NotFound" || ENDED_ORCHESTRATION_STATUSES.includes(controller.status);
    return {
        status: controller.status,
        error: controller.error === undefined ? null : jsonbSafeText(controller.error, 2_000),
        needsRecovery: ACTIVE_RUN_STATUSES.includes(run.status) && ended,
    };
}

/** The receipt of update_workflow operation recover. */
export interface WorkflowV2RecoverReceipt {
    runId: string;
    action: "none" | "dispatched" | "ended";
    status: WorkflowRunStatus;
    controller: WorkflowV2ControllerView;
}

function recoverReceiptJson(receipt: WorkflowV2RecoverReceipt): JsonValue {
    return {
        runId: receipt.runId, action: receipt.action, status: receipt.status,
        controller: { status: receipt.controller.status, error: receipt.controller.error, needsRecovery: receipt.controller.needsRecovery },
    };
}

const RUN_STATUSES: readonly WorkflowRunStatus[] = [...ACTIVE_RUN_STATUSES, "completed", "failed", "cancelled"];

function parseRecoverReceipt(value: JsonValue): WorkflowV2RecoverReceipt {
    const corrupt = () => new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "Stored recover receipt has an invalid shape.");
    if (!isJsonObject(value)) throw corrupt();
    const { runId, action, status, controller } = value;
    const parsedAction = action === "none" || action === "dispatched" || action === "ended" ? action : null;
    const parsedStatus = RUN_STATUSES.find(item => item === status);
    if (typeof runId !== "string" || parsedAction === null || parsedStatus === undefined || !isJsonObject(controller)) throw corrupt();
    const { status: controllerStatus, error, needsRecovery } = controller;
    if (typeof controllerStatus !== "string" || typeof needsRecovery !== "boolean") throw corrupt();
    if (error !== null && typeof error !== "string") throw corrupt();
    return { runId, action: parsedAction, status: parsedStatus, controller: { status: controllerStatus, error, needsRecovery } };
}

/**
 * Deliver the terminal notification of a run that a recover ended: its
 * controller had already ended, so nothing else reports it. The notifier
 * orchestration runs the controller's notification activity (at least once,
 * stable client message id); starting it again for the same run is ignored
 * by duroxide, so a repeated recover only makes sure it was started.
 */
async function notifyRecoveredRun(host: Pick<WorkflowV2Host, "store" | "duroxideClient">, run: WorkflowRunRow): Promise<void> {
    if (run.mode !== "live" || run.status !== "failed" || !isJsonObject(run.terminalError) || run.terminalError.code !== "controller_ended") return;
    const definition = await host.store.readDefinition(run.workflowSessionId);
    if (!definition?.parentSessionId || !definition.notifyParent) return;
    await host.duroxideClient.startOrchestrationVersioned(workflowNotifyInstanceId(run.runId), WORKFLOW_V2_NOTIFY_NAME,
        { runId: run.runId }, WORKFLOW_V2_NOTIFY_VERSION);
}

/**
 * Start the controller of a run whose recover receipt says it was
 * dispatched, while its controller has not begun it. The
 * receipt was stored first, so a repeat of the request reaches this again
 * after an interruption; duroxide ignores a second start of an instance, and
 * the run's stored controller instance id never changes.
 */
async function dispatchRecoveredRun(host: Pick<WorkflowV2Host, "duroxideClient">, run: WorkflowRunRow): Promise<void> {
    if (!runNotBegun(run)) return;
    const input: ControllerInput = { v: 2, workflowSessionId: run.workflowSessionId, runId: run.runId };
    await host.duroxideClient.startOrchestrationVersioned(run.controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME, input, WORKFLOW_V2_CONTROLLER_VERSION);
}

/**
 * Report a run that this cancel request ended before it began (no controller
 * ran it), by the controller's rule: the parent is told unless it asked for
 * the cancel itself, through the notifier orchestration (stable client
 * message id, at least once). The requester is the one the run's end
 * records (or attributes, for an earlier build's cancel that begin ended);
 * a repeat sent by the parent itself is not reported to it either. A repeat
 * only makes sure the notifier was started; a run ended by anything else
 * is left alone. The begin activity starts the same notifier when the
 * run's controller starts (workflow-v2-controller begin).
 */
async function notifyCancelledBeforeBegin(host: Pick<WorkflowV2Host, "store" | "duroxideClient">, run: WorkflowRunRow, operationId: string,
    callerSessionId: string | null): Promise<void> {
    const error = run.terminalError;
    const details = isJsonObject(error) && isJsonObject(error.details) ? error.details : null;
    if (run.mode !== "live" || run.status !== "cancelled" || !details || details.beforeBegin !== true || details.operationId !== operationId) return;
    const definition = await host.store.readDefinition(run.workflowSessionId);
    if (!definition?.parentSessionId || !definition.notifyParent) return;
    if (details.requestedBy === definition.parentSessionId || callerSessionId === definition.parentSessionId) return;
    await host.duroxideClient.startOrchestrationVersioned(workflowNotifyInstanceId(run.runId), WORKFLOW_V2_NOTIFY_NAME,
        { runId: run.runId }, WORKFLOW_V2_NOTIFY_VERSION);
}

/**
 * Recover an active run whose controller can no longer end it, on an
 * explicit request (update_workflow operation recover):
 * - not begun (admitted, or paused before it began) with no controller
 *   instance (the dispatch after admission was lost): dispatch it again.
 *   The receipt and the workflow.recovered event are stored before the
 *   start, so the receipt of a request that started the controller always
 *   says dispatched; a repeat starts it again;
 * - the controller ended, or its instance is gone, while the run is still
 *   active (its finalization attempts ran out, it was terminated, or its
 *   history is from an unsupported pre-release controller): end the run as
 *   failed with the controller's state, and notify the parent of that end
 *   when the workflow asked for it. Pending node executions lose to that
 *   end, so a running script's liveness check stops it.
 * A run that is not active, or whose controller is still running, is left as
 * it is. The operation id makes the request idempotent: the first receipt
 * stored for it is returned to every repeat, and a repeat completes the
 * dispatch or the notification that receipt implies. The dispatch and the
 * notification are at least once, not exactly once.
 */
export async function recoverWorkflowV2Run(host: Pick<WorkflowV2Host, "store" | "duroxideClient">, runId: string,
    request: { requestedBy: string | null; operationId: string }): Promise<StoredOperation<WorkflowV2RecoverReceipt>> {
    requireOperationId(request.operationId);
    const run = await host.store.readRun(runId);
    if (!run) throw new WorkflowStoreError("RUN_NOT_FOUND", `Workflow run ${runId} does not exist.`);
    const workflowSessionId = run.workflowSessionId;
    const requestSha256 = jsonSha256({ kind: "recover", runId });
    const replay = async (stored: JsonValue): Promise<StoredOperation<WorkflowV2RecoverReceipt>> => {
        const receipt = parseRecoverReceipt(stored);
        const current = await host.store.readRun(runId);
        if (current) {
            if (receipt.action === "dispatched") await dispatchRecoveredRun(host, current);
            await notifyRecoveredRun(host, current);
        }
        return { receipt, replayed: true };
    };
    /** The id was recorded meanwhile: a concurrent repeat (its receipt is returned) or another request (OPERATION_CONFLICT). */
    const recordedMeanwhile = async (error: unknown): Promise<StoredOperation<WorkflowV2RecoverReceipt>> => {
        if (!(error instanceof WorkflowStoreError) || error.code !== "OPERATION_CONFLICT") throw error;
        const stored = await host.store.readOperationReceipt(workflowSessionId, request.operationId, "recover", requestSha256);
        if (stored === null) throw error;
        return replay(stored);
    };
    const prior = await host.store.readOperationReceipt(workflowSessionId, request.operationId, "recover", requestSha256);
    if (prior !== null) return replay(prior);

    const controller = await inspectWorkflowV2Controller(host, run);
    let receipt: WorkflowV2RecoverReceipt = { runId, action: "none", status: run.status, controller };
    if (controller.needsRecovery && controller.status === "NotFound" && runNotBegun(run)) {
        const dispatching: WorkflowV2RecoverReceipt = { runId, action: "dispatched", status: run.status, controller };
        let intent: { recorded: boolean; run: WorkflowRunRow };
        try {
            intent = await host.store.recordRecoverDispatch({
                runId,
                receipt: { operationId: request.operationId, kind: "recover", requestSha256, value: recoverReceiptJson(dispatching) },
                projection: {
                    sessionId: workflowSessionId,
                    events: [{ eventType: "workflow.recovered", data: {
                        runId, action: "dispatched", requestedBy: request.requestedBy, operationId: request.operationId,
                    } }],
                },
            });
        } catch (error) {
            return recordedMeanwhile(error);
        }
        if (intent.recorded) {
            await dispatchRecoveredRun(host, intent.run);
            return { receipt: dispatching, replayed: false };
        }
        // Something began or ended the run meanwhile; this request changes nothing.
        receipt = { runId, action: "none", status: intent.run.status, controller };
    } else if (controller.needsRecovery) {
        const message = controller.status === "NotFound"
            ? "The workflow controller no longer exists; the run cannot continue."
            : `The workflow controller ended (${controller.status}) without ending the run.`;
        const ending: WorkflowV2RecoverReceipt = { runId, action: "ended", status: "failed", controller };
        let ended: { ended: boolean; run: WorkflowRunRow };
        try {
            ended = await host.store.finishRun({
                runId, status: "failed", terminalNodeId: null, terminalOutcome: null, outputText: null,
                errorText: canonicalJson({ code: "controller_ended", message,
                    details: { controllerStatus: controller.status, controllerError: controller.error, requestedBy: request.requestedBy } }),
                endPending: { winner: "controller", message: "The workflow run ended before this state finished." },
                receipt: { operationId: request.operationId, kind: "recover", requestSha256, value: recoverReceiptJson(ending) },
                projection: {
                    sessionId: workflowSessionId,
                    events: [{ eventType: "workflow.failed", data: {
                        runId, code: "controller_ended", controllerStatus: controller.status, error: message, requestedBy: request.requestedBy,
                    } }],
                    update: { state: "failed", lastError: message, touch: true },
                },
            });
        } catch (error) {
            return recordedMeanwhile(error);
        }
        if (ended.ended) {
            await notifyRecoveredRun(host, ended.run);
            return { receipt: ending, replayed: false };
        }
        receipt = { runId, action: "none", status: ended.run.status, controller };
    }
    const stored = await host.store.recordOperationReceipt(workflowSessionId, request.operationId, "recover", requestSha256, recoverReceiptJson(receipt));
    if (stored.replayed) return replay(stored.receipt);
    // A run an earlier recover ended: make sure its notification was started.
    await notifyRecoveredRun(host, run);
    return { receipt, replayed: false };
}

/**
 * Digests of one creation request, by the version of the fingerprint that
 * recorded it. A claim marker or receipt is never rewritten; a retry is
 * compared with the digest its record used, and the stored owner, parent
 * and first grant must match the request as well.
 * - 1 (c218d1bc..87549e10): content, parent and notification; the claim
 *   marker held no digest.
 * - 2 (159bdce5, ba30c8c2): version 1 plus the owner; the marker held the
 *   digest without stating its version.
 * - 3: version 2 plus the tool grant. 3a7ca2dd..547d1bf5 wrote it without
 *   stating the version; from 3833ba61 on the marker states `fingerprint: 3`.
 */
export const WORKFLOW_V2_CREATE_FINGERPRINT = 3;

function createFingerprints(request: CreateWorkflowV2Request, yamlSha256: string, publish: boolean, startInputs: JsonValue): { v1: string; v2: string; v3: string } {
    const content = {
        kind: "create", yamlSha256, publish, start: request.start ? { inputs: startInputs, ...varsDigestPart(request.start.vars) } : null,
        parentSessionId: request.parentSessionId, notifyParent: request.notifyParent !== false,
    };
    const owner = request.owner ? { provider: request.owner.provider, subject: request.owner.subject } : null;
    // The tool grant is part of the request: a retry with another grant is
    // another request, so it can never continue (or be told it created) this one.
    const binding = request.binding ? jsonSha256(JSON.parse(JSON.stringify(request.binding))) : null;
    return { v1: jsonSha256(content), v2: jsonSha256({ ...content, owner }), v3: jsonSha256({ ...content, owner, binding }) };
}

/** The same tool grant: both absent, or the same JSON (the stored copy went through JSONB). */
function sameGrant(stored: unknown, requested: WorkflowToolBinding | null | undefined): boolean {
    const storedGrant = stored === undefined || stored === null ? null : canonicalJson(JSON.parse(JSON.stringify(stored)));
    const requestedGrant = requested ? canonicalJson(JSON.parse(JSON.stringify(requested))) : null;
    return storedGrant === requestedGrant;
}

function sameOwner(stored: SessionOwnerInfo | null | undefined, requested: SessionOwnerInfo | null | undefined): boolean {
    if (!stored || !requested) return !stored && !requested;
    return stored.provider === requested.provider && stored.subject === requested.subject;
}

/** Create a workflow child: a draft by default; optionally published and started atomically. */
export async function createWorkflowV2(host: WorkflowV2Host, request: CreateWorkflowV2Request): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
    requireOperationId(request.operationId);
    requireStorableYaml(request.yaml);
    const compiled = compileWorkflowV2(request.yaml);
    const publish = request.publish === true || Boolean(request.start);
    const startInputs = request.start ? request.start.inputs : null;
    if (request.start) validateRunInputs(compiled, request.start.inputs);
    // Built before anything is written: inputs or vars over their limits refuse the request without a claim.
    const admission = request.start ? liveAdmission(request.workflowSessionId, request.start.inputs, request.start.vars ?? null) : null;
    const fingerprints = createFingerprints(request, compiled.yamlSha256, publish, startInputs);
    const requestSha256 = fingerprints.v3;
    // Digests a stored receipt of this request may carry (receipts are never rewritten).
    let acceptedRequestSha256: string[] = [requestSha256];
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
            workflowV2: { apiVersion: WORKFLOW_V2_API_VERSION, fingerprint: WORKFLOW_V2_CREATE_FINGERPRINT, requestSha256, operationId: request.operationId },
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
        // Compare with the fingerprint the claim recorded; what it did not
        // cover (the owner, the first grant) must match the stored row.
        const grantMatches = sameGrant(creation?.workflowToolBinding, request.binding);
        const ownerMatches = sameOwner(row.owner, request.owner);
        let sameRequest: boolean;
        if (marker.fingerprint === WORKFLOW_V2_CREATE_FINGERPRINT) {
            sameRequest = marker.requestSha256 === fingerprints.v3 && marker.operationId === request.operationId && grantMatches && ownerMatches;
        } else if (marker.fingerprint === undefined && typeof marker.requestSha256 === "string") {
            // An unstated version is version 2 or version 3: accept only the
            // digest this request has under one of them.
            const asVersion = marker.requestSha256 === fingerprints.v3 ? 3 : marker.requestSha256 === fingerprints.v2 ? 2 : null;
            sameRequest = asVersion !== null && marker.operationId === request.operationId && grantMatches && ownerMatches;
            acceptedRequestSha256 = asVersion === 2 ? [fingerprints.v3, fingerprints.v2] : [fingerprints.v3];
        } else if (marker.fingerprint === undefined && marker.requestSha256 === undefined && marker.operationId === undefined) {
            sameRequest = grantMatches && ownerMatches;
            acceptedRequestSha256 = [fingerprints.v3, fingerprints.v1];
        } else {
            throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Workflow ${request.workflowSessionId} has a creation record this build cannot read.`);
        }
        if (!sameRequest) {
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
        acceptedRequestSha256,
        publish,
        start: admission,
        title: `Workflow: ${compiled.name ?? "draft"}`,
    });
    await dispatchWorkflowV2Run(host, stored.receipt);
    return stored;
}

export type WorkflowV2Command =
    | { operation: "replace_definition"; yaml: string; expectedRevision: number }
    | { operation: "publish"; expectedRevision: number; definitionHash: string }
    | { operation: "publish_and_start"; expectedRevision: number; definitionHash: string; inputs: JsonValue; vars?: { [key: string]: JsonValue } }
    | { operation: "start"; definitionHash: string; inputs: JsonValue; vars?: { [key: string]: JsonValue } };

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
                ...(startInputs ? { inputs: canonicalJson(startInputs.value) } : {}),
                ...(command.operation === "publish_and_start" ? varsDigestPart(command.vars) : {}) }),
            start: startInputs ? liveAdmission(workflowSessionId, startInputs.value, command.operation === "publish_and_start" ? command.vars ?? null : null) : null,
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
            requestSha256: jsonSha256({ kind: "start", definitionHash: command.definitionHash, inputs: canonicalJson(command.inputs), ...varsDigestPart(command.vars) }),
            start: liveAdmission(workflowSessionId, command.inputs, command.vars ?? null),
        });
    }
    if (stored.receipt.run) await dispatchWorkflowV2Run(host, stored.receipt);
    return stored;
}

export type WorkflowV2RunCommand =
    | { operation: "set_vars"; runId: string | null; set: { [key: string]: JsonValue }; delete: string[]; expectedKvRevision: number }
    | { operation: "pause" | "resume" | "cancel"; runId: string | null; reason: string | null };

/** The run a run command targets: the named run of this workflow, or its live run. */
async function commandRun(host: Pick<WorkflowV2Host, "store">, workflowSessionId: string, runId: string | null): Promise<WorkflowRunRow> {
    const runs = await host.store.listRuns(workflowSessionId);
    const run = runId ? runs.find(item => item.runId === runId) : runs.find(item => item.mode === "live");
    if (!run) throw new WorkflowStoreError("RUN_NOT_FOUND", runId ? `Run ${runId} is not a run of this workflow.` : "This workflow has no live run.");
    return run;
}

/**
 * Apply one run command with idempotency by operation id:
 * - set_vars: one atomic set/delete batch on the run's open KV at the
 *   expected revision (null is a value; deletion is explicit);
 * - pause / resume: stop or restart admitting node executions (admitted work
 *   finishes; a cancel, a deletion and KV updates still apply while paused);
 * - cancel: send the run's controller its cancel command. The receipt says
 *   the command was accepted, not that the run has ended: the first
 *   run-ending transaction decides, and read_workflow shows the result.
 */
export async function controlWorkflowV2Run(
    host: Pick<WorkflowV2Host, "store" | "duroxideClient">,
    workflowSessionId: string,
    command: WorkflowV2RunCommand,
    context: { actor: WorkflowActor; operationId: string },
): Promise<StoredOperation<WorkflowRunCommandReceipt>> {
    requireOperationId(context.operationId);
    const run = await commandRun(host, workflowSessionId, command.runId);
    if (command.operation === "set_vars") {
        for (const key of [...Object.keys(command.set), ...command.delete]) {
            if (!isKvKey(key)) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "KV keys are 1-128 characters of valid text.");
        }
        if (new Set(command.delete).size !== command.delete.length || command.delete.some(key => Object.hasOwn(command.set, key))) {
            throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "delete must list distinct keys that set does not also name.");
        }
        return host.store.setRunVars({
            workflowSessionId, runId: run.runId, set: command.set, delete: command.delete, expectedRevision: command.expectedKvRevision,
            operationId: context.operationId, actor: context.actor,
            requestSha256: jsonSha256({ kind: "set_vars", runId: run.runId, set: canonicalJson(command.set), delete: [...command.delete].sort(),
                expectedRevision: command.expectedKvRevision }),
        });
    }
    const requestSha256 = jsonSha256({ kind: command.operation, runId: run.runId, reason: command.reason });
    if (command.operation === "cancel") {
        const reason = command.reason ?? "Cancelled by its parent";
        const requestedBy = context.actor.kind === "agent" ? context.actor.sessionId : null;
        const stored = await host.store.recordRunCancelRequest({ workflowSessionId, runId: run.runId, operationId: context.operationId, requestSha256,
            reason, requestedBy });
        if (ACTIVE_RUN_STATUSES.includes(stored.run.status)) {
            await host.duroxideClient.enqueueEvent(stored.run.controllerInstanceId, WORKFLOW_COMMAND_QUEUE, JSON.stringify({
                type: "cmd", cmd: "cancel", id: `cancel-${context.operationId}`, args: { reason }, requestedBy,
            }));
        } else {
            // The run has ended. When this request ended it before it began, its parent is told by the
            // controller's rule; for any other end this does nothing.
            await notifyCancelledBeforeBegin(host, stored.run, context.operationId, requestedBy);
        }
        return { receipt: stored.receipt, replayed: stored.replayed };
    }
    const stored = await host.store.setRunPaused({
        workflowSessionId, runId: run.runId, pause: command.operation === "pause", operationId: context.operationId,
        requestSha256, actor: context.actor, reason: command.reason,
    });
    // Resume: tell the waiting controller at once (its backstop timer would
    // also find it). The resume is stored first, so a repeat of the request
    // sends this hint again; a wake changes nothing by itself.
    if (command.operation === "resume") {
        const current = await host.store.readRun(run.runId);
        if (current && ADMITTING_RUN_STATUSES.includes(current.status)) {
            await host.duroxideClient.enqueueEvent(run.controllerInstanceId, WORKFLOW_COMMAND_QUEUE,
                JSON.stringify({ type: "workflow-wake", runId: run.runId, reason: "resume" }));
        }
    }
    return stored;
}

/** The operation id prefix of a receipt that a parent session's lifecycle command stored. */
export const SESSION_COMMAND_OPERATION_PREFIX = "session-command:";

/** A lifecycle command a durable session sends to one of its children (cancel_agent, delete_agent, the shutdown cascade). */
function parseSessionLifecycleCommand(raw: unknown): { cmd: "cancel" | "done" | "delete"; id: string; reason: string | null; requestedBy: string | null } | null {
    if (!isJsonObject(raw) || raw.type !== "cmd") return null;
    const { cmd, id, args, requestedBy } = raw;
    if (cmd !== "cancel" && cmd !== "done" && cmd !== "delete") return null;
    if (typeof id !== "string" || !id.trim()) return null;
    const reason = isJsonObject(args) && typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : null;
    return { cmd, id, reason, requestedBy: typeof requestedBy === "string" && requestedBy ? requestedBy : null };
}

/**
 * A lifecycle command (cancel, done or delete) that a parent's durable
 * session sends to a child through the sendCommandToSession activity. The
 * command waits in the child orchestration's queue, but a v2 workflow child
 * may have no controller to read it: its live run has not begun (duroxide
 * drops a queue message for an instance that has not started), or it has no
 * run. So, for a v2 workflow child only:
 * - the caller is the session of the orchestration that runs the activity
 *   (its instance id `session-<id>`, set by the runtime), never the
 *   command's requestedBy alone; it must be the child's parent in both its
 *   session row and its definition, and a requestedBy must name it too;
 * - the store applies the command once per operation id
 *   (SESSION_COMMAND_OPERATION_PREFIX plus the command's id, which the
 *   orchestration derives deterministically), in one transaction
 *   (store.recordSessionCommand): delete always soft-deletes the child (the
 *   deletion trigger tombstones it and ends an active run in that
 *   transaction; a run that already ended keeps its result), then its facts
 *   are removed; cancel and done end a run that has not begun (done keeps
 *   its "Stopped" meaning), and for a run that has begun its controller
 *   applies the queued command;
 * - a retry of the activity replays the receipt: it queues a cancel or done
 *   again while that run is active, and applies an accepted delete whose
 *   child is still live, then the facts cleanup; another request with that
 *   id fails.
 * Every other target (an ordinary agent session, a legacy workflow) returns
 * "enqueue": the caller queues the command as before.
 */
export async function applySessionCommandToWorkflowV2(
    host: { store: WorkflowStore; deleteSessionFacts?: ((sessionId: string) => Promise<unknown>) | null },
    request: { callerInstanceId: string; targetSessionId: string; command: unknown },
): Promise<{ action: "enqueue" } | { action: "applied"; receipt: WorkflowSessionCommandReceipt | null }> {
    const command = parseSessionLifecycleCommand(request.command);
    if (!command) return { action: "enqueue" };
    const link = await host.store.readSessionLink(request.targetSessionId);
    if (!link || link.sessionKind !== "workflow") return { action: "enqueue" };
    const definition = await host.store.readDefinition(request.targetSessionId);
    if (!definition) return { action: "enqueue" };
    const caller = request.callerInstanceId.startsWith("session-") ? request.callerInstanceId.slice("session-".length) : null;
    if (!caller || link.parentSessionId !== caller || definition.parentSessionId !== caller || (command.requestedBy !== null && command.requestedBy !== caller)) {
        throw new WorkflowStoreError("FORBIDDEN", `Only the session that created workflow ${request.targetSessionId} may send it ${command.cmd}.`);
    }
    const workflowSessionId = request.targetSessionId;
    const operationId = `${SESSION_COMMAND_OPERATION_PREFIX}${command.id}`;
    const requestSha256 = jsonSha256({ kind: `session-${command.cmd}`, reason: command.reason });
    /**
     * The child is deleted: found deleted, or deleted after the link was read
     * (by this command's own earlier attempt, a retry that overlapped it, or
     * another path) and seen when the store took its session lock. Both cases
     * take this one path. A receipt under this operation id for another
     * request is refused (OPERATION_CONFLICT). The child's run has ended (the
     * deletion ended it), which is what a cancel or done asks for; a delete
     * also removes the child's facts, as every deletion path does (it is
     * idempotent), so an attempt lost after its commit and before this
     * cleanup is completed here.
     */
    const deletedChild = async (): Promise<{ action: "applied"; receipt: WorkflowSessionCommandReceipt | null }> => {
        const prior = await host.store.readOperationReceipt(workflowSessionId, operationId, `session-${command.cmd}`, requestSha256);
        if (command.cmd === "delete" && host.deleteSessionFacts) await host.deleteSessionFacts(workflowSessionId);
        return { action: "applied", receipt: prior === null ? null : parseSessionCommandReceipt(prior) };
    };
    if (link.deleted) return deletedChild();
    let stored: Awaited<ReturnType<WorkflowStore["recordSessionCommand"]>>;
    try {
        stored = await host.store.recordSessionCommand({
            workflowSessionId, operationId, requestSha256, command: command.cmd,
            reason: command.reason ?? (command.cmd === "done" ? "Stopped" : command.cmd === "delete" ? "Deleted" : "Cancelled"), requestedBy: caller,
        });
    } catch (error) {
        if (error instanceof WorkflowStoreError && error.code === "WORKFLOW_DELETED") return deletedChild();
        throw error;
    }
    const { receipt, run } = stored;
    if (command.cmd === "delete") {
        // The store deleted the child in this call (or a repeat found an accepted delete and applied it): remove its facts.
        if (host.deleteSessionFacts) await host.deleteSessionFacts(workflowSessionId);
        return { action: "applied", receipt };
    }
    // A cancel or done for the run's controller: queue it while that run is active (a repeat queues it again); a run that ended makes it moot.
    if (receipt.applied === "queued" && run !== null && ACTIVE_RUN_STATUSES.includes(run.status)) return { action: "enqueue" };
    return { action: "applied", receipt };
}

/**
 * Bounds on a run's inbox, proposed defaults (D07): unclaimed messages a run
 * holds, of them from one sender, and one sender's inputs to one workflow in
 * the rate window.
 */
export const WORKFLOW_V2_INBOX_LIMITS: WorkflowInboxLimits = { maxUnconsumed: 100, maxUnconsumedPerSender: 20, maxPerSenderPerWindow: 60, windowSeconds: 600 };
/** How long an unclaimed input stays eligible for a receive state: the default and the most (seconds). */
export const WORKFLOW_V2_INPUT_TTL_SECONDS = 86_400;

/**
 * send_workflow_input: give a run of a v2 workflow one typed input (R07,
 * R08). The sender is the session the adapter names as the caller, never a
 * field of the request, and it must be allowed (authority.ts): the
 * workflow's live parent, or a live session of the same user as the
 * workflow (both owned by that user; unknown or system ownership grants
 * nothing). That is checked here on the catalog's rows, and a fresh input
 * again under the session locks when it is accepted, so a sender deleted
 * in between is refused; a repeat is answered only when the check here
 * allows its sender. The run is
 * the one named, or the live run. Its pinned definition must have a receive
 * state for the contract (an undeclared contract is refused as
 * UNSUPPORTED_CONTRACT), and the payload must satisfy the contract's schema
 * (INPUT_INVALID, nothing stored). The store accepts it once per (workflow,
 * sender, operation id) and a waiting receive takes it in the same
 * transaction (store.acceptInput); an input no receive waits for is kept,
 * in the run's order, until one takes it or it expires. The receipt is the
 * acceptance's, stored with the input: a repeat returns it unchanged. When a
 * receive took the input as it was accepted, the run's controller gets a
 * wake (a hint; its backstop timer finds the result too); a repeat of the
 * request sends the wake again.
 */
export async function sendWorkflowInputV2(
    host: Pick<WorkflowV2Host, "catalog" | "store" | "duroxideClient">,
    request: {
        workflowSessionId: string;
        senderSessionId: string;
        runId?: string | null;
        contract: string;
        correlation?: JsonValue;
        payload: JsonValue;
        ttlSeconds?: number | null;
        operationId: string;
    },
): Promise<StoredOperation<WorkflowInputReceipt>> {
    requireOperationId(request.operationId);
    const { workflowSessionId, senderSessionId } = request;
    const definition = await host.store.readDefinition(workflowSessionId);
    if (!definition) throw new WorkflowStoreError("WORKFLOW_NOT_FOUND", `${workflowSessionId} is not a version 2 workflow.`);
    if (definition.state === "deleted") throw new WorkflowStoreError("WORKFLOW_DELETED", "This workflow was deleted.");
    // An earlier refusal on the catalog's rows; a fresh input is decided again
    // when it is accepted, under the session locks (store.acceptInput).
    const authority = await typedInputAuthority(host.catalog, host.store, workflowSessionId, senderSessionId);
    if (authority !== "allowed") throw new WorkflowStoreError("FORBIDDEN", TYPED_INPUT_REFUSALS[authority]);
    const runs = await host.store.listRuns(workflowSessionId);
    const run = request.runId ? runs.find(item => item.runId === request.runId) : runs.find(item => item.mode === "live");
    if (!run) throw new WorkflowStoreError("RUN_NOT_FOUND", request.runId ? `Run ${request.runId} is not a run of this workflow.` : "This workflow has no live run to give input to.");
    if (typeof request.contract !== "string") throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "contract must name a contract, such as BuildEvent@1.");
    const ir = await host.store.readRevisionIr(workflowSessionId, run.revision, run.irSha256);
    const contract = ir.contracts?.[request.contract];
    const received = new Set(Object.values(ir.nodes).flatMap(node => node.type === "messaging" ? [node.contract] : []));
    if (!contract || !received.has(request.contract)) {
        throw new WorkflowStoreError("UNSUPPORTED_CONTRACT", `This workflow does not receive contract '${request.contract}'.`, { receives: [...received].sort() });
    }
    let payloadText: string;
    try { payloadText = boundedCanonicalJson(request.payload, "The input payload"); }
    catch (error) {
        if (error instanceof WorkflowJsonError) throw new WorkflowStoreError("INPUT_INVALID", error.message);
        throw error;
    }
    const problems = schemaSetFor(run.irSha256, ir.schemaDefs).validate(contract.schema, request.payload);
    if (problems.length) {
        throw new WorkflowStoreError("INPUT_INVALID", `The payload does not match contract ${request.contract}.`,
            problems.map(problem => ({ path: problem.path, message: problem.message })));
    }
    const correlationText = correlationTextOf(request.correlation === undefined || request.correlation === null ? {} : request.correlation);
    if (correlationText === null) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `correlation must be a JSON object of at most ${WORKFLOW_V2_MAX_CORRELATION_BYTES} bytes.`);
    }
    const ttlSeconds = request.ttlSeconds ?? WORKFLOW_V2_INPUT_TTL_SECONDS;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > WORKFLOW_V2_INPUT_TTL_SECONDS) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `ttl_seconds must be an integer from 1 to ${WORKFLOW_V2_INPUT_TTL_SECONDS}.`);
    }
    const requestSha256 = jsonSha256({ kind: "input", runId: run.runId, contract: request.contract, correlation: correlationText, payload: payloadText, ttlSeconds });
    const stored = await host.store.acceptInput({
        workflowSessionId, runId: run.runId, messageId: randomUUID(), senderSessionId, operationId: request.operationId, requestSha256,
        contract: request.contract, correlationText, payloadText, ttlSeconds, limits: WORKFLOW_V2_INBOX_LIMITS,
    });
    if (stored.receipt.claimedBy && ACTIVE_RUN_STATUSES.includes(stored.run.status)) {
        await host.duroxideClient.enqueueEvent(stored.run.controllerInstanceId, WORKFLOW_COMMAND_QUEUE,
            JSON.stringify({ type: "workflow-wake", runId: stored.run.runId, reason: "input" }));
    }
    return { receipt: stored.receipt, replayed: stored.replayed };
}
