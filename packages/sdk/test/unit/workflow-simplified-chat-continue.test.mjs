/**
 * Workflow Simplified: an agent node that continues its agent session (owner decision agent-node-continue-20261106; YAML
 * key `session: new | continue`, renamed from `chat` by the owner, 2026-11-09T06:30Z):
 * - the compiler accepts `session: new` (the IR carries no mode) and `session: continue` (the IR's `chat` field carries
 *   it), refuses any other value, refuses `session: continue` inside a parallel (For each) body in words, and refuses the
 *   old key `chat` saying what to write; a stored IR keeps it. Owner 2026-11-09T05:38Z: an agent state that sets no
 *   `session` continues (the IR carries `continue`) outside a parallel body, and gets a new session each visit inside one
 *   (a For each body or a named branch);
 * - the chat ids are derived (one per run and state; a replacement names its visit) and a continued chat is told apart
 *   from a visit's own;
 * - the first prompt of a continued chat says it continues and asks for node_execution_id, the cycle prompt says
 *   "cycle N" with the variables now, which changed and the previous result, and a replacement chat's first prompt says
 *   the earlier chat ended; a chat that does not continue gets the same first prompt as before;
 * - the graph shows the mode; the reminder names the cycle; the completion tool takes node_execution_id;
 * - the guidance every agent reads explains both modes and when to choose each (base guidance, both skills, the
 *   spawn_workflow and update_workflow descriptions).
 *
 * Run: node --test test/unit/workflow-simplified-chat-continue.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compileWorkflow, parseWorkflowIr } from "../../dist/workflow/compiler.js";
import {
    describeWorkflowState, workflowAgentChatContinues, workflowAgentChatSessionId, workflowAgentChildSessionId, workflowAgentCyclePrompt,
    workflowAgentPrompt,
} from "../../dist/workflow/runtime.js";
import { workflowAgentReminderText } from "../../dist/workflow/agent-reminder.js";
import { COMPLETE_WORKFLOW_NODE_TOOL_SPEC } from "../../dist/workflow/agent-node-service.js";
import { WORKFLOW_SESSION_GUIDANCE, WORKFLOW_SKILLS_DIR } from "../../dist/workflow/guidance.js";

const errors = result => result.diagnostics.filter(item => item.severity === "error");

const LOOP = chat => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: chatter, version: "1.0.0" }
initial: talk
states:
  talk:
    type: agent
    invoke: { prompt: "Tell one fact." }
${chat === undefined ? "" : `    session: ${chat}\n`}    timeoutSeconds: 60
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

const BRANCHES = chat => `
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
${chat === undefined ? "" : `            session: ${chat}\n`}            timeoutSeconds: 60
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
    // Owner 2026-11-09T05:38Z: a loop's agent state that sets no chat continues; its IR is the explicit continue's.
    assert.equal(plain.ir.nodes.talk.chat, "continue");
    assert.equal(plain.irSha256, continued.irSha256);
    assert.equal(Object.hasOwn(fresh.ir.nodes.talk, "chat"), false);
    assert.notEqual(continued.irSha256, fresh.irSha256);
    // A stored IR keeps the mode it was compiled with: absent is still new (a revision compiled before keeps it), and an
    // invalid stored value is refused.
    assert.equal(parseWorkflowIr(JSON.parse(JSON.stringify(continued.ir))).nodes.talk.chat, "continue");
    assert.equal(Object.hasOwn(parseWorkflowIr(JSON.parse(JSON.stringify(fresh.ir))).nodes.talk, "chat"), false);
    const bad = JSON.parse(JSON.stringify(continued.ir));
    bad.nodes.talk.chat = "sometimes";
    assert.throws(() => parseWorkflowIr(bad), /stored IR agent state talk is invalid/);

    const wrong = compileWorkflow(LOOP("sometimes"));
    assert.deepEqual(errors(wrong).map(item => [item.code, item.path]), [["WORKFLOW_FIELD_INVALID", "states.talk.session"]]);
    assert.match(errors(wrong)[0].message, /^session must be continue \(one agent session across the state's visits, the default\) or new /);
});

// Owner 2026-11-09T06:30Z: "lets drop the "chat" in YAML as well and replace with "session"": `chat` is no field now, and no alias.
test("the compiler refuses the old key chat, saying what to write", () => {
    for (const value of ["continue", "new"]) {
        const old = compileWorkflow(LOOP(undefined).replace("    timeoutSeconds: 60", `    chat: ${value}\n    timeoutSeconds: 60`));
        assert.equal(old.valid, false);
        assert.deepEqual(errors(old).map(item => [item.code, item.path, item.message]),
            [["WORKFLOW_FIELD_INVALID", "states.talk.chat", "`chat` is now `session`: write `session: continue` or `session: new`."]]);
    }
});

test("the compiler: in a For each body or a named branch an agent state that sets no chat gets a new chat each visit", () => {
    const forEach = compileWorkflow(FOR_EACH.replace("          session: continue\n", ""));
    assert.deepEqual(errors(forEach), [], JSON.stringify(forEach.diagnostics));
    assert.equal(Object.hasOwn(forEach.ir.nodes.talk, "chat"), false);
    assert.equal(forEach.irSha256, compileWorkflow(FOR_EACH.replace("session: continue", "session: new")).irSha256);
    const branches = compileWorkflow(BRANCHES(undefined));
    assert.deepEqual(errors(branches), [], JSON.stringify(branches.diagnostics));
    for (const id of ["left_talk", "right_talk"]) assert.equal(Object.hasOwn(branches.ir.nodes[id], "chat"), false, id);
    // Outside the parallel state the same Workflow's agent state continues.
    assert.equal(branches.ir.nodes.sum_up.chat, "continue");
    // An explicit continue in a branch is still refused, in today's words; an explicit new is accepted.
    const refused = errors(compileWorkflow(BRANCHES("continue"))).filter(item => item.path === "states.fan.branches.left.states.left_talk.session");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].message, "state 'left_talk' cannot continue its agent session: it runs inside branch 'left' of parallel state 'fan'. Use session: new.");
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

test("chat ids are derived: one per run and state, another per run, a replacement names its visit; a continued chat is told apart", () => {
    const chat = workflowAgentChatSessionId("run-1", "talk");
    assert.equal(workflowAgentChatSessionId("run-1", "talk"), chat);
    assert.match(chat, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(workflowAgentChatSessionId("run-2", "talk"), chat, "Run again starts a new chat");
    assert.notEqual(workflowAgentChatSessionId("run-1", "other"), chat);
    const replacement = workflowAgentChatSessionId("run-1", "talk", 3);
    assert.notEqual(replacement, chat);
    assert.equal(workflowAgentChatSessionId("run-1", "talk", 3), replacement);
    assert.equal(workflowAgentChatContinues({ nodeExecutionId: "nx-1", childSessionId: chat }), true);
    assert.equal(workflowAgentChatContinues({ nodeExecutionId: "nx-1", childSessionId: replacement }), true);
    assert.equal(workflowAgentChatContinues({ nodeExecutionId: "nx-1", childSessionId: workflowAgentChildSessionId("nx-1") }), false);
    // Known by the chat mark in its id: any other child id (chat: new, whatever it is) is a visit's own, handled as before.
    assert.match(chat, /-c0a7[0-9a-f]{8}$/);
    for (const other of ["child-1", workflowAgentChildSessionId("nx-2"), "8f1e2d3c-1111-8222-9333-444455556666"]) {
        assert.equal(workflowAgentChatContinues({ nodeExecutionId: "nx-1", childSessionId: other }), false, other);
    }
});

const INVOCATION = {
    workflowSessionId: "wf", runId: "run-1", nodeExecutionId: "nx-2", stateId: "talk", controllingSessionId: "parent",
    task: { source: "prompt", prompt: "Tell one fact." }, input: { round: 2 }, inputSchema: null, outputSchema: null, outcomes: ["again", "finish"],
    schemas: {}, deadlineAt: "2026-11-06T03:00:00.000Z",
};
const CYCLE = { cycle: 2, previous: { outcome: "again", resultKind: "business", output: { fact: "one" }, error: null },
    variables: { topic: "postgres", limit: 60 }, changedVariables: ["topic"] };

test("the prompts: a continued chat's first asks for node_execution_id; the cycle prompt says cycle N; a replacement says the earlier chat ended", () => {
    const before = workflowAgentPrompt(INVOCATION);
    assert.ok(before.includes("The workflow cancels this session at the deadline."));
    assert.ok(!before.includes("node_execution_id"), "a chat that does not continue gets the prompt it got before");
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

    const restarted = workflowAgentPrompt({ ...INVOCATION, continues: true, restart: { ...CYCLE, endedChatSessionId: "old-chat" } });
    const [restartSystem, restartJson] = restarted.split("\n");
    assert.ok(restartSystem.includes("This is cycle 2 of this state in this run. The agent session of its earlier cycles ended (session old-chat), "
        + "so this is a new agent session and their work is not here"));
    assert.deepEqual(JSON.parse(restartJson).changedVariables, ["topic"]);
    assert.deepEqual(JSON.parse(restartJson).previousResult, CYCLE.previous);
    assert.equal(JSON.parse(restartJson).cycle, 2);
});

test("the graph shows the mode only when the chat continues; the reminder names the cycle; the tool takes node_execution_id", () => {
    const continued = compileWorkflow(LOOP("continue"));
    const plain = compileWorkflow(LOOP("new"));
    assert.equal(describeWorkflowState(continued.ir.nodes.talk).chat, "continue");
    assert.equal(Object.hasOwn(describeWorkflowState(plain.ir.nodes.talk), "chat"), false);
    assert.equal(workflowAgentReminderText("talk", "nx-2"), "Reminder from the workflow: step 'talk' is still open. If you have finished, call "
        + "complete_workflow_node now with your outcome and output and node_execution_id nx-2 (this cycle's). If you are still working, continue.");
    assert.equal(workflowAgentReminderText("talk"), "Reminder from the workflow: step 'talk' is still open. If you have finished, call "
        + "complete_workflow_node now with your outcome and output. If you are still working, continue.");
    const parameter = COMPLETE_WORKFLOW_NODE_TOOL_SPEC.parameters.properties.node_execution_id;
    assert.equal(parameter.type, "string");
    assert.match(parameter.description, /Required when your prompt says this agent session continues across cycles/);
    assert.deepEqual(COMPLETE_WORKFLOW_NODE_TOOL_SPEC.parameters.required, ["operation_id"]);
});

// Owner 2026-11-08T16:55Z: the base guidance is trimmed to its rules; the chat modes are taught in the skills it names.
test("the skills every Workflow author reads explain both chat modes and when to choose each", () => {
    const skill = name => fs.readFileSync(path.join(WORKFLOW_SKILLS_DIR, name, "SKILL.md"), "utf8").replace(/\s+/g, " ");
    assert.ok(WORKFLOW_SESSION_GUIDANCE.includes("call `load_skill` with name `workflow-authoring`"));
    // Owner 2026-11-09T05:38Z: continue is the default; new only when the person asks; For each and branches use new.
    const authoring = skill("workflow-authoring");
    assert.ok(authoring.includes("`session: continue` (default): one agent session keeps the step's memory across visits. `session: new` (a fresh "
        + "one each visit) only if the person asks; For each and branches: `new`. Session lifecycle: workflow-reference."));
    assert.ok(!/`chat:|\bchat: (new|continue)/.test(authoring), "no `chat:` key is taught");
    // The formal review's known limit, in plain words.
    assert.ok(authoring.includes("Limit: after a visit times out, the next visit's prompt can wait behind the old turn until its abort lands, "
        + "and the next visit's time limit runs during that wait."));
    const reference = skill("workflow-reference");
    assert.ok(reference.includes("| `session` | Optional. `continue` (default) or `new`. In a parallel body (For each or branch) only `new`, its default there. (`chat` is no longer a field.) |"));
    assert.ok(reference.includes("`session: continue` (the default) keeps one agent session across the state's visits in a Workflow"));
    assert.ok(reference.includes("The step remembers earlier cycles (no repeats, incremental work); its context grows, so it costs more."));
    assert.ok(reference.includes("Use `session: new` (a fresh agent session each visit: clean, cheaper, no drift) only when the person asks for it, "
        + "or the visits are independent and the person wants that."));
    assert.ok(reference.includes("In a For each or a parallel branch each visit has its own agent session: `new` is the default there and "
        + "`continue` is refused."));
    assert.ok(reference.includes("Another Workflow (Run again) starts new agent sessions."));
    assert.ok(reference.includes("Each completion gives `node_execution_id` from its prompt."));
    assert.ok(reference.includes("Session lifecycle: the time limit is per visit; the agent session ends with the Workflow"));
});

