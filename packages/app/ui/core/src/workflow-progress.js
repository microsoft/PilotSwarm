import { formatLocalTime } from "./formatting.js";
import { WORKFLOW_ATTENTION_OUTCOMES, WORKFLOW_CONTROL_EVENT_TYPES, WORKFLOW_SESSION_GLYPH } from "./workflow-sessions.js";

const DETAIL_LIMIT = 40;
const stepEvents = new Set(["workflow.state_started", "workflow.state_completed"]);
// A graceful stop ends the run too (adversarial review R2-UI-6): a summary still waiting is closed by it.
const terminalEvents = new Set(["workflow.completed", "workflow.failed", "workflow.cancelled", "workflow.stopped"]);
const significantOutcomes = WORKFLOW_ATTENTION_OUTCOMES;
// Control and side-effect rows (pause, resume, variables, input, recovery, cancel request, parent notice) are not steps: a
// summary row is found past them and keeps updating, and they neither end nor split it.
const controlEvents = new Set(WORKFLOW_CONTROL_EVENT_TYPES);
const runIdOf = (data) => typeof data?.runId === "string" && data.runId !== "" ? data.runId : null;
/** A branch's scope ("<parallel visit>#<index>"): its visit numbers count on their own, and it runs beside other branches. */
const branchScope = scopeId => typeof scopeId === "string" && scopeId.includes("#");
const isStepRow = (row, sessionId) => Boolean(row?.workflowEvent) && row.sessionId === sessionId && !controlEvents.has(row.workflowEvent);
/** Where a row's step ran: its summary's run, scope and visit, or what a plain step row was marked with (null: version 1). */
function laneOf(row) {
    const progress = row?.workflowProgress;
    if (progress) return { runId: progress.runId ?? null, scopeId: progress.scopeId ?? null, nodeExecutionId: progress.nodeExecutionId ?? null };
    return row?.workflowLane ?? null;
}

/**
 * The scope of a step's event (adversarial review R2-UI-4 and its re-check RC-4): the root scope or one branch of one
 * parallel visit, whose visit numbers count on their own. A start names its scope; a completion that does not is the one
 * of the row its visit (its node execution) started in, else its own visit only, so it never joins another branch's
 * group. A version 1 event names neither: null, as before.
 */
function scopeOf(chat, sessionId, data) {
    if (typeof data?.scopeId === "string" && data.scopeId) return data.scopeId;
    if (typeof data?.nodeExecutionId !== "string" || !data.nodeExecutionId) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!isStepRow(chat[i], sessionId)) continue;
        const lane = laneOf(chat[i]);
        if (lane?.nodeExecutionId === data.nodeExecutionId) return lane.scopeId ?? null;
    }
    return `visit:${data.nodeExecutionId}`;
}

/**
 * The step row an event continues (re-check RC-4): for a branch, the latest row of that run's same branch, so another
 * branch's start or end never finishes or splits its summary; otherwise the latest step row outside every branch, as
 * before (the root, a version 1 run, or a visit whose start is not loaded). -1 when there is none.
 */
function laneIndex(chat, sessionId, runId, scopeId) {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!isStepRow(chat[i], sessionId)) continue;
        const lane = laneOf(chat[i]);
        if (branchScope(scopeId)) {
            if (lane && (lane.runId ?? null) === runId && lane.scopeId === scopeId) return i;
        } else if (!branchScope(lane?.scopeId)) {
            return i;
        }
    }
    return -1;
}

/** A plain step row, marked with where its step ran, so its completion and later steps of its branch find it. */
function laned(message, runId, scopeId, data) {
    if (scopeId === null && runId === null) return message;
    const nodeExecutionId = typeof data?.nodeExecutionId === "string" && data.nodeExecutionId ? data.nodeExecutionId : null;
    return { ...message, workflowLane: { runId, scopeId, nodeExecutionId } };
}

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
    if (latest?.outputPreview && latest.outputPreview !== "null") {
        const fence = "`".repeat(Math.max(3, ...[...latest.outputPreview.matchAll(/`+/g)].map(match => match[0].length + 1)));
        lines.push("", "Latest output:", "", `${fence}json`, latest.outputPreview, fence);
    }
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

/** Finish every summary of the session still checking or waiting that `which` picks (its progress), newest first. */
function finishGroups(chat, sessionId, which) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const progress = chat[i]?.workflowProgress;
        if (progress && chat[i].sessionId === sessionId && (progress.pending || progress.waiting) && which(progress)) finishGroup(chat, i, chat[i]);
    }
}

/**
 * Project repeated state attempts into one display row; durable events remain unchanged. Each branch of a parallel visit
 * keeps its own summaries (re-check RC-4): a step event continues the latest row of its own run and branch, a run's end
 * finishes every summary of that run, and a step event outside the branches continues the latest row outside them.
 */
export function appendWorkflowProgress(chat, event, message) {
    const data = event.data ?? {};
    const runId = runIdOf(data);
    const sessionId = message.sessionId;
    if (event.eventType === "workflow.started") {
        // A v2 run names itself. Every summary of an earlier run ends here, and nothing later merges into it.
        if (runId) finishGroups(chat, sessionId, () => true);
        chat.push({ ...message, workflowDefinition: Array.isArray(data.states) ? data.states : [], workflowRunId: runId });
        return;
    }
    if (terminalEvents.has(event.eventType)) {
        // The run ended (or stopped): every summary of it still checking or waiting ends, in every branch.
        finishGroups(chat, sessionId, progress => (progress.runId ?? null) === runId);
        chat.push(message);
        return;
    }
    const scopeId = scopeOf(chat, sessionId, data);
    const index = laneIndex(chat, sessionId, runId, scopeId);
    const previous = index >= 0 ? chat[index] : null;
    const prior = previous?.workflowProgress;
    if (!stepEvents.has(event.eventType)) {
        // Another event of a step (failed, cancelled, ...) ends the summary of its own branch only.
        if (prior && event.eventType.startsWith("workflow.state_")) finishGroup(chat, index, previous);
        chat.push(event.eventType.startsWith("workflow.state_") ? laned(message, runId, scopeId, data) : message);
        return;
    }
    const step = Number(data.step);
    if (!data.stateId || !Number.isSafeInteger(step) || step < 1) {
        chat.push(laned(message, runId, scopeId, data));
        return;
    }
    const started = event.eventType === "workflow.state_started";
    let definition;
    for (let i = chat.length - 1; i >= 0; i--) {
        const item = chat[i];
        if (item?.sessionId === message.sessionId && item.workflowDefinition) {
            // The latest definition describes only its own run. Another run's step is not matched against it, so a
            // run on another revision is never read through this one's transitions.
            if ((item.workflowRunId ?? null) === runId) definition = item.workflowDefinition.find(node => node?.id === data.stateId);
            break;
        }
    }
    // The same state of another run, or of another branch or parallel visit (their step numbers start again: R2-UI-4), is
    // not a continuation.
    const sameState = prior?.stateId === data.stateId && (prior.runId ?? null) === runId && (prior.scopeId ?? null) === scopeId;
    const selfLoop = definition && Object.values(definition.next ?? {}).includes(data.stateId);
    const eligible = definition ? (started ? selfLoop : definition.next?.[data.outcome] === data.stateId) : Boolean(sameState);
    // A v2 business result completed normally and carries no exit code; a v2 runtime error or an unknown result kind is never a quiet repeat. A business
    // outcome the author named as significant (failure, blocked, ...) stays its own row, as it does for legacy steps.
    // The old exit-code rule applies only when there is no result kind at all; an explicit kind this build does not know never groups.
    const hasKind = data.resultKind !== undefined && data.resultKind !== null;
    const completedCleanly = data.resultKind === "business" ? true
        : hasKind ? false
            : data.exitCode === 0 || data.resultSource === "reported" || data.resultSource === "stdout";
    const healthy = started || (!significantOutcomes.has(String(data.outcome ?? "").toLowerCase())
        && completedCleanly
        && !(Array.isArray(data.toolCalls) ? data.toolCalls : []).some(call => call?.ok === false)
        && !data.stderrTail);
    // A paged transcript without its definition can still group loaded
    // attempts, but must not claim a lifetime count or hide failed output.
    const partialStart = !definition && !prior && started;
    if (!eligible && !partialStart) {
        finishGroup(chat, index, previous);
        chat.push(laned(message, runId, scopeId, data));
        return;
    }
    if (!healthy) {
        finishGroup(chat, index, previous);
        chat.push(laned(message, runId, scopeId, data));
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
        // The reader's own time zone, with its short name (owner decision local-time-20261104).
        checkedAt: Number.isNaN(timestamp.getTime()) ? null : formatLocalTime(timestamp, { clock: true }),
    }];
    const progress = {
        stateId: data.stateId,
        runId,
        scopeId,
        nodeExecutionId: typeof data.nodeExecutionId === "string" && data.nodeExecutionId ? data.nodeExecutionId : null,
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
