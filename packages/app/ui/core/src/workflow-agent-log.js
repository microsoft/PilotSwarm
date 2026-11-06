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
import { sha256Hex } from "./sha256.js";

/** How many visits the Log shows before "Show older visits"; how long a text is before it folds. */
export const WORKFLOW_AGENT_LOG_VISITS = 10;
export const WORKFLOW_AGENT_LOG_FOLD = 600;
/** The Log's one line about what its rows are (finding 8). */
export const WORKFLOW_AGENT_LOG_NOTE = "Prompt rows are what the agent was given, its base instructions first; Agent rows are what it did.";

/** The summary the runtime records for the SDK's echo of the full system prompt (session-proxy summarizeSdkSystemPromptEchoEvent). */
/** What a reader who is not the Workflow's owner sees in an opened Base instructions row (review SF-3). */
export const WORKFLOW_BASE_INSTRUCTIONS_OWNER_ONLY = "Only this Workflow's owner can read the whole text.";

/**
 * Whether the signed-in viewer may read a Workflow's whole base instructions: its owner or an admin (session:manage),
 * as the portal's Workflow read reports it on every read (`ownerOnlyArtifacts.readable`, review SF-D4; earlier reads
 * carried only `personCommands.viewer`, present when the deployment takes a person's commands). A share reads the
 * summary row only (review SF-3); the server refuses the file to it whatever this says. Fail closed: a read with no
 * decision (not read yet, an older server) shows the owner-only summary and asks for no file.
 */
export function workflowBaseInstructionsReadable(readModel) {
    if (!isRecord(readModel)) return false;
    if (isRecord(readModel.ownerOnlyArtifacts) && typeof readModel.ownerOnlyArtifacts.readable === "boolean") return readModel.ownerOnlyArtifacts.readable;
    const viewer = isRecord(readModel.personCommands) ? readModel.personCommands.viewer : null;
    return isRecord(viewer) && viewer.allowed === true;
}

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
    // The whole digest is what the shown text is checked against (review SF-4); the artifact is the one it names.
    const sha256 = kept && typeof kept.sha256 === "string" && /^[0-9a-f]{64}$/.test(kept.sha256) ? kept.sha256 : null;
    const ref = kept && sha256 && typeof kept.sessionId === "string" && kept.artifact === `base-instructions-${sha256.slice(0, 16)}.md`
        ? { sessionId: kept.sessionId, artifact: kept.artifact, sha256 } : null;
    return { chars: Number(found[1]), snippet: found[2], ref };
}

/** What an opened Base instructions row says when the file no longer holds the recorded text (review SF-4). */
export const WORKFLOW_BASE_INSTRUCTIONS_CHANGED = "These base instructions changed since they were recorded, so they are not shown.";

const checkedTexts = new Map();

/**
 * Whether `text`, read from the file a Base instructions row names, is the text the runtime recorded: its sha256 is the
 * row's (`ref.sha256`, the whole digest; review SF-4). The text is shown only then. Pure (the digests of the last few
 * texts are remembered).
 */
export function workflowBaseInstructionsMatch(ref, text) {
    if (!isRecord(ref) || typeof ref.sha256 !== "string" || typeof text !== "string") return false;
    let digest = checkedTexts.get(text);
    if (digest === undefined) {
        digest = sha256Hex(text);
        if (checkedTexts.size >= 16) checkedTexts.clear();
        checkedTexts.set(text, digest);
    }
    return digest === ref.sha256;
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

/**
 * A chat's events by the visit they belong to: each event goes to the visit whose prompt came last before it. Events
 * loaded before any prompt of a shown visit belong to `firstVisit` (leadingVisit; reviews UI-10, UI-D5: a visit only on
 * evidence, else EARLIER), never dropped.
 */
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
 * Review UI-D6: what the Log offers for a chat's older lines, from its coverage entry { hasOlder, cap?, error? }: null
 * when nothing older exists; else { action: "load" | "retry" | null, text }. `cap`: the history window's limit, reached
 * (Load older makes no progress past it, so it is not offered and the Log says so); `error`: the last older-page read
 * failed (shown, with Retry).
 */
export function workflowAgentLogOlder(entry) {
    if (!isRecord(entry) || entry.hasOlder !== true) return null;
    if (Number.isSafeInteger(entry.cap) && entry.cap > 0) {
        return { action: null, text: `The Log reads at most the newest ${entry.cap.toLocaleString("en-US")} events of a chat, so this chat's older lines are not shown.` };
    }
    if (typeof entry.error === "string" && entry.error.trim()) return { action: "retry", text: `Older lines could not be read: ${entry.error.trim()}` };
    return { action: "load", text: null };
}

/** The key of a chat's rows whose visit is not known (review UI-D5): they come before the first prompt loaded. */
const EARLIER = Symbol("earlier in this chat");

/**
 * The visit the rows that start a chat's loaded window belong to, before its first loaded prompt (reviews UI-10, UI-D5).
 * `own`: the shown visits of the chat, oldest first; `single`: the chat serves one visit only (a new chat each visit, or
 * the run's whole history holds one visit of it).
 * - The window starts at a prompt: none (null).
 * - A shown visit's prompt comes first, with a shown visit before it whose prompt was given to the chat (its invocation
 *   is recorded spawned): that earlier visit (the rows come after its prompt, which is on an older page, and before the
 *   next one). Review UI-F3: a visit before it that never got its prompt (spawned false, e.g. it timed out first) is no
 *   evidence, so the rows are not given to it, nor guessed further back.
 * - Otherwise a chat that serves one visit: that visit.
 * - Otherwise which visit they belong to is not known: EARLIER (the Log shows them apart until their prompt is loaded),
 *   never guessed from the newest visit.
 */
function leadingVisit(events, own, single) {
    const sorted = (Array.isArray(events) ? events : []).filter(isRecord).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const ids = own.map(visit => visit.id);
    for (const event of sorted) {
        const prompted = workflowPromptVisit(event);
        if (!prompted) continue;
        if (sorted[0] === event) return null;
        const at = ids.indexOf(prompted);
        if (at > 0) return own[at - 1].agent?.spawned === true ? ids[at - 1] : EARLIER;
        return at === 0 && single ? ids[0] : EARLIER;
    }
    return single && ids.length === 1 ? ids[0] : EARLIER;
}

/**
 * The Log of an agent node: { groups, earlier, more, partial, loading, note }. `chats` maps an agent chat's session id to its loaded events
 * (undefined: not read yet); `coverage` maps it to { hasOlder, cap?, error? } (the chat has events older than those loaded;
 * the history window's limit, reached; the last older-page read's error: workflowAgentLogOlder, review UI-D6). Each
 * group is { visitId, ordinal, header, status, rows, loading, truncated }: `truncated` when the start of the visit's
 * chat (its prompt) is not loaded and older chat events exist (review UI-10: the Log says so and offers Load older,
 * never shows such a group as a complete visit). rows are { key, kind (prompt, agent, result or workflow), label, text,
 * more?, detail?, at, time }; a continued chat's visit without its own Base instructions row carries the reference of
 * the nearest earlier loaded visit's ("the same as visit N"), without its text.
 */
export function workflowAgentNodeLog({ node, events = [], chats = new Map(), coverage = new Map(), runId = null, limit = WORKFLOW_AGENT_LOG_VISITS,
    now = Date.now() } = {}) {
    const all = (Array.isArray(node?.executions) ? node.executions : []).filter(item => typeof item?.id === "string");
    const visits = workflowAgentLogVisits(node, limit);
    const shownIds = new Set(visits.map(visit => visit.id));
    const read = typeof chats?.get === "function" ? chats : new Map(Object.entries(chats ?? {}));
    const covered = typeof coverage?.get === "function" ? coverage : new Map(Object.entries(coverage ?? {}));
    // Each chat is cut once by the prompts of the visits shown; a visit with its own chat takes all of it. Review UI-D5: a
    // continued chat's rows before its first loaded prompt go to a visit only on evidence; otherwise they are shown apart.
    const cut = new Map();
    for (const chatId of new Set(visits.map(visit => visit.agent?.childSessionId).filter(Boolean))) {
        const own = visits.filter(visit => visit.agent?.childSessionId === chatId).sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
        const single = node?.chat !== "continue"
            || (all.filter(visit => visit.agent?.childSessionId === chatId).length === 1 && !node?.partial);
        const loaded = read.get(chatId);
        if (Array.isArray(loaded)) cut.set(chatId, chatByVisit(loaded, new Set(own.map(visit => visit.id)), leadingVisit(loaded, own, single)));
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
        // UI-10: the visit's start (its prompt) is not loaded while the chat has older events: the group is not complete.
        const truncated = !waiting && Boolean(chatId) && covered.get(chatId)?.hasOlder === true && !rows.some(row => row.label === "Prompt");
        return {
            visitId: visit.id, ordinal: visit.ordinal ?? null, chatId, loading: waiting, truncated, older: truncated ? workflowAgentLogOlder(covered.get(chatId)) : null,
            header: `Visit ${visit.ordinal ?? "—"}${started ? ` · ${started}` : ""}`, status: workflowNodeNow(node, visit, now), rows,
        };
    });
    // UI-10: a continued chat's later visits carry the base instructions the chat had at an earlier visit (one row, no text).
    // Review UI-11: the same base instructions (by their whole digest) are shown once, at the oldest visit that has them;
    // a later row says which visit shows them. Review UI-D9: every Base instructions row of a visit counts, in recorded
    // order: each distinct digest is shown in full once; a reference names which of a visit's instructions it means when
    // that visit has more than one; a visit with none carries the chat's last ones.
    const byOrdinal = groups.slice().sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    const lastBase = new Map();
    const shownBySha = new Map();
    const where = from => `visit ${from.ordinal ?? "—"}${from.count > 1 ? `, its instructions ${from.number} of ${from.count}` : ""}`;
    for (const group of byOrdinal) {
        const at = group.rows.flatMap((row, index) => row.label === "Base instructions" ? [index] : []);
        const shas = [...new Set(at.map(index => group.rows[index].instructions?.sha256 ?? null).filter(Boolean))];
        let last = null;
        for (const index of at) {
            const own = group.rows[index];
            const sha = own.instructions?.sha256 ?? null;
            if (sha && shownBySha.has(sha)) {
                const from = shownBySha.get(sha);
                group.rows[index] = { ...own, text: `The same as ${where(from)}.`, carriedFrom: from.ordinal, carriedNumber: from.number, instructions: null };
                last = { row: own, from };
                continue;
            }
            const from = { ordinal: group.ordinal ?? null, number: sha ? shas.indexOf(sha) + 1 : 1, count: shas.length };
            if (sha) shownBySha.set(sha, from);
            last = { row: own, from };
        }
        if (last) {
            lastBase.set(group.chatId, last);
            continue;
        }
        const earlier = group.chatId ? lastBase.get(group.chatId) : null;
        if (!earlier || group.loading) continue;
        const prompt = group.rows.findIndex(row => row.label === "Prompt");
        const carried = { key: `carried:${group.visitId}`, kind: "prompt", label: "Base instructions", at: null, time: null,
            text: `The same as ${where(earlier.from)} (this chat continues).`, carriedFrom: earlier.from.ordinal ?? null,
            carriedNumber: earlier.from.number, instructions: null, instructionsKept: earlier.row.instructionsKept === true };
        group.rows.splice(prompt >= 0 ? prompt : 0, 0, carried);
    }
    // Review UI-D5: a continued chat's loaded rows whose visit is not known yet (its prompt is on an older page): shown
    // apart, oldest last, until Load older reaches a prompt. { chatId, header, rows, hasOlder }.
    const earlier = [...cut.entries()].flatMap(([chatId, byVisit]) => {
        const rows = byVisit.has(EARLIER) ? chatRows(byVisit.get(EARLIER), null) : [];
        return rows.length ? [{ chatId, header: "Earlier in this chat · visit not loaded", hasOlder: covered.get(chatId)?.hasOlder === true,
            older: workflowAgentLogOlder(covered.get(chatId)),
            rows: rows.map(row => ({ ...row, time: row.at === null ? null : workflowNodeClock(row.at, now) })) }] : [];
    });
    // `more`: older visits are loaded but not shown ("Show older visits"); `partial`: the run's loaded history has no older ones.
    return { groups, earlier, more: all.length > visits.length, partial: Boolean(node?.partial), loading, note: WORKFLOW_AGENT_LOG_NOTE };
}
