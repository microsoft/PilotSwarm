import { workflowHumanInputError } from "./input-policy.js";
import type { JsonValue } from "./json.js";
import type { WorkflowV2Host } from "./service.js";
import { WorkflowStoreError, type WorkflowActor } from "./store.js";
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
