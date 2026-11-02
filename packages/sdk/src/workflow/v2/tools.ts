import type { SessionOwnerInfo } from "../../types.js";
import type { WorkflowToolBinding } from "../tool-policy.js";
import { assertJsonValue, isJsonObject, isStorableText, jsonbSafeText, previewJson, WorkflowJsonError, type JsonValue } from "./json.js";
import { WORKFLOW_V2_MILESTONE_IR_VERSION } from "./compiler.js";
import { describeWorkflowV2States, parseBranchScope, ROOT_SCOPE } from "./runtime.js";
import { parseTestFixtures, parseTestResponse, WORKFLOW_V2_TEST_NOTICE } from "./test-mode.js";
import {
    advanceWorkflowV2Test,
    controlWorkflowV2Run,
    createWorkflowV2,
    inspectWorkflowV2Controller,
    recoverWorkflowV2Run,
    respondWorkflowV2Test,
    sendWorkflowInputV2,
    startWorkflowV2Test,
    updateWorkflowV2,
    type WorkflowV2Command,
    type WorkflowV2Host,
    type WorkflowV2RunCommand,
} from "./service.js";
import {
    ACTIVE_RUN_STATUSES,
    diagnosticsJson,
    WORKFLOW_V2_STOP_MAX_GRACE_SECONDS,
    WORKFLOW_V2_TEST_ADVANCE_MAX_SECONDS,
    WORKFLOW_V2_TEST_EPOCH,
    WorkflowStoreError,
    type WorkflowActor,
    type WorkflowDefinitionReceipt,
    type WorkflowRunCommandReceipt,
    type WorkflowStore,
    type WorkflowAgentInvocation,
    type WorkflowNodeExecutionRow,
    type WorkflowRunRow,
    type WorkflowTestInterception,
} from "./store.js";

/**
 * Agent tool adapters for workflow v2. Each returns one JSON payload; the
 * calling agent's session id comes from the host, never from arguments.
 */

export const UPDATE_WORKFLOW_TOOL_SPEC = {
    description:
        "Change a workflow child you created with spawn_workflow (apiVersion pilotswarm.dev/v2-draft). "
        + "operation: replace_definition (yaml + expected_revision; drafts only, same metadata.version), "
        + "publish (expected_revision + definition_hash of the exact reviewed revision; does not start), "
        + "publish_and_start (publish fields + inputs, optional vars), start (definition_hash + inputs, optional vars; one live run per workflow child), "
        + "set_vars (set: {key: JSON value} and/or delete: [keys], expected_kv_revision from read_workflow; one atomic batch on the run's open KV; "
        + "null is a value, deletion is explicit; a state admitted later reads it as context.kv, ${kv.key} or ${kv[\"any key\"]}, one already admitted keeps its snapshot), "
        + "pause (the run admits no new state; work already running finishes and its result is kept), resume (a paused run only), "
        + "cancel (a run that has not begun ends at once; otherwise its controller is asked to cancel it and read_workflow shows when it has ended), "
        + "or recover (run_id optional, default the live run): when read_workflow shows needsRecovery, a run whose controller ended "
        + "without ending it is ended as failed (controller_ended) and its parent is notified as for any end, and a run admitted but never "
        + "started is started; otherwise nothing changes. run_id names the run for set_vars, pause, resume, cancel and recover (default the live run). "
        + "operation_id makes every operation idempotent: repeating it returns the original receipt; reusing it for a different request fails. "
        + "A run command's receipt (status, kvRevision) is the run as the command was accepted; read_workflow shows the run now. "
        + "Published definitions never change; a new version needs a new workflow child. Returns JSON.",
    parameters: {
        type: "object",
        properties: {
            workflow_id: { type: "string", description: "The workflow session id from spawn_workflow." },
            operation: { type: "string", enum: ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel", "recover"] },
            operation_id: { type: "string", description: "Idempotency id for this change." },
            yaml: { type: "string", description: "replace_definition: the complete new Workflow YAML." },
            expected_revision: { type: "integer", description: "replace_definition/publish: the draft revision you reviewed." },
            definition_hash: { type: "string", description: "publish/start: the yamlSha256 of the reviewed revision." },
            inputs: { type: "object", description: "publish_and_start/start: static run inputs checked against inputs.schema." },
            vars: { type: "object", description: "publish_and_start/start: the run's initial open KV map (any keys, JSON values)." },
            set: { type: "object", description: "set_vars: keys to set, with their JSON values." },
            delete: { type: "array", items: { type: "string" }, description: "set_vars: keys to delete." },
            expected_kv_revision: { type: "integer", description: "set_vars: the run's kvRevision you read." },
            reason: { type: "string", description: "pause/resume/cancel: an optional short reason." },
            run_id: { type: "string", description: "set_vars/pause/resume/cancel/recover: the run; default the live run." },
        },
        required: ["workflow_id", "operation", "operation_id"],
    },
} as const;

export const READ_WORKFLOW_TOOL_SPEC = {
    description:
        "Read a workflow child you created with spawn_workflow (v2): definition state, current revision and diagnostics, "
        + "the graph, runs, and the node executions of one run (default: the live run), with the run's open KV (kv, kvRevision) "
        + "and, while it is paused, pausedFrom and pauseSettled (true once no state it admitted is still running), the run's inbox of typed input "
        + "(send_workflow_input: each message, its sender and the receive state that took it), and its outbox (each message a send state sent: "
        + "its recipient (an agent session or a workflow), state pending, delivered or failed, and attempts; delivered means the recipient "
        + "accepted it (a session's queue, or a workflow's inbox), not that it was read). Returns JSON. Reading changes nothing: "
        + "an active run whose controller can no longer end it shows run.controller.needsRecovery; use update_workflow operation recover.",
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

/**
 * The operations update_workflow takes only on a host that starts runs at
 * controller 1.9.0 (WorkflowV2Host.requests; INACTIVE: only a turn of a worker
 * that runs it, which only tests register).
 */
export const UPDATE_WORKFLOW_MILESTONE_OPERATIONS = ["stop", "test", "test_respond", "test_advance"] as const;

/**
 * update_workflow as such a turn shows it (R26, T125): the production
 * description and parameters, which stay byte for byte as they are for every
 * other turn, with the milestone operations and their arguments added.
 */
export const UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC = {
    description: UPDATE_WORKFLOW_TOOL_SPEC.description
        + " This host also takes: stop (run_id optional, reason, grace_seconds 0 to 3600, default 60: the run admits no new state, "
        + "the work it admitted may settle until the grace ends, then it ends stopped); "
        + "test (expected_revision and definition_hash of the exact current revision, inputs, optional vars, agent_mode mocked, fixtures and "
        + "scenario: a test run beside the live run whose tool calls, agents, sends and requests are intercepted and answered by you or a "
        + "fixture, and whose deadlines run on a virtual clock; a script's own effects are real, and a test result is not a live result); "
        + "test_respond (run_id of the test run, interception_id, response { kind: success, error or cancel, value }: answers one "
        + "intercepted effect once); and test_advance (run_id of the test run, seconds 1 to 2592000: moves its virtual clock and decides "
        + "what became due).",
    parameters: {
        type: "object",
        properties: {
            ...UPDATE_WORKFLOW_TOOL_SPEC.parameters.properties,
            operation: { type: "string", enum: [...UPDATE_WORKFLOW_TOOL_SPEC.parameters.properties.operation.enum, ...UPDATE_WORKFLOW_MILESTONE_OPERATIONS] },
            expected_revision: { type: "integer", description: "replace_definition/publish/test: the draft revision you reviewed." },
            definition_hash: { type: "string", description: "publish/start/test: the yamlSha256 of the reviewed revision." },
            inputs: { type: "object", description: "publish_and_start/start/test: static run inputs checked against inputs.schema." },
            vars: { type: "object", description: "publish_and_start/start/test: the run's initial open KV map (any keys, JSON values)." },
            reason: { type: "string", description: "pause/resume/cancel/stop: an optional short reason." },
            run_id: { type: "string", description: "set_vars/pause/resume/cancel/recover/stop: the run, default the live run; test_respond/test_advance: the test run (required)." },
            grace_seconds: { type: "integer", description: "stop: how long admitted work may settle, 0 to 3600. Default 60." },
            agent_mode: { type: "string", enum: ["mocked", "real"], description: "test: mocked (default): you supply each agent state's typed result. real is not available." },
            fixtures: {
                type: "array", items: { type: "object" },
                description: "test: answers given in advance, each { operation?: tool.call (default), agent, send or request, tool (tool calls) or state "
                    + "(the others), arguments (the exact call arguments, or the state's exact input), response { kind, value } }.",
            },
            scenario: { type: "string", description: "test: an optional scenario name kept with the test run, at most 128 characters." },
            interception_id: { type: "string", description: "test_respond: the intercepted effect, from read_workflow or the notice you received." },
            response: { type: "object", description: "test_respond: { kind: success, error or cancel, value }; read_workflow shows the schema an answer must match." },
            seconds: { type: "integer", description: "test_advance: whole seconds to move the virtual clock, 1 to 2592000." },
        },
        required: ["workflow_id", "operation", "operation_id"],
    },
} as const;

/** read_workflow as a turn of a worker that runs controller 1.9.0 shows it (R26): the run's milestone fields are named too. */
export const READ_WORKFLOW_MILESTONE_TOOL_SPEC = {
    description: READ_WORKFLOW_TOOL_SPEC.description
        + " On this host a run also shows its stop (requestedAt, deadline, graceSeconds, reason and, while it runs, settled), each agent "
        + "state's child session (agent.childSessionId, the chat to open) and its lifecycle, each parallel branch's states (scopeId, branch) and "
        + "a parallel state's number of branches, and for a test run (give its run_id) run.test: the notice, the tested revision and whether "
        + "it is stale, the virtual clock, every interception with its arguments, the schema its answer must match and its answer, and the "
        + "coverage. definition.publishedAgentPins shows the agent versions a publication pinned.",
    parameters: READ_WORKFLOW_TOOL_SPEC.parameters,
} as const;

export const SEND_WORKFLOW_INPUT_TOOL_SPEC = {
    description:
        "Give a run of a version 2 workflow one typed input for its messaging receive states. "
        + "contract names one of the workflow's contracts that a receive state takes (such as BuildEvent@1); payload must satisfy its schema. "
        + "correlation (optional JSON object) must equal the receive's correlate values; run_id defaults to the live run. "
        + "The input is accepted durably once per operation_id; a repeat returns the same receipt, unchanged, and another request with the id is refused. "
        + "A receive that waits for it takes it now; otherwise it is kept, in order, until a receive takes it or ttl_seconds pass (default and most 86400). "
        + "A receive that elapsed first does not discard it. Acceptance is not processing: read_workflow shows what the run did. "
        + "You may send to the workflows you created, and to workflows that your own user owns when your session is owned by that user too; "
        + "the workflow's receive may also require a specific sender. "
        + "Returns the acceptance receipt as JSON: messageId, requestSha256 and payloadSha256 (the request and payload it accepted), "
        + "acceptedAt and expiresAt (the store's times, ISO 8601 with microseconds) and claimedBy (the receive state that took it when it was accepted, or null). "
        + "What happened to the input after that is shown by read_workflow, not by the receipt.",
    parameters: {
        type: "object",
        properties: {
            workflow_id: { type: "string", description: "The workflow session id." },
            contract: { type: "string", description: "The contract name, Name@version, that a receive state of the workflow takes." },
            payload: { description: "The JSON value; it must satisfy the contract's schema." },
            correlation: { type: "object", description: "Optional correlation values; they must equal the receive's correlate values. Default {}." },
            run_id: { type: "string", description: "Optional run id; default the live run." },
            ttl_seconds: { type: "integer", description: "How long the input stays eligible while unclaimed, 1 to 86400. Default 86400." },
            operation_id: { type: "string", description: "Idempotency id for this input from you." },
        },
        required: ["workflow_id", "contract", "payload", "operation_id"],
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

/** A JSON argument of typed input; anything that is not plain JSON is INPUT_INVALID. */
function inputJsonArg(value: unknown, name: string): JsonValue {
    try {
        assertJsonValue(value, name);
        return value;
    } catch (error) {
        if (error instanceof WorkflowJsonError) throw new WorkflowStoreError("INPUT_INVALID", error.message);
        throw error;
    }
}

function inputsArg(args: Record<string, unknown>): JsonValue {
    const value = args.inputs === undefined ? {} : args.inputs;
    if (!isJsonObject(value)) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "inputs must be a JSON object.");
    assertJsonValue(value, "inputs");
    return value;
}

/** An optional JSON object of open KV entries (vars, set). */
function kvObjectArg(args: Record<string, unknown>, name: string): { [key: string]: JsonValue } | null {
    const value = args[name];
    if (value === undefined || value === null) return null;
    if (!isJsonObject(value)) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `${name} must be a JSON object.`);
    assertJsonValue(value, name);
    return value;
}

function kvRevisionArg(args: Record<string, unknown>): number {
    const value = args.expected_kv_revision;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "expected_kv_revision must be a positive integer (the run's kvRevision from read_workflow).");
    }
    return value;
}

function deleteKeysArg(args: Record<string, unknown>): string[] {
    const value = args.delete;
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some(key => typeof key !== "string")) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "delete must be a list of keys.");
    }
    return value.map(String);
}

/** Parse update_workflow arguments into a typed command. */
export function parseUpdateWorkflowArgs(args: Record<string, unknown>, options: { milestone?: boolean } = {})
    : { workflowSessionId: string; operationId: string; command: WorkflowV2Command } {
    const workflowSessionId = requiredString(args, "workflow_id");
    const operationId = requiredString(args, "operation_id");
    const operation = args.operation;
    let command: WorkflowV2Command;
    const vars = kvObjectArg(args, "vars");
    if (vars !== null && operation !== "publish_and_start" && operation !== "start") {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "vars applies to publish_and_start and start only; use set_vars on a run.");
    }
    if (operation === "replace_definition") command = { operation, yaml: requiredString(args, "yaml"), expectedRevision: revisionArg(args) };
    else if (operation === "publish") command = { operation, expectedRevision: revisionArg(args), definitionHash: requiredString(args, "definition_hash") };
    else if (operation === "publish_and_start") {
        command = { operation, expectedRevision: revisionArg(args), definitionHash: requiredString(args, "definition_hash"), inputs: inputsArg(args),
            ...(vars !== null ? { vars } : {}) };
    } else if (operation === "start") {
        command = { operation, definitionHash: requiredString(args, "definition_hash"), inputs: inputsArg(args), ...(vars !== null ? { vars } : {}) };
    } else {
        // A host that takes the milestone operations names them too, as its tool description does.
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", options.milestone === true
            ? "operation must be replace_definition, publish, publish_and_start, start, set_vars, pause, resume, cancel, recover, stop, test, test_respond or test_advance."
            : "operation must be replace_definition, publish, publish_and_start, start, set_vars, pause, resume, cancel or recover.");
    }
    return { workflowSessionId, operationId, command };
}

const RUN_COMMANDS: ReadonlySet<string> = new Set(["set_vars", "pause", "resume", "cancel"]);

/**
 * Whether a host takes a graceful stop (operation stop): only one that
 * starts runs at controller 1.9.0 (WorkflowV2Host.requests; INACTIVE, test
 * hosts only). Elsewhere the operation is refused exactly as before.
 */
function hostStops(host: Pick<WorkflowToolHost, "requests">): boolean {
    return host.requests === true;
}

/**
 * The test operations of update_workflow (design 05; INACTIVE): test (start a
 * test run of the exact current revision), test_respond (answer an
 * intercepted effect by its interception id) and test_advance (move a test
 * run's virtual clock). Taken only by a host that starts runs at controller
 * 1.9.0 (WorkflowV2Host.requests); elsewhere they are refused exactly as
 * before. The tool's published description and operation enum are unchanged.
 */
const TEST_OPERATIONS: ReadonlySet<string> = new Set(["test", "test_respond", "test_advance"]);

function hostTests(host: Pick<WorkflowToolHost, "requests">): boolean {
    return host.requests === true;
}

async function testOperationFromTool(args: Record<string, unknown>, context: { callerSessionId: string; host: WorkflowToolHost }, actor: WorkflowActor): Promise<string> {
    const workflowSessionId = requiredString(args, "workflow_id");
    const operationId = requiredString(args, "operation_id");
    await authorizeParent(context.host, workflowSessionId, context.callerSessionId);
    if (args.operation === "test") {
        const vars = kvObjectArg(args, "vars");
        const agentMode = optionalString(args, "agent_mode") ?? "mocked";
        if (agentMode !== "mocked" && agentMode !== "real") throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "agent_mode must be mocked or real.");
        const scenario = optionalString(args, "scenario");
        if (scenario !== null && (scenario.length > 128 || !isStorableText(scenario))) {
            throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "scenario must be a name of at most 128 characters.");
        }
        const stored = await startWorkflowV2Test(context.host, workflowSessionId, {
            expectedRevision: revisionArg(args), definitionHash: requiredString(args, "definition_hash"), inputs: inputsArg(args),
            ...(vars !== null ? { vars } : {}), agentMode, fixtures: parseTestFixtures(args.fixtures), scenario,
        }, { actor, operationId });
        return payload({ ok: true, ...receiptJson(stored.receipt, stored.replayed), test: { agentMode, scenario, notice: WORKFLOW_V2_TEST_NOTICE } });
    }
    const runId = requiredString(args, "run_id");
    if (args.operation === "test_advance") {
        const seconds = args.seconds;
        if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > WORKFLOW_V2_TEST_ADVANCE_MAX_SECONDS) {
            throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `seconds must be an integer from 1 to ${WORKFLOW_V2_TEST_ADVANCE_MAX_SECONDS}.`);
        }
        const stored = await advanceWorkflowV2Test(context.host, workflowSessionId, { runId, seconds }, { actor, operationId });
        const receipt = stored.receipt;
        return payload({
            ok: true, workflowId: workflowSessionId, operation: "test_advance", replayed: stored.replayed, runId: receipt.runId, seconds: receipt.seconds,
            from: receipt.from, virtualNow: receipt.virtualNow, decided: receipt.decided,
        });
    }
    const interceptionId = requiredString(args, "interception_id");
    const answered = await respondWorkflowV2Test(context.host, workflowSessionId, { runId, interceptionId, response: parseTestResponse(args.response) },
        { actor, operationId });
    return payload({
        ok: true, workflowId: workflowSessionId, operation: "test_respond", replayed: answered.replayed, runId, interceptionId,
        interception: { operation: answered.interception.operation, state: answered.interception.state },
        node: { nodeExecutionId: answered.node.nodeExecutionId, stateId: answered.node.nodeId, state: answered.node.state, outcome: answered.node.outcome },
    });
}

function graceSecondsArg(args: Record<string, unknown>): number | null {
    const value = args.grace_seconds;
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > WORKFLOW_V2_STOP_MAX_GRACE_SECONDS) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", `grace_seconds must be an integer from 0 to ${WORKFLOW_V2_STOP_MAX_GRACE_SECONDS}.`);
    }
    return value;
}

/**
 * Parse the update_workflow arguments of a run command. `stop` (a graceful
 * stop: optional reason and grace_seconds) only when `options.stop` (hostStops).
 */
export function parseRunCommandArgs(args: Record<string, unknown>, options: { stop?: boolean } = {}): { workflowSessionId: string; operationId: string; command: WorkflowV2RunCommand } {
    const workflowSessionId = requiredString(args, "workflow_id");
    const operationId = requiredString(args, "operation_id");
    const runId = optionalString(args, "run_id");
    const operation = args.operation;
    if (operation === "set_vars") {
        const set: { [key: string]: JsonValue } = kvObjectArg(args, "set") ?? {};
        const keys = deleteKeysArg(args);
        if (Object.keys(set).length === 0 && keys.length === 0) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "set_vars needs set or delete.");
        return { workflowSessionId, operationId, command: { operation, runId, set, delete: keys, expectedKvRevision: kvRevisionArg(args) } };
    }
    if (operation === "pause" || operation === "resume" || operation === "cancel" || (operation === "stop" && options.stop === true)) {
        const reason = optionalString(args, "reason");
        if (reason !== null && reason.length > 500) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "reason must be at most 500 characters.");
        if (operation === "stop") return { workflowSessionId, operationId, command: { operation, runId, reason, graceSeconds: graceSecondsArg(args) } };
        return { workflowSessionId, operationId, command: { operation, runId, reason } };
    }
    throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "operation must be set_vars, pause, resume or cancel.");
}

function runCommandJson(receipt: WorkflowRunCommandReceipt, replayed: boolean): { [key: string]: JsonValue } {
    return { workflowId: receipt.workflowSessionId, operation: receipt.operation, replayed, runId: receipt.runId,
        status: receipt.status, kvRevision: receipt.kvRevision };
}

/** update_workflow operation recover: act on a run that read_workflow shows as needing recovery. */
async function recoverWorkflowFromTool(args: Record<string, unknown>, context: { callerSessionId: string; host: WorkflowToolHost }): Promise<string> {
    const workflowSessionId = requiredString(args, "workflow_id");
    const operationId = requiredString(args, "operation_id");
    await authorizeParent(context.host, workflowSessionId, context.callerSessionId);
    const runs = await context.host.store.listRuns(workflowSessionId);
    const requested = optionalString(args, "run_id");
    const run = requested ? runs.find(item => item.runId === requested) : runs.find(item => item.mode === "live");
    if (!run) throw new WorkflowStoreError("RUN_NOT_FOUND", requested ? `Run ${requested} is not a run of this workflow.` : "This workflow has no live run.");
    const recovered = await recoverWorkflowV2Run(context.host, run.runId, { requestedBy: context.callerSessionId, operationId });
    const receipt = recovered.receipt;
    return payload({
        ok: true, workflowId: workflowSessionId, operation: "recover", replayed: recovered.replayed,
        runId: receipt.runId, action: receipt.action, status: receipt.status,
        controller: { status: receipt.controller.status, error: receipt.controller.error, needsRecovery: receipt.controller.needsRecovery },
    });
}

export async function updateWorkflowFromTool(args: Record<string, unknown>, context: { callerSessionId: string; host: WorkflowToolHost }): Promise<string> {
    try {
        if (args.operation === "recover") return await recoverWorkflowFromTool(args, context);
        const actor: WorkflowActor = { kind: "agent", sessionId: context.callerSessionId };
        if (typeof args.operation === "string" && TEST_OPERATIONS.has(args.operation) && hostTests(context.host)) {
            return await testOperationFromTool(args, context, actor);
        }
        const stop = hostStops(context.host);
        if (typeof args.operation === "string" && (RUN_COMMANDS.has(args.operation) || (stop && args.operation === "stop"))) {
            const { workflowSessionId, operationId, command } = parseRunCommandArgs(args, { stop });
            await authorizeParent(context.host, workflowSessionId, context.callerSessionId);
            const stored = await controlWorkflowV2Run(context.host, workflowSessionId, command, { actor, operationId });
            return payload({ ok: true, ...runCommandJson(stored.receipt, stored.replayed) });
        }
        const { workflowSessionId, operationId, command } = parseUpdateWorkflowArgs(args, { milestone: hostTests(context.host) });
        await authorizeParent(context.host, workflowSessionId, context.callerSessionId);
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
    // Reading shows any stored graph, request and agent states (IR 7 and 8, INACTIVE) included; it runs nothing.
    const ir = graphRow?.valid && graphRow.irSha256
        ? await store.readRevisionIr(workflowSessionId, graphRow.revision, graphRow.irSha256, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION }) : null;
    const runs = await store.listRuns(workflowSessionId);
    const selected = options.runId ? runs.find(run => run.runId === options.runId) : runs.find(run => run.mode === "live");
    if (options.runId && !selected) throw new WorkflowStoreError("RUN_NOT_FOUND", `Run ${options.runId} is not a run of this workflow.`);
    const nodes = selected ? await store.listNodeExecutions(selected.runId, 200) : [];
    // An agent state's child session and its lifecycle (IR 8, INACTIVE): read only for a run that has one.
    const agents = selected && nodes.some(node => node.nodeType === "agent")
        ? new Map((await store.listAgentInvocations(selected.runId)).map(invocation => [invocation.nodeExecutionId, invocation] as const))
        : new Map<string, WorkflowAgentInvocation>();
    const inbox = selected ? await store.listInbox(selected.runId, 50) : [];
    const outbox = selected ? await store.listOutbox(selected.runId, 50) : [];
    // A recipient's later intake refusal of a delivered message (design 5.6), shown beside the delivery, which it never rewrites;
    // looked up for exactly the bounded page of messages shown.
    const intakeOutcomes: Map<string, { intakeOutcome: string; intakeOutcomeAt: string }> = selected && outbox.length > 0
        ? await store.listOutboxIntakeOutcomes(selected.runId, outbox.map(message => message.exchangeId)) : new Map();
    // A paused run has settled once no state it admitted is still running; so has a stopping run (migration 0096).
    const pauseSettled = selected?.status === "paused" ? !await store.hasPendingNodes(selected.runId) : null;
    const stopping = selected?.stop && ACTIVE_RUN_STATUSES.includes(selected.status) ? selected.stop : null;
    const stopSettled = stopping !== null ? !await store.hasPendingNodes(selected!.runId) : null;
    // A test run (migration 0098, INACTIVE): its notice, virtual clock, interceptions and coverage.
    const test = selected?.mode === "test" ? await testViewOf(store, workflowSessionId, selected, definition.currentRevision, nodes) : null;
    return {
        workflowId: workflowSessionId,
        definition: {
            state: definition.state, semver: definition.semver, currentRevision: definition.currentRevision,
            publishedRevision: definition.publishedRevision, publishedDefinitionHash: definition.publishedYamlSha256,
            // What publication pinned each named agent state to (migration 0099; R18, R28); only a definition with any shows it.
            ...(definition.publishedAgentPins !== null ? { publishedAgentPins: definition.publishedAgentPins } : {}),
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
            ...(selected.pausedFrom !== null ? { pausedFrom: selected.pausedFrom, pauseSettled } : {}),
            // A graceful stop (controller 1.9.0; only such a run has one): when it was accepted, its deadline, and while the run is
            // still active, whether its admitted work has settled.
            ...(selected.stop !== null ? { stop: {
                requestedAt: selected.stop.requestedAt.toISOString(), deadline: selected.stop.deadlineAt.toISOString(),
                graceSeconds: selected.stop.graceSeconds, reason: selected.stop.reason,
                ...(stopping !== null ? { settled: stopSettled } : {}),
            } } : {}),
            ...(test !== null ? { test } : {}),
            // A run deadline (migration 0100; limits.timeoutSeconds, controller 1.9.0): only a run with one shows it (a test
            // run's is on its virtual clock).
            ...(selected.deadlineAt ? { deadline: selected.deadlineAt.toISOString() } : {}),
            terminalState: selected.terminalNodeId,
            output: selected.terminalOutput === null ? null : previewJson(selected.terminalOutput, 2_000),
            error: selected.terminalError === null ? null : previewJson(selected.terminalError, 2_000),
            kvRevision: selected.kvRevision,
            kv: previewJson(selected.kv, 4_000),
            nodeExecutions: nodes.map(node => ({
                nodeExecutionId: node.nodeExecutionId, stateId: node.nodeId, ordinal: node.ordinal, state: node.state,
                outcome: node.outcome, resultKind: node.resultKind, winner: node.winner, attempts: node.effectAttempts, kvRevision: node.kvRevision,
                // A parallel branch's state (IR 8, INACTIVE): its branch's parallel state execution and index.
                ...(node.scopeId !== ROOT_SCOPE ? { scopeId: node.scopeId, ...branchViewOf(node.scopeId) } : {}),
                ...(node.nodeType === "parallel" && Array.isArray(node.input) ? { branches: node.input.length } : {}),
                ...(node.deadlineAt !== null ? { deadline: node.deadlineAt.toISOString() } : {}),
                ...(node.receive !== null ? { receive: { contract: node.receive.contract, from: node.receive.from, correlation: node.receive.correlation } } : {}),
                ...(agents.has(node.nodeExecutionId) ? { agent: agentViewOf(agents.get(node.nodeExecutionId)!) } : {}),
                ...(node.resultKind === "business" ? { outputPreview: previewJson(node.output, 500) } : {}),
                ...(node.resultKind === "runtime_error" ? { errorPreview: previewJson(node.error, 500) } : {}),
            })),
            inbox: inbox.map(message => ({
                messageId: message.messageId, contract: message.contract, senderSessionId: message.senderSessionId,
                correlation: message.correlation, acceptedAt: message.acceptedAt, expiresAt: message.expiresAt,
                claimedBy: message.consumedBy, claimedAt: message.consumedAt, payloadPreview: previewJson(message.payload, 300),
            })),
            outbox: outbox.map(message => ({
                exchangeId: message.exchangeId, nodeExecutionId: message.nodeExecutionId, recipientSessionId: message.recipientSessionId,
                recipientKind: message.recipientKind, contract: message.contract, state: message.state, attempts: message.attempts,
                createdAt: message.createdAt, deliveredAt: message.receipt?.deliveredAt ?? null, payloadPreview: previewJson(message.payload, 300),
                ...(message.receipt?.input ? { inputMessageId: message.receipt.input.messageId, claimedBy: message.receipt.input.claimedBy?.nodeExecutionId ?? null } : {}),
                ...(message.error !== null ? { errorPreview: previewJson(message.error, 500) } : {}),
                ...(intakeOutcomes.has(message.exchangeId) ? { ...intakeOutcomes.get(message.exchangeId) } : {}),
            })),
        } : null,
    };
}

/**
 * A test run as read_workflow shows it (design 05; R28): the permanent notice
 * (scripts run normally; framework tools are mocked), its agent mode, the
 * revision it tested and whether a newer one makes its result stale, its
 * virtual clock, each intercepted effect with its arguments, the schema an
 * answer must match and its answer (kind, disposition, value), and its
 * coverage: the states it entered and did not, the routes it took, and the
 * effects still waiting for an answer. Bounded; reading changes nothing.
 */
async function testViewOf(store: WorkflowStore, workflowSessionId: string, run: WorkflowRunRow, currentRevision: number,
    nodes: WorkflowNodeExecutionRow[]): Promise<{ [key: string]: JsonValue }> {
    const interceptions = await store.listInterceptions(run.runId, 200);
    const ir = await store.readRevisionIr(workflowSessionId, run.revision, run.irSha256, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
    const byId = new Map(nodes.map(node => [node.nodeExecutionId, node] as const));
    const visited = new Set(nodes.map(node => node.nodeId));
    const edges = new Map<string, { from: string; route: string; to: string; count: number }>();
    const outcomes = new Map<string, Set<string>>();
    for (const node of nodes) {
        if (node.outcome !== null) outcomes.set(node.nodeId, (outcomes.get(node.nodeId) ?? new Set<string>()).add(node.outcome));
        const from = node.predecessorId === null ? undefined : byId.get(node.predecessorId);
        if (from === undefined || node.arrivalRoute === null) continue;
        const key = canonicalKey(from.nodeId, node.arrivalRoute, node.nodeId);
        const edge = edges.get(key) ?? { from: from.nodeId, route: node.arrivalRoute, to: node.nodeId, count: 0 };
        edge.count += 1;
        edges.set(key, edge);
    }
    const virtualSeconds = run.virtualNow === null ? null : Math.round((run.virtualNow.getTime() - Date.parse(WORKFLOW_V2_TEST_EPOCH)) / 1000);
    return {
        notice: WORKFLOW_V2_TEST_NOTICE,
        agentMode: run.testAgentMode,
        scenario: run.testScenario,
        testedRevision: run.revision,
        stale: run.revision !== currentRevision,
        virtualClock: run.virtualNow === null ? null : { now: run.virtualNow.toISOString(), elapsedSeconds: virtualSeconds },
        interceptions: interceptions.map(item => interceptionViewOf(item, byId.get(item.nodeExecutionId))),
        coverage: {
            complete: nodes.length < 200,
            entered: [...visited].sort(),
            notEntered: Object.keys(ir.nodes).filter(id => !visited.has(id)).sort(),
            routes: [...edges.values()].sort((a, b) => canonicalKey(a.from, a.route, a.to).localeCompare(canonicalKey(b.from, b.route, b.to))),
            outcomes: Object.fromEntries([...outcomes.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, seen]) => [id, [...seen].sort()])),
            unanswered: interceptions.filter(item => item.state === "awaiting_parent").map(item => item.interceptionId),
        },
    };
}

function canonicalKey(...parts: string[]): string {
    return JSON.stringify(parts);
}

/** One intercepted effect of a test run, as read_workflow shows it. */
function interceptionViewOf(item: WorkflowTestInterception, node: WorkflowNodeExecutionRow | undefined): { [key: string]: JsonValue } {
    return {
        interceptionId: item.interceptionId, operation: item.operation, tool: item.tool, nodeExecutionId: item.nodeExecutionId,
        stateId: node?.nodeId ?? null, state: item.state, arguments: previewJson(item.arguments, 1_000), argumentsSha256: item.argumentsSha256,
        responseSchema: item.responseSchema, virtualAt: item.virtualAt.toISOString(),
        response: item.response === null ? null : {
            kind: item.response.kind, disposition: item.response.disposition, value: previewJson(item.response.value, 1_000),
            sha256: item.response.sha256, respondedAt: item.response.respondedAt.toISOString(),
        },
    };
}

/** A parallel branch's state, as read_workflow shows it: the parallel state execution its branch belongs to, and its index. */
function branchViewOf(scopeId: string): { [key: string]: JsonValue } {
    const scope = parseBranchScope(scopeId);
    return scope === null ? {} : { branch: { parallelNodeExecutionId: scope.parallelNodeExecutionId, index: scope.index } };
}

/** An agent state's child, as read_workflow shows it: the session to open for its chat, and where its lifecycle is. */
function agentViewOf(invocation: WorkflowAgentInvocation): { [key: string]: JsonValue } {
    return {
        childSessionId: invocation.childSessionId,
        task: invocation.task.source === "prompt" ? { source: "prompt" }
            : { source: "agent", name: invocation.task.name, package: invocation.task.package, version: invocation.task.version,
                // The exact package revision the child runs (R18), when the publication pinned one.
                ...(invocation.task.packageId && invocation.task.revision ? { packageId: invocation.task.packageId, revision: invocation.task.revision } : {}) },
        controllingSessionId: invocation.controllingSessionId,
        spawned: invocation.spawnedAt !== null,
        spawnAttempts: invocation.spawnAttempts,
        end: invocation.endRequested,
        endSent: invocation.endSentAt !== null,
        ...(invocation.endChildStatus !== null ? { endChildStatus: invocation.endChildStatus } : {}),
    };
}

export async function readWorkflowFromTool(args: Record<string, unknown>, context: { callerSessionId: string; host: WorkflowToolHost }): Promise<string> {
    try {
        const workflowSessionId = requiredString(args, "workflow_id");
        await authorizeParent(context.host, workflowSessionId, context.callerSessionId);
        const view = await readWorkflowV2View(context.host.store, workflowSessionId, {
            runId: optionalString(args, "run_id"), includeYaml: args.include_yaml === true,
        });
        // Report (never change) whether an active run's controller can still end it.
        const shown = isJsonObject(view.run) && typeof view.run.runId === "string" ? await context.host.store.readRun(view.run.runId) : null;
        if (shown && isJsonObject(view.run) && ACTIVE_RUN_STATUSES.includes(shown.status)) {
            const controller = await inspectWorkflowV2Controller(context.host, shown);
            view.run = { ...view.run, controller: { status: controller.status, error: controller.error, needsRecovery: controller.needsRecovery } };
        }
        return payload({ ok: true, ...view });
    } catch (error) {
        return errorPayload(error);
    }
}

/**
 * send_workflow_input: the calling session (from the host) gives a run typed
 * input. Unlike update_workflow it is not limited to the parent: the
 * service also allows a live session owned by the same user as the
 * workflow (authority.ts); unknown or system ownership allows nothing.
 */
export async function sendWorkflowInputFromTool(args: Record<string, unknown>, context: { callerSessionId: string; host: WorkflowToolHost }): Promise<string> {
    try {
        const workflowSessionId = requiredString(args, "workflow_id");
        const contract = requiredString(args, "contract");
        const operationId = requiredString(args, "operation_id");
        if (!Object.hasOwn(args, "payload")) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "payload is required.");
        const payloadValue = inputJsonArg(args.payload, "payload");
        const correlation = args.correlation === undefined || args.correlation === null ? undefined : inputJsonArg(args.correlation, "correlation");
        const ttl = args.ttl_seconds;
        if (ttl !== undefined && ttl !== null && typeof ttl !== "number") throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "ttl_seconds must be an integer.");
        const sent = await sendWorkflowInputV2(context.host, {
            workflowSessionId, senderSessionId: context.callerSessionId, runId: optionalString(args, "run_id"), contract,
            correlation, payload: payloadValue, ttlSeconds: typeof ttl === "number" ? ttl : null, operationId,
        });
        const receipt = sent.receipt;
        return payload({
            ok: true, replayed: sent.replayed, workflowId: receipt.workflowSessionId, runId: receipt.runId, messageId: receipt.messageId,
            senderSessionId: receipt.senderSessionId, operationId: receipt.operationId, contract: receipt.contract,
            requestSha256: receipt.requestSha256, payloadSha256: receipt.payloadSha256, acceptedAt: receipt.acceptedAt, expiresAt: receipt.expiresAt,
            claimedBy: receipt.claimedBy ? { nodeExecutionId: receipt.claimedBy.nodeExecutionId, stateId: receipt.claimedBy.stateId } : null,
        });
    } catch (error) {
        return errorPayload(error);
    }
}

/** spawn_workflow for a v2 document: a draft by default, or published (and started) when asked. */
export async function spawnWorkflowV2FromTool(
    args: { yaml: string; inputs?: Record<string, unknown>; vars?: Record<string, unknown>; notify_on_completion?: boolean; key?: string; state?: string; start?: boolean },
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
        const vars = kvObjectArg({ vars: args.vars }, "vars");
        if (vars !== null && args.start !== true) throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "vars needs start: true (they are the run's initial KV).");
        const stored = await createWorkflowV2(context.host, {
            workflowSessionId: context.workflowSessionId, parentSessionId: context.callerSessionId, owner: context.owner,
            yaml: args.yaml, actor: { kind: "agent", sessionId: context.callerSessionId }, operationId: context.operationId,
            publish, start: args.start === true ? { inputs, ...(vars !== null ? { vars } : {}) } : null, notifyParent: args.notify_on_completion !== false,
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
