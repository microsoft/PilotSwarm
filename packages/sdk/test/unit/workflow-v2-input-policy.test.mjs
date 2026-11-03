/**
 * Workflow v2 agent states, inactive: the human-input policy and the depth
 * rule of an agent state's subtree (workflow/v2/input-policy.ts; design 03
 * human-input denial and depth; R12 to R14, R16), over a fake lineage store.
 *
 * - Input stamped as an agent's passes without a lineage read; a person's to
 *   a session in an agent state's subtree is refused with 403
 *   WORKFLOW_HUMAN_INPUT_DENIED, naming the workflow and its controlling
 *   agent; a person's to any other session, or with no workflow store, passes.
 * - The capabilities say the same for prompts, answers and steers.
 * - A spawn in the subtree counts the stored level, up to level 3; elsewhere
 *   the session's own nesting level and the ordinary limit, as before.
 *
 * Run: node --test test/unit/workflow-v2-input-policy.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    assertWorkflowHumanInputAllowed, isAgentInput, spawnNesting, workflowInputCapabilities, workflowMaxNestingLevel,
    WORKFLOW_ASK_USER_REFUSAL, WORKFLOW_HUMAN_INPUT_DENIED, WORKFLOW_V2_MAX_DESCENDANT_LEVEL,
} from "../../dist/workflow/v2/input-policy.js";

const ROOT = { childSessionId: "C", nodeExecutionId: "nx-1", workflowSessionId: "W", controllingSessionId: "P", distance: 0 };
const LINEAGES = {
    P: { sessionId: "P", level: 0, agentRoot: null },
    C: { sessionId: "C", level: 2, agentRoot: ROOT },
    G: { sessionId: "G", level: 3, agentRoot: { ...ROOT, distance: 1 } },
    lost: { sessionId: "lost", level: null, agentRoot: ROOT },
};

function store() {
    const reads = [];
    return { reads, readWorkflowLineage: async id => { reads.push(id); return LINEAGES[id] ?? null; } };
}

test("a person's input to an agent state's subtree is refused; an agent's passes unread; other sessions and no store pass", async () => {
    const s = store();
    for (const [id, action] of [["C", "prompt"], ["G", "steer"], ["lost", "answer"]]) {
        await assert.rejects(assertWorkflowHumanInputAllowed(s, id, action, { kind: "user", provider: "p", subject: "alice" }), error => {
            assert.equal(error.code, WORKFLOW_HUMAN_INPUT_DENIED);
            assert.equal(error.status, 403);
            assert.deepEqual(error.details, { sessionId: id, action, workflowSessionId: "W", nodeExecutionId: "nx-1", controllingSessionId: "P" });
            assert.match(error.message, /workflow W/);
            assert.match(error.message, /session P/);
            return true;
        });
    }
    // No sender is a person's input too.
    await assert.rejects(assertWorkflowHumanInputAllowed(s, "C", "event"), { code: WORKFLOW_HUMAN_INPUT_DENIED });
    // The agent stamp (which only a host sets: the portal stamps every caller as a user) passes without a read.
    s.reads.length = 0;
    await assertWorkflowHumanInputAllowed(s, "C", "prompt", { kind: "agent", sessionId: "P" });
    assert.deepEqual(s.reads, []);
    assert.equal(isAgentInput({ kind: "agent", sessionId: "P" }), true);
    assert.equal(isAgentInput({ kind: "user", provider: "p", subject: "a" }), false);
    assert.equal(isAgentInput({ kind: "robot" }), false);
    assert.equal(isAgentInput(null), false);
    await assertWorkflowHumanInputAllowed(s, "P", "prompt");
    await assertWorkflowHumanInputAllowed(s, "missing", "prompt");
    await assertWorkflowHumanInputAllowed(null, "C", "prompt");
});

test("capabilities refuse prompts, answers and steers only in an agent state's subtree", () => {
    assert.deepEqual(workflowInputCapabilities(LINEAGES.P),
        { canSendPrompt: true, canAnswer: true, canSteer: true, reason: null, workflowSessionId: null, controllingSessionId: null });
    assert.deepEqual(workflowInputCapabilities(null).canSendPrompt, true);
    const denied = workflowInputCapabilities(LINEAGES.G);
    assert.deepEqual([denied.canSendPrompt, denied.canAnswer, denied.canSteer, denied.workflowSessionId, denied.controllingSessionId],
        [false, false, false, "W", "P"]);
    assert.match(denied.reason, /runs a step of a workflow/);
    assert.match(WORKFLOW_ASK_USER_REFUSAL, /needs_input/);
});

test("a spawn in an agent state's subtree counts its stored level up to level 3; elsewhere the ordinary rule is unchanged", () => {
    assert.equal(WORKFLOW_V2_MAX_DESCENDANT_LEVEL, 3);
    assert.equal(workflowMaxNestingLevel(LINEAGES.C), 3);
    assert.equal(workflowMaxNestingLevel(LINEAGES.P), null);
    // An agent state's child at level 2 may spawn its child at level 3, whatever nesting level it was given.
    assert.deepEqual(spawnNesting(0, 2, LINEAGES.C), { childNestingLevel: 3, maxNestingLevel: 3 });
    // That child may not spawn.
    const deepest = spawnNesting(1, 2, LINEAGES.G);
    assert.deepEqual(deepest, { childNestingLevel: 4, maxNestingLevel: 3 });
    assert.ok(deepest.childNestingLevel > deepest.maxNestingLevel);
    // An unreadable level in the subtree, and every ordinary lineage, keep the ordinary rule.
    assert.deepEqual(spawnNesting(2, 2, LINEAGES.lost), { childNestingLevel: 3, maxNestingLevel: 2 });
    assert.deepEqual(spawnNesting(1, 2, LINEAGES.P), { childNestingLevel: 2, maxNestingLevel: 2 });
    assert.deepEqual(spawnNesting(2, 2, null), { childNestingLevel: 3, maxNestingLevel: 2 });
});
