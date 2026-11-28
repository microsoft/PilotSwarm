// Decision node Portal/TUI UI contract. These tests run against the mounted shared Workflow views, not a parallel canvas.
// Run: node --test packages/app/ui/core/test/workflow-decision-ui.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
    normalizeWorkflowDecisionCapability,
    workflowDecisionLatencyText,
    workflowDecisionModel,
    workflowDecisionOutputSummary,
    workflowDecisionOverrideMap,
    reconcileWorkflowDecisionOverrideSelection,
    workflowDecisionSummary,
    workflowDecisionUnavailableText,
    workflowStartDecisionModels,
} from "../src/workflow-decision.js";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore,
    selectAdminConsole, selectWorkflowViewModal,
} from "../src/index.js";
import { workflowRunCommandArgs, workflowRunCommandWire } from "../src/workflow-commands.js";
import { workflowExecutionOfRow, projectWorkflow, workflowRouteKind } from "../src/workflow-view.js";
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

const SCORE_STATES = [
    {
        id: "score_ticket",
        type: "decision",
        input: "${input}",
        question: {
            type: "score",
            instructions: "How severe is this incident?",
            criteria: ["Cosmetic", "Minor", "Major", "Critical"],
        },
        next: { scored: "done", failure: "done" },
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

const SCORE_OUTPUT = {
    questionType: "score",
    outcome: "scored",
    score: 2.37,
    levels: [
        { label: "Cosmetic", probability: 0.01 },
        { label: "Minor", probability: 0.07 },
        { label: "Major", probability: 0.42 },
        { label: "Critical", probability: 0.5 },
    ],
    model: { qualified: "shared-decision:review-decision" },
};

function semanticSummaryFixture(output, truncated = false) {
    return {
        questionType: output.questionType,
        outcome: output.outcome,
        selection: output.selection ?? null,
        confidence: output.confidence ?? null,
        score: output.score ?? null,
        probabilities: Object.entries(output.probabilities ?? {}).map(([label, probability]) => ({ label, probability })),
        levels: output.levels ?? [],
        policy: output.policy ?? null,
        model: output.model.qualified,
        truncated,
    };
}

function decisionRead({ output = CHOICE_OUTPUT, execution = {}, run = {}, states = DECISION_STATES } = {}) {
    const stateId = states[0].id;
    const row = done(stateId, 1, output === null ? "unavailable" : output.outcome, {
        attempts: 1,
        outputPreview: output === null ? undefined : JSON.stringify(output),
        ...(output === null ? { resultKind: "runtime_error", errorPreview: JSON.stringify({
            code: "unavailable", message: "The Decision provider is unavailable. Try again later.",
        }) } : {}),
        ...execution,
    });
    return readModel({
        graph: { revision: 1, initial: stateId, states },
        nodeExecutions: [row],
        run: { agentModels: { [stateId]: { model: CAPABILITY.defaultModel } }, ...run },
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
    assert.equal(entries[0].text, `route_ticket: ${CAPABILITY.defaultModel} · Cluster Decision Default`);
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

test("a stale saved Decision model is shown and recoverable through the current eligible default", () => {
    const staleModel = "shared-decision:retired-decision";
    const [entry] = workflowStartModels(DECISION_STATES, {
        chosen: { route_ticket: { model: staleModel } },
        decision: CAPABILITY,
    });
    assert.equal(entry.available, true, "an eligible capability remains startable even when a saved override is stale");
    assert.equal(entry.model, staleModel);
    assert.equal(entry.selected, staleModel);
    assert.equal(entry.stale, true);
    assert.deepEqual(entry.choices, CAPABILITY.models);
    assert.match(entry.reason, /saved Decision model.*no longer eligible/i);

    const html = renderToStaticMarkup(React.createElement(StartDialog, {
        controller: {}, sessionId: "definition-1", name: "triage", number: 1,
        publication: { inputsSchema: null, revision: 2, publishedRevision: 2, state: "published", valid: true },
        control: { operation: "start", enabled: true }, startWith: async () => ({ ok: true }),
        onClose() {}, onStarted() {}, decision: CAPABILITY, models: [entry],
    }));
    assert.match(html, /data-field="decision-stale-model"/);
    assert.match(html, new RegExp(staleModel));
    assert.match(html, /aria-label="Decision model for route_ticket"/);
    assert.ok(html.includes(`Use Cluster Decision Default (${CAPABILITY.defaultModel})`));
    assert.doesNotMatch(html, /data-action="start-revision"[^>]*disabled=""/);
});

// Review of be5d3faf, bug 3: Run again sent only runAgainOf, so the server reused a pinned model that is no longer eligible
// and refused, while the dialog said the node would use the current default.
test("Run again sends the eligible Decision pins when a pinned model is no longer eligible, and nothing otherwise", () => {
    const states = [DECISION_STATES[0], { ...DECISION_STATES[0], id: "priority" }, DECISION_STATES[1]];
    const stale = "shared-decision:retired-decision";
    const kept = "shared-decision:review-decision";
    const sent = chosen => {
        const models = workflowStartModels(states, { chosen, decision: CAPABILITY });
        const selection = reconcileWorkflowDecisionOverrideSelection(models, null, { revision: 3 });
        return workflowStartDecisionModels(models, selection.values, { runAgain: true });
    };
    assert.deepEqual(sent({ route_ticket: { model: stale }, priority: { model: kept } }), { priority: { model: kept } });
    assert.deepEqual(sent({ route_ticket: { model: stale } }), {}, "an empty map: the stale node uses the default the dialog shows");
    assert.equal(sent({ route_ticket: { model: kept }, priority: { model: kept } }), null, "nothing stale: Run again keeps its pins");
    assert.equal(sent(null), null);

    const models = workflowStartModels(states, { decision: CAPABILITY });
    assert.equal(workflowStartDecisionModels(models, {}), null, "a Start with no override sends none");
    assert.deepEqual(workflowStartDecisionModels(models, { priority: kept }), { priority: { model: kept } });

    const [entry] = workflowStartModels(DECISION_STATES, { chosen: { route_ticket: { model: stale } }, decision: CAPABILITY });
    const html = renderToStaticMarkup(React.createElement(StartDialog, {
        controller: {}, sessionId: "definition-1", name: "triage", number: 2, source: { number: 1, inputs: {} },
        publication: { inputsSchema: null, inputsSchemaKnown: true, revision: 2, publishedRevision: 2, state: "published", valid: true },
        control: { operation: "start", enabled: true }, startWith: async () => ({ ok: true }),
        onClose() {}, onStarted() {}, decision: CAPABILITY, models: [entry],
    }));
    assert.ok(html.includes(`It will use the current Cluster Decision Default (${CAPABILITY.defaultModel}).`), html);
    assert.doesNotMatch(html, /unless you choose another eligible model/, "Run again has no model picker");
});

// Review of be5d3faf, minor 8: a Decision's runtime routes other than failure were drawn as business outcomes.
test("a Decision's runtime routes are error routes and its business routes stay outcomes", () => {
    const [choice] = DECISION_STATES;
    for (const label of ["failure", "timed_out", "unavailable", "invalid_output", "budget_exceeded"]) {
        assert.equal(workflowRouteKind(choice, label), "error", label);
    }
    for (const label of ["engineering", "billing", "support", "uncertain"]) assert.equal(workflowRouteKind(choice, label), "outcome", label);
    assert.equal(workflowRouteKind(SCORE_STATES[0], "scored"), "outcome");
    const noul = { id: "check", type: "decision", question: { type: "noul", criteria: { true: "yes", false: "no" } } };
    assert.equal(workflowRouteKind(noul, "yes"), "outcome");
    assert.equal(workflowRouteKind(noul, "timed_out"), "error");
    const named = { ...choice, question: { ...choice.question, criteria: { unavailable: "Not reachable", reachable: "Reachable" } } };
    assert.equal(workflowRouteKind(named, "unavailable"), "outcome", "an option named like a runtime code is the option");
});

test("Decision override state reconciles across rerenders, revision changes, catalog removal, and a new default", () => {
    const entries = workflowStartModels(DECISION_STATES, { decision: CAPABILITY });
    let selection = reconcileWorkflowDecisionOverrideSelection(entries, null, { revision: 1 });
    selection = {
        revision: 1,
        values: { ...selection.values, route_ticket: "shared-decision:review-decision" },
        stale: {},
    };

    const sameContext = reconcileWorkflowDecisionOverrideSelection(entries, selection, { revision: 1 });
    assert.equal(sameContext.values.route_ticket, "shared-decision:review-decision");

    const newDefault = "shared-decision:review-decision";
    const changedDefaultEntries = workflowStartModels(DECISION_STATES, { decision: {
        ...CAPABILITY, defaultModel: newDefault,
    } });
    const changedDefault = reconcileWorkflowDecisionOverrideSelection(changedDefaultEntries, {
        revision: 1, values: { route_ticket: "" }, stale: {},
    }, { revision: 1 });
    assert.equal(changedDefault.values.route_ticket, "");
    assert.equal(changedDefaultEntries[0].defaultModel, newDefault);

    const removedCatalogEntries = workflowStartModels(DECISION_STATES, { decision: {
        ...CAPABILITY, models: [CAPABILITY.defaultModel],
    } });
    const removedCatalog = reconcileWorkflowDecisionOverrideSelection(removedCatalogEntries, selection, { revision: 1 });
    assert.equal(removedCatalog.values.route_ticket, "");
    assert.equal(removedCatalog.stale.route_ticket, "shared-decision:review-decision");
    assert.deepEqual(workflowDecisionOverrideMap(removedCatalogEntries, removedCatalog.values), {});

    const nextRevision = reconcileWorkflowDecisionOverrideSelection(entries, selection, { revision: 2 });
    assert.equal(nextRevision.values.route_ticket, "");
    assert.deepEqual(nextRevision.stale, {});
});

test("mixed Agent and Decision Start models keep chat fallback only on Agent nodes", () => {
    const mixedStates = [
        { id: "summarize", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600,
            outcomes: ["ok"], next: { ok: "route_ticket" } },
        ...DECISION_STATES,
    ];
    const chosen = { summarize: { model: "shared-chat:gpt-chat", reasoningEffort: "low" },
        route_ticket: { model: CAPABILITY.defaultModel } };
    const entries = workflowStartModels(mixedStates, {
        chosen, decision: CAPABILITY, sessionModel: { model: "shared-chat:gpt-chat", reasoningEffort: "medium" },
    });
    assert.deepEqual(entries.map(entry => entry.kind), ["agent", "decision"]);
    assert.equal(entries[0].text, "summarize: shared-chat:gpt-chat · low reasoning · chosen at start");
    assert.equal(entries[1].text, `route_ticket: ${CAPABILITY.defaultModel} · pinned effective Decision model`);
    assert.doesNotMatch(entries[1].text, /gpt-chat|from the session|chat fallback/);

    const projection = projectWorkflow({ readModel: readModel({
        graph: { revision: 1, initial: "summarize", states: mixedStates }, run: { agentModels: chosen },
    }), sessionModel: { model: "shared-chat:gpt-chat" } });
    const agent = projection.nodes.find(node => node.id === "summarize");
    const decision = projection.nodes.find(node => node.id === "route_ticket");
    assert.match(agent.model.text, /shared-chat:gpt-chat.*chosen at start/);
    assert.equal(decision.model.text, `Model: ${CAPABILITY.defaultModel} · pinned effective Decision model`);
    assert.deepEqual(workflowDecisionModel({ model: CAPABILITY.defaultModel }), {
        source: "start", qualified: CAPABILITY.defaultModel, words: CAPABILITY.defaultModel,
        value: `${CAPABILITY.defaultModel} · pinned effective Decision model`,
        text: `Model: ${CAPABILITY.defaultModel} · pinned effective Decision model`, now: false,
    });
});

test("Decision overrides survive the checked Start command wire separately from Agent models", () => {
    const decisionModels = { route_ticket: { model: "shared-decision:review-decision" } };
    const agentModels = { ask: { model: "shared-chat:gpt-chat", reasoningEffort: "low" } };
    const checked = workflowRunCommandArgs("start", {
        definitionHash: "definition-hash", inputs: {}, agentModels, decisionModels,
    });
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.args.agentModels, agentModels);
    assert.deepEqual(checked.args.decisionModels, decisionModels);
    assert.deepEqual(workflowRunCommandWire("start", null, "operation-1", checked.args), {
        operation: "start", operation_id: "operation-1", definition_hash: "definition-hash", inputs: {},
        agent_models: agentModels, decision_models: decisionModels,
    });
    assert.equal(workflowRunCommandArgs("start", {
        definitionHash: "definition-hash", inputs: {}, decisionModels: { route_ticket: { model: "" } },
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
        truncated: false,
    });
    assert.match(workflowDecisionSummary({ type: "decision", question: { type: "choice" }, confidence: { minimumProbability: 0.8 } },
        { status: "completed", resultKind: "business", outputPreview: JSON.stringify(CHOICE_OUTPUT) }).text,
    /Uncertain.*engineering.*75%.*engineering 75%/);
    assert.equal(workflowDecisionOutputSummary({ ...CHOICE_OUTPUT, policy: undefined }), null,
        "choice still requires policy validation");

    const noulOutput = {
        questionType: "noul", outcome: "no", selection: "no", confidence: 0.75,
        probabilities: { yes: 0.25, no: 0.75 }, policy: { minimumProbability: 0.75, uncertain: false },
        model: { qualified: CAPABILITY.defaultModel },
    };
    const noul = workflowDecisionOutputSummary(noulOutput);
    assert.equal(noul.selection, "no");
    assert.equal(noul.uncertain, false);
    assert.equal(workflowDecisionOutputSummary({ ...noulOutput, policy: undefined }), null,
        "noul still requires policy validation");

    assert.equal(Object.hasOwn(SCORE_OUTPUT, "policy"), false, "the production score output carries no policy");
    const score = workflowDecisionOutputSummary(SCORE_OUTPUT);
    assert.deepEqual(score, {
        questionType: "score",
        outcome: "scored",
        selection: null,
        confidence: null,
        probabilities: [],
        threshold: null,
        uncertain: null,
        model: "shared-decision:review-decision",
        score: 2.37,
        levels: [
            { label: "Cosmetic", probability: 0.01 },
            { label: "Minor", probability: 0.07 },
            { label: "Major", probability: 0.42 },
            { label: "Critical", probability: 0.5 },
        ],
        truncated: false,
    });

    const polluted = workflowDecisionOutputSummary({
        ...SCORE_OUTPUT, attemptId: "score-attempt-secret", requestId: "score-request-secret",
        providerPayload: { raw: "score-provider-secret" }, latencyMs: 999, usage: { total: 100 },
    });
    assert.deepEqual(polluted, score, "transport fields never enter the score summary");
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

test("the Portal Decision result box and TUI show the supplied summary from the read model", async () => {
    const output = { questionType: "choice", outcome: "engineering", selection: "engineering", model: null };
    const text = "Supplied · engineering · Engineering confirmed.";
    const execution = {
        decisionSummary: { supplied: true, outcome: "engineering", text },
        supplied: { from: { executionId: "source-visit" }, note: "Engineering confirmed." },
    };
    const read = decisionRead({ output, execution });
    const projection = projectWorkflow({ readModel: read });
    const selected = projection.nodes.find(node => node.id === "route_ticket");
    const html = renderToStaticMarkup(React.createElement(WorkflowNodeContent, {
        tab: "output", selected, nodes: projection.nodes, select() {}, runId: read.run.runId, onReadWholeValue() {},
    }));
    assert.match(html, /Decision result/);
    assert.ok(html.includes(text));
    assert.doesNotMatch(html, /needs its whole value|Read the whole value/);
    const tui = await tuiDecisionLines({ output, execution });
    assert.ok(tui.includes(text));
    assert.doesNotMatch(tui, /Model:|Confidence:|second provider call/);
});

test("the mounted Portal summaries render the exact production score object and preserve provider level order", () => {
    const noul = {
        questionType: "noul", outcome: "no", selection: "no", confidence: 0.75,
        probabilities: { yes: 0.25, no: 0.75 }, policy: { minimumProbability: 0.75, uncertain: false },
        model: { qualified: CAPABILITY.defaultModel },
    };
    const yesNo = projectWorkflow({ readModel: decisionRead({ output: noul }) }).nodes.find(node => node.id === "route_ticket");
    assert.match(renderToStaticMarkup(React.createElement(WorkflowNodeSummary, { selected: yesNo, nodes: [yesNo], select() {} })), /no 75%/);

    const exact = projectWorkflow({ readModel: decisionRead({ output: SCORE_OUTPUT, states: SCORE_STATES }) })
        .nodes.find(node => node.id === "score_ticket");
    const exactHtml = renderToStaticMarkup(React.createElement(WorkflowNodeSummary, { selected: exact, nodes: [exact], select() {} }));
    assert.match(exactHtml, /shared-decision:review-decision/);
    assert.match(exactHtml, /data-fact="decision-score"[^>]*>.*?2\.37/);
    assert.match(exactHtml, /Cosmetic 1% · Minor 7% · Major 42% · Critical 50%/);

    const pollutedOutput = {
        ...SCORE_OUTPUT, attemptId: "score-attempt-secret", requestId: "score-request-secret",
        providerPayload: { raw: "score-provider-secret" }, latencyMs: 321, usage: { total: 77 },
    };
    const polluted = projectWorkflow({ readModel: decisionRead({ output: pollutedOutput, states: SCORE_STATES }) })
        .nodes.find(node => node.id === "score_ticket");
    const pollutedHtml = renderToStaticMarkup(React.createElement(WorkflowNodeSummary, { selected: polluted, nodes: [polluted], select() {} }));
    assert.doesNotMatch(pollutedHtml, /questionType|policy|attemptId|requestId|providerPayload|latencyMs|usage|score-(?:attempt|request|provider)-secret/i);
});

test("a completed Decision uses the server summary when its valid output preview is longer than 500 characters", async () => {
    const longLevel = `Cosmetic ${"x".repeat(620)}`;
    const output = { ...SCORE_OUTPUT, levels: [{ label: longLevel, probability: 0.42 }, ...SCORE_OUTPUT.levels.slice(1)] };
    const raw = JSON.stringify(output);
    const outputPreview = `${raw.slice(0, 500)}…`;
    const decisionSummary = semanticSummaryFixture(output);
    assert.ok(raw.length > 500);
    assert.ok(outputPreview.endsWith("…"));

    const read = decisionRead({ output, states: SCORE_STATES, execution: { outputPreview, decisionSummary } });
    const selected = projectWorkflow({ readModel: read }).nodes.find(node => node.id === "score_ticket");
    const summary = workflowDecisionSummary(selected, selected.current);
    assert.equal(summary.outcome, "scored");
    assert.equal(summary.score, 2.37);
    assert.equal(summary.levels[0].label, longLevel);

    const summaryHtml = renderToStaticMarkup(React.createElement(WorkflowNodeSummary, {
        selected, nodes: [selected], select() {}, runId: read.run.runId,
    }));
    assert.match(summaryHtml, /data-fact="now"[^>]*>.*?Done/);
    assert.match(summaryHtml, /data-fact="decision-score"[^>]*>.*?2\.37/);
    assert.match(summaryHtml, /data-fact="decision-levels"/);
    assert.ok(summaryHtml.includes(longLevel));
    assert.doesNotMatch(summaryHtml, /Not run|No Decision result yet/);

    const tui = await tuiDecisionLines({ output, states: SCORE_STATES, execution: { outputPreview, decisionSummary } });
    assert.ok(tui.includes("Status: Done"));
    assert.ok(tui.includes("Decision outcome: scored"));
    assert.ok(tui.includes("Score: 2.37"));
    assert.ok(tui.includes("Levels: Cosmetic"));
    assert.doesNotMatch(tui, /Not run|No Decision result yet/);
});

test("a truncated Decision summary stays completed and offers the whole-value recovery path", async () => {
    const output = { ...SCORE_OUTPUT, levels: [{ label: `Critical ${"z".repeat(12_000)}`, probability: 1 }] };
    const outputPreview = `${JSON.stringify(output).slice(0, 500)}…`;
    const fallback = workflowDecisionSummary({ type: "decision", question: { type: "score" } }, {
        status: "completed", resultKind: "business", outputPreview,
    });
    assert.equal(fallback.outcome, "Completed");
    assert.equal(fallback.needsWholeValue, true);
    assert.doesNotMatch(fallback.text, /Not run|No Decision result yet/);
    const decisionSummary = semanticSummaryFixture(output, true);
    decisionSummary.levels = [{ label: `${decisionSummary.levels[0].label.slice(0, 160)}…`, probability: 1 }];
    const read = decisionRead({ output, states: SCORE_STATES, execution: { outputPreview, decisionSummary } });
    const selected = projectWorkflow({ readModel: read }).nodes.find(node => node.id === "score_ticket");

    const nodeHtml = renderToStaticMarkup(React.createElement(WorkflowNodeSummary, {
        selected, nodes: [selected], select() {}, runId: read.run.runId, onReadWholeValue() {},
    }));
    assert.match(nodeHtml, /data-action="whole-value"/);
    assert.match(nodeHtml, /Scored · score 2\.37/);
    assert.doesNotMatch(nodeHtml, /Not run|No Decision result yet/);

    const outputHtml = renderToStaticMarkup(React.createElement(WorkflowNodeContent, {
        tab: "output", selected, nodes: [selected], select() {}, runId: read.run.runId, onReadWholeValue() {},
    }));
    assert.match(outputHtml, /This Decision summary was cut short/);
    assert.match(outputHtml, /data-action="whole-value"/);
    const tui = await tuiDecisionLines({ output, states: SCORE_STATES, execution: { outputPreview, decisionSummary } });
    assert.match(tui, /Decision summary cut short · f reads all/);
    assert.doesNotMatch(tui, /Not run|No Decision result yet/);
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
    assert.deepEqual(evidence.decisionInference, { attempt: 2, usageKnown: false, usageState: "not_reported" });
    const direct = workflowExecutionOfRow({
        nodeExecutionId: "node-2", stateId: "route_ticket", ordinal: 1, state: "completed",
        outcome: "engineering", resultKind: "business", attempts: 2, usageUnknown: true,
    });
    assert.deepEqual(direct.decisionInference, { attempt: 2, usageKnown: false, usageState: "not_reported" });
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

test("the latest attempt's recorded provider latency reaches the node details in words, and only from ledger evidence", () => {
    assert.equal(workflowDecisionLatencyText(379), "379 ms");
    assert.equal(workflowDecisionLatencyText(2_430), "2.4 s");
    assert.equal(workflowDecisionLatencyText(-1), null);
    const row = workflowExecutionOfRow({
        nodeExecutionId: "node-1", stateId: "route_ticket", ordinal: 1, state: "completed",
        outcome: "engineering", resultKind: "business", outputPreview: JSON.stringify(CHOICE_OUTPUT),
        decisionInference: [
            { nodeExecutionId: "node-1", attempt: 1, usageKnown: true, usageState: "known", latencyMs: 30_000 },
            { nodeExecutionId: "node-1", attempt: 2, usageKnown: true, usageState: "known", latencyMs: 412 },
        ],
    });
    assert.deepEqual(row.decisionInference, { attempt: 2, usageKnown: true, usageState: "known", latencyMs: 412 });
    assert.equal(workflowDecisionSummary({ type: "decision", question: { type: "choice" } }, row).latency, "412 ms");
    const fromOutputOnly = workflowDecisionSummary({ type: "decision", question: { type: "choice" } },
        { status: "completed", resultKind: "business", outputPreview: JSON.stringify({ ...CHOICE_OUTPUT, latencyMs: 999 }) });
    assert.equal("latency" in fromOutputOnly, false, "a latency in the node output is never shown");

    const read = decisionRead({ execution: { decisionInference: [{ attempt: 1, usageKnown: true, usageState: "known", latencyMs: 379 }] } });
    const selected = projectWorkflow({ readModel: read }).nodes.find(node => node.id === "route_ticket");
    const html = renderToStaticMarkup(React.createElement(WorkflowNodeSummary, { selected, nodes: [selected], select() {} }));
    assert.match(html, /data-fact="decision-latency"[^>]*>[\s\S]*?379 ms/);
});

test("a completed node with an unsettled claimed call exposes a distinct durable usage warning", async () => {
    const row = workflowExecutionOfRow({
        nodeExecutionId: "node-incomplete", stateId: "route_ticket", ordinal: 1, state: "completed",
        outcome: "engineering", resultKind: "business", outputPreview: JSON.stringify(CHOICE_OUTPUT),
        decisionInference: [{ nodeExecutionId: "node-incomplete", attempt: 2, usageKnown: null,
            usageState: "settlement_incomplete" }],
    });
    assert.deepEqual(row.decisionInference, { attempt: 2, usageKnown: null, usageState: "settlement_incomplete" });

    const read = decisionRead({ execution: { decisionInference: [{ nodeExecutionId: "node-incomplete", attempt: 2,
        usageKnown: null, usageState: "settlement_incomplete" }] } });
    const selected = projectWorkflow({ readModel: read }).nodes.find(node => node.id === "route_ticket");
    const html = renderToStaticMarkup(React.createElement(WorkflowNodeSummary, { selected, nodes: [selected], select() {} }));
    assert.match(html, /Usage settlement is incomplete/);
    assert.match(html, /may be missing from usage totals/);
    const tui = await tuiDecisionLines({ execution: { decisionInference: [{ nodeExecutionId: "node-incomplete",
        attempt: 2, usageKnown: null, usageState: "settlement_incomplete" }] } });
    assert.match(tui, /Usage settlement is incomplete/);
});

async function tuiDecisionLines({ output = CHOICE_OUTPUT, states = DECISION_STATES, execution = {} } = {}) {
    const shown = decisionRead({ output, states, execution: {
        inference: { operationId: "operation-secret", attempt: 2, tokensTotal: null, settledAt: "2026-11-19T00:00:00Z" },
        ...execution,
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
    store.dispatch({ type: "ui/modal", modal: { ...store.getState().ui.modal, selectedNodeId: states[0].id, detailsScroll: 0 } });
    return selectWorkflowViewModal(store.getState(), 120).detailsLines.map(line => line.text).join("\n");
}

test("the TUI-adjacent mounted Workflow details use the same semantic Decision summary", async () => {
    const text = await tuiDecisionLines();
    for (const expected of ["Type: Decision", "Model: shared-decision:ps-decision-1-1", "Uncertain", "engineering 75%", "second provider call", "Usage was not reported"])
        assert.ok(text.includes(expected), expected + "\n" + text);
    assert.doesNotMatch(text, /operation-secret|attemptId|providerPayload|requestId|latencyMs|tokensTotal/);
});

test("the TUI renders the exact production score object in provider level order without transport fields", async () => {
    const text = await tuiDecisionLines({
        output: {
            ...SCORE_OUTPUT, attemptId: "score-attempt-secret", requestId: "score-request-secret",
            providerPayload: { raw: "score-provider-secret" }, latencyMs: 321, usage: { total: 77 },
        },
        states: SCORE_STATES,
    });
    for (const expected of [
        "Model: shared-decision:review-decision", "Decision outcome: scored", "Score: 2.37",
        "Levels: Cosmetic 1% · Minor 7% · Major 42% · Critical 50%",
    ]) assert.ok(text.includes(expected), expected + "\n" + text);
    assert.doesNotMatch(text, /questionType|policy|attemptId|requestId|providerPayload|latencyMs|usage\s*:|score-(?:attempt|request|provider)-secret/i);
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

test("an optional Decision model-list failure does not discard the Admin chat catalog", async () => {
    const transport = {
        listProviders: async () => ({ providers: [
            { name: "shared-chat", typeId: "openai", class: "shared", usableByMe: true },
        ] }),
        listModels: async () => [{ providerId: "shared-chat", modelName: "gpt-chat", qualifiedName: "shared-chat:gpt-chat" }],
        listRuntimeDecisionModels: async () => { throw new Error("Decision model list unavailable"); },
        getModelDefaults: async () => loadedAdminState().admin.modelProviders.defaults,
    };
    const store = createStore(appReducer, loadedAdminState());
    const controller = new PilotSwarmUiController({ store, transport });
    const loaded = await controller.refreshAdminModelProviders();
    assert.equal(loaded?.providers.length, 1);
    assert.equal(loaded?.models[0].qualifiedName, "shared-chat:gpt-chat");
    assert.deepEqual(loaded?.decisionModels, []);
    assert.equal(store.getState().admin.modelProviders.loading, false);
    assert.equal(store.getState().admin.modelProviders.error, null);
});

// Review of be5d3faf, bug 4: a failed GET /model-defaults loaded the screen with no defaults and no error, so cycling a
// default with l or D started from an empty value and overwrote the real one.
test("a failed model-defaults read fails the Admin load, keeps the last defaults, and a cycle never starts from nothing", async () => {
    const calls = [];
    const transport = {
        listProviders: async () => ({ providers: [{ name: "shared-chat", typeId: "openai", class: "shared", usableByMe: true }] }),
        listModels: async () => [{ providerId: "shared-chat", modelName: "gpt-chat", qualifiedName: "shared-chat:gpt-chat" }],
        listRuntimeDecisionModels: async () => [],
        getModelDefaults: async () => { throw new Error("model defaults read failed"); },
        setModelDefault: async input => { calls.push(input); return input; },
    };
    const before = loadedAdminState();
    const store = createStore(appReducer, before);
    const controller = new PilotSwarmUiController({ store, transport });
    assert.equal(await controller.refreshAdminModelProviders(), null);
    const providers = store.getState().admin.modelProviders;
    assert.match(providers.error, /model defaults read failed/);
    assert.deepEqual(providers.defaults, before.admin.modelProviders.defaults, "the last defaults stay; nothing reads as automatic");

    // Never loaded: a cycle is refused before it writes.
    let empty = createInitialState({ mode: "web" });
    empty = appReducer(empty, { type: "admin/profile/loaded",
        profile: { provider: "entra", subject: "admin-1", email: "admin@example.com", displayName: "Admin", isAdmin: true } });
    const fresh = new PilotSwarmUiController({ store: createStore(appReducer, empty), transport });
    assert.equal(await fresh.refreshAdminModelProviders(), null);
    for (const scope of ["user", "cluster", "cluster_decision", "system"]) {
        const result = await fresh.cycleAdminModelDefault(scope);
        assert.equal(result.ok, false, scope);
        assert.match(result.error, /could not be read/);
    }
    assert.deepEqual(calls, [], "no default is written from an empty value");
});

// Review of be5d3faf, bug 1: after an admin change the page read the capability from its start-time bootstrap copy, so the
// Workflow tab kept Decision unavailable after a default was set (and available after it was cleared) until a reload.
test("an admin provider change reads Decision availability from the server again, both ways", async () => {
    const UNSET = { available: false, defaultModel: null, models: [], reason: "no_cluster_decision_default" };
    let served = { testMode: true, decision: UNSET };
    const transport = {
        getWorkflowCapabilities: async () => ({ testMode: true, decision: UNSET }),
        refreshWorkflowCapabilities: async () => served,
        setModelDefault: async input => {
            served = { testMode: true, decision: input.model ? CAPABILITY : UNSET };
            return input;
        },
    };
    const store = createStore(appReducer, loadedAdminState());
    const controller = new PilotSwarmUiController({ store, transport });
    controller.refreshAdminModelProviders = async () => null;
    await controller.readWorkflowTestMode();
    assert.equal(store.getState().ui.workflowDecision.available, false);

    await controller.setAdminModelDefault("cluster_decision", { provider: "shared-decision", qualifiedName: CAPABILITY.defaultModel });
    assert.deepEqual(store.getState().ui.workflowDecision, CAPABILITY, "set: Decision opens without a reload");

    await controller.setAdminModelDefault("cluster_decision", null);
    assert.deepEqual(store.getState().ui.workflowDecision, UNSET, "cleared: Decision closes without a reload");
    assert.equal(store.getState().ui.workflowTestMode, true);

    // A fresh read that fails closes Decision and keeps test mode as it was.
    served = CAPABILITY;
    transport.refreshWorkflowCapabilities = async () => { throw new Error("bootstrap unavailable"); };
    await controller.setAdminModelDefault("cluster_decision", { provider: "shared-decision", qualifiedName: CAPABILITY.defaultModel });
    assert.equal(store.getState().ui.workflowDecision.available, false);
    assert.equal(store.getState().ui.workflowTestMode, true);
});

test("admins can see and clear a stale configured Decision default even with no eligible Decision models", async () => {
    let state = loadedAdminState();
    state = appReducer(state, { type: "admin/modelProviders/page", page: "shared" });
    state = appReducer(state, {
        type: "admin/modelProviders/loaded",
        providers: [
            { name: "shared-chat", typeId: "openai", class: "shared", usableByMe: true },
            { name: "shared-decision", typeId: "foundry-wif", class: "shared", usableByMe: true },
        ],
        models: [
            { providerId: "shared-chat", name: "gpt-chat", qualifiedName: "shared-chat:gpt-chat" },
        ],
        decisionModels: [],
        defaults: {
            userSession: { configured: null, effective: null },
            clusterSession: { configured: null, effective: null },
            clusterDecision: {
                configured: { provider: "shared-decision", model: "shared-decision:retired-decision", reasoning: null, context: null },
                effective: null,
                error: "The configured Cluster Decision Default is no longer eligible.",
            },
            system: { configured: null, effective: null },
            systemOverrides: [],
        },
    });
    const view = selectAdminConsole(state);
    const clears = [];
    const html = renderToStaticMarkup(React.createElement(AdminModelProvidersSection, {
        controller: { setAdminModelDefault: (scope, choice) => { clears.push({ scope, choice }); } },
        view, mobile: false, onAddPersonal() {}, onAddShared() {}, onUpdatePersonal() {},
    }));
    assert.match(html, /aria-label="Cluster Decision Default"/);
    assert.match(html, /shared-decision:retired-decision/);
    assert.match(html, /currently configured/);
    assert.match(html, /aria-label="Clear Cluster Decision Default"/);
    assert.match(html, /no longer eligible/i);
    assert.ok(view.actions.some(action => action.id === "cycleDecisionDefault" && action.key === "D"));

    const calls = [];
    const store = createStore(appReducer, state);
    const controller = new PilotSwarmUiController({ store, transport: {
        setModelDefault: async input => { calls.push(input); return input; },
    } });
    controller.refreshAdminModelProviders = async () => null;
    controller.readWorkflowTestMode = async () => null;
    await controller.cycleAdminModelDefault("cluster_decision");
    assert.deepEqual(calls, [{ scope: "cluster_decision", provider: null, model: null,
        reasoningEffort: null, contextTier: null }]);
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
