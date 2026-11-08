/**
 * Final UI review of 24948403 (wfs1-adv-ui-final-24948403.md): UI3-F1..F6 and UI3-F9, at the portal model.
 * - UI3-F1 (high): every choice in the definition picker is stored as its entry's key, so the newest option chosen while an
 *   older run is shown shows the newest child, not the run's.
 * - UI3-F2 (high): a failed read of a Workflow's model keeps the ended row authoritative (the dot stays) and is read again
 *   after a pause; the model's freshness is the row it was read with, not the last attempt.
 * - UI3-F3: the reads for version discovery skip children that need none before the bound, so the queue moves on.
 * - UI3-F4: versions order by semantic-version precedence; build metadata ignored; invalid texts after, unread last.
 * - UI3-F5: Compare replaces a side whose entry was deleted.
 * - UI3-F6: a watch that starts again reads more than one page of missed events, then reloads past the bound.
 * - UI3-F9: children of one version with different YAML are separate entries; a run's Definition is its own child.
 *
 * Run: node --test ui/core/test/workflow-simplified-final-review.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, buildHistoryModel, createInitialState, createStore } from "../src/index.js";
import {
    workflowAttentionChildIds, workflowCompareVersions, workflowDefinitionVersions, workflowDefinitionsOf, workflowNeedsAttention, workflowStateOf,
    workflowVersionCompareSides, workflowVersionDiscriminator, workflowVersionReadIds,
} from "../src/workflow-owner.js";
import { WorkflowTab } from "../../react/src/workflow-tab.js";

process.env.TZ = "UTC";
const NAME = "hn-top-watch";
const STATES = [{ id: "poll", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["changed"], next: { changed: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" }];
const modelOf = (workflowId, semver, { hash = `h-${semver}`, status = "completed", draft = false } = {}) => ({
    workflowId, definition: draft ? { state: "draft", semver, currentRevision: 1, publishedRevision: null }
        : { state: "published", semver, currentRevision: 1, publishedRevision: 1 },
    revision: { revision: 1, definitionHash: hash, valid: true, name: NAME, diagnostics: [] },
    graph: { revision: 1, initial: "poll", states: STATES },
    runs: draft ? [] : [{ runId: `run-${workflowId}`, mode: "live", status, revision: 1, outcome: status === "completed" ? "succeeded" : null }],
    run: draft ? null : { runId: `run-${workflowId}`, mode: "live", status, outcome: null, nodeExecutions: [], inbox: [], outbox: [], kv: "{}", kvRevision: 1 },
});
const T0 = Date.parse("2026-11-06T23:30:00.000Z");
/** `children`: [id, status, model or null] in creation order. */
function harness(children, transport = {}) {
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "chat", title: "HN watcher", createdAt: T0, updatedAt: T0 },
        ...children.map(([sessionId, status], index) => ({ sessionId, sessionKind: "workflow", title: `Workflow: ${NAME}`, status, parentSessionId: "chat",
            createdAt: T0 + (index + 1) * 60_000, updatedAt: T0 + (index + 1) * 60_000 + 1_000 })),
    ] });
    for (const [id, , readModel] of children) {
        if (readModel) store.dispatch({ type: "ui/workflowView", sessionId: id, view: { readModel, readModelRunId: null } });
    }
    store.dispatch({ type: "sessions/selected", sessionId: "chat" });
    return { store, controller: new PilotSwarmUiController({ store, transport }) };
}
const render = (h, patch, { row = null } = {}) => {
    if (row) h.store.dispatch({ type: "sessions/selected", sessionId: "chat", workflowRowId: row });
    h.store.dispatch({ type: "ui/workflowTab", ownerId: "chat", patch: { definition: NAME, ...patch } });
    return renderToStaticMarkup(React.createElement(WorkflowTab, { controller: h.controller, mobile: false }));
};
const options = html => [...html.slice(html.indexOf("ps-wf-picker-select")).matchAll(/<option value="([^"]*)"( selected="")?>([^<]*)<\/option>/g)]
    .map(([, value, selected, words]) => ({ value, selected: Boolean(selected), words })).filter(option => option.value !== "__new__");
const versionsOf = h => {
    const state = h.store.getState();
    const [definition] = workflowDefinitionsOf(state.sessions.byId, "chat", state.ui.workflowViews);
    return { definition, versions: workflowDefinitionVersions(state.sessions.byId, definition, state.ui.workflowViews) };
};

test("UI3-F1: with an older run shown, the newest option (its key) shows the newest child, not the run's", () => {
    const h = harness([["wf-1", "cancelled", modelOf("wf-1", "1.0.0", { status: "cancelled" })], ["wf-2", "pending", modelOf("wf-2", "1.1.0", { draft: true })]]);
    // The run shown, no choice: its own definition (1.0.0).
    const own = render(h, { view: "definition", workflowId: "wf-1" }, { row: "wf-1" });
    assert.match(own, /data-definition-child="wf-1"/);
    // The newest option chosen: the handler stores its key (workflowNewestVersionKey); the run shown does not take it back.
    const { versions, definition } = versionsOf(h);
    const newest = versions.find(entry => entry.children.includes(definition.newestId)).key;
    const chosen = render(h, { view: "definition", versionKey: newest });
    assert.match(chosen, /data-definition-child="wf-2"/);
    assert.deepEqual(options(chosen).map(option => [option.words, option.selected]),
        [[`${NAME} · 1.1.0 · draft`, true], [`${NAME} · 1.0.0`, false]]);
});

test("UI3-F9: one version, different YAML: two entries told apart by their Workflows; a run's Definition is its own child", () => {
    const h = harness([
        ["wf-1", "completed", modelOf("wf-1", "1.1.3", { hash: "h-a" })],
        ["wf-2", "completed", modelOf("wf-2", "1.1.3", { hash: "h-b" })],
        ["wf-3", "completed", modelOf("wf-3", "1.1.3", { hash: "h-a" })],
    ]);
    const { versions } = versionsOf(h);
    assert.deepEqual(versions.map(entry => [entry.version, entry.identity, entry.children, entry.newestId, entry.numbers, entry.shared]),
        [["1.1.3", "h-a", ["wf-1", "wf-3"], "wf-3", [1, 3], true], ["1.1.3", "h-b", ["wf-2"], "wf-2", [2], true]]);
    assert.equal(workflowVersionDiscriminator(versions[0]), "#1, #3");
    assert.equal(workflowVersionDiscriminator({ shared: false, numbers: [1] }), null);
    assert.equal(workflowVersionDiscriminator({ shared: true, numbers: [] }, "23:31:00 UTC"), "made 23:31:00 UTC");
    const html = render(h, { view: "definition", workflowId: "wf-1" }, { row: "wf-1" });
    assert.deepEqual(options(html).map(option => [option.words, option.selected]), [[`${NAME} · 1.1.3 · #1, #3`, true], [`${NAME} · 1.1.3 · #2`, false]]);
    // #1's Definition is #1's own child, not its newest sibling #3 (the same definition) or #2 (another one).
    assert.match(html, /data-definition-child="wf-1"/);
    // Compare names both definitions of 1.1.3.
    const compare = render(h, { view: "definition", workflowId: "wf-1", definitionPanel: "revisions" }, { row: "wf-1" });
    assert.match(compare, /aria-label="Compare two versions" data-from="1\.1\.3 · #2" data-to="1\.1\.3 · #1, #3" data-compare="versions"/);
});

test("UI3-F4: semantic-version precedence; build metadata ignored (then by text); invalid texts after; unread last", () => {
    const order = ["1.0.0-rc.2", "1.0.0-rc.10", "1.0.0", "1.0.0+b1", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0oops", null, "01.0.0", "2.0.0",
        "1.0.0-1", "1.0.0-beta", "1.10.0", "1.9.0"].sort(workflowCompareVersions);
    assert.deepEqual(order, ["2.0.0", "1.10.0", "1.9.0", "1.0.0+b1", "1.0.0", "1.0.0-rc.10", "1.0.0-rc.2", "1.0.0-beta", "1.0.0-alpha.1",
        "1.0.0-alpha", "1.0.0-1", "1.0.0oops", "01.0.0", null]);
    assert.equal(workflowCompareVersions("1.0.0", "1.0.0"), 0);
});

test("UI3-F5: Compare replaces a side whose entry is gone, and never compares an entry with itself", () => {
    const keys = ["1.2.0", "1.1.0", "1.0.0"];
    assert.deepEqual(workflowVersionCompareSides(keys, "1.2.0"), { from: "1.1.0", to: "1.2.0" });
    assert.deepEqual(workflowVersionCompareSides(keys, "1.0.0"), { from: "1.1.0", to: "1.0.0" }, "the lowest compares with the one above");
    assert.deepEqual(workflowVersionCompareSides(keys, "1.2.0", { from: "1.0.0" }), { from: "1.0.0", to: "1.2.0" });
    // 1.1.0 was the From side, and its child was deleted: From becomes the default, a listed entry.
    assert.deepEqual(workflowVersionCompareSides(["1.2.0", "1.0.0"], "1.2.0", { from: "1.1.0" }), { from: "1.0.0", to: "1.2.0" });
    // The To side deleted: the shown entry.
    assert.deepEqual(workflowVersionCompareSides(["1.2.0", "1.0.0"], "1.2.0", { from: "1.0.0", to: "1.1.0" }), { from: "1.0.0", to: "1.2.0" });
    assert.deepEqual(workflowVersionCompareSides(["1.2.0", "1.1.0"], "1.2.0", { from: "1.2.0" }), { from: "1.1.0", to: "1.2.0" }, "never itself");
    assert.deepEqual(workflowVersionCompareSides(["1.2.0"], "1.2.0"), { from: null, to: "1.2.0" });
});

test("UI3-F3: the read queue leaves out children that need no read before its bound, so older versions are reached", () => {
    // Twelve drafts of one name, each its own version; the ten newest already read.
    const children = Array.from({ length: 12 }, (_, index) => [`wf-${index + 1}`, "pending", index >= 2 ? modelOf(`wf-${index + 1}`, `1.${index}.0`, { draft: true }) : null]);
    const h = harness(children);
    const state = h.store.getState();
    const definitions = workflowDefinitionsOf(state.sessions.byId, "chat", state.ui.workflowViews);
    const read = new Set(children.filter(([, , model]) => model).map(([id]) => id));
    assert.deepEqual(workflowVersionReadIds(definitions, state.sessions.byId, state.ui.workflowViews, id => !read.has(id), 10), ["wf-2", "wf-1"]);
    // Without the filter first, the ten newest held every slot.
    assert.equal(workflowVersionReadIds(definitions, state.sessions.byId, state.ui.workflowViews, () => true, 10).includes("wf-1"), false);
});

test("UI3-F2: a failed read keeps a Failed row authoritative and the dot on; it is read again after a pause, not before", async () => {
    const T1 = T0 + 60_000, T2 = T1 + 60_000;
    let fail = true;
    const reads = [];
    const running = { ...modelOf("wf-1", "1.0.0", { status: "running" }) };
    const transport = { async readWorkflow(sessionId) { reads.push(sessionId); if (fail) throw new Error("503 Service Unavailable"); return modelOf("wf-1", "1.0.0", { status: "failed" }); } };
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "api" }));
    const controller = new PilotSwarmUiController({ store, transport });
    const row = (status, updatedAt) => ({ sessionId: "wf-1", sessionKind: "workflow", title: `Workflow: ${NAME}`, status, parentSessionId: "chat", createdAt: T0, updatedAt });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "chat", title: "HN watcher", updatedAt: 1 }, row("running", T1)] });
    store.dispatch({ type: "sessions/selected", sessionId: "chat" });
    // A panel once read the model with the row as it was then (Running, T1): through the controller, so its freshness is known.
    fail = false;
    transport.readWorkflow = async (sessionId) => { reads.push(sessionId); if (fail) throw new Error("503 Service Unavailable"); return running; };
    await controller.ensureWorkflowReadModel("wf-1");
    assert.equal(store.getState().ui.workflowViews["wf-1"].readModelAt, T1);
    // In the background it fails: the row says Failed at T2, the cached model Running.
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "chat", title: "HN watcher", updatedAt: 1 }, row("failed", T2)] });
    const state = () => store.getState();
    const shown = () => workflowStateOf(state().sessions.byId["wf-1"], state().ui.workflowViews["wf-1"]).key;
    assert.equal(shown(), "failed");
    assert.equal(workflowNeedsAttention(state(), "chat"), true);
    // The new read fails once.
    fail = true;
    controller.workflowReadRetryMs = 60_000;
    controller.refreshWorkflowAttention();
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.length, 2);
    assert.match(state().ui.workflowViews["wf-1"].readModelError, /503/);
    assert.equal(shown(), "failed", "still Failed after the failed read");
    assert.equal(workflowNeedsAttention(state(), "chat"), true, "and the dot stays");
    // Still wanted by the dot, but not read again before the pause.
    assert.deepEqual(workflowAttentionChildIds(state().sessions.byId, "chat", state().ui.workflowViews), ["wf-1"]);
    controller.refreshWorkflowAttention();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.length, 2, "no read before the pause");
    // After the pause it is read again, and the model now says Failed.
    controller.workflowReadRetryMs = 0;
    fail = false;
    transport.readWorkflow = async (sessionId) => { reads.push(sessionId); return modelOf("wf-1", "1.0.0", { status: "failed" }); };
    controller.refreshWorkflowAttention();
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.length, 3);
    assert.equal(state().ui.workflowViews["wf-1"].readModelError, null);
    assert.equal(state().ui.workflowViews["wf-1"].readModelAt, T2);
    assert.equal(shown(), "failed");
    assert.deepEqual(workflowAttentionChildIds(state().sessions.byId, "chat", state().ui.workflowViews), [], "read for its row: no more reads");
});

test("UI3-F6: a watch that starts again reads every missed page, and past its bound reloads the history", async () => {
    const WF = "wf-watch";
    const events = Array.from({ length: 252 }, (_, index) => ({ sessionId: WF, seq: index + 1, eventType: "workflow.state_started",
        createdAt: new Date(T0 + index * 1000).toISOString(), data: { runId: "run-1", stateId: "poll", nodeExecutionId: `nx-${index + 1}` } }));
    const reads = [];
    let forced = 0;
    const transport = {
        async getSessionEvents(sessionId, afterSeq, limit) {
            reads.push({ afterSeq, limit });
            return events.filter(item => item.seq > Number(afterSeq || 0)).slice(0, limit);
        },
        subscribeSession() { return () => {}; },
    };
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "chat", title: "Chat" },
        { sessionId: WF, title: "Workflow: w", status: "running", sessionKind: "workflow", parentSessionId: "chat" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "chat" });
    store.dispatch({ type: "history/set", sessionId: WF, history: { ...buildHistoryModel(events.slice(0, 2), { requestedLimit: 300 }), lastSeq: 2 } });
    const stop = controller.watchWorkflow(WF);
    for (let index = 0; index < 6; index += 1) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reads.map(read => read.afterSeq), [2, 202]);
    assert.equal(store.getState().history.bySessionId.get(WF).lastSeq, 252);
    stop();
    // Always a full page: after five pages the history is loaded again (its own catch-up or the recent window).
    const always = new PilotSwarmUiController({ store, transport: { ...transport,
        async getSessionEvents(sessionId, afterSeq, limit) { return Array.from({ length: limit }, (_, index) => ({ ...events[0], seq: Number(afterSeq) + index + 1 })); } } });
    always.ensureSessionHistory = async (sessionId, options) => { forced += options?.force === true ? 1 : 0; return null; };
    await always.syncSessionEvents(WF, { maxPages: 5 });
    assert.equal(forced, 1);
    // One page by default, as before.
    forced = 0;
    await always.syncSessionEvents(WF);
    assert.equal(forced, 0);
});
