/**
 * PR 270 (owner decision): the report of a Workflow agent session's failed turn (workflow/agent-turn-failure.ts) on
 * the Workflow controller with a test-double host (as workflow-agent-node.test.js and workflow-simplified-session-continue.test.js).
 * The report is the activity session orchestration 1.0.83 makes when a turn of the session fails for good; here the test
 * calls it as that activity does (reportWorkflowAgentTurnFailure over the store and the durable client).
 *
 * - A visit's own session (session: new) whose turn failed: the visit fails execution_failed (winner controller) long before
 *   its deadline, the controller is woken, its failure route runs and the session is cancelled (formal WfAgent
 *   ChildFailsTerminally, ReportDecide; fix.agent-fail-decided). A repeated report decides nothing more (Inv_DecidedOnce).
 * - A late report, after the agent's own completion decided the visit, is a no-op (fix.agent-fail-safety).
 * - A continued session (session: continue): the report decides only the visit its turn worked on (the visit its prompt
 *   names); the next visit goes to the same session (no replacement), a stale report of the decided visit and a report that
 *   names no visit leave it pending, and it completes normally (WfContinuedSession TurnFails, ReportDecide own visit;
 *   fault.cc-report-binds-newest is what a report that bound the newest visit would do).
 *
 * The child sessions are test doubles (orchestrations that record their queues); turn Stops are recorded by a spy on the
 * catalog's turn control. No model runs. At 01caf109 the report does not exist (nothing decides the visit before its
 * deadline), so every case fails there.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { completeWorkflowNodeFromTool } from "../../src/workflow/agent-node-service.ts";
import {
    registerWorkflow, sessionQueueTransport, workflowAgentSessionId, workflowAgentChildSessionId, workflowAgentClientMessageId,
} from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { reportWorkflowAgentTurnFailure } from "../../src/workflow/agent-turn-failure.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = testTime.ms(120_000);
const ACTOR = { kind: "system", name: "workflow-agent-turn-failure-test" };
const TASK = "Review the change at the given head. Do not edit source.";
const CAUSE = "Failed after 3 attempts: Request failed: exceeded token rate limit (429)";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + testTime.ms(timeoutMs);
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(50);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** One agent state with a one-hour deadline and a failure route, then terminals. */
const REVIEW_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: reviewer, version: "1.0.0" }
initialInput: { head: "abc" }
initial: review
schemas:
  ReviewResult: { type: object, required: [verdict], properties: { verdict: { type: string } }, additionalProperties: false }
states:
  review:
    type: agent
    invoke: { prompt: "${TASK}" }
    session: new
    outputSchema: { $ref: "#/schemas/ReviewResult" }
    timeoutSeconds: 3600
    transition: { next: { accepted: done, timed_out: late, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  late: { type: terminal, outcome: blocked }
  failed: { type: terminal, outcome: failed, output: "\${runtime.error}" }
`;

/** One agent state that continues its session, visited again after its execution_failed (its own route) or on `again`. */
const SESSION_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: chatter, version: "1.0.0" }
initialInput: { round: 1 }
initial: talk
states:
  talk:
    type: agent
    invoke: { prompt: "Tell one new fact about PostgreSQL." }
    session: continue
    timeoutSeconds: 3600
    transition: { next: { again: pause, finish: done, execution_failed: pause, timed_out: late, failure: failed } }
  pause: { type: wait, seconds: 1, transition: { next: { elapsed: talk } } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  late: { type: terminal, outcome: blocked }
  failed: { type: terminal, outcome: failed }
`;

const CHILD = "test-turn-failure-child";
function* recordingChild(ctx) {
    const received = [];
    for (;;) {
        const raw = yield ctx.dequeueEvent("messages");
        received.push(typeof raw === "string" ? JSON.parse(raw) : raw);
        ctx.setCustomStatus(JSON.stringify(received));
    }
}

/** A worker-equivalent registration: a host double that creates a session once and gives it each visit's prompt; a Stop spy. */
async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerConcurrency: 8, workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    runtime.registerOrchestrationVersioned(CHILD, "1.0.0", recordingChild);
    const spawns = [];
    const stops = [];
    const agentNodes = {
        async spawn(request) {
            spawns.push(request);
            const instanceId = `session-${request.childSessionId}`;
            if ((await client.getStatus(instanceId)).status === "NotFound") {
                await catalog.createSession(request.childSessionId, {}).catch(() => {});
                await client.startOrchestrationVersioned(instanceId, CHILD, {}, "1.0.0");
            }
            await client.enqueueEvent(instanceId, "messages", JSON.stringify({ prompt: request.prompt, clientMessageIds: [request.clientMessageId] }));
            return { spawned: true };
        },
    };
    const spied = new Proxy(catalog, {
        get(target, key) {
            if (key === "turnControlAdd") {
                return async (sessionId, kind, text, requestId) => {
                    stops.push({ sessionId, kind, requestId });
                    return { refused: "no_turn" };
                };
            }
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    registerWorkflow({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog: spied, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 30_000,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
        agentNodes,
    });
    await runtime.start();
    return {
        catalog, store, client, spawns, stops, host: { catalog, store, duroxideClient: client },
        /** The report, as the activity makes it for session `sessionId`'s failed turn whose prompt ids are `clientMessageIds`. */
        report: (sessionId, clientMessageIds) => reportWorkflowAgentTurnFailure({ store, client }, { sessionId, clientMessageIds, cause: CAUSE }),
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

async function started(h, yaml) {
    const parent = randomUUID();
    await h.catalog.createSession(parent, {});
    const workflowSessionId = randomUUID();
    const created = await createWorkflow(h.host, { workflowSessionId, parentSessionId: parent, yaml, actor: ACTOR, operationId: "start", start: { inputs: {} } });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    return { parent, workflowSessionId, runId: created.receipt.run.runId };
}

const ended = (h, runId, timeoutMs = 60_000) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && ["completed", "failed", "cancelled", "stopped"].includes(run.status) ? run : null;
}, `run ${runId} to end`, timeoutMs);
const spawnedVisit = async (h, n) => {
    const request = await until(async () => (h.spawns.length >= n ? h.spawns[n - 1] : null), `visit ${n}`);
    await until(async () => (await h.store.readAgentInvocation(request.nodeExecutionId))?.spawnedAt ?? null, `the spawn of visit ${n}`);
    return request;
};
async function messagesOf(h, agentSession) {
    const status = await h.client.getStatus(`session-${agentSession}`);
    return typeof status.customStatus === "string" && status.customStatus ? JSON.parse(status.customStatus) : [];
}
const commandsOf = async (h, agentSession) => (await messagesOf(h, agentSession)).filter(message => message?.type === "cmd");
const completeAs = (h, agentSession, args) => completeWorkflowNodeFromTool(args, { callerSessionId: agentSession, store: h.store, client: h.client }).then(JSON.parse);
const eventsOf = async (h, workflowSessionId, type) => (await h.catalog.getSessionEvents(workflowSessionId, 0, 500))
    .filter(event => event.eventType === type).map(event => event.data);

describe("a Workflow agent session's failed turn decides its visit (PR 270)", () => {
    it("a visit's own session: the visit fails execution_failed before its deadline, the failure route runs and the session is cancelled; a repeat decides nothing", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const run = await started(h, REVIEW_YAML);
            const spawn = await spawnedVisit(h, 1);
            const nodeExecutionId = nodeExecutionIdFor(run.runId, "root", "review", 1);
            expect(spawn.childSessionId).toBe(workflowAgentChildSessionId(nodeExecutionId));
            expect(spawn.clientMessageId).toBe(workflowAgentClientMessageId(run.workflowSessionId, run.runId, nodeExecutionId));

            const startedAt = Date.now();
            expect(await h.report(spawn.childSessionId, [spawn.clientMessageId])).toEqual({ decided: [nodeExecutionId], reason: "decided" });
            // The wake reaches the controller at once (its backstop here is 30 s): the run ends long before the 1-hour deadline.
            const ends = await ended(h, run.runId, 25_000);
            expect(Date.now() - startedAt).toBeLessThan(testTime.ms(25_000));
            expect(ends).toMatchObject({ status: "failed", terminalOutcome: "failed", terminalNodeId: "failed" });
            const nodes = await h.store.listNodeExecutions(run.runId);
            expect(nodes.map(node => [node.nodeId, node.outcome, node.winner])).toEqual([["review", "execution_failed", "controller"], ["failed", "failed", "controller"]]);
            expect(nodes[0]).toMatchObject({ resultKind: "runtime_error", error: { code: "execution_failed" } });
            expect(nodes[0].error.message).toContain("exceeded token rate limit");
            // Inv_EndMatchesWinner: not the agent's own completion, so the session is cancelled.
            const [command] = await until(async () => { const cmds = await commandsOf(h, spawn.childSessionId); return cmds.length ? cmds : null; }, "the session's end");
            expect(command).toMatchObject({ type: "cmd", cmd: "cancel", id: `workflow-agent-end:${nodeExecutionId}`, requestedBy: run.workflowSessionId });
            expect(await eventsOf(h, run.workflowSessionId, "workflow.state_failed")).toContainEqual(expect.objectContaining({
                nodeExecutionId, outcome: "execution_failed", childSessionId: spawn.childSessionId, cause: "agent_turn_failed",
            }));

            // Inv_DecidedOnce: a repeated (or retried) report finds the visit decided and changes nothing.
            expect(await h.report(spawn.childSessionId, [spawn.clientMessageId])).toEqual({ decided: [], reason: "already_decided" });
            expect(await h.store.readNodeExecution(nodeExecutionId)).toMatchObject({ outcome: "execution_failed", winner: "controller" });
            // A session that is no agent state's session: nothing to decide.
            expect(await h.report(randomUUID(), [])).toEqual({ decided: [], reason: "not_a_step" });
        } finally {
            await h.stop();
        }
    });

    it("a late report, after the agent's own completion decided the visit, is a no-op", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const run = await started(h, REVIEW_YAML);
            const spawn = await spawnedVisit(h, 1);
            expect(await completeAs(h, spawn.childSessionId, { outcome: "accepted", output: { verdict: "ok" }, operation_id: "op-1" }))
                .toMatchObject({ ok: true, outcome: "accepted" });
            expect(await h.report(spawn.childSessionId, [spawn.clientMessageId])).toEqual({ decided: [], reason: "already_decided" });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: { verdict: "ok" } });
            expect(await h.store.readNodeExecution(spawn.nodeExecutionId)).toMatchObject({ outcome: "accepted", winner: "agent" });
            const [command] = await until(async () => { const cmds = await commandsOf(h, spawn.childSessionId); return cmds.length ? cmds : null; }, "the session's end");
            expect(command).toMatchObject({ cmd: "done" });
        } finally {
            await h.stop();
        }
    });

    it("a continued session: the report decides only its own visit; the next visit reuses the session and is untouched by a stale report", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const run = await started(h, SESSION_YAML);
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            const first = await spawnedVisit(h, 1);
            expect(first.childSessionId).toBe(agentSession);

            // The first visit's turn failed for good: its visit fails execution_failed, and its own route visits the state again.
            expect(await h.report(agentSession, [first.clientMessageId])).toEqual({ decided: [first.nodeExecutionId], reason: "decided" });
            const second = await spawnedVisit(h, 2);
            expect(await h.store.readNodeExecution(first.nodeExecutionId)).toMatchObject({ outcome: "execution_failed", winner: "controller" });
            // The visit is ended by its turn's Stop, never the session; the next visit goes to the SAME session (no replacement).
            expect(h.stops).toContainEqual(expect.objectContaining({ sessionId: agentSession, kind: "stop", requestId: `workflow-cycle-stop:${first.nodeExecutionId}` }));
            expect(second.childSessionId).toBe(agentSession);
            expect(second.prompt).toMatch(/^\[SYSTEM: WORKFLOW NODE INVOCATION, CYCLE 2\./);
            expect(await eventsOf(h, run.workflowSessionId, "workflow.agent_session_restarted")).toEqual([]);
            expect(await commandsOf(h, agentSession)).toEqual([]);
            expect(JSON.parse(second.prompt.split("\n")[1])).toMatchObject({ previousResult: { outcome: "execution_failed", resultKind: "runtime_error" } });

            // A stale report of the first visit, and a report whose turn names no visit (no recorded prompt names one here),
            // leave the open second visit pending: a report never binds to the session's newest visit.
            expect(await h.report(agentSession, [first.clientMessageId])).toEqual({ decided: [], reason: "already_decided" });
            expect(await h.report(agentSession, [])).toEqual({ decided: [], reason: "no_visit" });
            expect(await h.store.readNodeExecution(second.nodeExecutionId)).toMatchObject({ state: "pending" });

            // The session recovered: the second visit completes normally.
            expect(await completeAs(h, agentSession, { outcome: "finish", output: { fact: "two" }, operation_id: "op-2", node_execution_id: second.nodeExecutionId }))
                .toMatchObject({ ok: true, outcome: "finish" });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
            expect(h.spawns).toHaveLength(2);
        } finally {
            await h.stop();
        }
    });
});
