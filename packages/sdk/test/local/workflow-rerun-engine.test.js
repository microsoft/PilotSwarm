import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { PostgresProvider, Runtime, Client } from "duroxide";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { registerWorkflow, sessionQueueTransport } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "entra", subject: "owner-sub-5", displayName: "Owner 5" };
const OWNER_ACTOR = { kind: "user", provider: OWNER.provider, subject: OWNER.subject, name: "Owner 5" };

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
      await setResult("ok", { tag: "from-step1", execId: context.nodeExecutionId });
    transition: { next: { ok: provision, failure: failed } }
  provision:
    type: script
    outcomes: [ok]
    outputSchema: { $ref: "#/schemas/ProvisionOut" }
    carry: { tag: "\${states.step1.output.tag}" }
    source: |
      if (context.kv.failProv) process.exit(1);
      await setResult("ok", { fqdn: "live.db" });
    transition: { next: { ok: verify, execution_failed: failed, failure: failed } }
  verify:
    type: script
    input: { fqdn: "\${states.provision.output.fqdn}", carriedTag: "\${states.step1.output.tag}", step1Exec: "\${states.step1.output.execId}" }
    outcomes: [ok]
    source: |
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
            await setResult("ok", { item: context.branch.item });
          transition: { next: { ok: lane_done, failure: lane_done } }
        lane_done: { type: terminal, outcome: succeeded, output: "\${states.lane.output}" }
    transition: { next: { joined: finish, blocked: failed, failure: failed } }
  finish:
    type: script
    input: { step1Exec: "\${states.step1.output.step1Exec}" }
    outcomes: [ok]
    source: |
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
initial: step1
states:
  step1:
    type: script
    outcomes: [ok]
    source: 'await setResult("ok", {});'
    transition: { next: { ok: fan, failure: fail_end } }
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
          a_end: { type: terminal, outcome: succeeded }
    transition: { next: { joined: ok_end, blocked: fail_end, failure: fail_end } }
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
    it("runs supply mode end-to-end (provisioning failure -> supply -> downstream reads output & carry) and supply at visit 1 (reused=0)", { timeout: testTime.ms(180_000) }, async () => {
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

            // Run #2: step1 runs, provision fails with exit(1) -> enters terminal failed (status=completed, terminalOutcome=failed)
            const run2Start = await startSessionWorkflowDefinition(h, {
                ownerSessionId,
                definition: { definitionId: defId },
                inputs: {},
                vars: { failProv: true },
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: `start-sup-r2-${randomUUID()}`,
            });
            const run2 = await waitRunTerminal(h.store, run2Start.runId);
            expect(run2.status).toBe("failed");
            expect(run2.terminalOutcome).toBe("failed");

            const r2Keys = await h.store.listRerunKeys(run2.runId);
            const step1Visit = r2Keys.find(k => k.nodeId === "step1");
            const provVisit = r2Keys.find(k => k.nodeId === "provision");
            expect(step1Visit).toBeTruthy();
            expect(provVisit).toBeTruthy();

            // Re-run #3 in supply mode: supplies provision result -> passes over step1 & provision without re-running either!
            const run3Start = await startSessionWorkflowDefinition(h, {
                ownerSessionId,
                definition: { definitionId: defId },
                inputs: {},
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
            // Output proves step1 was NOT re-run (kept #2's nodeExecutionId!), and verify consumed supplied fqdn + step1 tag!
            expect(run3.terminalOutput).toEqual({
                verified: "supplied-prod.db",
                tag: "from-step1",
                step1Exec: step1Visit.nodeExecutionId,
            });

            // Check workflow.started event carries rerunOf!
            const events3 = await h.catalog.getSessionEvents(run3Start.workflowId);
            const startedEvt = events3.find(e => e.eventType === "workflow.started");
            expect(startedEvt?.data?.rerunOf?.workflowId).toBe(run2Start.workflowId);
            expect(startedEvt?.data?.rerunOf?.mode).toBe("supply");

            // Supply at visit 1 (reused = 0): supply step1 itself -> step1 is NOT re-run; provision runs fresh (with failProv=false via vars overlay)!
            const run4Start = await startSessionWorkflowDefinition(h, {
                ownerSessionId,
                definition: { definitionId: defId },
                inputs: {},
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
            expect(run4.terminalOutput).toEqual({
                verified: "live.db",
                tag: "supplied-at-v1",
                step1Exec: "supplied-v1",
            });
        });
    });

    it("runs run_again over a reused parallel fan-out without re-executing lanes, subtracts rerunUnwalked, and catches pre-cut divergence", { timeout: testTime.ms(180_000) }, async () => {
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
                inputs: {},
                vars: { failFinish: true },
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: `start-par-r2-${randomUUID()}`,
            });
            const r2 = await waitRunTerminal(h.store, r2Start.runId);
            expect(r2.status).toBe("failed");
            expect(r2.terminalOutcome).toBe("failed");

            const r2Keys = await h.store.listRerunKeys(r2.runId);
            const step1Visit = r2Keys.find(k => k.nodeId === "step1");
            const finishVisit = r2Keys.find(k => k.nodeId === "finish");
            expect(finishVisit).toBeTruthy();

            // Re-run #3 from finish with failFinish=false: step1 + parallel lanes passed over!
            const r3Start = await startSessionWorkflowDefinition(h, {
                ownerSessionId,
                definition: { definitionId: defId },
                inputs: {},
                vars: { failFinish: false },
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: `start-par-r3-${randomUUID()}`,
                rerunFrom: { workflowId: r2Start.workflowId, executionId: finishVisit.nodeExecutionId, mode: "run_again" },
            });
            const r3 = await waitRunTerminal(h.store, r3Start.runId);
            expect(r3.status).toBe("completed");
            expect(r3.terminalOutcome).toBe("succeeded");
            expect(r3.rerunUnwalked).toBeGreaterThanOrEqual(4); // 2 lanes x (lane + lane_done)
            expect(r3.terminalOutput).toEqual({ finished: true, step1Exec: step1Visit.nodeExecutionId });

            // Divergence guard: save rev 2 with a different initial state and skip pre-admission fit check -> fails rerun_diverged with 0 post-cut work!
            const divYaml = PARALLEL_RERUN_YAML
                .replace('version: "1.0.0"', 'version: "1.0.1"')
                .replace("initial: step1", "initial: finish");
            await saveSessionWorkflowDefinition(h, {
                ownerSessionId,
                name: "rerun-parallel-flow",
                yaml: divYaml,
                expected: { definitionId: defId, revision: 1 },
                actor: OWNER_ACTOR,
                operationId: `save-par-v2-${randomUUID()}`,
            });
            const rDivStart = await startSessionWorkflowDefinition(h, {
                ownerSessionId,
                definition: { definitionId: defId },
                revision: 2,
                inputs: {},
                actor: OWNER_ACTOR,
                owner: OWNER,
                operationId: `start-par-div-${randomUUID()}`,
                rerunFrom: { workflowId: r2Start.workflowId, executionId: finishVisit.nodeExecutionId, mode: "run_again", _skipFitCheckForTest: true },
            });
            const rDiv = await waitRunTerminal(h.store, rDivStart.runId);
            expect(rDiv.status).toBe("failed");
            expect(rDiv.terminalError?.code).toBe("rerun_diverged");
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
            const pool = new pg.Pool(pgPoolConfig(env.store));
            const s = `"${env.cmsSchema.replace(/"/g, '""')}"`;
            let srcWfId;
            let srcRunId;
            let visit2Id;
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

            // Wait for loop_agent#3 (cycle 3) to spawn!
            const deadline1 = Date.now() + 30_000;
            while (promptsSeen.length < 1 && Date.now() < deadline1) await new Promise(r => setTimeout(r, 100));
            expect(promptsSeen.length).toBeGreaterThanOrEqual(1);
            const p3 = promptsSeen[0];
            expect(p3.prompt).toContain("cycle 3");
            expect(p3.prompt).toContain("Manual rescue of cycle 2");
            expect(p3.prompt).toContain("rerunRecap");

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

            // Wait for loop_agent#4 (cycle 4) to spawn in the SAME child session!
            const deadline2 = Date.now() + 30_000;
            while (promptsSeen.length < 2 && Date.now() < deadline2) await new Promise(r => setTimeout(r, 100));
            expect(promptsSeen.length).toBeGreaterThanOrEqual(2);
            const p4 = promptsSeen[1];
            expect(p4.childSessionId).toBe(p3.childSessionId);
            expect(p4.prompt).toContain("CYCLE 4");

            // Verify S7 readAgentCyclesLostBefore reports { cycle: 4, lost: [3] }!
            const lostInfo = await store.readAgentCyclesLostBefore(p4.childSessionId, p4.nodeExecutionId);
            expect(lostInfo).toEqual({ cycle: 4, lost: [3] });

            // Verify I8 readReusedAgentVisits ordering works for named-branch continued agent too
            const reusedSummary = await store.readReusedAgentVisits(r3Start.runId, "loop_agent");
            expect(reusedSummary.count).toBe(2);
            expect(reusedSummary.visits.map(v => v.source)).toEqual(["reused", "supplied"]);
            expect(reusedSummary.visits[1].suppliedNote).toBe("Manual rescue of cycle 2");

            // Complete cycle 4 with outcome="done" -> run completes cleanly (and endAgent on reused/supplied visits was a clean no-op!)
            await store.completeNode(p4.nodeExecutionId, { outcome: "done", resultKind: "business", valueText: '{"c":4}', winner: "agent" }, {
                sessionId: r3Start.workflowId, events: [],
            });
            const r3 = await waitRunTerminal(store, r3Start.runId);
            expect(r3.status).toBe("completed");
            expect(r3.terminalOutcome).toBe("succeeded");

            // Sanity compile check on I8 named-branch continued agent YAML
            const nbSaved = await saveSessionWorkflowDefinition(h, {
                ownerSessionId,
                name: "rerun-named-branch-agent",
                yaml: NAMED_BRANCH_CONTINUED_AGENT_YAML,
                expected: null,
                actor: OWNER_ACTOR,
                operationId: `save-nb-${randomUUID()}`,
            });
            expect(nbSaved.receipt.valid).toBe(true);
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
});
