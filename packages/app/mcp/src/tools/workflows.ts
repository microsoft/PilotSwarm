import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { workflowTestModeFromEnv } from "pilotswarm-sdk";
import { sessionIdShape } from "../session-id.js";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors, type ToolResult } from "../util/respond.js";

/**
 * Workflow over MCP (design 04 REST/SDK/MCP mapping; R01, R26):
 *
 * Workflows are always on (owner 2026-11-08T08:03Z), with the full engine and a person's commands (2026-11-08T15:30Z):
 *
 *   read_workflow     the workflow read (always registered): the view of a workflow session, a section's next page
 *                     (cursor) or one node execution's whole output or error (execution_id)
 *   update_workflow   the update_workflow tool's command, sent to one workflow session (registered unless the server is
 *                     created with `workflowCommands: null`, which only a test does)
 *
 * The management client runs each (direct mode) or the Web API does (web mode: GET /sessions/{id}/workflow, POST
 * /sessions/{id}/workflow/commands): the same implementation, authority and refusals as for any person, the signed-in
 * caller (web mode) or this server's own user (direct mode). A read changes nothing. A command is recorded with that
 * actor; a workflow in a workflow agent state's subtree takes only pause, stop and cancel.
 */
export function registerWorkflowTools(server: McpServer, ctx: ServerContext): void {
    // Workflow test mode is hidden unless this process's deployment flag is on (spec 16): off, neither tool names it, and the
    // read shows no test run (review SF-5).
    const testMode = ctx.workflowTestMode ?? workflowTestModeFromEnv();
    server.registerTool(
        "read_workflow",
        {
            title: "Read Workflow",
            description:
                "Read a Workflow without changing it, as a person: its definition (state, current revision, "
                + "diagnostics), graph and runs, and one run (run_id, default the live run). Each section of the run holds its newest rows, "
                + "oldest first; rows still open are listed apart, however old (openExecutions, openInbox, openOutbox"
                + `${testMode ? ", run.test.openInterceptions" : ""}). run.pages gives each section's nextCursor: give it back as cursor (a JSON object; limit may `
                + "go with it) for that section's next, older page; null means none is older. execution_id, kv_revision, agent_versions, "
                + "definition_revision and step_input are separate reads: each argument says what it returns. Refusals carry their code: "
                + "WORKFLOW_NOT_FOUND, RUN_NOT_FOUND, EXECUTION_NOT_FOUND, KV_REVISION_NOT_FOUND, DEFINITION_REVISION_NOT_FOUND, WORKFLOW_CURSOR_INVALID, WORKFLOW_READ_INVALID, "
                + "and WORKFLOW_STORE_UNAVAILABLE (with its reason) when the store cannot be reached or has no room now.",
            inputSchema: {
                session_id: sessionIdShape().describe("The workflow session to read"),
                run_id: z.string().optional().describe("A run of the workflow; default the live run"),
                cursor: z.record(z.string(), z.unknown()).optional()
                    .describe("A nextCursor from run.pages (or from a page), given back as it was: that section's next, older page"),
                execution_id: z.string().optional().describe("With run_id, not with cursor: one step execution's whole output or error instead of its preview"),
                limit: z.number().int().optional().describe("Rows per page of each section, 1 to 200"),
                kv_revision: z.number().int().optional().describe("A revision of the run's variables, 1 to its kvRevision, each with its size and sha256"),
                kv_key: z.string().optional().describe("With kv_revision: one variable of that revision, whole"),
                agent_versions: z.boolean().optional().describe("true, alone: the agent versions publishing the current revision would lock now; it locks nothing"),
                definition_revision: z.number().int().optional().describe("Alone: a revision of the definition, 1 to the current one: its YAML as saved and formatted"),
                step_input: z.record(z.string(), z.unknown()).optional()
                    .describe("{ state, input? }, alone: an agent step's input fields in the current draft; with input, the YAML that mapping proposes"),
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

    // Off, update_workflow names stop and no test operation; with test mode on, the test operations too.
    const operations = testMode
        ? "operation (replace_definition, publish, publish_and_start, start, set_vars, pause, resume, cancel, stop, test, test_respond "
            + "and test_advance), operation_id (repeat it to retry the same command) and the operation's arguments (expected_revision, "
            + "definition_hash, yaml, inputs, vars, notify_on_completion, set, delete, expected_kv_revision, run_id, reason, grace_seconds, "
            + "agent_mode, fixtures, scenario, interception_id, response, seconds). "
        : "operation (replace_definition, publish, publish_and_start, start, set_vars, pause, resume, cancel and stop), operation_id "
            + "(repeat it to retry the same command) and the operation's arguments (expected_revision, definition_hash, yaml, inputs, "
            + "vars, notify_on_completion, set, delete, expected_kv_revision, run_id, reason, grace_seconds). ";
    server.registerTool(
        "update_workflow",
        {
            title: "Update Workflow",
            description:
                "Send one command to a Workflow, as a person. command is the update_workflow agent tool's command: "
                + operations
                + "A live start (publish_and_start, start) tells the workflow's parent agent the result when the run ends unless "
                + "notify_on_completion is false. Answers the command's receipt. "
                + "A workflow started under another workflow's agent step takes only pause, stop and cancel; read a workflow with read_workflow "
                + "first.",
            inputSchema: {
                session_id: sessionIdShape().describe("The workflow session to command"),
                command: z.record(z.string(), z.unknown()).describe("The command: { operation, operation_id, ...its arguments }"),
                originating_session_id: z.string().optional()
                    .describe("The session this command comes from, when an agent's call is passed on; a session inside a Workflow cannot change definitions"),
            },
        },
        withToolErrors(async ({ session_id, command, originating_session_id }) => {
            try {
                // The session this server acts for, when it was started for one, wins over the argument (review SF-2).
                const originatingSessionId = ctx.originatingSessionId ?? originating_session_id;
                return jsonResult(await ctx.mgmt.updateWorkflow(session_id, command,
                    ...(originatingSessionId !== undefined ? [{ originatingSessionId }] : [])));
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
