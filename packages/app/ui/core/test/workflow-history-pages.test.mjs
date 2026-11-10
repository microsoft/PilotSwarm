// A run's history in pages in the workflow views (design 04 read_workflow "Bounded history pagination"; R01 history;
// INACTIVE as the views are): the read model holds each section's newest page and its open rows; older pages a person
// loads join that run's own model only while they still join its page. When newer rows push the page past every loaded
// row, what lies between was never read: the loaded rows are not shown, the gap is said, and reading starts again from
// the page, so no row is skipped. An older row that was open when it was read and is no longer open is left out and
// counted, never shown as it was. An older server's model (no pages) keeps its first-200 notice.
//
// Run: node --test packages/app/ui/core/test/workflow-history-pages.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    projectWorkflowReadModel, workflowOlderStart, workflowRunHistory, workflowRunRows,
} from "../src/workflow-view.js";

const RUN = "run-1";
/** An opaque cursor as the read returns it (the views never look inside). */
const cursor = mark => ({ v: 1, workflowId: "wf", runId: RUN, section: "executions", order: "newest_first", after: { mark } });
const exec = (n, state = "completed") => ({ nodeExecutionId: `e${n}`, stateId: "poll", ordinal: n, state,
    ...(state === "completed" ? { outcome: "ok", resultKind: "business", outputPreview: `{"n":${n}}` } : {}) });
const runOf = ({ page, open = [], next = null, openComplete = true }) => ({
    runId: RUN, mode: "live", status: "running", outcome: null, kvRevision: 1, kv: "{}",
    nodeExecutions: page, openExecutions: open, inbox: [], openInbox: [], outbox: [], openOutbox: [],
    pages: {
        executions: { order: "newest_first", limit: 3, nextCursor: next, openComplete },
        inbox: { order: "newest_first", limit: 3, nextCursor: null, openComplete: true },
        outbox: { order: "newest_first", limit: 3, nextCursor: null, openComplete: true },
    },
});
const modelOf = run => ({ workflowId: "wf", definition: { state: "published", semver: "1.0.0", currentRevision: 1, publishedRevision: 1 },
    revision: { revision: 1, valid: true, diagnostics: [] }, graph: null, runs: [{ runId: RUN, mode: "live", status: "running", revision: 1 }], run });
const ids = rows => rows.map(row => row.nodeExecutionId);

test("older pages that join the newest page are merged, one row per id, and reading continues from the last older page", () => {
    const run = runOf({ page: [exec(4), exec(5), exec(6)], next: cursor("after-e4") });
    const older = { runId: RUN, sections: { executions: { items: [exec(1), exec(2), exec(3), exec(4), exec(5), exec(6)], nextCursor: cursor("after-e1") } } };
    const rows = workflowRunRows(run, older);
    assert.deepEqual(ids(rows.nodeExecutions), ["e1", "e2", "e3", "e4", "e5", "e6"]);
    assert.equal(rows.gaps, 0);
    const history = workflowRunHistory(run, older);
    assert.deepEqual(history.next.executions, cursor("after-e1"), "the next older page follows the oldest loaded row");
    assert.equal(history.complete, false);
    // Older pages of another run never join this one.
    assert.deepEqual(ids(workflowRunRows(run, { ...older, runId: "run-2" }).nodeExecutions), ["e4", "e5", "e6"]);
    assert.deepEqual(workflowRunHistory(run, { ...older, runId: "run-2" }).next.executions, cursor("after-e4"));
    // Its oldest row loaded: nothing older to read, and every execution is loaded.
    const all = { runId: RUN, sections: { executions: { items: older.sections.executions.items, nextCursor: null } } };
    assert.equal(workflowRunHistory(run, all).next.executions, undefined);
    assert.equal(workflowRunHistory(run, all).complete, true);
});

test("newer rows that push the page past every loaded row leave no gap: the loaded rows are not shown and reading starts again from the page", () => {
    const older = { runId: RUN, sections: { executions: { items: [exec(1), exec(2), exec(3), exec(4), exec(5), exec(6)], nextCursor: null } } };
    // e7 to e9 were never read: the new page is e10 to e12, with older rows before it.
    const run = runOf({ page: [exec(10), exec(11), exec(12)], next: cursor("after-e10") });
    const rows = workflowRunRows(run, older);
    assert.deepEqual(ids(rows.nodeExecutions), ["e10", "e11", "e12"], "no row shown across the unread gap");
    assert.equal(rows.gaps, 1);
    assert.deepEqual(workflowRunHistory(run, older).next.executions, cursor("after-e10"), "the next read follows the page");
    assert.deepEqual(workflowOlderStart(run, older).executions, { items: run.nodeExecutions, nextCursor: cursor("after-e10") });
    const projected = projectWorkflowReadModel(modelOf(run), { older });
    assert.ok(projected.banners.some(banner => banner.text.startsWith("Newer rows arrived after older history was loaded")), JSON.stringify(projected.banners));
    // A page that still overlaps the loaded rows joins them.
    const overlapping = runOf({ page: [exec(6), exec(7), exec(8)], next: cursor("after-e6") });
    assert.deepEqual(ids(workflowRunRows(overlapping, older).nodeExecutions), ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"]);
    assert.deepEqual(workflowOlderStart(overlapping, older).executions, older.sections.executions);
    // A page with nothing older needs no join.
    assert.equal(workflowRunRows(runOf({ page: [exec(10)] }), older).gaps, 0);
});

test("an older row open when read and no longer open is left out and counted; one still open is shown as the model lists it", () => {
    const older = { runId: RUN, sections: { executions: { items: [exec(1), exec(2, "pending"), exec(3, "pending"), exec(4), exec(5), exec(6)], nextCursor: null } } };
    const run = runOf({ page: [exec(5), exec(6)], open: [exec(2, "pending")], next: cursor("after-e5") });
    const rows = workflowRunRows(run, older);
    assert.deepEqual(ids(rows.nodeExecutions).sort(), ["e1", "e2", "e4", "e5", "e6"]);
    assert.equal(rows.staleOlder, 1, "e3 completed since it was read: it is not shown as pending");
    // With more open rows than a read lists, an older open row cannot be judged and stays.
    const partial = runOf({ page: [exec(5), exec(6)], open: [exec(2, "pending")], next: cursor("after-e5"), openComplete: false });
    assert.deepEqual(ids(workflowRunRows(partial, older).nodeExecutions).sort(), ["e1", "e2", "e3", "e4", "e5", "e6"]);
    const projected = projectWorkflowReadModel(modelOf(run), { older });
    assert.ok(projected.banners.some(banner => banner.text.startsWith("1 row loaded from older history changed")), JSON.stringify(projected.banners));
});

test("an older server's model without pages keeps the first-200 notice; a paged one says only that older executions are not loaded", () => {
    const legacy = { ...runOf({ page: Array.from({ length: 200 }, (_, i) => exec(i + 1)) }), pages: undefined };
    const projected = projectWorkflowReadModel(modelOf(legacy));
    assert.ok(projected.banners.some(banner => banner.text === "Only the first 200 visits are listed, so counts may be incomplete."));
    assert.equal(workflowRunHistory(legacy).paged, false);
    assert.equal(workflowRunHistory(legacy).more, false, "an older server pages no further");
    const paged = projectWorkflowReadModel(modelOf(runOf({ page: [exec(10)], next: cursor("after-e10") })));
    assert.ok(paged.banners.some(banner => banner.text === "Older visits are not loaded, so counts may be incomplete."));
    assert.ok(!paged.banners.some(banner => banner.text.startsWith("Only the first")));
});

test("the controller reads older history from the page again after a gap, for exactly the shown run, and keeps what it read", async () => {
    const calls = [];
    const transport = { readWorkflow: async (sessionId, options) => {
        calls.push([sessionId, options]);
        return { workflowId: "wf", runId: RUN, section: "executions", order: "newest_first", limit: 3,
            items: [exec(7), exec(8), exec(9)], nextCursor: cursor("after-e7") };
    } };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: poller", status: "running", sessionKind: "workflow" }] });
    const run = runOf({ page: [exec(10), exec(11), exec(12)], next: cursor("after-e10") });
    const stale = { runId: RUN, sections: { executions: { items: [exec(1), exec(2), exec(3)], nextCursor: cursor("after-e1") } }, loading: false, error: null };
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: modelOf(run), readModelRunId: null, olderHistory: stale } });
    const read = await controller.loadOlderWorkflowHistory("wf");
    assert.deepEqual(read, { ok: true, rows: 3 });
    assert.deepEqual(calls, [["wf", { runId: RUN, cursor: cursor("after-e10") }]], "from the page's cursor, not the stale older page's");
    const kept = store.getState().ui.workflowViews.wf.olderHistory;
    assert.deepEqual(ids(kept.sections.executions.items), ["e7", "e8", "e9", "e10", "e11", "e12"]);
    assert.deepEqual(kept.sections.executions.nextCursor, cursor("after-e7"));
    assert.deepEqual(ids(workflowRunRows(run, kept).nodeExecutions), ["e7", "e8", "e9", "e10", "e11", "e12"]);
    // An answer that is not the page of that run and section is refused, and what was loaded stays.
    transport.readWorkflow = async () => ({ runId: "run-2", section: "executions", items: [exec(4)], nextCursor: null });
    const refused = await controller.loadOlderWorkflowHistory("wf");
    assert.equal(refused.ok, false);
    assert.match(store.getState().ui.workflowViews.wf.olderHistory.error, /did not answer with the executions page of run run-1/);
    assert.deepEqual(ids(store.getState().ui.workflowViews.wf.olderHistory.sections.executions.items), ["e7", "e8", "e9", "e10", "e11", "e12"]);
});
