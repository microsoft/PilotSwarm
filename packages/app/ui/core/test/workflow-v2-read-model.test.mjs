/**
 * Workflow v2 read model wiring in the shared UI controller (readWorkflow,
 * GET /api/v1/sessions/:sessionId/workflow, access session:read; decision
 * read-workflow-transport, option A):
 *   - opening a workflow session's definition also loads its read model
 *     through the transport, and the view gets it with readModelAfterSeq,
 *     the highest event sequence loaded BEFORE the request
 *   - one request runs per session; events that arrive meanwhile fetch once
 *     more after it, with their newer watermark; a read model as new as the
 *     loaded events is not fetched again
 *   - a response that is no longer the newest request, for another run
 *     selection, older than the read model shown (by watermark or definition
 *     revision), or for a session that is no longer a workflow is discarded
 *   - a transport without the operation keeps the event-only view; a session
 *     that is not a version 2 workflow is marked and not asked again unless
 *     forced; any other failure keeps the read model shown
 *   - the execution log names v2 wait and messaging states by their kind
 *
 * Run: node --test test/workflow-v2-read-model.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController, appReducer, createInitialState, createStore, formatWorkflowEventText } from "../src/index.js";

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

function seeded({ lastSeq = 7, sessionKind = "workflow" } = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getSessionEventsBefore: async () => [],
        readWorkflow: async () => readModel(1, "default"),
    };
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "Workflow: w", status: "running", sessionKind }] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    const setLastSeq = seq => store.dispatch({ type: "history/set", sessionId: SID, history: { chat: [], activity: [], events: [], lastSeq: seq } });
    if (lastSeq !== null) setLastSeq(lastSeq);
    const view = () => store.getState().ui.workflowViews?.[SID] || {};
    return { controller, store, transport, view, setLastSeq };
}

test("opening a workflow's definition also loads its read model, with the watermark of the events loaded before the request", async () => {
    const h = seeded({ lastSeq: 4 });
    const calls = [];
    h.transport.readWorkflow = async (sessionId, options) => { calls.push([sessionId, options]); return readModel(1, "loaded"); };
    await h.controller.ensureWorkflowDefinition(SID);
    await until(() => h.view().readModel?.marker === "loaded", "the read model in the view");
    assert.deepEqual(calls, [[SID, {}]]);
    assert.equal(h.view().readModelAfterSeq, 4);
    assert.equal(h.view().readModelError, null);
    assert.equal(h.view().readModelUnavailable, false);
    // As new as the loaded events: not fetched again.
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(calls.length, 1);
    // A session whose history was never loaded gets no watermark (it is not proven).
    const unloaded = seeded({ lastSeq: null });
    await unloaded.controller.ensureWorkflowReadModel(SID);
    assert.equal(unloaded.view().readModel?.marker, "default");
    assert.equal(unloaded.view().readModelAfterSeq, null);
});

test("runs one request per session and fetches once more for events that arrived meanwhile", async () => {
    const h = seeded({ lastSeq: 7 });
    const calls = [];
    const responses = [deferred(), deferred()];
    h.transport.readWorkflow = (sessionId, options) => { calls.push([sessionId, options]); return responses[calls.length - 1].promise; };
    const first = h.controller.ensureWorkflowReadModel(SID);
    // Events arrive while it is in flight: the second call joins it (no second request now), and the first keeps watermark 7.
    h.setLastSeq(9);
    const joined = h.controller.ensureWorkflowReadModel(SID);
    await until(() => calls.length === 1, "the first request");
    responses[0].resolve(readModel(1, "first"));
    await until(() => calls.length === 2, "the second request");
    assert.equal(h.view().readModel.marker, "first");
    assert.equal(h.view().readModelAfterSeq, 7);
    responses[1].resolve(readModel(1, "second"));
    await Promise.all([first, joined]);
    assert.equal(h.view().readModel.marker, "second");
    assert.equal(h.view().readModelAfterSeq, 9);
    assert.equal(calls.length, 2);
});

test("discards a response that is not the newest request, for another run, older than the one shown, or for a non-workflow", async () => {
    const h = seeded({ lastSeq: 6 });
    h.store.dispatch({ type: "ui/workflowView", sessionId: SID, view: { readModel: readModel(3, "shown"), readModelAfterSeq: 5 } });

    // An older definition revision than the one shown.
    h.transport.readWorkflow = async () => readModel(2, "older-revision");
    await h.controller.ensureWorkflowReadModel(SID);
    assert.equal(h.view().readModel.marker, "shown");

    // Superseded: a newer request generation began after it was sent.
    const superseded = deferred();
    h.transport.readWorkflow = () => superseded.promise;
    const loading = h.controller.ensureWorkflowReadModel(SID);
    h.controller.invalidateWorkflowReadModel(SID);
    superseded.resolve(readModel(4, "superseded"));
    await loading;
    assert.equal(h.view().readModel.marker, "shown");

    // The run selection changed while it was in flight.
    const otherRun = deferred();
    h.transport.readWorkflow = () => otherRun.promise;
    const loadingRun = h.controller.ensureWorkflowReadModel(SID);
    h.store.dispatch({ type: "ui/workflowView", sessionId: SID, view: { selectedRunId: "run-2" } });
    otherRun.resolve(readModel(4, "other-run"));
    await loadingRun;
    assert.equal(h.view().readModel.marker, "shown");
    h.store.dispatch({ type: "ui/workflowView", sessionId: SID, view: { selectedRunId: null } });

    // A read model with a newer watermark was shown meanwhile.
    const olderWatermark = deferred();
    h.transport.readWorkflow = () => olderWatermark.promise;
    const loadingOld = h.controller.ensureWorkflowReadModel(SID);
    h.store.dispatch({ type: "ui/workflowView", sessionId: SID, view: { readModel: readModel(3, "newer"), readModelAfterSeq: 8 } });
    olderWatermark.resolve(readModel(3, "older-watermark"));
    await loadingOld;
    assert.equal(h.view().readModel.marker, "newer");

    // Control: a current response applies, asked for the selected run.
    h.setLastSeq(9);
    h.store.dispatch({ type: "ui/workflowView", sessionId: SID, view: { selectedRunId: "run-2" } });
    const runCalls = [];
    h.transport.readWorkflow = async (sessionId, options) => { runCalls.push([sessionId, options]); return readModel(3, "current"); };
    await h.controller.ensureWorkflowReadModel(SID);
    assert.deepEqual(runCalls, [[SID, { runId: "run-2" }]]);
    assert.equal(h.view().readModel.marker, "current");
    assert.equal(h.view().readModelAfterSeq, 9);

    // A session that stopped being a workflow while the request was in flight takes nothing.
    const gone = deferred();
    h.setLastSeq(10);
    h.transport.readWorkflow = () => gone.promise;
    const loadingGone = h.controller.ensureWorkflowReadModel(SID);
    h.store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "Agent", status: "idle", sessionKind: "agent" }] });
    gone.resolve(readModel(5, "after-kind-change"));
    await loadingGone;
    assert.notEqual(h.store.getState().ui.workflowViews?.[SID]?.readModel?.marker, "after-kind-change");
});

test("keeps the event-only view without the operation, marks a non-v2 workflow once, and keeps the read model shown on other failures", async () => {
    const unsupported = seeded();
    unsupported.transport.readWorkflow = undefined;
    await unsupported.controller.ensureWorkflowReadModel(SID);
    assert.equal(unsupported.view().readModel, undefined);

    const legacy = seeded();
    let asked = 0;
    legacy.transport.readWorkflow = async () => {
        asked += 1;
        throw Object.assign(new Error("This session is not a version 2 workflow."), { code: "WORKFLOW_NOT_FOUND", status: 404 });
    };
    await legacy.controller.ensureWorkflowReadModel(SID);
    assert.equal(legacy.view().readModelUnavailable, true);
    assert.equal(legacy.view().readModelError, null);
    legacy.setLastSeq(20);
    await legacy.controller.ensureWorkflowReadModel(SID);
    assert.equal(asked, 1, "a session marked unavailable is not asked again");
    await legacy.controller.ensureWorkflowReadModel(SID, { force: true });
    assert.equal(asked, 2, "a retry asks again");

    const failing = seeded({ lastSeq: 3 });
    failing.store.dispatch({ type: "ui/workflowView", sessionId: SID, view: { readModel: readModel(1, "kept"), readModelAfterSeq: 1 } });
    failing.transport.readWorkflow = async () => { throw Object.assign(new Error("Session not found."), { code: "NOT_FOUND", status: 404 }); };
    await failing.controller.ensureWorkflowReadModel(SID);
    assert.equal(failing.view().readModel.marker, "kept");
    assert.equal(failing.view().readModelError, "Session not found.");

    const agent = seeded({ sessionKind: "agent" });
    agent.transport.readWorkflow = async () => { throw new Error("an agent session is never asked"); };
    await agent.controller.ensureWorkflowReadModel(SID);
    assert.equal(agent.store.getState().ui.workflowViews?.[SID], undefined);
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
    assert.match(started, /\| pause \| wait \(30 s\) \| elapsed → tell \|/);
    assert.match(started, /\| tell \| send \(Note@1\) \| sent → listen \|/);
    assert.match(started, /\| listen \| receive \(Reply@1\) \| received → done \|/);
    assert.match(started, /\| done \| terminal \| ends: succeeded \|/);
    assert.equal(formatWorkflowEventText({ eventType: "workflow.state_started", seq: 2, data: { stateId: "pause", type: "wait", step: 1 } }),
        "▶ Step 1: `pause` started (wait).");
    // A legacy script state keeps its runtime label.
    assert.equal(formatWorkflowEventText({ eventType: "workflow.state_started", seq: 3, data: { stateId: "collect", runtime: "python", step: 1 } }),
        "▶ Step 1: `collect` started (python).");
});
