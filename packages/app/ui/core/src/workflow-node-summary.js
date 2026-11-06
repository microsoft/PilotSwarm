/**
 * The Node panel's summary (owner feedback 2026-11-06, finding 7: "There isn't much useful information in this box. I
 * don't know what I'm looking at."): what a node does in one sentence, where it is now in one line, how often it ran,
 * its last result as readable text, what an agent node's agent is told and how its chat works, and where each outcome
 * goes in words. One model for the portal and the TUI; plain words, no engine words ("runtime error route"), and no fact
 * said twice. Pure: `now` only decides whether a time shows its date.
 */
import { formatLocalTime, shortSessionId } from "./formatting.js";
import { formatSeconds, workflowV2AgentChatMode, workflowV2AgentTask, workflowV2RouteKind } from "./workflow-v2-view.js";

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => (typeof value === "string" && value.trim() ? value.trim() : null);
const timeOf = value => (typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN);

/** A time as people read it: the clock alone on the same day as `now`, else the date too (local time, as everywhere). */
export function workflowNodeClock(value, now = Date.now()) {
    const ms = timeOf(value);
    if (!Number.isFinite(ms)) return null;
    return formatLocalTime(ms, { clock: new Date(now).toDateString() === new Date(ms).toDateString() });
}

/** A duration in words: "4 s", "2 min 5 s", "1 h 3 min". */
export function workflowNodeDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    const total = Math.round(ms / 1000);
    if (total < 60) return `${total} s`;
    if (total < 3600) return `${Math.floor(total / 60)} min${total % 60 ? ` ${total % 60} s` : ""}`;
    const minutes = Math.floor((total % 3600) / 60);
    return `${Math.floor(total / 3600)} h${minutes ? ` ${minutes} min` : ""}`;
}

/** The first sentence of a prompt, on one line, at most `max` characters. */
export function workflowFirstSentence(value, max = 140) {
    const line = text(value)?.replace(/\s+/g, " ");
    if (!line) return null;
    const end = line.search(/[.!?](\s|$)/);
    const sentence = end >= 0 ? line.slice(0, end + 1) : line;
    return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

const party = value => (value === "parent" ? "the parent session" : value === null || value === undefined ? "any permitted sender"
    : typeof value === "string" && value.includes("${") ? `the session in ${value}` : `session ${shortSessionId(String(value))}`);
/** "a" or "an" before a word (a message type, read as written). */
const an = word => `${/^[aeiou]/i.test(String(word ?? "")) ? "an" : "a"} ${word}`;
const seconds = value => (typeof value === "number" ? formatSeconds(value) : value === undefined || value === null ? null : `the time in ${value}`);

/** What a node does, in one sentence: the definition's own description when it has one, else from its kind and fields. */
export function workflowNodeWhat(node) {
    const described = text(node?.about?.description);
    if (described) return described;
    const kind = node?.kind ?? (node?.type === "messaging" ? node.mode : node?.type);
    switch (kind) {
        case "agent": {
            if (node.invoke?.source === "agent") return `Asks agent ${workflowV2AgentTask(node)} to do its task with the node's input.`;
            const first = workflowFirstSentence(node.about?.prompt);
            return first ? `Asks an agent: “${first}”` : "Asks an agent to do the task in its prompt.";
        }
        case "script": return `Runs the script ${node.id}${Number.isFinite(node.timeoutSeconds) ? `, for at most ${formatSeconds(node.timeoutSeconds)}` : ""}.`;
        case "wait": return typeof node.seconds === "number" ? `Waits ${formatSeconds(node.seconds)}.` : `Waits for ${seconds(node.seconds) ?? "a time"}.`;
        case "send": return `Sends ${an(node.contract)} message to ${party(node.recipient)}.`;
        case "request": {
            const limit = seconds(node.timeoutSeconds);
            return `Asks ${party(node.recipient)} ${an(node.contract)} question and waits${limit ? ` up to ${limit}` : ""} for the answer.`;
        }
        case "receive": {
            const limit = seconds(node.waitSeconds);
            return `Waits for ${an(node.contract)} message from ${party(node.from)}${limit ? `, for at most ${limit}` : ""}.`;
        }
        case "parallel": return `Runs its branch for each item, ${node.concurrency > 1 ? `up to ${node.concurrency} at a time` : "one at a time"}, then joins them.`;
        case "terminal": return typeof node.parallel === "string" ? `Ends the branch: ${node.outcome}.` : `Ends the Workflow: ${node.outcome === "cancelled" ? "canceled" : node.outcome}.`;
        default: return null;
    }
}

const errorOf = preview => {
    if (typeof preview !== "string") return isRecord(preview) ? preview : null;
    try { const parsed = JSON.parse(preview); return isRecord(parsed) ? parsed : null; } catch { return null; }
};

/**
 * A result preview as people read it (owner: "the fact text, not only 'produced'"): a string as itself; an object with
 * one text field as that text; a few plain fields as "name: value" lines; anything else as indented JSON. A preview that
 * was cut short is shown as it arrived and says so. Null for no value.
 */
export function workflowReadableValue(preview) {
    if (preview === undefined || preview === null || preview === "") return null;
    const raw = typeof preview === "string" ? preview : JSON.stringify(preview);
    let value;
    try { value = JSON.parse(raw); } catch { return { text: raw, truncated: raw.endsWith("…") }; }
    if (value === null) return null;
    if (typeof value === "string") return { text: value, truncated: false };
    if (typeof value !== "object") return { text: String(value), truncated: false };
    if (!Array.isArray(value)) {
        const entries = Object.entries(value);
        if (entries.length === 1 && typeof entries[0][1] === "string") return { text: entries[0][1], truncated: false };
        if (entries.length > 0 && entries.length <= 6 && entries.every(([, item]) => item === null || typeof item !== "object")) {
            return { text: entries.map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n"), truncated: false };
        }
    }
    return { text: JSON.stringify(value, null, 2), truncated: false };
}

/** The visit whose result is shown: the given one when it ended, else the latest ended visit (by visit number). */
function lastEnded(node, execution) {
    if (execution?.status === "completed") return execution;
    const ended = (Array.isArray(node?.executions) ? node.executions : []).filter(item => item?.status === "completed");
    return ended.reduce((best, item) => (!best || (item.ordinal ?? 0) > (best.ordinal ?? 0) ? item : best), null);
}

const ENDED_WORDS = { cancelled: "Canceled", timed_out: "Time limit passed", stopped: "Stopped" };

/** Where the node is now, in one line ("Agent working since 17:40:01 · time limit 17:41:34", "Done 17:40:04 · produced"). */
export function workflowNodeNow(node, execution, now = Date.now()) {
    if (node?.notReached) return "Not reached yet in this item's visit.";
    if (!execution) return node?.runs ? null : "Not reached yet.";
    const at = value => workflowNodeClock(value, now);
    const since = execution.enteredAt ? ` since ${at(execution.enteredAt)}` : "";
    const limit = execution.deadline ? at(execution.deadline) : null;
    if (execution.status === "pending") {
        switch (node.kind) {
            case "agent": return `Agent working${since}${limit ? ` · time limit ${limit}` : ""}`;
            case "wait": return limit ? `Waiting until ${limit}` : `Waiting${since}`;
            case "receive": return `Waiting for a message${since}${limit ? ` · gives up ${limit}` : ""}`;
            case "request": return `Waiting for the answer${since}${limit ? ` · time limit ${limit}` : ""}`;
            case "send": return `Sending${since}`;
            case "parallel": return `Running its branches${since}${limit ? ` · time limit ${limit}` : ""}`;
            default: return `Running${since}${limit ? ` · time limit ${limit}` : ""}`;
        }
    }
    const ended = execution.endedAt ? ` ${at(execution.endedAt)}` : "";
    if (node.type === "terminal") return `Reached${ended}`;
    if (execution.resultKind === "runtime_error") {
        if (ENDED_WORDS[execution.outcome]) return `${ENDED_WORDS[execution.outcome]}${ended}`;
        const error = errorOf(execution.errorPreview);
        const why = text(error?.message) ?? (execution.effectStatus ? `the action ${execution.effectStatus}` : null);
        return `Failed${ended}${why ? ` · ${workflowFirstSentence(why, 160)}` : ""}`;
    }
    return `Done${ended}${execution.outcome ? ` · ${execution.outcome}` : ""}`;
}

/** How often the node ran ("Ran 4 times · last 17:42:01–17:42:05 (4 s)"), or its current visit. */
export function workflowNodeRuns(node, execution, now = Date.now()) {
    const count = Number.isSafeInteger(node?.runs) ? node.runs : 0;
    if (!count) return null;
    const loaded = node.partial ? " in the loaded history" : "";
    const start = execution?.enteredAt ? workflowNodeClock(execution.enteredAt, now) : null;
    if (execution?.status === "pending") return `Visit ${count}${loaded}${start ? ` · started ${start}` : ""}`;
    const times = `Ran ${count} ${count === 1 ? "time" : "times"}${loaded}`;
    if (!start || !execution?.endedAt) return times;
    const took = workflowNodeDuration(timeOf(execution.endedAt) - timeOf(execution.enteredAt));
    return `${times} · last ${start}–${workflowNodeClock(execution.endedAt, now)}${took ? ` (${took})` : ""}`;
}

/** The last result as readable text: a node's output, an error's message, a message it sent or took. */
export function workflowNodeResult(node, execution) {
    const ended = lastEnded(node, execution);
    if (!ended) return null;
    if (ended.resultKind === "runtime_error") {
        const error = errorOf(ended.errorPreview);
        const message = text(error?.message);
        const value = message ? { text: `${message}${text(error?.code) ? ` (${error.code})` : ""}`, truncated: false }
            : workflowReadableValue(ended.errorPreview);
        return value ? { label: ended.outcome === "cancelled" ? "Why it was canceled" : "What went wrong", ...value, executionId: ended.id ?? null, error: true } : null;
    }
    const sent = node.kind === "send" ? ended.outbox?.payloadPreview : undefined;
    const taken = node.kind === "receive" ? ended.inbox?.payloadPreview : undefined;
    const value = workflowReadableValue(ended.outputPreview ?? sent ?? taken);
    if (!value) return null;
    return { label: sent !== undefined ? "Last message sent" : taken !== undefined ? "Last message taken" : "Last result", ...value,
        executionId: ended.id ?? null, error: false };
}

/** Its agent chat: the one the shown visit uses, else the latest visit's. */
function chatOf(node, execution) {
    if (execution?.agent?.childSessionId) return execution.agent.childSessionId;
    const visits = (Array.isArray(node?.executions) ? node.executions : []).filter(item => item?.agent?.childSessionId);
    const latest = visits.reduce((best, item) => (!best || (item.ordinal ?? 0) > (best.ordinal ?? 0) ? item : best), null);
    return latest?.agent.childSessionId ?? null;
}

/** An error route in words, for the Next lines. */
const ROUTE_WORDS = {
    failure: "If it fails", timed_out: "If its time limit passes", needs_input: "If the agent needs a decision", execution_failed: "If the agent cannot do it",
    invalid_output: "If its result does not fit", unavailable: "If it cannot start", forbidden: "If it is not allowed", delivery_failed: "If the message cannot be delivered",
    cancelled: "If it is canceled",
};

/** Where each outcome goes, in words, and what happens when it fails with no route for that. */
export function workflowNodeNext(node) {
    if (!node || node.type === "terminal") return { lines: [], failure: null };
    const lines = Object.entries(isRecord(node.next) ? node.next : {}).map(([label, target]) => {
        const kind = workflowV2RouteKind(node, label);
        const words = kind === "outcome" ? label : ROUTE_WORDS[label] ?? `If ${label.replace(/_/g, " ")}`;
        return { label, target, kind, text: `${words} → ${target}` };
    });
    const caught = Object.hasOwn(node.next ?? {}, "failure");
    const ends = typeof node.parallel === "string" ? "its item ends" : "the Workflow stops";
    const failure = caught ? null : lines.some(line => line.kind === "error") ? `If it fails another way: ${ends}.` : `If it fails: ${ends}.`;
    return { lines, failure };
}

/**
 * The whole summary of a node for the Node panel: { what, now, runs, result, agent, next }. `execution` is the visit
 * shown (a branch step's chosen branch, else the node's current visit).
 */
export function workflowNodeSummary(node, { execution = node?.current ?? null, now = Date.now() } = {}) {
    if (!node) return null;
    const agent = node.kind === "agent" ? {
        chatMode: workflowV2AgentChatMode(node),
        told: node.invoke?.source === "agent" ? null : text(node.about?.prompt),
        toldWords: node.invoke?.source === "agent"
            ? `Agent ${workflowV2AgentTask(node)} follows its own instructions, with the node's input.` : null,
        chatSessionId: chatOf(node, execution),
    } : null;
    return {
        what: workflowNodeWhat(node), now: workflowNodeNow(node, execution, now), runs: workflowNodeRuns(node, execution, now),
        result: workflowNodeResult(node, execution), agent, next: workflowNodeNext(node),
    };
}
