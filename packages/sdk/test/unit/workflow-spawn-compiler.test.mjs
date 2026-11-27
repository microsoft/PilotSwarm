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

// UX round 2, A1: a receive of WorkflowEnded@1 with `correlate:` waited forever, because a child's end carries no correlation.
test("a receive of WorkflowEnded@1 with correlate is saved with a warning that names from; without correlate it has none", () => {
    const yamlOf = (contract, correlate) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: batch, version: "1.0.0" }
contracts:
  Progress@1: { schema: { type: object } }
initial: launch
states:
  launch:
    type: spawn
    definition: child
    transition: { next: { started: collect, failure: failed } }
  collect:
    type: messaging
    mode: receive
    contract: ${contract}
${correlate}    wait: { seconds: 600 }
    transition:
      next: { ${contract.startsWith("[") ? "Progress@1: collect, WorkflowEnded@1: done" : "received: done"}, elapsed: failed, failure: failed }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
    const CORRELATE = '    correlate: { workflowId: "${states.launch.output.workflowId}" }\n';
    const FROM = '    from: "${states.launch.output.workflowId}"\n';
    const warningsOf = result => result.diagnostics.filter(item => item.code === "WORKFLOW_ENDED_CORRELATE");
    for (const contract of ["WorkflowEnded@1", "[Progress@1, WorkflowEnded@1]"]) {
        const correlated = compileWorkflow(yamlOf(contract, CORRELATE));
        assert.equal(correlated.valid, true, JSON.stringify(correlated.diagnostics));
        const warned = warningsOf(correlated);
        assert.equal(warned.length, 1, `${contract}: ${JSON.stringify(correlated.diagnostics)}`);
        assert.equal(warned[0].severity, "warning");
        assert.equal(warned[0].path, "states.collect.correlate");
        assert.match(warned[0].message, /WorkflowEnded@1 carries no correlation/);
        assert.match(warned[0].message, /from:/);
        // Matched by sender, as the skill says: no warning.
        const byFrom = compileWorkflow(yamlOf(contract, FROM));
        assert.equal(byFrom.valid, true, JSON.stringify(byFrom.diagnostics));
        assert.deepEqual(warningsOf(byFrom), [], contract);
    }
    // An empty correlate matches the notice's empty correlation: no warning. Another contract's correlate: no warning.
    assert.deepEqual(warningsOf(compileWorkflow(yamlOf("WorkflowEnded@1", "    correlate: {}\n"))), []);
    const progress = compileWorkflow(yamlOf("Progress@1", CORRELATE));
    assert.equal(progress.valid, true, JSON.stringify(progress.diagnostics));
    assert.deepEqual(warningsOf(progress), []);
});

// Owner decision i6-downstream: a child's WorkflowEnded@1 output now arrives whole (up to 195,584 bytes), and later limits still
// apply. Saving warns (never refuses) when it reaches a join, a send or request message, or the run's output as it arrived.
const wholeOutputWarnings = yaml => {
    const compiled = compileWorkflow(yaml);
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    return compiled.diagnostics.filter(item => item.code === "WORKFLOW_ENDED_WHOLE_OUTPUT");
};

/** A fan-out: each branch spawns a child, receives its end and ends with `output`. */
const fanOutYaml = ({ output, contract = "WorkflowEnded@1", carry = "", forEach = "[a, b, c, d]", join = "" }) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: fan-out, version: "1.0.0" }
contracts:
  Progress@1: { schema: { type: object } }
initial: fan
states:
  fan:
    type: parallel
    forEach: ${forEach}
    concurrency: 4
${join}    body:
      initial: launch
      states:
        launch:
          type: spawn
          definition: child
          transition: { next: { started: collect, failure: branch_failed } }
        collect:
          type: messaging
          mode: receive
          contract: ${contract}
          from: "\${states.launch.output.workflowId}"
${carry}          wait: { seconds: 600 }
          transition: { next: { ${contract.startsWith("[") ? "Progress@1: collect, WorkflowEnded@1: branch_done" : "received: branch_done"}, elapsed: branch_failed, failure: branch_failed } }
        branch_done: { type: terminal, outcome: succeeded, output: ${output} }
        branch_failed: { type: terminal, outcome: failed }
    transition: { next: { joined: done, blocked: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;

/** One child; `relay` is entered with the child's end message, or from `pause` (a wait) after it. */
const relayYaml = (relay, { pause = false } = {}) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: relay, version: "1.0.0" }
contracts:
  ChildDone@1: { schema: { type: object } }
  Review@1: { schema: { type: object }, response: { schema: { type: object } } }
initial: launch
states:
  launch:
    type: spawn
    definition: child
    transition: { next: { started: collect, failure: failed } }
  collect:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    from: "\${states.launch.output.workflowId}"
    wait: { seconds: 600 }
    transition: { next: { received: ${pause ? "pause" : "relay"}, elapsed: failed, failure: failed } }
${pause ? `  pause:\n    type: wait\n    seconds: 60\n${pause === true ? "" : `    input: ${pause}\n`}    transition: { next: { elapsed: relay } }\n` : ""}  relay:
${relay}
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
const SEND = (input = "") => `    type: messaging\n    mode: send\n    contract: ChildDone@1\n    recipient: { parent: true }\n${input ? `    input: ${input}\n` : ""}    transition: { next: { sent: done, failure: failed } }`;

test("WORKFLOW_ENDED_WHOLE_OUTPUT: a child's whole output that reaches a join, a message or the run's output warns at save", () => {
    // A join: each branch ends with the end message, the payload of a list receive, the output itself, or a states reference.
    for (const [output, contract, carry] of [
        ['"${input}"'], ['"${input.output}"'], ['{ result: "${states.collect.output}" }'], ['"${states.collect.output.output}"'],
        ['"${input}"', "[Progress@1, WorkflowEnded@1]"], ['"${input.payload}"', "[Progress@1, WorkflowEnded@1]"],
        ['"${input.payload.output}"', "[Progress@1, WorkflowEnded@1]"],
        ['"${input.result}"', "WorkflowEnded@1", '          carry: { child: "${states.launch.output.workflowId}" }\n'],
        ['{ child: "${input.carry.child}", ended: "${input.result.output}" }', "WorkflowEnded@1", '          carry: { child: "${states.launch.output.workflowId}" }\n'],
    ]) {
        const warned = wholeOutputWarnings(fanOutYaml({ output, contract, carry }));
        assert.equal(warned.length, 1, `${output} ${contract ?? ""}: ${JSON.stringify(warned)}`);
        assert.equal(warned[0].severity, "warning");
        assert.equal(warned[0].path, "states.fan.body.states.branch_done.output");
        assert.match(warned[0].message, /child's whole WorkflowEnded@1 output/);
        assert.match(warned[0].message, /parallel state 'fan'/);
        assert.match(warned[0].message, /256 KiB/);
        assert.match(warned[0].message, /full_output/);
    }
    // Named branches: each branch that ends with a whole output warns.
    const named = wholeOutputWarnings(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: named, version: "1.0.0" }
initial: fork
states:
  fork:
    type: parallel
    timeoutSeconds: 3600
    branches:
      left:
        initial: l_launch
        states:
          l_launch: { type: spawn, definition: child, transition: { next: { started: l_collect, failure: l_failed } } }
          l_collect:
            type: messaging
            mode: receive
            contract: WorkflowEnded@1
            wait: { seconds: 600 }
            transition: { next: { received: l_done, elapsed: l_failed, failure: l_failed } }
          l_done: { type: terminal, outcome: succeeded, output: "\${input}" }
          l_failed: { type: terminal, outcome: failed }
      right:
        initial: r_launch
        states:
          r_launch: { type: spawn, definition: child, transition: { next: { started: r_collect, failure: r_failed } } }
          r_collect:
            type: messaging
            mode: receive
            contract: WorkflowEnded@1
            wait: { seconds: 600 }
            transition: { next: { received: r_done, elapsed: r_failed, failure: r_failed } }
          r_done: { type: terminal, outcome: succeeded, output: { child: "\${states.r_collect.output}" } }
          r_failed: { type: terminal, outcome: failed }
    transition: { next: { joined: done, blocked: failed, timed_out: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`);
    assert.deepEqual(named.map(item => item.path), ["states.fork.branches.left.states.l_done.output", "states.fork.branches.right.states.r_done.output"]);

    // A send or request message: the end message as it arrived (no input), through a wait, or held whole in an input.
    for (const [yaml, path] of [
        [relayYaml(SEND()), "states.relay"],
        [relayYaml(SEND('"${input}"')), "states.relay.input"],
        [relayYaml(SEND('{ report: "${input.output}", id: "${input.workflowId}" }')), "states.relay.input"],
        [relayYaml(SEND(), { pause: true }), "states.relay"],
        [relayYaml(SEND('{ ended: "${states.collect.output}" }'), { pause: '{ note: "later" }' }), "states.relay.input"],
        [relayYaml("    type: messaging\n    mode: request\n    contract: Review@1\n    recipient: { parent: true }\n    timeoutSeconds: 600\n"
            + "    transition: { next: { responded: done, declined: done, failure: failed } }"), "states.relay"],
    ]) {
        const warned = wholeOutputWarnings(yaml);
        assert.equal(warned.length, 1, `${path}: ${JSON.stringify(warned)}\n${yaml}`);
        assert.equal(warned[0].path, path);
        assert.match(warned[0].message, /child's whole WorkflowEnded@1 output/);
        assert.match(warned[0].message, /16 KiB/);
        assert.match(warned[0].message, /full_output/);
    }

    // The run's output: two children's whole outputs together can pass its 256 KiB.
    const two = (output) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: two, version: "1.0.0" }
initial: launch1
states:
  launch1: { type: spawn, definition: child, transition: { next: { started: launch2, failure: failed } } }
  launch2: { type: spawn, definition: child, transition: { next: { started: c1, failure: failed } } }
  c1:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    from: "\${states.launch1.output.workflowId}"
    wait: { seconds: 600 }
    transition: { next: { received: c2, elapsed: failed, failure: failed } }
  c2:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    from: "\${states.launch2.output.workflowId}"
    wait: { seconds: 600 }
    transition: { next: { received: done, elapsed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: ${output} }
  failed: { type: terminal, outcome: failed }
`;
    const both = wholeOutputWarnings(two('{ first: "${states.c1.output}", second: "${input.output}" }'));
    assert.equal(both.length, 1, JSON.stringify(both));
    assert.equal(both[0].path, "states.done.output");
    assert.match(both[0].message, /2 children's whole WorkflowEnded@1 outputs/);
    assert.match(both[0].message, /256 KiB/);

    // Mapped down, every one of them is quiet.
    assert.deepEqual(wholeOutputWarnings(two('{ first: "${states.c1.output.outcome}", second: "${input.output}" }')), []);
});

test("WORKFLOW_ENDED_WHOLE_OUTPUT stays quiet when only part of the child's result is kept, or when the value cannot pass a limit", () => {
    // A join of branches that keep only what they need, or a part inside the output.
    for (const [output, contract, carry] of [
        ['"${input.outcome}"'], ['{ outcome: "${input.outcome}", id: "${input.workflowId}", run: "${input.runId}" }'],
        ['"${input.output.summary}"'], ['"${states.collect.output.status}"'], ['"${input.outputTruncated}"'],
        ['"${input.payload.outcome}"', "[Progress@1, WorkflowEnded@1]"], ['"${input.contract}"', "[Progress@1, WorkflowEnded@1]"],
        ['"${input.carry.child}"', "WorkflowEnded@1", '          carry: { child: "${states.launch.output.workflowId}" }\n'],
        ['"${input.result.outcome}"', "WorkflowEnded@1", '          carry: { child: "${states.launch.output.workflowId}" }\n'],
        // Another contract's message is not a child's end.
        ['"${input}"', "Progress@1"],
        // A list receive's state output may hold another contract's message: a states reference to it is left alone.
        ['"${states.collect.output}"', "[Progress@1, WorkflowEnded@1]"],
    ]) {
        assert.deepEqual(wholeOutputWarnings(fanOutYaml({ output, contract, carry })), [], `${output} ${contract ?? ""}`);
    }
    // At most one branch output can be joined: one item, or the first success.
    assert.deepEqual(wholeOutputWarnings(fanOutYaml({ output: '"${input}"', forEach: "[a]" })), []);
    assert.deepEqual(wholeOutputWarnings(fanOutYaml({ output: '"${input}"', join: "    join: { first: 1 }\n" })), []);
    // A message that keeps only part, a wait that maps it down, and a send entered from the receive's elapsed route.
    assert.deepEqual(wholeOutputWarnings(relayYaml(SEND('{ outcome: "${input.outcome}", id: "${input.workflowId}" }'))), []);
    assert.deepEqual(wholeOutputWarnings(relayYaml(SEND(), { pause: '{ outcome: "${input.outcome}" }' })), []);
    const elapsed = relayYaml(SEND()).replace("received: relay, elapsed: failed", "received: done, elapsed: relay");
    assert.deepEqual(wholeOutputWarnings(elapsed), []);
    // One child's whole output fits the run's output: the child-dispatch pattern (terminal output "${input}") is quiet.
    assert.deepEqual(wholeOutputWarnings(relayYaml('    type: terminal\n    outcome: succeeded\n    output: "${input}"')), []);
    assert.deepEqual(wholeOutputWarnings(relayYaml('    type: terminal\n    outcome: succeeded\n    output: { ended: "${input}", child: "${states.collect.output.workflowId}" }')), []);
    // The same child named twice is still one output.
    assert.deepEqual(wholeOutputWarnings(relayYaml('    type: terminal\n    outcome: succeeded\n    output: { whole: "${input}", again: "${states.collect.output}" }')), []);
    // Named branches: one branch with a child's whole output beside small ones joins at most one of them.
    assert.deepEqual(wholeOutputWarnings(`
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: one-big-branch, version: "1.0.0" }
initial: fork
states:
  fork:
    type: parallel
    timeoutSeconds: 3600
    branches:
      big:
        initial: b_launch
        states:
          b_launch: { type: spawn, definition: child, transition: { next: { started: b_collect, failure: b_failed } } }
          b_collect:
            type: messaging
            mode: receive
            contract: WorkflowEnded@1
            wait: { seconds: 600 }
            transition: { next: { received: b_done, elapsed: b_failed, failure: b_failed } }
          b_done: { type: terminal, outcome: succeeded, output: "\${input}" }
          b_failed: { type: terminal, outcome: failed }
      small:
        initial: s_wait
        states:
          s_wait: { type: wait, seconds: 5, transition: { next: { elapsed: s_done } } }
          s_done: { type: terminal, outcome: succeeded, output: { note: "small" } }
    transition: { next: { joined: done, blocked: failed, timed_out: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`), []);
});
