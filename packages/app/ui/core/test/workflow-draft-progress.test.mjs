// Owner batch 7 (H1): while the workflow's parent agent is still writing it, an invalid latest revision is said calmly,
// "The agent is still writing this workflow.", with its errors folded under "Revision N has K errors": no alert, and not
// counted on the Notices button. Once the agent is no longer in a turn, or with no parent agent, the invalid state is
// shown as before. Both are compact at the top of the pane (CSS: .ps-workflow-empty align-content: start).
//
// Run: node --test packages/app/ui/core/test/workflow-draft-progress.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    selectWorkflowViewSnapshot, workflowParentWorking, workflowViewSnapshotEqual, projectWorkflow, workflowDraftInProgress,
    workflowNoticeBadge, workflowNoticeCount, workflowRevisionErrorsText, workflowShownNotices,
} from "../src/workflow-view.js";
import { WorkflowTab } from "../../react/src/workflow-tab.js";
import { readModel } from "./workflow-fixtures.mjs";

const BAD = { severity: "error", code: "WORKFLOW_ROUTE_INVALID", path: "states.fan", message: "route goes nowhere", line: 7 };
/** A draft whose latest revision (2) does not compile yet: there is no graph to draw. */
const invalid = () => readModel({ noRun: true, graph: null,
    definition: { state: "draft", currentRevision: 2, publishedRevision: null, publishedDefinitionHash: null },
    revision: { revision: 2, valid: false, irSha256: null, diagnostics: [BAD] } });
/** A published workflow whose newer revision (2) does not compile yet: revision 1's graph is drawn. */
const newerInvalid = () => readModel({ noRun: true, definition: { currentRevision: 2 },
    revision: { revision: 2, valid: false, diagnostics: [BAD, { ...BAD, line: 9 }] } });

/** The workflow session wf, and its parent agent's session in `parentStatus` (none when null). */
function mount(model, parentStatus) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    const sessions = [{ sessionId: "wf", sessionKind: "workflow", title: "Review", parentSessionId: parentStatus ? "agent-1" : null }];
    if (parentStatus) sessions.push({ sessionId: "agent-1", title: "Author", status: parentStatus });
    store.dispatch({ type: "sessions/loaded", sessions });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModelRunId: null, readModel: model } });
    return { store, controller: new PilotSwarmUiController({ store, transport: {} }) };
}

test("the parent agent works while it is running, as the session list steadies it (5 s hold); a wait, a schedule, a question or an idle session does not", () => {
    assert.equal(workflowParentWorking({ status: "running" }), true);
    // The 5 s hold is kept on purpose (review UI7-1): a parent between two turns close together still reads as running,
    // so the invalid state does not flash; one that has stopped reads so once the hold ends.
    assert.equal(workflowParentWorking({ status: "idle", rowVisualStatus: "running" }), true, "during the hold, the steadied status wins");
    assert.equal(workflowParentWorking({ status: "idle", rowVisualStatus: "idle" }), false, "after the hold");
    assert.equal(workflowParentWorking({ status: "running", rowVisualStatus: "idle" }), false, "a new turn reads as running once its hold ends");
    assert.equal(workflowParentWorking({ status: "running", rowVisualStatus: "cron_waiting" }), false);
    for (const status of ["idle", "waiting", "input_required", "completed", "failed"]) assert.equal(workflowParentWorking({ status }), false, status);
    assert.equal(workflowParentWorking(undefined), false);
    const wf = { sessionId: "wf", parentSessionId: "agent-1" };
    const at = (status, title = "Author") => ({ sessions: { activeSessionId: "wf", byId: { wf, "agent-1": { sessionId: "agent-1", status, title } } }, ui: {} });
    assert.equal(selectWorkflowViewSnapshot(at("running")).parentWorking, true);
    assert.equal(selectWorkflowViewSnapshot(at("idle")).parentWorking, false);
    assert.equal(selectWorkflowViewSnapshot({ sessions: { activeSessionId: "wf", byId: { wf: { sessionId: "wf" } } }, ui: {} }).parentWorking, false);
    // Whether the parent works is part of the snapshot; nothing else about the parent is.
    assert.ok(!workflowViewSnapshotEqual(selectWorkflowViewSnapshot(at("running")), selectWorkflowViewSnapshot(at("idle"))));
    assert.ok(workflowViewSnapshotEqual(selectWorkflowViewSnapshot(at("running")), selectWorkflowViewSnapshot(at("running", "Renamed"))));
});

test("the calm state is for an invalid latest revision while the parent agent works; its errors are then not counted", () => {
    const view = projectWorkflow({ readModel: invalid() });
    assert.deepEqual(view.latest, { revision: 2, valid: false, errors: 1 });
    assert.deepEqual(workflowDraftInProgress(view, true), { revision: 2, errors: 1 });
    assert.equal(workflowDraftInProgress(view, false), null);
    assert.equal(workflowDraftInProgress(projectWorkflow({ readModel: readModel({ noRun: true }) }), true), null, "a valid latest revision");
    assert.equal(workflowDraftInProgress(projectWorkflow({ readModel: { nope: true } }), true), null, "an unknown read");
    assert.equal(workflowRevisionErrorsText(2, 1), "Revision 2 has 1 error");
    assert.equal(workflowRevisionErrorsText(3, 0), "Revision 3 has unlisted errors");
    // While the agent is not working: an error notice, counted. While it writes: information, not counted.
    const idle = workflowShownNotices(view.banners);
    assert.deepEqual(idle.map(notice => [notice.level, notice.code, notice.text]), [["error", "invalid-revision", "Revision 2 has 1 error and cannot run."]]);
    assert.equal(workflowNoticeCount(idle), 1);
    const writing = workflowShownNotices(view.banners, { draftInProgress: workflowDraftInProgress(view, true) });
    assert.deepEqual(writing, [{ level: "info", code: "draft-in-progress", quiet: true,
        text: "The agent is still writing this Workflow. Revision 2 has 1 error and cannot run." }]);
    assert.equal(workflowNoticeCount(writing), 0);
    // A newer invalid revision beside a published graph: the same.
    const newer = projectWorkflow({ readModel: newerInvalid() });
    assert.deepEqual(newer.latest, { revision: 2, valid: false, errors: 2 });
    assert.equal(workflowNoticeCount(workflowShownNotices(newer.banners, { draftInProgress: workflowDraftInProgress(newer, true) })), 0);
    assert.equal(workflowNoticeCount(workflowShownNotices(newer.banners)), 1);
});

// Workflow Simplified: the Workflow tab's Definition view keeps H1. Its invalid line (07, D3: one line over the graph) is
// calm while the session that owns the definition is writing it, its errors folded; otherwise it is the error line. The
// Notices button it used to have is removed (spec 17), so nothing here counts or tints a button. Selecting the Workflow
// keeps its session's chat (09, S4); the tab is on its Definition view.
test("while the session writes the definition: one calm line, its errors folded; otherwise the error line over the graph (07 D3, H1)", () => {
    const tab = ({ controller, store }) => {
        const state = store.getState();
        const key = state.sessions.byId.wf?.parentSessionId && state.sessions.byId[state.sessions.byId.wf.parentSessionId] ? "agent-1" : "wf";
        store.dispatch({ type: "ui/workflowTab", ownerId: key, patch: { view: "definition" } });
        return renderToStaticMarkup(React.createElement(WorkflowTab, { controller }));
    };
    const writing = mount(invalid(), "running");
    assert.equal(writing.store.getState().sessions.activeSessionId, "agent-1", "the session stays in the middle");
    const html = tab(writing);
    assert.match(html, /<p class="ps-wf-line is-quiet" role="status" data-drafting="true">Author is still writing this definition\. Revision 2 has 1 error so far\.<\/p>/);
    assert.match(html, /<details class="ps-wf-errors"><summary>Errors so far<\/summary>/);
    assert.ok(html.includes("route goes nowhere"), "the errors are there, folded");
    assert.ok(!html.includes("is-error") && !html.includes("role=\"alert\""), html);
    assert.ok(!html.includes("aria-label=\"Notices\""), "no Notices button (17)");
    for (const status of ["idle", "waiting", null]) {
        const shown = tab(mount(invalid(), status));
        assert.match(shown, /<p class="ps-wf-line is-error" role="status">Revision 2 not valid · line 7: route goes nowhere\.<\/p>/, `${status}`);
        assert.ok(!shown.includes("data-drafting"), `${status}`);
    }
    // A newer invalid revision beside a published graph: the graph is drawn under the line.
    const graph = tab(mount(newerInvalid(), "running"));
    assert.ok(graph.includes("data-node-id"));
    assert.match(graph, /Author is still writing this definition\. Revision 2 has 2 errors so far\. Showing revision 1\./);
    assert.match(tab(mount(newerInvalid(), "idle")), /Revision 2 not valid · line 7: route goes nowhere\. Showing revision 1\./);
});

test("the Notices button: shown for any notice or a failed read; only counted notices give it a count and a tint", () => {
    const quiet = { level: "info", code: "draft-in-progress", quiet: true, text: "The agent is still writing this Workflow. Revision 2 has 1 error and cannot run." };
    assert.deepEqual(workflowNoticeBadge([]), { shown: false, count: 0, level: null });
    assert.deepEqual(workflowNoticeBadge([quiet]), { shown: true, count: 0, level: null }, "quiet only: no count, no tint");
    // A quiet revision notice beside an independent warning: only the warning is counted and tints the button.
    assert.deepEqual(workflowNoticeBadge([quiet, { level: "warning", text: "This run used revision 1." }]), { shown: true, count: 1, level: "warning" });
    assert.deepEqual(workflowNoticeBadge([quiet], true), { shown: true, count: 1, level: "error" }, "a failed read counts as an error");
    assert.deepEqual(workflowNoticeBadge([], true), { shown: true, count: 1, level: "error" });
    assert.deepEqual(workflowNoticeBadge([{ level: "info", text: "Draft revision 1 · not published." }]), { shown: true, count: 1, level: "info" });
});
