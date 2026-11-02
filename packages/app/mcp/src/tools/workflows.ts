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
    registerCredentialedWorkflowTools(server, ctx);
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

/** A refusal with a code, in one JSON shape (never a token: no refusal carries one). */
function codedRefusal(err: any, extra: Record<string, unknown>) {
    return errorResult(err.message, {
        code: err.code,
        ...extra,
        ...(Number.isInteger(err.status) ? { status: err.status } : {}),
        ...(err.details !== undefined && err.details !== null ? { details: err.details } : {}),
    });
}

/**
 * Workflow v2 (INACTIVE; test-only): answer a workflow's request, or complete
 * an agent state, as a holder session this server acts for (design 04).
 * Registered only when the server holds a credential vault (direct mode, its
 * configuration naming the holder sessions). The credential is obtained and
 * kept by the vault in this process's memory and sent only as the action's
 * credential: no tool takes one as an argument or returns one, so it never
 * reaches the client's model, its transcript or a log.
 */
function registerCredentialedWorkflowTools(server: McpServer, ctx: ServerContext): void {
    const vault = ctx.workflowCredentialVault;
    if (!vault) return;

    server.registerTool(
        "respond_session_request",
        {
            title: "Respond To Session Request",
            description:
                "Answer a workflow's typed request as the session this server acts for (its responder): request_id, operation_id "
                + "(repeat it to retry the same answer) and either response (a value that matches the request's response schema) or "
                + "decline ({ reason }). Answers the receipt. Only a session this server is configured to act for can answer.",
            inputSchema: {
                session_id: sessionIdShape().describe("The responder session this server acts for"),
                request_id: z.string().min(1).describe("The request's id (its node execution id)"),
                operation_id: z.string().min(1).describe("Your id for this answer; repeat it to retry the same answer"),
                response: z.unknown().optional().describe("The answer, matching the request's response schema"),
                decline: z.object({ reason: z.string() }).strict().optional().describe("A refusal with its reason, instead of a response"),
            },
        },
        withToolErrors(async ({ session_id, request_id, operation_id, response, decline }) => {
            try {
                const receipt = await vault.withCredential({ audience: "workflow.respond", nodeExecutionId: request_id, holderSessionId: session_id },
                    credential => ctx.mgmt.respondToSessionRequest(request_id, {
                        operationId: operation_id, ...(response !== undefined ? { response } : {}), ...(decline !== undefined ? { decline } : {}), credential,
                    }));
                vault.forget(request_id);
                return jsonResult(receipt);
            } catch (err: any) {
                if (typeof err?.code !== "string") throw err;
                return codedRefusal(err, { session_id, request_id });
            }
        }),
    );

    server.registerTool(
        "complete_workflow_node",
        {
            title: "Complete Workflow Node",
            description:
                "Complete a workflow agent state as the session this server acts for (the state's child): node_execution_id, "
                + "operation_id (repeat it to retry the same completion) and either outcome with output (one of the state's outcomes, an "
                + "output that matches its output schema) or error ({ code: needs_input or execution_failed, message }). Answers the "
                + "receipt; an output that does not match answers its problems. Only a session this server is configured to act for can complete.",
            inputSchema: {
                session_id: sessionIdShape().describe("The agent state's child session this server acts for"),
                node_execution_id: z.string().min(1).describe("The agent state's node execution id"),
                operation_id: z.string().min(1).describe("Your id for this completion; repeat it to retry the same completion"),
                outcome: z.string().optional().describe("One of the state's outcomes"),
                output: z.unknown().optional().describe("The output, matching the state's output schema"),
                error: z.object({ code: z.string(), message: z.string() }).strict().optional().describe("needs_input or execution_failed, with a message"),
            },
        },
        withToolErrors(async ({ session_id, node_execution_id, operation_id, outcome, output, error }) => {
            try {
                const receipt = await vault.withCredential({ audience: "workflow.complete", nodeExecutionId: node_execution_id, holderSessionId: session_id },
                    credential => ctx.mgmt.completeWorkflowNode(session_id, {
                        nodeExecutionId: node_execution_id, operationId: operation_id, ...(outcome !== undefined ? { outcome } : {}),
                        ...(output !== undefined ? { output } : {}), ...(error !== undefined ? { error } : {}), credential,
                    }));
                vault.forget(node_execution_id);
                return jsonResult(receipt);
            } catch (err: any) {
                if (typeof err?.code !== "string") throw err;
                return codedRefusal(err, { session_id, node_execution_id });
            }
        }),
    );
}
