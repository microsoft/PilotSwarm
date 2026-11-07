/**
 * Owner, 2026-11-06T19:40Z (F9): "I asked the chat for another revision of the workflow, it supposedly built one, but i
 * can't find it anywhere". His chat called spawn_workflow with new YAML (version 1.1.0) as a draft: a third workflow child
 * of hacker-news-top-change-monitor, its own revision 1, never started, beside #1 and #2 (1.0.0, running). The Definition
 * view showed it (it is the newest child) but said only "Revision 1"; the picker said "· revision 1"; the Workflows view
 * listed only started Workflows. Now:
 * - the picker names the newest child's version and says "draft" until it has started;
 * - the Definition view says the version, "draft, not started" and when it was made;
 * - the Workflows view says a draft is not started yet, with Show it and Start…; with more than one, how many, and each
 *   opens with its version and when it was made; a chosen older one says it is not the newest;
 * - the Revision column says the version too when Workflows of one name run different versions (owner, 2026-11-07T00:03Z:
 *   now a Version column for every Workflow, and the picker lists each version; workflow-simplified-versions.test.mjs).
 *
 * Run: node --test ui/core/test/workflow-simplified-f9-drafts.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    workflowChildDefinitionFacts, workflowDefinitionHeaderText, workflowDefinitionOptionLabel, workflowDefinitionsOf, workflowListVersionText,
    workflowUnstartedChildren, workflowUnstartedLine,
} from "../src/workflow-owner.js";
import { WorkflowTab } from "../../react/src/workflow-tab.js";

process.env.TZ = "UTC";
const NAME = "hacker-news-top-change-monitor";
const STATES = [{ id: "fetch_top_stories", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["changed"], next: { changed: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" }];
const started = (workflowId, runId, semver = "1.0.0") => ({
    workflowId, definition: { state: "published", semver, currentRevision: 1, publishedRevision: 1 },
    revision: { revision: 1, definitionHash: "h-6e43", valid: true, name: NAME, diagnostics: [] },
    graph: { revision: 1, initial: "fetch_top_stories", states: STATES },
    runs: [{ runId, mode: "live", status: "running", revision: 1, outcome: null }],
    run: { runId, mode: "live", status: "running", outcome: null, nodeExecutions: [], inbox: [], outbox: [], kv: "{}", kvRevision: 1 },
});
const draft = (workflowId, semver) => ({
    workflowId, definition: { state: "draft", semver, currentRevision: 1, publishedRevision: null },
    revision: { revision: 1, definitionHash: "h-5e54", valid: true, name: NAME, diagnostics: [] },
    graph: { revision: 1, initial: "fetch_top_stories", states: STATES }, runs: [], run: null,
});
const T0 = Date.parse("2026-11-06T19:20:05.000Z");
// His shape (the executor's read-only dump): #1 1dca4137 and #2 1b81f092 (1.0.0, running), the draft 3d25e4fe (1.1.0).
function harness({ more = [], second = "1.0.0" } = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    const row = (sessionId, status, createdAt) => ({ sessionId, sessionKind: "workflow", title: `Workflow: ${NAME}`, status, parentSessionId: "chat",
        createdAt, updatedAt: createdAt + 1_000 });
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "chat", title: "Hacker News Ranking Updates", createdAt: T0, updatedAt: T0 },
        row("wf-1", "running", Date.parse("2026-11-06T19:21:54.000Z")),
        row("wf-2", "running", Date.parse("2026-11-06T19:24:21.000Z")),
        row("wf-3", "pending", Date.parse("2026-11-06T19:35:04.000Z")),
        ...more.map(([id, , at]) => row(id, "pending", at)),
    ] });
    const model = (id, readModel) => store.dispatch({ type: "ui/workflowView", sessionId: id, view: { readModel, readModelRunId: null } });
    model("wf-1", started("wf-1", "run-1"));
    model("wf-2", started("wf-2", "run-2", second));
    model("wf-3", draft("wf-3", "1.1.0"));
    for (const [id, semver] of more) model(id, draft(id, semver));
    store.dispatch({ type: "sessions/selected", sessionId: "chat" });
    return { store, controller: new PilotSwarmUiController({ store, transport: {} }) };
}
const render = (h, patch) => {
    h.store.dispatch({ type: "ui/workflowTab", ownerId: "chat", patch: { definition: NAME, workflowId: null, ...patch } });
    return renderToStaticMarkup(React.createElement(WorkflowTab, { controller: h.controller, mobile: false }));
};
const text = html => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

test("the words: the picker's option, the Definition view's line, the Workflows view's line and the Version cell", () => {
    assert.equal(workflowDefinitionOptionLabel({ name: NAME, version: "1.1.0", revision: 1, state: "draft", started: false }), `${NAME} · 1.1.0 · draft`);
    // Owner, 2026-11-07T00:03Z: a started version reads by its version alone; the Definition view's line says its revision.
    assert.equal(workflowDefinitionOptionLabel({ name: NAME, version: "1.0.0", revision: 1, state: "published", started: true }), `${NAME} · 1.0.0`);
    assert.equal(workflowDefinitionOptionLabel({ name: "report-v2", version: "1.0.0", revision: 1, state: "published", started: false }), "report-v2 · 1.0.0 · not started");
    assert.equal(workflowDefinitionOptionLabel({ name: NAME, started: false }), NAME, "not read yet: the name");
    assert.equal(workflowDefinitionHeaderText({ revision: 1, version: "1.1.0", state: "draft", started: false, made: "19:35:04 UTC" }),
        "Revision 1 · 1.1.0 · draft, not started · made 19:35:04 UTC");
    assert.equal(workflowDefinitionHeaderText({ revision: 1, version: "1.0.0", state: "published", started: true, made: "19:21:54 UTC" }), "Revision 1 · 1.0.0");
    assert.equal(workflowDefinitionHeaderText({ revision: 2, version: "1.0.0", state: "published", started: false }), "Revision 2 · 1.0.0 · published, not started");
    assert.equal(workflowDefinitionHeaderText({}), null);
    assert.equal(workflowUnstartedLine([{ state: "draft", version: "1.1.0", newest: true }]), "A newer draft, 1.1.0, is not started yet.");
    assert.equal(workflowUnstartedLine([{ state: "published", version: "1.0.0", newest: false }]), "A published definition, 1.0.0, is not started yet.");
    assert.equal(workflowUnstartedLine([{ state: "draft" }, { state: "draft" }]), "2 drafts are not started yet.");
    assert.equal(workflowUnstartedLine([{ state: "draft" }, { state: "published" }, { state: null }]), "3 definitions are not started yet.");
    assert.equal(workflowUnstartedLine([]), null);
    assert.equal(workflowListVersionText({ revision: 1, version: "1.0.0" }), "1.0.0");
    assert.equal(workflowListVersionText({ revision: 2, version: "1.1.0" }), "1.1.0 · revision 2");
    assert.equal(workflowListVersionText({ revision: 2 }), "revision 2");
    assert.equal(workflowListVersionText({}), "—");
    assert.deepEqual(workflowChildDefinitionFacts(null), { version: null, state: null, revision: null, identity: null });
});

test("his shape: every child not started is listed, newest first, with its version, state and time", () => {
    const h = harness({ more: [["wf-4", "1.2.0", Date.parse("2026-11-06T19:50:00.000Z")]] });
    const state = h.store.getState();
    const [definition] = workflowDefinitionsOf(state.sessions.byId, "chat", state.ui.workflowViews);
    assert.deepEqual(definition.workflows.map(item => item.sessionId), ["wf-1", "wf-2"]);
    assert.equal(definition.newestId, "wf-4");
    assert.deepEqual(workflowUnstartedChildren(state.sessions.byId, definition, state.ui.workflowViews).map(item => [item.sessionId, item.version, item.state, item.newest]),
        [["wf-4", "1.2.0", "draft", true], ["wf-3", "1.1.0", "draft", false]]);
});

test("the picker says the draft's version and 'draft'; the Workflows view says a newer draft is not started, with Show it and Start…", () => {
    const h = harness();
    const html = render(h, { view: "workflows" });
    assert.match(html, new RegExp(`<option value="${NAME}" selected="">${NAME} · 1\\.1\\.0 · draft</option>`));
    const words = text(html);
    assert.match(words, /A newer draft, 1\.1\.0, is not started yet\. Show it Start…/);
    assert.match(html, /data-action="show-unstarted"[^>]*>Show it<\/button>/);
    assert.match(html, /data-action="start-unstarted"[^>]*>Start…<\/button>/);
    // #1 and #2 are listed as before, each with its version (owner, 2026-11-07T00:03Z); the picker lists 1.0.0 too.
    assert.match(html, /aria-label="Open hacker-news-top-change-monitor #2"/);
    assert.match(words, /#2 Running 1\.0\.0/);
    assert.match(html, new RegExp(`<option value="${NAME}\u001f1\\.0\\.0\u001fh-6e43">${NAME} · 1\\.0\\.0</option>`));
});

test("the Definition view shows the draft: its version, 'draft, not started' and when it was made", () => {
    const html = render(harness(), { view: "definition" });
    assert.match(text(html), /Revision 1 · 1\.1\.0 · draft, not started · made (?:\d{4}-\d{2}-\d{2} )?19:35:04 UTC/);
    assert.match(html, /data-definition-child="wf-3"/);
    assert.ok(!html.includes("show-newest"), "it is the newest");
});

test("two drafts: the line says how many, each opens with its version and time; it shows as its own version", () => {
    const h = harness({ more: [["wf-4", "1.2.0", Date.parse("2026-11-06T19:50:00.000Z")]] });
    const list = text(render(h, { view: "workflows" }));
    assert.match(list, /2 drafts are not started yet\. 1\.2\.0 · draft · made (?:\d{4}-\d{2}-\d{2} )?19:50:00 UTC Show it 1\.1\.0 · draft · made (?:\d{4}-\d{2}-\d{2} )?19:35:04 UTC Show it/);
    const older = render(h, { view: "definition", definitionChild: "wf-3" });
    assert.match(older, /data-definition-child="wf-3"/);
    // Owner, 2026-11-07T00:03Z: it is version 1.1.0, chosen in the picker; it is the newest of its version, so no link.
    assert.match(text(older), /Revision 1 · 1\.1\.0 · draft, not started · made (?:\d{4}-\d{2}-\d{2} )?19:35:04 UTC/);
    assert.ok(!older.includes("show-newest"));
    assert.match(older, new RegExp(`<option value="${NAME}\u001f1\\.1\\.0\u001fh-5e54" selected="">${NAME} · 1\\.1\\.0 · draft</option>`));
    assert.match(older, new RegExp(`<option value="${NAME}">${NAME} · 1\\.2\\.0 · draft</option>`));
    // A choice of another definition, or the newest, drops it.
    const newest = render(h, { view: "definition", definitionChild: null });
    assert.match(newest, /data-definition-child="wf-4"/);
});

test("Workflows of one name that run different versions: the Version column says each one's version", () => {
    const html = text(render(harness({ second: "1.1.0" }), { view: "workflows" }));
    assert.match(html, /#2 Running 1\.1\.0/);
    assert.match(html, /#1 Running 1\.0\.0/);
});
