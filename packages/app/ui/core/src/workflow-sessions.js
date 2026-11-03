/**
 * Workflow sessions in the UI.
 *
 * A workflow session runs a graph of states instead of a conversation.
 * The worker records one CMS event per step; the transcript projects repeated
 * polls as one updating row, with the definition and history available on
 * expansion. The live view is the session's canvas,
 * which the worker draws and updates (packages/sdk workflow/canvas.ts).
 */

export const WORKFLOW_SESSION_GLYPH = "◇";

export const WORKFLOW_EVENT_TYPES = [
    "workflow.started",
    "workflow.state_started",
    "workflow.state_completed",
    "workflow.state_failed",
    "workflow.state_cancelled",
    "workflow.completed",
    "workflow.failed",
    "workflow.cancelled",
    // Workflow v2 control events (packages/sdk/src/workflow/v2 runtime.ts, service.ts, store.ts).
    "workflow.paused",
    "workflow.resumed",
    "workflow.vars_set",
    "workflow.input_accepted",
    "workflow.recovered",
    "workflow.cancel_requested",
    "workflow.parent_notified",
    "workflow.parent_notification_skipped",
];

/** The v2 events that report a control action or a side effect, not a step of the run. They never end or split a poll summary. */
export const WORKFLOW_CONTROL_EVENT_TYPES = WORKFLOW_EVENT_TYPES.slice(8);

/** Outcomes that stay visible in a log of repeated steps, as business results and for legacy steps alike. */
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

function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return null;
    if (value < 1_000) return `${Math.round(value)} ms`;
    if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
    return `${Math.floor(value / 60_000)} min ${Math.round((value % 60_000) / 1_000)} s`;
}

/** One line of untrusted text as an inline code span: no markup, no line breaks, bounded. */
function inline(value, max = 120) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return code(text.length > max ? `${text.slice(0, max - 1)}…` : text);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";

/** Who acted, from the actor record of a pause, resume or variable update; nothing when it is missing or unknown. */
function describeActor(actor) {
    if (!isObject(actor)) return "";
    if (actor.kind === "user") return nonEmpty(actor.subject) ? ` by user ${inline(actor.subject, 60)}` : " by a user";
    if (actor.kind === "agent") return nonEmpty(actor.sessionId) ? ` by agent ${inline(String(actor.sessionId).slice(0, 8), 20)}` : " by an agent";
    if (actor.kind === "system") return nonEmpty(actor.name) ? ` by ${inline(actor.name, 60)}` : " by the system";
    return "";
}

function keyList(value) {
    const keys = Array.isArray(value) ? value.filter((key) => typeof key === "string" && key !== "") : [];
    if (keys.length === 0) return "";
    const shown = keys.slice(0, 5).map((key) => inline(key, 40)).join(", ");
    return keys.length > 5 ? `${shown} and ${keys.length - 5} more` : shown;
}

/**
 * Text, a one-line summary and a colour for a workflow v2 control event, built only from the fields the runtime writes.
 * Missing or malformed fields leave a part out; nothing here throws. Null for any other event.
 */
function controlEventView(event) {
    const data = isObject(event?.data) ? event.data : {};
    switch (event?.eventType) {
        case "workflow.paused":
        case "workflow.resumed": {
            const paused = event.eventType === "workflow.paused";
            const reason = nonEmpty(data.reason) ? `: ${inline(data.reason, 200)}` : ".";
            const head = `${paused ? "⏸ Workflow paused" : "▶ Workflow resumed"}${describeActor(data.actor)}`;
            return { text: `${head}${reason}`, summary: paused ? "paused" : "resumed", color: paused ? "yellow" : "gray" };
        }
        case "workflow.vars_set": {
            const set = keyList(data.set), removed = keyList(data.deleted);
            const parts = [set ? `set ${set}` : "", removed ? `removed ${removed}` : ""].filter(Boolean);
            const revision = Number.isSafeInteger(data.kvRevision) ? ` (revision ${data.kvRevision})` : "";
            return { text: `✎ Workflow variables updated${describeActor(data.actor)}${revision}${parts.length ? `: ${parts.join("; ")}` : ""}.`,
                summary: "variables updated", color: "gray" };
        }
        case "workflow.input_accepted": {
            const from = nonEmpty(data.senderSessionId) ? ` from ${inline(String(data.senderSessionId).slice(0, 8), 20)}` : "";
            const contract = nonEmpty(data.contract) ? ` ${inline(data.contract, 80)}` : "";
            const claimed = nonEmpty(data.claimedBy);
            return { text: `✉ Input${contract}${from} accepted by the workflow; ${claimed ? "a waiting receive step took it" : "it waits for a receive step"}.`,
                summary: claimed ? "input accepted and taken" : "input accepted", color: "gray" };
        }
        case "workflow.recovered": {
            const action = nonEmpty(data.action) ? data.action : null;
            // The event and its receipt are stored before the controller is started (service.ts), so it records a request, not a start.
            const text = action === "dispatched" ? "a restart of the run was recorded; this does not show that it has started"
                : action ? `action ${inline(action, 60)} recorded` : "recovery recorded";
            const by = nonEmpty(data.requestedBy) ? ` by ${inline(String(data.requestedBy).slice(0, 8), 20)}` : "";
            return { text: `↻ Recovery requested${by}: ${text}.`, summary: "recovery requested", color: "yellow" };
        }
        case "workflow.cancel_requested": {
            const count = Array.isArray(data.effects) ? data.effects.length : 0;
            return { text: `⏹ Asked ${count} running action${count === 1 ? "" : "s"} to stop. They may take a moment to end.`,
                summary: `${count} action${count === 1 ? "" : "s"} asked to stop`, color: "yellow" };
        }
        case "workflow.parent_notified":
            return { text: `✉ The parent session was told that the run ended${nonEmpty(data.parentSessionId) ? ` (${inline(String(data.parentSessionId).slice(0, 8), 20)})` : ""}.`,
                summary: "parent told the run ended", color: "gray" };
        case "workflow.parent_notification_skipped":
            return { text: `✉ The parent session was not told that the run ended${nonEmpty(data.reason) ? `: ${inline(data.reason, 200)}` : "."}`,
                summary: "parent not told", color: "yellow" };
        default:
            return null;
    }
}

function formatNext(next) {
    const entries = Object.entries(next || {});
    if (entries.length === 0) return "(no outcomes)";
    return entries.map(([outcome, target]) => `${outcome} → ${target ?? "end"}`).join(", ");
}

/** The state's kind for the definition table: v2 wait and messaging states are not scripts. */
function stateKind(state) {
    if (state?.type === "terminal") return "terminal";
    if (state?.type === "wait") return `wait (${state.seconds ?? "?"} s)`;
    if (state?.type === "messaging") return `${state.mode ?? "messaging"} (${state.contract ?? "?"})`;
    return `script (${state?.runtime ?? "?"})`;
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
    return `${label} (${names.join(", ")})${failed ? `, ${failed} failed` : ""}`;
}

/**
 * " after N steps" for a run's end: a version 1 run counts its steps; a version 2 run (its events name the run) records
 * no count, so nothing is said rather than "after 0 steps".
 */
function afterSteps(data) {
    if (data.steps === undefined && nonEmpty(data.runId)) return "";
    return ` after ${data.steps ?? 0} step${data.steps === 1 ? "" : "s"}`;
}

/**
 * How a step event names its step: "Step 2: `poll`" for a version 1 step (its run's step number), "Step `poll`" for a
 * version 2 step (its events name the visit, `nodeExecutionId`), with the visit number after the first visit.
 */
function stepName(data) {
    if (!nonEmpty(data.nodeExecutionId)) return `Step ${data.step ?? "?"}: ${code(data.stateId)}`;
    return `Step ${code(data.stateId)}${visitText(data)}`;
}

/** " (visit N)" for a version 2 step's second and later visits; "" otherwise. */
function visitText(data) {
    const visit = Number(data.step);
    return nonEmpty(data.nodeExecutionId) && Number.isSafeInteger(visit) && visit > 1 ? ` (visit ${visit})` : "";
}

function endedAtTerminal(data, mark) {
    return `${mark} Workflow **${data.name ?? "workflow"}** reached ${code(data.stateId)}${afterSteps(data)}: `
        + `outcome **${data.outcome ?? "?"}**${data.summary ? `. ${data.summary}` : "."}`;
}

/** Markdown text for one workflow event, or null when it is not one. */
export function formatWorkflowEventText(event) {
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    switch (event?.eventType) {
        case "workflow.started": {
            const states = Array.isArray(data.states) ? data.states : [];
            const lines = [
                `${WORKFLOW_SESSION_GLYPH} Workflow **${data.name ?? "workflow"}**${data.version ? ` ${data.version}` : ""} started: `
                + `${states.length} step${states.length === 1 ? "" : "s"}, first step ${code(data.initial)}.`,
            ];
            if (states.length > 0) {
                lines.push("", "| Step | Type | Outcome → next |", "|---|---|---|");
                for (const state of states) {
                    const type = stateKind(state);
                    const next = state?.type === "terminal" ? `ends: ${state.outcome ?? "?"}` : formatNext(state?.next);
                    lines.push(`| ${cell(state?.id)} | ${cell(type)} | ${cell(next)} |`);
                }
            }
            return lines.join("\n");
        }
        case "workflow.state_started":
            return `▶ ${stepName(data)} started (${data.runtime ?? data.type ?? "script"}).`;
        case "workflow.state_completed": {
            // An explicit runtime error recorded as a completion contradicts itself; it is never shown as a success.
            if (data.resultKind === "runtime_error") {
                const detail = nonEmpty(data.error) ? data.error : nonEmpty(data.outputPreview) && data.outputPreview !== "null" ? data.outputPreview : null;
                return `✗ ${stepName(data)} runtime error${nonEmpty(data.outcome) ? ` ${inline(data.outcome, 60)}` : ""}`
                    + `, recorded as a completion${detail ? `: ${inline(detail, 300)}` : ""}`;
            }
            const parts = [`✓ ${stepName(data)} → **${data.outcome ?? "?"}**`];
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
                const reason = nonEmpty(data.error) ? data.error : nonEmpty(data.effectStatus) ? `the action ${data.effectStatus}` : "no error text was recorded";
                return `✗ ${stepName(data)} runtime error${nonEmpty(data.outcome) ? ` ${inline(data.outcome, 60)}` : ""}: ${inline(reason, 300)}`;
            }
            return `✗ ${stepName(data)} could not run: ${data.error ?? "unknown error"}`;
        case "workflow.completed": {
            const lines = [endedAtTerminal(data, "■")];
            if (data.outputPreview && data.outputPreview !== "null") {
                lines.push("", "```json", shortPreview(data.outputPreview, 1_000), "```");
            }
            return lines.join("\n");
        }
        case "workflow.failed":
            if (data.outcome !== undefined) return endedAtTerminal(data, "✗");
            return `✗ Workflow **${data.name ?? "workflow"}** failed${afterSteps(data)}`
                + `${data.stateId ? ` at ${code(data.stateId)}` : ""}: ${data.error ?? "unknown error"}`;
        case "workflow.state_cancelled": {
            const duration = formatDuration(data.durationMs);
            return `⏹ ${stepName(data)} stopped${duration ? ` after ${duration}` : ""}.`;
        }
        case "workflow.cancelled":
            if (data.outcome !== undefined) return endedAtTerminal(data, "⏹");
            return `⏹ Workflow **${data.name ?? "workflow"}** stopped${afterSteps(data)}`
                + `${data.stateId ? ` at ${code(data.stateId)}` : ""}: ${data.reason ?? "cancelled"}`;
        default:
            return controlEventView(event)?.text ?? null;
    }
}

/**
 * How one workflow event is drawn in the transcript. The graph and the end
 * result are readable summaries; each step is a one-line notice that opens to show
 * its output and errors. `text` is the Markdown body either way.
 */
export function describeWorkflowEvent(event) {
    const text = formatWorkflowEventText(event);
    if (!text) return null;
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    // A version 1 step by its run's step number; a version 2 step's notice names it in its summary, with its visit after the first.
    const stepTitle = nonEmpty(data.nodeExecutionId) ? `${WORKFLOW_SESSION_GLYPH} Step${visitText(data)}` : `${WORKFLOW_SESSION_GLYPH} Step ${data.step ?? "?"}`;
    switch (event.eventType) {
        case "workflow.started":
            return { kind: "notice", title: "Workflow", color: "magenta",
                summary: `${data.name ?? "workflow"}${data.version ? ` ${data.version}` : ""} · ${Array.isArray(data.states) ? data.states.length : 0} steps · first step ${data.initial ?? "?"}`,
                text };
        case "workflow.completed":
            return { kind: "card", title: "Workflow result", color: "green", text };
        case "workflow.failed":
            return { kind: "card", title: "Workflow failed", color: "red", text };
        case "workflow.cancelled":
            return { kind: "card", title: "Workflow stopped", color: "yellow", text };
        case "workflow.state_started":
            return { kind: "notice", title: stepTitle, color: "gray", summary: `${data.stateId ?? "?"} started (${data.runtime ?? data.type ?? "script"})`, text };
        case "workflow.state_completed": {
            const duration = formatDuration(data.durationMs);
            const tools = formatToolCalls(data.toolCalls);
            const runtimeError = data.resultKind === "runtime_error";
            const summary = runtimeError ? `${data.stateId ?? "?"} runtime error${nonEmpty(data.outcome) ? ` ${data.outcome}` : ""}`
                : `${data.stateId ?? "?"} → ${data.outcome ?? "?"}${duration ? ` in ${duration}` : ""}${tools ? ` · ${tools}` : ""}`;
            // A v2 business result is a normal completion; its outcome only draws attention when the workflow's author named it so.
            // An explicit result kind this build does not know is never green. Legacy rules apply only when there is no kind.
            const hasKind = data.resultKind !== undefined && data.resultKind !== null;
            const color = data.resultKind === "business"
                ? (WORKFLOW_ATTENTION_OUTCOMES.has(String(data.outcome ?? "").toLowerCase()) ? "yellow" : "green")
                : runtimeError ? "red"
                    : hasKind ? "yellow"
                        : data.exitCode === 0 || data.resultSource === "reported" ? "green" : "yellow";
            return { kind: "notice", title: stepTitle, color, summary, text };
        }
        case "workflow.state_failed":
            return { kind: "notice", title: stepTitle, color: "red",
                summary: data.resultKind === "runtime_error"
                    ? `${data.stateId ?? "?"} runtime error${nonEmpty(data.outcome) ? ` ${data.outcome}` : ""}`
                    : `${data.stateId ?? "?"} could not run: ${data.error ?? "unknown error"}`, text };
        case "workflow.state_cancelled": {
            const duration = formatDuration(data.durationMs);
            return { kind: "notice", title: stepTitle, color: "yellow", summary: `${data.stateId ?? "?"} stopped${duration ? ` after ${duration}` : ""}`, text };
        }
        default: {
            const control = controlEventView(event);
            return control ? { kind: "notice", title: `${WORKFLOW_SESSION_GLYPH} Workflow`, color: control.color, summary: control.summary, text } : null;
        }
    }
}
