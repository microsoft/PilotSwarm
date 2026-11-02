import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionIdShape } from "../session-id.js";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * Workflow v2: a person's workflow command over MCP (design 04 REST/SDK/MCP
 * mapping; R26; INACTIVE: registered only when the server is created with the
 * test-only option workflowCommands, so the tool is absent everywhere else).
 *
 *   update_workflow   the update_workflow tool's command, sent to one workflow session
 *
 * The management client runs it (direct mode) or the Web API does (web mode,
 * POST /sessions/{id}/workflow/commands): the same implementation, authority
 * and refusals as for any person, the signed-in caller (web mode) or this
 * server's own user (direct mode) recorded as the actor. A workflow in a
 * workflow agent state's subtree takes only pause, stop and cancel.
 */
export function registerWorkflowTools(server: McpServer, ctx: ServerContext): void {
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
                + "A workflow inside a workflow agent state's subtree takes only pause, stop and cancel; read a workflow with get_session_detail "
                + "or the workflow read API first.",
            inputSchema: {
                session_id: sessionIdShape().describe("The workflow session to command"),
                command: z.record(z.string(), z.unknown()).describe("The command: { operation, operation_id, ...its arguments }"),
            },
        },
        withToolErrors(async ({ session_id, command }) => {
            try {
                return jsonResult(await ctx.mgmt.updateWorkflow(session_id, command));
            } catch (err: any) {
                // Every refusal with a code answers in one JSON shape, with its status and details; a bare 403 keeps the
                // standard answer.
                if (typeof err?.code !== "string" || (err.status === 403 && err.code === "FORBIDDEN")) throw err;
                return errorResult(err.message, {
                    code: err.code,
                    session_id,
                    ...(Number.isInteger(err.status) ? { status: err.status } : {}),
                    ...(err.details !== undefined && err.details !== null ? { details: err.details } : {}),
                });
            }
        }),
    );
}
