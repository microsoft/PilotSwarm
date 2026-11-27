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
import { createWorkflow } from "../../src/workflow/service.ts";
import { workflowAgentSessionId } from "../../src/workflow/runtime.ts";
import { FilesystemSessionStore } from "../../src/session-store.ts";

const TIMEOUT = 300_000;
const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "agent-memory-owner", email: null, displayName: null };
const ACTOR = { kind: "system", name: "workflow-agent-memory-worker-test" };
const ENDED = ["completed", "failed", "cancelled", "stopped"];
const MEMO = "MEMO-1: the secret word is zebra-42.";
const PROBE = "memory_probe";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One agent step: `continue` visits it twice (again, then finish) with a wait of `waitSeconds` between; `new` once. */
function stepYaml(session, waitSeconds = 1) {
    return JSON.stringify({
        apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: `memory-${session}`, version: "1.0.0" }, initial: "talk",
        states: {
            talk: {
                type: "agent", invoke: { prompt: "Remember the secret word across cycles." }, session, timeoutSeconds: 600,
                transition: { next: session === "continue" ? { again: "pause", finish: "done", failure: "failed" } : { finish: "done", failure: "failed" } },
            },
            ...(session === "continue" ? { pause: { type: "wait", seconds: waitSeconds, transition: { next: { elapsed: "talk" } } } } : {}),
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
    return (await ctx.catalog.getSessionEvents(agentSession, 0, 1_000, types)).map(event => ({ type: event.eventType, data: event.data }));
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
                // No Stop for a visit its agent completed, and every turn's snapshot was committed.
                const agent = await agentSessionEvidence(ctx, agentSession, ["user.stop", "session.snapshot_unpublished"]);
                expect(agent, JSON.stringify(agent)).toEqual([]);
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
            let worker = await startWorker(ctx.env, ctx.modelProvidersPath, "memory-a", []);
            let workerB = null;
            try {
                const { runId } = await startStep(ctx, stepYaml("continue", 20));
                const agentSession = workflowAgentSessionId(runId, "talk");
                const evidence = async () => ({ state, visits: await talkVisits(ctx.store, runId),
                    agent: await agentSessionEvidence(ctx, agentSession, ["user.stop", "session.snapshot_unpublished", "session.turn_started"]) });
                // The first visit reports, its turn ends, and the run waits 20 s before the second visit.
                await until("the first visit's turn ends", async () => state.memoServedAt
                    && (await ctx.catalog.getSession(agentSession))?.state !== "running" ? true : null, 90_000, evidence);
                await pause(1_000);
                expect((await talkVisits(ctx.store, runId))).toHaveLength(1);
                await worker.stop();
                worker = null;
                workerB = await startWorker(ctx.env, ctx.modelProvidersPath, "memory-b", [], {
                    sessionStateDir: bStateDir, sessionStore: new FilesystemSessionStore(storeDir, bStateDir),
                });
                const run = await runEnded(ctx, runId, evidence);
                expect(run, JSON.stringify(await evidence())).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: { recalled: "zebra-42" } });
                expect(state.visit2Turn).toBe(2);
                expect(state.visit2SawMemo).toBe(true);
                expect(await agentSessionEvidence(ctx, agentSession, ["session.snapshot_unpublished"])).toEqual([]);
            } finally {
                await worker?.stop();
                await workerB?.stop();
            }
        });
    });
});
