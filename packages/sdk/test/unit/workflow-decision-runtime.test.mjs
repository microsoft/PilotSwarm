/**
 * RED contract for the Workflow decision node's effect execution (design docs/proposals/workflow-decision-node.md v11:
 * "Existing path reused", "Retry and indoubt recovery", "Test mode"). Pure: the effect orchestration is driven with a
 * fake orchestration context, and the test-mode fixture functions are called directly.
 *
 * Pinned choices (see the RED report):
 * - The controller starts workflow-effect 1.1.0 for a Decision with `nodeType: "decision"`; that handler runs
 *   WORKFLOW_ACTIVITIES.runDecision, then records with the unchanged recordEffectResult and wake. The frozen 1.0.0
 *   script handler ignores extra nodeType fields and always runs runScript, preserving every old script schedule.
 * - No retry policy: a provider failure is not retried inside the orchestration either.
 * - Test mode: `decision` is a test operation whose fixture or parent answer is the raw Microsoft-shaped provider body.
 *   testResultFor runs the same parser and applyDecisionPolicy; a malformed body decides the state invalid_output (the
 *   live outcome of an invalid provider shape), so a test can exercise that route. The interception's arguments carry the
 *   effective qualified model, which the semantic output names.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { workflowEffect, workflowDecisionEffect, WORKFLOW_ACTIVITIES } from "../../dist/workflow/runtime.js";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../dist/activity-routing.js";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
import { canonicalJson } from "../../dist/workflow/json.js";
import { matchTestFixture, parseTestFixtures, storedTestFixtures, testResultFor } from "../../dist/workflow/test-mode.js";
import { WORKFLOW_TEST_OPERATIONS, workflowTestInterceptionId } from "../../dist/workflow/store.js";
import { applyDecisionPolicy } from "../../dist/decision-provider.js";

const QUALIFIED = "azure-foundry:ps-decision-1-1";
const EFFECT = { runId: "run-1", nodeExecutionId: "nx-1", controllerInstanceId: "session-wf-1" };

// ─── Effect orchestration ───────────────────────────────────────────

const ctx = {
    scheduleActivityTyped: (name, input) => ({ kind: "activity", name, input, withTag(tag) { return { ...this, tag }; } }),
    scheduleActivityWithRetryTyped: (name, input, policy) => ({ kind: "retry", name, input, policy }),
    scheduleTimer: ms => ({ kind: "timer", ms }),
};

/** Drive an effect handler: `answer(task)` returns { value } or { error }; every task it yielded, in order. */
function drive(effect, input, answer) {
    const gen = effect(ctx, input);
    const tasks = [];
    let step = gen.next();
    while (!step.done) {
        tasks.push(step.value);
        const reply = answer(step.value);
        step = "error" in reply ? gen.throw(reply.error) : gen.next(reply.value);
    }
    return { tasks, result: step.value };
}

const shape = tasks => tasks.map(task => (task.kind === "timer" ? ["timer", task.ms] : [task.kind, task.name]));

const DECIDED = {
    kind: "result",
    result: { outcome: "billing", resultKind: "business", winner: "effect", valueText: canonicalJson({ questionType: "choice", outcome: "billing" }) },
};

test("the effect runs runDecision for a decision state and stores its result through the unchanged record and wake", () => {
    assert.equal(WORKFLOW_ACTIVITIES.runDecision, "workflow.runDecision");
    const decision = { ...EFFECT, nodeType: "decision" };
    const ran = drive(workflowDecisionEffect, decision, task => ({ value: task.name === WORKFLOW_ACTIVITIES.runDecision ? DECIDED : null }));
    assert.equal(ran.result, null);
    assert.deepEqual(shape(ran.tasks), [
        ["activity", WORKFLOW_ACTIVITIES.runDecision],
        ["activity", WORKFLOW_ACTIVITIES.recordEffectResult],
        ["activity", WORKFLOW_ACTIVITIES.wake],
    ]);
    assert.ok(ran.tasks.every(task => task.kind === "activity" && task.tag === WORKFLOW_REQUEST_CAPABILITY), "every activity is tagged, none has a retry policy");
    assert.deepEqual(ran.tasks[0].input, decision);
    const recorded = ran.tasks[1].input;
    assert.deepEqual([recorded.runId, recorded.nodeExecutionId, recorded.controllerInstanceId], [EFFECT.runId, EFFECT.nodeExecutionId, EFFECT.controllerInstanceId]);
    assert.deepEqual(recorded.outcome, DECIDED, "the activity's result is what recordEffectResult stores with completeNode");
});

test("a failed runDecision activity is recorded once as execution_failed; it is not scheduled again and no script runs", () => {
    const decision = { ...EFFECT, nodeType: "decision" };
    const ran = drive(workflowDecisionEffect, decision, task => (task.name === WORKFLOW_ACTIVITIES.runDecision
        ? { error: new Error("the worker lost the Decision activity") } : { value: null }));
    assert.deepEqual(shape(ran.tasks), [
        ["activity", WORKFLOW_ACTIVITIES.runDecision],
        ["activity", WORKFLOW_ACTIVITIES.recordEffectResult],
        ["activity", WORKFLOW_ACTIVITIES.wake],
    ]);
    assert.ok(ran.tasks.every(task => task.name !== WORKFLOW_ACTIVITIES.runScript));
    const outcome = ran.tasks[1].input.outcome;
    assert.equal(outcome.kind, "result");
    assert.equal(outcome.result.outcome, "execution_failed");
    assert.equal(outcome.result.resultKind, "runtime_error");
});

test("the frozen 1.0.0 effect stays script-only for old and extra nodeType inputs", () => {
    const ran = { kind: "result", result: { outcome: "ok", resultKind: "business", valueText: "{}", winner: "effect" } };
    for (const input of [EFFECT, { ...EFFECT, nodeType: "script" }, { ...EFFECT, nodeType: "decision" }]) {
        const driven = drive(workflowEffect, input, task => ({ value: task.name === WORKFLOW_ACTIVITIES.runScript ? ran : null }));
        assert.deepEqual(shape(driven.tasks), [
            ["activity", WORKFLOW_ACTIVITIES.runScript],
            ["activity", WORKFLOW_ACTIVITIES.recordEffectResult],
            ["activity", WORKFLOW_ACTIVITIES.wake],
        ], JSON.stringify(input));
        assert.deepEqual(driven.tasks[0].input, EFFECT);
        assert.deepEqual(driven.tasks[1].input.outcome, ran);
    }
});

// ─── Test mode: decision fixtures ───────────────────────────────────

const CHOICE_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: decision-fixture, version: "1.0.0" }
initialInput: { ticket: "Please refund invoice 42" }
initial: route
states:
  route:
    type: decision
    input: "\${input}"
    question:
      type: choice
      instructions: Which team should handle this ticket?
      criteria:
        engineering: Bugs, outages, integrations, and application failures
        billing: Charges, invoices, refunds, and payments
        support: Sign-in, account access, and how-to questions
    confidence: { minimumProbability: 0.8 }
    transition:
      next: { engineering: done, billing: done, support: done, uncertain: done, failure: failed }
  grade:
    type: decision
    input: "\${input}"
    question:
      type: score
      instructions: How complete is the answer?
      criteria: [poor, fair, good, excellent]
    transition: { next: { scored: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: blocked, output: "\${runtime.error}" }
`;

/** A synthetic systemone fixture shaped like the documented Microsoft-Decision protocol; no live response was captured. */
const rawChoice = (choice, probabilities) => ({
    answers: { decision: { type: "choice", choice, probabilities } },
    usage: { input_tokens: 412, output_tokens: 6 },
});
const RAW_BILLING = rawChoice("billing", { engineering: 0.03, billing: 0.93, support: 0.04 });
const RAW_SCORE = {
    answers: { decision: { type: "score", score: 2.4, probabilities: { 0: 0.05, 1: 0.15, 2: 0.4, 3: 0.4 }, legend: ["poor", "fair", "good", "excellent"] } },
    usage: { input_tokens: 300, output_tokens: 4 },
};

function compiled() {
    const result = compileWorkflow(CHOICE_YAML);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    return result;
}

const interception = (nodeExecutionId, question) => ({
    operation: "decision",
    interceptionId: workflowTestInterceptionId(nodeExecutionId, "decision"),
    arguments: { model: QUALIFIED, state: { ticket: "Please refund invoice 42" }, question },
});

test("decision is a test operation: its fixture names its state and carries the raw provider body", () => {
    const expected = ["tool.call", "decision", "agent", "send", "request", "approval"];
    assert.deepEqual([...WORKFLOW_TEST_OPERATIONS], expected, JSON.stringify(WORKFLOW_TEST_OPERATIONS));
    assert.equal(workflowTestInterceptionId("nx-1", "decision"), "nx-1/decision");
    const fixtures = parseTestFixtures([{ operation: "decision", state: "route", response: { kind: "success", value: RAW_BILLING } }]);
    assert.deepEqual(fixtures, [{ operation: "decision", tool: null, state: "route", argumentsSha256: null, response: { kind: "success", value: RAW_BILLING } }]);
    assert.deepEqual(storedTestFixtures(JSON.parse(JSON.stringify(fixtures))), fixtures);
    assert.deepEqual(matchTestFixture(fixtures, { operation: "decision", tool: null, state: "route", argumentsSha256: "a".repeat(64), visit: 1 }), fixtures[0]);
    assert.equal(matchTestFixture(fixtures, { operation: "agent", tool: null, state: "route", argumentsSha256: null, visit: 1 }), null);
    for (const kind of ["error", "cancel"]) {
        const response = kind === "error" ? { kind, value: { code: "unavailable", message: "The provider is throttling requests." } } : { kind };
        assert.equal(parseTestFixtures([{ operation: "decision", state: "route", response }]).length, 1, kind);
    }
});

test("a decision's test response runs the same parser and confidence policy as a live answer (semantic output only)", () => {
    const { ir, irSha256 } = compiled();
    const node = ir.nodes.route;
    const expected = applyDecisionPolicy({
        question: node.question, confidence: node.confidence, model: QUALIFIED,
        answer: { questionType: "choice", selection: "billing", probabilities: { engineering: 0.03, billing: 0.93, support: 0.04 } },
    });
    assert.deepEqual(testResultFor(interception("nx-1", node.question), node, ir, irSha256, { kind: "success", value: RAW_BILLING }),
        { outcome: "billing", resultKind: "business", winner: "test", valueText: canonicalJson(expected) });
    // Below the threshold the policy routes uncertain; the provider's selection is still the selection.
    const unsure = testResultFor(interception("nx-1", node.question), node, ir, irSha256,
        { kind: "success", value: rawChoice("billing", { engineering: 0.2, billing: 0.62, support: 0.18 }) });
    assert.equal(unsure.outcome, "uncertain");
    assert.deepEqual(JSON.parse(unsure.valueText), applyDecisionPolicy({
        question: node.question, confidence: node.confidence, model: QUALIFIED,
        answer: { questionType: "choice", selection: "billing", probabilities: { engineering: 0.2, billing: 0.62, support: 0.18 } },
    }));
    // Score: the provider's score and ordered levels, unchanged; it routes scored.
    const grade = ir.nodes.grade;
    const scored = testResultFor(interception("nx-2", grade.question), grade, ir, irSha256, { kind: "success", value: RAW_SCORE });
    assert.deepEqual(scored, {
        outcome: "scored", resultKind: "business", winner: "test",
        valueText: canonicalJson(applyDecisionPolicy({ question: grade.question, model: QUALIFIED, answer: { questionType: "score", score: 2.4,
            levels: [{ label: "poor", probability: 0.05 }, { label: "fair", probability: 0.15 }, { label: "good", probability: 0.4 }, { label: "excellent", probability: 0.4 }] } })),
    });
    for (const text of [canonicalJson(expected), scored.valueText]) {
        assert.ok(!/usage|input_tokens|tokens|requestId|status/i.test(text), `no transport evidence or usage in the node output: ${text}`);
    }
});

test("a malformed raw body decides invalid_output; error and cancel answers decide as other operations' do", () => {
    const { ir, irSha256 } = compiled();
    const node = ir.nodes.route;
    const decide = response => testResultFor(interception("nx-1", node.question), node, ir, irSha256, response);
    for (const raw of [
        rawChoice("legal", { engineering: 0.3, billing: 0.3, support: 0.4 }),
        rawChoice("billing", { engineering: 0.03, billing: 0.93 }),
        { answers: { decision: { type: "noul", noul: 0.9, probabilities: { true: 0.9, false: 0.1 } } } },
        "billing",
    ]) {
        const result = decide({ kind: "success", value: raw });
        assert.equal(result.outcome, "invalid_output", JSON.stringify(raw));
        assert.equal(result.resultKind, "runtime_error");
        assert.equal(result.winner, "test");
        assert.equal(JSON.parse(result.valueText).code, "invalid_output");
    }
    for (const code of ["unavailable", "timed_out"]) {
        const [fixture] = parseTestFixtures([{ operation: "decision", state: node.id,
            response: { kind: "error", value: { code, message: "Simulated Decision error." } } }]);
        const failed = decide(fixture.response);
        assert.deepEqual([failed.outcome, failed.resultKind, failed.winner], [code, "runtime_error", "test"]);
    }
    assert.throws(() => decide({ kind: "error", value: { code: "not_a_runtime_code", message: "Wrong code." } }),
        { code: "TEST_RESPONSE_INVALID", message: /^An error response to decision needs code: one of / });
    const cancelled = decide({ kind: "cancel", value: null });
    assert.deepEqual([cancelled.outcome, cancelled.resultKind, cancelled.winner], ["cancelled", "runtime_error", "test"]);
});
