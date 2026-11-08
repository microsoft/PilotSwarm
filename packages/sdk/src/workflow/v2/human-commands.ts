import { WORKFLOW_V2_API_VERSION } from "./compiler.js";
import { sessionInsideWorkflow, WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT, WORKFLOW_DEFINITION_TOOLS_REFUSED, workflowHumanInputError } from "./input-policy.js";
import { jsonbSafeText, type JsonValue } from "./json.js";
import { WORKFLOW_V2_CONTROLLER_VERSION, WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, WORKFLOW_V2_STOP_CONTROLLER_VERSIONS } from "./runtime.js";
import type { WorkflowV2Host } from "./service.js";
import { WorkflowStoreError, type WorkflowActor, type WorkflowStore } from "./store.js";
import { UPDATE_WORKFLOW_OPERATIONS, operationWords, runUpdateWorkflowCommand, workflowTestModeAbsentError } from "./tools.js";
import { resolveWorkflowTestMode, WORKFLOW_TEST_MODE_OPERATIONS } from "./test-mode-switch.js";

/**
 * Workflow v2: a person's command to a workflow session (design 04 REST/SDK/MCP
 * mapping: `updateWorkflow`, POST /sessions/{id}/workflow/commands; R26, D11;
 * INACTIVE: only a management client created with the test-only option
 * `workflowCommands` takes one).
 *
 * The command is the update_workflow tool's command (same operations, same
 * arguments, same receipts), run by the same implementation
 * (runUpdateWorkflowCommand) after a person's checks instead of the agent
 * tool's parent check:
 * - The caller's access to the workflow session is decided before this runs
 *   (the portal's session gate; a direct management client is trusted). Its
 *   actor is the caller's principal as the host stamps it: a user, or the
 *   host itself (system); a command never names its actor, and an agent's
 *   actor is refused here (an agent uses its tool).
 * - The command targets the session it is sent to: a workflow_id, when given,
 *   must be that session. It must be a version 2 workflow that exists and is
 *   not deleted (WORKFLOW_NOT_FOUND).
 * - recover stays an agent's (and an operator's) path: it is refused here.
 * - Human input to a workflow agent state's subtree (design 03; R13, R14): a
 *   workflow session in such a subtree takes only a person's brakes (pause,
 *   stop, cancel); anything else that changes or drives it is refused with
 *   403 WORKFLOW_HUMAN_INPUT_DENIED, naming its controlling agent. Every other
 *   workflow takes every command the host takes.
 * - The milestone operations (stop, test, test_respond, test_advance) are
 *   taken only by a host that runs controller 1.9.0, as for the tool; the
 *   test operations only while workflow test mode is on (spec 16): while it
 *   is off, a test operation answers as an operation that does not exist.
 */

/** A person's brakes: the lifecycle controls a workflow in an agent state's subtree still takes (design 03). */
export const WORKFLOW_HUMAN_BRAKE_OPERATIONS: readonly string[] = ["pause", "stop", "cancel"];

/** A person's operations on every host: the update_workflow tool's, without recover (the agent's path). */
export const WORKFLOW_HUMAN_OPERATIONS: readonly string[] = [...UPDATE_WORKFLOW_OPERATIONS.definition, ...UPDATE_WORKFLOW_OPERATIONS.run];

/** A person's further operations on a host that runs controller 1.9.0 (WorkflowV2Host.requests): stop and the test operations. */
export const WORKFLOW_HUMAN_MILESTONE_OPERATIONS: readonly string[] = [...UPDATE_WORKFLOW_OPERATIONS.milestone];

/**
 * A person's further operations on a 1.9.0 host as workflow test mode decides them (spec 16; test-mode-switch.ts):
 * stop, and the test operations only while it is on.
 */
export function workflowHumanMilestoneOperations(testMode: boolean): string[] {
    return WORKFLOW_HUMAN_MILESTONE_OPERATIONS.filter(operation => testMode || !WORKFLOW_TEST_MODE_OPERATIONS.includes(operation));
}

/** The shape version of workflowCapabilities' answer; a client that does not know a version ignores the field. */
export const WORKFLOW_CAPABILITIES_SCHEMA = 1;

/**
 * Workflow support as a server advertises it in its bootstrap (design 04
 * "Advertise capability/version in bootstrap"; D11), so a client gates its
 * workflow surface before a call is refused. It reports what the host was
 * configured with and changes nothing: no controller or orchestration version
 * is served or activated by it, and the server decides every read and command
 * again.
 * - enabled (stage 2.0): whether Workflows are on (PILOTSWARM_WORKFLOWS; workflow/workflows-switch.ts). False: the answer is
 *   `{ schema, enabled: false }` and nothing else, and a client shows no Workflow button, tab, pane or rows.
 * - v2.apiVersion: the workflow document version this build compiles.
 * - v2.read: readWorkflow (GET /sessions/{id}/workflow) reads version 2
 *   workflows; false where the host has no workflow store (each read is then
 *   WORKFLOW_NOT_FOUND).
 * - v2.create and v2.input: false. A person creates no version 2 workflow and
 *   sends one no typed input over this API; the workflow's parent agent does
 *   (spawn_workflow, send_workflow_input).
 * - v2.commands: a person's commands (updateWorkflow, POST
 *   /sessions/{id}/workflow/commands). Off unless the host was created with
 *   the test-only option workflowCommands (INACTIVE): then it names the
 *   refusal every command gets (501 WORKFLOW_COMMANDS_UNAVAILABLE). On: the
 *   controller version the runs they start run at, and the operations they
 *   take (a workflow in a workflow agent state's subtree takes fewer; its read
 *   model's personCommands names them).
 * - Stage 2.5 (PR 235 8055fcd8): there is no legacy create. POST
 *   /sessions/workflow (createWorkflowSession), refused for every caller since a
 *   Workflow needs a parent agent, is gone, and with it `legacyCreate`.
 * - The test operations are listed only while workflow test mode is on
 *   (`commands.testMode`, or else the deployment flag; spec 16): off, a client
 *   offers no test control and shows no test run. `v2.testMode: true` says it
 *   is on (absent when off), with or without commands (review SF-D5).
 */
export function workflowCapabilities(options: { enabled?: boolean; read: boolean; commands: { requests?: boolean; testMode?: boolean } | null | undefined }): { [key: string]: JsonValue } {
    // Stage 2.0: with Workflows off the deployment says only that (`enabled: false`); a client shows no Workflow surface.
    if (options.enabled === false) return { schema: WORKFLOW_CAPABILITIES_SCHEMA, enabled: false };
    const commands = options.commands ?? null;
    const requests = commands?.requests === true;
    return {
        schema: WORKFLOW_CAPABILITIES_SCHEMA,
        enabled: true,
        v2: {
            apiVersion: WORKFLOW_V2_API_VERSION,
            read: options.read === true,
            // Review SF-D5: the server's word that workflow test mode is on, only then, so a client shows stored test
            // notices (a parent chat's "test waiting" card) only while it is; absent: hidden.
            ...(resolveWorkflowTestMode(commands?.testMode) ? { testMode: true } : {}),
            create: false,
            input: false,
            commands: commands
                ? {
                    available: true,
                    controllerVersion: requests ? WORKFLOW_V2_REQUEST_CONTROLLER_VERSION : WORKFLOW_V2_CONTROLLER_VERSION,
                    operations: requests
                        ? [...WORKFLOW_HUMAN_OPERATIONS, ...workflowHumanMilestoneOperations(resolveWorkflowTestMode(commands.testMode))]
                        : [...WORKFLOW_HUMAN_OPERATIONS],
                }
                : { available: false, refusal: { code: "WORKFLOW_COMMANDS_UNAVAILABLE", status: 501 } },
        },
    };
}

/**
 * The commands a workflow session takes from a person (design 04; R26, R13),
 * as its read model reports them (`personCommands`; INACTIVE: the management
 * client adds it only when it takes a person's commands), so a screen offers
 * only commands the workflow would take. It decides nothing:
 * updateWorkflowForPerson decides each command again, and the caller's access
 * to the session is decided where the read model is served (the portal adds
 * the signed-in caller's own decision as `viewer`).
 * - `operations`: every operation the host takes from a person, or, for a
 *   workflow in a workflow agent state's subtree, only a person's brakes,
 *   which `restriction` then explains, naming the workflow that holds the
 *   agent state and its controlling agent.
 * - `run`: for the run the read model shows (`runId`), whether it takes a
 *   graceful stop (offered, and its run was admitted for a controller that
 *   stops runs); null when no run is shown.
 * - `draft` (only for a draft, `draftRevision`, that a person may change:
 *   replace_definition offered): the current revision's number, definition
 *   hash and YAML, the text a person edits. The human read omits the YAML
 *   (it holds the scripts and prompts the graph does not show); a server that
 *   serves the read to callers who may not command the workflow leaves it out
 *   for them (the portal does).
 */
export async function workflowCommandsForPerson(
    store: Pick<WorkflowStore, "readWorkflowLineage" | "readRun" | "readRevision"> & Partial<Pick<WorkflowStore, "readDefinition">>, workflowSessionId: string,
    options: { requests: boolean; runId: string | null; draftRevision?: number | null; published?: boolean; testMode?: boolean }): Promise<{ [key: string]: JsonValue }> {
    // The test operations only while workflow test mode is on (spec 16): off, a screen offers no test control and no test run.
    const testMode = resolveWorkflowTestMode(options.testMode);
    const offered = options.requests ? [...WORKFLOW_HUMAN_OPERATIONS, ...workflowHumanMilestoneOperations(testMode)] : [...WORKFLOW_HUMAN_OPERATIONS];
    const [lineage, run, definition] = await Promise.all([store.readWorkflowLineage(workflowSessionId), options.runId ? store.readRun(options.runId) : null,
        typeof store.readDefinition === "function" ? store.readDefinition(workflowSessionId) : null]);
    const root = lineage?.agentRoot ?? null;
    // Code check G1: a copy of a chat revision takes no stage 1 definition operation (the store refuses each, PINNED_TO_CHAT_REVISION);
    // it is changed by saving a revision of its definition and started by a chat Start.
    const pinned = typeof definition?.chatDefinitionId === "string";
    // of-06: only a draft is tested. A published workflow offers no new test; the answers and clock of a test run that
    // began while it was a draft stay offered, so that run can finish.
    const operations = (root ? WORKFLOW_HUMAN_BRAKE_OPERATIONS.filter(operation => offered.includes(operation)) : offered)
        .filter(operation => !(options.published === true && operation === "test"))
        .filter(operation => !(pinned && (UPDATE_WORKFLOW_OPERATIONS.definition as readonly string[]).includes(operation)));
    const shown = run !== null && run.workflowSessionId === workflowSessionId ? run : null;
    const draftRevision = options.draftRevision ?? null;
    const revision = draftRevision !== null && operations.includes("replace_definition") ? await store.readRevision(workflowSessionId, draftRevision) : null;
    return {
        operations,
        restriction: root ? {
            reason: `This workflow was started by an agent step of another workflow: people can ${operationWords(operations)} it; only its controlling agent ${testMode ? "changes, resumes or tests" : "changes or resumes"} it.`,
            workflowSessionId: root.workflowSessionId, controllingSessionId: root.controllingSessionId,
        } : null,
        run: shown ? { runId: shown.runId, stop: operations.includes("stop") && shown.controllerVersion !== null
            && WORKFLOW_V2_STOP_CONTROLLER_VERSIONS.includes(shown.controllerVersion) } : null,
        ...(revision ? { draft: { revision: revision.revision, definitionHash: revision.yamlSha256, yaml: jsonbSafeText(revision.yaml) } } : {}),
    };
}

const NOT_FOUND = new Set(["WORKFLOW_NOT_FOUND", "WORKFLOW_DELETED", "RUN_NOT_FOUND", "NODE_NOT_FOUND", "INTERCEPTION_NOT_FOUND", "AGENT_NODE_NOT_FOUND",
    // Stage 2.1: a chat's Workflow Definitions.
    "DEFINITION_NOT_FOUND", "REVISION_NOT_FOUND", "CHAT_NOT_FOUND",
    // Stage 2.3: a package's Workflow Definition.
    "PACKAGE_WORKFLOW_NOT_FOUND"]);
const INVALID = new Set(["WORKFLOW_COMMAND_INVALID", "WORKFLOW_YAML_INVALID", "WORKFLOW_YAML_TOO_LARGE", "INPUT_INVALID", "WORKFLOW_NAME_MISMATCH",
    // OF-S2-7: a start's agent node models that do not name agent nodes of the revision, or are not shaped as one.
    "AGENT_MODELS_INVALID"]);
const UNPROCESSABLE = new Set(["WORKFLOW_INPUT_INVALID", "DEFINITION_INVALID", "TEST_RESPONSE_INVALID", "RESPONSE_INVALID", "KV_LIMIT", "WORKFLOW_SCRIPTS_DISABLED",
    // Stage 2.3: a package definition this host cannot run, and A2.
    "PACKAGE_WORKFLOW_UNSUPPORTED", "AGENT_HAS_WORKFLOWS",
    // OF-S2-7: a model the starter cannot use.
    "AGENT_MODEL_UNAVAILABLE"]);
const LIMITED = new Set(["OPERATION_LIMIT", "TEST_INTERCEPTION_LIMIT", "INBOX_RATE_LIMITED", "WORKFLOW_REVISION_LIMIT", "REVISION_LIMIT",
    // Stage 2.4: Start keeps spawn_agent's budget of running children.
    "CHILD_LIMIT"]);

/**
 * The HTTP status of a refused workflow command: 404 for what does not exist,
 * 403 forbidden, 400 an invalid command, 422 a value its contract refuses, 429
 * a limit, 500 a corrupt store, 503 a store not available now, and 409 for a command that conflicts with the
 * workflow's current state (a revision, hash, operation id, run or answer).
 */
export function workflowCommandStatus(code: string): number {
    if (NOT_FOUND.has(code)) return 404;
    if (code === "FORBIDDEN" || code === "WORKFLOW_HUMAN_INPUT_DENIED" || code === WORKFLOW_DEFINITION_TOOLS_REFUSED || code === "PACKAGE_WORKFLOW_NOT_ALLOWED") return 403;
    if (INVALID.has(code)) return 400;
    if (UNPROCESSABLE.has(code)) return 422;
    if (LIMITED.has(code)) return 429;
    if (code === "WORKFLOW_STORE_CORRUPT") return 500;
    if (code === "WORKFLOW_STORE_UNAVAILABLE" || code === "PACKAGE_UNAVAILABLE" || code === "PACKAGE_WORKFLOWS_UNAVAILABLE") return 503;
    return 409;
}

/**
 * A1 for a person's command (review SF-2): a command that names the session it comes from (`originatingSessionId`: a
 * management client, the Web API or MCP passing it on for an agent's call) is refused a definition operation
 * (replace_definition, publish, publish_and_start, start) when that session is inside a Workflow, by its stored
 * lineage, as that session's own definition tools are (403 WORKFLOW_DEFINITION_TOOLS_REFUSED). A lineage that cannot be
 * read refuses the command (it throws). Run, brake and read commands are not definition operations. A caller that holds a
 * person's credential and names no session is that person: this cannot tell (the receipt's known limit).
 */
export async function refuseDefinitionFromInsideWorkflow(store: Pick<WorkflowStore, "readWorkflowLineage">, operation: unknown,
    originatingSessionId: unknown): Promise<void> {
    if (originatingSessionId === undefined || originatingSessionId === null) return;
    if (typeof originatingSessionId !== "string" || !originatingSessionId.trim() || originatingSessionId.length > 256) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "originatingSessionId, when given, must be a session id of 1 to 256 characters.");
    }
    if (typeof operation !== "string" || !(UPDATE_WORKFLOW_OPERATIONS.definition as readonly string[]).includes(operation)) return;
    if (await sessionInsideWorkflow(store, originatingSessionId)) {
        throw new WorkflowStoreError(WORKFLOW_DEFINITION_TOOLS_REFUSED, WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT);
    }
}

/**
 * Run a person's command on workflow session `workflowSessionId` (see the
 * module's comment). Returns the receipt's JSON, as the tool's answer without
 * its `ok`; throws the refusal (a WorkflowStoreError, or the human-input
 * denial with its 403). `originatingSessionId`: the session the command comes
 * from, when its caller names one (refuseDefinitionFromInsideWorkflow).
 */
export async function updateWorkflowForPerson(command: unknown,
    context: { host: WorkflowV2Host; workflowSessionId: string; actor: WorkflowActor; originatingSessionId?: string | null })
    : Promise<{ [key: string]: JsonValue }> {
    const { host, workflowSessionId, actor } = context;
    if (actor.kind === "agent") {
        throw new WorkflowStoreError("FORBIDDEN", "An agent changes a workflow with its update_workflow tool, not with a person's command.");
    }
    if (command === null || typeof command !== "object" || Array.isArray(command)) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "The command must be a JSON object with an operation and an operation_id.");
    }
    const args = command as Record<string, unknown>;
    if (Object.hasOwn(args, "workflow_id") && args.workflow_id !== workflowSessionId) {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "workflow_id, when given, must be the workflow session the command is sent to.");
    }
    if (args.operation === "recover") {
        throw new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", "recover is not a person's command; the workflow's parent agent recovers a run.");
    }
    await refuseDefinitionFromInsideWorkflow(host.store, args.operation, context.originatingSessionId);
    // Test mode hidden (spec 16; owner answer Q3): while it is off, a test operation answers as an operation that does
    // not exist: the same checks as any unknown operation, then the same refusal, with no word of testing.
    const absent = workflowTestModeAbsentError(args.operation, host);
    const [row, definition] = await Promise.all([host.catalog.getSession(workflowSessionId), host.store.readDefinition(workflowSessionId)]);
    if (!row || row.deletedAt || row.sessionKind !== "workflow" || !definition) {
        throw new WorkflowStoreError("WORKFLOW_NOT_FOUND", `Session ${workflowSessionId} is not a version 2 workflow.`);
    }
    if (typeof args.operation !== "string" || !WORKFLOW_HUMAN_BRAKE_OPERATIONS.includes(args.operation)) {
        const lineage = await host.store.readWorkflowLineage(workflowSessionId);
        if (lineage?.agentRoot) throw workflowHumanInputError(workflowSessionId, "workflow", lineage);
    }
    if (absent) throw absent;
    return await runUpdateWorkflowCommand({ ...args, workflow_id: workflowSessionId }, host, actor, async () => {});
}
