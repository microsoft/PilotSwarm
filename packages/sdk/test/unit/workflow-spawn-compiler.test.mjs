/**
 * Child Workflows compiler tests (T3 & T4):
 * - T3: spawn state with every field, binding in definition, unknown field, invalid routes, parseWorkflowIr roundtrip.
 * - T4: receive of WorkflowEnded@1 without contracts entry; send/request/declare of WorkflowEnded@1 refused.
 *
 * Run: node --test test/unit/workflow-spawn-compiler.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow, parseWorkflowIr, SPAWN_STARTED, WORKFLOW_ENDED_CONTRACT } from "../../dist/workflow/compiler.js";

test("T3: spawn state compiles with all optional fields and round-trips through parseWorkflowIr", () => {
    const yaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-monitor, version: "1.0.0" }
initial: launch
states:
  launch:
    type: spawn
    description: Start child investigation
    definition: child-investigation
    revision: 2
    agentModels:
      deep_dive: { model: "provider:model-x", reasoningEffort: "medium", contextTier: "default" }
    inputs:
      cycle: "\${input.cycle}"
      note: "static"
    carry:
      loopState: "\${input.loopState}"
    transition:
      next:
        started: done
        budget_exceeded: done
        failure: failed
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
    const res = compileWorkflow(yaml);
    assert.equal(res.valid, true, JSON.stringify(res.diagnostics));
    const node = res.ir.nodes.launch;
    assert.equal(node.type, "spawn");
    assert.equal(node.definition, "child-investigation");
    assert.equal(node.revision, 2);
    assert.equal(node.hasInputs, true);
    assert.deepEqual(node.inputs, { cycle: "${input.cycle}", note: "static" });
    assert.deepEqual(node.agentModels, { deep_dive: { model: "provider:model-x", reasoningEffort: "medium", contextTier: "default" } });
    assert.deepEqual(node.carry, { loopState: "${input.loopState}" });
    assert.equal(SPAWN_STARTED, "started");

    // Package definition <package>/<name> also compiles.
    const pkgRes = compileWorkflow(yaml.replace("definition: child-investigation", "definition: pkg-one/child-investigation"));
    assert.equal(pkgRes.valid, true, JSON.stringify(pkgRes.diagnostics));
    assert.equal(pkgRes.ir.nodes.launch.definition, "pkg-one/child-investigation");

    // Stored IR round-trip succeeds.
    const parsed = parseWorkflowIr(JSON.parse(JSON.stringify(res.ir)));
    assert.deepEqual(parsed.nodes.launch, node);
});

test("T3: spawn state refuses binding in definition, unknown fields, missing started route, bad revision", () => {
    const withBinding = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: bad-spawn, version: "1.0.0" }
initial: launch
states:
  launch:
    type: spawn
    definition: "\${input.defName}"
    bogus: 123
    revision: 0
    transition:
      next:
        started: done
        failure: failed
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
    const res = compileWorkflow(withBinding);
    assert.equal(res.valid, false);
    const byPath = Object.fromEntries(res.diagnostics.filter(d => d.severity === "error").map(d => [d.path, d]));
    assert.ok(byPath["states.launch.definition"], "expected definition error");
    assert.match(byPath["states.launch.definition"].message, /never a binding/);
    assert.ok(byPath["states.launch.bogus"], "expected unknown field error");
    assert.equal(byPath["states.launch.bogus"].code, "WORKFLOW_FIELD_UNKNOWN");
    assert.ok(byPath["states.launch.revision"], "expected revision error");

    const missingStarted = compileWorkflow(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: bad-route, version: "1.0.0" }
initial: launch
states:
  launch:
    type: spawn
    definition: child-one
    transition:
      next:
        done_child: done
        failure: failed
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`);
    assert.equal(missingStarted.valid, false);
    assert.ok(missingStarted.diagnostics.some(d => d.code === "WORKFLOW_ROUTE_MISSING"));
    assert.ok(missingStarted.diagnostics.some(d => d.code === "WORKFLOW_ROUTE_INVALID"));
});

test("T4: receive of WorkflowEnded@1 compiles without contracts entry; send/request/declare refused", () => {
    assert.equal(WORKFLOW_ENDED_CONTRACT, "WorkflowEnded@1");
    const recvYaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-recv, version: "1.0.0" }
initial: wait_child
states:
  wait_child:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    wait: { seconds: 60 }
    carry: { cycle: 1 }
    transition:
      next:
        received: done
        elapsed: done
        failure: failed
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
    const recv = compileWorkflow(recvYaml);
    assert.equal(recv.valid, true, JSON.stringify(recv.diagnostics));
    assert.equal(recv.ir.nodes.wait_child.contract, WORKFLOW_ENDED_CONTRACT);
    const parsed = parseWorkflowIr(JSON.parse(JSON.stringify(recv.ir)));
    assert.equal(parsed.nodes.wait_child.contract, WORKFLOW_ENDED_CONTRACT);

    const sendYaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: bad-send, version: "1.0.0" }
initial: notify
states:
  notify:
    type: messaging
    mode: send
    contract: WorkflowEnded@1
    recipient: { parent: true }
    transition:
      next: { sent: done, failure: failed }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
    const send = compileWorkflow(sendYaml);
    assert.equal(send.valid, false);
    assert.ok(send.diagnostics.some(d => d.code === "WORKFLOW_CONTRACT_RESERVED" && d.path === "states.notify.contract"));

    const declareYaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: bad-declare, version: "1.0.0" }
contracts:
  WorkflowEnded@1: { schema: { type: object } }
initial: done
states:
  done: { type: terminal, outcome: succeeded }
`;
    const decl = compileWorkflow(declareYaml);
    assert.equal(decl.valid, false);
    assert.ok(decl.diagnostics.some(d => d.code === "WORKFLOW_CONTRACT_RESERVED" && d.path === "contracts.WorkflowEnded@1"));
});
