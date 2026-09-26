import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionIdShape } from "../session-id.js";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * Session workspaces (docs/proposals/session-workspaces.md, section 4.8):
 * read, set or clear, and retry a session's workspace — the folder it uses
 * as its working directory.
 *
 *   get_session_workspace    the record, revision, path, status and adopted content
 *   set_session_workspace    set { root, folder } or clear, with the expected revision
 *   retry_session_workspace  retry now: run the held prompts, or hold them again
 */
export function registerWorkspaceTools(server: McpServer, ctx: ServerContext) {
    server.registerTool(
        "get_session_workspace",
        {
            title: "Get Session Workspace",
            description:
                "Read a session's workspace: root and folder, revision, attach path, status (none, ready or "
                + "unavailable), the last error, how many prompts are held, and the repo agents and skills adopted.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session to read"),
            },
        },
        withToolErrors(async ({ session_id }) => jsonResult(await ctx.mgmt.getSessionWorkspace(session_id))),
    );

    server.registerTool(
        "set_session_workspace",
        {
            title: "Set Session Workspace",
            description:
                "Set a session's workspace to { root, folder }, or clear it with clear=true. expected_revision must "
                + "match the current revision (read it with get_session_workspace). Applied between turns: a busy "
                + "session answers after its turn. The next turn runs in the new folder.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session to change"),
                expected_revision: z.number().int().min(0).describe("The current workspace revision"),
                root: z.string().optional().describe("A root name the deployment serves"),
                folder: z.string().optional().describe("A folder relative to the root; omit for the root itself"),
                clear: z.boolean().optional().describe("Clear the workspace instead of setting one"),
                timeout_ms: z.number().int().positive().optional().describe("Max time to wait for the answer"),
            },
        },
        withToolErrors(async ({ session_id, expected_revision, root, folder, clear, timeout_ms }) => {
            if (clear && root) return errorResult("pass either clear=true or a root, not both", { session_id });
            if (!clear && !root) return errorResult("pass a root to set, or clear=true to clear", { session_id });
            const result = await ctx.mgmt.setSessionWorkspace(
                session_id,
                { expectedRevision: expected_revision, workspace: clear ? null : { root: root!, ...(folder !== undefined ? { folder } : {}) } },
                { ...(timeout_ms ? { timeoutMs: timeout_ms } : {}) },
            );
            return jsonResult(result);
        }),
    );

    server.registerTool(
        "retry_session_workspace",
        {
            title: "Retry Session Workspace",
            description:
                "Retry now for a session held because its workspace was unavailable: the held prompts run if the "
                + "workspace is back, or are held again with no model call.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session to retry"),
                timeout_ms: z.number().int().positive().optional().describe("Max time to wait for the answer"),
            },
        },
        withToolErrors(async ({ session_id, timeout_ms }) =>
            jsonResult(await ctx.mgmt.retrySessionWorkspace(session_id, { ...(timeout_ms ? { timeoutMs: timeout_ms } : {}) }))),
    );
}
