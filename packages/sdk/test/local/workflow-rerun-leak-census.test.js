/**
 * Re-run Resource Leak Census Suite (I7 Unit 3B — Task 6a: S1–S15).
 *
 * Verifies zero resource leaks across all 8 census categories (orchestrations, active runs,
 * child workflows, agent sessions, bare claim shells, open work on terminal runs, open/non-finite
 * inbox rows on terminal runs, and unswept sessions after owner end + Sweeper + prune_orchestrations)
 * across every I7 re-run lifecycle scenario on PG16 and live HorizonDB:
 *
 *   S1   G-R1 auto-pick cut-back with live 4-resource busy child (wait/receive/approval/request).
 *   S2   G-R2 spawn re-run while old 4-resource busy child winds down asynchronously.
 *   S3   `continue` mode consuming carried `WorkflowEnded@1` child notice (zero new children spawned).
 *   S4   `supply` mode on timed-out / failed agent step (live agent child ends cleanly; #3 spawns 0 agents).
 *   S5   Post-claim refusal immediately soft-deleting claim shell (before Sweeper runs).
 *   S6   Unretried claim crash while owner stays live — Sweeper skips before grace and collects after grace.
 *   S7   Crash + retry with same operationId = 1 reused shell, 0 leaks.
 *   S8   `rerun_diverged` = 0 post-cut work & 0 leaks.
 *   S9   Multi-generation `#1 -> #2 -> #3 -> #4` chain.
 *   S10  Standalone re-run of spawned child + owner end.
 *   S11  Parallel lane child spawns (G-R1 lane cut-back + full parallel re-run).
 *   S12  `pause` (+ `resume`), `stop` (grace 0), and `cancel` during pass-over (all three tested).
 *   S13  Fault-injected transient failure on `parent-end:` cancel retried to terminal.
 *   S14  `#2` deleted while `#3` runs (and `#4` re-runs cleanly from `#3`).
 *   S15  Unconsumed carried inbox message in `#3`: `listOpenInbox` omits ended run, direct SQL proves
 *        finite `expires_at` and TTL expiry to 0 active rows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { registerWorkflow, sessionQueueTransport } from "../../src/workflow/runtime.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { controlWorkflowRun, sendTypedWorkflowInput } from "../../src/workflow/service.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { createSweeperTools } from "../../src/sweeper-tools.ts";
import { buildPgPoolConfig } from "../../src/pg-pool-factory.ts";
import { assertNoLeaks, census } from "../helpers/workflow-leak-census.js";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = testTime.ms(300_000);
const ITERATIONS = 3;
const OWNER = { provider: "test", subject: "rerun-leak-owner", displayName: "Rerun Leak Owner" };
const ENGINE = { kind: "system", name: "workflow-rerun-leak-census-test" };
const OWNER_STAND_IN = "rerun-leak-owner-standin";
const FAKE_AGENT_CHILD = "rerun-leak-fake-agent-child";
const MARK_AGENT_ENDED = "rerun-leak-mark-agent-ended";
const TERMINAL_ORCH = new Set(["Completed", "Failed", "Terminated", "NotFound"]);
const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "stopped"]);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(label, check, timeoutMs = 60_000) {
    const deadline = Date.now() + testTime.ms(timeoutMs);
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(60);
    }
    throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

// ─── Inline Workflow Definitions ────────────────────────────────────

const BUSY_CHILD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: busy-child, version: "1.0.0" }
inputs:
  schema:
    type: object
    required: [responder]
    properties:
      responder: { type: string }
    additionalProperties: false
schemas:
  Ping: { type: object, additionalProperties: true }
  AskQ: { type: object, required: [q], properties: { q: { type: string } }, additionalProperties: false }
  AskA: { type: object, required: [ok], properties: { ok: { type: boolean } }, additionalProperties: false }
contracts:
  Ping@1:
    schema: { $ref: "#/schemas/Ping" }
  Ask@1:
    schema: { $ref: "#/schemas/AskQ" }
    response: { schema: { $ref: "#/schemas/AskA" } }
initial: fan
states:
  fan:
    type: parallel
    concurrency: 4
    branches:
      b_wait:
        initial: wait_step
        states:
          wait_step:
            type: wait
            seconds: 300
            transition: { next: { elapsed: w_done } }
          w_done: { type: terminal, outcome: succeeded }
      b_recv:
        initial: recv_step
        states:
          recv_step:
            type: messaging
            mode: receive
            contract: Ping@1
            wait: { seconds: 300 }
            transition: { next: { received: r_done, elapsed: r_done, failure: r_done } }
          r_done: { type: terminal, outcome: succeeded }
      b_appr:
        initial: appr_step
        states:
          appr_step:
            type: approval
            question: "Approve busy child?"
            timeoutSeconds: 300
            transition: { next: { approved: a_done, rejected: a_done, timed_out: a_done, failure: a_done } }
          a_done: { type: terminal, outcome: succeeded }
      b_req:
        initial: req_step
        states:
          req_step:
            type: messaging
            mode: request
            recipient: { sessionId: "\${inputs.responder}" }
            contract: Ask@1
            input: { q: "still alive?" }
            timeoutSeconds: 300
            transition: { next: { responded: q_done, declined: q_done, timed_out: q_done, failure: q_done } }
          q_done: { type: terminal, outcome: succeeded }
    transition: { next: { joined: done, blocked: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const QUICK_CHILD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: quick-child, version: "1.0.0" }
inputs:
  schema:
    type: object
    properties:
      tag: { type: string }
    additionalProperties: false
initial: work
states:
  work:
    type: script
    outcomes: [ok]
    input: { tag: "\${inputs.tag}" }
    source: |
      await setResult("ok", { ok: true, tag: context.input.tag ?? "quick" });
    transition: { next: { ok: done, execution_failed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${states.work.output}" }
  failed: { type: terminal, outcome: failed }
`;

const PARENT_SPAWN_GATE_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-spawn-gate, version: "1.0.0" }
inputs:
  schema:
    type: object
    required: [responder]
    properties:
      responder: { type: string }
    additionalProperties: false
schemas:
  Go: { type: object, additionalProperties: true }
contracts:
  Go@1: { schema: { $ref: "#/schemas/Go" } }
initial: setup
states:
  setup:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { ready: true });
    transition: { next: { ok: launch, execution_failed: failed, failure: failed } }
  launch:
    type: spawn
    definition: busy-child
    inputs:
      responder: "\${inputs.responder}"
    transition: { next: { started: wait_go, failure: failed } }
  wait_go:
    type: messaging
    mode: receive
    contract: Go@1
    wait: { seconds: 60 }
    transition: { next: { received: gate, elapsed: failed, failure: failed } }
  gate:
    type: script
    outcomes: [ok]
    source: |
      if (context.kv.failGate) process.exit(1);
      await setResult("ok", { ok: true });
    transition: { next: { ok: done, execution_failed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${states.gate.output}" }
  failed: { type: terminal, outcome: failed }
`;

const PARENT_CONTINUE_NOTICE_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-continue-notice, version: "1.0.0" }
schemas:
  Go: { type: object, additionalProperties: true }
contracts:
  Go@1: { schema: { $ref: "#/schemas/Go" } }
initial: launch
states:
  launch:
    type: spawn
    definition: quick-child
    inputs: { tag: "notice-child" }
    transition: { next: { started: prep, failure: failed } }
  prep:
    type: messaging
    mode: receive
    contract: Go@1
    wait: { seconds: 60 }
    transition: { next: { received: after_prep, elapsed: failed, failure: failed } }
  after_prep:
    type: script
    outcomes: [ok]
    source: |
      if (context.kv.failAfterPrep) process.exit(1);
      await setResult("ok", { continued: true });
    transition: { next: { ok: await_child, execution_failed: failed, failure: failed } }
  await_child:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    wait: { seconds: 30 }
    transition: { next: { received: done, elapsed: failed, failure: failed } }
  done:
    type: terminal
    outcome: succeeded
    output:
      notice: "\${states.await_child.output}"
      continued: "\${states.after_prep.output.continued}"
  failed: { type: terminal, outcome: failed }
`;

const AGENT_SUPPLY_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: agent-supply, version: "1.0.0" }
schemas:
  Answer:
    type: object
    required: [answer]
    properties:
      answer: { type: string }
    additionalProperties: false
initial: prep
states:
  prep:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { prepared: true });
    transition: { next: { ok: work_agent, execution_failed: failed, failure: failed } }
  work_agent:
    type: agent
    invoke:
      prompt: "Produce answer"
    outcomes: [completed]
    outputSchema: { $ref: "#/schemas/Answer" }
    timeoutSeconds: 1
    transition: { next: { completed: finish, timed_out: failed, execution_failed: failed, failure: failed } }
  finish:
    type: script
    outcomes: [ok]
    input: { answer: "\${states.work_agent.output.answer}" }
    source: |
      await setResult("ok", { got: context.input.answer });
    transition: { next: { ok: done, execution_failed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${states.finish.output}" }
  failed: { type: terminal, outcome: failed }
`;

const THREE_STEP_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: three-step, version: "1.0.0" }
initial: s1
states:
  s1:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { step: 1 });
    transition: { next: { ok: s2, execution_failed: failed, failure: failed } }
  s2:
    type: script
    outcomes: [ok]
    source: |
      if (context.kv.failAt === 2) process.exit(1);
      await setResult("ok", { step: 2 });
    transition: { next: { ok: s3, execution_failed: failed, failure: failed } }
  s3:
    type: script
    outcomes: [ok]
    source: |
      if (context.kv.failAt === 3) process.exit(1);
      await setResult("ok", { step: 3 });
    transition: { next: { ok: done, execution_failed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${states.s3.output}" }
  failed: { type: terminal, outcome: failed }
`;

const SLOW_LIVE_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: slow-live, version: "1.0.0" }
initial: hold
states:
  hold:
    type: wait
    seconds: 300
    transition: { next: { elapsed: done } }
  done: { type: terminal, outcome: succeeded }
`;

const STANDALONE_CHILD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: standalone-child, version: "1.0.0" }
initial: c1
states:
  c1:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { c1: true });
    transition: { next: { ok: c2, execution_failed: failed, failure: failed } }
  c2:
    type: script
    outcomes: [ok]
    source: |
      if (context.kv.failChild) process.exit(1);
      await setResult("ok", { c2: true });
    transition: { next: { ok: done, execution_failed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${states.c2.output}" }
  failed: { type: terminal, outcome: failed }
`;

const STANDALONE_PARENT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: standalone-parent, version: "1.0.0" }
initial: spawn_c
states:
  spawn_c:
    type: spawn
    definition: standalone-child
    inputs: {}
    transition: { next: { started: await_c, failure: failed } }
  await_c:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    wait: { seconds: 30 }
    transition: { next: { received: done, elapsed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const PARALLEL_SPAWN_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parallel-spawn, version: "1.0.0" }
inputs:
  schema:
    type: object
    required: [responder]
    properties:
      responder: { type: string }
    additionalProperties: false
schemas:
  Go: { type: object, additionalProperties: true }
contracts:
  Go@1: { schema: { $ref: "#/schemas/Go" } }
initial: setup
states:
  setup:
    type: script
    outcomes: [ok]
    source: |
      await setResult("ok", { ready: true });
    transition: { next: { ok: fan, execution_failed: failed, failure: failed } }
  fan:
    type: parallel
    concurrency: 2
    branches:
      lane_a:
        initial: spawn_a
        states:
          spawn_a:
            type: spawn
            definition: busy-child
            inputs:
              responder: "\${inputs.responder}"
            transition: { next: { started: a_done, failure: a_fail } }
          a_done: { type: terminal, outcome: succeeded }
          a_fail: { type: terminal, outcome: failed }
      lane_b:
        initial: spawn_b
        states:
          spawn_b:
            type: spawn
            definition: busy-child
            inputs:
              responder: "\${inputs.responder}"
            transition: { next: { started: b_done, failure: b_fail } }
          b_done: { type: terminal, outcome: succeeded }
          b_fail: { type: terminal, outcome: failed }
    transition: { next: { joined: wait_go, blocked: failed, failure: failed } }
  wait_go:
    type: messaging
    mode: receive
    contract: Go@1
    wait: { seconds: 60 }
    transition: { next: { received: post, elapsed: failed, failure: failed } }
  post:
    type: script
    outcomes: [ok]
    source: |
      if (context.kv.failPost) process.exit(1);
      await setResult("ok", { ok: true });
    transition: { next: { ok: done, execution_failed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${states.post.output}" }
  failed: { type: terminal, outcome: failed }
`;

const INBOX_TTL_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: inbox-ttl, version: "1.0.0" }
schemas:
  Start: { type: object, additionalProperties: true }
  Note: { type: object, additionalProperties: true }
contracts:
  Start@1: { schema: { $ref: "#/schemas/Start" } }
  Note@1: { schema: { $ref: "#/schemas/Note" } }
initial: s1
states:
  s1:
    type: messaging
    mode: receive
    contract: Start@1
    wait: { seconds: 60 }
    transition: { next: { received: s2, elapsed: failed, failure: failed } }
  s2:
    type: messaging
    mode: receive
    contract: Note@1
    wait: { seconds: 60 }
    transition: { next: { received: s3, elapsed: failed, failure: failed } }
  s3:
    type: script
    outcomes: [ok]
    source: |
      if (context.kv.failS3) process.exit(1);
      await setResult("ok", { ok: true });
    transition: { next: { ok: done, execution_failed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${states.s3.output}" }
  failed: { type: terminal, outcome: failed }
`;

// ─── Shared Sweeper + Harness Helpers ───────────────────────────────

function* fakeAgentChild(ctx, input) {
    const childSessionId = input?.childSessionId;
    while (true) {
        const msg = yield ctx.dequeueEvent("messages");
        const parsed = typeof msg === "string" ? JSON.parse(msg) : msg;
        if (parsed?.type === "cmd" && (parsed.cmd === "done" || parsed.cmd === "cancel")) {
            if (childSessionId) {
                yield ctx.scheduleActivity(MARK_AGENT_ENDED, {
                    sessionId: childSessionId,
                    state: parsed.cmd === "done" ? "completed" : "cancelled",
                });
            }
            return "ended";
        }
    }
}

async function sweepOwnerTree({ store, catalog, duroxideClient, q, ownerId, reason = "rerun-leak-census sweep" }) {
    const tools = createSweeperTools({ catalog, duroxideClient, factStore: null });
    const scan = tools.find(t => t.name === "scan_completed_sessions");
    const cleanup = tools.find(t => t.name === "cleanup_session");
    const prune = tools.find(t => t.name === "prune_orchestrations");

    for (let pass = 0; pass < 8; pass += 1) {
        await pause(50);
        const scanned = await scan.handler({ graceMinutes: 0 });
        expect(scanned.error, `scan_completed_sessions error: ${JSON.stringify(scanned)}`).toBeUndefined();
        const snapshot = await census({ store, catalog, duroxideClient, rootSessionIds: [ownerId], graceMs: 0 });
        const treeIds = new Set(snapshot.treeSessionIds);
        const targets = (scanned.sessions ?? []).map(s => s.sessionId).filter(id => treeIds.has(id));
        if (targets.length === 0) {
            const remaining = await q(
                "SELECT session_id FROM SCHEMA.sessions WHERE session_id = ANY($1::text[]) AND deleted_at IS NULL",
                [[...treeIds]],
            );
            if (remaining.length === 0) break;
            // On HorizonDB where DB server clock can lead client Date.now(), age updated_at past cutoff.
            await q(
                "UPDATE SCHEMA.sessions SET updated_at = LEAST(updated_at, $2::timestamptz) WHERE session_id = ANY($1::text[]) AND deleted_at IS NULL",
                [remaining.map(r => r.session_id), new Date(Date.now() - 5_000).toISOString()],
            );
            continue;
        }
        const cleaned = await cleanup.handler({ sessionIds: targets, graceMinutes: 0, reason });
        expect(cleaned.ok, `cleanup_session failed: ${JSON.stringify(cleaned)}`).toBe(true);
        const nonBusyRefusals = (cleaned.results ?? []).filter(r => r.refused && r.status !== "Busy");
        expect(nonBusyRefusals, `cleanup_session unexpected refusals: ${JSON.stringify(cleaned)}`).toEqual([]);
        const unexpectedFailures = (cleaned.results ?? []).filter(r => !r.ok && !r.refused && r.error !== "Session not found");
        expect(unexpectedFailures, `cleanup_session unexpected failures: ${JSON.stringify(cleaned)}`).toEqual([]);
    }

    const finalCensus = await until(`prune_orchestrations clears all terminal instances for ${ownerId}`, async () => {
        const pruned = await prune.handler({ deleteTerminalOlderThanMinutes: -1, keepExecutions: 1 });
        expect(pruned.ok, `prune_orchestrations failed: ${JSON.stringify(pruned)}`).toBe(true);
        const snap = await census({ store, catalog, duroxideClient, rootSessionIds: [ownerId], graceMs: 0 });
        const unpruned = Object.entries(snap.orchestrationStatuses).filter(([, status]) => status !== "NotFound");
        return unpruned.length === 0 ? snap : null;
    }, 45_000);
    assertNoLeaks(finalCensus, { allow: [] });
    return finalCensus;
}

async function startRuntimeHarness(env, { wrapStore = null } = {}) {
    const tag = randomUUID().slice(0, 8);
    const duroxideSchema = `duroxide_rlc_${tag}`;
    const cmsSchema = `cms_rlc_${tag}`;
    let provider = null;
    let catalog = null;
    let pool = null;
    let runtime = null;
    let runtimeStarted = false;

    const cleanupPartial = async () => {
        if (runtime && runtimeStarted) {
            try { await runtime.shutdown(100); } catch {}
        }
        if (catalog) {
            try { await catalog.close(); } catch {}
        }
        const dropPool = pool ?? new pg.Pool(buildPgPoolConfig({ connectionString: env.store }));
        try { await dropPool.query(`DROP SCHEMA IF EXISTS "${duroxideSchema}" CASCADE`); } catch {}
        try { await dropPool.query(`DROP SCHEMA IF EXISTS "${cmsSchema}" CASCADE`); } catch {}
        try { await dropPool.end(); } catch {}
    };

    try {
        provider = await PostgresProvider.connectWithSchema(env.store, duroxideSchema);
        const client = new Client(provider);
        catalog = await PgSessionCatalog.create(env.store, cmsSchema);
        await catalog.initialize();
        const rawStore = catalog.workflowStore();
        const store = wrapStore ? wrapStore(rawStore) : rawStore;
        pool = new pg.Pool(buildPgPoolConfig({ connectionString: env.store }));
        const q = async (sql, params = []) => (await pool.query(sql.replaceAll("SCHEMA", `"${cmsSchema}"`), params)).rows;

        runtime = new Runtime(provider, {
            orchestrationConcurrency: 8,
            workerConcurrency: 8,
            dispatcherPollIntervalMs: 20,
            workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
            logLevel: "error",
        });

        const agentSpawns = [];
        runtime.registerActivity(MARK_AGENT_ENDED, async (_ctx, args) => {
            await q(
                "UPDATE SCHEMA.sessions SET state = $2, updated_at = now() WHERE session_id = $1 AND deleted_at IS NULL",
                [args.sessionId, args.state],
            );
            return { ok: true };
        });
        runtime.registerOrchestrationVersioned(FAKE_AGENT_CHILD, "1.0.0", fakeAgentChild);
        runtime.registerOrchestration(OWNER_STAND_IN, function* (ctx) {
            yield ctx.waitForEvent("end");
            return null;
        });

        const host = { catalog, store, duroxideClient: client, scripts: true };
        const baseQueue = { ...sessionQueueTransport(client), version: async () => "1.0.83" };
        registerWorkflow(runtime, {
            store,
            catalog,
            enabled: () => true,
            resolveToolBinding: async () => null,
            openToolExecutor: async () => ({ call: async () => { throw new Error("no tools"); }, close: async () => {} }),
            authorizeParentNotification: async () => true,
            notifyParent: async () => ({ delivered: true }),
            deleteSession: async (id) => { await catalog.softDeleteSession(id); },
            wakeBackstopMs: 200,
            testPollMs: 50,
            sessionQueue: baseQueue,
            respondToolAvailable: async () => true,
            spawnChildHost: () => host,
            agentNodes: {
                async spawn(req) {
                    agentSpawns.push(req);
                    const instanceId = `session-${req.childSessionId}`;
                    if ((await client.getStatus(instanceId)).status === "NotFound") {
                        await catalog.createSession(req.childSessionId, {
                            parentSessionId: req.workflowSessionId,
                            owner: OWNER,
                        }).catch(() => {});
                        await client.startOrchestrationVersioned(
                            instanceId,
                            FAKE_AGENT_CHILD,
                            { childSessionId: req.childSessionId },
                            "1.0.0",
                        );
                    }
                    await client.enqueueEvent(instanceId, "messages", JSON.stringify({ prompt: req.prompt }));
                    return { spawned: true, used: { model: "mock:test" } };
                },
            },
        });
        await runtime.start();
        runtimeStarted = true;

        const createLiveOwner = async () => {
            const ownerId = randomUUID();
            await catalog.createSession(ownerId, { owner: OWNER });
            await client.startOrchestration(`session-${ownerId}`, OWNER_STAND_IN, {});
            await until(`owner ${ownerId} running`, async () => (await client.getStatus(`session-${ownerId}`)).status === "Running");
            return ownerId;
        };

        const saveDefs = async (ownerId, defs) => {
            const ids = {};
            for (const [name, yaml] of defs) {
                const saved = await saveSessionWorkflowDefinition(host, {
                    ownerSessionId: ownerId, name, yaml, expected: null,
                    actor: { kind: "session", sessionId: ownerId }, operationId: `save-${name}-${randomUUID()}`, by: "session",
                });
                expect(saved.receipt.valid, `${name}: ${JSON.stringify(saved.receipt.diagnostics)}`).toBe(true);
                ids[name] = saved.receipt.definitionId;
            }
            return ids;
        };

        const waitRunStatus = (runId, statuses, timeoutMs = 60_000) =>
            until(`run ${runId} in [${statuses.join(",")}]`, async () => {
                const run = await rawStore.readRun(runId);
                return run && statuses.includes(run.status) ? run : null;
            }, timeoutMs);

        const waitRunTerminal = (runId, timeoutMs = 60_000) => waitRunStatus(runId, [...TERMINAL_RUN], timeoutMs);

        const waitChildren = (wfId, count, timeoutMs = 45_000) =>
            until(`${count} children under ${wfId}`, async () => {
                const list = await rawStore.listChildWorkflows(wfId);
                return list.length >= count && list.every(c => c.runId) ? list : null;
            }, timeoutMs);

        const waitBusyChildLive = (childRunId, timeoutMs = 45_000) =>
            until(`busy-child ${childRunId} 4 resources live`, async () => {
                const nodes = await q(
                    `SELECT node_id, state FROM SCHEMA.workflow_node_executions
                      WHERE run_id = $1 AND node_id = ANY($2::text[])`,
                    [childRunId, ["wait_step", "recv_step", "appr_step", "req_step"]],
                );
                if (nodes.length < 4 || !nodes.every(n => n.state === "pending")) return null;
                const appr = await q("SELECT node_execution_id FROM SCHEMA.workflow_approvals WHERE run_id = $1 AND decision IS NULL", [childRunId]);
                if (appr.length < 1) return null;
                const req = await q("SELECT exchange_id FROM SCHEMA.workflow_requests WHERE run_id = $1", [childRunId]);
                if (req.length < 1) return null;
                const outbox = await q("SELECT state FROM SCHEMA.workflow_outbox WHERE run_id = $1 AND mode = 'request'", [childRunId]);
                if (outbox.length < 1 || outbox[0].state !== "delivered") return null;
                return { nodes: nodes.length, approvals: appr.length, requests: req.length, outbox: outbox[0].state };
            }, timeoutMs);

        const waitTreeSettled = (ownerId, { liveOwner = true, graceMs = 0, timeoutMs = 45_000 } = {}) =>
            until(`tree ${ownerId} settled`, async () => {
                const snap = await census({
                    store: rawStore,
                    catalog,
                    duroxideClient: client,
                    rootSessionIds: [ownerId],
                    graceMs,
                    liveOwnerSessionIds: liveOwner ? [ownerId] : [],
                });
                const liveBad = Object.entries(snap.categories).filter(([k, v]) => k !== "sessions_not_swept" && v.count > 0);
                return liveBad.length === 0 ? snap : null;
            }, timeoutMs);

        const endOwnerAndSweep = async (ownerId) => {
            try { await client.raiseEvent(`session-${ownerId}`, "end", {}); } catch {}
            await until(`owner ${ownerId} terminal`, async () => TERMINAL_ORCH.has((await client.getStatus(`session-${ownerId}`)).status));
            await q("UPDATE SCHEMA.sessions SET state = 'completed', updated_at = now() - interval '1 second' WHERE session_id = $1 AND deleted_at IS NULL", [ownerId]);
            await waitTreeSettled(ownerId, { liveOwner: false });
            return sweepOwnerTree({ store: rawStore, catalog, duroxideClient: client, q, ownerId });
        };

        return {
            client, catalog, store: rawStore, wrappedStore: store, pool, runtime, host, cmsSchema, agentSpawns,
            q, createLiveOwner, saveDefs, waitRunStatus, waitRunTerminal, waitChildren, waitBusyChildLive, waitTreeSettled, endOwnerAndSweep,
            stop: cleanupPartial,
        };
    } catch (error) {
        await cleanupPartial();
        throw error;
    }
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("I7 Re-run resource-leak census suite (S1–S15, PG16 & HorizonDB)", () => {
    describe("S1–S5: spawn cut-back, async wind-down, continue notice, agent supply, post-claim refusal", () => {
        let h;
        let postClaimDeleteSourceId = null;
        let lastClaimedWorkflowSessionId = null;

        beforeAll(async () => {
            h = await startRuntimeHarness(getEnv(), {
                wrapStore: raw => new Proxy(raw, {
                    get(target, prop) {
                        if (prop === "createDefinition") {
                            return async (input) => {
                                if (postClaimDeleteSourceId) {
                                    const victim = postClaimDeleteSourceId;
                                    postClaimDeleteSourceId = null;
                                    lastClaimedWorkflowSessionId = input.workflowSessionId;
                                    await h.catalog.softDeleteSession(victim);
                                }
                                return target.createDefinition(input);
                            };
                        }
                        const value = target[prop];
                        return typeof value === "function" ? value.bind(target) : value;
                    },
                }),
            });
        }, TIMEOUT);

        afterAll(async () => {
            if (h) await h.stop();
        }, TIMEOUT);

        it("S1: G-R1 auto-pick cut-back with live 4-resource busy child (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["busy-child", BUSY_CHILD_YAML],
                ["parent-spawn-gate", PARENT_SPAWN_GATE_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const r2 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-spawn-gate" },
                    inputs: { responder: ownerId }, vars: { failGate: true },
                    actor: ENGINE, operationId: `s1-r2-${i}`, owner: OWNER,
                });
                const [child2] = await h.waitChildren(r2.workflowId, 1);
                await h.waitBusyChildLive(child2.runId);
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: r2.workflowId, senderSessionId: ownerId,
                    contract: "Go@1", payload: { i }, operationId: `s1-r2-go-${i}`,
                });
                expect((await h.waitRunTerminal(r2.runId)).status).toBe("failed");
                expect((await h.waitRunTerminal(child2.runId)).status).toBe("cancelled");

                // Auto-pick re-run (executionId omitted) MUST cut back from `gate` across `launch` (G-R1).
                const r3 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-spawn-gate" },
                    vars: { failGate: false },
                    rerunFrom: { workflowId: r2.workflowId },
                    actor: ENGINE, operationId: `s1-r3-${i}`, owner: OWNER,
                });
                const r3Row = await h.store.readRun(r3.runId);
                expect(r3Row?.rerunResume?.fromStateId).toBe("launch");

                const [child3] = await h.waitChildren(r3.workflowId, 1);
                expect(child3.workflowSessionId).not.toBe(child2.workflowSessionId);
                await h.waitBusyChildLive(child3.runId);
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: r3.workflowId, senderSessionId: ownerId,
                    contract: "Go@1", payload: { i }, operationId: `s1-r3-go-${i}`,
                });
                expect((await h.waitRunTerminal(r3.runId)).status).toBe("completed");
                expect((await h.waitRunTerminal(child3.runId)).status).toBe("cancelled");

                const liveSnap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(liveSnap, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("S2: G-R2 spawn re-run started immediately while old busy child winds down asynchronously (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["busy-child", BUSY_CHILD_YAML],
                ["parent-spawn-gate", PARENT_SPAWN_GATE_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const r2 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-spawn-gate" },
                    inputs: { responder: ownerId }, vars: { failGate: true },
                    actor: ENGINE, operationId: `s2-r2-${i}`, owner: OWNER,
                });
                const [child2] = await h.waitChildren(r2.workflowId, 1);
                await h.waitBusyChildLive(child2.runId);
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: r2.workflowId, senderSessionId: ownerId,
                    contract: "Go@1", payload: { i }, operationId: `s2-r2-go-${i}`,
                });
                expect((await h.waitRunTerminal(r2.runId)).status).toBe("failed");

                // Do NOT wait for child2 to settle before starting #3 from `launch` (G-R2).
                const r2Nodes = await h.store.listNodeExecutions(r2.runId);
                const launchVisit = r2Nodes.find(n => n.nodeId === "launch");
                expect(launchVisit).toBeTruthy();

                const r3 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-spawn-gate" },
                    vars: { failGate: false },
                    rerunFrom: { workflowId: r2.workflowId, executionId: launchVisit.nodeExecutionId, mode: "run_again" },
                    actor: ENGINE, operationId: `s2-r3-${i}`, owner: OWNER,
                });
                const [child3] = await h.waitChildren(r3.workflowId, 1);
                expect(child3.workflowSessionId).not.toBe(child2.workflowSessionId);
                await h.waitBusyChildLive(child3.runId);
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: r3.workflowId, senderSessionId: ownerId,
                    contract: "Go@1", payload: { i }, operationId: `s2-r3-go-${i}`,
                });
                expect((await h.waitRunTerminal(r3.runId)).status).toBe("completed");
                expect((await h.waitRunTerminal(child2.runId)).status).toBe("cancelled");
                expect((await h.waitRunTerminal(child3.runId)).status).toBe("cancelled");

                const liveSnap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(liveSnap, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("S3: `continue` mode consuming carried WorkflowEnded@1 child notice with zero new child spawns (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["quick-child", QUICK_CHILD_YAML],
                ["parent-continue-notice", PARENT_CONTINUE_NOTICE_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const r2 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-continue-notice" },
                    inputs: {}, vars: { failAfterPrep: true },
                    actor: ENGINE, operationId: `s3-r2-${i}`, owner: OWNER,
                });
                const [child2] = await h.waitChildren(r2.workflowId, 1);
                expect((await h.waitRunTerminal(child2.runId)).status).toBe("completed");
                // Wait until WorkflowEnded@1 notice has arrived in #2's inbox (unconsumed) before releasing `prep`.
                await until(`WorkflowEnded@1 in #2 inbox (${i})`, async () => {
                    const rows = await h.q(
                        "SELECT message_id FROM SCHEMA.workflow_inbox WHERE run_id = $1 AND contract = 'WorkflowEnded@1' AND consumed_by IS NULL",
                        [r2.runId],
                    );
                    return rows.length === 1;
                });
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: r2.workflowId, senderSessionId: ownerId,
                    contract: "Go@1", payload: { i }, operationId: `s3-r2-go-${i}`,
                });
                expect((await h.waitRunTerminal(r2.runId)).status).toBe("failed");

                const r2Nodes = await h.store.listNodeExecutions(r2.runId);
                const prepVisit = r2Nodes.find(n => n.nodeId === "prep");
                expect(prepVisit?.state).toBe("completed");

                const r3 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-continue-notice" },
                    vars: { failAfterPrep: false },
                    rerunFrom: { workflowId: r2.workflowId, executionId: prepVisit.nodeExecutionId, mode: "continue" },
                    actor: ENGINE, operationId: `s3-r3-${i}`, owner: OWNER,
                });
                const r3Done = await h.waitRunTerminal(r3.runId);
                expect(r3Done.status).toBe("completed");
                expect(r3Done.terminalOutcome).toBe("succeeded");
                expect(r3Done.terminalOutput?.continued).toBe(true);
                expect(r3Done.terminalOutput?.notice?.workflowId).toBe(child2.workflowSessionId);
                expect(r3Done.terminalOutput?.notice?.output?.tag).toBe("notice-child");
                // Neither `launch` nor `prep` re-ran; zero new child workflows spawned under #3.
                expect(await h.store.listChildWorkflows(r3.workflowId)).toEqual([]);
                const r3Nodes = await h.store.listNodeExecutions(r3.runId);
                expect(r3Nodes.find(n => n.nodeId === "launch")?.reusedFromExecutionId).toBeTruthy();
                expect(r3Nodes.find(n => n.nodeId === "prep")?.reusedFromExecutionId).toBeTruthy();
                expect(r3Nodes.find(n => n.nodeId === "await_child")?.reusedFromExecutionId).toBeNull();

                const liveSnap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(liveSnap, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("S4: `supply` on timed-out agent step ends #2 agent session cleanly and spawns 0 agents in #3 (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [["agent-supply", AGENT_SUPPLY_YAML]]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const spawnsBeforeR2 = h.agentSpawns.length;
                const r2 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "agent-supply" },
                    inputs: {}, actor: ENGINE, operationId: `s4-r2-${i}`, owner: OWNER,
                });
                expect((await h.waitRunTerminal(r2.runId)).status).toBe("failed");
                expect(h.agentSpawns.length).toBeGreaterThan(spawnsBeforeR2);

                const afterR2Snap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(afterR2Snap, { allow: ["sessions_not_swept"] });

                const r2Nodes = await h.store.listNodeExecutions(r2.runId);
                const agentVisit = r2Nodes.find(n => n.nodeId === "work_agent");
                expect(agentVisit?.outcome).toBe("timed_out");

                const spawnsBeforeR3 = h.agentSpawns.length;
                const r3 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "agent-supply" },
                    rerunFrom: {
                        workflowId: r2.workflowId,
                        executionId: agentVisit.nodeExecutionId,
                        mode: "supply",
                        result: { outcome: "completed", output: { answer: `supplied-${i}` } },
                        note: `S4 manual supply iteration ${i}`,
                    },
                    actor: ENGINE, operationId: `s4-r3-${i}`, owner: OWNER,
                });
                const r3Done = await h.waitRunTerminal(r3.runId);
                expect(r3Done.status).toBe("completed");
                expect(r3Done.terminalOutput).toEqual({ got: `supplied-${i}` });
                expect(h.agentSpawns.length).toBe(spawnsBeforeR3);

                const liveSnap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(liveSnap, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("S5: post-claim refusals immediately soft-delete claim shell before any Sweeper runs (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["slow-live", SLOW_LIVE_YAML],
                ["three-step", THREE_STEP_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                // 5a. Pre-claim refusal against active run -> 0 shells left.
                const live = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "slow-live" },
                    inputs: {}, actor: ENGINE, operationId: `s5-live-${i}`, owner: OWNER,
                });
                await h.waitRunStatus(live.runId, ["running"]);
                await expect(startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "slow-live" },
                    rerunFrom: { workflowId: live.workflowId },
                    actor: ENGINE, operationId: `s5-pre-refuse-${i}`, owner: OWNER,
                })).rejects.toThrow();
                await controlWorkflowRun(h.host, live.workflowId, { operation: "cancel", reason: null }, {
                    actor: ENGINE, operationId: `s5-live-cancel-${i}`,
                });
                expect((await h.waitRunTerminal(live.runId)).status).toBe("cancelled");

                // 5b. Genuine post-claim refusal: source #2 is soft-deleted AFTER claim shell is created
                // and right before createDefinition -> RERUN_SOURCE_GONE -> claim shell soft-deleted immediately!
                const r2 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "three-step" },
                    inputs: {}, vars: { failAt: 3 },
                    actor: ENGINE, operationId: `s5-r2-${i}`, owner: OWNER,
                });
                expect((await h.waitRunTerminal(r2.runId)).status).toBe("failed");

                lastClaimedWorkflowSessionId = null;
                postClaimDeleteSourceId = r2.workflowId;
                await expect(startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "three-step" },
                    vars: { failAt: 0 },
                    rerunFrom: { workflowId: r2.workflowId },
                    actor: ENGINE, operationId: `s5-post-refuse-${i}`, owner: OWNER,
                })).rejects.toMatchObject({ code: "RERUN_SOURCE_GONE" });

                expect(lastClaimedWorkflowSessionId).toBeTruthy();
                const shellRows = await h.q(
                    "SELECT session_id, deleted_at FROM SCHEMA.sessions WHERE session_id = $1",
                    [lastClaimedWorkflowSessionId],
                );
                expect(shellRows).toHaveLength(1);
                expect(shellRows[0].deleted_at).not.toBeNull();

                // Verify claim_shells === 0 immediately, WITHOUT running Sweeper.
                const snap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                expect(snap.categories.claim_shells).toEqual({ count: 0, ids: [] });
                assertNoLeaks(snap, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });
    });

    describe("S6–S10: crash shells, retry reuse, rerun_diverged, multi-gen chain, standalone child re-run", () => {
        let h;
        let failNextCreateDefAndStart = false;
        let capturedCrashShellId = null;

        beforeAll(async () => {
            h = await startRuntimeHarness(getEnv(), {
                wrapStore: raw => new Proxy(raw, {
                    get(target, prop) {
                        if (prop === "createDefinition") {
                            return async (input) => {
                                if (failNextCreateDefAndStart) {
                                    failNextCreateDefAndStart = false;
                                    capturedCrashShellId = input.workflowSessionId;
                                    throw new Error("simulated-post-claim-crash");
                                }
                                return target.createDefinition(input);
                            };
                        }
                        const value = target[prop];
                        return typeof value === "function" ? value.bind(target) : value;
                    },
                }),
            });
        }, TIMEOUT);

        afterAll(async () => {
            if (h) await h.stop();
        }, TIMEOUT);

        it("S6: unretried claim crash while owner stays live — Sweeper collects bare claim shell after grace (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [["three-step", THREE_STEP_YAML]]);
            const sweeperTools = createSweeperTools({ catalog: h.catalog, duroxideClient: h.client, factStore: null });
            const scan = sweeperTools.find(t => t.name === "scan_completed_sessions");
            const cleanup = sweeperTools.find(t => t.name === "cleanup_session");

            for (let i = 1; i <= ITERATIONS; i += 1) {
                const r2 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "three-step" },
                    inputs: {}, vars: { failAt: 3 },
                    actor: ENGINE, operationId: `s6-r2-${i}`, owner: OWNER,
                });
                expect((await h.waitRunTerminal(r2.runId)).status).toBe("failed");

                // Simulate crash right after claim shell creation -> leaves bare no-run, no-def, NotFound shell.
                capturedCrashShellId = null;
                failNextCreateDefAndStart = true;
                await expect(startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "three-step" },
                    vars: { failAt: 0 }, rerunFrom: { workflowId: r2.workflowId },
                    actor: ENGINE, operationId: `s6-crash-${i}`, owner: OWNER,
                })).rejects.toThrow("simulated-post-claim-crash");
                expect(capturedCrashShellId).toBeTruthy();

                // Non-vacuity: census MUST report the bare claim shell while younger/uncollected.
                const preSnap = await census({
                    store: h.store, catalog: h.catalog, duroxideClient: h.client,
                    rootSessionIds: [ownerId], graceMs: 0, liveOwnerSessionIds: [ownerId],
                });
                expect(preSnap.categories.claim_shells.ids).toContain(capturedCrashShellId);

                // While younger than graceMinutes, scan_completed_sessions MUST skip it.
                const earlyScan = await scan.handler({ graceMinutes: 60 });
                expect((earlyScan.sessions ?? []).map(s => s.sessionId)).not.toContain(capturedCrashShellId);

                // Age shell past grace while owner remains Running -> Sweeper collects it on its own!
                await h.q(
                    "UPDATE SCHEMA.sessions SET created_at = now() - interval '120 minutes', updated_at = now() - interval '120 minutes' WHERE session_id = $1",
                    [capturedCrashShellId],
                );
                expect((await h.client.getStatus(`session-${ownerId}`)).status).toBe("Running");

                const dueScan = await scan.handler({ graceMinutes: 5 });
                expect((dueScan.sessions ?? []).map(s => s.sessionId)).toContain(capturedCrashShellId);
                const cleaned = await cleanup.handler({
                    sessionIds: [capturedCrashShellId], graceMinutes: 5, reason: "S6 orphan claim shell",
                });
                expect(cleaned.ok).toBe(true);
                expect(cleaned.results?.find(r => r.sessionId === capturedCrashShellId)?.ok).toBe(true);

                // Owner is STILL live, and claim_shells === 0!
                expect((await h.client.getStatus(`session-${ownerId}`)).status).toBe("Running");
                const liveSnap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                expect(liveSnap.categories.claim_shells).toEqual({ count: 0, ids: [] });
                assertNoLeaks(liveSnap, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("S7: crash + retry with same operationId reuses exact 1 claim shell (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [["three-step", THREE_STEP_YAML]]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const r2 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "three-step" },
                    inputs: {}, vars: { failAt: 3 },
                    actor: ENGINE, operationId: `s7-r2-${i}`, owner: OWNER,
                });
                expect((await h.waitRunTerminal(r2.runId)).status).toBe("failed");

                const opId = `s7-retry-op-${i}-${randomUUID()}`;
                capturedCrashShellId = null;
                failNextCreateDefAndStart = true;
                await expect(startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "three-step" },
                    vars: { failAt: 0 }, rerunFrom: { workflowId: r2.workflowId },
                    actor: ENGINE, operationId: opId, owner: OWNER,
                })).rejects.toThrow("simulated-post-claim-crash");
                const firstShellId = capturedCrashShellId;
                expect(firstShellId).toBeTruthy();

                // Retry with exact same operationId -> reuses exact same shell, completes cleanly.
                const r3 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "three-step" },
                    vars: { failAt: 0 }, rerunFrom: { workflowId: r2.workflowId },
                    actor: ENGINE, operationId: opId, owner: OWNER,
                });
                expect(r3.workflowId).toBe(firstShellId);
                expect((await h.waitRunTerminal(r3.runId)).status).toBe("completed");

                const liveSnap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                expect(liveSnap.categories.claim_shells).toEqual({ count: 0, ids: [] });
                assertNoLeaks(liveSnap, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("S8: rerun_diverged = 0 post-cut work & 0 leaks (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            const defs = await h.saveDefs(ownerId, [["three-step", THREE_STEP_YAML]]);
            const defId = defs["three-step"];
            const divYaml = THREE_STEP_YAML
                .replace('version: "1.0.0"', 'version: "1.0.1"')
                .replace("initial: s1", "initial: s3");
            const savedV2 = await saveSessionWorkflowDefinition(h.host, {
                ownerSessionId: ownerId, name: "three-step", yaml: divYaml,
                expected: { definitionId: defId, revision: 1 },
                actor: { kind: "session", sessionId: ownerId },
                operationId: `s8-v2-${randomUUID()}`, by: "session",
            });
            expect(savedV2.receipt.valid).toBe(true);

            for (let i = 1; i <= ITERATIONS; i += 1) {
                const r2 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { definitionId: defId }, revision: 1,
                    inputs: {}, vars: { failAt: 3 },
                    actor: ENGINE, operationId: `s8-r2-${i}`, owner: OWNER,
                });
                expect((await h.waitRunTerminal(r2.runId)).status).toBe("failed");
                const r2Nodes = await h.store.listNodeExecutions(r2.runId);
                const s3Visit = r2Nodes.find(n => n.nodeId === "s3");

                const rDiv = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { definitionId: defId }, revision: 2,
                    inputs: {}, vars: { failAt: 0 },
                    rerunFrom: {
                        workflowId: r2.workflowId,
                        executionId: s3Visit.nodeExecutionId,
                        mode: "run_again",
                        _skipFitCheckForTest: true,
                    },
                    actor: ENGINE, operationId: `s8-div-${i}`, owner: OWNER,
                });
                const divDone = await h.waitRunTerminal(rDiv.runId);
                expect(divDone.status).toBe("failed");
                expect(divDone.terminalError?.code).toBe("rerun_diverged");
                expect(divDone.rerunResumedAt).toBeNull();
                // Assert 0 post-cut node executions were written.
                const divNodes = await h.store.listNodeExecutions(rDiv.runId);
                expect(divNodes.filter(n => n.reusedFromExecutionId === null)).toEqual([]);

                const liveSnap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(liveSnap, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("S9: multi-generation #1 -> #2 -> #3 -> #4 chain (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [["three-step", THREE_STEP_YAML]]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const g1 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "three-step" },
                    inputs: {}, vars: { failAt: 2 },
                    actor: ENGINE, operationId: `s9-g1-${i}`, owner: OWNER,
                });
                expect((await h.waitRunTerminal(g1.runId)).status).toBe("failed");

                const g2 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "three-step" },
                    vars: { failAt: 3 }, rerunFrom: { workflowId: g1.workflowId },
                    actor: ENGINE, operationId: `s9-g2-${i}`, owner: OWNER,
                });
                expect((await h.waitRunTerminal(g2.runId)).status).toBe("failed");

                const g3 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "three-step" },
                    vars: { failAt: 3 }, rerunFrom: { workflowId: g2.workflowId },
                    actor: ENGINE, operationId: `s9-g3-${i}`, owner: OWNER,
                });
                expect((await h.waitRunTerminal(g3.runId)).status).toBe("failed");

                const g4 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "three-step" },
                    vars: { failAt: 0 }, rerunFrom: { workflowId: g3.workflowId },
                    actor: ENGINE, operationId: `s9-g4-${i}`, owner: OWNER,
                });
                const g4Done = await h.waitRunTerminal(g4.runId);
                expect(g4Done.status).toBe("completed");
                expect(g4Done.terminalOutput).toEqual({ step: 3 });

                // Verify transitive original provenance on #4's reused s1 points back to #1.
                const g4Nodes = await h.store.listNodeExecutions(g4.runId);
                const s1OnG4 = g4Nodes.find(n => n.nodeId === "s1");
                expect(s1OnG4?.reusedFromWorkflowSessionId).toBe(g1.workflowId);

                const liveSnap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(liveSnap, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("S10: standalone re-run of spawned child + owner end (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["standalone-child", STANDALONE_CHILD_YAML],
                ["standalone-parent", STANDALONE_PARENT_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const parent = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "standalone-parent" },
                    inputs: {}, actor: ENGINE, operationId: `s10-parent-${i}`, owner: OWNER,
                });
                const [child] = await h.waitChildren(parent.workflowId, 1);
                expect((await h.waitRunTerminal(child.runId)).status).toBe("completed");
                expect((await h.waitRunTerminal(parent.runId)).status).toBe("completed");

                const childNodes = await h.store.listNodeExecutions(child.runId);
                const c2Visit = childNodes.find(n => n.nodeId === "c2");
                const standalone = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "standalone-child" },
                    rerunFrom: { workflowId: child.workflowSessionId, executionId: c2Visit.nodeExecutionId, mode: "run_again" },
                    actor: ENGINE, operationId: `s10-standalone-${i}`, owner: OWNER,
                });
                const standaloneDone = await h.waitRunTerminal(standalone.runId);
                expect(standaloneDone.status).toBe("completed");
                const standaloneSession = await h.catalog.getSession(standalone.workflowId);
                expect(standaloneSession?.parentSessionId).toBe(ownerId);

                const liveSnap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(liveSnap, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });
    });

    describe("S11–S15: parallel lane cut-back, pass-over control, parent-end fault injection, live deletion, inbox TTL", () => {
        let h;
        let pendingPassOverControl = null; // { command, opId, fired, firedRunId }
        let s13FaultEnabled = false;
        const s13FailOnce = new Set();
        let s13InjectedFailures = 0;
        let s13CancelAttempts = 0;

        beforeAll(async () => {
            h = await startRuntimeHarness(getEnv(), {
                wrapStore: raw => new Proxy(raw, {
                    get(target, prop) {
                        if (prop === "readNodeExecution") {
                            return async (nodeExecutionId) => {
                                const row = await target.readNodeExecution(nodeExecutionId);
                                if (pendingPassOverControl && !pendingPassOverControl.fired && row && row.reusedFromExecutionId !== null && row.nodeId === "s1") {
                                    const hook = pendingPassOverControl;
                                    hook.fired = true;
                                    hook.firedRunId = row.runId;
                                    const run = await target.readRun(row.runId);
                                    if (run) {
                                        await controlWorkflowRun(h.host, run.workflowSessionId, hook.command, {
                                            actor: ENGINE, operationId: hook.opId,
                                        });
                                    }
                                }
                                return row;
                            };
                        }
                        if (prop === "recordSessionCommand") {
                            return async (input) => {
                                if (s13FaultEnabled && input.command === "cancel" && typeof input.operationId === "string" && input.operationId.startsWith("parent-end:")) {
                                    s13CancelAttempts += 1;
                                    const key = `${input.workflowSessionId}:${input.operationId}`;
                                    if (!s13FailOnce.has(key)) {
                                        s13FailOnce.add(key);
                                        s13InjectedFailures += 1;
                                        throw new Error("injected transient parent-end cancel failure");
                                    }
                                }
                                return target.recordSessionCommand(input);
                            };
                        }
                        const value = target[prop];
                        return typeof value === "function" ? value.bind(target) : value;
                    },
                }),
            });
        }, TIMEOUT);

        afterAll(async () => {
            if (h) await h.stop();
        }, TIMEOUT);

        it("S11: parallel lane child spawns — G-R1 lane cut-back + full parallel re-run (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["busy-child", BUSY_CHILD_YAML],
                ["parallel-spawn", PARALLEL_SPAWN_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const r2 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parallel-spawn" },
                    inputs: { responder: ownerId }, vars: { failPost: true },
                    actor: ENGINE, operationId: `s11-r2-${i}`, owner: OWNER,
                });
                const r2Children = await h.waitChildren(r2.workflowId, 2);
                for (const ch of r2Children) await h.waitBusyChildLive(ch.runId);
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: r2.workflowId, senderSessionId: ownerId,
                    contract: "Go@1", payload: { i }, operationId: `s11-r2-go-${i}`,
                });
                expect((await h.waitRunTerminal(r2.runId)).status).toBe("failed");
                for (const ch of r2Children) expect((await h.waitRunTerminal(ch.runId)).status).toBe("cancelled");

                // Auto-pick cuts back across `fan` (G-R1) because both lane children ended cancelled.
                const r3 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parallel-spawn" },
                    vars: { failPost: false }, rerunFrom: { workflowId: r2.workflowId },
                    actor: ENGINE, operationId: `s11-r3-${i}`, owner: OWNER,
                });
                const r3Row = await h.store.readRun(r3.runId);
                expect(r3Row?.rerunResume?.fromStateId).toBe("fan");

                const r3Children = await h.waitChildren(r3.workflowId, 2);
                const r2ChildIds = new Set(r2Children.map(c => c.workflowSessionId));
                for (const ch of r3Children) {
                    expect(r2ChildIds.has(ch.workflowSessionId)).toBe(false);
                    await h.waitBusyChildLive(ch.runId);
                }
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: r3.workflowId, senderSessionId: ownerId,
                    contract: "Go@1", payload: { i }, operationId: `s11-r3-go-${i}`,
                });
                expect((await h.waitRunTerminal(r3.runId)).status).toBe("completed");
                for (const ch of r3Children) expect((await h.waitRunTerminal(ch.runId)).status).toBe("cancelled");

                const liveSnap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(liveSnap, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("S12: pause (+ resume), stop (grace 0), and cancel during pass-over (all 3 modes x 3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [["three-step", THREE_STEP_YAML]]);

            const r2 = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: ownerId, definition: { name: "three-step" },
                inputs: {}, vars: { failAt: 3 },
                actor: ENGINE, operationId: `s12-src-${randomUUID()}`, owner: OWNER,
            });
            expect((await h.waitRunTerminal(r2.runId)).status).toBe("failed");

            try {
                for (let i = 1; i <= ITERATIONS; i += 1) {
                    // 12a. PAUSE during pass-over -> pauses before cut (0 post-cut nodes), then RESUME -> completed.
                    pendingPassOverControl = { command: { operation: "pause", reason: null }, opId: `s12-pause-cmd-${i}`, fired: false, firedRunId: null };
                    const pRun = await startSessionWorkflowDefinition(h.host, {
                        ownerSessionId: ownerId, definition: { name: "three-step" },
                        vars: { failAt: 0 }, rerunFrom: { workflowId: r2.workflowId },
                        actor: ENGINE, operationId: `s12-pause-${i}`, owner: OWNER,
                    });
                    const pausedRow = await h.waitRunStatus(pRun.runId, ["paused"]);
                    expect(pendingPassOverControl.fired).toBe(true);
                    expect(pendingPassOverControl.firedRunId).toBe(pRun.runId);
                    expect(pausedRow.rerunResumedAt).toBeNull();
                    expect((await h.store.listNodeExecutions(pRun.runId)).filter(n => n.reusedFromExecutionId === null)).toEqual([]);
                    pendingPassOverControl = null;

                    await controlWorkflowRun(h.host, pRun.workflowId, { operation: "resume", reason: null }, {
                        actor: ENGINE, operationId: `s12-resume-cmd-${i}`,
                    });
                    const resumedRow = await h.waitRunTerminal(pRun.runId);
                    expect(resumedRow.status).toBe("completed");
                    expect(resumedRow.rerunResumedAt).not.toBeNull();

                    // 12b. STOP (graceSeconds: 0) during pass-over -> stopped with 0 post-cut nodes.
                    pendingPassOverControl = { command: { operation: "stop", graceSeconds: 0, reason: null }, opId: `s12-stop-cmd-${i}`, fired: false, firedRunId: null };
                    const sRun = await startSessionWorkflowDefinition(h.host, {
                        ownerSessionId: ownerId, definition: { name: "three-step" },
                        vars: { failAt: 0 }, rerunFrom: { workflowId: r2.workflowId },
                        actor: ENGINE, operationId: `s12-stop-${i}`, owner: OWNER,
                    });
                    const stoppedRow = await h.waitRunTerminal(sRun.runId);
                    expect(pendingPassOverControl.fired).toBe(true);
                    expect(pendingPassOverControl.firedRunId).toBe(sRun.runId);
                    expect(stoppedRow.status).toBe("stopped");
                    expect(stoppedRow.rerunResumedAt).toBeNull();
                    expect((await h.store.listNodeExecutions(sRun.runId)).filter(n => n.reusedFromExecutionId === null)).toEqual([]);
                    pendingPassOverControl = null;

                    // 12c. CANCEL during pass-over -> cancelled with 0 post-cut nodes.
                    pendingPassOverControl = { command: { operation: "cancel", reason: null }, opId: `s12-cancel-cmd-${i}`, fired: false, firedRunId: null };
                    const cRun = await startSessionWorkflowDefinition(h.host, {
                        ownerSessionId: ownerId, definition: { name: "three-step" },
                        vars: { failAt: 0 }, rerunFrom: { workflowId: r2.workflowId },
                        actor: ENGINE, operationId: `s12-cancel-${i}`, owner: OWNER,
                    });
                    const cancelledRow = await h.waitRunTerminal(cRun.runId);
                    expect(pendingPassOverControl.fired).toBe(true);
                    expect(pendingPassOverControl.firedRunId).toBe(cRun.runId);
                    expect(cancelledRow.status).toBe("cancelled");
                    expect(cancelledRow.rerunResumedAt).toBeNull();
                    expect((await h.store.listNodeExecutions(cRun.runId)).filter(n => n.reusedFromExecutionId === null)).toEqual([]);
                    pendingPassOverControl = null;

                    const liveSnap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                    assertNoLeaks(liveSnap, { allow: ["sessions_not_swept"] });
                }
            } finally {
                pendingPassOverControl = null;
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("S13: fault-injected transient failure on parent-end cancel retried to terminal (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["busy-child", BUSY_CHILD_YAML],
                ["parent-spawn-gate", PARENT_SPAWN_GATE_YAML],
            ]);
            const beforeFailures = s13InjectedFailures;
            const beforeAttempts = s13CancelAttempts;
            s13FaultEnabled = true;
            try {
                for (let i = 1; i <= ITERATIONS; i += 1) {
                    const r2 = await startSessionWorkflowDefinition(h.host, {
                        ownerSessionId: ownerId, definition: { name: "parent-spawn-gate" },
                        inputs: { responder: ownerId }, vars: { failGate: true },
                        actor: ENGINE, operationId: `s13-r2-${i}`, owner: OWNER,
                    });
                    const [child2] = await h.waitChildren(r2.workflowId, 1);
                    await h.waitBusyChildLive(child2.runId);
                    await sendTypedWorkflowInput(h.host, {
                        workflowSessionId: r2.workflowId, senderSessionId: ownerId,
                        contract: "Go@1", payload: { i }, operationId: `s13-r2-go-${i}`,
                    });
                    expect((await h.waitRunTerminal(r2.runId)).status).toBe("failed");
                    expect((await h.waitRunTerminal(child2.runId)).status).toBe("cancelled");

                    const r3 = await startSessionWorkflowDefinition(h.host, {
                        ownerSessionId: ownerId, definition: { name: "parent-spawn-gate" },
                        vars: { failGate: false }, rerunFrom: { workflowId: r2.workflowId },
                        actor: ENGINE, operationId: `s13-r3-${i}`, owner: OWNER,
                    });
                    const [child3] = await h.waitChildren(r3.workflowId, 1);
                    await h.waitBusyChildLive(child3.runId);
                    await sendTypedWorkflowInput(h.host, {
                        workflowSessionId: r3.workflowId, senderSessionId: ownerId,
                        contract: "Go@1", payload: { i }, operationId: `s13-r3-go-${i}`,
                    });
                    expect((await h.waitRunTerminal(r3.runId)).status).toBe("completed");
                    expect((await h.waitRunTerminal(child3.runId)).status).toBe("cancelled");

                    const liveSnap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                    assertNoLeaks(liveSnap, { allow: ["sessions_not_swept"] });
                }
            } finally {
                s13FaultEnabled = false;
            }
            // Non-vacuity: every parent-end cancel hit the injected failure once and retried to success.
            const deltaFailures = s13InjectedFailures - beforeFailures;
            const deltaAttempts = s13CancelAttempts - beforeAttempts;
            expect(deltaFailures).toBeGreaterThanOrEqual(ITERATIONS * 2);
            expect(deltaAttempts).toBeGreaterThanOrEqual(deltaFailures * 2);

            await h.endOwnerAndSweep(ownerId);
        });

        it("S14: #2 deleted while #3 runs; #3 completes and #4 re-runs cleanly from #3 (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["busy-child", BUSY_CHILD_YAML],
                ["parent-spawn-gate", PARENT_SPAWN_GATE_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const r2 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-spawn-gate" },
                    inputs: { responder: ownerId }, vars: { failGate: true },
                    actor: ENGINE, operationId: `s14-r2-${i}`, owner: OWNER,
                });
                const [child2] = await h.waitChildren(r2.workflowId, 1);
                await h.waitBusyChildLive(child2.runId);
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: r2.workflowId, senderSessionId: ownerId,
                    contract: "Go@1", payload: { i }, operationId: `s14-r2-go-${i}`,
                });
                expect((await h.waitRunTerminal(r2.runId)).status).toBe("failed");
                expect((await h.waitRunTerminal(child2.runId)).status).toBe("cancelled");

                // Start #3 (waits on Go@1, so it is actively running while we soft-delete #2).
                const r3 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-spawn-gate" },
                    vars: { failGate: false }, rerunFrom: { workflowId: r2.workflowId },
                    actor: ENGINE, operationId: `s14-r3-${i}`, owner: OWNER,
                });
                const [child3] = await h.waitChildren(r3.workflowId, 1);
                await h.waitBusyChildLive(child3.runId);
                expect((await h.store.readRun(r3.runId))?.status).toBe("running");

                // Delete #2 while #3 is actively running!
                await h.catalog.softDeleteSession(r2.workflowId);
                expect((await h.store.readRun(r3.runId))?.status).toBe("running");

                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: r3.workflowId, senderSessionId: ownerId,
                    contract: "Go@1", payload: { i }, operationId: `s14-r3-go-${i}`,
                });
                expect((await h.waitRunTerminal(r3.runId)).status).toBe("completed");
                expect((await h.waitRunTerminal(child3.runId)).status).toBe("cancelled");

                // #4 can still re-run cleanly from #3 even though #2 is deleted.
                const r3Nodes = await h.store.listNodeExecutions(r3.runId);
                const r3Launch = r3Nodes.find(n => n.nodeId === "launch");
                const r4 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-spawn-gate" },
                    vars: { failGate: false },
                    rerunFrom: { workflowId: r3.workflowId, executionId: r3Launch.nodeExecutionId, mode: "run_again" },
                    actor: ENGINE, operationId: `s14-r4-${i}`, owner: OWNER,
                });
                const [child4] = await h.waitChildren(r4.workflowId, 1);
                await h.waitBusyChildLive(child4.runId);
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: r4.workflowId, senderSessionId: ownerId,
                    contract: "Go@1", payload: { i }, operationId: `s14-r4-go-${i}`,
                });
                expect((await h.waitRunTerminal(r4.runId)).status).toBe("completed");
                expect((await h.waitRunTerminal(child4.runId)).status).toBe("cancelled");

                const liveSnap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(liveSnap, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("S15: unconsumed carried inbox messages in #3 — listOpenInbox omits ended run, direct SQL proves finite expires_at & TTL expiry (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [["inbox-ttl", INBOX_TTL_YAML]]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const i2 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "inbox-ttl" },
                    inputs: {}, vars: { failS3: true },
                    actor: ENGINE, operationId: `s15-i2-${i}`, owner: OWNER,
                });
                await h.waitRunStatus(i2.runId, ["running"]);

                // Enqueue BOTH Note@1 messages BEFORE releasing `s1` (Start@1) so msg2.accepted_at <= s2.completedAt is guaranteed!
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: i2.workflowId, senderSessionId: ownerId,
                    contract: "Note@1", payload: { n: 1 }, operationId: `s15-msg1-${i}`, ttlSeconds: 60,
                });
                const msg2TtlSeconds = testTime.scale > 1 ? 20 : 5;
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: i2.workflowId, senderSessionId: ownerId,
                    contract: "Note@1", payload: { n: 2 }, operationId: `s15-msg2-${i}`, ttlSeconds: msg2TtlSeconds,
                });
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: i2.workflowId, senderSessionId: ownerId,
                    contract: "Start@1", payload: { i }, operationId: `s15-start-${i}`, ttlSeconds: 60,
                });
                expect((await h.waitRunTerminal(i2.runId)).status).toBe("failed");

                const i2Nodes = await h.store.listNodeExecutions(i2.runId);
                const s3Visit = i2Nodes.find(n => n.nodeId === "s3");
                const i3 = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "inbox-ttl" },
                    vars: { failS3: false },
                    rerunFrom: { workflowId: i2.workflowId, executionId: s3Visit.nodeExecutionId, mode: "run_again" },
                    actor: ENGINE, operationId: `s15-i3-${i}`, owner: OWNER,
                });
                expect((await h.waitRunTerminal(i3.runId)).status).toBe("completed");

                // WorkflowStore.listOpenInbox omits ended runs (returns { rows: [], more: false }).
                const open = await h.store.listOpenInbox(i3.runId, 50);
                expect(open.rows).toEqual([]);

                // Direct SQL on workflow_inbox proves msg2 was carried with finite expires_at...
                const carried = await h.q(
                    `SELECT message_id, contract, expires_at, isfinite(expires_at) AS is_finite
                       FROM SCHEMA.workflow_inbox
                      WHERE run_id = $1 AND consumed_by IS NULL`,
                    [i3.runId],
                );
                expect(carried).toHaveLength(1);
                expect(carried[0].contract).toBe("Note@1");
                expect(carried[0].is_finite).toBe(true);

                // ...and expires naturally by its finite TTL (0 active unexpired rows).
                await until(`carried inbox message expires by TTL on #3 (${i})`, async () => {
                    const active = await h.q(
                        `SELECT count(*)::int AS n
                           FROM SCHEMA.workflow_inbox
                          WHERE run_id = $1 AND consumed_by IS NULL AND expires_at > now()`,
                        [i3.runId],
                    );
                    return active[0].n === 0;
                }, 20_000);

                const liveSnap = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(liveSnap, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });
    });
});
