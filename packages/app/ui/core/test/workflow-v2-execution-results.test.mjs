// Each execution's own result in the workflow views (R01 history; design 02 node occurrences; mock M10; INACTIVE as the views are): the
// portal's History tab chooses one execution of the shown run and state by its exact identity, and the Output tab then
// shows that execution's own output or runtime error, never the latest in its place; the TUI's [ and ] step through the
// selected state's visits of the shown run the same way. A loop's visits stay distinct, a choice for one run or state
// never applies to another, a chosen execution that is no longer loaded is said to be missing, a preview the read cut
// short is said to be cut, and a refused read shows no result at all. Nothing here reads or sends anything new: the
// results are the previews the authorized read model already carries.
//
// Run: node --test packages/app/ui/core/test/workflow-v2-execution-results.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowViewModal,
} from "../src/index.js";
import { projectWorkflowV2, workflowV2ExecutionResult, workflowV2KvApplied, workflowV2KvCompare, workflowV2ShownExecution } from "../src/workflow-v2-view.js";
import { WorkflowV2NodeContent } from "../../react/src/workflow-v2-panels.js";
import { RUN, done, readModel, row } from "./workflow-v2-fixtures.mjs";

/** The live run: poll ran three times (each with its own output), pause twice, and pause waits again. */
const LOOP = readModel({ nodeExecutions: [
    done("poll", 1, "changed", { outputPreview: "{\"n\":1}" }),
    done("pause", 2, "elapsed"),
    done("poll", 3, "unchanged", { outputPreview: "{\"n\":2}" }),
    done("pause", 4, "elapsed"),
    done("poll", 5, "unchanged", { outputPreview: "{\"n\":3}" }),
    row("pause", 6, "pending"),
] });
/** A test run of the same workflow whose executions reuse the live run's ids: a choice for one run never applies to the other. */
const OTHER = "test-run-2";
const OTHER_RUN = readModel({ run: { runId: OTHER, mode: "test" }, runs: [{ runId: RUN, mode: "live", status: "running", revision: 1, outcome: null },
    { runId: OTHER, mode: "test", status: "running", revision: 1, outcome: null }],
nodeExecutions: [done("poll", 1, "changed", { outputPreview: "{\"n\":\"other\"}" }), done("poll", 3, "changed", { outputPreview: "{\"n\":\"other-3\"}" })] });

test("the shown execution is the one chosen for exactly this run and state, else the latest; a chosen one no longer loaded is missing", () => {
    const poll = projectWorkflowV2({ readModel: LOOP }).nodes.find(node => node.id === "poll");
    assert.deepEqual(poll.executions.map(item => item.id), ["nx-poll-5", "nx-poll-3", "nx-poll-1"], "newest first, every visit distinct");
    const latest = workflowV2ShownExecution(poll, RUN, null);
    assert.deepEqual([latest.chosen, latest.missing, latest.executionId, latest.index], [false, false, "nx-poll-5", 0]);
    const chosen = workflowV2ShownExecution(poll, RUN, { runId: RUN, stateId: "poll", executionId: "nx-poll-3" });
    assert.deepEqual([chosen.chosen, chosen.missing, chosen.execution.id, chosen.index], [true, false, "nx-poll-3", 1]);
    for (const selection of [{ runId: OTHER, stateId: "poll", executionId: "nx-poll-3" }, { runId: RUN, stateId: "pause", executionId: "nx-poll-3" },
        { runId: RUN, stateId: "poll", executionId: "" }, { runId: RUN, stateId: "poll" }, "nx-poll-3"]) {
        assert.equal(workflowV2ShownExecution(poll, RUN, selection).executionId, "nx-poll-5", JSON.stringify(selection));
    }
    const gone = workflowV2ShownExecution(poll, RUN, { runId: RUN, stateId: "poll", executionId: "nx-poll-9" });
    assert.deepEqual([gone.chosen, gone.missing, gone.execution, gone.executionId, gone.index], [true, true, null, "nx-poll-9", -1], "never the latest in its place");
});

test("an execution's result is its own: not ended, a runtime error with its code, an output (null included), none, or missing; a cut preview says so", () => {
    assert.deepEqual(workflowV2ExecutionResult({ id: "a", status: "pending" }).kind, "pending");
    assert.deepEqual(workflowV2ExecutionResult({ id: "b", status: "completed", resultKind: "runtime_error", outcome: "timed_out", effectStatus: "unknown",
        errorPreview: "{\"code\":\"timed_out\",\"message\":\"cut…" }),
    { kind: "error", value: "{\"code\":\"timed_out\",\"message\":\"cut…", truncated: true, code: "timed_out", effectStatus: "unknown" });
    assert.deepEqual(workflowV2ExecutionResult({ id: "c", status: "completed", resultKind: "runtime_error", outcome: "failed" }),
        { kind: "error", value: null, truncated: false, code: "failed", effectStatus: null });
    assert.deepEqual(workflowV2ExecutionResult({ id: "d", status: "completed", resultKind: "business", outcome: "ok", outputPreview: "null" }),
        { kind: "output", value: "null", truncated: false, code: "ok", effectStatus: null });
    assert.equal(workflowV2ExecutionResult({ id: "e", status: "completed", resultKind: "business", outcome: "ok", outputPreview: "{\"x\":\"long…" }).truncated, true);
    assert.equal(workflowV2ExecutionResult({ id: "f", status: "completed", resultKind: "business", outcome: "ok" }).kind, "none");
    assert.equal(workflowV2ExecutionResult(null).kind, "missing");
});

test("the portal's History chooses one execution exactly; the Output tab shows that execution's own output, never the latest in its place", () => {
    const projection = projectWorkflowV2({ readModel: LOOP });
    const poll = projection.nodes.find(node => node.id === "poll");
    const render = (tab, selection, extra = {}) => renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, { tab, selected: poll, nodes: projection.nodes,
        select() {}, runOutput: null, runError: null, runId: projection.runId, selection, onSelectExecution: () => {}, onTab: () => {}, ...extra }));
    const history = render("history", null);
    assert.equal([...history.matchAll(/data-action="show-result"/g)].length, 3, "each visit has its own Result button");
    for (const id of ["nx-poll-5", "nx-poll-3", "nx-poll-1"]) assert.ok(history.includes(`data-execution="${id}"`), id);
    const pressed = render("history", { runId: RUN, stateId: "poll", executionId: "nx-poll-3" });
    assert.match(pressed, /data-execution="nx-poll-3" aria-pressed="true"/);

    const latest = render("output", null);
    assert.ok(latest.includes("Latest result in the loaded history for this step."));
    assert.ok(latest.includes("&quot;n&quot;: 3"));
    const older = render("output", { runId: RUN, stateId: "poll", executionId: "nx-poll-3" });
    assert.ok(older.includes("Result of visit 3, chosen in History."));
    assert.ok(older.includes("&quot;n&quot;: 2"));
    assert.ok(!older.includes("&quot;n&quot;: 3"), "the latest output is not shown for an older visit");
    assert.ok(older.includes("data-action=\"latest-result\""));
    const missing = render("output", { runId: RUN, stateId: "poll", executionId: "nx-poll-9" });
    assert.ok(missing.includes("The visit chosen in History (nx-poll-9) is not in the loaded history of this run."));
    assert.ok(missing.includes("no other visit&#x27;s result is shown in its place"));
    assert.ok(!missing.includes("&quot;n&quot;"), "no output at all, the latest included");
    const otherRun = render("output", { runId: OTHER, stateId: "poll", executionId: "nx-poll-3" });
    assert.ok(otherRun.includes("Latest result in the loaded history for this step."), "a choice for another run does not apply");
    // Without the callbacks the History tab lists as before, without buttons.
    const plain = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, { tab: "history", selected: poll, nodes: projection.nodes, select() {},
        runOutput: null, runError: null }));
    assert.ok(!plain.includes("show-result"));
});

test("combined repeats are chosen one by one: a row of several visits has no Result button, the full list does", () => {
    const repeated = readModel({ nodeExecutions: [done("poll", 1, "unchanged", { outputPreview: "{\"n\":0}" }), done("pause", 2, "elapsed"),
        done("poll", 3, "unchanged", { outputPreview: "{\"n\":0}" }), done("pause", 4, "elapsed"), done("poll", 5, "changed", { outputPreview: "{\"n\":9}" })] });
    const projection = projectWorkflowV2({ readModel: repeated });
    const poll = projection.nodes.find(node => node.id === "poll");
    const html = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, { tab: "history", selected: poll, nodes: projection.nodes, select() {},
        runOutput: null, runError: null, runId: projection.runId, selection: null, onSelectExecution: () => {}, onTab: () => {} }));
    assert.ok(html.includes("1–3 (×2)"));
    assert.ok(html.includes("Every loaded visit (3)"));
    // One button for visit 5's row in the compact table, and one for each of the three visits in the full list.
    assert.equal([...html.matchAll(/data-action="show-result"/g)].length, 4);
    assert.equal([...html.matchAll(/data-execution="nx-poll-1"/g)].length, 1);
    assert.equal([...html.matchAll(/data-execution="nx-poll-3"/g)].length, 1);
});

/** The workflow session wf on the TUI with `initial` loaded for `selectedRunId`; readWorkflow answers with `read`. */
function harness(initial, { selectedRunId = null, read = async () => initial } = {}) {
    const calls = [];
    const transport = {
        getSessionEventsBefore: async () => [],
        readWorkflow: async (...args) => { calls.push(args); return read(...args); },
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: watch-v2", status: "running", sessionKind: "workflow" },
        { sessionId: "chat", title: "An ordinary chat", status: "idle" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { selectedRunId, readModel: initial, readModelRunId: selectedRunId } });
    return { controller, store, calls };
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const details = store => selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);
const statusOf = store => store.getState().ui.statusText;
const chosenOf = store => store.getState().ui.workflowViews.wf.selectedExecution ?? null;
const older = h => h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_OLDER_EXECUTION);
const newer = h => h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_NEWER_EXECUTION);

async function viewing(initial, state, options) {
    const h = harness(initial, options);
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    h.store.dispatch({ type: "ui/modal", modal: { ...h.store.getState().ui.modal, selectedNodeId: state } });
    return h;
}

test("the TUI shows a state's latest result, and [ ] step through its visits of the shown run, each with its own output", async () => {
    const h = await viewing(LOOP, "poll");
    let lines = details(h.store);
    assert.ok(lines.includes("Result of visit 5 · latest · [ older · ] newer"), lines.join("\n"));
    assert.ok(lines.includes("  Output: {\"n\":3}"));

    await older(h);
    assert.equal(statusOf(h.store), "Showing visit 3");
    assert.deepEqual(chosenOf(h.store), { runId: RUN, stateId: "poll", executionId: "nx-poll-3" });
    lines = details(h.store);
    assert.ok(lines.includes("Result of visit 3 · chosen · [ older · ] newer"));
    assert.ok(lines.includes("  Output: {\"n\":2}"));
    assert.ok(!lines.includes("  Output: {\"n\":3}"), "the latest output is not shown for an older visit");
    await older(h);
    assert.ok(details(h.store).includes("  Output: {\"n\":1}"));
    await older(h);
    assert.equal(statusOf(h.store), "No older visit loaded");
    assert.equal(chosenOf(h.store).executionId, "nx-poll-1");

    await newer(h);
    await newer(h);
    assert.ok(details(h.store).includes("Result of visit 5 · chosen · [ older · ] newer"));
    await newer(h);
    assert.equal(statusOf(h.store), "Showing the latest result again");
    assert.equal(chosenOf(h.store), null);
    assert.ok(details(h.store).includes("Result of visit 5 · latest · [ older · ] newer"));
    await newer(h);
    assert.equal(statusOf(h.store), "No newer visit");

    // Another state shows its own latest result: a choice for poll does not apply to it.
    await older(h);
    h.store.dispatch({ type: "ui/modal", modal: { ...h.store.getState().ui.modal, selectedNodeId: "pause" } });
    lines = details(h.store);
    assert.ok(lines.includes("Result of visit 4 · latest · [ older · ] newer"), lines.join("\n"));
    assert.ok(lines.includes("  No output"));
    assert.ok(!lines.some(line => line.includes("{\"n\"")));
});

test("a choice for one run never applies to another, even for the same execution id; a chosen visit no longer loaded is said to be missing", async () => {
    const h = await viewing(LOOP, "poll");
    await older(h);
    assert.equal(chosenOf(h.store).executionId, "nx-poll-3");
    // The view now shows the test run, whose executions reuse the ids: its own latest result, not the live run's visit 3.
    h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { selectedRunId: OTHER, readModel: OTHER_RUN, readModelRunId: OTHER } });
    let lines = details(h.store);
    assert.ok(lines.includes("Result of visit 3 · latest · [ older · ] newer"), lines.join("\n"));
    assert.ok(lines.includes("  Output: {\"n\":\"other-3\"}"));
    assert.ok(!lines.some(line => line.includes("· chosen")));

    // Back on the live run, the chosen visit is gone from a newer read: nothing is shown in its place.
    const trimmed = readModel({ nodeExecutions: [done("poll", 5, "unchanged", { outputPreview: "{\"n\":3}" }), row("pause", 6, "pending")] });
    h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { selectedRunId: null, readModel: trimmed, readModelRunId: null } });
    lines = details(h.store);
    assert.ok(lines.includes("The chosen visit is not loaded"), lines.join("\n"));
    assert.ok(lines.includes("  Its result is not shown, and no other visit's result is shown in its place."));
    assert.ok(!lines.some(line => line.startsWith("  Output:")));
    await newer(h);
    assert.equal(statusOf(h.store), "Showing the latest result again");
    assert.ok(details(h.store).includes("  Output: {\"n\":3}"));
});

test("a runtime error is that visit's own, with its code; a preview the read cut short is said to be cut", async () => {
    const failing = readModel({ nodeExecutions: [
        done("poll", 1, "changed", { outputPreview: `{"text":"${"x".repeat(40)}…` }),
        row("poll", 3, "completed", { outcome: "timed_out", resultKind: "runtime_error", winner: "controller",
            errorPreview: "{\"code\":\"timed_out\",\"message\":\"The script did not finish.\"}" }),
    ] });
    const h = await viewing(failing, "poll");
    let lines = details(h.store);
    assert.ok(lines.includes("Result of visit 3 · latest · [ older · ] newer"), lines.join("\n"));
    assert.ok(lines.includes("  Error · limit: {\"code\":\"timed_out\",\"message\":\"The script did not finish.\"}"), lines.join("\n"));
    await older(h);
    lines = details(h.store);
    assert.ok(lines.some(line => line.startsWith("  Output: {\"text\":\"xxx")));
    assert.ok(lines.includes("  Only the start is shown · f reads all"));
    // The state's label and its history still name the later visit's error; this visit's result line does not.
    assert.ok(lines.includes("Status: Failed · limit"), lines.join("\n"));
    assert.ok(!lines.some(line => line.startsWith("  Error")), "the later visit's error is not shown for this one");
});

test("a refused read shows its error and no result; an ordinary session is not touched", async () => {
    const h = harness(LOOP, { selectedRunId: null, read: async (sessionId, options) => {
        if (options?.runId === OTHER) throw Object.assign(new Error("Forbidden: you may not read this session."), { status: 403, code: "FORBIDDEN" });
        return LOOP;
    } });
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    // The person chooses the test run; its read is refused, so only the live run's model is held, and it is never overlaid.
    h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { selectedRunId: OTHER } });
    await h.controller.ensureWorkflowReadModel("wf");
    await settle();
    h.store.dispatch({ type: "ui/modal", modal: { ...h.store.getState().ui.modal, selectedNodeId: "poll" } });
    const lines = details(h.store);
    assert.ok(lines.includes("The Workflow's status could not be read: Forbidden: you may not read this session."), lines.join("\n"));
    assert.ok(!lines.some(line => line.startsWith("Result of")), "no result from another run's model");
    await older(h);
    assert.equal(statusOf(h.store), "No visit of this node is loaded");
    assert.equal(chosenOf(h.store), null);

    // An ordinary session has no workflow view: the keys change nothing, and a choice for it is ignored.
    h.store.dispatch({ type: "ui/modal", modal: null });
    h.store.dispatch({ type: "sessions/selected", sessionId: "chat" });
    const before = statusOf(h.store);
    await older(h);
    assert.equal(statusOf(h.store), before);
    h.controller.selectWorkflowExecution("chat", { runId: RUN, stateId: "poll", executionId: "nx-poll-3" });
    assert.equal(h.store.getState().ui.workflowViews?.chat, undefined);
});

test("f reads the whole value of exactly the visit shown, of exactly the shown run; o says when the server reads no older history", async () => {
    const whole = { n: 3, text: "line" };
    const h = await viewing(LOOP, "poll", { read: async (sessionId, options) => {
        if (options?.executionId === "nx-poll-5") return { workflowId: "wf", runId: RUN, execution: { nodeExecutionId: "nx-poll-5", result: { kind: "output", bytes: 23, whole: true, value: whole } } };
        if (options?.executionId === "nx-poll-3") throw Object.assign(new Error("Execution nx-poll-3 is not a node execution of run run-1."), { code: "EXECUTION_NOT_FOUND", status: 404 });
        return LOOP;
    } });
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_WHOLE_VALUE);
    await settle();
    assert.deepEqual(h.calls.at(-1), ["wf", { runId: RUN, executionId: "nx-poll-5" }]);
    assert.equal(statusOf(h.store), "Read the whole value; it is in the details (PgUp/PgDn scroll)");
    let lines = details(h.store);
    const at = lines.indexOf("  Output · 23 bytes:");
    assert.ok(at > 0, lines.join("\n"));
    assert.deepEqual(lines.slice(at + 1, at + 5), ["    {", "      \"n\": 3,", "      \"text\": \"line\"", "    }"]);

    // An older visit shows its own result, not visit 5's whole value; its read fails and says so, and nothing else is shown.
    await older(h);
    lines = details(h.store);
    assert.ok(!lines.some(line => line.startsWith("  Output · ")), lines.join("\n"));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_WHOLE_VALUE);
    await settle();
    lines = details(h.store);
    assert.ok(lines.some(line => line.startsWith("  Could not read it: Execution nx-poll-3 is not a node execution")), lines.join("\n"));
    assert.equal(statusOf(h.store), "The whole value could not be read; the details say why");

    // The same execution id in another run is that run's own: visit 5's whole value of the live run is not shown there.
    h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { selectedRunId: OTHER, readModel: OTHER_RUN, readModelRunId: OTHER, selectedExecution: null } });
    assert.ok(!details(h.store).some(line => line.startsWith("  Output · ")));

    // A pending visit has no value to read, and nothing is read.
    h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { selectedRunId: null, readModel: LOOP, readModelRunId: null, selectedExecution: null } });
    h.store.dispatch({ type: "ui/modal", modal: { ...h.store.getState().ui.modal, selectedNodeId: "pause" } });
    await newer(h);
    const calls = h.calls.length;
    h.controller.selectWorkflowExecution("wf", { runId: RUN, stateId: "pause", executionId: "nx-pause-6" });
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_WHOLE_VALUE);
    assert.equal(statusOf(h.store), "This visit has not ended; it has no value yet");
    assert.equal(h.calls.length, calls);

    // o: this read model has no pages (an older server), so no older history is read.
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_OLDER_HISTORY);
    assert.equal(statusOf(h.store), "This server reads no older visits");
    assert.equal(h.calls.length, calls);
});

// Mock M15 "Accepted 9 / applied 8", "Inspect update", "Compare snapshots" (R04, R05): a visit's applied variables beside
// the run's accepted ones, compared key by key from the read's snapshots (by each value's sha256), for exactly that run.
const KV = {
    1: { revision: 1, acceptedRevision: 3, keys: 2, bytes: 15, whole: true, entries: [
        { key: "a", bytes: 1, sha256: "s-a-1", value: 1 }, { key: "b", bytes: 3, sha256: "s-b-x", value: "x" }] },
    3: { revision: 3, acceptedRevision: 3, keys: 2, bytes: 16, whole: true, entries: [
        { key: "a", bytes: 1, sha256: "s-a-2", value: 2 }, { key: "c", bytes: 4, sha256: "s-c-t", value: true }] },
};

test("two revisions of a run's variables compare key by key, and a visit's applied revision is told beside the accepted one", () => {
    const compared = workflowV2KvCompare({ kv: KV[1] }, { kv: KV[3] });
    assert.deepEqual(compared, { from: 1, to: 3, whole: true, counts: { added: 1, removed: 1, changed: 1, same: 0 }, rows: [
        { key: "a", change: "changed", before: "1", after: "2" },
        { key: "b", change: "removed", before: "\"x\"", after: null },
        { key: "c", change: "added", before: null, after: "true" },
    ] });
    assert.equal(workflowV2KvCompare({ kv: KV[1] }, null), null, "nothing until both are loaded");
    assert.deepEqual(workflowV2KvApplied({ kvRevision: 1 }, { kvRevision: 3 }), { applied: 1, accepted: 3, same: false });
    assert.deepEqual(workflowV2KvApplied({ kvRevision: 3 }, { kvRevision: 3 }), { applied: 3, accepted: 3, same: true });
    assert.equal(workflowV2KvApplied({}, { kvRevision: 3 }), null);
});

test("i compares the variables the shown visit applied with the accepted ones, for exactly the shown run; the portal's Details offers the same", async () => {
    const model = readModel({ run: { kvRevision: 3 }, nodeExecutions: [done("poll", 1, "changed", { outputPreview: "{\"n\":1}" })] });
    const h = await viewing(model, "poll", { read: async (sessionId, options) => {
        if (options?.kvRevision) return { workflowId: "wf", runId: RUN, kv: KV[options.kvRevision] };
        return model;
    } });
    let lines = details(h.store);
    assert.ok(lines.includes("Variables applied: revision 1 · accepted now: revision 3 — i compares them"), lines.join("\n"));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_INSPECT_VARIABLES);
    await settle();
    assert.deepEqual(h.calls.filter(([, options]) => options?.kvRevision).map(([, options]) => options), [{ runId: RUN, kvRevision: 1 }, { runId: RUN, kvRevision: 3 }]);
    assert.equal(statusOf(h.store), "Variables of revision 1 (applied) and 3 (accepted now) are in the details (PgUp/PgDn scroll)");
    lines = details(h.store);
    const at = lines.indexOf("  Revision 1 → 3: 1 added · 1 removed · 1 changed · 0 unchanged");
    assert.ok(at > 0, lines.join("\n"));
    assert.deepEqual(lines.slice(at + 1, at + 4), ["    ~ a: 1 → 2", "    - b: \"x\"", "    + c: true"]);
    // Another run, even with the same execution ids, shows nothing of this comparison.
    h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { selectedRunId: OTHER, readModel: OTHER_RUN, readModelRunId: OTHER } });
    assert.ok(!details(h.store).some(line => line.includes("Revision 1 → 3")));
    // The portal's node Details: the same two revisions, and the comparison table.
    const projection = projectWorkflowV2({ readModel: model });
    const poll = projection.nodes.find(node => node.id === "poll");
    const view = h.store.getState().ui.workflowViews.wf;
    const html = renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, { tab: "details", selected: poll, nodes: projection.nodes, select() {},
        runOutput: null, runError: null, runId: RUN, kv: { accepted: 3, snapshots: view.kvRevisions, compare: view.kvCompare, onCompare() {} } }));
    assert.ok(html.includes("Revision 1 · accepted now: revision 3"), html);
    assert.ok(html.includes("data-action=\"compare-variables\""));
    assert.ok(html.includes("Revision 1 → 3: 1 added, 1 removed, 1 changed, 0 unchanged."));
    assert.equal([...html.matchAll(/data-change="(added|removed|changed)"/g)].length, 3);
});

// Re-check RC-7: in the TUI a branch step's result and [ ] status name the shown visit's branch and parallel visit, and say
// that [ ] go through every branch. RC-6: the choice keeps the parallel visit current when it was made; a new one ends it.
const BRANCH_GRAPH = { revision: 1, initial: "fan", states: [
    { id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 2, join: "all_required", failFast: false,
        body: { initial: "prepare", states: ["prepare", "reviewed"] }, outcomes: ["joined", "blocked"], next: { joined: "done", blocked: "failed" } },
    { id: "prepare", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["ready"], next: { ready: "reviewed" }, parallel: "fan" },
    { id: "reviewed", type: "terminal", outcome: "succeeded", parallel: "fan" },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
] };
const inBranch = (fan, index) => ({ scopeId: `${fan}#${index}`, branch: { parallelNodeExecutionId: fan, index } });
const BRANCH_ROWS = [
    done("fan", 1, "joined", { nodeExecutionId: "nx-fan-1", branches: 2 }),
    done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-1b0", outputPreview: "{\"who\":\"a\"}", ...inBranch("nx-fan-1", 0) }),
    done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-1b1", outputPreview: "{\"who\":\"b\"}", ...inBranch("nx-fan-1", 1) }),
    row("fan", 2, "pending", { nodeExecutionId: "nx-fan-2", branches: 1 }),
    done("prepare", 1, "ready", { nodeExecutionId: "nx-prepare-2b0", outputPreview: "{\"who\":\"c\"}", ...inBranch("nx-fan-2", 0) }),
];

test("RC-7: the TUI names the branch and parallel visit of a branch step's shown result; RC-6: a new parallel visit ends a choice", async () => {
    const h = await viewing(readModel({ graph: BRANCH_GRAPH, nodeExecutions: BRANCH_ROWS }), "prepare");
    let lines = details(h.store);
    assert.ok(lines.includes("Result of visit 1 · item 1 · For each visit 2 · latest · [ older · ] newer · all items"), lines.join("\n"));
    assert.ok(lines.includes("  Output: {\"who\":\"c\"}"));
    // [ : the newest older visit, of branch 2 in the first parallel visit; every one says where it was.
    await older(h);
    assert.equal(statusOf(h.store), "Showing visit 1 · item 2 · For each visit 1");
    assert.deepEqual(chosenOf(h.store), { runId: RUN, stateId: "prepare", executionId: "nx-prepare-1b1", parallelExecutionId: "nx-fan-2" });
    lines = details(h.store);
    assert.ok(lines.includes("Result of visit 1 · item 2 · For each visit 1 · chosen · [ older · ] newer · all items"), lines.join("\n"));
    assert.ok(lines.includes("  Output: {\"who\":\"b\"}"));
    await older(h);
    assert.equal(statusOf(h.store), "Showing visit 1 · item 1 · For each visit 1");
    assert.ok(details(h.store).includes("  Output: {\"who\":\"a\"}"));
    // A third parallel visit starts: the choice made in the second ends, and no older visit's result is shown as the step's own.
    h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: readModel({ graph: BRANCH_GRAPH, nodeExecutions: [
        ...BRANCH_ROWS.slice(0, 3), done("fan", 2, "joined", { nodeExecutionId: "nx-fan-2", branches: 1 }), BRANCH_ROWS[4],
        row("fan", 3, "pending", { nodeExecutionId: "nx-fan-3", branches: 1 })] }), readModelRunId: null } });
    lines = details(h.store);
    assert.ok(!lines.some(line => line.startsWith("Result of visit")), lines.join("\n"));
    assert.ok(!lines.includes("  Output: {\"who\":\"a\"}"));
});
