// Server-render checks for the workflow graph and node panes. Like
// app-render-smoke.test.mjs, this runs component bodies without a DOM; effects
// (resize observers, the controller's definition request) do not run.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    workflowDefinition, projectWorkflow,
} from "../src/workflow-view.js";
import { WorkflowMainPane, WorkflowNodePane } from "../../react/src/workflow-workspace.js";
import { workflowGraphKey } from "../../react/src/workflow-graph.js";
import { WorkflowNodeContent } from "../../react/src/workflow-panels.js";
import { startedData, started, completed, runtimeError, row, done, readModel } from "./workflow-fixtures.mjs";

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

// R1: a step whose runtime-error routes end the run as failed carries one ✕ badge with the end in its words.
const BADGE = /<span class="ps-workflow-badge" role="img" aria-label="Any error here ends the run: failed" title="Any error here ends the run: failed"[^>]*><span class="ps-workflow-badge-mark" aria-hidden="true">✕<\/span><\/span>/g;
const badged = (html, id) => new RegExp(`<div class="ps-workflow-step"><div class="ps-workflow-node [^"]*"[^>]*data-node-id="${id}"[^>]*>[\\s\\S]*?</div><span class="ps-workflow-badge"`).test(html);

test("a graph shows typed state labels, runtime-error routes and run status from the read model", () => {
    const model = readModel({ nodeExecutions: [row("pause", 1, "pending", { deadline: "2026-11-01T12:00:30.000Z" }), done("poll", 1, "changed")] });
    const html = main(mount({ view: { definition: workflowDefinition(startedData), readModel: model } }));
    assert.ok(html.includes("Wait · 30 s"));
    assert.ok(html.includes("Send · Alert@1"));
    assert.ok(html.includes("Receive · Ack@1"));
    assert.ok(html.includes("Done · changed"));
    // R1: the runtime-error routes into the failed end are ✕ badges on poll and notify, not dashed lines; the failed end
    // is no box but is listed in the Ends row with its two ways in.
    assert.equal([...html.matchAll(BADGE)].length, 2, html);
    assert.ok(badged(html, "poll") && badged(html, "notify"), html);
    assert.ok(!html.includes("data-kind=\"error\"") && !html.includes("stroke-dasharray=\"5 4\""), "no error line is drawn");
    assert.ok(!html.includes("data-node-id=\"failed\""), "the failed end has no box");
    assert.match(html, /<div class="ps-workflow-ends" role="group" aria-label="Ends">/);
    assert.match(html, /<button type="button" data-end="done" class="ps-workflow-end is-succeeded[^"]*"[^>]*><span class="ps-workflow-end-mark" aria-hidden="true">●<\/span> done · 1 way in<\/button>/);
    assert.match(html, /<button type="button" data-end="failed" class="ps-workflow-end is-failed[^"]*"[^>]*><span class="ps-workflow-end-mark" aria-hidden="true">⏹<\/span> failed · 2 ways in<\/button>/);
    assert.ok(html.includes("data-phase=\"waiting\""));
    assert.ok(html.includes(">Running<"), "the header shows the run status");
    assert.ok(html.includes("aria-label=\"Inspect notify\"") && html.includes("tabindex=\"0\""), "nodes keep their keyboard and button semantics");
    assert.equal(html.split(">Workflow session<").length - 1, 0);
    assert.ok(!html.includes("ps-chat-composer"), "no composer bar on the workflow screen (flow-09)");
});

test("a graph is drawn from durable events alone, and an unrecognized read model is reported, not drawn", () => {
    const events = [started("poll", 1), completed("poll", 1, "unchanged"), started("pause", 1)];
    const html = main(mount({ view: { definition: workflowDefinition(startedData) }, events }));
    assert.ok(html.includes("Done · unchanged"));
    // OF-S2-2: a card's state is its title's last words; the card shows a mark and a key fact.
    assert.ok(html.includes("· Waiting\""));
    const refused = main(mount({ view: { readModel: { nope: true } } }));
    assert.ok(refused.includes("No graph to show"));
    assert.ok(refused.includes("Workflow&#x27;s data has an unknown format"));
    const kept = main(mount({ view: { definition: workflowDefinition(startedData), readModel: { nope: true } } }));
    assert.ok(kept.includes("Wait · 30 s"), "a bad read model never hides the definition from the workflow's own start");
});

test("an invalid draft shows its diagnostics as text, and a draft with a graph says it is a draft", () => {
    const invalid = readModel({ noRun: true, graph: null, definition: { state: "draft", publishedRevision: null, publishedDefinitionHash: null },
        revision: { revision: 2, valid: false, irSha256: null, diagnostics: [{ severity: "error", code: "BAD", path: "states[0]", message: "<script>alert(1)</script> is not a state", line: 3 }] } });
    const html = main(mount({ view: { readModel: invalid } }));
    assert.ok(html.includes("This definition is not valid"));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; is not a state"));
    assert.ok(!html.includes("<script>alert"));
    // Batch 6 (r-3): the notices show in the side pane.
    const draftView = mount({ view: { readModel: readModel({ noRun: true, definition: { state: "draft", publishedRevision: null, publishedDefinitionHash: null } }),
        sidePanel: "notices" } });
    const draft = main(draftView) + node(draftView);
    assert.ok(draft.includes("Draft revision 1 · not published."));
    // Batch 5 (g-07): "Not started" is said once, by the run's status; the notices do not repeat it.
    assert.equal(draft.match(/<span class="ps-workflow-status">Not started<\/span>/g)?.length, 1);
    assert.ok(!draft.includes("Not started yet"), "the notices do not repeat it");
    assert.match(draft, /<span class="ps-workflow-status">Not started<\/span>/);
    assert.ok(node(mount({ view: { readModel: invalid } })).includes("This definition is not valid"));
});

test("node details explain a send accurately and show values as escaped text, never markup", () => {
    const payload = '{"x":"<b>bold</b>"}';
    const model = readModel({
        nodeExecutions: [done("notify", 1, "sent")],
        outbox: [{ exchangeId: "nx-notify-1", nodeExecutionId: "nx-notify-1", recipientSessionId: "parent-1", recipientKind: "agent",
            contract: "Alert@1", state: "delivered", attempts: 1, payloadPreview: payload }],
    });
    const html = node(mount({ view: { definition: workflowDefinition(startedData), readModel: model, selectedNodeId: "notify" } }));
    assert.ok(html.includes("Done · sent, queued at recipient"));
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
    const view = projectWorkflow({ definition: workflowDefinition(startedData), events });
    const selected = view.nodes[0];
    const render = tab => renderToStaticMarkup(React.createElement(WorkflowNodeContent, { tab, selected, nodes: view.nodes, select() {}, runOutput: null, runError: null }));
    const output = render("output");
    assert.ok(output.includes("Runtime error"));
    assert.ok(output.includes("cut off…"));
    assert.ok(output.includes("This preview was cut short"));
    const history = render("history");
    assert.ok(history.includes("1–3 (×3)"));
    assert.ok(history.includes("Every loaded visit (4)"));
    assert.ok(history.includes("Runtime error"));
    const business = projectWorkflow({ definition: workflowDefinition(startedData), events: events.slice(0, 1) }).nodes[0];
    const businessOutput = renderToStaticMarkup(React.createElement(WorkflowNodeContent, { tab: "output", selected: business, nodes: [], select() {}, runOutput: null, runError: null }));
    assert.ok(businessOutput.includes("&lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(!businessOutput.includes("<img"));
    const terminal = projectWorkflow({ readModel: readModel({ run: { status: "completed", outcome: "succeeded", terminalState: "done", output: '{"summary":"all good"}' } }) });
    const doneNode = terminal.nodes.find(item => item.id === "done");
    const terminalOutput = renderToStaticMarkup(React.createElement(WorkflowNodeContent, { tab: "output", selected: doneNode, nodes: terminal.nodes, select() {}, runOutput: terminal.output, runError: terminal.error }));
    assert.ok(terminalOutput.includes("Run output"));
    assert.ok(terminalOutput.includes("all good"));
});

test("a definition is not redrawn once the read model says there is no graph", () => {
    const invalid = readModel({ noRun: true, graph: null, definition: { state: "draft", publishedRevision: null, publishedDefinitionHash: null },
        revision: { revision: 2, valid: false, irSha256: null, diagnostics: [{ severity: "error", code: "BAD", path: "states[0]", message: "state is not valid", line: 3 }] } });
    const controller = mount({ view: { definition: workflowDefinition(startedData), readModel: invalid } });
    const html = main(controller);
    assert.ok(html.includes("This definition is not valid"));
    assert.ok(html.includes("state is not valid"));
    assert.ok(!html.includes("data-node-id"), "the older graph is not drawn");
    assert.ok(!html.includes("Send · Alert@1"));
    assert.ok(node(controller).includes("This definition is not valid"));
    const withGraph = main(mount({ view: { definition: workflowDefinition(startedData), readModel: readModel({ noRun: true }) } }));
    assert.ok(withGraph.includes("data-node-id"));
});

test("an unverified run status is shown with its notice", () => {
    const shown = mount({ view: { readModel: readModel({ nodeExecutions: [row("poll", 1, "pending")] }), readModelAfterSeq: 1, sidePanel: "notices" },
        events: [{ eventType: "workflow.paused", seq: 4, data: { runId: "run-1" } }] });
    const html = main(shown) + node(shown);
    // Review 19:27Z (D-W13): one word; its reason is the tooltip here (and a notice line in the terminal).
    assert.ok(html.includes('<span class="ps-workflow-status" title="Not certain · its data says running, its latest event says paused">Not certain</span>'), html);
    assert.ok(html.includes("Refresh to read it again."));
    assert.ok(html.includes("Waiting · Workflow status not certain"));
});

// Batch 5 (g-01, g-02): the server, and the browser until React Flow has loaded, draw the same top-to-bottom layout as a
// plain picture: each step a button card at its layout position, each edge a curve with its label box.
const slots = html => [...html.matchAll(/<div class="ps-workflow-node-slot" style="left:([\d.]+)px;top:([\d.]+)px;width:202px;height:66px">(?:<div class="ps-workflow-step">)?<div class="ps-workflow-node[^"]*"[^>]*data-node-id="([^"]+)"/g)]
    .map(match => ({ id: match[3], x: Number(match[1]), y: Number(match[2]) }));

test("the graph is drawn top to bottom: each step below the one that leads to it, its card a button, its edges curves", () => {
    const html = main(mount({ view: { definition: workflowDefinition(startedData), readModel: readModel({ nodeExecutions: [done("poll", 1, "changed")] }) } }));
    assert.ok(html.includes("role=\"group\" aria-label=\"Workflow graph\" data-renderer=\"static\""));
    const at = Object.fromEntries(slots(html).map(slot => [slot.id, slot]));
    // R2: the failed end is no box (poll's and notify's routes there are ✕ badges).
    assert.deepEqual(Object.keys(at).sort(), ["await_ack", "done", "notify", "pause", "poll"]);
    assert.ok(at.notify.y > at.poll.y && at.pause.y > at.poll.y && at.await_ack.y > at.notify.y && at.done.y > at.await_ack.y);
    const edges = [...html.matchAll(/<g class="ps-workflow-edge" data-from="([^"]+)" data-to="([^"]+)" data-kind="([^"]+)"([^>]*)>/g)];
    assert.deepEqual(edges.map(match => [match[1], match[2], match[3]]), [["poll", "notify", "outcome"], ["poll", "pause", "outcome"],
        ["pause", "poll", "outcome"], ["notify", "await_ack", "outcome"], ["await_ack", "done", "outcome"]]);
    // R4: the happy path, from the first step to the success end.
    assert.deepEqual(edges.filter(match => match[4].includes('data-spine="true"')).map(match => [match[1], match[2]]),
        [["poll", "notify"], ["notify", "await_ack"], ["await_ack", "done"]]);
    assert.match(html, /<path class="ps-workflow-edge-path" d="M[\d.]+,[\d.]+ L[^"]* C[^"]*" fill="none" marker-end="url\(#wf-arrow-[^)]+\)"/);
    // R3: a line that carries only some of its step's outcomes says them; one that carries all of them has no label,
    // its routes still named on hover.
    assert.ok(html.includes(">changed<title>changed</title>") && html.includes(">unchanged<title>unchanged</title>"), html);
    assert.equal([...html.matchAll(/<g class="ps-workflow-edge-label"/g)].length, 2);
    assert.ok(html.includes('<path class="ps-workflow-edge-hit"') && html.includes("<title>received · elapsed</title>"), html);
    assert.ok(!html.includes("✕ error") && !html.includes("Error routes:"), "no error line, so no error label");
    assert.match(html, /<div class="ps-workflow-node is-done[^"]*"[^>]*data-node-id="poll" role="button" tabindex="0" aria-label="Inspect poll" aria-pressed="(true|false)"/);
    // The old picture's controls are gone; the browser's zoom, fit and hand belong to React Flow (browser specs).
    assert.ok(!html.includes("Full graph") && !html.includes(">100%<") && !html.includes("Scrollable workflow graph"));
});

test("the graph's key changes with the graph, never with a run's progress, so the view is fitted again only for a new graph", () => {
    const definition = workflowDefinition(startedData);
    const before = projectWorkflow({ definition, events: [started("poll", 1)] });
    const after = projectWorkflow({ definition, events: [started("poll", 1), completed("poll", 1, "changed"), started("notify", 1)] });
    assert.notEqual(before.nodes.find(item => item.id === "poll").state, after.nodes.find(item => item.id === "poll").state);
    assert.equal(workflowGraphKey(before.definition), workflowGraphKey(after.definition));
    assert.notEqual(workflowGraphKey(definition), workflowGraphKey({ ...definition, revision: 2 }));
    assert.notEqual(workflowGraphKey(definition), workflowGraphKey({ ...definition, states: definition.states.slice(0, 5) }));
});
