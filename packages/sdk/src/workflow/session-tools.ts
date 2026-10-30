/**
 * Session tools for workflow scripts: the same operations an agent's
 * list_sessions, send_session_message and reply_session_message perform,
 * acting as the workflow session. They return JSON for the script instead of
 * the `[SYSTEM: ...]` lines written for a model.
 */
import type { SessionCatalog } from "../cms.js";
import { replyInternalSessionMessage, sendInternalSessionMessage, type SessionMessageReason, type SessionMessageVerdict } from "../session-messages.js";
import { formatSessionOwnerLabel, matchesSessionOwnerFilters } from "../session-owner-utils.js";
import type { ScriptToolHandler } from "./activities.js";

const MESSAGE_REASONS = new Set(["help", "guidance", "fact-request", "status-request", "handoff"]);
const REPLY_VERDICTS = new Set(["answered", "declined", "blocked", "stale"]);

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function sessionIdArg(value: unknown): string {
    return text(value).replace(/^session-/, "");
}

function millis(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    const parsed = typeof value === "number" ? value : Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function iso(value: unknown): string | null {
    const ms = millis(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function createScriptSessionTools(opts: {
    sessionId: string;
    catalog: Pick<SessionCatalog, "listSessions" | "getSession"> & Partial<SessionCatalog>;
    duroxideClient: any;
}): Map<string, ScriptToolHandler> {
    const { sessionId, catalog } = opts;
    const runtime = () => {
        if (!opts.duroxideClient) throw new Error("session messages are not available on this worker");
        return { catalog: catalog as SessionCatalog, duroxideClient: opts.duroxideClient };
    };
    const tools = new Map<string, ScriptToolHandler>();

    tools.set("list_sessions", async (args) => {
        const limit = Math.max(1, Math.min(100, Number(args.limit) || 50));
        const query = text(args.query).toLowerCase();
        const exactId = sessionIdArg(args.session_id);
        const agentId = text(args.agent_id);
        const state = text(args.state).toLowerCase();
        const parentId = sessionIdArg(args.parent_session_id);
        const includeChildren = args.include_children === true;
        const updatedSince = millis(args.updated_since);
        const rows = await catalog.listSessions();
        const sessions = rows
            .filter((row) => !row.deletedAt)
            .map((row) => ({ ...row, status: row.state }))
            .filter((row) => matchesSessionOwnerFilters(row as any, {
                includeSystem: args.include_system === true,
                ownerQuery: typeof args.owner_query === "string" ? args.owner_query : undefined,
                ownerKind: typeof args.owner_kind === "string" ? args.owner_kind : undefined,
            }))
            .filter((row) => {
                if (!includeChildren && !exactId && !parentId && row.parentSessionId) return false;
                if (exactId && row.sessionId !== exactId) return false;
                if (agentId && row.agentId !== agentId) return false;
                if (state && String(row.state || "").toLowerCase() !== state) return false;
                if (parentId && row.parentSessionId !== parentId) return false;
                if (Number.isFinite(updatedSince) && !(millis(row.updatedAt) >= updatedSince)) return false;
                if (query) {
                    const haystack = [row.sessionId, row.title, row.agentId, formatSessionOwnerLabel(row as any)]
                        .map((part) => String(part || "").toLowerCase()).join(" ");
                    if (!haystack.includes(query)) return false;
                }
                return true;
            })
            .slice(0, limit)
            .map((row) => ({
                sessionId: row.sessionId,
                ...(row.sessionId === sessionId ? { self: true } : {}),
                kind: row.sessionKind ?? "agent",
                title: row.title ?? null,
                agentId: row.agentId ?? null,
                status: row.state,
                parentSessionId: row.parentSessionId ?? null,
                owner: formatSessionOwnerLabel(row as any),
                createdAt: iso(row.createdAt),
                updatedAt: iso(row.updatedAt),
            }));
        return { count: sessions.length, sessions };
    });

    tools.set("send_session_message", async (args) => {
        const target = sessionIdArg(args.session_id);
        if (!target) throw new Error("session_id is required");
        // A reply would arrive on the workflow's command queue, which takes
        // lifecycle commands only.
        if (args.expects_response === true) {
            throw new Error("a workflow session cannot receive replies; send a one-way message (expects_response false)");
        }
        const reason = MESSAGE_REASONS.has(text(args.reason)) ? text(args.reason) as SessionMessageReason : undefined;
        const { requestId } = await sendInternalSessionMessage(runtime(), {
            fromSessionId: sessionId,
            toSessionId: target,
            subject: String(args.subject ?? ""),
            body: String(args.body ?? ""),
            ...(reason ? { reason } : {}),
            expectsResponse: false,
            ...(text(args.expires_at) ? { expiresAt: text(args.expires_at) } : {}),
        });
        return { requestId, target };
    });

    tools.set("reply_session_message", async (args) => {
        const target = sessionIdArg(args.session_id);
        const requestId = text(args.request_id);
        if (!target || !requestId || !text(args.body)) throw new Error("request_id, session_id and body are required");
        const verdict = REPLY_VERDICTS.has(text(args.verdict)) ? text(args.verdict) as SessionMessageVerdict : "answered";
        await replyInternalSessionMessage(runtime(), {
            requestId,
            fromSessionId: sessionId,
            toSessionId: target,
            verdict,
            body: String(args.body),
        });
        return { replied: true, requestId, target };
    });

    return tools;
}
