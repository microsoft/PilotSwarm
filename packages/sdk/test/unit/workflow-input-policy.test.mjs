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
    assertWorkflowHumanInputAllowed, computeSessionLevel, effectiveChildLevel, effectiveLevel, effectiveLevelDetail, isAgentInput,
    SESSION_MAX_NESTING_LEVEL, spawnNesting, spawnNestingRefusal, spawnNestingRefusalReason, workflowInputCapabilities,
    WORKFLOW_ASK_USER_REFUSAL, WORKFLOW_HUMAN_INPUT_DENIED,
} from "../../dist/workflow/input-policy.js";
import { registerActivities } from "../../dist/session-proxy.js";
import { handleSubAgentAction } from "../../dist/orchestration/agents.js";
import { WorkflowStore } from "../../dist/workflow/store.js";

const ROOT = { childSessionId: "C", nodeExecutionId: "nx-1", workflowSessionId: "W", controllingSessionId: "P", distance: 0 };
const LINEAGES = {
    P: { sessionId: "P", level: 0, hasWorkflow: false, agentRoot: null },
    C: { sessionId: "C", level: 0, hasWorkflow: true, agentRoot: ROOT },
    G: { sessionId: "G", level: 1, hasWorkflow: true, agentRoot: { ...ROOT, distance: 1 } },
    G2: { sessionId: "G2", level: 2, hasWorkflow: true, agentRoot: { ...ROOT, distance: 2 } },
    lost: { sessionId: "lost", level: null, hasWorkflow: true, agentRoot: ROOT },
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

function buildChain(specs) {
    // specs: Array<{ id, isWorkflow?, isSystem?, isAgentStep? }> ordered root-to-leaf; returns leaf-to-root SessionLevelNode[].
    const nodes = specs.map((spec, i) => ({
        sessionId: spec.id,
        parentSessionId: i === 0 ? null : specs[i - 1].id,
        isWorkflow: spec.isWorkflow === true,
        isSystem: spec.isSystem === true,
        ...(spec.isAgentStep ? { isAgentStep: true } : {}),
    }));
    return nodes.reverse();
}

test("I9: effectiveLevel computes first-Workflow-free chains and caps every session at level 2", () => {
    assert.equal(SESSION_MAX_NESTING_LEVEL, 2);
    assert.equal(computeSessionLevel, effectiveLevel);
    // 1. Chat, sub-agent, sub-agent -> 0, 1, 2 (unchanged without Workflow)
    assert.equal(effectiveLevel(buildChain([{ id: "chat" }])), 0);
    assert.equal(effectiveLevel(buildChain([{ id: "chat" }, { id: "s1" }])), 1);
    assert.equal(effectiveLevel(buildChain([{ id: "chat" }, { id: "s1" }, { id: "s2" }])), 2);
    // 2. Chat, Workflow, agent step, sub-agent, sub-agent -> 0, 0, 0, 1, 2
    assert.deepEqual(effectiveLevelDetail(buildChain([{ id: "chat" }, { id: "wf1", isWorkflow: true }])), { level: 0, hasWorkflow: true });
    assert.deepEqual(effectiveLevelDetail(buildChain([{ id: "chat" }, { id: "wf1", isWorkflow: true }, { id: "step1", isAgentStep: true }])),
        { level: 0, hasWorkflow: true });
    assert.equal(effectiveLevel(buildChain([{ id: "chat" }, { id: "wf1", isWorkflow: true }, { id: "step1", isAgentStep: true }, { id: "sub1" }])), 1);
    assert.equal(effectiveLevel(buildChain([{ id: "chat" }, { id: "wf1", isWorkflow: true }, { id: "step1", isAgentStep: true }, { id: "sub1" }, { id: "sub2" }])), 2);
    // 3. Chat, sub-agent, Workflow, agent step -> 0, 1, 1, 1
    assert.equal(effectiveLevel(buildChain([{ id: "chat" }, { id: "s1" }, { id: "wf2", isWorkflow: true }])), 1);
    assert.equal(effectiveLevel(buildChain([{ id: "chat" }, { id: "s1" }, { id: "wf2", isWorkflow: true }, { id: "step2", isAgentStep: true }])), 1);
    // 4. Chat, Workflow, child Workflow, agent step -> 0, 0, 1, 1
    assert.equal(effectiveLevel(buildChain([{ id: "chat" }, { id: "wf1", isWorkflow: true }, { id: "wf2", isWorkflow: true }])), 1);
    assert.equal(effectiveLevel(buildChain([{ id: "chat" }, { id: "wf1", isWorkflow: true }, { id: "wf2", isWorkflow: true }, { id: "step2", isAgentStep: true }])), 1);
    // 5. Chat, Workflow, child Workflow, child Workflow -> 2 (allowed); 4th Workflow -> 3 (refused)
    assert.equal(effectiveLevel(buildChain([{ id: "chat" }, { id: "wf1", isWorkflow: true }, { id: "wf2", isWorkflow: true }, { id: "wf3", isWorkflow: true }])), 2);
    assert.equal(effectiveLevel(buildChain([
        { id: "chat" }, { id: "wf1", isWorkflow: true }, { id: "wf2", isWorkflow: true }, { id: "wf3", isWorkflow: true }, { id: "wf4", isWorkflow: true },
    ])), 3);
    // 6. Chat, sub-agent, Workflow, child Workflow -> 2 (allowed); 3rd Workflow -> 3 (refused)
    assert.equal(effectiveLevel(buildChain([{ id: "chat" }, { id: "s1" }, { id: "wf2", isWorkflow: true }, { id: "wf3", isWorkflow: true }])), 2);
    assert.equal(effectiveLevel(buildChain([{ id: "chat" }, { id: "s1" }, { id: "wf2", isWorkflow: true }, { id: "wf3", isWorkflow: true }, { id: "wf4", isWorkflow: true }])), 3);
    // Empty, missing root, or cyclic -> null
    assert.equal(effectiveLevel([]), null);
    assert.equal(effectiveLevel([{ sessionId: "orphan", parentSessionId: "missing", isWorkflow: false, isSystem: false }]), null);
    assert.equal(effectiveLevel([
        { sessionId: "x", parentSessionId: "y", isWorkflow: false, isSystem: false },
        { sessionId: "y", parentSessionId: "x", isWorkflow: false, isSystem: false },
    ]), null);

    // spawnNesting uses lineage.level whenever lineage !== null, and fails closed when lineage.level === null even if sessionNestingLevel is 0.
    assert.deepEqual(spawnNesting(0, 2, LINEAGES.C), { childNestingLevel: 1, maxNestingLevel: 2 });
    assert.deepEqual(spawnNesting(0, 2, LINEAGES.G), { childNestingLevel: 2, maxNestingLevel: 2 });
    assert.deepEqual(spawnNesting(1, 2, LINEAGES.G2), { childNestingLevel: 3, maxNestingLevel: 2 });
    assert.deepEqual(spawnNesting(0, 2, LINEAGES.lost), { childNestingLevel: 3, maxNestingLevel: 2 });
    assert.deepEqual(spawnNesting(1, 2, LINEAGES.P), { childNestingLevel: 1, maxNestingLevel: 2 });
    assert.deepEqual(spawnNesting(2, 2, null), { childNestingLevel: 3, maxNestingLevel: 2 });
});

test("effectiveLevel and effectiveChildLevel match all 14 chains of Every chain, checked", () => {
    const P = { id: "person" };
    const sub = n => ({ id: `sub${n}` });
    const wf = n => ({ id: `wf${n}`, isWorkflow: true });
    const step = n => ({ id: `step${n}`, isAgentStep: true });

    const cases = [
        // [row, parentSpecs, childKind, expectedLevel, expectedAllowed]
        [1,  [P, sub(1)], "sub_agent", 2, true],                                           // example 1: person 0 -> sub 1 -> sub 2
        [2,  [P, sub(1), sub(2)], "sub_agent", 3, false],                                  // person 0 -> sub 1 -> sub 2 -> sub 3
        [3,  [P, wf(1), step(1)], "sub_agent", 1, true],                                   // person 0 -> W 1/0 -> step 1/0 -> sub 2/1
        [4,  [P, wf(1), step(1), sub(1)], "sub_agent", 2, true],                           // example 2: person 0 -> W 1/0 -> step 1/0 -> sub 2/1 -> sub 3/2
        [5,  [P, wf(1), step(1), sub(1), sub(2)], "sub_agent", 3, false],                  // -> sub 4/3
        [6,  [P, wf(1), wf(2)], "agent_step", 1, true],                                    // person 0 -> W 1/0 -> W 2/1 -> step 2/1
        [7,  [P, wf(1), wf(2), step(2)], "sub_agent", 2, true],                            // example 3 (I9): -> sub 3/2
        [8,  [P, wf(1), wf(2), step(2), sub(1)], "sub_agent", 3, false],                   // -> sub 4/3
        [9,  [P, sub(1), wf(1), step(1)], "sub_agent", 2, true],                           // person 0 -> sub 1 -> W 2/1 -> step 2/1 -> sub 3/2
        [10, [P, sub(1), wf(1), step(1), sub(2)], "sub_agent", 3, false],                  // -> sub 4/3
        [11, [P, wf(1), wf(2)], "workflow", 2, true],                                      // 3 nested Workflows
        [12, [P, sub(1), wf(1)], "workflow", 2, true],                                     // person -> sub 1 -> W 2/1 -> W 3/2
        [13, [P, sub(1), sub(2)], "workflow", 2, true],                                    // person -> sub 1 -> sub 2 -> W 3/2
        [14, [P, sub(1), sub(2), wf(1)], "workflow", 3, false],                            // person -> sub 1 -> sub 2 -> W 3/2 -> W 4/3
    ];
    for (const [row, parentSpecs, childKind, expectedLevel, expectedAllowed] of cases) {
        const parentDetail = effectiveLevelDetail(buildChain(parentSpecs));
        assert.ok(parentDetail !== null, `row ${row} parentDetail`);
        const proposed = effectiveChildLevel(parentDetail, childKind);
        assert.equal(proposed, expectedLevel, `row ${row} effectiveChildLevel`);
        assert.equal(proposed <= SESSION_MAX_NESTING_LEVEL, expectedAllowed, `row ${row} allowed`);

        const childSpec = childKind === "workflow"
            ? { id: "child", isWorkflow: true }
            : childKind === "agent_step"
                ? { id: "child", isAgentStep: true }
                : { id: "child" };
        assert.equal(effectiveLevel(buildChain([...parentSpecs, childSpec])), expectedLevel, `row ${row} full chain`);
    }
    // In rows 11, 12, 13, the level-2 Workflow's agent step sits at level 2 (allowed), and cannot spawn a sub-agent (3 -> refused).
    for (const wf3Specs of [
        [P, wf(1), wf(2), wf(3)],
        [P, sub(1), wf(1), wf(2)],
        [P, sub(1), sub(2), wf(1)],
    ]) {
        const wf3Detail = effectiveLevelDetail(buildChain(wf3Specs));
        assert.deepEqual(wf3Detail, { level: 2, hasWorkflow: true });
        assert.equal(effectiveChildLevel(wf3Detail, "agent_step"), 2);
        const stepDetail = effectiveLevelDetail(buildChain([...wf3Specs, step(3)]));
        assert.deepEqual(stepDetail, { level: 2, hasWorkflow: true });
        assert.equal(effectiveChildLevel(stepDetail, "sub_agent"), 3);
    }

    // Unverified-chain refusal applies to level === null for both insideWorkflow values.
    for (const inside of [false, true]) {
        const reason = spawnNestingRefusalReason(null, 2, inside);
        assert.equal(reason, "this session's delegation chain cannot be verified, and nothing goes past level 2. Do this work yourself.");
        assert.equal(spawnNestingRefusal(null, 2, inside), `[SYSTEM: spawn_agent failed — ${reason}]`);
    }
});

test("effectiveLevelDetail matches the owner level-table oracle across every legal delegation chain up to length 6, root Workflows, system resets, cycles, and depth > 32", () => {
    // Independent oracle of the owner's level table over a root-to-leaf spec list.
    // A system node resets the segment root to 0 only when it and EVERY ancestor above it are system.
    function oracle(specs) {
        let start = 0;
        for (let i = specs.length - 1; i >= 0; i -= 1) {
            if (specs[i].isSystem && specs.slice(0, i).every(anc => anc.isSystem)) {
                start = i;
                break;
            }
        }
        let level = 0;
        let hasWorkflow = Boolean(specs[start].isWorkflow && !specs[start].isSystem);
        for (let i = start + 1; i < specs.length; i += 1) {
            const kind = specs[i].kind;
            if (kind === "agent_step") {
                // same level as its Workflow (+0)
            } else if (kind === "workflow") {
                if (!hasWorkflow) hasWorkflow = true; // first Workflow in chain is free (+0)
                else level += 1; // any later Workflow is +1
            } else {
                level += 1; // sub-agent (including user-spawned system agent) is +1
            }
        }
        return { level, hasWorkflow };
    }

    // Allowed moves from each node role:
    // - person / sub_outside / system: sub_outside | workflow | system (user-spawned or platform system child)
    // - workflow: agent_step | workflow
    // - agent_step / sub_inside: sub_inside (Rule 5)
    const nextKinds = role => {
        if (role === "person" || role === "sub_outside" || role === "system") return ["sub_outside", "workflow", "system"];
        if (role === "workflow") return ["agent_step", "workflow"];
        return ["sub_inside"];
    };
    const makeSpec = (idx, role) => ({
        id: `n${idx}`,
        kind: role,
        isWorkflow: role === "workflow",
        isSystem: role === "system",
        isAgentStep: role === "agent_step",
    });

    let checked = 0;
    function walk(specs) {
        const expected = oracle(specs);
        const chain = buildChain(specs);
        assert.deepEqual(effectiveLevelDetail(chain), expected);
        assert.equal(effectiveLevel(chain), expected.level);
        checked += 1;

        if (specs.length >= 6) return;
        const lastRole = specs[specs.length - 1].kind;
        for (const role of nextKinds(lastRole)) {
            const childSpec = makeSpec(specs.length, role);
            const childKind = role === "workflow" ? "workflow" : role === "agent_step" ? "agent_step" : "sub_agent";
            // Platform system children of an all-system chain reset to 0; all other moves follow effectiveChildLevel.
            const childExpected = oracle([...specs, childSpec]);
            if (!(role === "system" && specs.every(s => s.isSystem))) {
                assert.equal(effectiveChildLevel(expected, childKind), childExpected.level);
            }
            walk([...specs, childSpec]);
        }
    }

    // 1. Every legal delegation chain up to length 6 starting from person, root Workflow, or system root.
    walk([makeSpec(0, "person")]);
    walk([makeSpec(0, "workflow")]);
    walk([makeSpec(0, "system")]);
    assert.ok(checked > 300, `expected exhaustive enumeration, checked=${checked}`);

    // Explicit root Workflow checks (parentSessionId === null, isWorkflow: true).
    assert.deepEqual(effectiveLevelDetail(buildChain([{ id: "rootWf", isWorkflow: true }])), { level: 0, hasWorkflow: true });
    assert.deepEqual(effectiveLevelDetail(buildChain([{ id: "rootWf", isWorkflow: true }, { id: "childWf", isWorkflow: true }])), { level: 1, hasWorkflow: true });

    // 2. Platform system sessions reset to level 0, hasWorkflow: false; user-spawned system agents (1 or 2 hops) stay in their chain (Q2).
    const sysHierarchy = [
        { id: "sysRoot", isWorkflow: false, isSystem: true },
        { id: "sysChild", isWorkflow: false, isSystem: true },
    ];
    assert.deepEqual(effectiveLevelDetail(buildChain(sysHierarchy)), { level: 0, hasWorkflow: false });
    assert.deepEqual(effectiveLevelDetail(buildChain([...sysHierarchy, { id: "sysWf", isWorkflow: true }])), { level: 0, hasWorkflow: true });
    assert.deepEqual(effectiveLevelDetail(buildChain([...sysHierarchy, { id: "s1" }, { id: "s2" }])), { level: 2, hasWorkflow: false });
    // User-spawned creatable system agent (1 hop or 2 consecutive system hops) under a non-system session does NOT reset depth (owner decision Q2).
    const userSpawnedSys = [
        { id: "p", isWorkflow: false, isSystem: false },
        { id: "sub1", isWorkflow: false, isSystem: false },
        { id: "sysChild", isWorkflow: false, isSystem: true },
    ];
    assert.deepEqual(effectiveLevelDetail(buildChain(userSpawnedSys)), { level: 2, hasWorkflow: false });
    assert.equal(effectiveChildLevel(effectiveLevelDetail(buildChain(userSpawnedSys)), "sub_agent"), 3);
    const twoUserSpawnedSys = [
        { id: "p", isWorkflow: false, isSystem: false },
        { id: "sysX", isWorkflow: false, isSystem: true },
        { id: "sysY", isWorkflow: false, isSystem: true },
    ];
    assert.deepEqual(effectiveLevelDetail(buildChain(twoUserSpawnedSys)), { level: 2, hasWorkflow: false });
    assert.deepEqual(effectiveLevelDetail(buildChain([...twoUserSpawnedSys, { id: "sub" }])), { level: 3, hasWorkflow: false });
    // Platform system session whose parent was pruned (parentSessionId still non-null, not in chain) still terminates as segment root.
    assert.deepEqual(effectiveLevelDetail([
        { sessionId: "child", parentSessionId: "sys", isWorkflow: false, isSystem: false },
        { sessionId: "sys", parentSessionId: "pruned-parent", isWorkflow: false, isSystem: true },
    ]), { level: 1, hasWorkflow: false });

    // 3. Cycles return null.
    assert.equal(effectiveLevelDetail([
        { sessionId: "a", parentSessionId: "b", isWorkflow: false, isSystem: false },
        { sessionId: "b", parentSessionId: "c", isWorkflow: true, isSystem: false },
        { sessionId: "c", parentSessionId: "a", isWorkflow: false, isSystem: false },
    ]), null);

    // 4. Chain deeper than WORKFLOW_LINEAGE_MAX_DEPTH (32) truncated before reaching root -> null.
    const deepTruncated = [];
    for (let i = 0; i <= 33; i += 1) {
        deepTruncated.push({ sessionId: `d${i}`, parentSessionId: `d${i + 1}`, isWorkflow: false, isSystem: false });
    }
    assert.equal(effectiveLevelDetail(deepTruncated), null);
});

test("I9 Check 4: captureSpawnToolsV1 enforces stored-chain effectiveLevel before warm/cold capture and feeds handleSubAgentAction without orchestration edits", async () => {
    async function runFallbackSpawn({ lineage, runtimeNestingLevel = 1 }) {
        const handlers = new Map();
        let captureCalls = 0;
        let spawnCalls = 0;
        const fakeManager = {
            captureSpawnTools: async () => { captureCalls += 1; return { toolCeiling: [] }; },
            getSessionStateDir: () => "/tmp",
            getWorkspaceProvider: () => null,
        };
        const fakeCatalog = {
            workflowStore: () => ({ readWorkflowLineage: async () => lineage }),
        };
        registerActivities(
            { registerActivity: (name, handler) => handlers.set(name, handler) },
            fakeManager, null, undefined, fakeCatalog, undefined, "in-memory://check4",
            undefined, undefined, [], null, [], [],
        );
        const captureHandler = handlers.get("captureSpawnToolsV1");
        assert.equal(typeof captureHandler, "function");

        const spawnedLevels = [];
        const runtime = {
            ctx: {
                traceInfo() {},
                utcNow: () => ({ __eff: "utcNow" }),
            },
            input: { sessionId: "parent-s1" },
            options: { nestingLevel: runtimeNestingLevel },
            state: {
                subAgents: [],
                config: { model: "fixture:m" },
                transcriptEpoch: 0,
                workspaceRevision: 0,
                iteration: 1,
                pendingPrompt: null,
                pendingCustomStatus: null,
            },
            session: {
                captureSpawnTools: (childConfig, grant, tools, agent, legacyToolNames, parentContext) => ({
                    __eff: "captureSpawnToolsV1",
                    input: { parentSessionId: "parent-s1", childConfig, grant, tools, agent, legacyToolNames, parentContext },
                }),
            },
            manager: {
                resolveAgentDefinition: () => ({ __eff: "resolveAgentDefinition" }),
                spawnChildSession: (_parent, _cfg, _task, childNestingLevel) => ({ __eff: "spawnChildSession", childNestingLevel }),
                recordSessionEvent: () => ({ __eff: "recordSessionEvent" }),
            },
        };
        const gen = handleSubAgentAction(runtime, { type: "spawn_agent", task: "review code" });
        let step = gen.next();
        while (!step.done) {
            const eff = step.value;
            if (eff?.__eff === "captureSpawnToolsV1") {
                try {
                    const res = await captureHandler({ traceInfo() {} }, eff.input);
                    step = gen.next(res);
                } catch (err) {
                    step = gen.throw(err);
                }
            } else if (eff?.__eff === "spawnChildSession") {
                spawnCalls += 1;
                spawnedLevels.push(eff.childNestingLevel);
                step = gen.next("child-created-1");
            } else if (eff?.__eff === "utcNow") {
                step = gen.next(Date.now());
            } else if (eff?.__eff === "recordSessionEvent") {
                step = gen.next(undefined);
            } else {
                step = gen.next(null);
            }
        }
        return { captureCalls, spawnCalls, spawnedLevels, pendingPrompt: runtime.state.pendingPrompt };
    }

    // (a) Chain #7: level-1 child-Workflow agent step succeeds at childNestingLevel = 2.
    const ok = await runFallbackSpawn({
        lineage: { sessionId: "parent-s1", level: 1, hasWorkflow: true, agentRoot: ROOT, deleted: false },
        runtimeNestingLevel: 1,
    });
    assert.equal(ok.captureCalls, 1);
    assert.equal(ok.spawnCalls, 1);
    assert.deepEqual(ok.spawnedLevels, [2]);

    // (b) Chain #8: level-2 Workflow/step is refused BEFORE captureSpawnTools (even if warm or runtimeNestingLevel was stale 1)
    // and handleSubAgentAction queues the refusal prompt without calling spawnChildSession.
    const refused = await runFallbackSpawn({
        lineage: { sessionId: "parent-s1", level: 2, hasWorkflow: true, agentRoot: ROOT, deleted: false },
        runtimeNestingLevel: 1,
    });
    assert.equal(refused.captureCalls, 0, "must refuse at top of captureSpawnToolsV1 before warm capture");
    assert.equal(refused.spawnCalls, 0, "spawnChildSession must not be called");
    assert.match(String(refused.pendingPrompt), /^spawn_agent failed: this session is at level 2, and nothing goes past level 2 /);
    assert.match(String(refused.pendingPrompt), /A sub-agent here would be at level 3\. Do this work yourself\.$/);

    // (c) Missing (null) or broken (level: null) stored lineage fails closed with unverified-chain text.
    for (const badLineage of [null, { sessionId: "parent-s1", level: null, hasWorkflow: false, agentRoot: null, deleted: false }]) {
        const failClosed = await runFallbackSpawn({ lineage: badLineage, runtimeNestingLevel: 0 });
        assert.equal(failClosed.captureCalls, 0);
        assert.equal(failClosed.spawnCalls, 0);
        assert.equal(failClosed.pendingPrompt,
            "spawn_agent failed: this session's delegation chain cannot be verified, and nothing goes past level 2. Do this work yourself.");
    }
});

test("WorkflowStore.readWorkflowLineage pre-0088 fallback omits session_kind on 42P01 and 42703 (Phase 2 review S-1)", async () => {
    for (const pgCode of ["42P01", "42703"]) {
        const queries = [];
        const fakePool = {
            async query(sql) {
                queries.push(sql);
                if (queries.length === 1) {
                    const err = new Error(`pre-0088 missing relation/column (${pgCode})`);
                    err.code = pgCode;
                    throw err;
                }
                return {
                    rows: [
                        { session_id: "grandchild", parent_session_id: "child", is_system: false, distance: 0, deleted: false, node_execution_id: null, workflow_session_id: null, controlling_session_id: null },
                        { session_id: "child", parent_session_id: "root", is_system: false, distance: 1, deleted: false, node_execution_id: null, workflow_session_id: null, controlling_session_id: null },
                        { session_id: "root", parent_session_id: null, is_system: false, distance: 2, deleted: false, node_execution_id: null, workflow_session_id: null, controlling_session_id: null },
                    ],
                };
            },
        };
        const wfStore = new WorkflowStore(fakePool, "copilot_sessions");
        const lineage = await wfStore.readWorkflowLineage("grandchild");
        assert.equal(queries.length, 2, `expected fallback retry on ${pgCode}`);
        assert.ok(queries[0].includes("session_kind"), "primary query selects session_kind");
        assert.ok(!queries[1].includes("session_kind"), `fallback query on ${pgCode} must not reference session_kind`);
        assert.deepEqual(lineage, {
            sessionId: "grandchild",
            level: 2,
            hasWorkflow: false,
            agentRoot: null,
            deleted: false,
        });
    }
});
