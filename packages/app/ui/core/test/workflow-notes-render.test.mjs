// Render/model coverage only: deployed-browser acceptance belongs to the integration owner.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { projectWorkflow, workflowDefinition } from "../src/workflow-view.js";
import { workflowNodeSummary } from "../src/workflow-node-summary.js";
import { WORKFLOW_GRAPH_GROUP_HEADER, layoutWorkflowGraphTB, workflowGraphNodeHeight } from "../src/workflow-graph-layout.js";
import { WorkflowGraph, WorkflowStepCard, WorkflowEdgeShape, workflowGraphKey } from "../../react/src/workflow-graph.js";
import { WorkflowNodeSummary } from "../../react/src/workflow-panels.js";
import { NodeFacts, BottomPanel } from "../../react/src/workflow-tab.js";
import { readModel } from "./workflow-fixtures.mjs";

const rootNotes = "  Why this process exists.\nSecond line <script>not executable</script>";
const stateNotes = "  Keep ${unknown.value} literally.\nOnly documentation.";
const graph = workflowDefinition({
    revision: 3, initial: "work", notes: rootNotes, states: [
        { id: "work", type: "script", runtime: "node", outcomes: ["ok", "again"], next: { ok: "done", again: "done" },
            about: { description: "Check the build\nwithout changing it", notes: stateNotes },
            routeNotes: { ok: "The build finished.", again: "Try a second path.\n<em>plain text</em>" } },
        { id: "done", type: "terminal", outcome: "succeeded", about: { notes: "Complete." } },
    ],
});
const view = projectWorkflow({ readModel: readModel({ graph }) });
const work = view.nodes.find(n => n.id === "work");
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

for (const mobile of [false, true]) {
    test(`${mobile ? "phone" : "desktop"} graph and Node panel expose labels, ids and complete notes without hover`, () => {
        const html = render(WorkflowGraph, { definition: graph, nodes: view.nodes, selected: work, select() {}, mobile });
        assert.match(html, /class="ps-workflow-node-name"[^>]*>Check the build/);
        assert.match(html, /class="ps-workflow-node-id" title="work">work<\/span>/);
        assert.ok(html.includes('aria-label="Notes; open Node to read"'));
        assert.ok(html.includes("Definition notes"));
        assert.ok(html.includes("&lt;script&gt;not executable&lt;/script&gt;"));
        assert.ok(!html.includes("<script>not executable"));
        const sheet = render(BottomPanel, {
            controller: { getState: () => ({ ui: {} }), subscribe: () => () => {}, dispatch() {} },
            panels: ["node"], panel: "node", onPanel() {}, mobile,
            children: React.createElement(WorkflowNodeSummary, { selected: work, nodes: view.nodes, select() {} }),
        });
        assert.ok(sheet.includes(stateNotes), "literal notes are read on the Node panel, not just a hover title");
        assert.ok(sheet.includes("The build finished."));
        assert.ok(sheet.includes("Try a second path.\n&lt;em&gt;plain text&lt;/em&gt;"));
        assert.ok(!sheet.includes("<em>plain text"));
        if (mobile) assert.ok(sheet.includes("← Graph"), "phone sheet retains its way back");
        const saved = render(NodeFacts, { node: work });
        assert.ok(saved.includes(stateNotes) && saved.includes("The build finished."), "saved definition has the same notes before a run");
    });
}

test("two routes sharing one edge keep both notes under the exact route names", () => {
    const layout = layoutWorkflowGraphTB(graph);
    const edge = layout.edges.find(e => e.from === "work" && e.to === "done");
    assert.equal(layout.edges.length, 1);
    assert.equal(edge.notes, "ok: The build finished.\nagain: Try a second path.\n<em>plain text</em>");
    const html = render(WorkflowEdgeShape, { edge });
    assert.ok(html.includes("ok: The build finished.\nagain: Try a second path."));
    assert.equal(workflowNodeSummary(work).notes, stateNotes);
    assert.equal(workflowNodeSummary(work).next.lines[1].notes, graph.states[0].routeNotes.again);
});

test("unannotated cards stay id-only; long labels and notes use bounded wrapping styles at both widths", () => {
    const plain = { ...work, about: undefined };
    const html = render(WorkflowStepCard, { node: plain, onSelect() {} });
    assert.ok(html.includes('class="ps-workflow-node-name">work</span>'));
    assert.ok(!html.includes("ps-workflow-node-id") && !html.includes("ps-workflow-node-notes"));
    const long = { ...work, about: { description: "Long label ".repeat(100), notes: "n".repeat(16384) } };
    const shown = render(WorkflowStepCard, { node: long, onSelect() {} });
    assert.ok(shown.includes("Long label ") && shown.includes('data-node-id="work"'));
    const css = fs.readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");
    assert.match(css, /\.ps-workflow-node-name[^}]*text-overflow: ellipsis/);
    assert.match(css, /\.ps-workflow-notes\s*\{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere/);
    for (const width of [390, 1440]) {
        const layout = layoutWorkflowGraphTB(graph, width);
        for (const [id, box] of layout.positions) {
            assert.equal(box.height, workflowGraphNodeHeight(graph.states.find(state => state.id === id)), "layout reserves room for labels");
        }
    }
});

for (const width of [1440, 390]) {
    test(`two-line labels reserve stable graph boxes and keep metadata at ${width}px`, () => {
        const html = render(WorkflowGraph, { definition: graph, nodes: view.nodes, select() {}, mobile: width === 390 });
        assert.match(html, /has-label/);
        assert.match(html, /height:100px/);
        assert.match(html, /title="Check the build\nwithout changing it"/);
        assert.match(html, /ps-workflow-node-name[^>]*>Check the build\nwithout changing it<\/span><\/span><span class="ps-workflow-node-row"><span class="ps-workflow-node-id" title="work">work<\/span>/);
        const plain = { ...graph, states: graph.states.map(state => ({ ...state, about: undefined })) };
        assert.notEqual(workflowGraphKey(graph), workflowGraphKey(plain), "a new card height invalidates the remembered layout");
        const nested = {
            initial: "parallel", states: [
                { id: "parallel", type: "parallel", body: { initial: "item", states: ["item", "end"] }, next: { joined: "done" } },
                { id: "item", type: "script", about: { description: "Check the build" }, next: { ok: "end" } },
                { id: "end", type: "terminal", about: { description: "Finished checking the build" } },
                { id: "done", type: "terminal" },
            ],
        };
        const layout = layoutWorkflowGraphTB(nested);
        assert.equal(layout.positions.get("item").height, 100);
        // B1, R2: the parallel step is its box's title; the end inside its box and the root's end that is not a success
        // (it has no outcome) are no boxes. R1: with no outcomes listed, "ok" and "joined" read as error routes into ends:
        // error handlers to ghosts of those ends (the parallel step's from its join bar), never lines or chips.
        assert.deepEqual([...layout.positions.keys()], ["item"]);
        assert.deepEqual([...layout.hidden].sort(), ["done", "end"]);
        assert.deepEqual([layout.edges.length, layout.chips.size], [0, 0]);
        assert.deepEqual([...layout.handlers].map(([id, list]) => [id, list.map(handler => [handler.key, handler.from, handler.end, handler.words, handler.index])]), [
            ["parallel", [["handler:parallel:done", "join:parallel", "done", "on error", 0]]],
            ["item", [["handler:item:end", "item", "end", "on error", 0]]]]);
        assert.deepEqual([...layout.marks].map(([id, list]) => [id, list.map(mark => mark.key)]),
            [["parallel", ["handler:parallel:done"]], ["item", ["handler:item:end"]]]);
        const group = layout.groups.get("parallel"), item = layout.positions.get("item");
        assert.ok(item.y >= group.y + WORKFLOW_GRAPH_GROUP_HEADER && item.y + item.height <= group.y + group.height, "the box has room for the taller card");
        // An end drawn as a box (a root success end) reserves room for its label too; one without a label does not.
        const rooted = layoutWorkflowGraphTB({
            initial: "item", states: [
                { id: "item", type: "script", about: { description: "Check the build" }, outcomes: ["ok", "skipped"], next: { ok: "end", skipped: "done" } },
                { id: "end", type: "terminal", outcome: "succeeded", about: { description: "Finished checking the build" } },
                { id: "done", type: "terminal", outcome: "succeeded" },
            ],
        });
        assert.deepEqual(["item", "end", "done"].map(id => rooted.positions.get(id)?.height), [100, 120, 66]);
        const first = rooted.positions.get("item"), end = rooted.positions.get("end");
        assert.ok(end.y > first.y + first.height, "edges have room below the taller card");
    });
}

test("card geometry reserves font slack and pins only graph cards to the existing bundled face", () => {
    const css = fs.readFileSync(new URL("../../../web/src/index.css", import.meta.url), "utf8");
    assert.match(css, /\.ps-workflow-node\s*\{[^}]*font-family: "PS JetBrains Mono", monospace;/);
    assert.match(css, /\.ps-workflow-node\.has-label \.ps-workflow-node-text\s*\{\s*gap: 4px;/);
    assert.ok(fs.existsSync(new URL("../../../web/src/assets/fonts/jetbrains-mono/jetbrains-mono-latin.woff2", import.meta.url)));
    assert.equal(workflowGraphNodeHeight({ type: "script", about: { description: "Label" } }), 100);
    assert.equal(workflowGraphNodeHeight({ type: "terminal", about: { description: "Label" } }), 120);
    for (const type of ["script", "terminal"]) {
        assert.equal(workflowGraphNodeHeight({ type }), 66);
        assert.equal(workflowGraphNodeHeight({ type, about: { description: "  " } }), 66);
    }
});
