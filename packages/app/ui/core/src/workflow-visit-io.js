/**
 * A node's visit in its details, with its input and output (owner 2026-11-20: "For node details in a running graph when I
 * click on node details I want to see the inputs and outputs for that iteration. These need to change as I time travel
 * back and forth too."; the Workflow UX design's Step details: "Type, status, visits, inputs, output"). Which visit the
 * details show, live and while the timeline shows a moment, and its input and output as people read them. One model for
 * the portal's Node panel and the TUI's details, in the same words. Pure: `now` only decides whether a time shows its date.
 */
import { workflowNodeResult } from "./workflow-node-summary.js";
import { workflowRunsText, workflowShortTime, workflowTimeTitle } from "./workflow-words.js";

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const msOf = value => (typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN);

/** The words of a visit's input and output, shared by the portal and the TUI. */
export const WORKFLOW_VISIT_WORDS = Object.freeze({
    input: "Input",
    output: "Output",
    /** A visit whose input is not in the read shown (known only from its events so far, or a server that sends none). */
    inputNotLoaded: "Not loaded.",
    running: "No result yet: this visit is still running.",
    noOutput: "No output.",
    cut: "Start only.",
    summary: "Summary.",
    showAll: "Show all",
    showAllInput: "Show all input",
    /** An output a replay shows that its visit recorded after the moment shown. */
    recordedAfter: at => `Recorded ${at}, after this point`,
});

/** The latest of `visits` to be entered (by entry time, then visit number, then id); null for none. */
function latestEntered(visits) {
    let best = null;
    for (const item of visits) {
        if (!isRecord(item) || typeof item.id !== "string") continue;
        if (!best) { best = item; continue; }
        const a = msOf(item.enteredAt), b = msOf(best.enteredAt);
        const order = (Number.isFinite(a) ? a : -Infinity) - (Number.isFinite(b) ? b : -Infinity)
            || (item.ordinal ?? 0) - (best.ordinal ?? 0) || item.id.localeCompare(best.id);
        if (order > 0) best = item;
    }
    return best;
}

/**
 * The visit a node's details show, as it stood at the moment shown. `current`: the visit the details show otherwise (a
 * branch step's chosen branch's, else the node's current visit; default `node.current`). While the timeline shows a moment
 * (`frame`: workflowReplayFrames' { atMs, nodeExecutionId, stateId }), the replayed visit itself when this is its node and
 * no other branch was chosen (`picked`); a branch step otherwise shows its chosen branch's visit then (`current`); any other
 * node its latest visit entered by then (`node.executions` of the moment's projection holds only those). Live: `current`.
 * Null when there is none (not reached, or not reached in its parallel step's current visit). Pure.
 */
export function workflowDetailsVisit(node, { current = undefined, frame = null, picked = false } = {}) {
    if (!isRecord(node)) return null;
    const shown = current === undefined ? node.current ?? null : current;
    if (!isRecord(frame) || !Number.isFinite(frame.atMs)) return isRecord(shown) ? shown : null;
    const executions = Array.isArray(node.executions) ? node.executions : [];
    if (frame.stateId === node.id && !picked) {
        const pinned = executions.find(item => item?.id === frame.nodeExecutionId);
        if (pinned) return pinned;
    }
    if (typeof node.parallel === "string" || picked) return isRecord(shown) ? shown : null;
    return latestEntered(executions) ?? (isRecord(shown) ? shown : null);
}

/**
 * A value's preview (a read's inputPreview or outputPreview: canonical JSON, cut with "…" past its limit) as formatted
 * JSON: { text, truncated }. A preview that was cut short is shown as it arrived and says so. Null for no preview.
 */
export function workflowVisitValueText(preview) {
    if (preview === undefined || preview === null) return null;
    const raw = typeof preview === "string" ? preview : JSON.stringify(preview);
    try { return { text: JSON.stringify(JSON.parse(raw), null, 2), truncated: false }; } catch { return { text: raw, truncated: raw.endsWith("…") }; }
}

/** The recorded copy of `visit` among `visits` (every loaded visit as recorded, not as a moment shows it), else `visit`. */
export function workflowRecordedVisit(visits, visit) {
    if (!isRecord(visit) || typeof visit.id !== "string") return null;
    for (const item of Array.isArray(visits) ? visits : []) if (item?.id === visit.id && isRecord(item)) return item;
    return visit;
}

/** Its output as recorded (`full`, ended): { kind, label, text, truncated, summary, semantic, error, executionId }. */
function outputOf(node, full) {
    const plain = node?.notReached ? { ...node, notReached: undefined } : node;
    const decision = node?.kind === "decision" || node?.type === "decision";
    // A Decision's semantic result and an error in words, as the node's result says them (workflowNodeResult).
    if (decision || full.resultKind === "runtime_error") {
        const result = workflowNodeResult(plain, full);
        if (result) return { kind: result.error ? "error" : "output", label: result.label, text: result.text, truncated: Boolean(result.truncated),
            summary: Boolean(result.summary), semantic: Boolean(result.semantic), error: Boolean(result.error), executionId: full.id };
        return { kind: "none", label: WORKFLOW_VISIT_WORDS.output, text: WORKFLOW_VISIT_WORDS.noOutput, truncated: false, executionId: full.id };
    }
    const value = full.outputPreview === "null" ? null : workflowVisitValueText(full.outputPreview);
    if (value) return { kind: "output", label: WORKFLOW_VISIT_WORDS.output, text: value.text, truncated: value.truncated, summary: false,
        semantic: false, error: false, executionId: full.id };
    // A message sent or taken, when the visit records no output of its own.
    const message = full.outputPreview === undefined ? workflowNodeResult(plain, full) : null;
    if (message) return { kind: "output", label: message.label, text: message.text, truncated: Boolean(message.truncated), summary: false,
        semantic: false, error: false, executionId: full.id };
    return { kind: "none", label: WORKFLOW_VISIT_WORDS.output, text: WORKFLOW_VISIT_WORDS.noOutput, truncated: false, executionId: full.id };
}

/**
 * One visit of a node with its input and output, for its details: { id, ordinal, header, input, output }. `visit` is the
 * visit as the moment shown has it (workflowDetailsVisit); `recorded` its copy as recorded (workflowRecordedVisit: a
 * replay's moment has no result for a visit that ended later); `atMs` the moment a replay shows (null live).
 *
 * `header`: "Visit 2 of 3 · entered 15:13:30 · ended 15:13:33" ("· running" while it runs then; a branch's visit names its
 * item instead of the count). `input`: { text, truncated } as formatted JSON, or null when the read shown has none.
 * `output`: its recorded output as formatted JSON, a Decision's semantic result, or its error in words ({ kind: output,
 * error, none or pending, label, text, truncated, summary, semantic, error, executionId }), with `recordedAfter` ("Recorded
 * 2026-11-20 15:13:33 UTC, after this point") when a replay shows a moment before the visit ended. Null without a visit.
 */
export function workflowVisitIo(node, visit, { recorded = null, atMs = null, now = Date.now() } = {}) {
    if (!isRecord(visit) || typeof visit.id !== "string") return null;
    const full = isRecord(recorded) && recorded.id === visit.id ? recorded : visit;
    const ended = full.status === "completed";
    const endMs = msOf(full.endedAt ?? full.completedAt);
    const after = ended && Number.isFinite(atMs) && Number.isFinite(endMs) && endMs > atMs;
    const clock = value => { const ms = msOf(value); return Number.isFinite(ms) ? workflowShortTime(ms, now) : null; };
    const ordinal = Number.isSafeInteger(visit.ordinal) ? visit.ordinal : null;
    const place = typeof node?.where?.[visit.id]?.label === "string" ? node.where[visit.id].label : null;
    const runs = Number.isSafeInteger(node?.runs) ? node.runs : null;
    const count = !place && ordinal !== null && runs !== null && runs >= ordinal ? ` of ${workflowRunsText(runs, Boolean(node.partial))}` : "";
    const entered = clock(visit.enteredAt);
    const endedAt = ended && !after ? clock(full.endedAt ?? full.completedAt) : null;
    const header = [ordinal === null ? "This visit" : `Visit ${ordinal}${count}`, place, entered ? `entered ${entered}` : null,
        ended && !after ? (endedAt ? `ended ${endedAt}` : "ended") : "running"].filter(Boolean).join(" · ");
    const output = ended ? outputOf(node, full)
        : { kind: "pending", label: WORKFLOW_VISIT_WORDS.output, text: WORKFLOW_VISIT_WORDS.running, truncated: false, executionId: full.id };
    return {
        id: visit.id, ordinal, header,
        input: workflowVisitValueText(visit.inputPreview ?? full.inputPreview),
        output: { ...output, recordedAfter: after ? WORKFLOW_VISIT_WORDS.recordedAfter(workflowTimeTitle(endMs)) : null },
    };
}

/**
 * One execution's whole input as the view read it (the controller's loadWorkflowExecutionValue keeps the read's
 * `execution.input` beside its result), as workflowWholeValue says a result: `loading`, `failed` with its error, `none`
 * (the read gave none: a server that sends none), `value` (the whole input, formatted, with its size in bytes) or `preview`
 * (a stored value larger than a read returns, its start, with its size and the limit). Null without an entry. Pure.
 */
export function workflowWholeInput(entry) {
    if (!isRecord(entry)) return null;
    if (entry.phase === "loading") return { kind: "loading" };
    if (entry.phase === "failed") return { kind: "failed", error: typeof entry.error === "string" && entry.error ? entry.error : "The value could not be read." };
    const input = isRecord(entry.input) ? entry.input : null;
    if (!input) return { kind: "none" };
    const bytes = Number.isSafeInteger(input.bytes) ? input.bytes : null;
    if (input.whole === true) {
        const value = input.value ?? null;
        return { kind: "value", label: WORKFLOW_VISIT_WORDS.input, bytes, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) };
    }
    return { kind: "preview", label: WORKFLOW_VISIT_WORDS.input, bytes, limitBytes: Number.isSafeInteger(input.limitBytes) ? input.limitBytes : null,
        text: typeof input.preview === "string" ? input.preview : "" };
}
