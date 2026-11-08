/**
 * Owner, 2026-11-07T16:29Z (OF-S2-1): "in the full screen and zen mode, lets move the bottom panel to a right panel of the
 * workflow window." On a desktop in full screen or zen, the panel (Node, Log, Variables; Node, Revisions) is a column to
 * the right of the graph with the same tabs, content and open state; its width is remembered in the profile settings
 * (workflowPanelWidths: { desktop }, a JSON value; no schema change). Normal mode and the phone keep the bottom panel.
 * The mounted cases (place, resize, persistence, both tab sets) are the browser specs "OF-S2-1".
 *
 * Run: node --test ui/core/test/workflow-simplified-side-panel.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { appReducer, createInitialState } from "../src/index.js";
import {
    normalizeWorkflowPanelWidths, workflowPanelIsSide, workflowPanelWidth, WORKFLOW_GRAPH_MIN_WIDTH, WORKFLOW_PANEL_WIDTH_DEFAULT,
    WORKFLOW_PANEL_WIDTH_MIN,
} from "../src/workflow-owner.js";
import { BottomPanel, WorkflowStage, workflowGraphMode } from "../../react/src/workflow-tab.js";

test("the side panel is a desktop's, in full screen or zen only", () => {
    assert.equal(workflowPanelIsSide("full", false), true);
    assert.equal(workflowPanelIsSide("zen", false), true);
    assert.equal(workflowPanelIsSide("normal", false), false);
    assert.equal(workflowPanelIsSide("full", true), false, "a phone's maximize keeps the bottom sheet");
    assert.equal(workflowPanelIsSide("zen", true), false);
    assert.equal(workflowPanelIsSide(undefined, false), false);
});

test("widths are whole pixels in range; the default, the minimum and the room the graph leaves bound them", () => {
    assert.deepEqual([WORKFLOW_PANEL_WIDTH_DEFAULT, WORKFLOW_PANEL_WIDTH_MIN, WORKFLOW_GRAPH_MIN_WIDTH], [400, 280, 360]);
    assert.deepEqual(normalizeWorkflowPanelWidths({ desktop: 512.6, phone: 300 }), { desktop: 513 });
    assert.deepEqual(normalizeWorkflowPanelWidths({ desktop: 200 }), {});
    assert.deepEqual(normalizeWorkflowPanelWidths({ desktop: "nope" }), {});
    assert.deepEqual(normalizeWorkflowPanelWidths(null), {});
    assert.deepEqual(normalizeWorkflowPanelWidths([400]), {});
    assert.equal(workflowPanelWidth({}), 400);
    assert.equal(workflowPanelWidth({ desktop: 640 }), 640);
    assert.equal(workflowPanelWidth({ desktop: 640 }, 500), 500, "never past the room the graph leaves");
    assert.equal(workflowPanelWidth({ desktop: 640 }, 100), WORKFLOW_PANEL_WIDTH_MIN, "never under the minimum");
});

test("the reducer keeps the width; null forgets it; a profile read brings it back and leaves it when absent", () => {
    let state = createInitialState({ workflowsEnabled: true, mode: "api" });
    assert.deepEqual(state.ui.workflowPanelWidths, {});
    state = appReducer(state, { type: "ui/workflowPanelWidth", width: 480 });
    assert.deepEqual(state.ui.workflowPanelWidths, { desktop: 480 });
    assert.equal(appReducer(state, { type: "ui/workflowPanelWidth", width: 480 }), state, "no change, no new state");
    state = appReducer(state, { type: "ui/workflowPanelWidth", width: null });
    assert.deepEqual(state.ui.workflowPanelWidths, {});
    state = appReducer(state, { type: "profileSettings/apply", settings: { workflowPanelWidths: { desktop: 520 } } });
    assert.deepEqual(state.ui.workflowPanelWidths, { desktop: 520 });
    const untouched = appReducer(state, { type: "profileSettings/apply", settings: { themeId: "terminal-green" } });
    assert.deepEqual(untouched.ui.workflowPanelWidths, { desktop: 520 }, "a profile without the key leaves it");
    // The bottom panel's heights are separate.
    assert.deepEqual(untouched.ui.workflowPanelHeights, {});
});

test("the portal saves and reads the width with the profile settings", () => {
    const webApp = fs.readFileSync(new URL("../../react/src/web-app.js", import.meta.url), "utf8");
    assert.match(webApp, /normalized\.workflowPanelWidths = normalizeWorkflowPanelWidths\(candidate\.workflowPanelWidths\)/);
    assert.match(webApp, /\{ workflowPanelWidths: state\.workflowPanelWidths \}/);
    assert.match(webApp, /\{ workflowPanelWidths: normalizedRemote\.workflowPanelWidths \}/);
    assert.match(webApp, /workflowPanelWidths: rootState\.ui\.workflowPanelWidths,/);
    assert.match(webApp, /state\.workflowPanelHeights, state\.workflowPanelWidths\]\);/);
});

const controllerWith = (state) => ({ getState: () => state, subscribe: () => () => {}, dispatch: () => {} });
const render = element => renderToStaticMarkup(element);

test("beside the graph: the panel follows it in a split; closed, a strip of stacked tabs; normal mode is as before", () => {
    const state = appReducer(createInitialState({ workflowsEnabled: true, mode: "api" }), { type: "ui/workflowPanelWidth", width: 460 });
    const controller = controllerWith(state);
    const panels = ["node", "log", "variables"];
    const graph = React.createElement("div", { className: "ps-wf-main" }, "graph");
    const replay = React.createElement("div", { className: "ps-wf-replay" }, "replay");
    // Side, open: graph and replay in the graph's column, the panel to its right with its width and a vertical handle.
    const open = render(React.createElement(WorkflowStage, { side: true,
        panel: React.createElement(BottomPanel, { controller, panels, panel: "log", onPanel() {}, mobile: false, side: true }, "LOG BODY") }, graph, replay));
    assert.match(open, /^<div class="ps-wf-split" data-panel-place="side"><div class="ps-wf-split-graph"><div class="ps-wf-main">graph<\/div><div class="ps-wf-replay">replay<\/div><\/div><div class="ps-wf-panel is-side" data-panel="log" style="width:460px">/);
    assert.match(open, /role="separator"[^>]*aria-orientation="vertical"[^>]*aria-label="Resize the side panel"[^>]*aria-valuemin="280"[^>]*aria-valuenow="460"/);
    assert.match(open, /class="ps-wf-panel-resize is-vertical"/);
    assert.match(open, /aria-label="Close the panel"/);
    assert.ok(open.includes("LOG BODY"));
    for (const name of ["Node", "Log", "Variables"]) assert.match(open, new RegExp(`role="tab"[^>]*>${name}<`));
    // Side, closed: the strip, its tabs stacked, no body.
    const closed = render(React.createElement(WorkflowStage, { side: true,
        panel: React.createElement(BottomPanel, { controller, panels: ["node", "revisions"], panel: null, onPanel() {}, mobile: false, side: true }, "BODY") }, graph));
    assert.match(closed, /<div class="ps-wf-panel is-side is-closed"><div class="ps-wf-panel-tabs" role="tablist" aria-label="Workflow panel" aria-orientation="vertical">/);
    assert.ok(!closed.includes("BODY"));
    assert.match(closed, />Revisions</);
    // Normal mode: no split; the panel under the graph with its height and its horizontal handle, exactly as before.
    const normal = render(React.createElement("div", { className: "ps-wf-body" }, React.createElement(WorkflowStage, { side: false,
        panel: React.createElement(BottomPanel, { controller, panels, panel: "node", onPanel() {}, mobile: false, side: false }, "NODE BODY") }, graph, replay)));
    assert.match(normal, /^<div class="ps-wf-body"><div class="ps-wf-main">graph<\/div><div class="ps-wf-replay">replay<\/div><div class="ps-wf-panel" data-panel="node" style="height:280px">/);
    assert.ok(!normal.includes("ps-wf-split"));
    assert.match(normal, /aria-orientation="horizontal"[^>]*aria-label="Resize the bottom panel"/);
    // A phone asked for the side keeps its sheet.
    const phone = render(React.createElement(BottomPanel, { controller, panels, panel: "node", onPanel() {}, mobile: true, side: true }, "SHEET"));
    assert.match(phone, /^<div class="ps-wf-panel is-sheet" data-panel="node"/);
});

test("the graph fits again when the side panel opens or closes, through its display mode (F8); normal mode keeps its mode", () => {
    assert.equal(workflowGraphMode("full", true, true), "full:panel");
    assert.equal(workflowGraphMode("full", true, false), "full");
    assert.equal(workflowGraphMode("zen", true, true), "zen:panel");
    assert.equal(workflowGraphMode("normal", false, true), "normal");
    assert.equal(workflowGraphMode("full", false, true), "full", "a phone's maximize, as before");
});

test("each view that has the panel takes the side place and fits its graph by it", () => {
    const tab = fs.readFileSync(new URL("../../react/src/workflow-tab.js", import.meta.url), "utf8");
    const chat = fs.readFileSync(new URL("../../react/src/workflow-chat-tab.js", import.meta.url), "utf8");
    assert.equal((tab.match(/const side = workflowPanelIsSide\(displayMode, mobile\);/g) ?? []).length, 2, "DefinitionView and WorkflowRunView");
    assert.equal((chat.match(/const side = workflowPanelIsSide\(displayMode, mobile\);/g) ?? []).length, 1, "ChatDefinitionView");
    assert.equal((tab.match(/h\(WorkflowStage, \{ side, panel: h\(BottomPanel, \{/g) ?? []).length, 2);
    assert.equal((chat.match(/h\(WorkflowStage, \{ side, panel: h\(BottomPanel, \{/g) ?? []).length, 1);
    assert.equal((tab.match(/mode: workflowGraphMode\(displayMode, side, Boolean\(panel\)\)/g) ?? []).length, 2);
    assert.equal((chat.match(/mode: workflowGraphMode\(displayMode, side, Boolean\(panel\)\)/g) ?? []).length, 1);
    // Every BottomPanel is given its place.
    for (const source of [tab, chat]) {
        const uses = source.match(/h\(BottomPanel, \{[^}]*\}/g) ?? [];
        assert.ok(uses.length > 0 && uses.every(use => /\bside\b/.test(use)), uses.join("\n"));
    }
});
