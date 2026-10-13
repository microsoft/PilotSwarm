import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionIdShape } from "../session-id.js";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * Turn- and queue-level session control (proposal G3) — finer levers than
 * abort_session's whole-session cancel:
 *
 *   stop_turn               stop the running turn, keep the session
 *   steer_session_turn      add guidance to the running turn
 *   complete_session        mark done (distinct from cancelled)
 *   cancel_pending_messages drop queued messages by client message id
 *   send_session_event      inject a custom event into the session
 */
export function registerTurnControlTools(server: McpServer, ctx: ServerContext) {
    async function requireSession(session_id: string) {
        const existing = await ctx.mgmt.getSession(session_id);
        return existing ?? null;
    }

    server.registerTool(
        "stop_turn",
        {
            title: "Stop Turn",
            description:
                "Stop the running turn of a PilotSwarm session without cancelling the session — it stays alive and "
                + "accepts new messages. Use abort_session only when the whole session should end. The outcome is "
                + "stopped, too_late (the turn had already finished its model run and completed normally), "
                + "no_active_turn, or timeout (with control_seq: the Stop was accepted and applies when the turn runs). "
                + "Pass request_id to make a retry after a lost response safe.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session whose current turn to stop"),
                reason: z.string().optional().describe("Optional reason, surfaced to the session"),
                timeout_ms: z.number().int().positive().optional().describe("Max time to wait for the turn to stop"),
                request_id: requestIdShape().optional().describe(
                    "Idempotency key. Reuse it only to retry after a transport failure; a new id is generated when omitted"),
            },
        },
        withToolErrors(async ({ session_id, reason, timeout_ms, request_id }) => {
            if (!(await requireSession(session_id))) {
                return errorResult("session not found", { session_id });
            }
            const requestId = request_id ?? randomUUID();
            const result = await ctx.mgmt.stopSessionTurn(session_id, { reason, timeoutMs: timeout_ms, requestId });
            const outcome = result && typeof result === "object" ? result.outcome : undefined;
            return jsonResult({
                ...(result && typeof result === "object" ? result : {}),
                stopped: outcome === "stopped" || outcome === "stop_forced",
                request_id: requestId,
            });
        }),
    );

    server.registerTool(
        "steer_session_turn",
        {
            title: "Steer Session Turn",
            description:
                "Add guidance to the running turn of a PilotSwarm session; the model receives it at its next model call. "
                + "Needs the sessions.steering feature. accepted: recorded once; its outcome (delivered, carried to the "
                + "next turn, not delivered) appears in the session events. no_turn or legacy_turn: no turn accepts "
                + "steering now — send the text with send_message instead and do not retry this request_id. Retry with "
                + "the same request_id only after a lost response.",
            inputSchema: {
                session_id: sessionIdShape().describe("The session whose running turn to steer"),
                text: z.string().min(1).describe("The guidance for the model"),
                request_id: requestIdShape().optional().describe(
                    "Idempotency key. Reuse it only to retry after a transport failure; a new id is generated when omitted"),
            },
        },
        withToolErrors(async ({ session_id, text, request_id }) => {
            if (!(await requireSession(session_id))) {
                return errorResult("session not found", { session_id });
            }
            const requestId = request_id ?? randomUUID();
            const result = await ctx.mgmt.steerSessionTurn(session_id, { text, requestId });
            if (result.outcome === "accepted") {
                return jsonResult({
                    accepted: true,
                    outcome: "accepted",
                    steer_id: result.steerId,
                    turn: result.turn,
                    ...(result.repeat ? { repeat: true } : {}),
                    request_id: requestId,
                });
            }
            return jsonResult({
                accepted: false,
                outcome: result.outcome,
                request_id: requestId,
                ...(result.outcome === "no_turn" || result.outcome === "legacy_turn"
                    ? { hint: "No running turn accepts steering. Send the text with send_message instead; do not retry this request_id." }
                    : {}),
            });
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

/** A caller-chosen idempotency key for Stop and Steer (the management client's limit). */
function requestIdShape() {
    return z.string().min(1).max(200);
}
