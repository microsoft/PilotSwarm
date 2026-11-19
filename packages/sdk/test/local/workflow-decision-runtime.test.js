/**
 * RED contract: Workflow decision states on the real durable runtime (duroxide PostgreSQL provider) and the real
 * PostgreSQL store, with the production registrations (design docs/proposals/workflow-decision-node.md v11: "Existing
 * path reused", "Retry and indoubt recovery", "Usage settlement", "Terminal semantics", "Runtime errors", "Test mode").
 *
 * The generic host dependency is fake and provider-neutral: `decisionNodes: { providerStore, providerFor }`.
 * - providerStore is the ProviderStore surface the chat path already uses: checkTurn(sessionId, model) is the budget gate;
 *   claimInferenceOperation / settleInferenceOperation are the provider_inference_operations ledger (key: operationId =
 *   node execution id, attempt = the effect entry's effect_attempts).
 * - providerFor(qualifiedModel) is the provider factory: a DecisionProvider (production: createDecisionProvider on the
 *   registry's resolved provider) or null when no provider serves the model. The runtime calls decide() with the
 *   deployment part of the qualified model and applies applyDecisionPolicy itself.
 *
 * The run's canonical model map is the existing per-node map column (workflow_runs.agent_models, keyed by state id:
 * { route: { model: "provider:model" } }). Start materialization of that map is not part of this runtime increment, so
 * these tests admit the run undispatched, store the map, then start the controller (as workflow-faults.test.js does).
 * Runtime error choices: no model for the state in the map is invalid_input (an invalid binding; never YAML, never a
 * chat default); budget paused is budget_exceeded; no paying provider or no provider for the model is unavailable.
 *
 * "Held" harnesses keep the runtime's own runDecision delivery waiting (a worker that took the activity and has not
 * answered) and make deliveries directly with the registered activity function: each direct call is one delivery of the
 * activity, so delivery 2 is a redelivery after a crash before the result reached Duroxide.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { canonicalJson } from "../../src/workflow/json.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { updateWorkflowFromTool } from "../../src/workflow/tools.ts";
import { completeWorkflowNodeFromTool } from "../../src/workflow/agent-node-service.ts";
import {
    registerWorkflow, WORKFLOW_ACTIVITIES, WORKFLOW_CONTROLLER_NAME, WORKFLOW_CONTROLLER_VERSION, workflowEffectInstanceId,
} from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { applyDecisionPolicy, DecisionProviderError } from "../../src/decision-provider.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = testTime.ms(180_000);
const ACTOR = { kind: "system", name: "workflow-decision-runtime-test" };
const QUALIFIED = "azure-foundry:ps-decision-1-1";
const DEPLOYMENT = "ps-decision-1-1";
const MAP = { route: { model: QUALIFIED } };
const TICKET = "Please refund invoice 42";

const CHOICE_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: decision-route, version: "1.0.0" }
initialInput: { ticket: "${TICKET}" }
initial: route
states:
  route:
    type: decision
    input: "\${input}"
    question:
      type: choice
      instructions: Which team should handle this ticket?
      criteria:
        engineering: Bugs, outages, integrations, and application failures
        billing: Charges, invoices, refunds, and payments
        support: Sign-in, account access, and how-to questions
    confidence: { minimumProbability: 0.8 }
    timeoutSeconds: 30
    transition:
      next: { engineering: to_engineering, billing: to_billing, support: to_support, uncertain: ask_person, failure: failed }
  to_engineering: { type: terminal, outcome: succeeded, output: "\${input}" }
  to_billing: { type: terminal, outcome: succeeded, output: "\${input}" }
  to_support: { type: terminal, outcome: succeeded, output: "\${input}" }
  ask_person: { type: terminal, outcome: blocked, output: "\${input}" }
  failed: { type: terminal, outcome: blocked, output: "\${runtime.error}" }
`;

const SCORE_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: decision-score, version: "1.0.0" }
initialInput: { answer: "Photosynthesis turns light into chemical energy." }
initial: grade
states:
  grade:
    type: decision
    input: "\${input}"
    question:
      type: score
      instructions: How complete is this answer?
      criteria: [poor, fair, good, excellent]
    transition: { next: { scored: use_score, failure: failed } }
  use_score:
    type: script
    source: |
      await setResult("ok", { seen: context.input, score: context.input.score, levels: context.input.levels });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: blocked, output: "\${runtime.error}" }
`;

const SCORE_AGENT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: decision-score-agent, version: "1.0.0" }
initialInput: { answer: "Photosynthesis turns light into chemical energy." }
initial: grade
schemas:
  ScoreInput:
    type: object
    required: [questionType, outcome, score, levels, model]
    properties:
      questionType: { type: string, const: score }
      outcome: { type: string, const: scored }
      score: { type: number }
      levels:
        type: array
        items:
          type: object
          required: [label, probability]
          properties:
            label: { type: string }
            probability: { type: number }
          additionalProperties: false
      model:
        type: object
        required: [qualified]
        properties:
          qualified: { type: string }
        additionalProperties: false
    additionalProperties: false
  ScoreReview:
    type: object
    required: [reviewed]
    properties:
      reviewed: { type: boolean }
    additionalProperties: false
states:
  grade:
    type: decision
    input: "\${input}"
    question:
      type: score
      instructions: How complete is this answer?
      criteria: [poor, fair, good, excellent]
    transition: { next: { scored: use_score, failure: failed } }
  use_score:
    type: agent
    input: "\${input}"
    invoke: { prompt: "Review the score result and finish the accepted route." }
    inputSchema: { $ref: "#/schemas/ScoreInput" }
    outputSchema: { $ref: "#/schemas/ScoreReview" }
    outcomes: [accepted]
    timeoutSeconds: 30
    transition: { next: { accepted: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: blocked, output: "\${runtime.error}" }
`;

const ROUTE = compileWorkflow(CHOICE_YAML).ir.nodes.route;
const GRADE = compileWorkflow(SCORE_YAML).ir.nodes.grade;
const choice = (selection, probabilities) => ({ questionType: "choice", selection, probabilities });
const BILLING = choice("billing", { engineering: 0.03, billing: 0.93, support: 0.04 });
const ENGINEERING = choice("engineering", { engineering: 0.91, billing: 0.05, support: 0.04 });
const SCORE = { questionType: "score", score: 2.4, levels: [
    { label: "poor", probability: 0.05 }, { label: "fair", probability: 0.15 }, { label: "good", probability: 0.4 }, { label: "excellent", probability: 0.4 },
] };
const semantic = answer => applyDecisionPolicy({ question: ROUTE.question, confidence: ROUTE.confidence, answer, model: QUALIFIED });
/** A raw systemone body for a choice answer (what a test fixture or a parent's test answer carries). */
const raw = answer => ({ answers: { decision: { type: "choice", choice: answer.selection, probabilities: answer.probabilities } },
    usage: { input_tokens: 412, output_tokens: 6 } });

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + testTime.ms(timeoutMs);
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, testTime.ms(ms)));
const AGENT_CHILD = "test-decision-score-agent-child";
function* decisionScoreAgentChild(ctx) {
    for (;;) yield ctx.dequeueEvent("messages");
}

/**
 * The fake generic Decision host. `scenario` is read at each call, so one registration serves every case; every call is
 * logged in order. The ledger is in memory: a claim is idempotent by `${operationId}/${attempt}`, and every settlement
 * is kept so a test can count them.
 */
function fakeDecisionHost() {
    const scenario = { verdict: "clear", resolves: true, answer: () => ({ answer: BILLING, usage: { inputTokens: 412, outputTokens: 6 } }) };
    const log = [];
    const claims = new Map();
    const settlements = new Map();
    const requests = [];
    const providerStore = {
        async checkTurn(sessionId, model) {
            log.push(["checkTurn", sessionId, model]);
            const paying = scenario.verdict !== "no_provider";
            return { verdict: scenario.verdict, providerName: paying ? "azure-foundry" : null, modelQualified: paying ? model : null, exempt: false,
                pause: scenario.verdict === "paused" ? { kind: "limit", provider: "azure-foundry", modelQualified: model } : null, rules: [] };
        },
        async claimInferenceOperation(claim) {
            const key = `${claim.operationId}/${claim.attempt}`;
            log.push(["claim", key]);
            if (claims.has(key)) return false;
            claims.set(key, claim);
            return true;
        },
        async settleInferenceOperation(usage) {
            const key = `${usage.operationId}/${usage.attempt}`;
            log.push(["settle", key]);
            const kept = settlements.get(key) ?? [];
            kept.push(usage);
            settlements.set(key, kept);
            return kept.length === 1;
        },
    };
    const providerFor = async (model) => {
        log.push(["providerFor", model]);
        if (!scenario.resolves) return null;
        return {
            async decide(request) {
                requests.push(request);
                log.push(["decide", request.model]);
                return scenario.answer(request, requests.length);
            },
        };
    };
    return { scenario, log, claims, settlements, requests, decisionNodes: { providerStore, providerFor } };
}

/** One delivery of an activity, made by the test: the activity context a worker gives it. */
const activityContext = h => ({
    isCancelled: () => false, traceInfo: () => {}, traceWarn: () => {}, traceError: () => {}, traceDebug: () => {}, getClient: () => h.client,
});

/**
 * A worker-equivalent registration with `decisionNodes`. With `hold`, the runtime's own runDecision deliveries wait in
 * `held` (by node execution) until released, and then report the state decided elsewhere; `real` has the registered
 * runDecision and recordEffectResult functions for the test's own deliveries.
 */
async function harness(env, { decisionNodes, hold = false } = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const store = catalog.workflowStore();
    const db = new pg.Pool({ connectionString: env.store, max: 1 });
    const runtime = new Runtime(provider, {
        // The held-delivery cases keep several simulated crashed workers blocked while the test drives redeliveries directly.
        workerConcurrency: 16, dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    const real = {};
    const held = new Map();
    const agentSpawns = [];
    runtime.registerOrchestrationVersioned(AGENT_CHILD, "1.0.0", decisionScoreAgentChild);
    const agentNodes = {
        async spawn(request) {
            agentSpawns.push(request);
            const instanceId = `session-${request.childSessionId}`;
            await client.startOrchestrationVersioned(instanceId, AGENT_CHILD, {}, "1.0.0");
            await client.enqueueEvent(instanceId, "messages", JSON.stringify({
                prompt: request.prompt, clientMessageIds: [request.clientMessageId],
            }));
            return { spawned: true };
        },
    };
    const registrar = {
        registerActivity: (name, fn) => {
            if (name === WORKFLOW_ACTIVITIES.recordEffectResult) real.record = fn;
            if (WORKFLOW_ACTIVITIES.runDecision !== undefined && name === WORKFLOW_ACTIVITIES.runDecision) {
                real.runDecision = fn;
                if (hold) {
                    runtime.registerActivity(name, async (_actx, input) => {
                        let release;
                        const released = new Promise(resolve => { release = resolve; });
                        held.set(input.nodeExecutionId, { input, release });
                        await released;
                        return { kind: "completed" };
                    });
                    return;
                }
            }
            runtime.registerActivity(name, fn);
        },
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    };
    registerWorkflow(registrar, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows have no parent to notify."); },
        deleteSession: async (sessionId) => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        agentNodes,
        decisionNodes,
    });
    await runtime.start();
    return {
        env, catalog, store, client, db, real, held, agentSpawns,
        host: {
            catalog, store, duroxideClient: client,
            checkAgentModel: async () => null,
            decisionCapability: async () => ({ available: true, defaultModel: QUALIFIED, models: [QUALIFIED], reason: null }),
        },
        async stop() {
            for (const entry of held.values()) entry.release();
            await runtime.shutdown(100);
            await db.end();
            await catalog.close();
        },
    };
}

/** Store `models` as the run's canonical per-node model map (the existing agent_models column). */
async function setModelMap(h, runId, models) {
    const text = canonicalJson(models);
    const { rowCount } = await h.db.query(`UPDATE "${h.env.cmsSchema}".workflow_runs SET agent_models = $1 WHERE run_id = $2`, [text, runId]);
    expect(rowCount).toBe(1);
    expect((await h.store.readRun(runId)).agentModels).toBe(text);
}

/** Admit a run of `yaml` undispatched, store `models` (unless null) as its model map, then start its controller. */
async function startDecisionRun(h, yaml, models) {
    const workflowSessionId = randomUUID();
    const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
    const created = await createWorkflow(undispatched, { workflowSessionId, parentSessionId: null, yaml, actor: ACTOR, operationId: "start",
        start: { inputs: {} } });
    const { runId, controllerInstanceId } = created.receipt.run;
    if (models !== null) await setModelMap(h, runId, models);
    else {
        // Runtime-only defense: Start now materializes a Decision model, so corrupt the stored binding after admission
        // to exercise the activity's invalid-input backstop without bypassing the production Start gate.
        const { rowCount } = await h.db.query(`UPDATE "${h.env.cmsSchema}".workflow_runs SET agent_models = NULL WHERE run_id = $1`, [runId]);
        expect(rowCount).toBe(1);
    }
    await h.client.startOrchestrationVersioned(controllerInstanceId, WORKFLOW_CONTROLLER_NAME, { v: 1, workflowSessionId, runId }, WORKFLOW_CONTROLLER_VERSION);
    return { workflowSessionId, runId, controllerInstanceId };
}

/** A run of CHOICE_YAML whose decision's runtime delivery is held: the test's own deliveries of it, and its node execution. */
async function heldDecision(h, models) {
    const run = await startDecisionRun(h, CHOICE_YAML, models);
    const nx = nodeExecutionIdFor(run.runId, "root", "route", 1);
    const held = await until(async () => h.held.get(nx), `the runtime's runDecision delivery of ${nx}`);
    return { run, nx, held, deliver: () => h.real.runDecision(activityContext(h), held.input),
        record: outcome => h.real.record(activityContext(h), { ...held.input, outcome }) };
}

async function finished(h, runId) {
    return until(async () => {
        const run = await h.store.readRun(runId);
        return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, `run ${runId} to finish`);
}

const unknownUsage = usage => usage !== undefined && (usage.tokensInput ?? null) === null && (usage.tokensOutput ?? null) === null;

describe("workflow decision states: effect execution, attempts and the terminal compare-and-swap", () => {
    it("routes from the stored semantic result of one provider call with the run's model, its budget gate and one ledger row", { timeout: TIMEOUT }, async () => {
        expect(WORKFLOW_ACTIVITIES.runDecision).toBe("workflow.runDecision");
        const fake = fakeDecisionHost();
        const h = await harness(getEnv(), { decisionNodes: fake.decisionNodes });
        try {
            const run = await startDecisionRun(h, CHOICE_YAML, MAP);
            const ended = await finished(h, run.runId);
            const expected = semantic(BILLING);
            expect(ended.status, JSON.stringify(ended.terminalError)).toBe("completed");
            expect(ended).toMatchObject({ terminalNodeId: "to_billing", terminalOutcome: "succeeded" });
            expect(ended.terminalOutput).toEqual(expected);
            const nx = nodeExecutionIdFor(run.runId, "root", "route", 1);
            expect(await h.store.readNodeExecution(nx)).toMatchObject({
                nodeType: "decision", state: "completed", outcome: "billing", resultKind: "business", winner: "effect", effectAttempts: 1, error: null,
            });
            expect((await h.store.readNodeExecution(nx)).output).toEqual(expected);
            // One provider call: the deployment of the run's model (never YAML, never a chat default), the state's input,
            // its question and its own timeout.
            expect(fake.requests).toHaveLength(1);
            const [request] = fake.requests;
            expect(request.signal).toBeInstanceOf(AbortSignal);
            expect({ model: request.model, state: request.state, question: request.question, timeoutMs: request.timeoutMs })
                .toEqual({ model: DEPLOYMENT, state: { ticket: TICKET }, question: ROUTE.question, timeoutMs: 30_000 });
            expect(fake.log.filter(entry => entry[0] === "providerFor")).toEqual([["providerFor", QUALIFIED]]);
            // The budget gate is the chat path's ProviderStore.checkTurn(the workflow's session, the qualified model).
            expect(fake.log.filter(entry => entry[0] === "checkTurn")).toEqual([["checkTurn", run.workflowSessionId, QUALIFIED]]);
            const order = fake.log.map(entry => entry[0]);
            expect(order.indexOf("checkTurn")).toBeLessThan(order.indexOf("claim"));
            expect(order.indexOf("claim")).toBeLessThan(order.indexOf("decide"));
            expect(order.indexOf("decide")).toBeLessThan(order.indexOf("settle"));
            // The ledger row: operation = node execution, attempt = the effect entry; settled once with the returned usage.
            expect([...fake.claims.keys()]).toEqual([`${nx}/1`]);
            const claim = fake.claims.get(`${nx}/1`);
            expect(claim).toMatchObject({ operationId: nx, attempt: 1, capability: "decision", sessionId: run.workflowSessionId,
                workflowRunId: run.runId, nodeExecutionId: nx, providerName: "azure-foundry", modelQualified: QUALIFIED });
            expect(typeof claim.purpose === "string" && claim.purpose.length > 0).toBe(true);
            expect(fake.settlements.get(`${nx}/1`)).toEqual([expect.objectContaining({ operationId: nx, attempt: 1, tokensInput: 412, tokensOutput: 6 })]);
        } finally { await h.stop(); }
    });

    it("passes a score decision's semantic output unchanged to the next script's input and on to the run's output", { timeout: TIMEOUT }, async () => {
        expect(WORKFLOW_ACTIVITIES.runDecision).toBe("workflow.runDecision");
        const fake = fakeDecisionHost();
        fake.scenario.answer = () => ({ answer: SCORE, usage: null });
        const h = await harness(getEnv(), { decisionNodes: fake.decisionNodes });
        try {
            const run = await startDecisionRun(h, SCORE_YAML, { grade: { model: QUALIFIED } });
            const ended = await finished(h, run.runId);
            const expected = applyDecisionPolicy({ question: GRADE.question, answer: SCORE, model: QUALIFIED });
            expect(ended.status, JSON.stringify(ended.terminalError)).toBe("completed");
            expect(ended.terminalOutput).toEqual({ seen: expected, score: 2.4, levels: expected.levels });
            const grade = nodeExecutionIdFor(run.runId, "root", "grade", 1);
            expect(await h.store.readNodeExecution(grade)).toMatchObject({ outcome: "scored", resultKind: "business", winner: "effect" });
            expect((await h.store.readNodeExecution(grade)).output).toEqual(expected);
            expect((await h.store.readNodeExecution(nodeExecutionIdFor(run.runId, "root", "use_score", 1))).input).toEqual(expected);
            // Usage the provider did not report is unknown (NULL), not zero; it is settled once.
            const settled = fake.settlements.get(`${grade}/1`);
            expect(settled).toHaveLength(1);
            expect(unknownUsage(settled[0])).toBe(true);
        } finally { await h.stop(); }
    });

    it("passes a score decision's semantic output unchanged to the next agent task input and routes the agent outcome normally", { timeout: TIMEOUT }, async () => {
        expect(WORKFLOW_ACTIVITIES.runDecision).toBe("workflow.runDecision");
        const fake = fakeDecisionHost();
        const providerAnswer = {
            ...SCORE,
            levels: [
                { label: "poor", probability: 0.05 },
                { label: "fair", probability: 0.55 },
                { label: "good", probability: 0.1 },
                { label: "excellent", probability: 0.3 },
            ],
            attemptId: "provider-attempt-9",
            requestId: "provider-request-9",
            rawPayload: { answers: { decision: { type: "score" } } },
            usage: { inputTokens: 999, outputTokens: 999 },
        };
        fake.scenario.answer = () => ({
            answer: providerAnswer,
            usage: { inputTokens: 412, outputTokens: 6 },
            attemptId: "response-attempt-9",
            requestId: "response-request-9",
            rawPayload: providerAnswer.rawPayload,
        });
        const h = await harness(getEnv(), { decisionNodes: fake.decisionNodes });
        try {
            const run = await startDecisionRun(h, SCORE_AGENT_YAML, { grade: { model: QUALIFIED } });
            const [spawn] = await until(async () => (h.agentSpawns.length > 0 ? h.agentSpawns : null), "the score agent state's child");
            const expected = applyDecisionPolicy({ question: GRADE.question, answer: providerAnswer, model: QUALIFIED });
            const promptLines = spawn.prompt.split("\n");
            expect(promptLines).toHaveLength(4);
            const [systemLine, contractText, taskHeader, task] = promptLines;
            const contract = JSON.parse(contractText);

            expect(systemLine).toContain("[SYSTEM: WORKFLOW NODE INVOCATION.");
            expect(taskHeader).toBe("[SYSTEM: The task of this state, from the workflow's definition:]");
            expect(spawn).toMatchObject({
                stateId: "use_score",
                task: { source: "prompt", prompt: "Review the score result and finish the accepted route." },
            });
            expect(task).toBe("Review the score result and finish the accepted route.");
            expect(contract).toMatchObject({
                workflowSessionId: run.workflowSessionId,
                runId: run.runId,
                stateId: "use_score",
                taskSource: "inline prompt",
                inputSchema: "ScoreInput",
                outputSchema: "ScoreReview",
                outcomes: ["accepted"],
            });
            expect(contract.input).toEqual(expected);
            expect(contract.input.levels).toEqual([
                { label: "poor", probability: 0.05 },
                { label: "fair", probability: 0.55 },
                { label: "good", probability: 0.1 },
                { label: "excellent", probability: 0.3 },
            ]);
            expect(Object.keys(contract.input).sort()).toEqual(["levels", "model", "outcome", "questionType", "score"]);
            for (const transportField of ["attemptId", "requestId", "rawPayload", "usage"]) {
                expect(contract.input).not.toHaveProperty(transportField);
            }

            const gradeNode = nodeExecutionIdFor(run.runId, "root", "grade", 1);
            expect((await h.store.readNodeExecution(gradeNode)).output).toEqual(expected);
            const agentNode = nodeExecutionIdFor(run.runId, "root", "use_score", 1);
            expect(await h.store.readNodeExecution(agentNode)).toMatchObject({ nodeType: "agent", state: "pending" });
            expect((await h.store.readNodeExecution(agentNode)).input).toEqual(expected);
            const completion = JSON.parse(await completeWorkflowNodeFromTool({
                outcome: "accepted", output: { reviewed: true }, operation_id: "score-review-1", node_execution_id: agentNode,
            }, { callerSessionId: spawn.childSessionId, store: h.store, client: h.client }));
            expect(completion, JSON.stringify(completion)).toMatchObject({
                ok: true, replayed: false, nodeExecutionId: agentNode, kind: "result", outcome: "accepted",
            });

            const ended = await finished(h, run.runId);
            expect(ended).toMatchObject({
                status: "completed", terminalNodeId: "done", terminalOutcome: "succeeded", terminalOutput: { reviewed: true },
            });
            expect(await h.store.readNodeExecution(agentNode)).toMatchObject({
                state: "completed", outcome: "accepted", resultKind: "business", winner: "agent", output: { reviewed: true },
            });
            expect(fake.requests).toHaveLength(1);
            expect(h.agentSpawns).toHaveLength(1);
        } finally { await h.stop(); }
    });

    it("counts deliveries as effect entries: 1 and 2 may call the provider, 3 is unavailable with no resolution, budget, claim or call; one result commits", { timeout: TIMEOUT }, async () => {
        expect(WORKFLOW_ACTIVITIES.runDecision).toBe("workflow.runDecision");
        const fake = fakeDecisionHost();
        fake.scenario.answer = (_request, call) => (call === 1
            ? { answer: ENGINEERING, usage: { inputTokens: 11, outputTokens: 2 } }
            : { answer: BILLING, usage: null });
        const h = await harness(getEnv(), { decisionNodes: fake.decisionNodes, hold: true });
        try {
            const d = await heldDecision(h, MAP);
            expect(await h.store.readNodeExecution(d.nx)).toMatchObject({ state: "pending", effectAttempts: 0 });

            // Delivery 1 enters (effect_attempts 1, in the entry transaction) and calls the provider. Its result never
            // reaches Duroxide: the worker is lost before the activity completes.
            const first = await d.deliver();
            expect(first).toMatchObject({ kind: "result", result: { outcome: "engineering", resultKind: "business", winner: "effect" } });
            expect(JSON.parse(first.result.valueText)).toEqual(semantic(ENGINEERING));
            expect(await h.store.readNodeExecution(d.nx)).toMatchObject({ state: "pending", effectAttempts: 1 });

            // Delivery 2 (the redelivery) is the last entry that may call the provider; it calls it again.
            const second = await d.deliver();
            expect(second).toMatchObject({ kind: "result", result: { outcome: "billing", resultKind: "business", winner: "effect" } });
            expect(await h.store.readNodeExecution(d.nx)).toMatchObject({ state: "pending", effectAttempts: 2 });
            // At least once externally: the entry cap bounds committed entries, not the network. One node execution made
            // two provider calls (a non-mutating inference: usage and cost, no external side effect).
            expect(fake.requests).toHaveLength(2);

            // Delivery 3 enters and records unavailable at once: no model resolution, no budget check, no claim, no call.
            const from = fake.log.length;
            const third = await d.deliver();
            expect(third).toMatchObject({ kind: "result", result: { outcome: "unavailable", resultKind: "runtime_error", winner: "effect" } });
            expect(JSON.parse(third.result.valueText).code).toBe("unavailable");
            expect(fake.log.slice(from)).toEqual([]);
            expect(fake.requests).toHaveLength(2);
            expect(await h.store.readNodeExecution(d.nx)).toMatchObject({ state: "pending", effectAttempts: 3 });

            // One ledger row per attempt key, each settled exactly once; attempt 2's unreported usage stays unknown.
            expect([...fake.claims.keys()].sort()).toEqual([`${d.nx}/1`, `${d.nx}/2`]);
            for (const attempt of [1, 2]) {
                expect(fake.claims.get(`${d.nx}/${attempt}`)).toMatchObject({ operationId: d.nx, attempt, capability: "decision", modelQualified: QUALIFIED });
                expect(fake.settlements.get(`${d.nx}/${attempt}`)).toHaveLength(1);
            }
            expect(fake.settlements.get(`${d.nx}/1`)[0]).toMatchObject({ tokensInput: 11, tokensOutput: 2 });
            expect(unknownUsage(fake.settlements.get(`${d.nx}/2`)[0])).toBe(true);

            // The terminal result is exactly once: the result Duroxide recorded (delivery 2's) wins the pending-only CAS
            // through recordEffectResult and completeNode; every other result loses and reads the stored row.
            expect(await d.record(second)).toEqual({ nodeExecutionId: d.nx, won: true, outcome: "billing" });
            expect(await d.record(first)).toEqual({ nodeExecutionId: d.nx, won: false, outcome: "billing" });
            expect(await d.record(third)).toEqual({ nodeExecutionId: d.nx, won: false, outcome: "billing" });
            const late = await h.store.completeNode(d.nx, first.result);
            expect(late.won).toBe(false);
            expect(late.node).toMatchObject({ state: "completed", outcome: "billing", resultKind: "business", winner: "effect", effectAttempts: 3 });
            expect(late.node.output).toEqual(semantic(BILLING));

            // The controller routes from the stored row.
            d.held.release();
            const ended = await finished(h, d.run.runId);
            expect(ended).toMatchObject({ status: "completed", terminalNodeId: "to_billing" });
            expect(ended.terminalOutput).toEqual(semantic(BILLING));
        } finally { await h.stop(); }
    });

    it("fails closed before any provider call (invalid_input, budget_exceeded, unavailable) and never retries a provider failure inside the activity", { timeout: TIMEOUT }, async () => {
        expect(WORKFLOW_ACTIVITIES.runDecision).toBe("workflow.runDecision");
        const fake = fakeDecisionHost();
        const h = await harness(getEnv(), { decisionNodes: fake.decisionNodes, hold: true });
        /** One delivery: its result, the host calls it made (by kind), and how many provider calls. */
        const observe = async deliver => {
            const from = fake.log.length;
            const calls = fake.requests.length;
            const delivered = await deliver();
            return { delivered, kinds: fake.log.slice(from).map(entry => entry[0]), calls: fake.requests.length - calls };
        };
        const failedWith = (seen, code) => {
            expect(seen.delivered, JSON.stringify(seen)).toMatchObject({ kind: "result", result: { outcome: code, resultKind: "runtime_error", winner: "effect" } });
            expect(JSON.parse(seen.delivered.result.valueText).code).toBe(code);
        };
        try {
            // No model for the state in the run's map: invalid_input. Nothing is resolved, checked, claimed or called.
            const unmapped = await heldDecision(h, null);
            let seen = await observe(unmapped.deliver);
            failedWith(seen, "invalid_input");
            expect(seen.kinds).toEqual([]);
            expect(seen.calls).toBe(0);
            // The stored result routes the failure like any other runtime error.
            expect(await unmapped.record(seen.delivered)).toEqual({ nodeExecutionId: unmapped.nx, won: true, outcome: "invalid_input" });

            // A paused budget: budget_exceeded after the gate; never claimed or called.
            fake.scenario.verdict = "paused";
            const paused = await heldDecision(h, MAP);
            seen = await observe(paused.deliver);
            failedWith(seen, "budget_exceeded");
            expect(fake.log.filter(entry => entry[0] === "checkTurn").at(-1)).toEqual(["checkTurn", paused.run.workflowSessionId, QUALIFIED]);
            expect(seen.kinds).not.toContain("claim");
            expect(seen.calls).toBe(0);

            // No provider pays for the model (checkTurn no_provider): unavailable; never claimed or called.
            fake.scenario.verdict = "no_provider";
            seen = await observe((await heldDecision(h, MAP)).deliver);
            failedWith(seen, "unavailable");
            expect(seen.kinds).not.toContain("claim");
            expect(seen.calls).toBe(0);

            // No provider serves the model (the factory has none): unavailable; never claimed or called.
            fake.scenario.verdict = "clear";
            fake.scenario.resolves = false;
            seen = await observe((await heldDecision(h, MAP)).deliver);
            failedWith(seen, "unavailable");
            expect(seen.kinds).not.toContain("claim");
            expect(seen.calls).toBe(0);

            // Provider failures (429, 5xx and network are unavailable in the adapter; its timeout is timed_out): one call per
            // delivery, no retry inside the activity, the code kept, and the claimed attempt settled once as unknown usage.
            // An adapter failure that is not a DecisionProviderError is execution_failed. Two deliveries per node.
            fake.scenario.resolves = true;
            const failures = [
                ["unavailable", new DecisionProviderError("unavailable", "The Decision provider is throttling requests.")],
                ["timed_out", new DecisionProviderError("timed_out", "The Decision provider did not answer within the timeout.")],
                ["forbidden", new DecisionProviderError("forbidden", "The Decision provider refused the credential.")],
                ["execution_failed", new Error("an adapter bug")],
            ];
            for (let index = 0; index < failures.length; index += 2) {
                const d = await heldDecision(h, MAP);
                for (const [offset, [code, error]] of failures.slice(index, index + 2).entries()) {
                    fake.scenario.answer = () => { throw error; };
                    seen = await observe(d.deliver);
                    failedWith(seen, code);
                    expect(seen.calls).toBe(1);
                    const key = `${d.nx}/${offset + 1}`;
                    expect(fake.claims.has(key)).toBe(true);
                    expect(fake.settlements.get(key)).toHaveLength(1);
                    expect(unknownUsage(fake.settlements.get(key)[0])).toBe(true);
                }
            }
        } finally { await h.stop(); }
    });

    it("keeps the lifecycle winner: a cancel committed first stops a delivery before any provider work, and a late result reads the stored row", { timeout: TIMEOUT }, async () => {
        expect(WORKFLOW_ACTIVITIES.runDecision).toBe("workflow.runDecision");
        const fake = fakeDecisionHost();
        const h = await harness(getEnv(), { decisionNodes: fake.decisionNodes, hold: true });
        try {
            const d = await heldDecision(h, MAP);
            await h.client.enqueueEvent(d.run.controllerInstanceId, "messages",
                JSON.stringify({ type: "cmd", cmd: "cancel", id: "cancel-1", args: { reason: "decision CAS test" } }));
            const ended = await finished(h, d.run.runId);
            expect(ended.status).toBe("cancelled");
            expect(await h.store.readNodeExecution(d.nx)).toMatchObject({ state: "completed", outcome: "cancelled", winner: "cancel", effectAttempts: 0 });
            // A delivery after the cancel commits enters nothing and does no provider work.
            const from = fake.log.length;
            expect(await d.deliver()).toEqual({ kind: "completed" });
            expect(fake.log.slice(from)).toEqual([]);
            expect(fake.requests).toHaveLength(0);
            expect((await h.store.readNodeExecution(d.nx)).effectAttempts).toBe(0);
            // A late result (from a delivery that was already calling the provider) loses the CAS; the stored row is returned.
            const late = { kind: "result", result: { outcome: "billing", resultKind: "business", winner: "effect", valueText: canonicalJson(semantic(BILLING)) } };
            expect(await d.record(late)).toEqual({ nodeExecutionId: d.nx, won: false, outcome: "cancelled" });
            const stored = await h.store.completeNode(d.nx, late.result);
            expect(stored).toMatchObject({ won: false, node: { state: "completed", outcome: "cancelled", winner: "cancel", output: null } });
        } finally { await h.stop(); }
    });

    it("collects an unresolved decision only once its effect is terminal: nothing while it runs, then execution_failed through completeNode", { timeout: TIMEOUT }, async () => {
        expect(WORKFLOW_ACTIVITIES.runDecision).toBe("workflow.runDecision");
        const fake = fakeDecisionHost();
        const h = await harness(getEnv(), { decisionNodes: fake.decisionNodes, hold: true });
        try {
            const d = await heldDecision(h, MAP);
            // Several backstop collections (every 500 ms) while the effect runs: no action.
            await sleep(2_500);
            expect((await h.client.getStatus(workflowEffectInstanceId(d.nx))).status).toBe("Running");
            expect(await h.store.readNodeExecution(d.nx)).toMatchObject({ state: "pending", winner: null });
            expect((await h.store.readRun(d.run.runId)).status).toBe("running");
            // The effect ends without storing a result (terminated, or its record exhausted its retries).
            await h.client.cancelInstance(workflowEffectInstanceId(d.nx), "terminated by the test");
            const ended = await finished(h, d.run.runId);
            expect(ended).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "failed" });
            expect(ended.terminalOutput).toMatchObject({ code: "execution_failed", details: { effectStatus: "Failed" } });
            expect(await h.store.readNodeExecution(d.nx)).toMatchObject({
                state: "completed", outcome: "execution_failed", resultKind: "runtime_error", winner: "controller",
            });
            expect(fake.requests).toHaveLength(0);
            const late = await h.store.completeNode(d.nx, { outcome: "billing", resultKind: "business", valueText: canonicalJson(semantic(BILLING)), winner: "effect" });
            expect(late).toMatchObject({ won: false, node: { outcome: "execution_failed", winner: "controller" } });
        } finally { await h.stop(); }
    });

    it("intercepts a test run's decision: a raw fixture decides it through the parser, and with none it waits for the parent; no provider is touched", { timeout: TIMEOUT }, async () => {
        expect(WORKFLOW_ACTIVITIES.runDecision).toBe("workflow.runDecision");
        const fake = fakeDecisionHost();
        fake.scenario.answer = () => { throw new Error("a test run must not call a Decision provider"); };
        const h = await harness(getEnv(), { decisionNodes: fake.decisionNodes });
        try {
            const parentId = randomUUID();
            await h.catalog.createSession(parentId, {});
            const context = host => ({ callerSessionId: parentId, host });
            /** A draft of CHOICE_YAML tested with `fixtures`: admitted undispatched, given the model map, then started. */
            const testRun = async (operationId, fixtures) => {
                const workflowSessionId = randomUUID();
                const created = await createWorkflow(h.host, { workflowSessionId, parentSessionId: parentId, yaml: CHOICE_YAML, actor: ACTOR, operationId: "create" });
                expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
                const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
                const started = JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowSessionId, operation: "test", operation_id: operationId,
                    expected_revision: 1, definition_hash: created.receipt.yamlSha256, inputs: {}, ...(fixtures ? { fixtures } : {}) }, context(undispatched)));
                expect(started, JSON.stringify(started)).toMatchObject({ ok: true, run: { mode: "test" } });
                const run = await h.store.readRun(started.run.runId);
                await setModelMap(h, run.runId, MAP);
                await h.client.startOrchestrationVersioned(run.controllerInstanceId, WORKFLOW_CONTROLLER_NAME, { v: 1, workflowSessionId, runId: run.runId },
                    WORKFLOW_CONTROLLER_VERSION);
                return { workflowSessionId, runId: run.runId, nx: nodeExecutionIdFor(run.runId, "root", "route", 1) };
            };

            // A fixture with the raw provider body: the same parser and policy decide; nothing is resolved, budgeted or called.
            const fixed = await testRun("test-fixture", [{ operation: "decision", state: "route", response: { kind: "success", value: raw(BILLING) } }]);
            const fixedEnd = await finished(h, fixed.runId);
            expect(fixedEnd).toMatchObject({ status: "completed", terminalNodeId: "to_billing" });
            expect(fixedEnd.terminalOutput).toEqual(semantic(BILLING));
            expect(await h.store.readNodeExecution(fixed.nx)).toMatchObject({ outcome: "billing", resultKind: "business", winner: "test" });
            expect(await h.store.readInterception(`${fixed.nx}/decision`)).toMatchObject({
                operation: "decision", state: "responded", response: { kind: "success", disposition: "fixture" },
            });

            // No fixture: the decision waits for the parent's answer, and never falls back to a live provider.
            const open = await testRun("test-open", null);
            const waiting = await until(async () => {
                const record = await h.store.readInterception(`${open.nx}/decision`);
                return record?.state === "awaiting_parent" ? record : null;
            }, "the decision to wait for its test answer");
            expect(waiting).toMatchObject({ operation: "decision", response: null });
            await sleep(1_500);
            expect(await h.store.readNodeExecution(open.nx)).toMatchObject({ state: "pending" });
            // The parent's raw answer decides it as a fixture would.
            const answered = JSON.parse(await updateWorkflowFromTool({ workflow_id: open.workflowSessionId, operation: "test_respond",
                operation_id: "respond-1", run_id: open.runId, interception_id: `${open.nx}/decision`,
                response: { kind: "success", value: raw(ENGINEERING) } }, context(h.host)));
            expect(answered, JSON.stringify(answered)).toMatchObject({ ok: true });
            const openEnd = await finished(h, open.runId);
            expect(openEnd).toMatchObject({ status: "completed", terminalNodeId: "to_engineering" });
            expect(openEnd.terminalOutput).toEqual(semantic(ENGINEERING));

            expect(fake.log).toEqual([]);
            expect(fake.requests).toHaveLength(0);
        } finally { await h.stop(); }
    });
});
