/**
 * Workflow v2 read model wiring in the shared UI controller (readWorkflow,
 * GET /api/v1/sessions/:sessionId/workflow, access session:read; decision
 * read-workflow-transport, option A; review READ-WIRE-01 to 03):
 *   - opening a workflow session's definition also loads its read model
 *     through the transport, for the run selection, with readModelAfterSeq,
 *     the highest event sequence loaded BEFORE the request
 *   - a request is for one identity (run selection, loaded events, session
 *     row updatedAt); every completed one is recorded, and the same identity
 *     is never asked again unless forced: nothing retries on its own
 *   - one request runs per session; a call while it runs makes one follow-up;
 *     a response is applied only for its own request, selection and session
 *     kind (failures included), and a selection that changed while it ran is
 *     asked for without waiting for events
 *   - a model read for another run is neither reused nor overlaid, and while
 *     the selected run's own model loads or fails, no other run's events or
 *     model are shown for it (only its own events); the last model's
 *     workflow-wide parts (its graph, or that there is none, with the reason)
 *     stay, so an earlier definition is not drawn again
 *   - WORKFLOW_NOT_FOUND (also a version 2 session whose definition has not
 *     committed yet) shows no error and is asked again, once, on new events
 *     or a changed session row; a legacy definition is never asked for
 *   - any other failure keeps the model shown and is reported, bounded, for
 *     its selection, with a Retry in the side pane's Notices (rendered here on the
 *     server; the click is the controller's forced request)
 *   - the execution log names v2 wait and messaging states by their kind
 *
 * Run: node --test test/workflow-v2-read-model.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore, formatWorkflowEventText } from "../src/index.js";
import { workflowDefinition, workflowReadModelView } from "../src/workflow-view.js";
import { projectWorkflowV2 } from "../src/workflow-v2-view.js";
import { WorkflowMainPane, WorkflowNodePane } from "../../react/src/workflow-workspace.js";
import { RUN, startedData, legacyStartedData, ev, started, completed, row, done, readModel as fixtureReadModel } from "./workflow-v2-fixtures.mjs";

const SID = "wf-read-model";

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/** A read model shaped as readWorkflowV2View returns it; `marker` tells responses apart. */
function readModel(revision, marker) {
    return {
        workflowId: SID,
        definition: { state: "published", semver: "1.0.0", currentRevision: revision, publishedRevision: revision, publishedDefinitionHash: "h" },
        revision: { revision, definitionHash: "h", valid: true, irSha256: "i", name: "w", diagnostics: [] },
        graph: null, runs: [], run: null, marker,
    };
}

/** Let pending promise callbacks run, a bounded number of turns. */
async function until(check, label) {
    for (let turn = 0; turn < 200; turn += 1) {
        if (check()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(`never reached: ${label}`);
}

/** Let every pending promise callback run, a bounded number of turns, with nothing to wait for. */
async function settled() {
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setImmediate(resolve));
}

function seeded({ lastSeq = 7, sessionKind = "workflow", updatedAt = 1 } = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const calls = [];
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getSessionEventsBefore: async () => [],
        respond: async () => readModel(1, "default"),
    };
    transport.readWorkflow = (sessionId, options) => { calls.push([sessionId, options]); return transport.respond(sessionId, options); };
    const controller = new PilotSwarmUiController({ store, transport });
    const setSession = fields => store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "Workflow: w", status: "running",
        sessionKind, updatedAt, ...fields }] });
    setSession({});
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    const setLastSeq = seq => store.dispatch({ type: "history/set", sessionId: SID, history: { chat: [], activity: [], events: [], lastSeq: seq } });
    if (lastSeq !== null) setLastSeq(lastSeq);
    const view = () => store.getState().ui.workflowViews?.[SID] || {};
    const select = runId => store.dispatch({ type: "ui/workflowView", sessionId: SID, view: { selectedRunId: runId } });
    return { controller, store, transport, calls, view, setLastSeq, setSession, select };
}

test("opening a workflow's definition also loads its read model, for the selection and the events loaded before the request", async () => {
    const h = seeded({ lastSeq: 4 });
    h.transport.respond = async () => readModel(1, "loaded");
    await h.controller.ensureWorkflowDefinition(SID);
    await until(() => h.view().readModel?.marker === "loaded", "the read model in the view");
    assert.deepEqual(h.calls, [[SID, {}]]);
    assert.equal(h.view().readModelRunId, null);
    assert.equal(h.view().readModelAfterSeq, 4);
    assert.deepEqual(h.view().readModelAttempt, { runId: null, afterSeq: 4, sessionUpdatedAt: 1 });
    assert.equal(h.view().readModelError, null);
    assert.equal(h.view().readModelUnavailable, false);
    // The same identity is not asked again.
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(h.calls.length, 1);
    // A session whose history was never loaded gets no watermark (it is not proven), and is asked once for it.
    const unloaded = seeded({ lastSeq: null });
    await unloaded.controller.ensureWorkflowReadModel(SID);
    await unloaded.controller.ensureWorkflowReadModel(SID);
    assert.equal(unloaded.view().readModel?.marker, "default");
    assert.equal(unloaded.view().readModelAfterSeq, null);
    assert.equal(unloaded.calls.length, 1);
});

test("runs one request per session and fetches once more for events that arrived meanwhile", async () => {
    const h = seeded({ lastSeq: 7 });
    const responses = [deferred(), deferred()];
    h.transport.respond = () => responses[h.calls.length - 1].promise;
    const first = h.controller.ensureWorkflowReadModel(SID);
    // Events arrive while it is in flight: the second call joins it (no second request now), and the first keeps watermark 7.
    h.setLastSeq(9);
    const joined = h.controller.ensureWorkflowReadModel(SID);
    await until(() => h.calls.length === 1, "the first request");
    responses[0].resolve(readModel(1, "first"));
    await until(() => h.calls.length === 2, "the second request");
    assert.equal(h.view().readModel.marker, "first");
    assert.equal(h.view().readModelAfterSeq, 7);
    responses[1].resolve(readModel(1, "second"));
    await Promise.all([first, joined]);
    assert.equal(h.view().readModel.marker, "second");
    assert.equal(h.view().readModelAfterSeq, 9);
    assert.equal(h.calls.length, 2);
});

test("READ-WIRE-01: the run selection is part of a request's identity; a model read for another run is neither reused nor shown", async () => {
    const h = seeded({ lastSeq: 5 });
    h.transport.respond = async (_id, options) => readModel(1, options.runId ?? "live");
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(h.view().readModel.marker, "live");

    // Another run at the same events: the cached live model is not reused, and not shown meanwhile.
    h.select("run-2");
    assert.equal(workflowReadModelView(h.view()).readModel, null);
    assert.equal(workflowReadModelView(h.view()).readModelAfterSeq, null);
    await h.controller.ensureWorkflowReadModel(SID);
    assert.deepEqual(h.calls.at(-1), [SID, { runId: "run-2" }]);
    assert.equal(workflowReadModelView(h.view()).readModel.marker, "run-2");
    assert.equal(h.view().readModelRunId, "run-2");

    // Back to the live run, still at the same events: asked again for it.
    h.select(null);
    await h.controller.ensureWorkflowReadModel(SID);
    assert.deepEqual(h.calls.at(-1), [SID, {}]);
    assert.equal(workflowReadModelView(h.view()).readModel.marker, "live");
    const asked = h.calls.length;

    // The selection changes while a request runs, with no new events and no other call: its answer is discarded and the
    // new selection is asked for after it.
    const inFlight = deferred();
    h.transport.respond = (_id, options) => (options.runId === undefined ? inFlight.promise : Promise.resolve(readModel(1, options.runId)));
    h.setLastSeq(6);
    const loading = h.controller.ensureWorkflowReadModel(SID);
    await until(() => h.calls.length === asked + 1, "the live request");
    h.select("run-3");
    inFlight.resolve(readModel(1, "live-late"));
    await loading;
    await until(() => h.calls.length === asked + 2, "the follow-up for run-3");
    assert.deepEqual(h.calls.at(-1), [SID, { runId: "run-3" }]);
    await until(() => h.view().readModelRunId === "run-3", "run-3's model");
    assert.equal(workflowReadModelView(h.view()).readModel.marker, "run-3");

    // A failure for a selection that changed while it ran is not recorded for the new one.
    const failing = deferred();
    h.transport.respond = (_id, options) => (options.runId === "run-3" ? failing.promise : Promise.resolve(readModel(1, "live-again")));
    h.setLastSeq(7);
    const failingLoad = h.controller.ensureWorkflowReadModel(SID);
    await until(() => h.calls.at(-1)?.[1]?.runId === "run-3" && h.calls.length === asked + 3, "run-3's request");
    h.select(null);
    failing.reject(Object.assign(new Error("run-3 failed"), { code: "INTERNAL_ERROR", status: 500 }));
    await failingLoad;
    await until(() => h.view().readModel?.marker === "live-again", "the live follow-up");
    assert.equal(h.view().readModelError, null);
    assert.equal(workflowReadModelView(h.view()).error, null);
});

test("discards a superseded answer (then asks again), records an older one without applying it, and gives a non-workflow nothing", async () => {
    const h = seeded({ lastSeq: 6 });
    h.transport.respond = async () => readModel(3, "shown");
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(h.view().readModel.marker, "shown");

    // Superseded: the answer of an invalidated request is discarded, and a new request follows it.
    h.setLastSeq(7);
    const superseded = deferred();
    h.transport.respond = () => superseded.promise;
    const loading = h.controller.ensureWorkflowReadModel(SID);
    await until(() => h.calls.length === 2, "the superseded request");
    h.controller.invalidateWorkflowReadModel(SID);
    h.transport.respond = async () => readModel(3, "after-invalidation");
    superseded.resolve(readModel(4, "superseded"));
    await loading;
    await until(() => h.view().readModel?.marker === "after-invalidation", "the request after the invalidation");
    assert.equal(h.calls.length, 3);

    // An older definition revision than the one shown is not applied, but recorded: it is not asked for again in a loop.
    h.setLastSeq(8);
    h.transport.respond = async () => readModel(2, "older-revision");
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(h.view().readModel.marker, "after-invalidation");
    assert.deepEqual(h.view().readModelAttempt, { runId: null, afterSeq: 8, sessionUpdatedAt: 1 });
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(h.calls.length, 4);

    // A session that stopped being a workflow while the request was in flight takes nothing, and is not asked again.
    h.setLastSeq(10);
    const gone = deferred();
    h.transport.respond = () => gone.promise;
    const loadingGone = h.controller.ensureWorkflowReadModel(SID);
    await until(() => h.calls.length === 5, "the request before the kind change");
    h.setSession({ title: "Agent", sessionKind: "agent" });
    gone.resolve(readModel(5, "after-kind-change"));
    await loadingGone;
    await settled();
    assert.notEqual(h.view().readModel?.marker, "after-kind-change");
    assert.equal(h.calls.length, 5);
});

test("READ-WIRE-03: WORKFLOW_NOT_FOUND is asked again once on a changed session row or new events, never in a loop, never for a legacy definition", async () => {
    const notYet = () => { throw Object.assign(new Error("This session is not a version 2 workflow."), { code: "WORKFLOW_NOT_FOUND", status: 404 }); };
    // The creation window: the session row committed, its definition not yet.
    const h = seeded({ lastSeq: 0, updatedAt: 1 });
    h.transport.respond = async () => notYet();
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(h.view().readModelUnavailable, true);
    assert.equal(h.view().readModelError, null, "not an error the pane shows");
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(h.calls.length, 1, "the same identity is not asked again");
    // The definition commits and writes the session row's title (a draft has no event): asked again, once, and read.
    h.transport.respond = async () => readModel(1, "draft");
    h.setSession({ title: "Workflow: w", updatedAt: 2 });
    await h.controller.ensureWorkflowReadModel(SID);
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(h.calls.length, 2);
    assert.equal(h.view().readModel.marker, "draft");
    assert.equal(h.view().readModelUnavailable, false);

    // New events (the run's workflow.started) also ask again after a not-found; nothing else does.
    const started = seeded({ lastSeq: 0 });
    started.transport.respond = async () => notYet();
    await started.controller.ensureWorkflowReadModel(SID);
    started.transport.respond = async () => readModel(1, "started");
    started.setLastSeq(1);
    await started.controller.ensureWorkflowReadModel(SID);
    assert.equal(started.calls.length, 2);
    assert.equal(started.view().readModel.marker, "started");

    // A legacy definition, from the session's own workflow.started event, has no read model: never asked, even with new
    // events or a forced retry.
    const legacy = seeded({ lastSeq: 3 });
    legacy.store.dispatch({ type: "ui/workflowView", sessionId: SID, view: { definition: workflowDefinition(legacyStartedData) } });
    legacy.setLastSeq(9);
    await legacy.controller.ensureWorkflowReadModel(SID);
    await legacy.controller.ensureWorkflowReadModel(SID, { force: true });
    await legacy.controller.ensureWorkflowDefinition(SID, { retry: true });
    assert.equal(legacy.calls.length, 0);

    // A transport without the operation keeps the event-only view; an agent session is never asked.
    const unsupported = seeded();
    unsupported.transport.readWorkflow = undefined;
    await unsupported.controller.ensureWorkflowReadModel(SID);
    assert.equal(unsupported.view().readModel, undefined);
    const agent = seeded({ sessionKind: "agent" });
    await agent.controller.ensureWorkflowReadModel(SID);
    assert.equal(agent.calls.length, 0);
    assert.equal(agent.store.getState().ui.workflowViews?.[SID], undefined);
});

test("READ-WIRE-02: a failure keeps the model shown, is reported bounded for its selection, is not retried on its own, and Retry asks now", async () => {
    const h = seeded({ lastSeq: 3 });
    h.transport.respond = async () => readModel(1, "kept");
    await h.controller.ensureWorkflowReadModel(SID);
    h.setLastSeq(4);
    const long = "x".repeat(400);
    h.transport.respond = async () => { throw Object.assign(new Error(long), { code: "INTERNAL_ERROR", status: 500 }); };
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(h.view().readModel.marker, "kept");
    const shown = workflowReadModelView(h.view());
    assert.equal(shown.readModel.marker, "kept");
    assert.equal(shown.error.length, 300);
    assert.ok(shown.error.endsWith("…"));
    // Not retried on its own for the same identity.
    await h.controller.ensureWorkflowReadModel(SID);
    await h.controller.ensureWorkflowDefinition(SID);
    assert.equal(h.calls.length, 2);
    // Another selection does not show this selection's error.
    h.select("run-2");
    assert.equal(workflowReadModelView(h.view()).error, null);
    h.select(null);
    // Retry (forced) asks now, and success clears the error.
    h.transport.respond = async () => readModel(1, "recovered");
    await h.controller.ensureWorkflowReadModel(SID, { force: true });
    assert.equal(h.calls.length, 3);
    assert.equal(h.view().readModel.marker, "recovered");
    assert.equal(workflowReadModelView(h.view()).error, null);
    // A Retry while a request runs is honoured after it, even at the same identity.
    const running = deferred();
    h.transport.respond = () => running.promise;
    const loading = h.controller.ensureWorkflowReadModel(SID, { force: true });
    await until(() => h.calls.length === 4, "the running request");
    h.transport.respond = async () => readModel(1, "after-retry");
    const retried = h.controller.ensureWorkflowReadModel(SID, { force: true });
    running.reject(Object.assign(new Error("Service unavailable."), { code: "INTERNAL_ERROR", status: 503 }));
    await Promise.all([loading, retried]);
    await until(() => h.view().readModel?.marker === "after-retry", "the retried request");
    assert.equal(h.calls.length, 5);
    assert.equal(workflowReadModelView(h.view()).error, null);
});

test("READ-WIRE-02: the side pane shows the selected run's read failure, with a Retry, and never another run's", () => {
    const render = view => {
        const store = createStore(appReducer, createInitialState({ mode: "api" }));
        store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, sessionKind: "workflow", title: "Watch" }] });
        store.dispatch({ type: "sessions/selected", sessionId: SID });
        store.dispatch({ type: "ui/workflowView", sessionId: SID, view });
        const controller = new PilotSwarmUiController({ store, transport: {} });
        return renderToStaticMarkup(React.createElement(React.Fragment, null, React.createElement(WorkflowMainPane, { controller, icon: null }),
            view.sidePanel ? React.createElement(WorkflowNodePane, { controller }) : null));
    };
    const model = fixtureReadModel({ nodeExecutions: [done("poll", 1, "changed")] });
    // Batch 6 (r-3): the failure and its Retry show in the side pane's Notices.
    const failed = { definition: workflowDefinition(startedData), readModel: model, readModelRunId: null,
        readModelAttempt: { runId: null, afterSeq: 2, sessionUpdatedAt: null }, readModelError: "Service unavailable.", sidePanel: "notices" };
    const html = render(failed);
    assert.ok(html.includes("role=\"alert\""));
    assert.ok(html.includes("could not be read: Service unavailable."));
    assert.ok(html.includes(">Retry<"));
    assert.ok(html.includes("Wait · 30 s"), "the graph stays");
    assert.ok(html.includes("Done · changed"), "the last read model stays");
    // Another run selected: neither that run's error nor the live run's model is shown.
    const other = render({ ...failed, selectedRunId: "run-2" });
    assert.ok(!other.includes("could not be read"));
    assert.ok(!other.includes("Done · changed"));
    assert.ok(other.includes("Wait · 30 s"), "the workflow's graph");
    // No failure, no alert.
    assert.ok(!render({ ...failed, readModelError: null }).includes("could not be read"));
    // A legacy definition has no read model: a failure recorded before it loaded is not shown.
    const legacy = render({ ...failed, definition: workflowDefinition(legacyStartedData), readModel: null });
    assert.ok(!legacy.includes("could not be read"));
    assert.ok(legacy.includes("node · idle"), "the legacy graph");
});

/** Run A's durable events (the live run, run-1): its start, poll ended `changed`, then pause waiting. */
const runAEvents = [ev("workflow.started", startedData), started("poll", 1), completed("poll", 1, "changed", '{"n":1}'), started("pause", 2, { type: "wait" })];

/** The same event shape for another run. */
const inRun = (runId, event) => ({ ...event, data: { ...event.data, runId,
    ...(event.data.nodeExecutionId ? { nodeExecutionId: `${event.data.nodeExecutionId}-${runId}` } : {}) } });

/** The workflow pane rendered on the server from a workflow view and a loaded history (effects do not run). */
function renderPane(view, events = []) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, sessionKind: "workflow", title: "Watch" }] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    if (events.length) store.dispatch({ type: "history/set", sessionId: SID, history: { chat: [], activity: [], events, lastSeq: events.length } });
    store.dispatch({ type: "ui/workflowView", sessionId: SID, view });
    const controller = new PilotSwarmUiController({ store, transport: {} });
    // Batch 6 (r-3): with a side panel chosen, the side pane too (a read failure shows in its Notices).
    return renderToStaticMarkup(React.createElement(React.Fragment, null, React.createElement(WorkflowMainPane, { controller, icon: null }),
        view.sidePanel ? React.createElement(WorkflowNodePane, { controller }) : null));
}

/** Nothing of run A: its executions, its waiting state and its status. */
function assertNoRunA(html, label) {
    assert.ok(!html.includes("Done · changed"), `${label}: no execution of run A`);
    assert.ok(!html.includes(">Waiting<") && !html.includes("data-phase=\"waiting\""), `${label}: no waiting state of run A`);
    assert.ok(!html.includes(">Running<"), `${label}: not run A's status`);
}

test("READ-WIRE-01: with run A's history loaded, a selected run B whose model is loading or failed shows nothing of run A, and the workflow's graph or its absence stays", () => {
    const definition = workflowDefinition(startedData);
    // The history is in effect: with the live selection and no read model, run A is drawn from its events.
    const live = renderPane({ definition }, runAEvents);
    // OF-S2-2: each card's state is in its title (the card shows a mark and a key fact).
    assert.ok(live.includes("Done · changed") && live.includes("· Waiting") && live.includes(">Running<"), "run A from its events");

    const modelA = fixtureReadModel({ nodeExecutions: [done("poll", 1, "changed"), row("pause", 2, "pending")] });
    const loading = { definition, readModel: modelA, readModelRunId: null, readModelAfterSeq: 4,
        readModelAttempt: { runId: null, afterSeq: 4, sessionUpdatedAt: null }, selectedRunId: "run-2" };
    const failed = { ...loading, readModelAttempt: { runId: "run-2", afterSeq: 4, sessionUpdatedAt: null }, readModelError: "Service unavailable.",
        sidePanel: "notices" };
    for (const [label, view] of [["loading", loading], ["failed", failed]]) {
        const html = renderPane(view, runAEvents);
        assertNoRunA(html, label);
        assert.ok(html.includes("Wait · 30 s"), `${label}: the workflow's graph stays`);
        assert.ok(html.includes(">Not loaded<"), `${label}: the header says so`);
        assert.equal(html.includes("could not be read: Service unavailable."), label === "failed", label);
        const projected = projectWorkflowV2({ ...workflowReadModelView(view), definition, events: runAEvents });
        assert.equal(projected.runId, "run-2", label);
        assert.equal(projected.readModel, null, label);
        assert.deepEqual([projected.inbox, projected.outbox, projected.output, projected.error], [[], [], null, null], label);
        assert.ok(projected.nodes.every(node => node.executions.length === 0 && node.pending === null), label);
    }

    // Run B's own events are drawn meanwhile; run A's are not.
    const runBEvents = [inRun("run-2", ev("workflow.started", startedData)), inRun("run-2", started("poll", 1)),
        inRun("run-2", completed("poll", 1, "unchanged"))];
    const mixed = renderPane(loading, [...runAEvents, ...runBEvents]);
    assert.ok(mixed.includes("Done · unchanged"), "run B's events");
    assert.ok(!mixed.includes("Done · changed") && !mixed.includes(">Waiting<"), "not run A's");
    // A selected run of another revision is not overlaid, even when its start is not loaded: the workflow's run list says its revision.
    const listed = fixtureReadModel({ nodeExecutions: [done("poll", 1, "changed")], runs: [
        { runId: RUN, mode: "live", status: "running", revision: 1, outcome: null }, { runId: "run-2", mode: "test", status: "running", revision: 2, outcome: null }] });
    const otherRevision = projectWorkflowV2({ ...workflowReadModelView({ ...loading, readModel: listed }), definition,
        events: [...runAEvents, inRun("run-2", completed("poll", 1, "unchanged"))] });
    assert.equal(otherRevision.bound, false);
    assert.ok(otherRevision.banners.some(banner => banner.text.startsWith("This Workflow ran revision 2;")));
    assert.ok(otherRevision.nodes.every(node => node.executions.length === 0));

    // A model that says the workflow has no graph keeps saying so while run B's model loads or fails: the definition from the
    // events is not drawn again, and the reason stays.
    const noGraph = fixtureReadModel({ graph: null, nodeExecutions: [done("poll", 1, "changed")] });
    const own = renderPane({ definition, readModel: noGraph, readModelRunId: null }, runAEvents);
    assert.ok(own.includes("No graph to show") && own.includes("is valid, but its graph is not available") && !own.includes("Wait · 30 s"));
    for (const [label, view] of [["loading", { ...loading, readModel: noGraph }], ["failed", { ...failed, readModel: noGraph }]]) {
        const html = renderPane(view, runAEvents);
        assert.ok(html.includes("No graph to show"), `${label}: still no graph`);
        assert.ok(html.includes("is valid, but its graph is not available"), `${label}: and why`);
        assert.ok(!html.includes("Wait · 30 s"), `${label}: the events' definition is not drawn again`);
        assert.ok(html.includes(">Not loaded<"), label);
        assertNoRunA(html, label);
    }
    // An invalid revision keeps its diagnostics; the other selection's run banner is not carried over.
    const invalid = fixtureReadModel({ graph: null, noRun: true,
        revision: { valid: false, diagnostics: [{ severity: "error", code: "E1", path: "$.states", message: "broken state" }] } });
    const invalidOther = renderPane({ ...loading, readModel: invalid }, runAEvents);
    assert.ok(invalidOther.includes("This definition is not valid") && invalidOther.includes("broken state"));
    assert.ok(!invalidOther.includes("Wait · 30 s"));
    const projected = projectWorkflowV2({ ...workflowReadModelView({ ...loading, readModel: invalid }), definition, events: runAEvents });
    assert.equal(projected.definition, null);
    assert.equal(projected.modelStatus, "invalid");
    assert.ok(!projected.banners.some(banner => banner.text === "Not started yet."));
    assert.ok(projectWorkflowV2({ readModel: invalid }).banners.some(banner => banner.text === "Not started yet."), "it is the run's banner");
});

test("READ-WIRE-01: the controller's run selection, with run A's history loaded, shows nothing of run A while run B loads, fails and is retried", async () => {
    const h = seeded({ lastSeq: 4 });
    h.store.dispatch({ type: "history/set", sessionId: SID, history: { chat: [], activity: [], events: runAEvents, lastSeq: 4 } });
    const modelA = fixtureReadModel({ nodeExecutions: [done("poll", 1, "changed"), row("pause", 2, "pending")] });
    const runs = [{ runId: RUN, mode: "live", status: "running", revision: 1, outcome: null }, { runId: "run-2", mode: "test", status: "running", revision: 1, outcome: null }];
    const modelB = fixtureReadModel({ run: { runId: "run-2", mode: "test" }, runs, nodeExecutions: [done("poll", 1, "unchanged")] });
    const runB = deferred();
    h.transport.respond = (_id, options) => (options.runId === "run-2" ? runB.promise : Promise.resolve(modelA));
    await h.controller.ensureWorkflowDefinition(SID);
    await until(() => h.view().readModel === modelA && h.view().definition, "run A's model and the definition");
    const pane = () => renderToStaticMarkup(React.createElement(React.Fragment, null, React.createElement(WorkflowMainPane, { controller: h.controller, icon: null }),
        h.view().sidePanel ? React.createElement(WorkflowNodePane, { controller: h.controller }) : null));
    assert.ok(pane().includes("Done · changed"), "run A while it is selected");

    h.select("run-2");
    const loading = h.controller.ensureWorkflowReadModel(SID);
    await until(() => h.calls.at(-1)?.[1]?.runId === "run-2", "run B's request");
    const whileLoading = pane();
    assertNoRunA(whileLoading, "loading");
    assert.ok(whileLoading.includes("Wait · 30 s") && whileLoading.includes(">Not loaded<"));

    runB.reject(Object.assign(new Error("Service unavailable."), { code: "INTERNAL_ERROR", status: 503 }));
    await loading;
    // Batch 6 (r-3): the failure and its Retry show in the side pane's Notices.
    h.store.dispatch({ type: "ui/workflowView", sessionId: SID, view: { sidePanel: "notices" } });
    const failed = pane();
    assertNoRunA(failed, "failed");
    assert.ok(failed.includes("could not be read: Service unavailable.") && failed.includes(">Retry<") && failed.includes("Wait · 30 s"));

    h.transport.respond = async () => modelB;
    await h.controller.ensureWorkflowReadModel(SID, { force: true });
    const shown = pane();
    assert.ok(shown.includes("Done · unchanged") && shown.includes("Test · Running"), "run B's own model");
    assert.ok(!shown.includes("Done · changed") && !shown.includes("could not be read"));
});

test("READ-WIRE-01: without its own model, the live selection never stands for a run known not to be live, even when its events are the latest", () => {
    const definition = workflowDefinition(startedData);
    const testRun = [inRun("run-2", ev("workflow.started", { ...startedData, mode: "test" })), inRun("run-2", started("poll", 1)),
        inRun("run-2", completed("poll", 1, "unchanged"))];
    // Its start event says it is a test run.
    const byEvent = projectWorkflowV2({ definition, events: [...runAEvents, ...testRun] });
    assert.equal(byEvent.runId, RUN);
    assert.ok(byEvent.nodes.some(node => node.stateLabel === "Done · changed") && !byEvent.nodes.some(node => node.stateLabel === "Done · unchanged"));
    // Its start is not loaded, but the last model, read for it, lists it as a test run: run A, the live run, is drawn while the
    // live selection's own model loads.
    const runs = [{ runId: RUN, mode: "live", status: "running", revision: 1, outcome: null }, { runId: "run-2", mode: "test", status: "running", revision: 1, outcome: null }];
    const modelB = fixtureReadModel({ run: { runId: "run-2", mode: "test" }, runs, nodeExecutions: [done("poll", 1, "unchanged")] });
    const view = { definition, readModel: modelB, readModelRunId: "run-2", selectedRunId: null };
    const html = renderPane(view, [...runAEvents, ...testRun.slice(1)]);
    assert.ok(html.includes("Done · changed") && html.includes("· Waiting"), "the live run's events");
    assert.ok(!html.includes("Done · unchanged"), "not the test run's events or model");
    assert.equal(projectWorkflowV2({ ...workflowReadModelView(view), events: [...runAEvents, ...testRun.slice(1)] }).runId, RUN);
});

test("the execution log names v2 wait and messaging states by their kind", () => {
    const started = formatWorkflowEventText({ eventType: "workflow.started", seq: 1, data: {
        name: "v2", version: "1.0.0", initial: "pause",
        states: [
            { id: "pause", type: "wait", seconds: 30, outcomes: ["elapsed"], next: { elapsed: "tell" } },
            { id: "tell", type: "messaging", mode: "send", contract: "Note@1", recipient: "parent", outcomes: ["sent"], next: { sent: "listen" } },
            { id: "listen", type: "messaging", mode: "receive", contract: "Reply@1", from: null, outcomes: ["received"], next: { received: "done" } },
            { id: "done", type: "terminal", outcome: "succeeded" },
        ],
    } });
    assert.match(started, /\| pause \| Wait · 30 s \| elapsed → tell \|/);
    assert.match(started, /\| tell \| Send · Note@1 \| sent → listen \|/);
    assert.match(started, /\| listen \| Receive · Reply@1 \| received → done \|/);
    assert.match(started, /\| done \| End \| End · succeeded \|/);
    assert.equal(formatWorkflowEventText({ eventType: "workflow.state_started", seq: 2, data: { stateId: "pause", type: "wait", step: 1 } }),
        "● `pause` · #1 started.");
    // Review 19:27Z (row 28): the node and its visit; the kind is in the definition table, not each line.
    assert.equal(formatWorkflowEventText({ eventType: "workflow.state_started", seq: 3, data: { stateId: "collect", runtime: "python", step: 1 } }),
        "● `collect` · #1 started.");
});
