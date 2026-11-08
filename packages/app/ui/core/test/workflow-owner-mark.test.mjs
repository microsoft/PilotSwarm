/**
 * OF-S2-5 (owner, 2026-11-07T20:58Z: "The subagent sessions did grow workflows but the icon doesn't show it. Need to
 * workflow icon next to the session title if the session has grown a workflow."): a session, a sub-agent too, that has
 * grown Workflows wears the Workflow mark beside its title, in its list row at every depth and in the chat's title, with
 * the words "Has Workflows" (Workflows are always on, so no switch hides it). It grows them by the server's row flag (it owns a live
 * Workflow Definition), by its definitions read here, or by its Workflow children. The mark is gray and after the title,
 * where a Workflow row's own mark is magenta and before it.
 *
 * Run: node --test test/workflow-owner-mark.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState, selectChatPaneChrome, selectSessionRows, sessionGrowsWorkflows, WORKFLOW_OWNER_MARK_TITLE } from "../src/index.js";

const ROOT = { sessionId: "root-1", title: "Planner", status: "idle", createdAt: 1, updatedAt: 10, parentSessionId: null };
const sub = (sessionId, extra = {}) => ({ sessionId, title: `Helper ${sessionId}`, status: "idle", createdAt: 2, updatedAt: 9, parentSessionId: "root-1", ...extra });
const WORKFLOW = { sessionId: "wf-1", title: "Workflow: poll", sessionKind: "workflow", status: "running", createdAt: 3, updatedAt: 8, parentSessionId: "sub-children" };

function loaded({ sessions = [], definitions = null } = {}) {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [ROOT, ...sessions] });
    // The sub-agent rows show (a parent's children start collapsed).
    for (const id of ["root-1", "sub-children"]) state = appReducer(state, { type: "sessions/expand", sessionId: id });
    if (definitions) state = appReducer(state, { type: "ui/chatDefinitions", ownerId: definitions.ownerId, patch: { items: definitions.items, at: 1 } });
    return state;
}

const markOf = runs => (runs || []).filter(run => run?.role === "workflowOwner");
const rowOf = (state, sessionId) => selectSessionRows(state).find(row => row?.sessionId === sessionId);

const CASES = {
    flag: sub("sub-flag", { hasWorkflowDefinitions: true }),
    children: sub("sub-children"),
    neither: sub("sub-neither", { hasWorkflowDefinitions: false }),
    loadedOnly: sub("sub-loaded", { hasWorkflowDefinitions: false }),
    deletedOnly: sub("sub-deleted"),
};

const everything = () => loaded({ sessions: [...Object.values(CASES), WORKFLOW],
    definitions: { ownerId: "sub-loaded", items: [{ definitionId: "d1", name: "watch", deletedAt: null }] } });

test("sessionGrowsWorkflows: the row flag, a live definition read here, or a Workflow child, with no opt-in", () => {
    const state = everything();
    assert.equal(sessionGrowsWorkflows(state, "sub-flag"), true);
    assert.equal(sessionGrowsWorkflows(state, "sub-children"), true);
    assert.equal(sessionGrowsWorkflows(state, "sub-loaded"), true);
    assert.equal(sessionGrowsWorkflows(state, "sub-neither"), false);
    assert.equal(sessionGrowsWorkflows(state, "root-1"), false);
    assert.equal(sessionGrowsWorkflows(state, "wf-1"), false, "a Workflow has not grown one");
    assert.equal(sessionGrowsWorkflows(state, "missing"), false);
    const deleted = loaded({ sessions: [CASES.deletedOnly], definitions: { ownerId: "sub-deleted", items: [{ definitionId: "d2", name: "old", deletedAt: "2026-11-07T20:00:00Z" }] } });
    assert.equal(sessionGrowsWorkflows(deleted, "sub-deleted"), false, "a deleted definition does not count");
});

test("list rows: a sub-agent with definitions or with Workflow children wears the mark after its title; neither, none", () => {
    const state = everything();
    for (const id of ["sub-flag", "sub-children", "sub-loaded"]) {
        const row = rowOf(state, id);
        assert.ok(row, id);
        assert.equal(row.depth, 1, `${id} is a sub-agent row`);
        const mark = markOf(row.titleRuns);
        assert.equal(mark.length, 1, id);
        assert.deepEqual({ text: mark[0].text, color: mark[0].color, title: mark[0].title }, { text: " ◇", color: "gray", title: WORKFLOW_OWNER_MARK_TITLE });
        assert.equal(WORKFLOW_OWNER_MARK_TITLE, "Has Workflows");
        const titleAt = row.titleRuns.findIndex(run => run.text === `Helper ${id}`);
        assert.ok(titleAt >= 0 && row.titleRuns.indexOf(mark[0]) === titleAt + 1, `${id}: right after the title`);
    }
    assert.equal(markOf(rowOf(state, "sub-neither").titleRuns).length, 0);
    assert.equal(markOf(rowOf(state, "root-1").titleRuns).length, 0);
});

test("list rows: a Workflow row keeps its own magenta mark before its title and has no owner mark", () => {
    const row = rowOf(everything(), "wf-1");
    assert.ok(row);
    assert.equal(markOf(row.titleRuns).length, 0);
    const kind = row.titleRuns.find(run => run.role === "sessionKind");
    assert.equal(kind?.color, "magenta");
});

test("chat title: the sub-agent's chat says it has grown Workflows; neither does not", () => {
    for (const id of ["sub-flag", "sub-children", "sub-loaded"]) {
        const chrome = selectChatPaneChrome({ ...everything(), sessions: { ...everything().sessions, activeSessionId: id } });
        const mark = markOf(chrome.title);
        assert.equal(mark.length, 1, id);
        assert.equal(mark[0].title, "Has Workflows");
    }
    const neither = everything();
    assert.equal(markOf(selectChatPaneChrome({ ...neither, sessions: { ...neither.sessions, activeSessionId: "sub-neither" } }).title).length, 0);
});

test("the row flag is kept when a later list says false: a definition deleted since reads false, not the old true", () => {
    let state = loaded({ sessions: [CASES.flag] });
    assert.equal(sessionGrowsWorkflows(state, "sub-flag"), true);
    state = appReducer(state, { type: "sessions/loaded", sessions: [ROOT, { ...CASES.flag, hasWorkflowDefinitions: false, updatedAt: 11 }] });
    assert.equal(sessionGrowsWorkflows(state, "sub-flag"), false);
});

// OF-S2-5-F1: an untitled row's title is its id; the mark follows it at once, before the row's age and model, so the portal
// can keep it on screen right after the title while the rest gives way.
test("an untitled row's mark follows its id, before its age and model", () => {
    const untitled = { sessionId: "sub-untitled-0001", title: null, status: "idle", createdAt: 2, updatedAt: Date.now() - 60_000,
        parentSessionId: "root-1", model: "test:test-model", hasWorkflowDefinitions: true };
    const row = rowOf(loaded({ sessions: [untitled] }), "sub-untitled-0001");
    assert.ok(row);
    const at = row.titleRuns.findIndex(run => run.role === "workflowOwner");
    assert.ok(at > 0, JSON.stringify(row.titleRuns));
    assert.match(row.titleRuns[at - 1].text, /^sub-unti|^[0-9a-f-]{8}/, "the run before the mark is the id");
    assert.ok(row.titleRuns.slice(at + 1).some(run => run.text === " · "), "the age and model follow the mark");
});
