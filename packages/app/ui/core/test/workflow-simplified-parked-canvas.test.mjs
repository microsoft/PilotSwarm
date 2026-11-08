/**
 * Workflow Simplified, review UI-6: switching an ordinary chat's right block Canvas -> Workflow -> Canvas keeps its canvas
 * page. The Workflow tab parks the chat's CanvasFrame (mounted, off to the side) as the Workspace tab does; only a
 * Workflow that is itself the active session (its owner not loaded) replaces the frame with "shown in the middle".
 *
 * Run: node --test ui/core/test/workflow-simplified-parked-canvas.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { activeSessionIsWorkflowSession } from "../../react/src/web-app.js";

const stateOf = (activeKind, sidePaneTab) => ({
    sessions: { activeSessionId: "s-1", byId: { "s-1": { sessionId: "s-1", sessionKind: activeKind } } },
    ui: { canvasOpen: true, sidePaneTab },
});

test("the Workflow tab beside a chat is not a workflow session: the chat's canvas frame stays mounted", () => {
    assert.equal(activeSessionIsWorkflowSession(stateOf(undefined, "workflow")), false);
    assert.equal(activeSessionIsWorkflowSession(stateOf(undefined, "canvas")), false);
    assert.equal(activeSessionIsWorkflowSession(stateOf("workflow", "canvas")), true, "a Workflow that is the active session");
});

test("the canvas pane decides the placeholder by the active session, not by the side tab", () => {
    const webApp = fs.readFileSync(new URL("../../react/src/web-app.js", import.meta.url), "utf8");
    assert.match(webApp, /const activeWorkflow = useControllerSelector\(controller, activeSessionIsWorkflowSession\);/);
    assert.doesNotMatch(webApp, /const activeWorkflow = useControllerSelector\(controller, activeSessionIsWorkflow\);/);
});
