import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionIdShape } from "../session-id.js";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors, type ToolResult } from "../util/respond.js";
import { steeringResultDisplay } from "pilotswarm/ui-core/steering-labels";

/**
 * Turn- and queue-level session control (proposal G3) — finer levers than
 * abort_session's whole-session cancel:
 *
 *   stop_turn               abort the in-flight turn, keep the session
 *   complete_session        mark done (distinct from cancelled)
 *   cancel_pending_messages drop queued messages by client message id
 *   send_session_event      inject a custom event into the session
 */
export function registerTurnControlTools(server: McpServer, ctx: ServerContext) {
    const steeringResult = (result: object) => jsonResult({ ...result, display: steeringResultDisplay(result) });
    function withSteeringErrors<A extends unknown[]>(fn: (...args: A) => Promise<ToolResult>) {
        return withToolErrors(async (...args: A) => {
            if (!ctx.api) return errorResult("Session steering is unsupported in direct-store MCP mode. Use authenticated Web API mode.", {
                code: "unsupported", reason: "direct_mcp_unavailable",
            });
            return fn(...args);
        });
    }
    async function requireSession(session_id: string) {
        const existing = await ctx.mgmt.getSession(session_id);
        return existing ?? null;
    }

    server.registerTool("get_steering_state", {
        title: "Get Steering State",
        description: "Read current-turn steering availability, the observed expectedTarget token and text/rate limits. "
            + "An open target grants no permission. Preserve the observed token when submitting guidance.",
        inputSchema: { session_id: sessionIdShape() },
    }, withSteeringErrors(async ({ session_id }) => steeringResult(await ctx.mgmt.getSessionSteeringState(session_id))));

    server.registerTool("steer_turn", {
        title: "Steer Current Turn",
        description: "Accept user guidance for this session's observed running turn without stopping it. Text only. "
            + "Delivery waits for a supported model/tool boundary and may be retained if the turn ends. "
            + "Acceptance is not delivery or compliance. This is not ordinary Send, a question answer, or a permission change. "
            + "Reuse client_request_id and expected_target after a lost response; never silently retarget.",
        inputSchema: {
            session_id: sessionIdShape(),
            text: z.string().min(1),
            client_request_id: z.string().min(1).max(200),
            expected_target: z.string().min(1).max(1024),
        },
    }, withSteeringErrors(async ({ session_id, text, client_request_id, expected_target }) => {
        const result = await ctx.mgmt.steerSessionTurn(session_id, {
            text, clientRequestId: client_request_id, expectedTarget: expected_target,
        });
        return { ...steeringResult(result), ...(result.ok ? {} : { isError: true }) };
    }));

    server.registerTool("get_steering_request", {
        title: "Get Steering Receipt",
        description: "Read one authoritative receipt, including separate delivery, future eligibility, inclusion and bounded attempt evidence. "
            + "Use the server request ID, not the caller retry identity.",
        inputSchema: {
            session_id: sessionIdShape(), request_id: z.string().min(1),
            attempt_cursor: z.string().optional(), attempt_limit: z.number().int().min(1).max(200).optional(),
        },
    }, withSteeringErrors(async ({ session_id, request_id, attempt_cursor, attempt_limit }) =>
        steeringResult(await ctx.mgmt.getSteeringRequest(session_id, request_id, { attemptCursor: attempt_cursor, attemptLimit: attempt_limit }))));

    server.registerTool("list_steering_requests", {
        title: "List Steering Receipts",
        description: "Read a bounded server-ordered receipt page (default 50, maximum 200). Cursors stay bound to this session and filters.",
        inputSchema: {
            session_id: sessionIdShape(), cursor: z.string().optional(),
            limit: z.number().int().min(1).max(200).optional(), expected_target: z.string().optional(),
            dispositions: z.array(z.enum(["accepted", "delivered_current_turn", "delivered_after_response", "delivered_timing_unconfirmed", "delivered_before_stop",
                "not_delivered_turn_ended", "not_delivered_turn_stopped", "withdrawn", "delivery_unconfirmed", "rejected"])).optional(),
        },
    }, withSteeringErrors(async ({ session_id, cursor, limit, expected_target, dispositions }) =>
        steeringResult(await ctx.mgmt.listSteeringRequests(session_id, { cursor, limit, expectedTarget: expected_target, dispositions }))));

    server.registerTool("withdraw_steering_request", {
        title: "Withdraw Guidance",
        description: "Withdraw only before worker claim, as the original author or effective session manager. "
            + "It never recalls submitted text. A losing withdrawal returns not_withdrawable and the current receipt.",
        inputSchema: { session_id: sessionIdShape(), request_id: z.string().min(1) },
    }, withSteeringErrors(async ({ session_id, request_id }) => {
        const result = await ctx.mgmt.withdrawSteeringRequest(session_id, request_id);
        return { ...steeringResult(result), ...(["forbidden", "not_found", "not_withdrawable"].includes(result.outcome) ? { isError: true } : {}) };
    }));

    server.registerTool(
        "stop_turn",
        {
            title: "Stop Turn",
            description:
                "Abort the in-flight turn of a running PilotSwarm session without cancelling the session — it stays "
                + "alive and accepts new messages. Use abort_session only when the whole session should end.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session whose current turn to stop"),
                reason: z.string().optional().describe("Optional reason, surfaced to the session"),
                timeout_ms: z.number().int().positive().optional().describe("Max time to wait for the turn to stop"),
            },
        },
        withToolErrors(async ({ session_id, reason, timeout_ms }) => {
            if (!(await requireSession(session_id))) {
                return errorResult("session not found", { session_id });
            }
            const result = await ctx.mgmt.stopSessionTurn(session_id, { reason, timeoutMs: timeout_ms });
            return jsonResult({ stopped: true, ...(result && typeof result === "object" ? result : {}) });
        }),
    );

    server.registerTool(
        "complete_session",
        {
            title: "Complete Session",
            description:
                "Mark a PilotSwarm session completed (a successful terminal state — distinct from abort_session's "
                + "cancelled). Use when the session's work is done and it should stop cleanly.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session to complete"),
                reason: z.string().optional().describe("Optional completion reason"),
            },
        },
        withToolErrors(async ({ session_id, reason }) => {
            if (!(await requireSession(session_id))) {
                return errorResult("session not found", { session_id });
            }
            await ctx.mgmt.completeSession(session_id, reason);
            return jsonResult({ completed: true });
        }),
    );

    server.registerTool(
        "cancel_pending_messages",
        {
            title: "Cancel Pending Messages",
            description:
                "Cancel queued (not yet processed) messages in a session, identified by the client_message_ids they "
                + "were sent with. Pair with send_message's client_message_ids parameter.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session holding the queued messages"),
                client_message_ids: z.array(z.string().min(1)).min(1).describe("Client message ids to cancel"),
            },
        },
        withToolErrors(async ({ session_id, client_message_ids }) => {
            if (!(await requireSession(session_id))) {
                return errorResult("session not found", { session_id });
            }
            try {
                await ctx.mgmt.cancelPendingMessage(session_id, client_message_ids);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                if (/not started|NotFound/i.test(msg)) {
                    // Pending-message cancellation rides the orchestration
                    // command channel, which only exists once the session's
                    // orchestration has started. Explain, don't confuse.
                    return errorResult(
                        "cannot cancel yet: this session's orchestration has not started, so the command channel "
                        + "is not live. Monitor the session (get_session_detail include: ['status']) and retry "
                        + "once orchestration_status is no longer NotFound.",
                        { session_id, client_message_ids },
                    );
                }
                throw err;
            }
            return jsonResult({ cancelled: true, client_message_ids });
        }),
    );

    // sendSessionEvent is a Web API session operation; in direct mode there is
    // no equivalent seam (events are worker-internal), so web-only.
    if (ctx.api) {
        server.registerTool(
            "send_session_event",
            {
                title: "Send Session Event",
                description:
                    "Inject a custom named event into a PilotSwarm session (e.g. a webhook-style signal an agent "
                    + "is waiting on). Not a chat message — use send_message for prompts.",
                inputSchema: {
                    session_id: sessionIdShape().describe("The target session"),
                    event_name: z.string().min(1).describe("Event name the session listens for"),
                    data: z.record(z.string(), z.any()).optional().describe("Event payload"),
                },
            },
            withToolErrors(async ({ session_id, event_name, data }) => {
                if (!(await requireSession(session_id))) {
                    return errorResult("session not found", { session_id });
                }
                await ctx.web.ops.sendSessionEvent({ sessionId: session_id, eventName: event_name, data });
                return jsonResult({ sent: true, event_name });
            }),
        );
    }
}
