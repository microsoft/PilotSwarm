/**
 * Workflow Simplified A1, O3 and nesting words (spec 14; E4, O3):
 * - a session inside a Workflow (an agent state's subtree, by its stored lineage) gets no definition tools: they are
 *   not declared, and the handlers refuse them in words (the server's lineage check is in
 *   test/local/workflow-a1-refusal.test.js);
 * - the nesting limit stays (WORKFLOW_MAX_DESCENDANT_LEVEL = 3) and each refusal says it in words;
 * - the runtime base guidance tells every session to hand prescriptive work to a Workflow (O3).
 *
 * Run: node --test test/unit/workflow-simplified-a1.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    spawnNesting, spawnNestingRefusal, WORKFLOW_DEFINITION_TOOLS, WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT, WORKFLOW_DEFINITION_TOOLS_REFUSED,
    WORKFLOW_MAX_DESCENDANT_LEVEL, workflowDefinitionToolsRefusal, workflowDefinitionToolsRefused,
} from "../../dist/workflow/input-policy.js";
import { createWorkflowAgentNodeHost } from "../../dist/workflow/agent-host.js";
import { WORKFLOW_SESSION_GUIDANCE } from "../../dist/workflow/guidance.js";
import { ManagedSession } from "../../dist/managed-session.js";
import { spawnWorkflowFromTool } from "../../dist/workflow/spawn.js";

const ROOT = { childSessionId: "C", nodeExecutionId: "nx-1", workflowSessionId: "W", controllingSessionId: "P", distance: 0 };

test("inside a Workflow is decided by the stored lineage: an agent state's child and its sub-agents", () => {
    assert.equal(workflowDefinitionToolsRefused({ sessionId: "C", level: 2, agentRoot: ROOT }), true);
    assert.equal(workflowDefinitionToolsRefused({ sessionId: "G", level: 3, agentRoot: { ...ROOT, distance: 1 } }), true);
    assert.equal(workflowDefinitionToolsRefused({ sessionId: "S", level: 1, agentRoot: null }), false, "an ordinary sub-agent keeps them (O3)");
    assert.equal(workflowDefinitionToolsRefused(null), false);
    assert.equal(workflowDefinitionToolsRefused(undefined), false);
});

test("the refusal in words: the tools' JSON refusal with its code", () => {
    assert.equal(WORKFLOW_DEFINITION_TOOLS_REFUSED, "WORKFLOW_DEFINITION_TOOLS_REFUSED");
    assert.match(WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT, /^Sessions inside a Workflow cannot create or change workflow definitions\. /);
    assert.deepEqual(JSON.parse(workflowDefinitionToolsRefusal()),
        { ok: false, error: { code: WORKFLOW_DEFINITION_TOOLS_REFUSED, message: WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT } });
});

test("spawn_workflow refuses before anything else when its caller is inside a Workflow; elsewhere it runs as before", async () => {
    const deps = (refused) => ({
        parentSessionId: "C", enabled: () => true, definitionToolsRefused: async () => refused,
        resolveOwner: async () => { throw new Error("not reached"); },
        captureToolBinding: async () => { throw new Error("not reached"); },
        workflowHost: async () => { throw new Error("not reached"); },
    });
    const older = "apiVersion: pilotswarm.dev/v1alpha1\nkind: Workflow\nmetadata: { name: x, version: 1.0.0 }\n";
    const yaml = "apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: x, version: \"1.0.0\" }\ninitial: done\nstates:\n  done: { type: terminal, outcome: succeeded }\n";
    // Inside a Workflow every document gets the same refusal, whatever its apiVersion.
    assert.equal(await spawnWorkflowFromTool({ yaml: older }, { toolCallId: "t" }, deps(true)), workflowDefinitionToolsRefusal());
    assert.equal(await spawnWorkflowFromTool({ yaml }, { toolCallId: "t" }, deps(true)), workflowDefinitionToolsRefusal());
    assert.equal(JSON.parse(await spawnWorkflowFromTool({ yaml: older }, { toolCallId: "t" }, deps(false))).error.code, "WORKFLOW_API_VERSION");
    // A lineage that cannot be read refuses the call (fail closed), coded, with its sanitized reason.
    const failing = { ...deps(false), definitionToolsRefused: async () => { throw new Error("connection refused"); } };
    const answer = JSON.parse(await spawnWorkflowFromTool({ yaml }, { toolCallId: "t" }, failing));
    assert.equal(answer.ok, false);
    assert.equal(typeof answer.error.code, "string");
});

test("the model is declared no definition tools inside a Workflow, and keeps every other tool (A5)", () => {
    const names = defs => defs.map(def => def.name);
    for (const opts of [{}, { workflowMilestone: true }, { workflowMilestone: true, workflowAgentChild: true }]) {
        const outside = names(ManagedSession.subAgentToolDefs(opts));
        const inside = names(ManagedSession.subAgentToolDefs({ ...opts, workflowInsideWorkflow: true }));
        for (const tool of WORKFLOW_DEFINITION_TOOLS) {
            // spawn_workflow is no longer declared anywhere (owner 2026-11-08T16:55Z); its handler refuses inside a Workflow.
            assert.equal(outside.includes(tool), tool !== "spawn_workflow", tool);
            assert.ok(!inside.includes(tool), tool);
        }
        assert.deepEqual(inside, outside.filter(name => !WORKFLOW_DEFINITION_TOOLS.includes(name)));
        assert.ok(inside.includes("read_workflow") && inside.includes("send_workflow_input") && inside.includes("spawn_agent"));
    }
});

test("nesting refusals keep the limit and say it in words; ordinary sessions keep their refusal as it was", () => {
    assert.equal(WORKFLOW_MAX_DESCENDANT_LEVEL, 3);
    assert.equal(spawnNestingRefusal(2, 2, false),
        "[SYSTEM: spawn_agent failed — you are already at nesting level 2 (max 2). Sub-agents at this depth cannot spawn further sub-agents. Handle the task directly instead.]");
    const inside = spawnNestingRefusal(3, 3, true);
    assert.match(inside, /^\[SYSTEM: spawn_agent failed — this session runs inside a Workflow at level 3 \(the top-level chat is level 0\), /);
    assert.match(inside, /sessions inside a Workflow stop at level 3\. A sub-agent would be at level 4\. Do this work yourself\.\]$/);
    // An agent node's chat at level 2 may still spawn one level; its sub-agent at level 3 may not.
    assert.deepEqual(spawnNesting(0, 2, { sessionId: "C", level: 2, agentRoot: ROOT }), { childNestingLevel: 3, maxNestingLevel: 3 });
    assert.deepEqual(spawnNesting(0, 2, { sessionId: "G", level: 3, agentRoot: { ...ROOT, distance: 1 } }), { childNestingLevel: 4, maxNestingLevel: 3 });
});

test("an agent node too deep is refused in words naming its node and the levels", async () => {
    const rows = { A: { parentSessionId: null }, B: { parentSessionId: "A" }, C: { parentSessionId: "B" }, D: { parentSessionId: "C" } };
    const host = createWorkflowAgentNodeHost({
        getSession: async id => rows[id] ?? null, resolveAgent: async () => null, createChild: async () => { throw new Error("not reached"); },
    });
    const answer = await host.spawn({ workflowSessionId: "D", childSessionId: "X", stateId: "summarize", controllingSessionId: "C",
        prompt: "p", clientMessageId: "m", task: { source: "prompt", prompt: "p" } });
    assert.equal(answer.refused.code, "forbidden");
    assert.equal(answer.refused.message, "Node summarize cannot start its agent: its chat would be at level 4 (the top-level chat is level 0), "
        + "and sessions inside a Workflow stop at level 3. Start this Workflow from a session nearer the top.");
});

test("the base guidance hands prescriptive work to a Workflow (O3)", () => {
    for (const phrase of [
        "For prescriptive or repetitive work that needs little judgment, write a Workflow Definition and start a Workflow instead of doing each step yourself.",
        "It runs without model turns, except at the agent nodes that need judgment.",
        "Do one-off work directly, or spawn sub-agents when that fits better.",
    ]) {
        assert.ok(WORKFLOW_SESSION_GUIDANCE.includes(phrase), phrase);
    }
    assert.ok(WORKFLOW_SESSION_GUIDANCE.indexOf("prescriptive or repetitive") < WORKFLOW_SESSION_GUIDANCE.indexOf("`workflow_definition`"));
});
