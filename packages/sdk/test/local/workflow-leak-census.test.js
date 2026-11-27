/**
 * Baseline Workflow resource-leak census suite (B1–B11 + Sweeper/Prune + non-vacuity control).
 *
 * Verifies resource cleanup on plain Workflow runs (no re-runs) across all 8 census categories
 * (orchestrations, active runs, child workflows, agent sessions, bare claim shells, open work on
 * terminal runs, pending inbox rows on terminal runs, and unswept sessions after owner end +
 * Sweeper + prune_orchestrations).
 *
 * Known baseline leak (kept active as `it.fails` pending owner design decision for I7):
 *   - B10b / B10c: unconsumed default-TTL `workflow_inbox` rows (both direct `sendTypedWorkflowInput`
 *     and fire-and-forget child `WorkflowEnded@1` notices) remain unexpired after the target run ends
 *     and are still surfaced by `WorkflowStore.listOpenInbox()`.
 *
 * Scenarios (3 iterations each for B1–B10a):
 *   B1   Parent fails while a spawned child has pending wait, receive, approval, and delivered request
 *        (also verifies `wfx-` and `wfr-` instances were observed Completed, proving category 1 non-vacuity).
 *   B2   Parent cancelled with the same live 4-resource child.
 *   B3   Parent stopped (grace 0) with the same live 4-resource child.
 *   B4   Parent session deleted while child runs (child is also deleted).
 *   B5   Three levels: grandparent -> child -> grandchild (4-resource), grandparent fails.
 *   B6   Real PilotSwarmWorker + scripted model: (a) continued agent session (`session: continue`)
 *        live when parent ends; (b) plain agent step (`session: new`) actively stopped mid-turn
 *        (held HTTP request never released before stop; asserts `user.stop` for `workflow-cycle-stop:<nx>`
 *        and `wfa-` Completed).
 *   B7   Parallel step with two named lanes, each spawning a child; parent fails in one lane.
 *   B8   Fault injection: parent-end cancel of child fails once; controller retries and child ends.
 *   B9   Owner session ends while top-level Workflow and its child run (real owner-ended DB trigger),
 *        including a run with a pending outbox delivery when the owner ends.
 *   B10a Messages sent to a run that then ends: consumed before end, short-TTL expired, and post-end
 *        send refused with RUN_ENDED (zero inbox rows inserted).
 *   B10b (`it.fails`) Unconsumed default-TTL inbox message stays unexpired on a terminal run.
 *   B10c (`it.fails`) Fire-and-forget child completes before parent ends; unconsumed WorkflowEnded@1
 *        stays unexpired on the terminal parent run.
 *   B11  Claim-shell lifecycle + test-mode (`wft-`) bench: bare claim shell is reported in category 5,
 *        skipped by standalone Sweeper scan (`noRun`), removed immediately on parent delete, and removed
 *        by ancestor cascade when owner ends + Sweeper runs; test bench `wft-` is observed Completed and
 *        pruned by `prune_orchestrations`.
 *   Control (non-vacuity): deliberately leaked resources across all 8 categories (including pending node
 *        and awaiting_parent test interception) are caught and reported by census + assertNoLeaks.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider } from "../helpers/scripted-workers.js";
import { PilotSwarmClient, PilotSwarmWorker } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { registerWorkflow, sessionQueueTransport, workflowAgentSessionId } from "../../src/workflow/runtime.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { workflowDefinitionFromTool } from "../../src/workflow/definition-tool.ts";
import {
    applyOperatorCommandToWorkflow,
    controlWorkflowRun,
    createWorkflow,
    sendTypedWorkflowInput,
} from "../../src/workflow/service.ts";
import { updateWorkflowFromTool } from "../../src/workflow/tools.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { createSweeperTools } from "../../src/sweeper-tools.ts";
import { buildPgPoolConfig } from "../../src/pg-pool-factory.ts";
import { assertNoLeaks, census } from "../helpers/workflow-leak-census.js";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = testTime.ms(240_000);
const ITERATIONS = 3;
const OWNER = { provider: "test", subject: "leak-census-owner", displayName: "Leak Census Owner" };
const ENGINE = { kind: "system", name: "workflow-leak-census-test" };
const OWNER_STAND_IN = "leak-census-owner-standin";
const TERMINAL_ORCH = new Set(["Completed", "Failed", "Terminated", "NotFound"]);
const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "stopped"]);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(label, check, timeoutMs = 45_000) {
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

const SLEEP_CHILD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: sleep-child, version: "1.0.0" }
inputs:
  schema:
    type: object
    required: [id]
    properties:
      id: { type: integer }
    additionalProperties: false
initial: pause
states:
  pause:
    type: wait
    seconds: 300
    transition: { next: { elapsed: done } }
  done: { type: terminal, outcome: succeeded, output: { id: "\${inputs.id}" } }
`;

const PARENT_SPAWN_FAIL_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-spawn-fail, version: "1.0.0" }
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
initial: s_child
states:
  s_child:
    type: spawn
    definition: busy-child
    inputs: { responder: "\${inputs.responder}" }
    transition: { next: { started: wait_go, failure: boom } }
  wait_go:
    type: messaging
    mode: receive
    contract: Go@1
    wait: { seconds: 300 }
    transition: { next: { received: boom, elapsed: boom, failure: boom } }
  boom: { type: terminal, outcome: failed, output: { reason: "parent-failed" } }
`;

const PARENT_SPAWN_HOLD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-spawn-hold, version: "1.0.0" }
inputs:
  schema:
    type: object
    required: [responder]
    properties:
      responder: { type: string }
    additionalProperties: false
initial: s_child
states:
  s_child:
    type: spawn
    definition: busy-child
    inputs: { responder: "\${inputs.responder}" }
    transition: { next: { started: hold, failure: failed } }
  hold:
    type: wait
    seconds: 300
    transition: { next: { elapsed: done } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const GRANDPARENT_THREE_LEVEL_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: grandparent-fail, version: "1.0.0" }
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
initial: s_mid
states:
  s_mid:
    type: spawn
    definition: parent-spawn-hold
    inputs: { responder: "\${inputs.responder}" }
    transition: { next: { started: wait_go, failure: boom } }
  wait_go:
    type: messaging
    mode: receive
    contract: Go@1
    wait: { seconds: 300 }
    transition: { next: { received: boom, elapsed: boom, failure: boom } }
  boom: { type: terminal, outcome: failed, output: { reason: "grandparent-failed" } }
`;

const PARALLEL_TWO_LANES_FAIL_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parallel-two-lanes-fail, version: "1.0.0" }
schemas:
  FailLane: { type: object, additionalProperties: true }
contracts:
  FailLane@1: { schema: { $ref: "#/schemas/FailLane" } }
initial: fan
states:
  fan:
    type: parallel
    concurrency: 2
    failFast: true
    branches:
      lane_a:
        initial: a_spawn
        states:
          a_spawn:
            type: spawn
            definition: sleep-child
            inputs: { id: 1 }
            transition: { next: { started: a_wait_fail, failure: a_fail } }
          a_wait_fail:
            type: messaging
            mode: receive
            contract: FailLane@1
            wait: { seconds: 300 }
            transition: { next: { received: a_fail, elapsed: a_fail, failure: a_fail } }
          a_fail: { type: terminal, outcome: failed, output: { lane: "a" } }
      lane_b:
        initial: b_spawn
        states:
          b_spawn:
            type: spawn
            definition: sleep-child
            inputs: { id: 2 }
            transition: { next: { started: b_hold, failure: b_fail } }
          b_hold:
            type: wait
            seconds: 300
            transition: { next: { elapsed: b_done } }
          b_done: { type: terminal, outcome: succeeded }
          b_fail: { type: terminal, outcome: failed }
    transition: { next: { joined: done, blocked: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const INBOX_CONSUME_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: inbox-consume, version: "1.0.0" }
schemas:
  Ping: { type: object, additionalProperties: true }
contracts:
  Ping@1: { schema: { $ref: "#/schemas/Ping" } }
initial: recv
states:
  recv:
    type: messaging
    mode: receive
    contract: Ping@1
    wait: { seconds: 60 }
    transition: { next: { received: done, elapsed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;

const INBOX_UNCONSUMED_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: inbox-unconsumed, version: "1.0.0" }
schemas:
  Ping: { type: object, additionalProperties: true }
  Go: { type: object, additionalProperties: true }
contracts:
  Ping@1: { schema: { $ref: "#/schemas/Ping" } }
  Go@1: { schema: { $ref: "#/schemas/Go" } }
initial: wait_go
states:
  wait_go:
    type: messaging
    mode: receive
    contract: Go@1
    wait: { seconds: 60 }
    transition: { next: { received: done, elapsed: wait_ping, failure: failed } }
  wait_ping:
    type: messaging
    mode: receive
    contract: Ping@1
    wait: { seconds: 60 }
    transition: { next: { received: done, elapsed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const QUICK_CHILD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: quick-child, version: "1.0.0" }
initial: step
states:
  step:
    type: script
    source: |
      await setResult("ok", { done: true });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

const PARENT_FIRE_AND_FORGET_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-fire-and-forget, version: "1.0.0" }
schemas:
  Go: { type: object, additionalProperties: true }
contracts:
  Go@1: { schema: { $ref: "#/schemas/Go" } }
initial: spawn_quick
states:
  spawn_quick:
    type: spawn
    definition: quick-child
    inputs: {}
    transition: { next: { started: wait_go, failure: failed } }
  wait_go:
    type: messaging
    mode: receive
    contract: Go@1
    wait: { seconds: 60 }
    transition: { next: { received: done, elapsed: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const SEND_OUTBOX_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: send-outbox, version: "1.0.0" }
inputs:
  schema:
    type: object
    required: [recipient]
    properties:
      recipient: { type: string }
    additionalProperties: false
schemas:
  Note: { type: object, additionalProperties: true }
contracts:
  Note@1: { schema: { $ref: "#/schemas/Note" } }
initial: send_msg
states:
  send_msg:
    type: messaging
    mode: send
    recipient: { sessionId: "\${inputs.recipient}" }
    contract: Note@1
    input: { text: "pending-on-owner-end" }
    transition: { next: { sent: hold, failure: failed } }
  hold:
    type: wait
    seconds: 300
    transition: { next: { elapsed: done } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

/**
 * Shared Sweeper + prune_orchestrations pass for an ended owner tree.
 * Checks scan/cleanup/prune errors and refusals explicitly, asserts all 8 census categories
 * (including `sessions_not_swept`) are zero, and verifies terminal effect/session orchestrations
 * are garbage-collected (`NotFound`) after `prune_orchestrations`.
 */
async function sweepOwnerTree({ store, catalog, duroxideClient, q, ownerId, reason = "leak-census sweep" }) {
    const tools = createSweeperTools({ catalog, duroxideClient, factStore: null });
    const scan = tools.find(t => t.name === "scan_completed_sessions");
    const cleanup = tools.find(t => t.name === "cleanup_session");
    const prune = tools.find(t => t.name === "prune_orchestrations");

    for (let pass = 0; pass < 4; pass += 1) {
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
            // On HorizonDB where DB server clock can slightly lead client Date.now(), age updated_at past cutoff.
            await q(
                "UPDATE SCHEMA.sessions SET updated_at = LEAST(updated_at, $2::timestamptz) WHERE session_id = ANY($1::text[]) AND deleted_at IS NULL",
                [remaining.map(r => r.session_id), new Date(Date.now() - 5_000).toISOString()],
            );
            continue;
        }
        const cleaned = await cleanup.handler({ sessionIds: targets, graceMinutes: 0, reason });
        expect(cleaned.ok, `cleanup_session failed: ${JSON.stringify(cleaned)}`).toBe(true);
        expect(cleaned.refusedCount, `cleanup_session refused targets: ${JSON.stringify(cleaned)}`).toBe(0);
        // Batch cleanup cascade-deletes descendants when an ancestor is cleaned first, so later
        // descendants in the same batch return "Session not found"; any other failure is unexpected.
        const unexpectedFailures = (cleaned.results ?? []).filter(r => !r.ok && r.error !== "Session not found");
        expect(unexpectedFailures, `cleanup_session unexpected failures: ${JSON.stringify(cleaned)}`).toEqual([]);
    }

    // Prune terminal Duroxide orchestration histories (wfx/wfs/wfr/wfa/wfn/wfc/wft/session) as the Sweeper does.
    const pruned = await prune.handler({ deleteTerminalOlderThanMinutes: 0, keepExecutions: 1 });
    expect(pruned.ok, `prune_orchestrations failed: ${JSON.stringify(pruned)}`).toBe(true);

    const finalCensus = await census({ store, catalog, duroxideClient, rootSessionIds: [ownerId], graceMs: 0 });
    assertNoLeaks(finalCensus, { allow: [] });
    // Verify terminal orchestration histories in this tree were actually garbage-collected by prune.
    const unpruned = Object.entries(finalCensus.orchestrationStatuses)
        .filter(([, status]) => status !== "NotFound");
    expect(unpruned, `expected all pruned orchestrations to be NotFound, remaining: ${JSON.stringify(unpruned)}`).toEqual([]);
    return finalCensus;
}

// ─── Lightweight Duroxide + PG Harness (B1–B5, B7–B11, Control) ─────

async function startRuntimeHarness(env, { wrapStore = null, skipParentEndCleanup = false, wrapSessionQueue = null } = {}) {
    const tag = randomUUID().slice(0, 8);
    const duroxideSchema = `duroxide_lc_${tag}`;
    const cmsSchema = `cms_lc_${tag}`;
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
        let store = wrapStore ? wrapStore(rawStore) : rawStore;
        if (skipParentEndCleanup) {
            // Control hook: hide children from listChildWorkflows during parent-end cleanup so children leak.
            store = new Proxy(store, {
                get(target, prop) {
                    if (prop === "listChildWorkflows") return async () => [];
                    const value = target[prop];
                    return typeof value === "function" ? value.bind(target) : value;
                },
            });
        }
        pool = new pg.Pool(buildPgPoolConfig({ connectionString: env.store }));
        runtime = new Runtime(provider, {
            orchestrationConcurrency: 8,
            workerConcurrency: 8,
            dispatcherPollIntervalMs: 20,
            workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
            logLevel: "error",
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
            sessionQueue: wrapSessionQueue ? wrapSessionQueue(baseQueue) : baseQueue,
            respondToolAvailable: async () => true,
            spawnChildHost: () => host,
        });
        runtime.registerOrchestration(OWNER_STAND_IN, function* (ctx) {
            yield ctx.waitForEvent("end");
            return null;
        });
        await runtime.start();
        runtimeStarted = true;

        const q = async (sql, params = []) => (await pool.query(sql.replaceAll("SCHEMA", `"${cmsSchema}"`), params)).rows;

        const createLiveOwner = async () => {
            const ownerId = randomUUID();
            await catalog.createSession(ownerId, { owner: OWNER });
            await client.startOrchestration(`session-${ownerId}`, OWNER_STAND_IN, {});
            await until(`owner ${ownerId} running`, async () => (await client.getStatus(`session-${ownerId}`)).status === "Running");
            return ownerId;
        };

        const saveDefs = async (ownerId, defs) => {
            for (const [name, yaml] of defs) {
                const saved = await saveSessionWorkflowDefinition(host, {
                    ownerSessionId: ownerId, name, yaml, expected: null,
                    actor: { kind: "session", sessionId: ownerId }, operationId: `save-${name}`, by: "session",
                });
                expect(saved.receipt.valid, `${name}: ${JSON.stringify(saved.receipt.diagnostics)}`).toBe(true);
            }
        };

        const waitRunStatus = (runId, statuses, timeoutMs = 45_000) =>
            until(`run ${runId} in [${statuses.join(",")}]`, async () => {
                const run = await rawStore.readRun(runId);
                return run && statuses.includes(run.status) ? run : null;
            }, timeoutMs);

        const waitChildren = (wfId, count, timeoutMs = 30_000) =>
            until(`${count} children under ${wfId}`, async () => {
                const list = await rawStore.listChildWorkflows(wfId);
                return list.length >= count && list.every(c => c.runId) ? list : null;
            }, timeoutMs);

        const waitBusyChildLive = (childRunId, timeoutMs = 30_000) =>
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

        const waitTreeSettled = (ownerId, { liveOwner = true, timeoutMs = 30_000 } = {}) =>
            until(`tree ${ownerId} orchestrations settled`, async () => {
                const res = await census({
                    store: rawStore,
                    catalog,
                    duroxideClient: client,
                    rootSessionIds: [ownerId],
                    graceMs: 0,
                    liveOwnerSessionIds: liveOwner ? [ownerId] : [],
                });
                return res.categories.orchestrations_live.count === 0
                    && res.categories.runs_active.count === 0
                    && res.categories.child_workflows_active.count === 0
                    ? res : null;
            }, timeoutMs);

        const endOwnerAndSweep = async (ownerId) => {
            try { await client.raiseEvent(`session-${ownerId}`, "end", {}); } catch {}
            await until(`owner ${ownerId} terminal`, async () => TERMINAL_ORCH.has((await client.getStatus(`session-${ownerId}`)).status));
            await q("UPDATE SCHEMA.sessions SET state = 'completed', updated_at = now() - interval '1 second' WHERE session_id = $1 AND deleted_at IS NULL", [ownerId]);
            // Wait for any trigger-cancelled children to reach terminal before Sweeper runs.
            await waitTreeSettled(ownerId, { liveOwner: false });
            return sweepOwnerTree({ store: rawStore, catalog, duroxideClient: client, q, ownerId });
        };

        return {
            client, catalog, store: rawStore, wrappedStore: store, pool, runtime, host, cmsSchema,
            q, createLiveOwner, saveDefs, waitRunStatus, waitChildren, waitBusyChildLive, waitTreeSettled, endOwnerAndSweep,
            stop: cleanupPartial,
        };
    } catch (error) {
        await cleanupPartial();
        throw error;
    }
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("Workflow resource-leak census baseline (B1–B11 + Sweeper/Prune + Control)", () => {
    describe("B1–B5: parent termination & cascade modes (3x each)", () => {
        let h;
        beforeAll(async () => {
            h = await startRuntimeHarness(getEnv());
        }, TIMEOUT);
        afterAll(async () => {
            if (h) await h.stop();
        }, TIMEOUT);

        it("B1: parent fails while spawned child has pending wait, receive, approval, and delivered request (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["busy-child", BUSY_CHILD_YAML],
                ["parent-spawn-fail", PARENT_SPAWN_FAIL_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const parent = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-spawn-fail" }, inputs: { responder: ownerId },
                    actor: ENGINE, operationId: `b1-${i}`, owner: OWNER,
                });
                const [child] = await h.waitChildren(parent.workflowId, 1);
                await h.waitBusyChildLive(child.runId);
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: parent.workflowId, senderSessionId: ownerId, contract: "Go@1", payload: { i }, operationId: `b1-go-${i}`,
                });
                expect((await h.waitRunStatus(parent.runId, ["failed"])).status).toBe("failed");
                expect((await h.waitRunStatus(child.runId, ["cancelled"])).status).toBe("cancelled");
                const c = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(c, { allow: ["sessions_not_swept"] });
                // Non-vacuity of category 1: confirm real wfx- (spawn) and wfr- (request) orchestrations were observed Completed, not NotFound.
                const statuses = Object.entries(c.orchestrationStatuses);
                expect(statuses.some(([id, st]) => id.startsWith("wfx-") && st === "Completed"), JSON.stringify(statuses)).toBe(true);
                expect(statuses.some(([id, st]) => id.startsWith("wfr-") && st === "Completed"), JSON.stringify(statuses)).toBe(true);
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("B2: parent cancelled with the same live 4-resource child (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["busy-child", BUSY_CHILD_YAML],
                ["parent-spawn-hold", PARENT_SPAWN_HOLD_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const parent = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-spawn-hold" }, inputs: { responder: ownerId },
                    actor: ENGINE, operationId: `b2-${i}`, owner: OWNER,
                });
                const [child] = await h.waitChildren(parent.workflowId, 1);
                await h.waitBusyChildLive(child.runId);
                await applyOperatorCommandToWorkflow(h.host, {
                    targetSessionId: parent.workflowId, command: { type: "cmd", cmd: "cancel", id: `b2-cancel-${i}`, reason: "b2 cancel" },
                });
                expect((await h.waitRunStatus(parent.runId, ["cancelled"])).status).toBe("cancelled");
                expect((await h.waitRunStatus(child.runId, ["cancelled"])).status).toBe("cancelled");
                const c = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(c, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("B3: parent stopped (grace 0) with the same live 4-resource child (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["busy-child", BUSY_CHILD_YAML],
                ["parent-spawn-hold", PARENT_SPAWN_HOLD_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const parent = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-spawn-hold" }, inputs: { responder: ownerId },
                    actor: ENGINE, operationId: `b3-${i}`, owner: OWNER,
                });
                const [child] = await h.waitChildren(parent.workflowId, 1);
                await h.waitBusyChildLive(child.runId);
                const stopAns = JSON.parse(await updateWorkflowFromTool({
                    operation: "stop", workflow_id: parent.workflowId, operation_id: `b3-stop-${i}`, grace_seconds: 0, reason: "b3 stop",
                }, { callerSessionId: ownerId, host: h.host }));
                expect(stopAns.ok, JSON.stringify(stopAns)).toBe(true);
                expect((await h.waitRunStatus(parent.runId, ["stopped"])).status).toBe("stopped");
                expect((await h.waitRunStatus(child.runId, ["cancelled"])).status).toBe("cancelled");
                const c = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(c, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("B4: parent session deleted while child runs — child is also deleted (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["busy-child", BUSY_CHILD_YAML],
                ["parent-spawn-hold", PARENT_SPAWN_HOLD_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const parent = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-spawn-hold" }, inputs: { responder: ownerId },
                    actor: ENGINE, operationId: `b4-${i}`, owner: OWNER,
                });
                const [child] = await h.waitChildren(parent.workflowId, 1);
                await h.waitBusyChildLive(child.runId);
                await applyOperatorCommandToWorkflow(h.host, {
                    targetSessionId: parent.workflowId, command: { type: "cmd", cmd: "delete", id: `b4-del-${i}`, reason: "b4 delete" },
                });
                expect((await h.waitRunStatus(parent.runId, ["cancelled"])).status).toBe("cancelled");
                expect((await h.waitRunStatus(child.runId, ["cancelled"])).status).toBe("cancelled");
                await until(`child ${child.workflowSessionId} deleted`, async () => (await h.store.readSessionLink(child.workflowSessionId))?.deleted === true);
                const c = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(c, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });

        it("B5: three levels — grandparent -> child -> grandchild (4-resource), grandparent fails (3x)", { timeout: TIMEOUT }, async () => {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["busy-child", BUSY_CHILD_YAML],
                ["parent-spawn-hold", PARENT_SPAWN_HOLD_YAML],
                ["grandparent-fail", GRANDPARENT_THREE_LEVEL_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const gp = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "grandparent-fail" }, inputs: { responder: ownerId },
                    actor: ENGINE, operationId: `b5-${i}`, owner: OWNER,
                });
                const [mid] = await h.waitChildren(gp.workflowId, 1);
                const [grandchild] = await h.waitChildren(mid.workflowSessionId, 1);
                await h.waitBusyChildLive(grandchild.runId);
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: gp.workflowId, senderSessionId: ownerId, contract: "Go@1", payload: { i }, operationId: `b5-go-${i}`,
                });
                expect((await h.waitRunStatus(gp.runId, ["failed"])).status).toBe("failed");
                expect((await h.waitRunStatus(mid.runId, ["cancelled"])).status).toBe("cancelled");
                expect((await h.waitRunStatus(grandchild.runId, ["cancelled"])).status).toBe("cancelled");
                const c = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(c, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        });
    });

    it("B6: real worker agent steps — continued session live on parent end and plain agent step actively stopped mid-turn (3x each)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const midTurnState = { hold: false, inFlightResolvers: [], arrivedCount: 0, lastNx: null, waitForArrival: null };
        const visitOf = pos => /"nodeExecutionId":"(nx-[0-9a-f]+)"/.exec(pos.lastUserText)?.[1] ?? null;
        const isStepRequest = body => (body.tools ?? []).some(t => t.function?.name === "complete_workflow_node");
        let model = null;
        let catalog = null;
        let client = null;
        let worker = null;
        let pool = null;
        try {
            model = await startScriptedModel({
                respond: async (body, position) => {
                    if (!isStepRequest(body)) return { content: "ok" };
                    const nx = visitOf(position);
                    if (midTurnState.hold) {
                        midTurnState.arrivedCount += 1;
                        midTurnState.lastNx = nx;
                        midTurnState.waitForArrival?.();
                        midTurnState.waitForArrival = null;
                        // Hold indefinitely until finally: proves the runtime actively stops the turn mid-flight
                        // rather than waiting for the model to answer on its own.
                        await new Promise(resolve => { midTurnState.inFlightResolvers.push(resolve); });
                        return { content: "released in finally" };
                    }
                    if (position.step === 0) {
                        return {
                            tools: [{
                                name: "complete_workflow_node",
                                args: { outcome: "again", output: { cycle: 1 }, operation_id: `op-${nx}`, node_execution_id: nx },
                            }],
                        };
                    }
                    return { content: "cycle 1 memo complete" };
                },
            });
            const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);
            catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
            await catalog.initialize();
            const store = catalog.workflowStore();
            client = new PilotSwarmClient({
                store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema, modelProvidersPath,
            });
            worker = new PilotSwarmWorker({
                store: env.store, githubToken: process.env.GITHUB_TOKEN, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
                factsSchema: env.factsSchema, sessionStateDir: env.sessionStateDir, workerNodeId: `leak-b6-${randomUUID().slice(0, 6)}`,
                disableManagementAgents: true, logLevel: "error", modelProvidersPath,
            });
            await client.start();
            await worker.start();
            const duroxide = client._getDuroxideClient();
            pool = new pg.Pool(buildPgPoolConfig({ connectionString: env.store }));
            const q = async (sql, params = []) => (await pool.query(sql.replaceAll("SCHEMA", `"${env.cmsSchema}"`), params)).rows;

            const ownerId = randomUUID();
            await catalog.createSession(ownerId, { owner: OWNER });

            const continuedYaml = JSON.stringify({
                apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "b6-continued", version: "1.0.0" }, initial: "talk",
                states: {
                    talk: {
                        type: "agent", invoke: { prompt: "Report again so the workflow enters wait while you stay live." },
                        session: "continue", timeoutSeconds: 300,
                        transition: { next: { again: "hold", finish: "done", failure: "failed" } },
                    },
                    hold: { type: "wait", seconds: 300, transition: { next: { elapsed: "talk" } } },
                    done: { type: "terminal", outcome: "succeeded" },
                    failed: { type: "terminal", outcome: "failed" },
                },
            });
            const plainMidTurnYaml = JSON.stringify({
                apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "b6-plain", version: "1.0.0" }, initial: "work",
                states: {
                    work: {
                        type: "agent", invoke: { prompt: "Hold mid-turn until cancelled." },
                        session: "new", timeoutSeconds: 300,
                        transition: { next: { ok: "done", failure: "failed" } },
                    },
                    done: { type: "terminal", outcome: "succeeded" },
                    failed: { type: "terminal", outcome: "failed" },
                },
            });

            // B6a: continued session live when parent workflow ends (3 iterations).
            midTurnState.hold = false;
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const wfId = randomUUID();
                const created = await createWorkflow({ catalog, store, duroxideClient: duroxide }, {
                    workflowSessionId: wfId, parentSessionId: ownerId, yaml: continuedYaml, actor: ENGINE,
                    operationId: `b6a-create-${i}`, publish: true, start: { inputs: {} }, notifyParent: false,
                });
                expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
                const runId = created.receipt.run.runId;
                const agentSessionId = workflowAgentSessionId(runId, "talk");
                await until(`b6a-${i} enters hold with live continued agent`, async () => {
                    const nodes = await store.listNodeExecutions(runId);
                    const inHold = nodes.some(n => n.nodeId === "hold" && n.state === "pending");
                    if (!inHold) return false;
                    return (await duroxide.getStatus(`session-${agentSessionId}`)).status === "Running";
                }, 60_000);
                await controlWorkflowRun({ catalog, store, duroxideClient: duroxide }, wfId,
                    { operation: "cancel", reason: "end while continued agent live" },
                    { actor: { kind: "agent", sessionId: ownerId }, operationId: `b6a-cancel-${i}` });
                const settled = await until(`b6a-${i} census settled`, async () => {
                    const c = await census({ store, catalog, duroxideClient: duroxide, rootSessionIds: [ownerId], graceMs: 0 });
                    return c.categories.orchestrations_live.count === 0
                        && c.categories.runs_active.count === 0
                        && c.categories.agent_sessions_live.count === 0 ? c : null;
                }, 60_000);
                assertNoLeaks(settled, { allow: ["sessions_not_swept"] });
                // Non-vacuity of category 1 for agent spawns: confirm wfa-* and session-<agent> were observed Completed.
                expect(Object.entries(settled.orchestrationStatuses).some(([id, st]) => id.startsWith("wfa-") && st === "Completed")).toBe(true);
                expect(settled.orchestrationStatuses[`session-${agentSessionId}`]).toBe("Completed");
            }

            // B6b: plain agent step actively stopped mid-turn (3 iterations).
            midTurnState.hold = true;
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const beforeCount = midTurnState.arrivedCount;
                const arrived = new Promise(resolve => { midTurnState.waitForArrival = resolve; });
                const wfId = randomUUID();
                const created = await createWorkflow({ catalog, store, duroxideClient: duroxide }, {
                    workflowSessionId: wfId, parentSessionId: ownerId, yaml: plainMidTurnYaml, actor: ENGINE,
                    operationId: `b6b-create-${i}`, publish: true, start: { inputs: {} }, notifyParent: false,
                });
                expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
                const runId = created.receipt.run.runId;
                await until(`b6b-${i} agent mid-turn`, async () => {
                    if (midTurnState.arrivedCount > beforeCount) return true;
                    await Promise.race([arrived, pause(100)]);
                    return midTurnState.arrivedCount > beforeCount;
                }, 60_000);
                const nx = midTurnState.lastNx;
                expect(nx).toBeTruthy();
                const inv = await store.readAgentInvocation(nx);
                expect(inv).toBeTruthy();
                await controlWorkflowRun({ catalog, store, duroxideClient: duroxide }, wfId,
                    { operation: "cancel", reason: "cancel mid-turn" },
                    { actor: { kind: "agent", sessionId: ownerId }, operationId: `b6b-cancel-${i}` });
                // Do NOT release the held model HTTP call here — the runtime MUST actively stop the turn.
                const settled = await until(`b6b-${i} census settled while model call still held`, async () => {
                    const c = await census({ store, catalog, duroxideClient: duroxide, rootSessionIds: [ownerId], graceMs: 0 });
                    return c.categories.orchestrations_live.count === 0
                        && c.categories.runs_active.count === 0
                        && c.categories.agent_sessions_live.count === 0 ? c : null;
                }, 60_000);
                assertNoLeaks(settled, { allow: ["sessions_not_swept"] });
                // Verify the turn-control stop was genuinely recorded for this exact visit.
                const stopEvents = await catalog.getSessionEvents(inv.childSessionId, 0, 200, ["user.stop"]);
                expect(
                    stopEvents.some(ev => String(ev.data?.requestId ?? "") === `workflow-cycle-stop:${nx}`),
                    `expected user.stop for workflow-cycle-stop:${nx}, got ${JSON.stringify(stopEvents)}`,
                ).toBe(true);
                expect(settled.orchestrationStatuses[`wfa-${nx}`]).toBe("Completed");
                expect(settled.orchestrationStatuses[`session-${inv.childSessionId}`]).toBe("Completed");
            }

            // End owner and run shared Sweeper + prune_orchestrations pass -> all 8 categories zero & histories pruned.
            await q("UPDATE SCHEMA.sessions SET state = 'completed', updated_at = now() - interval '5 seconds' WHERE session_id = $1", [ownerId]);
            await sweepOwnerTree({ store, catalog, duroxideClient: duroxide, q, ownerId, reason: "b6 sweep" });
        } finally {
            for (const resolve of midTurnState.inFlightResolvers.splice(0)) resolve();
            if (worker) { try { await worker.stop(); } catch {} }
            if (client) { try { await client.stop(); } catch {} }
            if (catalog) { try { await catalog.close(); } catch {} }
            if (pool) { try { await pool.end(); } catch {} }
            if (model) { try { await model.close(); } catch {} }
        }
    });

    it("B7: parallel two lanes each spawning a child; parent fails in one lane (3x)", { timeout: TIMEOUT }, async () => {
        const h = await startRuntimeHarness(getEnv());
        try {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["sleep-child", SLEEP_CHILD_YAML],
                ["parallel-two-lanes-fail", PARALLEL_TWO_LANES_FAIL_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const parent = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parallel-two-lanes-fail" }, inputs: {},
                    actor: ENGINE, operationId: `b7-${i}`, owner: OWNER,
                });
                const children = await h.waitChildren(parent.workflowId, 2);
                for (const c of children) await h.waitRunStatus(c.runId, ["running"]);
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: parent.workflowId, senderSessionId: ownerId, contract: "FailLane@1", payload: { i }, operationId: `b7-fail-${i}`,
                });
                expect((await h.waitRunStatus(parent.runId, ["failed"])).status).toBe("failed");
                for (const c of children) expect((await h.waitRunStatus(c.runId, ["cancelled"])).status).toBe("cancelled");
                const c = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(c, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        } finally {
            await h.stop();
        }
    });

    it("B8: fault injection — parent-end cancel of child fails once, controller retries and child ends (3x)", { timeout: TIMEOUT }, async () => {
        const injectedOps = new Set();
        let cancelAttempts = 0;
        let injectedFailures = 0;
        const h = await startRuntimeHarness(getEnv(), {
            wrapStore: (raw) => new Proxy(raw, {
                get(target, prop) {
                    if (prop === "recordSessionCommand") {
                        return async (input) => {
                            if (input?.command === "cancel" && String(input.operationId ?? "").startsWith("parent-end:")) {
                                cancelAttempts += 1;
                                const key = `${input.operationId}:${input.workflowSessionId}`;
                                if (!injectedOps.has(key)) {
                                    injectedOps.add(key);
                                    injectedFailures += 1;
                                    throw new Error("Simulated transient parent-end cancel failure");
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
        try {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["busy-child", BUSY_CHILD_YAML],
                ["parent-spawn-fail", PARENT_SPAWN_FAIL_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const parent = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-spawn-fail" }, inputs: { responder: ownerId },
                    actor: ENGINE, operationId: `b8-${i}`, owner: OWNER,
                });
                const [child] = await h.waitChildren(parent.workflowId, 1);
                await h.waitBusyChildLive(child.runId);
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: parent.workflowId, senderSessionId: ownerId, contract: "Go@1", payload: { i }, operationId: `b8-go-${i}`,
                });
                expect((await h.waitRunStatus(parent.runId, ["failed"])).status).toBe("failed");
                expect((await h.waitRunStatus(child.runId, ["cancelled"])).status).toBe("cancelled");
                const c = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(c, { allow: ["sessions_not_swept"] });
            }
            expect(injectedFailures).toBe(ITERATIONS);
            expect(cancelAttempts).toBeGreaterThanOrEqual(ITERATIONS * 2);
            await h.endOwnerAndSweep(ownerId);
        } finally {
            await h.stop();
        }
    });

    it("B9: owner session ends while top-level Workflow, its child, and a pending outbox send run — real owner-ended DB trigger (3x)", { timeout: TIMEOUT }, async () => {
        let holdSendEnqueue = false;
        let releaseSendEnqueue = null;
        let sendEnqueueHeld = null;
        const h = await startRuntimeHarness(getEnv(), {
            wrapSessionQueue: (base) => ({
                ...base,
                enqueue: async (sessionId, message) => {
                    if (holdSendEnqueue && String(message?.clientMessageId ?? "").includes(":send:")) {
                        holdSendEnqueue = false;
                        sendEnqueueHeld?.();
                        await new Promise(resolve => { releaseSendEnqueue = resolve; });
                        throw new Error("Simulated delivery interruption on owner end");
                    }
                    return base.enqueue(sessionId, message);
                },
            }),
        });
        try {
            for (let i = 1; i <= ITERATIONS; i += 1) {
                const ownerId = await h.createLiveOwner();
                await h.saveDefs(ownerId, [
                    ["busy-child", BUSY_CHILD_YAML],
                    ["parent-spawn-hold", PARENT_SPAWN_HOLD_YAML],
                    ["send-outbox", SEND_OUTBOX_YAML],
                ]);
                const parent = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "parent-spawn-hold" }, inputs: { responder: ownerId },
                    actor: ENGINE, operationId: `b9-${i}`, owner: OWNER,
                });
                const [child] = await h.waitChildren(parent.workflowId, 1);
                await h.waitBusyChildLive(child.runId);

                // Also start a sibling workflow with a pending outbox send that is mid-delivery when the owner ends.
                holdSendEnqueue = true;
                const held = new Promise(resolve => { sendEnqueueHeld = resolve; });
                const senderWf = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "send-outbox" }, inputs: { recipient: ownerId },
                    actor: ENGINE, operationId: `b9-send-${i}`, owner: OWNER,
                });
                await until(`b9-${i} send outbox pending mid-delivery`, async () => {
                    await Promise.race([held, pause(50)]);
                    const rows = await h.q("SELECT state FROM SCHEMA.workflow_outbox WHERE run_id = $1 AND mode = 'send'", [senderWf.runId]);
                    return !holdSendEnqueue && rows.length === 1 && rows[0].state === "pending";
                }, 30_000);

                // Fire ONLY the real workflow_owner_session_ended DB trigger (no manual enqueue).
                await h.q("UPDATE SCHEMA.sessions SET state = 'completed', updated_at = now() WHERE session_id = $1", [ownerId]);
                await h.client.raiseEvent(`session-${ownerId}`, "end", {});
                // Release the paused send attempt so wfs- retries/settles against the ended run.
                releaseSendEnqueue?.();
                releaseSendEnqueue = null;

                expect((await h.waitRunStatus(parent.runId, ["cancelled"])).status).toBe("cancelled");
                expect((await h.waitRunStatus(child.runId, ["cancelled"])).status).toBe("cancelled");
                expect((await h.waitRunStatus(senderWf.runId, ["cancelled"])).status).toBe("cancelled");
                const c = await h.waitTreeSettled(ownerId, { liveOwner: false });
                assertNoLeaks(c, { allow: ["sessions_not_swept"] });
                expect(Object.entries(c.orchestrationStatuses).some(([id, st]) => id.startsWith("wfs-") && st === "Completed")).toBe(true);
                await h.endOwnerAndSweep(ownerId);
            }
        } finally {
            releaseSendEnqueue?.();
            await h.stop();
        }
    });

    it("B10a: messages sent to a run that then ends — consumed, short-TTL expired, and post-end refused with RUN_ENDED (3x)", { timeout: TIMEOUT }, async () => {
        const h = await startRuntimeHarness(getEnv());
        try {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["inbox-consume", INBOX_CONSUME_YAML],
                ["inbox-unconsumed", INBOX_UNCONSUMED_YAML],
            ]);
            for (let i = 1; i <= ITERATIONS; i += 1) {
                // Sub-case 1: message sent and consumed before run completes.
                const wConsume = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "inbox-consume" }, inputs: {},
                    actor: ENGINE, operationId: `b10a-c-${i}`, owner: OWNER,
                });
                await h.waitRunStatus(wConsume.runId, ["running"]);
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: wConsume.workflowId, senderSessionId: ownerId, contract: "Ping@1",
                    payload: { seq: i }, operationId: `b10a-c-msg-${i}`,
                });
                expect((await h.waitRunStatus(wConsume.runId, ["completed"])).status).toBe("completed");

                // Sub-case 2: sending after run ended must reject with RUN_ENDED and insert zero inbox rows.
                const beforeCount = (await h.q("SELECT count(*)::int AS c FROM SCHEMA.workflow_inbox WHERE run_id = $1", [wConsume.runId]))[0].c;
                await expect(sendTypedWorkflowInput(h.host, {
                    workflowSessionId: wConsume.workflowId, senderSessionId: ownerId, contract: "Ping@1",
                    payload: { late: true }, operationId: `b10a-late-${i}`,
                })).rejects.toMatchObject({ code: "RUN_ENDED" });
                const afterCount = (await h.q("SELECT count(*)::int AS c FROM SCHEMA.workflow_inbox WHERE run_id = $1", [wConsume.runId]))[0].c;
                expect(afterCount).toBe(beforeCount);

                // Sub-case 3: unconsumed message with short TTL (1s) expires naturally after run ends.
                const wExpired = await startSessionWorkflowDefinition(h.host, {
                    ownerSessionId: ownerId, definition: { name: "inbox-unconsumed" }, inputs: {},
                    actor: ENGINE, operationId: `b10a-e-${i}`, owner: OWNER,
                });
                await h.waitRunStatus(wExpired.runId, ["running"]);
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: wExpired.workflowId, senderSessionId: ownerId, contract: "Ping@1",
                    payload: { seq: i, shortTtl: true }, ttlSeconds: 1, operationId: `b10a-e-msg-${i}`,
                });
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: wExpired.workflowId, senderSessionId: ownerId, contract: "Go@1",
                    payload: { go: true }, operationId: `b10a-e-go-${i}`,
                });
                expect((await h.waitRunStatus(wExpired.runId, ["completed"])).status).toBe("completed");
                await until(`b10a-${i} short-TTL inbox expired`, async () => {
                    const c = await census({
                        store: h.store, catalog: h.catalog, duroxideClient: h.client,
                        rootSessionIds: [ownerId], graceMs: 0, liveOwnerSessionIds: [ownerId],
                    });
                    return c.categories.inbox_pending_on_terminal_runs.count === 0
                        && c.categories.orchestrations_live.count === 0 ? c : null;
                }, 15_000);

                const c = await h.waitTreeSettled(ownerId, { liveOwner: true });
                assertNoLeaks(c, { allow: ["sessions_not_swept"] });
            }
            await h.endOwnerAndSweep(ownerId);
        } finally {
            await h.stop();
        }
    });

    // KNOWN LEAK (expected failure via `it.fails` until owner chooses I7 design):
    // Unconsumed default-TTL (24h) workflow_inbox rows stay unexpired when the target run ends
    // (endRunIn, finishStoppedRun, expireRun, cancelBeforeBegin, workflow_on_session_deleted,
    // workflow_on_owner_session_ended never close/expire inbox rows; listOpenInbox() still surfaces
    // them on terminal runs). Kept live with `it.fails` so CI proves the leak exists and flags when fixed.
    it.fails("B10b (KNOWN LEAK): unconsumed default-TTL inbox message stays unexpired on terminal run", { timeout: TIMEOUT }, async () => {
        const h = await startRuntimeHarness(getEnv());
        try {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [["inbox-unconsumed", INBOX_UNCONSUMED_YAML]]);
            const wUnconsumed = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: ownerId, definition: { name: "inbox-unconsumed" }, inputs: {},
                actor: ENGINE, operationId: "b10b-u-1", owner: OWNER,
            });
            await h.waitRunStatus(wUnconsumed.runId, ["running"]);
            await sendTypedWorkflowInput(h.host, {
                workflowSessionId: wUnconsumed.workflowId, senderSessionId: ownerId, contract: "Ping@1",
                payload: { unconsumed: true }, operationId: "b10b-u-msg-1",
            });
            await sendTypedWorkflowInput(h.host, {
                workflowSessionId: wUnconsumed.workflowId, senderSessionId: ownerId, contract: "Go@1",
                payload: { go: true }, operationId: "b10b-u-go-1",
            });
            expect((await h.waitRunStatus(wUnconsumed.runId, ["completed"])).status).toBe("completed");
            const c = await h.waitTreeSettled(ownerId, { liveOwner: true });
            assertNoLeaks(c, { allow: ["sessions_not_swept"] });
        } finally {
            await h.stop();
        }
    });

    // KNOWN LEAK (expected failure via `it.fails` until owner chooses I7 design):
    // Fire-and-forget child Workflow completes before its parent ends -> writes WorkflowEnded@1 (24h TTL)
    // into parent's workflow_inbox (`runtime.ts:3036-3048`). When the parent ends without receiving it,
    // the WorkflowEnded@1 row stays unconsumed and unexpired on the terminal parent run.
    it.fails("B10c (KNOWN LEAK): fire-and-forget child WorkflowEnded@1 stays unexpired on terminal parent run", { timeout: TIMEOUT }, async () => {
        const h = await startRuntimeHarness(getEnv());
        try {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["quick-child", QUICK_CHILD_YAML],
                ["parent-fire-and-forget", PARENT_FIRE_AND_FORGET_YAML],
            ]);
            const parent = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: ownerId, definition: { name: "parent-fire-and-forget" }, inputs: {},
                actor: ENGINE, operationId: "b10c-1", owner: OWNER,
            });
            const [child] = await h.waitChildren(parent.workflowId, 1);
            expect((await h.waitRunStatus(child.runId, ["completed"])).status).toBe("completed");
            // Wait until the child's WorkflowEnded@1 notice has landed in the parent's inbox.
            await until("WorkflowEnded@1 landed in parent inbox", async () => {
                const rows = await h.q("SELECT message_id FROM SCHEMA.workflow_inbox WHERE run_id = $1 AND contract = 'WorkflowEnded@1'", [parent.runId]);
                return rows.length === 1;
            }, 20_000);
            // Parent completes without ever receiving WorkflowEnded@1.
            await sendTypedWorkflowInput(h.host, {
                workflowSessionId: parent.workflowId, senderSessionId: ownerId, contract: "Go@1",
                payload: { go: true }, operationId: "b10c-go-1",
            });
            expect((await h.waitRunStatus(parent.runId, ["completed"])).status).toBe("completed");
            const c = await h.waitTreeSettled(ownerId, { liveOwner: true });
            assertNoLeaks(c, { allow: ["sessions_not_swept"] });
        } finally {
            await h.stop();
        }
    });

    it("B11: bare claim-shell cleanup (parent delete vs owner cascade sweep) and test-mode (wft-) bench pruning", { timeout: TIMEOUT }, async () => {
        const h = await startRuntimeHarness(getEnv());
        try {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["quick-child", QUICK_CHILD_YAML],
                ["sleep-child", SLEEP_CHILD_YAML],
            ]);

            // Part 1: test-mode bench (`wft-<run>`) completes, is observed Completed by census, and is pruned by Sweeper.
            const report = JSON.parse(await workflowDefinitionFromTool({ name: "quick-child", operation: "test", fixtures: [] }, {
                callerSessionId: ownerId, host: h.host, toolCallId: randomUUID(), owner: OWNER, binding: async () => null,
                testWait: { waitMs: testTime.ms(90_000), pollMs: 50, graceMs: 10_000 },
            }));
            expect(report, JSON.stringify(report)).toMatchObject({ ok: true, status: "passed" });
            const [benchRun] = await h.store.listRuns(report.testId);
            expect(benchRun.controllerInstanceId.startsWith("wft-")).toBe(true);
            await until("bench wft- controller completed", async () => (await h.client.getStatus(benchRun.controllerInstanceId)).status === "Completed");

            // Part 2: bare claim shell under a parent workflow that is deleted -> endWorkflowRunChildWorkflows deletes it immediately.
            const parentDel = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: ownerId, definition: { name: "sleep-child" }, inputs: { id: 1 },
                actor: ENGINE, operationId: "b11-pdel", owner: OWNER,
            });
            await h.waitRunStatus(parentDel.runId, ["running"]);
            const delShellId = randomUUID();
            await h.q("SELECT SCHEMA.cms_create_workflow_session($1, $2, '{}'::jsonb)", [delShellId, parentDel.workflowId]);
            const beforeDel = await census({
                store: h.store, catalog: h.catalog, duroxideClient: h.client,
                rootSessionIds: [ownerId], graceMs: 0, liveOwnerSessionIds: [ownerId],
            });
            expect(beforeDel.categories.claim_shells.ids).toContain(delShellId);
            await applyOperatorCommandToWorkflow(h.host, {
                targetSessionId: parentDel.workflowId, command: { type: "cmd", cmd: "delete", id: "b11-del-parent", reason: "delete parent with shell" },
            });
            await until("bare shell deleted with parent", async () => (await h.store.readSessionLink(delShellId))?.deleted === true);

            // Part 3: bare claim shell left under a live owner/workflow (crashed spawn before run admission):
            // census reports category 5 non-zero, standalone Sweeper scan skips it (`noRun`), and owner-end
            // cascade sweep removes it (category 5 = 0, category 8 = 0, wft- pruned to NotFound).
            const orphanShellId = randomUUID();
            await h.q("SELECT SCHEMA.cms_create_workflow_session($1, $2, '{}'::jsonb)", [orphanShellId, ownerId]);
            const beforeSweep = await h.waitTreeSettled(ownerId, { liveOwner: true });
            expect(beforeSweep.categories.claim_shells.ids).toEqual([orphanShellId]);
            expect(beforeSweep.orchestrationStatuses[benchRun.controllerInstanceId]).toBe("Completed");
            assertNoLeaks(beforeSweep, { allow: ["claim_shells", "sessions_not_swept"] });

            // Standalone Sweeper scan does NOT return a bare workflow session with no run (`noRun`).
            const tools = createSweeperTools({ catalog: h.catalog, duroxideClient: h.client, factStore: null });
            const scan = tools.find(t => t.name === "scan_completed_sessions");
            await pause(50);
            const scanned = await scan.handler({ graceMinutes: 0 });
            expect((scanned.sessions ?? []).map(s => s.sessionId)).not.toContain(orphanShellId);

            // Owner ends + Sweeper cascades -> claim_shells = 0, sessions_not_swept = 0, wft- pruned to NotFound.
            await h.endOwnerAndSweep(ownerId);
        } finally {
            await h.stop();
        }
    });

    it("Control (non-vacuity): census catches and assertNoLeaks reports deliberate leaks across all 8 categories", { timeout: TIMEOUT }, async () => {
        const h = await startRuntimeHarness(getEnv(), { skipParentEndCleanup: true });
        try {
            const ownerId = await h.createLiveOwner();
            await h.saveDefs(ownerId, [
                ["busy-child", BUSY_CHILD_YAML],
                ["parent-spawn-fail", PARENT_SPAWN_FAIL_YAML],
            ]);

            // 1. Deliberately skip parent-end cleanup -> child workflow + its run + its orchestration stay live!
            const parent = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: ownerId, definition: { name: "parent-spawn-fail" }, inputs: { responder: ownerId },
                actor: ENGINE, operationId: "ctrl-parent", owner: OWNER,
            });
            const [leakedChild] = await h.waitChildren(parent.workflowId, 1);
            await h.waitBusyChildLive(leakedChild.runId);
            await sendTypedWorkflowInput(h.host, {
                workflowSessionId: parent.workflowId, senderSessionId: ownerId, contract: "Go@1", payload: {}, operationId: "ctrl-go",
            });
            expect((await h.waitRunStatus(parent.runId, ["failed"])).status).toBe("failed");
            await until("parent controller terminal", async () => TERMINAL_ORCH.has((await h.client.getStatus(`session-${parent.workflowId}`)).status));

            // 2. Deliberate bare claim shell (workflow session with no run row, deleted_at NULL).
            const shellId = randomUUID();
            await h.q(`SELECT SCHEMA.cms_create_workflow_session($1, $2, '{}'::jsonb)`, [shellId, ownerId]);

            // 3. Deliberate open work (approval, request, outbox, plain pending node, awaiting_parent test interception)
            //    + pending inbox on the terminal parent run (direct DB state).
            const fakePendingNx = `nx-ctrl-${randomUUID().replaceAll("-", "")}`;
            await h.q(
                `INSERT INTO SCHEMA.workflow_node_executions
                    (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state)
                 VALUES ($1, $2, 'root', 'ctrl_appr', 99, 'approval', '{}', '0', 'pending')`,
                [fakePendingNx, parent.runId],
            );
            await h.q(
                `INSERT INTO SCHEMA.workflow_approvals
                    (node_execution_id, workflow_session_id, run_id, owner_provider, owner_subject, snapshot, context_sha256)
                 VALUES ($1, $2, $3, $4, $5, '{}', repeat('a', 64))`,
                [fakePendingNx, parent.workflowId, parent.runId, OWNER.provider, OWNER.subject],
            );
            const fakeOutboxNx = `nx-out-${randomUUID().replaceAll("-", "")}`;
            await h.q(
                `INSERT INTO SCHEMA.workflow_node_executions
                    (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state)
                 VALUES ($1, $2, 'root', 'ctrl_req', 100, 'messaging', '{}', '0', 'pending')`,
                [fakeOutboxNx, parent.runId],
            );
            await h.q(
                `INSERT INTO SCHEMA.workflow_outbox
                    (exchange_id, node_execution_id, workflow_session_id, run_id, mode, recipient_session_id, recipient_kind, contract, payload, payload_sha256, state, created_at)
                 VALUES ($1, $1, $2, $3, 'request', $4, 'agent', 'Ask@1', '{}', '0', 'pending', now())`,
                [fakeOutboxNx, parent.workflowId, parent.runId, ownerId],
            );
            await h.q(
                `INSERT INTO SCHEMA.workflow_requests
                    (exchange_id, workflow_session_id, run_id, responder_session_id, contract, request_sha256, response_schema, deadline_at, created_at)
                 VALUES ($1, $2, $3, $4, 'Ask@1', '0', '{}', now() + interval '1 hour', now())`,
                [fakeOutboxNx, parent.workflowId, parent.runId, ownerId],
            );
            const fakePlainPendingNx = `nx-wait-${randomUUID().replaceAll("-", "")}`;
            await h.q(
                `INSERT INTO SCHEMA.workflow_node_executions
                    (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state)
                 VALUES ($1, $2, 'root', 'ctrl_wait', 102, 'wait', '{}', '0', 'pending')`,
                [fakePlainPendingNx, parent.runId],
            );
            const fakeInterceptionId = `ti-ctrl-${randomUUID().slice(0, 8)}`;
            await h.q(
                `INSERT INTO SCHEMA.workflow_test_interceptions
                    (interception_id, run_id, node_execution_id, operation, arguments, arguments_sha256, state, virtual_at, created_at)
                 VALUES ($1, $2, $3, 'send', '{}', '0', 'awaiting_parent', now(), now())`,
                [fakeInterceptionId, parent.runId, fakePlainPendingNx],
            );
            // 4. Deliberate live agent session started by a workflow visit (running state, end never sent).
            const fakeAgentNx = `nx-agt-${randomUUID().replaceAll("-", "")}`;
            const fakeAgentSessionId = randomUUID();
            await h.catalog.createSession(fakeAgentSessionId, { parentSessionId: parent.workflowId, owner: OWNER });
            await h.q(
                `INSERT INTO SCHEMA.workflow_node_executions
                    (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state)
                 VALUES ($1, $2, 'root', 'ctrl_agent', 101, 'agent', '{}', '0', 'pending')`,
                [fakeAgentNx, parent.runId],
            );
            await h.q(
                `INSERT INTO SCHEMA.workflow_agent_invocations
                    (node_execution_id, run_id, workflow_session_id, child_session_id, task, outcomes, deadline_at, created_at, spawn_attempts)
                 VALUES ($1, $2, $3, $4, '{}', '["ok"]', now() + interval '1 hour', now(), 1)`,
                [fakeAgentNx, parent.runId, parent.workflowId, fakeAgentSessionId],
            );
            const fakeInboxId = `msg-ctrl-${randomUUID()}`;
            await h.q(
                `INSERT INTO SCHEMA.workflow_inbox
                    (message_id, workflow_session_id, run_id, sender_session_id, operation_id, request_sha256, contract, correlation, payload, accepted_at, expires_at)
                 VALUES ($1, $2, $3, $4, 'ctrl-inbox', '0', 'Ping@1', '{}', '{}', now(), now() + interval '1 hour')`,
                [fakeInboxId, parent.workflowId, parent.runId, ownerId],
            );

            const leaked = await census({
                store: h.store,
                catalog: h.catalog,
                duroxideClient: h.client,
                rootSessionIds: [ownerId],
                graceMs: 0,
                liveOwnerSessionIds: [ownerId],
            });
            expect(leaked.categories.orchestrations_live.ids.some(id => id.startsWith(`session-${leakedChild.workflowSessionId}:`))).toBe(true);
            expect(leaked.categories.runs_active.ids).toContain(leakedChild.runId);
            expect(leaked.categories.child_workflows_active.ids).toContain(leakedChild.workflowSessionId);
            expect(leaked.categories.agent_sessions_live.ids).toContain(fakeAgentSessionId);
            expect(leaked.categories.claim_shells.ids).toContain(shellId);
            expect(leaked.categories.open_work_on_terminal_runs.ids).toContain(`approval:${fakePendingNx}`);
            expect(leaked.categories.open_work_on_terminal_runs.ids).toContain(`request:${fakeOutboxNx}`);
            expect(leaked.categories.open_work_on_terminal_runs.ids).toContain(`outbox:${fakeOutboxNx}`);
            expect(leaked.categories.open_work_on_terminal_runs.ids).toContain(`node:${fakePlainPendingNx}`);
            expect(leaked.categories.open_work_on_terminal_runs.ids).toContain(`interception:${fakeInterceptionId}`);
            expect(leaked.categories.inbox_pending_on_terminal_runs.ids).toContain(fakeInboxId);
            expect(leaked.categories.sessions_not_swept.ids).toContain(ownerId);
            expect(leaked.total).toBeGreaterThanOrEqual(12);

            let err = null;
            try {
                assertNoLeaks(leaked);
            } catch (caught) {
                err = caught;
            }
            expect(err).toBeInstanceOf(Error);
            expect(err.message).toContain("orchestrations_live");
            expect(err.message).toContain("runs_active");
            expect(err.message).toContain("child_workflows_active");
            expect(err.message).toContain("agent_sessions_live");
            expect(err.message).toContain("claim_shells");
            expect(err.message).toContain("open_work_on_terminal_runs");
            expect(err.message).toContain("inbox_pending_on_terminal_runs");
            expect(err.message).toContain("sessions_not_swept");
            expect(err.message).toContain(leakedChild.runId);
            expect(err.message).toContain(fakeAgentSessionId);
            expect(err.message).toContain(shellId);
            expect(err.message).toContain(fakePlainPendingNx);
            expect(err.message).toContain(fakeInterceptionId);
            expect(err.message).toContain(fakeInboxId);

            // Clean up the leaked child so runtime shutdown is clean.
            await applyOperatorCommandToWorkflow(h.host, {
                targetSessionId: leakedChild.workflowSessionId,
                command: { type: "cmd", cmd: "cancel", id: "ctrl-cleanup", reason: "cleanup" },
            });
            await h.waitRunStatus(leakedChild.runId, [...TERMINAL_RUN]);
        } finally {
            await h.stop();
        }
    });
});
