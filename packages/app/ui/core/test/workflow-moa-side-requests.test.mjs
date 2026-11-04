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
import { workflowDraftHandoff } from "../src/moa.js";
import { fileURLToPath } from "node:url";

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("the workflow pane hands panel and step-details requests to a host that has no side pane", () => {
    const workspace = read("../../react/src/workflow-workspace.js");
    assert.match(workspace, /export function WorkflowMainPane\(\{ controller, icon, onNodeSelected, mobile = false, onOpenSide = null \}\)/);
    assert.match(workspace, /onClick: \(\) => \(onOpenSide \? onOpenSide\(\{ sessionId, panel, nodeId: selected\?\.id \?\? null \}\)/);
    assert.match(workspace, /if \(onOpenSide && \(open \|\| id === view\.selectedNodeId\)\) \{\s*select\(id, \{ open: false \}\);\s*onOpenSide\(\{ sessionId, panel: null, nodeId: id \}\);/);
    const webApp = read("../../react/src/web-app.js");
    assert.match(webApp, /onOpenSide: props\.onWorkflowOpenSide \?\? null/);
});

test("a Master of Agents panel opens the workflow in the workspace on that panel, step, run and unsaved YAML", () => {
    const moa = read("../../../web/src/moa/MoaWorkspace.jsx");
    assert.match(moa, /onWorkflowOpenSide=\{onWorkflowSide \? request => onWorkflowSide\(ready, request\) : null\}/);
    assert.match(moa, /onWorkflowSide=\{\(child, request\) => openWorkflowSide\(node, child, request\)\}/);
    const body = moa.slice(moa.indexOf("const openWorkflowSide = "), moa.indexOf("const zoom = (node, artifact = null) => {"));
    for (const part of ["zoom(node);", "sidePanel: request?.panel ?? null", "selectedNodeId: request.nodeId", "selectedRunId: childView.selectedRunId",
        "mainTab: childView.mainTab", "workflowDraftHandoff({ sessionId, buffer: child?.workflowDraftBuffers?.get(sessionId) ?? null, saved: childView.draftEdit ?? null })",
        "...(draft ?? {})", "type: \"ui/sidePaneTab\", tab: \"canvas\"",
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
    // Discarded in the live editor: the stale saved edit is not resurrected.
    assert.deepEqual(workflowDraftHandoff({ sessionId: "wf-1", buffer: clean, saved }), { draftEdit: null, draftDirty: false });
    assert.deepEqual(workflowDraftHandoff({ sessionId: "wf-1", buffer: null, saved }), { draftEdit: saved, draftDirty: true });
    assert.equal(workflowDraftHandoff({ sessionId: "wf-1", buffer: null, saved: null }), null);
    // Another session's buffer or saved edit never counts.
    assert.equal(workflowDraftHandoff({ sessionId: "wf-2", buffer: dirty, saved }), null);
});

test("VR-6: Discard edits drops the saved edit from the view too", () => {
    const panels = read("../../react/src/workflow-v2-panels.js");
    assert.match(panels, /setTextValue\(base\.yaml\);\s*controller\.dispatch\(\{ type: "ui\/workflowView", sessionId, view: \{ draftEdit: null, draftDirty: false \} \}\);/);
});
