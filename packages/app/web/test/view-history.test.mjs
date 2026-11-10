import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createViewHistory, cleanView, navigationShortcut, reloadReadySessionId, viewKey, workflowTabOnReload, workflowTabPatch,
} from "../src/navigation/view-history.js";
const view = id => cleanView({ mode: "workspace", sessionId: String(id) });

test("history retains ten views, clamps ends, and replaces the forward branch", () => {
    const h = createViewHistory();
    for (let i = 0; i < 15; i++) h.visit(view(i));
    assert.equal(h.entries.length, 10); assert.equal(h.entries[0].sessionId, "5");
    assert.equal(h.move(1), null);
    h.move(-1); h.move(-1); assert.equal(h.current.sessionId, "12");
    h.visit(view("new")); assert.equal(h.destination(1), null);
    assert.equal(h.move(-1).sessionId, "12");
    while (h.move(-1));
    assert.equal(h.current.sessionId, "5"); assert.equal(h.index, 0);
});
test("repeated destinations update context without adding visits or losing Forward", () => {
    const h = createViewHistory(); h.visit(view(1)); h.visit(view(2)); h.move(-1);
    assert.equal(h.visit(view(1)), false); assert.equal(h.destination(1).sessionId, "2");
    const a = cleanView({ mode: "moa", dashboardId: "ops", panelId: "one" });
    const b = cleanView({ ...a, panelId: "two" });
    assert.equal(viewKey(a), viewKey(b)); h.visit(a); h.visit(b);
    assert.equal(h.current.panelId, "two"); assert.equal(h.entries.length, 2);
    assert.notEqual(viewKey(a), viewKey({ ...a, dashboardId: "review" }));
});
test("storage round trips the cursor and references, never arbitrary payloads", () => {
    const h = createViewHistory(); h.visit({ ...view(1), prompt: "secret", history: ["private text"] }); h.visit(view(2)); h.move(-1);
    assert.doesNotMatch(h.serialize(), /secret|private text|prompt/);
    const restored = createViewHistory(h.serialize());
    assert.equal(restored.current.sessionId, "1"); assert.equal(restored.destination(1).sessionId, "2");
    for (const invalid of ["broken", "null", JSON.stringify({ version: 1, entries: [{ mode: "evil" }], index: 0 }), JSON.stringify({version:1,entries:[view(1)],index:9})])
        assert.equal(createViewHistory(invalid).entries.length, 0);
});
test("keyboard supports Option-produced characters and composer navigation without hijacking other editing", () => {
    const event = extra => ({ altKey: true, code: "Minus", key: "–", ...extra });
    assert.equal(navigationShortcut(event()), -1);
    for (const code of ["Equal", "NumpadAdd"]) assert.equal(navigationShortcut(event({ code, key: "±", shiftKey: true })), 1);
    const composer = { matches: selector => selector === 'textarea.ps-prompt-input', closest: () => ({}) };
    assert.equal(navigationShortcut(event({ target: composer })), -1);
    assert.equal(navigationShortcut(event({ target: composer, code: "Equal", key: "≠" })), 1);
    for (const extra of [{ isComposing: true }, { getModifierState: name => name === "AltGraph" }, { ctrlKey: true }, { repeat: true }])
        assert.equal(navigationShortcut(event({ target: composer, ...extra })), 0);
    for (const extra of [{ altKey: false }, { ctrlKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }, { getModifierState: () => true }, { target: { isContentEditable: true } }, { target: { closest: () => ({}) } }])
        assert.equal(navigationShortcut(event(extra)), 0);
});

// Workflow Simplified, review UI-8: two Workflows of one chat are two views, and the right block's tab is part of a view.
test("a Workflow selected under its chat and the right block's tab are part of a view", () => {
    const base = { mode: "workspace", sessionId: "owner-1", canvasOpen: true, canvasSlot: 1 };
    const a = cleanView({ ...base, workflowRowId: "wf-1", sidePaneTab: "workflow" });
    const b = cleanView({ ...base, workflowRowId: "wf-2", sidePaneTab: "workflow" });
    assert.equal(a.workflowRowId, "wf-1");
    assert.equal(a.sidePaneTab, "workflow");
    assert.notEqual(viewKey(a), viewKey(b), "two Workflows, two views");
    assert.notEqual(viewKey(cleanView({ ...base, sidePaneTab: "canvas" })), viewKey(cleanView({ ...base, sidePaneTab: "workflow" })));
    assert.equal(cleanView({ ...base, sidePaneTab: "junk" }).sidePaneTab, "canvas");
    // With the right block closed, its tab does not make another view.
    assert.equal(viewKey(cleanView({ ...base, canvasOpen: false, sidePaneTab: "canvas" })), viewKey(cleanView({ ...base, canvasOpen: false, sidePaneTab: "workflow" })));
    const history = createViewHistory(null);
    assert.equal(history.visit(a), true);
    assert.equal(history.visit(b), true);
    assert.equal(history.move(-1).workflowRowId, "wf-1");
});

// Review UI-D3: the Workflow tab's context (the Workflow it shows under its parent, the definition and the Definition |
// Workflows view) is part of a view, apart from the highlighted row: Back/Forward and a reload show it again.
test("UI-D3: a view keeps the Workflow tab's context; Back/Forward and a reload restore it", () => {
    const base = { mode: "workspace", sessionId: "owner-1", canvasOpen: true, canvasSlot: 1, sidePaneTab: "workflow" };
    const tab = (workflowId, definition, view) => ({ ownerId: "owner-1", workflowId, definition, view });
    // Bounded references only.
    assert.deepEqual(cleanView({ ...base, workflowTab: tab("wf-b", "watch-flow", "workflows") }).workflowTab,
        { ownerId: "owner-1", workflowId: "wf-b", definition: "watch-flow", view: "workflows" });
    assert.deepEqual(cleanView({ ...base, workflowTab: { ...tab(null, "x".repeat(2000), "junk") } }).workflowTab,
        { ownerId: "owner-1", workflowId: null, definition: null, view: null });
    assert.equal(cleanView({ ...base, workflowTab: { workflowId: "wf-b" } }).workflowTab, null, "no owner, no context");
    assert.equal(cleanView(base).workflowTab, null);
    // Choosing in the tab is not a visit: the same view, its context updated in place.
    const shown = cleanView({ ...base, workflowTab: tab("wf-b", "watch-flow", "workflows") });
    const other = cleanView({ ...base, workflowTab: tab(null, "report-flow", "definition") });
    assert.equal(viewKey(shown), viewKey(other));
    // Back/Forward: the row view (wf-b highlighted), then the parent showing a non-default definition view; Back to the
    // row and Forward again gives the parent's own context back, also through storage.
    const history = createViewHistory(null);
    history.visit(cleanView({ ...base, workflowRowId: "wf-b", workflowTab: tab("wf-b", "watch-flow", "workflows") }));
    history.visit(shown);
    history.visit(other);
    assert.equal(history.entries.length, 2);
    assert.equal(history.move(-1).workflowRowId, "wf-b");
    const restored = createViewHistory(history.serialize());
    assert.deepEqual(restored.move(1).workflowTab, other.workflowTab);
    assert.deepEqual(workflowTabPatch(other.workflowTab), { workflowId: null, definition: "report-flow", view: "definition" });
    // A reload: the saved current view of the session now active, with nothing chosen in its tab yet, gives its context.
    const state = (activeSessionId, workflowTabs = {}) => ({ sessions: { activeSessionId }, ui: { workflowTabs } });
    assert.deepEqual(workflowTabOnReload(shown, state("owner-1")), { ownerId: "owner-1", patch: { workflowId: "wf-b", definition: "watch-flow", view: "workflows" } });
    assert.equal(workflowTabOnReload(shown, state("someone-else")), null, "another session opened");
    assert.equal(workflowTabOnReload(shown, state("owner-1", { "owner-1": { view: "definition" } })), null, "already chosen in this page");
    assert.equal(workflowTabOnReload({ ...shown, mode: "admin" }, state("owner-1")), null);
    assert.equal(workflowTabOnReload(undefined, state("owner-1")), null);
});

// Review UI-F2: a reload's saved view is applied, and the startup view taken, only once the initial session is resolved: a
// stored profile can select the session before the catalog answers (the ca43135a/10447048 browser runs), and a view taken
// then has no Workflow tab context, since that needs the session's row.
test("UI-F2: the startup view waits for the selected session's row and for a deep link to resolve", () => {
    const row = { sessionId: "owner-1", title: "Release triage agent" };
    const state = (activeSessionId, byId = {}, navigationIntent = null) => ({ sessions: { activeSessionId, byId, navigationIntent } });
    assert.equal(reloadReadySessionId(state(null)), null, "nothing selected");
    assert.equal(reloadReadySessionId(state("owner-1")), null, "selected by the profile before the catalog answered");
    assert.equal(reloadReadySessionId(state("owner-1", { "owner-1": row })), "owner-1");
    assert.equal(reloadReadySessionId(state("owner-1", { "owner-1": row }, { sessionId: "owner-2", status: "pending" })), null,
        "a deep link is still resolving");
    assert.equal(reloadReadySessionId(state("owner-1", { "owner-1": row }, { sessionId: "owner-1", status: "resolved" })), "owner-1");
    assert.equal(reloadReadySessionId(state("owner-1", { "owner-1": row }, { sessionId: "gone", status: "failed" })), "owner-1");
    assert.equal(reloadReadySessionId(undefined), null);
    // Once resolved, the saved view of that session still gives its context (nothing chosen in its tab yet).
    const shown = cleanView({ mode: "workspace", sessionId: "owner-1", canvasOpen: true, sidePaneTab: "workflow",
        workflowTab: { ownerId: "owner-1", workflowId: "wf-b", definition: "watch-flow", view: "workflows" } });
    const ready = { ...state("owner-1", { "owner-1": row }), ui: { workflowTabs: {} } };
    assert.deepEqual(workflowTabOnReload(shown, ready), { ownerId: "owner-1", patch: { workflowId: "wf-b", definition: "watch-flow", view: "workflows" } });
});

test("a phone screen is part of the view: chat, diagnostics and canvas are separate stops", () => {
    const h = createViewHistory();
    h.visit({ ...view(1), mobilePane: "workspace" });
    assert.equal(h.visit({ ...view(1), mobilePane: "inspector" }), true);
    assert.equal(h.visit({ ...view(1), mobilePane: "activity" }), true);
    assert.equal(h.entries.length, 3);
    assert.equal(cleanView({ ...view(1), mobilePane: "anything" }).mobilePane, null);
    const restored = createViewHistory(h.serialize());
    assert.equal(restored.current.mobilePane, "activity");
    assert.equal(restored.destination(-1).mobilePane, "inspector");
});

test("a phone's full-screen artifact preview is a stop of its own, and older entries still load", () => {
    const h = createViewHistory();
    h.visit({ ...view(1), mobilePane: "workspace" });
    const preview = { ...view(1), mobilePane: "workspace", artifactSessionId: "1", artifactFilename: "report.html", artifactFullscreen: true };
    assert.equal(h.visit(preview), true, "opening the preview is a visit");
    assert.notEqual(viewKey(cleanView(preview)), viewKey(cleanView({ ...preview, artifactFullscreen: false })));
    // The preview covers the screen under it: over chat or over the Files
    // tab, it is the same place, so a deep link landing on it adds no stop.
    assert.equal(viewKey(cleanView(preview)), viewKey(cleanView({ ...preview, mobilePane: "inspector" })));
    assert.equal(h.visit({ ...preview, mobilePane: "inspector" }), false, "the same preview refreshes its stop");
    assert.equal(h.index, 1);
    const restored = createViewHistory(h.serialize());
    assert.equal(restored.current.artifactFullscreen, true);
    assert.equal(restored.destination(-1).artifactFullscreen, false);
    // An entry saved before the field existed reads as the desktop pane.
    assert.equal(cleanView({ mode: "workspace", sessionId: "9", artifactSessionId: "9", artifactFilename: "a.md" }).artifactFullscreen, false);
});

// 0.8.10 merge: a view carries both this line's Workflow fields and main's phone fields; each still makes its own stop.
test("a view keeps the Workflow row, the right block's tab and the Workflow tab beside the phone's pane and preview", () => {
    const base = { mode: "workspace", sessionId: "owner-1", canvasOpen: true, canvasSlot: 1 };
    const both = cleanView({ ...base, workflowRowId: "wf-1", sidePaneTab: "workflow", mobilePane: "canvas",
        workflowTab: { ownerId: "owner-1", workflowId: "wf-1", definition: "watch-flow", view: "workflows" } });
    assert.deepEqual([both.workflowRowId, both.sidePaneTab, both.mobilePane, both.artifactFullscreen, both.workflowTab?.workflowId],
        ["wf-1", "workflow", "canvas", false, "wf-1"]);
    assert.notEqual(viewKey(both), viewKey(cleanView({ ...both, workflowRowId: "wf-2" })), "another Workflow, another stop");
    assert.notEqual(viewKey(both), viewKey(cleanView({ ...both, mobilePane: "inspector" })), "another phone pane, another stop");
    assert.equal(viewKey(both), viewKey(cleanView({ ...both, workflowTab: { ownerId: "owner-1", workflowId: null, definition: "report-flow", view: "definition" } })),
        "choosing in the Workflow tab is not a visit");
    const restored = createViewHistory(JSON.stringify({ version: 1, entries: [both], index: 0 }));
    assert.deepEqual(restored.current, both);
});
