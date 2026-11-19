// Decision node Portal/TUI UI contract. These tests run against the mounted shared Workflow views, not a parallel canvas.
// Run: node --test packages/app/ui/core/test/workflow-decision-ui.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
    normalizeWorkflowDecisionCapability,
    workflowDecisionOutputSummary,
    workflowDecisionOverrideMap,
    workflowDecisionSummary,
    workflowDecisionUnavailableText,
} from "../src/workflow-decision.js";
import { PilotSwarmUiController, UI_COMMANDS } from "../src/controller.js";
import { buildHistoryModel } from "../src/history.js";
import { workflowRunCommandArgs, workflowRunCommandWire } from "../src/workflow-commands.js";
import { appReducer } from "../src/reducer.js";
import { selectAdminConsole, selectWorkflowViewModal } from "../src/selectors.js";
import { createInitialState } from "../src/state.js";
import { createStore } from "../src/store.js";
import { workflowExecutionOfRow, projectWorkflow } from "../src/workflow-view.js";
import { workflowStartModels } from "../src/workflow-words.js";
import { WorkflowNodeContent, WorkflowNodeSummary } from "../../react/src/workflow-panels.js";
import { AdminModelProvidersSection } from "../../react/src/web-app.js";
import { StartDialog } from "../../react/src/workflow-tab.js";
import { done, readModel } from "./workflow-fixtures.mjs";

const DECISION_STATES = [
    {
        id: "route_ticket",
        type: "decision",
        input: "${input}",
        question: {
            type: "choice",
            instructions: "Which team should handle this ticket?",
            criteria: {
                engineering: "Bugs and outages",
                billing: "Payments and refunds",
                support: "Account access",
            },
        },
        confidence: { minimumProbability: 0.8 },
        next: { engineering: "done", billing: "done", support: "done", uncertain: "done", failure: "done" },
    },
    { id: "done", type: "terminal", outcome: "succeeded" },
];

const CAPABILITY = {
    available: true,
    defaultModel: "shared-decision:ps-decision-1-1",
    models: ["shared-decision:ps-decision-1-1", "shared-decision:review-decision"],
    reason: null,
};

const CHOICE_OUTPUT = {
    questionType: "choice",
    outcome: "uncertain",
    selection: "engineering",
    confidence: 0.75,
    probabilities: { engineering: 0.75, billing: 0.125, support: 0.125 },
    policy: { minimumProbability: 0.8, uncertain: true },
    model: { qualified: "shared-decision:ps-decision-1-1" },
};

function decisionRead({ output = CHOICE_OUTPUT, execution = {}, run = {} } = {}) {
    const row = done("route_ticket", 1, output === null ? "unavailable" : output.outcome, {
        attempts: 1,
        outputPreview: output === null ? undefined : JSON.stringify(output),
        ...(output === null ? { resultKind: "runtime_error", errorPreview: JSON.stringify({
            code: "unavailable", message: "The Decision provider is unavailable. Try again later.",
        }) } : {}),
        ...execution,
    });
    return readModel({
        graph: { revision: 1, initial: "route_ticket", states: DECISION_STATES },
        nodeExecutions: [row],
        run: { agentModels: { route_ticket: { model: CAPABILITY.defaultModel } }, ...run },
    });
}

function loadedAdminState() {
    let state = createInitialState({ mode: "web" });
    state = appReducer(state, {
        type: "admin/profile/loaded",
        profile: { provider: "entra", subject: "admin-1", email: "admin@example.com", displayName: "Admin", isAdmin: true },
    });
    return appReducer(state, {
        type: "admin/modelProviders/loaded",
        providers: [
            { name: "shared-chat", typeId: "openai", class: "shared", usableByMe: true },
            { name: "shared-decision", typeId: "foundry-wif", class: "shared", usableByMe: true },
        ],
        models: [
            { providerId: "shared-chat", name: "gpt-chat", qualifiedName: "shared-chat:gpt-chat" },
        ],
        decisionModels: [
            { providerId: "shared-decision", providerType: "foundry-wif", name: "ps-decision-1-1",
                qualifiedName: "shared-decision:ps-decision-1-1", description: "Workflow decisions" },
        ],
        defaults: {
            userSession: { configured: null, effective: null },
            clusterSession: { configured: null, effective: null },
            clusterDecision: { configured: { provider: null, model: null, reasoning: null, context: null }, effective: null, error: null },
            system: { configured: null, effective: null },
            systemOverrides: [],
        },
    });
}

test("Decision capability is fail-closed and actionable without chat fallback", () => {
    assert.deepEqual(normalizeWorkflowDecisionCapability(CAPABILITY), CAPABILITY);
    const unset = normalizeWorkflowDecisionCapability({ available: false, defaultModel: null, models: [], reason: "no_cluster_decision_default" });
    assert.equal(unset.available, false);
    assert.match(workflowDecisionUnavailableText(unset, { admin: true }), /Configure an eligible Cluster Decision Default in Admin Settings/);
    assert.deepEqual(unset.models, []);

    const malformed = normalizeWorkflowDecisionCapability({ available: true, defaultModel: "chat:gpt-5", models: ["chat:gpt-5"] });
    assert.equal(malformed.available, false, "a chat-shaped tuple without the server's eligible Decision catalog must not authorize authoring");
});

test("the controller carries the runtime workflows.decision advertisement as the authoring gate", async () => {
    const transport = { getWorkflowCapabilities: async () => ({ workflows: { decision: CAPABILITY } }) };
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const controller = new PilotSwarmUiController({ store, transport });
    await controller.readWorkflowTestMode();
    assert.deepEqual(store.getState().ui.workflowDecision, CAPABILITY);
});

test("Decision Start models use only the eligible catalog and preserve explicit overrides", () => {
    const entries = workflowStartModels(DECISION_STATES, { decision: CAPABILITY, sessionModel: { model: "shared-chat:gpt-chat" } });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "route_ticket");
    assert.equal(entries[0].kind, "decision");
    assert.equal(entries[0].model, CAPABILITY.defaultModel);
    assert.deepEqual(entries[0].choices, CAPABILITY.models);
    assert.doesNotMatch(entries[0].text, /gpt-chat|from the session/);

    const override = workflowDecisionOverrideMap(entries, { route_ticket: "shared-decision:review-decision" });
    assert.deepEqual(override, { route_ticket: { model: "shared-decision:review-decision" } });
    assert.deepEqual(workflowDecisionOverrideMap(entries, { route_ticket: "shared-chat:gpt-chat" }), {});

    const unavailable = workflowStartModels(DECISION_STATES, {
        decision: { available: false, defaultModel: null, models: [], reason: "no_cluster_decision_default" },
        sessionModel: { model: "shared-chat:gpt-chat" },
    });
    assert.equal(unavailable[0].available, false);
    assert.deepEqual(unavailable[0].choices, []);
    assert.match(unavailable[0].reason, /Cluster Decision Default/);
});

test("Decision overrides survive the checked Start command wire and no chat value is accepted by this UI map", () => {
    const binding = { route_ticket: { model: "shared-decision:review-decision" } };
    const checked = workflowRunCommandArgs("start", {
        definitionHash: "definition-hash", inputs: {}, agentModels: binding,
    });
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.args.agentModels, binding);
    assert.deepEqual(workflowRunCommandWire("start", null, "operation-1", checked.args), {
        operation: "start", operation_id: "operation-1", definition_hash: "definition-hash", inputs: {},
        agent_models: binding,
    });
    assert.equal(workflowRunCommandArgs("start", {
        definitionHash: "definition-hash", inputs: {}, agentModels: { route_ticket: { model: "" } },
    }).ok, false);
});

test("the mounted Start dialog gates unavailable authoring and renders only eligible Decision overrides", () => {
    const base = {
        controller: {}, sessionId: "definition-1", name: "triage", number: 1,
        publication: { inputsSchema: null, revision: 1, publishedRevision: 1, state: "published", valid: true },
        control: { operation: "start", enabled: true }, startWith: async () => ({ ok: true }),
        onClose() {}, onStarted() {},
    };
    const available = workflowStartModels(DECISION_STATES, { decision: CAPABILITY });
    const availableHtml = renderToStaticMarkup(React.createElement(StartDialog, { ...base, decision: CAPABILITY, models: available }));
    assert.match(availableHtml, /aria-label="Decision model for route_ticket"/);
    assert.match(availableHtml, /shared-decision:ps-decision-1-1/);
    assert.match(availableHtml, /shared-decision:review-decision/);
    assert.doesNotMatch(availableHtml, /shared-chat:gpt-chat/);

    const unavailableCapability = { available: false, defaultModel: null, models: [], reason: "cluster_decision_default_ineligible" };
    const unavailableHtml = renderToStaticMarkup(React.createElement(StartDialog, {
        ...base,
        decision: unavailableCapability,
        models: workflowStartModels(DECISION_STATES, { decision: unavailableCapability }),
    }));
    assert.match(unavailableHtml, /data-field="decision-availability"/);
    assert.match(unavailableHtml, /choose another eligible Cluster Decision Default in Admin Settings/i);
    assert.doesNotMatch(unavailableHtml, /aria-label="Decision model for route_ticket"/);
    assert.match(unavailableHtml, /data-action="start-revision"[^>]*disabled=""|data-operation="start"[^>]*disabled=""/);
});

test("choice, noul and score outputs reduce to semantic-only summaries", () => {
    const choice = workflowDecisionOutputSummary(CHOICE_OUTPUT);
    assert.deepEqual(choice, {
        questionType: "choice",
        outcome: "uncertain",
        selection: "engineering",
        confidence: 0.75,
        probabilities: [
            { label: "engineering", probability: 0.75 },
            { label: "billing", probability: 0.125 },
            { label: "support", probability: 0.125 },
        ],
        threshold: 0.8,
        uncertain: true,
        model: CAPABILITY.defaultModel,
        score: null,
        levels: [],
    });
    assert.match(workflowDecisionSummary({ type: "decision", question: { type: "choice" }, confidence: { minimumProbability: 0.8 } },
        { status: "completed", resultKind: "business", outputPreview: JSON.stringify(CHOICE_OUTPUT) }).text,
    /Uncertain.*engineering.*75%.*engineering 75%/);

    const noul = workflowDecisionOutputSummary({
        questionType: "noul", outcome: "no", selection: "no", confidence: 0.75,
        probabilities: { yes: 0.25, no: 0.75 }, policy: { minimumProbability: 0.75, uncertain: false },
        model: { qualified: CAPABILITY.defaultModel },
    });
    assert.equal(noul.selection, "no");
    assert.equal(noul.uncertain, false);

    const score = workflowDecisionOutputSummary({
        questionType: "score", outcome: "scored", score: 3.5,
        levels: [{ level: "1", probability: 0.25 }, { level: "2", probability: 0.75 }],
        policy: { minimumProbability: null, uncertain: false }, model: { qualified: CAPABILITY.defaultModel },
    });
    assert.equal(score.score, 3.5);
    assert.deepEqual(score.levels, [{ label: "1", probability: 0.25 }, { label: "2", probability: 0.75 }]);

    const polluted = workflowDecisionOutputSummary({
        ...CHOICE_OUTPUT, attemptId: "attempt-secret", requestId: "request-secret", providerPayload: { raw: "provider-secret" },
        latencyMs: 999, usage: { total: 100 },
    });
    assert.equal(JSON.stringify(polluted).includes("secret"), false);
    assert.equal("attemptId" in polluted, false);
});

test("Portal node summary and Output view show the semantic result, including uncertain and failure, without transport fields", () => {
    const projection = projectWorkflow({ readModel: decisionRead({ output: {
        ...CHOICE_OUTPUT, attemptId: "attempt-secret", requestId: "request-secret",
        providerPayload: { raw: "provider-secret" }, latencyMs: 999, usage: { total: 100 },
    } }) });
    const selected = projection.nodes.find(node => node.id === "route_ticket");
    const summaryHtml = renderToStaticMarkup(React.createElement(WorkflowNodeSummary, {
        selected, nodes: projection.nodes, select() {}, runId: projection.runId,
    }));
    for (const text of ["Decision", "shared-decision:ps-decision-1-1", "Uncertain", "engineering 75%", "80%"])
        assert.ok(summaryHtml.includes(text), text);
    assert.doesNotMatch(summaryHtml, /providerPayload|requestId|attemptId|latencyMs|usage|attempt-secret|request-secret|provider-secret/i);

    const detailsHtml = renderToStaticMarkup(React.createElement(WorkflowNodeContent, {
        tab: "details", selected, nodes: projection.nodes, select() {}, runId: projection.runId,
    }));
    assert.match(detailsHtml, /Type<\/span><strong>Decision/);
    assert.match(detailsHtml, /Decision outcome<\/span><strong>Uncertain/);
    assert.doesNotMatch(detailsHtml, /providerPayload|requestId|attemptId|latencyMs|usage|attempt-secret|request-secret|provider-secret/i);

    const outputHtml = renderToStaticMarkup(React.createElement(WorkflowNodeContent, {
        tab: "output", selected, nodes: projection.nodes, select() {}, runId: projection.runId,
    }));
    assert.match(outputHtml, /Uncertain.*engineering/);
    assert.doesNotMatch(outputHtml, /providerPayload|requestId|attemptId|latencyMs|usage|questionType/);

    const failedRead = decisionRead({ output: null, execution: {
        errorPreview: JSON.stringify({
            code: "unavailable", message: "The provider was unavailable.", requestId: "request-secret",
            providerPayload: { raw: "provider-secret" }, latencyMs: 123, usage: { tokens: 42 },
        }),
    } });
    const failed = projectWorkflow({ readModel: failedRead }).nodes.find(node => node.id === "route_ticket");
    const failureHtml = renderToStaticMarkup(React.createElement(WorkflowNodeSummary, {
        selected: failed, nodes: [failed], select() {}, runId: "run-1",
    }));
    assert.match(failureHtml, /Failure.*unavailable/i);
    assert.match(failureHtml, /The Decision provider is unavailable\. Try again later\./);
    assert.doesNotMatch(failureHtml, /request-secret|provider-secret|latencyMs|tokens|usage/i);
});

test("the mounted Portal summaries also show semantic yes/no and score results", () => {
    const cases = [
        [{
            questionType: "noul", outcome: "no", selection: "no", confidence: 0.75,
            probabilities: { yes: 0.25, no: 0.75 }, policy: { minimumProbability: 0.75, uncertain: false },
            model: { qualified: CAPABILITY.defaultModel },
        }, /no 75%/],
        [{
            questionType: "score", outcome: "scored", score: 3.5,
            levels: [{ level: "minor", probability: 0.25 }, { level: "major", probability: 0.75 }],
            policy: { minimumProbability: null, uncertain: false }, model: { qualified: CAPABILITY.defaultModel },
        }, /Score.*3.5.*major 75%/],
    ];
    for (const [output, expected] of cases) {
        const selected = projectWorkflow({ readModel: decisionRead({ output }) }).nodes.find(node => node.id === "route_ticket");
        const html = renderToStaticMarkup(React.createElement(WorkflowNodeSummary, { selected, nodes: [selected], select() {} }));
        assert.match(html, expected);
        assert.doesNotMatch(html, /questionType|providerPayload|latencyMs|usage/i);
    }
});

test("one Decision warning comes from normalized ledger evidence, never node output or an attempt identifier", () => {
    const evidence = workflowExecutionOfRow({
        nodeExecutionId: "node-1", stateId: "route_ticket", ordinal: 1, state: "completed",
        outcome: "engineering", resultKind: "business", outputPreview: JSON.stringify({ ...CHOICE_OUTPUT, attemptId: "output-attempt" }),
        inference: {
            operationId: "operation-secret", attempt: 2, tokensTotal: null, settledAt: "2026-11-19T00:00:00Z",
            providerName: "secret-provider", modelQualified: CAPABILITY.defaultModel,
        },
    });
    assert.deepEqual(evidence.decisionInference, { attempt: 2, usageKnown: false });
    const direct = workflowExecutionOfRow({
        nodeExecutionId: "node-2", stateId: "route_ticket", ordinal: 1, state: "completed",
        outcome: "engineering", resultKind: "business", attempts: 2, usageUnknown: true,
    });
    assert.deepEqual(direct.decisionInference, { attempt: 2, usageKnown: false });
    assert.equal(JSON.stringify(evidence).includes("operation-secret"), false);
    assert.equal(JSON.stringify(evidence).includes("secret-provider"), false);

    const read = decisionRead({ execution: { inference: {
        operationId: "operation-secret", attempt: 2, tokensTotal: null, settledAt: "2026-11-19T00:00:00Z",
    } } });
    const selected = projectWorkflow({ readModel: read }).nodes.find(node => node.id === "route_ticket");
    const html = renderToStaticMarkup(React.createElement(WorkflowNodeSummary, { selected, nodes: [selected], select() {} }));
    const warnings = html.match(/data-field="decision-warning"/g) ?? [];
    assert.equal(warnings.length, 1);
    assert.match(html, /second provider call/i);
    assert.match(html, /usage was not reported/i);
    assert.doesNotMatch(html, /operation-secret|attemptId|tokensTotal|2026-11-19T00:00:00Z/);
});

async function tuiDecisionLines() {
    const shown = decisionRead({ execution: {
        inference: { operationId: "operation-secret", attempt: 2, tokensTotal: null, settledAt: "2026-11-19T00:00:00Z" },
    } });
    const transport = { getSessionEventsBefore: async () => [], readWorkflow: async () => shown };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "owner", title: "Triage session", status: "idle", model: "shared-chat:gpt-chat" },
        { sessionId: "wf", title: "Workflow: triage", status: "running", sessionKind: "workflow", parentSessionId: "owner" },
    ] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: shown, readModelRunId: null } });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    store.dispatch({ type: "ui/modal", modal: { ...store.getState().ui.modal, selectedNodeId: "route_ticket", detailsScroll: 0 } });
    return selectWorkflowViewModal(store.getState(), 120).detailsLines.map(line => line.text).join("\n");
}

test("the TUI-adjacent mounted Workflow details use the same semantic Decision summary", async () => {
    const text = await tuiDecisionLines();
    for (const expected of ["Type: Decision", "Model: shared-decision:ps-decision-1-1", "Uncertain", "engineering 75%", "second provider call", "Usage was not reported"])
        assert.ok(text.includes(expected), expected + "\n" + text);
    assert.doesNotMatch(text, /operation-secret|attemptId|providerPayload|requestId|latencyMs|tokensTotal/);
});

test("Admin Decision choices come only from decisionModels and the clear action remains admin-only", () => {
    const state = appReducer(loadedAdminState(), { type: "admin/modelProviders/page", page: "shared" });
    const view = selectAdminConsole(state);
    const providers = view.modelProviders;
    assert.deepEqual(providers.decisionChoices.map(choice => choice.qualifiedName), ["shared-decision:ps-decision-1-1"]);
    assert.equal(JSON.stringify(providers.decisionChoices).includes("gpt-chat"), false);
    assert.equal(providers.sharedProviders.find(provider => provider.name === "shared-decision").usesWorkloadIdentity, true);

    const html = renderToStaticMarkup(React.createElement(AdminModelProvidersSection, {
        controller: {}, view, mobile: false,
        onAddPersonal() {}, onAddShared() {}, onUpdatePersonal() {},
    }));
    assert.match(html, /aria-label="Cluster Decision Default"/);
    const decisionSelect = html.slice(html.indexOf('aria-label="Cluster Decision Default"'), html.indexOf("</select>", html.indexOf('aria-label="Cluster Decision Default"')) + 9);
    assert.match(decisionSelect, /shared-decision · ps-decision-1-1/);
    assert.doesNotMatch(decisionSelect, /shared-chat · gpt-chat/);
    assert.match(html, /aria-label="Clear Cluster Decision Default"/);

    const personal = appReducer(state, { type: "admin/profile/loaded", profile: {
        provider: "entra", subject: "user-1", email: "user@example.com", displayName: "User", isAdmin: false,
    } });
    const personalView = selectAdminConsole(personal);
    assert.deepEqual(personalView.modelProviders.decisionChoices, []);
});

test("the Admin controller loads eligible Decision models and writes cluster_decision without chat defaults", async () => {
    const calls = [];
    const defaults = {
        userSession: { configured: null, effective: null },
        clusterSession: { configured: null, effective: null },
        clusterDecision: { configured: { provider: null, model: null, reasoning: null, context: null }, effective: null, error: null },
        system: { configured: null, effective: null }, systemOverrides: [],
    };
    const transport = {
        listProviders: async () => ({ providers: [
            { name: "shared-chat", typeId: "openai", class: "shared", usableByMe: true },
            { name: "shared-decision", typeId: "foundry-wif", class: "shared", usableByMe: true },
        ] }),
        listModels: async () => [{ providerId: "shared-chat", modelName: "gpt-chat", qualifiedName: "shared-chat:gpt-chat" }],
        listRuntimeDecisionModels: async () => [{
            providerId: "shared-decision", modelName: "ps-decision-1-1", qualifiedName: "shared-decision:ps-decision-1-1",
        }],
        getModelDefaults: async () => defaults,
        setModelDefault: async input => { calls.push(input); return input; },
    };
    const store = createStore(appReducer, loadedAdminState());
    const controller = new PilotSwarmUiController({ store, transport });
    await controller.refreshAdminModelProviders();
    const view = selectAdminConsole(store.getState()).modelProviders;
    assert.deepEqual(view.decisionChoices.map(choice => choice.qualifiedName), ["shared-decision:ps-decision-1-1"]);
    await controller.setAdminModelDefault("cluster_decision", view.decisionChoices[0]);
    assert.deepEqual(calls[0], {
        scope: "cluster_decision", provider: "shared-decision", model: "shared-decision:ps-decision-1-1",
        reasoningEffort: null, contextTier: null,
    });
});
