/**
 * Workflow Simplified: an agent node that continues its agent session (owner decision agent-node-continue-20261106; YAML
 * key `session: new | continue`, renamed from `session` by the owner, 2026-11-09T06:30Z):
 * - the compiler accepts `session: new` (the IR carries no mode) and `session: continue` (the IR's `session` field carries
 *   it), refuses any other value, refuses `session: continue` inside a parallel (For each) body in words, and refuses the
 *   old key `session` saying what to write; a stored IR keeps it. Owner 2026-11-09T05:38Z: an agent state that sets no
 *   `session` continues (the IR carries `continue`) outside a parallel body, and gets a new session each visit inside one
 *   (a For each body or a named branch);
 * - the session ids are derived (one per run and state; a replacement names its visit) and a continued session is told apart
 *   from a visit's own;
 * - the first prompt of a continued session says it continues and asks for node_execution_id, the cycle prompt says
 *   "cycle N" with the variables now, which changed and the previous result, and a replacement session's first prompt says
 *   the earlier session ended; a session that does not continue gets the same first prompt as before;
 * - the graph shows the mode; the reminder names the cycle; the completion tool takes node_execution_id;
 * - the guidance every agent reads explains both modes and when to choose each (base guidance, both skills, the
 *   spawn_workflow and update_workflow descriptions).
 *
 * Run: node --test test/unit/workflow-simplified-session-continue.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compileWorkflow, parseWorkflowIr } from "../../dist/workflow/compiler.js";
import {
    describeWorkflowState, workflowAgentSessionContinues, workflowAgentSessionId, workflowAgentChildSessionId, workflowAgentCyclePrompt,
    workflowAgentPrompt,
} from "../../dist/workflow/runtime.js";
import { workflowAgentReminderText } from "../../dist/workflow/agent-reminder.js";
import { COMPLETE_WORKFLOW_NODE_TOOL_SPEC, workflowAgentCycleMemoryLostPrompt } from "../../dist/workflow/agent-node-service.js";
import { WORKFLOW_SESSION_GUIDANCE, WORKFLOW_SKILLS_DIR } from "../../dist/workflow/guidance.js";

const errors = result => result.diagnostics.filter(item => item.severity === "error");

const LOOP = agentSession => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: chatter, version: "1.0.0" }
initial: talk
states:
  talk:
    type: agent
    invoke: { prompt: "Tell one fact." }
${agentSession === undefined ? "" : `    session: ${agentSession}\n`}    timeoutSeconds: 60
    transition: { next: { again: pause, finish: done, failure: failed } }
  pause: { type: wait, seconds: 5, transition: { next: { elapsed: talk } } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const FOR_EACH = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: fan, version: "1.0.0" }
initialInput: { items: [1, 2] }
initial: fan
states:
  fan:
    type: parallel
    forEach: "\${input.items}"
    body:
      initial: talk
      states:
        talk:
          type: agent
          invoke: { prompt: "Tell one fact." }
          session: continue
          timeoutSeconds: 60
          transition: { next: { said: said_it, failure: gave_up } }
        said_it: { type: terminal, outcome: succeeded }
        gave_up: { type: terminal, outcome: blocked }
    transition: { next: { joined: done, blocked: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const BRANCHES = agentSession => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: lanes, version: "1.0.0" }
initial: fan
states:
  fan:
    type: parallel
    timeoutSeconds: 600
    branches:
      left:
        initial: left_talk
        states:
          left_talk:
            type: agent
            invoke: { prompt: "Tell one fact." }
${agentSession === undefined ? "" : `            session: ${agentSession}\n`}            timeoutSeconds: 60
            transition: { next: { said: left_done, failure: left_failed } }
          left_done: { type: terminal, outcome: succeeded }
          left_failed: { type: terminal, outcome: failed }
      right:
        initial: right_talk
        states:
          right_talk:
            type: agent
            invoke: { prompt: "Tell another fact." }
            timeoutSeconds: 60
            transition: { next: { said: right_done, failure: right_failed } }
          right_done: { type: terminal, outcome: succeeded }
          right_failed: { type: terminal, outcome: failed }
    transition: { next: { joined: sum_up, blocked: failed, timed_out: failed, failure: failed } }
  sum_up:
    type: agent
    invoke: { prompt: "Sum up." }
    timeoutSeconds: 60
    transition: { next: { done: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

test("the compiler: continue is the default where it is allowed and is carried; new leaves the IR without a mode; anything else is refused", () => {
    const plain = compileWorkflow(LOOP(undefined));
    const fresh = compileWorkflow(LOOP("new"));
    const continued = compileWorkflow(LOOP("continue"));
    for (const result of [plain, fresh, continued]) assert.deepEqual(errors(result), [], JSON.stringify(result.diagnostics));
    // Owner 2026-11-09T05:38Z: a loop's agent state that sets no session continues; its IR is the explicit continue's.
    assert.equal(plain.ir.nodes.talk.session, "continue");
    assert.equal(plain.irSha256, continued.irSha256);
    assert.equal(Object.hasOwn(fresh.ir.nodes.talk, "session"), false);
    assert.notEqual(continued.irSha256, fresh.irSha256);
    // A stored IR keeps the mode it was compiled with: absent is still new (a revision compiled before keeps it), and an
    // invalid stored value is refused.
    assert.equal(parseWorkflowIr(JSON.parse(JSON.stringify(continued.ir))).nodes.talk.session, "continue");
    assert.equal(Object.hasOwn(parseWorkflowIr(JSON.parse(JSON.stringify(fresh.ir))).nodes.talk, "session"), false);
    const bad = JSON.parse(JSON.stringify(continued.ir));
    bad.nodes.talk.session = "sometimes";
    assert.throws(() => parseWorkflowIr(bad), /stored IR agent state talk is invalid/);

    const wrong = compileWorkflow(LOOP("sometimes"));
    assert.deepEqual(errors(wrong).map(item => [item.code, item.path]), [["WORKFLOW_FIELD_INVALID", "states.talk.session"]]);
    assert.match(errors(wrong)[0].message, /^session must be continue \(one agent session across the state's visits, the default outside parallel states\) or new /);
});

test("the compiler: in a For each body or a named branch an agent state that sets no session gets a new session each visit", () => {
    const forEach = compileWorkflow(FOR_EACH.replace("          session: continue\n", ""));
    assert.deepEqual(errors(forEach), [], JSON.stringify(forEach.diagnostics));
    assert.equal(Object.hasOwn(forEach.ir.nodes.talk, "session"), false);
    assert.equal(forEach.irSha256, compileWorkflow(FOR_EACH.replace("session: continue", "session: new")).irSha256);
    const branches = compileWorkflow(BRANCHES(undefined));
    assert.deepEqual(errors(branches), [], JSON.stringify(branches.diagnostics));
    for (const id of ["left_talk", "right_talk"]) assert.equal(Object.hasOwn(branches.ir.nodes[id], "session"), false, id);
    // Outside the parallel state the same Workflow's agent state continues.
    assert.equal(branches.ir.nodes.sum_up.session, "continue");
    // I8: explicit continue inside a named branch is accepted (one continued session per run and state);
    // sibling states that omit session stay new, and explicit new is accepted.
    const branchContinue = compileWorkflow(BRANCHES("continue"));
    assert.deepEqual(errors(branchContinue), [], JSON.stringify(branchContinue.diagnostics));
    assert.equal(branchContinue.ir.nodes.left_talk.session, "continue");
    assert.equal(Object.hasOwn(branchContinue.ir.nodes.right_talk, "session"), false);
    assert.deepEqual(errors(compileWorkflow(BRANCHES("new"))), []);
});

test("the compiler refuses session: continue inside a For each body, in words", () => {
    const result = compileWorkflow(FOR_EACH);
    const refused = errors(result).filter(item => item.path === "states.fan.body.states.talk.session");
    assert.equal(refused.length, 1, JSON.stringify(result.diagnostics));
    assert.equal(refused[0].code, "WORKFLOW_FIELD_INVALID");
    assert.match(refused[0].message, /^state 'talk' cannot continue its agent session: it runs inside For each state 'fan', whose items run side by side and cannot share one agent session\. Use session: new\.$/);
    const fresh = compileWorkflow(FOR_EACH.replace("session: continue", "session: new"));
    assert.deepEqual(errors(fresh), [], JSON.stringify(fresh.diagnostics));
});

test("session ids are derived: one per run and state, another per run, a replacement names its visit; a continued session is told apart", () => {
    const agentSession = workflowAgentSessionId("run-1", "talk");
    assert.equal(workflowAgentSessionId("run-1", "talk"), agentSession);
    assert.match(agentSession, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(workflowAgentSessionId("run-2", "talk"), agentSession, "Run again starts a new session");
    assert.notEqual(workflowAgentSessionId("run-1", "other"), agentSession);
    const replacement = workflowAgentSessionId("run-1", "talk", 3);
    assert.notEqual(replacement, agentSession);
    assert.equal(workflowAgentSessionId("run-1", "talk", 3), replacement);
    assert.equal(workflowAgentSessionContinues({ nodeExecutionId: "nx-1", childSessionId: agentSession }), true);
    assert.equal(workflowAgentSessionContinues({ nodeExecutionId: "nx-1", childSessionId: replacement }), true);
    assert.equal(workflowAgentSessionContinues({ nodeExecutionId: "nx-1", childSessionId: workflowAgentChildSessionId("nx-1") }), false);
    // Known by the session mark in its id: any other child id (session: new, whatever it is) is a visit's own, handled as before.
    assert.match(agentSession, /-c0a7[0-9a-f]{8}$/);
    for (const other of ["child-1", workflowAgentChildSessionId("nx-2"), "8f1e2d3c-1111-8222-9333-444455556666"]) {
        assert.equal(workflowAgentSessionContinues({ nodeExecutionId: "nx-1", childSessionId: other }), false, other);
    }
});

const INVOCATION = {
    workflowSessionId: "wf", runId: "run-1", nodeExecutionId: "nx-2", stateId: "talk", controllingSessionId: "parent",
    task: { source: "prompt", prompt: "Tell one fact." }, input: { round: 2 }, inputSchema: null, outputSchema: null, outcomes: ["again", "finish"],
    schemas: {}, deadlineAt: "2026-11-06T03:00:00.000Z",
};
const CYCLE = { cycle: 2, previous: { outcome: "again", resultKind: "business", output: { fact: "one" }, error: null },
    variables: { topic: "postgres", limit: 60 }, changedVariables: ["topic"] };

test("the prompts: a continued session's first asks for node_execution_id; the cycle prompt says cycle N; a replacement says the earlier session ended", () => {
    const before = workflowAgentPrompt(INVOCATION);
    assert.ok(before.includes("The workflow cancels this session at the deadline."));
    assert.ok(!before.includes("node_execution_id"), "a session that does not continue gets the prompt it got before");
    assert.equal(workflowAgentPrompt({ ...INVOCATION, continues: false }), before);

    const first = workflowAgentPrompt({ ...INVOCATION, continues: true });
    const [system, json, , task] = first.split("\n");
    assert.ok(system.includes("This agent session continues: each later visit of this state in this run comes to this same session as a new cycle"));
    assert.ok(system.includes("Every completion must also give node_execution_id, the id of the cycle it finishes (this one's is nx-2)."));
    assert.ok(!system.includes("The workflow cancels this session at the deadline."));
    assert.equal(Object.hasOwn(JSON.parse(json), "cycle"), false);
    assert.equal(task, "Tell one fact.");

    const cycle = workflowAgentCyclePrompt({ ...INVOCATION, ...CYCLE });
    const [cycleSystem, cycleJson, cycleTaskLine, cycleTask] = cycle.split("\n");
    assert.match(cycleSystem, /^\[SYSTEM: WORKFLOW NODE INVOCATION, CYCLE 2\. This is cycle 2 of the same workflow state in this run, in this same agent session/);
    assert.ok(cycleSystem.includes("changedVariables names the variables that changed since your last cycle"));
    assert.ok(cycleSystem.includes("node_execution_id nx-2 (this cycle's)"));
    assert.deepEqual(JSON.parse(cycleJson), {
        cycle: 2, workflowSessionId: "wf", runId: "run-1", nodeExecutionId: "nx-2", stateId: "talk", controllingParentSessionId: "parent",
        input: { round: 2 }, inputSchema: null, variables: { topic: "postgres", limit: 60 }, changedVariables: ["topic"],
        previousResult: CYCLE.previous, outcomes: ["again", "finish"], outputSchema: null, schemas: {}, deadline: "2026-11-06T03:00:00.000Z",
    });
    assert.ok(cycleTaskLine.includes("The task of this state"));
    assert.equal(cycleTask, "Tell one fact.");

    const restarted = workflowAgentPrompt({ ...INVOCATION, continues: true, restart: { ...CYCLE, endedSessionId: "old-agent" } });
    const [restartSystem, restartJson] = restarted.split("\n");
    assert.ok(restartSystem.includes("This is cycle 2 of this state in this run. The agent session of its earlier cycles ended (session old-agent), "
        + "so this is a new agent session and their work is not here"));
    assert.deepEqual(JSON.parse(restartJson).changedVariables, ["topic"]);
    assert.deepEqual(JSON.parse(restartJson).previousResult, CYCLE.previous);
    assert.equal(JSON.parse(restartJson).cycle, 2);
});

test("a later cycle whose earlier cycles were lost after their report is told so instead of being told they are above (I1 D-2)", () => {
    const above = "in this same agent session: what you did in earlier cycles is above.";
    const cycle4 = workflowAgentCyclePrompt({ ...INVOCATION, ...CYCLE, cycle: 4 });
    assert.ok(cycle4.includes(above));
    // Nothing lost, only later cycles named, or a prompt without the words: unchanged.
    assert.equal(workflowAgentCycleMemoryLostPrompt(cycle4, 4, []), cycle4);
    assert.equal(workflowAgentCycleMemoryLostPrompt(cycle4, 4, [4, 5]), cycle4);
    const first = workflowAgentPrompt({ ...INVOCATION, continues: true });
    assert.equal(workflowAgentCycleMemoryLostPrompt(first, 2, [1]), first);

    const one = workflowAgentCycleMemoryLostPrompt(cycle4, 4, [3]);
    assert.ok(!one.includes(above));
    assert.ok(one.includes("in this same agent session. The conversation of cycle 3 is not available: it was lost after that cycle "
        + "reported its result, before it was saved, so it is not above."));
    assert.ok(one.includes("What you did in the other earlier cycles is above."));
    const two = workflowAgentCycleMemoryLostPrompt(cycle4, 4, [3, 1, 3]);
    assert.ok(two.includes("The conversation of cycles 1 and 3 is not available: it was lost after those cycles reported their result"));
    assert.ok(two.includes("What you did in the other earlier cycles is above."));
    const all = workflowAgentCycleMemoryLostPrompt(cycle4, 4, [1, 2, 3]);
    assert.ok(all.includes("The conversation of cycles 1, 2 and 3 is not available"));
    assert.ok(!all.includes("other earlier cycles"));
    // Only the system line changes: the JSON and the task stay as sent.
    assert.deepEqual(one.split("\n").slice(1), cycle4.split("\n").slice(1));
});

test("I7 re-run prompts: K+1 recap wording (singular/reused/supplied/mixed/omitted) + full previousResult, K+2 sentence, restart recap, and S7 lost-memory with pre-cut cycles", () => {
    // K=1 reused: singular wording, never "(1..1)", includes full previousResult + changedVariables + bounded rerunRecap.
    const k1Reused = workflowAgentPrompt({
        ...INVOCATION,
        continues: true,
        rerunRecap: {
            cycle: 2,
            count: 1,
            reusedCount: 1,
            suppliedCount: 0,
            omitted: 0,
            visits: [{ visit: 1, source: "reused", outcome: "again", resultKind: "business", output: { fact: "one" } }],
            variables: CYCLE.variables,
            changedVariables: ["topic"],
            previous: CYCLE.previous,
        },
    });
    const [k1Sys, k1Json] = k1Reused.split("\n");
    assert.ok(k1Sys.includes("Cycle 1 was reused from an earlier Workflow run."));
    assert.ok(!k1Sys.includes("(1..1)"));
    assert.ok(!k1Sys.includes("ran in a previous Workflow run"));
    const k1Parsed = JSON.parse(k1Json);
    assert.equal(k1Parsed.cycle, 2);
    assert.deepEqual(k1Parsed.previousResult, CYCLE.previous);
    assert.deepEqual(k1Parsed.changedVariables, ["topic"]);
    assert.deepEqual(k1Parsed.rerunRecap, {
        omitted: 0,
        visits: [{ visit: 1, source: "reused", outcome: "again", resultKind: "business", output: { fact: "one" } }],
    });

    // K=1 supplied: never says supplied cycle ran in a previous Workflow run!
    const k1Supplied = workflowAgentPrompt({
        ...INVOCATION,
        continues: true,
        rerunRecap: {
            cycle: 2,
            count: 1,
            reusedCount: 0,
            suppliedCount: 1,
            omitted: 0,
            visits: [{ visit: 1, source: "supplied", outcome: "again", resultKind: "business", output: { manual: true }, suppliedNote: "Operator override" }],
            variables: CYCLE.variables,
            changedVariables: [],
            previous: { outcome: "again", resultKind: "business", output: { manual: true }, error: null },
        },
    });
    const [k1SupSys] = k1Supplied.split("\n");
    assert.ok(k1SupSys.includes("Cycle 1's result was supplied by a person without running."));
    assert.ok(!k1SupSys.includes("ran in a previous Workflow run"));

    // K=2 mixed (cycle 1 reused, cycle 2 supplied): distinguishes reused vs supplied cleanly.
    const k2Mixed = workflowAgentPrompt({
        ...INVOCATION,
        continues: true,
        rerunRecap: {
            cycle: 3,
            count: 2,
            reusedCount: 1,
            suppliedCount: 1,
            omitted: 0,
            visits: [
                { visit: 1, source: "reused", outcome: "again", resultKind: "business", output: { n: 1 } },
                { visit: 2, source: "supplied", outcome: "again", resultKind: "business", output: { n: 2 }, suppliedNote: "Manual rescue" },
            ],
            variables: CYCLE.variables,
            changedVariables: ["topic"],
            previous: { outcome: "again", resultKind: "business", output: { n: 2 }, error: null },
        },
    });
    const [k2MixSys] = k2Mixed.split("\n");
    assert.ok(k2MixSys.includes("Cycle 1 was reused from an earlier Workflow run; cycle 2's result was supplied by a person without running."));
    assert.ok(!k2MixSys.includes("ran in a previous Workflow run"));

    // K+2 normal cycle prompt appends Design §5.4 sentence (plural K=2 and singular K=1).
    const k2Cycle4 = workflowAgentCyclePrompt({ ...INVOCATION, ...CYCLE, cycle: 4, preCutCount: 2 });
    const [c4Sys] = k2Cycle4.split("\n");
    assert.ok(c4Sys.includes("Cycles 1 to 2 were reused or supplied before this re-run started; their summary is in cycle 3's prompt above."));
    const k1Cycle3 = workflowAgentCyclePrompt({ ...INVOCATION, ...CYCLE, cycle: 3, preCutCount: 1 });
    assert.ok(k1Cycle3.split("\n")[0].includes("Cycle 1 was reused or supplied before this re-run started; its summary is in cycle 2's prompt above."));

    // S7 lost-memory when K+1 (cycle 3) was lost on cycle 4: no "other earlier cycles", replaces K+1-above note, re-carries rerunRecap in JSON!
    const recapPayload = {
        omitted: 0,
        visits: [
            { visit: 1, source: "reused", outcome: "again", resultKind: "business", output: { n: 1 } },
            { visit: 2, source: "supplied", outcome: "again", resultKind: "business", output: { n: 2 }, suppliedNote: "Manual rescue" },
        ],
    };
    const lostK1OnC4 = workflowAgentCycleMemoryLostPrompt(k2Cycle4, 4, [3], { firstSessionCycle: 3, rerunRecap: recapPayload });
    const [lostC4Sys, lostC4Json] = lostK1OnC4.split("\n");
    assert.ok(lostC4Sys.includes("The conversation of cycle 3 is not available"));
    assert.ok(!lostC4Sys.includes("other earlier cycles"), "pre-cut cycles 1..2 must not count as other earlier cycles above");
    assert.ok(!lostC4Sys.includes("in cycle 3's prompt above"), "must not claim summary is in lost cycle 3's prompt above");
    assert.ok(lostC4Sys.includes("Cycles 1 to 2 were reused or supplied before this re-run started; because cycle 3's conversation was lost, rerunRecap in the JSON carries their summary again."));
    assert.deepEqual(JSON.parse(lostC4Json).rerunRecap, recapPayload);

    // S7 lost-memory on cycle 5 when cycle 3 was lost (cycle 4 IS above): includes "other earlier cycles" AND re-carries rerunRecap.
    const k2Cycle5 = workflowAgentCyclePrompt({ ...INVOCATION, ...CYCLE, cycle: 5, preCutCount: 2 });
    const lostC3OnC5 = workflowAgentCycleMemoryLostPrompt(k2Cycle5, 5, [3], { firstSessionCycle: 3, rerunRecap: recapPayload });
    assert.ok(lostC3OnC5.split("\n")[0].includes("What you did in the other earlier cycles is above."));
    assert.deepEqual(JSON.parse(lostC3OnC5.split("\n")[1]).rerunRecap, recapPayload);

    // S7 lost-memory on cycle 5 when cycle 4 was lost (cycle 3 NOT lost): keeps cycle 3 note intact, does not inject rerunRecap.
    const lostC4OnC5 = workflowAgentCycleMemoryLostPrompt(k2Cycle5, 5, [4], { firstSessionCycle: 3 });
    assert.ok(lostC4OnC5.split("\n")[0].includes("What you did in the other earlier cycles is above."));
    assert.ok(lostC4OnC5.split("\n")[0].includes("their summary is in cycle 3's prompt above."));
    assert.equal(Object.hasOwn(JSON.parse(lostC4OnC5.split("\n")[1]), "rerunRecap"), false);

    // Restart path after S_new ended on its own with pre-cut cycles re-carries bounded rerunRecap in JSON and text.
    const restartedWithPreCut = workflowAgentPrompt({
        ...INVOCATION,
        continues: true,
        restart: { ...CYCLE, cycle: 4, endedSessionId: "ended-s-new" },
        rerunRecap: {
            cycle: 4,
            count: 2,
            reusedCount: 1,
            suppliedCount: 1,
            omitted: 0,
            visits: recapPayload.visits,
            variables: CYCLE.variables,
            changedVariables: ["topic"],
            previous: CYCLE.previous,
        },
    });
    const [rstSys, rstJson] = restartedWithPreCut.split("\n");
    assert.ok(rstSys.includes("This is cycle 4 of this state in this run. The agent session of its earlier cycles ended (session ended-s-new)"));
    assert.ok(rstSys.includes("Cycle 1 was reused from an earlier Workflow run; cycle 2's result was supplied by a person without running."));
    assert.deepEqual(JSON.parse(rstJson).rerunRecap, recapPayload);
});

test("the graph shows the mode only when the session continues; the reminder names the cycle; the tool takes node_execution_id", () => {
    const continued = compileWorkflow(LOOP("continue"));
    const plain = compileWorkflow(LOOP("new"));
    assert.equal(describeWorkflowState(continued.ir.nodes.talk).session, "continue");
    assert.equal(Object.hasOwn(describeWorkflowState(plain.ir.nodes.talk), "session"), false);
    assert.equal(workflowAgentReminderText("talk", "nx-2"), "Reminder from the workflow: step 'talk' is still open. If you have finished, call "
        + "complete_workflow_node now with your outcome and output and node_execution_id nx-2 (this cycle's). If you are still working, continue.");
    assert.equal(workflowAgentReminderText("talk"), "Reminder from the workflow: step 'talk' is still open. If you have finished, call "
        + "complete_workflow_node now with your outcome and output. If you are still working, continue.");
    const parameter = COMPLETE_WORKFLOW_NODE_TOOL_SPEC.parameters.properties.node_execution_id;
    assert.equal(parameter.type, "string");
    assert.match(parameter.description, /Required when your prompt says this agent session continues across cycles/);
    assert.deepEqual(COMPLETE_WORKFLOW_NODE_TOOL_SPEC.parameters.required, ["operation_id"]);
});

// Owner 2026-11-08T16:55Z: the base guidance is trimmed to its rules; the session modes are taught in the skills it names.
test("the skills every Workflow author reads explain both session modes and when to choose each", () => {
    const skill = name => fs.readFileSync(path.join(WORKFLOW_SKILLS_DIR, name, "SKILL.md"), "utf8").replace(/\s+/g, " ");
    assert.ok(WORKFLOW_SESSION_GUIDANCE.includes("call `load_skill` with name `workflow-authoring`"));
    // Owner 2026-11-09T05:38Z + I8: continue is the default outside parallel; named branches default new and allow continue; For each uses new only.
    const authoring = skill("workflow-authoring");
    assert.ok(authoring.includes("`session: continue` (default): keeps step memory across visits (allowed in `branches:`, default `new`). "
        + "`session: new` (fresh visit) only if asked, and only choice in `forEach`. Session lifecycle: workflow-reference."));
    // The formal review's known limit, in plain words.
    assert.ok(authoring.includes("Limit: after a visit times out, the next visit's prompt can wait behind the old turn until its abort lands, "
        + "and the next visit's time limit runs during that wait."));
    const reference = skill("workflow-reference");
    assert.ok(reference.includes("| `session` | Optional. `continue` (default outside parallel) or `new`. Named `branches:` default `new` (`continue` allowed); `forEach` only `new`. |"));
    assert.ok(reference.includes("`session: continue` (the default) keeps one agent session across the state's visits in a Workflow"));
    assert.ok(reference.includes("The step remembers earlier cycles (no repeats, incremental work); its context grows, so it costs more."));
    assert.ok(reference.includes("Use `session: new` (a fresh agent session each visit: clean, cheaper, no drift) only when the person asks for it, "
        + "or the visits are independent and the person wants that."));
    assert.ok(reference.includes("In named `branches:`, `new` is default and `continue` is allowed (one session per run and state); `forEach` allows only `new`."));
    assert.ok(reference.includes("Another Workflow (Run again) starts new agent sessions."));
    assert.ok(reference.includes("Each completion gives `node_execution_id` from its prompt."));
    assert.ok(reference.includes("Session lifecycle: the time limit is per visit; the agent session ends with the Workflow"));
});

