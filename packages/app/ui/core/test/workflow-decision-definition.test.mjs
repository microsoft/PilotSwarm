// A Decision node's definition in the Node panels and the TUI (owner 2026-11-20: "Just like script and other nodes have
// icons, I want decision nodes to have icons as well. Also the node tab should display, like the script node, full info
// (maybe collapsed) on the decision prompts etc."). One model (workflowDecisionDefinition) for the Definition view's Node
// panel, a Workflow's Node panel and the TUI, in the same words; the question as the compiler's IR writes it
// (packages/sdk/src/workflow/compiler.ts, WorkflowIRDecisionQuestion).
// Run: node --test packages/app/ui/core/test/workflow-decision-definition.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WORKFLOW_DECISION_TYPE_LABELS, workflowDecisionDefinition, workflowDecisionTypeLabel } from "../src/workflow-decision.js";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowViewModal,
} from "../src/index.js";
import { projectWorkflow } from "../src/workflow-view.js";
import { NodeFacts } from "../../react/src/workflow-tab.js";
import { WorkflowNodeSummary } from "../../react/src/workflow-panels.js";
import { DecisionQuestionSection } from "../../react/src/workflow-code.js";
import { done, readModel } from "./workflow-fixtures.mjs";

const DEFAULT_MODEL = "shared-decision:ps-decision-1-1";
const CAPABILITY = { available: true, defaultModel: DEFAULT_MODEL, models: [DEFAULT_MODEL, "shared-decision:review-decision"], reason: null };
const UNAVAILABLE = { available: false, defaultModel: null, models: [], reason: "no_cluster_decision_default" };

const INSTRUCTIONS = "Which team should handle this ticket? Read the whole ticket, not only its title.\n"
    + "Route outages to engineering even when the customer mentions a refund.";
const CHOICE = {
    id: "route_ticket", type: "decision", description: null, hasInput: true, input: "${input}", inputSchema: null,
    question: {
        type: "choice",
        instructions: INSTRUCTIONS,
        criteria: { engineering: "Bugs and outages", billing: "Payments and refunds", support: "Account access" },
    },
    confidence: { minimumProbability: 0.8 },
    timeoutSeconds: 30,
    next: { engineering: "done", billing: "done", support: "done", uncertain: "done", failure: "done" },
};
const NOUL = {
    id: "is_urgent", type: "decision", input: "${input}",
    question: { type: "noul", instructions: "Does this ticket need a person within the hour?",
        criteria: { true: "A customer cannot work at all", false: "Anything that can wait for the next business day" } },
    confidence: { minimumProbability: 0.75 },
    timeoutSeconds: 45,
    next: { yes: "done", no: "done", uncertain: "done" },
};
const NOUL_PLAIN = {
    id: "is_spam", type: "decision", input: "${input}",
    question: { type: "noul", instructions: "Is this message spam?" },
    timeoutSeconds: 90,
    next: { yes: "done", no: "done" },
};
const SCORE = {
    id: "score_ticket", type: "decision", input: "${input}",
    question: { type: "score", instructions: "How severe is this incident?", criteria: ["Cosmetic", "Minor", "Major", "Critical"] },
    timeoutSeconds: 30,
    next: { scored: "done", failure: "done" },
};
const DONE = { id: "done", type: "terminal", outcome: "succeeded" };

const graphOf = state => ({ revision: 1, initial: state.id, states: [state, DONE] });
const definitionNode = state => projectWorkflow({ readModel: readModel({ graph: graphOf(state), noRun: true }) }).nodes.find(node => node.id === state.id);
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test("the question types in words: never the YAML's own names", () => {
    assert.deepEqual({ ...WORKFLOW_DECISION_TYPE_LABELS }, { choice: "Choice", noul: "Yes or no", score: "Score" });
    assert.equal(workflowDecisionTypeLabel("noul"), "Yes or no");
    assert.equal(workflowDecisionTypeLabel("toString"), null);
    assert.equal(workflowDecisionTypeLabel(undefined), null);
});

test("a choice: its whole instructions, each option with its description, the confidence threshold, the time limit and the model", () => {
    const shown = workflowDecisionDefinition(CHOICE, { capability: CAPABILITY });
    assert.equal(shown.type, "choice");
    assert.equal(shown.typeLabel, "Choice");
    assert.equal(shown.summary, "Decision question · Choice · 3 options");
    assert.equal(shown.instructions, INSTRUCTIONS, "the whole instructions, never only their first sentence");
    assert.equal(shown.criteria.heading, "Options");
    assert.deepEqual(shown.criteria.columns, ["Option", "Description"]);
    assert.deepEqual(shown.criteria.rows.map(row => [row.key, row.name, row.text, row.line]), [
        ["engineering", "engineering", "Bugs and outages", "engineering — Bugs and outages"],
        ["billing", "billing", "Payments and refunds", "billing — Payments and refunds"],
        ["support", "support", "Account access", "support — Account access"],
    ], "in the order written");
    assert.equal(shown.criteria.note, null);
    assert.deepEqual(shown.confidence, { threshold: 0.8, text: "Below 80% confidence → uncertain" });
    assert.deepEqual(shown.timeout, { seconds: 30, text: "30 s" });
    assert.deepEqual([shown.model.name, shown.model.source, shown.model.text], [DEFAULT_MODEL, "Cluster Decision Default",
        `${DEFAULT_MODEL} · Cluster Decision Default`]);
    // Without a threshold, it says so; one option reads in the singular.
    const plain = workflowDecisionDefinition({ ...CHOICE, confidence: undefined, question: { ...CHOICE.question, criteria: { only: "The one" } } });
    assert.deepEqual(plain.confidence, { threshold: null, text: "No confidence threshold" });
    assert.equal(plain.summary, "Decision question · Choice · 1 option");
    assert.equal(workflowDecisionDefinition({ ...CHOICE, confidence: { minimumProbability: 0.125 } }).confidence.text,
        "Below 12.5% confidence → uncertain");
});

test("a yes-or-no question: Yes and No with their descriptions, or a note when it has none", () => {
    const shown = workflowDecisionDefinition(NOUL, { capability: CAPABILITY });
    assert.equal(shown.typeLabel, "Yes or no");
    assert.equal(shown.summary, "Decision question · Yes or no");
    const words = [shown.typeLabel, shown.summary, shown.criteria.heading, ...shown.criteria.columns, ...shown.criteria.rows.map(row => row.line),
        shown.confidence.text, shown.timeout.text, shown.model.text];
    assert.doesNotMatch(words.join("\n"), /noul|true|false/i, "the wire names never reach the words");
    assert.equal(shown.criteria.heading, "Answers");
    assert.deepEqual(shown.criteria.rows.map(row => row.line), ["Yes — A customer cannot work at all",
        "No — Anything that can wait for the next business day"]);
    assert.deepEqual(shown.confidence, { threshold: 0.75, text: "Below 75% confidence → uncertain" });
    assert.deepEqual(shown.timeout, { seconds: 45, text: "45 s" });

    const plain = workflowDecisionDefinition(NOUL_PLAIN);
    assert.deepEqual(plain.criteria.rows, []);
    assert.equal(plain.criteria.note, "No descriptions of yes and no: the instructions alone decide.");
    assert.deepEqual(plain.confidence, { threshold: null, text: "No confidence threshold" });
    assert.equal(plain.timeout.text, "1 min 30 s");
});

test("a score: its levels in order with their place, 0 first, what the score means, and no confidence", () => {
    const shown = workflowDecisionDefinition(SCORE, { capability: CAPABILITY });
    assert.equal(shown.summary, "Decision question · Score · 4 levels");
    assert.equal(shown.criteria.heading, "Levels");
    assert.deepEqual(shown.criteria.columns, ["Score", "Level"]);
    assert.deepEqual(shown.criteria.rows.map(row => [row.index, row.name, row.text]),
        [[0, "0", "Cosmetic"], [1, "1", "Minor"], [2, "2", "Major"], [3, "3", "Critical"]]);
    assert.equal(shown.criteria.note, "The score is a number from 0 (Cosmetic) to 3 (Critical).");
    assert.equal(shown.confidence, null, "a score routes scored: no threshold applies");
    // The output's own levels ({ label, probability }) are not the question's criteria.
    assert.deepEqual(workflowDecisionDefinition({ ...SCORE, question: { type: "score", instructions: "x", levels: ["a", "b"] } }).criteria.rows, []);
});

test("the model: the run's own, else the Cluster Decision Default, else that none is eligible", () => {
    assert.deepEqual(workflowDecisionDefinition(CHOICE, { model: "shared-decision:review-decision", capability: CAPABILITY }).model,
        { name: "shared-decision:review-decision", source: "this run", text: "shared-decision:review-decision · this run",
            title: "The Decision model this run uses." });
    assert.equal(workflowDecisionDefinition(CHOICE, { model: { qualified: "shared-decision:review-decision" } }).model.source, "this run");
    const unavailable = workflowDecisionDefinition(CHOICE, { capability: UNAVAILABLE }).model;
    assert.equal(unavailable.name, null);
    assert.equal(unavailable.text, "No eligible Cluster Decision Default");
    assert.match(unavailable.title, /Admin Settings/);
    // A chat-shaped capability is not trusted (normalizeWorkflowDecisionCapability).
    assert.equal(workflowDecisionDefinition(CHOICE, { capability: { available: true, defaultModel: "chat:gpt-5", models: ["chat:gpt-5"] } }).model.name, null);
    assert.equal(workflowDecisionDefinition(CHOICE).model.text, "Cluster Decision Default");
});

test("odd shapes never throw and say what they can", () => {
    for (const node of [null, undefined, {}, { question: null }, { question: { type: "other" } }, { question: { type: "choice", criteria: [] } }]) {
        const shown = workflowDecisionDefinition(node);
        assert.equal(typeof shown.summary, "string");
        assert.ok(Array.isArray(shown.criteria.rows));
    }
    assert.equal(workflowDecisionDefinition({ question: { type: "other" } }).summary, "Decision question");
});

test("the Definition view's Node panel shows the whole question closed, as a script's, with its facts and its routes", () => {
    const node = definitionNode(CHOICE);
    const html = render(NodeFacts, { node, decision: CAPABILITY });
    // The first sentence stays as the node's one-line summary.
    assert.match(html, /<p class="ps-wf-what" data-node-what="true">Runs a Decision model: “Which team should handle this ticket\?”<\/p>/);
    // Its facts: the time limit, the confidence threshold and the model Start uses.
    assert.match(html, /<span>Limit<\/span><strong>30 s<\/strong>/);
    assert.match(html, /data-fact="decision-confidence-threshold"><span>Confidence threshold<\/span><strong>Below 80% confidence → uncertain<\/strong>/);
    assert.match(html, new RegExp(`data-fact="decision-model"><span>Model</span><strong>${DEFAULT_MODEL} · Cluster Decision Default</strong>`));
    // The question, in its own section, closed until opened.
    const section = /<details class="ps-wf-more" data-section="decision-question">(.*?)<\/details>/s.exec(html);
    assert.ok(section, html);
    assert.match(section[1], /^<summary>Decision question · Choice · 3 options<\/summary>/);
    assert.ok(!/<details[^>]* open=""/.test(html), "closed by default");
    assert.ok(section[1].includes(`<p class="ps-wf-decision-instructions">${INSTRUCTIONS}</p>`), "the whole instructions, as written");
    assert.match(section[1], /<div class="ps-wf-decision-part" data-field="decision-criteria" data-question-type="choice"><h4 class="ps-wf-decision-heading">Options<\/h4>/);
    assert.match(section[1], /<thead><tr><th scope="col">Option<\/th><th scope="col">Description<\/th><\/tr><\/thead>/);
    for (const [label, description] of Object.entries(CHOICE.question.criteria)) {
        assert.ok(section[1].includes(`<tr data-criterion="${label}"><th scope="row">${label}</th><td>${description}</td></tr>`), label);
    }
    // Its routes are as before.
    assert.match(html, /<li data-route="engineering">engineering → done<\/li>/);
    assert.match(html, /<li data-route="uncertain">uncertain → done<\/li>/);
    // No wire names in the words.
    assert.doesNotMatch(html.replace(/<[^>]*>/g, " "), /minimumProbability|noul|questionType|criteria|timeoutSeconds/);
});

test("the Definition view's Node panel for a yes-or-no question and a score, and before a Cluster Decision Default is set", () => {
    const noul = render(NodeFacts, { node: definitionNode(NOUL_PLAIN), decision: UNAVAILABLE });
    assert.match(noul, /<summary>Decision question · Yes or no<\/summary>/);
    assert.match(noul, /<h4 class="ps-wf-decision-heading">Answers<\/h4><p class="ps-wf-decision-note">No descriptions of yes and no: the instructions alone decide\.<\/p>/);
    assert.match(noul, /data-fact="decision-confidence-threshold"><span>Confidence threshold<\/span><strong>No confidence threshold<\/strong>/);
    assert.match(noul, /data-fact="decision-model"[^>]*><span>Model<\/span><strong>No eligible Cluster Decision Default<\/strong>/);
    const described = render(NodeFacts, { node: definitionNode(NOUL), decision: CAPABILITY });
    assert.match(described, /<tr data-criterion="yes"><th scope="row">Yes<\/th><td>A customer cannot work at all<\/td><\/tr>/);
    assert.match(described, /<tr data-criterion="no"><th scope="row">No<\/th><td>Anything that can wait for the next business day<\/td><\/tr>/);

    const score = render(NodeFacts, { node: definitionNode(SCORE), decision: CAPABILITY });
    assert.match(score, /<summary>Decision question · Score · 4 levels<\/summary>/);
    assert.match(score, /<thead><tr><th scope="col">Score<\/th><th scope="col">Level<\/th><\/tr><\/thead><tbody><tr data-criterion="0"><th scope="row">0<\/th><td>Cosmetic<\/td><\/tr>/);
    assert.match(score, /<tr data-criterion="3"><th scope="row">3<\/th><td>Critical<\/td><\/tr>/);
    assert.match(score, /The score is a number from 0 \(Cosmetic\) to 3 \(Critical\)\./);
    assert.doesNotMatch(score, /Confidence threshold/, "a score has no threshold");
    // Other nodes are as before.
    const script = render(NodeFacts, { node: definitionNode({ id: "check", type: "script", runtime: "node", outcomes: ["ok"], next: { ok: "done" } }) });
    assert.doesNotMatch(script, /decision-question|Confidence threshold|data-fact="decision-model"/);
});

test("a Workflow's Node panel shows the same question, closed, beside its result", () => {
    const output = {
        questionType: "choice", outcome: "engineering", selection: "engineering", confidence: 0.9,
        probabilities: { engineering: 0.9, billing: 0.05, support: 0.05 }, policy: { minimumProbability: 0.8, uncertain: false },
        model: { qualified: DEFAULT_MODEL },
    };
    const read = readModel({ graph: graphOf(CHOICE), nodeExecutions: [done(CHOICE.id, 1, "engineering", { outputPreview: JSON.stringify(output) })],
        run: { agentModels: { [CHOICE.id]: { model: DEFAULT_MODEL } } } });
    const selected = projectWorkflow({ readModel: read }).nodes.find(node => node.id === CHOICE.id);
    const html = render(WorkflowNodeSummary, { selected, nodes: [selected], select() {}, runId: read.run.runId });
    assert.match(html, /<details class="ps-wf-more" data-section="decision-question"><summary>Decision question · Choice · 3 options<\/summary>/);
    assert.ok(html.includes(`<p class="ps-wf-decision-instructions">${INSTRUCTIONS}</p>`));
    assert.match(html, /<tr data-criterion="billing"><th scope="row">billing<\/th><td>Payments and refunds<\/td><\/tr>/);
    assert.ok(!/<details[^>]* open=""/.test(html), "closed by default");
    // The result is still said before it, and the routes after it.
    assert.ok(html.indexOf('data-fact="result"') < html.indexOf('data-section="decision-question"'));
    assert.ok(html.indexOf('data-section="decision-question"') < html.indexOf('aria-label="Next"'));
    // A section of its own: the same component, from the node or from its definition.
    assert.equal(render(DecisionQuestionSection, { node: selected }), render(DecisionQuestionSection, { definition: workflowDecisionDefinition(selected) }));
    assert.equal(render(DecisionQuestionSection, {}), "");
});

async function tuiLines(states, { run = true, capability = CAPABILITY } = {}) {
    const stateId = states[0].id;
    const shown = run
        ? readModel({ graph: { revision: 1, initial: stateId, states }, nodeExecutions: [],
            run: { agentModels: { [stateId]: { model: "shared-decision:review-decision" } } } })
        : readModel({ graph: { revision: 1, initial: stateId, states }, noRun: true });
    const transport = { getSessionEventsBefore: async () => [], readWorkflow: async () => shown };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "ui/workflowDecision", decision: capability });
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "owner", title: "Triage session", status: "idle", model: "shared-chat:gpt-chat" },
        { sessionId: "wf", title: "Workflow: triage", status: "running", sessionKind: "workflow", parentSessionId: "owner" },
    ] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: shown, readModelRunId: null } });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    store.dispatch({ type: "ui/modal", modal: { ...store.getState().ui.modal, selectedNodeId: stateId, detailsScroll: 0 } });
    return selectWorkflowViewModal(store.getState(), 120).detailsLines.map(line => line.text);
}

test("the TUI says the same question in the same words, as plain lines", async () => {
    const lines = await tuiLines([CHOICE, DONE], { run: false });
    const at = lines.indexOf("Decision question · Choice · 3 options");
    assert.ok(at >= 0, lines.join("\n"));
    assert.deepEqual(lines.slice(at, at + 11), [
        "Decision question · Choice · 3 options",
        "Instructions:",
        "  Which team should handle this ticket? Read the whole ticket, not only its title.",
        "  Route outages to engineering even when the customer mentions a refund.",
        "Options:",
        "  engineering — Bugs and outages",
        "  billing — Payments and refunds",
        "  support — Account access",
        "Confidence threshold: Below 80% confidence → uncertain",
        "Limit: 30 s",
        `Model: ${DEFAULT_MODEL} · Cluster Decision Default`,
    ]);

    const score = await tuiLines([SCORE, DONE], { run: false });
    const from = score.indexOf("Decision question · Score · 4 levels");
    assert.ok(from >= 0, score.join("\n"));
    assert.deepEqual(score.slice(from + 1, from + 9), ["Instructions:", "  How severe is this incident?", "Levels:",
        "  0 — Cosmetic", "  1 — Minor", "  2 — Major", "  3 — Critical", "  The score is a number from 0 (Cosmetic) to 3 (Critical)."]);
    assert.ok(!score.some(line => line.startsWith("Confidence threshold:")));

    const noul = await tuiLines([NOUL_PLAIN, DONE], { run: false, capability: UNAVAILABLE });
    assert.ok(noul.includes("Decision question · Yes or no"), noul.join("\n"));
    assert.ok(noul.includes("  No descriptions of yes and no: the instructions alone decide."));
    assert.ok(noul.includes("Model: No eligible Cluster Decision Default"));
    assert.ok(!noul.some(line => /noul/i.test(line)));

    // In a run, the run's own model line (the Decision summary's) is the only one.
    const inRun = await tuiLines([CHOICE, DONE]);
    assert.ok(inRun.includes("Decision question · Choice · 3 options"), inRun.join("\n"));
    assert.deepEqual(inRun.filter(line => line.startsWith("Model:")), ["Model: shared-decision:review-decision"]);
});
