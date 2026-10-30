/**
 * Script workflow sessions in the UI.
 *
 * A workflow session runs a graph of script nodes instead of a conversation.
 * The worker records one CMS event per step; the transcript renders them as
 * an execution log: the graph when it starts, a line per node as it starts
 * and ends, and the final result. The live view is the session's canvas,
 * which the worker draws and updates (packages/sdk script-workflow/canvas.ts).
 */

export const WORKFLOW_SESSION_GLYPH = "⛓";

export const WORKFLOW_EVENT_TYPES = [
    "workflow.started",
    "workflow.node_started",
    "workflow.node_completed",
    "workflow.node_failed",
    "workflow.node_cancelled",
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

/** Markdown text for one workflow event, or null when it is not one. */
export function formatWorkflowEventText(event) {
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    switch (event?.eventType) {
        case "workflow.started": {
            const nodes = Array.isArray(data.nodes) ? data.nodes : [];
            const lines = [
                `${WORKFLOW_SESSION_GLYPH} Workflow **${data.name ?? "workflow"}** started: ${nodes.length} node${nodes.length === 1 ? "" : "s"}, entry ${code(data.entry)}.`,
            ];
            if (nodes.length > 0) {
                lines.push("", "| Node | Runtime | Outcome → next |", "|---|---|---|");
                for (const node of nodes) {
                    lines.push(`| ${cell(node.id)} | ${cell(node.runtime)} | ${cell(formatNext(node.next))} |`);
                }
            }
            return lines.join("\n");
        }
        case "workflow.node_started":
            return `▶ Step ${data.step ?? "?"}: ${code(data.nodeId)} started (${data.runtime ?? "script"}).`;
        case "workflow.node_completed": {
            const parts = [`✓ Step ${data.step ?? "?"}: ${code(data.nodeId)} → **${data.outcome ?? "?"}**`];
            const duration = formatDuration(data.durationMs);
            if (duration) parts.push(`in ${duration}`);
            const tools = formatToolCalls(data.toolCalls);
            if (tools) parts.push(`· ${tools}`);
            const lines = [`${parts.join(" ")}.`];
            if (data.outputPreview && data.outputPreview !== "null") lines.push(`Output: ${code(shortPreview(data.outputPreview))}`);
            if (data.stderrTail) lines.push("", "```text", shortPreview(data.stderrTail, 1_000), "```");
            return lines.join("\n");
        }
        case "workflow.node_failed":
            return `✗ Step ${data.step ?? "?"}: ${code(data.nodeId)} could not run: ${data.error ?? "unknown error"}`;
        case "workflow.completed": {
            const lines = [
                `■ Workflow **${data.name ?? "workflow"}** completed after ${data.steps ?? "?"} step${data.steps === 1 ? "" : "s"} `
                + `with outcome **${data.outcome ?? "?"}**${data.terminalNodeId ? ` at ${code(data.terminalNodeId)}` : ""}.`,
            ];
            if (data.outputPreview && data.outputPreview !== "null") {
                lines.push("", "```json", shortPreview(data.outputPreview, 1_000), "```");
            }
            return lines.join("\n");
        }
        case "workflow.failed":
            return `✗ Workflow **${data.name ?? "workflow"}** failed after ${data.steps ?? 0} step${data.steps === 1 ? "" : "s"}`
                + `${data.terminalNodeId ? ` at ${code(data.terminalNodeId)}` : ""}: ${data.error ?? "unknown error"}`;
        case "workflow.node_cancelled": {
            const duration = formatDuration(data.durationMs);
            return `⏹ Step ${data.step ?? "?"}: ${code(data.nodeId)} stopped${duration ? ` after ${duration}` : ""}.`;
        }
        case "workflow.cancelled":
            return `⏹ Workflow **${data.name ?? "workflow"}** stopped after ${data.steps ?? 0} step${data.steps === 1 ? "" : "s"}`
                + `${data.terminalNodeId ? ` at ${code(data.terminalNodeId)}` : ""}: ${data.reason ?? "cancelled"}`;
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
        case "workflow.node_started":
            return { kind: "notice", title: stepTitle, color: "gray", summary: `${data.nodeId ?? "?"} started (${data.runtime ?? "script"})`, text };
        case "workflow.node_completed": {
            const duration = formatDuration(data.durationMs);
            const tools = formatToolCalls(data.toolCalls);
            const summary = `${data.nodeId ?? "?"} → ${data.outcome ?? "?"}${duration ? ` in ${duration}` : ""}${tools ? ` · ${tools}` : ""}`;
            return { kind: "notice", title: stepTitle, color: data.exitCode === 0 || data.resultSource === "reported" ? "green" : "yellow", summary, text };
        }
        case "workflow.node_failed":
            return { kind: "notice", title: stepTitle, color: "red", summary: `${data.nodeId ?? "?"} could not run: ${data.error ?? "unknown error"}`, text };
        case "workflow.node_cancelled": {
            const duration = formatDuration(data.durationMs);
            return { kind: "notice", title: stepTitle, color: "yellow", summary: `${data.nodeId ?? "?"} stopped${duration ? ` after ${duration}` : ""}`, text };
        }
        default:
            return null;
    }
}
