/**
 * Owner, 2026-11-07T00:03Z: versions are first-class. His screenshot: hn-top-watch #1 (Canceled) and #2 (Completed), and
 * the definition picker showed one entry, "hn-top-watch · 1.1.0 · revision 1". In stage 1 each version of a definition is
 * its own workflow child (a new version is a new child), so the tab shows them as versions:
 * - the definition picker lists each version of a name as its own option, highest first ("hn-top-watch · 1.1.0",
 *   "hn-top-watch · 1.0.0"), with draft or not started where it applies;
 * - the Definition view, its YAML and Start… follow the chosen version (its newest child); a Workflow shown is its own
 *   version;
 * - the Workflow picker's options and the Workflows list say each Workflow's version ("#1 · 1.0.0 · Canceled");
 * - Compare compares two versions' YAML (each its newest child's current revision).
 *
 * Run: node --test ui/core/test/workflow-simplified-versions.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    workflowChosenVersion, workflowDefinitionVersions, workflowDefinitionsOf, workflowVersionFromOptionValue, workflowVersionOptionValue,
    workflowCompareVersions, workflowNewestVersionKey, workflowVersionDiscriminator,
} from "../src/workflow-owner.js";
import { workflowV2VersionCompare } from "../src/workflow-v2-commands.js";
import { WorkflowTab } from "../../react/src/workflow-tab.js";

process.env.TZ = "UTC";
const NAME = "hn-top-watch";
const STATES = [{ id: "poll", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["changed"], next: { changed: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" }];
const YAML = version => `apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: ${NAME}, version: "${version}" }\ninitial: poll\n`;
const started = (workflowId, runId, semver, status, outcome) => ({
    workflowId, definition: { state: "published", semver, currentRevision: 1, publishedRevision: 1 },
    revision: { revision: 1, definitionHash: `h-${semver}`, valid: true, name: NAME, diagnostics: [] },
    graph: { revision: 1, initial: "poll", states: STATES },
    runs: [{ runId, mode: "live", status, revision: 1, outcome }],
    run: { runId, mode: "live", status, outcome, nodeExecutions: [], inbox: [], outbox: [], kv: "{}", kvRevision: 1 },
});
const T0 = Date.parse("2026-11-06T23:30:00.000Z");
/** An entry's key: its version and the definition it holds (the fixtures' definitionHash). */
const KEY = version => `${version}\u001fh-${version}`;
// His shape: #1 1.0.0 (Canceled) and #2 1.1.0 (Completed), both children of the chat.
function harness({ more = [] } = {}) {
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "api" }));
    const row = (sessionId, status, createdAt) => ({ sessionId, sessionKind: "workflow", title: `Workflow: ${NAME}`, status, parentSessionId: "chat",
        createdAt, updatedAt: createdAt + 1_000 });
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "chat", title: "HN watcher", createdAt: T0, updatedAt: T0 },
        row("wf-1", "cancelled", T0 + 60_000),
        row("wf-2", "completed", T0 + 120_000),
        ...more.map(([id, status, at]) => row(id, status, at)),
    ] });
    const model = (id, readModel, extra = {}) => store.dispatch({ type: "ui/workflowView", sessionId: id, view: { readModel, readModelRunId: null, ...extra } });
    model("wf-1", started("wf-1", "run-1", "1.0.0", "cancelled", null));
    model("wf-2", started("wf-2", "run-2", "1.1.0", "completed", "succeeded"));
    for (const [id, , , readModel] of more) if (readModel) model(id, readModel);
    store.dispatch({ type: "sessions/selected", sessionId: "chat" });
    return { store, controller: new PilotSwarmUiController({ store, transport: {} }) };
}
const render = (h, patch, { row = null } = {}) => {
    if (row) h.store.dispatch({ type: "sessions/selected", sessionId: "chat", workflowRowId: row });
    h.store.dispatch({ type: "ui/workflowTab", ownerId: "chat", patch: { definition: NAME, ...patch } });
    return renderToStaticMarkup(React.createElement(WorkflowTab, { controller: h.controller, mobile: false }));
};
const text = html => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const definitionOptions = html => [...html.slice(html.indexOf("ps-wf-picker-select")).matchAll(/<option value="([^"]*)"( selected="")?>([^<]*)<\/option>/g)]
    .slice(0, 3).map(([, value, selected, words]) => ({ value, selected: Boolean(selected), words }));
const versionsOf = h => {
    const state = h.store.getState();
    const [definition] = workflowDefinitionsOf(state.sessions.byId, "chat", state.ui.workflowViews);
    return { definition, versions: workflowDefinitionVersions(state.sessions.byId, definition, state.ui.workflowViews) };
};

test("his shape: two versions of one definition, highest first, each with its newest child", () => {
    const { definition, versions } = versionsOf(harness());
    assert.deepEqual(definition.workflows.map(item => [item.sessionId, item.number]), [["wf-1", 1], ["wf-2", 2]], "numbers stay the name's");
    assert.deepEqual(versions.map(entry => [entry.version, entry.children, entry.newestId, entry.startable]),
        [["1.1.0", ["wf-2"], "wf-2", false], ["1.0.0", ["wf-1"], "wf-1", false]]);
});

test("versions order by number, a release above its pre-release; a child not read yet joins once read, unless it is the newest", () => {
    const at = minutes => T0 + minutes * 60_000;
    const h = harness({ more: [
        ["wf-3", "completed", at(3), started("wf-3", "run-3", "1.10.0", "completed", "succeeded")],
        ["wf-4", "completed", at(4), started("wf-4", "run-4", "1.10.0-rc.1", "completed", "succeeded")],
        ["wf-5", "completed", at(5), started("wf-5", "run-5", "1.9.0", "completed", "succeeded")],
        ["wf-6", "completed", at(6), started("wf-6", "run-6", "1.0.0", "completed", "succeeded")],
        ["wf-7", "completed", at(7), null],
    ] });
    const { versions } = versionsOf(h);
    assert.deepEqual(versions.map(entry => entry.version), ["1.10.0", "1.10.0-rc.1", "1.9.0", "1.1.0", "1.0.0", null]);
    // 1.0.0's newest child is the later one; the child not read yet is the definition's newest, so it is reachable.
    assert.equal(versions.find(entry => entry.version === "1.0.0").newestId, "wf-6");
    assert.deepEqual(versions.at(-1).children, ["wf-7"]);
    // Not the newest: it waits for its read.
    const older = harness({ more: [["wf-0", "completed", T0 + 30_000, null]] });
    assert.deepEqual(versionsOf(older).versions.map(entry => entry.version), ["1.1.0", "1.0.0"]);
});

test("the version shown: a chosen child, else the chosen version, else the Workflow shown, else the newest child's", () => {
    const { definition, versions } = versionsOf(harness());
    const pick = options => workflowChosenVersion(versions, { newestId: definition.newestId, ...options })?.version ?? null;
    assert.equal(pick({}), "1.1.0", "the newest child's");
    assert.equal(pick({ workflowId: "wf-1" }), "1.0.0", "the Workflow shown");
    assert.equal(pick({ workflowId: "wf-1", key: KEY("1.1.0") }), "1.1.0", "chosen beats shown");
    assert.equal(pick({ key: KEY("1.1.0"), child: "wf-1" }), "1.0.0", "a chosen child beats both");
    assert.equal(pick({ key: KEY("9.9.9") }), "1.1.0", "an unknown choice: the newest");
    assert.equal(workflowChosenVersion([], {}), null);
    assert.deepEqual(versions.map(entry => entry.key), [KEY("1.1.0"), KEY("1.0.0")]);
    assert.equal(workflowNewestVersionKey(versions, definition.newestId), KEY("1.1.0"));
    // The picker's values: the name for the entry holding the newest child, name␟key for the others.
    assert.equal(workflowVersionOptionValue({ name: NAME, key: KEY("1.1.0"), newest: true }), NAME);
    assert.equal(workflowVersionOptionValue({ name: NAME, key: KEY("1.0.0") }), `${NAME}\u001f${KEY("1.0.0")}`);
    assert.deepEqual(workflowVersionFromOptionValue(NAME), { name: NAME, key: null });
    assert.deepEqual(workflowVersionFromOptionValue(`${NAME}\u001f${KEY("1.0.0")}`), { name: NAME, key: KEY("1.0.0") });
});

test("the picker lists each version; the Definition view follows the chosen one, its YAML and Start… with it", () => {
    const h = harness();
    const newest = render(h, { view: "definition" });
    assert.deepEqual(definitionOptions(newest), [
        { value: NAME, selected: true, words: `${NAME} · 1.1.0` },
        { value: `${NAME}\u001f${KEY("1.0.0")}`, selected: false, words: `${NAME} · 1.0.0` },
    ], "OF-S2-8: no option asks the chat for a new definition");
    assert.match(newest, /data-version="1\.1\.0"/);
    assert.match(newest, /data-definition-child="wf-2"/);
    assert.match(text(newest), /Revision 1 · 1\.1\.0 /);
    // 1.0.0 chosen: its newest child is shown, and the picker says 1.0.0.
    const chosen = render(h, { view: "definition", versionKey: KEY("1.0.0") });
    assert.deepEqual(definitionOptions(chosen).map(option => [option.words, option.selected]),
        [[`${NAME} · 1.1.0`, false], [`${NAME} · 1.0.0`, true]]);
    assert.match(chosen, /data-definition-child="wf-1"/);
    assert.match(text(chosen), /Revision 1 · 1\.0\.0 /);
    assert.ok(!chosen.includes("show-newest"), "the newest of its version");
    // Start another… repeats the version shown: the Definition view's child is the one the chat is asked about.
    assert.match(chosen, /data-action="start-another"/);
});

test("a Workflow shown is its own version: the picker says 1.0.0 for #1; the Workflow picker says each one's version", () => {
    const h = harness();
    const html = render(h, { view: "workflows", workflowId: "wf-1", versionKey: KEY("1.1.0") }, { row: "wf-1" });
    assert.deepEqual(definitionOptions(html).map(option => [option.words, option.selected]).slice(0, 2),
        [[`${NAME} · 1.1.0`, false], [`${NAME} · 1.0.0`, true]]);
    assert.match(html, /<optgroup label="2 Workflows"><option value="wf-2">#2 · 1\.1\.0 · Completed<\/option><option value="wf-1"[^>]*>#1 · 1\.0\.0 · Canceled<\/option><\/optgroup>/);
});

test("the Workflows list says each Workflow's version", () => {
    const html = text(render(harness(), { view: "workflows", workflowId: null }));
    assert.match(html, /# State Version Started Took/);
    assert.match(html, /#2 Completed 1\.1\.0 /);
    assert.match(html, /#1 Canceled 1\.0\.0 /);
});

test("Compare compares two versions' YAML: from the version below the one shown, each its newest child's revision", () => {
    const h = harness();
    const closed = render(h, { view: "definition", definitionPanel: "revisions", versionKey: null });
    assert.match(closed, /aria-label="Compare two versions" data-from="1\.0\.0" data-to="1\.1\.0" data-compare="versions"/);
    assert.match(text(closed), /Reading versions 1\.0\.0 and 1\.1\.0…/);
    // Both read: the summary counts the lines.
    const read = (id, version) => h.store.dispatch({ type: "ui/workflowView", sessionId: id, view: { definitionRevisions: {
        1: { phase: "loaded", value: { definitionRevision: { revision: 1, yaml: YAML(version), valid: true } } } } } });
    read("wf-1", "1.0.0");
    read("wf-2", "1.1.0");
    assert.match(text(render(h, { view: "definition", definitionPanel: "revisions" })), /Version 1\.0\.0 → 1\.1\.0: \+1 −1 lines/);
    // The lowest version shown: it compares with the one above.
    assert.match(render(h, { view: "definition", definitionPanel: "revisions", versionKey: KEY("1.0.0") }), /data-from="1\.1\.0" data-to="1\.0\.0"/);
});

test("workflowV2VersionCompare: reading, the same YAML, and a failed read", () => {
    const loaded = yaml => ({ phase: "loaded", value: { definitionRevision: { revision: 1, yaml, valid: true } } });
    assert.equal(workflowV2VersionCompare({ version: "1.0.0", read: null }, { version: "1.1.0", read: null }).summary, "Reading versions 1.0.0 and 1.1.0…");
    assert.equal(workflowV2VersionCompare({ version: "1.0.0", read: loaded("a") }, { version: "1.0.1", read: loaded("a") }).summary,
        "Versions 1.0.0 and 1.0.1 have the same YAML.");
    const failed = workflowV2VersionCompare({ version: "1.0.0", read: { phase: "failed", error: "gone" } }, { version: "1.1.0", read: loaded("b") });
    assert.equal(failed.summary, "Version 1.0.0 could not be read: gone");
    assert.equal(failed.ready, false);
});

test("two children of one version: the older one says it is not the newest, and the way back stays on that version", () => {
    const at = minutes => T0 + minutes * 60_000;
    const draftOf = (id, semver) => ({ ...started(id, "x", semver, "running", null), definition: { state: "draft", semver, currentRevision: 1, publishedRevision: null },
        runs: [], run: null });
    const h = harness({ more: [
        ["wf-3", "pending", at(3), draftOf("wf-3", "1.2.0")],
        ["wf-4", "pending", at(4), draftOf("wf-4", "1.2.0")],
        ["wf-5", "pending", at(5), draftOf("wf-5", "1.3.0")],
    ] });
    const older = render(h, { view: "definition", definitionChild: "wf-3", versionKey: null });
    assert.match(older, /data-definition-child="wf-3"/);
    assert.match(older, /data-action="show-newest"/);
    assert.match(older, new RegExp(`<option value="${NAME}\u001f1\\.2\\.0\u001fh-1\\.2\\.0" selected="">${NAME} · 1\\.2\\.0 · draft</option>`));
    // What "show the newest" does: the newest child of 1.2.0, not the definition's newest (1.3.0).
    const back = render(h, { definitionChild: null, versionKey: KEY("1.2.0") });
    assert.match(back, /data-definition-child="wf-4"/);
    assert.ok(!back.includes("show-newest"));
});

test("a Workflow row chosen in the session list: a version chosen in the tab gives way to the Workflow's own", () => {
    const h = harness();
    h.store.dispatch({ type: "ui/workflowTab", ownerId: "chat", patch: { definition: NAME, view: "definition", versionKey: KEY("1.1.0") } });
    h.store.dispatch({ type: "sessions/selected", sessionId: "chat", workflowRowId: "wf-1" });
    assert.equal(h.store.getState().ui.workflowTabs.chat.versionKey, undefined);
    h.store.dispatch({ type: "ui/workflowTab", ownerId: "chat", patch: { view: "definition" } });
    const html = renderToStaticMarkup(React.createElement(WorkflowTab, { controller: h.controller, mobile: false }));
    assert.match(html, /data-definition-child="wf-1"/, "the Definition view shows #1's version");
    assert.match(html, /data-version="1\.0\.0"/);
});
