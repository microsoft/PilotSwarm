// Owner batch 7 (H1): while the workflow's parent agent is still writing it, an invalid latest revision is said calmly,
// "The agent is still writing this workflow.", with its errors folded under "Revision N has K errors": no alert, and not
// counted on the Notices button. Once the agent is no longer in a turn, or with no parent agent, the invalid state is
// shown as before. Both are compact at the top of the pane (CSS: .ps-workflow-empty align-content: start).
//
// Run: node --test packages/app/ui/core/test/workflow-v2-draft-progress.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import { selectWorkflowViewSnapshot, workflowParentWorking, workflowViewSnapshotEqual } from "../src/workflow-view.js";
import {
    projectWorkflowV2, workflowV2DraftInProgress, workflowV2NoticeBadge, workflowV2NoticeCount, workflowV2RevisionErrorsText, workflowV2ShownNotices,
} from "../src/workflow-v2-view.js";
import { WorkflowMainPane, WorkflowNodePane } from "../../react/src/workflow-workspace.js";
import { readModel } from "./workflow-v2-fixtures.mjs";

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
const main = ({ controller }) => renderToStaticMarkup(React.createElement(WorkflowMainPane, { controller, icon: null }));
const side = ({ controller }) => renderToStaticMarkup(React.createElement(WorkflowNodePane, { controller }));
const tool = (html, name) => html.match(new RegExp(`<button [^>]*aria-label="${name}"[^>]*>`))?.[0] ?? null;
/** The Notices button's badge as drawn: its count and tint, or null for a button without one (or no button). */
const badgeOf = html => {
    const button = html.match(/<button [^>]*aria-label="Notices"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? "";
    const badge = button.match(/<span class="ps-workflow-tool-badge"(?: data-level="([a-z]+)")?[^>]*>([^<]*)<\/span>/);
    return badge ? { level: badge[1] ?? null, count: badge[2] } : null;
};

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
    const view = projectWorkflowV2({ readModel: invalid() });
    assert.deepEqual(view.latest, { revision: 2, valid: false, errors: 1 });
    assert.deepEqual(workflowV2DraftInProgress(view, true), { revision: 2, errors: 1 });
    assert.equal(workflowV2DraftInProgress(view, false), null);
    assert.equal(workflowV2DraftInProgress(projectWorkflowV2({ readModel: readModel({ noRun: true }) }), true), null, "a valid latest revision");
    assert.equal(workflowV2DraftInProgress(projectWorkflowV2({ readModel: { nope: true } }), true), null, "an unknown read");
    assert.equal(workflowV2RevisionErrorsText(2, 1), "Revision 2 has 1 error");
    assert.equal(workflowV2RevisionErrorsText(3, 0), "Revision 3 has unlisted errors");
    // While the agent is not working: an error notice, counted. While it writes: information, not counted.
    const idle = workflowV2ShownNotices(view.banners);
    assert.deepEqual(idle.map(notice => [notice.level, notice.code, notice.text]), [["error", "invalid-revision", "Revision 2 has 1 error and cannot run."]]);
    assert.equal(workflowV2NoticeCount(idle), 1);
    const writing = workflowV2ShownNotices(view.banners, { draftInProgress: workflowV2DraftInProgress(view, true) });
    assert.deepEqual(writing, [{ level: "info", code: "draft-in-progress", quiet: true,
        text: "The agent is still writing this workflow. Revision 2 has 1 error and cannot run." }]);
    assert.equal(workflowV2NoticeCount(writing), 0);
    // A newer invalid revision beside a published graph: the same.
    const newer = projectWorkflowV2({ readModel: newerInvalid() });
    assert.deepEqual(newer.latest, { revision: 2, valid: false, errors: 2 });
    assert.equal(workflowV2NoticeCount(workflowV2ShownNotices(newer.banners, { draftInProgress: workflowV2DraftInProgress(newer, true) })), 0);
    assert.equal(workflowV2NoticeCount(workflowV2ShownNotices(newer.banners)), 1);
});

test("while the parent agent writes: the calm screen with its errors folded, no alert, and Notices without a count; otherwise the invalid state", () => {
    const writing = mount(invalid(), "running");
    const html = main(writing);
    assert.match(html, /<div class="ps-workflow-empty is-drafting" role="status" data-drafting="2"><strong>The agent is still writing this workflow\.<\/strong><details class="ps-workflow-draft-errors"><summary>Revision 2 has 1 error<\/summary>/);
    assert.ok(html.includes("route goes nowhere"), "the errors are there, folded");
    assert.ok(!html.includes("role=\"alert\"") && !html.includes("This workflow definition is invalid"), html);
    // Review UI7-2: the quiet notice stays reachable; the button has no count and no tint.
    assert.ok(tool(html, "Notices"), "the Notices button stays");
    assert.equal(badgeOf(html), null, "the revision's errors are not counted");
    assert.ok(side(writing).includes("The agent is still writing this workflow."), "the side pane says the same");
    for (const status of ["idle", "waiting", null]) {
        const shown = main(mount(invalid(), status));
        assert.ok(shown.includes("This workflow definition is invalid") && shown.includes("role=\"alert\""), `${status}: the invalid state`);
        assert.ok(!shown.includes("is-drafting"), `${status}`);
        assert.deepEqual(badgeOf(shown), { level: "error", count: "1" }, `${status}: its errors are counted`);
    }
    // A newer invalid revision beside a published graph: the graph is drawn; while the agent writes, its errors are listed
    // behind Notices without a count or tint, so the notice can still be read.
    const graph = main(mount(newerInvalid(), "running"));
    assert.ok(graph.includes("data-node-id"));
    assert.ok(tool(graph, "Notices"));
    assert.equal(badgeOf(graph), null);
    assert.deepEqual(badgeOf(main(mount(newerInvalid(), "idle"))), { level: "error", count: "1" });
});

test("the Notices button: shown for any notice or a failed read; only counted notices give it a count and a tint", () => {
    const quiet = { level: "info", code: "draft-in-progress", quiet: true, text: "The agent is still writing this workflow. Revision 2 has 1 error and cannot run." };
    assert.deepEqual(workflowV2NoticeBadge([]), { shown: false, count: 0, level: null });
    assert.deepEqual(workflowV2NoticeBadge([quiet]), { shown: true, count: 0, level: null }, "quiet only: no count, no tint");
    // A quiet revision notice beside an independent warning: only the warning is counted and tints the button.
    assert.deepEqual(workflowV2NoticeBadge([quiet, { level: "warning", text: "This run used revision 1." }]), { shown: true, count: 1, level: "warning" });
    assert.deepEqual(workflowV2NoticeBadge([quiet], true), { shown: true, count: 1, level: "error" }, "a failed read counts as an error");
    assert.deepEqual(workflowV2NoticeBadge([], true), { shown: true, count: 1, level: "error" });
    assert.deepEqual(workflowV2NoticeBadge([{ level: "info", text: "Draft revision 1 · not published." }]), { shown: true, count: 1, level: "info" });
});
