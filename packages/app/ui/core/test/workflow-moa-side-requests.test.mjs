/**
 * Adversarial review UI-2: in a Master of Agents dashboard a workflow panel has no side pane of its own, so its panel
 * buttons and a step's details went nowhere. The panel now hands the request to its host, which opens the workflow in
 * the workspace on the same panel, step and run, with any unsaved YAML (bound to its session).
 *
 * Run: node --test test/workflow-moa-side-requests.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workflowDraftHandoff, workflowSideHandoffView } from "../src/moa.js";
import { appReducer, createInitialState, createStore } from "../src/index.js";
import { fileURLToPath } from "node:url";

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("the workflow pane hands panel and step-details requests to a host that has no side pane", () => {
    const workspace = read("../../react/src/workflow-workspace.js");
    assert.match(workspace, /export function WorkflowMainPane\(\{ controller, icon, onNodeSelected, mobile = false, onOpenSide = null \}\)/);
    assert.match(workspace, /onClick: \(\) => \(onOpenSide \? onOpenSide\(\{ sessionId, panel, nodeId: selected\?\.id \?\? null \}\)/);
    assert.match(workspace, /if \(onOpenSide && \(open \|\| id === view\.selectedNodeId\)\) \{\s*select\(id, \{ open: false \}\);\s*onOpenSide\(\{ sessionId, panel: null, nodeId: id \}\);/);
    // Workflow Simplified (spec 18): a Master of Agents panel that holds a Workflow shows the Workflow tab, as the portal
    // does; the old workflow pane is no longer mounted there.
    const webApp = read("../../react/src/web-app.js");
    assert.doesNotMatch(webApp, /WorkflowMainPane/);
    assert.match(webApp, /function ChatPane\(props\) \{[\s\S]*?return React\.createElement\(WorkflowTab, \{ controller: props\.controller, mobile: Boolean\(props\.mobile\) \}\);\s*\}/);
});

test("a Master of Agents panel opens the workflow in the workspace on that panel, step, run and unsaved YAML", () => {
    const moa = read("../../../web/src/moa/MoaWorkspace.jsx");
    assert.match(moa, /onWorkflowOpenSide=\{onWorkflowSide \? request => onWorkflowSide\(ready, request\) : null\}/);
    assert.match(moa, /onWorkflowSide=\{\(child, request\) => openWorkflowSide\(node, child, request\)\}/);
    const body = moa.slice(moa.indexOf("const openWorkflowSide = "), moa.indexOf("const zoom = (node, artifact = null) => {"));
    for (const part of ["zoom(node);", "view: workflowSideHandoffView({ request, childView, draft })",
        "workflowDraftHandoff({ sessionId, buffer: child?.workflowDraftBuffers?.get(sessionId) ?? null, saved: childView.draftEdit ?? null })",
        "type: \"ui/sidePaneTab\", tab: \"canvas\"",
        "type: \"canvas/flip\", sessionId, slot: 1"]) {
        assert.ok(body.includes(part), part);
    }
    const panels = read("../../react/src/workflow-v2-panels.js");
    assert.match(panels, /controller\.workflowDraftBuffers\.set\(sessionId, \{ sessionId, base, text: textValue \}\)/);
});

// Verification VR-6 (M-14): a clean live buffer is authoritative; it never brings back a discarded saved edit.
test("VR-6: the live buffer decides what edit is handed over; the saved one only when no live buffer exists", () => {
    const base = { sessionId: "wf-1", revision: 2, yaml: "a: 1\n" };
    const dirty = { sessionId: "wf-1", base, text: "a: 2\n" };
    const clean = { sessionId: "wf-1", base, text: "a: 1\n" };
    const saved = { sessionId: "wf-1", base, text: "a: 3\n" };
    assert.deepEqual(workflowDraftHandoff({ sessionId: "wf-1", buffer: dirty, saved }), { draftEdit: dirty, draftDirty: true });
    // Discarded in the live editor: the stale saved edit is not resurrected, and nothing is handed over (E2-R4: the
    // workspace's own unsaved edit is not erased).
    assert.equal(workflowDraftHandoff({ sessionId: "wf-1", buffer: clean, saved }), null);
    assert.deepEqual(workflowDraftHandoff({ sessionId: "wf-1", buffer: null, saved }), { draftEdit: saved, draftDirty: true });
    assert.equal(workflowDraftHandoff({ sessionId: "wf-1", buffer: null, saved: null }), null);
    // Another session's buffer or saved edit never counts.
    assert.equal(workflowDraftHandoff({ sessionId: "wf-2", buffer: dirty, saved }), null);
});

test("VR-6: Discard edits drops the saved edit from the view too", () => {
    const panels = read("../../react/src/workflow-v2-panels.js");
    assert.match(panels, /setTextValue\(base\.yaml\);\s*controller\.dispatch\(\{ type: "ui\/workflowView", sessionId, view: \{ draftEdit: null, draftDirty: false \} \}\);/);
});

// Verification of VR-6 in E2 (E2-R4; test E2-T9): opening the workflow from a panel whose editor is clean keeps the main
// workspace's own unsaved edit; a changed panel edit is handed over as unsaved.
test("E2-T9: a clean panel buffer hands over nothing, so the workspace keeps its own unsaved edit; a changed one is handed over", async () => {
    const { appReducer, createInitialState } = await import("../src/index.js");
    const base = { sessionId: "wf-1", revision: 2, yaml: "a: 1\n" };
    const own = { sessionId: "wf-1", base, text: "a: own\n" };
    let state = appReducer(createInitialState(), { type: "sessions/loaded", sessions: [{ sessionId: "wf-1", sessionKind: "workflow", title: "W" }] });
    state = appReducer(state, { type: "ui/workflowView", sessionId: "wf-1", view: { draftEdit: own, draftDirty: true } });
    const open = (buffer, saved = null) => {
        const draft = workflowDraftHandoff({ sessionId: "wf-1", buffer, saved });
        return appReducer(state, { type: "ui/workflowView", sessionId: "wf-1", view: { sidePanel: null, ...(draft ?? {}) } }).ui.workflowViews["wf-1"];
    };
    // A clean panel buffer (and a discarded panel edit): the workspace's own edit stays, unsaved.
    assert.deepEqual([open({ sessionId: "wf-1", base, text: "a: 1\n" }).draftEdit, open({ sessionId: "wf-1", base, text: "a: 1\n" }).draftDirty], [own, true]);
    assert.equal(open({ sessionId: "wf-1", base, text: "a: 1\n" }, { sessionId: "wf-1", base, text: "a: stale\n" }).draftEdit, own);
    // A changed panel buffer: handed over, unsaved.
    const changed = { sessionId: "wf-1", base, text: "a: panel\n" };
    assert.deepEqual([open(changed).draftEdit, open(changed).draftDirty], [changed, true]);
});

// Adversarial review R2-UI-2: the workspace last showed a test run of the workflow; a dashboard panel that never chose a
// run (the live run) opens its step details there. The workspace must show the live run, not keep its test run.
test("R2-UI-2: a panel on the live run opens the live run in a workspace that showed a test run; a chosen run is kept", () => {
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: review", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { selectedRunId: "test-run-7", mainTab: "yaml", sidePanel: "calls" } });
    assert.equal(store.getState().ui.workflowViews.wf.selectedRunId, "test-run-7");
    const draft = { draftEdit: { sessionId: "wf", text: "a: 2\n" }, draftDirty: true };
    const handed = workflowSideHandoffView({ request: { sessionId: "wf", panel: "details", nodeId: "review" }, childView: {}, draft });
    assert.deepEqual(handed, { sidePanel: "details", selectedNodeId: "review", selectedRunId: null, mainTab: "graph", ...draft });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: handed });
    const view = store.getState().ui.workflowViews.wf;
    assert.deepEqual([view.selectedRunId, view.mainTab, view.sidePanel, view.selectedNodeId], [null, "graph", "details", "review"]);
    // A panel that chose a run, and the YAML tab, hands them over; a step log request names no step.
    assert.deepEqual(workflowSideHandoffView({ request: { panel: "log" }, childView: { selectedRunId: "run-3", mainTab: "yaml" } }),
        { sidePanel: "log", selectedRunId: "run-3", mainTab: "yaml" });
    assert.deepEqual(workflowSideHandoffView({}), { sidePanel: null, selectedRunId: null, mainTab: "graph" });
});
