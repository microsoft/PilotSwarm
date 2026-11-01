import React from "react";
import {
    compactWorkflowV2Executions, formatSeconds, formatWorkflowValue, workflowV2RouteKind,
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
