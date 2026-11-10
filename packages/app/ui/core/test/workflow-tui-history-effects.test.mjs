// The TUI workflow view's read-only history and test effects (design 02 "Portal/TUI: observed state"; design 05 test
// mode, T115, T119 in the TUI): the selected state's executions newest first, as the portal's History tab lists them
// (unchanged repeats of a loop combined), the shown test run's held calls as the
// portal's table lists them (read-only; answered by the run's parent agent, a fixture or a person in the portal), and
// the details scrolled with PgUp/PgDn within what the panel shows.
//
// Run: node --test packages/app/ui/core/test/workflow-tui-history-effects.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    UI_COMMANDS,
    appReducer,
    buildHistoryModel,
    createInitialState,
    createStore,
    selectWorkflowViewModal,
    workflowViewPanelWidth,
} from "../src/index.js";
import { readModel, row, done } from "./workflow-v2-fixtures.mjs";

/** A review that loops through a fix until accepted. */
const states = [
    { id: "review", type: "agent", invoke: { source: "agent", name: "code-reviewer" }, timeoutSeconds: 600,
        outcomes: ["accepted", "rework"], next: { accepted: "done", rework: "fix", timed_out: "failed" } },
    { id: "fix", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["fixed"], next: { fixed: "review" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const graph = { revision: 1, initial: "review", states };
const agent = childSessionId => ({ childSessionId, spawned: true, spawnAttempts: 1, end: null, endSent: false });
const RUNS = [
    { runId: "run-1", mode: "live", status: "running", revision: 1, outcome: null },
    { runId: "run-t1", mode: "test", status: "running", revision: 1, outcome: null },
];
/** The live run: review sent back twice for rework, fixed twice, now reviewing again. */
const LIVE = readModel({ graph, revision: { name: "review-loop" }, runs: RUNS, nodeExecutions: [
    done("review", 1, "rework", { agent: agent("child-1"), winner: "agent" }),
    done("fix", 2, "fixed"),
    done("review", 3, "rework", { agent: agent("child-3"), winner: "agent" }),
    done("fix", 4, "fixed"),
    row("review", 5, "pending", { agent: agent("child-5") }),
] });
/** A test run with `count` held calls of review: the first answered by a fixture, the rest waiting for the parent. */
function testRun(count) {
    const interceptions = Array.from({ length: count }, (_, i) => ({
        interceptionId: `nx-review-1/call-${i + 1}`, operation: "tool.call", tool: i === 0 ? "read_build" : `notify_${i}`, nodeExecutionId: "nx-review-1",
        stateId: "review", state: i === 0 ? "responded" : "awaiting_parent", arguments: "{}", argumentsSha256: "h", responseSchema: null,
        virtualAt: "9000-01-01T00:00:00.000Z",
        response: i === 0 ? { kind: "success", disposition: "fixture", value: "{\"state\":\"green\"}", sha256: "v", respondedAt: "2026-11-02T20:00:00.000Z" } : null,
    }));
    return readModel({ graph, revision: { name: "review-loop" }, runs: RUNS, nodeExecutions: [row("review", 1, "pending", { agent: agent("child-t1") })],
        run: { runId: "run-t1", mode: "test", status: "running", test: { notice: "TEST — scripts run normally; workflow tools are mocked.",
            agentMode: "mocked", agentPins: null, scenario: null, testedRevision: 1, stale: false,
            virtualClock: { now: "9000-01-01T00:00:00.000Z", elapsedSeconds: 0 }, interceptions,
            coverage: { unanswered: interceptions.filter(item => !item.response).map(item => item.interceptionId) } } } });
}

function harness({ view, events = [], transport: extra = {} } = {}) {
    const calls = [];
    const transport = { getSessionEventsBefore: async () => [], ...extra };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: review-loop", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel(events) });
    if (view) store.dispatch({ type: "ui/workflowView", sessionId: "wf", view });
    return { controller, store, calls };
}

const texts = view => view.detailsLines.map(line => line.text);
const present = store => {
    const layout = store.getState().ui.layout;
    return selectWorkflowViewModal(store.getState(), workflowViewPanelWidth(layout.viewportWidth), layout.viewportHeight);
};

test("a state's history lists its visits newest first, a loop's unchanged repeats combined, as the portal's History tab", async () => {
    const { controller, store } = harness({ view: { readModel: LIVE, readModelRunId: null },
        transport: { readWorkflow: async () => LIVE } });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    let lines = texts(selectWorkflowViewModal(store.getState(), 110));
    // Review 19:27Z (row 17): visits, each result in the Workflow's words.
    const at = lines.indexOf("Visits · newest first · repeats combined:");
    assert.ok(at > 0, lines.join("\n"));
    assert.deepEqual(lines.slice(at + 1, at + 3), ["  visit 5 · Running", "  visits 1–3 ×2 · ✓ rework"]);
    // The fix state: two fixes, combined.
    await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    lines = texts(selectWorkflowViewModal(store.getState(), 110));
    assert.equal(lines[lines.indexOf("Visits · newest first · repeats combined:") + 1], "  visits 2–4 ×2 · ✓ fixed");
    // An end not reached has no executions.
    await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    lines = texts(selectWorkflowViewModal(store.getState(), 110));
    assert.ok(lines.includes("  No visits loaded."));
    // A live run shows no held calls.
    assert.ok(!lines.some(line => line.startsWith("Calls of this test")));
});

test("a test run's held calls are listed with their state and answer, read-only, from that run's own model", async () => {
    const model = testRun(2);
    const { controller, store } = harness({ view: { selectedRunId: "run-t1", readModel: model, readModelRunId: "run-t1" },
        transport: { readWorkflow: async () => model } });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    const view = selectWorkflowViewModal(store.getState(), 110);
    const lines = texts(view);
    assert.ok(lines.includes("! TEST — scripts run normally; workflow tools are mocked."));
    assert.ok(lines.includes("Calls of this test · 2 · 1 waits for the parent:"), lines.join("\n"));
    assert.ok(lines.includes("  tool.call · read_build · node review · success · prepared answer ◂ this node"));
    assert.ok(lines.includes("  tool.call · notify_1 · node review · waiting for the parent ◂ this node"));
    assert.ok(lines.includes("The TUI shows them; the test's parent agent, a prepared answer or a person in the portal answers them."));
    assert.equal(view.detailsLines.find(line => line.text.includes("notify_1")).color, "yellow");
    // Another state of the same run: the effects are the run's, without the mark.
    await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    const other = texts(selectWorkflowViewModal(store.getState(), 110));
    assert.ok(other.includes("  tool.call · read_build · node review · success · prepared answer"));
    // A model read for another run is never shown for this one.
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { selectedRunId: "run-1" } });
    assert.ok(!texts(selectWorkflowViewModal(store.getState(), 110)).some(line => line.startsWith("Calls of this test")));
});

test("PgUp/PgDn scroll the details a page at a time within what the panel shows; another state or run starts at the top", async () => {
    const model = testRun(30);
    const { controller, store } = harness({ view: { selectedRunId: "run-t1", readModel: model, readModelRunId: "run-t1" },
        transport: { readWorkflow: async () => model } });
    store.dispatch({ type: "ui/viewport", width: 120, height: 24 });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    const first = present(store);
    const page = first.detailsHeight - 3;
    assert.equal(first.detailsScroll, 0);
    assert.ok(first.detailsMaxScroll > 2 * page, `enough lines to page (${first.detailsLines.length} lines, max ${first.detailsMaxScroll})`);
    await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_DETAILS_DOWN);
    assert.equal(store.getState().ui.modal.detailsScroll, page);
    for (let i = 0; i < 20; i++) await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_DETAILS_DOWN);
    assert.equal(store.getState().ui.modal.detailsScroll, first.detailsMaxScroll, "never past the last line");
    assert.equal(present(store).detailsScroll, first.detailsMaxScroll);
    await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_DETAILS_UP);
    assert.equal(store.getState().ui.modal.detailsScroll, first.detailsMaxScroll - page);
    for (let i = 0; i < 20; i++) await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_DETAILS_UP);
    assert.equal(store.getState().ui.modal.detailsScroll, 0);
    // Another state starts at the top.
    await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_DETAILS_DOWN);
    await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    assert.equal(store.getState().ui.modal.detailsScroll, 0);
    // So does another run.
    await controller.handleCommand(UI_COMMANDS.MODAL_PREV);
    await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_DETAILS_DOWN);
    assert.equal(store.getState().ui.modal.detailsScroll, page);
    await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PREV_RUN);
    assert.equal(store.getState().ui.modal.detailsScroll, 0);
    // Short details do not scroll.
    const short = harness({ view: { readModel: LIVE, readModelRunId: null }, transport: { readWorkflow: async () => LIVE } });
    short.store.dispatch({ type: "ui/viewport", width: 120, height: 60 });
    await short.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await short.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_DETAILS_DOWN);
    assert.equal(present(short.store).detailsMaxScroll, 0);
    assert.equal(short.store.getState().ui.modal.detailsScroll ?? 0, 0);
});
