import React from "react";
import {
    compactWorkflowV2Executions, formatSeconds, formatWorkflowValue, projectWorkflowV2ReadModel, workflowV2RouteKind,
} from "../../core/src/workflow-v2-view.js";

const h = React.createElement;
const TONES = { error: "var(--ps-danger)", warning: "var(--ps-warning)", info: "var(--ps-muted)" };

/** Notices about the definition and the run. Text only; every value is a React child, never markup. */
export function WorkflowV2Banners({ banners }) {
    if (!banners?.length) return null;
    return h("div", { className: "ps-workflow-banners", role: "status", "aria-label": "Workflow notices",
        style: { display: "grid", gap: 4, padding: "6px 10px", fontSize: "0.75rem" } },
    banners.map((banner, i) => h("div", { key: i, "data-level": banner.level,
        style: { color: TONES[banner.level] || TONES.info, overflowWrap: "anywhere" } }, banner.text)));
}

export function WorkflowV2Diagnostics({ diagnostics }) {
    if (!diagnostics?.length) return null;
    return h("ul", { className: "ps-workflow-diagnostics", "aria-label": "Definition diagnostics",
        style: { margin: 0, paddingLeft: 18, fontSize: "0.8rem", overflowWrap: "anywhere" } },
    diagnostics.map((item, i) => h("li", { key: i, "data-severity": item.severity },
        h("strong", null, item.severity), " ", item.code, item.path ? ` · ${item.path}` : "", item.line ? ` · line ${item.line}` : "",
        ": ", item.message)));
}

/** Shown in place of the graph when the read model has no graph to draw: draft without a graph, invalid, or unrecognized. */
export function WorkflowV2NoGraph({ projection }) {
    const alert = projection.banners.some(banner => banner.level === "error");
    return h("div", { className: "ps-workflow-empty", role: alert ? "alert" : "status" },
        h("strong", null, projection.modelStatus === "invalid" ? "This workflow definition is invalid" : "No workflow graph to show"),
        h(WorkflowV2Banners, { banners: projection.banners }),
        h(WorkflowV2Diagnostics, { diagnostics: projection.diagnostics }));
}

function Value({ value, label }) {
    const { text, truncated } = formatWorkflowValue(value);
    if (!text) return null;
    return h(React.Fragment, null,
        label ? h("h3", null, label) : null,
        h("pre", null, text),
        truncated ? h("p", null, "This preview was cut short; the full value is not in this view.") : null);
}

/** The recipient's intake line. It sits beside the delivery rows and never replaces them; every value is text. */
function IntakeOutcome({ intake }) {
    const refused = intake.kind !== "unknown";
    const row = (label, value) => h("div", { className: "ps-workflow-property", key: label },
        h("span", null, label), h("strong", null, value));
    return h("div", { className: "ps-workflow-intake", "data-intake": intake.kind },
        row("Recipient intake", refused ? `Refused · ${intake.reason}`
            : `Unrecognized outcome${intake.raw ? ` · ${intake.raw}` : ""}`),
        row("Intake noted at", intake.at || "Time not recorded"),
        h("p", null, refused
            ? "The recipient's intake refused this message. This does not change the recorded delivery state or show that the recipient read or acted on it."
            : "This intake note is not recognized, so it is not shown as a result. The delivery above is as recorded."));
}

const resultLabel = execution => execution.status === "pending" ? "Pending"
    : execution.resultKind === "business" ? "Business result"
        : execution.resultKind === "runtime_error" ? "Runtime error" : "Result kind not recorded";

function kindProperties(node, current) {
    const rows = [];
    if (node.kind === "script") rows.push(["Timeout", `${node.timeoutSeconds} s`]);
    if (node.kind === "wait") {
        rows.push(["Duration", typeof node.seconds === "number" ? formatSeconds(node.seconds) : String(node.seconds)]);
        if (current?.deadline) rows.push(["Deadline", current.deadline]);
    }
    if (node.kind === "receive") {
        rows.push(["Contract", node.contract], ["From", node.from === null ? "Any permitted sender" : node.from === "parent" ? "Parent session" : String(node.from)]);
        if (node.waitSeconds !== undefined) rows.push(["Wait limit", formatSeconds(node.waitSeconds)]);
    }
    if (node.kind === "send" || node.kind === "request") {
        rows.push(["Contract", node.contract], ["Recipient", node.recipient === "parent" ? "Parent session" : String(node.recipient)]);
        if (node.kind === "request" && node.timeoutSeconds !== undefined) rows.push(["Response deadline", typeof node.timeoutSeconds === "number" ? formatSeconds(node.timeoutSeconds) : String(node.timeoutSeconds)]);
    }
    return rows;
}

/** The tab panel body of a v2 node. The caller owns the tab strip so its tab semantics are unchanged. */
export function WorkflowV2NodeContent({ tab, selected, nodes, select, runOutput, runError }) {
    const property = (label, value) => h("div", { className: "ps-workflow-property", key: label },
        h("span", null, label), h("strong", null, value));
    const current = selected.current;
    if (tab === "details") {
        const lastOutcome = selected.outcome
            ? `${selected.outcome} · ${selected.resultKind === "runtime_error" ? "runtime error" : "business outcome"}` : "Not recorded";
        return h(React.Fragment, null,
            property("State", selected.stateLabel),
            property("Executions", `${selected.runs}${selected.partial ? " in loaded history" : ""}`),
            property("Last outcome", lastOutcome),
            kindProperties(selected, current).map(([label, value]) => property(label, value)),
            selected.description.map((line, i) => h("p", { key: i }, line)),
            selected.type === "terminal" ? h("p", null, selected.summary || "The workflow ends at this node.") : null,
            selected.next ? h("h3", null, "Transitions") : null,
            Object.entries(selected.next || {}).map(([label, target]) =>
                h("button", { key: label, type: "button", className: "ps-workflow-transition",
                    disabled: !nodes.some(node => node.id === target), onClick: () => select(target) },
                label, " → ", target, workflowV2RouteKind(selected, label) === "error" ? " · runtime error route" : "")),
            current?.inbox ? h(React.Fragment, null, h("h3", null, "Message taken"),
                property("Contract", current.inbox.contract), property("From", current.inbox.senderSessionId),
                h(Value, { value: current.inbox.payloadPreview })) : null,
            current?.outbox ? h(React.Fragment, null, h("h3", null, "Delivery"),
                property("Delivery state", current.outbox.state),
                property("Attempts", String(current.outbox.attempts ?? "—")),
                property("Recipient", current.outbox.recipientSessionId || "—"),
                current.outbox.intake ? h(IntakeOutcome, { intake: current.outbox.intake }) : null,
                h(Value, { value: current.outbox.payloadPreview, label: "Sent payload" })) : null);
    }
    if (tab === "output") {
        const result = selected.result;
        const terminalValue = selected.type === "terminal" ? (runError ?? runOutput) : null;
        return h(React.Fragment, null,
            h("p", null, "Latest result in the loaded history for this node."),
            !result && terminalValue === null ? h("pre", null, "This node has no result in the loaded history.") : null,
            result?.resultKind === "runtime_error"
                ? h(Value, { value: result.errorPreview ?? result.outcome ?? (result.effectStatus ? `Effect ${result.effectStatus}` : "No error text was recorded."), label: "Runtime error" })
                : result ? (result.outputPreview !== undefined ? h(Value, { value: result.outputPreview, label: "Output" })
                    : h("pre", null, "This state records no output.")) : null,
            terminalValue !== null ? h(Value, { value: terminalValue, label: runError !== null && runError !== undefined ? "Run error" : "Run output" }) : null);
    }
    const rows = compactWorkflowV2Executions(selected.executions);
    const table = items => h("table", null,
        h("thead", null, h("tr", null, ["Visit", "Result", "Outcome"].map(label => h("th", { key: label }, label)))),
        h("tbody", null, items.map(({ execution, count, from, to }, i) => h("tr", { key: execution.id || i },
            h("td", null, count > 1 ? `${from}–${to} (×${count})` : String(execution.ordinal ?? "—")),
            h("td", null, resultLabel(execution)),
            h("td", null, execution.outcome || "—")))));
    return h(React.Fragment, null,
        h("p", null, "Most recent executions available in the loaded history. Unchanged repeats are combined."),
        rows.length ? table(rows) : h("p", null, "No executions in the loaded history."),
        selected.executions.length > rows.length ? h("details", null,
            h("summary", null, `Every loaded execution (${selected.executions.length})`),
            table(selected.executions.map(execution => ({ execution, count: 1, from: execution.ordinal, to: execution.ordinal })))) : null);
}

// ── Run picker ──────────────────────────────────────────────────────────────
// Chooses which run of a v2 workflow the graph, log and details show. The list is `runs` of the read model that
// readWorkflowV2View returns ({ runId, mode: "live" | "test", status, revision, outcome }); the choice is
// `ui.workflowViews[sessionId].selectedRunId`, where null is the live run. Nothing here fetches: the controller's
// ensureWorkflowReadModel reads the selected run, and the projection overlays only that run's own model.

const RUN_MODES = { live: "Live", test: "Test" };
const RUN_STATUS_WORDS = new Set(["admitted", "running", "paused", "completed", "failed", "cancelled"]);
const RUN_OPTION_LIMIT = 100;
const LABEL_LIMIT = 100;

const bounded = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const shortId = id => id.length > 12 ? `${id.slice(0, 8)}…` : id;

/** One option's text, naming the kind, status, outcome, revision and a short run id; long values are cut. */
function runLabel(run) {
    const kind = RUN_MODES[run.mode] ?? "Run (mode not recognized)";
    const status = RUN_STATUS_WORDS.has(run.status) ? run.status : "status unknown";
    const outcome = typeof run.outcome === "string" && run.outcome ? ` (${run.outcome})` : "";
    const revision = Number.isSafeInteger(run.revision) ? ` · revision ${run.revision}` : "";
    return bounded(`${kind} · ${status}${outcome}${revision} · ${shortId(run.runId)}`, LABEL_LIMIT);
}

/**
 * What the picker shows, from the workflow's last read model (any selection's: the run list is workflow-wide), the
 * selection, whether the selection's own model is loaded, and its read error. Pure; never throws. Entries that are not
 * a run are counted and left out. A selected id that is not in the list is kept as its own option, never replaced.
 */
export function workflowV2RunPickerModel({ workflowModel = null, selectedRunId = null, ownModelLoaded = false, error = null } = {}) {
    const selection = typeof selectedRunId === "string" && selectedRunId !== "" ? selectedRunId : null;
    const projected = workflowModel ? projectWorkflowV2ReadModel(workflowModel) : null;
    const list = projected?.ok ? projected.runs : null;
    const runs = [];
    const seen = new Set();
    let malformed = 0;
    for (const item of list || []) {
        if (item === null || typeof item !== "object" || Array.isArray(item) || typeof item.runId !== "string" || item.runId === "" || seen.has(item.runId)) {
            malformed += 1;
            continue;
        }
        seen.add(item.runId);
        runs.push(item);
    }
    const live = runs.find(run => run.mode === "live");
    const shown = runs.slice(0, RUN_OPTION_LIMIT);
    const options = [{ value: "", kind: "live", title: "The workflow's live run",
        label: bounded(live ? `Live run · ${RUN_STATUS_WORDS.has(live.status) ? live.status : "status unknown"} · ${shortId(live.runId)}` : "Live run", LABEL_LIMIT) }];
    for (const run of shown) options.push({ value: run.runId, kind: run.mode === "test" ? "test" : run.mode === "live" ? "live" : "other", label: runLabel(run), title: run.runId });
    let missing = false;
    if (selection !== null && !seen.has(selection)) {
        missing = true;
        options.push({ value: selection, kind: "missing", title: selection,
            label: bounded(`Selected run ${shortId(selection)} · ${list ? "not in the run list that was read" : "run list not loaded"}`, LABEL_LIMIT) });
    } else if (selection !== null && !shown.some(run => run.runId === selection)) {
        const run = runs.find(item => item.runId === selection);
        options.push({ value: selection, kind: run.mode === "test" ? "test" : "live", label: runLabel(run), title: selection });
    }
    const notes = [];
    if (!list) notes.push({ level: "info", text: workflowModel ? "The run list is unavailable." : "Run list not loaded yet." });
    else if (runs.length === 0 && malformed === 0) notes.push({ level: "info", text: "No runs yet." });
    if (malformed) notes.push({ level: "warning", text: `${malformed} run ${malformed === 1 ? "entry" : "entries"} in the run list could not be read and ${malformed === 1 ? "is" : "are"} not listed.` });
    if (runs.length > RUN_OPTION_LIMIT) notes.push({ level: "info", text: `Showing the first ${RUN_OPTION_LIMIT} of ${runs.length} runs.` });
    if (missing && list) notes.push({ level: "warning", text: "This run is not in the run list that was read; only what is loaded for it is shown." });
    if (error) notes.push({ level: "error", text: "This run could not be read. Your selection is kept." });
    else if (!ownModelLoaded) notes.push({ level: "info", text: selection === null ? "Reading the live run…" : "Reading this run…" });
    return { selection, value: selection ?? "", options, notes, runsKnown: Boolean(list), runCount: runs.length, malformed, missing };
}

/** Select a run (null for the live run). Only the selection changes; the controller reads that run's model for it. */
export function selectWorkflowV2Run(controller, sessionId, runId) {
    const next = typeof runId === "string" && runId !== "" ? runId : null;
    controller.dispatch({ type: "ui/workflowView", sessionId, view: { selectedRunId: next } });
    return next;
}

/** A native select: keyboard, type-ahead and screen reader behaviour come with it. Every value is a React text child. */
export function WorkflowV2RunPicker({ controller, sessionId, workflowModel, selectedRunId, ownModelLoaded, error }) {
    const model = workflowV2RunPickerModel({ workflowModel, selectedRunId, ownModelLoaded, error });
    const noteId = `wf-run-note-${React.useId().replace(/:/g, "")}`;
    return h("div", { className: "ps-workflow-run-picker", style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0, maxWidth: "100%", fontSize: "0.75rem" } },
        h("select", { "aria-label": "Workflow run", "aria-describedby": model.notes.length ? noteId : undefined, value: model.value,
            "data-selection": model.selection ?? "live", title: model.options.find(option => option.value === model.value)?.title,
            style: { minWidth: 0, maxWidth: "26em", textOverflow: "ellipsis" },
            onChange: event => selectWorkflowV2Run(controller, sessionId, event.target.value) },
        model.options.map(option => h("option", { key: option.value === "" ? "live" : `run:${option.value}`, value: option.value, title: option.title, "data-kind": option.kind }, option.label))),
        model.notes.length ? h("span", { id: noteId, role: "status", "aria-live": "polite", style: { color: "var(--ps-muted)", overflowWrap: "anywhere" } },
            model.notes.map((note, i) => h("span", { key: i, "data-level": note.level, style: { marginRight: 6, color: TONES[note.level] || TONES.info } }, note.text))) : null);
}
