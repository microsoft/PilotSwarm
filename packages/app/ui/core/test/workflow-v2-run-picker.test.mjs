// The workflow v2 run picker: it lists the runs of the last read model (readWorkflowV2View `runs`), writes only
// `ui.workflowViews[sessionId].selectedRunId` (null is the live run), and shows nothing of another run while the
// selected one loads. The controller's own read-model rules are exercised through its real ensureWorkflowReadModel.
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    workflowV2Definition, workflowReadModelView, projectWorkflowV2,
} from "../src/workflow-v2-view.js";
import { WorkflowMainPane, WorkflowNodePane } from "../../react/src/workflow-workspace.js";
import { selectWorkflowV2Run, workflowV2RunPickerModel } from "../../react/src/workflow-v2-panels.js";
import { startedData, ev, row, done, readModel } from "./workflow-v2-fixtures.mjs";

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
const def = () => workflowV2Definition(startedData);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function until(check, label) {
    for (let turn = 0; turn < 200; turn += 1) { if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
    assert.fail(`never reached: ${label}`);
}

// Review 19:27Z (row 5): in the Workflow's words, no id (its tooltip has it); the Workflow's own option says its revision (its
// state is the view's title).
test("several live and test runs are listed with kind, state, outcome and revision; the live run is listed once, first", () => {
    const model = workflowV2RunPickerModel({ workflowModel: MODEL, selectedRunId: null, ownModelLoaded: true });
    assert.deepEqual(model.options.map(option => [option.value, option.kind]), [["", "live"], ["run-test-1", "test"], ["run-old", "live"], ["run-test-2", "test"]]);
    assert.equal(model.options[0].label, "Workflow · revision 1");
    assert.equal(model.options[1].label, "Test · Completed · succeeded · revision 1");
    assert.equal(model.options[2].label, "Workflow · Failed · failed · revision 1");
    assert.equal(model.value, "");
    assert.deepEqual(model.notes, []);
    assert.equal(model.runCount, 4);
    const test2 = workflowV2RunPickerModel({ workflowModel: MODEL, selectedRunId: "run-test-2", ownModelLoaded: true });
    assert.equal(test2.value, "run-test-2");
    assert.equal(test2.missing, false);
    // The live run chosen by its own id shows as the live run's option, not a second one (flow-03).
    const byId = workflowV2RunPickerModel({ workflowModel: MODEL, selectedRunId: "run-live", ownModelLoaded: true });
    assert.equal(byId.value, "");
    assert.deepEqual(byId.options.map(option => option.value), ["", "run-test-1", "run-old", "run-test-2"]);
    assert.equal(workflowV2RunPickerModel({ workflowModel: readModel({ runs: [run("a", "test")] }), selectedRunId: null, ownModelLoaded: true }).options[0].label, "Workflow", "no live run is listed");
});

test("a selected id that is not listed, or whose list is not loaded, stays visible instead of falling back", () => {
    const unlisted = workflowV2RunPickerModel({ workflowModel: MODEL, selectedRunId: "run-from-link-0123456789", ownModelLoaded: false });
    assert.equal(unlisted.value, "run-from-link-0123456789");
    assert.equal(unlisted.options.at(-1).label, "Chosen · not in the list that was read");
    assert.equal(unlisted.options.at(-1).title, "run-from-link-0123456789");
    assert.deepEqual(unlisted.notes.map(note => note.text), ["This one is not in the list that was read; only what is loaded for it is shown.", "Reading this one…"]);
    const notLoaded = workflowV2RunPickerModel({ workflowModel: null, selectedRunId: "run-x", ownModelLoaded: false });
    assert.equal(notLoaded.value, "run-x");
    assert.equal(notLoaded.options.at(-1).label, "Chosen · list not loaded");
    assert.deepEqual(notLoaded.notes.map(note => note.text), ["The list is not loaded yet.", "Reading this one…"]);
    assert.equal(notLoaded.missing, true);
    // A listed run is selectable by its own id even beyond the display limit.
    const many = readModel({ runs: Array.from({ length: 130 }, (_, i) => run(`r-${i}`, i % 2 ? "test" : "live")) });
    const far = workflowV2RunPickerModel({ workflowModel: many, selectedRunId: "r-120", ownModelLoaded: true });
    assert.equal(far.options.length, 1 + 100 + 1);
    assert.equal(far.options.at(-1).value, "r-120");
    assert.ok(far.notes.some(note => note.text === "Showing the first 100 of 130."));
});

test("a malformed run list is counted and left out; an unrecognized model gives no list; the pane never throws", () => {
    const junk = readModel({ runs: [null, 7, "x", [], { mode: "live" }, { runId: "" }, { runId: 5 }, run("ok"), run("ok"), { runId: "odd", mode: "mystery", status: "weird", revision: "x", outcome: 3 }] });
    const model = workflowV2RunPickerModel({ workflowModel: junk, selectedRunId: null, ownModelLoaded: true });
    assert.deepEqual(model.options.map(option => option.value), ["", "odd"]);
    assert.equal(model.malformed, 8);
    assert.equal(model.options[0].label, "Workflow · revision 1");
    assert.equal(model.options[1].label, "Run · mode not recognized · Not certain");
    assert.deepEqual(model.notes.map(note => note.text), ["8 entries in the list could not be read and are not listed."]);
    const one = workflowV2RunPickerModel({ workflowModel: readModel({ runs: [null] }), ownModelLoaded: true });
    assert.deepEqual(one.notes.map(note => note.text), ["1 entry in the list could not be read and is not listed."]);
    for (const bad of [{ nope: true }, "text", 5, [], { workflowId: "w" }]) {
        const m = workflowV2RunPickerModel({ workflowModel: bad, selectedRunId: "r", ownModelLoaded: false });
        assert.equal(m.runsKnown, false);
        assert.equal(m.value, "r");
        assert.equal(m.notes[0].text, "The list is not available.");
    }
    assert.doesNotThrow(() => workflowV2RunPickerModel(undefined));
    assert.doesNotThrow(() => workflowV2RunPickerModel({ workflowModel: { ...MODEL, runs: "x" }, selectedRunId: 5, error: 3 }));
    assert.doesNotThrow(() => pane(seed({ view: { definition: def(), readModel: junk, readModelRunId: null } }).controller));
});

test("no runs and a model of an unknown format show no picker or an honest empty one", () => {
    const empty = workflowV2RunPickerModel({ workflowModel: readModel({ noRun: true }), ownModelLoaded: true });
    assert.deepEqual(empty.options.map(option => option.value), [""]);
    // The model still says it (the terminal shows it); the portal shows no picker until a run exists, and says
    // "No run yet" once, in the run's status (batch 5, g-07).
    assert.deepEqual(empty.notes.map(note => note.text), ["Not started yet."]);
    const none = pane(seed({ view: { definition: def(), readModel: readModel({ noRun: true }), readModelRunId: null } }).controller);
    assert.ok(!none.includes("aria-label=\"Workflow run\"") && !none.includes("Not started yet."));
    assert.equal(none.match(/<span class="ps-workflow-status">Not started<\/span>/g)?.length, 1);
    assert.match(none, /<span class="ps-workflow-status">Not started<\/span>/);
    // A run selected by its id is shown even before the run list has it.
    assert.match(pane(seed({ view: { definition: def(), readModel: readModel({ noRun: true }), readModelRunId: null, selectedRunId: "run-x" } }).controller),
        /<select aria-label="Workflow run"/);
    const junk = pane(seed({ view: { definition: def(), readModel: { nope: true }, readModelRunId: null } }).controller);
    assert.ok(!junk.includes("Workflow run"));
    assert.ok(!pane(seed({ view: {} }).controller).includes("Workflow run"), "no definition and no model: nothing to pick from");
});

test("the pane renders a native select with an accessible name, the selection chosen and a described status", () => {
    const html = pane(seed({ view: { definition: def(), readModel: MODEL, readModelRunId: null } }).controller);
    assert.match(html, /<select aria-label="Workflow run"/);
    assert.ok(!/<select[^>]*tabindex="-1"/.test(html), "reachable by keyboard");
    // flow-03: the live run is one option, the empty value, with its revision; the other three runs follow.
    assert.equal((html.match(/<option/g) || []).length, 4);
    assert.match(html, /<option[^>]*value=""[^>]*selected=""[^>]*>Workflow · revision 1<\/option>/);
    assert.ok(!html.includes('value="run-live"'), "the live run is not listed a second time by its id");
    const test2 = pane(seed({ view: { definition: def(), readModel: MODEL, readModelRunId: null, selectedRunId: "run-test-2" } }).controller);
    assert.match(test2, /<option[^>]*value="run-test-2"[^>]*selected=""[^>]*>Test · Canceled · revision 1<\/option>/);
    assert.ok(!/<option[^>]*value=""[^>]*selected/.test(test2));
    const describedBy = test2.match(/aria-describedby="([^"]+)"/)?.[1];
    assert.ok(describedBy && test2.includes(`id="${describedBy}"`), "the select is described by its status text");
    assert.match(test2, /Reading this one…/);
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
    assert.ok(html.includes(`title="&lt;img src=x onerror=alert(1)&gt;${"z".repeat(300)} · Test · Completed · revision 1 · outcome `), "the title carries the full id as text");
    const label = workflowV2RunPickerModel({ workflowModel: model, selectedRunId: null, ownModelLoaded: true }).options[1].label;
    assert.ok(label.length <= 120 && label.endsWith(" · revision 1") && !label.includes("zzzz"), label);
    assert.ok(workflowV2RunPickerModel({ workflowModel: MODEL, selectedRunId: hostile }).options.at(-1).label.length <= 120);
});

test("while the selected run's model loads or fails, nothing of the previously read run is overlaid, and the selection is kept", () => {
    const live = readModel({ nodeExecutions: [done("poll", 1, "changed"), row("pause", 2, "pending")], runs: [run("run-1"), ...MODEL.runs] });
    const viewOf = extra => ({ definition: def(), readModel: live, readModelRunId: null, ...extra });
    const liveHtml = pane(seed({ view: viewOf({}) }).controller);
    assert.match(liveHtml, /Done · changed/);
    const loading = pane(seed({ view: viewOf({ selectedRunId: "run-test-1" }) }).controller);
    assert.ok(!loading.includes("Done · changed"), "the live run's result is not drawn for the test run");
    assert.match(loading, /<span class="ps-workflow-status">Not loaded<\/span>/);
    assert.match(loading, /<option[^>]*value="run-test-1"[^>]*selected=""/);
    assert.match(loading, /Reading this one…/);
    const failingSeed = seed({ view: viewOf({ selectedRunId: "run-test-1", readModelAttempt: { runId: "run-test-1", afterSeq: null, sessionUpdatedAt: 1 },
        readModelError: "boom", sidePanel: "notices" }) });
    const failing = pane(failingSeed.controller);
    assert.ok(!failing.includes("Done · changed"));
    assert.match(failing, /This one could not be read\. Your choice is kept\./);
    // Batch 6 (r-3): the whole failure, with its Retry, is in the side pane's Notices.
    assert.match(renderToStaticMarkup(React.createElement(WorkflowNodePane, { controller: failingSeed.controller })),
        /The workflow&#x27;s current status could not be read: boom/);
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
    assert.match(pane(h.controller), /This one could not be read\. Your choice is kept\./);
    selectWorkflowV2Run(h.controller, SID, "run-test-2");
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(workflowReadModelView(h.view()).error, null);
    assert.equal(workflowReadModelView(h.view()).readModel.marker, "run-test-2");
});

test("run fields that are not plain data, and prototype keys, are read as unknown and never throw", () => {
    const items = [
        JSON.parse('{"runId":"a1","mode":{"toString":null},"status":{"toString":null},"outcome":{"toString":null},"revision":{"toString":null}}'),
        { runId: "a2", mode: "constructor", status: "constructor", outcome: "x" },
        { runId: "a3", mode: "__proto__", status: "toString" },
        JSON.parse('{"runId":"a4","mode":"hasOwnProperty","__proto__":{"mode":"live"}}'),
        Object.assign(Object.create({ mode: "live", status: "running", revision: 9, outcome: "inherited" }), { runId: "a5" }),
        Object.create({ runId: "inherited", mode: "live" }),
        JSON.parse('{"__proto__":{"runId":"zz"}}'),
    ];
    const workflowModel = readModel({ runs: items });
    let model;
    assert.doesNotThrow(() => { model = workflowV2RunPickerModel({ workflowModel, selectedRunId: "a2", ownModelLoaded: true }); });
    assert.deepEqual(model.options.map(option => option.value), ["", "a1", "a2", "a3", "a4", "a5"]);
    assert.equal(model.malformed, 2);
    assert.deepEqual(model.options.slice(1).map(option => option.label), [
        "Run · mode not recognized · Not certain",
        "Run · mode not recognized · Not certain · x",
        "Run · mode not recognized · Not certain",
        "Run · mode not recognized · Not certain",
        "Run · mode not recognized · Not certain",
    ]);
    assert.equal(model.options[0].label, "Workflow", "no listed run is a live run");
    assert.deepEqual(model.options.slice(1).map(option => option.kind), ["other", "other", "other", "other", "other"]);
    assert.ok(model.options.every(option => !/function|native code|\[object/.test(option.label + option.title)));
    let html;
    assert.doesNotThrow(() => { html = pane(seed({ view: { definition: def(), readModel: workflowModel, readModelRunId: null } }).controller); });
    assert.ok(html.includes("Run · mode not recognized · Not certain · x"));
    assert.ok(!/native code|\[object/.test(html));
});

test("long outcomes cannot hide which run an option is: kind, state and revision stay, and the tooltip names them all with the id", () => {
    const long = "needs-human-review-".repeat(20);
    const workflowModel = readModel({ runs: [
        run("run-0123456789-aaa1", "test", "completed", { outcome: long, revision: 3 }),
        run("run-0123456789-bbb2", "test", "completed", { outcome: long, revision: 4 }),
        run("run-9", "live", "failed", { outcome: "x".repeat(100000), revision: 12 }),
    ] });
    const [only, a, b] = workflowV2RunPickerModel({ workflowModel, selectedRunId: null, ownModelLoaded: true }).options;
    assert.equal(a.label, "Test · Completed · needs-human-review-… · revision 3");
    assert.equal(b.label, "Test · Completed · needs-human-review-… · revision 4");
    assert.notEqual(a.label, b.label);
    assert.equal(a.title, `run-0123456789-aaa1 · Test · Completed · revision 3 · outcome ${long.slice(0, 299)}…`);
    assert.ok(b.title.startsWith("run-0123456789-bbb2 · Test · Completed · revision 4 · outcome "));
    assert.equal(only.label, "Workflow · revision 12");
    assert.ok(only.label.length <= 120 && only.title.length <= 400);
    const html = pane(seed({ view: { definition: def(), readModel: workflowModel, readModelRunId: null } }).controller);
    assert.ok(html.includes("needs-human-review-… · revision 3") && html.includes("needs-human-review-… · revision 4"));
    assert.ok(html.includes("title=\"run-0123456789-aaa1 · Test"));
});

const GHOST = "run-test-ghost";
const ghostEvents = () => [
    ev("workflow.state_started", { runId: GHOST, nodeExecutionId: "nx-ghost-1", stateId: "poll", scopeId: "root", ordinal: 1, step: 1, type: "script" }),
    ev("workflow.state_completed", { runId: GHOST, nodeExecutionId: "nx-ghost-1", stateId: "poll", step: 1, outcome: "changed", resultKind: "business", outputPreview: '{"ghost":true}' }),
];
const listed = [run("run-live"), run("run-test-1", "test", "completed")];
/** The model read for the ghost test run: neither listed in `runs` nor started in the loaded events. */
const ghostModel = (mode = "test") => readModel({ runs: listed, run: { runId: GHOST, mode, status: "completed", outcome: "succeeded", terminalState: "done", output: '{"who":"ghost"}' } });
const liveModel = readModel({ runs: listed, run: { runId: "run-live", mode: "live", status: "running", output: '{"who":"live"}', nodeExecutions: [done("poll", 1, "unchanged")] } });

test("going back to live while its model loads or fails never draws the last test run's events, even when that run is neither listed nor started", async () => {
    const events = ghostEvents();
    // Pure projection: the live selection's own model is not here, the wide model was read for the ghost test run.
    for (const mode of ["test", "mystery", undefined]) {
        const projection = projectWorkflowV2({ definition: def(), workflowModel: ghostModel(mode), selectedRunId: null, events });
        assert.equal(projection.runId, null, `mode ${String(mode)}`);
        assert.ok(projection.nodes.every(node => node.state === "idle" && !node.current), `mode ${String(mode)}`);
        assert.equal(projection.status.label, "Not started");
        assert.ok(projection.banners.every(banner => !/v2 shape/.test(banner.text)), "events of a left-out run are not called malformed");
    }
    // The live run's own model draws only its own rows, and its own output.
    const ownLive = projectWorkflowV2({ definition: def(), readModel: liveModel, workflowModel: liveModel, selectedRunId: null, events });
    assert.equal(ownLive.runId, "run-live");
    assert.equal(ownLive.output, '{"who":"live"}');
    assert.equal(ownLive.nodes.find(node => node.id === "poll").stateLabel, "Done · unchanged");
    // Controls: a live wide model does not hide a newer live run's events, and an unmarked run is not excluded by mistake.
    const newer = [ev("workflow.state_completed", { runId: "run-new", nodeExecutionId: "nx-new-1", stateId: "poll", step: 1, outcome: "unchanged", resultKind: "business" })];
    assert.equal(projectWorkflowV2({ definition: def(), workflowModel: liveModel, selectedRunId: null, events: newer }).runId, "run-new");
    assert.equal(projectWorkflowV2({ definition: def(), selectedRunId: null, events: newer }).runId, "run-new");

    // The real controller and the rendered pane: test run, then back to live while its model loads, fails, and arrives.
    const h = seed({ events });
    h.transport.respond = async (_id, options) => (options.runId === GHOST ? ghostModel() : liveModel);
    selectWorkflowV2Run(h.controller, SID, GHOST);
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(h.view().readModelRunId, GHOST);
    selectWorkflowV2Run(h.controller, SID, null);
    const loading = pane(h.controller);
    assert.ok(!loading.includes("Done · changed"), "loading: no ghost overlay");
    assert.match(loading, /Not started/);
    assert.match(loading, /Reading the Workflow…/);
    assert.ok(!loading.includes("Test run"));
    h.transport.respond = async () => { throw Object.assign(new Error("live read failed"), { code: "INTERNAL_ERROR", status: 500 }); };
    await h.controller.ensureWorkflowReadModel(SID);
    const failed = pane(h.controller);
    assert.ok(!failed.includes("Done · changed"), "failed: no ghost overlay");
    assert.match(failed, /This one could not be read\. Your choice is kept\./);
    // Batch 6 (r-3): the failure itself, with its Retry, is in the side pane's Notices.
    h.store.dispatch({ type: "ui/workflowView", sessionId: SID, view: { sidePanel: "notices" } });
    assert.match(renderToStaticMarkup(React.createElement(WorkflowNodePane, { controller: h.controller })),
        /The workflow&#x27;s current status could not be read: live read failed/);
    h.store.dispatch({ type: "ui/workflowView", sessionId: SID, view: { sidePanel: null } });
    h.transport.respond = async () => liveModel;
    await h.controller.ensureWorkflowReadModel(SID, { force: true });
    assert.equal(h.view().readModelRunId, null);
    const arrived = pane(h.controller);
    assert.match(arrived, /Done · unchanged/);
    assert.ok(!arrived.includes("Done · changed"));
    assert.ok(!arrived.includes("live read failed"));
});
