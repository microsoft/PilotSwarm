/**
 * RED contract for Workflow decision compilation. The compiler is deliberately provider-neutral: model binding happens at
 * Start time, while this file fixes the YAML and stored-IR contract only.
 *
 * Run from the repository root after npm run build --workspace=packages/sdk:
 * node --test packages/sdk/test/unit/workflow-decision-compile.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { stringify } from "yaml";
import { compileWorkflow, parseWorkflowIr, RUNTIME_ERROR_CODES } from "../../dist/workflow/compiler.js";

const CHOICE_NODE = {
    type: "decision",
    input: "${input}",
    question: {
        type: "choice",
        instructions: "Which team should handle this ticket?",
        criteria: {
            engineering: "Bugs, outages, integrations, and application failures",
            billing: "Charges, invoices, refunds, and payments",
            support: "Sign-in, account access, and how-to questions",
        },
    },
    confidence: { minimumProbability: 0.8 },
    timeoutSeconds: 30,
    transition: {
        next: {
            engineering: "done",
            billing: "done",
            support: "done",
            uncertain: "review",
            failure: "failed",
        },
    },
};

const workflow = (node) => stringify({
    apiVersion: "pilotswarm.dev/v1",
    kind: "Workflow",
    metadata: { name: "decision-compiler", version: "1.0.0" },
    initial: "decide",
    states: {
        decide: node,
        done: { type: "terminal", outcome: "succeeded" },
        review: { type: "terminal", outcome: "blocked" },
        failed: { type: "terminal", outcome: "failed" },
    },
});

const compile = node => compileWorkflow(workflow(node));
const clone = value => structuredClone(value);
const errors = result => result.diagnostics.filter(item => item.severity === "error");
const assertInvalid = (result, label, path) => {
    assert.equal(result.valid, false, `${label}: ${JSON.stringify(result.diagnostics)}`);
    if (path !== undefined) {
        assert.ok(errors(result).some(item => item.path === path
            || item.path.startsWith(`${path}.`) || item.path.startsWith(`${path}[`)),
            `${label}: ${JSON.stringify(errors(result).map(item => [item.code, item.path]))}`);
    }
};

const choiceWithoutConfidence = () => {
    const node = clone(CHOICE_NODE);
    delete node.confidence;
    delete node.transition.next.uncertain;
    return node;
};

const noulNode = () => ({
    type: "decision",
    input: "${input.proposedAction}",
    question: {
        type: "noul",
        instructions: "Does this action require production access?",
        criteria: {
            true: "Reads or changes production data or configuration",
            false: "Uses no production data or configuration",
        },
    },
    confidence: { minimumProbability: 0.9 },
    timeoutSeconds: 30,
    transition: { next: { yes: "done", no: "done", uncertain: "review", failure: "failed" } },
});

const scoreNode = () => ({
    type: "decision",
    input: "${input}",
    question: {
        type: "score",
        instructions: "How severe is this incident?",
        criteria: ["Cosmetic", "Minor", "Major", "Critical"],
    },
    timeoutSeconds: 30,
    transition: { next: { scored: "done", failure: "failed" } },
});

test("choice compiles to the exact WorkflowIRDecision shape and round-trips stored IR", () => {
    const compiled = compile(CHOICE_NODE);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.deepEqual(compiled.ir.nodes.decide, {
        id: "decide",
        type: "decision",
        description: null,
        hasInput: true,
        input: "${input}",
        inputSchema: null,
        question: {
            type: "choice",
            instructions: "Which team should handle this ticket?",
            criteria: {
                engineering: "Bugs, outages, integrations, and application failures",
                billing: "Charges, invoices, refunds, and payments",
                support: "Sign-in, account access, and how-to questions",
            },
        },
        confidence: { minimumProbability: 0.8 },
        timeoutSeconds: 30,
        next: {
            engineering: "done",
            billing: "done",
            support: "done",
            uncertain: "review",
            failure: "failed",
        },
    });
    assert.deepEqual(parseWorkflowIr(JSON.parse(JSON.stringify(compiled.ir))), compiled.ir);
});

test("choice requires its criteria routes and exactly the conditional uncertain route", () => {
    const missing = clone(CHOICE_NODE);
    delete missing.transition.next.billing;
    assertInvalid(compile(missing), "missing criterion route", "states.decide.transition.next");

    const extra = clone(CHOICE_NODE);
    extra.transition.next.legal = "done";
    assertInvalid(compile(extra), "extra business route", "states.decide.transition.next");

    const withoutConfidence = choiceWithoutConfidence();
    withoutConfidence.transition.next.uncertain = "review";
    assertInvalid(compile(withoutConfidence), "uncertain without confidence", "states.decide.transition.next");

    const withoutUncertain = clone(CHOICE_NODE);
    delete withoutUncertain.transition.next.uncertain;
    assertInvalid(compile(withoutUncertain), "confidence without uncertain", "states.decide.transition.next");

    const plain = choiceWithoutConfidence();
    const compiled = compile(plain);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.equal(Object.hasOwn(compiled.ir.nodes.decide, "confidence"), false);

    const noRuntimeRoute = choiceWithoutConfidence();
    delete noRuntimeRoute.transition.next.failure;
    const optional = compile(noRuntimeRoute);
    assert.equal(optional.valid, true, JSON.stringify(optional.diagnostics));
    assert.ok(optional.diagnostics.some(item => item.code === "WORKFLOW_FAILURE_UNHANDLED"
        && item.severity === "warning" && item.path === "states.decide.transition.next"));

    for (const route of ["failure", ...RUNTIME_ERROR_CODES]) {
        const node = choiceWithoutConfidence();
        node.transition.next[route] = "failed";
        assert.equal(compile(node).valid, true, `optional runtime route ${route}`);
    }
});

test("choice criteria reject reserved, duplicate, and dynamic labels", () => {
    for (const label of ["uncertain", "scored", "failure", ...RUNTIME_ERROR_CODES]) {
        const node = choiceWithoutConfidence();
        node.question.criteria = { ordinary: "Ordinary", [label]: "Reserved" };
        node.transition.next = { ordinary: "done", [label]: "failed" };
        assertInvalid(compile(node), `reserved label ${label}`, "states.decide.question.criteria");
    }

    const dynamic = choiceWithoutConfidence();
    dynamic.question.criteria = { ordinary: "Ordinary", "${input.option}": "Dynamic" };
    dynamic.transition.next = { ordinary: "done", "${input.option}": "done" };
    assertInvalid(compile(dynamic), "dynamic label", "states.decide.question.criteria");

    const duplicate = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: duplicate-choice, version: "1.0.0" }
initial: decide
states:
  decide:
    type: decision
    question:
      type: choice
      instructions: Choose a lane.
      criteria:
        alpha: First
        alpha: Duplicate
        beta: Second
    transition: { next: { alpha: done, beta: done } }
  done: { type: terminal, outcome: succeeded }
`;
    assertInvalid(compileWorkflow(duplicate), "duplicate criteria label", "$");
});

test("noul takes optional exact true/false criteria and yes/no routes", () => {
    const withCriteria = compile(noulNode());
    assert.equal(withCriteria.valid, true, JSON.stringify(withCriteria.diagnostics));
    assert.deepEqual(withCriteria.ir.nodes.decide.question, {
        type: "noul",
        instructions: "Does this action require production access?",
        criteria: {
            true: "Reads or changes production data or configuration",
            false: "Uses no production data or configuration",
        },
    });
    assert.deepEqual(parseWorkflowIr(JSON.parse(JSON.stringify(withCriteria.ir))), withCriteria.ir);

    const withoutCriteria = noulNode();
    delete withoutCriteria.question.criteria;
    delete withoutCriteria.confidence;
    delete withoutCriteria.transition.next.uncertain;
    const plain = compile(withoutCriteria);
    assert.equal(plain.valid, true, JSON.stringify(plain.diagnostics));
    assert.equal(Object.hasOwn(plain.ir.nodes.decide.question, "criteria"), false);

    for (const criteria of [{ true: "Positive" }, { true: "Positive", false: "Negative", maybe: "Other" }]) {
        const node = noulNode();
        node.question.criteria = criteria;
        assertInvalid(compile(node), `malformed noul criteria ${JSON.stringify(criteria)}`, "states.decide.question.criteria");
    }
    for (const missing of ["yes", "no"]) {
        const node = noulNode();
        delete node.transition.next[missing];
        assertInvalid(compile(node), `missing ${missing}`, "states.decide.transition.next");
    }
    const extra = noulNode();
    extra.transition.next.maybe = "review";
    assertInvalid(compile(extra), "extra noul route", "states.decide.transition.next");

    const uncertainWithoutConfidence = noulNode();
    delete uncertainWithoutConfidence.confidence;
    assertInvalid(compile(uncertainWithoutConfidence), "noul uncertain without confidence",
        "states.decide.transition.next");
    const confidenceWithoutUncertain = noulNode();
    delete confidenceWithoutUncertain.transition.next.uncertain;
    assertInvalid(compile(confidenceWithoutUncertain), "noul confidence without uncertain",
        "states.decide.transition.next");
});

test("score preserves an ordered criteria array and only takes the scored route", () => {
    const compiled = compile(scoreNode());
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.deepEqual(compiled.ir.nodes.decide.question, {
        type: "score",
        instructions: "How severe is this incident?",
        criteria: ["Cosmetic", "Minor", "Major", "Critical"],
    });
    assert.deepEqual(parseWorkflowIr(JSON.parse(JSON.stringify(compiled.ir))), compiled.ir);

    for (const criteria of [[], ["Only"], ["Low", "Low"], ["${input.low}", "High"], [1, 2]]) {
        const node = scoreNode();
        node.question.criteria = criteria;
        assertInvalid(compile(node), `invalid score criteria ${JSON.stringify(criteria)}`, "states.decide.question.criteria");
    }

    const withConfidence = scoreNode();
    withConfidence.confidence = { minimumProbability: 0.8 };
    assertInvalid(compile(withConfidence), "score confidence", "states.decide.confidence");

    const withoutScored = scoreNode();
    delete withoutScored.transition.next.scored;
    assertInvalid(compile(withoutScored), "missing scored", "states.decide.transition.next");

    const extra = scoreNode();
    extra.transition.next.maybe = "review";
    assertInvalid(compile(extra), "extra score route", "states.decide.transition.next");
});

test("minimumProbability is finite and in the closed range 0 to 1", () => {
    for (const minimumProbability of [0, 0.8, 1]) {
        const node = clone(CHOICE_NODE);
        node.confidence.minimumProbability = minimumProbability;
        const compiled = compile(node);
        assert.equal(compiled.valid, true, `${minimumProbability}: ${JSON.stringify(compiled.diagnostics)}`);
    }
    for (const minimumProbability of [NaN, Infinity, -Infinity, -0.1, 1.1, "0.8", null]) {
        const node = clone(CHOICE_NODE);
        node.confidence.minimumProbability = minimumProbability;
        assertInvalid(compile(node), `minimumProbability ${String(minimumProbability)}`,
            "states.decide.confidence.minimumProbability");
    }
});

test("decision timeoutSeconds is a literal integer from 1 to 86400 and defaults to 30", () => {
    for (const [value, expected] of [[undefined, 30], [1, 1], [86400, 86400]]) {
        const node = clone(CHOICE_NODE);
        if (value === undefined) delete node.timeoutSeconds;
        else node.timeoutSeconds = value;
        const compiled = compile(node);
        assert.equal(compiled.valid, true, `${String(value)}: ${JSON.stringify(compiled.diagnostics)}`);
        assert.equal(compiled.ir.nodes.decide.timeoutSeconds, expected);
    }
    for (const timeoutSeconds of [0, 86401, 1.5, NaN, Infinity, true, "30", "${input.timeout}"]) {
        const node = clone(CHOICE_NODE);
        node.timeoutSeconds = timeoutSeconds;
        assertInvalid(compile(node), `timeoutSeconds ${String(timeoutSeconds)}`, "states.decide.timeoutSeconds");
    }
});

test("stored decision IR is strict", () => {
    const compiled = compile(CHOICE_NODE);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.deepEqual(parseWorkflowIr(JSON.parse(JSON.stringify(compiled.ir))), compiled.ir);

    const malformed = [
        ["unknown node field", node => { node.model = "azure-foundry:ps-decision-1-1"; }],
        ["unknown question field", node => { node.question.provider = "foundry"; }],
        ["unknown question type", node => { node.question.type = "binary"; }],
        ["missing criteria", node => { delete node.question.criteria; }],
        ["dynamic criterion", node => { node.question.criteria["${input.option}"] = "Dynamic"; }],
        ["non-finite threshold", node => { node.confidence.minimumProbability = Infinity; }],
        ["invalid threshold", node => { node.confidence.minimumProbability = 1.1; }],
        ["invalid timeout", node => { node.timeoutSeconds = 86401; }],
        ["missing route", node => { delete node.next.billing; }],
        ["extra route", node => { node.next.legal = "done"; }],
        ["missing uncertain route", node => { delete node.next.uncertain; }],
    ];
    for (const [label, mutate] of malformed) {
        const ir = structuredClone(compiled.ir);
        mutate(ir.nodes.decide);
        assert.throws(() => parseWorkflowIr(ir), /stored IR decision state decide is invalid/, label);
    }
});

test("compileWorkflow stays catalog-free and model binding is not YAML", () => {
    assert.equal(compileWorkflow.length, 1);
    const node = clone(CHOICE_NODE);
    node.model = "azure-foundry:ps-decision-1-1";
    assertInvalid(compile(node), "YAML model binding", "states.decide.model");
});

test("a non-Decision workflow keeps its golden IR", () => {
    const compiled = compileWorkflow(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: legacy-golden, version: "1.0.0" }
initial: hold
states:
  hold:
    type: wait
    seconds: 30
    transition: { next: { elapsed: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.deepEqual(compiled.ir, {
        irVersion: 1,
        apiVersion: "pilotswarm.dev/v1",
        name: "legacy-golden",
        version: "1.0.0",
        description: null,
        initial: "hold",
        initialInput: null,
        inputsSchema: null,
        outputSchema: null,
        catchAll: null,
        limits: { maxNodeExecutions: 1000 },
        schemaDefs: {},
        contracts: {},
        nodes: {
            hold: {
                id: "hold", type: "wait", description: null, seconds: 30,
                hasInput: false, input: null, next: { elapsed: "done", failure: "failed" },
            },
            done: {
                id: "done", type: "terminal", description: null, outcome: "succeeded",
                summary: null, hasOutput: false, output: null, outputSchema: null,
            },
            failed: {
                id: "failed", type: "terminal", description: null, outcome: "failed",
                summary: null, hasOutput: false, output: null, outputSchema: null,
            },
        },
    });
});
