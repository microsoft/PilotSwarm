/**
 * The Node panel's summary (owner feedback 2026-11-06, finding 7: "There isn't much useful information in this box. I
 * don't know what I'm looking at."): what a node does in one sentence, where it is now in one line, how often it ran,
 * its last result as readable text, what an agent node's agent is told and how its session works, and where each outcome
 * goes in words. One model for the portal and the TUI; plain words, no engine words ("runtime error route"), and no fact
 * said twice. Pure: `now` only decides whether a time shows its date.
 */
import { shortSessionId } from "./formatting.js";
import { formatSeconds, workflowAgentSessionMode, workflowAgentTask, workflowAgentTools, workflowAgentToolsTitle, workflowRouteKind } from "./workflow-view.js";
import { workflowErrorParts, workflowErrorLeavesOut, workflowServerErrorWords } from "./workflow-error-words.js";
import { workflowAskAnswerWords, workflowDuration, workflowErrorRouteWords, workflowFailureDetail, workflowOutcomeWord, workflowRunsText, workflowShortTime } from "./workflow-words.js";

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => (typeof value === "string" && value.trim() ? value.trim() : null);
const timeOf = value => (typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN);

/** A time as people read it (workflowShortTime): the clock alone on the same day as `now`, else the date too; no zone. */
export function workflowNodeClock(value, now = Date.now()) {
    const ms = timeOf(value);
    return Number.isFinite(ms) ? workflowShortTime(ms, now) : null;
}

/** A duration (workflowDuration): "820 ms", "4 s", "2 min 5 s", "1 h 3 min". */
export const workflowNodeDuration = workflowDuration;

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

/** The name of the named branch a step is in, or null (a For each's step, or a step outside a parallel step). */
const branchNameOf = node => (typeof node?.branchName === "string" && node.branchName ? node.branchName : null);

/** What a node does, in one sentence: the definition's own description when it has one, else from its kind and fields. */
export function workflowNodeWhat(node) {
    const described = text(node?.about?.description);
    if (described) return described;
    const kind = node?.kind ?? (node?.type === "messaging" ? node.mode : node?.type);
    switch (kind) {
        case "agent": {
            if (node.invoke?.source === "agent") return `Asks agent ${workflowAgentTask(node)} to do its task with the node's input.`;
            const first = workflowFirstSentence(node.about?.prompt);
            return first ? `Asks an agent: “${first}”` : "Asks an agent to do the task in its prompt.";
        }
        case "script": return `Runs the script ${node.id}${Number.isFinite(node.timeoutSeconds) ? `, for at most ${formatSeconds(node.timeoutSeconds)}` : ""}.`;
        case "approval": return `Asks the Workflow owner: ${node.question ?? "Read the proposal and decide."}`;
        case "wait": return typeof node.seconds === "number" ? `Waits ${formatSeconds(node.seconds)}.`
            // Stage 2.4: a clock wait waits until a time of day, a weekday or a day of the month, in its time zone.
            : typeof node.until === "string" ? `Waits until ${node.until}.`
            : `Waits for ${seconds(node.seconds) ?? "a time"}.`;
        case "send": return `Sends ${an(node.contract)} message to ${party(node.recipient)}.`;
        case "request": {
            const limit = seconds(node.timeoutSeconds);
            return `Asks ${party(node.recipient)} ${an(node.contract)} question and waits${limit ? ` up to ${limit}` : ""} for the answer.`;
        }
        case "receive": {
            const limit = seconds(node.waitSeconds);
            return `Waits for ${an(node.contract)} message from ${party(node.from)}${limit ? `, for at most ${limit}` : ""}.`;
        }
        // Named branches by their names, and a named branch's end.
        case "parallel": return Array.isArray(node.namedBranches)
            ? `Runs its branches (${node.namedBranches.map(item => item.name).join(", ")}) ${node.concurrency >= node.namedBranches.length ? "all at once"
                : node.concurrency > 1 ? `up to ${node.concurrency} at a time` : "one at a time"}, then joins them.`
            : `Runs its nodes for each item, ${node.concurrency > 1 ? `up to ${node.concurrency} at a time` : "one at a time"}, then joins them.`;
        case "terminal": return `Ends ${typeof node.parallel !== "string" ? "the Workflow" : branchNameOf(node) ? `branch ${branchNameOf(node)}` : "the item"}: `
            + `${workflowOutcomeWord(node.outcome)}.`;
        default: return null;
    }
}

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

/**
 * The visit whose result is shown (review UI-3): the given one when it ended; else the selected item's own latest ended
 * visit when the caller names it (`ended`, null: none yet); none for a step its item's visit has not reached; for a
 * For each step with no item chosen, the latest ended visit of the For each's shown visit (the view's `result`, never an
 * earlier visit's); else, for a step outside a For each, its latest ended visit (by visit number: they count in one scope).
 */
function lastEnded(node, execution, ended = undefined) {
    if (node?.notReached) return null;
    if (execution?.status === "completed") return execution;
    if (ended !== undefined) return ended?.status === "completed" ? ended : null;
    if (typeof node?.parallel === "string") return node.result?.status === "completed" ? node.result : null;
    const done = (Array.isArray(node?.executions) ? node.executions : []).filter(item => item?.status === "completed");
    return done.reduce((best, item) => (!best || (item.ordinal ?? 0) > (best.ordinal ?? 0) ? item : best), null);
}

/** Words joined as a Workflow value is: "Running · since 17:40:01 · limit 17:41:34" (an empty part is left out). */
const line = (...parts) => parts.filter(Boolean).join(" · ");

/**
 * Where the node is now, in one line (OF-S2-2 part 2): its state in one word, then its one fact and its times: "Running ·
 * since 17:40:01 · limit 17:41:34", "Done · produced · 17:40:04", "Failed · time limit · 17:40:04". A failure's words are
 * the result's (workflowNodeResult), never said twice.
 */
export function workflowNodeNow(node, execution, now = Date.now()) {
    if (node?.notReached) return "Not reached";
    if (!execution) return node?.runs ? null : "Not reached";
    const at = value => workflowNodeClock(value, now);
    const since = execution.enteredAt ? `since ${at(execution.enteredAt)}` : null;
    const limit = execution.deadline ? `limit ${at(execution.deadline)}` : null;
    if (execution.status === "pending") {
        switch (node.kind) {
            case "approval": return line("Waiting for owner approval", "Read and answer directly in the portal", limit);
            case "wait": return execution.deadline ? line("Waiting", `until ${at(execution.deadline)}`) : line("Waiting", since);
            case "receive": return line("Waiting", "for a message", since, limit);
            // Review 18:45Z: an Ask waits for its answer; a message queued at its recipient is sent (accepted, not read).
            case "request": return line(workflowAskAnswerWords(null, true), since, limit);
            case "send": return execution.outbox?.state === "delivered" ? line("Sent", "queued at recipient", since) : line("Sending", since);
            // A For each says how many of its items succeeded, as its card does.
            case "parallel": return line("Running", /^\d+\/\d+ ok$/.test(node.card?.fact ?? "") ? node.card.fact : null, since, limit);
            default: return line("Running", since, limit);
        }
    }
    const ended = execution.endedAt ? at(execution.endedAt) : null;
    if (node.type === "terminal") return line("Reached", ended);
    if (node.kind === "request" && workflowAskAnswerWords(execution.outcome)) return line(workflowAskAnswerWords(execution.outcome), ended);
    if (execution.resultKind === "runtime_error") {
        if (execution.outcome === "cancelled" || execution.outcome === "stopped") return line("Canceled", ended);
        // The shortest reason; with no error words, what happened to its action.
        const reason = workflowFailureDetail(execution.outcome);
        const action = !execution.outcome && !workflowServerErrorWords(execution) && execution.effectStatus ? `action ${execution.effectStatus}` : null;
        return line("Failed", action ?? reason, ended);
    }
    return line("Done", execution.outcome ? workflowOutcomeWord(execution.outcome) : null, ended);
}

/** How often the node ran, in numbers (OF-S2-2 part 2): "4 · last 4 s at 17:42:01"; "126+" when older runs are not loaded. */
export function workflowNodeRuns(node, execution, now = Date.now()) {
    const count = Number.isSafeInteger(node?.runs) ? node.runs : 0;
    if (!count) return null;
    const runs = workflowRunsText(count, Boolean(node.partial));
    // A run at work: its start is in Now.
    if (execution?.status === "pending" || !execution?.enteredAt || !execution?.endedAt) return runs;
    const took = workflowNodeDuration(timeOf(execution.endedAt) - timeOf(execution.enteredAt));
    const start = workflowNodeClock(execution.enteredAt, now);
    return took && start ? `${runs} · last ${took} at ${start}` : runs;
}

/** The last result as readable text: a node's output, an error's message, a message it sent or took. */
export function workflowNodeResult(node, execution, { ended: itemEnded = undefined } = {}) {
    const ended = lastEnded(node, execution, itemEnded);
    if (!ended) return null;
    if (ended.resultKind === "runtime_error") {
        // In plain words (workflowErrorWords), with the error's code; the whole error is read on request. Review UI-D7:
        // words that leave out recorded detail are a summary, and the whole error stays readable (`truncated`, `summary`).
        const parts = workflowErrorParts(ended.errorPreview);
        const words = workflowServerErrorWords(ended);
        const leavesOut = words ? workflowErrorLeavesOut(ended.errorPreview, words) : false;
        const value = words ? { text: `${words}${parts?.code && parts.code !== words ? ` · ${parts.code}` : ""}`, truncated: leavesOut,
            ...(leavesOut ? { summary: true } : {}) }
            : workflowReadableValue(ended.errorPreview);
        return value ? { label: ended.outcome === "cancelled" ? "Why canceled" : "Error", ...value, executionId: ended.id ?? null, error: true } : null;
    }
    const sent = node.kind === "send" ? ended.outbox?.payloadPreview : undefined;
    const taken = node.kind === "receive" ? ended.inbox?.payloadPreview : undefined;
    const value = workflowReadableValue(ended.outputPreview ?? sent ?? taken);
    if (!value) return null;
    return { label: sent !== undefined ? "Message sent" : taken !== undefined ? "Message taken" : "Result", ...value,
        executionId: ended.id ?? null, error: false };
}

/** What a For each step without a result of its own says (review UI-3); null elsewhere. */
function noResultText(node, execution, ended) {
    if (!node || node.notReached || node.type === "terminal") return null;
    if (lastEnded(node, execution, ended)) return null;
    if (ended !== undefined) return "No result yet";
    return typeof node.parallel === "string" && node.runs ? "No result yet" : null;
}

/** Its agent session: the one the shown visit uses, else the latest visit's. */
function chatOf(node, execution) {
    if (execution?.agent?.childSessionId) return execution.agent.childSessionId;
    const visits = (Array.isArray(node?.executions) ? node.executions : []).filter(item => item?.agent?.childSessionId);
    const latest = visits.reduce((best, item) => (!best || (item.ordinal ?? 0) > (best.ordinal ?? 0) ? item : best), null);
    return latest?.agent.childSessionId ?? null;
}

/**
 * Where each outcome goes, and what happens when it fails with no route for that (OF-S2-2 part 2): an outcome by its
 * name ("generated → send_joke"), an error route with the error mark the graph's edges use ("✕ limit → retry"),
 * then "✕ error → Workflow fails" ("✕ other errors → item ends" when some errors are routed).
 */
export function workflowNodeNext(node) {
    if (!node || node.type === "terminal") return { lines: [], failure: null };
    const lines = Object.entries(isRecord(node.next) ? node.next : {}).map(([label, target]) => {
        const kind = workflowRouteKind(node, label);
        const words = kind === "outcome" ? label : workflowErrorRouteWords(label);
        return { label, target, kind, text: `${words} → ${target}`,
            ...(typeof node.routeNotes?.[label] === "string" ? { notes: node.routeNotes[label] } : {}) };
    });
    const caught = Object.hasOwn(node.next ?? {}, "failure");
    const ends = typeof node.parallel !== "string" ? "Workflow fails" : branchNameOf(node) ? "branch ends" : "item ends";
    const failure = caught ? null : `✕ ${lines.some(entry => entry.kind === "error") ? "other errors" : "error"} → ${ends}`;
    return { lines, failure };
}

/**
 * The whole summary of a node for the Node panel: { what, now, runs, result, agent, next }. `execution` is the visit
 * shown (a branch step's chosen branch, else the node's current visit).
 */
export function workflowNodeSummary(node, { execution = node?.current ?? null, ended = undefined, now = Date.now() } = {}) {
    if (!node) return null;
    const agent = node.kind === "agent" ? {
        sessionMode: workflowAgentSessionMode(node),
        tools: workflowAgentTools(node),
        toolsTitle: workflowAgentToolsTitle(node),
        told: node.invoke?.source === "agent" ? null : text(node.about?.prompt),
        toldWords: node.invoke?.source === "agent"
            ? `Agent ${workflowAgentTask(node)} follows its own instructions, with the node's input.` : null,
        sessionId: chatOf(node, execution),
        // OF-S2-7: the model it uses ("azure:gpt-5 · low reasoning · chosen at start", or "… · from the session").
        model: node.model?.value ?? null,
    } : null;
    return {
        what: workflowNodeWhat(node), now: workflowNodeNow(node, execution, now), runs: workflowNodeRuns(node, execution, now),
        ...(typeof node.about?.notes === "string" ? { notes: node.about.notes } : {}),
        runsTitle: node.partial && node.runs ? "Older visits not loaded" : null,
        result: workflowNodeResult(node, execution, { ended }), agent, next: workflowNodeNext(node),
        // A chosen item (`ended` given) or a For each step that has no result of its own here says so (review UI-3).
        noResult: noResultText(node, execution, ended),
    };
}
