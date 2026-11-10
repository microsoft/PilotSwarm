/**
 * Workflow authoring rules (2026-11-08, from chats that wrote Workflows):
 * - E1 loop re-entry: a route back to a state brings it the previous state's output (a chat's check_ci took a closed
 *   { checks } and gave { checks, ciState }; its wait passed that back, and the second visit failed "Input does not match
 *   node.check_ci.input"): map it with `input:`, or let the inputSchema take those fields.
 * - E2 KV: only the parent (vars, set_vars) and the person (Variables) set KV, never a state: read a key with a default
 *   (a script threw on an unset kv.ciState; another read kv.riskSummary, which nothing set).
 * - E3 a send's output is its delivery receipt, not the message.
 * - E4 after a failed test: say what failed, and never claim a fix or a retest that did not happen.
 * - The polling-loop example (workflow-patterns, ci-poll) does E1 and E2, compiles as written, and runs its loop with the
 *   real binding evaluator and schema validator.
 *
 * Run: node --test test/unit/workflow-authoring-rules.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadSkillsSync } from "../../dist/skills.js";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
import { evaluateBindingTemplate } from "../../dist/workflow/bindings.js";
import { WorkflowSchemaSet } from "../../dist/workflow/schema.js";
import { WORKFLOW_SKILLS_DIR } from "../../dist/workflow/guidance.js";

const ALL = { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true, enableClockWaits: true };
const flat = text => text.replace(/\s+/g, " ");
const skill = name => {
    const found = loadSkillsSync(WORKFLOW_SKILLS_DIR).find(item => item.name === name);
    assert.ok(found, name);
    return found;
};
const example = (text, name) => {
    const start = text.indexOf(`\`\`\`yaml\n# example: ${name}\n`);
    assert.ok(start >= 0, `the example ${name}`);
    const body = text.slice(start + "```yaml\n".length);
    return body.slice(0, body.indexOf("\n```"));
};


test("E1 to E3: the authoring skill says loops get the previous output, KV needs a default, and a send gives its receipt", () => {
    const authoring = flat(skill("workflow-authoring").prompt);
    for (const phrase of [
        // E1
        "A route back to a state brings it the previous state's output. Map it with `input:`, or let its `inputSchema` take those "
            + "fields: a closed schema (`additionalProperties: false`) refuses extra ones, such as `ciState`.",
        "Call `load_skill` with name `workflow-patterns` for a polling loop.",
        // E2
        "Only the parent (`vars` at start, `set_vars`) and the person (Variables) set KV; no state writes it.",
        "Read a KV key with a default (`kv.x ?? 30`), and only keys they set: name the person's keys in the description.",
        "A value the run needs is a required input, not KV.",
        "context.kv.pollLimit ?? 12; // KV, with a default",
        // E3
        "A send's output is its delivery receipt, not the message: a state after it cannot read the message, so send after the "
            + "states that need it.",
        // No state writes KV, so a loop's counter is in its data.
        "Bound the rounds (a schema, or a counter in the data the loop carries) so the loop ends.",
    ]) assert.ok(authoring.includes(phrase), `workflow-authoring: ${phrase}`);
    assert.ok(!authoring.includes("a counter in the variables"), "a state cannot count in KV");
    assert.ok(!/load the `?workflow-patterns`? skill/i.test(authoring), "telling a model to load a skill names load_skill");
});

test("E4: after a failed test the tools skill says to tell the person what failed and never to claim a retest", () => {
    const tools = flat(skill("workflow-tools").prompt);
    for (const phrase of [
        "After a failed test, tell the person what failed.",
        "To fix it, change the definition or its fixtures, save, and test again if the user wants.",
        "Never say you fixed, saved or tested again when you did not: report only what you ran.",
    ]) assert.ok(tools.includes(phrase), `workflow-tools: ${phrase}`);
});

test("the patterns skill has the polling loop and its index card says so", () => {
    const patterns = skill("workflow-patterns");
    assert.match(patterns.description, /or loops back to a state \(a polling loop\)/);
    const text = flat(patterns.prompt);
    assert.ok(text.includes("## A polling loop"));
    assert.ok(text.includes("This skill adds three patterns to it."));
    assert.ok(text.includes("`check_ci`'s closed `inputSchema` refuses `ciState`, so `wait_ci` maps the output back with `input:`; "
        + "KV is read with a default."));
});

test("the polling-loop example compiles with no diagnostics and runs its loop: the wait's input mapping passes check_ci's schema", async () => {
    const yaml = example(skill("workflow-patterns").prompt, "ci-poll");
    const compiled = compileWorkflow(yaml, ALL);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    assert.deepEqual(compiled.diagnostics, []);
    const { ir } = compiled;
    const check = ir.nodes.check_ci;
    const wait = ir.nodes.wait_ci;
    assert.equal(check.type, "script");
    assert.equal(check.hasInput, false);
    assert.equal(ir.schemaDefs[check.inputSchema].additionalProperties, false, "check_ci's inputSchema is closed");
    assert.equal(wait.type, "wait");
    assert.deepEqual(wait.input, { checks: "${input.checks}" });
    assert.equal(wait.next.elapsed, "check_ci", "the wait loops back");
    assert.match(check.source, /context\.kv\.maxChecks \?\? 30/);

    const schemas = new WorkflowSchemaSet(ir.schemaDefs);
    const scope = (input, kv) => ({ inputs: null, input, kv, runtime: { error: null } });
    const runCheck = async (input, kv, state) => {
        let result = null;
        const source = new (Object.getPrototypeOf(async () => {}).constructor)("context", "callTool", "setResult", check.source);
        await source({ input, kv, inputs: null }, async name => (assert.equal(name, "get_ci_state"), { state }),
            async (outcome, output) => { result = { outcome, output }; });
        return result;
    };
    for (const [kv, states, rounds] of [[{}, ["pending", "pending", "success"], 3], [{ maxChecks: 2, pollSeconds: 5 }, ["pending", "pending", "pending"], 2]]) {
        let input = evaluateBindingTemplate(ir.initialInput, scope(null, kv));
        let visits = 0;
        for (;;) {
            assert.deepEqual(schemas.validate(check.inputSchema, input), [], `visit ${visits + 1} of check_ci takes its input`);
            const result = await runCheck(input, kv, states[visits]);
            visits += 1;
            if (result.outcome === "done") break;
            assert.equal(check.next[result.outcome], "wait_ci");
            // Without the wait's input, check_ci would get this output back, and its closed schema refuses ciState.
            assert.ok(schemas.validate(check.inputSchema, result.output).some(problem => /is not a known field/.test(problem.message)),
                JSON.stringify(result.output));
            assert.equal(evaluateBindingTemplate(wait.seconds, scope(result.output, kv)), kv.pollSeconds ?? 60);
            input = evaluateBindingTemplate(wait.input, scope(result.output, kv), "states.wait_ci.input");
        }
        assert.equal(visits, rounds, JSON.stringify(kv));
    }
});
