/**
 * The Node panel's visit (owner 2026-11-20: "For node details in a running graph when I click on node details I want to
 * see the inputs and outputs for that iteration. These need to change as I time travel back and forth too."): which visit
 * it is and when it ran, then its Input and its Output (or its error), each as formatted JSON in a code box; a Decision's
 * output is its semantic result in words. A preview that was cut short says so, and Show all reads the visit's whole
 * input and output (one read: readWorkflow with its execution id). While the timeline shows a moment before the visit
 * ended, its output is still shown, labelled with when it was recorded. The words are the shared model's
 * (workflowVisitIo), as the TUI says them. Every value is a React text child.
 */
import React from "react";
import { workflowExecutionValue, workflowWholeValue } from "../../core/src/workflow-view.js";
import { WORKFLOW_VISIT_WORDS, workflowWholeInput } from "../../core/src/workflow-visit-io.js";
import { CodeBlock } from "./workflow-code.js";

const h = React.createElement;
const withThousands = value => Number(value).toLocaleString("en-US");
const GRID = { display: "grid", gap: 6, gridTemplateColumns: "minmax(0, 1fr)" };

/** A whole value as it was read: being read, its failure, none, or the value with its size (a stored value too large for a read: its start). */
function Whole({ whole, label, field }) {
    if (whole.kind === "loading") return h("p", { role: "status" }, "Reading…");
    if (whole.kind === "failed") return h("p", { role: "alert" }, `Could not read it: ${whole.error}`);
    if (whole.kind === "none") return h("p", { className: "ps-wf-muted" }, field === "input" ? "The read gave no input." : "No value yet: it had not ended.");
    const size = whole.bytes === null ? "" : ` · ${withThousands(whole.bytes)} bytes`;
    return h(React.Fragment, null,
        h("h3", null, `${label}${size}`),
        whole.kind === "preview" ? h("p", { "data-whole-preview": "", title: whole.limitBytes === null ? "Larger than one read"
            : `Larger than one read of ${withThousands(whole.limitBytes)} bytes` }, "Only its start is shown.") : null,
        h(CodeBlock, { text: whole.text, language: "auto", [`data-whole-${field}`]: whole.kind }));
}

/**
 * Phase 3 I7 (design §7.2): where a re-run's visit came from: reused ("Reused from #2 · ran … · took …") or supplied ("✎
 * Supplied in #3 (did not run) · by … · …", its Reason callout and the visit it replaced), with Open in #2 (`onOpen`, a
 * Workflow id) unless that Workflow was cleaned up.
 */
function VisitProvenance({ provenance, onOpen }) {
    const supplied = provenance.kind === "supplied";
    return h("div", { className: `ps-wf-provenance is-${provenance.kind}`, "data-provenance": provenance.kind, "data-field": "visit-provenance" },
        h("p", { className: "ps-wf-provenance-head", style: { margin: 0 } }, provenance.head),
        supplied && provenance.reason ? h("p", { className: "ps-wf-reason", "data-field": "supplied-reason", style: { margin: 0 } },
            h("strong", null, "Reason"), " ", h("span", null, provenance.reason)) : null,
        provenance.origin || (provenance.open && onOpen && provenance.workflowId) ? h("p", { className: "ps-wf-muted", style: { margin: 0 } },
            provenance.origin ? h("span", null, provenance.origin) : null,
            provenance.origin && provenance.open && onOpen && provenance.workflowId ? " · " : null,
            provenance.open && onOpen && provenance.workflowId ? h("button", { type: "button", className: "ps-link-button", "data-action": "open-rerun-origin",
                "data-session": provenance.workflowId, onClick: () => onOpen(provenance.workflowId) }, provenance.open) : null) : null);
}

/**
 * One visit's section in the Node panel (workflowVisitIo's model, `io`). `result`: its Output block is the node's result
 * (data-fact "result"), as the Result block was. `runId`, `executionValues` and `onReadWholeValue` read and show the
 * visit's whole values. `onOpenOrigin` opens the Workflow a re-run's reused or supplied visit came from.
 */
export function WorkflowVisitSection({ io, result = true, runId = null, executionValues = null, onReadWholeValue = null, onOpenOrigin = null }) {
    const entry = runId ? workflowExecutionValue(executionValues, runId, io.id) : null;
    const output = io.output;
    const canRead = Boolean(onReadWholeValue && runId);
    const loading = entry?.phase === "loading";
    const read = () => onReadWholeValue(io.id);
    const wholeInput = io.input?.truncated ? workflowWholeInput(entry) : null;
    const wholeOutput = output.truncated ? workflowWholeValue(entry) : null;
    const button = (label, action) => h("button", { type: "button", className: "ps-mini-button", "data-action": action,
        "data-execution": io.id, disabled: loading, onClick: read }, label);
    return h("section", { className: "ps-wf-visit", "aria-label": "Visit", "data-visit": io.id, "data-ordinal": io.ordinal ?? undefined, style: GRID },
        h("p", { className: "ps-wf-visit-head", "data-field": "visit-head", style: { margin: 0, fontWeight: 600, overflowWrap: "anywhere" } }, io.header),
        io.provenance ? h(VisitProvenance, { provenance: io.provenance, onOpen: onOpenOrigin }) : null,
        h("div", { className: "ps-wf-result", "data-field": "visit-input" },
            h("h3", null, WORKFLOW_VISIT_WORDS.input),
            io.input ? h(CodeBlock, { text: io.input.text, language: "auto" })
                : h("p", { className: "ps-wf-muted", style: { margin: 0 } }, WORKFLOW_VISIT_WORDS.inputNotLoaded),
            io.input?.truncated ? h("p", { className: "ps-wf-muted", style: { margin: 0 } }, WORKFLOW_VISIT_WORDS.cut) : null,
            io.input?.truncated && canRead ? button(wholeInput && !loading ? `${WORKFLOW_VISIT_WORDS.showAllInput} again` : WORKFLOW_VISIT_WORDS.showAllInput,
                "whole-input") : null,
            wholeInput ? h(Whole, { whole: wholeInput, label: WORKFLOW_VISIT_WORDS.input, field: "input" }) : null),
        h("div", { className: `ps-wf-result${output.error ? " is-error" : ""}`, "data-field": "visit-output", "data-output": output.kind,
            "data-fact": result && output.kind !== "pending" ? "result" : undefined },
            h("h3", null, output.label),
            output.recordedAfter ? h("p", { className: "ps-wf-muted", "data-field": "visit-recorded-after", style: { margin: 0 } }, output.recordedAfter) : null,
            output.kind === "pending" || output.kind === "none" ? h("p", { className: "ps-wf-muted", style: { margin: 0 } }, output.text)
                : h(CodeBlock, { text: output.text, language: "auto" }),
            output.truncated ? h("p", { className: "ps-wf-muted", style: { margin: 0 } }, output.summary ? WORKFLOW_VISIT_WORDS.summary : WORKFLOW_VISIT_WORDS.cut) : null,
            output.truncated && canRead ? button(wholeOutput && !loading ? `${WORKFLOW_VISIT_WORDS.showAll} again` : WORKFLOW_VISIT_WORDS.showAll, "whole-value") : null,
            wholeOutput ? h(Whole, { whole: wholeOutput, label: wholeOutput.label === "Runtime error" ? "Error" : "Output", field: "value" }) : null));
}
