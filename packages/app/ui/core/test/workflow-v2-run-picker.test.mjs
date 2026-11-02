// The workflow v2 run picker: it lists the runs of the last read model (readWorkflowV2View `runs`), writes only
// `ui.workflowViews[sessionId].selectedRunId` (null is the live run), and shows nothing of another run while the
// selected one loads. The controller's own read-model rules are exercised through its real ensureWorkflowReadModel.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import { workflowDefinition, workflowReadModelView } from "../src/workflow-view.js";
import { WorkflowMainPane } from "../../react/src/workflow-workspace.js";
import { selectWorkflowV2Run, workflowV2RunPickerModel } from "../../react/src/workflow-v2-panels.js";
import { startedData, legacyStartedData, row, done, readModel } from "./workflow-v2-fixtures.mjs";

const SID = "wf-picker";
const run = (runId, mode = "live", status = "running", extra = {}) => ({ runId, mode, status, revision: 1, outcome: null, ...extra });
const MODEL = readModel({ runs: [run("run-live"), run("run-test-1", "test", "completed", { outcome: "succeeded" }), run("run-old", "live", "failed", { outcome: "failed" }), run("run-test-2", "test", "cancelled")] });

function seed({ view = {}, events = [], kind = "workflow" } = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    const calls = [];
    const transport = { listSessions: async () => [], subscribeSession: () => () => {}, getSessionEventsBefore: async () => [],
        respond: async () => MODEL };
    transport.readWorkflow = (sessionId, options) => { calls.push([sessionId, options]); return transport.respond(sessionId, options); };
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, sessionKind: kind, title: "Watch", status: "running", updatedAt: 1 }] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    if (events.length) store.dispatch({ type: "history/set", sessionId: SID, history: { chat: [], activity: [], events, lastSeq: events.length } });
    store.dispatch({ type: "ui/workflowView", sessionId: SID, view });
    const controller = new PilotSwarmUiController({ store, transport });
    return { store, controller, transport, calls, view: () => store.getState().ui.workflowViews?.[SID] || {} };
}
const pane = controller => renderToStaticMarkup(React.createElement(WorkflowMainPane, { controller, log: null, icon: null }));
const def = () => workflowDefinition(startedData);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function until(check, label) {
    for (let turn = 0; turn < 200; turn += 1) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
    assert.fail(`never reached: ${label}`);
}

test("several live and test runs are listed with kind, status, outcome, revision and a short id; the live option names the first live run", () => {
    const model = workflowV2RunPickerModel({ workflowModel: MODEL, selectedRunId: null, ownModelLoaded: true });
    assert.deepEqual(model.options.map(option => [option.value, option.kind]), [["", "live"], ["run-live", "live"], ["run-test-1", "test"], ["run-old", "live"], ["run-test-2", "test"]]);
    assert.equal(model.options[0].label, "Live run · running · run-live");
    assert.equal(model.options[2].label, "Test · completed (succeeded) · revision 1 · run-test-1");
    assert.equal(model.options[3].label, "Live · failed (failed) · revision 1 · run-old");
    assert.equal(model.value, "");
    assert.deepEqual(model.notes, []);
    assert.equal(model.runCount, 4);
    const test2 = workflowV2RunPickerModel({ workflowModel: MODEL, selectedRunId: "run-test-2", ownModelLoaded: true });
    assert.equal(test2.value, "run-test-2");
    assert.equal(test2.missing, false);
    assert.equal(workflowV2RunPickerModel({ workflowModel: readModel({ runs: [run("a", "test")] }), selectedRunId: null, ownModelLoaded: true }).options[0].label, "Live run", "no live run is listed");
});

test("a selected id that is not listed, or whose list is not loaded, stays visible instead of falling back", () => {
    const unlisted = workflowV2RunPickerModel({ workflowModel: MODEL, selectedRunId: "run-from-link-0123456789", ownModelLoaded: false });
    assert.equal(unlisted.value, "run-from-link-0123456789");
    assert.equal(unlisted.options.at(-1).label, "Selected run run-from… · not in the run list that was read");
    assert.equal(unlisted.options.at(-1).title, "run-from-link-0123456789");
    assert.deepEqual(unlisted.notes.map(note => note.text), ["This run is not in the run list that was read; only what is loaded for it is shown.", "Reading this run…"]);
    const notLoaded = workflowV2RunPickerModel({ workflowModel: null, selectedRunId: "run-x", ownModelLoaded: false });
    assert.equal(notLoaded.value, "run-x");
    assert.equal(notLoaded.options.at(-1).label, "Selected run run-x · run list not loaded");
    assert.deepEqual(notLoaded.notes.map(note => note.text), ["Run list not loaded yet.", "Reading this run…"]);
    assert.equal(notLoaded.missing, true);
    // A listed run is selectable by its own id even beyond the display limit.
    const many = readModel({ runs: Array.from({ length: 130 }, (_, i) => run(`r-${i}`, i % 2 ? "test" : "live")) });
    const far = workflowV2RunPickerModel({ workflowModel: many, selectedRunId: "r-120", ownModelLoaded: true });
    assert.equal(far.options.length, 1 + 100 + 1);
    assert.equal(far.options.at(-1).value, "r-120");
    assert.ok(far.notes.some(note => note.text === "Showing the first 100 of 130 runs."));
});

test("a malformed run list is counted and left out; an unrecognized model gives no list; the pane never throws", () => {
    const junk = readModel({ runs: [null, 7, "x", [], { mode: "live" }, { runId: "" }, { runId: 5 }, run("ok"), run("ok"), { runId: "odd", mode: "mystery", status: "weird", revision: "x", outcome: 3 }] });
    const model = workflowV2RunPickerModel({ workflowModel: junk, selectedRunId: null, ownModelLoaded: true });
    assert.deepEqual(model.options.map(option => option.value), ["", "ok", "odd"]);
    assert.equal(model.malformed, 8);
    assert.equal(model.options[2].label, "Run (mode not recognized) · status unknown · odd");
    assert.deepEqual(model.notes.map(note => note.text), ["8 run entries in the run list could not be read and are not listed."]);
    const one = workflowV2RunPickerModel({ workflowModel: readModel({ runs: [null] }), ownModelLoaded: true });
    assert.deepEqual(one.notes.map(note => note.text), ["1 run entry in the run list could not be read and is not listed."]);
    for (const bad of [{ nope: true }, "text", 5, [], { workflowId: "w" }]) {
        const m = workflowV2RunPickerModel({ workflowModel: bad, selectedRunId: "r", ownModelLoaded: false });
        assert.equal(m.runsKnown, false);
        assert.equal(m.value, "r");
        assert.equal(m.notes[0].text, "The run list is unavailable.");
    }
    assert.doesNotThrow(() => workflowV2RunPickerModel(undefined));
    assert.doesNotThrow(() => workflowV2RunPickerModel({ workflowModel: { ...MODEL, runs: "x" }, selectedRunId: 5, error: 3 }));
    assert.doesNotThrow(() => pane(seed({ view: { definition: def(), readModel: junk, readModelRunId: null } }).controller));
});

test("no runs, a legacy workflow and a model that is not v2 show no picker or an honest empty one", () => {
    const empty = workflowV2RunPickerModel({ workflowModel: readModel({ noRun: true }), ownModelLoaded: true });
    assert.deepEqual(empty.options.map(option => option.value), [""]);
    assert.deepEqual(empty.notes.map(note => note.text), ["No runs yet."]);
    assert.match(pane(seed({ view: { definition: def(), readModel: readModel({ noRun: true }), readModelRunId: null } }).controller), /No runs yet\./);
    const legacy = pane(seed({ view: { definition: workflowDefinition(legacyStartedData) } }).controller);
    assert.ok(!legacy.includes("Workflow run"));
    assert.ok(legacy.includes("node · idle"), "the legacy graph is unchanged");
    const legacyJunk = pane(seed({ view: { definition: workflowDefinition(legacyStartedData), readModel: { nope: true }, readModelRunId: null } }).controller);
    assert.ok(!legacyJunk.includes("Workflow run"));
    assert.ok(!pane(seed({ view: {} }).controller).includes("Workflow run"), "no definition and no model: nothing to pick from");
});

test("the pane renders a native select with an accessible name, the selection chosen and a described status", () => {
    const html = pane(seed({ view: { definition: def(), readModel: MODEL, readModelRunId: null } }).controller);
    assert.match(html, /<select aria-label="Workflow run"/);
    assert.ok(!/<select[^>]*tabindex="-1"/.test(html), "reachable by keyboard");
    assert.equal((html.match(/<option/g) || []).length, 5);
    assert.match(html, /<option[^>]*value=""[^>]*selected=""[^>]*>Live run · running · run-live<\/option>/);
    const test2 = pane(seed({ view: { definition: def(), readModel: MODEL, readModelRunId: null, selectedRunId: "run-test-2" } }).controller);
    assert.match(test2, /<option[^>]*value="run-test-2"[^>]*selected=""[^>]*>Test · cancelled · revision 1 · run-test-2<\/option>/);
    assert.ok(!/<option[^>]*value=""[^>]*selected/.test(test2));
    const describedBy = test2.match(/aria-describedby="([^"]+)"/)?.[1];
    assert.ok(describedBy && test2.includes(`id="${describedBy}"`), "the select is described by its status text");
    assert.match(test2, /Reading this run…/);
    // Selecting maps the empty value to the live run and any other value to that run id.
    const h = seed({ view: { definition: def() } });
    assert.equal(selectWorkflowV2Run(h.controller, SID, "run-test-1"), "run-test-1");
    assert.equal(h.view().selectedRunId, "run-test-1");
    assert.equal(selectWorkflowV2Run(h.controller, SID, ""), null);
    assert.equal(h.view().selectedRunId, null);
    assert.equal(selectWorkflowV2Run(h.controller, SID, undefined), null);
    assert.deepEqual(Object.keys(h.view()).sort(), ["definition", "selectedRunId"], "only the selection is written");
});

test("run ids, outcomes and long text render escaped and bounded", () => {
    const hostile = `<img src=x onerror=alert(1)>${"z".repeat(300)}`;
    const model = readModel({ runs: [run(hostile, "test", "completed", { outcome: "<b>done</b>".repeat(30) }), run("r2")] });
    const html = pane(seed({ view: { definition: def(), readModel: model, readModelRunId: null, selectedRunId: hostile } }).controller);
    assert.ok(!html.includes("<img src=x"));
    assert.ok(!html.includes("<b>done"));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(html.includes(`title="&lt;img src=x onerror=alert(1)&gt;${"z".repeat(300)}"`), "the title carries the full id as text");
    const label = workflowV2RunPickerModel({ workflowModel: model, selectedRunId: null, ownModelLoaded: true }).options[1].label;
    assert.ok(label.length <= 100 && label.endsWith("…"));
    assert.ok(workflowV2RunPickerModel({ workflowModel: MODEL, selectedRunId: hostile }).options.at(-1).label.length <= 100);
});

test("while the selected run's model loads or fails, nothing of the previously read run is overlaid, and the selection is kept", () => {
    const live = readModel({ nodeExecutions: [done("poll", 1, "changed"), row("pause", 2, "pending")], runs: [run("run-1"), ...MODEL.runs] });
    const viewOf = extra => ({ definition: def(), readModel: live, readModelRunId: null, ...extra });
    const liveHtml = pane(seed({ view: viewOf({}) }).controller);
    assert.match(liveHtml, /Done · changed/);
    const loading = pane(seed({ view: viewOf({ selectedRunId: "run-test-1" }) }).controller);
    assert.ok(!loading.includes("Done · changed"), "the live run's result is not drawn for the test run");
    assert.match(loading, /Selected run not loaded/);
    assert.match(loading, /<option[^>]*value="run-test-1"[^>]*selected=""/);
    assert.match(loading, /Reading this run…/);
    const failing = pane(seed({ view: viewOf({ selectedRunId: "run-test-1", readModelAttempt: { runId: "run-test-1", afterSeq: null, sessionUpdatedAt: 1 }, readModelError: "boom" }) }).controller);
    assert.ok(!failing.includes("Done · changed"));
    assert.match(failing, /This run could not be read\. Your selection is kept\./);
    assert.match(failing, /The workflow&#x27;s current state could not be read: boom/);
    assert.match(failing, /<option[^>]*value="run-test-1"[^>]*selected=""/);
    assert.ok(!failing.includes("Reading this run…"));
    assert.deepEqual(workflowReadModelView({ readModel: live, readModelRunId: null, selectedRunId: "run-test-1" }).readModel, null);
});

test("choosing a run and clearing the choice read the actual run each time, and a late answer for a replaced choice is never shown", async () => {
    const h = seed({ events: [] });
    h.transport.respond = async (_id, options) => ({ ...MODEL, marker: options.runId ?? "live" });
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(h.view().readModel.marker, "live");
    selectWorkflowV2Run(h.controller, SID, "run-test-1");
    assert.equal(workflowReadModelView(h.view()).readModel, null, "the live model is not shown for the test run");
    await h.controller.ensureWorkflowReadModel(SID);
    assert.deepEqual(h.calls.at(-1), [SID, { runId: "run-test-1" }]);
    assert.equal(workflowReadModelView(h.view()).readModel.marker, "run-test-1");
    // Clearing goes back to a read of the live run, not the last test run: the view holds one model, the test run's,
    // which is not the live selection's own.
    selectWorkflowV2Run(h.controller, SID, null);
    assert.equal(workflowReadModelView(h.view()).readModel, null);
    await h.controller.ensureWorkflowReadModel(SID);
    assert.deepEqual(h.calls.at(-1), [SID, {}]);
    assert.equal(h.view().readModelRunId, null);
    assert.equal(workflowReadModelView(h.view()).readModel.marker, "live");

    // Rapid choices: run-old, then run-test-2 while run-old is still being read. The late answer is discarded and only
    // the current choice is asked for afterwards.
    const slow = deferred();
    const base = h.calls.length;
    h.transport.respond = (_id, options) => (options.runId === "run-old" ? slow.promise : Promise.resolve({ ...MODEL, marker: options.runId ?? "live-2" }));
    selectWorkflowV2Run(h.controller, SID, "run-old");
    const first = h.controller.ensureWorkflowReadModel(SID);
    await until(() => h.calls.length === base + 1, "the request for run-old");
    selectWorkflowV2Run(h.controller, SID, "run-test-2");
    h.controller.ensureWorkflowReadModel(SID).catch(() => {});
    slow.resolve({ ...MODEL, marker: "run-old-late" });
    await first;
    await until(() => h.view().readModelRunId === "run-test-2", "run-test-2's model");
    assert.deepEqual(h.calls.slice(base).map(call => call[1]), [{ runId: "run-old" }, { runId: "run-test-2" }]);
    assert.equal(h.view().readModel.marker, "run-test-2");
    assert.equal(h.view().selectedRunId, "run-test-2");

    // The same, but the choice goes back to the live run while run-old is read: the live run is read, never run-old.
    const slow2 = deferred();
    const base2 = h.calls.length;
    h.transport.respond = (_id, options) => (options.runId === "run-old" ? slow2.promise : Promise.resolve({ ...MODEL, marker: options.runId ?? "live-2" }));
    selectWorkflowV2Run(h.controller, SID, "run-old");
    const second = h.controller.ensureWorkflowReadModel(SID);
    await until(() => h.calls.length === base2 + 1, "the second request for run-old");
    selectWorkflowV2Run(h.controller, SID, null);
    h.controller.ensureWorkflowReadModel(SID).catch(() => {});
    slow2.resolve({ ...MODEL, marker: "run-old-late-2" });
    await second;
    await until(() => h.view().readModel?.marker === "live-2", "the live follow-up");
    assert.equal(h.view().readModelRunId, null);
    assert.equal(h.view().selectedRunId, null);
    assert.deepEqual(h.calls.slice(base2).map(call => call[1]), [{ runId: "run-old" }, {}]);
    assert.notEqual(h.view().readModel.marker, "run-old-late-2");
});

test("a failed read keeps the chosen run, and choosing again is not blocked", async () => {
    const h = seed({ events: [] });
    h.transport.respond = async (_id, options) => {
        if (options.runId === "run-test-1") throw Object.assign(new Error("read failed"), { code: "INTERNAL_ERROR", status: 500 });
        return { ...MODEL, marker: options.runId ?? "live" };
    };
    await h.controller.ensureWorkflowReadModel(SID);
    selectWorkflowV2Run(h.controller, SID, "run-test-1");
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(h.view().selectedRunId, "run-test-1");
    assert.equal(workflowReadModelView(h.view()).error, "read failed");
    assert.match(pane(h.controller), /This run could not be read\. Your selection is kept\./);
    selectWorkflowV2Run(h.controller, SID, "run-test-2");
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(workflowReadModelView(h.view()).error, null);
    assert.equal(workflowReadModelView(h.view()).readModel.marker, "run-test-2");
});
