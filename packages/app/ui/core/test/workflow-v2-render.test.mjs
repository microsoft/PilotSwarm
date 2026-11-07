// Server-render checks for the v2 workflow graph and node panes. Like
// app-render-smoke.test.mjs, this runs component bodies without a DOM; effects
// (resize observers, the controller's definition request) do not run.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import { workflowDefinition } from "../src/workflow-view.js";
import { WorkflowMainPane, WorkflowNodePane } from "../../react/src/workflow-workspace.js";
import { workflowGraphKey } from "../../react/src/workflow-graph.js";
import { WorkflowV2NodeContent } from "../../react/src/workflow-v2-panels.js";
import { projectWorkflowV2 } from "../src/workflow-v2-view.js";
import { startedData, legacyStartedData, started, completed, runtimeError, row, done, readModel } from "./workflow-v2-fixtures.mjs";

function mount({ view = {}, events = [] } = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", sessionKind: "workflow", title: "Watch" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    if (events.length) store.dispatch({ type: "history/set", sessionId: "wf", history: { events } });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view });
    return new PilotSwarmUiController({ store, transport: {} });
}

const main = controller => renderToStaticMarkup(React.createElement(WorkflowMainPane, { controller, icon: null }));
const node = controller => renderToStaticMarkup(React.createElement(WorkflowNodePane, { controller }));

test("the legacy graph renders as before, without v2 marks", () => {
    const html = main(mount({ view: { definition: workflowDefinition(legacyStartedData) } }));
    // Words (Workflow Simplified 03, 10): a node's type in a word, never the Node.js runtime as "node".
    assert.ok(html.includes("Script · idle"));
    // No v2 route marks on its edges. Its nodes carry their type for their icon (Workflow Simplified 10).
    assert.ok(!/<g class="ps-workflow-edge"[^>]*data-kind=/.test(html), html);
    assert.ok(html.includes('data-kind="script"') && html.includes('data-kind="terminal"'));
    assert.ok(!html.includes("data-phase=\"waiting\""));
    assert.equal(html.split(">Workflow session<").length - 1, 0, "no static composer bar (flow-09)");
});

test("a v2 graph shows typed state labels, runtime-error routes and run status from the read model", () => {
    const model = readModel({ nodeExecutions: [row("pause", 1, "pending", { deadline: "2026-11-01T12:00:30.000Z" }), done("poll", 1, "changed")] });
    const html = main(mount({ view: { definition: workflowDefinition(startedData), readModel: model } }));
    assert.ok(html.includes("Wait · 30 s"));
    assert.ok(html.includes("Send · Alert@1"));
    assert.ok(html.includes("Receive · Ack@1"));
    assert.ok(html.includes("Done · changed"));
    assert.ok(html.includes("data-kind=\"error\""));
    assert.ok(html.includes("stroke-dasharray=\"5 4\""));
    assert.ok(html.includes("data-phase=\"waiting\""));
    assert.ok(html.includes(">Running<"), "the header shows the run status");
    assert.ok(html.includes("aria-label=\"Inspect notify\"") && html.includes("tabindex=\"0\""), "nodes keep their keyboard and button semantics");
    assert.equal(html.split(">Workflow session<").length - 1, 0);
    assert.ok(!html.includes("ps-chat-composer"), "no composer bar on the workflow screen (flow-09)");
});

test("a v2 graph is drawn from durable events alone, and an unrecognized read model is reported, not drawn", () => {
    const events = [started("poll", 1), completed("poll", 1, "unchanged"), started("pause", 1)];
    const html = main(mount({ view: { definition: workflowDefinition(startedData) }, events }));
    assert.ok(html.includes("Done · unchanged"));
    assert.ok(html.includes(">Waiting<"));
    const refused = main(mount({ view: { readModel: { nope: true } } }));
    assert.ok(refused.includes("No workflow graph to show"));
    assert.ok(refused.includes("workflow data has an unknown format"));
    const legacyKept = main(mount({ view: { definition: workflowDefinition(legacyStartedData), readModel: { nope: true } } }));
    assert.ok(legacyKept.includes("Script · idle"), "a bad read model never hides a legacy definition");
});

test("an invalid draft shows its diagnostics as text, and a draft with a graph says it is a draft", () => {
    const invalid = readModel({ noRun: true, graph: null, definition: { state: "draft", publishedRevision: null, publishedDefinitionHash: null },
        revision: { revision: 2, valid: false, irSha256: null, diagnostics: [{ severity: "error", code: "BAD", path: "states[0]", message: "<script>alert(1)</script> is not a state", line: 3 }] } });
    const html = main(mount({ view: { readModel: invalid } }));
    assert.ok(html.includes("This workflow definition is invalid"));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; is not a state"));
    assert.ok(!html.includes("<script>alert"));
    // Batch 6 (r-3): the notices show in the side pane.
    const draftView = mount({ view: { readModel: readModel({ noRun: true, definition: { state: "draft", publishedRevision: null, publishedDefinitionHash: null } }),
        sidePanel: "notices" } });
    const draft = main(draftView) + node(draftView);
    assert.ok(draft.includes("Draft revision 1 · not published."));
    // Batch 5 (g-07): "No run yet" is said once, by the run's status; the notices do not repeat it.
    assert.equal(draft.match(/No runs? yet/g)?.length, 1);
    assert.match(draft, /<span class="ps-workflow-status">No run yet<\/span>/);
    assert.ok(node(mount({ view: { readModel: invalid } })).includes("This workflow definition is invalid"));
});

test("node details explain a send accurately and show values as escaped text, never markup", () => {
    const payload = '{"x":"<b>bold</b>"}';
    const model = readModel({
        nodeExecutions: [done("notify", 1, "sent")],
        outbox: [{ exchangeId: "nx-notify-1", nodeExecutionId: "nx-notify-1", recipientSessionId: "parent-1", recipientKind: "agent",
            contract: "Alert@1", state: "delivered", attempts: 1, payloadPreview: payload }],
    });
    const html = node(mount({ view: { definition: workflowDefinition(startedData), readModel: model, selectedNodeId: "notify" } }));
    assert.ok(html.includes("Sent · queued at recipient"));
    assert.ok(html.includes("does not show that the recipient read, answered or acted on it"));
    assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt;"));
    assert.ok(!html.includes("<b>bold"));
    assert.ok(html.includes("delivery_failed → failed · runtime error route"));
});

test("output and history tabs show the right result kind, truncation, and combined repeats with raw rows kept", () => {
    const events = [
        completed("poll", 1, "unchanged", "<img src=x onerror=alert(1)>"), completed("poll", 2, "unchanged", "<img src=x onerror=alert(1)>"),
        completed("poll", 3, "unchanged", "<img src=x onerror=alert(1)>"), runtimeError("poll", 4, "timed_out", "cut off…"),
    ];
    const view = projectWorkflowV2({ definition: workflowDefinition(startedData), events });
    const selected = view.nodes[0];
    const render = tab => renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, { tab, selected, nodes: view.nodes, select() {}, runOutput: null, runError: null }));
    const output = render("output");
    assert.ok(output.includes("Runtime error"));
    assert.ok(output.includes("cut off…"));
    assert.ok(output.includes("This preview was cut short"));
    const history = render("history");
    assert.ok(history.includes("1–3 (×3)"));
    assert.ok(history.includes("Every loaded visit (4)"));
    assert.ok(history.includes("Runtime error"));
    const business = projectWorkflowV2({ definition: workflowDefinition(startedData), events: events.slice(0, 1) }).nodes[0];
    const businessOutput = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, { tab: "output", selected: business, nodes: [], select() {}, runOutput: null, runError: null }));
    assert.ok(businessOutput.includes("&lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(!businessOutput.includes("<img"));
    const terminal = projectWorkflowV2({ readModel: readModel({ run: { status: "completed", outcome: "succeeded", terminalState: "done", output: '{"summary":"all good"}' } }) });
    const doneNode = terminal.nodes.find(item => item.id === "done");
    const terminalOutput = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, { tab: "output", selected: doneNode, nodes: terminal.nodes, select() {}, runOutput: terminal.output, runError: terminal.error }));
    assert.ok(terminalOutput.includes("Run output"));
    assert.ok(terminalOutput.includes("all good"));
});

test("a v2 definition is not redrawn once the read model says there is no graph", () => {
    const invalid = readModel({ noRun: true, graph: null, definition: { state: "draft", publishedRevision: null, publishedDefinitionHash: null },
        revision: { revision: 2, valid: false, irSha256: null, diagnostics: [{ severity: "error", code: "BAD", path: "states[0]", message: "state is not valid", line: 3 }] } });
    const controller = mount({ view: { definition: workflowDefinition(startedData), readModel: invalid } });
    const html = main(controller);
    assert.ok(html.includes("This workflow definition is invalid"));
    assert.ok(html.includes("state is not valid"));
    assert.ok(!html.includes("data-node-id"), "the older graph is not drawn");
    assert.ok(!html.includes("Send · Alert@1"));
    assert.ok(node(controller).includes("This workflow definition is invalid"));
    const withGraph = main(mount({ view: { definition: workflowDefinition(startedData), readModel: readModel({ noRun: true }) } }));
    assert.ok(withGraph.includes("data-node-id"));
});

test("an unverified run status is shown with its notice", () => {
    const shown = mount({ view: { readModel: readModel({ nodeExecutions: [row("poll", 1, "pending")] }), readModelAfterSeq: 1, sidePanel: "notices" },
        events: [{ eventType: "workflow.paused", seq: 4, data: { runId: "run-1" } }] });
    const html = main(shown) + node(shown);
    assert.ok(html.includes("Status not certain · its data says running, latest event says paused"));
    assert.ok(html.includes("Refresh to read it again."));
    assert.ok(html.includes("Pending · run status not certain"));
});

// Batch 5 (g-01, g-02): the server, and the browser until React Flow has loaded, draw the same top-to-bottom layout as a
// plain picture: each step a button card at its layout position, each edge a curve with its label box.
const slots = html => [...html.matchAll(/<div class="ps-workflow-node-slot" style="left:([\d.]+)px;top:([\d.]+)px;width:202px;height:66px"><div class="ps-workflow-node[^"]*"[^>]*data-node-id="([^"]+)"/g)]
    .map(match => ({ id: match[3], x: Number(match[1]), y: Number(match[2]) }));

test("the graph is drawn top to bottom: each step below the one that leads to it, its card a button, its edges curves", () => {
    const html = main(mount({ view: { definition: workflowDefinition(startedData), readModel: readModel({ nodeExecutions: [done("poll", 1, "changed")] }) } }));
    assert.ok(html.includes("role=\"group\" aria-label=\"Workflow graph\" data-renderer=\"static\""));
    const at = Object.fromEntries(slots(html).map(slot => [slot.id, slot]));
    assert.deepEqual(Object.keys(at).sort(), ["await_ack", "done", "failed", "notify", "pause", "poll"]);
    assert.ok(at.notify.y > at.poll.y && at.pause.y > at.poll.y && at.await_ack.y > at.notify.y && at.done.y > at.await_ack.y);
    assert.equal([...html.matchAll(/<g class="ps-workflow-edge"/g)].length, 7);
    assert.match(html, /<path class="ps-workflow-edge-path" d="M[\d.]+,[\d.]+ L[^"]* C[^"]*" fill="none" marker-end="url\(#wf-arrow-[^)]+\)"/);
    assert.ok(html.includes("<title>failure / timed_out</title>"), "a merged label keeps every outcome in its title");
    assert.match(html, /<div class="ps-workflow-node is-done[^"]*"[^>]*data-node-id="poll" role="button" tabindex="0" aria-label="Inspect poll" aria-pressed="(true|false)"/);
    // The old picture's controls are gone; the browser's zoom, fit and hand belong to React Flow (browser specs).
    assert.ok(!html.includes("Full graph") && !html.includes(">100%<") && !html.includes("Scrollable workflow graph"));
});

test("the graph's key changes with the graph, never with a run's progress, so the view is fitted again only for a new graph", () => {
    const definition = workflowDefinition(startedData);
    const before = projectWorkflowV2({ definition, events: [started("poll", 1)] });
    const after = projectWorkflowV2({ definition, events: [started("poll", 1), completed("poll", 1, "changed"), started("notify", 1)] });
    assert.notEqual(before.nodes.find(item => item.id === "poll").state, after.nodes.find(item => item.id === "poll").state);
    assert.equal(workflowGraphKey(before.definition), workflowGraphKey(after.definition));
    assert.notEqual(workflowGraphKey(definition), workflowGraphKey({ ...definition, revision: 2 }));
    assert.notEqual(workflowGraphKey(definition), workflowGraphKey({ ...definition, states: definition.states.slice(0, 5) }));
});
