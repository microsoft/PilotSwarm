import { WORKFLOW_SESSION_GLYPH } from "./workflow-sessions.js";

const DETAIL_LIMIT = 40;
const stepEvents = new Set(["workflow.state_started", "workflow.state_completed"]);
const terminalEvents = new Set(["workflow.completed", "workflow.failed", "workflow.cancelled"]);
const significantOutcomes = new Set(["changed", "change", "failure", "failed", "error", "timeout", "cancelled", "canceled", "blocked"]);

function duration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function cell(value) {
    return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function render(message) {
    const progress = message.workflowProgress;
    const latest = progress.entries.at(-1);
    const count = progress.count;
    const label = progress.polling ? "check" : "run";
    const status = progress.pending ? "Checking" : progress.waiting ? "Waiting for changes" : "Polling ended";
    const parts = [`${count} ${label}${count === 1 ? "" : "s"}${progress.partial ? " loaded" : ""}`];
    if (progress.outcome) parts.push(progress.outcome);
    if (latest?.checkedAt) parts.push(`last checked ${latest.checkedAt}`);
    const elapsed = duration(latest?.durationMs);
    if (elapsed) parts.push(`last ${elapsed}`);
    const lines = [
        `**${cell(progress.stateId)}**: ${status} · ${parts.join(" · ")}`,
        "",
        "| Step | Outcome | Time | Tools |",
        "|---|---|---|---|",
        ...progress.entries.map(entry => `| ${entry.step} | ${cell(entry.outcome)} | ${duration(entry.durationMs) ?? "—"} | ${entry.tools} |`),
    ];
    if (count > progress.entries.length) lines.push("", `Showing the latest ${progress.entries.length} of ${count} ${label}s. Full events remain in the execution log.`);
    if (latest?.outputPreview && latest.outputPreview !== "null") lines.push("", "Latest output:", "", "```json", latest.outputPreview, "```");
    return {
        ...message,
        text: lines.join("\n"),
        workflowNotice: {
            title: `${WORKFLOW_SESSION_GLYPH} ${status}`,
            summary: parts.join(" · "),
            color: progress.pending || progress.waiting ? "cyan" : "gray",
            progress: true,
        },
    };
}

function finishGroup(chat, index, previous) {
    if (!previous?.workflowProgress) return;
    if (!previous.workflowProgress.count) chat.splice(index, 1);
    else chat[index] = render({ ...previous, workflowProgress: { ...previous.workflowProgress, pending: false, waiting: false } });
}

/** Project repeated state attempts into one display row; durable events remain unchanged. */
export function appendWorkflowProgress(chat, event, message) {
    const data = event.data ?? {};
    if (event.eventType === "workflow.started") {
        chat.push({ ...message, workflowDefinition: Array.isArray(data.states) ? data.states : [] });
        return;
    }
    let index = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.workflowEvent && chat[i].sessionId === message.sessionId) { index = i; break; }
    }
    const previous = index >= 0 ? chat[index] : null;
    const prior = previous?.workflowProgress;
    if (!stepEvents.has(event.eventType)) {
        if (prior && (terminalEvents.has(event.eventType) || event.eventType.startsWith("workflow.state_"))) {
            finishGroup(chat, index, previous);
        }
        chat.push(message);
        return;
    }
    const step = Number(data.step);
    if (!data.stateId || !Number.isSafeInteger(step) || step < 1) {
        chat.push(message);
        return;
    }
    const started = event.eventType === "workflow.state_started";
    const definition = [...chat].reverse().find(item => item.sessionId === message.sessionId && item.workflowDefinition)?.workflowDefinition
        ?.find(node => node.id === data.stateId);
    const sameState = prior?.stateId === data.stateId;
    const selfLoop = definition && Object.values(definition.next ?? {}).includes(data.stateId);
    const eligible = definition ? (started ? selfLoop : definition.next?.[data.outcome] === data.stateId) : Boolean(sameState);
    const healthy = started || (!significantOutcomes.has(String(data.outcome ?? "").toLowerCase())
        && (data.exitCode === 0 || data.resultSource === "reported" || data.resultSource === "stdout")
        && !(Array.isArray(data.toolCalls) ? data.toolCalls : []).some(call => call?.ok === false)
        && !data.stderrTail);
    // A paged transcript without its definition can still group loaded
    // attempts, but must not claim a lifetime count or hide failed output.
    const partialStart = !definition && !prior && started;
    if (!eligible && !partialStart) {
        finishGroup(chat, index, previous);
        chat.push(message);
        return;
    }
    if (!healthy) {
        finishGroup(chat, index, previous);
        chat.push(message);
        return;
    }
    if (sameState && (step < prior.lastStep || (step === prior.lastStep && (!prior.pending || started)))) return;
    const sameOutcome = started || !prior?.count || prior.outcome === data.outcome;
    const contiguous = sameState && (step === prior.lastStep || step === prior.lastStep + 1);
    const merge = contiguous && sameOutcome;
    if (prior && !merge) {
        finishGroup(chat, index, previous);
    }
    const polling = Boolean(selfLoop) || (merge && (prior.polling || step > prior.firstStep));
    const timestamp = new Date(event.createdAt ?? event.timestamp ?? event.time);
    const entry = started ? [] : [{
        step, outcome: data.outcome, durationMs: data.durationMs,
        tools: Array.isArray(data.toolCalls) ? data.toolCalls.length : 0,
        outputPreview: typeof data.outputPreview === "string" ? data.outputPreview.slice(0, 1000) : null,
        checkedAt: Number.isNaN(timestamp.getTime()) ? null : `${timestamp.toISOString().slice(11, 19)} UTC`,
    }];
    const progress = {
        stateId: data.stateId,
        firstStep: merge ? prior.firstStep : step,
        lastStep: step,
        count: (merge ? prior.count : 0) + (started ? 0 : 1),
        entries: [...(merge ? prior.entries : []), ...entry].slice(-DETAIL_LIMIT),
        outcome: started ? (merge ? prior.outcome : null) : data.outcome,
        pending: started,
        waiting: !started && Boolean(polling),
        polling: Boolean(polling),
        partial: merge ? prior.partial : !definition,
    };
    const rendered = render({ ...message, id: merge ? previous.id : message.id, workflowProgress: progress });
    if (merge) chat[index] = rendered;
    else chat.push(rendered);
}
