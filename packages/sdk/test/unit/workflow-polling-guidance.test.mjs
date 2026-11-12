import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow, parseWorkflowIr, WAIT_MAX_SECONDS, WORKFLOW_MAX_NODE_EXECUTIONS, WORKFLOW_RUN_TIMEOUT_MAX_SECONDS } from "../../dist/workflow/compiler.js";
import { evaluateBindingTemplate } from "../../dist/workflow/bindings.js";
import { WorkflowSchemaSet } from "../../dist/workflow/schema.js";
import { loadSkillsSync } from "../../dist/skills.js";
import { WORKFLOW_SKILLS_DIR } from "../../dist/workflow/guidance.js";

const yaml = (seconds, limits = "") => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: bounded-wait, version: "1.0.0" }
initial: wait
${limits}
states:
  wait: { type: wait, seconds: ${seconds}, transition: { next: { elapsed: done, failure: failed } } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
const polling = () => loadSkillsSync(WORKFLOW_SKILLS_DIR).find(skill => skill.name === "workflow-polling").prompt;

test("FB-003: bounds and stored IR stay unchanged; limit diagnostics teach units and exit budgeting", () => {
    for (const seconds of [1, WAIT_MAX_SECONDS, '"${kv.pollSeconds ?? 60}"']) {
        const result = compileWorkflow(yaml(seconds));
        assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
        assert.equal(result.ir.limits.maxNodeExecutions, 1000);
        assert.equal(result.ir.limits.timeoutSeconds, undefined);
        assert.deepEqual(parseWorkflowIr(JSON.parse(JSON.stringify(result.ir))), result.ir);
    }
    for (const seconds of [0, 1.5, WAIT_MAX_SECONDS + 1]) {
        const result = compileWorkflow(yaml(seconds));
        assert.equal(result.valid, false);
        const error = result.diagnostics.find(item => item.path === "states.wait.seconds");
        assert.equal(error.code, "WORKFLOW_FIELD_INVALID");
        assert.match(error.message, /30 days per wait, not per run/);
        assert.match(error.message, /bounded repeated waits; see workflow-polling/);
    }
    for (const [field, max, words] of [
        ["maxNodeExecutions", WORKFLOW_MAX_NODE_EXECUTIONS, /every state visit counts, including waits, branches and terminals/],
        ["timeoutSeconds", WORKFLOW_RUN_TIMEOUT_MAX_SECONDS, /optional run deadline is at most 30 days; pauses do not stop it/],
    ]) {
        for (const value of [1, max]) assert.equal(compileWorkflow(yaml(1, `limits: { ${field}: ${value} }`)).valid, true);
        for (const value of [0, 1.5, max + 1]) {
            const result = compileWorkflow(yaml(1, `limits: { ${field}: ${value} }`));
            assert.equal(result.valid, false);
            const error = result.diagnostics.find(item => item.path === `limits.${field}`);
            assert.equal(error.code, "WORKFLOW_FIELD_INVALID");
            assert.match(error.message, words);
        }
    }
});

test("FB-003: the documented conservative calculator and multi-day examples agree", () => {
    const text = polling().replace(/\s+/g, " ");
    assert.ok(text.includes("P = floor((B - R) / C)"));
    assert.ok(text.includes("C * (ceil(D / S) + 1) + R"));
    for (const [budget, reserve, cost, count] of [[1000, 20, 2, 490], [10000, 20, 2, 4990], [10000, 20, 4, 2495]]) {
        assert.equal(Math.floor((budget - reserve) / cost), count);
        const format = value => value.toLocaleString("en-US");
        assert.ok(text.includes(`| ${[budget, reserve, cost, count].map(format).join(" | ")} |`));
    }
    for (const [days, seconds, label, count, visits] of [
        [7, 900, "15 minutes", 673, 1366], [14, 3600, "1 hour", 337, 694], [28, 21600, "6 hours", 113, 246],
    ]) {
        assert.equal(Math.ceil(days * 86400 / seconds) + 1, count);
        assert.equal(2 * count + 20, visits);
        assert.ok(text.includes(`| ${days} days | ${label} | ${count} | ${visits.toLocaleString("en-US")} |`));
    }
    for (const words of [
        "Omitting", "parent, not a script", "Confirm the old run ended",
        "Reconcile an ambiguous start response", "not a resume of a completed run", "prevent overlap",
        "Do not reset a missing counter to zero", "`carry` is not a supported field",
    ]) assert.ok(text.includes(words), words);
});

test("FB-004: ambiguous delivery is blocked with typed unknown output, not a retry or a new lifecycle", () => {
    const body = polling().split("```yaml\n# example: uncertain-send\n")[1].split("\n```")[0];
    const compiled = compileWorkflow(body);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.deepEqual(compiled.diagnostics, []);
    const { ir } = compiled;
    assert.equal(ir.nodes.send.next.delivery_failed, "uncertain");
    assert.equal(ir.nodes.send.next.failure, "failed");
    assert.equal(ir.nodes.uncertain.outcome, "blocked");
    const error = { code: "delivery_failed", message: "The recipient may have queued it." };
    const scope = { inputs: { operationId: "observation-7" }, input: error, kv: {}, runtime: { error } };
    const output = evaluateBindingTemplate(ir.nodes.uncertain.output, scope);
    assert.deepEqual(output, { outcome: "unknown", operationId: "observation-7", error });
    const schemas = new WorkflowSchemaSet(ir.schemaDefs);
    assert.deepEqual(schemas.validate(ir.nodes.uncertain.outputSchema, output), []);
    assert.ok(schemas.validate(ir.nodes.uncertain.outputSchema, { ...output, outcome: "succeeded" }).length > 0);
    const unsupported = compileWorkflow(body.replace("outcome: blocked", "outcome: unknown"));
    assert.equal(unsupported.valid, false, "unknown was not added to the terminal schema");
});
