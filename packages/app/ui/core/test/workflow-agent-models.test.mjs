// OF-S2-7 (owner 2026-11-07T21:32Z): per-node models, as people read them. An agent node uses the model its start chose
// for it ("chosen at start"), else the model of the chat that owns the Workflow ("from the chat"): the Node panel, the
// node's tooltip and the TUI's node details say which, with its reasoning effort and context tier; an agent node's Log
// says what each visit's chat used; the package picker says "your default" and shows the card's model hints.
// Review OF7-R8: what a visit ran on is its spawn's record (workflow.agent_spawned model); where only the chat's current
// model is known, it says "now".
//
// Run: node --test packages/app/ui/core/test/workflow-agent-models.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowViewModal,
} from "../src/index.js";
import { projectWorkflowV2 } from "../src/workflow-v2-view.js";
import { workflowNodeSummary } from "../src/workflow-node-summary.js";
import { workflowAgentNodeLog } from "../src/workflow-agent-log.js";
import { workflowAgentModel, workflowModelFromKey, workflowModelWords, workflowSessionModel, workflowSessionModelKey, workflowSpawnedModels,
    workflowStartModels } from "../src/workflow-words.js";
import { StartDialog } from "../../react/src/workflow-tab.js";
import { workflowPickerItems } from "../src/controller.js";
import { workflowPickerDetailsLines } from "../src/selectors.js";
import { WorkflowV2AgentLog, WorkflowV2NodeSummary } from "../../react/src/workflow-v2-panels.js";
import { WorkflowStepCard } from "../../react/src/workflow-graph.js";
import { done, readModel } from "./workflow-v2-fixtures.mjs";

process.env.TZ = "UTC";

const states = [
    { id: "classify", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["ok"], next: { ok: "review" } },
    { id: "review", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["ok"], next: { ok: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
];
const CHOSEN = { classify: { model: "anthropic:fast", reasoningEffort: "low", contextTier: "long_context" } };
const CHAT = { model: "azure:chat-model", reasoningEffort: "medium", contextTier: null };
const model = (run = {}) => readModel({ graph: { revision: 1, initial: "classify", states }, run });

test("the words: a model with its reasoning and context; chosen at start, else from the chat; a session row's model and its key", () => {
    assert.equal(workflowModelWords({ model: "a:b", reasoningEffort: "high", contextTier: "long_context" }), "a:b · high reasoning · long context");
    assert.equal(workflowModelWords({ model: "a:b", contextTier: "default" }), "a:b · default context");
    assert.equal(workflowModelWords({ model: " " }), null);
    assert.equal(workflowModelWords(null), null);
    assert.deepEqual(workflowAgentModel({ model: "a:b", reasoningEffort: "low" }, CHAT),
        { source: "start", words: "a:b · low reasoning", value: "a:b · low reasoning · chosen at start", text: "Model: a:b · low reasoning · chosen at start",
            now: false });
    // Only the chat's current model is known: it says so ("now"), never as what a visit used.
    assert.deepEqual(workflowAgentModel(null, CHAT), { source: "chat", words: "azure:chat-model · medium reasoning",
        value: "from the chat · now azure:chat-model · medium reasoning", text: "Model: from the chat · now azure:chat-model · medium reasoning", now: true });
    // A visit's record is the evidence, whatever the chat has now.
    assert.equal(workflowAgentModel(null, CHAT, { model: "azure:old-model", reasoningEffort: "high", contextTier: null, source: "chat" }).text,
        "Model: azure:old-model · high reasoning · from the chat");
    assert.equal(workflowAgentModel({ model: "a:b" }, CHAT, { model: "a:b", reasoningEffort: "low", contextTier: "default", source: "start" }).text,
        "Model: a:b · low reasoning · default context · chosen at start");
    // The chat not loaded: it still says where the model comes from.
    assert.equal(workflowAgentModel(null, null).text, "Model: from the chat");
    assert.deepEqual(workflowSessionModel({ model: "a:b", reasoningEffort: "high", contextTier: "long_context", title: "x" }),
        { model: "a:b", reasoningEffort: "high", contextTier: "long_context" });
    assert.equal(workflowSessionModel({ title: "no model" }), null);
    const byId = { chat: { model: "a:b", reasoningEffort: "high" } };
    assert.deepEqual(workflowModelFromKey(workflowSessionModelKey(byId, "chat")), { model: "a:b", reasoningEffort: "high", contextTier: null });
    assert.equal(workflowSessionModelKey(byId, "other"), "");
    assert.equal(workflowModelFromKey(""), null);
    assert.equal(workflowModelFromKey("not json"), null);
});

test("the Node panel and the node's tooltip: chosen at start for a node its run mapped, from the chat for the others", () => {
    const projection = projectWorkflowV2({ readModel: model({ agentModels: CHOSEN }), chatModel: CHAT });
    const classify = projection.nodes.find(node => node.id === "classify");
    const review = projection.nodes.find(node => node.id === "review");
    assert.equal(classify.model.text, "Model: anthropic:fast · low reasoning · long context · chosen at start");
    assert.equal(review.model.text, "Model: from the chat · now azure:chat-model · medium reasoning");
    assert.equal(projection.nodes.find(node => node.id === "done").model, undefined, "only agent nodes have a model");
    assert.equal(workflowNodeSummary(classify).agent.model, "anthropic:fast · low reasoning · long context · chosen at start");
    const panel = renderToStaticMarkup(React.createElement(WorkflowV2NodeSummary, { selected: classify, nodes: projection.nodes, select: () => {} }));
    assert.match(panel, /data-fact="model"[^>]*><span>Model<\/span><strong>anthropic:fast · low reasoning · long context · chosen at start<\/strong>/);
    const card = renderToStaticMarkup(React.createElement(WorkflowStepCard, { node: review, onSelect() {} }));
    assert.match(card, /title="review · Agent · [^"]* · Model: from the chat · now azure:chat-model · medium reasoning"/);
    // A run without a map, or the definition alone: every agent node uses its chat's.
    const plain = projectWorkflowV2({ readModel: model(), chatModel: CHAT });
    assert.equal(plain.nodes.find(node => node.id === "classify").model.source, "chat");
    const definitionOnly = projectWorkflowV2({ workflowModel: model({ agentModels: CHOSEN }), chatModel: CHAT });
    assert.equal(definitionOnly.nodes.find(node => node.id === "classify").model.source, "chat", "a run's choice shows only on its own run");
});

/** The TUI's node details of `nodeId` in a Workflow of chat "chat" (on azure:chat-model, medium), its run's choice CHOSEN. */
async function tuiDetails(nodeId) {
    const shown = model({ agentModels: CHOSEN });
    const transport = { getSessionEventsBefore: async () => [], readWorkflow: async () => shown };
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "chat", title: "Triage chat", status: "idle", model: "azure:chat-model", reasoningEffort: "medium" },
        { sessionId: "wf", title: "Workflow: triage", status: "running", sessionKind: "workflow", parentSessionId: "chat" },
    ] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: shown, readModelRunId: null } });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    store.dispatch({ type: "ui/modal", modal: { ...store.getState().ui.modal, selectedNodeId: nodeId, detailsScroll: 0 } });
    return selectWorkflowViewModal(store.getState(), 120).detailsLines.map(line => line.text);
}

test("the TUI's node details have a Model line, from the run's choice or the chat that owns the Workflow", async () => {
    const classify = await tuiDetails("classify");
    assert.ok(classify.includes("Model: anthropic:fast · low reasoning · long context · chosen at start"), classify.join("\n"));
    const review = await tuiDetails("review");
    assert.ok(review.some(line => line.startsWith("review · Agent")), review.join("\n"));
    assert.ok(review.includes("Model: from the chat · now azure:chat-model · medium reasoning"), review.join("\n"));
});

/** A continued chat's two visits: visit 1 ran on azure:model-a, then the chat was switched to anthropic:model-b. */
const SPAWNED = [1, 2].map(n => ({ eventType: "workflow.agent_spawned", data: { runId: "run-1", nodeExecutionId: `nx-classify-${n}`, stateId: "classify",
    childSessionId: "child-1", ...(n === 1 ? { model: { model: "azure:model-a", reasoningEffort: "high", contextTier: null, source: "chat" } } : {}) } }));
const VISITS = [1, 2].map(n => done("classify", n, "ok", { enteredAt: `2026-11-07T08:0${n}:00Z`, endedAt: `2026-11-07T08:0${n}:05Z`,
    agent: { childSessionId: "child-1", spawned: true } }));

test("review OF7-R8: an agent node's Log says what each visit ran on from its spawn's record; else the chat's model now", () => {
    const node = projectWorkflowV2({ readModel: model({ nodeExecutions: VISITS }) }).nodes.find(item => item.id === "classify");
    const log = workflowAgentNodeLog({ node, events: SPAWNED, chats: new Map([["child-1", []]]), runId: "run-1",
        chatModels: new Map([["child-1", { model: "anthropic:model-b", reasoningEffort: "low" }]]) });
    const byVisit = Object.fromEntries(log.groups.map(group => [group.ordinal, [group.model, group.modelNow]]));
    // Visit 1 recorded its model; visit 2 has no record (an older worker), so its line is the chat's model now.
    assert.deepEqual(byVisit, { 1: ["azure:model-a · high reasoning", false], 2: ["anthropic:model-b · low reasoning", true] });
    const html = renderToStaticMarkup(React.createElement(WorkflowV2AgentLog, { log, nodeId: "classify" }));
    assert.match(html, /<p class="ps-wf-muted ps-wf-alog-model" data-model="used">Model: azure:model-a · high reasoning<\/p>/);
    assert.match(html, /<p class="ps-wf-muted ps-wf-alog-model" data-model="now">Model now: anthropic:model-b · low reasoning<\/p>/);
    // Nothing known: no model line, never a guess.
    const unread = workflowAgentNodeLog({ node, chats: new Map([["child-1", []]]), runId: "run-1" });
    assert.deepEqual(unread.groups.map(group => group.model), [null, null]);
    assert.ok(!renderToStaticMarkup(React.createElement(WorkflowV2AgentLog, { log: unread, nodeId: "classify" })).includes("ps-wf-alog-model"));
    // Another run's record is not this run's.
    assert.equal(workflowSpawnedModels(SPAWNED, "run-2").size, 0);
    assert.equal(workflowSpawnedModels(SPAWNED, "run-1").get("nx-classify-1").model, "azure:model-a");
});

test("review OF7-R8: the Node panel shows what the shown visit ran on, from its spawn's record, not the chat's model now", () => {
    const rows = [VISITS[0]];
    const projection = projectWorkflowV2({ readModel: model({ nodeExecutions: rows }), events: [SPAWNED[0]], chatModel: { model: "anthropic:model-b" } });
    const classify = projection.nodes.find(node => node.id === "classify");
    assert.equal(classify.model.text, "Model: azure:model-a · high reasoning · from the chat");
    assert.equal(workflowNodeSummary(classify).agent.model, "azure:model-a · high reasoning · from the chat");
    // Without the record: the chat's model, said as now.
    const without = projectWorkflowV2({ readModel: model({ nodeExecutions: rows }), chatModel: { model: "anthropic:model-b" } });
    assert.equal(without.nodes.find(node => node.id === "classify").model.text, "Model: from the chat · now anthropic:model-b");
});

test("the package picker: Model: your default; its agent nodes use it unless the chat chooses one at start; the card's model hints", () => {
    const listed = { ref: "ops/triage", name: "triage", package: "ops", semver: "1.0.0", description: "Triages.", outcomes: { done: "Done." },
        checked: { scripts: [], agents: ["classify", "review"], words: "Checked from the definition: it runs no scripts; it has agent steps (classify, review): each one asks a model." },
        modelHints: { classify: "fast, low reasoning" } };
    const [item] = workflowPickerItems([listed]);
    assert.deepEqual(item.agentNodes, ["classify", "review"]);
    assert.deepEqual(item.modelHints, [{ id: "classify", text: "fast, low reasoning" }]);
    const text = workflowPickerDetailsLines(item).map(line => line.map(run => run.text).join(""));
    const at = text.indexOf("Model: your default");
    assert.ok(at >= 0, text.join("\n"));
    assert.deepEqual(text.slice(at, at + 3), ["Model: your default", "Its agent nodes use this model unless the chat chooses one for a node at start.",
        "Model hints: classify: fast, low reasoning"]);
    // No agent nodes and no hints: neither line.
    const [plain] = workflowPickerItems([{ ...listed, checked: { scripts: [], agents: [], words: "" }, modelHints: {} }]);
    const plainText = workflowPickerDetailsLines(plain).map(line => line.map(run => run.text).join(""));
    assert.ok(!plainText.some(line => line.startsWith("Its agent nodes") || line.startsWith("Model hints")), plainText.join("\n"));
});

test("the Start dialog shows what each agent node will use: the chat's model, or for Run again the choices its Workflow started with", () => {
    const graph = [...states, { id: "summarize", type: "agent", parallel: "fan" }, { id: "fan", type: "parallel" }];
    assert.deepEqual(workflowStartModels(graph, { chat: CHAT }).map(entry => entry.text), [
        "classify: from the chat · now azure:chat-model · medium reasoning", "review: from the chat · now azure:chat-model · medium reasoning",
        "summarize: from the chat · now azure:chat-model · medium reasoning"]);
    assert.deepEqual(workflowStartModels(graph, { chosen: CHOSEN, chat: null }).map(entry => entry.text), [
        "classify: anthropic:fast · low reasoning · long context · chosen at start", "review: from the chat", "summarize: from the chat"]);
    assert.deepEqual(workflowStartModels([{ id: "done", type: "terminal" }]), []);
    assert.deepEqual(workflowStartModels(null), []);
    const render = models => renderToStaticMarkup(React.createElement(StartDialog, { controller: {}, sessionId: "def-1", name: "triage", number: 2,
        publication: { inputsSchema: null, revision: 1, publishedRevision: 1, state: "published", valid: true }, control: { operation: "start", enabled: true },
        startWith: async () => ({ ok: true }), onClose: () => {}, onStarted: () => {}, models }));
    const html = render(workflowStartModels(states, { chosen: CHOSEN, chat: CHAT }));
    assert.match(html, /data-field="models"><span class="ps-wf-label">Models<\/span><ul class="ps-wf-models"><li>classify: anthropic:fast · low reasoning · long context · chosen at start<\/li><li>review: from the chat · now azure:chat-model · medium reasoning<\/li><\/ul>/);
    assert.ok(!render([]).includes('data-field="models"'), "no agent nodes: no Models field");
});

test("DEV at fed7e7ac: a run whose stored choices cannot be read says so for its agent nodes, never the chat's model", () => {
    assert.equal(workflowAgentModel(null, CHAT, null, { unreadable: true }).text, "Model: model choices cannot be read");
    // A visit's record still wins: it is what that visit ran on.
    assert.equal(workflowAgentModel(null, CHAT, { model: "azure:old", source: "chat" }, { unreadable: true }).text, "Model: azure:old · from the chat");
    const projection = projectWorkflowV2({ readModel: model({ agentModelsUnreadable: true }), chatModel: CHAT });
    assert.equal(projection.nodes.find(node => node.id === "classify").model.text, "Model: model choices cannot be read");
    assert.equal(projectWorkflowV2({ readModel: model(), chatModel: CHAT }).nodes.find(node => node.id === "classify").model.now, true);
});
