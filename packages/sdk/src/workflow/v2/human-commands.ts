import { WORKFLOW_V2_API_VERSION } from "./compiler.js";
import { workflowHumanInputError } from "./input-policy.js";
import { jsonbSafeText, type JsonValue } from "./json.js";
import { WORKFLOW_V2_CONTROLLER_VERSION, WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, WORKFLOW_V2_STOP_CONTROLLER_VERSIONS } from "./runtime.js";
import type { WorkflowV2Host } from "./service.js";
import { WorkflowStoreError, type WorkflowActor, type WorkflowStore } from "./store.js";
import { runUpdateWorkflowCommand } from "./tools.js";

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
 *   taken only by a host that runs controller 1.9.0, as for the tool.
 */

/** A person's brakes: the lifecycle controls a workflow in an agent state's subtree still takes (design 03). */
export const WORKFLOW_HUMAN_BRAKE_OPERATIONS: readonly string[] = ["pause", "stop", "cancel"];

/** A person's operations on every host: the update_workflow tool's, without recover (the agent's path). */
export const WORKFLOW_HUMAN_OPERATIONS: readonly string[] = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel"];

/** A person's further operations on a host that runs controller 1.9.0 (WorkflowV2Host.requests): stop and the test operations. */
export const WORKFLOW_HUMAN_MILESTONE_OPERATIONS: readonly string[] = ["stop", "test", "test_respond", "test_advance"];

/** The shape version of workflowCapabilities' answer; a client that does not know a version ignores the field. */
export const WORKFLOW_CAPABILITIES_SCHEMA = 1;

/**
 * Workflow support as a server advertises it in its bootstrap (design 04
 * "Advertise capability/version in bootstrap"; D11), so a client gates its
 * workflow surface before a call is refused. It reports what the host was
 * configured with and changes nothing: no controller or orchestration version
 * is served or activated by it, and the server decides every read and command
 * again.
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
 * - legacyCreate: createWorkflowSession (POST /sessions/workflow) keeps its
 *   version 1 semantics and never makes a version 2 draft, so an old client is
 *   not moved to draft-by-default.
 */
export function workflowCapabilities(options: { read: boolean; commands: { requests?: boolean } | null | undefined }): { [key: string]: JsonValue } {
    const commands = options.commands ?? null;
    const requests = commands?.requests === true;
    return {
        schema: WORKFLOW_CAPABILITIES_SCHEMA,
        v2: {
            apiVersion: WORKFLOW_V2_API_VERSION,
            read: options.read === true,
            create: false,
            input: false,
            commands: commands
                ? {
                    available: true,
                    controllerVersion: requests ? WORKFLOW_V2_REQUEST_CONTROLLER_VERSION : WORKFLOW_V2_CONTROLLER_VERSION,
                    operations: requests ? [...WORKFLOW_HUMAN_OPERATIONS, ...WORKFLOW_HUMAN_MILESTONE_OPERATIONS] : [...WORKFLOW_HUMAN_OPERATIONS],
                }
                : { available: false, refusal: { code: "WORKFLOW_COMMANDS_UNAVAILABLE", status: 501 } },
        },
        legacyCreate: { workflowVersion: 1, draft: false },
    };
}

/** "pause, stop or cancel". */
function operationWords(operations: readonly string[]): string {
    return operations.length < 2 ? operations.join("") : `${operations.slice(0, -1).join(", ")} or ${operations.at(-1)}`;
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
export async function workflowCommandsForPerson(store: Pick<WorkflowStore, "readWorkflowLineage" | "readRun" | "readRevision">, workflowSessionId: string,
    options: { requests: boolean; runId: string | null; draftRevision?: number | null }): Promise<{ [key: string]: JsonValue }> {
    const offered = options.requests ? [...WORKFLOW_HUMAN_OPERATIONS, ...WORKFLOW_HUMAN_MILESTONE_OPERATIONS] : [...WORKFLOW_HUMAN_OPERATIONS];
    const [lineage, run] = await Promise.all([store.readWorkflowLineage(workflowSessionId), options.runId ? store.readRun(options.runId) : null]);
    const root = lineage?.agentRoot ?? null;
    const operations = root ? WORKFLOW_HUMAN_BRAKE_OPERATIONS.filter(operation => offered.includes(operation)) : offered;
    const shown = run !== null && run.workflowSessionId === workflowSessionId ? run : null;
    const draftRevision = options.draftRevision ?? null;
    const revision = draftRevision !== null && operations.includes("replace_definition") ? await store.readRevision(workflowSessionId, draftRevision) : null;
    return {
        operations,
        restriction: root ? {
            reason: `This workflow was started by an agent step of another workflow: people can ${operationWords(operations)} it; only its controlling agent changes, resumes or tests it.`,
            workflowSessionId: root.workflowSessionId, controllingSessionId: root.controllingSessionId,
        } : null,
        run: shown ? { runId: shown.runId, stop: operations.includes("stop") && shown.controllerVersion !== null
            && WORKFLOW_V2_STOP_CONTROLLER_VERSIONS.includes(shown.controllerVersion) } : null,
        ...(revision ? { draft: { revision: revision.revision, definitionHash: revision.yamlSha256, yaml: jsonbSafeText(revision.yaml) } } : {}),
    };
}

const NOT_FOUND = new Set(["WORKFLOW_NOT_FOUND", "WORKFLOW_DELETED", "RUN_NOT_FOUND", "NODE_NOT_FOUND", "INTERCEPTION_NOT_FOUND", "AGENT_NODE_NOT_FOUND"]);
const INVALID = new Set(["WORKFLOW_COMMAND_INVALID", "WORKFLOW_YAML_INVALID", "INPUT_INVALID"]);
const UNPROCESSABLE = new Set(["WORKFLOW_INPUT_INVALID", "DEFINITION_INVALID", "TEST_RESPONSE_INVALID", "RESPONSE_INVALID", "KV_LIMIT"]);
const LIMITED = new Set(["OPERATION_LIMIT", "TEST_INTERCEPTION_LIMIT", "INBOX_RATE_LIMITED"]);

/**
 * The HTTP status of a refused workflow command: 404 for what does not exist,
 * 403 forbidden, 400 an invalid command, 422 a value its contract refuses, 429
 * a limit, 500 a corrupt store, and 409 for a command that conflicts with the
 * workflow's current state (a revision, hash, operation id, run or answer).
 */
export function workflowCommandStatus(code: string): number {
    if (NOT_FOUND.has(code)) return 404;
    if (code === "FORBIDDEN" || code === "WORKFLOW_HUMAN_INPUT_DENIED") return 403;
    if (INVALID.has(code)) return 400;
    if (UNPROCESSABLE.has(code)) return 422;
    if (LIMITED.has(code)) return 429;
    if (code === "WORKFLOW_STORE_CORRUPT") return 500;
    return 409;
}

/**
 * Run a person's command on workflow session `workflowSessionId` (see the
 * module's comment). Returns the receipt's JSON, as the tool's answer without
 * its `ok`; throws the refusal (a WorkflowStoreError, or the human-input
 * denial with its 403).
 */
export async function updateWorkflowForPerson(command: unknown, context: { host: WorkflowV2Host; workflowSessionId: string; actor: WorkflowActor })
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
    const [row, definition] = await Promise.all([host.catalog.getSession(workflowSessionId), host.store.readDefinition(workflowSessionId)]);
    if (!row || row.deletedAt || row.sessionKind !== "workflow" || !definition) {
        throw new WorkflowStoreError("WORKFLOW_NOT_FOUND", `Session ${workflowSessionId} is not a version 2 workflow.`);
    }
    if (typeof args.operation !== "string" || !WORKFLOW_HUMAN_BRAKE_OPERATIONS.includes(args.operation)) {
        const lineage = await host.store.readWorkflowLineage(workflowSessionId);
        if (lineage?.agentRoot) throw workflowHumanInputError(workflowSessionId, "workflow", lineage);
    }
    return await runUpdateWorkflowCommand({ ...args, workflow_id: workflowSessionId }, host, actor, async () => {});
}
