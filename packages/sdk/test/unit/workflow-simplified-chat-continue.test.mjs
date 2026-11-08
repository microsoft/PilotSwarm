/**
 * Workflow Simplified: an agent node that continues its chat (owner decision agent-node-continue-20261106; YAML key
 * `chat: new | continue`):
 * - the compiler accepts `chat: new` (the default; the IR is unchanged) and `chat: continue` (the IR carries it), refuses
 *   any other value, and refuses `chat: continue` inside a parallel (For each) body in words; a stored IR keeps it;
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
import { compileWorkflowV2, parseWorkflowIr, WORKFLOW_V2_MILESTONE_IR_VERSION } from "../../dist/workflow/v2/compiler.js";
import {
    describeWorkflowV2State, workflowAgentChatContinues, workflowAgentChatSessionId, workflowAgentChildSessionId, workflowAgentCyclePrompt,
    workflowAgentPrompt,
} from "../../dist/workflow/v2/runtime.js";
import { workflowAgentReminderText } from "../../dist/workflow/v2/agent-reminder.js";
import { COMPLETE_WORKFLOW_NODE_TOOL_SPEC } from "../../dist/workflow/v2/agent-node-service.js";
import { WORKFLOW_SESSION_GUIDANCE, WORKFLOW_V2_SKILLS_DIR } from "../../dist/workflow/guidance.js";

const AGENTS = { enableRequests: true, enableAgents: true };
const PARALLEL = { ...AGENTS, enableParallel: true };
const READ = { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION };
const errors = result => result.diagnostics.filter(item => item.severity === "error");

const LOOP = chat => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: chatter, version: "1.0.0" }
initial: talk
states:
  talk:
    type: agent
    invoke: { prompt: "Tell one fact." }
${chat === undefined ? "" : `    chat: ${chat}\n`}    timeoutSeconds: 60
    transition: { next: { again: pause, finish: done, failure: failed } }
  pause: { type: wait, seconds: 5, transition: { next: { elapsed: talk } } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const FOR_EACH = `
apiVersion: pilotswarm.dev/v2-draft
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
          chat: continue
          timeoutSeconds: 60
          transition: { next: { said: said_it, failure: gave_up } }
        said_it: { type: terminal, outcome: succeeded }
        gave_up: { type: terminal, outcome: blocked }
    transition: { next: { joined: done, blocked: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

test("the compiler: chat new is the default and leaves the IR as it was; continue is carried; anything else is refused", () => {
    const plain = compileWorkflowV2(LOOP(undefined), AGENTS);
    const fresh = compileWorkflowV2(LOOP("new"), AGENTS);
    const continued = compileWorkflowV2(LOOP("continue"), AGENTS);
    for (const result of [plain, fresh, continued]) assert.deepEqual(errors(result), [], JSON.stringify(result.diagnostics));
    assert.equal(fresh.irSha256, plain.irSha256);
    assert.equal(Object.hasOwn(plain.ir.nodes.talk, "chat"), false);
    assert.equal(continued.ir.nodes.talk.chat, "continue");
    assert.notEqual(continued.irSha256, plain.irSha256);
    // A stored IR keeps the mode, and an invalid stored value is refused.
    assert.equal(parseWorkflowIr(JSON.parse(JSON.stringify(continued.ir)), READ).nodes.talk.chat, "continue");
    assert.equal(Object.hasOwn(parseWorkflowIr(JSON.parse(JSON.stringify(plain.ir)), READ).nodes.talk, "chat"), false);
    const bad = JSON.parse(JSON.stringify(continued.ir));
    bad.nodes.talk.chat = "sometimes";
    assert.throws(() => parseWorkflowIr(bad, READ), /stored IR agent state talk is invalid/);

    const wrong = compileWorkflowV2(LOOP("sometimes"), AGENTS);
    assert.deepEqual(errors(wrong).map(item => [item.code, item.path]), [["WORKFLOW_FIELD_INVALID", "states.talk.chat"]]);
    assert.match(errors(wrong)[0].message, /chat must be new .* or continue/);
});

test("the compiler refuses chat: continue inside a For each body, in words", () => {
    const result = compileWorkflowV2(FOR_EACH, PARALLEL);
    const refused = errors(result).filter(item => item.path === "states.fan.body.states.talk.chat");
    assert.equal(refused.length, 1, JSON.stringify(result.diagnostics));
    assert.equal(refused[0].code, "WORKFLOW_FIELD_INVALID");
    assert.match(refused[0].message, /^state 'talk' cannot continue its chat: it runs inside For each state 'fan', whose items run side by side and cannot share one chat\. Use chat: new\.$/);
    const fresh = compileWorkflowV2(FOR_EACH.replace("chat: continue", "chat: new"), PARALLEL);
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
    assert.ok(system.includes("This chat continues: each later visit of this state in this run comes to this same chat as a new cycle"));
    assert.ok(system.includes("Every completion must also give node_execution_id, the id of the cycle it finishes (this one's is nx-2)."));
    assert.ok(!system.includes("The workflow cancels this session at the deadline."));
    assert.equal(Object.hasOwn(JSON.parse(json), "cycle"), false);
    assert.equal(task, "Tell one fact.");

    const cycle = workflowAgentCyclePrompt({ ...INVOCATION, ...CYCLE });
    const [cycleSystem, cycleJson, cycleTaskLine, cycleTask] = cycle.split("\n");
    assert.match(cycleSystem, /^\[SYSTEM: WORKFLOW NODE INVOCATION, CYCLE 2\. This is cycle 2 of the same workflow state in this run, in this same chat/);
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
    assert.ok(restartSystem.includes("This is cycle 2 of this state in this run. The chat of its earlier cycles ended (session old-chat), "
        + "so this is a new chat and their work is not here"));
    assert.deepEqual(JSON.parse(restartJson).changedVariables, ["topic"]);
    assert.deepEqual(JSON.parse(restartJson).previousResult, CYCLE.previous);
    assert.equal(JSON.parse(restartJson).cycle, 2);
});

test("the graph shows the mode only when the chat continues; the reminder names the cycle; the tool takes node_execution_id", () => {
    const continued = compileWorkflowV2(LOOP("continue"), AGENTS);
    const plain = compileWorkflowV2(LOOP(undefined), AGENTS);
    assert.equal(describeWorkflowV2State(continued.ir.nodes.talk).chat, "continue");
    assert.equal(Object.hasOwn(describeWorkflowV2State(plain.ir.nodes.talk), "chat"), false);
    assert.equal(workflowAgentReminderText("talk", "nx-2"), "Reminder from the workflow: step 'talk' is still open. If you have finished, call "
        + "complete_workflow_node now with your outcome and output and node_execution_id nx-2 (this cycle's). If you are still working, continue.");
    assert.equal(workflowAgentReminderText("talk"), "Reminder from the workflow: step 'talk' is still open. If you have finished, call "
        + "complete_workflow_node now with your outcome and output. If you are still working, continue.");
    const parameter = COMPLETE_WORKFLOW_NODE_TOOL_SPEC.parameters.properties.node_execution_id;
    assert.equal(parameter.type, "string");
    assert.match(parameter.description, /Required when your prompt says this chat continues across cycles/);
    assert.deepEqual(COMPLETE_WORKFLOW_NODE_TOOL_SPEC.parameters.required, ["operation_id"]);
});

// Owner 2026-11-08T16:55Z: the base guidance is trimmed to its rules; the chat modes are taught in the skills it names.
test("the skills every Workflow author reads explain both chat modes and when to choose each", () => {
    const skill = name => fs.readFileSync(path.join(WORKFLOW_V2_SKILLS_DIR, name, "SKILL.md"), "utf8").replace(/\s+/g, " ");
    assert.ok(WORKFLOW_SESSION_GUIDANCE.includes("load the `workflow-authoring` skill"));
    const authoring = skill("workflow-authoring");
    assert.ok(authoring.includes("`chat: new` (default) gives each visit a new chat. `chat: continue` keeps one chat across the state's visits, "
        + "for memory of earlier cycles; its context grows. Not in a parallel body."));
    // The formal review's known limit, in plain words.
    assert.ok(authoring.includes("Limit: after a visit times out, the next visit's prompt can wait behind the old turn until its abort lands, "
        + "and the next visit's time limit runs during that wait."));
    const reference = skill("workflow-reference");
    assert.ok(reference.includes("| `chat` | Optional. `new` (default) or `continue`. Refused in a parallel body. |"));
    assert.ok(reference.includes("`chat: new` gives each visit a new chat: clean, cheaper, no drift; use it when visits are independent."));
    assert.ok(reference.includes("Use it for memory of earlier cycles (no repeats, incremental work); its context grows, so it costs more."));
    assert.ok(reference.includes("Another Workflow (Run again) starts new chats."));
    assert.ok(reference.includes("Each completion gives `node_execution_id` from its prompt."));
});

