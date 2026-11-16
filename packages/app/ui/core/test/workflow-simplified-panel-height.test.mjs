/**
 * The Workflow tab's bottom panel height (owner feedback 2026-11-06: "sizes of these bottom panels need to be
 * consistent… the box needs to be resizable"): one height per device class, set by the panel's handle, remembered in
 * the profile settings (workflowPanelHeights: { desktop, phone }, a JSON value; no schema change).
 *
 * Run: node --test test/workflow-simplified-panel-height.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { appReducer, createInitialState } from "../src/index.js";
import {
    normalizeWorkflowPanelHeights, workflowPanelHeight, WORKFLOW_PANEL_HEIGHT_DEFAULTS, WORKFLOW_PANEL_HEIGHT_MIN,
} from "../src/workflow-owner.js";

test("heights are whole pixels in range per device class; the default and the room bound them", () => {
    assert.deepEqual(normalizeWorkflowPanelHeights({ desktop: 300.4, phone: "410", other: 500 }), { desktop: 300, phone: 410 });
    assert.deepEqual(normalizeWorkflowPanelHeights({ desktop: 40, phone: 9_999 }), {});
    assert.deepEqual(normalizeWorkflowPanelHeights(null), {});
    assert.deepEqual(normalizeWorkflowPanelHeights([280]), {});
    assert.deepEqual(WORKFLOW_PANEL_HEIGHT_DEFAULTS, { desktop: 280, phone: 360 });
    assert.equal(workflowPanelHeight({}, "desktop"), 280);
    assert.equal(workflowPanelHeight({}, "phone"), 360);
    assert.equal(workflowPanelHeight({ desktop: 500 }, "desktop", 400), 400, "never past the room the graph leaves");
    assert.equal(workflowPanelHeight({ desktop: 500 }, "desktop", 60), WORKFLOW_PANEL_HEIGHT_MIN, "never under the minimum");
    assert.equal(workflowPanelHeight({ phone: 200 }, "desktop"), 280, "each device class keeps its own");
});

test("the reducer keeps one height per device class; null forgets it; a profile read brings them back", () => {
    let state = createInitialState({ mode: "api" });
    assert.deepEqual(state.ui.workflowPanelHeights, {});
    state = appReducer(state, { type: "ui/workflowPanelHeight", device: "desktop", height: 360 });
    state = appReducer(state, { type: "ui/workflowPanelHeight", device: "phone", height: 300 });
    assert.deepEqual(state.ui.workflowPanelHeights, { desktop: 360, phone: 300 });
    const same = appReducer(state, { type: "ui/workflowPanelHeight", device: "desktop", height: 360 });
    assert.equal(same, state, "no change, no new state");
    state = appReducer(state, { type: "ui/workflowPanelHeight", device: "desktop", height: null });
    assert.deepEqual(state.ui.workflowPanelHeights, { phone: 300 });
    state = appReducer(state, { type: "profileSettings/apply", settings: { workflowPanelHeights: { desktop: 420, phone: 50 } } });
    assert.deepEqual(state.ui.workflowPanelHeights, { desktop: 420 });
    const untouched = appReducer(state, { type: "profileSettings/apply", settings: { themeId: "terminal-green" } });
    assert.deepEqual(untouched.ui.workflowPanelHeights, { desktop: 420 }, "a profile without the key leaves them");
});

test("the portal saves and reads the heights with the profile settings", () => {
    const webApp = fs.readFileSync(new URL("../../react/src/web-app.js", import.meta.url), "utf8");
    assert.match(webApp, /normalized\.workflowPanelHeights = normalizeWorkflowPanelHeights\(candidate\.workflowPanelHeights\)/);
    assert.match(webApp, /\{ workflowPanelHeights: state\.workflowPanelHeights \}/);
    assert.match(webApp, /\{ workflowPanelHeights: normalizedRemote\.workflowPanelHeights \}/);
    assert.match(webApp, /workflowPanelHeights: rootState\.ui\.workflowPanelHeights,/);
    assert.match(webApp, /state\.workflowLayouts, state\.workflowPanelHeights[,\]]/);
    const tab = fs.readFileSync(new URL("../../react/src/workflow-tab.js", import.meta.url), "utf8");
    assert.match(tab, /role: "separator", tabIndex: 0, "aria-orientation": "horizontal",\s*"aria-label": "Resize the bottom panel"/);
    assert.match(tab, /style: \{ height: `\$\{height\}px` \}/);
});
