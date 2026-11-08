// The Workflow tab has the canvas's zen and full screen (owner, 2026-11-06T06:28Z: "need the full screen and zen mode
// buttons for the workflow tab as well, exact same behavior as the canvas"; replaces batch 6 f-02 and spec L1). One set
// of buttons and one pair of stored flags serve both, so switching between them keeps the mode; only a Workflow shown in
// the middle (its session is the active one) has neither. The browser test "zen and full screen" drives it end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activeSessionIsWorkflowSession } from "../../react/src/web-app.js";

const webApp = readFileSync(new URL("../../react/src/web-app.js", import.meta.url), "utf8");
const workflowTab = readFileSync(new URL("../../react/src/workflow-tab.js", import.meta.url), "utf8");
const chatTab = readFileSync(new URL("../../react/src/workflow-chat-tab.js", import.meta.url), "utf8");

test("only a Workflow shown in the middle turns zen and full screen off; the Workflow tab keeps them", () => {
    const gate = /function activeSessionIsWorkflow\(state\) \{\n\s*return activeSessionIsWorkflowSession\(state\);\n\}/;
    assert.match(webApp, gate);
    assert.doesNotMatch(webApp, /sidePaneTab === WORKFLOW_SIDE_TAB\);\n\}/, "the Workflow tab no longer turns them off");
    const state = (kind, tab) => ({ sessions: { activeSessionId: "s", byId: { s: { sessionId: "s", sessionKind: kind } } },
        ui: { canvasOpen: true, sidePaneTab: tab } });
    assert.equal(activeSessionIsWorkflowSession(state(undefined, "workflow")), false, "the Workflow tab beside a chat");
    assert.equal(activeSessionIsWorkflowSession(state("workflow", "canvas")), true, "a Workflow in the middle");
});

test("the Workflow tab gets the canvas's own buttons, and the toolbar keeps full screen across Canvas and Workflow", () => {
    // One definition of each button, used by the canvas header and handed to the Workflow tab.
    for (const name of ["zenButton", "fullScreenButton", "phoneMaximizeButton"]) {
        assert.equal((webApp.match(new RegExp(`const ${name} = \\(\\) =>`, "g")) ?? []).length, 1, name);
    }
    // Owner, 2026-11-06T19:40Z: the tab also gets the display mode (F8), and in full screen its own Exit full screen (F7).
    assert.match(webApp, /React\.createElement\(WorkflowTab, \{ controller, mobile, modeButtons: workflowModeButtons,\n[^\n]*\n\s*displayMode: maximized \? "full" : !mobile && zenOn \? "zen" : "normal" \}\)/);
    assert.match(webApp, /: maximized \? React\.createElement\(WorkflowToolButton, \{ label: "Exit full screen", glyph: "exit-full-screen"/);
    assert.match(webApp, /const header = onWorkflow && \(mobile \|\| !maximized\) \? null/, "full screen promotes the Workflow tab's controls too");
    assert.match(webApp, /def\.key === "canvas" \|\| def\.key === "workflow"/, "Canvas and Workflow switch without leaving full screen");
    // Stage 2.1b: WorkflowTab hands its props to the tab on a chat's definitions or to the stage 1 tab; both take the mode
    // buttons and the display mode, and put the buttons at the right end of their header.
    assert.match(workflowTab, /export function WorkflowTab\(props\) \{/);
    assert.match(workflowTab, /return h\(ChatWorkflowTab, \{ \.\.\.props, context, definitions, listError: entry\?\.error \?\? null \}\);/);
    assert.match(workflowTab, /return h\(StageOneWorkflowTab, props\);/);
    assert.match(workflowTab, /function StageOneWorkflowTab\(\{ controller, mobile = false, modeButtons = null, displayMode = "normal" \}\)/);
    assert.match(chatTab, /export function ChatWorkflowTab\(\{ controller, mobile = false, modeButtons = null, displayMode = "normal", context, definitions,/);
    // OF-S2-8: the chat's header places them after the row, or on a phone's first line beside the definition (`modes`).
    assert.match(workflowTab, /modeButtons \? h\("span", \{ className: "ps-wf-tab-modes" \}, modeButtons\) : null\),/);
    assert.match(chatTab, /const modes = modeButtons \? h\("span", \{ className: "ps-wf-tab-modes" \}, modeButtons\) : null;/);
    assert.match(chatTab, /wraps \? modes : null,\n\s*rest,\n\s*wraps \? null : modes\),/);
    // The labels are the canvas's.
    for (const label of ['"aria-label": zenOn ? "Leave zen mode" : "Zen mode"', '"aria-label": "Full screen canvas"',
        '"aria-label": maximized ? "Restore canvas" : "Maximize canvas"']) {
        assert.ok(webApp.includes(label), label);
    }
});
