/**
 * An agent node's Log (owner feedback 2026-11-06, finding 8: "The log for the agent node should show the chat history
 * along with the log. show the base prompts, the agents outputs and the logs for the session in a clearly discernable
 * way."). One group per visit of the node, newest first ("Visit 4 · 17:42:01"), and in each group, in time order, three
 * kinds of row told apart by their label:
 * - Prompt: what the agent chat was given: the visit's prompt (the workflow's wrapper with its input and the node's task),
 *   any message to it (the parent agent's), and the runtime's notes to it (system messages);
 * - Agent: the chat's answers, each tool call as one line (its arguments and result to expand), and its typed result;
 * - Workflow: the Workflow's own lines for that visit (started, the chat, reminders, its end), as the Log says them.
 * The chat is read with the same history reads as any session; a chat that continues across visits (chat: continue) is
 * cut at each visit's prompt. The agent's base instructions are not recorded in its chat, so the Log says so and shows
 * only what is recorded. Long text is folded (`more`). Pure.
 */
import { callText, firstCallLine } from "./chat-activity.js";
import { workflowEventText } from "./workflow-v2-view.js";
import { workflowNodeClock, workflowNodeNow } from "./workflow-node-summary.js";

/** How many visits the Log shows before "Show older visits"; how long a text is before it folds. */
export const WORKFLOW_AGENT_LOG_VISITS = 10;
export const WORKFLOW_AGENT_LOG_FOLD = 600;
/** The Log's one line about what its rows are (finding 8). */
export const WORKFLOW_AGENT_LOG_NOTE = "Prompt rows are what the agent was given, its base instructions first; Agent rows are what it did.";

/** The summary the runtime records for the SDK's echo of the full system prompt (session-proxy summarizeSdkSystemPromptEchoEvent). */
const BASE_SUMMARY = /^\[SYSTEM: Copilot SDK rebuilt the full system prompt for model input\. Full content omitted from CMS \((\d+) chars\)\. Snippet: ([\s\S]*)\]$/;

/**
 * A recorded base-instructions summary as a row's parts: its length and snippet, and where its whole text is kept
 * (`baseInstructions`, a workflow agent chat's: { sessionId, artifact, sha256, chars }), or null for another message.
 */
export function workflowBaseInstructions(data) {
    const content = isRecord(data) && typeof data.content === "string" ? data.content : "";
    const found = BASE_SUMMARY.exec(content);
    if (!found) return null;
    const kept = isRecord(data.baseInstructions) ? data.baseInstructions : null;
    const ref = kept && typeof kept.sessionId === "string" && typeof kept.artifact === "string" && /^base-instructions-[0-9a-f]{16}\.md$/.test(kept.artifact)
        ? { sessionId: kept.sessionId, artifact: kept.artifact, sha256: typeof kept.sha256 === "string" ? kept.sha256 : null } : null;
    return { chars: Number(found[1]), snippet: found[2], ref };
}

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const timeOf = value => {
    const ms = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
    return Number.isFinite(ms) ? ms : null;
};
const COMPLETE_TOOL = "complete_workflow_node";

/** A text, folded when it is long: { text, more } where `more` is the whole text (absent when nothing was cut). */
export function workflowLogFold(value, max = WORKFLOW_AGENT_LOG_FOLD) {
    const whole = typeof value === "string" ? value : callText(value);
    if (whole.length <= max) return { text: whole };
    return { text: `${whole.slice(0, max).trimEnd()}…`, more: whole };
}

/** The node execution a prompt was sent for: its client message id ends in ":agent:<node execution>" (workflowAgentClientMessageId). */
export function workflowPromptVisit(event) {
    if (event?.eventType !== "user.message") return null;
    const ids = Array.isArray(event.data?.clientMessageIds) ? event.data.clientMessageIds : [];
    for (const id of ids) {
        const found = typeof id === "string" ? /:agent:([^:]+)$/.exec(id) : null;
        if (found) return found[1];
    }
    return null;
}

/** The visits of an agent node the Log shows, newest first, at most `limit`. */
export function workflowAgentLogVisits(node, limit = WORKFLOW_AGENT_LOG_VISITS) {
    const visits = (Array.isArray(node?.executions) ? node.executions : []).filter(item => typeof item?.id === "string");
    return visits.slice().sort((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0)).slice(0, Math.max(1, limit));
}

/** The agent chats the shown visits used (a continued chat once): what the Log reads. */
export function workflowAgentLogChats(node, limit = WORKFLOW_AGENT_LOG_VISITS) {
    return [...new Set(workflowAgentLogVisits(node, limit).map(visit => visit.agent?.childSessionId).filter(id => typeof id === "string" && id))];
}

/** A chat's events by the visit they belong to: each event goes to the visit whose prompt came last before it. */
function chatByVisit(events, visitIds, firstVisit) {
    const byVisit = new Map();
    let current = firstVisit;
    const sorted = (Array.isArray(events) ? events : []).filter(isRecord).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    for (const event of sorted) {
        const prompted = workflowPromptVisit(event);
        if (prompted && visitIds.has(prompted)) current = prompted;
        else if (prompted) current = null; // a visit the Log does not show (older): its events are not shown either
        if (current === null) continue;
        if (!byVisit.has(current)) byVisit.set(current, []);
        byVisit.get(current).push(event);
    }
    return byVisit;
}

const toolPreview = args => {
    if (!isRecord(args)) return firstCallLine(args);
    for (const key of ["command", "query", "path", "prompt", "message", "key", "key_pattern", "url"]) {
        if (args[key] !== undefined && args[key] !== null) return firstCallLine(typeof args[key] === "object" ? JSON.stringify(args[key]) : args[key]);
    }
    return firstCallLine(JSON.stringify(args));
};

/** The rows of one visit's chat events: prompts, answers, tool calls (one row per call) and the typed result. */
function chatRows(events, visitId) {
    const rows = [];
    const calls = new Map();
    const seenInstructions = new Set();
    for (const event of events) {
        const data = isRecord(event.data) ? event.data : {};
        const at = timeOf(event.createdAt);
        const base = { key: `chat:${event.sessionId ?? ""}:${event.seq}`, seq: event.seq ?? 0, at };
        if (event.eventType === "user.message") {
            const content = typeof data.content === "string" ? data.content : "";
            if (!content.trim()) continue;
            const own = workflowPromptVisit(event) === visitId;
            const from = typeof data.sender?.display === "string" && data.sender.display ? data.sender.display : null;
            rows.push({ ...base, kind: "prompt", label: own ? "Prompt" : `Message${from ? ` from ${from}` : ""}`, ...workflowLogFold(content) });
        } else if (event.eventType === "system.message") {
            const content = typeof data.content === "string" ? data.content : "";
            const instructions = workflowBaseInstructions(data);
            if (instructions) {
                // The same instructions once per visit (the SDK may compose them again at a later turn).
                const key = instructions.ref?.sha256 ?? `${instructions.chars}:${instructions.snippet}`;
                if (seenInstructions.has(key)) continue;
                seenInstructions.add(key);
                rows.push({ ...base, kind: "prompt", label: "Base instructions",
                    text: `${instructions.chars.toLocaleString("en-US")} characters: ${instructions.snippet}`, instructions: instructions.ref,
                    instructionsKept: instructions.ref !== null });
            } else if (content.trim()) rows.push({ ...base, kind: "prompt", label: "Note to the agent", ...workflowLogFold(content) });
        } else if (event.eventType === "assistant.message") {
            const content = typeof data.content === "string" ? data.content : "";
            if (content.trim()) rows.push({ ...base, kind: "agent", label: "Agent", ...workflowLogFold(content) });
        } else if (event.eventType === "tool.execution_start" || event.eventType === "tool.execution_complete") {
            const id = typeof data.toolCallId === "string" && data.toolCallId ? data.toolCallId : `seq:${event.seq}`;
            const known = calls.get(id);
            const name = data.toolName || data.name || known?.name || "tool";
            const args = data.arguments ?? data.args ?? known?.arguments;
            const row = known ?? { ...base, kind: "agent", label: "Tool", name, arguments: args };
            row.name = name;
            row.arguments = args;
            if (event.eventType === "tool.execution_complete") {
                row.result = data.result ?? data.output;
                row.failed = data.success === false || Boolean(data.error);
                if (data.error) row.error = data.error;
            }
            if (name === COMPLETE_TOOL) {
                row.kind = "result";
                row.label = "Typed result";
                const outcome = isRecord(args) ? (typeof args.outcome === "string" ? args.outcome : isRecord(args.error) ? args.error.code : null) : null;
                const output = isRecord(args) ? (args.output !== undefined ? args.output : isRecord(args.error) ? args.error.message : undefined) : undefined;
                row.text = `${outcome ?? "complete"}${output !== undefined ? ` · ${firstCallLine(typeof output === "string" ? output : JSON.stringify(output))}` : ""}`;
            } else {
                const preview = toolPreview(args);
                row.text = `${name}${preview ? ` — ${preview}` : ""}${row.failed ? " (failed)" : ""}`;
            }
            row.detail = [args !== undefined ? `Arguments\n${callText(args)}` : "", row.result !== undefined ? `Result\n${callText(row.result)}` : "",
                row.error ? `Error\n${callText(row.error)}` : ""].filter(Boolean).join("\n\n") || "No arguments or result were recorded.";
            if (!known) {
                calls.set(id, row);
                rows.push(row);
            }
        }
    }
    return rows;
}

/** The Workflow's own rows for one visit: its events that name the visit, in the Log's sentences. */
function workflowRows(events, runId, visitId) {
    const rows = [];
    for (const event of Array.isArray(events) ? events : []) {
        const data = isRecord(event?.data) ? event.data : {};
        if (data.nodeExecutionId !== visitId || (runId && data.runId && data.runId !== runId)) continue;
        const line = workflowEventText(event.eventType, data, "short");
        if (!line) continue;
        rows.push({ key: `wf:${event.seq}`, seq: event.seq ?? 0, at: timeOf(event.createdAt), kind: "workflow", label: "Workflow", text: line.text,
            level: line.level ?? "info" });
    }
    return rows;
}

/**
 * The Log of an agent node: { groups, more, partial, loading, note }. `chats` maps an agent chat's session id to its loaded events
 * (undefined: not read yet). Each group is { visitId, ordinal, header, status, rows, loading }; rows are { key, kind
 * (prompt, agent, result or workflow), label, text, more?, detail?, at, time }.
 */
export function workflowAgentNodeLog({ node, events = [], chats = new Map(), runId = null, limit = WORKFLOW_AGENT_LOG_VISITS, now = Date.now() } = {}) {
    const all = (Array.isArray(node?.executions) ? node.executions : []).filter(item => typeof item?.id === "string");
    const visits = workflowAgentLogVisits(node, limit);
    const shownIds = new Set(visits.map(visit => visit.id));
    const read = typeof chats?.get === "function" ? chats : new Map(Object.entries(chats ?? {}));
    // Each chat is cut once by the prompts of the visits shown; a visit with its own chat takes all of it.
    const cut = new Map();
    for (const chatId of new Set(visits.map(visit => visit.agent?.childSessionId).filter(Boolean))) {
        const own = visits.filter(visit => visit.agent?.childSessionId === chatId).sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
        const loaded = read.get(chatId);
        if (Array.isArray(loaded)) cut.set(chatId, chatByVisit(loaded, new Set(own.map(visit => visit.id)), own.length === 1 ? own[0].id : null));
    }
    let loading = false;
    const groups = visits.map(visit => {
        const chatId = visit.agent?.childSessionId ?? null;
        const waiting = Boolean(chatId) && !cut.has(chatId);
        if (waiting) loading = true;
        const chatEvents = chatId && cut.has(chatId) ? cut.get(chatId).get(visit.id) ?? [] : [];
        const sorted = [...chatRows(chatEvents, visit.id), ...workflowRows(events, runId, visit.id)]
            .map((row, index) => ({ ...row, order: index }))
            .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.order - b.order);
        // The base instructions come before the visit's own prompt (they are what the agent is, the prompt what it is asked).
        const base = sorted.findIndex(row => row.label === "Base instructions");
        const asked = sorted.findIndex(row => row.label === "Prompt");
        if (base > asked && asked >= 0) sorted.splice(asked, 0, ...sorted.splice(base, 1));
        const rows = sorted.map(({ order, ...row }) => ({ ...row, time: row.at === null ? null : workflowNodeClock(row.at, now) }));
        const started = visit.enteredAt ? workflowNodeClock(visit.enteredAt, now) : null;
        return {
            visitId: visit.id, ordinal: visit.ordinal ?? null, chatId, loading: waiting,
            header: `Visit ${visit.ordinal ?? "—"}${started ? ` · ${started}` : ""}`, status: workflowNodeNow(node, visit, now), rows,
        };
    });
    // `more`: older visits are loaded but not shown ("Show older visits"); `partial`: the run's loaded history has no older ones.
    return { groups, more: all.length > visits.length, partial: Boolean(node?.partial), loading, note: WORKFLOW_AGENT_LOG_NOTE };
}
