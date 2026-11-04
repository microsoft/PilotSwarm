/**
 * Workflow v2 agent states (IR 8; design 03 agent node, 04 tool surface;
 * requirements R09 to R11, R14 and R15), INACTIVE: only controller 1.9.0
 * runs them, and only tests register it and start runs there (the test-only
 * option workflowRequests and a host with `requests`).
 *
 * - The compiler: agent states compile to IR 8 only with enableAgents; the
 *   task is exactly one of an inline prompt or a named agent; outcomes and
 *   routes; a reader takes IR 8 only when asked to; a definition without an
 *   agent state compiles to the same IR either way.
 * - The store: an agent state's admission records its invocation with the
 *   node's deadline; complete_workflow_node's operation (shape, identity,
 *   contract, correction budget, durable expiry, repeats and conflicts); the
 *   deadline's elapse; the spawn and end records.
 * - Controller 1.9.0 on a native duroxide runtime with a test-double host:
 *   the child is created with the host-generated wrapper and a stable id;
 *   its typed completion routes the state and its session is told done; its
 *   deadline routes timed_out and its session is cancelled; a host refusal
 *   and a worker without a host fail the state; a cancel of the run cancels
 *   the child; while the run is paused (verification of RT-6), an agent state
 *   decided by its completion or its deadline has its child ended at once, a
 *   failed end is tried again while paused, and nothing is routed or
 *   admitted until the resume; an agent state in a parallel branch that the
 *   parallel state's own time limit cancels (IR 9) has its child ended.
 *
 * The child session is a test double (an orchestration that records the
 * messages its queue gets); the test completes the state through the real
 * complete_workflow_node tool function as that session. No model runs: this
 * is not evidence of a real agent's behavior (R10, R11) or of the human-input
 * boundary.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import {
    compileWorkflowV2, parseWorkflowIr, WORKFLOW_V2_AGENT_IR_VERSION, WORKFLOW_V2_MILESTONE_IR_VERSION, WORKFLOW_V2_REQUEST_IR_VERSION,
} from "../../src/workflow/v2/compiler.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { controlWorkflowV2Run, createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { readWorkflowV2View } from "../../src/workflow/v2/tools.ts";
import { completeWorkflowNodeFromTool, COMPLETE_WORKFLOW_NODE_TOOL } from "../../src/workflow/v2/agent-node-service.ts";
import {
    describeWorkflowV2State, registerWorkflowV2, sessionQueueTransport, WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, workflowAgentChildSessionId,
    workflowAgentClientMessageId, workflowLiveControllerInstanceId,
} from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor, WORKFLOW_V2_AGENT_MAX_INVALID_COMPLETIONS } from "../../src/workflow/v2/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-agent-node-test" };
const AGENTS = { enableRequests: true, enableAgents: true };
const TASK = "Review the change at the given head. Do not edit source.";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(50);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** One agent state (`state` replaces its body), then terminals for each route. */
const AGENT_YAML = ({ timeoutSeconds = 3600, invoke = `{ prompt: "${TASK}" }`, extra = "" } = {}) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: reviewer, version: "1.0.0" }
initialInput: { head: "abc" }
initial: review
schemas:
  ReviewInput: { type: object, required: [head], properties: { head: { type: string } }, additionalProperties: false }
  ReviewResult: { type: object, required: [verdict], properties: { verdict: { type: string }, notes: { type: string } }, additionalProperties: false }
states:
  review:
    type: agent
    invoke: ${invoke}
    inputSchema: { $ref: "#/schemas/ReviewInput" }
    outputSchema: { $ref: "#/schemas/ReviewResult" }
    timeoutSeconds: ${timeoutSeconds}
${extra}    transition: { next: { accepted: done, changes_required: rework, needs_input: ask, timed_out: late, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  rework: { type: terminal, outcome: blocked, output: "\${input}" }
  ask: { type: terminal, outcome: blocked }
  late: { type: terminal, outcome: blocked }
  failed: { type: terminal, outcome: failed }
`;

const errorsOf = result => result.diagnostics.filter(item => item.severity === "error");

/** A parallel state (IR 9) over one head whose branch is an agent state, with a 3-second time limit of its own. */
const PARALLEL_AGENT_YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: reviewers, version: "1.0.0" }
initialInput: { heads: [{ head: "abc" }] }
initial: fan
schemas:
  ReviewInput: { type: object, required: [head], properties: { head: { type: string } }, additionalProperties: false }
  ReviewResult: { type: object, required: [verdict], properties: { verdict: { type: string } }, additionalProperties: false }
states:
  fan:
    type: parallel
    forEach: "\${input.heads}"
    timeoutSeconds: 3
    body:
      initial: review
      states:
        review:
          type: agent
          invoke: { prompt: "${TASK}" }
          inputSchema: { $ref: "#/schemas/ReviewInput" }
          outputSchema: { $ref: "#/schemas/ReviewResult" }
          timeoutSeconds: 3600
          transition: { next: { accepted: done, failure: refused } }
        done: { type: terminal, outcome: succeeded, output: "\${input}" }
        refused: { type: terminal, outcome: blocked }
    transition: { next: { joined: finished, blocked: stuck, timed_out: late, failure: failed } }
  finished: { type: terminal, outcome: succeeded, output: "\${input}" }
  stuck: { type: terminal, outcome: blocked, output: "\${input}" }
  late: { type: terminal, outcome: blocked, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;

describe("workflow v2 agent states: compiler and IR 8", () => {
    it("compiles an agent state to IR 8 only when agents are enabled, and reads IR 8 only when asked to", () => {
        const refused = compileWorkflowV2(AGENT_YAML(), { enableRequests: true });
        expect(refused.valid).toBe(false);
        expect(errorsOf(refused).map(item => [item.code, item.path])).toEqual([["WORKFLOW_NODE_TYPE_UNSUPPORTED", "states.review.type"]]);

        const compiled = compileWorkflowV2(AGENT_YAML(), AGENTS);
        expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
        expect(compiled.ir.irVersion).toBe(WORKFLOW_V2_AGENT_IR_VERSION);
        expect(compiled.ir.contracts).toEqual({});
        expect(compiled.ir.nodes.review).toEqual({
            id: "review", type: "agent", description: null, invoke: { prompt: TASK }, hasInput: false, input: null,
            inputSchema: "ReviewInput", outputSchema: "ReviewResult", outcomes: ["accepted", "changes_required"], timeoutSeconds: 3600,
            next: { accepted: "done", changes_required: "rework", needs_input: "ask", timed_out: "late", failure: "failed" },
        });
        const stored = JSON.parse(canonicalJson(compiled.ir));
        expect(parseWorkflowIr(stored, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION })).toEqual(compiled.ir);
        for (const options of [{}, { maxIrVersion: WORKFLOW_V2_REQUEST_IR_VERSION }]) {
            expect(() => parseWorkflowIr(stored, options)).toThrow(/stored IR version 8 is not supported/);
        }
        expect(describeWorkflowV2State(compiled.ir.nodes.review)).toEqual({
            id: "review", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 3600, outcomes: ["accepted", "changes_required"],
            next: compiled.ir.nodes.review.next,
        });

        // A named agent, pinned to a package and version; a version needs its package; so does a workflow interface, which
        // the IR keeps (publication matches it against the package's export: workflow-v2-agent-resolver.test.js).
        const named = compileWorkflowV2(AGENT_YAML({ invoke: `{ agent: { name: code-reviewer, package: review-kit, version: "1.2.0" } }` }), AGENTS);
        expect(named.valid, JSON.stringify(named.diagnostics)).toBe(true);
        expect(named.ir.nodes.review.invoke).toEqual({ agent: { name: "code-reviewer", package: "review-kit", version: "1.2.0" } });
        expect(compileWorkflowV2(AGENT_YAML({ invoke: `{ agent: { name: code-reviewer } }` }), AGENTS).ir.nodes.review.invoke)
            .toEqual({ agent: { name: "code-reviewer", package: null, version: null } });
        const contracted = compileWorkflowV2(AGENT_YAML({ invoke: `{ agent: { name: code-reviewer, package: review-kit, interface: "review_change@1" } }` }), AGENTS);
        expect(contracted.valid, JSON.stringify(contracted.diagnostics)).toBe(true);
        expect(contracted.ir.nodes.review.invoke).toEqual({ agent: { name: "code-reviewer", package: "review-kit", version: null,
            interface: { name: "review_change", version: "1" } } });
        expect(parseWorkflowIr(JSON.parse(canonicalJson(contracted.ir)), { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION })).toEqual(contracted.ir);
        for (const [invoke, code, path] of [
            [`{ agent: { name: code-reviewer, version: "1.2.0" } }`, "WORKFLOW_FIELD_INVALID", "states.review.invoke.agent.version"],
            [`{ agent: { name: code-reviewer, interface: "review_change@1" } }`, "WORKFLOW_FIELD_INVALID", "states.review.invoke.agent.interface"],
            [`{ agent: { name: code-reviewer, package: review-kit, interface: "review_change" } }`, "WORKFLOW_FIELD_INVALID",
                "states.review.invoke.agent.interface"],
            [`{ prompt: "${TASK}", agent: { name: code-reviewer } }`, "WORKFLOW_FIELD_INVALID", "states.review.invoke"],
            [`{}`, "WORKFLOW_FIELD_INVALID", "states.review.invoke"],
            [`{ prompt: "" }`, "WORKFLOW_FIELD_INVALID", "states.review.invoke.prompt"],
            [`{ agent: { name: "-bad" } }`, "WORKFLOW_FIELD_INVALID", "states.review.invoke.agent.name"],
        ]) {
            const result = compileWorkflowV2(AGENT_YAML({ invoke }), AGENTS);
            expect(result.valid, invoke).toBe(false);
            expect(errorsOf(result).map(item => [item.code, item.path]), invoke).toContainEqual([code, path]);
        }
    });

    it("checks an agent state's outcomes, routes and deadline; a definition without one compiles to the same IR either way", () => {
        // Declared outcomes need routes, and every non-runtime route must be a declared outcome.
        const declared = compileWorkflowV2(AGENT_YAML({ extra: "    outcomes: [accepted]\n" }), AGENTS);
        expect(errorsOf(declared).map(item => [item.code, item.path])).toEqual([["WORKFLOW_ROUTE_INVALID", "states.review.transition.next.changes_required"]]);
        const unrouted = compileWorkflowV2(AGENT_YAML({ extra: "    outcomes: [accepted, changes_required, approved]\n" }), AGENTS);
        expect(errorsOf(unrouted).map(item => item.code)).toEqual(["WORKFLOW_ROUTE_MISSING"]);
        const runtimeOutcome = compileWorkflowV2(AGENT_YAML({ extra: "    outcomes: [accepted, timed_out]\n" }), AGENTS);
        expect(errorsOf(runtimeOutcome).map(item => [item.code, item.path])).toContainEqual(["WORKFLOW_FIELD_INVALID", "states.review.outcomes"]);
        for (const timeoutSeconds of ["0", "86401", "1.5", "nope"]) {
            const result = compileWorkflowV2(AGENT_YAML({ timeoutSeconds }), AGENTS);
            expect(result.valid, timeoutSeconds).toBe(false);
            expect(errorsOf(result).map(item => item.path), timeoutSeconds).toContain("states.review.timeoutSeconds");
        }
        const bound = compileWorkflowV2(AGENT_YAML({ timeoutSeconds: `"\${kv.limit}"` }), AGENTS);
        expect(bound.valid, JSON.stringify(bound.diagnostics)).toBe(true);
        expect(bound.ir.nodes.review.timeoutSeconds).toBe("${kv.limit}");

        // Without an agent state, enabling agents changes nothing in the IR.
        const plain = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: plain, version: "1.0.0" }
initial: wait
states:
  wait: { type: wait, seconds: 5, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;
        const before = compileWorkflowV2(plain, { enableRequests: true });
        const after = compileWorkflowV2(plain, AGENTS);
        expect(after.irSha256).toBe(before.irSha256);
        expect(after.ir.irVersion).toBe(4);
    });
});

// ─── The store ────────────────────────────────────────────────

/** A store over a migrated schema, and published agent workflows whose live run is admitted for 1.9.0 (no controller runs them). */
async function agentFixture(env) {
    const h = await openWorkflowStore(env);
    const parent = randomUUID();
    await h.catalog.createSession(parent, {});
    return Object.assign(h, {
        parent,
        async workflow(yaml = AGENT_YAML()) {
            const compiled = compileWorkflowV2(yaml, AGENTS);
            expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            expect(await h.catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner: null,
                creationConfig: { workflowV2: { requestSha256: "agent" } } })).toEqual({ created: true });
            await h.store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: ACTOR,
                operationId: "create", requestSha256: "agent", publish: true, title: "Workflow: agent",
                start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION },
            });
            return { workflowSessionId, runId, compiled };
        },
        /** Admit the agent state of `run` pending, with `timeoutSeconds`; returns its node execution id and child id. */
        async admit(run, { timeoutSeconds = 3600, outputSchema = "ReviewResult", outcomes = ["accepted", "changes_required"] } = {}) {
            const nodeExecutionId = nodeExecutionIdFor(run.runId, "root", "review", 1);
            const childSessionId = workflowAgentChildSessionId(nodeExecutionId);
            const admitted = await h.store.enterNode({
                runId: run.runId, nodeExecutionId, scopeId: "root", nodeId: "review", ordinal: 1, nodeType: "agent",
                predecessorId: null, arrivalRoute: null, inputText: canonicalJson({ head: "abc" }), kvRevision: 1, waitSeconds: null,
                immediate: null,
                agent: { childSessionId, controllingSessionId: parent, task: { source: "prompt", prompt: TASK }, outcomes, outputSchema, timeoutSeconds },
            });
            expect(admitted).toMatchObject({ admitted: true, inserted: true, node: { state: "pending", nodeType: "agent" } });
            return { nodeExecutionId, childSessionId, node: admitted.node };
        },
        complete(childSessionId, operationId, call) {
            return h.store.completeAgentNode({ childSessionId, operationId, call });
        },
    });
}

describe("workflow v2 agent states: the store", () => {
    it("admits an agent state with its invocation record and deadline; refuses a spec whose contract is not its state's", { timeout: TIMEOUT }, async () => {
        const h = await agentFixture(getEnv());
        try {
            const run = await h.workflow();
            for (const wrong of [{ outputSchema: "ReviewInput" }, { outputSchema: null }, { outcomes: ["accepted"] }]) {
                await expect(h.admit(run, wrong)).rejects.toMatchObject({ code: "WORKFLOW_STORE_CORRUPT" });
            }
            const { nodeExecutionId, childSessionId, node } = await h.admit(run, { timeoutSeconds: 600 });
            expect(node.deadlineAt.getTime() - node.enteredAt.getTime()).toBe(600_000);
            const invocation = await h.store.readAgentInvocation(nodeExecutionId);
            expect(invocation).toMatchObject({
                nodeExecutionId, runId: run.runId, workflowSessionId: run.workflowSessionId, childSessionId, controllingSessionId: h.parent,
                task: { source: "prompt", prompt: TASK }, outcomes: ["accepted", "changes_required"], outputSchema: "ReviewResult",
                spawnAttempts: 0, spawnedAt: null, endRequested: null, endSentAt: null,
            });
            expect(invocation.deadlineAt).toEqual(node.deadlineAt);
            expect(await h.store.readAgentInvocationByChild(childSessionId)).toEqual(invocation);
            expect(await h.store.readAgentInvocationByChild(randomUUID())).toBeNull();
            // An agent spec on another state, or an agent state without one, is a broken admission.
            await expect(h.store.enterNode({
                runId: run.runId, nodeExecutionId: nodeExecutionIdFor(run.runId, "root", "review", 2), scopeId: "root", nodeId: "review", ordinal: 2,
                nodeType: "agent", predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
            })).rejects.toMatchObject({ code: "WORKFLOW_STORE_CORRUPT" });

            // The spawn and end records: one spawn, counted attempts; the first end stands; its delivery is marked once.
            expect(await h.store.beginAgentSpawn(nodeExecutionId)).toMatchObject({ action: "spawn", invocation: { spawnAttempts: 1 } });
            expect(await h.store.beginAgentSpawn(nodeExecutionId)).toMatchObject({ action: "spawn", invocation: { spawnAttempts: 2 } });
            expect(await h.store.recordAgentSpawned(nodeExecutionId)).toMatchObject({ recorded: true });
            expect(await h.store.recordAgentSpawned(nodeExecutionId)).toMatchObject({ recorded: false });
            expect(await h.store.beginAgentSpawn(nodeExecutionId)).toMatchObject({ action: "spawned", invocation: { spawnAttempts: 2 } });
            await expect(h.store.markAgentEndSent(nodeExecutionId, "Running")).rejects.toMatchObject({ code: "WORKFLOW_STORE_CORRUPT" });
            expect(await h.store.recordAgentEnd(nodeExecutionId, "cancel")).toMatchObject({ recorded: true, invocation: { endRequested: "cancel" } });
            expect(await h.store.recordAgentEnd(nodeExecutionId, "done")).toMatchObject({ recorded: false, invocation: { endRequested: "cancel" } });
            expect(await h.store.markAgentEndSent(nodeExecutionId, "Running")).toMatchObject({ marked: true, invocation: { endChildStatus: "Running" } });
            expect(await h.store.markAgentEndSent(nodeExecutionId, "Completed")).toMatchObject({ marked: false, invocation: { endChildStatus: "Running" } });
            await expect(h.q(`UPDATE SCHEMA.workflow_agent_invocations SET end_requested = NULL, end_requested_at = NULL WHERE node_execution_id = $1`,
                [nodeExecutionId])).rejects.toThrow(/workflow_agent_invocations_end_sent/);
        } finally {
            await h.stop();
        }
    });

    // Owner decision Q2 (agent-reminder.ts): the gate of the in-turn reminder checks the step and records the reminder in
    // one transaction (recordAgentReminder), at most WORKFLOW_V2_AGENT_MAX_REMINDERS per step, only while the step is open
    // and its child has no sub-agent at work; the same turn records once.
    it("Q2: records a step's reminders once per turn, at most 3, only while the step is open and nothing is at work", { timeout: TIMEOUT }, async () => {
        const h = await agentFixture(getEnv());
        try {
            const run = await h.workflow();
            const { nodeExecutionId, childSessionId } = await h.admit(run);
            const record = turn => h.store.recordAgentReminder({ childSessionId, turn });
            const recorded = async () => (await h.catalog.getSessionEvents(run.workflowSessionId, 0, 200, ["workflow.agent_reminded"]))
                .map(event => event.data);

            // Not an agent state's child: nothing.
            expect(await h.store.recordAgentReminder({ childSessionId: randomUUID(), turn: 1 })).toEqual({ recorded: false, reason: "not_a_step" });
            // The first stall; an attempt of the same turn that runs again reminds again under the same number, and records nothing more.
            expect(await record(1)).toEqual({ recorded: true, n: 1, max: 3, stateId: "review", nodeExecutionId, repeat: false });
            expect(await record(1)).toEqual({ recorded: true, n: 1, max: 3, stateId: "review", nodeExecutionId, repeat: true });
            expect(await recorded()).toEqual([{ runId: run.runId, nodeExecutionId, stateId: "review", childSessionId, turn: 1, n: 1, max: 3 }]);
            // Two concurrent checks of one turn: one record, one number.
            const both = await Promise.all([record(2), record(2)]);
            expect(both.map(item => item.n)).toEqual([2, 2]);
            expect(both.filter(item => item.repeat)).toHaveLength(1);
            // A sub-agent of the child at work: no reminder until it is done, also for a turn already recorded (review D5).
            await h.catalog.createSession(childSessionId, { parentSessionId: run.workflowSessionId });
            const sub = randomUUID();
            await h.catalog.createSession(sub, { parentSessionId: childSessionId });
            await h.catalog.updateSession(sub, { state: "running" });
            expect(await record(3)).toEqual({ recorded: false, reason: "sub_agents" });
            expect(await record(1)).toEqual({ recorded: false, reason: "sub_agents" });
            expect(await record(2)).toEqual({ recorded: false, reason: "sub_agents" });
            await h.catalog.updateSession(sub, { state: "idle" });
            expect(await record(1)).toEqual({ recorded: true, n: 1, max: 3, stateId: "review", nodeExecutionId, repeat: true });
            expect(await record(3)).toMatchObject({ recorded: true, n: 3, repeat: false });
            // A fourth stall: spent, across turns.
            expect(await record(4)).toEqual({ recorded: false, reason: "spent" });
            expect((await recorded()).map(data => [data.n, data.turn])).toEqual([[1, 1], [2, 2], [3, 3]]);

            // A completed step, a step with an end requested, a step past its deadline (the store's clock): nothing recorded.
            const second = await h.workflow();
            const done = await h.admit(second);
            expect(await h.complete(done.childSessionId, "op-done", { outcome: "accepted", output: { verdict: "ok" } })).toMatchObject({ kind: "accepted" });
            expect(await h.store.recordAgentReminder({ childSessionId: done.childSessionId, turn: 1 })).toEqual({ recorded: false, reason: "decided" });
            const third = await h.workflow();
            const ending = await h.admit(third);
            await h.store.recordAgentEnd(ending.nodeExecutionId, "cancel");
            expect(await h.store.recordAgentReminder({ childSessionId: ending.childSessionId, turn: 1 })).toEqual({ recorded: false, reason: "decided" });
            const fourth = await h.workflow();
            const late = await h.admit(fourth, { timeoutSeconds: 1 });
            await pause(1_200);
            expect(await h.store.recordAgentReminder({ childSessionId: late.childSessionId, turn: 1 })).toEqual({ recorded: false, reason: "expired" });
            for (const workflowSessionId of [second.workflowSessionId, third.workflowSessionId, fourth.workflowSessionId]) {
                expect(await h.catalog.getSessionEvents(workflowSessionId, 0, 200, ["workflow.agent_reminded"])).toEqual([]);
            }
        } finally {
            await h.stop();
        }
    });

    // The gate serializes with the step's completion and its deadline: it reads the store's clock after the locks.
    it("Q2: a reminder check that waits for a completion's locks finds the step decided; one that waits past the deadline records nothing", { timeout: TIMEOUT }, async () => {
        const h = await agentFixture(getEnv());
        try {
            // A completion holds the step's locks while the check starts: the check waits, then finds the step decided.
            const run = await h.workflow();
            const { childSessionId } = await h.admit(run);
            let held;
            let holding = new Promise(resolve => { held = resolve; });
            h.control.hook = async ({ sql, params, query }) => {
                const result = await query(sql, params);
                if (sql.includes(".workflow_agent_completions") && sql.includes("INSERT")) {
                    held();
                    await pause(1_000);
                }
                return result;
            };
            const completion = h.complete(childSessionId, "op-held", { outcome: "accepted", output: { verdict: "ok" } });
            await holding;
            const check = h.store.recordAgentReminder({ childSessionId, turn: 1 });
            expect(await completion).toMatchObject({ kind: "accepted" });
            expect(await check).toEqual({ recorded: false, reason: "decided" });

            // A check that began before the deadline and waited for the locks past it records nothing.
            const late = await h.workflow();
            const step = await h.admit(late, { timeoutSeconds: 3 });
            const deadline = (await h.store.readAgentInvocation(step.nodeExecutionId)).deadlineAt.getTime();
            holding = new Promise(resolve => { held = resolve; });
            h.control.hook = async ({ sql, params, query }) => {
                const result = await query(sql, params);
                // The first check's record, just written: hold its transaction (and its locks) until after the deadline.
                if (sql.includes("cms_record_events") && String(params?.[1] ?? "").includes('"turn":1')) {
                    held();
                    while (Date.now() < deadline + 500) await pause(50);
                }
                return result;
            };
            const first = h.store.recordAgentReminder({ childSessionId: step.childSessionId, turn: 1 });
            await holding;
            const startedAt = Date.now();
            const second = h.store.recordAgentReminder({ childSessionId: step.childSessionId, turn: 2 });
            expect(await first).toMatchObject({ recorded: true, n: 1 });
            expect(await second).toEqual({ recorded: false, reason: "expired" });
            expect(startedAt).toBeLessThan(deadline);
            h.control.hook = null;
            expect((await h.catalog.getSessionEvents(late.workflowSessionId, 0, 200, ["workflow.agent_reminded"])).map(event => event.data.n)).toEqual([1]);
        } finally {
            h.control.hook = null;
            await h.stop();
        }
    });

    it("E2-T5: an agent's reported error is stored with its secrets hidden, and a repeat of the same call is still recognized", { timeout: TIMEOUT }, async () => {
        const h = await agentFixture(getEnv());
        try {
            const secret = "s3nt1nel-Secr3t";
            const run = await h.workflow();
            const { nodeExecutionId, childSessionId } = await h.admit(run);
            const call = { error: { code: "needs_input", message: `Which base? token=${secret}`, details: { apiKey: secret, tokens: [secret], count: 2 } } };
            expect(await h.complete(childSessionId, "op-e", call)).toMatchObject({ kind: "accepted", replayed: false });
            const [raw] = await h.q("SELECT error FROM SCHEMA.workflow_node_executions WHERE node_execution_id = $1", [nodeExecutionId]);
            expect(String(raw.error)).not.toContain(secret);
            expect(JSON.parse(raw.error)).toEqual({ code: "needs_input", message: "Which base? token=<hidden>",
                details: { apiKey: "<hidden>", tokens: "<hidden>", count: 2 } });
            // The operation's hash is the hash of what the agent sent: the same call again is its repeat.
            expect(await h.complete(childSessionId, "op-e", call)).toMatchObject({ kind: "accepted", replayed: true });
            const events = await h.catalog.getSessionEvents(run.workflowSessionId, 0, 100, ["workflow.state_failed"]);
            expect(JSON.stringify(events)).not.toContain(secret);
        } finally {
            await h.stop();
        }
    });

    it("decides an agent state once by its child's typed completion: shape, contract, correction budget, repeats and conflicts", { timeout: TIMEOUT }, async () => {
        const h = await agentFixture(getEnv());
        try {
            const run = await h.workflow();
            const { nodeExecutionId, childSessionId } = await h.admit(run);
            // Only the state's own child; a malformed call or id writes nothing.
            await expect(h.complete(randomUUID(), "op-1", { outcome: "accepted", output: { verdict: "ok" } })).rejects.toMatchObject({ code: "AGENT_NODE_NOT_FOUND" });
            for (const call of [null, {}, { outcome: "accepted", error: { code: "needs_input", message: "x" } }, { outcome: 5 },
                { outcome: "accepted", output: { verdict: "ok" }, extra: 1 }, { error: { code: "needs_input" } }, { error: "x" }]) {
                await expect(h.complete(childSessionId, "op-x", call), JSON.stringify(call)).rejects.toMatchObject({ code: "COMPLETION_INVALID" });
            }
            await expect(h.complete(childSessionId, "", { outcome: "accepted" })).rejects.toMatchObject({ code: "WORKFLOW_COMMAND_INVALID" });
            expect(await h.q("SELECT count(*)::int AS n FROM SCHEMA.workflow_agent_completions")).toEqual([{ n: 0 }]);

            // An undeclared outcome or an output against its schema: field errors, the state stays pending, the budget counts down.
            const invalid = await h.complete(childSessionId, "op-1", { outcome: "approved", output: { verdict: 5 } });
            expect(invalid).toMatchObject({ kind: "refused", replayed: false, code: "OUTPUT_INVALID", attemptsLeft: WORKFLOW_V2_AGENT_MAX_INVALID_COMPLETIONS - 1,
                state: { status: "pending" } });
            expect(invalid.problems.map(problem => problem.path)).toContain("outcome");
            expect(await h.complete(childSessionId, "op-1", { outcome: "approved", output: { verdict: 5 } }))
                .toMatchObject({ kind: "refused", replayed: true, code: "OUTPUT_INVALID" });
            expect(await h.complete(childSessionId, "op-1", { outcome: "accepted", output: { verdict: "ok" } }))
                .toMatchObject({ kind: "refused", replayed: true, code: "OPERATION_CONFLICT" });
            expect((await h.store.readNodeExecution(nodeExecutionId)).state).toBe("pending");

            // A valid completion decides the state (winner agent), with its receipt; a repeat returns it.
            const accepted = await h.complete(childSessionId, "op-2", { outcome: "accepted", output: { verdict: "ok", notes: "fine" } });
            expect(accepted).toMatchObject({ kind: "accepted", replayed: false, receipt: {
                nodeExecutionId, workflowSessionId: run.workflowSessionId, runId: run.runId, stateId: "review", childSessionId, operationId: "op-2",
                kind: "result", outcome: "accepted" } });
            expect(accepted.receipt.decidedAt).toMatch(/\.\d{6}Z$/);
            expect(await h.store.readNodeExecution(nodeExecutionId)).toMatchObject({
                state: "completed", outcome: "accepted", resultKind: "business", winner: "agent", output: { verdict: "ok", notes: "fine" } });
            expect(await h.complete(childSessionId, "op-2", { outcome: "accepted", output: { verdict: "ok", notes: "fine" } }))
                .toEqual({ ...accepted, replayed: true });
            // The same result under another id is that completion; another result conflicts; nothing changes.
            expect(await h.complete(childSessionId, "op-3", { outcome: "accepted", output: { verdict: "ok", notes: "fine" } }))
                .toMatchObject({ kind: "accepted", replayed: true, receipt: accepted.receipt });
            expect(await h.complete(childSessionId, "op-4", { outcome: "changes_required", output: { verdict: "no" } }))
                .toMatchObject({ kind: "refused", code: "COMPLETION_CONFLICT", state: { status: "completed", outcome: "accepted", winner: "agent" } });
            expect(await h.store.readNodeExecution(nodeExecutionId)).toMatchObject({ outcome: "accepted", output: { verdict: "ok", notes: "fine" } });
            const events = await h.catalog.getSessionEvents(run.workflowSessionId, 0, 200);
            expect(events.filter(event => event.eventType === "workflow.state_completed" && event.data?.nodeExecutionId === nodeExecutionId)).toHaveLength(1);

            // The budget: the last invalid completion fails the state invalid_output; nothing completes it after that.
            const spent = await h.workflow();
            const second = await h.admit(spent);
            for (let attempt = 1; attempt < WORKFLOW_V2_AGENT_MAX_INVALID_COMPLETIONS; attempt += 1) {
                expect(await h.complete(second.childSessionId, `bad-${attempt}`, { outcome: "accepted", output: {} }))
                    .toMatchObject({ code: "OUTPUT_INVALID", attemptsLeft: WORKFLOW_V2_AGENT_MAX_INVALID_COMPLETIONS - attempt });
            }
            expect(await h.complete(second.childSessionId, "bad-last", { outcome: "accepted", output: {} }))
                .toMatchObject({ code: "OUTPUT_ATTEMPTS_EXHAUSTED", attemptsLeft: 0, state: { status: "completed", outcome: "invalid_output", winner: "agent" } });
            expect(await h.store.readNodeExecution(second.nodeExecutionId)).toMatchObject({ outcome: "invalid_output", resultKind: "runtime_error", winner: "agent" });
            expect(await h.complete(second.childSessionId, "good", { outcome: "accepted", output: { verdict: "ok" } }))
                .toMatchObject({ kind: "refused", code: "NODE_CLOSED" });

            // A reported error: needs_input decides the state as that runtime error; another code is a field error.
            const asking = await h.workflow();
            const third = await h.admit(asking);
            expect(await h.complete(third.childSessionId, "e-1", { error: { code: "timed_out", message: "no" } }))
                .toMatchObject({ code: "OUTPUT_INVALID" });
            expect(await h.complete(third.childSessionId, "e-2", { error: { code: "needs_input", message: "Which branch?", details: { options: ["a", "b"] } } }))
                .toMatchObject({ kind: "accepted", receipt: { kind: "error", outcome: "needs_input" } });
            expect(await h.store.readNodeExecution(third.nodeExecutionId)).toMatchObject({ outcome: "needs_input", resultKind: "runtime_error", winner: "agent",
                error: { code: "needs_input", message: "Which branch?", details: { options: ["a", "b"] } } });
        } finally {
            await h.stop();
        }
    });

    it("expires an agent state durably at its deadline: the completion is refused, only the elapse decides timed_out, a run end closes it", { timeout: TIMEOUT }, async () => {
        const h = await agentFixture(getEnv());
        try {
            const timedOut = { outcome: "timed_out", resultKind: "runtime_error", valueText: canonicalJson({ code: "timed_out", message: "late" }), winner: "controller" };
            const run = await h.workflow();
            const { nodeExecutionId, childSessionId } = await h.admit(run, { timeoutSeconds: 1 });
            const early = await h.store.elapseAgentNode(nodeExecutionId, timedOut);
            expect(early.result).toBe("not_due");
            expect(early.remainingMs).toBeGreaterThan(0);
            await expect(h.store.elapseAgentNode(nodeExecutionId, { ...timedOut, winner: "agent" })).rejects.toMatchObject({ code: "WORKFLOW_STORE_CORRUPT" });
            await pause(1_200);
            expect(await h.complete(childSessionId, "late", { outcome: "accepted", output: { verdict: "ok" } }))
                .toMatchObject({ kind: "refused", code: "NODE_EXPIRED", state: { status: "pending" } });
            expect(await h.complete(childSessionId, "late", { outcome: "accepted", output: { verdict: "ok" } }))
                .toMatchObject({ kind: "refused", replayed: true, code: "NODE_EXPIRED" });
            expect(await h.store.elapseAgentNode(nodeExecutionId, timedOut))
                .toMatchObject({ result: "elapsed", node: { outcome: "timed_out", resultKind: "runtime_error", winner: "controller" } });
            expect((await h.store.elapseAgentNode(nodeExecutionId, timedOut)).result).toBe("decided");
            expect(await h.complete(childSessionId, "later", { outcome: "accepted", output: { verdict: "ok" } }))
                .toMatchObject({ kind: "refused", code: "NODE_CLOSED" });

            // A run that ends decides its pending agent state (winner controller): the completion finds it closed.
            const ended = await h.workflow();
            const second = await h.admit(ended);
            expect(await h.store.finishRun({ runId: ended.runId, status: "cancelled", terminalNodeId: null, terminalOutcome: null, outputText: null,
                errorText: canonicalJson({ code: "cancelled", message: "stop" }), endPending: { winner: "cancel", message: "cancelled" } }))
                .toMatchObject({ ended: true });
            expect(await h.store.readNodeExecution(second.nodeExecutionId)).toMatchObject({ outcome: "cancelled", winner: "cancel" });
            expect(await h.complete(second.childSessionId, "after", { outcome: "accepted", output: { verdict: "ok" } }))
                .toMatchObject({ kind: "refused", code: "NODE_CLOSED" });
            expect(await h.store.beginAgentSpawn(second.nodeExecutionId)).toMatchObject({ action: "decided" });
        } finally {
            await h.stop();
        }
    });
});

// ─── Controller 1.9.0 on a native runtime ────────────────────

/** The child session double: it records every message its queue gets as its custom status, and keeps running. */
const CHILD = "test-agent-child";
function* agentChild(ctx) {
    const received = [];
    for (;;) {
        const raw = yield ctx.dequeueEvent("messages");
        received.push(typeof raw === "string" ? JSON.parse(raw) : raw);
        ctx.setCustomStatus(JSON.stringify(received));
    }
}

/**
 * A worker-equivalent registration with workflowRequests and the request tag
 * declared. With `host`, agent states' children are created by a double that
 * records each spawn request, starts the child double under the session's
 * instance id and gives it the first prompt (or refuses, when `refusal` is
 * set); without it, the worker has no agent host.
 */
async function harness(env, { host = true } = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    runtime.registerOrchestrationVersioned(CHILD, "1.0.0", agentChild);
    const spawns = [];
    const control = { refusal: null };
    const agentNodes = {
        async spawn(request) {
            spawns.push(request);
            if (control.refusal) return { refused: control.refusal };
            const instanceId = `session-${request.childSessionId}`;
            await client.startOrchestrationVersioned(instanceId, CHILD, {}, "1.0.0");
            await client.enqueueEvent(instanceId, "messages", JSON.stringify({ prompt: request.prompt, clientMessageIds: [request.clientMessageId] }));
            return { spawned: true };
        },
    };
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        workflowRequests: true,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
        ...(host ? { agentNodes } : {}),
    });
    await runtime.start();
    return {
        catalog, store, client, spawns, control, host: { catalog, store, duroxideClient: client, requests: true },
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

/** A parent session and a started run of `yaml` it created. */
async function started(h, yaml) {
    const parent = randomUUID();
    await h.catalog.createSession(parent, {});
    const workflowSessionId = randomUUID();
    const created = await createWorkflowV2(h.host, {
        workflowSessionId, parentSessionId: parent, yaml, actor: ACTOR, operationId: "start", start: { inputs: {} },
    });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    return { parent, workflowSessionId, runId: created.receipt.run.runId };
}

const ended = (h, runId) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && ["completed", "failed", "cancelled", "stopped"].includes(run.status) ? run : null;
}, `run ${runId} to end`);

/** The messages the child double's queue got. */
async function childMessages(h, childSessionId) {
    const status = await h.client.getStatus(`session-${childSessionId}`);
    return typeof status.customStatus === "string" && status.customStatus ? JSON.parse(status.customStatus) : [];
}

const lifecycleCommand = (h, childSessionId) => until(async () => {
    const messages = await childMessages(h, childSessionId);
    return messages.find(message => message?.type === "cmd") ?? null;
}, `the lifecycle command of ${childSessionId}`);

const completeAs = (h, childSessionId, args) => completeWorkflowNodeFromTool(args, { callerSessionId: childSessionId, store: h.store, client: h.client })
    .then(text => JSON.parse(text));

describe("workflow v2 agent states: controller 1.9.0 (inactive, test-only registration)", () => {
    it("creates the child with the wrapper and a stable id, routes its typed completion, and tells its session done", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { parent, workflowSessionId, runId } = await started(h, AGENT_YAML());
            const [spawn] = await until(async () => (h.spawns.length > 0 ? h.spawns : null), "the agent state's child");
            const nodeExecutionId = nodeExecutionIdFor(runId, "root", "review", 1);
            expect(spawn).toMatchObject({
                nodeExecutionId, workflowSessionId, runId, stateId: "review", controllingSessionId: parent, task: { source: "prompt", prompt: TASK },
                childSessionId: workflowAgentChildSessionId(nodeExecutionId),
                clientMessageId: workflowAgentClientMessageId(workflowSessionId, runId, nodeExecutionId),
            });
            expect(spawn.childSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
            // The wrapper: how the state is finished, then the invocation as untrusted JSON, then the task.
            const [system, json, taskLine, task] = spawn.prompt.split("\n");
            expect(system).toContain(COMPLETE_WORKFLOW_NODE_TOOL);
            expect(system).toContain("Humans cannot send you prompts");
            expect(JSON.parse(json)).toMatchObject({
                workflowSessionId, runId, nodeExecutionId, stateId: "review", controllingParentSessionId: parent, taskSource: "inline prompt",
                input: { head: "abc" }, inputSchema: "ReviewInput", outputSchema: "ReviewResult", outcomes: ["accepted", "changes_required"],
                deadline: spawn.deadlineAt,
            });
            expect(Object.keys(JSON.parse(json).schemas).sort()).toEqual(["ReviewInput", "ReviewResult"]);
            expect(taskLine).toContain("The task of this state");
            expect(task).toBe(TASK);
            await until(async () => (await h.store.readAgentInvocation(nodeExecutionId))?.spawnedAt ?? null, "the spawn to be recorded");

            // Chat is not completion: the run waits. An invalid completion is answered with field errors; a valid one routes.
            expect(await completeAs(h, spawn.childSessionId, { outcome: "accepted", output: { verdict: 5 }, operation_id: "op-0" }))
                .toMatchObject({ ok: false, error: { code: "OUTPUT_INVALID", attemptsLeft: WORKFLOW_V2_AGENT_MAX_INVALID_COMPLETIONS - 1 } });
            expect((await h.store.readRun(runId)).status).toBe("running");
            expect(await completeAs(h, spawn.childSessionId, { outcome: "accepted", output: { verdict: "ok" }, operation_id: "op-1" }))
                .toMatchObject({ ok: true, replayed: false, nodeExecutionId, outcome: "accepted", kind: "result" });
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: { verdict: "ok" } });
            expect(await lifecycleCommand(h, spawn.childSessionId))
                .toMatchObject({ type: "cmd", cmd: "done", id: `workflow-agent-end:${nodeExecutionId}`, requestedBy: workflowSessionId });
            expect((await childMessages(h, spawn.childSessionId))[0]).toEqual({ prompt: spawn.prompt, clientMessageIds: [spawn.clientMessageId] });
            expect(h.spawns).toHaveLength(1);

            // read_workflow names the child session, which a click on the state opens (R23), and its lifecycle.
            const view = await readWorkflowV2View(h.store, workflowSessionId);
            expect(view.graph.states.find(state => state.id === "review")).toMatchObject({ type: "agent", invoke: { source: "prompt" } });
            expect(view.run.nodeExecutions.find(node => node.stateId === "review")).toMatchObject({
                outcome: "accepted", winner: "agent",
                agent: { childSessionId: spawn.childSessionId, controllingSessionId: parent, spawned: true, spawnAttempts: 1, end: "done", endSent: true,
                    endChildStatus: "Running" },
            });
            expect((await h.client.getInstanceInfo(workflowLiveControllerInstanceId(workflowSessionId))).orchestrationVersion)
                .toBe(WORKFLOW_V2_REQUEST_CONTROLLER_VERSION);
            const events = await h.catalog.getSessionEvents(workflowSessionId, 0, 500);
            expect(events.filter(event => event.eventType === "workflow.agent_spawned")).toHaveLength(1);
            expect(events.filter(event => event.eventType === "workflow.agent_ended").map(event => event.data))
                .toEqual([expect.objectContaining({ nodeExecutionId, end: "done", sent: true })]);
        } finally {
            await h.stop();
        }
    });

    it("times the state out at its outer deadline and cancels the child; routes needs_input; a late completion finds the state closed", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const late = await started(h, AGENT_YAML({ timeoutSeconds: 1 }));
            const [spawn] = await until(async () => (h.spawns.length > 0 ? h.spawns : null), "the agent state's child");
            const run = await ended(h, late.runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "blocked" });
            expect((await h.store.listNodeExecutions(late.runId)).map(node => [node.nodeId, node.outcome, node.winner]))
                .toEqual([["review", "timed_out", "controller"], ["late", "blocked", "controller"]]);
            expect(await lifecycleCommand(h, spawn.childSessionId)).toMatchObject({ cmd: "cancel", requestedBy: late.workflowSessionId });
            expect(await completeAs(h, spawn.childSessionId, { outcome: "accepted", output: { verdict: "ok" }, operation_id: "op-1" }))
                .toMatchObject({ ok: false, error: { code: "NODE_CLOSED" } });

            // An agent that needs a decision completes with needs_input; the state routes it (to the parent, in a real definition).
            const asking = await started(h, AGENT_YAML());
            const [, second] = await until(async () => (h.spawns.length > 1 ? h.spawns : null), "the second child");
            await until(async () => (await h.store.readAgentInvocation(second.nodeExecutionId))?.spawnedAt ?? null, "the spawn to be recorded");
            expect(await completeAs(h, second.childSessionId, { error: { code: "needs_input", message: "Which base?" }, operation_id: "ask-1" }))
                .toMatchObject({ ok: true, kind: "error", outcome: "needs_input" });
            expect(await ended(h, asking.runId)).toMatchObject({ terminalOutcome: "blocked", terminalNodeId: "ask" });
            expect(await lifecycleCommand(h, second.childSessionId)).toMatchObject({ cmd: "done" });
        } finally {
            await h.stop();
        }
    });

    // Owner decision join-k-of-n (IR 9): a parallel state's own time limit cancels its running branches; an agent state's child
    // in one of them is ended as a timed-out agent state's is.
    it("ends the child of an agent state in a branch that the parallel state's time limit cancels; a late completion finds the state closed", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { workflowSessionId, runId } = await started(h, PARALLEL_AGENT_YAML);
            const [spawn] = await until(async () => (h.spawns.length > 0 ? h.spawns : null), "the branch's agent child");
            await until(async () => (await h.store.readAgentInvocation(spawn.nodeExecutionId))?.spawnedAt ?? null, "the spawn to be recorded");
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "late" });
            const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
            expect(await h.store.readNodeExecution(fan)).toMatchObject({ outcome: "timed_out", resultKind: "runtime_error" });
            expect(await h.store.readNodeExecution(spawn.nodeExecutionId)).toMatchObject({
                state: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "join_timeout" });
            expect(await lifecycleCommand(h, spawn.childSessionId)).toMatchObject({ cmd: "cancel", requestedBy: workflowSessionId });
            const view = await readWorkflowV2View(h.store, workflowSessionId);
            expect(view.run.nodeExecutions.find(node => node.nodeExecutionId === spawn.nodeExecutionId))
                .toMatchObject({ winner: "join_timeout", agent: { childSessionId: spawn.childSessionId, end: "cancel" } });
            expect(await completeAs(h, spawn.childSessionId, { outcome: "accepted", output: { verdict: "ok" }, operation_id: "late-1" }))
                .toMatchObject({ ok: false, error: { code: "NODE_CLOSED" } });
            expect(h.spawns).toHaveLength(1);
        } finally {
            await h.stop();
        }
    });

    it("fails the state when the host refuses or the worker has none, and cancels the child when the run is cancelled", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            h.control.refusal = { code: "unavailable", message: "Agent \"code-reviewer\" is not available to this workflow's owner." };
            const refused = await started(h, AGENT_YAML({ invoke: `{ agent: { name: code-reviewer } }` }));
            expect(await ended(h, refused.runId)).toMatchObject({ status: "failed", terminalOutcome: "failed", terminalNodeId: "failed" });
            const review = (await h.store.listNodeExecutions(refused.runId)).find(node => node.nodeId === "review");
            expect(review).toMatchObject({ outcome: "unavailable", resultKind: "runtime_error", winner: "controller",
                error: { code: "unavailable", details: { childSessionId: h.spawns[0].childSessionId } } });
            expect(h.spawns[0].task).toEqual({ source: "agent", name: "code-reviewer", package: null, version: null });
            expect(JSON.parse(h.spawns[0].prompt.split("\n")[1]).taskSource).toEqual({ agent: "code-reviewer", package: null, version: null });
            h.control.refusal = null;

            // A cancel of the run while the child works: the state loses to the cancel, and the child is cancelled.
            const cancelled = await started(h, AGENT_YAML());
            const [, spawn] = await until(async () => (h.spawns.length > 1 ? h.spawns : null), "the second child");
            await until(async () => (await h.store.readAgentInvocation(spawn.nodeExecutionId))?.spawnedAt ?? null, "the spawn to be recorded");
            await controlWorkflowV2Run(h.host, cancelled.workflowSessionId, { operation: "cancel", runId: null, reason: "not needed" },
                { actor: ACTOR, operationId: "cancel-1" });
            expect(await ended(h, cancelled.runId)).toMatchObject({ status: "cancelled" });
            expect(await h.store.readNodeExecution(spawn.nodeExecutionId)).toMatchObject({ outcome: "cancelled", winner: "cancel" });
            expect(await lifecycleCommand(h, spawn.childSessionId)).toMatchObject({ cmd: "cancel" });
            await until(async () => (await h.store.readAgentInvocation(spawn.nodeExecutionId))?.endSentAt ?? null, "the end to be recorded");
        } finally {
            await h.stop();
        }
        // A worker without an agent host: the state fails unavailable at once.
        const bare = await harness(getEnv(), { host: false });
        try {
            const run = await started(bare, AGENT_YAML());
            expect(await ended(bare, run.runId)).toMatchObject({ status: "failed", terminalNodeId: "failed" });
            expect((await bare.store.listNodeExecutions(run.runId)).find(node => node.nodeId === "review"))
                .toMatchObject({ outcome: "unavailable", error: { message: "This worker creates no agent sessions for workflow agent states." } });
        } finally {
            await bare.stop();
        }
    });
});

/**
 * Two branches, each one agent state (verification of RT-6, M-12): agent states while the run is paused. A branch's
 * result routed before the pause takes effect puts the controller on its paused path (its next state is refused); the
 * other branch's agent state is then decided while the run is paused.
 */
const PAUSED_AGENTS_YAML = ({ timeoutSeconds = 3600 } = {}) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: paused-reviewers, version: "1.0.0" }
initialInput: { items: [a, b] }
initial: fan
schemas:
  ReviewResult: { type: object, required: [verdict], properties: { verdict: { type: string } }, additionalProperties: false }
states:
  fan:
    type: parallel
    forEach: "\${input.items}"
    concurrency: 2
    body:
      initial: review
      states:
        review:
          type: agent
          invoke: { prompt: "${TASK}" }
          outputSchema: { $ref: "#/schemas/ReviewResult" }
          timeoutSeconds: ${timeoutSeconds}
          transition: { next: { accepted: done, changes_required: done, needs_input: done, timed_out: done, failure: done } }
        done: { type: terminal, outcome: succeeded, output: "\${branch.item}" }
    transition: { next: { joined: finished, blocked: stuck, failure: failed } }
  finished: { type: terminal, outcome: succeeded, output: "\${input}" }
  stuck: { type: terminal, outcome: blocked, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;

/** Both children of a PAUSED_AGENTS_YAML run, spawned and recorded. */
async function bothChildren(h, already = 0) {
    const spawns = await until(async () => (h.spawns.length >= already + 2 ? h.spawns.slice(already, already + 2) : null), "both children");
    for (const spawn of spawns) {
        await until(async () => (await h.store.readAgentInvocation(spawn.nodeExecutionId))?.spawnedAt ?? null, "the spawn to be recorded");
    }
    return spawns;
}

const pauseRun = (h, workflowSessionId) => controlWorkflowV2Run(h.host, workflowSessionId, { operation: "pause", runId: null, reason: "look first" },
    { actor: ACTOR, operationId: "pause-1" });
const resumeRun = (h, workflowSessionId) => controlWorkflowV2Run(h.host, workflowSessionId, { operation: "resume", runId: null, reason: null },
    { actor: ACTOR, operationId: "resume-1" });
/** Nothing after the agent states was admitted, and nothing was routed to the join. */
const nothingAdmitted = async (h, runId) => {
    expect((await h.store.readRun(runId)).status).toBe("paused");
    expect((await h.store.listNodeExecutions(runId)).map(node => node.nodeId).sort()).toEqual(["fan", "review", "review"]);
};

describe("workflow v2 agent states while the run is paused (verification of RT-6; controller 1.9.0, test-only)", () => {
    it("ends the child of an agent state that completes while the run is paused, routes its result only after the resume, and cancels the children of a paused run that is cancelled", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { workflowSessionId, runId } = await started(h, PAUSED_AGENTS_YAML());
            const [first, second] = await bothChildren(h);
            await pauseRun(h, workflowSessionId);
            // The first branch's result is routed and its child is told done (as before the pause took effect); its next
            // state is refused, so the controller is on its paused path once the child has the command.
            expect(await completeAs(h, first.childSessionId, { outcome: "accepted", output: { verdict: "ok" }, operation_id: "op-1" }))
                .toMatchObject({ ok: true, outcome: "accepted" });
            expect(await lifecycleCommand(h, first.childSessionId)).toMatchObject({ cmd: "done" });
            // The second branch's agent completes while the run is paused: its child is told done now, not at the resume.
            expect(await completeAs(h, second.childSessionId, { outcome: "accepted", output: { verdict: "ok" }, operation_id: "op-2" }))
                .toMatchObject({ ok: true, outcome: "accepted" });
            expect(await lifecycleCommand(h, second.childSessionId))
                .toMatchObject({ cmd: "done", id: `workflow-agent-end:${second.nodeExecutionId}` });
            expect(await h.store.readAgentInvocation(second.nodeExecutionId)).toMatchObject({ endRequested: "done", endSentAt: expect.any(Date) });
            await pause(1_500);
            await nothingAdmitted(h, runId);

            await resumeRun(h, workflowSessionId);
            expect(await ended(h, runId)).toMatchObject({ status: "completed", terminalNodeId: "finished", terminalOutput: ["a", "b"] });
            // Each child was ended once: the end at the resume's routing found it ended.
            const events = await h.catalog.getSessionEvents(workflowSessionId, 0, 500);
            expect(events.filter(event => event.eventType === "workflow.agent_ended").map(event => event.data.nodeExecutionId).sort())
                .toEqual([first.nodeExecutionId, second.nodeExecutionId].sort());

            // A paused run that is cancelled: both working children are cancelled.
            const cancelled = await started(h, PAUSED_AGENTS_YAML());
            const children = await bothChildren(h, 2);
            await pauseRun(h, cancelled.workflowSessionId);
            await controlWorkflowV2Run(h.host, cancelled.workflowSessionId, { operation: "cancel", runId: null, reason: "not needed" },
                { actor: ACTOR, operationId: "cancel-1" });
            expect(await ended(h, cancelled.runId)).toMatchObject({ status: "cancelled" });
            for (const child of children) expect(await lifecycleCommand(h, child.childSessionId)).toMatchObject({ cmd: "cancel" });
        } finally {
            await h.stop();
        }
    });

    it("times out an agent state whose deadline passes while the run is paused, and tries its child's failed end again while still paused", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { workflowSessionId, runId } = await started(h, PAUSED_AGENTS_YAML({ timeoutSeconds: 6 }));
            const [first, second] = await bothChildren(h);
            // The end of the second child fails (every attempt of the activity) until the store is restored.
            const recordAgentEnd = h.store.recordAgentEnd.bind(h.store);
            const blocked = { on: true, attempts: 0 };
            h.store.recordAgentEnd = async (nodeExecutionId, end) => {
                if (nodeExecutionId === second.nodeExecutionId && blocked.on) {
                    blocked.attempts += 1;
                    throw new Error("The store is not available (test).");
                }
                return await recordAgentEnd(nodeExecutionId, end);
            };
            await pauseRun(h, workflowSessionId);
            expect(await completeAs(h, first.childSessionId, { outcome: "accepted", output: { verdict: "ok" }, operation_id: "op-1" }))
                .toMatchObject({ ok: true });
            expect(await lifecycleCommand(h, first.childSessionId)).toMatchObject({ cmd: "done" });

            // The second state's deadline passes while the run is paused: it is timed_out now, and its child's end is tried
            // until the activity's attempts are spent (one attempt and four retries).
            await until(async () => (await h.store.readNodeExecution(second.nodeExecutionId))?.state === "completed", "the deadline to elapse while paused");
            expect(await h.store.readNodeExecution(second.nodeExecutionId)).toMatchObject({ outcome: "timed_out", winner: "controller" });
            await until(async () => blocked.attempts >= 5 || null, "the end's attempts to be spent", 60_000);
            expect((await childMessages(h, second.childSessionId)).filter(message => message?.type === "cmd")).toEqual([]);
            await nothingAdmitted(h, runId);

            // The store is restored while the run is still paused: the end is tried again and the child is cancelled.
            blocked.on = false;
            expect(await lifecycleCommand(h, second.childSessionId)).toMatchObject({ cmd: "cancel", id: `workflow-agent-end:${second.nodeExecutionId}` });
            expect(await h.store.readAgentInvocation(second.nodeExecutionId)).toMatchObject({ endRequested: "cancel", endSentAt: expect.any(Date) });
            await nothingAdmitted(h, runId);

            await resumeRun(h, workflowSessionId);
            expect(await ended(h, runId)).toMatchObject({ status: "completed", terminalNodeId: "finished", terminalOutput: ["a", "b"] });
        } finally {
            await h.stop();
        }
    });
});
