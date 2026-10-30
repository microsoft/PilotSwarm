/**
 * Workflow sessions in the UI.
 *
 * A workflow session runs a graph of states instead of a conversation.
 * The worker records one CMS event per step; the transcript renders them as
 * an execution log: the graph when it starts, a line per state as it starts
 * and ends, and the terminal state the run reached. The live view is the session's canvas,
 * which the worker draws and updates (packages/sdk workflow/canvas.ts).
 */

export const WORKFLOW_SESSION_GLYPH = "⛓";

export const WORKFLOW_EVENT_TYPES = [
    "workflow.started",
    "workflow.state_started",
    "workflow.state_completed",
    "workflow.state_failed",
    "workflow.state_cancelled",
    "workflow.completed",
    "workflow.failed",
    "workflow.cancelled",
];

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

function formatNext(next) {
    const entries = Object.entries(next || {});
    if (entries.length === 0) return "(no outcomes)";
    return entries.map(([outcome, target]) => `${outcome} → ${target ?? "end"}`).join(", ");
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

function endedAtTerminal(data, mark) {
    return `${mark} Workflow **${data.name ?? "workflow"}** reached ${code(data.stateId)} after ${data.steps ?? 0} step${data.steps === 1 ? "" : "s"}: `
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
                + `${states.length} state${states.length === 1 ? "" : "s"}, initial ${code(data.initial)}.`,
            ];
            if (states.length > 0) {
                lines.push("", "| State | Type | Outcome → next |", "|---|---|---|");
                for (const state of states) {
                    const type = state?.type === "terminal" ? "terminal" : `script (${state?.runtime ?? "?"})`;
                    const next = state?.type === "terminal" ? `ends: ${state.outcome ?? "?"}` : formatNext(state?.next);
                    lines.push(`| ${cell(state?.id)} | ${cell(type)} | ${cell(next)} |`);
                }
            }
            return lines.join("\n");
        }
        case "workflow.state_started":
            return `▶ Step ${data.step ?? "?"}: ${code(data.stateId)} started (${data.runtime ?? "script"}).`;
        case "workflow.state_completed": {
            const parts = [`✓ Step ${data.step ?? "?"}: ${code(data.stateId)} → **${data.outcome ?? "?"}**`];
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
            return `✗ Step ${data.step ?? "?"}: ${code(data.stateId)} could not run: ${data.error ?? "unknown error"}`;
        case "workflow.completed": {
            const lines = [endedAtTerminal(data, "■")];
            if (data.outputPreview && data.outputPreview !== "null") {
                lines.push("", "```json", shortPreview(data.outputPreview, 1_000), "```");
            }
            return lines.join("\n");
        }
        case "workflow.failed":
            if (data.outcome !== undefined) return endedAtTerminal(data, "✗");
            return `✗ Workflow **${data.name ?? "workflow"}** failed after ${data.steps ?? 0} step${data.steps === 1 ? "" : "s"}`
                + `${data.stateId ? ` at ${code(data.stateId)}` : ""}: ${data.error ?? "unknown error"}`;
        case "workflow.state_cancelled": {
            const duration = formatDuration(data.durationMs);
            return `⏹ Step ${data.step ?? "?"}: ${code(data.stateId)} stopped${duration ? ` after ${duration}` : ""}.`;
        }
        case "workflow.cancelled":
            if (data.outcome !== undefined) return endedAtTerminal(data, "⏹");
            return `⏹ Workflow **${data.name ?? "workflow"}** stopped after ${data.steps ?? 0} step${data.steps === 1 ? "" : "s"}`
                + `${data.stateId ? ` at ${code(data.stateId)}` : ""}: ${data.reason ?? "cancelled"}`;
        default:
            return null;
    }
}

/**
 * How one workflow event is drawn in the transcript. The graph and the end
 * result are full cards; each step is a one-line notice that opens to show
 * its output and errors. `text` is the Markdown body either way.
 */
export function describeWorkflowEvent(event) {
    const text = formatWorkflowEventText(event);
    if (!text) return null;
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    const stepTitle = `${WORKFLOW_SESSION_GLYPH} Step ${data.step ?? "?"}`;
    switch (event.eventType) {
        case "workflow.started":
            return { kind: "card", title: "Workflow", color: "magenta", text };
        case "workflow.completed":
            return { kind: "card", title: "Workflow result", color: "green", text };
        case "workflow.failed":
            return { kind: "card", title: "Workflow failed", color: "red", text };
        case "workflow.cancelled":
            return { kind: "card", title: "Workflow stopped", color: "yellow", text };
        case "workflow.state_started":
            return { kind: "notice", title: stepTitle, color: "gray", summary: `${data.stateId ?? "?"} started (${data.runtime ?? "script"})`, text };
        case "workflow.state_completed": {
            const duration = formatDuration(data.durationMs);
            const tools = formatToolCalls(data.toolCalls);
            const summary = `${data.stateId ?? "?"} → ${data.outcome ?? "?"}${duration ? ` in ${duration}` : ""}${tools ? ` · ${tools}` : ""}`;
            return { kind: "notice", title: stepTitle, color: data.exitCode === 0 || data.resultSource === "reported" ? "green" : "yellow", summary, text };
        }
        case "workflow.state_failed":
            return { kind: "notice", title: stepTitle, color: "red", summary: `${data.stateId ?? "?"} could not run: ${data.error ?? "unknown error"}`, text };
        case "workflow.state_cancelled": {
            const duration = formatDuration(data.durationMs);
            return { kind: "notice", title: stepTitle, color: "yellow", summary: `${data.stateId ?? "?"} stopped${duration ? ` after ${duration}` : ""}`, text };
        }
        default:
            return null;
    }
}
