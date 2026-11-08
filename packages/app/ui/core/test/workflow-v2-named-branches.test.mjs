// Named branches (owner decision 2026-11-08T00:35Z, IR 11), the minimal UI: a parallel step with branches says their
// names instead of "Item N" in its Node panel (its Branches section and results table), a branch step says its branch,
// the branch picker and a step's places name the branch, and the TUI's node details count and list branches by name.
// Slice 2: the graph draws the branches as lanes side by side in one box (no stack), the parallel step leading into
// each lane by an edge labelled with its name; the card, the box, a blocked join, why a visit was canceled and the
// replay say "branch" (and its name) where a For each says "item".
//
// Run: node --test packages/app/ui/core/test/workflow-v2-named-branches.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowViewModal,
} from "../src/index.js";
import { workflowViewNodes } from "../src/workflow-tui.js";
import { formatWorkflowEventText } from "../src/workflow-sessions.js";
import {
    projectWorkflowV2, workflowEventText, workflowV2Definition, workflowV2ItemList, workflowV2NodeLabel, workflowV2ReplayFrames, workflowV2ReplayLabel,
    workflowV2VisitEnding,
} from "../src/workflow-v2-view.js";
import { WORKFLOW_GRAPH_GROUP_HEADER, layoutWorkflowGraphTB, workflowGroupId } from "../src/workflow-graph-layout.js";
import { WorkflowV2NodeSummary } from "../../react/src/workflow-v2-panels.js";
import { WorkflowEdgeShape, WorkflowGroupBox } from "../../react/src/workflow-graph.js";
import { done, readModel } from "./workflow-v2-fixtures.mjs";

process.env.TZ = "UTC";

// The graph as read_workflow gives it (describeWorkflowV2States): the parallel step lists its branches; each branch
// state names its parallel step and its branch.
const states = [
    { id: "views", type: "parallel", concurrency: 2, join: "all_required", failFast: false,
        branches: [{ name: "quick", initial: "quick_work", states: ["quick_work", "quick_end"] },
            { name: "careful", initial: "careful_work", states: ["careful_work", "careful_end"] }],
        body: { initial: "quick_work", states: ["quick_work", "quick_end", "careful_work", "careful_end"] },
        outcomes: ["joined", "blocked"], next: { joined: "done", blocked: "failed" } },
    { id: "quick_work", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["ok"], next: { ok: "quick_end" }, parallel: "views", branchName: "quick" },
    { id: "quick_end", type: "terminal", outcome: "succeeded", parallel: "views", branchName: "quick" },
    { id: "careful_work", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["ok"], next: { ok: "careful_end" }, parallel: "views", branchName: "careful" },
    { id: "careful_end", type: "terminal", outcome: "succeeded", parallel: "views", branchName: "careful" },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const graph = { revision: 1, initial: "views", states };
const branch = index => ({ scopeId: `nx-views-1#${index}`, branch: { parallelNodeExecutionId: "nx-views-1", index } });
const model = () => readModel({ graph, run: { status: "completed", outcome: "blocked" }, nodeExecutions: [
    done("views", 1, "blocked", { branches: 2 }),
    done("quick_work", 1, "ok", { nodeExecutionId: "nx-quick-work", ...branch(0) }),
    done("quick_end", 2, "succeeded", { nodeExecutionId: "nx-quick-end", outputPreview: "\"q\"", ...branch(0) }),
    done("careful_work", 1, "crashed", { nodeExecutionId: "nx-careful-work", resultKind: "runtime_error",
        errorPreview: JSON.stringify({ code: "crashed", message: "exit code 1" }), ...branch(1) }),
] });

test("the graph's named branches are the parallel step's namedBranches (its view's branches stay a branch step's picker)", () => {
    const definition = workflowV2Definition(graph);
    const views = definition.states.find(node => node.id === "views");
    assert.deepEqual(views.namedBranches.map(item => [item.name, item.initial]), [["quick", "quick_work"], ["careful", "careful_work"]]);
    assert.equal(Object.hasOwn(views, "branches"), false);
    assert.equal(workflowV2ItemList([1], ["quick", "careful"]), "branch careful");
    assert.equal(workflowV2ItemList([0, 1], ["quick", "careful"]), "branches quick, careful");
    assert.equal(workflowV2ItemList([1]), "item 2");
});

test("the Node panel names the branches: its Branches section, a blocked join, the results table and a branch step", () => {
    const projection = projectWorkflowV2({ readModel: model() });
    const views = projection.nodes.find(node => node.id === "views");
    assert.ok(views.description.includes("Branches: quick, careful."), views.description.join(" | "));
    assert.deepEqual(views.evidence.names, ["quick", "careful"]);
    assert.deepEqual(views.evidence.rows.map(row => [row.name, row.status]), [["quick", "ok"], ["careful", "failed"]]);
    assert.deepEqual(views.evidence.blocking, [1]);
    const html = renderToStaticMarkup(React.createElement(WorkflowV2NodeSummary, { selected: views, nodes: projection.nodes, select: () => {} }));
    assert.match(html, /<h3>Branches<\/h3>/);
    assert.match(html, /<span>Branches<\/span><strong>quick, careful<\/strong>/);
    assert.match(html, /Blocked by branch careful/);
    assert.match(html, /aria-label="Branches"><h3>Branch results<\/h3>/);
    assert.match(html, /<tr data-branch="0" data-status="ok"><td>quick<\/td>/);
    assert.ok(!/For each|Item 1|Items started/.test(html), html);
    // A branch step: its description, its picker choice and its place name its branch.
    const careful = projection.nodes.find(node => node.id === "careful_work");
    assert.ok(careful.description.includes("Branch careful of views."), careful.description.join(" | "));
    assert.deepEqual(careful.branches.choices.map(choice => choice.label), ["Branch careful · ✕ crashed"]);
    assert.equal(careful.where["nx-careful-work"].label, "branch careful");
    // Final review FUI-F3: its picker is labelled Branch; a For each's step keeps Item.
    const picker = renderToStaticMarkup(React.createElement(WorkflowV2NodeSummary, { selected: careful, nodes: projection.nodes, select: () => {} }));
    assert.match(picker, /<span>Branch<\/span><select[^>]*data-field="branch"/);
    assert.ok(!/<span>Item<\/span>/.test(picker), picker);
    const { branchName: _branchName, ...item } = careful;
    const forEach = renderToStaticMarkup(React.createElement(WorkflowV2NodeSummary, { selected: item, nodes: projection.nodes, select: () => {} }));
    assert.match(forEach, /<span>Item<\/span><select[^>]*data-field="branch"/);
});

test("the TUI's node details count branches and list them by name", async () => {
    const shown = model();
    const transport = { getSessionEventsBefore: async () => [], readWorkflow: async () => shown };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: views", status: "completed", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: shown, readModelRunId: null } });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    store.dispatch({ type: "ui/modal", modal: { ...store.getState().ui.modal, selectedNodeId: "views", detailsScroll: 0 } });
    const lines = selectWorkflowViewModal(store.getState(), 120).detailsLines.map(line => line.text);
    assert.ok(lines.some(line => /^Branches: 1\/2 ok/.test(line)), lines.join("\n"));
    assert.ok(lines.includes("  Join blocked by branch careful"), lines.join("\n"));
    assert.ok(lines.some(line => line.startsWith("  quick · ")), lines.join("\n"));
    assert.ok(lines.some(line => line.startsWith("  careful · ")), lines.join("\n"));
    assert.ok(!lines.some(line => /^\s+item \d/.test(line)), lines.join("\n"));
    // Slice 2: where each branch starts, by its name; a branch's end says its branch.
    assert.ok(lines.includes("Runs its branches (quick, careful) all at once, then joins them."), lines.join("\n"));
    assert.ok(lines.includes("  quick → quick_work · where branch quick starts"), lines.join("\n"));
    assert.ok(lines.includes("  careful → careful_work · where branch careful starts"), lines.join("\n"));
    assert.ok(!lines.some(line => line.includes("each item")), lines.join("\n"));
    store.dispatch({ type: "ui/modal", modal: { ...store.getState().ui.modal, selectedNodeId: "careful_end", detailsScroll: 0 } });
    const end = selectWorkflowViewModal(store.getState(), 120).detailsLines.map(line => line.text);
    assert.ok(end.includes("Branch careful ends here."), end.join("\n"));
    assert.ok(end.some(line => /^Ends branch careful: /.test(line)), end.join("\n"));
    store.dispatch({ type: "ui/modal", modal: { ...store.getState().ui.modal, selectedNodeId: "careful_work", detailsScroll: 0 } });
    const work = selectWorkflowViewModal(store.getState(), 120).detailsLines.map(line => line.text);
    assert.ok(work.includes("  ✕ error → branch ends"), work.join("\n"));
    // The list shows each branch's steps together, lane by lane, after the parallel step.
    const order = workflowViewNodes(projectWorkflowV2({ readModel: shown })).map(entry => entry.id);
    assert.deepEqual(order.slice(order.indexOf("views"), order.indexOf("views") + 5), ["views", "quick_work", "quick_end", "careful_work", "careful_end"]);
});

test("the graph draws named branches as lanes side by side in one box, each entered by an edge with its name", () => {
    // A longer careful lane: its tops still line up with quick's.
    const longer = states.map(node => (node.id === "views" ? { ...node,
        branches: [node.branches[0], { name: "careful", initial: "careful_prep", states: ["careful_prep", "careful_work", "careful_end"] }],
        body: { initial: "quick_work", states: ["quick_work", "quick_end", "careful_prep", "careful_work", "careful_end"] } } : node));
    longer.splice(3, 0, { id: "careful_prep", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["ok"], next: { ok: "careful_work" },
        parallel: "views", branchName: "careful" });
    const layout = layoutWorkflowGraphTB(workflowV2Definition({ revision: 1, initial: "views", states: longer }));
    const group = layout.groups.get("views");
    assert.deepEqual(group.lanes, ["quick", "careful"]);
    assert.equal(group.stack, 0, "lanes, not a stack of items");
    // No edge into the box itself: one edge into each lane, from the parallel step, labelled with the branch's name.
    assert.equal(layout.edges.some(edge => edge.to === workflowGroupId("views")), false);
    const lanes = layout.edges.filter(edge => edge.branch && edge.lane !== undefined);
    assert.deepEqual(lanes.map(edge => [edge.from, edge.to, edge.lane, edge.labelText, edge.kind]),
        [["views", "quick_work", "quick", "quick", "branch"], ["views", "careful_prep", "careful", "careful", "branch"]]);
    const at = id => layout.positions.get(id);
    // Side by side in declared order, their first steps on one row, inside the box under its label row.
    assert.ok(at("quick_work").x + at("quick_work").width <= at("careful_prep").x, "quick's lane stands left of careful's");
    assert.equal(at("quick_work").y, at("careful_prep").y);
    for (const id of ["quick_work", "quick_end", "careful_prep", "careful_work", "careful_end"]) {
        const box = at(id);
        assert.ok(box.x >= group.x && box.x + box.width <= group.x + group.width && box.y >= group.y + WORKFLOW_GRAPH_GROUP_HEADER
            && box.y + box.height <= group.y + group.height, id);
    }
    assert.equal(at("quick_end").x, at("quick_work").x, "a lane is a column");
    for (const edge of lanes) {
        const parallel = at("views"), first = at(edge.to);
        assert.deepEqual(edge.points[0], [parallel.x + parallel.width / 2, parallel.y + parallel.height], "it leaves the parallel step");
        assert.deepEqual(edge.points.at(-1), [first.x + first.width / 2, first.y], "it reaches its lane's first step");
        assert.ok(edge.labelY > group.y + WORKFLOW_GRAPH_GROUP_HEADER && edge.labelY < first.y, "its name sits in the lane, above its first step");
        assert.ok(edge.labelX > first.x && edge.labelX < first.x + first.width, "over its lane");
    }
    // Each lane's end leads straight down to the join bar, and says its branch.
    const ends = layout.edges.filter(edge => edge.join);
    assert.deepEqual(ends.map(edge => [edge.from, edge.lane]), [["quick_end", "quick"], ["careful_end", "careful"]]);
    assert.equal(ends[0].points[0][0], at("quick_end").x + at("quick_end").width / 2);
    // The box and the edges in words.
    const box = renderToStaticMarkup(React.createElement(WorkflowGroupBox, { group }));
    assert.match(box, /class="ps-workflow-group is-idle is-named"/);
    assert.match(box, /aria-label="Branches of views \(quick, careful\)"/);
    assert.match(box, /title="Each branch of views runs its own nodes: quick, careful\."/);
    assert.match(box, /<span class="ps-workflow-group-label">Branches<\/span>/);
    const edge = renderToStaticMarkup(React.createElement("svg", null, React.createElement(WorkflowEdgeShape, { edge: lanes[0] })));
    assert.match(edge, /aria-label="views: branch quick starts at quick_work"/);
    assert.match(edge, /<title>Branch quick starts here<\/title>quick|>quick<title>Branch quick starts here<\/title>/);
    assert.match(renderToStaticMarkup(React.createElement("svg", null, React.createElement(WorkflowEdgeShape, { edge: ends[1] }))),
        /aria-label="careful_end: branch careful ends at the join of views"/);
    // A For each keeps its box with a stack, entered by one edge without a label.
    const forEach = layoutWorkflowGraphTB(workflowV2Definition({ revision: 1, initial: "fan", states: [
        { id: "fan", type: "parallel", forEach: { count: 2 }, concurrency: 2, join: "all_required", failFast: false,
            body: { initial: "work", states: ["work", "end"] }, outcomes: ["joined", "blocked"], next: { joined: "done", blocked: "done" } },
        { id: "work", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["ok"], next: { ok: "end" }, parallel: "fan" },
        { id: "end", type: "terminal", outcome: "succeeded", parallel: "fan" },
        { id: "done", type: "terminal", outcome: "succeeded" },
    ] }));
    assert.equal(forEach.groups.get("fan").stack > 0, true);
    assert.equal(Object.hasOwn(forEach.groups.get("fan"), "lanes"), false);
    assert.deepEqual(forEach.edges.filter(item => item.branch).map(item => [item.to, item.labelText]), [[workflowGroupId("fan"), ""]]);
});

test("the card, the box, a blocked join, why a visit was canceled and the replay say branch and its name", () => {
    const definition = workflowV2Definition(graph);
    const node = id => definition.states.find(item => item.id === id);
    assert.equal(workflowV2NodeLabel(node("views")), "Branches · all at once");
    assert.equal(workflowV2NodeLabel({ ...node("views"), concurrency: 1 }), "Branches · one at a time");
    assert.equal(workflowV2NodeLabel({ ...node("views"), namedBranches: [...node("views").namedBranches, { name: "third", initial: "x", states: ["x"] }] }),
        "Branches · up to 2 at a time");
    assert.match(workflowV2NodeLabel(node("quick_end")), /^Branch ends · /);
    assert.match(workflowV2NodeLabel({ ...node("quick_end"), branchName: undefined }), /^Item ends · /);
    // A blocked join of named branches; its box says "Branches".
    const projection = projectWorkflowV2({ readModel: model() });
    const views = projection.nodes.find(item => item.id === "views");
    assert.equal(views.stateLabel, "Done · blocked, a branch failed");
    assert.equal(views.joinBar.group.label, "Branches");
    // Every visit in a branch carries its branch's name.
    assert.deepEqual(projection.allExecutions.filter(item => item.branch).map(item => [item.stateId, item.branch.name]),
        [["quick_work", "quick"], ["quick_end", "quick"], ["careful_work", "careful"]]);
    // A visit canceled by the join or another branch's failure says "branch".
    const canceled = winner => projectWorkflowV2({ readModel: readModel({ graph, run: { status: "completed", outcome: "blocked" }, nodeExecutions: [
        done("views", 1, "blocked", { branches: 2 }),
        done("careful_work", 1, "cancelled", { nodeExecutionId: "nx-careful-work", resultKind: "runtime_error", winner, ...branch(1) }),
    ] }) }).allExecutions.find(item => item.id === "nx-careful-work");
    assert.equal(workflowV2VisitEnding(canceled("fail_fast")).why, "Another branch failed, so this one was canceled");
    assert.equal(workflowV2VisitEnding(canceled("join")).why, "The join already had the successes it needs, so this branch was canceled");
    assert.equal(workflowV2VisitEnding(canceled("join_timeout")).why, "The parallel node's limit passed, so this branch was canceled");
    // A For each's item keeps its words.
    const { name: _name, ...unnamed } = canceled("fail_fast").branch;
    assert.equal(workflowV2VisitEnding({ ...canceled("fail_fast"), branch: unnamed }).why, "Another item failed, so this one was canceled");
    // The replay names the branch.
    const timed = projectWorkflowV2({ readModel: readModel({ graph, run: { status: "running" }, nodeExecutions: [
        { ...done("views", 1, "joined", { branches: 2 }), state: "pending", outcome: null, resultKind: null, winner: null, enteredAt: "2026-11-08T01:00:00.000Z" },
        { ...done("careful_work", 1, "ok", { nodeExecutionId: "nx-careful-work", ...branch(1) }), enteredAt: "2026-11-08T01:00:01.000Z" },
    ] }) });
    const frames = workflowV2ReplayFrames(timed.allExecutions);
    assert.deepEqual(frames.map(frame => [frame.stateId, frame.branchIndex, frame.branchName]), [["views", null, null], ["careful_work", 1, "careful"]]);
    assert.equal(workflowV2ReplayLabel(frames[1]), "01:00:01 · careful_work visit 1 · branch careful");
    assert.equal(workflowV2ReplayLabel({ ...frames[1], branchName: null }), "01:00:01 · careful_work visit 1 · item 2");
    // The Log names the branches a cut canceled (the event names them for named branches only).
    assert.equal(workflowEventText("workflow.branches_cancelled", { reason: "join", branches: ["careful"] }).text, "⊘ Canceled branch careful · the join had enough");
    assert.equal(workflowEventText("workflow.branches_cancelled", { reason: "timeout", branches: ["quick", "careful"] }).text,
        "⊘ Canceled branches quick, careful · the parallel node's limit passed");
    assert.equal(workflowEventText("workflow.branches_cancelled", { branches: ["quick"] }).text, "⊘ Canceled branch quick · another branch failed");
    assert.equal(workflowEventText("workflow.branches_cancelled", { reason: "join" }).text, "⊘ Other items canceled · the join had enough");
    // The start's table in the session's chat says "Branches" for the parallel state.
    const table = formatWorkflowEventText({ eventType: "workflow.started", data: { name: "two-views", initial: "views", states } });
    assert.match(table, /\| `?views`? \| Branches \|/);
    assert.doesNotMatch(table, /For each/);
});

test("NB-R7: a named fork's branch results say branch: canceled rows, the limit notices, the first column and the TUI", () => {
    const timedOut = (winner, outcome = "timed_out") => readModel({ graph, run: { status: "completed", outcome: "blocked" }, nodeExecutions: [
        done("views", 1, outcome, { branches: 2, ...(outcome === "timed_out" ? { resultKind: "runtime_error",
            errorPreview: JSON.stringify({ code: "timed_out", message: "The parallel state's time limit passed before its join." }) } : {}) }),
        done("quick_work", 1, "ok", { nodeExecutionId: "nx-quick-work", ...branch(0) }),
        done("quick_end", 2, "succeeded", { nodeExecutionId: "nx-quick-end", outputPreview: "\"q\"", ...branch(0) }),
        done("careful_work", 1, "cancelled", { nodeExecutionId: "nx-careful-work", resultKind: "runtime_error", winner, ...branch(1),
            errorPreview: JSON.stringify({ code: "cancelled", message: "cut" }) }),
    ] });
    const views = model => projectWorkflowV2({ readModel: model }).nodes.find(node => node.id === "views");
    // A row canceled by another branch's failure, or by the fork's own limit, says branch.
    const failFast = views(timedOut("fail_fast", "blocked"));
    assert.equal(failFast.evidence.rows[1].why, "Another branch failed, so this one was canceled");
    const limit = views(timedOut("join_timeout"));
    assert.equal(limit.evidence.rows[1].why, "The parallel node's limit passed, so this branch was canceled");
    assert.equal(limit.evidence.timedOut, true);
    const html = renderToStaticMarkup(React.createElement(WorkflowV2NodeSummary, { selected: limit, nodes: [], select: () => {} }));
    assert.match(html, /The limit passed before the join: running branches canceled; waiting branches not started\./);
    assert.match(html, /<th>Branch<\/th><th>Node<\/th>/);
    assert.ok(!/items|<th>#<\/th>|Another item|For each node/.test(html), html);
    // After the limit, with enough successes: the joined notice says branches too.
    const joined = renderToStaticMarkup(React.createElement(WorkflowV2NodeSummary, { selected: { ...limit, evidence: { ...limit.evidence, timedOut: false,
        joinedAfterLimit: true } }, nodes: [], select: () => {} }));
    assert.match(joined, /The limit passed after enough branches succeeded: the join used them; running branches canceled\./);
    // A For each keeps its words.
    const forEachEvidence = { ...limit.evidence, names: null, rows: limit.evidence.rows.map(({ name: _name, ...row }) => row) };
    const forEach = renderToStaticMarkup(React.createElement(WorkflowV2NodeSummary, { selected: { ...limit, namedBranches: undefined, evidence: forEachEvidence },
        nodes: [], select: () => {} }));
    assert.match(forEach, /running items canceled; waiting items not started/);
    assert.match(forEach, /<th>#<\/th>/);
});

test("NB-R7 in the terminal: detail lines say branch for a named fork's rows, the limit and the rows not shown", async () => {
    // Thirteen named branches, b1 to b13, each a script then its end; the fork joined after its limit had cut b1.
    const names = Array.from({ length: 13 }, (_, index) => `b${index + 1}`);
    const many = [
        { id: "views", type: "parallel", concurrency: 13, join: { first: 12 }, failFast: false, timeoutSeconds: 60,
            branches: names.map(name => ({ name, initial: `${name}_work`, states: [`${name}_work`, `${name}_end`] })),
            body: { initial: "b1_work", states: names.flatMap(name => [`${name}_work`, `${name}_end`]) },
            outcomes: ["joined", "blocked"], next: { joined: "done", blocked: "failed", timed_out: "failed" } },
        ...names.flatMap(name => [
            { id: `${name}_work`, type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["ok"], next: { ok: `${name}_end` }, parallel: "views", branchName: name },
            { id: `${name}_end`, type: "terminal", outcome: "succeeded", parallel: "views", branchName: name },
        ]),
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ];
    const at = index => ({ scopeId: `nx-views-1#${index}`, branch: { parallelNodeExecutionId: "nx-views-1", index } });
    const shown = readModel({ graph: { revision: 1, initial: "views", states: many }, run: { status: "completed", outcome: "succeeded" }, nodeExecutions: [
        done("views", 1, "joined", { branches: 13 }),
        done("b1_work", 1, "cancelled", { nodeExecutionId: "nx-b1-work", resultKind: "runtime_error", winner: "join_timeout", ...at(0),
            errorPreview: JSON.stringify({ code: "cancelled", message: "cut" }) }),
        ...names.slice(1).flatMap((name, index) => [
            done(`${name}_work`, 1, "ok", { nodeExecutionId: `nx-${name}-work`, ...at(index + 1) }),
            done(`${name}_end`, 2, "succeeded", { nodeExecutionId: `nx-${name}-end`, ...at(index + 1) }),
        ]),
    ] });
    const transport = { getSessionEventsBefore: async () => [], readWorkflow: async () => shown };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: views", status: "completed", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: shown, readModelRunId: null } });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    store.dispatch({ type: "ui/modal", modal: { ...store.getState().ui.modal, selectedNodeId: "views", detailsScroll: 0 } });
    const lines = selectWorkflowViewModal(store.getState(), 160, 200).detailsLines.map(line => line.text);
    assert.ok(lines.includes("  Limit passed after enough branches succeeded; the join used them."), lines.join("\n"));
    assert.ok(lines.includes("  … 1 more branch · the portal lists them all"), lines.join("\n"));
    assert.ok(!lines.some(line => /items|Another item|For each node/.test(line)), lines.join("\n"));
    // The row of the branch the limit cut says branch (the twelve shown are b1 to b12; b13 is the one not shown).
    assert.ok(lines.some(line => line.startsWith("  b1 · ") && line.endsWith("the parallel node's limit passed, so this branch was canceled")), lines.join("\n"));
});
