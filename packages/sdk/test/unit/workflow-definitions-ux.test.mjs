/**
 * Definitions-lens findings (TEST rehearsal at 2422c33e, UXFD-F1 to F4): a chat saved `inputs.topic` with `required: true`
 * and `required: [topic]` (version 1 and 2 shapes mixed), got "Map keys must be unique" at line 11 and saved the same mistake
 * again. And a TEST check at 27b2eaef: asked in prose, the model picked the CLI's own "skill" tool, not load_skill.
 *
 * - F2: a duplicated key names the key and both lines.
 * - F3: nothing a 1.0.83 chat sees teaches the version 1 `inputs` form (`<input>: { type, required: true }`).
 * - F4: the guidance a chat sees once Workflows are on has a stop rule for the same error, and workflow_definition's
 *   description has a short `inputs: { schema: … }` example, which compiles.
 * - Every text that tells the model to load a Workflow skill names the load_skill tool.
 *
 * Run: node --test test/unit/workflow-definitions-ux.test.mjs (after npm run build).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflowV2 } from "../../dist/workflow/v2/compiler.js";
import { ManagedSession } from "../../dist/managed-session.js";
import { loadSkillsSync } from "../../dist/skills.js";
import {
    WORKFLOW_CONTEXT_STUB, WORKFLOW_V2_SKILLS_DIR, WORKFLOW_V2_TEST_MODE_SKILLS_DIR, workflowSessionGuidance,
} from "../../dist/workflow/guidance.js";
import { workflowDefinitionToolSpec } from "../../dist/workflow/v2/definition-tool.js";

const MIXED = `apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: ux-defs, version: "1.0.0" }
inputs:
  topic:
    type: object
    required: true
    properties:
      topic: { type: string }
    required: [topic]
initial: done
states:
  done: { type: terminal, outcome: succeeded }
`;

test("UXFD-F2: a duplicated key names the key and both lines", () => {
    const compiled = compileWorkflowV2(MIXED);
    assert.equal(compiled.valid, false);
    const duplicate = compiled.diagnostics.find(item => item.code === "WORKFLOW_YAML_INVALID");
    assert.ok(duplicate, JSON.stringify(compiled.diagnostics));
    assert.equal(duplicate.line, 10);
    assert.match(duplicate.message, /^Duplicate key "required" at line 10 \(first at line 7\): a mapping may name each key once\.$/);
    // Another parse error keeps the parser's own words.
    const other = compileWorkflowV2("apiVersion: [unclosed\n");
    assert.ok(other.diagnostics.some(item => item.code === "WORKFLOW_YAML_INVALID" && !item.message.startsWith("Duplicate key")));
});

/** Every text a 1.0.83 chat with Workflows on sees about Workflows: guidance, declarations and the skills it can load. */
function chatTexts() {
    const texts = [];
    for (const testMode of [false, true]) {
        for (const tests of [false, true]) texts.push([`guidance testMode=${testMode} tests=${tests}`, workflowSessionGuidance(testMode, { scripts: true, clockWaits: tests, tests })]);
    }
    texts.push(["stub", WORKFLOW_CONTEXT_STUB]);
    for (const opts of [{ workflowMilestone: true }, {}]) {
        for (const tool of ManagedSession.subAgentToolDefs(opts)) {
            if (/workflow|respond_session_request|enable_workflows/.test(tool.name)) texts.push([`tool ${tool.name}`, `${tool.description} ${JSON.stringify(tool.parameters)}`]);
        }
    }
    for (const skill of [...loadSkillsSync(WORKFLOW_V2_SKILLS_DIR), ...loadSkillsSync(WORKFLOW_V2_TEST_MODE_SKILLS_DIR)]) {
        texts.push([`skill ${skill.name}`, `${skill.description}\n${skill.prompt}`]);
    }
    return texts;
}

test("UXFD-F3: no text a 1.0.83 chat sees teaches the version 1 inputs form; spawn_workflow is not declared", () => {
    for (const [where, text] of chatTexts()) {
        assert.ok(!/required: true/.test(text), `${where} teaches required: true`);
        assert.ok(!/v1alpha1/.test(text), `${where} names version 1`);
    }
    for (const opts of [{ workflowMilestone: true }, {}]) {
        assert.ok(!ManagedSession.subAgentToolDefs(opts).some(tool => tool.name === "spawn_workflow"));
    }
});

test("UXFD-F4: the guidance has a stop rule for a repeated error, and workflow_definition shows the inputs schema form, which compiles", () => {
    const guidance = workflowSessionGuidance(false, { scripts: true, clockWaits: true, requests: true });
    assert.ok(guidance.includes("A save with errors: fix the line each error names. If the same error returns after two saves, "
        + "stop: call `load_skill` with name `workflow-authoring`, or tell the person the exact error."), guidance);
    assert.ok(guidance.length <= 2250, `${guidance.length}`);
    const description = workflowDefinitionToolSpec({ tests: true }).description;
    const example = /inputs: (\{ schema: \{ type: object, required: \[topic\], properties: \{ topic: \{ type: string \} \} \} \})/.exec(description)?.[1];
    assert.ok(example, description);
    const yaml = ["apiVersion: pilotswarm.dev/v2-draft", "kind: Workflow", 'metadata: { name: ux-defs, version: "1.0.0" }', `inputs: ${example}`,
        "initial: pause", "states:", "  pause: { type: wait, seconds: 1, transition: { next: { elapsed: done } } }",
        "  done: { type: terminal, outcome: succeeded }", ""].join("\n");
    const compiled = compileWorkflowV2(yaml);
    assert.deepEqual(compiled.diagnostics.filter(item => item.severity === "error"), []);
    assert.equal(compiled.valid, true);
});

test("TEST at 27b2eaef: every text that tells the model to load a Workflow skill names the load_skill tool", () => {
    for (const [where, text] of chatTexts()) {
        const flat = text.replace(/\s+/g, " ");
        // "load the `workflow-authoring` skill", "Load `workflow-reference`", "Load the workflow-tools skill": the bare verb.
        assert.ok(!/\b[Ll]oad (the )?`?workflow-(authoring|reference|tools|patterns|testing)`?( skill)?\b/.test(flat), `${where}: ${flat.match(/.{0,40}[Ll]oad (the )?`?workflow-.{0,40}/)?.[0]}`);
    }
    const guidance = workflowSessionGuidance(false, { scripts: true, clockWaits: true, requests: true });
    assert.ok(guidance.includes("call `load_skill` with name `workflow-authoring`"));
    assert.ok(WORKFLOW_CONTEXT_STUB.includes("call `enable_workflows` (not `load_skill`)"));
    assert.ok(WORKFLOW_CONTEXT_STUB.length <= 600, `${WORKFLOW_CONTEXT_STUB.length}`);
});
