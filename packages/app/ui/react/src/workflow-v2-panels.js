import React from "react";
import {
    compactWorkflowV2Executions, formatSeconds, formatWorkflowValue, workflowV2AgentBindingRows, workflowV2AgentTask, workflowV2RouteKind,
} from "../../core/src/workflow-v2-view.js";
import { workflowV2RunPickerModel } from "../../core/src/workflow-v2-run-picker.js";
import {
    WORKFLOW_V2_TEST_NOTICE_TEXT, WORKFLOW_V2_TEST_REAL_AGENT_NOTICE_TEXT, workflowV2AdvanceDraft, workflowV2DraftEdit, workflowV2JsonObjectDraft,
    workflowV2ScenarioDraft, workflowV2TestAnswerTemplate, workflowV2TestResponseDraft, workflowV2VariableDraft, workflowV2VariableRemoval,
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
    if (node.kind === "agent") {
        // The workflow interface the state names and what the shown run pins it to (package revision, interface digest).
        rows.push(["Agent", workflowV2AgentTask(node)], ...workflowV2AgentBindingRows(node.binding), ["Outcomes", (node.outcomes || []).join(", ") || "—"]);
        if (node.timeoutSeconds !== undefined) rows.push(["Deadline", typeof node.timeoutSeconds === "number" ? formatSeconds(node.timeoutSeconds) : String(node.timeoutSeconds)]);
        if (current?.deadline) rows.push(["Deadline at", current.deadline]);
    }
    if (node.kind === "parallel") {
        rows.push(["Branches start at", String(node.body?.initial ?? "—")],
            ["Concurrency", node.concurrency === 1 ? "One branch at a time" : `Up to ${node.concurrency} branches at a time`],
            ["Join", `${node.join === "all_required" ? "Every branch must succeed" : String(node.join)}${node.failFast ? " · the first failure cancels the others" : ""}`]);
        if (Number.isSafeInteger(current?.branches)) rows.push(["Branches", String(current.branches)]);
    }
    if (node.parallel) rows.push(["Parallel state", String(node.parallel)]);
    if (current?.branch && Number.isSafeInteger(current.branch.index)) rows.push(["Branch", String(current.branch.index)]);
    return rows;
}

/**
 * An agent state's child session (design 03, R23): a click opens its actual chat, which people read but cannot
 * write to. Nothing is opened when the child has not been created yet.
 */
function AgentChild({ agent, openSession }) {
    if (!agent?.childSessionId) return null;
    return h("div", { className: "ps-workflow-agent-child" },
        h("h3", null, "Agent session"),
        h("div", { className: "ps-workflow-property" }, h("span", null, "Child session"), h("strong", null, agent.childSessionId)),
        h("div", { className: "ps-workflow-property" }, h("span", null, "Lifecycle"),
            h("strong", null, `${agent.spawned ? "Created" : "Not created yet"}${agent.end ? ` · ended (${agent.end})` : ""}`)),
        openSession && agent.spawned ? h("button", { type: "button", className: "ps-workflow-transition",
            onClick: () => openSession(agent.childSessionId) }, "Open the agent's chat (read-only)") : null,
        h("p", null, "People can read this chat. Only the workflow's parent agent can message it, and only the agent's typed result completes the state."));
}

/** The tab panel body of a v2 node. The caller owns the tab strip so its tab semantics are unchanged. */
export function WorkflowV2NodeContent({ tab, selected, nodes, select, runOutput, runError, openSession = null }) {
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
            current?.agent ? h(AgentChild, { agent: current.agent, openSession }) : null,
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
 * A test run's intercepted effects (design 05; INACTIVE outside controller 1.9.0's tests): what each reached, the
 * schema its answer must match and its answer. The parent answers through its own tools; a person may answer one that
 * waits only when `responder` (workflowV2TestResponder's answer) says so: its Answer button opens the answer form for it.
 * The notice that scripts run normally stays in the banners above.
 */
export function WorkflowV2TestInterceptions({ test, controller = null, sessionId = null, responder = null, answering = null }) {
    const items = Array.isArray(test?.interceptions) ? test.interceptions : [];
    if (!items.length) return null;
    const answerable = Boolean(controller && responder?.respond);
    const waits = id => answerable && responder.waiting.some(item => item.interceptionId === id);
    return h("section", { className: "ps-workflow-test", "aria-label": "Test interceptions", style: { padding: "6px 10px", fontSize: "0.75rem" } },
        h("h3", null, `Intercepted effects (${items.length})`),
        h("table", null,
            h("thead", null, h("tr", null, [...["Effect", "State", "Answer"], ...(answerable ? [""] : [])].map((label, i) => h("th", { key: i }, label)))),
            h("tbody", null, items.map((item, i) => h("tr", { key: item.interceptionId || i, "data-interception": item.interceptionId },
                h("td", { title: item.interceptionId }, item.tool ? `${item.operation} · ${item.tool}` : String(item.operation)),
                h("td", null, item.stateId || "—"),
                h("td", null, item.response ? `${item.response.kind} · ${item.response.disposition}` : "Waiting for the parent"),
                answerable ? h("td", null, waits(item.interceptionId) ? h("button", { type: "button", className: "ps-mini-button", "data-action": "answer",
                    disabled: responder.busy, "aria-pressed": answering === item.interceptionId,
                    onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { answeringInterceptionId: item.interceptionId } }) },
                "Answer") : null) : null)))));
}

/**
 * A person's answer to one intercepted effect of a test run (design 05 test_respond; mock M18; R19, R20, R26;
 * INACTIVE). It shows what the effect reached (its arguments) and what the answer must match, then sends the answer the
 * person chose: success with a JSON value, error with { code, message, details? }, or cancel. The JSON is checked here;
 * the server checks it against the effect's contract and says which fields it refuses, and the same answer sent again is
 * the same answer. Once it is accepted the form closes.
 */
export function WorkflowV2TestAnswer({ controller, sessionId, responder, interceptionId }) {
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
    const radio = (value, label) => h("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, marginRight: 12 } },
        h("input", { type: "radio", name: kindName, value, checked: kind === value, onChange: () => setKind(value), "data-answer-kind": value }), label);
    const what = `${waiting.operation}${waiting.tool ? ` · ${waiting.tool}` : ""}${waiting.stateId ? ` in '${waiting.stateId}'` : ""}`;
    return h("section", { className: "ps-workflow-test-answer", "aria-label": "Answer an intercepted effect", "data-interception": interceptionId,
        style: { display: "grid", gap: 6, padding: "6px 12px", fontSize: "0.75rem", borderBottom: "1px solid var(--ps-border)" } },
    h("h3", { style: { margin: 0, fontSize: "0.8rem" } }, `Answer ${what}`),
    h("div", { className: "ps-workflow-property" }, h("span", null, "Interception"), h("strong", null, h("code", null, interceptionId))),
    waiting.arguments !== null ? h(Value, { value: waiting.arguments, label: "What it reached" }) : null,
    waiting.responseSchema !== null ? h(Value, { value: waiting.responseSchema, label: "The answer must match" }) : null,
    h("fieldset", { style: { margin: 0, padding: "4px 8px", border: "1px solid var(--ps-border)" } },
        h("legend", null, "Answer"), radio("success", "Success"), radio("error", "Error"), radio("cancel", "Cancel")),
    kind === "cancel" ? h("p", { style: { margin: 0, color: "var(--ps-muted)" } }, "The effect ends as cancelled; a cancel has no value.")
        : h("label", { style: { display: "grid", gap: 2 } }, kind === "error" ? "Error (JSON: { \"code\", \"message\", \"details\"? })" : "Value (JSON)",
            h("textarea", { value: valueText, rows: 4, onChange: event => setValueText(event.target.value), "data-field": "answer",
                style: { fontFamily: "var(--ps-font-mono, monospace)", width: "100%" } })),
    h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
        h("button", { type: "button", className: "ps-mini-button", "data-operation": "test_respond", disabled: !responder.respond || responder.busy,
            title: responder.reason ?? (responder.busy ? "Another command for this workflow is being sent." : "Send this answer to the test run."),
            onClick: () => { send(); } }, responder.pending === "test_respond" ? "Sending…" : "Send answer"),
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
    model.controls.map(control => h("button", { key: control.operation, type: "button",
        className: `ps-mini-button${control.danger ? " is-danger" : ""}`, "data-operation": control.operation,
        disabled: !control.enabled, title: control.title,
        onClick: () => { controller.sendWorkflowRunCommand(sessionId, { operation: control.operation, runId: model.runId }); } }, control.label)),
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
    h("p", { style: { margin: 0, color: "var(--ps-muted)" } },
        "An open map: a new name needs no declaration. A state reads the variables as they are when it starts; work already running keeps the values it started with. They cannot change the published definition, permissions, join receipts or request winners."),
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
    return h("button", { type: "button", className: "ps-mini-button", "aria-expanded": Boolean(open), "aria-controls": open ? controls : undefined,
        onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { variablesOpen: !open } }) }, "Variables");
}

/** The header button that opens and closes the publication panel (the view's `definitionOpen`): "Publish…" for a draft, "Start…" otherwise. */
export function WorkflowV2DefinitionToggle({ controller, sessionId, model, open, controls }) {
    if (!model?.controls?.length) return null;
    return h("button", { type: "button", className: "ps-mini-button", "aria-expanded": Boolean(open), "aria-controls": open ? controls : undefined,
        "data-definition-state": model.state,
        onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { definitionOpen: !open } }) },
    model.state === "draft" ? "Publish…" : "Start…");
}

/**
 * Publication review (design 04; mocks M01 and M03; R17, R18, R26; INACTIVE: only a read model that says which commands
 * the workflow takes from people has it). `model` is workflowV2DefinitionControls' answer. It shows exactly what is
 * published or started (the definition, the revision and its full definition hash), then sends the command for that
 * revision and hash: Publish only, Publish and start (with the run's inputs and optional initial variables, as JSON
 * objects), or Start live run for a published definition. A revision that changed meanwhile is refused by the server and
 * the workflow is read again; what the person typed stays. Publishing and starting are separate, explicit choices.
 */
export function WorkflowV2DefinitionPanel({ controller, sessionId, model, id }) {
    const [inputs, setInputs] = React.useState("{}");
    const [vars, setVars] = React.useState("");
    const [error, setError] = React.useState(null);
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
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
    row("Definition", [model.name, model.semver].filter(Boolean).join(" ") || "Not named"),
    row(draft ? "Revision" : "Published revision", shownRevision === null ? "Not known" : String(shownRevision)),
    row("Definition hash", h("code", { style: { overflowWrap: "anywhere" }, "data-field": "definition-hash" }, shownHash ?? "Not known")),
    draft ? row("Validity", model.valid ? "Valid" : `${model.errors || "Unlisted"} error${model.errors === 1 ? "" : "s"}: it cannot be published`) : null,
    row("Live effects", runs ? "Only when its live run starts" : "None until a live run starts"),
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
    return h("button", { type: "button", className: "ps-mini-button", "aria-expanded": Boolean(open), "aria-controls": open ? controls : undefined,
        onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { draftOpen: !open } }) }, "Edit draft");
}

/**
 * The draft's YAML editor (design 04 replace_definition; mocks M01 and M02; R03, R17, R26; INACTIVE: only a read model
 * that carries the draft's YAML for this caller has it). `model` is workflowV2DraftEditor's answer. An edit starts from
 * the revision shown and is saved at that revision, so a draft someone else changed meanwhile is refused, never
 * overwritten: the editor then says so and offers to load the new revision (discarding the edit) or to keep the edit on
 * it. Edits are kept across a refusal and a new read. The version (metadata.version) cannot change: a new version needs
 * a new workflow, and the server refuses it.
 */
export function WorkflowV2DraftEditor({ controller, sessionId, model, id }) {
    const [base, setBase] = React.useState(() => model ? { revision: model.revision, yaml: model.yaml } : null);
    const [textValue, setTextValue] = React.useState(() => model?.yaml ?? "");
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
    h("textarea", { value: textValue, rows: 16, spellCheck: false, "aria-label": "Workflow YAML", "data-field": "yaml",
        onChange: event => setTextValue(event.target.value),
        style: { fontFamily: "var(--ps-font-mono, monospace)", width: "100%", resize: "vertical" } }),
    h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 } },
        h("button", { type: "button", className: "ps-mini-button", "data-operation": "replace_definition", disabled: !edit.canSave,
            title: edit.reason ?? `Save as a new revision after revision ${base.revision}.`, onClick: save }, model.pending ? "Saving…" : "Save draft"),
        h("button", { type: "button", className: "ps-mini-button", "data-action": "discard", disabled: !edit.changed,
            onClick: () => setTextValue(base.yaml) }, "Discard edits"),
        h("button", { type: "button", className: "ps-mini-button",
            onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { draftOpen: false } }) }, "Close"),
        edit.changed && !edit.conflict ? h("span", { role: "status", style: { color: "var(--ps-muted)" } }, "Unsaved changes") : null));
}

/** The header button that opens and closes the test review (the view's `testOpen`). */
export function WorkflowV2TestToggle({ controller, sessionId, model, open, controls }) {
    if (!model) return null;
    return h("button", { type: "button", className: "ps-mini-button", "aria-expanded": Boolean(open), "aria-controls": open ? controls : undefined,
        onClick: () => controller.dispatch({ type: "ui/workflowView", sessionId, view: { testOpen: !open } }) }, "Test…");
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
    const row = (label, value) => h("div", { className: "ps-workflow-property" }, h("span", null, label), h("strong", null, value));
    const radio = (value, label) => h("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, marginRight: 12 } },
        h("input", { type: "radio", name: modeName, value, checked: agentMode === value, onChange: () => setAgentMode(value), "data-agent-mode": value }), label);
    return h("section", { id, className: "ps-workflow-test-review", "aria-label": "Test review", "data-revision": model.revision ?? undefined,
        style: { display: "grid", gap: 6, padding: "6px 12px", fontSize: "0.75rem", borderBottom: "1px solid var(--ps-border)" } },
    h("h3", { style: { margin: 0, fontSize: "0.8rem" } }, "Test review · not a sandbox"),
    h("p", { role: "note", style: { margin: 0, color: TONES.warning } }, WORKFLOW_V2_TEST_NOTICE_TEXT),
    row("Definition", [model.name, model.semver].filter(Boolean).join(" ") || "Not named"),
    row(model.state === "draft" ? "Draft revision" : "Revision", model.revision === null ? "Not known" : String(model.revision)),
    row("Definition hash", h("code", { style: { overflowWrap: "anywhere" }, "data-field": "definition-hash" }, model.definitionHash ?? "Not known")),
    row("Validity", model.valid ? "Valid" : `${model.errors || "Unlisted"} error${model.errors === 1 ? "" : "s"}: it cannot be tested`),
    h("fieldset", { style: { margin: 0, padding: "4px 8px", border: "1px solid var(--ps-border)" } },
        h("legend", null, "Agent states"),
        radio("mocked", "Mocked: the parent answers each agent state"),
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
