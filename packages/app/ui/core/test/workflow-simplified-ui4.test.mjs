/**
 * UI re-review of 0d67b8a6 (wfs1-adv-ui-refix-0d67b8a6.md): UI4-F1..F4, at the portal model.
 * - UI4-F1 (high): a version choice is stored as a child, so a draft's new revision (another hash) or its first read keeps
 *   the Definition view on that child; a chosen child that is deleted shows the newest and says so, never the run shown
 *   before.
 * - UI4-F2 (high): selecting a Workflow row (the session list, a click or the keyboard: one action) clears a child shown with
 *   Show it, and while a run is shown the picker describes that run.
 * - UI4-F4: drafts of one version made in the same second (or with no time) have distinct names in the picker, Compare and
 *   the list of drafts.
 *
 * Run: node --test ui/core/test/workflow-simplified-ui4.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    workflowDefinitionVersions, workflowDefinitionsOf, workflowMadeNumbers, workflowMadeWords, workflowPickerChoicePatch, workflowUnstartedChildren,
    workflowVersionDiscriminator,
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
/** `children`: [id, status, model or null, createdAt (default: a minute apart; null: none)] in creation order. */
function harness(children) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "chat", title: "HN watcher", createdAt: T0, updatedAt: T0 },
        ...children.map(([sessionId, status, , createdAt], index) => {
            const made = createdAt === undefined ? T0 + (index + 1) * 60_000 : createdAt;
            return { sessionId, sessionKind: "workflow", title: `Workflow: ${NAME}`, status, parentSessionId: "chat",
                ...(made === null ? {} : { createdAt: made }), updatedAt: (made ?? T0) + 1_000 };
        }),
    ] });
    for (const [id, , readModel] of children) if (readModel) read(store, id, readModel);
    store.dispatch({ type: "sessions/selected", sessionId: "chat" });
    return { store, controller: new PilotSwarmUiController({ store, transport: {} }) };
}
function read(store, id, readModel) {
    store.dispatch({ type: "ui/workflowView", sessionId: id, view: { readModel, readModelRunId: null } });
}
const tabOf = h => h.store.getState().ui.workflowTabs?.chat ?? {};
const draw = h => renderToStaticMarkup(React.createElement(WorkflowTab, { controller: h.controller, mobile: false }));
const render = (h, patch = {}) => {
    h.store.dispatch({ type: "ui/workflowTab", ownerId: "chat", patch: { definition: NAME, ...patch } });
    return draw(h);
};
const options = html => [...html.slice(html.indexOf("ps-wf-picker-select")).matchAll(/<option value="([^"]*)"( selected="")?>([^<]*)<\/option>/g)]
    .map(([, value, selected, words]) => ({ value, selected: Boolean(selected), words })).filter(option => option.value !== "__new__");
const chosenWords = html => options(html).find(option => option.selected)?.words ?? null;
const shownChild = html => /data-definition-child="([^"]+)"/.exec(html)?.[1] ?? null;
const versionsOf = h => {
    const state = h.store.getState();
    const [definition] = workflowDefinitionsOf(state.sessions.byId, "chat", state.ui.workflowViews);
    return { definition, versions: workflowDefinitionVersions(state.sessions.byId, definition, state.ui.workflowViews) };
};
/** The picker's own handler (workflow-tab.js onChoose is workflowPickerChoicePatch) for an option's value, applied to the tab. */
const choose = (h, value) => {
    const state = h.store.getState();
    const { definition, versions } = versionsOf(h);
    const definitions = workflowDefinitionsOf(state.sessions.byId, "chat", state.ui.workflowViews);
    const patch = workflowPickerChoicePatch(value, { definitions, definition: definitions.find(item => item.name === definition.name), versions,
        byId: state.sessions.byId, views: state.ui.workflowViews });
    h.store.dispatch({ type: "ui/workflowTab", ownerId: "chat", patch });
    return draw(h);
};

test("UI4-F1: a draft chosen in the picker stays shown when its new revision changes its hash (A shown before, not taken back)", () => {
    const h = harness([["wf-1", "cancelled", modelOf("wf-1", "1.0.0", { status: "cancelled" })], ["wf-2", "pending", modelOf("wf-2", "1.1.0", { draft: true })]]);
    h.store.dispatch({ type: "sessions/selected", sessionId: "chat", workflowRowId: "wf-1" });
    assert.equal(chosenWords(draw(h)), `${NAME} · 1.0.0`, "A's run is shown: the picker says A");
    // B chosen in the picker (its option is the bare name: it holds the newest child).
    const chosen = choose(h, options(draw(h)).find(option => option.words.startsWith(`${NAME} · 1.1.0`)).value);
    assert.equal(tabOf(h).versionChild, "wf-2");
    assert.equal(shownChild(chosen), "wf-2");
    // B saved: revision 2, another hash. The old entry key is gone; the choice is the child, so B stays.
    const before = versionsOf(h).versions.find(entry => entry.children.includes("wf-2")).key;
    read(h.store, "wf-2", modelOf("wf-2", "1.1.0", { draft: true, hash: "h-1.1.0-saved", revision: 2 }));
    const after = draw(h);
    assert.notEqual(versionsOf(h).versions.find(entry => entry.children.includes("wf-2")).key, before, "the hash (entry key) changed");
    assert.equal(shownChild(after), "wf-2", "still B, not the run shown before (A)");
    assert.equal(chosenWords(after), `${NAME} · 1.1.0 · draft`);
    assert.match(after, /<section class="ps-wf-tab" aria-label="Workflow" data-view="definition" data-definition="hn-top-watch" data-version="1\.1\.0"/);
    // The same in Compare's "To" side: B's entry, by its new key.
    const compare = render(h, { definitionPanel: "revisions" });
    assert.match(compare, /aria-label="Compare two versions" data-from="1\.0\.0" data-to="1\.1\.0"/);
    assert.equal(shownChild(compare), "wf-2");
});

test("UI4-F1: the newest chosen before its first read stays shown when the read arrives; a newer child of its definition follows", () => {
    const h = harness([["wf-1", "cancelled", modelOf("wf-1", "1.0.0", { status: "cancelled" })], ["wf-2", "pending", null]]);
    h.store.dispatch({ type: "sessions/selected", sessionId: "chat", workflowRowId: "wf-1" });
    const unread = options(draw(h)).find(option => option.value === NAME);
    assert.ok(unread, "the newest child, not read yet, is the bare name's option");
    assert.equal(shownChild(choose(h, unread.value)), "wf-2");
    read(h.store, "wf-2", modelOf("wf-2", "1.1.0", { draft: true }));
    assert.equal(shownChild(draw(h)), "wf-2", "read: still B");
    // Another child of the same version and the same YAML (the same definition) is that entry's newest: it is shown, as the
    // version follows its newest child.
    h.store.dispatch({ type: "sessions/loaded", sessions: [...Object.values(h.store.getState().sessions.byId),
        { sessionId: "wf-3", sessionKind: "workflow", title: `Workflow: ${NAME}`, status: "pending", parentSessionId: "chat", createdAt: T0 + 300_000,
            updatedAt: T0 + 301_000 }] });
    read(h.store, "wf-3", modelOf("wf-3", "1.1.0", { draft: true }));
    assert.equal(shownChild(draw(h)), "wf-3");
});

test("UI4-F1: a chosen child that is deleted shows the newest and says so, never the run shown before", () => {
    const h = harness([["wf-1", "cancelled", modelOf("wf-1", "1.0.0", { status: "cancelled" })], ["wf-2", "pending", modelOf("wf-2", "1.1.0", { draft: true })]]);
    h.store.dispatch({ type: "sessions/selected", sessionId: "chat", workflowRowId: "wf-1" });
    const html = render(h, { view: "definition", versionChild: "wf-9" });
    assert.equal(shownChild(html), "wf-2");
    assert.match(html, /data-choice="gone">The version you chose was deleted\. Showing the newest\.</);
    assert.equal(chosenWords(html), `${NAME} · 1.1.0 · draft`);
    // With no choice the Definition view is the run's own (UI3-F9), and nothing is said.
    const own = render(h, { versionChild: null });
    assert.equal(shownChild(own), "wf-1");
    assert.doesNotMatch(own, /data-choice="gone"/);
});

test("UI4-F2: selecting A's row after Show it on B clears B; the picker and the Definition view are A's (click or keyboard: one action)", () => {
    for (const select of [
        h => h.store.dispatch({ type: "sessions/selected", sessionId: "chat", workflowRowId: "wf-1" }),
        // A Workflow's own id selected (a link, the keyboard on its row): mapped to its session with the Workflow row.
        h => h.store.dispatch({ type: "sessions/selected", sessionId: "wf-1" }),
    ]) {
        const h = harness([["wf-1", "completed", modelOf("wf-1", "1.0.0")], ["wf-2", "pending", modelOf("wf-2", "1.1.0", { draft: true })]]);
        // The Workflows list, then Show it on B.
        render(h, { view: "workflows", workflowId: null });
        const shown = render(h, { view: "definition", definitionChild: "wf-2" });
        assert.equal(shownChild(shown), "wf-2");
        select(h);
        assert.equal(tabOf(h).definitionChild, undefined, "the row selection clears Show it");
        assert.equal(tabOf(h).workflowId, "wf-1");
        const run = draw(h);
        assert.equal(chosenWords(run), `${NAME} · 1.0.0`, "the run shown: the picker says A");
        const definition = render(h, { view: "definition" });
        assert.equal(shownChild(definition), "wf-1");
        assert.equal(chosenWords(definition), `${NAME} · 1.0.0`);
    }
});

test("UI4-F2: while a run is shown, a child kept from Show it does not name the picker (the run does)", () => {
    const h = harness([["wf-1", "completed", modelOf("wf-1", "1.1.3", { hash: "h-a" })], ["wf-2", "pending", modelOf("wf-2", "1.1.3", { hash: "h-b", draft: true })]]);
    h.store.dispatch({ type: "sessions/selected", sessionId: "chat", workflowRowId: "wf-1" });
    // As a tab state could hold it (a choice made elsewhere): the run is shown, and Show it's child is still stored.
    const html = render(h, { view: "workflows", workflowId: "wf-1", definitionChild: "wf-2" });
    assert.equal(chosenWords(html), `${NAME} · 1.1.3 · #1`, "equal versions, different definitions: the run's own");
    assert.match(html, /data-view="workflows"/);
});

test("UI4-F4: drafts of one version made in the same second have distinct names in the picker, Compare and the list", () => {
    const h = harness([
        ["wf-1", "pending", modelOf("wf-1", "1.1.3", { hash: "h-a", draft: true }), T0 + 100],
        ["wf-2", "pending", modelOf("wf-2", "1.1.3", { hash: "h-b", draft: true }), T0 + 800],
        ["wf-3", "pending", modelOf("wf-3", "1.1.3", { hash: "h-c", draft: true }), T0 + 900],
        ["wf-4", "pending", modelOf("wf-4", "1.1.3", { hash: "h-d", draft: true }), T0 + 5_000],
    ]);
    const html = render(h, { view: "definition" });
    const words = options(html).map(option => option.words);
    assert.equal(new Set(words).size, 4, words.join(" | "));
    assert.match(words[0], /^hn-top-watch · 1\.1\.3 · made [^(]+ · draft$/, "made in a second of its own: no number");
    // Review 19:10Z: the number in plain words ("number 2"), not an ordinal.
    assert.deepEqual(words.slice(1).map(text => / · number (\d) · draft$/.exec(text)?.[1]), ["3", "2", "1"], "numbered oldest first");
    // Each name chooses its own child.
    for (const [index, child] of [["1", "wf-1"], ["2", "wf-2"], ["3", "wf-3"]]) {
        const option = options(draw(h)).find(item => item.words.endsWith(` · number ${index} · draft`));
        assert.equal(shownChild(choose(h, option.value)), child);
    }
    // Compare: the same numbers, distinct sides.
    const compare = render(h, { definitionPanel: "revisions", versionChild: "wf-2" });
    const [, from, to] = /aria-label="Compare two versions" data-from="([^"]*)" data-to="([^"]*)"/.exec(compare);
    assert.match(to, /^1\.1\.3 · made .+ · number 2$/);
    assert.notEqual(from, to);
    for (const field of ["compare-from-version", "compare-to-version"]) {
        const select = compare.slice(compare.indexOf(`data-field="${field}"`)).split("</select>")[0];
        const names = [...select.matchAll(/<option value="[^"]*"(?: selected="")?>Version ([^<]*)<\/option>/g)].map(match => match[1]);
        assert.equal(names.length, 4, field);
        assert.equal(new Set(names).size, 4, `${field}: ${names.join(" | ")}`);
    }
    // The Workflows view's list of drafts: the same numbers, in the visible and the accessible names.
    const list = render(h, { view: "workflows", workflowId: null, versionChild: null });
    const items = [...list.matchAll(/aria-label="Show ([^"]*)"/g)].map(match => match[1]);
    assert.equal(items.length, 4);
    assert.equal(new Set(items).size, 4, items.join(" | "));
    assert.deepEqual(items.map(text => / · number (\d)$/.exec(text)?.[1] ?? null), [null, "3", "2", "1"]);
});

test("UI4-F4: with no creation time, drafts of one version are numbered; numbers are by creation, and only for names that collide", () => {
    const items = [
        { sessionId: "c", version: "1.1.3", createdAt: null },
        { sessionId: "b", version: "1.1.3", createdAt: null },
        { sessionId: "a", version: "1.1.3", createdAt: null },
        { sessionId: "z", version: "1.0.0", createdAt: null },
    ];
    const numbers = workflowMadeNumbers(items, () => null);
    assert.deepEqual([...numbers.entries()], [["a", 1], ["b", 2], ["c", 3]]);
    assert.equal(workflowMadeWords(null, 2), "number 2");
    assert.equal(workflowMadeWords("01:00:00 UTC", 2), "made 01:00:00 UTC · number 2");
    assert.equal(workflowMadeWords("01:00:00 UTC", null), "made 01:00:00 UTC");
    assert.equal(workflowMadeWords(null, null), null);
    assert.equal(workflowVersionDiscriminator({ shared: true, numbers: [] }, null, 2), "number 2");
    assert.equal(workflowVersionDiscriminator({ shared: true, numbers: [4] }, "01:00:00 UTC", 2), "#4", "a version with Workflows says their numbers");
    // Through the tab: two drafts with no time, one version.
    const h = harness([
        ["wf-1", "pending", modelOf("wf-1", "1.1.3", { hash: "h-a", draft: true }), null],
        ["wf-2", "pending", modelOf("wf-2", "1.1.3", { hash: "h-b", draft: true }), null],
    ]);
    const words = options(render(h, { view: "definition" })).map(option => option.words);
    assert.deepEqual(words, [`${NAME} · 1.1.3 · number 2 · draft`, `${NAME} · 1.1.3 · number 1 · draft`]);
    // The children not started, as the list has them (newest first), give the same numbers.
    const state = h.store.getState();
    const [definition] = workflowDefinitionsOf(state.sessions.byId, "chat", state.ui.workflowViews);
    assert.deepEqual([...workflowMadeNumbers(workflowUnstartedChildren(state.sessions.byId, definition, state.ui.workflowViews)).entries()],
        [["wf-1", 1], ["wf-2", 2]]);
});
