/**
 * UX2R-F1 (UX replay r2, product): after a chat's Workflow finished, its Workflow tab opened on the Definition view ("No
 * run") with no word of the finished Workflow. The view now names the definition's newest Workflow and its state, one click
 * away (chatLatestWorkflow; the tab renders it as "Workflow #2 · Completed · View it").
 *
 * Run: node --test test/workflow-chat-latest.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chatDefinitionsModel, chatLatestWorkflow } from "../src/workflow-chat-definitions.js";

const item = workflows => ({ definitionId: "def-1", name: "watch", currentRevision: 1, revisions: [{ revision: 1, valid: true }], workflows });
const started = (id, runStatus, at) => ({ workflowSessionId: id, definitionId: "def-1", revision: 1, runStatus, createdAt: at });

test("the newest Workflow, by its number, in its state's one word from the list before its row is loaded", () => {
    const [definition] = chatDefinitionsModel([item([started("w1", "completed", "2026-11-07T10:00:00Z"), started("w2", "cancelled", "2026-11-07T11:00:00Z")])]);
    assert.deepEqual(chatLatestWorkflow(definition), { sessionId: "w2", number: 2, text: "Workflow #2 · Canceled" });
    const [one] = chatDefinitionsModel([item([started("w1", "completed", "2026-11-07T10:00:00Z")])]);
    assert.equal(chatLatestWorkflow(one).text, "Workflow #1 · Completed");
    const [stopped] = chatDefinitionsModel([item([started("w1", "stopped", "2026-11-07T10:00:00Z")])]);
    assert.equal(chatLatestWorkflow(stopped).text, "Workflow #1 · Canceled");
});

test("its state as its row says it, once loaded", () => {
    const [definition] = chatDefinitionsModel([item([started("w1", "running", "2026-11-07T10:00:00Z")])]);
    const byId = { w1: { sessionId: "w1", sessionKind: "workflow", status: "completed", parentSessionId: "chat", title: "Workflow: watch" } };
    assert.equal(chatLatestWorkflow(definition, byId, {}).text, "Workflow #1 · Completed");
});

test("none for a definition with no Workflow", () => {
    const [definition] = chatDefinitionsModel([item([])]);
    assert.equal(chatLatestWorkflow(definition), null);
    assert.equal(chatLatestWorkflow(null), null);
});
