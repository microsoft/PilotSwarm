import React from "react";
import {
    compactWorkflowV2Executions, formatSeconds, formatWorkflowValue, workflowV2Activity, workflowV2AgentBindingRows, workflowV2AgentTask, workflowV2ExecutionResult,
    workflowV2ExecutionValue, workflowV2KvApplied, workflowV2KvCompare, workflowV2KvSnapshot, workflowV2RouteKind, workflowV2SessionSubtree, workflowV2ShownExecution,
    workflowV2AgentEndText, workflowV2EventTime, workflowV2ShortHash, workflowV2VisitEnding, workflowV2WholeValue,
} from "../../core/src/workflow-v2-view.js";
import { workflowV2RunPickerModel } from "../../core/src/workflow-v2-run-picker.js";
import { WorkflowToolButton } from "./workflow-tool-button.js";
import {
    WORKFLOW_V2_STEP_INPUT_SOURCE_LABELS, WORKFLOW_V2_TEST_NOTICE_TEXT, WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT, WORKFLOW_V2_VARIABLES_HELP_TEXT, workflowV2AdvanceDraft, workflowV2DraftEdit, workflowV2DraftMarks, workflowV2JsonObjectDraft,
    workflowV2LineDiff, workflowV2PublicationEvidenceRows, workflowV2RevisionCompare, workflowV2StepInputKey, workflowV2StepInputRequest, workflowV2StepInputRows, workflowV2StepInputSummary,
    workflowV2ScenarioDraft, workflowV2TestAnswerTemplate, workflowV2TestResponseDraft, workflowV2VariableDraft, workflowV2VariableRemoval,
    workflowV2AnswerSourceText, WORKFLOW_V2_ASK_PARENT_KINDS, workflowV2AskParentSent,
} from "../../core/src/workflow-v2-commands.js";

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

function Value({ value, label, truncatedNote = "This preview was cut short; the full value is not in this view." }) {
    const { text, truncated } = formatWorkflowValue(value);
    if (!text) return null;
    return h(React.Fragment, null,
        label ? h("h3", null, label) : null,
        h("pre", null, text),
        truncated ? h("p", null, truncatedNote) : null);
}

const withThousands = value => Number(value).toLocaleString("en-US");

/**
 * One execution's whole value as it was read (workflowV2WholeValue; mock M10 "Inspect typed output"): being read, its
 * failure, that it had no value, or the whole output or runtime error with its size; a stored value larger than a read
 * returns (none is written) shows its start and says so. Every value is a React text child.
 */
function WholeValue({ whole }) {
    if (whole.kind === "loading") return h("p", { role: "status" }, "Reading the whole value…");
    if (whole.kind === "failed") return h("p", { role: "alert" }, `The whole value could not be read: ${whole.error}`);
    if (whole.kind === "none") return h("p", null, "It had no value when it was read: it had not ended.");
    const size = whole.bytes === null ? "" : ` (${withThousands(whole.bytes)} bytes)`;
    return h(React.Fragment, null,
        h("h3", null, `Whole ${whole.label === "Runtime error" ? "runtime error" : "output"}${size}`),
        whole.kind === "preview" ? h("p", null, `This stored value is more than a read returns${whole.limitBytes === null ? "" : ` (${withThousands(whole.limitBytes)} bytes)`}; only its start is shown.`) : null,
        h("pre", { "data-whole-value": whole.kind }, whole.text));
}

/**
 * The shown run's older history (design 04 read_workflow "Bounded history pagination"): Load older history reads the
 * next, older page of its executions, messages and held calls; after loaded rows changed it reads them again from
 * the start. Nothing when the whole history is loaded and nothing changed.
 */
function OlderHistory({ history, onLoadOlder, section = null }) {
    if (!history || !onLoadOlder) return null;
    const more = section ? Boolean(history.next?.[section]) : history.more;
    if (!more && !history.staleOlder) return null;
    return h("div", { className: "ps-workflow-older", style: { display: "grid", gap: 4 } },
        h("button", { type: "button", className: "ps-mini-button", "data-action": "older-history", disabled: history.loading,
            onClick: () => onLoadOlder(Boolean(history.staleOlder)) },
        history.loading ? "Reading older history…" : history.staleOlder ? "Read older history again" : "Load older history"),
        history.error ? h("p", { role: "alert" }, `Older history could not be read: ${history.error}`) : null);
}

/** The recipient's intake line. It sits beside the delivery rows and never replaces them; every value is text. */
function IntakeOutcome({ intake }) {
    const refused = intake.kind !== "unknown";
    const row = (label, value) => h("div", { className: "ps-workflow-property", key: label },
        h("span", null, label), h("strong", null, value));
    return h("div", { className: "ps-workflow-intake", "data-intake": intake.kind },
        row("Check by recipient", refused ? `Refused · ${intake.reason}`
            : `Unrecognized result${intake.raw ? ` · ${intake.raw}` : ""}`),
        row("Checked at", intake.at || "Time not recorded"),
        h("p", null, refused
            ? "The recipient refused this message when it checked it. This does not change the recorded delivery or show that the recipient read or acted on it."
            : "This check result is not recognized, so it is not shown as a result. The delivery above is as recorded."));
}

const resultLabel = execution => execution.status === "pending" ? "Pending"
    : execution.resultKind === "business" ? "Outcome"
        : execution.resultKind === "runtime_error" ? "Runtime error" : "How it ended was not recorded";

function kindProperties(node, current) {
    const rows = [];
    if (node.kind === "script") rows.push(["Timeout", `${node.timeoutSeconds} s`]);
    if (node.kind === "wait") {
        rows.push(["Duration", typeof node.seconds === "number" ? formatSeconds(node.seconds) : String(node.seconds)]);
        if (current?.deadline) rows.push(["Deadline", workflowV2EventTime(current.deadline) ?? current.deadline]);
    }
    if (node.kind === "receive") {
        rows.push(["Message type", node.contract], ["From", node.from === null ? "Any permitted sender" : node.from === "parent" ? "Parent session" : String(node.from)]);
        if (node.waitSeconds !== undefined) rows.push(["Wait limit", formatSeconds(node.waitSeconds)]);
    }
    if (node.kind === "send" || node.kind === "request") {
        rows.push(["Message type", node.contract], ["Recipient", node.recipient === "parent" ? "Parent session" : String(node.recipient)]);
        if (node.kind === "request" && node.timeoutSeconds !== undefined) rows.push(["Response deadline", typeof node.timeoutSeconds === "number" ? formatSeconds(node.timeoutSeconds) : String(node.timeoutSeconds)]);
    }
    if (node.kind === "agent") {
        // The workflow interface the state names and what the shown run pins it to (package revision, interface digest).
        rows.push(["Agent", workflowV2AgentTask(node)], ...workflowV2AgentBindingRows(node.binding), ["Outcomes", (node.outcomes || []).join(", ") || "—"]);
        if (node.timeoutSeconds !== undefined) rows.push(["Deadline", typeof node.timeoutSeconds === "number" ? formatSeconds(node.timeoutSeconds) : String(node.timeoutSeconds)]);
        if (current?.deadline) rows.push(["Deadline at", workflowV2EventTime(current.deadline) ?? current.deadline]);
    }
    if (node.kind === "parallel") {
        rows.push(["Branches start at", String(node.body?.initial ?? "—")],
            ["Concurrency", node.concurrency === 1 ? "One branch at a time" : `Up to ${node.concurrency} branches at a time`],
            ["Join", `${node.join === "all_required" ? "Every branch must succeed" : String(node.join)}${node.failFast ? " · the first failure cancels the others" : ""}`]);
        if (Number.isSafeInteger(current?.branches)) rows.push(["Branches", String(current.branches)]);
    }
    if (node.parallel) rows.push(["Parallel step", String(node.parallel)]);
    if (current?.branch && Number.isSafeInteger(current.branch.index)) rows.push(["Branch", String(current.branch.index)]);
    return rows;
}

/**
 * An agent state's child session (design 03, R23): a click opens its actual chat, which people read but cannot
 * write to. Nothing is opened when the child has not been created yet.
 */
function AgentChild({ agent, openSession, subtree = [] }) {
    if (!agent?.childSessionId) return null;
    // Every session under this step: its agent chat and what that chat started (mock M14 "View owned subtree").
    const under = subtree.filter(entry => entry.depth > 0);
    return h("div", { className: "ps-workflow-agent-child" },
        h("h3", null, "Agent session"),
        h("div", { className: "ps-workflow-property" }, h("span", null, "Agent chat"), h("strong", null, agent.childSessionId)),
        h("div", { className: "ps-workflow-property" }, h("span", null, "Status"),
            h("strong", null, agent.end ? `Ended (${workflowV2AgentEndText(agent.end) ?? agent.end})` : agent.spawned ? "Created" : "Not created yet")),
        openSession && agent.spawned ? h("button", { type: "button", className: "ps-workflow-transition", "data-action": "open-agent-chat",
            onClick: () => openSession(agent.childSessionId) }, "Open the agent's chat (read-only)") : null,
        // While the step waits, its description already says only the typed result completes it.
        h("p", null, "People can read this chat. Only the workflow's parent agent can message it."),
        under.length ? h("div", { className: "ps-workflow-subtree", "aria-label": "Sessions under this step" },
            h("h3", null, `Sessions under this step (${under.length})`),
            h("ul", { style: { margin: 0, paddingLeft: 16 } }, under.map(entry => h("li", { key: entry.sessionId, "data-session": entry.sessionId,
                style: { marginLeft: (entry.depth - 1) * 12 } },
            `${entry.title ?? entry.sessionId} · ${entry.status}`,
            openSession ? h("button", { type: "button", className: "ps-mini-button", "data-action": "open-session", style: { marginLeft: 6 },
                onClick: () => openSession(entry.sessionId) }, "Open (read-only)") : null)))) : null);
}

/**
 * Each branch of a parallel step's visit (owner decision q16; mocks M22 "JOIN BLOCKED k / n", M23 "Inspect conflict",
 * M24 "Inspect evidence"): how many succeeded, which ones block a blocked join, and per branch where it is, its last
 * step, a short result and why it did not succeed.
 */
function BranchEvidence({ evidence }) {
    return h("div", { className: "ps-workflow-evidence", "aria-label": "Branch results" },
        h("h3", null, "Branch results"),
        h("p", { style: { margin: 0 } }, `${evidence.succeeded} of ${evidence.total} branches succeeded${evidence.running ? `, ${evidence.running} running` : ""}.`),
        evidence.blocked && evidence.blocking.length ? h("p", { role: "status", "data-blocking": evidence.blocking.join(","), style: { margin: 0, color: TONES.warning } },
            `The join is blocked by ${evidence.blocking.length === 1 ? "branch" : "branches"} ${evidence.blocking.join(", ")}.`) : null,
        evidence.rows.length ? h("table", null,
            h("thead", null, h("tr", null, ["Branch", "Status", "Last step", "Result", "Why"].map(label => h("th", { key: label }, label)))),
            h("tbody", null, evidence.rows.map(row => h("tr", { key: row.index, "data-branch": row.index, "data-status": row.status },
                h("td", null, String(row.index)), h("td", null, row.status), h("td", null, row.step ?? "—"), h("td", null, row.result ?? "—"),
                h("td", null, row.why ?? "—"))))) : null);
}

/**
 * Ask the workflow's parent agent about this visit (owner decision q16; mocks M22 "Send findings", M23 "Request scoped
 * rework", M24 "Ask parent for approval"): choose findings, rework or approval, add a note, and send it to the parent
 * agent's chat as an ordinary message (controller.askParentAboutStep). The parent decides what to do.
 */
function AskParent({ onAskParent, executionId }) {
    const [kind, setKind] = React.useState(null);
    const [note, setNote] = React.useState("");
    const [sent, setSent] = React.useState(null);
    const send = async () => {
        const result = await onAskParent(kind, note, executionId);
        setSent(result?.ok ? workflowV2AskParentSent(result.parentSessionId) : result?.reason ?? "It was not sent.");
        if (result?.ok) setNote("");
    };
    return h("div", { className: "ps-workflow-ask-parent", "aria-label": "Ask the parent agent", style: { display: "grid", gap: 4 } },
        h("h3", null, "Ask the parent agent"),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } }, Object.entries(WORKFLOW_V2_ASK_PARENT_KINDS).map(([value, item]) =>
            h("button", { key: value, type: "button", className: "ps-mini-button", "data-ask": value, "aria-pressed": kind === value,
                onClick: () => { setKind(value); setSent(null); } }, item.label))),
        kind ? h("label", { style: { display: "grid", gap: 2 } }, "Your note (optional)",
            h("textarea", { value: note, rows: 3, "data-field": "ask-note", onChange: event => setNote(event.target.value) })) : null,
        kind ? h("button", { type: "button", className: "ps-mini-button", "data-action": "ask-parent-send", style: { justifySelf: "start" },
            onClick: () => { send(); } }, "Send to the parent agent") : null,
        sent ? h("p", { role: "status", style: { margin: 0 } }, sent) : null,
        h("p", { style: { margin: 0, color: "var(--ps-muted)" } }, "It goes to the parent agent's chat as a message; the parent decides what to do."));
}

/** A collapsed list of activity rows (owner decision q14): time, what happened, who, newest first. */
function ActivityDetails({ rows, label }) {
    if (!rows.length) return null;
    return h("details", { className: "ps-workflow-activity" },
        h("summary", null, `${label} (${rows.length})`),
        h("ol", { style: { margin: 0, paddingLeft: 18 } }, rows.map((row, index) => h("li", { key: row.seq ?? index, "data-level": row.level,
            style: { color: TONES[row.level] ?? "inherit" } }, `${row.at ? `${row.at} · ` : ""}${row.what}${row.who ? ` · by ${row.who}` : ""}`))));
}

/**
 * Why the shown run ended and who did what in it (owner decision q14; mocks M09 "Inspect audit", M14 "Inspect
 * cancellation"): one line once it ended, then its activity, newest first, from the workflow's own events.
 */
export function WorkflowV2RunActivity({ ending, events, runId }) {
    const rows = workflowV2Activity(events, { runId });
    if (!ending && !rows.length) return null;
    return h("section", { className: "ps-workflow-run-activity", "aria-label": "Run activity",
        style: { display: "grid", gap: 4, padding: "4px 12px", fontSize: "0.75rem", borderBottom: "1px solid var(--ps-border)" } },
    ending ? h("p", { role: "status", "data-ending": ending.status, style: { margin: 0 } }, ending.text) : null,
    h(ActivityDetails, { rows, label: "Activity of this run" }));
}

/**
 * The variables a visit applied and the run's accepted ones (mock M15 "Accepted 9 / applied 8", "Inspect update",
 * "Compare snapshots"): the two revisions, a button that reads and compares them for exactly this run, and the
 * comparison key by key (added, removed, changed; unchanged counted). Values are as read: whole up to 256 KiB in all,
 * else their start. Every value is a React text child. Nothing without `kv.onCompare`.
 */
function KvApplied({ execution, runId, kv }) {
    const applied = workflowV2KvApplied(execution, { kvRevision: kv?.accepted });
    if (!applied || !runId) return null;
    const from = applied.applied, to = applied.accepted ?? applied.applied;
    const asked = kv.compare && kv.compare.runId === runId && kv.compare.from === from && kv.compare.to === to;
    const before = asked ? workflowV2KvSnapshot(kv.snapshots, runId, from) : null;
    const after = asked ? workflowV2KvSnapshot(kv.snapshots, runId, to) : null;
    const failed = [before, after].find(entry => entry?.phase === "failed") ?? null;
    const loading = asked && !failed && (before?.phase !== "loaded" || after?.phase !== "loaded");
    const compared = asked && !failed && !loading ? workflowV2KvCompare(before, after) : null;
    const rows = compared ? compared.rows.filter(row => row.change !== "same") : [];
    return h("div", { className: "ps-workflow-kv", "data-kv-applied": String(from) },
        h("div", { className: "ps-workflow-property" }, h("span", null, "Variables applied"),
            h("strong", null, `Revision ${from}${applied.accepted === null ? "" : applied.same ? " (the accepted revision)" : ` · accepted now: revision ${applied.accepted}`}`)),
        kv.onCompare ? h("button", { type: "button", className: "ps-mini-button", "data-action": "compare-variables", disabled: loading,
            onClick: () => kv.onCompare(from, to) }, loading ? "Reading the variables…" : applied.same ? "Inspect these variables" : "Compare with the accepted variables") : null,
        failed ? h("p", { role: "alert" }, `The variables of revision ${failed.revision} could not be read: ${failed.error}`) : null,
        compared ? h(React.Fragment, null,
            h("p", { role: "status" }, `Revision ${compared.from} → ${compared.to}: ${compared.counts.added} added, ${compared.counts.removed} removed, `
                + `${compared.counts.changed} changed, ${compared.counts.same} unchanged.${compared.whole ? "" : " Values over 256 KiB in all are shown by their start."}`),
            rows.length ? h("table", null,
                h("thead", null, h("tr", null, ["Variable", "Change", `Revision ${compared.from}`, `Revision ${compared.to}`].map((label, i) => h("th", { key: i }, label)))),
                h("tbody", null, rows.map(row => h("tr", { key: row.key, "data-change": row.change },
                    h("td", null, row.key), h("td", null, row.change),
                    h("td", null, row.before === null ? "—" : h("code", { style: { overflowWrap: "anywhere" } }, row.before)),
                    h("td", null, row.after === null ? "—" : h("code", { style: { overflowWrap: "anywhere" } }, row.after)))))) : null) : null);
}

/**
 * The tab panel body of a v2 node. The caller owns the tab strip so its tab semantics are unchanged. The Output tab
 * shows one execution's own result: the latest by default, or the one chosen in the History tab for exactly this run
 * (`runId`) and state (`selection`, the view's selectedExecution), never the latest in its place; `onSelectExecution`
 * (an execution id, or null for the latest) and `onTab` let History choose one. Without them History lists as before.
 * `onReadWholeValue` (an execution id) reads that execution's whole output or error, shown from `executionValues` for
 * exactly this run and execution; `history` (the run's, workflowV2RunHistory) and `onLoadOlder` (restart) let History
 * read the run's older history. `kv` ({ accepted, snapshots, compare, onCompare }) shows in Details the variables the
 * current visit applied beside the accepted ones and compares them. Without them neither is offered.
 */
export function WorkflowV2NodeContent({ tab, selected, nodes, select, runOutput, runError, openSession = null, runId = null, selection = null,
    onSelectExecution = null, onTab = null, executionValues = null, onReadWholeValue = null, history = null, onLoadOlder = null, kv = null,
    events = null, sessionsById = null, onAskParent = null }) {
    const property = (label, value) => h("div", { className: "ps-workflow-property", key: label },
        h("span", null, label), h("strong", null, value));
    const current = selected.current;
    if (tab === "details") {
        const lastOutcome = selected.outcome
            ? `${selected.outcome}${selected.resultKind === "runtime_error" ? " · runtime error" : ""}` : "Not recorded";
        return h(React.Fragment, null,
            property("Status", selected.stateLabel),
            property("Visits", `${selected.runs}${selected.partial ? " in loaded history" : ""}`),
            property("Last outcome", lastOutcome),
            // Why the latest visit ended (owner decision q14; mock M14 "Inspect cancellation").
            workflowV2VisitEnding(current) ? property("Why it ended", workflowV2VisitEnding(current).text) : null,
            kindProperties(selected, current).map(([label, value]) => property(label, value)),
            selected.description.map((line, i) => h("p", { key: i }, line)),
            selected.type === "terminal" ? h("p", null, selected.summary || "The workflow ends at this step.") : null,
            selected.next ? h("h3", null, "Next steps") : null,
            Object.entries(selected.next || {}).map(([label, target]) =>
                h("button", { key: label, type: "button", className: "ps-workflow-transition",
                    disabled: !nodes.some(node => node.id === target), onClick: () => select(target) },
                label, " → ", target, workflowV2RouteKind(selected, label) === "error" ? " · runtime error route" : "")),
            current?.agent ? h(AgentChild, { agent: current.agent, openSession, subtree: workflowV2SessionSubtree(sessionsById, current.agent.childSessionId) }) : null,
            kv ? h(KvApplied, { execution: current, runId, kv }) : null,
            current?.inbox ? h(React.Fragment, null, h("h3", null, "Message taken"),
                property("Message type", current.inbox.contract), property("From", current.inbox.senderSessionId),
                h(Value, { value: current.inbox.payloadPreview })) : null,
            current?.outbox ? h(React.Fragment, null, h("h3", null, "Delivery"),
                property("Delivery status", current.outbox.state),
                property("Attempts", String(current.outbox.attempts ?? "—")),
                property("Recipient", current.outbox.recipientSessionId || "—"),
                current.outbox.intake ? h(IntakeOutcome, { intake: current.outbox.intake }) : null,
                h(Value, { value: current.outbox.payloadPreview, label: "Sent payload" })) : null,
            // Who did what in this visit, from the workflow's events (owner decision q14; mock M09 "Inspect audit").
            events && current?.id ? h(ActivityDetails, { rows: workflowV2Activity(events, { runId, nodeExecutionId: current.id }), label: "Activity of this visit" }) : null,
            // Each branch's result for a parallel step, and asking the parent agent about this visit (owner decision q16).
            selected.evidence ? h(BranchEvidence, { evidence: selected.evidence }) : null,
            onAskParent && current?.id ? h(AskParent, { key: current.id, onAskParent, executionId: current.id }) : null);
    }
    if (tab === "output") {
        const shown = workflowV2ShownExecution(selected, runId, selection);
        const result = shown.execution ? workflowV2ExecutionResult(shown.execution) : null;
        const visit = shown.execution && Number.isSafeInteger(shown.execution.ordinal) ? `visit ${shown.execution.ordinal}` : "this visit";
        // The run's own output belongs to its end, shown with the latest result only.
        const terminalValue = !shown.chosen && selected.type === "terminal" ? (runError ?? runOutput) : null;
        // That execution's whole value (mock M10), read for exactly this run and execution, never another's in its place.
        const executionId = typeof shown.execution?.id === "string" && shown.execution.id ? shown.execution.id : null;
        const canRead = Boolean(onReadWholeValue && runId && executionId && result && result.kind !== "pending");
        const whole = executionId ? workflowV2WholeValue(workflowV2ExecutionValue(executionValues, runId, executionId)) : null;
        const cutNote = canRead ? "This preview was cut short; Read the whole value shows all of it." : undefined;
        return h(React.Fragment, null,
            shown.chosen
                ? h("p", { "data-execution": shown.executionId }, shown.missing
                    ? `The visit chosen in History (${shown.executionId}) is not in the loaded history of this run.`
                    : `Result of ${visit}, chosen in History.`)
                : h("p", null, "Latest result in the loaded history for this step."),
            shown.chosen && onSelectExecution ? h("button", { type: "button", className: "ps-mini-button", "data-action": "latest-result",
                onClick: () => onSelectExecution(null) }, "Show the latest result") : null,
            shown.chosen && shown.missing ? h("pre", null, "Its result is not shown, and no other visit's result is shown in its place.") : null,
            !shown.chosen && !result && terminalValue === null ? h("pre", null, "This step has no result in the loaded history.") : null,
            result?.kind === "pending" ? h("pre", null, "This visit has not ended; it has no result yet.") : null,
            result?.kind === "error"
                ? h(Value, { value: result.value ?? result.code ?? (result.effectStatus ? `Action ${result.effectStatus}` : "No error text was recorded."), label: "Runtime error",
                    truncatedNote: cutNote })
                : null,
            result?.kind === "output" ? h(Value, { value: result.value, label: "Output", truncatedNote: cutNote }) : null,
            result?.kind === "none" ? h("pre", null, "This step records no output.") : null,
            canRead ? h("button", { type: "button", className: "ps-mini-button", "data-action": "whole-value", "data-execution": executionId,
                disabled: whole?.kind === "loading", onClick: () => onReadWholeValue(executionId) },
            whole && whole.kind !== "loading" ? "Read the whole value again" : "Read the whole value") : null,
            whole ? h(WholeValue, { whole }) : null,
            terminalValue !== null ? h(Value, { value: terminalValue, label: runError !== null && runError !== undefined ? "Run error" : "Run output" }) : null);
    }
    const rows = compactWorkflowV2Executions(selected.executions);
    const shown = workflowV2ShownExecution(selected, runId, selection);
    // A row of one execution chooses exactly that execution's result; a row of combined repeats lists them one by one below.
    const choose = onSelectExecution ? (execution => h("button", { type: "button", className: "ps-mini-button", "data-action": "show-result",
        "data-execution": execution.id, "aria-pressed": shown.chosen && shown.executionId === execution.id,
        onClick: () => { onSelectExecution(execution.id); onTab?.("output"); } }, "Result")) : null;
    const table = items => h("table", null,
        h("thead", null, h("tr", null, [...["Visit", "Result", "Outcome"], ...(choose ? [""] : [])].map((label, i) => h("th", { key: i }, label)))),
        h("tbody", null, items.map(({ execution, count, from, to }, i) => h("tr", { key: execution.id || i },
            h("td", null, count > 1 ? `${from}–${to} (×${count})` : String(execution.ordinal ?? "—")),
            h("td", null, resultLabel(execution)),
            h("td", null, execution.outcome || "—"),
            choose ? h("td", null, count === 1 && typeof execution.id === "string" ? choose(execution) : null) : null))));
    return h(React.Fragment, null,
        h("p", null, "Most recent visits in the loaded history. Unchanged repeats are combined."),
        rows.length ? table(rows) : h("p", null, "No visits in the loaded history."),
        selected.executions.length > rows.length ? h("details", null,
            h("summary", null, `Every loaded visit (${selected.executions.length})`),
            table(selected.executions.map(execution => ({ execution, count: 1, from: execution.ordinal, to: execution.ordinal })))) : null,
        h(OlderHistory, { history, onLoadOlder }));
}

// ── Run picker ──────────────────────────────────────────────────────────────
// Chooses which run of a v2 workflow the graph, log and details show. The list is `runs` of the read model that
// readWorkflowV2View returns ({ runId, mode: "live" | "test", status, revision, outcome }); the choice is
// `ui.workflowViews[sessionId].selectedRunId`, where null is the live run. Nothing here fetches: the controller's
// ensureWorkflowReadModel reads the selected run, and the projection overlays only that run's own model.

// The options, labels and notes are the shared run picker model (ui-core), so the portal and the TUI show the same runs.
export { workflowV2RunPickerModel };

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

/**
 * A test run's held calls (design 05; INACTIVE outside controller 1.9.0's tests): what each reached, the
 * schema its answer must match and its answer. The parent answers through its own tools; a person may answer one that
 * waits only when `responder` (workflowV2TestResponder's answer) says so: its Answer button opens the answer form for it.
 * The notice that scripts run normally stays in the banners above.
 */
export function WorkflowV2TestInterceptions({ test, controller = null, sessionId = null, responder = null, answering = null, history = null, onLoadOlder = null,
    parentSessionId = null }) {
    const items = Array.isArray(test?.interceptions) ? test.interceptions : [];
    if (!items.length) return null;
    const answerable = Boolean(controller && responder?.respond);
    const waits = id => answerable && responder.waiting.some(item => item.interceptionId === id);
    // Asking the workflow's parent agent about a held call that waits (owner decision q12): a message in its chat.
    const askable = Boolean(controller && parentSessionId && responder?.runId);
    const asks = item => askable && item.state === "awaiting_parent";
    return h("section", { className: "ps-workflow-test", "aria-label": "Test calls", style: { padding: "6px 10px", fontSize: "0.75rem" } },
        h("h3", null, `Calls (${items.length})`),
        h("table", null,
            h("thead", null, h("tr", null, [...["Call", "Step", "Answer"], ...(answerable || askable ? [""] : [])].map((label, i) => h("th", { key: i }, label)))),
            h("tbody", null, items.map((item, i) => h("tr", { key: item.interceptionId || i, "data-interception": item.interceptionId },
                h("td", { title: item.interceptionId }, item.tool ? `${item.operation} · ${item.tool}` : String(item.operation)),
                h("td", null, item.stateId || "—"),
                h("td", null, item.response ? `${item.response.kind} · ${workflowV2AnswerSourceText(item.response.disposition, "—")}` : "Waiting for the parent"),
                answerable || askable ? h("td", null,
                    waits(item.interceptionId) ? h("button", { type: "button", className: "ps-mini-button", "data-action": "answer",
                        disabled: responder.busy, "aria-pressed": answering === item.interceptionId,
                        onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { answeringInterceptionId: item.interceptionId } }) },
                    "Answer") : null,
                    asks(item) ? h("button", { type: "button", className: "ps-mini-button", "data-action": "ask-parent",
                        title: "Send a message about this call to the parent agent's chat; it answers with its own tools.",
                        onClick: () => { controller.askParentAboutHeldCall?.(sessionId, { runId: responder.runId, interceptionId: item.interceptionId })?.catch?.(() => {}); } },
                    "Ask the parent agent") : null) : null)))),
        // Older held calls of this run than the read holds: the run's older history reads them.
        h(OlderHistory, { history, onLoadOlder, section: "interceptions" }));
}

/**
 * A person's answer to one held call of a test run (design 05 test_respond; mock M18; R19, R20, R26;
 * INACTIVE). It shows what the effect reached (its arguments) and what the answer must match, then sends the answer the
 * person chose: success with a JSON value, error with { code, message, details? }, or cancel. The JSON is checked here;
 * the server checks it against the effect's contract and says which fields it refuses, and the same answer sent again is
 * the same answer. Once it is accepted the form closes.
 */
export function WorkflowV2TestAnswer({ controller, sessionId, responder, interceptionId, parentSessionId = null }) {
    const waiting = responder?.waiting.find(item => item.interceptionId === interceptionId) ?? null;
    const [kind, setKind] = React.useState("success");
    const [valueText, setValueText] = React.useState(() => workflowV2TestAnswerTemplate(waiting));
    const [error, setError] = React.useState(null);
    const kindName = `wf-test-answer-${React.useId().replace(/:/g, "")}`;
    // Another interception starts from its own template.
    React.useEffect(() => { setKind("success"); setValueText(workflowV2TestAnswerTemplate(waiting)); setError(null); }, [interceptionId]);
    if (!responder || !waiting) return null;
    const close = () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { answeringInterceptionId: null } });
    const send = async () => {
        const draft = workflowV2TestResponseDraft(kind, valueText);
        setError(draft.ok ? null : draft.error);
        if (!draft.ok) return;
        const result = await controller.sendWorkflowRunCommand(sessionId, { operation: "test_respond", runId: responder.runId, interceptionId,
            response: draft.response });
        if (result?.ok) close();
    };
    // The same answer as a suggestion in the parent agent's chat instead (owner decision q12; mock M18).
    const askParent = async () => {
        const draft = workflowV2TestResponseDraft(kind, valueText);
        setError(draft.ok ? null : draft.error);
        if (!draft.ok) return;
        const result = await controller.askParentAboutHeldCall?.(sessionId, { runId: responder.runId, interceptionId, response: draft.response });
        if (result?.ok) close();
        else if (result?.reason) setError(result.reason);
    };
    const radio = (value, label) => h("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, marginRight: 12 } },
        h("input", { type: "radio", name: kindName, value, checked: kind === value, onChange: () => setKind(value), "data-answer-kind": value }), label);
    const what = `${waiting.operation}${waiting.tool ? ` · ${waiting.tool}` : ""}${waiting.stateId ? ` in '${waiting.stateId}'` : ""}`;
    return h("section", { className: "ps-workflow-test-answer", "aria-label": "Answer a call", "data-interception": interceptionId,
        style: { display: "grid", gap: 6, padding: "6px 12px", fontSize: "0.75rem", borderBottom: "1px solid var(--ps-border)" } },
    h("h3", { style: { margin: 0, fontSize: "0.8rem" } }, `Answer ${what}`),
    waiting.arguments !== null ? h(Value, { value: waiting.arguments, label: "What it reached" }) : null,
    waiting.responseSchema !== null ? h(Value, { value: waiting.responseSchema, label: "The answer must match" }) : null,
    h("fieldset", { style: { margin: 0, padding: "4px 8px", border: "1px solid var(--ps-border)" } },
        h("legend", null, "Answer"), radio("success", "Success"), radio("error", "Error"), radio("cancel", "Cancel")),
    kind === "cancel" ? h("p", { style: { margin: 0, color: "var(--ps-muted)" } }, "The call ends as cancelled; a cancel has no value.")
        : h("label", { style: { display: "grid", gap: 2 } }, kind === "error" ? "Error (JSON: { \"code\", \"message\", \"details\"? })" : "Value (JSON)",
            h("textarea", { value: valueText, rows: 4, onChange: event => setValueText(event.target.value), "data-field": "answer",
                style: { fontFamily: "var(--ps-font-mono, monospace)", width: "100%" } })),
    h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
        h("button", { type: "button", className: "ps-mini-button", "data-operation": "test_respond", disabled: !responder.respond || responder.busy,
            title: responder.reason ?? (responder.busy ? "Another command for this workflow is being sent." : "Send this answer to the test run."),
            onClick: () => { send(); } }, responder.pending === "test_respond" ? "Sending…" : "Send answer"),
        parentSessionId ? h("button", { type: "button", className: "ps-mini-button", "data-action": "ask-parent",
            title: "Send this answer to the parent agent's chat as a suggestion; it answers the call with its own tools.",
            onClick: () => { askParent(); } }, "Send to the parent agent instead") : null,
        h("button", { type: "button", className: "ps-mini-button", onClick: close }, "Close")),
    error ? h("span", { role: "alert", style: { color: TONES.error } }, error) : null);
}

/**
 * A test run's virtual clock (design 05 timer simulation; mock M19; R08, R19, R26; INACTIVE): how far it is from the
 * test's start, and an advance by a whole number of seconds (1 to 30 days) that decides what came due. Script clocks
 * are real, and the control says so.
 */
export function WorkflowV2TestClock({ controller, sessionId, responder }) {
    const [seconds, setSeconds] = React.useState("60");
    const [error, setError] = React.useState(null);
    if (!responder?.advance) return null;
    const advance = () => {
        const draft = workflowV2AdvanceDraft(seconds);
        setError(draft.ok ? null : draft.error);
        if (draft.ok) controller.sendWorkflowRunCommand(sessionId, { operation: "test_advance", runId: responder.runId, seconds: draft.seconds });
    };
    return h("div", { className: "ps-workflow-test-clock", role: "group", "aria-label": "Virtual clock",
        style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "6px 12px", fontSize: "0.75rem", borderBottom: "1px solid var(--ps-border)" } },
    h("span", null, responder.elapsedSeconds === null ? "Virtual clock" : `Virtual clock: ${formatSeconds(responder.elapsedSeconds)} after the test began`),
    h("input", { type: "number", min: 1, step: 1, value: seconds, onChange: event => setSeconds(event.target.value), "aria-label": "Seconds to advance",
        "data-field": "seconds", style: { width: "7em" } }),
    h("button", { type: "button", className: "ps-mini-button", "data-operation": "test_advance", disabled: responder.busy,
        onClick: advance }, responder.pending === "test_advance" ? "Advancing…" : "Advance"),
    h("span", { style: { color: "var(--ps-muted)" } }, "Script clocks are real."),
    error ? h("span", { role: "alert", style: { color: TONES.error } }, error) : null);
}

/**
 * A person's run controls (R17, R26; mocks M04 and M16; INACTIVE: only a read model that says which commands the
 * workflow takes from people has any). `model` is workflowV2RunControls' answer. Native buttons; a disabled one says why
 * in its title. Stop and cancel open the confirm dialog; the server decides every command again.
 */
export function WorkflowV2RunControls({ controller, sessionId, model }) {
    const noteId = `wf-run-controls-${React.useId().replace(/:/g, "")}`;
    if (!model?.controls?.length) return null;
    return h("div", { className: "ps-workflow-run-controls", role: "group", "aria-label": "Run controls", "aria-busy": model.busy || undefined,
        "aria-describedby": model.restriction ? noteId : undefined, "data-run-id": model.runId,
        style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, minWidth: 0, maxWidth: "100%" } },
    model.controls.map(control => h(WorkflowToolButton, { key: control.operation, label: control.label, glyph: control.operation,
        danger: Boolean(control.danger), "data-operation": control.operation, disabled: !control.enabled, title: control.title,
        onClick: () => { controller.sendWorkflowRunCommand(sessionId, { operation: control.operation, runId: model.runId }); } })),
    model.restriction ? h("span", { id: noteId, className: "ps-workflow-run-restriction",
        style: { color: "var(--ps-muted)", fontSize: "0.75rem", overflowWrap: "anywhere" } }, model.restriction) : null);
}

/**
 * The last run control that was refused, or whose answer never came, beside the graph (workflowV2RunCommandNotice's
 * answer). Retry sends the same command again, with the same operation id; Dismiss only clears the notice.
 */
export function WorkflowV2RunCommandNotice({ controller, sessionId, notice }) {
    if (!notice) return null;
    return h("div", { className: "ps-workflow-run-command-notice", role: "alert", "data-level": notice.level,
        style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: "0.8rem",
            color: TONES[notice.level] || TONES.info, borderBottom: "1px solid var(--ps-border)", overflowWrap: "anywhere" } },
    h("span", { style: { flex: 1, minWidth: 0 } }, notice.text),
    notice.retry ? h("button", { type: "button", className: "ps-mini-button",
        onClick: () => { controller.retryWorkflowRunCommand(sessionId); } }, "Retry") : null,
    h("button", { type: "button", className: "ps-mini-button", onClick: () => controller.dismissWorkflowRunCommand(sessionId) }, "Dismiss"));
}

/**
 * The run's variables (its open KV; R04, R05; mock M15; INACTIVE: only a read model that says which commands the
 * workflow takes from people has this panel). `model` is workflowV2RunVariables' answer. The list is read-only text; a
 * person who may change the variables sets one (a name and a JSON value) or removes one (by name, after the confirm
 * dialog), each as one update at the revision shown. Edit copies a listed variable into the form. The server checks the
 * revision (a changed map is refused and read again) and everything else.
 */
export function WorkflowV2Variables({ controller, sessionId, model, id }) {
    const [key, setKey] = React.useState("");
    const [value, setValue] = React.useState("");
    const [error, setError] = React.useState(null);
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    // A draft belongs to the run it was typed for: another run starts with an empty form.
    const runId = model?.runId ?? null;
    React.useEffect(() => { setKey(""); setValue(""); setError(null); }, [runId]);
    if (!model) return null;
    const send = async input => {
        const result = await controller.sendWorkflowRunCommand(sessionId, { operation: "set_vars", runId: model.runId,
            expectedKvRevision: model.revision, ...input });
        if (result?.ok && mounted.current) { setKey(""); setValue(""); setError(null); }
    };
    const onSet = event => {
        event.preventDefault();
        const draft = workflowV2VariableDraft(key, value);
        setError(draft.ok ? null : draft.error);
        if (draft.ok) send({ set: draft.set });
    };
    const onRemove = () => {
        const removal = workflowV2VariableRemoval(key);
        setError(removal.ok ? null : removal.error);
        if (removal.ok) send({ delete: removal.delete });
    };
    const cell = { padding: "2px 8px 2px 0", verticalAlign: "top", overflowWrap: "anywhere" };
    return h("section", { id, className: "ps-workflow-variables", "aria-label": "Workflow variables", "data-run-id": model.runId,
        style: { display: "grid", gap: 6, padding: "6px 12px", fontSize: "0.75rem", borderBottom: "1px solid var(--ps-border)" } },
    h("h3", { style: { margin: 0, fontSize: "0.8rem" } }, model.revision === null ? "Variables" : `Variables · revision ${model.revision}`),
    h("p", { style: { margin: 0, color: "var(--ps-muted)" } }, WORKFLOW_V2_VARIABLES_HELP_TEXT),
    model.note ? h("p", { role: "status", style: { margin: 0 } }, model.note) : null,
    model.preview ? h("pre", { style: { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "8em", overflow: "auto" } }, model.preview) : null,
    model.entries.length ? h("table", { style: { borderCollapse: "collapse", width: "100%" } },
        h("thead", null, h("tr", null, ["Name", "Value", ""].map((label, i) => h("th", { key: i, style: { ...cell, textAlign: "left" } }, label)))),
        h("tbody", null, model.entries.map(entry => h("tr", { key: entry.key, "data-key": entry.key },
            h("td", { style: cell }, entry.key),
            h("td", { style: cell }, h("code", null, entry.displayText)),
            h("td", { style: { ...cell, whiteSpace: "nowrap" } }, model.editable ? h("button", { type: "button", className: "ps-mini-button",
                "aria-label": `Edit ${entry.key}`, disabled: model.busy,
                onClick: () => { setKey(entry.key); setValue(entry.valueText); setError(null); } }, "Edit") : null))))) : null,
    model.editable
        ? h("form", { "aria-label": "Set or remove a variable", onSubmit: onSet,
            style: { display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 6 } },
        h("label", { style: { display: "grid", gap: 2 } }, "Name",
            h("input", { type: "text", value: key, maxLength: 128, onChange: event => setKey(event.target.value), "data-field": "name" })),
        h("label", { style: { display: "grid", gap: 2, flex: "1 1 14em", minWidth: 0 } }, "Value (JSON)",
            h("textarea", { value, rows: 2, onChange: event => setValue(event.target.value), "data-field": "value",
                style: { fontFamily: "var(--ps-font-mono, monospace)", width: "100%" } })),
        h("button", { type: "submit", className: "ps-mini-button", disabled: model.busy, "data-operation": "set" }, model.pending ? "Saving…" : "Set"),
        h("button", { type: "button", className: "ps-mini-button is-danger", disabled: model.busy, "data-operation": "remove", onClick: onRemove }, "Remove"),
        error ? h("span", { role: "alert", style: { flexBasis: "100%", color: TONES.error } }, error) : null)
        : h("p", { className: "ps-workflow-variables-readonly", style: { margin: 0, color: "var(--ps-muted)" } }, model.reason));
}

/** The header button that opens and closes the variables panel (the view's `variablesOpen`). */
export function WorkflowV2VariablesToggle({ controller, sessionId, open, controls }) {
    return h(WorkflowToolButton, { label: "Variables", glyph: "variables", "aria-expanded": Boolean(open), "aria-controls": open ? controls : undefined,
        onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { variablesOpen: !open } }) });
}

/** The header button that opens and closes the publication panel (the view's `definitionOpen`): "Publish…" for a draft, "Start…" otherwise. */
export function WorkflowV2DefinitionToggle({ controller, sessionId, model, open, controls }) {
    if (!model?.controls?.length) return null;
    const draft = model.state === "draft";
    return h(WorkflowToolButton, { label: draft ? "Publish…" : "Start…", glyph: draft ? "publish" : "start",
        "aria-expanded": Boolean(open), "aria-controls": open ? controls : undefined, "data-definition-state": model.state,
        onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { definitionOpen: !open } }) });
}

/**
 * The definition a review is about, on one line (flow-08): its name and version · its revision · whether it is valid
 * (when the review says), and its hash by its first 12 characters. The whole hash is on hover and in `data-hash`; the
 * command still sends the whole hash.
 */
function DefinitionSummary({ model, revisionLabel, revision, hash, validity = null }) {
    const parts = [[model.name, model.semver].filter(Boolean).join(" ") || "Not named",
        `${revisionLabel} ${revision === null || revision === undefined ? "not known" : revision}`, ...(validity ? [validity] : [])];
    const whole = typeof hash === "string" && hash ? hash : null;
    return h("div", { className: "ps-workflow-property", "data-field": "definition-summary" }, h("span", null, "Definition"),
        h("strong", null, `${parts.join(" · ")} · `,
            h("code", { "data-field": "definition-hash", title: whole ?? undefined, "data-hash": whole ?? undefined },
                whole ? (whole.length > 12 ? workflowV2ShortHash(whole) : whole) : "hash not known")));
}

/**
 * Publication review (design 04; mocks M01 and M03; R17, R18, R26; INACTIVE: only a read model that says which commands
 * the workflow takes from people has it). `model` is workflowV2DefinitionControls' answer. It shows exactly what is
 * published or started (the definition, the revision and its full definition hash), then sends the command for that
 * revision and hash: Publish only, Publish and start (with the run's inputs and optional initial variables, as JSON
 * objects), or Start live run for a published definition. A revision that changed meanwhile is refused by the server and
 * the workflow is read again; what the person typed stays. Publishing and starting are separate, explicit choices.
 */
export function WorkflowV2DefinitionPanel({ controller, sessionId, model, id, versionsNow = null }) {
    const [inputs, setInputs] = React.useState("{}");
    const [vars, setVars] = React.useState("");
    const [error, setError] = React.useState(null);
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    // A draft's named agents: the versions publishing would lock now, read when the review opens or its revision changes (q1).
    const reviewedRevision = model?.state === "draft" && model.agents?.length ? model.revision : null;
    React.useEffect(() => {
        if (reviewedRevision !== null) controller.loadWorkflowAgentVersions?.(sessionId, { revision: reviewedRevision })?.catch?.(() => {});
    }, [controller, sessionId, reviewedRevision]);
    if (!model?.controls?.length) return null;
    const runs = model.controls.some(control => control.operation !== "publish");
    const send = async operation => {
        let run = {};
        if (operation !== "publish") {
            const parsedInputs = workflowV2JsonObjectDraft(inputs, { label: "Inputs" });
            const parsedVars = workflowV2JsonObjectDraft(vars, { label: "Initial variables", optional: true });
            const refused = !parsedInputs.ok ? parsedInputs : !parsedVars.ok ? parsedVars : null;
            if (refused) { setError(refused.error); return; }
            run = { inputs: parsedInputs.value, ...(parsedVars.value !== undefined ? { vars: parsedVars.value } : {}) };
        }
        setError(null);
        const result = await controller.sendWorkflowRunCommand(sessionId, operation === "start"
            ? { operation, definitionHash: model.publishedDefinitionHash, ...run }
            : { operation, expectedRevision: model.revision, definitionHash: model.definitionHash, ...run });
        if (result?.ok && mounted.current) controller.dispatch({ type: "ui/workflowView", sessionId, view: { definitionOpen: false } });
    };
    const draft = model.state === "draft";
    const shownRevision = draft ? model.revision : model.publishedRevision;
    const shownHash = draft ? model.definitionHash : model.publishedDefinitionHash;
    const row = (label, value, extra = {}) => h("div", { className: "ps-workflow-property", key: label, ...extra }, h("span", null, label), h("strong", null, value));
    return h("section", { id, className: "ps-workflow-definition", "aria-label": draft ? "Publish review" : "Start the live run",
        "data-definition-state": model.state,
        style: { display: "grid", gap: 6, padding: "6px 12px", fontSize: "0.75rem", borderBottom: "1px solid var(--ps-border)" } },
    h("h3", { style: { margin: 0, fontSize: "0.8rem" } }, draft ? "Publish review" : "Start the live run"),
    h(DefinitionSummary, { model, revisionLabel: draft ? "revision" : "published revision", revision: shownRevision, hash: shownHash,
        validity: draft ? (model.valid ? "valid" : `${model.errors || "unlisted"} error${model.errors === 1 ? "" : "s"}: it cannot be published`) : null }),
    row("Live effects", runs ? "Only when its live run starts" : "None until a live run starts"),
    // What publication pins for each named agent, and the tests of exactly this revision (information: no test is required).
    workflowV2PublicationEvidenceRows(model, versionsNow).map(([label, value], index) => row(label, value, { key: `evidence-${index}`, "data-evidence": label.trim() })),
    h("p", { style: { margin: 0, color: "var(--ps-muted)" } }, draft
        ? "Publishing freezes this exact revision: it no longer changes, and a new version needs a new workflow. Publication starts no run, approves no repository write and grants no tool."
        : "Starting runs the published revision with real effects. A workflow has one live run."),
    runs ? h("label", { style: { display: "grid", gap: 2 } }, "Inputs (JSON object)",
        h("textarea", { value: inputs, rows: 3, onChange: event => setInputs(event.target.value), "data-field": "inputs",
            style: { fontFamily: "var(--ps-font-mono, monospace)", width: "100%" } })) : null,
    runs ? h("label", { style: { display: "grid", gap: 2 } }, "Initial variables (JSON object, optional)",
        h("textarea", { value: vars, rows: 2, onChange: event => setVars(event.target.value), "data-field": "vars",
            style: { fontFamily: "var(--ps-font-mono, monospace)", width: "100%" } })) : null,
    h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
        model.controls.map(control => h("button", { key: control.operation, type: "button", className: "ps-mini-button",
            "data-operation": control.operation, disabled: !control.enabled, title: control.title,
            onClick: () => { send(control.operation); } }, control.label)),
        h("button", { type: "button", className: "ps-mini-button",
            onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { definitionOpen: false } }) }, "Close")),
    error ? h("span", { role: "alert", style: { color: TONES.error } }, error) : null);
}

/** The header button that opens and closes the draft editor (the view's `draftOpen`). */
export function WorkflowV2DraftToggle({ controller, sessionId, model, open, controls }) {
    if (!model) return null;
    return h(WorkflowToolButton, { label: "Edit draft", glyph: "edit", "aria-expanded": Boolean(open), "aria-controls": open ? controls : undefined,
        onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { draftOpen: !open } }) });
}

/**
 * The draft's YAML editor (design 04 replace_definition; mocks M01 and M02; R03, R17, R26; INACTIVE: only a read model
 * that carries the draft's YAML for this caller has it). `model` is workflowV2DraftEditor's answer. An edit starts from
 * the revision shown and is saved at that revision, so a draft someone else changed meanwhile is refused, never
 * overwritten: the editor then says so and offers to load the new revision (discarding the edit) or to keep the edit on
 * it. Edits are kept across a refusal and a new read. The version (metadata.version) cannot change: a new version needs
 * a new workflow, and the server refuses it.
 */
export function WorkflowV2DraftEditor({ controller, sessionId, model, id, revisionReads = null, agentSteps = [], stepInput = null, stepInputPreview = null }) {
    const [base, setBase] = React.useState(() => model ? { revision: model.revision, yaml: model.yaml } : null);
    const [textValue, setTextValue] = React.useState(() => model?.yaml ?? "");
    const [comparing, setComparing] = React.useState(false);
    // A new revision read while nothing was edited (or one that is exactly this edit, once saved) is taken as it is.
    React.useEffect(() => {
        if (!model || !base || model.revision === base.revision) return;
        if (textValue === base.yaml || textValue === model.yaml) {
            setBase({ revision: model.revision, yaml: model.yaml });
            setTextValue(model.yaml);
        }
    }, [model?.revision, model?.yaml]);
    if (!model || !base) return null;
    const edit = workflowV2DraftEdit(base, textValue, model);
    const save = () => {
        if (!edit.canSave) return;
        controller.sendWorkflowRunCommand(sessionId, { operation: "replace_definition", expectedRevision: base.revision, yaml: textValue });
    };
    return h("section", { id, className: "ps-workflow-draft-editor", "aria-label": "Draft editor", "data-revision": base.revision,
        style: { display: "grid", gap: 6, padding: "6px 12px", fontSize: "0.75rem", borderBottom: "1px solid var(--ps-border)" } },
    h("h3", { style: { margin: 0, fontSize: "0.8rem" } }, `Draft · editing revision ${base.revision}`),
    h("p", { style: { margin: 0, color: "var(--ps-muted)" } },
        `Saving makes a new revision; it never overwrites one someone else saved meanwhile.${model.semver ? ` The version stays ${model.semver}: a new version needs a new workflow.` : ""}`),
    edit.conflict ? h("div", { role: "alert", "data-conflict": "true", style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, color: TONES.warning } },
        h("span", { style: { flex: "1 1 20em" } }, edit.reason),
        h("button", { type: "button", className: "ps-mini-button", "data-action": "load",
            onClick: () => { setBase({ revision: model.revision, yaml: model.yaml }); setTextValue(model.yaml); } }, `Load revision ${model.revision}`),
        h("button", { type: "button", className: "ps-mini-button", "data-action": "keep",
            onClick: () => setBase({ revision: model.revision, yaml: model.yaml }) }, `Keep my edits on revision ${model.revision}`)) : null,
    h(WorkflowV2YamlBox, { value: textValue, onChange: setTextValue,
        // The saved revision's errors, on their lines, while the edit is of that revision (owner decision q5).
        marks: !edit.conflict && model.current ? workflowV2DraftMarks(model.diagnostics) : { lines: [], unplaced: 0 }, changed: edit.changed }),
    h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 } },
        h("button", { type: "button", className: "ps-mini-button", "data-operation": "replace_definition", disabled: !edit.canSave,
            title: edit.reason ?? `Save as a new revision after revision ${base.revision}.`, onClick: save }, model.pending ? "Saving…" : "Save draft"),
        h("button", { type: "button", className: "ps-mini-button", "data-action": "discard", disabled: !edit.changed,
            onClick: () => setTextValue(base.yaml) }, "Discard edits"),
        h("button", { type: "button", className: "ps-mini-button", "data-action": "compare", "aria-expanded": comparing,
            disabled: model.revision < 2, title: model.revision < 2 ? "There is only one version so far." : "Compare two saved versions of this draft.",
            onClick: () => setComparing(open => !open) }, "Compare versions"),
        h("button", { type: "button", className: "ps-mini-button",
            onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { draftOpen: false } }) }, "Close"),
        edit.changed && !edit.conflict ? h("span", { role: "status", style: { color: "var(--ps-muted)" } }, "Unsaved changes") : null),
    comparing && model.revision >= 2 ? h(WorkflowV2RevisionCompare, { controller, sessionId, latest: model.revision, reads: revisionReads }) : null,
    agentSteps.length ? h(WorkflowV2StepInputEditor, { controller, sessionId, steps: agentSteps, loaded: stepInput, preview: stepInputPreview,
        draftRevision: model.revision, draftYaml: model.yaml, busy: model.busy, unsaved: edit.changed }) : null);
}

/**
 * Change an agent step's inputs without writing YAML (owner decision q6): choose the step, then for each of its input
 * fields where the value comes from (a run input, the previous step's result, a workflow variable or a fixed value; a
 * value written in a way this editor does not change stays as written). "Show the change" asks the server to write it
 * into the draft's YAML (only that step's input lines change) and shows the changed lines; "Save as a new draft
 * revision" saves exactly that text, at the revision it was prepared on. Changing or adding a field drops the prepared
 * change, so what is saved is always what the fields say. Nothing is saved while the YAML box above has
 * unsaved edits, so the two never overwrite each other.
 */
export function WorkflowV2StepInputEditor({ controller, sessionId, steps, loaded, preview, draftRevision, draftYaml, busy, unsaved }) {
    const [state, setState] = React.useState(steps[0]);
    const [rows, setRows] = React.useState(() => workflowV2StepInputRows(loaded?.state === steps[0] && loaded.phase === "loaded" ? loaded.value : null));
    const [error, setError] = React.useState(null);
    const [newField, setNewField] = React.useState("");
    const listId = React.useId();
    const chosen = steps.includes(state) ? state : steps[0];
    React.useEffect(() => { controller.loadWorkflowStepInput?.(sessionId, chosen)?.catch?.(() => {}); }, [controller, sessionId, chosen, draftRevision]);
    const mine = loaded && loaded.state === chosen ? loaded : null;
    const value = mine?.phase === "loaded" ? mine.value : null;
    React.useEffect(() => { setRows(workflowV2StepInputRows(value)); setError(null); }, [value]);
    // Any change to the fields drops the prepared change (and one still being prepared): it no longer says what is shown.
    const changeRows = update => { setRows(update); controller.forgetWorkflowStepInputPreview?.(sessionId); };
    const setRow = (index, patch) => changeRows(current => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    const request = workflowV2StepInputRequest(rows);
    // A prepared change is shown, and saved, only while it was prepared from exactly these fields.
    const shown = preview && preview.state === chosen && preview.key === workflowV2StepInputKey(request.ok ? request.input : null) ? preview : null;
    const summary = shown ? workflowV2StepInputSummary(chosen, shown) : null;
    const prepare = () => {
        if (!request.ok) { setError(request.error); return; }
        setError(null);
        controller.previewWorkflowStepInput?.(sessionId, chosen, request.input)?.catch?.(() => {});
    };
    const stale = shown?.phase === "loaded" && shown.revision !== draftRevision;
    const canSave = shown?.phase === "loaded" && shown.value?.changed === true && !stale && !busy && !unsaved;
    const saveTitle = unsaved ? "Save or discard your YAML edits above first." : stale ? "The draft changed since this was prepared; show the change again."
        : busy ? "Another command for this workflow is being sent." : shown?.value?.changed === true ? `Save as a new revision after revision ${draftRevision}.`
            : "Show the change first.";
    const changedLines = shown?.phase === "loaded" && typeof shown.value?.yaml === "string"
        ? workflowV2LineDiff(draftYaml, shown.value.yaml).rows.filter(row => row.kind !== "same") : [];
    const placeholder = source => source === "run_input" ? "run input name" : source === "variable" ? "variable name"
        : source === "previous_step" ? "field of its result, such as summary (empty: all of it)" : source === "fixed" ? "value, such as 3, true or a text" : "";
    const runInputs = Array.isArray(value?.runInputs) ? value.runInputs : [];
    return h("section", { className: "ps-workflow-step-input", "aria-label": "Step inputs", "data-state": chosen,
        style: { display: "grid", gap: 6, paddingTop: 6, borderTop: "1px solid var(--ps-border)" } },
    h("h3", { style: { margin: 0, fontSize: "0.8rem" } }, "Step inputs"),
    h("label", { style: { display: "inline-flex", alignItems: "center", gap: 6 } }, "Agent step",
        h("select", { value: chosen, "data-field": "step", onChange: event => setState(event.target.value) },
            steps.map(step => h("option", { key: step, value: step }, step)))),
    mine?.phase === "loading" ? h("p", { role: "status", style: { margin: 0 } }, "Reading the step's inputs…") : null,
    mine?.phase === "failed" ? h("p", { role: "alert", style: { margin: 0, color: TONES.error } }, `The step's inputs could not be read: ${mine.error}`) : null,
    value?.inputShape === "expression" ? h("p", { style: { margin: 0, color: TONES.warning } },
        `This step's input is written as one value (${value.inputText}). Choosing fields below replaces it.`) : null,
    value && !value.schemaDeclared ? h("p", { style: { margin: 0, color: "var(--ps-muted)" } },
        "This step does not list its input fields (inputSchema), so add each field by name.") : null,
    runInputs.length ? h("datalist", { id: listId }, runInputs.map(name => h("option", { key: name, value: name }))) : null,
    value ? h("table", null,
        h("thead", null, h("tr", null, ["Field", "Where its value comes from", "Which one"].map(label => h("th", { key: label }, label)))),
        h("tbody", null, rows.map((row, index) => h("tr", { key: row.name, "data-input-field": row.name },
            h("td", null, row.name, row.required ? " (required)" : "", row.type ? ` · ${row.type}` : "",
                row.description ? h("div", { style: { color: "var(--ps-muted)" } }, row.description) : null),
            h("td", null, h("select", { value: row.source, "aria-label": `Where ${row.name} comes from`,
                onChange: event => setRow(index, { source: event.target.value,
                    detail: event.target.value === "keep" ? row.keepText ?? "" : event.target.value === row.source ? row.detail : "" }) },
            Object.entries(WORKFLOW_V2_STEP_INPUT_SOURCE_LABELS).filter(([source]) => source !== "keep" || row.keepable)
                .map(([source, label]) => h("option", { key: source, value: source }, label)))),
            h("td", null, row.source === "none" ? null : row.source === "keep"
                ? h("code", null, row.detail)
                : h("input", { type: "text", value: row.detail, placeholder: placeholder(row.source), "aria-label": `${row.name}: ${placeholder(row.source)}`,
                    list: row.source === "run_input" && runInputs.length ? listId : undefined, onChange: event => setRow(index, { detail: event.target.value }) })))))) : null,
    value ? h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 } },
        h("input", { type: "text", value: newField, placeholder: "new field name", "aria-label": "New field name", "data-field": "new-field",
            onChange: event => setNewField(event.target.value) }),
        h("button", { type: "button", className: "ps-mini-button", "data-action": "add-field",
            disabled: !newField.trim() || rows.some(row => row.name === newField.trim()),
            onClick: () => { changeRows(current => [...current, { name: newField.trim(), required: false, declared: false, type: null, description: null,
                source: "fixed", detail: "", keepable: false, keepText: null }]); setNewField(""); } }, "Add field")) : null,
    request.ok && request.missing.length ? h("p", { style: { margin: 0, color: TONES.warning } },
        `Not set: ${request.missing.join(", ")} (required). The step refuses to start without them.`) : null,
    error ? h("p", { role: "alert", style: { margin: 0, color: TONES.error } }, error) : null,
    summary ? h("p", { role: summary.level === "error" ? "alert" : "status", style: { margin: 0, color: TONES[summary.level] ?? TONES.info } }, summary.text) : null,
    changedLines.length ? h("pre", { className: "ps-workflow-step-input-change", style: { margin: 0, overflow: "auto" } },
        changedLines.map((row, i) => h("div", { key: i, "data-kind": row.kind, style: { color: row.kind === "added" ? "var(--ps-success, inherit)" : TONES.error } },
            `${row.kind === "added" ? "+" : "-"} ${row.text}`))) : null,
    value ? h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 } },
        h("button", { type: "button", className: "ps-mini-button", "data-action": "prepare-step-input", disabled: shown?.phase === "loading",
            onClick: prepare }, "Show the change"),
        h("button", { type: "button", className: "ps-mini-button", "data-operation": "replace_definition", "data-action": "save-step-input",
            disabled: !canSave, title: saveTitle,
            onClick: () => { controller.saveWorkflowStepInput?.(sessionId, { state: chosen, input: request.input })?.catch?.(() => {}); } },
        "Save as a new draft revision")) : null);
}

let diffEditorModule = null;
const loadDiffEditor = () => (diffEditorModule ??= import("./workspace-editor.js"));

/**
 * Compare two saved versions of the draft (owner decision q4; mocks M01, M02, M20 "Compare revisions"): pick the two
 * revisions (by default the one before the latest and the latest), side by side or in one column, both shown as properly
 * formatted YAML (a draft written as JSON compares as YAML) in the Workspace pane's read-only diff view, with a summary
 * of the lines added and removed. Until that view has loaded (and wherever it cannot load), the same comparison shows as
 * lines marked + and -. Each revision is read once (controller.loadWorkflowDefinitionRevision); reading changes nothing.
 */
export function WorkflowV2RevisionCompare({ controller, sessionId, latest, reads }) {
    const [from, setFrom] = React.useState(Math.max(1, latest - 1));
    const [to, setTo] = React.useState(latest);
    const [layout, setLayout] = React.useState("split");
    const [viewer, setViewer] = React.useState("pending");
    const hostRef = React.useRef(null);
    React.useEffect(() => {
        controller.loadWorkflowDefinitionRevision?.(sessionId, from)?.catch?.(() => {});
        controller.loadWorkflowDefinitionRevision?.(sessionId, to)?.catch?.(() => {});
    }, [controller, sessionId, from, to]);
    const compared = workflowV2RevisionCompare(reads, from, to);
    const beforeText = compared.before.text, afterText = compared.after.text;
    React.useEffect(() => {
        if (!compared.ready || !hostRef.current) return undefined;
        let disposed = false;
        let handle = null;
        setViewer("pending");
        loadDiffEditor().then(module => {
            if (disposed || !hostRef.current) return undefined;
            return module.createDiff(hostRef.current, { original: beforeText, modified: afterText, name: "workflow.yaml", layout }).then(made => {
                if (disposed) made.destroy();
                else { handle = made; setViewer("ready"); }
            });
        }).catch(() => { if (!disposed) setViewer("failed"); });
        return () => { disposed = true; handle?.destroy(); };
    }, [compared.ready, beforeText, afterText, layout]);
    const options = Array.from({ length: latest }, (_, index) => index + 1);
    const pick = (label, value, onChange, field) => h("label", { style: { display: "inline-flex", alignItems: "center", gap: 4 } }, label,
        h("select", { value, "data-field": field, onChange: event => onChange(Number(event.target.value)) },
            options.map(revision => h("option", { key: revision, value: revision }, `Revision ${revision}${revision === latest ? " (latest)" : ""}`))));
    return h("section", { className: "ps-workflow-compare", "aria-label": "Compare versions", "data-from": from, "data-to": to,
        style: { display: "grid", gap: 6 } },
    h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 } },
        pick("From", from, setFrom, "compare-from"), pick("To", to, setTo, "compare-to"),
        h("button", { type: "button", className: "ps-mini-button", "aria-pressed": layout === "split", onClick: () => setLayout("split") }, "Side by side"),
        h("button", { type: "button", className: "ps-mini-button", "aria-pressed": layout === "inline", onClick: () => setLayout("inline") }, "One column")),
    h("p", { role: compared.failed ? "alert" : "status", style: { margin: 0, color: compared.failed ? TONES.error : "var(--ps-muted)" } }, compared.summary,
        compared.ready && !(compared.before.formatted && compared.after.formatted) ? " A revision that does not parse is shown as saved." : ""),
    // The diff view's own element (CodeMirror fills it; React renders nothing into it), shown once it is ready.
    compared.ready ? h("div", { ref: hostRef, className: "ps-workflow-compare-view",
        style: viewer === "ready" ? { maxHeight: "28em", overflow: "auto", border: "1px solid var(--ps-border)" } : { display: "none" } }) : null,
    compared.ready && viewer !== "ready" ? h("pre", { "data-diff": "lines", style: { margin: 0, padding: "4px 6px", maxHeight: "28em", overflow: "auto",
        border: "1px solid var(--ps-border)", fontFamily: "var(--ps-font-mono, monospace)", fontSize: "0.8rem" } },
    compared.diff.rows.map((row, index) => h("div", { key: index, "data-kind": row.kind,
        style: row.kind === "added" ? { color: TONES.success ?? "var(--ps-code-inserted)" } : row.kind === "removed" ? { color: TONES.error } : undefined },
    `${row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "} ${row.text}`))) : null);
}

/**
 * The draft's YAML box with its errors marked inside it (owner decision q5): a line-number column beside the text, whose
 * marked lines show "●" in the error or warning colour with the messages as their title, and below the box one button
 * per marked line that moves the cursor to it and selects it. The box stays a plain text box (screen readers and every
 * test read it as one); it does not wrap lines, so each number stays beside its line. Marks are the saved revision's:
 * after an edit they stay on their line numbers until the next save checks the text.
 */
function WorkflowV2YamlBox({ value, onChange, marks, changed }) {
    const areaRef = React.useRef(null);
    const gutterRef = React.useRef(null);
    const listId = `wf-yaml-marks-${React.useId().replace(/:/g, "")}`;
    const lineCount = value.split("\n").length;
    const byLine = new Map(marks.lines.map(mark => [mark.line, mark]));
    const mono = { fontFamily: "var(--ps-font-mono, monospace)", fontSize: "0.8rem", lineHeight: 1.45 };
    const goTo = line => {
        const area = areaRef.current;
        if (!area) return;
        const rows = area.value.split("\n");
        const index = Math.min(Math.max(1, line), rows.length) - 1;
        const start = rows.slice(0, index).reduce((sum, row) => sum + row.length + 1, 0);
        area.focus();
        area.setSelectionRange(start, start + rows[index].length);
        area.scrollTop = Math.max(0, (area.scrollHeight / Math.max(1, rows.length)) * (index - 2));
    };
    return h(React.Fragment, null,
        h("div", { className: "ps-workflow-yaml", style: { display: "flex", border: "1px solid var(--ps-border)", borderRadius: 4 } },
            h("div", { ref: gutterRef, className: "ps-workflow-yaml-gutter", "aria-hidden": "true",
                style: { ...mono, overflow: "hidden", textAlign: "right", padding: "2px 6px", color: "var(--ps-muted)", userSelect: "none",
                    borderRight: "1px solid var(--ps-border)", minWidth: "3.5em" } },
            Array.from({ length: lineCount }, (_, index) => {
                const mark = byLine.get(index + 1);
                return h("div", { key: index, ...(mark ? { "data-mark": mark.severity, title: mark.texts.join("\n"),
                    style: { color: mark.severity === "error" ? TONES.error : TONES.warning, fontWeight: 700 } } : {}) },
                mark ? `● ${index + 1}` : String(index + 1));
            })),
            h("textarea", { ref: areaRef, value, rows: 16, wrap: "off", spellCheck: false, "aria-label": "Workflow YAML", "data-field": "yaml",
                ...(marks.lines.length ? { "aria-describedby": listId } : {}),
                onChange: event => onChange(event.target.value),
                onScroll: event => { if (gutterRef.current) gutterRef.current.scrollTop = event.target.scrollTop; },
                style: { ...mono, flex: 1, minWidth: 0, width: "100%", resize: "vertical", border: 0, padding: "2px 6px", whiteSpace: "pre", overflow: "auto" } })),
        marks.lines.length ? h("ul", { id: listId, className: "ps-workflow-yaml-marks", "aria-label": "Errors marked in the YAML",
            style: { margin: 0, paddingLeft: 18, display: "grid", gap: 2 } },
        marks.lines.map(mark => h("li", { key: mark.line, "data-mark": mark.severity },
            h("button", { type: "button", className: "ps-mini-button", "data-line": mark.line, onClick: () => goTo(mark.line) }, `Line ${mark.line}`),
            " ", h("span", { style: { color: mark.severity === "error" ? TONES.error : TONES.warning } }, mark.texts.join("; "))))) : null,
        marks.lines.length && changed ? h("p", { style: { margin: 0, color: "var(--ps-muted)" } },
            "The marks are for the revision as saved; save to check your edits.") : null);
}

/** The header button that opens and closes the test review (the view's `testOpen`). */
export function WorkflowV2TestToggle({ controller, sessionId, model, open, controls }) {
    if (!model) return null;
    return h(WorkflowToolButton, { label: "Test…", glyph: "test", "aria-expanded": Boolean(open), "aria-controls": open ? controls : undefined,
        onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { testOpen: !open } }) });
}

/**
 * Test review (design 05; mocks M18 to M20; R19, R20, R26, R28; INACTIVE: only a read model that says the workflow takes
 * a test from people has it). `model` is workflowV2TestControls' answer. It shows exactly what is tested (the definition,
 * the current revision and its full definition hash) and the test notice: scripts run for real, framework tools are
 * mocked, and a test result is not evidence that the definition is safe to run live. Agents are mocked by default; real
 * agents spend model tokens, and the notice says so before the test starts. Start test sends the revision and hash with
 * the inputs and optional initial variables (JSON objects) and an optional scenario name; once it starts, the view shows
 * the new test run.
 */
export function WorkflowV2TestPanel({ controller, sessionId, model, id }) {
    const [inputs, setInputs] = React.useState("{}");
    const [vars, setVars] = React.useState("");
    const [scenario, setScenario] = React.useState("");
    const [agentMode, setAgentMode] = React.useState("mocked");
    const [error, setError] = React.useState(null);
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const modeName = `wf-test-agents-${React.useId().replace(/:/g, "")}`;
    if (!model) return null;
    const start = async () => {
        const parsedInputs = workflowV2JsonObjectDraft(inputs, { label: "Inputs" });
        const parsedVars = workflowV2JsonObjectDraft(vars, { label: "Initial variables", optional: true });
        const parsedScenario = workflowV2ScenarioDraft(scenario);
        const refused = [parsedInputs, parsedVars, parsedScenario].find(item => !item.ok);
        if (refused) { setError(refused.error); return; }
        setError(null);
        const result = await controller.sendWorkflowRunCommand(sessionId, { operation: "test", expectedRevision: model.revision,
            definitionHash: model.definitionHash, inputs: parsedInputs.value, agentMode,
            ...(parsedVars.value !== undefined ? { vars: parsedVars.value } : {}), ...(parsedScenario.value !== undefined ? { scenario: parsedScenario.value } : {}) });
        const runId = result?.ok && typeof result.receipt?.run?.runId === "string" ? result.receipt.run.runId : null;
        if (result?.ok && mounted.current) {
            controller.dispatch({ type: "ui/workflowView", sessionId, view: { testOpen: false, ...(runId ? { selectedRunId: runId } : {}) } });
        }
    };
    const radio = (value, label) => h("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, marginRight: 12 } },
        h("input", { type: "radio", name: modeName, value, checked: agentMode === value, onChange: () => setAgentMode(value), "data-agent-mode": value }), label);
    return h("section", { id, className: "ps-workflow-test-review", "aria-label": "Test review", "data-revision": model.revision ?? undefined,
        style: { display: "grid", gap: 6, padding: "6px 12px", fontSize: "0.75rem", borderBottom: "1px solid var(--ps-border)" } },
    h("h3", { style: { margin: 0, fontSize: "0.8rem" } }, "Test review"),
    h("p", { role: "note", style: { margin: 0, color: TONES.warning } }, WORKFLOW_V2_TEST_NOTICE_TEXT),
    h(DefinitionSummary, { model, revisionLabel: model.state === "draft" ? "draft revision" : "revision", revision: model.revision, hash: model.definitionHash,
        validity: model.valid ? "valid" : `${model.errors || "unlisted"} error${model.errors === 1 ? "" : "s"}: it cannot be tested` }),
    h("fieldset", { style: { margin: 0, padding: "4px 8px", border: "1px solid var(--ps-border)" } },
        h("legend", null, "Agent steps"),
        radio("mocked", "Mocked: the parent answers for each agent step"),
        radio("real", "Real agents (spend model tokens)")),
    agentMode === "real" ? h("p", { role: "note", "data-notice": "real-agents", style: { margin: 0, color: TONES.warning } },
        WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT) : null,
    h("label", { style: { display: "grid", gap: 2 } }, "Inputs (JSON object)",
        h("textarea", { value: inputs, rows: 3, onChange: event => setInputs(event.target.value), "data-field": "inputs",
            style: { fontFamily: "var(--ps-font-mono, monospace)", width: "100%" } })),
    h("label", { style: { display: "grid", gap: 2 } }, "Initial variables (JSON object, optional)",
        h("textarea", { value: vars, rows: 2, onChange: event => setVars(event.target.value), "data-field": "vars",
            style: { fontFamily: "var(--ps-font-mono, monospace)", width: "100%" } })),
    h("label", { style: { display: "grid", gap: 2 } }, "Scenario name (optional)",
        h("input", { type: "text", value: scenario, maxLength: 128, onChange: event => setScenario(event.target.value), "data-field": "scenario" })),
    h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
        h("button", { type: "button", className: "ps-mini-button", "data-operation": "test", disabled: !model.control.enabled, title: model.control.title,
            onClick: () => { start(); } }, model.control.label),
        h("button", { type: "button", className: "ps-mini-button",
            onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { testOpen: false } }) }, "Close")),
    error ? h("span", { role: "alert", style: { color: TONES.error } }, error) : null);
}
