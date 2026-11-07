/**
 * UI re-check of d5f4fca1 (wfs1-adv-ui-recheck-d5f4fca1.md), UI5-F1 (high): the view follows a newer child of the same
 * version and definition (C after the chosen B), and the stored choice now follows it too (workflowVersionChoicePatch, the
 * patch the Workflow tab applies after it renders), so a revision that gives C a definition of its own keeps the view, its
 * YAML and its Start on C, never back on B. Driven through the production handler (workflowPickerChoicePatch) and the
 * production reconciliation, then the real tab's render. The mounted case (YAML mode and a typed Start form kept) is the
 * browser spec "UI5-F1".
 *
 * Run: node --test ui/core/test/workflow-simplified-ui5.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    workflowDefinitionVersions, workflowDefinitionsOf, workflowPickerChoicePatch, workflowVersionChoicePatch,
} from "../src/workflow-owner.js";
import { WorkflowTab } from "../../react/src/workflow-tab.js";

process.env.TZ = "UTC";
const NAME = "hn-top-watch";
const STATES = [{ id: "poll", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["changed"], next: { changed: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" }];
const modelOf = (workflowId, semver, { hash = `h-${semver}`, status = "completed", draft = false, revision = 1 } = {}) => ({
    workflowId, definition: draft ? { state: "draft", semver, currentRevision: revision, publishedRevision: null }
        : { state: "published", semver, currentRevision: revision, publishedRevision: revision },
    revision: { revision, definitionHash: hash, valid: true, name: NAME, diagnostics: [] },
    graph: { revision, initial: "poll", states: STATES },
    runs: draft ? [] : [{ runId: `run-${workflowId}`, mode: "live", status, revision, outcome: status === "completed" ? "succeeded" : null }],
    run: draft ? null : { runId: `run-${workflowId}`, mode: "live", status, outcome: null, nodeExecutions: [], inbox: [], outbox: [], kv: "{}", kvRevision: 1 },
});
const T0 = Date.parse("2026-11-06T23:30:00.000Z");
const row = (sessionId, status, index) => ({ sessionId, sessionKind: "workflow", title: `Workflow: ${NAME}`, status, parentSessionId: "chat",
    createdAt: T0 + (index + 1) * 60_000, updatedAt: T0 + (index + 1) * 60_000 + 1_000 });

function harness() {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "chat", title: "HN watcher", createdAt: T0, updatedAt: T0 },
        row("wf-a", "cancelled", 0), row("wf-b", "pending", 1)] });
    read(store, "wf-a", modelOf("wf-a", "1.0.0", { status: "cancelled" }));
    read(store, "wf-b", modelOf("wf-b", "1.1.0", { draft: true, hash: "h-same" }));
    store.dispatch({ type: "sessions/selected", sessionId: "chat", workflowRowId: "wf-a" });
    return { store, controller: new PilotSwarmUiController({ store, transport: {} }) };
}
function read(store, id, readModel) {
    store.dispatch({ type: "ui/workflowView", sessionId: id, view: { readModel, readModelRunId: null } });
}
const tabOf = h => h.store.getState().ui.workflowTabs?.chat ?? {};
const facts = h => {
    const state = h.store.getState();
    const definitions = workflowDefinitionsOf(state.sessions.byId, "chat", state.ui.workflowViews);
    const [definition] = definitions;
    return { state, definitions, definition, versions: workflowDefinitionVersions(state.sessions.byId, definition, state.ui.workflowViews) };
};
/** The tab renders, then applies its own reconciliation (the effect after the render), as the mounted tab does. */
const draw = h => {
    const html = renderToStaticMarkup(React.createElement(WorkflowTab, { controller: h.controller, mobile: false }));
    const { definition, versions } = facts(h);
    const patch = workflowVersionChoicePatch(versions, tabOf(h), definition.children);
    if (patch) h.store.dispatch({ type: "ui/workflowTab", ownerId: "chat", patch });
    return html;
};
const options = html => [...html.slice(html.indexOf("ps-wf-picker-select")).matchAll(/<option value="([^"]*)"( selected="")?>([^<]*)<\/option>/g)]
    .map(([, value, selected, words]) => ({ value, selected: Boolean(selected), words })).filter(option => option.value !== "__new__");
const shownChild = html => /data-definition-child="([^"]+)"/.exec(html)?.[1] ?? null;
/** The picker's own handler for the option whose words start with `words`. */
const choose = (h, words) => {
    const option = options(draw(h)).find(item => item.words.startsWith(words));
    assert.ok(option, words);
    const { state, definitions, definition, versions } = facts(h);
    h.store.dispatch({ type: "ui/workflowTab", ownerId: "chat", patch: workflowPickerChoicePatch(option.value, { definitions, definition, versions,
        byId: state.sessions.byId, views: state.ui.workflowViews }) });
};

test("UI5-F1: B chosen; an equivalent newer C is followed and stored; C's revision with its own definition keeps the view on C", () => {
    const h = harness();
    choose(h, `${NAME} · 1.1.0`);
    assert.equal(tabOf(h).versionChild, "wf-b");
    assert.equal(shownChild(draw(h)), "wf-b");
    // C arrives: the same version and definition as B (one entry); the view follows the newest, C, and so does the choice.
    h.store.dispatch({ type: "sessions/merged", session: row("wf-c", "pending", 2) });
    read(h.store, "wf-c", modelOf("wf-c", "1.1.0", { draft: true, hash: "h-same" }));
    assert.equal(shownChild(draw(h)), "wf-c");
    assert.equal(tabOf(h).versionChild, "wf-c", "the stored choice followed the shown child");
    // C is saved: revision 2, a definition of its own (another entry). The view stays on C, not B.
    read(h.store, "wf-c", modelOf("wf-c", "1.1.0", { draft: true, hash: "h-c-edited", revision: 2 }));
    const after = draw(h);
    assert.equal(shownChild(after), "wf-c");
    assert.match(after, /Revision 2 · 1\.1\.0/);
    assert.equal(tabOf(h).versionChild, "wf-c");
    // B is still its own option; choosing it shows it.
    choose(h, `${NAME} · 1.1.0 · made`);
    assert.ok(["wf-b", "wf-c"].includes(shownChild(draw(h))));
});

test("UI5-F1: the reconciliation changes nothing when the stored child is the one shown, is gone, or no choice is made", () => {
    const h = harness();
    const { definition, versions } = facts(h);
    assert.equal(workflowVersionChoicePatch(versions, {}, definition.children), null, "no choice");
    assert.equal(workflowVersionChoicePatch(versions, { versionChild: "wf-b" }, definition.children), null, "the shown child");
    assert.equal(workflowVersionChoicePatch(versions, { versionChild: "wf-gone" }, definition.children), null, "gone: the view says so");
    // An earlier shape is stored as its entry's newest child (UI4-F3).
    assert.deepEqual(workflowVersionChoicePatch(versions, { version: "1.1.0" }, definition.children), { versionChild: "wf-b", versionKey: null, version: null });
});
