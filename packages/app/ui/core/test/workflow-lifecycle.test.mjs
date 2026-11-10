/**
 * OF-S2-4 (owner, 2026-11-07T19:14Z): the first Workflow definition of a chat opens the Workflow panel (B), and every
 * lifecycle change lights the Workflow button's dot while the panel is closed (C). Node visits, variable changes and
 * ordinary row updates do not.
 *
 * Run: node --test ui/core/test/workflow-lifecycle.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    appReducer, chatLifecycleStamp, createInitialState, createStore, workflowLifecycleAt, workflowLifecycleAtOf,
    workflowLifecycleChangedAt, workflowLifecycleKeys, workflowLifecycleNeedsAttention,
} from "../src/index.js";

const NOW = Date.parse("2026-11-07T20:00:00.000Z");
const iso = ms => new Date(ms).toISOString();
const definition = (name, revisions, extra = {}) => ({ definitionId: `def-${name}`, name, currentRevision: revisions.length,
    newestValidRevision: revisions.length, updatedAt: revisions.at(-1)?.createdAt ?? null,
    revisions: revisions.map((entry, index) => ({ revision: index + 1, valid: true, ...entry })), workflows: [], ...extra });
const loaded = items => ({ items, at: NOW, error: null, unsupported: false });

const OWNER = "owner";
function storeWith(rows = []) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "ui/sessionViewDevice", device: "desktop" });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: OWNER, title: "Release triage", updatedAt: iso(NOW - 3_600_000) }, ...rows] });
    store.dispatch({ type: "sessions/selected", sessionId: OWNER });
    return store;
}
const ui = store => store.getState().ui;

test("B (one rule with d, review F1): in the chat, its first definition opens the panel, whatever its time; a page load onto it does too", () => {
    const store = storeWith();
    store.dispatch({ type: "profileSettings/apply", settings: {} });
    assert.equal(ui(store).canvasOpen, false);
    store.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch: loaded([]) });
    assert.equal(ui(store).canvasOpen, false, "an empty list opens nothing");
    const seq = Number(ui(store).workflowAutoOpenSeq) || 0;
    const handSeq = Number(ui(store).workflowOpenSeq) || 0;
    // Its time is the server's and is never compared with this browser's clock (a skewed clock changes nothing).
    store.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch: loaded([definition("watch", [{ createdAt: iso(NOW + 900_000) }])]) });
    assert.deepEqual([ui(store).canvasOpen, ui(store).rightPaneMode, ui(store).sidePaneTab], [true, "canvas", "workflow"]);
    // Review F7: the phone shows it by its own path (no canvas opt-out withdrawn, Budget left open), not a hand-opening's.
    assert.deepEqual([ui(store).workflowAutoOpenSeq, ui(store).workflowOpenSeq], [seq + 1, handSeq], "the phone brings its Workflow pane up");
    // Closed by the person, a second definition does not open it again.
    store.dispatch({ type: "ui/canvasOpen", open: false });
    store.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch: loaded([definition("watch", [{ createdAt: iso(NOW) }]),
        definition("digest", [{ createdAt: iso(NOW) }])]) });
    assert.equal(ui(store).canvasOpen, false);
    // A page load onto it: the first read lists the definition, its panel was never on screen: it opens.
    const reload = storeWith();
    reload.dispatch({ type: "profileSettings/apply", settings: {} });
    reload.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch: loaded([definition("watch", [{ createdAt: iso(NOW - 900_000) }])]) });
    assert.equal(ui(reload).canvasOpen, true);
});

test("the first Workflow auto-open replaces Canvas; progress, attention and profile reads do not pop it back", () => {
    const store = storeWith();
    store.dispatch({ type: "profileSettings/apply", settings: {} });
    store.dispatch({ type: "canvas/flip", sessionId: OWNER, slot: 1 });
    assert.equal(ui(store).sidePaneTab, "canvas");
    store.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER,
        patch: loaded([definition("watch", [{ createdAt: iso(NOW) }])]) });
    assert.equal(ui(store).sidePaneTab, "workflow");

    store.dispatch({ type: "canvas/flip", sessionId: OWNER, slot: 1 });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf-1", view: {
        readModel: { workflowId: "wf-1", run: { runId: "r1", status: "running" }, executions: [] },
    } });
    store.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER,
        patch: loaded([definition("watch", [{ createdAt: iso(NOW + 1_000) }])]) });
    assert.equal(ui(store).sidePaneTab, "canvas", "later Workflow updates do not replace Canvas");
    store.dispatch({ type: "ui/sidePaneTab", tab: "workflow" });
    store.dispatch({ type: "profileSettings/apply", settings: {
        themeId: "terminal-green", desktopPanes: { canvasOpen: true, sideTab: "canvas" },
    } });
    assert.equal(ui(store).sidePaneTab, "workflow", "UI-7: a profile read never brings Canvas back");
});

const VIEWED = NOW - 60_000;
const row = (id, status, { createdAt = NOW - 3_600_000, updatedAt = NOW - 3_000_000 } = {}) => ({ sessionId: id, sessionKind: "workflow",
    title: "Workflow: watch", status, parentSessionId: OWNER, createdAt: iso(createdAt), updatedAt: iso(updatedAt) });

/** A chat whose panel last showed at VIEWED, with one Workflow running since before it and one definition saved before it. */
function viewedStore(rows = [row("wf-1", "running")]) {
    const store = storeWith(rows);
    store.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch: loaded([definition("watch", [{ createdAt: iso(NOW - 3_700_000) }],
        { workflows: [{ workflowSessionId: "wf-1", revision: 1, runStatus: "running", createdAt: iso(NOW - 3_600_000) }] })]) });
    store.dispatch({ type: "canvas/viewed", sessionId: OWNER, workflowAt: VIEWED });
    return store;
}
const dot = store => workflowLifecycleNeedsAttention(store.getState(), OWNER);

test("C: each lifecycle event lights the dot; opening the panel (its receipt) clears it", () => {
    const real = Date.now;
    Date.now = () => NOW;
    try {
        const baseline = viewedStore();
        assert.equal(dot(baseline), false, "nothing new since the panel showed");
        const defs = store => store.getState().ui.chatDefinitions[OWNER].items;
        const relist = (store, items) => store.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch: loaded(items) });
        const cases = {
            "definition created": store => relist(store, [...defs(store), definition("digest", [{ createdAt: iso(NOW) }])]),
            "revision saved": store => relist(store, [{ ...defs(store)[0], currentRevision: 2,
                revisions: [...defs(store)[0].revisions, { revision: 2, valid: true, createdAt: iso(NOW) }] }]),
            "definition deleted": store => relist(store, [{ ...defs(store)[0], deletedAt: iso(NOW) }]),
            "test started": store => relist(store, [{ ...defs(store)[0], revisions: [{ ...defs(store)[0].revisions[0],
                lastTest: { testId: "t1", verdict: "running", at: iso(NOW) } }] }]),
            "test finished": store => relist(store, [{ ...defs(store)[0], revisions: [{ ...defs(store)[0].revisions[0],
                lastTest: { testId: "t1", verdict: "passed", at: iso(NOW) } }] }]),
            "Workflow started": store => store.dispatch({ type: "sessions/merged", session: row("wf-2", "running", { createdAt: NOW, updatedAt: NOW }) }),
            "Workflow paused": store => store.dispatch({ type: "sessions/merged", session: row("wf-1", "waiting", { updatedAt: NOW }) }),
            "Workflow completed": store => store.dispatch({ type: "sessions/merged", session: row("wf-1", "completed", { updatedAt: NOW }) }),
            "Workflow failed": store => store.dispatch({ type: "sessions/merged", session: row("wf-1", "failed", { updatedAt: NOW }) }),
            "Workflow canceled": store => store.dispatch({ type: "sessions/merged", session: row("wf-1", "cancelled", { updatedAt: NOW }) }),
        };
        for (const [name, act] of Object.entries(cases)) {
            const store = viewedStore();
            act(store);
            assert.equal(dot(store), true, name);
            // The panel shown records what it showed: the dot clears.
            store.dispatch({ type: "canvas/viewed", sessionId: OWNER, workflowAt: workflowLifecycleAtOf(store.getState(), OWNER) });
            assert.equal(dot(store), false, `${name}: cleared once shown`);
        }
        // Resumed: paused before the panel showed, running again now.
        const resumed = viewedStore([row("wf-1", "waiting", { updatedAt: VIEWED - 1_000 })]);
        assert.equal(dot(resumed), false);
        resumed.dispatch({ type: "sessions/merged", session: row("wf-1", "running", { updatedAt: NOW }) });
        assert.equal(dot(resumed), true, "Workflow resumed");
    } finally {
        Date.now = real;
    }
});

test("C: node visits, variable changes and ordinary row updates do not light the dot", () => {
    const real = Date.now;
    Date.now = () => NOW;
    try {
        const store = viewedStore();
        // The row changes (a node's visit, a variable) with the same status: no lifecycle change.
        for (let i = 1; i <= 5; i += 1) store.dispatch({ type: "sessions/merged", session: row("wf-1", "running", { updatedAt: NOW + i * 1_000 }) });
        // Its read model changes: another visit of a node, a variables revision; the Workflow still runs.
        const model = visits => ({ workflowId: "wf-1", definition: { state: "published", currentRevision: 1 }, revision: { revision: 1, valid: true },
            runs: [{ runId: "r1", mode: "live", status: "running", revision: 1 }],
            run: { runId: "r1", mode: "live", status: "running", kvRevision: visits, nodeExecutions: Array.from({ length: visits }, (_, n) => ({
                nodeExecutionId: `nx-${n}`, stateId: "poll", ordinal: n + 1, state: "completed", outcome: "unchanged", resultKind: "business" })) } });
        for (const visits of [1, 2, 3]) store.dispatch({ type: "ui/workflowView", sessionId: "wf-1", view: { readModel: model(visits) } });
        assert.equal(dot(store), false);
        // The keys and their change times, directly: a status that stays is no change; a new key is.
        const keys = workflowLifecycleKeys(store.getState().sessions.byId, OWNER, store.getState().ui.workflowViews, null);
        assert.deepEqual(keys, { "wf-1": "running" });
        assert.equal(workflowLifecycleChangedAt(keys, { "wf-1": "running" }, {}), 0);
        assert.equal(workflowLifecycleChangedAt(keys, { "wf-1": "paused" }, { "wf-1": { updatedAt: iso(NOW) } }), NOW);
        assert.equal(workflowLifecycleChangedAt(null, keys, {}), 0, "a first observation is no change");
        // A Workflow listed but whose row is not loaded is keyed from the list.
        const listed = workflowLifecycleKeys({}, OWNER, {}, loaded([definition("watch", [{ createdAt: iso(NOW) }],
            { workflows: [{ workflowSessionId: "wf-9", revision: 1, runStatus: "stopped" }] })]));
        assert.deepEqual(listed, { "wf-9": "canceled" });
        assert.equal(workflowLifecycleAt({}, OWNER, {}, null, 0), 0);
    } finally {
        Date.now = real;
    }
});

test("C: a Workflow read before keeps its model while the panel is closed; its row's pause and resume still change its key", () => {
    const model = status => ({ readModel: { workflowId: "wf-1", definition: { state: "published", currentRevision: 1 }, revision: { revision: 1, valid: true },
        runs: [{ runId: "r1", mode: "live", status, revision: 1 }], run: { runId: "r1", mode: "live", status, nodeExecutions: [] } } });
    const byId = status => ({ [OWNER]: { sessionId: OWNER }, "wf-1": row("wf-1", status) });
    assert.deepEqual(workflowLifecycleKeys(byId("waiting"), OWNER, { "wf-1": model("running") }), { "wf-1": "paused" });
    assert.deepEqual(workflowLifecycleKeys(byId("running"), OWNER, { "wf-1": model("paused") }), { "wf-1": "running" });
    assert.deepEqual(workflowLifecycleKeys(byId("running"), OWNER, { "wf-1": model("running") }), { "wf-1": "running" });
});

// OF-S2-4d (owner, 19:45Z): the panel opens once per chat, the first time it has a lifecycle change the person has not
// seen: at once in the chat, else on arrival (a switch or a page load); never on unknown state.
function arrivalStore({ profile = true, lastViewed = 0 } = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "ui/sessionViewDevice", device: "desktop" });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: OWNER, title: "Release triage", updatedAt: iso(NOW - 3_600_000) },
        { sessionId: "other", title: "Another chat", updatedAt: iso(NOW - 3_600_000) }] });
    if (profile) {
        store.dispatch({ type: "profileSettings/apply", settings: lastViewed ? { canvasPrefs: { [OWNER]: { lastViewedWorkflowAt: lastViewed } } } : {} });
    }
    store.dispatch({ type: "sessions/selected", sessionId: "other" });
    return store;
}
const OLD_DEF = () => loaded([definition("watch", [{ createdAt: iso(NOW - 86_400_000) }])]);
const isOpen = store => ui(store).canvasOpen === true && ui(store).sidePaneTab === "workflow";

test("OF-S2-4d: arriving at a never-seen chat with a definition opens the panel once; switching back later does not", () => {
    const store = arrivalStore();
    // The chat's definition was saved while the person was elsewhere (a day ago: no freshness limit on arrival).
    store.dispatch({ type: "sessions/selected", sessionId: OWNER });
    assert.equal(isOpen(store), false, "not before its definitions are read");
    const seq = Number(ui(store).workflowAutoOpenSeq) || 0;
    store.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch: OLD_DEF() });
    assert.equal(isOpen(store), true, "opens on arrival");
    assert.equal(ui(store).workflowAutoOpenSeq, seq + 1, "the phone brings its Workflow pane up");
    // The panel shown writes its receipt; the person closes it, goes elsewhere and comes back: it stays closed.
    store.dispatch({ type: "canvas/viewed", sessionId: OWNER, workflowAt: Math.max(workflowLifecycleAtOf(store.getState(), OWNER), 1) });
    store.dispatch({ type: "ui/canvasOpen", open: false });
    store.dispatch({ type: "sessions/selected", sessionId: "other" });
    store.dispatch({ type: "sessions/selected", sessionId: OWNER });
    store.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch: { ...OLD_DEF(), at: NOW + 1 } });
    assert.equal(isOpen(store), false, "shown once: never again");
    // Even with no receipt in the store yet (it opened in this page), it does not open again.
    const again = arrivalStore();
    again.dispatch({ type: "sessions/selected", sessionId: OWNER });
    again.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch: OLD_DEF() });
    again.dispatch({ type: "ui/canvasOpen", open: false });
    again.dispatch({ type: "sessions/selected", sessionId: "other" });
    again.dispatch({ type: "sessions/selected", sessionId: OWNER });
    assert.equal(isOpen(again), false, "once per page, whatever the receipt");
});

test("OF-S2-4d: never after a receipt, before the profile read, after a failed read, or for a chat with nothing", () => {
    const arrive = (store, patch = OLD_DEF()) => {
        store.dispatch({ type: "sessions/selected", sessionId: OWNER });
        store.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch });
        return isOpen(store);
    };
    assert.equal(arrive(arrivalStore({ lastViewed: NOW - 86_400_000 })), false, "the panel was on screen once (another device)");
    assert.equal(arrive(arrivalStore({ lastViewed: 1 })), false, "shown once before any change");
    const early = arrivalStore({ profile: false });
    assert.equal(arrive(early), false, "the profile (and its receipt) not read yet");
    early.dispatch({ type: "profileSettings/apply", settings: {} });
    assert.equal(isOpen(early), true, "decided once the profile is read");
    // Review F9: a failed read as the controller makes it, { error, failedAt } merged over the last good read's items.
    const failed = arrivalStore({ profile: false });
    failed.dispatch({ type: "sessions/selected", sessionId: OWNER });
    failed.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch: OLD_DEF() });
    failed.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch: { error: "boom", failedAt: NOW } });
    assert.ok(Array.isArray(ui(failed).chatDefinitions[OWNER].items), "the old items stay");
    failed.dispatch({ type: "profileSettings/apply", settings: {} });
    assert.equal(isOpen(failed), false, "a failed read decides nothing");
    failed.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch: { ...OLD_DEF(), error: null } });
    assert.equal(isOpen(failed), true, "a read that succeeds again decides");
    assert.equal(arrive(arrivalStore(), loaded([])), false, "a chat with no definition and no Workflow");
    // Full screen or zen stay as they are: zen on the canvas, the Workflow panel takes the column and zen stays.
    const zen = arrivalStore();
    zen.dispatch({ type: "sessions/selected", sessionId: OWNER });
    zen.dispatch({ type: "ui/canvasZen", on: true });
    zen.dispatch({ type: "ui/canvasMaximized", on: true });
    assert.notEqual(ui(zen).sidePaneTab, "workflow");
    zen.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch: OLD_DEF() });
    assert.deepEqual([isOpen(zen), ui(zen).canvasZen, ui(zen).canvasMaximized], [true, true, true]);
});

test("review F2: while an agent node's chat is the active session, the owner's Workflow keys are recorded and its panel decides", () => {
    const store = arrivalStore();
    store.dispatch({ type: "sessions/merged", session: row("wf-1", "running") });
    store.dispatch({ type: "sessions/merged", session: { sessionId: "node-chat", title: "Workflow step: review", parentSessionId: "wf-1",
        updatedAt: iso(NOW - 3_000_000) } });
    store.dispatch({ type: "canvas/viewed", sessionId: OWNER, workflowAt: VIEWED });
    store.dispatch({ type: "sessions/selected", sessionId: "node-chat" });
    assert.equal(store.getState().sessions.activeSessionId, "node-chat");
    assert.deepEqual(ui(store).workflowLifecycle?.[OWNER]?.keys, { "wf-1": "running" });
    // The Workflow pauses while its node's chat is shown: recorded for the owner, so the dot it lights is that change.
    store.dispatch({ type: "sessions/merged", session: row("wf-1", "waiting", { updatedAt: NOW }) });
    assert.deepEqual(ui(store).workflowLifecycle[OWNER], { keys: { "wf-1": "paused" }, sources: { "wf-1": "row" }, waiting: {}, at: NOW });
});

test("review F3, F4: a re-read follows statuses, never a row's update; a Workflow known only from the list is never dated by this browser", () => {
    const byId = (updatedAt, status = "running") => ({ [OWNER]: { sessionId: OWNER, status: "idle", updatedAt: iso(updatedAt) },
        "wf-1": row("wf-1", status, { updatedAt }) });
    assert.equal(chatLifecycleStamp(byId(NOW), OWNER), chatLifecycleStamp(byId(NOW + 5_000), OWNER), "a node visit: no re-read");
    assert.notEqual(chatLifecycleStamp(byId(NOW), OWNER), chatLifecycleStamp(byId(NOW, "waiting"), OWNER), "a pause: re-read");
    assert.equal(chatLifecycleStamp({}, null), "");
    // A list-only Workflow whose key changes: no time (0), never Date.now().
    assert.equal(workflowLifecycleChangedAt({ "wf-9": "running" }, { "wf-9": "canceled" }, {}), 0);
});

// Review of 2ada4690, F5-F9 (round head).
const liveModel = (status, { stop = null, asking = false } = {}) => ({ workflowId: "wf-1", definition: { state: "published", currentRevision: 1 },
    revision: { revision: 1, valid: true }, graph: { states: [{ id: "ask", type: "request" }] },
    runs: [{ runId: "r1", mode: "live", status, revision: 1 }],
    run: { runId: "r1", mode: "live", status, ...(stop ? { stop } : {}),
        nodeExecutions: asking ? [{ nodeExecutionId: "nx-ask", stateId: "ask", ordinal: 1, state: "pending" }] : [] } });

test("review F5: a key read from a more exact source is no change (canceling at a page load); leaving waiting is none either", () => {
    const real = Date.now;
    Date.now = () => NOW;
    try {
        // A page load: the row says running (it changed when the stop was asked, after the panel last showed); the model,
        // read next, says canceling. The person saw nothing new happen: no dot.
        const store = viewedStore([row("wf-1", "running", { updatedAt: NOW })]);
        assert.equal(dot(store), false);
        store.dispatch({ type: "ui/workflowView", sessionId: "wf-1", view: { readModel: liveModel("running", { stop: { deadline: iso(NOW + 60_000) } }),
            readModelAt: iso(NOW) } });
        assert.deepEqual(ui(store).workflowLifecycle[OWNER].keys, { "wf-1": "canceling" });
        assert.equal(dot(store), false, "the row's running, then the model's canceling: one state, read twice");
        // A change seen in the model itself still counts.
        const paused = viewedStore([row("wf-1", "running", { updatedAt: VIEWED - 1_000 })]);
        paused.dispatch({ type: "ui/workflowView", sessionId: "wf-1", view: { readModel: liveModel("running"), readModelAt: iso(VIEWED - 1_000) } });
        assert.equal(dot(paused), false);
        paused.dispatch({ type: "sessions/merged", session: row("wf-1", "waiting", { updatedAt: NOW }) });
        assert.equal(dot(paused), true, "a pause the row says after the model was read");
        // The rules directly: a source upgrade is no change; the same source, or a newer row over a model, is.
        const byId = { "wf-1": { updatedAt: iso(NOW) } };
        assert.equal(workflowLifecycleChangedAt({ "wf-1": "running" }, { "wf-1": "canceling" }, byId, { "wf-1": "row" }, { "wf-1": "model" }), 0);
        assert.equal(workflowLifecycleChangedAt({ "wf-1": "running" }, { "wf-1": "paused" }, byId, { "wf-9": "list" }, { "wf-1": "row" }), 0);
        assert.equal(workflowLifecycleChangedAt({ "wf-1": "running" }, { "wf-1": "paused" }, byId, { "wf-1": "model" }, { "wf-1": "model" }), NOW);
        assert.equal(workflowLifecycleChangedAt({ "wf-1": "paused" }, { "wf-1": "running" }, byId, { "wf-1": "model" }, { "wf-1": "row" }), NOW);
        // An answer arrived: the Workflow runs on. That is not a lifecycle event.
        assert.equal(workflowLifecycleChangedAt({ "wf-1": "waiting" }, { "wf-1": "running" }, byId), 0);
    } finally {
        Date.now = real;
    }
});

test("review F6: a model read with the row it has (readModelAt) wins over that row; a row changed after the read wins over it", () => {
    const at = NOW - 3_000_000;
    const byId = updatedAt => ({ [OWNER]: { sessionId: OWNER }, "wf-1": row("wf-1", "running", { updatedAt }) });
    const paused = { readModel: liveModel("paused"), readModelAt: iso(at) };
    // The person's own pause in the panel: the model says paused at once; the row still says running until the next poll.
    assert.deepEqual(workflowLifecycleKeys(byId(at), OWNER, { "wf-1": paused }), { "wf-1": "paused" });
    // The row changed after that read (resumed elsewhere): the row wins.
    assert.deepEqual(workflowLifecycleKeys(byId(at + 1_000), OWNER, { "wf-1": paused }), { "wf-1": "running" });
    // The panel open: its own pause is recorded with the model, so the receipt the panel writes covers it.
    const store = viewedStore([row("wf-1", "running", { updatedAt: NOW })]);
    store.dispatch({ type: "ui/workflowView", sessionId: "wf-1", view: { readModel: liveModel("running"), readModelAt: iso(NOW) } });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf-1", view: { readModel: liveModel("paused"), readModelAt: iso(NOW) } });
    assert.deepEqual(ui(store).workflowLifecycle[OWNER].keys, { "wf-1": "paused" });
    store.dispatch({ type: "canvas/viewed", sessionId: OWNER, workflowAt: workflowLifecycleAtOf(store.getState(), OWNER) });
    store.dispatch({ type: "sessions/merged", session: row("wf-1", "waiting", { updatedAt: NOW }) });
    assert.equal(dot(store), false, "the next poll's row says the same pause: no dot for the person's own action");
});

test("review F8: a Workflow waiting for an answer is dated when it was first seen waiting; node visits do not relight it", () => {
    const real = Date.now;
    Date.now = () => NOW;
    try {
        const store = viewedStore([row("wf-1", "running", { updatedAt: VIEWED - 1_000 })]);
        store.dispatch({ type: "ui/workflowView", sessionId: "wf-1", view: { readModel: liveModel("running"), readModelAt: iso(VIEWED - 1_000) } });
        assert.equal(dot(store), false);
        store.dispatch({ type: "sessions/merged", session: row("wf-1", "running", { updatedAt: NOW }) });
        store.dispatch({ type: "ui/workflowView", sessionId: "wf-1", view: { readModel: liveModel("running", { asking: true }), readModelAt: iso(NOW) } });
        assert.deepEqual(ui(store).workflowLifecycle[OWNER].waiting, { "wf-1": NOW });
        assert.equal(dot(store), true, "waiting for input lights the dot");
        store.dispatch({ type: "canvas/viewed", sessionId: OWNER, workflowAt: workflowLifecycleAtOf(store.getState(), OWNER) });
        assert.equal(dot(store), false);
        // Other branches visit nodes while it waits: its row moves, its key stays waiting.
        for (let i = 1; i <= 3; i += 1) {
            store.dispatch({ type: "sessions/merged", session: row("wf-1", "running", { updatedAt: NOW + i * 5_000 }) });
            store.dispatch({ type: "ui/workflowView", sessionId: "wf-1", view: { readModel: liveModel("running", { asking: true }),
                readModelAt: iso(NOW + i * 5_000) } });
        }
        assert.equal(dot(store), false, "node visits while it waits do not relight the dot");
        assert.deepEqual(ui(store).workflowLifecycle[OWNER].waiting, { "wf-1": NOW });
    } finally {
        Date.now = real;
    }
});

test("review F9: switching chats, an agent node's chat and a reload of a canceling Workflow light and open nothing; a fresh chat opens with no opt-in", () => {
    const real = Date.now;
    Date.now = () => NOW;
    try {
        // Switching to another chat and back is no lifecycle change.
        const store = viewedStore();
        store.dispatch({ type: "sessions/loaded", sessions: [...Object.values(store.getState().sessions.byId),
            { sessionId: "other", title: "Another chat", updatedAt: iso(NOW - 3_600_000) }] });
        store.dispatch({ type: "sessions/selected", sessionId: "other" });
        store.dispatch({ type: "sessions/selected", sessionId: OWNER });
        assert.equal(dot(store), false, "a chat switch");
        assert.equal(ui(store).canvasOpen, false);
        // An agent node's chat shown (the tab's owner is still the chat): no change, no panel.
        store.dispatch({ type: "sessions/merged", session: { sessionId: "node-chat", title: "Workflow step: review", parentSessionId: "wf-1",
            updatedAt: iso(NOW) } });
        const autoSeq = Number(ui(store).workflowAutoOpenSeq) || 0;
        store.dispatch({ type: "sessions/selected", sessionId: "node-chat" });
        assert.equal(dot(store), false, "an agent node's chat");
        assert.equal(Number(ui(store).workflowAutoOpenSeq) || 0, autoSeq, "nothing opens by itself (the chat's panel was on screen)");
        // Workflows are always on: a never-seen chat with a definition opens with no opt-in.
        const fresh = arrivalStore();
        fresh.dispatch({ type: "sessions/selected", sessionId: OWNER });
        fresh.dispatch({ type: "ui/chatDefinitions", ownerId: OWNER, patch: OLD_DEF() });
        assert.equal(isOpen(fresh), true, "always on");
    } finally {
        Date.now = real;
    }
});
