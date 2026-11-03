import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionIdShape } from "../session-id.js";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors, type ToolResult } from "../util/respond.js";

/**
 * Workflow v2 over MCP (design 04 REST/SDK/MCP mapping; R01, R26):
 *
 *   read_workflow     the workflow read (always registered): the view of a workflow session, a section's next page
 *                     (cursor) or one node execution's whole output or error (execution_id)
 *   update_workflow   the update_workflow tool's command, sent to one workflow session (INACTIVE: registered only when
 *                     the server is created with the test-only option workflowCommands, so it is absent everywhere else)
 *
 * The management client runs each (direct mode) or the Web API does (web mode: GET /sessions/{id}/workflow, POST
 * /sessions/{id}/workflow/commands): the same implementation, authority and refusals as for any person, the signed-in
 * caller (web mode) or this server's own user (direct mode). A read changes nothing. A command is recorded with that
 * actor; a workflow in a workflow agent state's subtree takes only pause, stop and cancel.
 */
export function registerWorkflowTools(server: McpServer, ctx: ServerContext): void {
    server.registerTool(
        "read_workflow",
        {
            title: "Read Workflow",
            description:
                "Read a version 2 workflow session without changing it, as a person: its definition state, current revision and "
                + "diagnostics, graph and runs, and one run (run_id, default the live run) with the newest page of its node executions, "
                + "inbox and outbox (and a test run's interceptions), each page oldest first, the rows still open that a page does not hold "
                + "(openExecutions, openInbox, openOutbox, run.test.openInterceptions), and run.pages: each section's nextCursor. Give a "
                + "nextCursor back as cursor (it is a JSON object; limit may go with it) to read that section's next, older page; null "
                + "means none is older. execution_id (with run_id, default the live run) reads one node execution with its whole output "
                + "or error (execution.result) instead of its preview. limit: rows per page, 1 to 200. kv_revision reads that revision of the "
                + "run's variables (each with its size and sha256), and kv_key with it one variable, whole. agent_versions: true, alone, "
                + "reads the agent versions that publishing the current revision would lock now (it locks nothing). definition_revision, alone, "
                + "reads that revision of the definition (its YAML as saved and formatted). step_input ({ state, input? }), alone, reads an agent "
                + "step's input fields in the current draft and, with input, the draft's YAML with only that step's inputs changed. Refusals carry their code: "
                + "WORKFLOW_NOT_FOUND, RUN_NOT_FOUND, EXECUTION_NOT_FOUND, KV_REVISION_NOT_FOUND, DEFINITION_REVISION_NOT_FOUND, WORKFLOW_CURSOR_INVALID, WORKFLOW_READ_INVALID.",
            inputSchema: {
                session_id: sessionIdShape().describe("The workflow session to read"),
                run_id: z.string().optional().describe("A run of the workflow; default the live run"),
                cursor: z.record(z.string(), z.unknown()).optional()
                    .describe("A nextCursor from run.pages (or from a page), given back as it was: that section's next, older page"),
                execution_id: z.string().optional().describe("A node execution of the run: its whole output or error"),
                limit: z.number().int().optional().describe("Rows per page of each section, 1 to 200"),
                kv_revision: z.number().int().optional().describe("A revision of the run's variables, 1 to its kvRevision"),
                kv_key: z.string().optional().describe("With kv_revision: one variable of that revision, whole"),
                agent_versions: z.boolean().optional().describe("true: the agent versions publishing the current revision would lock now, and nothing else"),
                definition_revision: z.number().int().optional().describe("A revision of the definition, 1 to the current one: its YAML, and nothing else"),
                step_input: z.record(z.string(), z.unknown()).optional()
                    .describe("{ state, input? }: an agent step's input fields in the current draft; with input, the YAML that mapping proposes"),
            },
        },
        withToolErrors(async ({ session_id, run_id, cursor, execution_id, limit, kv_revision, kv_key, agent_versions, definition_revision, step_input }) => {
            try {
                return jsonResult(await ctx.mgmt.readWorkflow(session_id, {
                    ...(run_id !== undefined ? { runId: run_id } : {}),
                    ...(cursor !== undefined ? { cursor } : {}),
                    ...(execution_id !== undefined ? { executionId: execution_id } : {}),
                    ...(limit !== undefined ? { limit } : {}),
                    ...(kv_revision !== undefined ? { kvRevision: kv_revision } : {}),
                    ...(kv_key !== undefined ? { kvKey: kv_key } : {}),
                    ...(agent_versions !== undefined ? { agentVersions: agent_versions } : {}),
                    ...(definition_revision !== undefined ? { definitionRevision: definition_revision } : {}),
                    ...(step_input !== undefined ? { stepInput: step_input } : {}),
                }));
            } catch (err: unknown) {
                return refusal(err, session_id);
            }
        }),
    );

    if (ctx.workflowCommands !== true) return;

    server.registerTool(
        "update_workflow",
        {
            title: "Update Workflow",
            description:
                "Send one command to a version 2 workflow session, as a person. command is the update_workflow agent tool's command: "
                + "operation (replace_definition, publish, publish_and_start, start, set_vars, pause, resume, cancel; stop, test, test_respond "
                + "and test_advance when the workers run controller 1.9.0), operation_id (repeat it to retry the same command) and the "
                + "operation's arguments (expected_revision, definition_hash, yaml, inputs, vars, set, delete, expected_kv_revision, run_id, "
                + "reason, grace_seconds, agent_mode, fixtures, scenario, interception_id, response, seconds). Answers the command's receipt. "
                + "A workflow inside a workflow agent state's subtree takes only pause, stop and cancel; read a workflow with read_workflow "
                + "first.",
            inputSchema: {
                session_id: sessionIdShape().describe("The workflow session to command"),
                command: z.record(z.string(), z.unknown()).describe("The command: { operation, operation_id, ...its arguments }"),
            },
        },
        withToolErrors(async ({ session_id, command }) => {
            try {
                return jsonResult(await ctx.mgmt.updateWorkflow(session_id, command));
            } catch (err: unknown) {
                return refusal(err, session_id);
            }
        }),
    );
}

/**
 * A workflow refusal: every one with a code answers in one JSON shape, with its status and details; a bare 403 and an
 * error without a code keep the standard answer (rethrown to withToolErrors).
 */
function refusal(err: unknown, session_id: string): ToolResult {
    const failure = (err ?? {}) as { code?: unknown; status?: unknown; message?: unknown; details?: unknown };
    const code = failure.code;
    if (typeof code !== "string" || (failure.status === 403 && code === "FORBIDDEN")) throw err;
    return errorResult(typeof failure.message === "string" ? failure.message : String(err), {
        code,
        session_id,
        ...(Number.isInteger(failure.status) ? { status: failure.status } : {}),
        ...(failure.details !== undefined && failure.details !== null ? { details: failure.details } : {}),
    });
}
