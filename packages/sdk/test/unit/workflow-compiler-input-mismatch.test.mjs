/**
 * F: the compiler warns (WORKFLOW_INPUT_MISMATCH, never an error) when a route brings a state with no `input:` a value
 * whose declared simple object schema its closed inputSchema refuses, or that lacks a property it requires; the reference
 * skill names the warning.
 *
 * Run: node --test test/unit/workflow-compiler-input-mismatch.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadSkillsSync } from "../../dist/skills.js";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
import { WORKFLOW_SKILLS_DIR } from "../../dist/workflow/guidance.js";
const flat = text => text.replace(/\s+/g, " ");
const mismatches = compiled => compiled.diagnostics.filter(item => item.code === "WORKFLOW_INPUT_MISMATCH");

test("the reference skill names the warning", () => {
    const reference = loadSkillsSync(WORKFLOW_SKILLS_DIR).find(item => item.name === "workflow-reference");
    assert.ok(flat(reference.prompt).includes("or needs one it lacks, gets the warning `WORKFLOW_INPUT_MISMATCH`."));
});

// F: the compiler's warning. check_ci (closed { checks }) gives { checks, ciState }; wait_ci passes its input on.
const STATUS = "{ type: object, additionalProperties: false, required: [checks, ciState], properties: { checks: { type: integer }, ciState: { type: string } } }";
const CHECKS = "{ type: object, additionalProperties: false, required: [checks], properties: { checks: { type: integer } } }";
const loop = ({ inputSchema = CHECKS, outputSchema = STATUS, waitInput = "", checkInput = "" } = {}) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ci-watch, version: "1.0.0" }
initial: check_ci
initialInput: { checks: 0 }
schemas:
  Status: ${STATUS}
states:
  check_ci:
    type: script
    inputSchema: ${inputSchema}
    outputSchema: ${outputSchema}
    outcomes: [pending, done]${checkInput}
    source: |
      await setResult("done", { checks: 1, ciState: "success" });
    transition: { next: { pending: wait_ci, done: done, failure: failed } }
  wait_ci:
    type: wait
    seconds: 60${waitInput}
    transition: { next: { elapsed: check_ci, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed, output: "\${runtime.error}" }
`;

test("F: the evidence case warns, naming both states and the property; the definition stays valid", () => {
    const compiled = compileWorkflow(loop());
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.ok(compiled.ir, "a warning never invalidates the definition");
    assert.deepEqual(mismatches(compiled), [{
        severity: "warning", code: "WORKFLOW_INPUT_MISMATCH", path: "states.check_ci.inputSchema",
        message: "check_ci gets \"ciState\" from wait_ci (which passes on check_ci's output), but its inputSchema does not allow it: "
            + "map the input with input: or allow the property.",
    }]);
    assert.deepEqual(compiled.diagnostics.filter(item => item.code !== "WORKFLOW_INPUT_MISMATCH"), [], "nothing else");
    // A named schema warns the same way.
    assert.equal(mismatches(compileWorkflow(loop({ outputSchema: "{ $ref: \"#/schemas/Status\" }" }))).length, 1);
});

test("F: an explicit input: on the wait or on the state, or a schema that takes the fields, is silent", () => {
    for (const variant of [
        { waitInput: "\n    input: { checks: \"${input.checks}\" }" },
        { checkInput: "\n    input: { checks: \"${input.checks}\" }" },
        { inputSchema: "{ type: object, required: [checks], properties: { checks: { type: integer } } }" },
        { inputSchema: "{ type: object, additionalProperties: false, required: [checks], properties: { checks: { type: integer }, ciState: { type: string } } }" },
    ]) {
        const compiled = compileWorkflow(loop(variant));
        assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
        assert.deepEqual(compiled.diagnostics, [], JSON.stringify(variant));
    }
});

test("F: a required property the closed producer lacks warns; an open producer, or a schema that is not a simple object, is silent", () => {
    const needsRound = "{ type: object, required: [checks, round], properties: { checks: { type: integer }, round: { type: integer } } }";
    const compiled = compileWorkflow(loop({ inputSchema: needsRound }));
    assert.equal(compiled.valid, true);
    assert.deepEqual(mismatches(compiled).map(item => item.message), [
        "check_ci needs \"round\" from wait_ci (which passes on check_ci's output), but check_ci's outputSchema does not have it: "
            + "map the input with input: or add the property.",
    ]);
    const openStatus = "{ type: object, required: [checks], properties: { checks: { type: integer }, ciState: { type: string } } }";
    assert.deepEqual(mismatches(compileWorkflow(loop({ inputSchema: needsRound, outputSchema: openStatus }))), [],
        "an open output may carry round");
    for (const inputSchema of [
        "{ anyOf: [{ type: object, additionalProperties: false, properties: { checks: { type: integer } } }] }",
        "{ type: object, additionalProperties: false, properties: { checks: { type: integer } }, allOf: [{ required: [checks] }] }",
        "{ type: object, additionalProperties: { type: string }, properties: { checks: { type: integer } } }",
        "{ type: object, additionalProperties: false }",
    ]) {
        const quiet = compileWorkflow(loop({ inputSchema }));
        assert.equal(quiet.valid, true, `${inputSchema}: ${JSON.stringify(quiet.diagnostics)}`);
        assert.deepEqual(mismatches(quiet), [], inputSchema);
    }
    for (const outputSchema of ["{ allOf: [{ $ref: \"#/schemas/Status\" }] }", "{ type: object }"]) {
        assert.deepEqual(mismatches(compileWorkflow(loop({ outputSchema }))), [], outputSchema);
    }
});

test("F: a direct route warns (an optional property: can get); a runtime route and a parallel body's first state do not", () => {
    const yaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: triage, version: "1.0.0" }
initial: classify
states:
  classify:
    type: script
    outputSchema: { type: object, additionalProperties: false, required: [label], properties: { label: { type: string }, score: { type: number } } }
    outcomes: [bug]
    source: |
      await setResult("bug", { label: "bug" });
    transition: { next: { bug: review, failure: recover } }
  review:
    type: agent
    invoke: { prompt: "Review the label in your input." }
    inputSchema: { type: object, additionalProperties: false, required: [label], properties: { label: { type: string } } }
    outcomes: [done]
    timeoutSeconds: 600
    transition: { next: { done: fan, failure: failed } }
  recover:
    type: script
    inputSchema: { type: object, additionalProperties: false, required: [label], properties: { label: { type: string } } }
    outcomes: [done]
    source: |
      await setResult("done", null);
    transition: { next: { done: failed, failure: failed } }
  fan:
    type: parallel
    forEach: [{ x: 1 }]
    body:
      initial: first
      states:
        first:
          type: script
          inputSchema: { type: object, additionalProperties: false, required: [x], properties: { x: { type: integer } } }
          outputSchema: { type: object, additionalProperties: false, required: [x, y], properties: { x: { type: integer }, y: { type: integer } } }
          outcomes: [next]
          source: |
            await setResult("next", { x: 1, y: 2 });
          transition: { next: { next: second, failure: item_failed } }
        second:
          type: script
          inputSchema: { type: object, additionalProperties: false, required: [x], properties: { x: { type: integer } } }
          outcomes: [done]
          source: |
            await setResult("done", null);
          transition: { next: { done: item_done, failure: item_failed } }
        item_done: { type: terminal, outcome: succeeded }
        item_failed: { type: terminal, outcome: failed }
    transition: { next: { joined: done, blocked: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
    const compiled = compileWorkflow(yaml);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.deepEqual(mismatches(compiled).map(item => [item.path, item.message]), [
        ["states.review.inputSchema", "review can get \"score\" from classify, but its inputSchema does not allow it: "
            + "map the input with input: or allow the property."],
        ["states.fan.body.states.second.inputSchema", "second gets \"y\" from first, but its inputSchema does not allow it: "
            + "map the input with input: or allow the property."],
    ]);
});
