import { formatLocalTime } from "./formatting.js";

/**
 * The Workflow words (owner, 2026-11-07T17:47Z, OF-S2-2: "less verbose … simple numbers / icons … super crisp (and
 * consistent)"). One place for the marks, counts and short facts a Workflow screen shows, so every screen says a state, a
 * visit count or a time the same way. Every short form has its words in a tooltip and for screen readers.
 *
 * The vocabulary (OF-S2-2 part 2, reviews 18:45Z and 19:10Z): a node's execution is a "visit" ("Visits 5", "Visit 4 ·
 * 08:25:01"; a tooltip may say "Ran 126 times"), the whole is a "Workflow"; a For each runs its nodes once per "item"
 * ("k/n ok"); a graph has "nodes"; a time limit reads "limit" where it shows ("✕ limit"), "Time limit" in tooltips. A state
 * is one word; its detail follows " · ".
 */

/**
 * A Workflow's states, one word each. Review 18:45Z (D-W1): a stop either way reads Canceled; how it was stopped is its
 * tooltip ("Canceled after started nodes finished", "Canceled at once"). "Not certain": its status could not be decided.
 */
export const WORKFLOW_RUN_STATE_WORDS = Object.freeze({
    running: "Running", waiting: "Waiting", pausing: "Pausing", paused: "Paused", canceling: "Canceling",
    completed: "Completed", failed: "Failed", canceled: "Canceled", stopped: "Canceled", notCertain: "Not certain",
});

/** A status as the data says it, by its one word (stage 3): the runtime's names too ("cancelled", "admitted", "stopping"). */
const RUN_STATUS_ALIASES = Object.freeze({ cancelled: "canceled", admitted: "running", stopping: "canceling", error: "failed", idle: "waiting" });

/**
 * A Workflow's status in its one word (review 19:27Z, D-W13): "Running", "Canceled" (cancelled or stopped), "Completed";
 * "Not certain" for a status it does not know, never the raw word. Null without one.
 */
export function workflowRunStateWord(status) {
    if (typeof status !== "string" || !status) return null;
    const key = Object.hasOwn(RUN_STATUS_ALIASES, status) ? RUN_STATUS_ALIASES[status] : status;
    return Object.hasOwn(WORKFLOW_RUN_STATE_WORDS, key) ? WORKFLOW_RUN_STATE_WORDS[key] : WORKFLOW_RUN_STATE_WORDS.notCertain;
}

/** The words a state is said in, for reasonShown: a reason that is only one of them says nothing more. */
const STATE_ONLY_REASONS = new Set(["stopped", "stop", "canceled", "cancelled", "cancel", "completed", "failed", "paused", "resumed", "done", "deleted"]);

/**
 * A reason as people read it, or null when it says nothing beyond the state (review 19:27Z: the server's default reason
 * for a stop is "Stopped"; never "Canceled at once: Stopped"). Only text with more than a state word is kept.
 */
export function workflowReasonShown(reason) {
    const text = typeof reason === "string" ? reason.trim() : "";
    if (!text) return null;
    return STATE_ONLY_REASONS.has(text.replace(/[.!]+$/, "").toLowerCase()) ? null : text;
}

/** A node's states, one word each (D-W2: a node's visit is Done; a Workflow is Completed). */
export const WORKFLOW_NODE_STATE_WORDS = Object.freeze({
    running: "Running", waiting: "Waiting", sending: "Sending", paused: "Paused", done: "Done", failed: "Failed",
    canceled: "Canceled", reached: "Reached", notReached: "Not reached",
});

/** An outcome as people read it: "canceled" (one l) for the stored `cancelled`. */
export function workflowOutcomeWord(outcome) {
    return outcome === "cancelled" ? "canceled" : String(outcome ?? "");
}

/**
 * A duration, the one form every Workflow screen uses (D-W6): "820 ms" under a second, "4 s", "2 min 45 s", "1 h 3 min".
 * Null when it cannot be read.
 */
export function workflowDuration(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const total = Math.round(ms / 1000);
    if (total < 60) return `${total} s`;
    if (total < 3600) return `${Math.floor(total / 60)} min${total % 60 ? ` ${total % 60} s` : ""}`;
    const minutes = Math.floor((total % 3600) / 60);
    return `${Math.floor(total / 3600)} h${minutes ? ` ${minutes} min` : ""}`;
}

/** How many times a node was visited, as a number: "126", or "126+" when older visits are not loaded (`partial`). */
export function workflowRunsText(runs, partial = false) {
    return Number.isSafeInteger(runs) ? `${runs}${partial ? "+" : ""}` : null;
}

/** An error route of a node in the Workflow's words, with the error mark the graph's edges use ("✕ limit"). */
const ERROR_ROUTE_WORDS = Object.freeze({
    failure: "✕ error", timed_out: "✕ limit", needs_input: "✕ needs input", execution_failed: "✕ agent failed",
    invalid_output: "✕ invalid output", invalid_input: "✕ invalid input", unavailable: "✕ unavailable", forbidden: "✕ forbidden",
    delivery_failed: "✕ not delivered", cancelled: "⊘ canceled",
});

/** An error route's words: "✕ limit" for `timed_out`; an unknown one by its label, with spaces ("✕ quota exceeded"). */
export function workflowErrorRouteWords(label) {
    const key = String(label ?? "");
    return Object.hasOwn(ERROR_ROUTE_WORDS, key) ? ERROR_ROUTE_WORDS[key] : `✕ ${key.replace(/_/g, " ")}`;
}

/** A state as one mark: done, running or waiting, failed, canceled. A state not reached has none (its card is dimmed). */
export const WORKFLOW_STATE_MARKS = Object.freeze({
    done: Object.freeze({ glyph: "✓", word: "done" }),
    running: Object.freeze({ glyph: "●", word: "running" }),
    failed: Object.freeze({ glyph: "✕", word: "failed" }),
    cancelled: Object.freeze({ glyph: "⊘", word: "canceled" }),
});

/** A node's mark for its `state` and `phase` (as nodeView says them); null when it was not reached (or there is no run). */
export function workflowStateMark(state, phase = null) {
    if (Object.hasOwn(WORKFLOW_STATE_MARKS, state)) return WORKFLOW_STATE_MARKS[state];
    // A visit waiting while the run is paused, or while the run's status is not certain, has started: it is not idle.
    if (state === "idle" && (phase === "paused" || phase === "unverified")) return WORKFLOW_STATE_MARKS.running;
    return null;
}

/**
 * How many times a node was visited, as a badge: "↻ 126", or "↻ 126+" when older visits are not loaded (`partial`), with
 * its words as the title ("Ran 126 times", "Ran 126 times · older visits not loaded"). Null under 2 visits.
 */
export function workflowVisitBadge(runs, partial = false) {
    if (!Number.isSafeInteger(runs) || runs < 2) return null;
    const count = workflowRunsText(runs, partial);
    return { text: `↻ ${count}`, title: `Ran ${runs} times${partial ? " · older visits not loaded" : ""}` };
}

/** Review 18:45Z: an Ask's answer in its own words, as its Now line and state say it. */
const ASK_ANSWER_WORDS = Object.freeze({ responded: "✓ answered", declined: "✕ declined", timed_out: "✕ limit" });

/** An Ask's answer: "Waiting · answer" while it waits (`pending`); "✓ answered", "✕ declined" or "✕ limit" when done; else null. */
export function workflowAskAnswerWords(outcome, pending = false) {
    if (pending) return "Waiting · answer";
    return typeof outcome === "string" && Object.hasOwn(ASK_ANSWER_WORDS, outcome) ? ASK_ANSWER_WORDS[outcome] : null;
}

/**
 * Review 21:15Z: a refusal as one line, "<label>: <why>" ("Start refused: …", "Revision not saved: …"): the server's message
 * when it gave one (as it is when it already begins with the label), else `fallback`.
 */
export function workflowRefusalText(label, message, fallback) {
    const why = typeof message === "string" && message.trim() ? message.trim() : String(fallback ?? "").trim();
    return why.toLowerCase().startsWith(String(label).toLowerCase()) ? why : `${label}: ${why}`;
}

/** A message contract's name without its version ("DadJoke@1" → "DadJoke"). */
export function workflowContractName(contract) {
    const text = typeof contract === "string" ? contract.trim() : "";
    const at = text.lastIndexOf("@");
    return at > 0 ? text.slice(0, at) : text;
}

const REASONS = Object.freeze({ timed_out: "limit", invalid_input: "invalid input", invalid_output: "invalid output", cancelled: "canceled" });

/** The shortest reason a node's visit failed: "limit", "invalid input", "invalid output", "canceled", or "error". */
export function workflowFailureReason(outcome) {
    return typeof outcome === "string" && Object.hasOwn(REASONS, outcome) ? REASONS[outcome] : "error";
}

/**
 * A failure's detail, for a node's tooltip and its Now line: the shortest reason when it has one ("limit"), else the
 * outcome it recorded, in words ("execution failed"); "error" when it recorded none.
 */
export function workflowFailureDetail(outcome) {
    if (typeof outcome !== "string" || !outcome) return "error";
    return Object.hasOwn(REASONS, outcome) ? REASONS[outcome] : outcome.replace(/_/g, " ");
}

/** "k/n ok": how many of a node's items succeeded, of all; null without a count. */
export function workflowItemsFraction(ok, total) {
    return Number.isSafeInteger(ok) && Number.isSafeInteger(total) && total > 0 ? `${Math.min(ok, total)}/${total} ok` : null;
}

const msOf = value => (value instanceof Date ? value.getTime() : typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN);

/**
 * A time as every Workflow screen shows it (D-W7): the local clock ("08:31:05") on the day it is, the local date and
 * clock on another day ("2026-11-06 08:31:05"), with no zone name (workflowTimeTitle, its tooltip, has it). Null when it
 * cannot be read.
 */
export function workflowShortTime(value, now = Date.now()) {
    const ms = msOf(value);
    if (!Number.isFinite(ms)) return null;
    const sameDay = new Date(now).toDateString() === new Date(ms).toDateString();
    const full = formatLocalTime(ms, { clock: sameDay });
    return full ? full.replace(/\s+\S+$/, "") : null;
}

/** The one form a Workflow screen shows a time in (workflowShortTime). */
export const workflowTime = workflowShortTime;

/** A time's tooltip: the local date, clock and zone ("2026-11-07 08:31:05 PST"). Null when it cannot be read. */
export function workflowTimeTitle(value) {
    const ms = msOf(value);
    return Number.isFinite(ms) ? formatLocalTime(ms) : null;
}

/** OF-S2-7: a context tier in words. */
const CONTEXT_TIER_WORDS = Object.freeze({ default: "default context", long_context: "long context" });

/**
 * OF-S2-7: a model with its reasoning effort and context tier, as people read them ("azure:gpt-5 · high reasoning · long
 * context"), from a start's choice or a session row ({ model, reasoningEffort, contextTier }); null without a model. Pure.
 */
export function workflowModelWords(choice) {
    const model = choice && typeof choice === "object" && typeof choice.model === "string" ? choice.model.trim() : "";
    if (!model) return null;
    const effort = typeof choice.reasoningEffort === "string" && choice.reasoningEffort.trim() ? `${choice.reasoningEffort.trim()} reasoning` : null;
    const tier = typeof choice.contextTier === "string" && choice.contextTier.trim()
        ? CONTEXT_TIER_WORDS[choice.contextTier.trim()] ?? choice.contextTier.trim() : null;
    return [model, effort, tier].filter(Boolean).join(" · ");
}

/** OF-S2-7: a session row's model, reasoning effort and context tier (the parts workflowModelWords reads), or null. Pure. */
export function workflowSessionModel(session) {
    if (!session || typeof session !== "object" || typeof session.model !== "string" || !session.model.trim()) return null;
    return { model: session.model, reasoningEffort: session.reasoningEffort ?? null, contextTier: session.contextTier ?? null };
}

/**
 * OF-S2-7: what each agent node of a graph (its states, nested bodies listed too) will use, for the Start dialog (the person
 * does not choose here: a start of theirs uses the chat's model, Run again its Workflow's choices): [{ id, text }], text
 * "classify: <model words> · chosen at start" or "… · from the chat". Empty without agent nodes. Pure.
 */
export function workflowStartModels(states, { chosen = null, chat = null } = {}) {
    const picked = id => (chosen && typeof chosen === "object" && chosen[id] && typeof chosen[id] === "object" ? chosen[id] : null);
    return (Array.isArray(states) ? states : []).filter(state => state?.type === "agent" && typeof state.id === "string")
        .map(state => ({ id: state.id, text: `${state.id}: ${workflowAgentModel(picked(state.id), chat).value}` }));
}

/**
 * OF-S2-7: the model of a session (by id, in a sessions-by-id record) as one stable text, for a screen's selector ("" when
 * the session or its model is not loaded); workflowModelFromKey reads it back. Pure.
 */
export function workflowSessionModelKey(byId, sessionId) {
    const row = byId && typeof byId === "object" && typeof sessionId === "string" && Object.hasOwn(byId, sessionId) ? byId[sessionId] : null;
    const model = workflowSessionModel(row);
    return model ? JSON.stringify([model.model, model.reasoningEffort, model.contextTier]) : "";
}

/** OF-S2-7: a model key (workflowSessionModelKey) as { model, reasoningEffort, contextTier }, or null for "". Pure. */
export function workflowModelFromKey(key) {
    if (typeof key !== "string" || !key) return null;
    try {
        const [model, reasoningEffort, contextTier] = JSON.parse(key);
        return typeof model === "string" ? { model, reasoningEffort: reasoningEffort ?? null, contextTier: contextTier ?? null } : null;
    } catch {
        return null;
    }
}

/**
 * OF-S2-7: the model an agent node uses. `used` (review OF7-R8: what the shown visit's chat ran on, recorded with its spawn:
 * { model, reasoningEffort, contextTier, source }) is the evidence; without it, the one the start chose (`chosen`, the
 * run's agentModels entry), else its chat's as it is now (`chat`, workflowSessionModel of the chat that owns the Workflow;
 * null when that chat is not loaded). { source: "start" | "chat", words, value, text, now }: value "azure:gpt-5 · low
 * reasoning · chosen at start" or "… · from the chat", "from the chat · now …" when only the chat's current model is known,
 * "from the chat" when not even that; text "Model: " and the value. `unreadable` (DEV at fed7e7ac): the run's stored choices
 * cannot be read, so without a visit's record it says that, never the chat's model. Pure.
 */
export function workflowAgentModel(chosen, chat = null, used = null, { unreadable = false } = {}) {
    const ran = workflowModelWords(used);
    if (!ran && unreadable) {
        return { source: "start", words: null, value: "model choices cannot be read", text: "Model: model choices cannot be read", now: false };
    }
    if (ran) {
        const source = used.source === "start" ? "start" : "chat";
        const value = `${ran} · ${source === "start" ? "chosen at start" : "from the chat"}`;
        return { source, words: ran, value, text: `Model: ${value}`, now: false };
    }
    const picked = workflowModelWords(chosen);
    if (picked) return { source: "start", words: picked, value: `${picked} · chosen at start`, text: `Model: ${picked} · chosen at start`, now: false };
    const inherited = workflowModelWords(chat);
    const value = inherited ? `from the chat · now ${inherited}` : "from the chat";
    return { source: "chat", words: inherited, value, text: `Model: ${value}`, now: Boolean(inherited) };
}

/**
 * OF-S2-7 review OF7-R8: what each visit's agent chat ran on, from the Workflow's `workflow.agent_spawned` events (of run
 * `runId` when given): node execution id → { model, reasoningEffort, contextTier, source }. Pure.
 */
export function workflowSpawnedModels(events, runId = null) {
    const out = new Map();
    for (const event of Array.isArray(events) ? events : []) {
        const data = event?.eventType === "workflow.agent_spawned" ? event.data : null;
        if (!data || typeof data.nodeExecutionId !== "string" || (runId && data.runId !== runId)) continue;
        const model = data.model;
        if (model && typeof model === "object" && typeof model.model === "string" && model.model) {
            out.set(data.nodeExecutionId, { model: model.model, reasoningEffort: model.reasoningEffort ?? null, contextTier: model.contextTier ?? null,
                source: model.source === "start" ? "start" : "chat" });
        }
    }
    return out;
}

/**
 * A node card's two rows (OF-S2-2): row 1 is the name with a visit badge; row 2 is a state mark and the node's one key
 * fact. The key fact by node type: a wait its time ("30 s", "until 09:00"; while waiting, "until <the deadline>"); a
 * send, request or receive its contract's name; a For each its items ("4/5 ok"); an end its outcome. An agent node
 * has none (OF-S2-3a): its row 2 is its mark alone ("✓", "●", "⊘"), its items when several reached it. A failed visit's
 * fact is its shortest reason; any other node done with no key fact shows the outcome it took. `input`:
 * - kind, state, phase, outcome, terminalOutcome (an end's), runs, partial (older visits not loaded), notReached;
 * - seconds or clock (a wait's), deadline (a waiting visit's), contract, agentName, items ({ ok, total }).
 * { mark, fact, badge, row2 }: `row2` false when there is nothing to say on it (a node not reached with no key fact).
 */
export function workflowNodeCardWords(input) {
    const mark = workflowStateMark(input.state, input.phase);
    const items = input.items ? workflowItemsFraction(input.items.ok, input.items.total) : null;
    let fact = null;
    switch (input.kind) {
        case "wait": {
            const base = input.clock ?? (typeof input.seconds === "number" ? input.secondsText ?? `${input.seconds} s` : null);
            const until = input.deadline && mark === WORKFLOW_STATE_MARKS.running ? workflowShortTime(input.deadline) : null;
            fact = until ? (base && !base.startsWith("until") ? `${base} · until ${until}` : `until ${until}`) : base;
            break;
        }
        case "send":
        case "request":
        case "receive":
            fact = workflowContractName(input.contract) || null;
            break;
        // OF-S2-3a (owner, 2026-11-07): an agent node's card says its state only. Its outcome is on its edge and, with its
        // agent's name, in its tooltip and the Node panel; a failure still says its shortest reason.
        case "agent":
            break;
        case "terminal":
            fact = input.terminalOutcome ? workflowOutcomeWord(input.terminalOutcome) : null;
            break;
        default:
            break;
    }
    if (items) fact = items;
    else if (mark === WORKFLOW_STATE_MARKS.failed && input.kind !== "terminal") fact = workflowFailureReason(input.outcome);
    else if (input.kind === "agent") fact = null;
    else if (!fact && mark === WORKFLOW_STATE_MARKS.done) fact = input.outcome ? workflowOutcomeWord(input.outcome) : "done";
    else if (!fact && mark === WORKFLOW_STATE_MARKS.cancelled) fact = "canceled";
    else if (!fact && mark === WORKFLOW_STATE_MARKS.running) fact = input.phase === "paused" ? "paused" : input.kind === "script" ? "running" : "waiting";
    return { mark, fact, badge: input.itemsShown ? null : workflowVisitBadge(input.runs, input.partial), row2: Boolean(mark || fact) };
}
