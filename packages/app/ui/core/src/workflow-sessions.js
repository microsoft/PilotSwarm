/**
 * Workflow sessions in the UI.
 *
 * A workflow session runs a graph of states instead of a conversation.
 * The worker records one CMS event per step; the transcript projects repeated
 * polls as one updating row, with the definition and history available on
 * expansion. The live view is the session's canvas,
 * which the worker draws and updates (packages/sdk workflow/canvas.ts).
 */

import { workflowEventText } from "./workflow-v2-view.js";
import { WORKFLOW_STATE_MARKS, workflowDuration, workflowFailureDetail, workflowFailureReason, workflowOutcomeWord, workflowReasonShown } from "./workflow-words.js";

export const WORKFLOW_SESSION_GLYPH = "◇";

/** The v2 events that report a control action or a side effect, not a step of the run. They never end or split a poll summary. */
export const WORKFLOW_CONTROL_EVENT_TYPES = [
    // Workflow v2 control events (packages/sdk/src/workflow/v2 runtime.ts, service.ts, store.ts).
    "workflow.paused",
    "workflow.resumed",
    "workflow.vars_set",
    "workflow.input_accepted",
    "workflow.recovered",
    "workflow.cancel_requested",
    // A graceful stop was asked (adversarial review R2-UI-6): the run's admitted steps may still finish.
    "workflow.stop_requested",
    "workflow.parent_notified",
    "workflow.parent_notification_skipped",
];

export const WORKFLOW_EVENT_TYPES = [
    "workflow.started",
    "workflow.state_started",
    "workflow.state_completed",
    "workflow.state_failed",
    "workflow.state_cancelled",
    "workflow.completed",
    "workflow.failed",
    "workflow.cancelled",
    // A run that ended by a graceful stop (R2-UI-6).
    "workflow.stopped",
    ...WORKFLOW_CONTROL_EVENT_TYPES,
];

/** Outcomes that stay visible in a log of repeated steps, as business results. */
export const WORKFLOW_ATTENTION_OUTCOMES = new Set(["changed", "change", "failure", "failed", "error", "timeout", "cancelled", "canceled", "blocked"]);

const WORKFLOW_EVENT_TYPE_SET = new Set(WORKFLOW_EVENT_TYPES);

export function isWorkflowSession(session) {
    return session?.sessionKind === "workflow";
}

export function isWorkflowEvent(event) {
    return WORKFLOW_EVENT_TYPE_SET.has(event?.eventType);
}

function code(text) {
    return `\`${String(text ?? "").replace(/`/g, "'")}\``;
}

function cell(text) {
    return String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** A duration in the one form (D-W6, workflowDuration); null when it cannot be read. */
function formatDuration(ms) {
    return ms === null || ms === undefined || ms === "" ? null : workflowDuration(Number(ms));
}

/** Stage 3 (review 19:27Z): the marks of the words module (✓ ● ✕ ⊘), never ✗, ■ or ⏹ for a state. */
const DONE = WORKFLOW_STATE_MARKS.done.glyph;
const RUNNING = WORKFLOW_STATE_MARKS.running.glyph;
const FAILED = WORKFLOW_STATE_MARKS.failed.glyph;
const CANCELED = WORKFLOW_STATE_MARKS.cancelled.glyph;

/** One line of untrusted text as an inline code span: no markup, no line breaks, bounded. */
function inline(value, max = 120) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return code(text.length > max ? `${text.slice(0, max - 1)}…` : text);
}

const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

/** A failure's outcome in words: a known one plain ("limit", "invalid output", "error"), any other as one code span (it is data). */
const failureWords = (outcome) => (!nonEmpty(outcome) || workflowFailureReason(outcome) !== "error"
    ? workflowFailureDetail(outcome) : inline(workflowFailureDetail(outcome), 60));

/**
 * Text, a one-line summary and a colour for a workflow v2 control event: its long form in the one sentence table the
 * activity list also uses (workflowEventText). Missing or malformed fields leave a part out; nothing here throws. Null
 * for any other event.
 */
function controlEventView(event, options) {
    return workflowEventText(event?.eventType, event?.data, "long", options);
}

function formatNext(next) {
    const entries = Object.entries(next || {});
    if (entries.length === 0) return "none";
    return entries.map(([outcome, target]) => `${outcome} → ${target ?? "end"}`).join(", ");
}

const MESSAGING_WORDS = { send: "Send", receive: "Receive", request: "Ask" };

/** The node's type for the definition table, as the graph labels it ("Wait · 30 s", "Send · Alert@1", "Script"). */
function stateKind(state) {
    if (state?.type === "terminal") return "End";
    if (state?.type === "wait") return typeof state.until === "string" ? `Wait · until ${state.until}` : `Wait · ${state.seconds ?? "?"} s`;
    if (state?.type === "messaging") return `${MESSAGING_WORDS[state.mode] ?? "Message"} · ${state.contract ?? "?"}`;
    if (state?.type === "agent") return "Agent";
    // IR 11: a parallel state with named branches.
    if (state?.type === "parallel") return Array.isArray(state.branches) || Array.isArray(state.namedBranches) ? "Branches" : "For each";
    return "Script";
}

function shortPreview(text, max = 200) {
    const value = String(text ?? "");
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatToolCalls(toolCalls) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
    const failed = toolCalls.filter((call) => call && call.ok === false).length;
    const names = [...new Set(toolCalls.map((call) => call?.name).filter(Boolean))];
    const label = `${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"}`;
    return `${label} · ${names.join(", ")}${failed ? ` · ${failed} failed` : ""}`;
}

/**
 * How a node event names its node (review 19:27Z row 28): "`poll`", with " · visit N" after the first visit (its events
 * name the visit, `nodeExecutionId`).
 */
function stepName(data) {
    return `${code(data.stateId)}${visitText(data)}`;
}

/** " · visit N" for a node's second and later visits; "" otherwise. */
function visitText(data) {
    const visit = Number(data.step);
    return nonEmpty(data.nodeExecutionId) && Number.isSafeInteger(visit) && visit > 1 ? ` · visit ${visit}` : "";
}

function endedAtTerminal(data, mark) {
    return `${mark} Workflow **${data.name ?? "workflow"}** reached ${code(data.stateId)}: `
        + `outcome **${data.outcome === undefined || data.outcome === null ? "?" : workflowOutcomeWord(data.outcome)}**${data.summary ? `. ${data.summary}` : "."}`;
}

/** ": <reason>", or "" when there is none or it is only a state word (review 19:27Z: never "canceled: cancelled"). */
const reasonText = value => (workflowReasonShown(typeof value === "string" ? value : null) ? `: ${value.trim()}` : "");

/**
 * Markdown text for one workflow event, or null when it is not one. `options.sessionName` (a function from a session id to
 * its title) names a session a control line mentions; without one the line leaves it out (review 19:27Z: never an id).
 */
export function formatWorkflowEventText(event, options = {}) {
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    switch (event?.eventType) {
        case "workflow.started": {
            const states = Array.isArray(data.states) ? data.states : [];
            const lines = [
                `${WORKFLOW_SESSION_GLYPH} Workflow **${data.name ?? "workflow"}**${data.version ? ` ${data.version}` : ""} started · `
                + `${states.length} node${states.length === 1 ? "" : "s"} · starts at ${code(data.initial)}.`,
            ];
            if (states.length > 0) {
                lines.push("", "| Node | Type | Outcome → next |", "|---|---|---|");
                for (const state of states) {
                    const type = stateKind(state);
                    const next = state?.type === "terminal" ? `End · ${state.outcome === undefined ? "?" : workflowOutcomeWord(state.outcome)}` : formatNext(state?.next);
                    lines.push(`| ${cell(state?.id)} | ${cell(type)} | ${cell(next)} |`);
                }
            }
            return lines.join("\n");
        }
        case "workflow.state_started":
            return `${RUNNING} ${stepName(data)} started.`;
        case "workflow.state_completed": {
            // An explicit runtime error recorded as a completion contradicts itself; it is never shown as a success.
            if (data.resultKind === "runtime_error") {
                const detail = nonEmpty(data.error) ? data.error : nonEmpty(data.outputPreview) && data.outputPreview !== "null" ? data.outputPreview : null;
                return `${FAILED} ${stepName(data)} · ${failureWords(data.outcome)} · recorded as a completion${detail ? `: ${inline(detail, 300)}` : ""}`;
            }
            const parts = [`${DONE} ${stepName(data)} → **${data.outcome === undefined || data.outcome === null ? "?" : workflowOutcomeWord(data.outcome)}**`];
            const duration = formatDuration(data.durationMs);
            if (duration) parts.push(`in ${duration}`);
            const tools = formatToolCalls(data.toolCalls);
            if (tools) parts.push(`· ${tools}`);
            const lines = [`${parts.join(" ")}.`];
            if (data.outputPreview && data.outputPreview !== "null") lines.push(`Output: ${code(shortPreview(data.outputPreview))}`);
            if (data.stderrTail) lines.push("", "```text", shortPreview(data.stderrTail, 1_000), "```");
            return lines.join("\n");
        }
        case "workflow.state_failed":
            if (data.resultKind === "runtime_error") {
                const reason = nonEmpty(data.error) ? data.error : nonEmpty(data.effectStatus) ? `the action ${data.effectStatus}` : "no error text";
                if (data.outcome === "cancelled") return `${CANCELED} ${stepName(data)} canceled: ${inline(reason, 300)}`;
                return `${FAILED} ${stepName(data)} · ${failureWords(data.outcome)}: ${inline(reason, 300)}`;
            }
            return `${FAILED} ${stepName(data)} could not run: ${data.error ?? "unknown error"}`;
        case "workflow.completed": {
            const lines = [endedAtTerminal(data, DONE)];
            if (data.outputPreview && data.outputPreview !== "null") {
                lines.push("", "```json", shortPreview(data.outputPreview, 1_000), "```");
            }
            return lines.join("\n");
        }
        case "workflow.failed":
            if (data.outcome !== undefined) return endedAtTerminal(data, FAILED);
            return `${FAILED} Workflow **${data.name ?? "workflow"}** failed`
                + `${data.stateId ? ` at ${code(data.stateId)}` : ""}: ${data.error ?? "unknown error"}`;
        case "workflow.state_cancelled": {
            const duration = formatDuration(data.durationMs);
            return `${CANCELED} ${stepName(data)} canceled${duration ? ` after ${duration}` : ""}.`;
        }
        case "workflow.cancelled":
            if (data.outcome !== undefined) return endedAtTerminal(data, CANCELED);
            return `${CANCELED} Workflow **${data.name ?? "workflow"}** canceled`
                + `${data.stateId ? ` at ${code(data.stateId)}` : ""}${reasonText(data.reason)}${reasonText(data.reason) ? "" : "."}`;
        default:
            return controlEventView(event, options)?.text ?? null;
    }
}

/**
 * How one workflow event is drawn in the transcript. The graph and the end
 * result are readable summaries; each step is a one-line notice that opens to show
 * its output and errors. `text` is the Markdown body either way.
 */
export function describeWorkflowEvent(event, options = {}) {
    const text = formatWorkflowEventText(event, options);
    if (!text) return null;
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    // A node's notice names it in its summary, with its visit after the first.
    const stepTitle = `${WORKFLOW_SESSION_GLYPH} Node${visitText(data)}`;
    const states = Array.isArray(data.states) ? data.states.length : 0;
    switch (event.eventType) {
        case "workflow.started":
            return { kind: "notice", title: "Workflow", color: "magenta",
                summary: `${data.name ?? "workflow"}${data.version ? ` ${data.version}` : ""} · ${states} node${states === 1 ? "" : "s"} · starts at ${data.initial ?? "?"}`,
                text };
        case "workflow.completed":
            return { kind: "card", title: "Workflow result", color: "green", text };
        case "workflow.failed":
            return { kind: "card", title: "Workflow failed", color: "red", text };
        case "workflow.cancelled":
            return { kind: "card", title: "Workflow canceled", color: "yellow", text };
        // A graceful stop ended the run (R2-UI-6); its text is the event's long form. Review 19:27Z: it reads Canceled.
        case "workflow.stopped":
            return { kind: "card", title: "Workflow canceled", color: "yellow", text };
        case "workflow.state_started":
            return { kind: "notice", title: stepTitle, color: "gray", summary: `${data.stateId ?? "?"} started`, text };
        case "workflow.state_completed": {
            const duration = formatDuration(data.durationMs);
            const tools = formatToolCalls(data.toolCalls);
            const runtimeError = data.resultKind === "runtime_error";
            const summary = runtimeError ? `${data.stateId ?? "?"} · ${workflowFailureDetail(data.outcome)}`
                : `${data.stateId ?? "?"} → ${data.outcome === undefined || data.outcome === null ? "?" : workflowOutcomeWord(data.outcome)}${duration ? ` in ${duration}` : ""}${tools ? ` · ${tools}` : ""}`;
            // A business result is a normal completion; its outcome only draws attention when the workflow's author named it so.
            // A result kind this build does not know (or none) is never green.
            const color = data.resultKind === "business"
                ? (WORKFLOW_ATTENTION_OUTCOMES.has(String(data.outcome ?? "").toLowerCase()) ? "yellow" : "green")
                : runtimeError ? "red" : "yellow";
            return { kind: "notice", title: stepTitle, color, summary, text };
        }
        case "workflow.state_failed":
            return { kind: "notice", title: stepTitle, color: "red",
                summary: data.resultKind === "runtime_error"
                    ? `${data.stateId ?? "?"} · ${data.outcome === "cancelled" ? "canceled" : workflowFailureDetail(data.outcome)}`
                    : `${data.stateId ?? "?"} could not run: ${data.error ?? "unknown error"}`, text };
        case "workflow.state_cancelled": {
            const duration = formatDuration(data.durationMs);
            return { kind: "notice", title: stepTitle, color: "yellow", summary: `${data.stateId ?? "?"} canceled${duration ? ` after ${duration}` : ""}`, text };
        }
        default: {
            const control = controlEventView(event, options);
            return control ? { kind: "notice", title: `${WORKFLOW_SESSION_GLYPH} Workflow`, color: control.color, summary: control.summary, text } : null;
        }
    }
}

/** The words an empty workflow step log shows, and while it loads (owner batch 5, g-06). */
export const WORKFLOW_STEP_LOG_EMPTY_TEXT = "No step output yet.";
export const WORKFLOW_STEP_LOG_LOADING_TEXT = "Loading the step log…";

const stepLogLineText = line => Array.isArray(line)
    ? line.map(run => (typeof run?.text === "string" ? run.text : "")).join("")
    : typeof line?.text === "string" ? line.text : "";

/**
 * A workflow's step log as the portal shows it (owner batch 5, g-06): the transcript's lines as they are once the
 * workflow has written any; until then plain words, never the session's splash art (the splash is the transcript's
 * "markup" line) and never "No messages yet." `history` is the session's loaded history ({ chat, loadState }). A
 * failed read keeps the transcript's own words for it, and any other line the transcript shows without a message
 * (a warning about the session) follows the words. Pure.
 */
export function workflowStepLogLines(lines, history) {
    const chat = Array.isArray(history?.chat) ? history.chat : [];
    const list = Array.isArray(lines) ? lines : [];
    if (chat.length) return list;
    if (history?.loadState === "loading") return [{ text: WORKFLOW_STEP_LOG_LOADING_TEXT, color: "gray" }];
    if (history?.loadState === "failed") return list;
    const kept = list.filter(line => line?.kind !== "markup" && stepLogLineText(line) !== "No messages yet.");
    const content = kept.some(line => (line && !Array.isArray(line) && typeof line.kind === "string") || stepLogLineText(line).trim());
    return [{ text: WORKFLOW_STEP_LOG_EMPTY_TEXT, color: "gray" }, ...(content ? kept : [])];
}
