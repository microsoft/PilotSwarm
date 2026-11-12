import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
import { scriptToolRequirements } from "../../dist/workflow/script-analysis.js";

const yaml = source => `apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: authoring-check, version: "1.0.0" }
initial: poll
states:
  poll:
    type: script
    source: ${JSON.stringify(source)}
    transition: { next: { success: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

test("FB-016: each script is checked as a Node ES module without executing it", () => {
    for (const source of ["return;", "const = broken;", "await callTool('x', {", "export const value = ;"]) {
        const compiled = compileWorkflow(yaml(source));
        assert.equal(compiled.valid, false, source);
        assert.equal(compiled.ir, null);
        assert.ok(compiled.diagnostics.some(item => item.code === "WORKFLOW_SCRIPT_SYNTAX" && item.path === "states.poll.source"
            && item.severity === "error" && item.message.includes("Node ES module")), source);
    }
    const valid = compileWorkflow(yaml('import fs from "node:fs"; await callTool("read_facts", {}); await setResult("success", {});'));
    assert.equal(valid.valid, true);
    assert.equal(compileWorkflow(yaml('throw new Error("analysis must not execute");')).valid, true);
});

test("FB-017: recognizable Promise combinators warn and name the sequential-call fix", () => {
    for (const source of [
        'await Promise.all([callTool("x", {}), callTool("y", {})]);',
        'await Promise["allSettled"]([1, 2].map(n => callTool("x", { n })));',
    ]) {
        assert.equal(scriptToolRequirements(source).concurrent, true);
        const compiled = compileWorkflow(yaml(source));
        assert.equal(compiled.valid, true);
        const warning = compiled.diagnostics.find(item => item.code === "WORKFLOW_TOOLS_CONCURRENT");
        assert.equal(warning.severity, "warning");
        assert.match(warning.message, /Await each callTool call one at a time/);
        assert.match(warning.message, /for\.\.\.of loop/);
    }
    for (const source of [
        'await callTool("x", {}); await callTool("y", {});',
        'await Promise.all([Promise.resolve(1), Promise.resolve(2)]);',
        'async function local(Promise) { await Promise.all([callTool("x", {})]); }',
        'async function local(callTool) { await Promise.all([callTool("x", {})]); }',
    ]) assert.equal(scriptToolRequirements(source).concurrent, undefined, source);
});

test("FB-016: invalid script sources in parallel bodies report their state too", () => {
    const compiled = compileWorkflow(`apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: nested-invalid, version: "1.0.0" }
initial: fan
states:
  fan:
    type: parallel
    forEach: [1]
    body:
      initial: invalid
      states:
        invalid: { type: script, source: "return;", transition: { next: { success: childDone, failure: childDone } } }
        childDone: { type: terminal, outcome: succeeded }
    transition: { next: { joined: done, blocked: done, failure: done } }
  done: { type: terminal, outcome: succeeded }
`);
    assert.equal(compiled.valid, false);
    assert.ok(compiled.diagnostics.some(item => item.code === "WORKFLOW_SCRIPT_SYNTAX" && item.path === "states.fan.body.states.invalid.source"));
});
