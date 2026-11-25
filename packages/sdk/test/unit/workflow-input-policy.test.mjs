/**
 * Workflow agent states, inactive: the human-input policy and the depth
 * rule of an agent state's subtree (workflow/input-policy.ts; design 03
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
 * Run: node --test test/unit/workflow-input-policy.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    assertWorkflowHumanInputAllowed, computeSessionLevel, isAgentInput, SESSION_MAX_NESTING_LEVEL, spawnNesting, workflowInputCapabilities,
    WORKFLOW_ASK_USER_REFUSAL, WORKFLOW_HUMAN_INPUT_DENIED,
} from "../../dist/workflow/input-policy.js";

const ROOT = { childSessionId: "C", nodeExecutionId: "nx-1", workflowSessionId: "W", controllingSessionId: "P", distance: 0 };
const LINEAGES = {
    P: { sessionId: "P", level: 0, agentRoot: null },
    C: { sessionId: "C", level: 1, agentRoot: ROOT },
    G: { sessionId: "G", level: 2, agentRoot: { ...ROOT, distance: 1 } },
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

test("T1 & T2: level rule computes every chain in section 7.5 and caps every session at level 2", () => {
    assert.equal(SESSION_MAX_NESTING_LEVEL, 2);
    const chain = (specs) => {
        const nodes = specs.map((spec, i) => ({
            sessionId: spec[0], parentSessionId: i === 0 ? null : specs[i - 1][0], isAgentStep: Boolean(spec[1]),
        }));
        return nodes.reverse();
    };
    // 1. Chat, sub-agent, sub-agent -> 0, 1, 2
    assert.equal(computeSessionLevel(chain([["chat"]])), 0);
    assert.equal(computeSessionLevel(chain([["chat"], ["s1"]])), 1);
    assert.equal(computeSessionLevel(chain([["chat"], ["s1"], ["s2"]])), 2);
    // 2. Chat, Workflow, agent step, sub-agent -> 0, 1, 1, 2
    assert.equal(computeSessionLevel(chain([["chat"], ["wf1"]])), 1);
    assert.equal(computeSessionLevel(chain([["chat"], ["wf1"], ["step1", true]])), 1);
    assert.equal(computeSessionLevel(chain([["chat"], ["wf1"], ["step1", true], ["sub"]])), 2);
    // 3. Chat, sub-agent, Workflow, agent step -> 0, 1, 2, 2
    assert.equal(computeSessionLevel(chain([["chat"], ["s1"], ["wf2"]])), 2);
    assert.equal(computeSessionLevel(chain([["chat"], ["s1"], ["wf2"], ["step2", true]])), 2);
    // 4. Chat, Workflow, child Workflow, agent step -> 0, 1, 2, 2
    assert.equal(computeSessionLevel(chain([["chat"], ["wf1"], ["wf2"]])), 2);
    assert.equal(computeSessionLevel(chain([["chat"], ["wf1"], ["wf2"], ["step2", true]])), 2);
    // 5. Chat, Workflow, child Workflow, child Workflow -> 3 (refused)
    assert.equal(computeSessionLevel(chain([["chat"], ["wf1"], ["wf2"], ["wf3"]])), 3);
    // 6. Chat, sub-agent, Workflow, child Workflow -> 3 (refused)
    assert.equal(computeSessionLevel(chain([["chat"], ["s1"], ["wf2"], ["wf3"]])), 3);
    // Empty, missing root, or cyclic -> null
    assert.equal(computeSessionLevel([]), null);
    assert.equal(computeSessionLevel([{ sessionId: "orphan", parentSessionId: "missing" }]), null);
    assert.equal(computeSessionLevel([{ sessionId: "x", parentSessionId: "y" }, { sessionId: "y", parentSessionId: "x" }]), null);

    // T2: agent step of a level-1 Workflow (level 1) may spawn a sub-agent (level 2 <= 2); its sub-agent (level 2) may not (level 3 > 2).
    assert.deepEqual(spawnNesting(0, 2, LINEAGES.C), { childNestingLevel: 2, maxNestingLevel: 2 });
    const deepest = spawnNesting(1, 2, LINEAGES.G);
    assert.deepEqual(deepest, { childNestingLevel: 3, maxNestingLevel: 2 });
    assert.ok(deepest.childNestingLevel > deepest.maxNestingLevel);
    // Agent step of a level-2 child Workflow (level 2) cannot spawn a sub-agent (level 3 > 2).
    const childWfStep = spawnNesting(2, 2, { sessionId: "C2", level: 2, agentRoot: { ...ROOT, childSessionId: "C2", workflowSessionId: "W2" } });
    assert.deepEqual(childWfStep, { childNestingLevel: 3, maxNestingLevel: 2 });
    // An unreadable level in the subtree, and every ordinary lineage, keep the ordinary rule.
    assert.deepEqual(spawnNesting(2, 2, LINEAGES.lost), { childNestingLevel: 3, maxNestingLevel: 2 });
    assert.deepEqual(spawnNesting(1, 2, LINEAGES.P), { childNestingLevel: 2, maxNestingLevel: 2 });
    assert.deepEqual(spawnNesting(2, 2, null), { childNestingLevel: 3, maxNestingLevel: 2 });
});
