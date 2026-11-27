/**
 * An agent step remembers its earlier visits (issue I1). A full PilotSwarmWorker (PostgreSQL, Duroxide and the Copilot
 * CLI) with the model scripted (scripted-model.mjs), as workflow-agent-turn-failure-worker.test.js runs one.
 *
 * When the agent reports its result with complete_workflow_node, its turn goes on: the model writes its reply. The visit's
 * end sends that turn no Stop, so the turn ends by itself and its snapshot (the session's memory) is committed; the next
 * visit's prompt waits behind it and starts a new turn on the new visit. After the report every tool refuses, the CLI's
 * built-in tools too, so the turn only finishes its reply.
 *
 * Before this change the visit's end stopped the turn: a stopped turn commits nothing, so the next visit started from the
 * snapshot before the earlier visit (and on another worker remembered nothing of it), and the CLI's built-in tools still
 * ran after the report.
 *
 * The turn's reply is bounded (review R1-1..R1-3): the run's end stops it before the session's end; a reply still running
 * WORKFLOW_AGENT_REPLY_SETTLE.ms after the report is stopped, also with turnTimeoutMs 0; and a reply lost with its Copilot
 * session is not replayed with the step's tools open. Review R2: neither when the report came in a recovery's own run
 * (R2-1), and a result written whose acknowledgement was lost closes the tools and bounds the reply as well (R2-3).
 * Review R3: also when the read-back comes while that write's COMMIT is still in flight (R3-1), and a session: new step's
 * turn retried after its result does not run the model again (R3-2).
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { useSuiteEnv } from "../helpers/local-env.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { FIXTURE_QUALIFIED_MODEL, registerScriptedProvider } from "../helpers/scripted-workers.js";
import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { controlWorkflowRun, createWorkflow, respondWorkflowApproval } from "../../src/workflow/service.ts";
import { workflowAgentSessionId } from "../../src/workflow/runtime.ts";
import { WorkflowStore, nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { parseApprovalCommand } from "../../src/workflow/approval.ts";
import { WORKFLOW_AGENT_REPLY_SETTLE } from "../../src/workflow/agent-node-service.ts";
import { FilesystemSessionStore } from "../../src/session-store.ts";

const TIMEOUT = 300_000;
const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "agent-memory-owner", email: null, displayName: null };
const ACTOR = { kind: "system", name: "workflow-agent-memory-worker-test" };
const ENDED = ["completed", "failed", "cancelled", "stopped"];
const MEMO = "MEMO-1: the secret word is zebra-42.";
const PROBE = "memory_probe";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One agent step: `continue` visits it twice (again, then finish) with a wait of 1 second between, or with `gate` an approval
 * the test answers; `new` once.
 */
function stepYaml(session, { gate = false } = {}) {
    const between = gate
        ? { gate: { type: "approval", question: "Run the next cycle?", timeoutSeconds: 3_600,
            transition: { next: { approved: "talk", rejected: "failed", timed_out: "failed", failure: "failed" } } } }
        : { gate: { type: "wait", seconds: 1, transition: { next: { elapsed: "talk" } } } };
    return JSON.stringify({
        apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: `memory-${session}`, version: "1.0.0" }, initial: "talk",
        states: {
            talk: {
                type: "agent", invoke: { prompt: "Remember the secret word across cycles." }, session, timeoutSeconds: 600,
                transition: { next: session === "continue" ? { again: "gate", finish: "done", failure: "failed" } : { finish: "done", failure: "failed" } },
            },
            ...(session === "continue" ? between : {}),
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
        },
    });
}

const textOf = message => typeof message?.content === "string" ? message.content
    : Array.isArray(message?.content) ? message.content.map(part => part?.text ?? "").join("") : "";
const visitOf = position => /"nodeExecutionId":"(nx-[0-9a-f]+)"/.exec(position.lastUserText)?.[1] ?? null;
const cycleOf = position => Number(/WORKFLOW NODE INVOCATION, CYCLE (\d+)\./.exec(position.lastUserText)?.[1] ?? 1);
const isStepRequest = body => (body.tools ?? []).some(tool => tool.function?.name === "complete_workflow_node");
const complete = (nodeExecutionId, outcome, operationId, output) => ({
    name: "complete_workflow_node", args: { outcome, output, operation_id: operationId, node_execution_id: nodeExecutionId },
});

async function until(label, check, timeoutMs, evidence = async () => ({})) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(250);
    }
    throw new Error(`boundary not reached: ${label}: ${JSON.stringify(await evidence()).slice(0, 8_000)}`);
}

function workerOptions(env, modelProvidersPath, workerNodeId, extra = {}) {
    return {
        store: env.store, githubToken: process.env.GITHUB_TOKEN, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema, sessionStateDir: env.sessionStateDir, workerNodeId, disableManagementAgents: true,
        logLevel: "error", modelProvidersPath, ...extra,
    };
}

/** A worker that uses the scripted model, with the probe tool registered. */
async function startWorker(env, modelProvidersPath, workerNodeId, probeCalls, extra = {}) {
    const worker = new PilotSwarmWorker(workerOptions(env, modelProvidersPath, workerNodeId, extra));
    worker.registerTools([defineTool(PROBE, {
        description: "Records that it ran. A test probe.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        handler: async () => { probeCalls.push(Date.now()); return { probed: true }; },
    })]);
    await worker.start();
    return worker;
}

/** The parts every case shares: the scripted model, a catalog and a client; `fn` starts its own workers. */
async function withFixture(respond, fn) {
    const env = getEnv();
    const model = await startScriptedModel({ respond: (body, position, record) => (isStepRequest(body) ? respond(body, position, record) : { content: "ok" }) });
    const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const client = new PilotSwarmClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema,
        modelProvidersPath });
    await client.start();
    try {
        return await fn({ env, model, modelProvidersPath, catalog, client, store: catalog.workflowStore(), duroxide: client._getDuroxideClient() });
    } finally {
        await client.stop();
        await catalog.close();
        await model.close();
    }
}

/** Start `yaml` under a new parent session, or under `delegate.parentSessionId` with its captured tool binding. */
async function startStep({ catalog, duroxide }, yaml, delegate = null) {
    const parent = delegate?.parentSessionId ?? randomUUID();
    if (!delegate) await catalog.createSession(parent, { owner: OWNER });
    const workflowSessionId = randomUUID();
    const created = await createWorkflow({ catalog, store: catalog.workflowStore(), duroxideClient: duroxide,
        ...(delegate ? { describeAgentTools: delegate.describeAgentTools } : {}) }, {
        workflowSessionId, parentSessionId: parent, yaml, actor: ACTOR, operationId: "create", publish: true,
        start: { inputs: {} }, notifyParent: false, ...(delegate ? { binding: delegate.binding } : {}),
    });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    return { workflowSessionId, runId: created.receipt.run.runId };
}

const runEnded = (ctx, runId, evidence) => until("the run ends", async () => {
    const row = await ctx.store.readRun(runId);
    return row && ENDED.includes(row.status) ? row : null;
}, 180_000, evidence);

/** The visits of the agent state, in order, and whether each was sent its prompt. */
async function talkVisits(store, runId) {
    const nodes = (await store.listNodeExecutions(runId)).filter(node => node.nodeId === "talk").sort((a, b) => a.ordinal - b.ordinal);
    return Promise.all(nodes.map(async node => ({ node, invocation: await store.readAgentInvocation(node.nodeExecutionId) })));
}

/** What the visits of a continued step saw: the first visit reports, then holds its reply until the second visit's prompt is sent. */
function continuedScript(state) {
    return async (body, position) => {
        const nx = visitOf(position);
        if (cycleOf(position) === 1) {
            state.visit1 ??= nx;
            if (position.step === 0) return { tools: [complete(nx, "again", "op-1", { said: "zebra-42" })] };
            if (position.step === 1) {
                state.reported = JSON.parse(position.toolResults[0] ?? "null");
                // The reply takes a while (`holdMs`), or waits until the next visit's prompt was sent, so that prompt reaches the
                // session while this turn runs. Either way the visit's end comes while the turn writes its reply.
                if (state.visit2Sent) state.waitedForVisit2 = await state.visit2Sent().catch(() => false);
                else await pause(state.holdMs ?? 0);
                state.memoServedAt = Date.now();
                return { content: MEMO };
            }
            return { content: "ok" };
        }
        if (position.step === 0) {
            state.visit2 = nx;
            state.visit2Turn = position.turn;
            state.visit2SawMemo = body.messages.some(message => message.role === "assistant" && textOf(message).includes(MEMO));
            state.visit2SawFirstPrompt = body.messages.some(message => message.role === "user" && textOf(message).includes(state.visit1 ?? "?"));
            return { tools: [complete(nx, "finish", "op-2", { recalled: state.visit2SawMemo ? "zebra-42" : "nothing" })] };
        }
        return { content: "Cycle 2 done." };
    };
}

async function agentSessionEvidence(ctx, agentSession, types) {
    return (await ctx.catalog.getSessionEvents(agentSession, 0, 1_000, types))
        .map(event => ({ seq: event.seq, type: event.eventType, worker: event.workerNodeId ?? null, data: event.data }));
}

/**
 * The first visit's turn ended by itself and was committed: no Stop naming it, and no unpublished snapshot before the
 * session's second turn started. (A Stop at the run's very end, of the last visit's reply, is allowed.)
 */
async function expectFirstTurnCommitted(ctx, agentSession, visit1) {
    const agent = await agentSessionEvidence(ctx, agentSession, ["user.stop", "session.snapshot_unpublished", "session.turn_started"]);
    const secondTurn = agent.filter(event => event.type === "session.turn_started")[1];
    expect(secondTurn, JSON.stringify(agent)).toBeTruthy();
    expect(agent.filter(event => event.type === "user.stop" && String(event.data?.requestId ?? "").includes(visit1)), JSON.stringify(agent)).toEqual([]);
    expect(agent.filter(event => event.type !== "session.turn_started" && event.seq < secondTurn.seq), JSON.stringify(agent)).toEqual([]);
    return { agent, secondTurn };
}

const CORRUPTED = "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.";

/**
 * A session: new step's turn ended after a fault that came after its result, and was not run again: the step's session
 * ended (so no run of that turn is still to come), no model request came after the fault, and the turn was not committed.
 */
async function expectSettledUnreplayed(ctx, runId, state, { counter = "afterFault", unpublished: mustBeUnpublished = true } = {}) {
    const [visit] = await talkVisits(ctx.store, runId);
    const agentSession = visit.invocation.childSessionId;
    const evidence = async () => ({ state, agent: await agentSessionEvidence(ctx, agentSession, ["session.turn_started", "session.snapshot_unpublished", "system.message"]) });
    await until("the step's session ends", async () => {
        const status = (await ctx.duroxide.getStatus(`session-${agentSession}`)).status;
        return ["Completed", "Failed", "Terminated"].includes(status) ? status : null;
    }, 90_000, evidence);
    expect(state[counter], JSON.stringify(await evidence())).toBe(0);
    if (!mustBeUnpublished) return;
    const unpublished = await agentSessionEvidence(ctx, agentSession, ["session.snapshot_unpublished"]);
    expect(unpublished.length, JSON.stringify(await evidence())).toBeGreaterThan(0);
}

describe("a Workflow agent step's turn after its report (issue I1, real worker)", () => {
    it("every tool refuses after the report, the CLI's built-in tools too; the turn finishes its reply", { timeout: TIMEOUT }, async () => {
        const marker = path.join(getEnv().baseDir, `after-report-${randomUUID()}.txt`);
        const state = {};
        const probeCalls = [];
        const respond = (body, position) => {
            const nx = visitOf(position);
            if (position.step === 0) {
                state.advertised = (body.tools ?? []).map(tool => tool.function?.name);
                return { tools: [complete(nx, "finish", "op-1", { said: "one" })] };
            }
            if (position.step === 1) {
                state.reported = JSON.parse(position.toolResults[0] ?? "null");
                return { tools: [
                    { name: "bash", args: { command: `echo after-report > ${marker}`, description: "write a marker" } },
                    { name: PROBE, args: {} },
                    complete(nx, "finish", "op-again", { said: "two" }),
                ] };
            }
            if (position.step === 2) {
                state.afterReport = position.toolResults;
                return { content: "Reported; nothing more to do." };
            }
            return { content: "ok" };
        };
        await withFixture(respond, async ctx => {
            const worker = await startWorker(ctx.env, ctx.modelProvidersPath, "memory-a", probeCalls);
            try {
                // The step gets the probe as its parent's delegated tool (the Workflow's captured tool binding).
                const parent = await ctx.client.createSession({ owner: OWNER, model: FIXTURE_QUALIFIED_MODEL, toolNames: [PROBE] });
                await parent.sendAndWait("Prepare the parent.", 60_000);
                const manager = worker.sessionManager;
                const { runId } = await startStep(ctx, stepYaml("new"), { parentSessionId: parent.sessionId,
                    binding: await manager.captureWorkflowToolBinding(parent.sessionId),
                    describeAgentTools: (...args) => manager.describeWorkflowAgentTools(...args) });
                const run = await runEnded(ctx, runId, async () => ({ state, visits: await talkVisits(ctx.store, runId) }));
                expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
                expect(state.advertised).toEqual(expect.arrayContaining(["bash", PROBE, "complete_workflow_node"]));
                expect(state.reported).toMatchObject({ ok: true, outcome: "finish" });
                const results = await until("the turn's reply after the report", async () => state.afterReport ?? null, 60_000, async () => state);
                expect(results, JSON.stringify(results)).toHaveLength(3);
                for (const result of results) expect(result, JSON.stringify(results)).toMatch(/result of this workflow step is recorded/);
                expect(fs.existsSync(marker), "the shell command ran after the report").toBe(false);
                expect(probeCalls).toEqual([]);
            } finally {
                await worker.stop();
            }
        });
    });

    it("session: continue: the visit's turn is not stopped, its memory is committed, and the next visit's prompt starts a new turn", { timeout: TIMEOUT }, async () => {
        const state = {};
        await withFixture(continuedScript(state), async ctx => {
            const worker = await startWorker(ctx.env, ctx.modelProvidersPath, "memory-a", []);
            try {
                const { runId, workflowSessionId } = await startStep(ctx, stepYaml("continue"));
                state.visit2Sent = () => until("the second visit's prompt is sent", async () => (await talkVisits(ctx.store, runId))[1]?.invocation?.spawnedAt ?? null, 60_000)
                    .then(() => true);
                const agentSession = workflowAgentSessionId(runId, "talk");
                const evidence = async () => ({ state, visits: await talkVisits(ctx.store, runId),
                    agent: await agentSessionEvidence(ctx, agentSession, ["user.stop", "session.snapshot_unpublished", "session.turn_started"]) });
                const run = await runEnded(ctx, runId, evidence);
                expect(run, JSON.stringify(await evidence())).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: { recalled: "zebra-42" } });
                expect(state.reported).toMatchObject({ ok: true, outcome: "again", nodeExecutionId: state.visit1 });
                // The second visit's prompt was sent while the first visit's turn still ran (its reply waited for it) ...
                expect(state.waitedForVisit2).toBe(true);
                // ... and started a new turn, bound to the second visit, with the first visit's turn in the conversation.
                expect(state.visit2).not.toBe(state.visit1);
                expect(state.visit2Turn).toBe(2);
                expect(state.visit2SawFirstPrompt).toBe(true);
                expect(state.visit2SawMemo).toBe(true);
                // No Stop for a visit its agent completed while the run was active, and its turn's snapshot was committed.
                await expectFirstTurnCommitted(ctx, agentSession, state.visit1);
                const ended = (await ctx.catalog.getSessionEvents(workflowSessionId, 0, 500, ["workflow.agent_cycle_ended"])).map(event => event.data);
                expect(ended.map(data => [data.nodeExecutionId, data.end, data.turnStopped])).toEqual([[state.visit1, "done", false], [state.visit2, "done", false]]);
            } finally {
                await worker.stop();
            }
        });
    });

    it("session: continue across a worker restart between visits: the second visit, on a new worker, recalls the first", { timeout: TIMEOUT }, async () => {
        const state = { holdMs: 4_000 };
        const script = continuedScript(state);
        await withFixture(script, async ctx => {
            // Worker B has its own local session folder: what it knows of the session comes from the committed snapshot.
            const storeDir = path.join(path.dirname(ctx.env.sessionStateDir), "session-store");
            const bStateDir = `${ctx.env.sessionStateDir}-b`;
            fs.mkdirSync(bStateDir, { recursive: true });
            const snapshots = new FilesystemSessionStore(storeDir, bStateDir);
            let worker = await startWorker(ctx.env, ctx.modelProvidersPath, "memory-a", []);
            let workerB = null;
            try {
                // The second visit waits for an approval the test gives after the worker restart.
                const { runId, workflowSessionId } = await startStep(ctx, stepYaml("continue", { gate: true }));
                const agentSession = workflowAgentSessionId(runId, "talk");
                const evidence = async () => ({ state, visits: await talkVisits(ctx.store, runId), snapshot: await snapshots.probeSnapshot(agentSession),
                    agent: await agentSessionEvidence(ctx, agentSession, ["user.stop", "session.snapshot_unpublished", "session.turn_started"]) });
                // The first visit reports and its turn ends; a committed snapshot of the session is the witness.
                await until("the first visit's turn is committed", async () => state.memoServedAt
                    && (await ctx.catalog.getSession(agentSession))?.state !== "running"
                    && (await snapshots.probeSnapshot(agentSession)).exists ? true : null, 90_000, evidence);
                const approvalId = nodeExecutionIdFor(runId, "root", "gate", 1);
                const approval = await until("the approval between the visits", async () => (await ctx.store.approvals.readMany([approvalId])).get(approvalId) ?? null,
                    60_000, evidence);
                expect(await talkVisits(ctx.store, runId)).toHaveLength(1);
                await worker.stop();
                worker = null;
                workerB = await startWorker(ctx.env, ctx.modelProvidersPath, "memory-b", [], { sessionStateDir: bStateDir, sessionStore: snapshots });
                await respondWorkflowApproval({ catalog: ctx.catalog, store: ctx.store, duroxideClient: ctx.duroxide }, workflowSessionId,
                    parseApprovalCommand({ operation: "approval_respond", operation_id: "next-cycle", run_id: runId, approval_id: approvalId,
                        context_sha256: approval.contextSha256, decision: "approved" }),
                    { kind: "user", provider: OWNER.provider, subject: OWNER.subject });
                const run = await runEnded(ctx, runId, evidence);
                expect(run, JSON.stringify(await evidence())).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: { recalled: "zebra-42" } });
                expect(state.visit2Turn).toBe(2);
                expect(state.visit2SawMemo).toBe(true);
                // Worker B ran the second visit's turn.
                const { secondTurn } = await expectFirstTurnCommitted(ctx, agentSession, state.visit1);
                expect(secondTurn.worker).toBe("memory-b");
            } finally {
                await worker?.stop();
                await workerB?.stop();
            }
        });
    });

    it("the run's end stops a completed visit's reply that still runs, though a later visit's own Stop does not reach it", { timeout: TIMEOUT }, async () => {
        let release = () => {};
        const held = new Promise(resolve => { release = resolve; });
        const state = {};
        const respond = async (_body, position) => {
            const nx = visitOf(position);
            if (cycleOf(position) === 1 && position.step === 0) return { tools: [complete(nx, "again", "op-1", { said: "zebra-42" })] };
            if (cycleOf(position) === 1 && position.step === 1) {
                state.holding = true;
                await Promise.race([held, pause(150_000)]);
                state.released = true;
                return { content: MEMO };
            }
            state.laterRequests = (state.laterRequests ?? 0) + 1;
            return { content: "ok" };
        };
        await withFixture(respond, async ctx => {
            const worker = await startWorker(ctx.env, ctx.modelProvidersPath, "memory-a", []);
            try {
                const { runId, workflowSessionId } = await startStep(ctx, stepYaml("continue"));
                const agentSession = workflowAgentSessionId(runId, "talk");
                const evidence = async () => ({ state, visits: await talkVisits(ctx.store, runId),
                    session: await ctx.duroxide.getStatus(`session-${agentSession}`).then(s => s.status, String),
                    agent: await agentSessionEvidence(ctx, agentSession, ["user.stop", "session.snapshot_unpublished", "session.turn_started"]) });
                // The first visit reported and holds its reply; the second visit's prompt is queued behind it.
                await until("the second visit's prompt is sent while the first reply is held", async () => state.holding
                    && (await talkVisits(ctx.store, runId))[1]?.invocation?.spawnedAt ? true : null, 60_000, evidence);
                await controlWorkflowRun({ catalog: ctx.catalog, store: ctx.store, duroxideClient: ctx.duroxide }, workflowSessionId,
                    { operation: "cancel", runId: null, reason: "enough" }, { actor: ACTOR, operationId: "cancel-held" });
                // Before the held reply is released: the run's end stopped that turn and the agent session ended.
                await until("the agent session ends", async () => {
                    const status = (await ctx.duroxide.getStatus(`session-${agentSession}`)).status;
                    return ["Completed", "Failed", "Terminated"].includes(status) ? status : null;
                }, 90_000, evidence);
                expect(state.released, "the held reply was not released").toBeUndefined();
                const stops = (await agentSessionEvidence(ctx, agentSession, ["user.stop"])).map(event => event.data?.requestId);
                expect(stops).toContain(`workflow-session-stop:${agentSession}`);
                expect(await runEnded(ctx, runId, evidence)).toMatchObject({ status: "cancelled" });
                // The second visit, decided by the cancel, never ran a model turn.
                expect(state.laterRequests ?? 0).toBe(0);
            } finally {
                release();
                await worker.stop();
            }
        });
    });

    it("a reply still running after the settle limit is stopped, with turnTimeoutMs 0; the next visit then runs", { timeout: TIMEOUT }, async () => {
        const state = { denied: 0 };
        const respond = async (_body, position) => {
            const nx = visitOf(position);
            if (cycleOf(position) === 1) {
                if (position.step === 0) return { tools: [complete(nx, "again", "op-1", { said: "zebra-42" })] };
                // The model never stops: after its result it keeps calling a tool, which is refused each time.
                state.reportedAt ??= Date.now();
                if (position.toolResults.some(text => /result of this workflow step is recorded/.test(text))) state.denied += 1;
                await pause(300);
                return { tools: [{ name: "bash", args: { command: "true", description: "keep going" } }] };
            }
            state.visit2At ??= Date.now();
            return position.step === 0 ? { tools: [complete(nx, "finish", "op-2", { recalled: "nothing" })] } : { content: "done" };
        };
        const before = WORKFLOW_AGENT_REPLY_SETTLE.ms;
        WORKFLOW_AGENT_REPLY_SETTLE.ms = 4_000;
        try {
            await withFixture(respond, async ctx => {
                const worker = await startWorker(ctx.env, ctx.modelProvidersPath, "memory-a", [], { turnTimeoutMs: 0 });
                try {
                    const { runId } = await startStep(ctx, stepYaml("continue"));
                    const agentSession = workflowAgentSessionId(runId, "talk");
                    const evidence = async () => ({ state, visits: await talkVisits(ctx.store, runId),
                        agent: await agentSessionEvidence(ctx, agentSession, ["user.stop", "session.snapshot_unpublished", "session.turn_started"]) });
                    expect(await runEnded(ctx, runId, evidence)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
                    expect(state.denied).toBeGreaterThan(0);
                    // The reply was stopped about 4 s after the result; the second visit's turn started then.
                    expect(state.visit2At - state.reportedAt).toBeLessThan(60_000);
                    const lost = await agentSessionEvidence(ctx, agentSession, ["session.snapshot_unpublished"]);
                    expect(lost.length, JSON.stringify(lost)).toBeGreaterThan(0);
                } finally {
                    await worker.stop();
                }
            });
        } finally {
            WORKFLOW_AGENT_REPLY_SETTLE.ms = before;
        }
    });

    it("a reply lost with its Copilot session after the report is not run again with the step's tools open", { timeout: TIMEOUT }, async () => {
        const marker = path.join(getEnv().baseDir, `replayed-${randomUUID()}.txt`);
        const state = { failed: 0, afterFault: 0 };
        const respond = (_body, position) => {
            const nx = visitOf(position);
            if (state.failed === 0) {
                if (position.step === 0) return { tools: [complete(nx, "finish", "op-1", { said: "one" })] };
                // After the result, the provider refuses the conversation as a corrupted transcript.
                state.failed += 1;
                return { httpStatus: 400, message: CORRUPTED };
            }
            // Any request after that runs the step's task again, which would run its tools again.
            state.afterFault += 1;
            return position.step === 0 ? { tools: [{ name: "bash", args: { command: `echo replayed > ${marker}`, description: "replay" } }] } : { content: "ok" };
        };
        await withFixture(respond, async ctx => {
            const worker = await startWorker(ctx.env, ctx.modelProvidersPath, "memory-a", []);
            try {
                const { runId } = await startStep(ctx, stepYaml("new"));
                const run = await runEnded(ctx, runId, async () => ({ state, visits: await talkVisits(ctx.store, runId) }));
                expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
                await expectSettledUnreplayed(ctx, runId, state);
                expect(state.failed).toBe(1);
                expect(fs.existsSync(marker), "the step's task ran again after its report").toBe(false);
            } finally {
                await worker.stop();
            }
        });
    });

    it("a step that reports in the recovery of a lost live session is not run again when that recovery's transcript is then refused", { timeout: TIMEOUT }, async () => {
        const marker = path.join(getEnv().baseDir, `replayed-${randomUUID()}.txt`);
        const state = { phase: "start", afterFault: 0 };
        const respond = (_body, position) => {
            const nx = visitOf(position);
            if (state.phase === "start") {
                // The first run loses its live Copilot session before the step reports.
                state.phase = "lost";
                return { httpStatus: 400, message: "Session not found: the live session is gone." };
            }
            if (state.phase === "lost") {
                // The recovery's own run reports the result; then the provider refuses its conversation.
                if (position.step === 0) return { tools: [complete(nx, "finish", "op-1", { said: "one" })] };
                state.phase = "corrupted";
                return { httpStatus: 400, message: CORRUPTED };
            }
            state.afterFault += 1;
            return position.step === 0 ? { tools: [{ name: "bash", args: { command: `echo replayed > ${marker}`, description: "replay" } }] } : { content: "ok" };
        };
        await withFixture(respond, async ctx => {
            const worker = await startWorker(ctx.env, ctx.modelProvidersPath, "memory-a", []);
            try {
                const { runId } = await startStep(ctx, stepYaml("new"));
                const run = await runEnded(ctx, runId, async () => ({ state, visits: await talkVisits(ctx.store, runId) }));
                expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: { said: "one" } });
                await expectSettledUnreplayed(ctx, runId, state);
                expect(state.phase).toBe("corrupted");
                expect(fs.existsSync(marker), "the step's task ran again after its report").toBe(false);
            } finally {
                await worker.stop();
            }
        });
    });

    // Reviews R2-3 and R3-1: the completion's write commits, but its call fails: after the commit (a lost acknowledgement), or
    // while the COMMIT is still in flight (the decision's row lock held when the worker reads the visit back; it lands after).
    const LOST_ACK = {
        "committed, then its acknowledgement lost": async function (original, input) {
            await original.call(this, input);
            throw new Error("Connection terminated unexpectedly");
        },
        "its COMMIT still in flight": async function (original, input) {
            // Another transaction holds the visit's row lock, as the decision's own does until its COMMIT lands. The decision
            // queues behind it, and commits 2 seconds after the worker saw its call fail.
            const holder = await this.pool.connect();
            await holder.query("BEGIN");
            await holder.query(`SELECT 1 FROM ${this.t.nodes} WHERE node_execution_id = $1 FOR UPDATE`, [input.nodeExecutionId]);
            original.call(this, input).catch(() => {});
            await pause(500);
            setTimeout(() => { holder.query("COMMIT").catch(() => {}).finally(() => holder.release()); }, 2_000);
            throw new Error("Connection terminated unexpectedly");
        },
    };
    for (const [writeFault, fault] of Object.entries(LOST_ACK)) it(`a result whose write commits though its call fails (${writeFault}) closes the turn's tools and bounds its reply`, { timeout: TIMEOUT }, async () => {
        const marker = path.join(getEnv().baseDir, `after-lost-ack-${randomUUID()}.txt`);
        const state = { denied: 0, steps: 0 };
        const respond = async (_body, position) => {
            const nx = visitOf(position);
            if (cycleOf(position) === 1) {
                if (position.step === 0) return { tools: [complete(nx, "again", "op-1", { said: "zebra-42" })] };
                if (position.step === 1) state.reported = JSON.parse(position.toolResults[0] ?? "null");
                if (position.toolResults.some(text => /result of this workflow step is recorded/.test(text))) state.denied += 1;
                // The model keeps going after the failed-looking completion (bounded, so a run without the fix ends too).
                state.steps += 1;
                if (state.steps > 40) return { content: "giving up" };
                await pause(300);
                return { tools: [{ name: "bash", args: { command: `echo after-ack > ${marker}`, description: "keep going" } }] };
            }
            state.visit2At ??= Date.now();
            return position.step === 0 ? { tools: [complete(nx, "finish", "op-2", { recalled: "nothing" })] } : { content: "done" };
        };
        const original = WorkflowStore.prototype.completeAgentNode;
        WorkflowStore.prototype.completeAgentNode = async function (input) {
            return input.operationId === "op-1" ? fault.call(this, original, input) : original.call(this, input);
        };
        const before = WORKFLOW_AGENT_REPLY_SETTLE.ms;
        WORKFLOW_AGENT_REPLY_SETTLE.ms = 4_000;
        try {
            await withFixture(respond, async ctx => {
                const worker = await startWorker(ctx.env, ctx.modelProvidersPath, "memory-a", [], { turnTimeoutMs: 0 });
                try {
                    const { runId } = await startStep(ctx, stepYaml("continue"));
                    const evidence = async () => ({ state, visits: await talkVisits(ctx.store, runId) });
                    expect(await runEnded(ctx, runId, evidence)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
                    // The model saw a failed completion, but the write had committed: the first visit's result is the one recorded.
                    expect(state.reported).toMatchObject({ ok: false });
                    const [visit1] = await talkVisits(ctx.store, runId);
                    expect(visit1.node).toMatchObject({ state: "completed", winner: "agent", outcome: "again" });
                    // No tool ran after it, and the reply was stopped by the reply limit rather than going on.
                    expect(fs.existsSync(marker), "a tool ran after the committed result").toBe(false);
                    expect(state.denied).toBeGreaterThan(0);
                    expect(state.steps).toBeLessThan(40);
                } finally {
                    await worker.stop();
                }
            });
        } finally {
            WORKFLOW_AGENT_REPLY_SETTLE.ms = before;
            WorkflowStore.prototype.completeAgentNode = original;
        }
    });

    it("a completion whose write did not commit leaves the visit open: the agent completes it again", { timeout: TIMEOUT }, async () => {
        const state = {};
        const respond = (_body, position) => {
            const nx = visitOf(position);
            if (cycleOf(position) === 1) {
                if (position.step === 0) return { tools: [complete(nx, "again", "op-1", { said: "zebra-42" })] };
                if (position.step === 1) {
                    state.first = JSON.parse(position.toolResults[0] ?? "null");
                    return { tools: [complete(nx, "again", "op-1b", { said: "zebra-42" })] };
                }
                if (position.step === 2) state.second = JSON.parse(position.toolResults[0] ?? "null");
                return { content: "Reported." };
            }
            return position.step === 0 ? { tools: [complete(nx, "finish", "op-2", { recalled: "nothing" })] } : { content: "done" };
        };
        const original = WorkflowStore.prototype.completeAgentNode;
        WorkflowStore.prototype.completeAgentNode = async function (input) {
            if (input.operationId === "op-1") throw new Error("Connection terminated unexpectedly");
            return original.call(this, input);
        };
        try {
            await withFixture(respond, async ctx => {
                const worker = await startWorker(ctx.env, ctx.modelProvidersPath, "memory-a", []);
                try {
                    const { runId } = await startStep(ctx, stepYaml("continue"));
                    expect(await runEnded(ctx, runId, async () => ({ state, visits: await talkVisits(ctx.store, runId) })))
                        .toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
                    expect(state.first).toMatchObject({ ok: false });
                    expect(state.second).toMatchObject({ ok: true, outcome: "again", operationId: "op-1b" });
                } finally {
                    await worker.stop();
                }
            });
        } finally {
            WorkflowStore.prototype.completeAgentNode = original;
        }
    });

    it("a session: new step's turn retried after its result was recorded does not run the model again (review R3-2)", { timeout: TIMEOUT }, async () => {
        const marker = path.join(getEnv().baseDir, `retried-${randomUUID()}.txt`);
        let release = () => {};
        const held = new Promise(resolve => { release = resolve; });
        const state = { afterReport: 0 };
        const respond = async (_body, position) => {
            const nx = visitOf(position);
            if (!state.reported) {
                if (position.step === 0) return { tools: [complete(nx, "finish", "op-1", { said: "one" })] };
                // The result is recorded; the reply is held while the worker stops, so the turn is cut and retried.
                state.reported = true;
                await Promise.race([held, pause(150_000)]);
                return { content: "late reply" };
            }
            state.afterReport += 1;
            return position.step === 0 ? { tools: [{ name: "bash", args: { command: `echo retried > ${marker}`, description: "again" } }] } : { content: "ok" };
        };
        await withFixture(respond, async ctx => {
            let worker = await startWorker(ctx.env, ctx.modelProvidersPath, "memory-a", []);
            let workerB = null;
            try {
                const { runId } = await startStep(ctx, stepYaml("new"));
                const evidence = async () => ({ state, visits: await talkVisits(ctx.store, runId) });
                await until("the result is recorded and the reply held", async () => state.reported
                    && (await talkVisits(ctx.store, runId))[0]?.node?.state === "completed" ? true : null, 60_000, evidence);
                await worker.stop();
                worker = null;
                release();
                workerB = await startWorker(ctx.env, ctx.modelProvidersPath, "memory-b", []);
                expect(await runEnded(ctx, runId, evidence)).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: { said: "one" } });
                await expectSettledUnreplayed(ctx, runId, state, { counter: "afterReport", unpublished: false });
                expect(fs.existsSync(marker), "the step's task ran again after its result").toBe(false);
            } finally {
                release();
                await worker?.stop();
                await workerB?.stop();
            }
        });
    });
});
