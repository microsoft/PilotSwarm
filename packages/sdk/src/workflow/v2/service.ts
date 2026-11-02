import { randomUUID } from "node:crypto";
import type { SessionCatalog } from "../../cms.js";
import type { SessionOwnerInfo } from "../../types.js";
import type { WorkflowToolBinding } from "../tool-policy.js";
import {
    compileWorkflowV2, declaredSemver, WORKFLOW_V2_API_VERSION, WORKFLOW_V2_MILESTONE_IR_VERSION, WORKFLOW_V2_RUNNABLE_IR_VERSION,
    type WorkflowCompileResult, type WorkflowIR,
} from "./compiler.js";
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
    WORKFLOW_V2_REQUEST_CONTROLLER_VERSION,
    WORKFLOW_V2_STOP_CONTROLLER_VERSIONS,
    WORKFLOW_V2_TAGGED_ORCHESTRATION_VERSION,
    workflowLiveControllerInstanceId,
    workflowNotifyInstanceId,
    workflowTestControllerInstanceId,
    type ControllerInput,
} from "./runtime.js";
import { testResultFor, workflowTestAnsweredProjection, type WorkflowTestFixture, type WorkflowTestResponse } from "./test-mode.js";
import { WORKFLOW_COMMAND_QUEUE } from "../orchestration.js";
import {
    ACTIVE_RUN_STATUSES,
    ADMITTING_RUN_STATUSES,
    checkedKvText,
    isKvKey,
    parseSessionCommandReceipt,
    runNotBegun,
    typedInputRequestSha256,
    WORKFLOW_V2_INPUT_TTL_SECONDS,
    WorkflowStoreError,
    type RunAdmission,
    type StoredOperation,
    type WorkflowActor,
    type WorkflowDefinitionReceipt,
    type WorkflowInboxLimits,
    type WorkflowInputReceipt,
    type WorkflowOutboxMessage,
    type WorkflowRunCommandReceipt,
    type WorkflowRunRow,
    type WorkflowRunStatus,
    type WorkflowSessionCommandReceipt,
    type WorkflowStore,
    type WorkflowNodeExecutionRow,
    type WorkflowTestAdvanceReceipt,
    type WorkflowTestInterception,
} from "./store.js";

export { WORKFLOW_V2_INPUT_TTL_SECONDS } from "./store.js";

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
    /**
     * Request states (design workflow-messaging-request.md 8.4; INACTIVE:
     * only a test sets it, with workers that register them): a definition
     * compiles with request states enabled (IR 7), and runs start at
     * controller 1.9.0 with the 1.1.0 notifier. Absent or false: a request
     * state keeps a definition an invalid draft, and runs start at 1.8.0.
     */
    requests?: boolean;
    /**
     * Resolve a named agent as an agent state's child would be bound to it
     * (INACTIVE; design 03 package agents): the definition the caller's
     * owner sees by that name, or null. When the host has it, publication
     * pins every named agent state of the published revision to what it
     * returns (WorkflowStore publication, migration 0099) and refuses one
     * it cannot resolve (AGENT_UNAVAILABLE).
     */
    resolveAgent?: (name: string, callerSessionId: string) => Promise<WorkflowPublicationAgent | null>;
    /**
     * The test-run retention policy (design 05 cleanup; INACTIVE: only a host
     * that runs tests applies it): after each test admission, the workflow's
     * ended test runs beyond the newest `keep` that ended at least
     * `graceSeconds` ago, and whose controller has finished, are deleted
     * (WorkflowStore.pruneTestRun). Defaults: WORKFLOW_V2_TEST_RUNS_RETAINED
     * and WORKFLOW_V2_TEST_RUN_RETENTION_GRACE_SECONDS.
     */
    testRetention?: { keep?: number; graceSeconds?: number };
}

/** How many ended test runs a workflow keeps by default (design 05 cleanup; D07: a configurable default). */
export const WORKFLOW_V2_TEST_RUNS_RETAINED = 20;
/** How long an ended test run is kept at least, so that its controller's notice and its effects settle first. */
export const WORKFLOW_V2_TEST_RUN_RETENTION_GRACE_SECONDS = 300;

/** A named agent as the host resolves it at publication. */
export interface WorkflowPublicationAgent {
    name: string;
    system?: boolean;
    creatable?: boolean;
    packageId?: string;
    packageName?: string;
    packageVersion?: string;
    /** The content hash of the exact package version (R18): pinned with it, so a run keeps that revision after a republish. */
    packageRevision?: string;
}

/**
 * The agent pins of a revision to publish (design 03, 02 publication;
 * T011, T018): for each agent state that names an agent, what the host
 * resolves it to for the workflow's parent (the agent states' controlling
 * agent), as the child's binding would: its agent, package, package version
 * and package id. A named agent that the host cannot resolve, that is a
 * worker-managed system agent, or that does not match the package or
 * version the state names refuses the publication (AGENT_UNAVAILABLE); a
 * generic agent is never substituted. Null when the revision has no named
 * agent state or the host does not resolve agents (its children are then
 * bound when they are created, as before).
 */
async function publicationAgentPins(host: Pick<WorkflowV2Host, "resolveAgent">, ir: WorkflowIR | null, callerSessionId: string): Promise<string | null> {
    if (!ir || !host.resolveAgent) return null;
    const pins: { [stateId: string]: JsonValue } = {};
    for (const node of Object.values(ir.nodes)) {
        if (node.type !== "agent" || !("agent" in node.invoke)) continue;
        const named = node.invoke.agent;
        const resolved = await host.resolveAgent(named.name, callerSessionId);
        const refuse = (message: string): never => {
            throw new WorkflowStoreError("AGENT_UNAVAILABLE", message, { stateId: node.id, agent: named.name, package: named.package, version: named.version });
        };
        if (!resolved) refuse(`Agent "${named.name}" of state '${node.id}' is not available to this workflow's owner; publication pins every named agent.`);
        else {
            if (resolved.system && resolved.creatable === false) refuse(`Agent "${named.name}" of state '${node.id}' is a worker-managed system agent; a workflow cannot run it.`);
            if (named.package !== null && resolved.packageName !== named.package) {
                refuse(`Agent "${named.name}" of state '${node.id}' is not available from package "${named.package}".`);
            }
            if (named.version !== null && resolved.packageVersion !== named.version) {
                refuse(`Agent "${named.name}" of state '${node.id}' is not available at version ${named.version} (it is at ${resolved.packageVersion ?? "no version"}).`);
            }
            pins[node.id] = {
                name: resolved.name, package: resolved.packageName ?? null, version: resolved.packageVersion ?? null, packageId: resolved.packageId ?? null,
                // The exact revision (R18), when the host knows it; a run of this publication then keeps it after a republish.
                ...(resolved.packageId && resolved.packageRevision ? { revision: resolved.packageRevision } : {}),
            };
        }
    }
    return Object.keys(pins).length > 0 ? canonicalJson(pins) : null;
}

/** The controller version a host starts runs at (WorkflowV2Host.requests). */
function controllerVersionFor(host: Pick<WorkflowV2Host, "requests">): string {
    return host.requests === true ? WORKFLOW_V2_REQUEST_CONTROLLER_VERSION : WORKFLOW_V2_CONTROLLER_VERSION;
}

/**
 * The controller version a run was admitted for (migration 0096; a run
 * admitted before it records none, and 1.8.0 was then the only version). A
 * run is started, recovered and reported only at its own version, never at
 * the version of the host that acts on it: design 02 never points a
 * new-version run at a legacy interpreter, nor an older run at a newer one.
 */
function runControllerVersion(run: Pick<WorkflowRunRow, "controllerVersion">): string {
    return run.controllerVersion ?? WORKFLOW_V2_CONTROLLER_VERSION;
}

/** The notifier version of a run's controller: a 1.9.0 run reports through the tagged 1.1.0 notifier. */
function runNotifyVersion(run: Pick<WorkflowRunRow, "controllerVersion">): string {
    return runControllerVersion(run) === WORKFLOW_V2_REQUEST_CONTROLLER_VERSION ? WORKFLOW_V2_TAGGED_ORCHESTRATION_VERSION : WORKFLOW_V2_NOTIFY_VERSION;
}

/**
 * The run's controller version when this host runs it; otherwise
 * CONTROLLER_UNAVAILABLE before anything changes (design 02 compatibility,
 * T121, T122): a 1.9.0 run is started or recovered only by a host that starts
 * 1.9.0 runs (WorkflowV2Host.requests), and never handed to 1.8.0.
 */
function requireRunsController(host: Pick<WorkflowV2Host, "requests">, run: Pick<WorkflowRunRow, "runId" | "controllerVersion">): string {
    const version = runControllerVersion(run);
    if (version === WORKFLOW_V2_CONTROLLER_VERSION || (version === WORKFLOW_V2_REQUEST_CONTROLLER_VERSION && host.requests === true)) return version;
    throw new WorkflowStoreError("CONTROLLER_UNAVAILABLE",
        `Run ${run.runId} was admitted for workflow controller ${version}, which this build does not run; a build that runs it starts or recovers it.`,
        { runId: run.runId, controllerVersion: version, hostControllerVersion: controllerVersionFor(host) });
}

/**
 * Refuse, before anything is written, to publish or start a revision whose IR
 * this host does not run (design 02 compatibility: reader support precedes
 * new writes; T121): IR 7 and 8 (request, agent or parallel states, or a run
 * deadline) need controller 1.9.0, so a host that starts 1.8.0 runs answers
 * CONTROLLER_UNAVAILABLE and neither publishes nor admits anything; a host
 * that starts 1.9.0 runs does both. A revision that does not exist, or has no
 * compiled IR, is left to the store's own refusal.
 */
async function requireRunsRevision(host: Pick<WorkflowV2Host, "store" | "requests">, workflowSessionId: string, revision: number | null): Promise<void> {
    if (host.requests === true || revision === null) return;
    const irVersion = await host.store.readRevisionIrVersion(workflowSessionId, revision);
    if (irVersion === null || irVersion <= WORKFLOW_V2_RUNNABLE_IR_VERSION) return;
    throw new WorkflowStoreError("CONTROLLER_UNAVAILABLE",
        `Revision ${revision} has IR version ${irVersion} (request, agent or parallel states, or a run deadline), which needs workflow controller `
            + `${WORKFLOW_V2_REQUEST_CONTROLLER_VERSION}; this build runs ${WORKFLOW_V2_CONTROLLER_VERSION}, so it neither publishes nor starts it.`,
        { revision, irVersion, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, hostControllerVersion: WORKFLOW_V2_CONTROLLER_VERSION });
}

/** A definition as a host compiles it (WorkflowV2Host.requests): a host that starts 1.9.0 runs compiles request, agent and parallel states. */
function compileFor(host: Pick<WorkflowV2Host, "requests">, yaml: string): WorkflowCompileResult {
    return compileWorkflowV2(yaml, host.requests === true ? { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true } : {});
}

/** How a host reads stored IR: a host that starts 1.9.0 runs reads its request, agent and parallel states (IR 7 and 8). */
function irOptionsFor(host: Pick<WorkflowV2Host, "requests">): { maxIrVersion?: number } {
    return host.requests === true ? { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION } : {};
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

/** A live run's admission, for the controller version this host starts runs at (stored with the run, migration 0096). */
function liveAdmission(host: Pick<WorkflowV2Host, "requests">, workflowSessionId: string, inputs: JsonValue, vars: { [key: string]: JsonValue } | null): RunAdmission {
    return {
        runId: randomUUID(), mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
        inputsText: boundedCanonicalJson(inputs, "Workflow inputs"), kvText: checkedKvText(vars ?? {}), testAgentMode: null,
        controllerVersion: controllerVersionFor(host),
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
    // At the version the run was admitted for (a replayed admission may reach a host that does not run it: refused).
    await host.duroxideClient.startOrchestrationVersioned(admitted.controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME, input, requireRunsController(host, run));
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

const RUN_STATUSES: readonly WorkflowRunStatus[] = [...ACTIVE_RUN_STATUSES, "completed", "failed", "cancelled", "stopped"];

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
async function notifyRecoveredRun(host: Pick<WorkflowV2Host, "store" | "duroxideClient" | "requests">, run: WorkflowRunRow): Promise<void> {
    if (run.mode !== "live" || run.status !== "failed" || !isJsonObject(run.terminalError) || run.terminalError.code !== "controller_ended") return;
    const definition = await host.store.readDefinition(run.workflowSessionId);
    if (!definition?.parentSessionId || !definition.notifyParent) return;
    await host.duroxideClient.startOrchestrationVersioned(workflowNotifyInstanceId(run.runId), WORKFLOW_V2_NOTIFY_NAME,
        { runId: run.runId }, runNotifyVersion(run));
}

/**
 * Start the controller of a run whose recover receipt says it was
 * dispatched, while its controller has not begun it. The
 * receipt was stored first, so a repeat of the request reaches this again
 * after an interruption; duroxide ignores a second start of an instance, and
 * the run's stored controller instance id never changes.
 */
async function dispatchRecoveredRun(host: Pick<WorkflowV2Host, "duroxideClient" | "requests">, run: WorkflowRunRow): Promise<void> {
    if (!runNotBegun(run)) return;
    const input: ControllerInput = { v: 2, workflowSessionId: run.workflowSessionId, runId: run.runId };
    await host.duroxideClient.startOrchestrationVersioned(run.controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME, input, requireRunsController(host, run));
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
async function notifyCancelledBeforeBegin(host: Pick<WorkflowV2Host, "store" | "duroxideClient" | "requests">, run: WorkflowRunRow, operationId: string,
    callerSessionId: string | null): Promise<void> {
    const error = run.terminalError;
    const details = isJsonObject(error) && isJsonObject(error.details) ? error.details : null;
    if (run.mode !== "live" || run.status !== "cancelled" || !details || details.beforeBegin !== true || details.operationId !== operationId) return;
    const definition = await host.store.readDefinition(run.workflowSessionId);
    if (!definition?.parentSessionId || !definition.notifyParent) return;
    if (details.requestedBy === definition.parentSessionId || callerSessionId === definition.parentSessionId) return;
    await host.duroxideClient.startOrchestrationVersioned(workflowNotifyInstanceId(run.runId), WORKFLOW_V2_NOTIFY_NAME,
        { runId: run.runId }, runNotifyVersion(run));
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
export async function recoverWorkflowV2Run(host: Pick<WorkflowV2Host, "store" | "duroxideClient" | "requests">, runId: string,
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
        // Only a host that runs the run's controller version starts it; nothing is recorded otherwise.
        requireRunsController(host, run);
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
    const compiled = compileFor(host, request.yaml);
    const publish = request.publish === true || Boolean(request.start);
    const startInputs = request.start ? request.start.inputs : null;
    if (request.start) validateRunInputs(compiled, request.start.inputs);
    // Built before anything is written: inputs or vars over their limits refuse the request without a claim.
    const admission = request.start ? liveAdmission(host, request.workflowSessionId, request.start.inputs, request.start.vars ?? null) : null;
    // A definition published at creation pins its named agents first: one that cannot be resolved refuses the request
    // before anything is written.
    const agentPinsText = publish && compiled.valid ? await publicationAgentPins(host, compiled.ir, request.parentSessionId ?? request.workflowSessionId) : null;
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
        ...(agentPinsText !== null ? { agentPinsText } : {}),
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
        const compiled = compileFor(host, command.yaml);
        stored = await host.store.replaceDraft({
            workflowSessionId, expectedRevision: command.expectedRevision, yaml: command.yaml, compiled,
            declaredSemver: compiled.version ?? declaredSemver(command.yaml), actor: context.actor, operationId: context.operationId,
            requestSha256: jsonSha256({ kind: "replace_definition", yamlSha256: compiled.yamlSha256, expectedRevision: command.expectedRevision }),
            title: `Workflow: ${compiled.name ?? "draft"}`,
        });
        return stored;
    }
    if (command.operation === "publish" || command.operation === "publish_and_start") {
        await requireRunsRevision(host, workflowSessionId, command.expectedRevision);
        // The operation decides whether a run starts; any JSON input, null included, is a value.
        const startInputs: { value: JsonValue } | null = command.operation === "publish_and_start" ? { value: command.inputs } : null;
        // The revision to publish: its inputs are checked for a start, and on a host that resolves agents its named agents
        // are pinned (a publication refused there writes nothing; the store decides the revision, hash and state again).
        const readsIr = command.operation === "publish_and_start" || host.resolveAgent !== undefined;
        const revision = readsIr ? await host.store.readRevision(workflowSessionId, command.expectedRevision) : null;
        const revisionIr = revision?.valid && revision.irSha256
            ? await host.store.readRevisionIr(workflowSessionId, command.expectedRevision, revision.irSha256, irOptionsFor(host)) : null;
        if (command.operation === "publish_and_start" && revisionIr && revision?.irSha256) {
            const problems = revisionIr.inputsSchema ? schemaSetFor(revision.irSha256, revisionIr.schemaDefs).validate(revisionIr.inputsSchema, command.inputs) : [];
            if (problems.length) {
                throw new WorkflowStoreError("WORKFLOW_INPUT_INVALID", "Workflow inputs do not match inputs.schema.",
                    problems.map(problem => ({ path: problem.path, message: problem.message })));
            }
        }
        const definition = revisionIr ? await host.store.readDefinition(workflowSessionId) : null;
        const agentPinsText = revisionIr && definition?.state === "draft"
            ? await publicationAgentPins(host, revisionIr, definition.parentSessionId ?? workflowSessionId) : null;
        stored = await host.store.publish({
            workflowSessionId, expectedRevision: command.expectedRevision, definitionHash: command.definitionHash,
            operationId: context.operationId,
            requestSha256: jsonSha256({ kind: command.operation, expectedRevision: command.expectedRevision, definitionHash: command.definitionHash,
                ...(startInputs ? { inputs: canonicalJson(startInputs.value) } : {}),
                ...(command.operation === "publish_and_start" ? varsDigestPart(command.vars) : {}) }),
            start: startInputs ? liveAdmission(host, workflowSessionId, startInputs.value, command.operation === "publish_and_start" ? command.vars ?? null : null) : null,
            ...(agentPinsText !== null ? { agentPinsText } : {}),
        });
    } else {
        const definition = await host.store.readDefinition(workflowSessionId);
        await requireRunsRevision(host, workflowSessionId, definition?.publishedRevision ?? null);
        if (definition?.state === "published" && definition.publishedRevision !== null && definition.publishedIrSha256) {
            const ir = await host.store.readRevisionIr(workflowSessionId, definition.publishedRevision, definition.publishedIrSha256, irOptionsFor(host));
            const problems = ir.inputsSchema ? schemaSetFor(definition.publishedIrSha256, ir.schemaDefs).validate(ir.inputsSchema, command.inputs) : [];
            if (problems.length) {
                throw new WorkflowStoreError("WORKFLOW_INPUT_INVALID", "Workflow inputs do not match inputs.schema.",
                    problems.map(problem => ({ path: problem.path, message: problem.message })));
            }
        }
        stored = await host.store.startLive({
            workflowSessionId, definitionHash: command.definitionHash, operationId: context.operationId,
            requestSha256: jsonSha256({ kind: "start", definitionHash: command.definitionHash, inputs: canonicalJson(command.inputs), ...varsDigestPart(command.vars) }),
            start: liveAdmission(host, workflowSessionId, command.inputs, command.vars ?? null),
        });
    }
    if (stored.receipt.run) await dispatchWorkflowV2Run(host, stored.receipt);
    return stored;
}

export type WorkflowV2RunCommand =
    | { operation: "set_vars"; runId: string | null; set: { [key: string]: JsonValue }; delete: string[]; expectedKvRevision: number }
    | { operation: "pause" | "resume" | "cancel"; runId: string | null; reason: string | null }
    /** A graceful stop (controller 1.9.0 only; INACTIVE): graceSeconds null is the default grace. */
    | { operation: "stop"; runId: string | null; reason: string | null; graceSeconds: number | null };

/** The grace a stop gives a run's admitted work to settle when the request names none (design D03; at most WORKFLOW_V2_STOP_MAX_GRACE_SECONDS). */
export const WORKFLOW_V2_STOP_DEFAULT_GRACE_SECONDS = 60;

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
 *   run-ending transaction decides, and read_workflow shows the result;
 * - stop (controller 1.9.0 only; INACTIVE: only a test host starts runs
 *   there): a graceful stop. The store records it once, with its deadline
 *   (the store's clock plus the grace), for a run admitted for a controller
 *   that stops (store.requestRunStop): the run admits no new state, its
 *   admitted work may settle until the deadline, and then its controller
 *   ends it stopped, cancelling what is still pending. The controller is
 *   told at once (a hint; its backstop collection finds the stop too). The
 *   receipt says the stop was accepted, not that the run has ended.
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
    if (command.operation === "stop") {
        const graceSeconds = command.graceSeconds ?? WORKFLOW_V2_STOP_DEFAULT_GRACE_SECONDS;
        const stored = await host.store.requestRunStop({
            workflowSessionId, runId: run.runId, operationId: context.operationId, actor: context.actor, reason: command.reason, graceSeconds,
            requestSha256: jsonSha256({ kind: "stop", runId: run.runId, reason: command.reason, graceSeconds }),
            stoppableVersions: WORKFLOW_V2_STOP_CONTROLLER_VERSIONS,
        });
        // The stop is stored first, so a repeat of the request sends this hint again; a wake changes nothing by itself.
        if (ACTIVE_RUN_STATUSES.includes(stored.run.status)) {
            await host.duroxideClient.enqueueEvent(stored.run.controllerInstanceId, WORKFLOW_COMMAND_QUEUE,
                JSON.stringify({ type: "workflow-wake", runId: stored.run.runId, reason: "stop" }));
        }
        return { receipt: stored.receipt, replayed: stored.replayed };
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
export async function sendWorkflowInputV2(host: TypedInputHost, request: TypedInputRequest): Promise<StoredOperation<WorkflowInputReceipt>> {
    return acceptTypedInput(host, request, null);
}

/**
 * A send state's message given to its workflow recipient as typed input,
 * from the sending workflow: send_workflow_input's checks and acceptance with
 * the message's frozen contract, correlation and payload, the exchange id as
 * the operation id, the recipient's live run and the default ttl. The
 * acceptance is bound to the send (store.acceptInput sendExchangeId): the
 * recipient takes no fresh input for a send decided first (SEND_DECIDED), and
 * a repeat of an acceptance made before is answered as any repeat. Only the
 * send's delivery calls this; no public request carries that binding.
 */
export async function acceptSendAsWorkflowInputV2(host: TypedInputHost, message: WorkflowOutboxMessage): Promise<StoredOperation<WorkflowInputReceipt>> {
    return acceptTypedInput(host, {
        workflowSessionId: message.recipientSessionId, senderSessionId: message.workflowSessionId, runId: null, contract: message.contract,
        correlation: message.correlation, payload: message.payload, ttlSeconds: null, operationId: message.exchangeId,
    }, message.exchangeId);
}

type TypedInputHost = { catalog: Pick<SessionCatalog, "getSession">; store: WorkflowStore; duroxideClient: Pick<WorkflowV2Host["duroxideClient"], "enqueueEvent"> };

interface TypedInputRequest {
    workflowSessionId: string;
    senderSessionId: string;
    runId?: string | null;
    contract: string;
    correlation?: JsonValue;
    payload: JsonValue;
    ttlSeconds?: number | null;
    operationId: string;
}

async function acceptTypedInput(host: TypedInputHost, request: TypedInputRequest, sendExchangeId: string | null)
    : Promise<StoredOperation<WorkflowInputReceipt>> {
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
    // Reading the contracts runs nothing: a run of request or agent states (IR 7 and 8, INACTIVE) takes input as any run.
    const ir = await host.store.readRevisionIr(workflowSessionId, run.revision, run.irSha256, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
    const contract = ir.contracts?.[request.contract];
    const received = new Set(Object.values(ir.nodes).flatMap(node => node.type === "messaging" && node.mode === "receive" ? [node.contract] : []));
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
    const requestSha256 = typedInputRequestSha256({ runId: run.runId, contract: request.contract, correlationText, payloadText, ttlSeconds });
    const stored = await host.store.acceptInput({
        workflowSessionId, runId: run.runId, messageId: randomUUID(), senderSessionId, operationId: request.operationId, requestSha256,
        contract: request.contract, correlationText, payloadText, ttlSeconds, limits: WORKFLOW_V2_INBOX_LIMITS,
        ...(sendExchangeId !== null ? { sendExchangeId } : {}),
    });
    if (stored.receipt.claimedBy && ACTIVE_RUN_STATUSES.includes(stored.run.status)) {
        await host.duroxideClient.enqueueEvent(stored.run.controllerInstanceId, WORKFLOW_COMMAND_QUEUE,
            JSON.stringify({ type: "workflow-wake", runId: stored.run.runId, reason: "input" }));
    }
    return { receipt: stored.receipt, replayed: stored.replayed };
}

// ─── Test runs (migration 0098; design 05 tool-mocked testing; INACTIVE) ───

/** update_workflow operation test: a test run of the exact current revision (INACTIVE: only a host that starts 1.9.0 runs takes it). */
export interface WorkflowV2TestCommand {
    expectedRevision: number;
    definitionHash: string;
    inputs: JsonValue;
    vars?: { [key: string]: JsonValue };
    agentMode: "mocked" | "real";
    fixtures: WorkflowTestFixture[];
    /** The scenario the test run is for (migration 0099), kept with its results as evidence; null for none. */
    scenario?: string | null;
}

/** The operation a host that does not run tests refuses, as an unknown operation is refused. */
function requireTestHost(host: Pick<WorkflowV2Host, "requests">): void {
    if (host.requests !== true) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "This build does not run workflow tests.");
}

/** Tell a run's controller to collect at once (a hint; its backstop finds the change too). */
async function wakeRun(host: Pick<WorkflowV2Host, "duroxideClient">, run: Pick<WorkflowRunRow, "controllerInstanceId" | "runId">, reason: string): Promise<void> {
    await host.duroxideClient.enqueueEvent(run.controllerInstanceId, WORKFLOW_COMMAND_QUEUE, JSON.stringify({ type: "workflow-wake", runId: run.runId, reason }));
}

/**
 * A real-agent test run's agent pins (design 05: package identities are
 * pinned just as a live run's are; R18, R19): a test of the published
 * revision takes its publication's pins; a test of a draft is pinned as its
 * publication would be (publicationAgentPins, for the workflow's parent): a
 * named agent that the workflow's owner cannot use, a worker-managed system
 * agent, or a package or version that does not match refuses the test with
 * AGENT_UNAVAILABLE before anything is written, so a test never runs an agent
 * that its publication could not pin. Null when nothing is pinned (no named
 * agent state, or a host that does not resolve agents: its children are then
 * bound when they are created, by the same visibility rules).
 */
async function testAgentPins(host: Pick<WorkflowV2Host, "store" | "resolveAgent">, workflowSessionId: string, revision: number, ir: WorkflowIR | null)
    : Promise<string | null> {
    const definition = await host.store.readDefinition(workflowSessionId);
    if (!definition) return null;
    if (definition.publishedRevision === revision) return definition.publishedAgentPins === null ? null : canonicalJson(definition.publishedAgentPins);
    return publicationAgentPins(host, ir, definition.parentSessionId ?? workflowSessionId);
}

/**
 * Start a test run (design 05; R19, R20; INACTIVE): the exact current
 * revision the request names (expected_revision and definition_hash), draft
 * or published, with its inputs (checked against inputs.schema), its own
 * initial KV, and the fixtures it answers intercepted effects from. The run
 * runs at controller 1.9.0 under its own controller instance; its scripts
 * run normally, its framework effects are intercepted, and its deadlines run
 * on its virtual clock. It never changes the live run, and it is never
 * evidence that the definition is safe to run live.
 *
 * Agent mode mocked (the default): each agent state is intercepted, and the
 * parent (or a fixture) supplies its typed result. Agent mode real: each
 * agent state's child is an ordinary agent session, created and bound as a
 * live run's is (same owner, visibility, depth and system-agent rules, and
 * the package revision pinned at admission: testAgentPins), whose framework
 * tool calls are intercepted instead of running (test-agent-tools.ts). Its
 * deadline is on the run's virtual clock. Neither mode makes a package or a
 * tool available that a live run would not have, and nothing falls back to a
 * live call.
 */
export async function startWorkflowV2Test(host: WorkflowV2Host, workflowSessionId: string, command: WorkflowV2TestCommand,
    context: { actor: WorkflowActor; operationId: string }): Promise<StoredOperation<WorkflowDefinitionReceipt>> {
    requireOperationId(context.operationId);
    requireTestHost(host);
    if (command.agentMode !== "mocked" && command.agentMode !== "real") {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "agent_mode must be mocked or real.");
    }
    const revision = await host.store.readRevision(workflowSessionId, command.expectedRevision);
    let ir: WorkflowIR | null = null;
    if (revision?.valid && revision.irSha256) {
        ir = await host.store.readRevisionIr(workflowSessionId, command.expectedRevision, revision.irSha256, irOptionsFor(host));
        const problems = ir.inputsSchema ? schemaSetFor(revision.irSha256, ir.schemaDefs).validate(ir.inputsSchema, command.inputs) : [];
        if (problems.length) {
            throw new WorkflowStoreError("WORKFLOW_INPUT_INVALID", "Workflow inputs do not match inputs.schema.",
                problems.map(problem => ({ path: problem.path, message: problem.message })));
        }
    }
    const fixturesText = canonicalJson(command.fixtures);
    const requestSha256 = jsonSha256({ kind: "test", expectedRevision: command.expectedRevision, definitionHash: command.definitionHash,
        inputs: canonicalJson(command.inputs), agentMode: command.agentMode, fixtures: fixturesText, ...varsDigestPart(command.vars),
        ...(command.scenario ? { scenario: command.scenario } : {}) });
    // A real-agent test is pinned once, when it is admitted; a repeat of its operation returns its receipt (the store reads it
    // again under its lock) and pins nothing again.
    const replay = command.agentMode === "real" ? await host.store.readOperationReceipt(workflowSessionId, context.operationId, "test", requestSha256) : null;
    const testAgentPinsText = command.agentMode === "real" && replay === null
        ? await testAgentPins(host, workflowSessionId, command.expectedRevision, ir) : null;
    const runId = randomUUID();
    const stored = await host.store.startTest({
        workflowSessionId, expectedRevision: command.expectedRevision, definitionHash: command.definitionHash, operationId: context.operationId,
        requestSha256,
        start: {
            runId, mode: "test", controllerInstanceId: workflowTestControllerInstanceId(runId),
            inputsText: boundedCanonicalJson(command.inputs, "Workflow inputs"), kvText: checkedKvText(command.vars ?? {}), testAgentMode: command.agentMode,
            controllerVersion: controllerVersionFor(host), fixturesText, ...(command.scenario ? { testScenario: command.scenario } : {}),
            ...(testAgentPinsText !== null ? { testAgentPinsText } : {}),
        },
    });
    if (stored.receipt.run) await dispatchWorkflowV2Run(host, stored.receipt);
    if (!stored.replayed) await retainTestRuns(host, workflowSessionId);
    return stored;
}

/**
 * Apply the test-run retention policy (WorkflowV2Host.testRetention) after a
 * test admission: delete the ended test runs beyond the newest `keep` that
 * ended at least the grace ago and whose controller instance has finished
 * (an ended run's controller may still be telling its parent). Best effort:
 * a failure never refuses the test that was admitted; it is recorded as
 * workflow.test_retention_failed, and the next admission tries again.
 */
async function retainTestRuns(host: Pick<WorkflowV2Host, "store" | "duroxideClient" | "testRetention">, workflowSessionId: string): Promise<void> {
    const keep = host.testRetention?.keep ?? WORKFLOW_V2_TEST_RUNS_RETAINED;
    const graceSeconds = host.testRetention?.graceSeconds ?? WORKFLOW_V2_TEST_RUN_RETENTION_GRACE_SECONDS;
    try {
        for (const run of await host.store.listPrunableTestRuns(workflowSessionId, { keep, graceSeconds })) {
            const controller = await host.duroxideClient.getStatus(run.controllerInstanceId);
            if (!["Completed", "Failed", "Terminated", "NotFound"].includes(controller.status)) continue;
            await host.store.pruneTestRun(run.runId, {
                graceSeconds,
                projection: pruned => ({ sessionId: workflowSessionId, events: [{ eventType: "workflow.test_run_deleted", data: {
                    runId: pruned.runId, revision: pruned.revision, status: pruned.status, scenario: pruned.testScenario,
                    reason: "retention", keep, graceSeconds,
                } }] }),
            });
        }
    } catch (error) {
        await host.store.recordSessionEvents(workflowSessionId, [{ eventType: "workflow.test_retention_failed", data: {
            error: jsonbSafeText(error instanceof Error ? error.message : String(error), 1_000),
        } }]).catch(() => undefined);
    }
}

/** The test run a test command names (run_id is required: a test command never defaults to the live run). */
async function testRun(host: Pick<WorkflowV2Host, "store">, workflowSessionId: string, runId: string): Promise<WorkflowRunRow> {
    const run = await commandRun(host, workflowSessionId, runId);
    if (run.mode !== "test") throw new WorkflowStoreError("RUN_NOT_TEST", `Run ${run.runId} is not a test run.`);
    return run;
}

/**
 * Answer an intercepted effect of a test run by its interception id (design
 * 05; out of band: this answer is never itself intercepted): a tool call's
 * script receives it; an agent's, send's or request's state is decided by
 * it, checked as the live effect's result would be (testResultFor). An
 * invalid answer is refused with its field errors and the effect stays
 * open; the same answer again is idempotent, another is
 * TEST_RESPONSE_CONFLICT; an answer to an effect whose state was decided
 * otherwise (a virtual deadline, a cancel) is refused.
 */
export async function respondWorkflowV2Test(host: Pick<WorkflowV2Host, "store" | "duroxideClient" | "requests">, workflowSessionId: string,
    command: { runId: string; interceptionId: string; response: WorkflowTestResponse }, context: { actor: WorkflowActor; operationId: string })
    : Promise<{ replayed: boolean; interception: WorkflowTestInterception; node: WorkflowNodeExecutionRow }> {
    requireOperationId(context.operationId);
    requireTestHost(host);
    const run = await testRun(host, workflowSessionId, command.runId);
    const intercepted = await host.store.readInterception(command.interceptionId);
    if (!intercepted || intercepted.runId !== run.runId) {
        throw new WorkflowStoreError("INTERCEPTION_NOT_FOUND", `Interception ${command.interceptionId} is not one of test run ${run.runId}.`);
    }
    const executed = await host.store.readNodeExecution(intercepted.nodeExecutionId);
    if (!executed) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Interception ${command.interceptionId} names no node execution.`);
    const ir = await host.store.readRevisionIr(workflowSessionId, run.revision, run.irSha256, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
    const node = ir.nodes[executed.nodeId];
    if (!node) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `The pinned definition has no state ${executed.nodeId}.`);
    const decide = testResultFor(intercepted, node, ir, run.irSha256, command.response);
    const answered = await host.store.respondInterception({
        workflowSessionId, runId: run.runId, interceptionId: command.interceptionId, kind: command.response.kind,
        valueText: canonicalJson(command.response.value), disposition: "parent", operationId: context.operationId, actor: context.actor, decide,
        projection: record => workflowTestAnsweredProjection(run, executed, record, decide),
    });
    if (decide !== null) await wakeRun(host, run, "test");
    return { replayed: answered.replayed, interception: answered.record, node: answered.node };
}

/**
 * Advance a test run's virtual clock (design 05 timer simulation), once per
 * operation id: what became due is decided in the same transaction, in
 * deadline order (store.advanceTestClock), and the controller is told.
 */
export async function advanceWorkflowV2Test(host: Pick<WorkflowV2Host, "store" | "duroxideClient" | "requests">, workflowSessionId: string,
    command: { runId: string; seconds: number }, context: { actor: WorkflowActor; operationId: string }): Promise<StoredOperation<WorkflowTestAdvanceReceipt>> {
    requireOperationId(context.operationId);
    requireTestHost(host);
    const run = await testRun(host, workflowSessionId, command.runId);
    const stored = await host.store.advanceTestClock({
        workflowSessionId, runId: run.runId, seconds: command.seconds, operationId: context.operationId,
        requestSha256: jsonSha256({ kind: "test_advance", runId: run.runId, seconds: command.seconds }),
        projection: receipt => ({
            sessionId: workflowSessionId,
            events: [
                { eventType: "workflow.test_clock_advanced", data: { runId: run.runId, seconds: receipt.seconds, from: receipt.from,
                    virtualNow: receipt.virtualNow, decidedCount: receipt.decided.length } },
                ...receipt.decided.slice(0, 100).map(item => ({
                    eventType: item.outcome === "timed_out" ? "workflow.state_failed" : "workflow.state_completed",
                    data: { runId: run.runId, nodeExecutionId: item.nodeExecutionId, stateId: item.stateId, outcome: item.outcome,
                        resultKind: item.outcome === "timed_out" ? "runtime_error" : "business", virtualNow: receipt.virtualNow },
                })),
            ],
            update: { touch: true },
        }),
    });
    await wakeRun(host, run, "test");
    return stored;
}
