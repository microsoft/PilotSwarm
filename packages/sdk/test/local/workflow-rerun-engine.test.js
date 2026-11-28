import { describe, it, expect } from "vitest";
import pg from "pg";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { PostgresProvider, Runtime, Client } from "duroxide";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { registerWorkflow, sessionQueueTransport, workflowAgentSessionId } from "../../src/workflow/runtime.ts";
import { workflowAgentCycleMemoryLostPrompt } from "../../src/workflow/agent-node-service.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { sendTypedWorkflowInput } from "../../src/workflow/service.ts";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "entra", subject: "owner-sub-5", displayName: "Owner 5" };
const OWNER_ACTOR = { kind: "user", provider: OWNER.provider, subject: OWNER.subject, name: "Owner 5" };

/**
 * Out-of-band execution counter over loopback HTTP so sandboxed ESM workflow scripts
 * (which run under Node --permission with --allow-net and no filesystem access) report
 * every live script execution directly to the test harness.
 */
async function withCounterFile(fn) {
    const entries = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            const label = body.trim();
            if (label) entries.push(label);
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const url = `http://127.0.0.1:${addr.port}/hit`;
    const read = () => [...entries];
    const reset = () => { entries.length = 0; };
    try {
        return await fn({ file: url, url, read, reset });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function pgPoolConfig(connectionString) {
    const parsed = new URL(connectionString);
    const sslMode = (parsed.searchParams.get("sslmode") ?? "").toLowerCase();
    const relaxSsl = sslMode === "require" || sslMode === "prefer";
    if (relaxSsl) parsed.searchParams.delete("sslmode");
    return {
        connectionString: parsed.toString(),
        max: 4,
        ...(relaxSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    };
}

function liveHost(client) {
    return {
        catalog: client._catalog,
        store: client._catalog.workflowStore(),
        duroxideClient: client.duroxideClient,
        scripts: true,
    };
}

async function waitRunTerminal(store, runId, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const run = await store.readRun(runId);
        if (run && run.finishedAt) return run;
        await new Promise(r => setTimeout(r, 150));
    }
    const last = await store.readRun(runId);
    throw new Error(`Timed out waiting for run ${runId} (status=${last?.status ?? "missing"})`);
}

const SUPPLY_FLOW_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-supply-flow, version: "1.0.0" }
limits: { maxNodeExecutions: 30 }
schemas:
  ProvisionOut:
    type: object
    additionalProperties: false
    required: [fqdn]
    properties:
      fqdn: { type: string, minLength: 1 }
initial: step1
states:
  step1:
    type: script
    outcomes: [ok]
    source: |
      if (context.inputs.counterFile) await fetch(context.inputs.counterFile, { method: "POST", body: "step1" });
      await setResult("ok", { tag: "from-step1", execId: context.nodeExecutionId });
    transition: { next: { ok: provision, failure: failed } }
  provision:
    type: script
    outcomes: [ok]
    outputSchema: { $ref: "#/schemas/ProvisionOut" }
    carry: { tag: "\${states.step1.output.tag}" }
    source: |
      if (context.inputs.counterFile) await fetch(context.inputs.counterFile, { method: "POST", body: "provision" });
      if (context.kv.failProv) process.exit(1);
      await setResult("ok", { fqdn: "live.db" });
    transition: { next: { ok: verify, execution_failed: failed, failure: failed } }
  verify:
    type: script
    input: { fqdn: "\${states.provision.output.fqdn}", carriedTag: "\${states.step1.output.tag}", step1Exec: "\${states.step1.output.execId}" }
    outcomes: [ok]
    source: |
      if (context.inputs.counterFile) await fetch(context.inputs.counterFile, { method: "POST", body: "verify" });
      await setResult("ok", { verified: context.input.fqdn, tag: context.input.carriedTag, step1Exec: context.input.step1Exec });
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${states.verify.output}" }
  failed: { type: terminal, outcome: failed }
`;

const PARALLEL_RERUN_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-parallel-flow, version: "1.0.0" }
limits: { maxNodeExecutions: 30 }
initial: step1
states:
  step1:
    type: script
    outcomes: [ok]
    source: |
      if (context.inputs.counterFile) await fetch(context.inputs.counterFile, { method: "POST", body: "step1" });
      await setResult("ok", { items: ["a", "b"], step1Exec: context.nodeExecutionId });
    transition: { next: { ok: fan, failure: failed } }
  fan:
    type: parallel
    forEach: "\${states.step1.output.items}"
    concurrency: 2
    body:
      initial: lane
      states:
        lane:
          type: script
          outcomes: [ok]
          source: |
            if (context.inputs.counterFile) await fetch(context.inputs.counterFile, { method: "POST", body: "lane:" + context.branch.item });
            await setResult("ok", { item: context.branch.item });
          transition: { next: { ok: lane_done, failure: lane_done } }
        lane_done: { type: terminal, outcome: succeeded, output: "\${states.lane.output}" }
    transition: { next: { joined: finish, blocked: failed, failure: failed } }
  finish:
    type: script
    input: { step1Exec: "\${states.step1.output.step1Exec}" }
    outcomes: [ok]
    source: |
      if (context.inputs.counterFile) await fetch(context.inputs.counterFile, { method: "POST", body: "finish" });
      if (context.kv.failFinish) process.exit(1);
      await setResult("ok", { finished: true, step1Exec: context.input.step1Exec });
    transition: { next: { ok: done, execution_failed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${states.finish.output}" }
  failed: { type: terminal, outcome: failed }
`;

const CONTINUED_AGENT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-continued-agent, version: "1.0.0" }
limits: { maxNodeExecutions: 30 }
initial: loop_agent
states:
  loop_agent:
    type: agent
    session: continue
    invoke:
      prompt: "Process cycle input."
    outcomes: [more, done]
    timeoutSeconds: 60
    transition: { next: { more: bump, done: ok_end, execution_failed: fail_end, failure: fail_end } }
  bump:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { bumped: true });
    transition: { next: { ok: loop_agent, failure: fail_end } }
  ok_end: { type: terminal, outcome: succeeded }
  fail_end: { type: terminal, outcome: failed }
`;

const NAMED_BRANCH_CONTINUED_AGENT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-named-branch-agent, version: "1.0.0" }
limits: { maxNodeExecutions: 30 }
initial: fan
states:
  fan:
    type: parallel
    concurrency: 1
    branches:
      alpha:
        initial: a_agent
        states:
          a_agent:
            type: agent
            session: continue
            invoke:
              prompt: "Alpha lane cycle."
            outcomes: [done]
            timeoutSeconds: 60
            transition: { next: { done: a_end, failure: a_end } }
          a_end: { type: terminal, outcome: succeeded, output: "\${states.a_agent.output}" }
    transition: { next: { joined: decide, blocked: fail_end, failure: fail_end } }
  decide:
    type: wait
    seconds: 1
    maxVisits: 2
    transition: { next: { elapsed: fan, exhausted: ok_end, failure: fail_end } }
  ok_end: { type: terminal, outcome: succeeded }
  fail_end: { type: terminal, outcome: failed }
`;

const RECEIVE_AFTER_CUT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-receive-inbox, version: "1.0.0" }
limits: { maxNodeExecutions: 20 }
schemas:
  Notice:
    type: object
    properties:
      msg: { type: string }
contracts:
  Notice@1: { schema: { $ref: "#/schemas/Notice" } }
initial: step1
states:
  step1:
    type: script
    outcomes: [ok]
    source: 'await setResult("ok", { ok: true });'
    transition: { next: { ok: wait_msg, failure: failed } }
  wait_msg:
    type: messaging
    mode: receive
    contract: "Notice@1"
    wait: { seconds: 15 }
    transition: { next: { received: done, elapsed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

function* fakeChildSession(ctx) {
    while (true) {
        const msg = yield ctx.dequeueEvent("messages");
        const parsed = typeof msg === "string" ? JSON.parse(msg) : msg;
        if (parsed?.type === "cmd" && (parsed.cmd === "done" || parsed.cmd === "cancel")) return "ended";
    }
}

describe("Task 5: End-to-end I7 pass-over engine (unchanged 1.3.0 controller)", () => {
    it("runs supply mode end-to-end with real execution counters, exact rerunOf shape (I-1), and supply at visit 1 (reused=0)", { timeout: testTime.ms(180_000) }, async () => {
        await withCounterFile(async (counter) => {
            await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
                const h = liveHost(client);
                const ownerSessionId = randomUUID();
                await h.catalog.createSession(ownerSessionId, { owner: OWNER });
                const saved = await saveSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    name: "rerun-supply-flow",
                    yaml: SUPPLY_FLOW_YAML,
                    expected: null,
                    actor: OWNER_ACTOR,
                    operationId: `save-sup-${randomUUID()}`,
                });
                const defId = saved.receipt.definitionId;

                // Run #2: step1 runs, provision fails with exit(1) -> enters terminal failed
                const run2Start = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: defId },
                    inputs: { counterFile: counter.file },
                    vars: { failProv: true },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-sup-r2-${randomUUID()}`,
                });
                const run2 = await waitRunTerminal(h.store, run2Start.runId);
                expect(run2.status).toBe("failed");
                expect(run2.terminalOutcome).toBe("failed");
                expect(counter.read()).toEqual(["step1", "provision"]);
                counter.reset();

                const r2Keys = await h.store.listRerunKeys(run2.runId);
                const step1Visit = r2Keys.find(k => k.nodeId === "step1");
                const provVisit = r2Keys.find(k => k.nodeId === "provision");
                expect(step1Visit).toBeTruthy();
                expect(provVisit).toBeTruthy();

                // Re-run #3 in supply mode: supplies provision result -> passes over step1 & provision without re-running either!
                const run3Start = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: defId },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-sup-r3-${randomUUID()}`,
                    rerunFrom: {
                        workflowId: run2Start.workflowId,
                        executionId: provVisit.nodeExecutionId,
                        mode: "supply",
                        result: { outcome: "ok", output: { fqdn: "supplied-prod.db" } },
                        note: "Provisioned manually via az cli",
                    },
                });
                const run3 = await waitRunTerminal(h.store, run3Start.runId);
                expect(run3.status).toBe("completed");
                expect(run3.terminalOutcome).toBe("succeeded");
                // Real counter proves step1 and provision did NOT execute again — only verify ran! (M-7)
                expect(counter.read()).toEqual(["verify"]);
                expect(run3.terminalOutput).toEqual({
                    verified: "supplied-prod.db",
                    tag: "from-step1",
                    step1Exec: step1Visit.nodeExecutionId,
                });

                // Exact Design §5.1(1) workflow.started.rerunOf shape (I-1)
                const events3 = await h.catalog.getSessionEvents(run3Start.workflowId);
                const startedEvt = events3.find(e => e.eventType === "workflow.started");
                expect(startedEvt?.data?.rerunOf).toEqual({
                    workflowId: run2Start.workflowId,
                    runId: run2.runId,
                    executionId: provVisit.nodeExecutionId,
                    stateId: "provision",
                    visit: 1,
                    mode: "supply",
                    reused: 1,
                    suppliedOutcome: "ok",
                });

                counter.reset();
                // Supply at visit 1 (reused = 0): supply step1 itself -> step1 is NOT re-run; provision + verify run fresh!
                const run4Start = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: defId },
                    vars: { failProv: false },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-sup-v1-${randomUUID()}`,
                    rerunFrom: {
                        workflowId: run2Start.workflowId,
                        executionId: step1Visit.nodeExecutionId,
                        mode: "supply",
                        result: { outcome: "ok", output: { tag: "supplied-at-v1", execId: "supplied-v1" } },
                        note: "Supplied visit 1 directly",
                    },
                });
                const run4 = await waitRunTerminal(h.store, run4Start.runId);
                expect(run4.status).toBe("completed");
                expect(run4.terminalOutcome).toBe("succeeded");
                expect(counter.read()).toEqual(["provision", "verify"]);
                expect(run4.terminalOutput).toEqual({
                    verified: "live.db",
                    tag: "supplied-at-v1",
                    step1Exec: "supplied-v1",
                });
                const events4 = await h.catalog.getSessionEvents(run4Start.workflowId);
                const startedEvt4 = events4.find(e => e.eventType === "workflow.started");
                expect(startedEvt4?.data?.rerunOf).toEqual({
                    workflowId: run2Start.workflowId,
                    runId: run2.runId,
                    executionId: step1Visit.nodeExecutionId,
                    stateId: "step1",
                    visit: 1,
                    mode: "supply",
                    reused: 0,
                    suppliedOutcome: "ok",
                });
            });
        });
    });

    it("runs run_again over parallel (after & whole-parallel #8), proves 0 re-executions (M-7), checks rerunOf without suppliedOutcome (I-1), and catches both divergence paths (#17)", { timeout: testTime.ms(180_000) }, async () => {
        await withCounterFile(async (counter) => {
            await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
                const h = liveHost(client);
                const ownerSessionId = randomUUID();
                await h.catalog.createSession(ownerSessionId, { owner: OWNER });
                const saved = await saveSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    name: "rerun-parallel-flow",
                    yaml: PARALLEL_RERUN_YAML,
                    expected: null,
                    actor: OWNER_ACTOR,
                    operationId: `save-par-${randomUUID()}`,
                });
                const defId = saved.receipt.definitionId;

                const r2Start = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: defId },
                    inputs: { counterFile: counter.file },
                    vars: { failFinish: true },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-par-r2-${randomUUID()}`,
                });
                const r2 = await waitRunTerminal(h.store, r2Start.runId);
                expect(r2.status).toBe("failed");
                expect(r2.terminalOutcome).toBe("failed");
                expect(counter.read().sort()).toEqual(["finish", "lane:a", "lane:b", "step1"]);
                counter.reset();

                const r2Keys = await h.store.listRerunKeys(r2.runId);
                const step1Visit = r2Keys.find(k => k.nodeId === "step1");
                const fanVisit = r2Keys.find(k => k.nodeId === "fan");
                const finishVisit = r2Keys.find(k => k.nodeId === "finish");
                expect(fanVisit).toBeTruthy();
                expect(finishVisit).toBeTruthy();

                // Re-run #3 from finish with failFinish=false: step1 + parallel lanes passed over (0 re-executions)!
                const r3Start = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: defId },
                    vars: { failFinish: false },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-par-r3-${randomUUID()}`,
                    rerunFrom: { workflowId: r2Start.workflowId, executionId: finishVisit.nodeExecutionId, mode: "run_again" },
                });
                const r3 = await waitRunTerminal(h.store, r3Start.runId);
                expect(r3.status).toBe("completed");
                expect(r3.terminalOutcome).toBe("succeeded");
                expect(counter.read()).toEqual(["finish"]);
                expect(r3.rerunUnwalked).toBe(4); // 2 lanes x (lane + lane_done)
                expect(r3.terminalOutput).toEqual({ finished: true, step1Exec: step1Visit.nodeExecutionId });

                // I-1: run_again rerunOf carries exact fields and OMITS suppliedOutcome
                const events3 = await h.catalog.getSessionEvents(r3Start.workflowId);
                const startedEvt3 = events3.find(e => e.eventType === "workflow.started");
                expect(startedEvt3?.data?.rerunOf).toEqual({
                    workflowId: r2Start.workflowId,
                    runId: r2.runId,
                    executionId: finishVisit.nodeExecutionId,
                    stateId: "finish",
                    visit: 1,
                    mode: "run_again",
                    reused: 6,
                });
                expect(Object.hasOwn(startedEvt3.data.rerunOf, "suppliedOutcome")).toBe(false);

                // #8: Whole parallel step chosen (run_again from fan) -> step1 NOT re-run; all lanes + finish run fresh!
                counter.reset();
                const rWholeParStart = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: defId },
                    vars: { failFinish: false },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-par-whole-${randomUUID()}`,
                    rerunFrom: { workflowId: r2Start.workflowId, executionId: fanVisit.nodeExecutionId, mode: "run_again" },
                });
                const rWholePar = await waitRunTerminal(h.store, rWholeParStart.runId);
                expect(rWholePar.status).toBe("completed");
                expect(rWholePar.terminalOutcome).toBe("succeeded");
                expect(counter.read().sort()).toEqual(["finish", "lane:a", "lane:b"]);
                expect(rWholePar.terminalOutput).toEqual({ finished: true, step1Exec: step1Visit.nodeExecutionId });

                // #17 Path A: enterNodeActivity pre-cut coordinate mismatch (rev 2 changes initial to finish) -> fails rerun_diverged with 0 executions!
                counter.reset();
                const divYamlA = PARALLEL_RERUN_YAML
                    .replace('version: "1.0.0"', 'version: "1.0.1"')
                    .replace("initial: step1", "initial: finish");
                await saveSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    name: "rerun-parallel-flow",
                    yaml: divYamlA,
                    expected: { definitionId: defId, revision: 1 },
                    actor: OWNER_ACTOR,
                    operationId: `save-par-v2-${randomUUID()}`,
                });
                const rDivAStart = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: defId },
                    revision: 2,
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-par-divA-${randomUUID()}`,
                    rerunFrom: { workflowId: r2Start.workflowId, executionId: finishVisit.nodeExecutionId, mode: "run_again", _skipFitCheckForTest: true },
                });
                const rDivA = await waitRunTerminal(h.store, rDivAStart.runId);
                expect(rDivA.status).toBe("failed");
                expect(rDivA.terminalError?.code).toBe("rerun_diverged");
                expect(counter.read()).toEqual([]);

                // #17 Path B: first-new-visit divergence (rev 3 keeps pre-cut step1 + fan identical, but routes fan.joined -> alt_finish instead of finish) -> 0 executions!
                counter.reset();
                const divYamlB = PARALLEL_RERUN_YAML
                    .replace('version: "1.0.0"', 'version: "1.0.2"')
                    .replace("transition: { next: { joined: finish, blocked: failed, failure: failed } }",
                        "transition: { next: { joined: alt_finish, blocked: failed, failure: failed } }")
                    .replace("  done: { type: terminal",
                        `  alt_finish:\n    type: script\n    outcomes: [ok]\n    source: |\n      if (context.inputs.counterFile) await fetch(context.inputs.counterFile, { method: "POST", body: "alt_finish" });\n      await setResult("ok", { alt: true });\n    transition: { next: { ok: done, failure: failed } }\n  done: { type: terminal`);
                await saveSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    name: "rerun-parallel-flow",
                    yaml: divYamlB,
                    expected: { definitionId: defId, revision: 2 },
                    actor: OWNER_ACTOR,
                    operationId: `save-par-v3-${randomUUID()}`,
                });
                const rDivBStart = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: defId },
                    revision: 3,
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-par-divB-${randomUUID()}`,
                    rerunFrom: { workflowId: r2Start.workflowId, executionId: finishVisit.nodeExecutionId, mode: "run_again", _skipFitCheckForTest: true },
                });
                const rDivB = await waitRunTerminal(h.store, rDivBStart.runId);
                expect(rDivB.status).toBe("failed");
                expect(rDivB.terminalError?.code).toBe("rerun_diverged");
                expect(counter.read()).toEqual([]);
            });
        });
    });

    it("delivers K+1 rerunRecap (including suppliedNote), continues K+2 in same agent session with S7 lost-memory cycle continuity, and no-ops endAgent on reused visits", { timeout: testTime.ms(180_000) }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const store = catalog.workflowStore();
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const runtime = new Runtime(provider, {
            dispatcherPollIntervalMs: 10, logLevel: "error", workerConcurrency: 8, workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
        });
        const promptsSeen = [];
        runtime.registerOrchestrationVersioned("fake-agent-child", "1.0.0", fakeChildSession);
        registerWorkflow({
            registerActivity: (name, fn) => runtime.registerActivity(name, fn),
            registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
        }, {
            store,
            catalog,
            enabled: () => true,
            resolveToolBinding: async () => null,
            openToolExecutor: async () => { throw new Error("No tools"); },
            authorizeParentNotification: async () => false,
            notifyParent: async () => {},
            deleteSession: async id => catalog.softDeleteSession(id),
            wakeBackstopMs: 500,
            sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
            agentNodes: {
                async spawn(req) {
                    promptsSeen.push(req);
                    const instanceId = `session-${req.childSessionId}`;
                    if ((await client.getStatus(instanceId)).status === "NotFound") {
                        await catalog.createSession(req.childSessionId, {}).catch(() => {});
                        await client.startOrchestrationVersioned(instanceId, "fake-agent-child", {}, "1.0.0");
                    }
                    await client.enqueueEvent(instanceId, "messages", JSON.stringify({ prompt: req.prompt }));
                    return { spawned: true, used: { model: "mock:test" } };
                },
            },
        });
        await runtime.start();
        try {
            const h = { catalog, store, duroxideClient: client, scripts: true };
            const ownerSessionId = randomUUID();
            await catalog.createSession(ownerSessionId, { owner: OWNER });
            const saved = await saveSessionWorkflowDefinition(h, {
                ownerSessionId,
                name: "rerun-continued-agent",
                yaml: CONTINUED_AGENT_YAML,
                expected: null,
                actor: OWNER_ACTOR,
                operationId: `save-ag-${randomUUID()}`,
            });
            const defId = saved.receipt.definitionId;

            // Seed ended run #2 with 2 completed visits of loop_agent (ordinal 1 -> more, bump#1 -> ok, ordinal 2 -> execution_failed)
            // PLUS a live source child session for loop_agent#1 to prove endAgent is a no-op on reused visits (M-4).
            const pool = new pg.Pool(pgPoolConfig(env.store));
            const s = `"${env.cmsSchema.replace(/"/g, '""')}"`;
            let srcWfId;
            let srcRunId;
            let visit2Id;
            const srcChildSessionId = randomUUID();
            await catalog.createSession(srcChildSessionId, {}).catch(() => {});
            await client.startOrchestrationVersioned(`session-${srcChildSessionId}`, "fake-agent-child", {}, "1.0.0");
            try {
                const deferH = {
                    ...h,
                    duroxideClient: Object.assign(Object.create(client), { startOrchestrationVersioned: async () => {} }),
                };
                const started = await startSessionWorkflowDefinition(deferH, {
                    ownerSessionId,
                    definition: { definitionId: defId },
                    inputs: {},
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `seed-ag-r2-${randomUUID()}`,
                });
                srcWfId = started.workflowId;
                srcRunId = started.runId;
                const v1 = nodeExecutionIdFor(srcRunId, "root", "loop_agent", 1);
                const b1 = nodeExecutionIdFor(srcRunId, "root", "bump", 1);
                visit2Id = nodeExecutionIdFor(srcRunId, "root", "loop_agent", 2);
                const base = Date.now() - 20_000;
                const rows = [
                    [v1, null, "loop_agent", 1, "agent", null, "{}", "more", "business", '{"note":"cycle1"}', null, "agent", 1],
                    [b1, v1, "bump", 1, "script", "more", '{"note":"cycle1"}', "ok", "business", '{"bumped":true}', null, "effect", 1],
                    [visit2Id, b1, "loop_agent", 2, "agent", "ok", '{"bumped":true}', "execution_failed", "runtime_error", null, '{"code":"execution_failed","message":"boom"}', "agent", 1],
                ];
                for (let i = 0; i < rows.length; i += 1) {
                    const [id, pred, nid, ord, ntype, route, inp, out, rk, outText, errText, win, kvRev] = rows[i];
                    await pool.query(
                        `INSERT INTO ${s}.workflow_node_executions (
                            node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
                            input, input_sha256, state, outcome, result_kind, output, error, winner,
                            effect_attempts, entered_at, completed_at, kv_revision, deadline_at
                         ) VALUES ($1,$2,'root',$3,$4,$5,$6,$7,$8,$9,'completed',$10,$11,$12,$13,$14,1,$15::timestamptz,$16::timestamptz,$17,NULL)`,
                        [id, srcRunId, pred, nid, ord, ntype, route, inp, sha256Hex(inp), out, rk, outText, errText, win,
                            new Date(base + i * 1000).toISOString(), new Date(base + i * 1000 + 300).toISOString(), kvRev],
                    );
                }
                await pool.query(
                    `INSERT INTO ${s}.workflow_agent_invocations (
                        node_execution_id, run_id, workflow_session_id, child_session_id, task, outcomes,
                        deadline_at, created_at, spawn_attempts, spawned_at
                     ) VALUES ($1, $2, $3, $4, 'Process cycle input.', '["more","done"]', $5::timestamptz, $6::timestamptz, 1, $6::timestamptz)`,
                    [v1, srcRunId, srcWfId, srcChildSessionId, new Date(base + 60_000).toISOString(), new Date(base + 50).toISOString()],
                );
                await pool.query(`UPDATE ${s}.workflow_runs SET status = 'failed', finished_at = now() WHERE run_id = $1`, [srcRunId]);
            } finally {
                await pool.end();
            }

            // Re-run #3 supplying loop_agent#2 with outcome="more" and a suppliedNote -> bump#2 runs -> loop_agent#3 (K+1 = cycle 3!) spawns with rerunRecap!
            const r3Start = await startSessionWorkflowDefinition(h, {
                ownerSessionId,
                definition: { definitionId: defId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: `start-ag-r3-${randomUUID()}`,
                rerunFrom: {
                    workflowId: srcWfId,
                    executionId: visit2Id,
                    mode: "supply",
                    result: { outcome: "more", output: { rescued: true } },
                    note: "Manual rescue of cycle 2",
                },
            });

            // Wait for loop_agent#3 (cycle 3, K+1) to spawn!
            const deadline1 = Date.now() + 30_000;
            while (promptsSeen.length < 1 && Date.now() < deadline1) await new Promise(r => setTimeout(r, 100));
            expect(promptsSeen.length).toBeGreaterThanOrEqual(1);
            const p3 = promptsSeen[0];
            expect(p3.prompt).toContain("cycle 3");
            // I-3: supplied cycle must NOT be described as having "ran in a previous Workflow run"
            expect(p3.prompt).not.toContain("ran in a previous Workflow run");
            expect(p3.prompt).toContain("Cycle 1 was reused from an earlier Workflow run; cycle 2's result was supplied by a person without running.");
            expect(p3.prompt).toContain("Manual rescue of cycle 2");
            const p3Json = JSON.parse(p3.prompt.split("\n")[1]);
            expect(p3Json.previousResult).toEqual({
                outcome: "more",
                resultKind: "business",
                output: { rescued: true },
                error: null,
            });
            expect(p3Json.rerunRecap).toEqual({
                omitted: 0,
                visits: [
                    { visit: 1, source: "reused", outcome: "more", resultKind: "business", output: { note: "cycle1" } },
                    { visit: 2, source: "supplied", outcome: "more", resultKind: "business", output: { rescued: true }, suppliedNote: "Manual rescue of cycle 2" },
                ],
            });

            // Complete cycle 3 with outcome="more", then record memory loss on cycle 3 -> S7 must record cycle = 3 (NOT 1)!
            await store.completeNode(p3.nodeExecutionId, { outcome: "more", resultKind: "business", valueText: '{"c":3}', winner: "agent" }, {
                sessionId: r3Start.workflowId, events: [],
            });
            const lossRec = await store.recordAgentCycleMemoryLost({
                nodeExecutionId: p3.nodeExecutionId,
                childSessionId: p3.childSessionId,
                reason: "not_committed",
            });
            expect(lossRec.recorded).toBe(true);

            // Wait for loop_agent#4 (cycle 4, K+2) to spawn in the SAME child session!
            const deadline2 = Date.now() + 30_000;
            while (promptsSeen.length < 2 && Date.now() < deadline2) await new Promise(r => setTimeout(r, 100));
            expect(promptsSeen.length).toBeGreaterThanOrEqual(2);
            const p4 = promptsSeen[1];
            expect(p4.childSessionId).toBe(p3.childSessionId);
            expect(p4.prompt).toContain("CYCLE 4");
            // I-2: normal K+2 prompt appends Design §5.4 pre-cut sentence
            expect(p4.prompt).toContain("Cycles 1 to 2 were reused or supplied before this re-run started; their summary is in cycle 3's prompt above.");

            // I-2: S7 readAgentCyclesLostBefore includes firstSessionCycle & re-carried rerunRecap when K+1 is lost
            const lostInfo = await store.readAgentCyclesLostBefore(p4.childSessionId, p4.nodeExecutionId);
            expect(lostInfo).toEqual({
                cycle: 4,
                lost: [3],
                firstSessionCycle: 3,
                rerunRecap: p3Json.rerunRecap,
            });
            const rewrittenP4 = workflowAgentCycleMemoryLostPrompt(p4.prompt, lostInfo.cycle, lostInfo.lost, {
                firstSessionCycle: lostInfo.firstSessionCycle,
                rerunRecap: lostInfo.rerunRecap,
            });
            expect(rewrittenP4).not.toContain("other earlier cycles");
            expect(rewrittenP4).not.toContain("in cycle 3's prompt above");
            expect(JSON.parse(rewrittenP4.split("\n")[1]).rerunRecap).toEqual(p3Json.rerunRecap);

            // I-2 + M-5: End S_new before completing cycle 4 with "more" so cycle 5 hits the RESTART path!
            await client.enqueueEvent(`session-${p3.childSessionId}`, "messages", JSON.stringify({ type: "cmd", cmd: "done" }));
            const endDeadline = Date.now() + 15_000;
            while ((await client.getStatus(`session-${p3.childSessionId}`)).status === "Running" && Date.now() < endDeadline) {
                await new Promise(r => setTimeout(r, 50));
            }
            expect((await client.getStatus(`session-${p3.childSessionId}`)).status).toBe("Completed");

            await store.completeNode(p4.nodeExecutionId, { outcome: "more", resultKind: "business", valueText: '{"c":4}', winner: "agent" }, {
                sessionId: r3Start.workflowId, events: [],
            });
            const deadline3 = Date.now() + 30_000;
            while (promptsSeen.length < 3 && Date.now() < deadline3) await new Promise(r => setTimeout(r, 100));
            expect(promptsSeen.length).toBeGreaterThanOrEqual(3);
            const p5 = promptsSeen[2];
            expect(p5.childSessionId).not.toBe(p3.childSessionId);
            // M-5: replacement session id uses preCutCount (2) + visits (2) + 1 = 5
            expect(p5.childSessionId).toBe(workflowAgentSessionId(r3Start.runId, "loop_agent", 5));
            expect(p5.prompt).toContain("cycle 5");
            expect(p5.prompt).toContain("Cycle 1 was reused from an earlier Workflow run; cycle 2's result was supplied by a person without running.");
            const p5Json = JSON.parse(p5.prompt.split("\n")[1]);
            expect(p5Json.rerunRecap).toEqual(p3Json.rerunRecap);
            expect(p5Json.previousResult).toEqual({
                outcome: "more",
                resultKind: "business",
                output: { c: 4 },
                error: null,
            });

            // Complete cycle 5 with outcome="done" -> run completes cleanly
            await store.completeNode(p5.nodeExecutionId, { outcome: "done", resultKind: "business", valueText: '{"c":5}', winner: "agent" }, {
                sessionId: r3Start.workflowId, events: [],
            });
            const r3 = await waitRunTerminal(store, r3Start.runId);
            expect(r3.status).toBe("completed");
            expect(r3.terminalOutcome).toBe("succeeded");

            // M-4: source run #2's child session is STILL Running — #3's endAgent was a true no-op on reused visits!
            expect((await client.getStatus(`session-${srcChildSessionId}`)).status).toBe("Running");
            await client.enqueueEvent(`session-${srcChildSessionId}`, "messages", JSON.stringify({ type: "cmd", cmd: "done" }));

            // I8 named-branch session: continue e2e recap ordering across multiple parallel visits (COALESCE(p.ordinal,0), n.ordinal)
            const nbSaved = await saveSessionWorkflowDefinition(h, {
                ownerSessionId,
                name: "rerun-named-branch-agent",
                yaml: NAMED_BRANCH_CONTINUED_AGENT_YAML,
                expected: null,
                actor: OWNER_ACTOR,
                operationId: `save-nb-${randomUUID()}`,
            });
            expect(nbSaved.receipt.valid).toBe(true);
            const nbPool = new pg.Pool(pgPoolConfig(env.store));
            let nbSrcWfId;
            let nbFan3Id;
            try {
                const deferH = {
                    ...h,
                    duroxideClient: Object.assign(Object.create(client), { startOrchestrationVersioned: async () => {} }),
                };
                const startedNb = await startSessionWorkflowDefinition(deferH, {
                    ownerSessionId,
                    definition: { definitionId: nbSaved.receipt.definitionId },
                    inputs: {},
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `seed-nb-r2-${randomUUID()}`,
                });
                nbSrcWfId = startedNb.workflowId;
                const nbRunId = startedNb.runId;
                const fan1 = nodeExecutionIdFor(nbRunId, "root", "fan", 1);
                const br1Scope = `${fan1}#0`;
                const a1 = nodeExecutionIdFor(nbRunId, br1Scope, "a_agent", 1);
                const ae1 = nodeExecutionIdFor(nbRunId, br1Scope, "a_end", 1);
                const dec1 = nodeExecutionIdFor(nbRunId, "root", "decide", 1);
                const fan2 = nodeExecutionIdFor(nbRunId, "root", "fan", 2);
                const br2Scope = `${fan2}#0`;
                const a2 = nodeExecutionIdFor(nbRunId, br2Scope, "a_agent", 1);
                const ae2 = nodeExecutionIdFor(nbRunId, br2Scope, "a_end", 1);
                const dec2 = nodeExecutionIdFor(nbRunId, "root", "decide", 2);
                nbFan3Id = nodeExecutionIdFor(nbRunId, "root", "fan", 3);
                const base2 = Date.now() - 30_000;
                const nbNodes = [
                    [fan1, "root", null, "fan", 1, "parallel", null, "[{}]", "joined", "business", '{"alpha":{"round":1}}', null, "controller"],
                    [a1, br1Scope, null, "a_agent", 1, "agent", null, "{}", "done", "business", '{"round":1}', null, "agent"],
                    [ae1, br1Scope, a1, "a_end", 1, "terminal", "done", '{"round":1}', "succeeded", "business", '{"round":1}', null, "controller"],
                    [dec1, "root", fan1, "decide", 1, "wait", "joined", '{"alpha":{"round":1}}', "elapsed", "business", '{}', null, "timer"],
                    [fan2, "root", dec1, "fan", 2, "parallel", "elapsed", "[{}]", "joined", "business", '{"alpha":{"round":2}}', null, "controller"],
                    [a2, br2Scope, null, "a_agent", 1, "agent", null, "{}", "done", "business", '{"round":2}', null, "agent"],
                    [ae2, br2Scope, a2, "a_end", 1, "terminal", "done", '{"round":2}', "succeeded", "business", '{"round":2}', null, "controller"],
                    [dec2, "root", fan2, "decide", 2, "wait", "joined", '{"alpha":{"round":2}}', "elapsed", "business", '{}', null, "timer"],
                    [nbFan3Id, "root", dec2, "fan", 3, "parallel", "elapsed", "[{}]", "blocked", "business", '{"blocked":true}', null, "controller"],
                ];
                for (let i = 0; i < nbNodes.length; i += 1) {
                    const [id, scopeId, pred, nid, ord, ntype, route, inp, out, rk, outText, errText, win] = nbNodes[i];
                    await nbPool.query(
                        `INSERT INTO ${s}.workflow_node_executions (
                            node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
                            input, input_sha256, state, outcome, result_kind, output, error, winner,
                            effect_attempts, entered_at, completed_at, kv_revision, deadline_at
                         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'completed',$11,$12,$13,$14,$15,1,$16::timestamptz,$17::timestamptz,1,NULL)`,
                        [id, nbRunId, scopeId, pred, nid, ord, ntype, route, inp, sha256Hex(inp), out, rk, outText, errText, win,
                            new Date(base2 + i * 1000).toISOString(), new Date(base2 + i * 1000 + 300).toISOString()],
                    );
                }
                await nbPool.query(`UPDATE ${s}.workflow_runs SET status = 'failed', finished_at = now() WHERE run_id = $1`, [nbRunId]);
            } finally {
                await nbPool.end();
            }

            const promptsBeforeNb = promptsSeen.length;
            const nbR3Start = await startSessionWorkflowDefinition(h, {
                ownerSessionId,
                definition: { definitionId: nbSaved.receipt.definitionId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: `start-nb-r3-${randomUUID()}`,
                rerunFrom: { workflowId: nbSrcWfId, executionId: nbFan3Id, mode: "run_again" },
            });
            const nbDeadline = Date.now() + 30_000;
            while (promptsSeen.length <= promptsBeforeNb && Date.now() < nbDeadline) await new Promise(r => setTimeout(r, 100));
            expect(promptsSeen.length).toBeGreaterThan(promptsBeforeNb);
            const pAlpha = promptsSeen[promptsBeforeNb];
            expect(pAlpha.prompt).toContain("cycle 3");
            const pAlphaJson = JSON.parse(pAlpha.prompt.split("\n")[1]);
            expect(pAlphaJson.rerunRecap.visits.map(v => v.output)).toEqual([{ round: 1 }, { round: 2 }]);
            await store.completeNode(pAlpha.nodeExecutionId, { outcome: "done", resultKind: "business", valueText: '{"round":3}', winner: "agent" }, {
                sessionId: nbR3Start.workflowId, events: [],
            });
            const nbR3 = await waitRunTerminal(store, nbR3Start.runId);
            expect(nbR3.status).toBe("completed");
            expect(nbR3.terminalOutcome).toBe("succeeded");
        } finally {
            await runtime.shutdown();
            await catalog.close();
        }
    });

    it("delivers carried waiting inbox messages to a downstream receive state in the re-run", { timeout: testTime.ms(180_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = liveHost(client);
            const ownerSessionId = randomUUID();
            await h.catalog.createSession(ownerSessionId, { owner: OWNER });
            const saved = await saveSessionWorkflowDefinition(h, {
                ownerSessionId,
                name: "rerun-receive-inbox",
                yaml: RECEIVE_AFTER_CUT_YAML,
                expected: null,
                actor: OWNER_ACTOR,
                operationId: `save-rcv-${randomUUID()}`,
            });
            const defId = saved.receipt.definitionId;

            // Seed ended run #2 where step1 succeeded, wait_msg timed out, AND a Notice@1 message arrived in inbox (waiting)
            const pool = new pg.Pool(pgPoolConfig(getEnv().store));
            const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;
            let srcWfId;
            let srcRunId;
            let waitId;
            try {
                const deferH = {
                    ...h,
                    duroxideClient: Object.assign(Object.create(client.duroxideClient), { startOrchestrationVersioned: async () => {} }),
                };
                const started = await startSessionWorkflowDefinition(deferH, {
                    ownerSessionId,
                    definition: { definitionId: defId },
                    inputs: {},
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `seed-rcv-r2-${randomUUID()}`,
                });
                srcWfId = started.workflowId;
                srcRunId = started.runId;
                const s1 = nodeExecutionIdFor(srcRunId, "root", "step1", 1);
                waitId = nodeExecutionIdFor(srcRunId, "root", "wait_msg", 1);
                const t1 = new Date(Date.now() - 20_000).toISOString();
                const t2 = new Date(Date.now() - 10_000).toISOString();
                await pool.query(
                    `INSERT INTO ${s}.workflow_node_executions (
                        node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
                        input, input_sha256, state, outcome, result_kind, output, error, winner,
                        effect_attempts, entered_at, completed_at, kv_revision, deadline_at
                     ) VALUES
                     ($1,$2,'root',NULL,'step1',1,'script',NULL,'{}',$3,'completed','ok','business','{"ok":true}',NULL,'effect',1,$4::timestamptz,$4::timestamptz,1,NULL),
                     ($5,$2,'root',$1,'wait_msg',1,'messaging','ok','{"ok":true}',$6,'completed','timed_out','runtime_error',NULL,'{"code":"timed_out","message":"timeout"}','controller',1,$7::timestamptz,$7::timestamptz,1,NULL)`,
                    [s1, srcRunId, sha256Hex("{}"), t1, waitId, sha256Hex('{"ok":true}'), t2],
                );
                await pool.query(
                    `INSERT INTO ${s}.workflow_inbox (
                        message_id, workflow_session_id, run_id, sender_session_id, operation_id, request_sha256,
                        contract, correlation, payload, accepted_at, expires_at
                     ) VALUES ($1,$2,$3,$4,'op-notice-1',$5,'Notice@1','{}','{"msg":"carried-hello"}',$6::timestamptz,now() + interval '1 hour')`,
                    [randomUUID(), srcWfId, srcRunId, ownerSessionId, sha256Hex("op-notice-1"), new Date(Date.now() - 25_000).toISOString()],
                );
                await pool.query(`UPDATE ${s}.workflow_runs SET status = 'failed', finished_at = now() WHERE run_id = $1`, [srcRunId]);
            } finally {
                await pool.end();
            }

            // Re-run #3 from wait_msg (run_again): wait_msg consumes the carried Notice@1 message and finishes succeeded!
            const r3Start = await startSessionWorkflowDefinition(h, {
                ownerSessionId,
                definition: { definitionId: defId },
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: `start-rcv-r3-${randomUUID()}`,
                rerunFrom: { workflowId: srcWfId, executionId: waitId, mode: "run_again" },
            });
            const r3 = await waitRunTerminal(h.store, r3Start.runId);
            expect(r3.status).toBe("completed");
            expect(r3.terminalOutcome).toBe("succeeded");
        });
    });

    it("covers Spec §11.2 #7 (continue mode), #4 (maxNodeExecutions exact boundary), #3 (maxVisits carry-over), and #5/#6 (catch-all reused & terminal invalid_output pass-over)", { timeout: testTime.ms(240_000) }, async () => {
        await withCounterFile(async (counter) => {
            await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
                const h = liveHost(client);
                const ownerSessionId = randomUUID();
                await h.catalog.createSession(ownerSessionId, { owner: OWNER });

                // --- #7: continue mode end-to-end ---
                const contV1Yaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-continue-mode, version: "1.0.0" }
limits: { maxNodeExecutions: 1 }
initial: step1
states:
  step1:
    type: script
    outcomes: [ok]
    source: |
      if (context.inputs.counterFile) await fetch(context.inputs.counterFile, { method: "POST", body: "step1" });
      await setResult("ok", { fromStep1: 42 });
    transition: { next: { ok: step2, failure: failed } }
  step2:
    type: script
    input: { v: "\${states.step1.output.fromStep1}" }
    outcomes: [ok]
    source: |
      if (context.inputs.counterFile) await fetch(context.inputs.counterFile, { method: "POST", body: "step2" });
      await setResult("ok", { doubled: context.input.v * 2 });
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${states.step2.output}" }
  failed: { type: terminal, outcome: failed }
`;
                const contSaved = await saveSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    name: "rerun-continue-mode",
                    yaml: contV1Yaml,
                    expected: null,
                    actor: OWNER_ACTOR,
                    operationId: `save-cont-v1-${randomUUID()}`,
                });
                const contDefId = contSaved.receipt.definitionId;
                const contR2Start = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: contDefId },
                    inputs: { counterFile: counter.file },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-cont-r2-${randomUUID()}`,
                });
                const contR2 = await waitRunTerminal(h.store, contR2Start.runId);
                expect(contR2.status).toBe("failed");
                expect(contR2.terminalError?.code).toBe("limit_exceeded");
                expect(counter.read()).toEqual(["step1"]);
                const contR2Step1 = (await h.store.listRerunKeys(contR2.runId)).find(k => k.nodeId === "step1");
                expect(contR2Step1).toBeTruthy();

                // Save rev 2 with higher maxNodeExecutions, then re-run in mode: "continue" from step1 -> step1 NOT re-run, step2 runs!
                await saveSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    name: "rerun-continue-mode",
                    yaml: contV1Yaml.replace('version: "1.0.0"', 'version: "1.0.1"').replace("maxNodeExecutions: 1", "maxNodeExecutions: 10"),
                    expected: { definitionId: contDefId, revision: 1 },
                    actor: OWNER_ACTOR,
                    operationId: `save-cont-v2-${randomUUID()}`,
                });
                counter.reset();
                const contR3Start = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: contDefId },
                    revision: 2,
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-cont-r3-${randomUUID()}`,
                    rerunFrom: { workflowId: contR2Start.workflowId, executionId: contR2Step1.nodeExecutionId, mode: "continue" },
                });
                const contR3 = await waitRunTerminal(h.store, contR3Start.runId);
                expect(contR3.status).toBe("completed");
                expect(contR3.terminalOutcome).toBe("succeeded");
                expect(counter.read()).toEqual(["step2"]);
                expect(contR3.terminalOutput).toEqual({ doubled: 84 });
                const contEvents = await h.catalog.getSessionEvents(contR3Start.workflowId);
                const contStarted = contEvents.find(e => e.eventType === "workflow.started");
                expect(contStarted?.data?.rerunOf).toEqual({
                    workflowId: contR2Start.workflowId,
                    runId: contR2.runId,
                    executionId: contR2Step1.nodeExecutionId,
                    stateId: "step1",
                    visit: 1,
                    mode: "continue",
                    reused: 1,
                });
                expect(Object.hasOwn(contStarted.data.rerunOf, "suppliedOutcome")).toBe(false);

                // --- #4: maxNodeExecutions exact boundary (reused + new <= limit; fails at exact +1) ---
                // 3 lanes -> step1 (1) + fan (1) + 3*(lane + lane_done) (6, unwalked) = 8 reused; finish (1) + done (1) = 2 new; total = 10.
                const capYaml = (maxNodes, ver) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-max-exec-cap, version: "${ver}" }
limits: { maxNodeExecutions: ${maxNodes} }
initial: step1
states:
  step1:
    type: script
    outcomes: [ok]
    source: 'await setResult("ok", { items: ["a", "b", "c"] });'
    transition: { next: { ok: fan, failure: failed } }
  fan:
    type: parallel
    forEach: "\${states.step1.output.items}"
    concurrency: 3
    body:
      initial: lane
      states:
        lane:
          type: script
          outcomes: [ok]
          source: 'await setResult("ok", { x: context.branch.item });'
          transition: { next: { ok: lane_done, failure: lane_done } }
        lane_done: { type: terminal, outcome: succeeded, output: "\${states.lane.output}" }
    transition: { next: { joined: finish, blocked: failed, failure: failed } }
  finish:
    type: script
    outcomes: [ok]
    source: |
      if (context.kv.failFinish) process.exit(1);
      await setResult("ok", { ok: true });
    transition: { next: { ok: done, execution_failed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;
                const capSaved = await saveSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    name: "rerun-max-exec-cap",
                    yaml: capYaml(20, "1.0.0"),
                    expected: null,
                    actor: OWNER_ACTOR,
                    operationId: `save-cap-v1-${randomUUID()}`,
                });
                const capDefId = capSaved.receipt.definitionId;
                const capR2Start = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: capDefId },
                    inputs: {},
                    vars: { failFinish: true },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-cap-r2-${randomUUID()}`,
                });
                const capR2 = await waitRunTerminal(h.store, capR2Start.runId);
                expect(capR2.status).toBe("failed");
                const capFinishVisit = (await h.store.listRerunKeys(capR2.runId)).find(k => k.nodeId === "finish");
                expect(capFinishVisit).toBeTruthy();

                // Rev 2: maxNodeExecutions = 10 (exact fit: 8 reused + 2 new = 10) -> succeeds!
                await saveSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    name: "rerun-max-exec-cap",
                    yaml: capYaml(10, "1.0.1"),
                    expected: { definitionId: capDefId, revision: 1 },
                    actor: OWNER_ACTOR,
                    operationId: `save-cap-v2-${randomUUID()}`,
                });
                const capExactStart = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: capDefId },
                    revision: 2,
                    inputs: {},
                    vars: { failFinish: false },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-cap-exact-${randomUUID()}`,
                    rerunFrom: { workflowId: capR2Start.workflowId, executionId: capFinishVisit.nodeExecutionId, mode: "run_again" },
                });
                const capExact = await waitRunTerminal(h.store, capExactStart.runId);
                expect(capExact.status).toBe("completed");
                expect(capExact.terminalOutcome).toBe("succeeded");
                expect(capExact.rerunUnwalked).toBe(6);

                // Rev 3: maxNodeExecutions = 9 (1 short: 8 reused + finish(9) + done(10 > 9)) -> fails max_node_executions!
                await saveSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    name: "rerun-max-exec-cap",
                    yaml: capYaml(9, "1.0.2"),
                    expected: { definitionId: capDefId, revision: 2 },
                    actor: OWNER_ACTOR,
                    operationId: `save-cap-v3-${randomUUID()}`,
                });
                const capShortStart = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: capDefId },
                    revision: 3,
                    inputs: {},
                    vars: { failFinish: false },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-cap-short-${randomUUID()}`,
                    rerunFrom: { workflowId: capR2Start.workflowId, executionId: capFinishVisit.nodeExecutionId, mode: "run_again" },
                });
                const capShort = await waitRunTerminal(h.store, capShortStart.runId);
                expect(capShort.status).toBe("failed");
                expect(capShort.terminalError?.code).toBe("limit_exceeded");

                // --- #3: maxVisits carry-over & exhausted at exact visit ---
                const mvYaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-max-visits, version: "1.0.0" }
limits: { maxNodeExecutions: 20 }
initial: work
states:
  work:
    type: script
    maxVisits: 3
    input: { n: "\${states.work.output.n ?? 0}" }
    outcomes: [again]
    source: |
      const next = context.input.n + 1;
      if (context.inputs.counterFile) await fetch(context.inputs.counterFile, { method: "POST", body: "work:" + next });
      if (context.kv.failAtVisit === next) process.exit(1);
      await setResult("again", { n: next });
    transition: { next: { again: work, exhausted: done, execution_failed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;
                const mvSaved = await saveSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    name: "rerun-max-visits",
                    yaml: mvYaml,
                    expected: null,
                    actor: OWNER_ACTOR,
                    operationId: `save-mv-${randomUUID()}`,
                });
                counter.reset();
                const mvR2Start = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: mvSaved.receipt.definitionId },
                    inputs: { counterFile: counter.file },
                    vars: { failAtVisit: 2 },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-mv-r2-${randomUUID()}`,
                });
                const mvR2 = await waitRunTerminal(h.store, mvR2Start.runId);
                expect(mvR2.status).toBe("failed");
                expect(counter.read()).toEqual(["work:1", "work:2"]);
                const mvVisit2 = (await h.store.listRerunKeys(mvR2.runId)).find(k => k.nodeId === "work" && k.ordinal === 2);
                expect(mvVisit2).toBeTruthy();

                counter.reset();
                const mvR3Start = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: mvSaved.receipt.definitionId },
                    vars: { failAtVisit: 0 },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-mv-r3-${randomUUID()}`,
                    rerunFrom: { workflowId: mvR2Start.workflowId, executionId: mvVisit2.nodeExecutionId, mode: "run_again" },
                });
                const mvR3 = await waitRunTerminal(h.store, mvR3Start.runId);
                expect(mvR3.status).toBe("completed");
                expect(mvR3.terminalOutcome).toBe("succeeded");
                // Visit 1 reused (0 exec), visits 2 & 3 executed fresh, visit 4 exhausted -> done!
                expect(counter.read()).toEqual(["work:2", "work:3"]);
                expect(mvR3.terminalOutput).toEqual({ n: 3 });

                // --- #5 & #6: catch-all reused & terminal invalid_output pass-over ---
                const catchYaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-catchall-terminal, version: "1.0.0" }
limits: { maxNodeExecutions: 20 }
initial: work
catchAll: handler
states:
  work:
    type: script
    outcomes: [ok]
    source: |
      if (context.inputs.counterFile) await fetch(context.inputs.counterFile, { method: "POST", body: "work" });
      await setResult("ok", { w: 1 });
    transition: { next: { ok: done } }
  done:
    type: terminal
    outcome: succeeded
    output: 8
    outputSchema: { type: string }
  handler:
    type: script
    outcomes: [ok]
    source: |
      if (context.inputs.counterFile) await fetch(context.inputs.counterFile, { method: "POST", body: "handler" });
      if (context.kv.failHandler) process.exit(1);
      await setResult("ok", { caught: true });
    transition: { next: { ok: after_handler } }
  after_handler:
    type: script
    outcomes: [ok]
    source: |
      if (context.inputs.counterFile) await fetch(context.inputs.counterFile, { method: "POST", body: "after_handler" });
      if (context.kv.failAfter) process.exit(1);
      await setResult("ok", { recovered: true });
    transition: { next: { ok: final_ok } }
  final_ok: { type: terminal, outcome: succeeded, output: "\${states.after_handler.output}" }
`;
                const catchSaved = await saveSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    name: "rerun-catchall-terminal",
                    yaml: catchYaml,
                    expected: null,
                    actor: OWNER_ACTOR,
                    operationId: `save-catch-${randomUUID()}`,
                });
                const catchDefId = catchSaved.receipt.definitionId;
                // Run #2: work -> done (invalid_output -> catchAll handler) -> handler succeeds -> after_handler fails (cannot re-enter catchAll -> run failed!)
                counter.reset();
                const catchR2Start = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: catchDefId },
                    inputs: { counterFile: counter.file },
                    vars: { failHandler: false, failAfter: true },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-catch-r2-${randomUUID()}`,
                });
                const catchR2 = await waitRunTerminal(h.store, catchR2Start.runId);
                expect(catchR2.status).toBe("failed");
                expect(counter.read()).toEqual(["work", "handler", "after_handler"]);
                const catchKeys = await h.store.listRerunKeys(catchR2.runId);
                const handlerVisit = catchKeys.find(k => k.nodeId === "handler");
                const afterVisit = catchKeys.find(k => k.nodeId === "after_handler");
                expect(handlerVisit).toBeTruthy();
                expect(afterVisit).toBeTruthy();

                // #6: Re-run #3 from handler (run_again): passes over work AND terminal done (invalid_output -> handler WITHOUT ending run!), runs handler + after_handler -> succeeds!
                counter.reset();
                const catchR3Start = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: catchDefId },
                    vars: { failHandler: false, failAfter: false },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-catch-r3-${randomUUID()}`,
                    rerunFrom: { workflowId: catchR2Start.workflowId, executionId: handlerVisit.nodeExecutionId, mode: "run_again" },
                });
                const catchR3 = await waitRunTerminal(h.store, catchR3Start.runId);
                expect(catchR3.status).toBe("completed");
                expect(catchR3.terminalOutcome).toBe("succeeded");
                expect(counter.read()).toEqual(["handler", "after_handler"]);
                expect(catchR3.terminalOutput).toEqual({ recovered: true });

                // #5: Re-run #4 from after_handler with failAfter=true: handler was ALREADY reused (catchAll entered before cut!) -> after_handler error MUST fail the run, NOT re-enter handler!
                counter.reset();
                const catchR4Start = await startSessionWorkflowDefinition(h, {
                    ownerSessionId,
                    definition: { definitionId: catchDefId },
                    vars: { failHandler: false, failAfter: true },
                    actor: OWNER_ACTOR,
                    owner: OWNER,
                    operationId: `start-catch-r4-${randomUUID()}`,
                    rerunFrom: { workflowId: catchR2Start.workflowId, executionId: afterVisit.nodeExecutionId, mode: "run_again" },
                });
                const catchR4 = await waitRunTerminal(h.store, catchR4Start.runId);
                expect(catchR4.status).toBe("failed");
                expect(counter.read()).toEqual(["after_handler"]);
            });
        });
    });

    it("covers Spec §11.2 #11 (reused send/request/approval/spawn counts do not grow) and #23 (run deadline & receive wait.totalSeconds restart fresh)", { timeout: testTime.ms(240_000) }, async () => {
        await withCounterFile(async (counter) => {
            await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
                const h = liveHost(client);
                const ownerSessionId = randomUUID();
                await h.catalog.createSession(ownerSessionId, { owner: OWNER });
                const pool = new pg.Pool(pgPoolConfig(getEnv().store));
                const s = `"${getEnv().cmsSchema.replace(/"/g, '""')}"`;

                try {
                    // --- #11: reused send, request, approval, spawn do not re-fire in the re-run ---
                    const childYaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-noop-child, version: "1.0.0" }
initial: done
states:
  done: { type: terminal, outcome: succeeded }
`;
                    await saveSessionWorkflowDefinition(h, {
                        ownerSessionId,
                        name: "rerun-noop-child",
                        yaml: childYaml,
                        expected: null,
                        actor: OWNER_ACTOR,
                        operationId: `save-child-${randomUUID()}`,
                    });

                    const sideEffectsYaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-side-effects, version: "1.0.0" }
limits: { maxNodeExecutions: 20 }
schemas:
  NoteBody: { type: object, properties: { msg: { type: string } } }
  AskReq: { type: object, properties: { q: { type: string } } }
  AskResp: { type: object, properties: { answer: { type: string } } }
contracts:
  Note@1: { schema: { $ref: "#/schemas/NoteBody" } }
  Ask@1:
    schema: { $ref: "#/schemas/AskReq" }
    response: { schema: { $ref: "#/schemas/AskResp" } }
initial: send_step
states:
  send_step:
    type: messaging
    mode: send
    recipient: { parent: true }
    contract: Note@1
    input: { msg: "hi" }
    transition: { next: { sent: req_step, failure: failed } }
  req_step:
    type: messaging
    mode: request
    recipient: { parent: true }
    contract: Ask@1
    input: { q: "ok?" }
    timeoutSeconds: 60
    transition: { next: { responded: appr_step, declined: failed, timed_out: failed, failure: failed } }
  appr_step:
    type: approval
    question: "Approve?"
    timeoutSeconds: 60
    transition: { next: { approved: spawn_step, rejected: failed, timed_out: failed, failure: failed } }
  spawn_step:
    type: spawn
    definition: rerun-noop-child
    transition: { next: { started: tail, failure: failed } }
  tail:
    type: script
    outcomes: [ok]
    source: |
      if (context.inputs.counterFile) await fetch(context.inputs.counterFile, { method: "POST", body: "tail" });
      await setResult("ok", { tailDone: true });
    transition: { next: { ok: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${states.tail.output}" }
  failed: { type: terminal, outcome: failed }
`;
                    const seSaved = await saveSessionWorkflowDefinition(h, {
                        ownerSessionId,
                        name: "rerun-side-effects",
                        yaml: sideEffectsYaml,
                        expected: null,
                        actor: OWNER_ACTOR,
                        operationId: `save-se-${randomUUID()}`,
                    });

                    // Seed ended run #2 with completed send, request, approval, spawn, and failed tail
                    const deferH = {
                        ...h,
                        duroxideClient: Object.assign(Object.create(client.duroxideClient), { startOrchestrationVersioned: async () => {} }),
                    };
                    const seR2Start = await startSessionWorkflowDefinition(deferH, {
                        ownerSessionId,
                        definition: { definitionId: seSaved.receipt.definitionId },
                        inputs: { counterFile: counter.file },
                        actor: OWNER_ACTOR,
                        owner: OWNER,
                        operationId: `seed-se-r2-${randomUUID()}`,
                    });
                    const seRun2Id = seR2Start.runId;
                    const nSend = nodeExecutionIdFor(seRun2Id, "root", "send_step", 1);
                    const nReq = nodeExecutionIdFor(seRun2Id, "root", "req_step", 1);
                    const nAppr = nodeExecutionIdFor(seRun2Id, "root", "appr_step", 1);
                    const nSpawn = nodeExecutionIdFor(seRun2Id, "root", "spawn_step", 1);
                    const nTail = nodeExecutionIdFor(seRun2Id, "root", "tail", 1);
                    const baseT = Date.now() - 30_000;
                    const seRows = [
                        [nSend, null, "send_step", 1, "messaging", null, '{"msg":"hi"}', "sent", "business", '{"sent":true}', null, "effect"],
                        [nReq, nSend, "req_step", 1, "messaging", "sent", '{"q":"ok?"}', "responded", "business", '{"answer":"yes"}', null, "message"],
                        [nAppr, nReq, "appr_step", 1, "approval", "responded", '{}', "approved", "business", JSON.stringify({ decision: "approved", question: "Approve?", decidedBy: { provider: OWNER.provider, subject: OWNER.subject }, decidedAt: new Date(baseT + 2500).toISOString() }), null, "approval"],
                        [nSpawn, nAppr, "spawn_step", 1, "spawn", "approved", '{}', "started", "business", '{"workflowId":"wf-old-child"}', null, "effect"],
                        [nTail, nSpawn, "tail", 1, "script", "started", '{"workflowId":"wf-old-child"}', "execution_failed", "runtime_error", null, '{"code":"execution_failed","message":"boom"}', "effect"],
                    ];
                    for (let i = 0; i < seRows.length; i += 1) {
                        const [id, pred, nid, ord, ntype, route, inp, out, rk, outText, errText, win] = seRows[i];
                        await pool.query(
                            `INSERT INTO ${s}.workflow_node_executions (
                                node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
                                input, input_sha256, state, outcome, result_kind, output, error, winner,
                                effect_attempts, entered_at, completed_at, kv_revision, deadline_at
                             ) VALUES ($1,$2,'root',$3,$4,$5,$6,$7,$8,$9,'completed',$10,$11,$12,$13,$14,1,$15::timestamptz,$16::timestamptz,1,NULL)`,
                            [id, seRun2Id, pred, nid, ord, ntype, route, inp, sha256Hex(inp), out, rk, outText, errText, win,
                                new Date(baseT + i * 1000).toISOString(), new Date(baseT + i * 1000 + 300).toISOString()],
                        );
                    }
                    await pool.query(`UPDATE ${s}.workflow_runs SET status = 'failed', finished_at = now() WHERE run_id = $1`, [seRun2Id]);

                    counter.reset();
                    const seR3Start = await startSessionWorkflowDefinition(h, {
                        ownerSessionId,
                        definition: { definitionId: seSaved.receipt.definitionId },
                        actor: OWNER_ACTOR,
                        owner: OWNER,
                        operationId: `start-se-r3-${randomUUID()}`,
                        rerunFrom: { workflowId: seR2Start.workflowId, executionId: nTail, mode: "run_again" },
                    });
                    const seR3 = await waitRunTerminal(h.store, seR3Start.runId);
                    expect(seR3.status).toBe("completed");
                    expect(seR3.terminalOutcome).toBe("succeeded");
                    expect(counter.read()).toEqual(["tail"]);

                    // Assert 0 new outbox sends, 0 new requests, 0 new approvals, and 0 new child workflows created for #3!
                    const { rows: obCnt } = await pool.query(`SELECT count(*)::int AS c FROM ${s}.workflow_outbox WHERE run_id = $1`, [seR3Start.runId]);
                    const { rows: rqCnt } = await pool.query(`SELECT count(*)::int AS c FROM ${s}.workflow_requests WHERE run_id = $1`, [seR3Start.runId]);
                    const { rows: apCnt } = await pool.query(`SELECT count(*)::int AS c FROM ${s}.workflow_approvals WHERE run_id = $1`, [seR3Start.runId]);
                    const { rows: chCnt } = await pool.query(`SELECT count(*)::int AS c FROM ${s}.workflow_definitions WHERE parent_session_id = $1`, [seR3Start.workflowId]);
                    expect(obCnt[0].c).toBe(0);
                    expect(rqCnt[0].c).toBe(0);
                    expect(apCnt[0].c).toBe(0);
                    expect(chCnt[0].c).toBe(0);

                    // --- #23: run deadline (limits.timeoutSeconds) AND receive wait.totalSeconds restart fresh ---
                    const clockYaml = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-clock-restart, version: "1.0.0" }
limits: { timeoutSeconds: 15, maxNodeExecutions: 20 }
schemas:
  TickBody: { type: object, properties: { seq: { type: integer } } }
contracts:
  Tick@1: { schema: { $ref: "#/schemas/TickBody" } }
initial: listen
states:
  listen:
    type: messaging
    mode: receive
    contract: Tick@1
    wait: { totalSeconds: 4 }
    transition: { next: { received: record, elapsed: failed, failure: failed } }
  record:
    type: script
    input: { seq: "\${states.listen.output.payload.seq}" }
    outcomes: [again, done]
    source: |
      if (context.input.seq >= 2) await setResult("done", { seq: context.input.seq });
      else await setResult("again", { seq: context.input.seq });
    transition: { next: { again: listen, done: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${states.record.output}" }
  failed: { type: terminal, outcome: failed }
`;
                    const clockSaved = await saveSessionWorkflowDefinition(h, {
                        ownerSessionId,
                        name: "rerun-clock-restart",
                        yaml: clockYaml,
                        expected: null,
                        actor: OWNER_ACTOR,
                        operationId: `save-clock-${randomUUID()}`,
                    });
                    const clockR2Start = await startSessionWorkflowDefinition(deferH, {
                        ownerSessionId,
                        definition: { definitionId: clockSaved.receipt.definitionId },
                        inputs: {},
                        actor: OWNER_ACTOR,
                        owner: OWNER,
                        operationId: `seed-clock-r2-${randomUUID()}`,
                    });
                    const clockR2Id = clockR2Start.runId;
                    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
                    const twoHoursAgoPlus1s = new Date(Date.now() - 2 * 3600 * 1000 + 1000).toISOString();
                    const twoHoursAgoPlus4s = new Date(Date.now() - 2 * 3600 * 1000 + 4000).toISOString();
                    const l1 = nodeExecutionIdFor(clockR2Id, "root", "listen", 1);
                    const rec1 = nodeExecutionIdFor(clockR2Id, "root", "record", 1);
                    const l2 = nodeExecutionIdFor(clockR2Id, "root", "listen", 2);
                    await pool.query(
                        `INSERT INTO ${s}.workflow_node_executions (
                            node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
                            input, input_sha256, state, outcome, result_kind, output, error, winner,
                            effect_attempts, entered_at, completed_at, kv_revision, deadline_at
                         ) VALUES
                         ($1,$2,'root',NULL,'listen',1,'messaging',NULL,'{}',$3,'completed','received','business','{"payload":{"seq":1}}',NULL,'message',1,$4::timestamptz,$4::timestamptz,1,$5::timestamptz),
                         ($6,$2,'root',$1,'record',1,'script','received','{"seq":1}',$7,'completed','again','business','{"seq":1}',NULL,'effect',1,$8::timestamptz,$8::timestamptz,1,NULL),
                         ($9,$2,'root',$6,'listen',2,'messaging','again','{}',$3,'completed','elapsed','business','{}',NULL,'timer',1,$5::timestamptz,$5::timestamptz,1,NULL)`,
                        [l1, clockR2Id, sha256Hex("{}"), twoHoursAgo, twoHoursAgoPlus4s, rec1, sha256Hex('{"seq":1}'), twoHoursAgoPlus1s, l2],
                    );
                    await pool.query(
                        `UPDATE ${s}.workflow_runs SET status = 'failed', created_at = $2::timestamptz, deadline_at = $3::timestamptz, finished_at = $3::timestamptz WHERE run_id = $1`,
                        [clockR2Id, twoHoursAgo, twoHoursAgoPlus4s],
                    );

                    // Re-run #3 from listen#2: BOTH run deadline (15s) and listen totalSeconds (4s) must start fresh!
                    const beforeStartMs = Date.now();
                    const clockR3Start = await startSessionWorkflowDefinition(h, {
                        ownerSessionId,
                        definition: { definitionId: clockSaved.receipt.definitionId },
                        actor: OWNER_ACTOR,
                        owner: OWNER,
                        operationId: `start-clock-r3-${randomUUID()}`,
                        rerunFrom: { workflowId: clockR2Start.workflowId, executionId: l2, mode: "run_again" },
                    });

                    // Wait until listen#2 is admitted in pending state, confirm fresh deadline_at > now, then deliver Tick@1 after 600ms!
                    const waitAdmit = Date.now() + 15_000;
                    let r3Run = null;
                    let r3Listen2 = null;
                    while (Date.now() < waitAdmit) {
                        r3Run = await h.store.readRun(clockR3Start.runId);
                        r3Listen2 = await h.store.readNodeExecution(nodeExecutionIdFor(clockR3Start.runId, "root", "listen", 2));
                        if (r3Listen2 && r3Listen2.state === "pending") break;
                        await new Promise(r => setTimeout(r, 80));
                    }
                    expect(r3Run?.deadlineAt).toBeTruthy();
                    expect(r3Run.deadlineAt.getTime()).toBeGreaterThan(beforeStartMs + 10_000);
                    expect(r3Listen2?.state).toBe("pending");
                    expect(r3Listen2?.deadlineAt).toBeTruthy();
                    expect(r3Listen2.deadlineAt.getTime()).toBeGreaterThan(beforeStartMs + 2_000);

                    await new Promise(r => setTimeout(r, 600));
                    await sendTypedWorkflowInput(h, {
                        workflowSessionId: clockR3Start.workflowId,
                        senderSessionId: ownerSessionId,
                        runId: clockR3Start.runId,
                        contract: "Tick@1",
                        payload: { seq: 2 },
                        operationId: `tick-2-${randomUUID()}`,
                    });
                    const clockR3 = await waitRunTerminal(h.store, clockR3Start.runId);
                    expect(clockR3.status).toBe("completed");
                    expect(clockR3.terminalOutcome).toBe("succeeded");
                    expect(clockR3.terminalOutput).toEqual({ seq: 2 });
                } finally {
                    await pool.end();
                }
            });
        });
    });
});
