import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mergeWorkspaceChange } from "pilotswarm-sdk";
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
 *   set_session_workspace    change the working folder or the extra folders, or clear,
 *                            with the expected revision; what is not named stays
 *   retry_session_workspace  retry now: run the held prompts, or hold them again
 */
export function registerWorkspaceTools(server: McpServer, ctx: ServerContext) {
    server.registerTool(
        "get_session_workspace",
        {
            title: "Get Session Workspace",
            description:
                "Read a session's workspace: root and folder, revision, attach path, status (none, ready or "
                + "unavailable), the last error, how many prompts are held, the repo agents and skills adopted, and the "
                + "default folders used or left out. turnRevision is the revision the last turn ran under; adopted and "
                + "defaults are as of it.",
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
                "Change a session's workspace. { root, folder } sets the working folder; extra: { <name>: { root, folder, "
                + "required } } adds or replaces an extra folder and extra: { <name>: null } removes one; clear=true clears "
                + "everything. What you do not name stays as it is. expected_revision must match the current revision "
                + "(read it with get_session_workspace). Applied between turns: a busy session answers after its turn.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session to change"),
                expected_revision: z.number().int().min(0).describe("The current workspace revision"),
                root: z.string().optional().describe("A root name the deployment serves, for the working folder"),
                folder: z.string().optional().describe("A folder relative to the root; omit for the root itself"),
                extra: z.record(z.string(), z.object({
                    root: z.string(),
                    folder: z.string().optional(),
                    required: z.boolean().optional(),
                }).strict().nullable()).optional().describe("Extra folders by name: { root, folder, required } adds or replaces, null removes"),
                clear: z.boolean().optional().describe("Clear the working folder and every extra folder"),
                timeout_ms: z.number().int().min(1_000).max(300_000).optional().describe("Max time to wait for the answer, 1000 to 300000 ms"),
            },
        },
        withToolErrors(async ({ session_id, expected_revision, root, folder, extra, clear, timeout_ms }) => {
            try {
                // The same merge rules as the agent's tool, on the record read
                // now: nothing the caller leaves out is dropped. The revision
                // check catches a change made in between.
                const current = await ctx.mgmt.getSessionWorkspace(session_id);
                const merged = mergeWorkspaceChange(current.workspace, { root, folder, extra, clear });
                if (!merged.ok) {
                    return errorResult(`${merged.code}: ${merged.message}`, { code: merged.code, session_id, revision: current.revision });
                }
                // The merged record names `extra`, even when empty, so the session
                // sets exactly these folders.
                const workspace = merged.next ? { ...merged.next, extra: merged.next.extra ?? {} } : null;
                const result = await ctx.mgmt.setSessionWorkspace(
                    session_id,
                    { expectedRevision: expected_revision, workspace },
                    { ...(timeout_ms ? { timeoutMs: timeout_ms } : {}) },
                );
                return jsonResult(result);
            } catch (err: any) {
                // Every refusal with a code (a bad folder, an unknown root, a
                // stale revision, a session with no turn yet) answers in the
                // same JSON shape as the check above. A bare 403 keeps the
                // standard answer.
                if (typeof err?.code !== "string" || err.status === 403) throw err;
                return errorResult(err.message, {
                    code: err.code,
                    session_id,
                    ...(Number.isInteger(err.revision) ? { revision: err.revision } : {}),
                });
            }
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
                timeout_ms: z.number().int().min(1_000).max(300_000).optional().describe("Max time to wait for the answer, 1000 to 300000 ms"),
            },
        },
        withToolErrors(async ({ session_id, timeout_ms }) =>
            jsonResult(await ctx.mgmt.retrySessionWorkspace(session_id, { ...(timeout_ms ? { timeoutMs: timeout_ms } : {}) }))),
    );
}
