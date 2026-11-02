/**
 * The compact polling log of a workflow session's transcript.
 *
 * A polling workflow runs the same script state again and again through a
 * `wait` state: check, wait, check, wait. Listing every visit buries what
 * matters, so repeated visits of one script state through a wait loop
 * collapse into ONE row that updates in place:
 *
 *   ◇ check: Waiting · 37 checks · idle · last checked 01:20 · last 0.8 s · next check 01:30
 *
 * Opening the row shows the latest attempts and the latest output. A visit
 * with a different outcome, a failure, or any other event ends the group,
 * and is shown as its own row. This is a display projection only: the
 * durable events are unchanged, and no model reads this transcript.
 * After Affan Dar's compact progress rows, keyed on wait states here.
 */
import { WORKFLOW_SESSION_GLYPH } from "./workflow-sessions.js";

/** The most attempts a group row lists when opened. */
export const WORKFLOW_PROGRESS_DETAIL_LIMIT = 40;

const PREVIEW_CHARS = 1_000;

function duration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value < 0) return null;
    return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(1)} s`;
}

function clock(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value)) return null;
    try {
        return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
        return new Date(value).toISOString().slice(11, 16);
    }
}

function millis(value) {
    if (value instanceof Date) return value.getTime();
    const parsed = typeof value === "number" ? value : Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : null;
}

function cell(value) {
    return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * What the grouping needs from one step event, kept on its transcript row.
 * A "healthy" attempt reported its result (or exited 0), wrote nothing to
 * stderr and had no failed tool call: only those are folded away.
 */
export function workflowStepInfo(event) {
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    const toolCalls = Array.isArray(data.toolCalls) ? data.toolCalls : [];
    return {
        stateId: typeof data.stateId === "string" ? data.stateId : null,
        step: Number.isSafeInteger(Number(data.step)) ? Number(data.step) : null,
        visit: Number.isSafeInteger(Number(data.visit)) && Number(data.visit) > 0 ? Number(data.visit) : null,
        outcome: typeof data.outcome === "string" ? data.outcome : null,
        durationMs: data.durationMs,
        tools: toolCalls.length,
        outputPreview: typeof data.outputPreview === "string" ? data.outputPreview.slice(0, PREVIEW_CHARS) : null,
        healthy: (data.resultSource === "reported" || data.resultSource === "stdout" || data.exitCode === 0)
            && !data.stderrTail && !toolCalls.some((call) => call?.ok === false),
        at: millis(event?.createdAt),
        until: millis(data.until),
    };
}

function entryOf(step) {
    return { step: step.step, outcome: step.outcome, durationMs: step.durationMs, tools: step.tools, outputPreview: step.outputPreview, at: step.at };
}

const STATUS = { checking: "Checking", checked: "Checked", waiting: "Waiting", ended: "Polling ended" };

/** The row for a group, built from its progress state. */
export function renderWorkflowProgress(base, progress) {
    const latest = progress.entries.at(-1);
    const count = Math.max(progress.count, progress.entries.length);
    const parts = [STATUS[progress.phase] ?? "Waiting", `${count} check${count === 1 ? "" : "s"}`];
    if (progress.outcome) parts.push(progress.outcome);
    const checked = clock(latest?.at);
    if (checked) parts.push(`last checked ${checked}`);
    const took = duration(latest?.durationMs);
    if (took) parts.push(`last ${took}`);
    const next = progress.phase === "waiting" ? clock(progress.nextAt) : null;
    if (next) parts.push(`next check ${next}`);
    const lines = [
        "| Step | Outcome | Time | Tools |",
        "|---|---|---|---|",
        ...progress.entries.map((entry) => `| ${entry.step ?? "?"} | ${cell(entry.outcome)} | ${duration(entry.durationMs) ?? "—"} | ${entry.tools} |`),
    ];
    if (count > progress.entries.length) {
        lines.push("", `Showing the latest ${progress.entries.length} of ${count} checks; full events remain in the execution log.`);
    }
    if (latest?.outputPreview && latest.outputPreview !== "null") {
        lines.push("", "Latest output:", "", "```json", latest.outputPreview, "```");
    }
    return {
        ...base,
        text: lines.join("\n"),
        workflowProgress: progress,
        workflowNotice: {
            title: `${WORKFLOW_SESSION_GLYPH} ${progress.stateId}`,
            summary: parts.join(" · "),
            color: progress.phase === "ended" ? "gray" : "cyan",
            progress: true,
        },
    };
}

/** The latest workflow rows of this session, newest first: [{ index, row }]. */
function workflowTail(chat, sessionId, limit) {
    const found = [];
    for (let i = chat.length - 1; i >= 0 && found.length < limit; i--) {
        const row = chat[i];
        if (row?.workflowEvent && row.sessionId === sessionId) found.push({ index: i, row });
    }
    return found;
}

/**
 * Append one workflow event's row to `chat`, folding repeated visits of a
 * script state through a wait loop into one row. `message` is the event's
 * ordinary row (history.js), carrying `workflowStep` for step events.
 */
export function appendWorkflowEvent(chat, event, message) {
    const type = event?.eventType;
    const step = message.workflowStep ?? null;
    const [last, second, third] = workflowTail(chat, message.sessionId, 3);
    const open = last?.row.workflowProgress && last.row.workflowProgress.phase !== "ended" ? last : null;

    if (open) {
        const progress = open.row.workflowProgress;
        const same = step?.stateId === progress.stateId;
        let next = null;
        if (type === "workflow.state_started" && same && progress.phase === "waiting") {
            next = { ...progress, phase: "checking" };
        } else if (type === "workflow.state_completed" && same && progress.phase === "checking"
            && step.outcome === progress.outcome && step.healthy) {
            next = {
                ...progress,
                phase: "checked",
                count: Math.max(progress.count + 1, step.visit ?? 0),
                entries: [...progress.entries, entryOf(step)].slice(-WORKFLOW_PROGRESS_DETAIL_LIMIT),
            };
        } else if (type === "workflow.state_waiting" && progress.phase === "checked") {
            next = { ...progress, phase: "waiting", nextAt: step?.until ?? null };
        }
        if (next) {
            chat[open.index] = renderWorkflowProgress(open.row, next);
            return;
        }
        // Anything else ends the group; the event gets its own row.
        chat[open.index] = renderWorkflowProgress(open.row, { ...progress, phase: "ended" });
        chat.push(message);
        return;
    }

    // The second visit of a script state that came back through a wait:
    // fold its first visit (started, completed, waiting rows) into a group.
    if (type === "workflow.state_started" && step?.stateId
        && last?.row.workflowEvent === "workflow.state_waiting"
        && second?.row.workflowEvent === "workflow.state_completed"
        && second.row.workflowStep?.stateId === step.stateId && second.row.workflowStep.healthy) {
        const completed = second.row.workflowStep;
        const started = third?.row.workflowEvent === "workflow.state_started"
            && third.row.workflowStep?.stateId === step.stateId && third.row.workflowStep.step === completed.step ? third : null;
        const progress = {
            stateId: step.stateId,
            outcome: completed.outcome,
            phase: "checking",
            count: Math.max(1, completed.visit ?? 0),
            entries: [entryOf(completed)],
            nextAt: last.row.workflowStep?.until ?? null,
        };
        const base = { ...(started?.row ?? second.row), sessionId: message.sessionId, workflowEvent: "workflow.progress" };
        delete base.workflowStep;
        delete base.cardTitle;
        delete base.cardTitleColor;
        for (const index of [last.index, second.index, ...(started ? [started.index] : [])].sort((a, b) => b - a)) chat.splice(index, 1);
        chat.push(renderWorkflowProgress(base, progress));
        return;
    }

    chat.push(message);
}
