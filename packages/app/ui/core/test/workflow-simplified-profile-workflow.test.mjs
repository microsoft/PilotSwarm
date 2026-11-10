/**
 * Workflow Simplified, review UI-8: a profile that saved a Workflow selected under its session (activeSessionId: the
 * Workflow's id) selects that session with the Workflow row on reload, as a click on the row does; a saved plain session
 * selects itself, as before.
 *
 * Run: node --test ui/core/test/workflow-simplified-profile-workflow.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState } from "../src/index.js";

const OWNER = "owner-1";
const SESSIONS = [
    { sessionId: OWNER, title: "Jokes", status: "idle", createdAt: 1, updatedAt: 1 },
    { sessionId: "wf-1", sessionKind: "workflow", title: "Workflow: dad-joke", status: "running", parentSessionId: OWNER, createdAt: 2, updatedAt: 2 },
    { sessionId: "other", title: "Other", status: "idle", createdAt: 3, updatedAt: 3 },
];
const loaded = () => appReducer(createInitialState({ mode: "api" }), { type: "sessions/loaded", sessions: SESSIONS });

test("a saved Workflow selection selects its session with the Workflow row", () => {
    const state = appReducer(loaded(), { type: "profileSettings/apply", settings: { activeSessionId: "wf-1" } });
    assert.equal(state.sessions.activeSessionId, OWNER);
    assert.equal(state.sessions.workflowRowId, "wf-1");
});

test("a saved plain session selects itself, with no Workflow row", () => {
    const state = appReducer(loaded(), { type: "profileSettings/apply", settings: { activeSessionId: "other" } });
    assert.equal(state.sessions.activeSessionId, "other");
    assert.equal(state.sessions.workflowRowId, null);
});
