import React from "react";
import {
    compactWorkflowV2Executions, formatSeconds, formatWorkflowValue, workflowV2Activity, workflowV2AgentBindingRows, workflowV2AgentChatMode, workflowV2AgentTask, workflowV2AgentTools, workflowV2ExecutionResult,
    workflowV2ExecutionValue, workflowV2KvApplied, workflowV2KvCompare, workflowV2KvSnapshot, workflowV2RouteKind, workflowV2SessionSubtree, workflowV2ShownExecution,
    workflowV2AgentEndText, workflowV2EventTime, workflowV2ShortHash, workflowV2ShownNotices, workflowV2VisitEnding, workflowV2WholeValue,
    describeWorkflowV2Execution, workflowV2BranchChoice, workflowV2BranchNumber, workflowV2BranchSteps, workflowV2ForEachText,
    workflowV2RevisionErrorsText, workflowV2JoinWords, workflowV2VisitScope, workflowV2NotReachedText, workflowV2ItemList, workflowV2OutcomeWord,
} from "../../core/src/workflow-v2-view.js";
import { workflowV2RunPickerModel } from "../../core/src/workflow-v2-run-picker.js";
import { workflowNodeSummary } from "../../core/src/workflow-node-summary.js";
import { workflowShortTime, workflowTimeTitle } from "../../core/src/workflow-words.js";
import { WORKFLOW_BASE_INSTRUCTIONS_CHANGED, WORKFLOW_BASE_INSTRUCTIONS_OWNER_ONLY } from "../../core/src/workflow-agent-log.js";
import { workflowTabButtonTip, workflowVersionCompareSides } from "../../core/src/workflow-owner.js";
import { WorkflowToolButton } from "./workflow-tool-button.js";
import { CodeBlock, CodeText, codeChildren, useCodeRuns } from "./workflow-code.js";
import {
    WORKFLOW_V2_STEP_INPUT_SOURCE_LABELS, WORKFLOW_V2_TEST_NOTICE_TEXT, WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT, WORKFLOW_V2_VARIABLES_HELP_TEXT, workflowV2AdvanceDraft, workflowV2DraftEdit, workflowV2DraftMarks, workflowV2JsonObjectDraft,
    workflowV2LineDiff, workflowV2PublicationEvidenceRows, workflowV2RevisionCompare, workflowV2VersionCompare, workflowV2StepInputKey, workflowV2StepInputRequest, workflowV2StepInputRows, workflowV2StepInputSummary,
    workflowV2StepInputEditorState, workflowV2StepInputEdited, workflowV2StepInputLoadWaiting,
    workflowV2ScenarioDraft, workflowV2TestAnswerTemplate, workflowV2TestResponseDraft, workflowV2VariableDraft, workflowV2VariableRemoval,
    workflowV2VariableEdit, workflowV2VariableEditState, WORKFLOW_V2_VARIABLE_EDIT_EMPTY,
    workflowV2AnswerSourceText, WORKFLOW_V2_ASK_PARENT_KINDS, workflowV2AskParentSent, workflowV2InputsBoxEmpty, workflowV2SampleInputs,
    workflowV2TestRunsShown,
} from "../../core/src/workflow-v2-commands.js";

const h = React.createElement;
// UXFD-F5: error words use the Workflow's danger text colour, chosen per theme for 4.5:1 (FUI-F2), as the CSS does.
const TONES = { error: "var(--ps-wf-danger-text, var(--ps-danger))", warning: "var(--ps-warning)", info: "var(--ps-muted)" };

/** What is wrong with a JSON box's text, in plain words, or null (empty text is left to the submit's own check). */
function jsonProblem(text, { name, object }) {
    if (typeof text !== "string" || !text.trim()) return null;
    if (object) {
        const draft = workflowV2JsonObjectDraft(text, { label: name, optional: true });
        return draft.ok ? null : draft.error;
    }
    try { JSON.parse(text); return null; } catch (error) { return `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`; }
}

/** A JSON box starts at its text's height, at least 2 lines, and grows to 8; past that it scrolls inside (batch 6, f-04). */
const JSON_BOX_MIN_ROWS = 2;
const JSON_BOX_MAX_ROWS = 8;

/**
 * A JSON edit box of the workflow screen (of-07): its label tied to it, the shared theme style in monospace, vertical
 * resize, and what is wrong with the JSON as text under it while it is invalid (its description, so screen readers read
 * it with the box). `object` asks for a JSON object; otherwise any JSON value. Its height follows its text (f-04).
 */
function JsonBox({ label, name, value, onChange, field, object = true, className = "", action = null, title = null }) {
    const id = `wf-json-${React.useId().replace(/:/g, "")}`;
    const problem = jsonProblem(value, { name, object });
    const rows = Math.min(JSON_BOX_MAX_ROWS, Math.max(JSON_BOX_MIN_ROWS, String(value ?? "").split("\n").length));
    const labelEl = h("label", { htmlFor: id, title: title ?? undefined }, label);
    return h("div", { className: `ps-workflow-field${className ? ` ${className}` : ""}` },
        // `action`: a small button beside the label (the inputs' Sample, f-05).
        action ? h("div", { className: "ps-workflow-field-head" }, labelEl, action) : labelEl,
        h("textarea", { id, className: "ps-workflow-input is-code", value, rows, spellCheck: false, "data-field": field,
            "aria-invalid": problem ? true : undefined, "aria-describedby": problem ? `${id}-problem` : undefined,
            onChange: event => onChange(event.target.value) }),
        problem ? h("span", { id: `${id}-problem`, className: "ps-workflow-field-error" }, problem) : null);
}

/** A one-line or plain-text edit box of the workflow screen, in the shared style (of-07), its label tied to it. */
function TextBox({ label, children, className = "" }) {
    return h("label", { className: `ps-workflow-field${className ? ` ${className}` : ""}` }, h("span", null, label), children);
}

/**
 * A run's Inputs box with sample data from the workflow's input schema (batch 7, f-05; workflowV2SampleInputs): filled
 * when it is empty or "{}" and the person has not typed in it, again when the schema changes while it still is, and on
 * Sample (an icon button beside its label, only when the schema gives a sample). Returns the box's text, its change
 * handler for JsonBox and that button.
 */
function useSampleInputs(schema) {
    const schemaKey = JSON.stringify(schema ?? null);
    const sampleText = React.useMemo(() => {
        const sample = workflowV2SampleInputs(schema);
        return sample ? JSON.stringify(sample, null, 2) : null;
    }, [schemaKey]);
    const [inputs, setInputs] = React.useState(() => sampleText ?? "{}");
    const typed = React.useRef(false);
    React.useEffect(() => {
        if (sampleText && !typed.current) setInputs(current => (workflowV2InputsBoxEmpty(current) ? sampleText : current));
    }, [sampleText]);
    const onChange = value => { typed.current = true; setInputs(value); };
    const action = sampleText ? h(WorkflowToolButton, { label: "Sample", glyph: "sample", "data-action": "sample-inputs",
        title: "Fill with sample inputs from the schema", onClick: () => { typed.current = false; setInputs(sampleText); } }) : null;
    return { inputs, onChange, action };
}

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
    // UXFD-F6: the words a person reads are the line and the message; the code and the path stay in the tooltip, for support.
    diagnostics.map((item, i) => h("li", { key: i, "data-severity": item.severity, "data-code": item.code ?? undefined,
        title: [item.code, item.path].filter(Boolean).join(" · ") || undefined },
        item.severity === "warning" ? "Warning: " : "", item.line ? `Line ${item.line}: ` : "", item.message)));
}

/**
 * Shown in place of the graph when the read model has no graph to draw: draft without a graph, invalid, or unrecognized.
 * Owner batch 7 (H1): while the parent agent is still writing the latest revision (`drafting`, workflowV2DraftInProgress),
 * it says so calmly, with that revision's errors folded under one line; no alert. Otherwise, as before.
 */
export function WorkflowV2NoGraph({ projection, drafting = null }) {
    if (drafting) {
        return h("div", { className: "ps-workflow-empty is-drafting", role: "status", "data-drafting": drafting.revision },
            h("strong", null, "The agent is still writing this Workflow."),
            h("details", { className: "ps-workflow-draft-errors" },
                h("summary", null, workflowV2RevisionErrorsText(drafting.revision, drafting.errors)),
                h(WorkflowV2Diagnostics, { diagnostics: projection.diagnostics })),
            // Any other notice, as before; the revision's own errors are the folded line above.
            h(WorkflowV2Banners, { banners: workflowV2ShownNotices(projection.banners, { draftInProgress: drafting }).filter(banner => !banner.quiet) }));
    }
    const alert = projection.banners.some(banner => banner.level === "error");
    return h("div", { className: "ps-workflow-empty", role: alert ? "alert" : "status" },
        h("strong", null, projection.modelStatus === "invalid" ? "This definition is not valid" : "No graph to show"),
        // "No run yet" is said once, by the run's status in the header (batch 5, g-07).
        h(WorkflowV2Banners, { banners: workflowV2ShownNotices(projection.banners) }),
        h(WorkflowV2Diagnostics, { diagnostics: projection.diagnostics }));
}

function Value({ value, label, truncatedNote = "This preview was cut short; the full value is not in this view." }) {
    const { text, truncated } = formatWorkflowValue(value);
    if (!text) return null;
    return h(React.Fragment, null,
        label ? h("h3", null, label) : null,
        // OF-S2-8: a JSON value is highlighted.
        h(CodeBlock, { text, language: "auto" }),
        truncated ? h("p", null, truncatedNote) : null);
}

const withThousands = value => Number(value).toLocaleString("en-US");

/**
 * One execution's whole value as it was read (workflowV2WholeValue; mock M10 "Inspect typed output"): being read, its
 * failure, that it had no value, or the whole output or runtime error with its size; a stored value larger than a read
 * returns (none is written) shows its start and says so. Every value is a React text child.
 */
function WholeValue({ whole }) {
    if (whole.kind === "loading") return h("p", { role: "status" }, "Reading…");
    if (whole.kind === "failed") return h("p", { role: "alert" }, `Could not read it: ${whole.error}`);
    if (whole.kind === "none") return h("p", null, "No value yet: it had not ended.");
    const size = whole.bytes === null ? "" : ` · ${withThousands(whole.bytes)} bytes`;
    return h(React.Fragment, null,
        h("h3", null, `${whole.label === "Runtime error" ? "Error" : "Output"}${size}`),
        // Review 18:45Z: no parenthetical in the words; the read's limit is the tooltip.
        whole.kind === "preview" ? h("p", { "data-whole-preview": "", title: whole.limitBytes === null ? "Larger than one read"
            : `Larger than one read of ${withThousands(whole.limitBytes)} bytes` }, "Only its start is shown.") : null,
        h(CodeBlock, { text: whole.text, language: "auto", "data-whole-value": whole.kind }));
}

/**
 * A failed Workflow's error as it arrived, folded under its headline (coordinator 2026-11-06; workflowFailure). Review
 * UI-D7: when the words and that text leave out recorded detail (a cut preview, a script's stderr), Read the whole error
 * reads the failed visit's whole stored error and shows it here.
 */
export function WorkflowV2FailureDetails({ failure, runId = null, executionValues = null, onReadWholeValue = null }) {
    if (!failure?.details || (failure.details === failure.words && !failure.leavesOut)) return null;
    const canRead = Boolean(failure.leavesOut && failure.executionId && runId && onReadWholeValue);
    const whole = canRead ? workflowV2WholeValue(workflowV2ExecutionValue(executionValues, runId, failure.executionId)) : null;
    return h("details", { className: "ps-wf-failure-details" }, h("summary", null, "Details"), h("pre", null, failure.details),
        canRead ? h("button", { type: "button", className: "ps-mini-button", "data-action": "whole-error", "data-execution": failure.executionId,
            disabled: whole?.kind === "loading", onClick: () => onReadWholeValue(failure.executionId) },
        whole && whole.kind !== "loading" ? "Show all again" : "Show all") : null,
        whole ? h(WholeValue, { whole }) : null);
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
        rows.push(["Agent", workflowV2AgentTask(node)], ["Chat", workflowV2AgentChatMode(node)], ...workflowV2AgentBindingRows(node.binding), ["Outcomes", (node.outcomes || []).join(", ") || "—"]);
        // FU-17: a state that limits its agent's tools says which.
        if (workflowV2AgentTools(node)) rows.push(["Tools", workflowV2AgentTools(node)]);
        if (node.timeoutSeconds !== undefined) rows.push(["Deadline", typeof node.timeoutSeconds === "number" ? formatSeconds(node.timeoutSeconds) : String(node.timeoutSeconds)]);
        if (current?.deadline) rows.push(["Deadline at", workflowV2EventTime(current.deadline) ?? current.deadline]);
    }
    // A parallel step's own rows are its For each section (ParallelSections; owner batch 7, H2).
    if (node.parallel) rows.push(["Parallel step", String(node.parallel)]);
    if (current?.branch && Number.isSafeInteger(current.branch.index)) rows.push(["Branch", node.branchName ?? String(workflowV2BranchNumber(current.branch.index))]);
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
 * M24 "Inspect evidence"; owner batch 7, H2): how many succeeded, run and wait, which ones block a blocked join, and per
 * branch its current (or last) step, where it is, that step's deadline, its result or why it did not succeed, and its
 * agent chat when that step is an agent step. Branches are numbered from 1 for people; the data attributes keep the
 * index from 0.
 */
function BranchEvidence({ evidence, openSession = null }) {
    // A join of the first k (owner decision join-k-of-n) says how many it needs.
    const needs = evidence.needed !== undefined && evidence.needed !== evidence.total ? `needs ${evidence.needed}` : null;
    // Review 18:45Z: one word per idea, "k/n ok"; an item not started is waiting.
    const counts = [`${evidence.succeeded}/${evidence.total} ok`, needs, evidence.running ? `${evidence.running} running` : null,
        evidence.queued ? `${evidence.queued} waiting` : null].filter(Boolean).join(" · ");
    const noun = evidence.names ? "branches" : "items";
    return h("div", { className: "ps-workflow-evidence", "aria-label": evidence.names ? "Branches" : "Items" },
        h("h3", null, evidence.names ? "Branch results" : "Items"),
        h("p", { style: { margin: 0 } }, counts),
        evidence.blocked && evidence.blocking.length ? h("p", { role: "status", "data-blocking": evidence.blocking.join(","), style: { margin: 0, color: TONES.warning } },
            `Blocked by ${workflowV2ItemList(evidence.blocking, evidence.names)}`) : null,
        // Review NB-R7: named branches are "branches" here too, and the first column is "Branch".
        evidence.timedOut ? h("p", { role: "status", "data-timed-out": "true", style: { margin: 0, color: TONES.warning } },
            `The limit passed before the join: running ${noun} canceled; waiting ${noun} not started.`) : null,
        // J1b (Q1): successes saved before the time limit still join after it.
        evidence.joinedAfterLimit ? h("p", { role: "status", "data-joined-after-limit": "true", style: { margin: 0 } },
            `The limit passed after enough ${noun} succeeded: the join used them; running ${noun} canceled.`) : null,
        evidence.rows.length ? h("table", null,
            h("thead", null, h("tr", null, [evidence.names ? "Branch" : "#", "Node", "State", "Limit", "Result", "Chat"].map(label => h("th", { key: label }, label)))),
            h("tbody", null, evidence.rows.map(row => h("tr", { key: row.index, "data-branch": row.index, "data-status": row.status },
                h("td", null, row.name ?? String(workflowV2BranchNumber(row.index))), h("td", null, row.step ?? "—"), h("td", null, row.status),
                h("td", { title: row.deadline ? workflowTimeTitle(row.deadline) ?? undefined : undefined }, row.deadline ? workflowShortTime(row.deadline) ?? row.deadline : "—"),
                h("td", null, row.why ?? row.result ?? (row.outcome ? workflowV2OutcomeWord(row.outcome) : "—")),
                h("td", null, !row.agent ? "—" : openSession ? h("button", { type: "button", className: "ps-mini-button", "data-action": "open-branch-chat",
                    "data-session": row.agent, onClick: () => openSession(row.agent) }, "Open chat") : row.agent))))) : null);
}

/**
 * A parallel step's details (owner batch 7, H2): For each (where its items come from, never a literal list's values;
 * how many run at a time; the join rule in words), its own time limit when it has one (owner decision join-k-of-n: its
 * length, and when the shown visit's ends), its Branch steps (each selects that step) and its Branches. No hooks:
 * tests call it as a function.
 */
function ParallelSections({ selected, current, nodes, select, openSession }) {
    const property = (label, value, title = undefined) => h("div", { className: "ps-workflow-property", key: label },
        h("span", title ? { title } : null, label), h("strong", null, value));
    const steps = workflowV2BranchSteps(selected, nodes);
    // IR 11: named branches instead of a For each over a list.
    const named = Array.isArray(selected.namedBranches) ? selected.namedBranches : null;
    return h(React.Fragment, null,
        h("h3", null, named ? "Branches" : "For each"),
        named ? property("Branches", named.map(item => item.name).join(", ")) : property("Items", workflowV2ForEachText(selected.forEach)),
        property("At a time", String(selected.concurrency ?? 1)),
        property("Join", workflowV2JoinWords(selected)),
        // Review 21:15Z: a time limit reads "Limit" where it shows; "Time limit" is its tooltip.
        selected.timeoutSeconds !== undefined ? property("Limit", typeof selected.timeoutSeconds === "number"
            ? formatSeconds(selected.timeoutSeconds) : `From ${String(selected.timeoutSeconds)}`, "Time limit") : null,
        selected.timeoutSeconds !== undefined && current?.deadline
            ? property("Limit ends", workflowShortTime(current.deadline) ?? current.deadline, "When the time limit ends") : null,
        Number.isSafeInteger(current?.branches) && !named ? property("Items started", String(current.branches)) : null,
        steps.length ? h(React.Fragment, null,
            h("h3", null, named ? "Nodes of its branches" : "Nodes per item"),
            steps.map(id => h("button", { key: id, type: "button", className: "ps-workflow-transition", "data-branch-step": id,
                disabled: !nodes.some(node => node.id === id), onClick: () => select(id) },
            id, nodes.find(node => node.id === id)?.label ? ` · ${nodes.find(node => node.id === id).label}` : ""))) : null,
        selected.evidence ? h(BranchEvidence, { evidence: selected.evidence, openSession }) : null);
}

/**
 * Which branch a branch step's details show (owner batch 7, H2): a choice per branch that reached the step in the shown
 * visit of its parallel step; by default the first where it runs, else the one that ended last. `onBranch(index)` chooses.
 * Its label is "Branch" for a step of a named branch (IR 11; final review FUI-F3), "Item" for a For each's.
 */
function BranchPicker({ branches, chosen, onBranch = null, named = false }) {
    return h("label", { className: "ps-workflow-field ps-workflow-branch-picker" }, h("span", null, named ? "Branch" : "Item"),
        h("select", { className: "ps-workflow-input", value: String(chosen.index), "data-field": "branch", disabled: !onBranch,
            onChange: event => onBranch?.(Number(event.target.value)) },
        branches.choices.map(choice => h("option", { key: choice.index, value: String(choice.index) }, choice.label))));
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
        kind ? h(TextBox, { label: "Your note (optional)" },
            h("textarea", { className: "ps-workflow-input", value: note, rows: 3, "data-field": "ask-note", onChange: event => setNote(event.target.value) })) : null,
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
 * A Base instructions row (finding 8): their length and first words; opened, their whole text, read from the artifact
 * the runtime kept on the Workflow (`row.instructions`), or a plain line that only the summary was kept. A reader who is
 * not the Workflow's owner (`readInstructions` answers `{ ownerOnly: true }`; review SF-3) is told so, and nothing is read.
 * A text whose sha256 is not the recorded one (`{ changed: true }`; review SF-4) is not shown: the row says it changed.
 * r4 C04: an echo recorded whole (`row.inline`) is shown from the chat itself, to the owner only, with no file read.
 */
function BaseInstructions({ row, readInstructions, onInstructions, openBodies = false }) {
    // Review UI-11: the body (and the whole text) is mounted only while the row is open.
    const [open, setOpen] = React.useState(openBodies);
    const loaded = row.instructions && readInstructions ? readInstructions(row.instructions) : null;
    const inlineOwnerOnly = Boolean(row.inline) && Boolean(readInstructions?.({ inline: true })?.ownerOnly);
    return h("details", { className: "ps-wf-alog-base", ...(openBodies ? { open: true } : {}), onToggle: event => {
        const nowOpen = event.currentTarget.open;
        setOpen(nowOpen);
        if (nowOpen && row.instructions && onInstructions && !loaded?.text && !loaded?.ownerOnly) onInstructions(row.instructions);
    } },
    h("summary", null, row.text),
    !open ? null
        : row.inline ? (inlineOwnerOnly ? h("p", { className: "ps-wf-muted", "data-owner-only": "" }, WORKFLOW_BASE_INSTRUCTIONS_OWNER_ONLY)
            : h("pre", { "data-base-instructions": "inline" }, row.inline.text))
        : !row.instructions ? h("p", { className: "ps-wf-muted" }, "Only this summary was kept.")
        : loaded?.ownerOnly ? h("p", { className: "ps-wf-muted", "data-owner-only": "" }, WORKFLOW_BASE_INSTRUCTIONS_OWNER_ONLY)
        : loaded?.changed ? h("p", { role: "status", "data-changed": "" }, WORKFLOW_BASE_INSTRUCTIONS_CHANGED)
        : loaded?.error ? h("p", { role: "alert" }, `Could not read them: ${loaded.error}`)
            : loaded?.text ? h("pre", { "data-base-instructions": row.instructions.artifact }, loaded.text)
                : h("p", { className: "ps-wf-muted" }, loaded?.loading ? "Reading…" : "Open to read the whole text."));
}

/** A disclosure whose body is mounted only while it is open (review UI-11: a long Log keeps closed bodies out of the page). */
function LazyDetails({ summary, body, className = undefined, openBodies = false }) {
    const [open, setOpen] = React.useState(openBodies);
    return h("details", { className, ...(openBodies ? { open: true } : {}), onToggle: event => setOpen(event.currentTarget.open) },
        h("summary", null, summary), open ? body() : null);
}

/** A row's text with its chat's words as a link that opens that chat (r4 C04: the Workflow's line about the agent chat). */
function withChatLink(text, chat, onOpenChat) {
    const at = chat && onOpenChat && typeof text === "string" ? text.indexOf(chat.words) : -1;
    if (at < 0) return text;
    return [text.slice(0, at), h("button", { key: "chat", type: "button", className: "ps-link-button", "data-action": "open-agent-chat",
        "data-session": chat.sessionId, onClick: () => onOpenChat(chat.sessionId) }, chat.words), text.slice(at + chat.words.length)];
}

/** One row of an agent node's Log: its label and time, then its text (folded with Show more) or its call (to expand). */
function AgentLogRow({ row, readInstructions = null, onInstructions = null, openBodies = false, onOpenChat = null }) {
    const [open, setOpen] = React.useState(false);
    const body = row.label === "Base instructions" && row.carriedFrom !== undefined
        ? h("p", { className: "ps-wf-muted", "data-carried-from": row.carriedFrom ?? "" }, row.text)
        : row.label === "Base instructions" ? h(BaseInstructions, { row, readInstructions, onInstructions, openBodies })
        : row.detail !== undefined
        ? h(LazyDetails, { summary: row.text, body: () => h("pre", null, row.detail), openBodies })
        : h("div", { className: "ps-wf-alog-text" },
            h("p", null, open && row.more ? row.more : withChatLink(row.text, row.chat, onOpenChat)),
            row.more ? h("button", { type: "button", className: "ps-mini-button", "data-action": "fold", onClick: () => setOpen(!open) },
                open ? "Show less" : "Show more") : null);
    return h("li", { className: "ps-wf-alog-row", "data-kind": row.kind, "data-level": row.level ?? undefined },
        h("div", { className: "ps-wf-alog-head" }, h("span", { className: "ps-wf-alog-label" }, row.label), row.time ? h("time", null, row.time) : null),
        body);
}

/**
 * What the Log offers for a chat's older lines (workflowAgentLogOlder; review UI-D6): Load older; or the last read's
 * error, said, with Retry; or, at the history window's limit, that plain fact and no button.
 */
function OlderChat({ older, chatId, onOlderChat, olderChatLoading }) {
    if (!older) return null;
    const loading = Boolean(olderChatLoading?.has?.(chatId));
    const button = older.action && onOlderChat ? h("button", { type: "button", className: "ps-link-button", "data-action": "older-chat",
        disabled: loading, onClick: () => onOlderChat(chatId) }, loading ? "Loading…" : older.action === "retry" ? "Retry" : "Load older") : null;
    return h(React.Fragment, null,
        older.text ? h("span", { "data-older": older.action === "retry" ? "failed" : "limit", role: older.action === "retry" ? "alert" : undefined },
            `${older.text} `) : null,
        button);
}

/**
 * An agent node's Log (finding 8; workflowAgentNodeLog): what is not recorded, said once; then one group per visit,
 * newest first ("Visit 4 · 17:42:01" and where it ended), with its Prompt, Agent and Workflow rows in time order, told
 * apart by their label and the colour of their edge. `failed` names the chats that could not be read; `onMore` shows
 * older visits.
 */
export function WorkflowV2AgentLog({ log, failed = null, onMore = null, nodeId = null, readInstructions = null, onInstructions = null,
    onOlderChat = null, olderChatLoading = null, onOlderVisits = null, openBodies = false, onOpenChat = null }) {
    return h("div", { className: "ps-wf-alog", "aria-label": nodeId ? `Log of node ${nodeId}` : "Agent node log" },
        h("p", { className: "ps-wf-muted ps-wf-alog-note" }, log.note),
        log.groups.length ? null : h("p", { className: "ps-wf-muted" }, "Not reached"),
        log.groups.map(group => h("section", { key: group.visitId, className: "ps-wf-alog-visit", "data-visit": group.ordinal ?? undefined },
            h("h3", null, group.header, group.status ? h("span", { className: "ps-wf-alog-status" }, ` · ${group.status}`) : null),
            // OF-S2-7: the model this visit's chat used.
            group.model ? h("p", { className: "ps-wf-muted ps-wf-alog-model", "data-model": group.modelNow ? "now" : "used" },
                `${group.modelNow ? "Model now" : "Model"}: ${group.model}`) : null,
            group.loading ? h("p", { className: "ps-wf-muted" }, failed?.has?.(group.chatId) ? "Could not read the chat." : "Reading the chat…") : null,
            // Review UI-10: the start of this visit's chat is not loaded; it is not shown as complete.
            group.truncated ? h("p", { className: "ps-wf-muted", "data-truncated": "" }, "This visit's start is not loaded. ",
                h(OlderChat, { older: group.older, chatId: group.chatId, onOlderChat, olderChatLoading })) : null,
            group.rows.length ? h("ol", { className: "ps-wf-alog-rows" }, group.rows.map(row => h(AgentLogRow, { key: row.key, row, readInstructions,
                onInstructions, openBodies, onOpenChat }))) : null)),
        // Review UI-D5: a continued chat's loaded lines whose visit is not known yet, shown apart until their prompt is loaded.
        (log.earlier ?? []).map(part => h("section", { key: `earlier:${part.chatId}`, className: "ps-wf-alog-visit is-earlier", "data-earlier": "" },
            h("h3", null, part.header),
            h("p", { className: "ps-wf-muted" }, "Visit known once the earlier prompt is loaded. ",
                h(OlderChat, { older: part.older, chatId: part.chatId, onOlderChat, olderChatLoading })),
            h("ol", { className: "ps-wf-alog-rows" }, part.rows.map(row => h(AgentLogRow, { key: row.key, row, readInstructions, onInstructions, openBodies, onOpenChat }))))),
        log.more && onMore ? h("button", { type: "button", className: "ps-mini-button", "data-action": "older-visits", onClick: onMore }, "Show older visits") : null,
        !log.more && log.partial ? h("p", { className: "ps-wf-muted" }, "Older visits not loaded. ",
            onOlderVisits ? h("button", { type: "button", className: "ps-link-button", "data-action": "older-executions", onClick: onOlderVisits }, "Load older visits") : null)
            : null);
}

/**
 * A Workflow's Node panel (Workflow Simplified; owner feedback 2026-11-06, finding 7): one view, no tabs inside the tab.
 * What the node does in one sentence; Now and Runs in one line each; its last result as readable text (Read the whole
 * value when the preview was cut short); for an agent node how its chat works, what its agent is told (folded) and Open
 * the agent chat; a parallel node's For each and branches; and Next, one line per outcome in words, each selecting the
 * node it names, then what happens when it fails. Its visits, one by one, are in the Log. From the shared model
 * (workflowNodeSummary), as the TUI says it.
 */
export function WorkflowV2NodeSummary({ selected, nodes, select, openSession = null, runId = null, executionValues = null, onReadWholeValue = null,
    branchIndex = null, onBranch = null, onLog = null, sections = null }) {
    const branch = workflowV2BranchChoice(selected.branches, branchIndex);
    const current = branch ? branch.execution : selected.current ?? null;
    // Review UI-3: a chosen item shows its own result (its latest ended visit in that item), never another item's.
    const summary = workflowNodeSummary(selected, { execution: current, ...(branch ? { ended: branch.ended ?? null } : {}) });
    const fact = (label, value, extra = {}) => value ? h("div", { className: "ps-wf-fact", key: label, ...extra, title: extra.title ?? undefined },
        h("span", null, label), h("strong", null, value)) : null;
    const result = summary.result;
    const whole = result?.executionId && runId ? workflowV2WholeValue(workflowV2ExecutionValue(executionValues, runId, result.executionId)) : null;
    const canRead = Boolean(result?.truncated && onReadWholeValue && runId && result.executionId);
    const known = id => nodes.some(node => node.id === id);
    return h("div", { className: "ps-wf-summary" },
        summary.what ? h("p", { className: "ps-wf-what", "data-node-what": "true" }, summary.what) : null,
        branch ? h(BranchPicker, { branches: selected.branches, chosen: branch, onBranch, named: Boolean(selected.branchName) }) : null,
        h("div", { className: "ps-wf-facts" },
            fact("Now", summary.now, { "data-fact": "now" }),
            fact("Visits", summary.runs, { "data-fact": "runs", title: summary.runsTitle }),
            summary.agent ? fact("Chat", summary.agent.chatMode, { "data-fact": "chat" }) : null,
            summary.agent?.tools ? fact("Tools", summary.agent.tools, { "data-fact": "tools", title: summary.agent.toolsTitle }) : null,
            // OF-S2-7: the model it uses, chosen at start or from the chat.
            summary.agent?.model ? fact("Model", summary.agent.model, { "data-fact": "model" }) : null),
        result ? h("div", { className: `ps-wf-result${result.error ? " is-error" : ""}`, "data-fact": "result" },
            h("h3", null, result.label),
            h(CodeBlock, { text: result.text, language: "auto" }),
            result.truncated ? h("p", { className: "ps-wf-muted" }, result.summary ? "Summary." : "Start only.") : null,
            canRead ? h("button", { type: "button", className: "ps-mini-button", "data-action": "whole-value", "data-execution": result.executionId,
                disabled: whole?.kind === "loading", onClick: () => onReadWholeValue(result.executionId) },
            whole && whole.kind !== "loading" ? "Show all again" : "Show all") : null,
            whole ? h(WholeValue, { whole }) : null) : null,
        !result && summary.noResult ? h("p", { className: "ps-wf-muted", "data-fact": "no-result" }, summary.noResult) : null,
        summary.agent ? h("div", { className: "ps-wf-agent" },
            summary.agent.told ? h("details", { className: "ps-wf-told" }, h("summary", null, "Prompt"), h("pre", null, summary.agent.told))
                : summary.agent.toldWords ? h("p", { className: "ps-wf-muted" }, summary.agent.toldWords) : null,
            ...workflowV2AgentBindingRows(selected.binding).map(([label, value, title]) => fact(label, value, title ? { title } : {})),
            openSession && summary.agent.chatSessionId ? h("button", { type: "button", className: "ps-mini-button", "data-action": "open-agent-chat",
                "data-session": summary.agent.chatSessionId, onClick: () => openSession(summary.agent.chatSessionId) }, "Open chat") : null) : null,
        selected.kind === "parallel" ? h(ParallelSections, { selected, current, nodes, select, openSession }) : null,
        // OF-S2-8: the script and sample input and output (NodeCodeSections), before where it goes next.
        sections,
        summary.next.lines.length || summary.next.failure ? h("div", { className: "ps-wf-next", "aria-label": "Next" },
            h("h3", null, selected.kind === "parallel" ? "Next, after the join" : "Next"),
            summary.next.lines.map(line => h("button", { key: line.label, type: "button", className: "ps-workflow-transition", "data-route": line.label,
                "data-kind": line.kind, disabled: !known(line.target), onClick: () => select(line.target) }, line.text)),
            summary.next.failure ? h("p", { className: "ps-wf-muted", "data-route": "unrouted" }, summary.next.failure) : null) : null,
        onLog && selected.runs ? h("button", { type: "button", className: "ps-mini-button ps-wf-to-log", "data-action": "node-log", onClick: onLog },
            selected.runs === 1 ? "Show in Log" : `Show ${selected.runs} visits in Log`) : null);
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
    events = null, sessionsById = null, onAskParent = null, branchIndex = null, onBranch = null }) {
    const property = (label, value) => h("div", { className: "ps-workflow-property", key: label },
        h("span", null, label), h("strong", null, value));
    if (tab === "details") {
        // A branch step's details show one branch's visit, chosen by its picker (owner batch 7, H2; `branchIndex`, `onBranch`).
        const branch = workflowV2BranchChoice(selected.branches, branchIndex);
        const current = branch ? branch.execution : selected.current;
        const description = branch ? describeWorkflowV2Execution(selected, current) : selected.description;
        const outcomeWords = (outcome, resultKind) => (outcome ? `${outcome}${resultKind === "runtime_error" ? " · runtime error" : ""}` : "Not recorded");
        // With a branch chosen, Status and Last outcome are that branch's (review UI7-3); the step's own are "All branches".
        const chosen = branch?.status ? branch : null;
        return h(React.Fragment, null,
            property("Status", chosen ? chosen.status.stateLabel : selected.stateLabel),
            property(chosen ? "Visits, all branches" : "Visits", `${selected.runs}${selected.partial ? " in loaded history" : ""}`),
            property("Last outcome", chosen ? outcomeWords(chosen.lastOutcome?.outcome, chosen.lastOutcome?.resultKind) : outcomeWords(selected.outcome, selected.resultKind)),
            chosen ? property("All branches", selected.stateLabel) : null,
            // Why the latest visit ended (owner decision q14; mock M14 "Inspect cancellation").
            workflowV2VisitEnding(current) ? property("Why it ended", workflowV2VisitEnding(current).text) : null,
            branch ? h(BranchPicker, { branches: selected.branches, chosen: branch, onBranch, named: Boolean(selected.branchName) }) : null,
            kindProperties(selected, current).map(([label, value]) => property(label, value)),
            description.map((line, i) => h("p", { key: i }, line)),
            selected.type === "terminal" ? h("p", null, selected.summary || (selected.parallel ? "The branch ends at this step." : "The workflow ends at this step.")) : null,
            selected.kind === "parallel" ? h(ParallelSections, { selected, current, nodes, select, openSession }) : null,
            // A parallel step's routes leave from its join bar, once every branch has ended (H2).
            selected.next ? h("h3", null, selected.kind === "parallel" ? "Next steps from the join" : "Next steps") : null,
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
            // Asking the parent agent about this visit (owner decision q16).
            onAskParent && current?.id ? h(AskParent, { key: current.id, onAskParent, executionId: current.id }) : null);
    }
    // A branch step's Output and History follow the branch its details show (adversarial review R2-UI-5).
    const branchChoice = workflowV2BranchChoice(selected.branches, branchIndex);
    const placeOf = execution => (execution?.id ? selected.where?.[execution.id] ?? null : null);
    if (tab === "output") {
        const shown = workflowV2ShownExecution(selected, runId, selection, branchChoice);
        const result = shown.execution ? workflowV2ExecutionResult(shown.execution) : null;
        const place = placeOf(shown.execution);
        const visit = `${shown.execution && Number.isSafeInteger(shown.execution.ordinal) ? `visit ${shown.execution.ordinal}` : "this visit"}${place ? ` in ${place.label}` : ""}`;
        const branchWords = Number.isSafeInteger(shown.branchIndex) ? `branch ${workflowV2BranchNumber(shown.branchIndex)}` : null;
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
                : h("p", { "data-branch": shown.branchIndex ?? undefined }, branchWords
                    ? `Latest result of ${branchWords} in the loaded history for this step (the branch chosen in Details).`
                    : "Latest result in the loaded history for this step."),
            shown.chosen && onSelectExecution ? h("button", { type: "button", className: "ps-mini-button", "data-action": "latest-result",
                onClick: () => onSelectExecution(null) }, "Show the latest result") : null,
            shown.chosen && shown.missing ? h("pre", null, "Its result is not shown, and no other visit's result is shown in its place.") : null,
            !shown.chosen && !result && terminalValue === null ? h("pre", { "data-not-reached": selected.notReached && !branchWords ? "true" : undefined }, branchWords
                ? `This step has no result in ${branchWords} in the loaded history yet.`
                // Re-check RC-5: not reached yet in the parallel step's current visit; an earlier visit's result is not shown as its own.
                : selected.notReached ? workflowV2NotReachedText(selected.notReached) : "This step has no result in the loaded history.") : null,
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
    // A branch step lists the visits of the branch its details show; every loaded visit, of all branches, is below (R2-UI-5).
    const branchScope = branchChoice ? workflowV2VisitScope(branchChoice.execution) : null;
    const visits = branchScope ? selected.executions.filter(execution => workflowV2VisitScope(execution) === branchScope) : selected.executions;
    const rows = compactWorkflowV2Executions(visits);
    const shown = workflowV2ShownExecution(selected, runId, selection, branchChoice);
    const branched = Boolean(selected.where);
    // A row of one execution chooses exactly that execution's result; a row of combined repeats lists them one by one below.
    const choose = onSelectExecution ? (execution => h("button", { type: "button", className: "ps-mini-button", "data-action": "show-result",
        "data-execution": execution.id, "aria-pressed": shown.chosen && shown.executionId === execution.id,
        // Re-check RC-6: the choice keeps the parallel visit and the branch it was made in; a later change of either ends it.
        // Adversarial review R3-UI-3: only a branch chosen in Details is kept. The default branch is not a choice: it moves
        // as branches run and end, and that must not end a result chosen here (a Details change still clears it).
        onClick: () => {
            const picked = Number.isSafeInteger(branchIndex) && branchChoice?.index === branchIndex ? branchIndex : null;
            onSelectExecution(execution.id, typeof selected.parallel === "string"
                ? { parallelExecutionId: selected.parallelVisitId ?? null, branchIndex: picked } : undefined);
            onTab?.("output");
        } }, "Result")) : null;
    const table = items => h("table", null,
        h("thead", null, h("tr", null, [...(branched ? ["Branch"] : []), ...["Visit", "Result", "Outcome"], ...(choose ? [""] : [])]
            .map((label, i) => h("th", { key: i }, label)))),
        h("tbody", null, items.map(({ execution, count, from, to }, i) => h("tr", { key: execution.id || i, "data-branch": placeOf(execution)?.index ?? undefined },
            branched ? h("td", null, placeOf(execution)?.label.replace(/^item /, "") ?? "—") : null,
            h("td", null, count > 1 ? `${from}–${to} (×${count})` : String(execution.ordinal ?? "—")),
            h("td", null, resultLabel(execution)),
            h("td", null, execution.outcome || "—"),
            choose ? h("td", null, count === 1 && typeof execution.id === "string" ? choose(execution) : null) : null))));
    const all = selected.executions;
    return h(React.Fragment, null,
        h("p", null, branchChoice
            ? `Most recent visits of branch ${workflowV2BranchNumber(branchChoice.index)} (the branch chosen in Details) in the loaded history. Unchanged repeats are combined.`
            // Re-check RC-5: none of these visits is in the parallel step's current visit; each row says which it was in.
            : selected.notReached ? `Not reached yet in ${Number.isSafeInteger(selected.notReached.parallelVisit) ? `visit ${selected.notReached.parallelVisit}` : "the current visit"}`
                + ` of '${selected.notReached.parallelStateId}'. Its visits in earlier parallel visits, newest first. Unchanged repeats are combined.`
                : "Most recent visits in the loaded history. Unchanged repeats are combined."),
        rows.length ? table(rows) : h("p", null, "No visits in the loaded history."),
        all.length > rows.length ? h("details", null,
            h("summary", null, branchChoice ? `Every loaded visit, all branches (${all.length})` : `Every loaded visit (${all.length})`),
            table(all.map(execution => ({ execution, count: 1, from: execution.ordinal, to: execution.ordinal })))) : null,
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

/**
 * A native select: keyboard, type-ahead and screen reader behaviour come with it. Every value is a React text child.
 * Until a run exists there is nothing to pick, and the run's status already says "No run yet", so the picker is not
 * shown (batch 5, g-07); a run that is selected by its id stays shown, listed or not.
 */
export function WorkflowV2RunPicker({ controller, sessionId, workflowModel, selectedRunId, ownModelLoaded, error }) {
    // Test runs only while the server's test mode is on (Workflow Simplified, spec 16).
    const model = workflowV2RunPickerModel({ workflowModel, selectedRunId, ownModelLoaded, error, tests: workflowV2TestRunsShown(workflowModel) });
    const noteId = `wf-run-note-${React.useId().replace(/:/g, "")}`;
    if (model.runCount === 0 && model.selection === null && model.malformed === 0) return null;
    return h("div", { className: "ps-workflow-run-picker", style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0, maxWidth: "100%", fontSize: "0.75rem" } },
        h("select", { "aria-label": "Workflow run", className: "ps-workflow-input", "aria-describedby": model.notes.length ? noteId : undefined, value: model.value,
            "data-selection": model.selection ?? "live", title: model.options.find(option => option.value === model.value)?.title,
            style: { minWidth: 0, maxWidth: "26em", textOverflow: "ellipsis" },
            onChange: event => selectWorkflowV2Run(controller, sessionId, event.target.value) },
        model.options.map(option => h("option", { key: option.value === "" ? "live" : `run:${option.value}`, value: option.value, title: option.title, "data-kind": option.kind }, option.label))),
        model.notes.length ? h("span", { id: noteId, role: "status", "aria-live": "polite", style: { color: "var(--ps-muted)", overflowWrap: "anywhere" } },
            model.notes.map((note, i) => h("span", { key: i, "data-level": note.level, style: { marginRight: 6, color: TONES[note.level] || TONES.info } }, note.text))) : null);
}

/**
 * A test run's held calls (design 05;): what each reached, the
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
        : h(JsonBox, { label: kind === "error" ? "Error (JSON: { \"code\", \"message\", \"details\"? })" : "Value (JSON)",
            name: kind === "error" ? "The error" : "The value", object: kind === "error", value: valueText, onChange: setValueText, field: "answer" }),
    h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
        h("button", { type: "button", className: "ps-mini-button", "data-operation": "test_respond", disabled: !responder.respond || responder.busy,
            title: responder.reason ?? (responder.busy ? "Another command for this Workflow is being sent." : "Send this answer to the test run."),
            onClick: () => { send(); } }, responder.pending === "test_respond" ? "Sending…" : "Send answer"),
        parentSessionId ? h("button", { type: "button", className: "ps-mini-button", "data-action": "ask-parent",
            title: "Send this answer to the parent agent's chat as a suggestion; it answers the call with its own tools.",
            onClick: () => { askParent(); } }, "Send to the parent agent instead") : null,
        h("button", { type: "button", className: "ps-mini-button", onClick: close }, "Close")),
    error ? h("span", { role: "alert", style: { color: TONES.error } }, error) : null);
}

/**
 * A test run's virtual clock (design 05 timer simulation; mock M19; R08, R19, R26): how far it is from the
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
        "data-field": "seconds", className: "ps-workflow-input", style: { width: "7em" } }),
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
 * dialog), each as one update. Edit copies a listed variable into the form. An edit is sent at the revision it started
 * from (adversarial review R2-UI-1, workflowV2VariableEdit): when the workflow is read again at a newer revision, the
 * edit stays, the form says the variables changed since editing began, and Set and Remove wait until the person loads the
 * new values or keeps the edit to save it over them. Load takes only what it can read (re-check RC-1,
 * workflowV2VariableLoad): a removed variable's old value is cleared, and a list too long to read leaves the edit as it
 * was, behind. The server checks the revision (a changed map is refused and read again) and everything else.
 */
export function WorkflowV2Variables({ controller, sessionId, model, id }) {
    const [edit, change] = React.useReducer(workflowV2VariableEdit, WORKFLOW_V2_VARIABLE_EDIT_EMPTY);
    const [error, setError] = React.useState(null);
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    // The edit and run on screen now (re-check UI-RC2-6): an answer to an earlier update must not clear a newer edit or its
    // error, or touch the form of another run.
    const onScreen = React.useRef({ generation: edit.generation, runId: null });
    onScreen.current = { generation: edit.generation, runId: model?.runId ?? null };
    // A draft belongs to the run it was typed for: another run starts with an empty form.
    const runId = model?.runId ?? null;
    React.useEffect(() => { change({ type: "clear" }); setError(null); }, [runId]);
    if (!model) return null;
    const { key, value } = edit;
    const editState = workflowV2VariableEditState(edit, model.revision);
    // The shown list, so the form knows whether the name it edits is a listed variable (re-check RC-1).
    const shownList = { entries: model.entries, complete: model.complete, preview: model.preview, revision: model.revision };
    const setKey = text => change({ type: "type", field: "key", text, ...shownList });
    const setValue = text => change({ type: "type", field: "value", text, ...shownList });
    const send = async input => {
        // Re-check UI-RC2-6: the answer belongs to the edit sent (its generation) of the run it was sent for; typing on
        // meanwhile keeps the newer edit, and another run's form is not touched (the run's notice reports the update).
        const sent = edit.generation;
        const sentRun = model.runId;
        const result = await controller.sendWorkflowRunCommand(sessionId, { operation: "set_vars", runId: model.runId,
            expectedKvRevision: editState.expectedKvRevision, ...input });
        if (!result?.ok || !mounted.current || onScreen.current.runId !== sentRun) return;
        const unchanged = onScreen.current.generation === sent;
        change({ type: "saved", generation: sent });
        if (unchanged) setError(null);
    };
    const onSet = event => {
        event.preventDefault();
        if (editState.behind) return;
        const draft = workflowV2VariableDraft(key, value);
        setError(draft.ok ? null : draft.error);
        if (draft.ok) send({ set: draft.set });
    };
    const onRemove = () => {
        if (editState.behind) return;
        const removal = workflowV2VariableRemoval(key);
        setError(removal.ok ? null : removal.error);
        if (removal.ok) send({ delete: removal.delete });
    };
    const cell = { padding: "2px 8px 2px 0", verticalAlign: "top", overflowWrap: "anywhere" };
    return h("section", { id, className: "ps-workflow-variables ps-workflow-side-form", "aria-label": "Workflow variables", "data-run-id": model.runId },
    h("h3", { style: { margin: 0, fontSize: "0.8rem" } }, model.revision === null ? "Variables" : `Variables · revision ${model.revision}`),
    h("p", { style: { margin: 0, color: "var(--ps-muted)" } }, WORKFLOW_V2_VARIABLES_HELP_TEXT),
    model.note ? h("p", { role: "status", style: { margin: 0 } }, model.note) : null,
    model.preview ? h(CodeBlock, { text: model.preview, language: "auto", style: { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "8em", overflow: "auto" } }) : null,
    model.entries.length ? h("table", { style: { borderCollapse: "collapse", width: "100%" } },
        h("thead", null, h("tr", null, ["Name", "Value", ""].map((label, i) => h("th", { key: i, style: { ...cell, textAlign: "left" } }, label)))),
        h("tbody", null, model.entries.map(entry => h("tr", { key: entry.key, "data-key": entry.key },
            h("td", { style: cell }, entry.key),
            h("td", { style: cell }, h(CodeText, { text: entry.displayText })),
            h("td", { style: { ...cell, whiteSpace: "nowrap" } }, model.editable ? h("button", { type: "button", className: "ps-mini-button",
                "aria-label": `Edit ${entry.key}`, disabled: model.busy,
                onClick: () => { change({ type: "copy", key: entry.key, value: entry.valueText, revision: model.revision }); setError(null); } }, "Edit") : null))))) : null,
    model.editable
        ? h("form", { "aria-label": "Set or remove a variable", onSubmit: onSet,
            style: { display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 6 } },
        h(TextBox, { label: "Name" },
            h("input", { type: "text", className: "ps-workflow-input", value: key, maxLength: 128, onChange: event => setKey(event.target.value), "data-field": "name" })),
        h(JsonBox, { label: "Value", title: "JSON", name: "The value", object: false, value, onChange: setValue, field: "value", className: "is-grow" }),
        h("button", { type: "submit", className: "ps-mini-button", disabled: model.busy || Boolean(editState.behind), "data-operation": "set" },
            model.pending ? "Saving…" : "Set"),
        h("button", { type: "button", className: "ps-mini-button is-danger", disabled: model.busy || Boolean(editState.behind), "data-operation": "remove",
            onClick: onRemove }, "Remove"),
        editState.behind ? h("div", { role: "status", className: "ps-workflow-variables-behind", "data-base-revision": editState.behind.base,
            style: { flexBasis: "100%", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, color: TONES.warning } },
        h("span", { style: { flex: "1 1 16em", minWidth: 0 } }, `${editState.behind.text} Load the new values, or keep your edit and save it over them.`),
        h("button", { type: "button", className: "ps-mini-button", "data-operation": "reload",
            onClick: () => { change({ type: "reload", ...shownList }); setError(null); } }, "Load new values"),
        h("button", { type: "button", className: "ps-mini-button", "data-operation": "keep",
            onClick: () => { change({ type: "keep", ...shownList }); setError(null); } }, "Keep my edit")) : null,
        // What the last Load did when it could not simply load the value (re-check RC-1): removed, not set, or not loadable here.
        editState.notice ? h("span", { role: "status", className: "ps-workflow-variables-loaded", style: { flexBasis: "100%", color: TONES.warning } },
            editState.notice) : null,
        error ? h("span", { role: "alert", style: { flexBasis: "100%", color: TONES.error } }, error) : null)
        : h("p", { className: "ps-workflow-variables-readonly", style: { margin: 0, color: "var(--ps-muted)" } }, model.reason));
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
    const { inputs, onChange: setInputs, action: sampleAction } = useSampleInputs(model?.inputsSchema ?? null);
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
        if (result?.ok && mounted.current) controller.dispatch({ type: "ui/workflowView", sessionId, view: { sidePanel: null } });
    };
    const draft = model.state === "draft";
    const shownRevision = draft ? model.revision : model.publishedRevision;
    const shownHash = draft ? model.definitionHash : model.publishedDefinitionHash;
    const row = (label, value, extra = {}) => h("div", { className: "ps-workflow-property", key: label, ...extra }, h("span", null, label), h("strong", null, value));
    return h("section", { id, className: "ps-workflow-definition ps-workflow-side-form", "aria-label": draft ? "Publish review" : "Start the live run",
        "data-definition-state": model.state },
    h("h3", { style: { margin: 0, fontSize: "0.8rem" } }, draft ? "Publish review" : "Start the live run"),
    h(DefinitionSummary, { model, revisionLabel: draft ? "revision" : "published revision", revision: shownRevision, hash: shownHash,
        validity: draft ? (model.valid ? "valid" : `${model.errors || "unlisted"} error${model.errors === 1 ? "" : "s"}: it cannot be published`) : null }),
    row("Live effects", runs ? "Only when its live run starts" : "None until a live run starts"),
    // What publication pins for each named agent, and the tests of exactly this revision (information: no test is required).
    workflowV2PublicationEvidenceRows(model, versionsNow).map(([label, value], index) => row(label, value, { key: `evidence-${index}`, "data-evidence": label.trim() })),
    h("p", { className: "ps-workflow-side-note" }, draft
        ? "Publishing freezes this exact revision; it starts no run and grants no tool."
        : "Starting runs the published revision with real effects; a workflow has one live run."),
    runs ? h(JsonBox, { label: "Inputs (JSON object)", name: "Inputs", value: inputs, onChange: setInputs, field: "inputs", action: sampleAction }) : null,
    runs ? h(JsonBox, { label: "Initial variables (JSON object, optional)", name: "Initial variables", value: vars, onChange: setVars, field: "vars" }) : null,
    h("div", { className: "ps-workflow-panel-actions" },
        model.controls.map(control => h("button", { key: control.operation, type: "button", className: "ps-mini-button",
            "data-operation": control.operation, disabled: !control.enabled, title: control.title,
            onClick: () => { send(control.operation); } }, control.label)),
        h("button", { type: "button", className: "ps-mini-button",
            onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { sidePanel: null } }) }, "Close")),
    error ? h("span", { role: "alert", style: { color: TONES.error } }, error) : null);
}

/**
 * The draft's YAML editor (design 04 replace_definition; mocks M01 and M02; R03, R17, R26; INACTIVE: only a read model
 * that carries the draft's YAML for this caller has it). `model` is workflowV2DraftEditor's answer. An edit starts from
 * the revision shown and is saved at that revision, so a draft someone else changed meanwhile is refused, never
 * overwritten: the editor then says so and offers to load the new revision (discarding the edit) or to keep the edit on
 * it. Edits are kept across a refusal and a new read. The version (metadata.version) cannot change: a new version needs
 * a new workflow, and the server refuses it.
 *
 * Batch 6 (r-2): the editor is the YAML tab of a draft and fills it: one compact strip (the revision, Save, Discard,
 * whether there are unsaved changes, and `tools`, the button for the draft tools in the side pane), the answer to a save
 * (`notice`), then the YAML box at the tab's full height, scrolling inside, with its marks under it. An unsaved edit is
 * never lost when the editor goes (the Graph tab, another session): it is kept in the workflow's view state
 * (`draftEdit`, given back as `savedEdit`) and shown again when the editor comes back; nothing is kept once the edit is
 * saved or discarded. Whether there is one (`draftDirty`) tells the step-input editor not to save over it.
 */
export function WorkflowV2DraftEditor({ controller, sessionId, model: givenModel, id, savedEdit = null, notice = null, tools = null }) {
    // UI-1: the buffer belongs to one workflow session. A model read for another session is not taken (the editor waits for
    // its own), a kept edit of another session is not restored, and an edit of another session is never saved here.
    const model = givenModel && givenModel.sessionId === sessionId ? givenModel : null;
    const kept = savedEdit && savedEdit.sessionId === sessionId && typeof savedEdit.text === "string" && savedEdit.base
        && savedEdit.base.sessionId === sessionId && Number.isSafeInteger(savedEdit.base.revision) && typeof savedEdit.base.yaml === "string" ? savedEdit : null;
    const [base, setBase] = React.useState(() => kept ? kept.base : model ? { sessionId, revision: model.revision, yaml: model.yaml } : null);
    const [textValue, setTextValue] = React.useState(() => kept ? kept.text : model?.yaml ?? "");
    const latest = React.useRef({ base, textValue });
    latest.current = { base, textValue };
    // The edit as it is now, for a host that opens this workflow elsewhere (a Master of Agents panel; UI-2). No dispatch.
    React.useEffect(() => {
        if (!controller.workflowDraftBuffers) controller.workflowDraftBuffers = new Map();
        if (base && base.sessionId === sessionId) controller.workflowDraftBuffers.set(sessionId, { sessionId, base, text: textValue });
    });
    React.useEffect(() => () => { controller.workflowDraftBuffers?.delete(sessionId); }, [controller, sessionId]);
    React.useEffect(() => () => {
        const { base: was, textValue: text } = latest.current;
        const edit = was && was.sessionId === sessionId && text !== was.yaml ? { sessionId, base: was, text } : null;
        controller.dispatch({ type: "ui/workflowView", sessionId, view: { draftEdit: edit, draftDirty: Boolean(edit) } });
    }, [controller, sessionId]);
    const dirty = Boolean(base && textValue !== base.yaml);
    const told = React.useRef(Boolean(kept));
    React.useEffect(() => {
        if (told.current === dirty) return;
        told.current = dirty;
        controller.dispatch({ type: "ui/workflowView", sessionId, view: { draftDirty: dirty } });
    }, [controller, sessionId, dirty]);
    // The first model of this session, when the editor came up before it was read.
    React.useEffect(() => {
        if (model && !base) {
            setBase({ sessionId, revision: model.revision, yaml: model.yaml });
            setTextValue(model.yaml);
        }
    }, [model, base, sessionId]);
    // A new revision read while nothing was edited (or one that is exactly this edit, once saved) is taken as it is.
    React.useEffect(() => {
        if (!model || !base || model.revision === base.revision) return;
        if (textValue === base.yaml || textValue === model.yaml) {
            setBase({ sessionId, revision: model.revision, yaml: model.yaml });
            setTextValue(model.yaml);
        }
    }, [model?.revision, model?.yaml]);
    if (!model || !base || base.sessionId !== sessionId) return null;
    const edit = workflowV2DraftEdit(base, textValue, model);
    const save = () => {
        // Only this session's own edit, on this session's own model (UI-1).
        if (!edit.canSave || base.sessionId !== sessionId || model.sessionId !== sessionId) return;
        controller.sendWorkflowRunCommand(sessionId, { operation: "replace_definition", expectedRevision: base.revision, yaml: textValue });
    };
    // Plain words (spec draft 3; review UI-4): a definition and its revisions, saved; no draft or publish words.
    return h("section", { id, className: "ps-workflow-draft-editor", "aria-label": "YAML editor", "data-revision": base.revision },
    h("div", { className: "ps-workflow-yaml-strip" },
        h("h3", null, `Definition · editing revision ${base.revision}`),
        // Owner, 2026-11-06T13:43Z (F1): icons; each keeps its words as its name, and a refusal's reason is its tooltip.
        h(WorkflowToolButton, { label: model.pending ? "Saving…" : "Save", glyph: "save", "data-operation": "replace_definition", disabled: !edit.canSave,
            title: edit.reason ?? workflowTabButtonTip("save", { revision: base.revision }), onClick: save }),
        h(WorkflowToolButton, { label: "Discard edits", glyph: "discard", "data-action": "discard", disabled: !edit.changed,
            title: workflowTabButtonTip("discard"),
            // VR-6: a discarded edit is dropped from the view too, so nothing brings it back.
            onClick: () => {
                setTextValue(base.yaml);
                controller.dispatch({ type: "ui/workflowView", sessionId, view: { draftEdit: null, draftDirty: false } });
            } }),
        edit.changed && !edit.conflict ? h("span", { role: "status", className: "ps-workflow-yaml-unsaved" }, "Unsaved changes") : null,
        tools ? h("span", { className: "ps-workflow-yaml-strip-tools" }, tools) : null),
    h("p", { className: "ps-workflow-yaml-note" },
        `Saving makes a new revision; it never overwrites one someone else saved meanwhile.${model.semver ? ` The version stays ${model.semver}: a new version needs a new workflow.` : ""}`),
    notice,
    edit.conflict ? h("div", { role: "alert", "data-conflict": "true", style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, color: TONES.warning } },
        h("span", { style: { flex: "1 1 20em" } }, edit.reason),
        h("button", { type: "button", className: "ps-mini-button", "data-action": "load",
            onClick: () => { setBase({ sessionId, revision: model.revision, yaml: model.yaml }); setTextValue(model.yaml); } }, `Load revision ${model.revision}`),
        h("button", { type: "button", className: "ps-mini-button", "data-action": "keep",
            onClick: () => setBase({ sessionId, revision: model.revision, yaml: model.yaml }) }, `Keep my edits on revision ${model.revision}`)) : null,
    h(WorkflowV2YamlBox, { value: textValue, onChange: setTextValue,
        // The saved revision's errors, on their lines, while the edit is of that revision (owner decision q5).
        marks: !edit.conflict && model.current ? workflowV2DraftMarks(model.diagnostics) : { lines: [], unplaced: 0 }, changed: edit.changed }));
}

/**
 * The draft's tools, in the side pane (batch 6, r-3; opened from the YAML tab's strip): compare two saved versions (owner
 * decision q4) and change an agent step's inputs without writing YAML (q6). `unsaved` says the YAML tab holds edits not
 * saved yet, which the step-input editor never saves over.
 */
export function WorkflowV2DraftTools({ controller, sessionId, model, revisionReads = null, agentSteps = [], stepInput = null, stepInputPreview = null, unsaved = false }) {
    const [comparing, setComparing] = React.useState(false);
    if (!model) return null;
    return h("section", { className: "ps-workflow-draft-tools", "aria-label": "YAML tools", "data-revision": model.revision },
    h("div", { className: "ps-workflow-panel-actions" },
        h("button", { type: "button", className: "ps-mini-button", "data-action": "compare", "aria-expanded": comparing,
            disabled: model.revision < 2, title: model.revision < 2 ? "There is only one version so far." : "Compare two saved versions of this draft.",
            onClick: () => setComparing(open => !open) }, "Compare versions"),
        unsaved ? h("span", { role: "status", className: "ps-workflow-yaml-unsaved" }, "The YAML tab has unsaved changes.") : null),
    comparing && model.revision >= 2 ? h(WorkflowV2RevisionCompare, { controller, sessionId, latest: model.revision, reads: revisionReads }) : null,
    agentSteps.length ? h(WorkflowV2StepInputEditor, { controller, sessionId, steps: agentSteps, loaded: stepInput, preview: stepInputPreview,
        draftRevision: model.revision, draftYaml: model.yaml, busy: model.busy, unsaved }) : null);
}

/**
 * A revision's YAML, read-only (batch 6, r-2): the YAML tab of a workflow whose YAML this person cannot edit (a published
 * definition, or a draft the person may not change). `model` is the workflow's read model. The revision shown is the
 * published one, or a draft's current one; its YAML comes from the revision read (controller.loadWorkflowDefinitionRevision,
 * `reads` the view's `definitionRevisions`), which the server gives only to a person who may change the workflow;
 * anyone else is told so, and nothing is read for them.
 */
export function WorkflowV2YamlView({ controller, sessionId, model, reads = null }) {
    const definition = model && typeof model.definition === "object" ? model.definition : null;
    const published = definition?.state === "published";
    const revision = published ? definition.publishedRevision : definition?.currentRevision;
    const known = Number.isSafeInteger(revision) && revision >= 1;
    const denied = model?.personCommands?.viewer?.allowed === false;
    React.useEffect(() => {
        if (known && !denied) controller.loadWorkflowDefinitionRevision?.(sessionId, revision)?.catch?.(() => {});
    }, [controller, sessionId, revision, known, denied]);
    const entry = known && reads && typeof reads === "object" ? reads[revision] : null;
    const value = entry?.value?.definitionRevision ?? null;
    const yamlText = value && typeof value.yaml === "string" ? value.yaml : null;
    // Words (03, 17): no draft or published; the revision and what a person can do.
    const note = !known ? "There is no revision to show yet."
        : published ? `Revision ${revision} · read-only. To change it, ask the chat.`
            : `Revision ${revision} · read-only: you cannot change this definition.`;
    return h("section", { className: "ps-workflow-yaml-view", "aria-label": "Workflow YAML", "data-revision": known ? revision : undefined },
    h("p", { className: "ps-workflow-yaml-note" }, note),
    !known ? null
        : denied ? h("p", { role: "status", className: "ps-workflow-yaml-note" }, "The YAML is shown to people who can change this workflow.")
            : entry?.phase === "failed" ? h("p", { role: "alert", style: { margin: 0, color: TONES.error } }, `The YAML could not be read: ${entry.error ?? "no reason given"} `,
                h("button", { type: "button", className: "ps-mini-button",
                    onClick: () => { controller.loadWorkflowDefinitionRevision?.(sessionId, revision)?.catch?.(() => {}); } }, "Retry"))
                : yamlText === null ? h("p", { role: "status", className: "ps-workflow-yaml-note" }, `Reading revision ${revision}…`)
                    : h(WorkflowV2YamlBox, { value: yamlText, readOnly: true, marks: { lines: [], unplaced: 0 }, changed: false }));
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
    const [edit, setEdit] = React.useState(() => workflowV2StepInputEditorState(null,
        { step: steps[0], value: loaded?.state === steps[0] && loaded.phase === "loaded" ? loaded.value : null }));
    const rows = edit.rows;
    const waiting = edit.waiting;
    const [error, setError] = React.useState(null);
    const [newField, setNewField] = React.useState("");
    const listId = React.useId();
    const chosen = steps.includes(state) ? state : steps[0];
    React.useEffect(() => { controller.loadWorkflowStepInput?.(sessionId, chosen)?.catch?.(() => {}); }, [controller, sessionId, chosen, draftRevision]);
    const mine = loaded && loaded.state === chosen ? loaded : null;
    const value = mine?.phase === "loaded" ? mine.value : null;
    // UI-4: the person's changed fields of a step are kept while its inputs are read again (loading, a failed read) and
    // when a newer reading arrives, which then waits until they choose to load it (workflowV2StepInputEditorState).
    React.useEffect(() => { setEdit(current => workflowV2StepInputEditorState(current, { step: chosen, value })); }, [value, chosen]);
    // A reading taken as it is clears the last refusal shown.
    React.useEffect(() => { if (!edit.dirty) setError(null); }, [edit.reading, edit.step]);
    const loadWaiting = () => {
        setEdit(current => workflowV2StepInputLoadWaiting(current));
        controller.forgetWorkflowStepInputPreview?.(sessionId);
    };
    // Any change to the fields drops the prepared change (and one still being prepared): it no longer says what is shown.
    const changeRows = update => { setEdit(current => workflowV2StepInputEdited(current, update)); controller.forgetWorkflowStepInputPreview?.(sessionId); };
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
    const saveTitle = unsaved ? "Save or discard your YAML edits first." : stale ? "The draft changed since this was prepared; show the change again."
        : busy ? "Another command for this Workflow is being sent." : shown?.value?.changed === true ? `Save as a new revision after revision ${draftRevision}.`
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
        h("select", { className: "ps-workflow-input", value: chosen, "data-field": "step", onChange: event => setState(event.target.value) },
            steps.map(step => h("option", { key: step, value: step }, step)))),
    mine?.phase === "loading" ? h("p", { role: "status", style: { margin: 0 } }, "Reading the step's inputs…") : null,
    waiting ? h("p", { role: "status", "data-step-input-waiting": "true", style: { margin: 0, color: TONES.warning } },
        "The draft changed since you began; your field changes are kept. ",
        h("button", { type: "button", className: "ps-mini-button", onClick: loadWaiting }, "Load the new inputs")) : null,
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
            h("td", null, h("select", { className: "ps-workflow-input", value: row.source, "aria-label": `Where ${row.name} comes from`,
                onChange: event => setRow(index, { source: event.target.value,
                    detail: event.target.value === "keep" ? row.keepText ?? "" : event.target.value === row.source ? row.detail : "" }) },
            Object.entries(WORKFLOW_V2_STEP_INPUT_SOURCE_LABELS).filter(([source]) => source !== "keep" || row.keepable)
                .map(([source, label]) => h("option", { key: source, value: source }, label)))),
            h("td", null, row.source === "none" ? null : row.source === "keep"
                ? h("code", null, row.detail)
                : h("input", { type: "text", className: "ps-workflow-input", value: row.detail, placeholder: placeholder(row.source), "aria-label": `${row.name}: ${placeholder(row.source)}`,
                    list: row.source === "run_input" && runInputs.length ? listId : undefined, onChange: event => setRow(index, { detail: event.target.value }) })))))) : null,
    value ? h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 } },
        h("input", { type: "text", className: "ps-workflow-input", value: newField, placeholder: "new field name", "aria-label": "New field name", "data-field": "new-field",
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
    React.useEffect(() => {
        controller.loadWorkflowDefinitionRevision?.(sessionId, from)?.catch?.(() => {});
        controller.loadWorkflowDefinitionRevision?.(sessionId, to)?.catch?.(() => {});
    }, [controller, sessionId, from, to]);
    const compared = workflowV2RevisionCompare(reads, from, to);
    const options = Array.from({ length: latest }, (_, index) => index + 1);
    const pick = (label, value, onChange, field) => h("label", { style: { display: "inline-flex", alignItems: "center", gap: 4 } }, label,
        h("select", { className: "ps-workflow-input", value, "data-field": field, onChange: event => onChange(Number(event.target.value)) },
            options.map(revision => h("option", { key: revision, value: revision }, `Revision ${revision}${revision === latest ? " (latest)" : ""}`))));
    return h(CompareView, { label: "Compare versions", from, to, compared, pickers: [pick("From", from, setFrom, "compare-from"), pick("To", to, setTo, "compare-to")],
        unparsed: " A revision that does not parse is shown as saved." });
}

/**
 * Owner, 2026-11-07T00:03Z: compare two versions of a definition. In stage 1 each version is its own workflow child, so
 * each side is its newest child's current revision, read once as a revision is (controller.loadWorkflowDefinitionRevision);
 * reading changes nothing. `versions`: [{ key, version, label, sessionId, revision, read }] (highest first; review UI3-F9:
 * one per definition of a version; `read` the child's `definitionRevisions` entry); `chosen`: the key of the entry the
 * Definition view shows, the default "To". The default "From" is the next entry below it (or the one above, for the lowest).
 * Review UI3-F5: a side whose entry is no longer listed (its child deleted) is replaced by the default for that side, so the
 * pickers and the comparison always name sides that exist.
 */
export function WorkflowV2VersionCompare({ controller, versions, chosen }) {
    const list = Array.isArray(versions) ? versions.filter(item => item && typeof item.key === "string" && item.sessionId) : [];
    const [choice, setChoice] = React.useState({ from: null, to: null });
    const { from, to } = workflowVersionCompareSides(list.map(item => item.key), chosen, choice);
    const setFrom = key => setChoice(current => ({ ...current, from: key }));
    const setTo = key => setChoice(current => ({ ...current, to: key }));
    const side = key => list.find(item => item.key === key) ?? null;
    const before = side(from), after = side(to);
    React.useEffect(() => {
        for (const item of [before, after]) {
            if (item && Number.isSafeInteger(item.revision)) controller.loadWorkflowDefinitionRevision?.(item.sessionId, item.revision)?.catch?.(() => {});
        }
    }, [controller, before?.sessionId, before?.revision, after?.sessionId, after?.revision]);
    const compared = workflowV2VersionCompare({ version: before?.label ?? null, read: before?.read ?? null }, { version: after?.label ?? null, read: after?.read ?? null });
    const pick = (label, value, onChange, field) => h("label", { style: { display: "inline-flex", alignItems: "center", gap: 4 } }, label,
        h("select", { className: "ps-workflow-input", value: value ?? "", "data-field": field, onChange: event => onChange(event.target.value) },
            list.map(item => h("option", { key: item.key, value: item.key }, `Version ${item.label ?? item.version}`))));
    return h(CompareView, { label: "Compare two versions", from: before?.label ?? "", to: after?.label ?? "", compared, kind: "versions",
        pickers: [pick("From", from, setFrom, "compare-from-version"), pick("To", to, setTo, "compare-to-version")],
        unparsed: " A version that does not parse is shown as saved." });
}

/**
 * The comparison's pickers, its layout buttons, its summary and its diff (the Workspace pane's read-only diff view, or
 * until it has loaded, and wherever it cannot load, the same comparison as lines marked + and -).
 */
export function CompareView({ label, from, to, compared, pickers, unparsed, kind = null }) {
    const [layout, setLayout] = React.useState("split");
    const [viewer, setViewer] = React.useState("pending");
    const hostRef = React.useRef(null);
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
    return h("section", { className: "ps-workflow-compare", "aria-label": label, "data-from": from, "data-to": to, "data-compare": kind ?? undefined,
        style: { display: "grid", gap: 6 } },
    h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 } },
        ...pickers,
        h("button", { type: "button", className: "ps-mini-button", "aria-pressed": layout === "split", onClick: () => setLayout("split") }, "Side by side"),
        h("button", { type: "button", className: "ps-mini-button", "aria-pressed": layout === "inline", onClick: () => setLayout("inline") }, "One column")),
    h("p", { role: compared.failed ? "alert" : "status", style: { margin: 0, color: compared.failed ? TONES.error : "var(--ps-muted)" } }, compared.summary,
        compared.ready && !(compared.before.formatted && compared.after.formatted) ? unparsed : ""),
    // The diff view's own element (CodeMirror fills it; React renders nothing into it), shown once it is ready.
    compared.ready ? h("div", { ref: hostRef, className: "ps-workflow-compare-view",
        style: viewer === "ready" ? { maxHeight: "28em", overflow: "auto", border: "1px solid var(--ps-border)" } : { display: "none" } }) : null,
    compared.ready && viewer !== "ready" ? h("pre", { "data-diff": "lines", style: { margin: 0, padding: "4px 6px", maxHeight: "28em", overflow: "auto",
        border: "1px solid var(--ps-border)", fontFamily: "var(--ps-mono, monospace)", fontSize: "0.8rem" } },
    compared.diff.rows.map((row, index) => h("div", { key: index, "data-kind": row.kind,
        style: row.kind === "added" ? { color: TONES.success ?? "var(--ps-code-inserted)" } : row.kind === "removed" ? { color: TONES.error } : undefined },
    `${row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "} ${row.text}`))) : null);
}

/** A marked line's tooltip in the gutter: each of its diagnostics in words, its code and path after them. */
const markTip = mark => mark.texts.map((words, at) => (mark.codes?.[at] ? `${words} (${mark.codes[at]})` : words)).join("\n");

/**
 * The draft's YAML box with its errors marked inside it (owner decision q5): a line-number column beside the text, whose
 * marked lines show "●" in the error or warning colour with the messages as their title, and below the box one button
 * per marked line that moves the cursor to it and selects it. The box stays a plain text box (screen readers and every
 * test read it as one); it does not wrap lines, so each number stays beside its line. Marks are the saved revision's:
 * after an edit they stay on their line numbers until the next save checks the text. It fills the YAML tab (batch 6,
 * r-2) and scrolls inside; `readOnly` shows a revision that cannot be edited, in the same box.
 */
const useLayoutEffectOnClient = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

export function WorkflowV2YamlBox({ value, onChange = null, marks, changed, readOnly = false }) {
    const areaRef = React.useRef(null);
    const gutterRef = React.useRef(null);
    const paintRef = React.useRef(null);
    // OF-S2-8 (owner, 2026-11-07T23:13Z): the YAML is highlighted. The text people edit stays the plain textarea (caret,
    // selection, undo, IME, paste are the browser's); its letters turn transparent over a highlighted copy of the same text,
    // in the same font, padding and scroll position, once the parser has loaded. Until then it is the plain text, in place.
    const runs = useCodeRuns(value, "yaml");
    useLayoutEffectOnClient(() => {
        if (paintRef.current && areaRef.current) {
            paintRef.current.scrollTop = areaRef.current.scrollTop;
            paintRef.current.scrollLeft = areaRef.current.scrollLeft;
        }
    });
    const listId = `wf-yaml-marks-${React.useId().replace(/:/g, "")}`;
    const lineCount = value.split("\n").length;
    const byLine = new Map(marks.lines.map(mark => [mark.line, mark]));
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
    // The box's look (monospace, theme colours, focus ring) is the shared workflow edit-box style in index.css (of-07);
    // the gutter and the text inherit one font from the box, so each line number stays beside its line.
    return h(React.Fragment, null,
        h("div", { className: "ps-workflow-yaml" },
            h("div", { ref: gutterRef, className: "ps-workflow-yaml-gutter", "aria-hidden": "true",
                style: { overflow: "hidden", textAlign: "right", padding: "2px 6px", color: "var(--ps-muted)", userSelect: "none",
                    borderRight: "1px solid var(--ps-border)", minWidth: "3.5em" } },
            Array.from({ length: lineCount }, (_, index) => {
                const mark = byLine.get(index + 1);
                return h("div", { key: index, ...(mark ? { "data-mark": mark.severity, title: markTip(mark),
                    style: { color: mark.severity === "error" ? TONES.error : TONES.warning, fontWeight: 700 } } : {}) },
                mark ? `● ${index + 1}` : String(index + 1));
            })),
            h("div", { className: "ps-workflow-yaml-text" },
                runs ? h("pre", { ref: paintRef, className: "ps-workflow-yaml-paint", "aria-hidden": "true" },
                    h("code", null, codeChildren(value, runs)), "\n") : null,
                h("textarea", { ref: areaRef, value, rows: 16, wrap: "off", spellCheck: false, "aria-label": "Workflow YAML", "data-field": "yaml",
                    className: runs ? "is-painted" : undefined, "data-highlighted": runs ? "true" : undefined,
                    ...(marks.lines.length ? { "aria-describedby": listId } : {}),
                    ...(readOnly ? { readOnly: true } : { onChange: event => onChange(event.target.value) }),
                    onScroll: event => {
                        if (gutterRef.current) gutterRef.current.scrollTop = event.target.scrollTop;
                        if (paintRef.current) { paintRef.current.scrollTop = event.target.scrollTop; paintRef.current.scrollLeft = event.target.scrollLeft; }
                    },
                    style: { flex: 1, minWidth: 0, width: "100%", resize: "none", border: 0, padding: "2px 6px", whiteSpace: "pre", overflow: "auto" } }))),
        marks.lines.length ? h("ul", { id: listId, className: "ps-workflow-yaml-marks", "aria-label": "Errors marked in the YAML",
            style: { margin: 0, paddingLeft: 18, display: "grid", gap: 2 } },
        marks.lines.map(mark => h("li", { key: mark.line, "data-mark": mark.severity },
            h("button", { type: "button", className: "ps-mini-button", "data-line": mark.line, onClick: () => goTo(mark.line) }, `Line ${mark.line}`),
            // UXP-GEM-05: the words the diagnostics list says (the line is the button); the code and path in the tooltip.
            " ", h("span", { title: (mark.codes ?? []).filter(Boolean).join("\n") || undefined,
                style: { color: mark.severity === "error" ? TONES.error : TONES.warning } }, mark.texts.join("; "))))) : null,
        marks.lines.length && changed ? h("p", { style: { margin: 0, color: "var(--ps-muted)" } },
            "The marks are for the revision as saved; save to check your edits.") : null);
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
    const { inputs, onChange: setInputs, action: sampleAction } = useSampleInputs(model?.inputsSchema ?? null);
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
            controller.dispatch({ type: "ui/workflowView", sessionId, view: { sidePanel: null, ...(runId ? { selectedRunId: runId } : {}) } });
        }
    };
    const radio = (value, label) => h("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, marginRight: 12 } },
        h("input", { type: "radio", name: modeName, value, checked: agentMode === value, onChange: () => setAgentMode(value), "data-agent-mode": value }), label);
    return h("section", { id, className: "ps-workflow-test-review ps-workflow-side-form", "aria-label": "Test review", "data-revision": model.revision ?? undefined },
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
    h(JsonBox, { label: "Inputs (JSON object)", name: "Inputs", value: inputs, onChange: setInputs, field: "inputs", action: sampleAction }),
    h(JsonBox, { label: "Initial variables (JSON object, optional)", name: "Initial variables", value: vars, onChange: setVars, field: "vars" }),
    h(TextBox, { label: "Scenario name (optional)" },
        h("input", { type: "text", className: "ps-workflow-input", value: scenario, maxLength: 128, onChange: event => setScenario(event.target.value), "data-field": "scenario" })),
    h("div", { className: "ps-workflow-panel-actions" },
        h("button", { type: "button", className: "ps-mini-button", "data-operation": "test", disabled: !model.control.enabled, title: model.control.title,
            onClick: () => { start(); } }, model.control.label),
        h("button", { type: "button", className: "ps-mini-button",
            onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { sidePanel: null } }) }, "Close")),
    error ? h("span", { role: "alert", style: { color: TONES.error } }, error) : null);
}
