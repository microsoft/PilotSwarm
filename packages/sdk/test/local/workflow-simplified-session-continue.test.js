/**
 * Workflow Simplified: an agent node that continues its session (owner decision agent-node-continue-20261106; the
 * parent's design verdict: YAML key `session: new | continue` (owner 2026-11-09T06:30Z renamed it from `session`), and the formal
 * answers Q1 to Q5).
 *
 * - The store: a child session is not unique among the visits (it is indexed); two visits share one session; a completion
 *   of a continued session binds ONLY by the node execution id it gives (none, or one that is not the session's, is refused in
 *   words; a late one binds to its own decided visit and is refused there,
 *   the open visit unaffected); a reminder binds to the open visit and names it.
 * - The controller with a test-double host (as workflow-agent-node.test.js): two visits go to ONE session; the
 *   second prompt says cycle 2 with the variables now, which changed and the previous result; a visit's time limit stops
 *   its turn (a turn control Stop, never the session) and the next visit runs; the session is ended once, when the Workflow
 *   ends; a cancel ends it; a graceful stop ends an idle session at once; a session that ended on its own between visits is
 *   replaced by a new session whose first prompt and the Workflow's log say so.
 *
 * The child session is a test double (an orchestration that records its queue); turn Stops are recorded by a spy on
 * the catalog's turn control. No model runs.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { canonicalJson } from "../../src/workflow/json.ts";
import { controlWorkflowRun, createWorkflow } from "../../src/workflow/service.ts";
import { completeWorkflowNodeFromTool } from "../../src/workflow/agent-node-service.ts";
import { readWorkflowView } from "../../src/workflow/tools.ts";
import {
    registerWorkflow, sessionQueueTransport, WORKFLOW_CONTROLLER_VERSION, workflowAgentSessionId, workflowAgentChildSessionId,
    workflowLiveControllerInstanceId,
} from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { spawnNesting, WORKFLOW_MAX_DESCENDANT_LEVEL } from "../../src/workflow/input-policy.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { PilotSwarmManagementClient, PilotSwarmClient } from "../helpers/local-workers.js";
import { createWorkflowAgentNodeHost } from "../../src/workflow/agent-host.ts";
import { recordSessionEndRequested } from "../../src/session-end-mark.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-simplified-session-continue-test" };
const TASK = "Tell one new fact about PostgreSQL.";
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

/**
 * One agent node that continues its agent session, visited again after a wait until it says finish. `session`: its `session`
 * (null: nothing, the default; owner 2026-11-09T05:38Z: continue outside a parallel body).
 */
const SESSION_YAML = ({ limit = "3600", wait = 1, agentSession = "continue" } = {}) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: chatter, version: "1.0.0" }
initialInput: { round: 1 }
initial: talk
states:
  talk:
    type: agent
    invoke: { prompt: "${TASK}" }
${agentSession === null ? "" : `    session: ${agentSession}\n`}    timeoutSeconds: ${limit}
    transition: { next: { again: pause, finish: done, timed_out: pause, failure: failed } }
  pause: { type: wait, seconds: ${wait}, transition: { next: { elapsed: talk } } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;

// ─── The create fence (review DRR-1) ───────────────────────────

describe("review DRR-1: a Workflow agent session's create never brings a deleted session back", () => {
    it("a create with refuseDeleted makes a new session, reuses a live one and refuses a deleted one, which stays deleted; other creates are unchanged", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const client = new PilotSwarmClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
        await client.start();
        // This test has no model providers; the create's model resolution is not what it checks.
        client._resolveCreationModel = async () => null;
        try {
            const store = catalog.workflowStore();
            const id = randomUUID();
            await client.createSession({ sessionId: id, refuseDeleted: true });
            expect(await catalog.getSession(id)).toBeTruthy();
            await client.createSession({ sessionId: id, refuseDeleted: true });
            await catalog.softDeleteSession(id);
            await expect(client.createSession({ sessionId: id, refuseDeleted: true })).rejects.toMatchObject({ code: "SESSION_DELETED" });
            await expect(catalog.createSession(id, { refuseDeleted: true })).rejects.toMatchObject({ code: "SESSION_DELETED" });
            expect(await store.isSessionDeleted(id)).toBe(true);
            // Every other caller's create keeps its behaviour: it brings the deleted row back.
            await catalog.createSession(id, {});
            expect(await store.isSessionDeleted(id)).toBe(false);
        } finally {
            await client.stop();
            await catalog.close();
        }
    });
});

describe("review DR2-002: Workflow agent session creates of one id take turns", () => {
    it("a create that found no row holds the id until it commits: another create of the id waits, so no create revives a later deletion", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const a = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await a.initialize();
        const b = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await b.initialize();
        // A's paused create; let go in any case, so a failing check does not leave it holding a connection.
        let release = null;
        let first = null;
        try {
            const id = randomUUID();
            // A pauses right after its row read found no row (two connections: A's and B's own pools).
            let paused = null;
            const reached = new Promise(resolve => { paused = resolve; });
            const connect = a.pool.connect.bind(a.pool);
            // pool.query takes its connection with a callback: only the transaction's own connect() is watched.
            a.pool.connect = (...args) => args.length > 0 ? connect(...args) : (async () => {
                const conn = await connect();
                const query = conn.query.bind(conn);
                conn.query = async (...args) => {
                    const out = await query(...args);
                    const text = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
                    if (/SELECT deleted_at FROM .*sessions WHERE session_id = \$1 FOR UPDATE/s.test(text) && release === null) {
                        expect(out.rows).toEqual([]);
                        const gate = new Promise(resolve => { release = resolve; });
                        paused();
                        await gate;
                    }
                    return out;
                };
                return conn;
            })();
            first = a.createSession(id, { refuseDeleted: true });
            await reached;
            // B's create of the same id waits while A holds it: it cannot create the row (for a person to delete) under A.
            let secondDone = false;
            const second = b.createSession(id, { refuseDeleted: true }).then(() => { secondDone = true; }, error => { secondDone = true; throw error; });
            await pause(1_000);
            expect(secondDone).toBe(false);
            expect(await b.getSession(id)).toBeNull();
            release();
            await first;
            await second;
            // Then a person deletes the row: no create with refuseDeleted brings it back.
            await b.softDeleteSession(id);
            await expect(a.createSession(id, { refuseDeleted: true })).rejects.toMatchObject({ code: "SESSION_DELETED" });
            await expect(b.createSession(id, { refuseDeleted: true })).rejects.toMatchObject({ code: "SESSION_DELETED" });
            expect(await a.workflowStore().isSessionDeleted(id)).toBe(true);
        } finally {
            if (release) release();
            await first?.catch(() => {});
            await a.close();
            await b.close();
        }
    });
});

// ─── The store ────────────────────────────────────────────────

describe("session: continue in the store", () => {
    it("a session's visits are rows of one child session; a completion binds only by its node execution id; a reminder binds to the open visit", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const direct = new pg.Pool({ connectionString: env.store, max: 2 });
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        try {
            await catalog.initialize();
            // child_session_id is not unique (a session that continues has one row per visit), and is indexed.
            expect((await direct.query(
                `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = $1 AND t.relname = 'workflow_agent_invocations' AND c.contype = 'u'`, [env.cmsSchema])).rows[0].n).toBe(0);
            expect((await direct.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = 'workflow_agent_invocations_by_child'`,
                [env.cmsSchema])).rows).toHaveLength(1);

            const store = catalog.workflowStore();
            const yaml = SESSION_YAML();
            const compiled = compileWorkflow(yaml);
            expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
            expect(compiled.ir.nodes.talk.session).toBe("continue");
            const parent = randomUUID();
            await catalog.createSession(parent, {});
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            expect(await catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner: null,
                creationConfig: { workflow: { requestSha256: "chat" } } })).toEqual({ created: true });
            await store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: ACTOR,
                operationId: "create", requestSha256: "chat", publish: true, title: "Workflow: chatter",
                start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION },
            });
            const agentSession = workflowAgentSessionId(runId, "talk");
            const admit = async (ordinal, predecessorId) => {
                const nodeExecutionId = nodeExecutionIdFor(runId, "root", "talk", ordinal);
                const admitted = await store.enterNode({
                    runId, nodeExecutionId, scopeId: "root", nodeId: "talk", ordinal, nodeType: "agent",
                    predecessorId, arrivalRoute: predecessorId ? "elapsed" : null, inputText: canonicalJson({ round: ordinal }), kvRevision: 1,
                    waitSeconds: null, immediate: null,
                    agent: { childSessionId: agentSession, controllingSessionId: parent, task: { source: "prompt", prompt: TASK },
                        outcomes: ["again", "finish"], outputSchema: null, timeoutSeconds: 3600 },
                });
                expect(admitted).toMatchObject({ admitted: true, node: { state: "pending", nodeType: "agent" } });
                return nodeExecutionId;
            };
            const first = await admit(1, null);
            const refusal = call => store.completeAgentNode({ childSessionId: agentSession, operationId: randomUUID(), ...call });
            // Q1: a continued session's completion must name its cycle; one that is not this session's is refused in words.
            await expect(refusal({ call: { outcome: "again", output: { fact: "one" } } }))
                .rejects.toMatchObject({ code: "AGENT_NODE_NOT_FOUND", message: expect.stringContaining("give node_execution_id") });
            await expect(refusal({ call: { outcome: "again", output: null }, nodeExecutionId: "nx-not-mine" }))
                .rejects.toMatchObject({ code: "AGENT_NODE_NOT_FOUND", message: expect.stringContaining("is not a cycle of this session") });
            expect(await store.completeAgentNode({ childSessionId: agentSession, operationId: "op-1", call: { outcome: "again", output: { fact: "one" } },
                nodeExecutionId: first })).toMatchObject({ kind: "accepted", receipt: { nodeExecutionId: first, outcome: "again" } });

            // The second visit is admitted to the same session: both invocations name it (the UNIQUE is gone).
            const second = await admit(2, first);
            expect((await store.listAgentInvocationsOfState(runId, "talk")).map(item => [item.nodeExecutionId, item.childSessionId]))
                .toEqual([[first, agentSession], [second, agentSession]]);
            expect((await store.readAgentInvocationByChild(agentSession)).nodeExecutionId).toBe(second);
            // RT-4: a session with two visits is one lineage row, not a cycle: level 2 (its sub-agent level 3, the workflow
            // nesting maximum), its agent root the open visit.
            await catalog.createSession(agentSession, { parentSessionId: workflowSessionId });
            const mini = randomUUID();
            await catalog.createSession(mini, { parentSessionId: agentSession });
            const root = { childSessionId: agentSession, nodeExecutionId: second, workflowSessionId, controllingSessionId: parent };
            expect(await store.readWorkflowLineage(agentSession)).toEqual({ sessionId: agentSession, level: 2, agentRoot: { ...root, distance: 0 }, deleted: false });
            expect(await store.readWorkflowLineage(mini)).toEqual({ sessionId: mini, level: 3, agentRoot: { ...root, distance: 1 }, deleted: false });
            expect(spawnNesting(1, 2, await store.readWorkflowLineage(agentSession)))
                .toEqual({ childNestingLevel: 3, maxNestingLevel: WORKFLOW_MAX_DESCENDANT_LEVEL });
            // A real-agent test's scope (workflowTestAgentScope) is the agent root's visit: the open one, not the first.

            // RT-5: the visits are counted in the store, with no cap. 1,001 older decided visits (copies of the first,
            // admitted earlier: lower ordinals, the order the store reads them in since PRR-3) make the second visit cycle
            // 1,003 of the state; its previous visit is still the first.
            const copies = 1_001;
            await direct.query(`UPDATE "${env.cmsSchema}".workflow_node_executions SET ordinal = ordinal + ${copies} WHERE node_execution_id = ANY($1::text[])`,
                [[first, second]]);
            const copy = (table, extra) => `INSERT INTO "${env.cmsSchema}".${table}
                SELECT (jsonb_populate_record(NULL::"${env.cmsSchema}".${table}, to_jsonb(t) || ${extra})).*
                  FROM "${env.cmsSchema}".${table} t, generate_series(1, ${copies}) g WHERE t.node_execution_id = $1`;
            await direct.query(copy("workflow_node_executions",
                `jsonb_build_object('node_execution_id', 'rt5-' || g, 'ordinal', ${copies + 1} - g)`), [first]);
            await direct.query(copy("workflow_agent_invocations",
                "jsonb_build_object('node_execution_id', 'rt5-' || g, 'created_at', t.created_at - make_interval(secs => g))"), [first]);
            const before = await store.readAgentVisitsBefore(runId, "talk", second);
            expect([before.count, before.previous.nodeExecutionId]).toEqual([copies + 1, first]);
            const all = await store.readAgentVisitsBefore(runId, "talk", null);
            expect([all.count, all.previous.nodeExecutionId]).toEqual([copies + 2, second]);
            expect(await store.readAgentVisitsBefore(runId, "talk", "rt5-1001")).toEqual({ count: 0, previous: null });

            // RT-2/RT-3, the turn-to-visit fence: a turn's visit is the open one its prompt names, else the newest it names;
            // a prompt that names none inherits the session's newest recorded visit prompt; a session that does not continue a
            // session has none.
            const pid = nx => `workflow:${workflowSessionId}:${runId}:agent:${nx}`;
            expect(await store.readTurnVisit(agentSession, [pid(second)])).toEqual({ nodeExecutionId: second, open: true, inherited: false });
            expect(await store.readTurnVisit(agentSession, [pid(first)])).toEqual({ nodeExecutionId: first, open: false, inherited: false });
            expect(await store.readTurnVisit(agentSession, [pid(first), pid(second)])).toEqual({ nodeExecutionId: second, open: true, inherited: false });
            expect(await store.readTurnVisit(agentSession, [])).toEqual({ nodeExecutionId: null, open: false, inherited: true });
            await catalog.recordEvents(agentSession, [{ eventType: "user.message", data: { content: "cycle 2", clientMessageIds: [pid(second)] } }]);
            await catalog.recordEvents(agentSession, [{ eventType: "user.message", data: { content: "a sub-agent's update" } }]);
            expect(await store.readTurnVisit(agentSession, ["some-other-id"])).toEqual({ nodeExecutionId: second, open: true, inherited: true });
            expect(await store.readTurnVisit(mini, [pid(second)])).toBeNull();
            // A Stop's request id names its visit; the worker reads it by the Stop's position.
            const { rows: [stopRow] } = await direct.query(
                `INSERT INTO "${env.cmsSchema}".session_events (session_id, event_type, data) VALUES ($1, 'user.stop', $2) RETURNING seq`,
                [agentSession, JSON.stringify({ turn: 3, text: "cycle ended", requestId: `workflow-cycle-stop:${first}:sent` })]);
            expect(await store.readControlRequestIds(agentSession, [Number(stopRow.seq), 999_999_999]))
                .toEqual(new Map([[Number(stopRow.seq), `workflow-cycle-stop:${first}:sent`]]));
            // D3: a Stop that names another visit gets its outcome (too_late) at once, so a turn that then fails ends as an
            // error (it is retried), not as stopped by it. Without that, the open Stop turns the failure into a stop.
            const failsWith = async (turn, record) => {
                expect(await catalog.turnStart(agentSession, turn, [], "worker-d3")).toMatchObject({ stopped: false });
                const added = await catalog.turnControlAdd(agentSession, "stop", "cycle ended", `workflow-cycle-stop:${first}:${turn}`, null);
                expect(added).toMatchObject({ turn });
                if (record) {
                    expect(await store.recordStopNotForTurn(agentSession, added.seq, turn)).toEqual({ recorded: true });
                    expect(await store.recordStopNotForTurn(agentSession, added.seq, turn), "once").toEqual({ recorded: false });
                }
                return (await catalog.turnEnd(agentSession, turn, 0, "error", [])).stopped;
            };
            expect(await failsWith(5, true)).toBe(false);
            expect(await failsWith(6, false), "the open Stop would have turned the failure into a stop").toBe(true);
            expect(await store.recordStopNotForTurn(agentSession, 999_999_999, 7), "no such Stop").toEqual({ recorded: false });

            // RT-1: whether any visit of the session began a spawn attempt.
            expect(await store.sessionHasSpawnAttempt(agentSession)).toBe(false);
            expect((await store.beginAgentSpawn(second)).action).toBe("spawn");
            expect(await store.sessionHasSpawnAttempt(agentSession)).toBe(true);
            // A late answer of the first visit binds to it, never to the open one, and is refused there.
            expect(await store.completeAgentNode({ childSessionId: agentSession, operationId: "late-1", call: { outcome: "finish", output: { fact: "late" } },
                nodeExecutionId: first })).toMatchObject({ kind: "refused", code: "COMPLETION_CONFLICT" });
            expect(await store.readNodeExecution(second)).toMatchObject({ state: "pending" });
            // A reminder binds to the reminded turn's own visit and names it (RT-3); a turn with no visit, or with a decided
            // one, is not reminded, whatever visit is open.
            expect(await store.recordAgentReminder({ childSessionId: agentSession, turn: 7 })).toEqual({ recorded: false, reason: "no_visit" });
            expect(await store.recordAgentReminder({ childSessionId: agentSession, turn: 7, visit: first })).toEqual({ recorded: false, reason: "decided" });
            // The session's sub-agent (RT-4's, above) is still at work: no reminder while it is (review D5).
            expect(await store.recordAgentReminder({ childSessionId: agentSession, turn: 7, visit: second })).toEqual({ recorded: false, reason: "sub_agents" });
            await catalog.updateSession(mini, { state: "completed" });
            expect(await store.recordAgentReminder({ childSessionId: agentSession, turn: 7, visit: second }))
                .toMatchObject({ recorded: true, nodeExecutionId: second, cycle: second, stateId: "talk", n: 1 });
            // A turn completes only its own visit (RT-3); a turn with no cycle prompt (null) completes none (D1).
            await expect(store.completeAgentNode({ childSessionId: agentSession, operationId: "op-no-visit", call: { outcome: "finish", output: { fact: "x" } },
                nodeExecutionId: second, turnVisit: null }))
                .rejects.toMatchObject({ code: "AGENT_NODE_NOT_FOUND", message: expect.stringContaining("This turn received no cycle prompt") });
            await expect(store.completeAgentNode({ childSessionId: agentSession, operationId: "op-other-turn", call: { outcome: "finish", output: { fact: "x" } },
                nodeExecutionId: second, turnVisit: first }))
                .rejects.toMatchObject({ code: "AGENT_NODE_NOT_FOUND", message: expect.stringContaining(`This turn works on cycle ${first}`) });
            expect(await store.completeAgentNode({ childSessionId: agentSession, operationId: "op-2", call: { outcome: "finish", output: { fact: "two" } },
                nodeExecutionId: second })).toMatchObject({ kind: "accepted", receipt: { nodeExecutionId: second, outcome: "finish" } });
            expect(await store.recordAgentReminder({ childSessionId: agentSession, turn: 8, visit: second })).toMatchObject({ recorded: false, reason: "decided" });
            // With no visit open, the lineage's agent root is the newest visit, still one row.
            expect(await store.readWorkflowLineage(mini)).toEqual({ sessionId: mini, level: 3, agentRoot: { ...root, nodeExecutionId: second, distance: 1 }, deleted: false });
        } finally {
            await catalog.close();
            await direct.end();
        }
    });
});

// ─── The controller ───────────────────────────────────────────

const CHILD = "test-agent-child";
function* sessionChild(ctx) {
    const received = [];
    for (;;) {
        const raw = yield ctx.dequeueEvent("messages");
        const message = typeof raw === "string" ? JSON.parse(raw) : raw;
        received.push(message);
        ctx.setCustomStatus(JSON.stringify(received));
        // A delete ends a session (its orchestration's delete handler); a done or cancel is only recorded here.
        if (message?.type === "cmd" && message.cmd === "delete") return "deleted";
    }
}

/**
 * A worker-equivalent registration (as workflow-agent-node.test.js's harness). The host double creates a session once
 * (its catalog row and its orchestration) and gives it each visit's prompt; the catalog's turn control is a spy that
 * records each Stop (the double runs no turns, so it answers no_turn).
 */
async function harness(env, { storeHooks = null, storeBefore = null, beforeCreate = null, deferVisible = false, createAlways = false,
    beforeStop = null, realHost = false, beforeSend = null, activityClient = null } = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    // `storeHooks[name](result, args)` runs after the controller's call of that store method returns, before its caller
    // goes on, and `storeBefore[name](args)` before the call (a race a test sets up at an exact point); every other method
    // is the store's own.
    const controllerStore = storeHooks || storeBefore ? new Proxy(store, {
        get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== "function") return value;
            if (storeHooks && Object.hasOwn(storeHooks, key)) return async (...args) => storeHooks[key](await value.apply(target, args), args);
            if (storeBefore && Object.hasOwn(storeBefore, key)) return async (...args) => { await storeBefore[key](args); return value.apply(target, args); };
            return value.bind(target);
        },
    }) : store;
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    // duroxide's real default is 2 worker slots (see workflow-join.test.js): a test that holds a spawn's send in a slot
    // must leave room for the controller's and the cleanup's activities.
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerConcurrency: 8, workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    runtime.registerOrchestrationVersioned(CHILD, "1.0.0", sessionChild);
    const spawns = [];
    const stops = [];
    // deferVisible: the host creates the session (its catalog row) and reports it spawned, but its session's orchestration
    // starts only when the test calls makeVisible (a session whose first turn has not run yet reads NotFound; formal t3).
    const unseen = new Map();
    // realHost (review DRR-1): the real host (agent-host.ts) over a child creator that does what the worker's does: the
    // catalog create with refuseDeleted (a deleted session is never brought back), then the first prompt. `beforeCreate`
    // gets the child's spec, after every check of the spawn and before the create.
    /** The sessions the real host's creator has sent a prompt to (review DRR-1c). */
    const sentTo = new Set();
    const real = realHost ? createWorkflowAgentNodeHost({
        getSession: id => catalog.getSession(id),
        resolveAgent: async () => null,
        createChild: async spec => {
            if (beforeCreate) await beforeCreate(spec);
            await catalog.createSession(spec.sessionId, { parentSessionId: spec.parentSessionId, refuseDeleted: true });
            // `beforeSend` (review DRR-1b): after the catalog create, before the send that starts the session's orchestration.
            if (beforeSend) await beforeSend(spec);
            const instanceId = `session-${spec.sessionId}`;
            if ((await client.getStatus(instanceId)).status === "NotFound") await client.startOrchestrationVersioned(instanceId, CHILD, {}, "1.0.0");
            await client.enqueueEvent(instanceId, "messages", JSON.stringify({ prompt: spec.prompt, clientMessageIds: [spec.clientMessageId] }));
            sentTo.add(spec.sessionId);
        },
    }) : null;
    const agentNodes = real ? { async spawn(request) { spawns.push(request); return real.spawn(request); } } : {
        async spawn(request) {
            spawns.push(request);
            // A spawn that passed its open check and has not created the session yet (a test holds it here).
            if (beforeCreate) await beforeCreate(request);
            const instanceId = `session-${request.childSessionId}`;
            const message = JSON.stringify({ prompt: request.prompt, clientMessageIds: [request.clientMessageId] });
            // createAlways: as the real host (createChild through a client), the session's catalog row is created on every
            // visit, which brings a soft-deleted row back (migration 0082's cms_create_session).
            if (createAlways) await catalog.createSession(request.childSessionId, {});
            if (deferVisible && (await client.getStatus(instanceId)).status === "NotFound") {
                await catalog.createSession(request.childSessionId, {}).catch(() => {});
                unseen.set(request.childSessionId, [...(unseen.get(request.childSessionId) ?? []), message]);
                return { spawned: true };
            }
            if ((await client.getStatus(instanceId)).status === "NotFound") {
                await catalog.createSession(request.childSessionId, {}).catch(() => {});
                await client.startOrchestrationVersioned(instanceId, CHILD, {}, "1.0.0");
            }
            await client.enqueueEvent(instanceId, "messages", message);
            return { spawned: true };
        },
    };
    const spied = new Proxy(catalog, {
        get(target, key) {
            if (key === "turnControlAdd") {
                return async (sessionId, kind, text, requestId) => {
                    // beforeStop: a fault a test injects (it throws to fail this Stop).
                    if (beforeStop) await beforeStop({ sessionId, kind, requestId });
                    stops.push({ sessionId, kind, text, requestId, spawnsBefore: spawns.length });
                    return { refused: "no_turn" };
                };
            }
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    registerWorkflow({
        // `activityClient(client)` (review DRR-1c): what an activity's getClient returns, in place of its durable client.
        registerActivity: (name, fn) => runtime.registerActivity(name, activityClient
            ? (actx, input) => fn(new Proxy(actx, { get(target, key) {
                if (key === "getClient") return () => { const own = target.getClient(); return own ? activityClient(own) : own; };
                const value = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
            } }), input)
            : fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store: controllerStore, catalog: spied, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
        agentNodes,
    });
    await runtime.start();
    return {
        catalog, store, client, spawns, stops, sentTo, host: { catalog, store, duroxideClient: client },
        /** A deferred session's Copilot session starts now, and gets the prompts it was sent while it was not visible. */
        async makeVisible(agentSession) {
            const instanceId = `session-${agentSession}`;
            await client.startOrchestrationVersioned(instanceId, CHILD, {}, "1.0.0");
            for (const message of unseen.get(agentSession) ?? []) await client.enqueueEvent(instanceId, "messages", message);
            unseen.delete(agentSession);
        },
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

/** A parent session and a started run of `yaml` it created, with `vars`. */
async function started(h, yaml, vars = undefined) {
    const parent = randomUUID();
    await h.catalog.createSession(parent, {});
    const workflowSessionId = randomUUID();
    const created = await createWorkflow(h.host, {
        workflowSessionId, parentSessionId: parent, yaml, actor: ACTOR, operationId: "start", start: { inputs: {}, ...(vars ? { vars } : {}) },
    });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    return { parent, workflowSessionId, runId: created.receipt.run.runId };
}

const ended = (h, runId) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && ["completed", "failed", "cancelled", "stopped"].includes(run.status) ? run : null;
}, `run ${runId} to end`);

async function ownerMessages(h, agentSession) {
    const status = await h.client.getStatus(`session-${agentSession}`);
    return typeof status.customStatus === "string" && status.customStatus ? JSON.parse(status.customStatus) : [];
}
const commandsOf = async (h, agentSession) => (await ownerMessages(h, agentSession)).filter(message => message?.type === "cmd");
const agentSessionEnd = (h, agentSession) => until(async () => (await commandsOf(h, agentSession))[0] ?? null, `the end of session ${agentSession}`, 30_000);
/** What a test that waits for a session's end saw when none came: the session, its visits, the spawn's orchestration, the log. */
async function agentSessionEndDiagnosis(h, run, agentSession, nodeExecutionIds) {
    const status = async instanceId => {
        const read = await h.client.getStatus(instanceId).catch(error => ({ status: `read failed: ${error?.message}` }));
        return { status: read.status, output: read.output ?? null, error: read.error ?? null };
    };
    const events = await h.catalog.getSessionEvents(run.workflowSessionId, 0, 500).catch(() => []);
    return JSON.stringify({
        agentSession: await status(`session-${agentSession}`),
        spawns: await Promise.all(nodeExecutionIds.map(nx => status(`wfa-${nx}`))),
        visits: await Promise.all(nodeExecutionIds.map(async nx => {
            const invocation = await h.store.readAgentInvocation(nx);
            const node = await h.store.readNodeExecution(nx);
            return invocation && { nx, spawnAttempts: invocation.spawnAttempts, spawnedAt: invocation.spawnedAt, endRequested: invocation.endRequested,
                endSentAt: invocation.endSentAt, endChildStatus: invocation.endChildStatus, node: node && [node.state, node.outcome, node.winner] };
        })),
        run: (await h.store.readRun(run.runId))?.status ?? null,
        log: events.filter(event => event.eventType.startsWith("workflow.agent") || event.eventType === "workflow.cancelled")
            .map(event => [event.eventType, event.data?.childStatus ?? event.data?.error ?? null, event.data?.sent ?? null]),
    });
}
/** agentSessionEnd, failing with agentSessionEndDiagnosis when no end comes. */
const agentSessionEndOrDiagnose = async (h, run, agentSession, nodeExecutionIds) => {
    try {
        return await agentSessionEnd(h, agentSession);
    } catch (error) {
        throw new Error(`${error.message}; diagnosis: ${await agentSessionEndDiagnosis(h, run, agentSession, nodeExecutionIds)}`);
    }
};
const visit = (h, n) => until(async () => (h.spawns.length >= n ? h.spawns[n - 1] : null), `visit ${n}`);
const spawnedVisit = async (h, n) => {
    const request = await visit(h, n);
    await until(async () => (await h.store.readAgentInvocation(request.nodeExecutionId))?.spawnedAt ?? null, `the spawn of visit ${n}`);
    return request;
};
const completeAs = (h, agentSession, args) => completeWorkflowNodeFromTool(args, { callerSessionId: agentSession, store: h.store, client: h.client })
    .then(text => JSON.parse(text));
const eventsOf = async (h, workflowSessionId, type) => (await h.catalog.getSessionEvents(workflowSessionId, 0, 500))
    .filter(event => event.eventType === type).map(event => event.data);

/** A For each over two items whose body's agent state sets no session (owner 2026-11-09T05:38Z: new, the only choice there). */
const FOR_EACH_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: fan-talk, version: "1.0.0" }
initialInput: { items: [a, b] }
initial: fan
states:
  fan:
    type: parallel
    forEach: "\${input.items}"
    concurrency: 2
    body:
      initial: talk
      states:
        talk:
          type: agent
          invoke: { prompt: "${TASK}" }
          timeoutSeconds: 3600
          transition: { next: { said: said_it, failure: gave_up } }
        said_it: { type: terminal, outcome: succeeded }
        gave_up: { type: terminal, outcome: blocked }
    transition: { next: { joined: done, blocked: failed, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

// Owner 2026-11-09T05:38Z: an agent state that sets no session continues one agent session across its visits where it may (a
// loop of the outer graph); inside a For each each item's visit has its own; an explicit `session: new` still gets one each visit.
describe("the default session mode on the controller", () => {
    it("a loop's agent state that sets no session keeps one agent session across its visits", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const run = await started(h, SESSION_YAML({ agentSession: null }));
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            const first = await spawnedVisit(h, 1);
            expect(first.childSessionId).toBe(agentSession);
            expect(first.prompt.split("\n")[0]).toContain("This agent session continues");
            expect(await completeAs(h, agentSession, { outcome: "again", output: { fact: "one" }, operation_id: "op-1", node_execution_id: first.nodeExecutionId }))
                .toMatchObject({ ok: true, outcome: "again" });
            const second = await spawnedVisit(h, 2);
            expect(second.childSessionId).toBe(agentSession);
            expect(second.prompt).toMatch(/^\[SYSTEM: WORKFLOW NODE INVOCATION, CYCLE 2\./);
            expect(await completeAs(h, agentSession, { outcome: "finish", output: { fact: "two" }, operation_id: "op-2", node_execution_id: second.nodeExecutionId }))
                .toMatchObject({ ok: true, outcome: "finish" });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
            expect((await eventsOf(h, run.workflowSessionId, "workflow.agent_spawned")).map(data => [data.childSessionId, data.session, data.cycle]))
                .toEqual([[agentSession, "continue", 1], [agentSession, "continue", 2]]);
            expect((await readWorkflowView(h.store, run.workflowSessionId)).graph.states.find(state => state.id === "talk")).toMatchObject({ session: "continue" });
        } finally {
            await h.stop();
        }
    });

    it("an explicit session: new gets a new agent session each visit", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const run = await started(h, SESSION_YAML({ agentSession: "new" }));
            const first = await spawnedVisit(h, 1);
            expect(first.childSessionId).toBe(workflowAgentChildSessionId(first.nodeExecutionId));
            expect(first.prompt.split("\n")[0]).not.toContain("This agent session continues");
            expect(await completeAs(h, first.childSessionId, { outcome: "again", output: { fact: "one" }, operation_id: "op-1" })).toMatchObject({ ok: true });
            const second = await spawnedVisit(h, 2);
            expect(second.childSessionId).toBe(workflowAgentChildSessionId(second.nodeExecutionId));
            expect(second.childSessionId).not.toBe(first.childSessionId);
            expect(await completeAs(h, second.childSessionId, { outcome: "finish", output: { fact: "two" }, operation_id: "op-2" })).toMatchObject({ ok: true });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
            expect((await eventsOf(h, run.workflowSessionId, "workflow.agent_spawned")).map(data => data.session ?? null)).toEqual([null, null]);
            expect((await readWorkflowView(h.store, run.workflowSessionId)).graph.states.find(state => state.id === "talk")).not.toHaveProperty("session");
        } finally {
            await h.stop();
        }
    });

    it("a For each body's agent state that sets no session gets a new agent session for each item", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const run = await started(h, FOR_EACH_YAML);
            const items = [await spawnedVisit(h, 1), await spawnedVisit(h, 2)];
            for (const item of items) expect(item.childSessionId).toBe(workflowAgentChildSessionId(item.nodeExecutionId));
            expect(new Set(items.map(item => item.childSessionId)).size).toBe(2);
            for (const [index, item] of items.entries()) {
                expect(await completeAs(h, item.childSessionId, { outcome: "said", output: { fact: String(index) }, operation_id: `op-${index}` }))
                    .toMatchObject({ ok: true, outcome: "said" });
            }
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
            expect((await eventsOf(h, run.workflowSessionId, "workflow.agent_spawned")).map(data => data.session ?? null)).toEqual([null, null]);
        } finally {
            await h.stop();
        }
    });
});

describe("session: continue on the controller", () => {
    it("two visits share one session; the second is cycle 2 with the variables now; a time limit stops the turn, not the session; the owner session ends once with the Workflow", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const run = await started(h, SESSION_YAML({ limit: `"\${kv.limit}"` }), { limit: 3 });
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            const first = await spawnedVisit(h, 1);
            expect(first.childSessionId).toBe(agentSession);
            const [system1, json1] = first.prompt.split("\n");
            expect(system1).toContain("This agent session continues");
            expect(system1).toContain(`(this one's is ${first.nodeExecutionId})`);
            expect(JSON.parse(json1)).not.toHaveProperty("cycle");
            // Q1: without node_execution_id, the completion is refused in words and decides nothing.
            expect(await completeAs(h, agentSession, { outcome: "again", output: { fact: "one" }, operation_id: "op-0" }))
                .toMatchObject({ ok: false, error: { code: "AGENT_NODE_NOT_FOUND", message: expect.stringContaining("give node_execution_id") } });
            // The variables change before the first visit's 3-second time limit passes: the next visit reads them.
            await controlWorkflowRun(h.host, run.workflowSessionId,
                { operation: "set_vars", runId: null, set: { limit: 3600, topic: "postgres" }, delete: [], expectedKvRevision: 1 },
                { actor: ACTOR, operationId: "vars-1" });

            const second = await spawnedVisit(h, 2);
            expect(second.childSessionId).toBe(agentSession);
            expect(second.nodeExecutionId).not.toBe(first.nodeExecutionId);
            const [system2, json2, taskLine2, task2] = second.prompt.split("\n");
            expect(system2).toMatch(/^\[SYSTEM: WORKFLOW NODE INVOCATION, CYCLE 2\. This is cycle 2 of the same workflow state in this run/);
            expect(system2).toContain(`node_execution_id ${second.nodeExecutionId} (this cycle's)`);
            expect(JSON.parse(json2)).toMatchObject({
                cycle: 2, nodeExecutionId: second.nodeExecutionId, stateId: "talk",
                variables: { limit: 3600, topic: "postgres" }, changedVariables: ["limit", "topic"],
                previousResult: { outcome: "timed_out", resultKind: "runtime_error" },
            });
            expect(taskLine2).toContain("The task of this state");
            expect(task2).toBe(TASK);
            // Q2: the first visit's time limit stopped its turn (a Stop), never the session; both prompts reached the one session.
            expect(h.stops).toContainEqual(expect.objectContaining({ sessionId: agentSession, kind: "stop", requestId: `workflow-cycle-stop:${first.nodeExecutionId}` }));
            const prompts = await until(async () => {
                const messages = await ownerMessages(h, agentSession);
                return messages.length >= 2 ? messages : null;
            }, "both prompts in the session");
            expect(prompts.map(message => message.prompt)).toEqual([first.prompt, second.prompt]);
            expect(await commandsOf(h, agentSession)).toEqual([]);

            // A late answer of the first visit is refused; the second visit is unaffected.
            expect(await completeAs(h, agentSession, { outcome: "finish", output: { fact: "late" }, operation_id: "late-1", node_execution_id: first.nodeExecutionId }))
                .toMatchObject({ ok: false, error: { code: "NODE_CLOSED" } });
            expect(await h.store.readNodeExecution(second.nodeExecutionId)).toMatchObject({ state: "pending" });
            expect(await completeAs(h, agentSession, { outcome: "finish", output: { fact: "two" }, operation_id: "op-2", node_execution_id: second.nodeExecutionId }))
                .toMatchObject({ ok: true, nodeExecutionId: second.nodeExecutionId, outcome: "finish" });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });

            // The session is ended once, when the Workflow ends: done, by its last visit's own result.
            expect(await agentSessionEnd(h, agentSession)).toMatchObject({ type: "cmd", cmd: "done", id: `workflow-agent-session-end:${agentSession}`, requestedBy: run.workflowSessionId });
            await pause(1_000);
            expect(await commandsOf(h, agentSession)).toHaveLength(1);
            expect(h.spawns).toHaveLength(2);
            expect((await eventsOf(h, run.workflowSessionId, "workflow.agent_cycle_ended")).map(data => data.nodeExecutionId))
                .toEqual([first.nodeExecutionId, second.nodeExecutionId]);
            expect(await eventsOf(h, run.workflowSessionId, "workflow.agent_ended"))
                .toEqual([expect.objectContaining({ childSessionId: agentSession, end: "done", sent: true, session: "continue" })]);
            expect((await eventsOf(h, run.workflowSessionId, "workflow.agent_spawned")).map(data => [data.childSessionId, data.session, data.cycle]))
                .toEqual([[agentSession, "continue", 1], [agentSession, "continue", 2]]);

            // Finding 7: the read view says what the agent is told and when each visit started and ended (the Node panel's lines).
            const view = await readWorkflowView(h.store, run.workflowSessionId);
            expect(view.graph.states.find(state => state.id === "talk")).toMatchObject({ type: "agent", session: "continue", about: { prompt: TASK } });
            expect(view.graph.states.find(state => state.id === "pause")).not.toHaveProperty("about");
            for (const visit of view.run.nodeExecutions.filter(node => node.stateId === "talk")) {
                expect(Number.isFinite(Date.parse(visit.enteredAt)), JSON.stringify(visit)).toBe(true);
                expect(Date.parse(visit.endedAt)).toBeGreaterThanOrEqual(Date.parse(visit.enteredAt));
            }
        } finally {
            await h.stop();
        }
    });

    it("RT-7: a KV read that fails is not read as no variables: the spawn retries before it sends, and the prompt has the variables now", { timeout: TIMEOUT }, async () => {
        // Once the variables changed, the first read of KV revision 1 (the cycle's read of the previous visit's
        // variables; admissions read the current revision) fails once. Swallowed, it would read as no variables, and
        // `keep`, which did not change, would be reported changed.
        let armed = false;
        let failures = 0;
        const h = await harness(getEnv(), { storeHooks: {
            readKv: (result, [, revision]) => {
                if (armed && revision === 1 && failures === 0) {
                    failures += 1;
                    throw new Error("a transient read failure");
                }
                return result;
            },
        } });
        try {
            const run = await started(h, SESSION_YAML({ limit: `"\${kv.limit}"` }), { limit: 3, keep: "x" });
            await spawnedVisit(h, 1);
            await controlWorkflowRun(h.host, run.workflowSessionId,
                { operation: "set_vars", runId: null, set: { limit: 3600, topic: "postgres" }, delete: [], expectedKvRevision: 1 },
                { actor: ACTOR, operationId: "vars-1" });
            armed = true;
            const second = await spawnedVisit(h, 2);
            expect(failures).toBe(1);
            expect(JSON.parse(second.prompt.split("\n")[1])).toMatchObject({
                cycle: 2, variables: { limit: 3600, topic: "postgres", keep: "x" }, changedVariables: ["limit", "topic"],
            });
            expect(h.spawns).toHaveLength(2);
            await controlWorkflowRun(h.host, run.workflowSessionId, { operation: "cancel", runId: null, reason: "done" }, { actor: ACTOR, operationId: "cancel-rt7" });
            expect(await ended(h, run.runId)).toMatchObject({ status: "cancelled" });
        } finally {
            await h.stop();
        }
    });

    it("a cancel ends the session; a graceful stop ends an idle session at once", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            // A cancel while the session is idle between visits: the owner session ends with its last visit's result (done).
            const idle = await started(h, SESSION_YAML({ wait: 600 }));
            const idleSession = workflowAgentSessionId(idle.runId, "talk");
            const first = await spawnedVisit(h, 1);
            expect(await completeAs(h, idleSession, { outcome: "again", output: { fact: "one" }, operation_id: "op-1", node_execution_id: first.nodeExecutionId }))
                .toMatchObject({ ok: true });
            await until(async () => (await h.store.listNodeExecutions(idle.runId)).some(node => node.nodeId === "pause"), "the wait between visits");
            await controlWorkflowRun(h.host, idle.workflowSessionId, { operation: "cancel", runId: null, reason: "enough" }, { actor: ACTOR, operationId: "cancel-1" });
            expect(await ended(h, idle.runId)).toMatchObject({ status: "cancelled" });
            expect(await agentSessionEnd(h, idleSession)).toMatchObject({ cmd: "done", id: `workflow-agent-session-end:${idleSession}` });

            // A cancel while a visit runs: the visit loses to the cancel, and the session is cancelled.
            const busy = await started(h, SESSION_YAML());
            const busySession = workflowAgentSessionId(busy.runId, "talk");
            const running = await spawnedVisit(h, 2);
            expect(running.childSessionId).toBe(busySession);
            await controlWorkflowRun(h.host, busy.workflowSessionId, { operation: "cancel", runId: null, reason: "enough" }, { actor: ACTOR, operationId: "cancel-2" });
            expect(await ended(h, busy.runId)).toMatchObject({ status: "cancelled" });
            expect(await agentSessionEnd(h, busySession)).toMatchObject({ cmd: "cancel", id: `workflow-agent-session-end:${busySession}` });

            // Q5: a graceful stop with a long grace: the idle session is not started work and is ended at once.
            const stopping = await started(h, SESSION_YAML({ wait: 600 }));
            const stoppingSession = workflowAgentSessionId(stopping.runId, "talk");
            const third = await spawnedVisit(h, 3);
            expect(third.childSessionId).toBe(stoppingSession);
            expect(await completeAs(h, stoppingSession, { outcome: "again", output: { fact: "x" }, operation_id: "op-3", node_execution_id: third.nodeExecutionId }))
                .toMatchObject({ ok: true });
            await until(async () => (await h.store.listNodeExecutions(stopping.runId)).some(node => node.nodeId === "pause"), "the wait between visits");
            const asked = Date.now();
            await controlWorkflowRun(h.host, stopping.workflowSessionId, { operation: "stop", runId: null, reason: "enough", graceSeconds: 300 },
                { actor: ACTOR, operationId: "stop-1" });
            expect(await agentSessionEnd(h, stoppingSession)).toMatchObject({ cmd: "done", id: `workflow-agent-session-end:${stoppingSession}` });
            expect(Date.now() - asked).toBeLessThan(60_000);
            await controlWorkflowRun(h.host, stopping.workflowSessionId, { operation: "cancel", runId: null, reason: "done" }, { actor: ACTOR, operationId: "cancel-3" })
                .catch(() => {});
            await ended(h, stopping.runId);
            await pause(1_000);
            expect(await commandsOf(h, stoppingSession)).toHaveLength(1);
        } finally {
            await h.stop();
        }
    });

    it("Q4: a session that ended on its own between visits is replaced by a new session; its first prompt and the log say so", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const run = await started(h, SESSION_YAML({ wait: 2 }));
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            const first = await spawnedVisit(h, 1);
            // A person deletes the session; then the visit's result arrives.
            await h.catalog.softDeleteSession(agentSession);
            expect(await completeAs(h, agentSession, { outcome: "again", output: { fact: "one" }, operation_id: "op-1", node_execution_id: first.nodeExecutionId }))
                .toMatchObject({ ok: true });
            const second = await spawnedVisit(h, 2);
            const replacement = workflowAgentSessionId(run.runId, "talk", 2);
            expect(second.childSessionId).toBe(replacement);
            expect(replacement).not.toBe(agentSession);
            const [system2, json2] = second.prompt.split("\n");
            expect(system2).toContain("This agent session continues");
            expect(system2).toContain(`The agent session of its earlier cycles ended (session ${agentSession})`);
            expect(JSON.parse(json2)).toMatchObject({ cycle: 2, nodeExecutionId: second.nodeExecutionId, previousResult: { outcome: "again", output: { fact: "one" } } });
            expect(await eventsOf(h, run.workflowSessionId, "workflow.agent_session_restarted"))
                .toEqual([expect.objectContaining({ endedSessionId: agentSession, childSessionId: replacement, cycle: 2, stateId: "talk" })]);
            expect(await completeAs(h, replacement, { outcome: "finish", output: { fact: "two" }, operation_id: "op-2", node_execution_id: second.nodeExecutionId }))
                .toMatchObject({ ok: true });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed" });
            expect(await agentSessionEnd(h, replacement)).toMatchObject({ cmd: "done", id: `workflow-agent-session-end:${replacement}` });
        } finally {
            await h.stop();
        }
    });
    for (const [label, endAgentSession, gone] of [
        ["deleted", async (h, agentSession) => {
            await h.catalog.softDeleteSession(agentSession);
            await h.client.cancelInstance(`session-${agentSession}`, "deleted by a person");
        }, "deleted"],
        ["ended", async (h, agentSession) => {
            await h.client.cancelInstance(`session-${agentSession}`, "ended by a person");
        }, "ended"],
    ]) {
        it(`G1: a session ${label} by a person after the next visit's admission gets no prompt: the visit fails unavailable at once, and a deleted session stays deleted`, { timeout: TIMEOUT }, async () => {
            // Fault injection: the session is deleted or ended as the second visit's spawn begins (after its admission chose it).
            let beforeSpawn = null;
            const h = await harness(getEnv(), {
                createAlways: true,
                storeBefore: { beginAgentSpawn: async ([nodeExecutionId]) => {
                    if (beforeSpawn) {
                        const hook = beforeSpawn;
                        beforeSpawn = null;
                        await hook(nodeExecutionId);
                    }
                } },
            });
            try {
                const run = await started(h, SESSION_YAML());
                const agentSession = workflowAgentSessionId(run.runId, "talk");
                const first = await spawnedVisit(h, 1);
                let second = null;
                beforeSpawn = async (nodeExecutionId) => {
                    second = nodeExecutionId;
                    await endAgentSession(h, agentSession);
                    await until(async () => ["Completed", "Failed", "Terminated"].includes((await h.client.getStatus(`session-${agentSession}`)).status),
                        "the session's orchestration to end");
                };
                expect(await completeAs(h, agentSession, { outcome: "again", output: { fact: "one" }, operation_id: "op-1", node_execution_id: first.nodeExecutionId }))
                    .toMatchObject({ ok: true });
                const asked = Date.now();
                expect(await ended(h, run.runId)).toMatchObject({ status: "failed", terminalOutcome: "failed" });
                expect(Date.now() - asked).toBeLessThan(30_000);
                expect(second).not.toBeNull();
                expect(await h.store.readNodeExecution(second)).toMatchObject({ state: "completed", outcome: "unavailable", winner: "controller",
                    error: { code: "unavailable", message: expect.stringContaining(`The agent session ${agentSession} that this step continues was ${gone}`),
                        details: { childSessionId: agentSession } } });
                // Nothing was sent to it, and the host was not asked: a deleted session is not brought back.
                expect(h.spawns).toHaveLength(1);
                expect(await h.store.isSessionDeleted(agentSession)).toBe(label === "deleted");
                expect((await eventsOf(h, run.workflowSessionId, "workflow.agent_spawned")).map(data => data.nodeExecutionId)).toEqual([first.nodeExecutionId]);
            } finally {
                await h.stop();
            }
        });
    }
    // G1 residual (TLA+ limit.cc-g1-end-during-turn): a person ends the agent session while one of its turns runs. The
    // command waits in the session's queue and its orchestration reads Running (the test double never ends: its turn is
    // "still running"). The end's mark is recorded first, so the next visit does not reuse the ending session: it gets a
    // new agent session (the visit's number in its id) and completes; its prompt is not queued behind the end.
    it("G1 residual: a session a person ends while its turn runs is not reused by the next visit, which gets a new session and completes", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await harness(env);
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
        await mgmt.start();
        try {
            const run = await started(h, SESSION_YAML({ limit: `"\${kv.limit}"` }), { limit: 3 });
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            const first = await spawnedVisit(h, 1);
            expect(first.childSessionId).toBe(agentSession);
            // The person ends it while its (first visit's) turn runs: the command is queued; the session still reads Running.
            await mgmt.completeSession(agentSession, "ended by a person", { wait: false });
            expect((await h.client.getStatus(`session-${agentSession}`)).status).toBe("Running");
            expect((await h.catalog.getSessionEvents(agentSession, 0, 100, ["session.end_requested"])).map(event => event.data))
                .toEqual([expect.objectContaining({ cmd: "done" })]);
            await controlWorkflowRun(h.host, run.workflowSessionId,
                { operation: "set_vars", runId: null, set: { limit: 3600 }, delete: [], expectedKvRevision: 1 }, { actor: ACTOR, operationId: "vars-g1r" });
            // The first visit is decided by its time limit; the next visit goes to a new agent session.
            const second = await spawnedVisit(h, 2);
            const replacement = workflowAgentSessionId(run.runId, "talk", 2);
            expect(second.childSessionId).toBe(replacement);
            expect(await h.store.readNodeExecution(first.nodeExecutionId)).toMatchObject({ outcome: "timed_out" });
            expect(await eventsOf(h, run.workflowSessionId, "workflow.agent_session_restarted"))
                .toEqual([expect.objectContaining({ endedSessionId: agentSession, childSessionId: replacement, cycle: 2 })]);
            // Nothing more went to the ending session after its end; the next visit completes in the new one. Review DRR-2:
            // the Workflow carried the marked end too (its own id): a second end, which the session never reads, fails nothing.
            const sent = await ownerMessages(h, agentSession);
            expect(sent.map(message => message.prompt ?? message.cmd)).toEqual([first.prompt, "done", "done"]);
            const mark = await h.store.readSessionEndMark(agentSession);
            expect(sent[2]).toMatchObject({ type: "cmd", cmd: "done", id: `workflow-mark-end:${mark.id}`, requestedBy: run.workflowSessionId,
                args: { reason: "A person asked to end this session." } });
            expect(await completeAs(h, replacement, { outcome: "finish", output: { fact: "two" }, operation_id: "op-2", node_execution_id: second.nodeExecutionId }))
                .toMatchObject({ ok: true, outcome: "finish" });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });

    // Review DRR-1: the spawn's check is a read; the create and the send come after it. A deletion that lands between them
    // must not be undone by the create (cms_create_session revives a deleted row; the Workflow's create refuses it), and an
    // end asked between them must not leave the visit waiting for a prompt that sits behind that end (the send-side guard).
    for (const label of ["deleted", "ended"]) {
        it(`DRR-1: an agent session ${label} after the next visit's check and before its create is not brought back, and the visit fails unavailable at once`, { timeout: TIMEOUT }, async () => {
            const env = getEnv();
            let gate = null;
            const h = await harness(env, { realHost: true, beforeCreate: async spec => {
                if (gate) {
                    const hook = gate;
                    gate = null;
                    await hook(spec);
                }
            } });
            const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
            await mgmt.start();
            try {
                const run = await started(h, SESSION_YAML());
                const agentSession = workflowAgentSessionId(run.runId, "talk");
                const first = await spawnedVisit(h, 1);
                gate = async spec => {
                    expect(spec.sessionId).toBe(agentSession);
                    if (label === "deleted") {
                        await h.catalog.softDeleteSession(agentSession);
                        await h.client.cancelInstance(`session-${agentSession}`, "deleted by a person");
                    } else {
                        await mgmt.completeSession(agentSession, "ended by a person", { wait: false });
                    }
                };
                expect(await completeAs(h, agentSession, { outcome: "again", output: { fact: "one" }, operation_id: "op-1", node_execution_id: first.nodeExecutionId }))
                    .toMatchObject({ ok: true });
                const asked = Date.now();
                expect(await ended(h, run.runId)).toMatchObject({ status: "failed", terminalOutcome: "failed" });
                expect(Date.now() - asked).toBeLessThan(30_000);
                expect(gate).toBeNull();
                const second = await visit(h, 2);
                expect(second.childSessionId).toBe(agentSession);
                expect(await h.store.readNodeExecution(second.nodeExecutionId)).toMatchObject({ state: "completed", outcome: "unavailable", winner: "controller",
                    error: { code: "unavailable", message: expect.stringContaining(`The agent session ${agentSession} of this step was`),
                        details: { childSessionId: agentSession } } });
                expect((await eventsOf(h, run.workflowSessionId, "workflow.agent_spawned")).map(data => data.nodeExecutionId)).toEqual([first.nodeExecutionId]);
                if (label === "deleted") {
                    // The create refused the deleted session: it stays deleted, and nothing was sent to it.
                    expect(await h.store.isSessionDeleted(agentSession)).toBe(true);
                    expect((await ownerMessages(h, agentSession)).filter(message => message.prompt).map(message => message.prompt)).toEqual([first.prompt]);
                } else {
                    // The prompt went behind the end, which ends the session; the visit was decided as it was sent.
                    expect(await h.store.isSessionDeleted(agentSession)).toBe(false);
                    const sent = (await ownerMessages(h, agentSession)).map(message => message.prompt ?? message.cmd);
                    expect(sent.slice(0, 3)).toEqual([first.prompt, "done", second.prompt]);
                }
            } finally {
                await mgmt.stop();
                await h.stop();
            }
        });
    }
    // Review DRR-1b: a person deletes the agent session after the spawn's create and before its send. The session has no
    // orchestration yet, so the delete is a catalog delete only, and the send then starts its orchestration. The visit is
    // decided unavailable (the send-side guard), the row stays deleted, and the Workflow ends that orchestration.
    it("DRR-1b: a session deleted between its create and its first send is ended, stays deleted, and its visit is unavailable", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        let gate = null;
        const h = await harness(env, { realHost: true, beforeSend: async spec => {
            if (gate) {
                const hook = gate;
                gate = null;
                await hook(spec);
            }
        } });
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
        await mgmt.start();
        try {
            let deleted = null;
            gate = async spec => {
                expect((await h.client.getStatus(`session-${spec.sessionId}`)).status).toBe("NotFound");
                await mgmt.deleteSession(spec.sessionId, "deleted by a person");
                deleted = spec.sessionId;
            };
            const run = await started(h, SESSION_YAML());
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            expect(await ended(h, run.runId)).toMatchObject({ status: "failed", terminalOutcome: "failed" });
            expect(deleted).toBe(agentSession);
            const first = await visit(h, 1);
            expect(await h.store.readNodeExecution(first.nodeExecutionId)).toMatchObject({ state: "completed", outcome: "unavailable", winner: "controller",
                error: { code: "unavailable", message: expect.stringContaining(`The agent session ${agentSession} of this step was deleted`) } });
            expect(await h.store.isSessionDeleted(agentSession)).toBe(true);
            // The orchestration the send started is ended by the Workflow's carried delete.
            const status = await until(async () => {
                const read = (await h.client.getStatus(`session-${agentSession}`)).status;
                return read !== "Running" ? read : null;
            }, "the deleted session's orchestration to end", 30_000);
            expect(["Completed", "Failed", "Terminated"]).toContain(status);
            expect((await ownerMessages(h, agentSession)).find(message => message.type === "cmd"))
                .toMatchObject({ cmd: "delete", id: `workflow-deleted-end:${agentSession}`, requestedBy: run.workflowSessionId });
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });
    // Review DRR-1c: right after the spawn's own send the session's start is only queued and its first turn has not run, so
    // its status reads NotFound. The carried delete is still queued: duroxide delivers it with the queued start, and the
    // session's first turn applies it before any model turn. (Here the status read right after the send says NotFound.)
    it("DRR-1c: a deleted session that reads NotFound right after its send still gets the carried delete and ends", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        let gate = null;
        let h = null;
        const notFoundOnce = new Set();
        h = await harness(env, {
            realHost: true,
            beforeSend: async spec => {
                if (gate) {
                    const hook = gate;
                    gate = null;
                    await hook(spec);
                }
            },
            activityClient: own => new Proxy(own, { get(target, key) {
                if (key === "getStatus") {
                    return async instanceId => {
                        const id = instanceId.startsWith("session-") ? instanceId.slice("session-".length) : null;
                        if (id !== null && h.sentTo.has(id) && !notFoundOnce.has(id)) {
                            notFoundOnce.add(id);
                            return { status: "NotFound" };
                        }
                        return target.getStatus(instanceId);
                    };
                }
                const value = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
            } }),
        });
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
        await mgmt.start();
        try {
            gate = async spec => { await mgmt.deleteSession(spec.sessionId, "deleted by a person"); };
            const run = await started(h, SESSION_YAML());
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            expect(await ended(h, run.runId)).toMatchObject({ status: "failed", terminalOutcome: "failed" });
            // The status read right after the send said NotFound.
            expect(notFoundOnce.has(agentSession)).toBe(true);
            const first = await visit(h, 1);
            expect(await h.store.readNodeExecution(first.nodeExecutionId)).toMatchObject({ state: "completed", outcome: "unavailable", winner: "controller",
                error: { code: "unavailable", message: expect.stringContaining(`The agent session ${agentSession} of this step was deleted`) } });
            expect(await h.store.isSessionDeleted(agentSession)).toBe(true);
            // The carried delete reached the session, and its orchestration ended.
            const status = await until(async () => {
                const read = (await h.client.getStatus(`session-${agentSession}`)).status;
                return read !== "Running" ? read : null;
            }, "the deleted session's orchestration to end", 30_000);
            expect(["Completed", "Failed", "Terminated"]).toContain(status);
            const received = await h.client.getStatus(`session-${agentSession}`);
            const messages = typeof received.customStatus === "string" && received.customStatus ? JSON.parse(received.customStatus) : [];
            expect(messages.find(message => message.type === "cmd")).toMatchObject({ cmd: "delete", id: `workflow-deleted-end:${agentSession}`, requestedBy: run.workflowSessionId });
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });
    // Review DR2-003: an end asked of the agent session between its create and its first send leaves a mark; its own
    // command was never queued (the session had no orchestration). Right after the send the session reads NotFound (its
    // start is queued, its first turn has not run). The Workflow acts on the mark (the visit is unavailable) and still
    // carries the marked end, queued after the start, so the session receives it.
    it("DR2-003: a marked end whose session reads NotFound right after its send is still carried, after the start", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        let gate = null;
        let h = null;
        const notFoundOnce = new Set();
        h = await harness(env, {
            realHost: true,
            beforeSend: async spec => {
                if (gate) {
                    const hook = gate;
                    gate = null;
                    await hook(spec);
                }
            },
            activityClient: own => new Proxy(own, { get(target, key) {
                if (key === "getStatus") {
                    return async instanceId => {
                        const id = instanceId.startsWith("session-") ? instanceId.slice("session-".length) : null;
                        if (id !== null && h.sentTo.has(id) && !notFoundOnce.has(id)) {
                            notFoundOnce.add(id);
                            return { status: "NotFound" };
                        }
                        return target.getStatus(instanceId);
                    };
                }
                const value = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
            } }),
        });
        try {
            // A real mark, as a person's cancel records it; its own command is not queued.
            gate = async spec => { await recordSessionEndRequested(h.catalog, spec.sessionId, { cmd: "cancel", id: "person-cancel-before-start" }); };
            const run = await started(h, SESSION_YAML());
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            expect(await ended(h, run.runId)).toMatchObject({ status: "failed", terminalOutcome: "failed" });
            expect(notFoundOnce.has(agentSession)).toBe(true);
            const first = await visit(h, 1);
            expect(await h.store.readNodeExecution(first.nodeExecutionId)).toMatchObject({ state: "completed", outcome: "unavailable", winner: "controller",
                error: { code: "unavailable", message: expect.stringContaining(`The agent session ${agentSession} of this step was ended`) } });
            // The carried cancel reached the session, after its start and first prompt.
            const carried = await until(async () => {
                const messages = await ownerMessages(h, agentSession);
                const at = messages.findIndex(message => message.type === "cmd" && message.id === "workflow-mark-end:person-cancel-before-start");
                return at >= 0 ? { at, messages } : null;
            }, "the carried cancel", 30_000);
            expect(carried.messages[carried.at]).toMatchObject({ cmd: "cancel", requestedBy: run.workflowSessionId, args: { reason: "A person asked to end this session." } });
            expect(carried.messages.findIndex(message => message.prompt === first.prompt)).toBeLessThan(carried.at);
        } finally {
            await h.stop();
        }
    });
    // Review DRR-1: an attempt created the session and stopped before recording it; a person deleted the session during the
    // retry's backoff. The retry does not create it again: a first visit, and a replacement session, are checked too.
    for (const which of ["first", "replacement"]) {
        it(`DRR-1: a ${which} visit's spawn that created its session and stopped before recording it does not bring the session back after a deletion`, { timeout: TIMEOUT }, async () => {
            const env = getEnv();
            let crashAt = which === "first" ? 1 : 2;
            let records = 0;
            let h = null;
            h = await harness(env, { realHost: true, storeBefore: { recordAgentSpawned: async () => {
                records += 1;
                if (records !== crashAt) return;
                crashAt = 0;
                // The worker stops after the create and the send, before the record; then a person deletes the session.
                const made = h.spawns.at(-1).childSessionId;
                await h.catalog.softDeleteSession(made);
                await h.client.cancelInstance(`session-${made}`, "deleted by a person");
                throw new Error("the worker stopped before recording the spawn");
            } } });
            try {
                const run = await started(h, SESSION_YAML());
                const agentSession = workflowAgentSessionId(run.runId, "talk");
                let target = agentSession;
                if (which === "replacement") {
                    const first = await spawnedVisit(h, 1);
                    await h.catalog.softDeleteSession(agentSession);
                    expect(await completeAs(h, agentSession, { outcome: "again", output: { fact: "one" }, operation_id: "op-1", node_execution_id: first.nodeExecutionId }))
                        .toMatchObject({ ok: true });
                    target = workflowAgentSessionId(run.runId, "talk", 2);
                }
                expect(await ended(h, run.runId)).toMatchObject({ status: "failed", terminalOutcome: "failed" });
                const visitOf = which === "first" ? 1 : 2;
                const request = await visit(h, visitOf);
                expect(request.childSessionId).toBe(target);
                expect(await h.store.readNodeExecution(request.nodeExecutionId)).toMatchObject({ state: "completed", outcome: "unavailable", winner: "controller",
                    error: { code: "unavailable", message: expect.stringContaining(`The agent session ${target} of this step was deleted before its prompt was sent`) } });
                // The retry asked the host for nothing more, and the session stays deleted.
                expect(h.spawns).toHaveLength(visitOf);
                expect(await h.store.isSessionDeleted(target)).toBe(true);
            } finally {
                await h.stop();
            }
        });
    }

    // Review DRR-2: the mark commits and the asker's command is not queued (its queue write throws, or its process stops
    // after the mark). The Workflow acts on the mark (the next visit gets a new agent session) and carries the end itself:
    // the old session receives it, so it never stays live beside its replacement.
    for (const label of ["the queue write throws", "the asker stops after the mark"]) {
        it(`DRR-2: when ${label}, the next visit replaces the session and the old session still receives the marked end`, { timeout: TIMEOUT }, async () => {
            const env = getEnv();
            const h = await harness(env);
            const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
            await mgmt.start();
            try {
                const run = await started(h, SESSION_YAML({ limit: `"\${kv.limit}"` }), { limit: 3 });
                const agentSession = workflowAgentSessionId(run.runId, "talk");
                const first = await spawnedVisit(h, 1);
                if (label === "the queue write throws") {
                    const enqueue = mgmt._duroxideClient.enqueueEvent;
                    mgmt._duroxideClient.enqueueEvent = async () => { throw new Error("the queue write failed"); };
                    try {
                        await expect(mgmt.cancelSession(agentSession, "ended by a person")).rejects.toThrow(/the queue write failed/);
                    } finally {
                        mgmt._duroxideClient.enqueueEvent = enqueue;
                    }
                } else {
                    await recordSessionEndRequested(h.catalog, agentSession, { cmd: "cancel", id: "person-cancel-1" });
                }
                const mark = await h.store.readSessionEndMark(agentSession);
                expect(mark).toMatchObject({ cmd: "cancel", requestedBy: null });
                // The asker's command never reached the session.
                expect(await commandsOf(h, agentSession)).toEqual([]);
                await controlWorkflowRun(h.host, run.workflowSessionId,
                    { operation: "set_vars", runId: null, set: { limit: 3600 }, delete: [], expectedKvRevision: 1 }, { actor: ACTOR, operationId: "vars-drr2" });
                const second = await spawnedVisit(h, 2);
                const replacement = workflowAgentSessionId(run.runId, "talk", 2);
                expect(second.childSessionId).toBe(replacement);
                // The Workflow carried the marked end before it acted on the mark.
                const carried = await agentSessionEnd(h, agentSession);
                expect(carried).toMatchObject({ type: "cmd", cmd: "cancel", id: `workflow-mark-end:${mark.id}`, requestedBy: run.workflowSessionId,
                    args: { reason: "A person asked to end this session." } });
                expect((await ownerMessages(h, agentSession)).filter(message => message.prompt).map(message => message.prompt)).toEqual([first.prompt]);
                expect(await completeAs(h, replacement, { outcome: "finish", output: { fact: "two" }, operation_id: "op-2", node_execution_id: second.nodeExecutionId }))
                    .toMatchObject({ ok: true, outcome: "finish" });
                expect(await ended(h, run.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
            } finally {
                await mgmt.stop();
                await h.stop();
            }
        });
    }

    it("G2: a visit whose turn Stop failed past its retries is ended before the next visit's prompt is sent; a failure there retries the spawn", { timeout: TIMEOUT }, async () => {
        // Fault injection: the first visit's Stop fails 5 times (the controller's end of that visit gives up), and then once
        // more as the second visit's spawn ends it (that attempt fails, and its retry ends it).
        let firstVisit = null;
        let failures = 0;
        const endSentAtSpawn = [];
        const h = await harness(getEnv(), {
            beforeStop: async ({ requestId }) => {
                if (firstVisit && requestId === `workflow-cycle-stop:${firstVisit}` && failures < 6) {
                    failures += 1;
                    throw new Error(`injected: Stop ${failures} of the first visit fails`);
                }
            },
            beforeCreate: async request => {
                if (firstVisit && request.nodeExecutionId !== firstVisit) endSentAtSpawn.push((await h.store.readAgentInvocation(firstVisit))?.endSentAt ?? null);
            },
        });
        try {
            const run = await started(h, SESSION_YAML({ limit: `"\${kv.limit}"` }), { limit: 2 });
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            firstVisit = (await visit(h, 1)).nodeExecutionId;
            // The first visit is decided by its 2-second time limit; the next one has an hour.
            await controlWorkflowRun(h.host, run.workflowSessionId,
                { operation: "set_vars", runId: null, set: { limit: 3600 }, delete: [], expectedKvRevision: 1 }, { actor: ACTOR, operationId: "vars-1" });
            const second = await spawnedVisit(h, 2);
            expect(second.childSessionId).toBe(agentSession);
            expect(failures).toBe(6);
            // The first visit's Stop was added, and its end marked sent, before the second visit's prompt was sent.
            expect(h.stops.filter(stop => stop.requestId === `workflow-cycle-stop:${firstVisit}`))
                .toEqual([expect.objectContaining({ sessionId: agentSession, kind: "stop", spawnsBefore: 1 })]);
            expect(endSentAtSpawn.at(-1)).not.toBeNull();
            expect(await h.store.readAgentInvocation(firstVisit)).toMatchObject({ endChildStatus: "AgentSessionContinues" });
            expect(await h.store.readNodeExecution(firstVisit)).toMatchObject({ outcome: "timed_out" });
            // The second visit goes on: it is not timed out, and its agent's result decides it.
            expect(await h.store.readNodeExecution(second.nodeExecutionId)).toMatchObject({ state: "pending" });
            expect(await completeAs(h, agentSession, { outcome: "finish", output: { fact: "two" }, operation_id: "op-2", node_execution_id: second.nodeExecutionId }))
                .toMatchObject({ ok: true, outcome: "finish" });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
        } finally {
            await h.stop();
        }
    });

    for (const session of ["continue", "new"]) {
        it(`G5: a cancel of the run while a visit's turn runs stops that turn before the agent session is ended (session: ${session})`, { timeout: TIMEOUT }, async () => {
            // The test double runs no turns: the turn Stop is the one the turn waits for; what matters is that it is added,
            // before the session's end command (a session takes a command only between turns).
            let h = null;
            const commandsAtStop = [];
            h = await harness(getEnv(), { beforeStop: async ({ sessionId }) => { commandsAtStop.push((await commandsOf(h, sessionId)).length); } });
            try {
                const run = await started(h, SESSION_YAML({ agentSession: session }));
                const first = await spawnedVisit(h, 1);
                const child = first.childSessionId;
                await controlWorkflowRun(h.host, run.workflowSessionId, { operation: "cancel", runId: null, reason: "enough" }, { actor: ACTOR, operationId: "cancel-g5" });
                expect(await ended(h, run.runId)).toMatchObject({ status: "cancelled" });
                const end = await until(async () => (await commandsOf(h, child))[0] ?? null, `the end of ${child}`, 30_000);
                expect(end).toMatchObject({ type: "cmd", cmd: "cancel" });
                expect(h.stops.filter(stop => stop.sessionId === child))
                    .toEqual([expect.objectContaining({ kind: "stop", requestId: `workflow-cycle-stop:${first.nodeExecutionId}` })]);
                expect(commandsAtStop).toEqual([0]);
            } finally {
                await h.stop();
            }
        });
    }

    it("PRR-3: visits are ordered by their ordinals, not the database clock: with visit 2 admitted at an earlier time, it is cycle 2 after visit 1, and a graceful stop keeps the session while visit 2 runs", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const direct = new pg.Pool({ connectionString: env.store, max: 2 });
        let firstVisit = null;
        let inverted = false;
        // Fault injection: as visit 2's spawn begins, its invocation's time is set a minute before visit 1's (the database
        // clock stepped back between the two admissions).
        const h = await harness(env, {
            storeBefore: { beginAgentSpawn: async ([nodeExecutionId]) => {
                if (!firstVisit || nodeExecutionId === firstVisit || inverted) return;
                inverted = true;
                await direct.query(`UPDATE "${env.cmsSchema}".workflow_agent_invocations SET created_at =
                    (SELECT created_at - interval '1 minute' FROM "${env.cmsSchema}".workflow_agent_invocations WHERE node_execution_id = $2)
                    WHERE node_execution_id = $1`, [nodeExecutionId, firstVisit]);
            } },
        });
        try {
            const run = await started(h, SESSION_YAML());
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            firstVisit = (await spawnedVisit(h, 1)).nodeExecutionId;
            expect(await completeAs(h, agentSession, { outcome: "again", output: { fact: "one" }, operation_id: "op-1", node_execution_id: firstVisit }))
                .toMatchObject({ ok: true });
            const second = await spawnedVisit(h, 2);
            expect(inverted).toBe(true);
            const [first2, second2] = await Promise.all([firstVisit, second.nodeExecutionId].map(nx => h.store.readAgentInvocation(nx)));
            expect(second2.createdAt.getTime()).toBeLessThan(first2.createdAt.getTime());
            // Visit 2's prompt is cycle 2, with visit 1's result as the previous one.
            const [system2, json2] = second.prompt.split("\n");
            expect(system2).toMatch(/^\[SYSTEM: WORKFLOW NODE INVOCATION, CYCLE 2\./);
            expect(JSON.parse(json2)).toMatchObject({ cycle: 2, previousResult: { outcome: "again", output: { fact: "one" } } });
            // The session's newest visit is visit 2.
            expect(await h.store.readAgentInvocationByChild(agentSession)).toMatchObject({ nodeExecutionId: second.nodeExecutionId });
            expect((await h.store.readAgentVisitsBefore(run.runId, "talk", null))).toMatchObject({ count: 2, previous: { nodeExecutionId: second.nodeExecutionId } });
            // A graceful stop with visit 2 running: the session is started work, so it is not ended.
            await controlWorkflowRun(h.host, run.workflowSessionId, { operation: "stop", runId: null, reason: "enough", graceSeconds: 300 },
                { actor: ACTOR, operationId: "stop-prr3" });
            await pause(3_000);
            expect(await commandsOf(h, agentSession)).toEqual([]);
            // Visit 2's own result ends it; then the session is ended once.
            expect(await completeAs(h, agentSession, { outcome: "finish", output: { fact: "two" }, operation_id: "op-2", node_execution_id: second.nodeExecutionId }))
                .toMatchObject({ ok: true });
            expect(await agentSessionEnd(h, agentSession)).toMatchObject({ cmd: "done", id: `workflow-agent-session-end:${agentSession}` });
            await ended(h, run.runId);
            await pause(1_000);
            expect(await commandsOf(h, agentSession)).toHaveLength(1);
        } finally {
            await h.stop();
            await direct.end();
        }
    });

    for (const [label, finish] of [
        ["the run completes", async (h, run, agentSession, nx) => {
            expect(await completeAs(h, agentSession, { outcome: "finish", output: { fact: "one" }, operation_id: "op-1", node_execution_id: nx }))
                .toMatchObject({ ok: true });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed" });
            return "done";
        }],
        ["the run is canceled", async (h, run) => {
            await controlWorkflowRun(h.host, run.workflowSessionId, { operation: "cancel", runId: null, reason: "enough" }, { actor: ACTOR, operationId: "cancel-rt1" });
            expect(await ended(h, run.runId)).toMatchObject({ status: "cancelled" });
            return "cancel";
        }],
    ]) {
        it(`RT-1: ${label} while a spawn that passed its check has not created the session: the end stays owed, and the after-send check ends the session once`, { timeout: TIMEOUT }, async () => {
            let release;
            const held = new Promise(resolve => { release = resolve; });
            const h = await harness(getEnv(), { beforeCreate: () => held });
            try {
                const run = await started(h, SESSION_YAML());
                const agentSession = workflowAgentSessionId(run.runId, "talk");
                const first = await visit(h, 1);
                const end = await finish(h, run, agentSession, first.nodeExecutionId);
                // The run's cleanup found no session, and an attempt that may still create it: the end is owed, not AgentSessionEnded.
                await until(async () => (await h.store.readAgentInvocation(first.nodeExecutionId))?.endChildStatus === "NotFound", "the owed end");
                expect((await h.client.getStatus(`session-${agentSession}`)).status).toBe("NotFound");
                release();
                expect(await agentSessionEndOrDiagnose(h, run, agentSession, [first.nodeExecutionId])).toMatchObject({ type: "cmd", cmd: end, id: `workflow-agent-session-end:${agentSession}`, requestedBy: run.workflowSessionId });
                await until(async () => (await h.store.readAgentInvocation(first.nodeExecutionId))?.endChildStatus === "AgentSessionEnded", "the owner session ended");
                await pause(1_000);
                expect(await commandsOf(h, agentSession)).toHaveLength(1);
                expect((await eventsOf(h, run.workflowSessionId, "workflow.agent_ended")).map(data => [data.sent, data.childStatus]))
                    .toEqual([[false, "NotFound"], [true, expect.any(String)]]);
            } finally {
                release?.();
                await h.stop();
            }
        });
    }

    it("RT-1 (formal t2): an older visit's late send creates the session after the run ended while the newest visit had no attempt: the session is ended", { timeout: TIMEOUT }, async () => {
        let release;
        const held = new Promise(resolve => { release = resolve; });
        let h = null;
        let firstVisit = null;
        const secondVisit = [];
        h = await harness(getEnv(), {
            // Visit 1's spawn passed its check and holds before it creates the session.
            beforeCreate: request => {
                firstVisit ??= request.nodeExecutionId;
                return request.nodeExecutionId === firstVisit ? held : undefined;
            },
            storeBefore: {
                // Visit 2 is admitted; before its spawn attempt begins, the run is canceled, so the attempt never begins
                // (beginAgentSpawn finds the visit decided). The hook does not wait for the cleanup: an activity that waited
                // here held a worker slot beside visit 1's held send, and the cleanup's activity could not run (c00519ae).
                async beginAgentSpawn([nodeExecutionId]) {
                    if (firstVisit === null || nodeExecutionId === firstVisit || secondVisit.length > 0) return;
                    secondVisit.push(nodeExecutionId);
                    const { workflowSessionId } = await h.store.readAgentInvocation(nodeExecutionId);
                    await controlWorkflowRun(h.host, workflowSessionId, { operation: "cancel", runId: null, reason: "enough" },
                        { actor: ACTOR, operationId: "cancel-t2" });
                },
            },
        });
        try {
            const run = await started(h, SESSION_YAML({ limit: "1", wait: 1 }));
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            const first = await visit(h, 1);
            // Visit 1 times out while its send is held; visit 2 is admitted to the same session (never created yet).
            await until(async () => (secondVisit.length > 0 ? secondVisit : null), "visit 2's spawn");
            expect(await ended(h, run.runId)).toMatchObject({ status: "cancelled" });
            // The run's cleanup (after the run's status) leaves the end owed on the newest visit, which began no attempt.
            let newest;
            try {
                newest = await until(async () => {
                    const invocation = await h.store.readAgentInvocation(secondVisit[0]);
                    return invocation?.endChildStatus === "NotFound" ? invocation : null;
                }, "the owed end on the newest visit, as the test reads it");
            } catch (error) {
                throw new Error(`${error.message}; diagnosis: ${await agentSessionEndDiagnosis(h, run, agentSession, [first.nodeExecutionId, secondVisit[0]])}`);
            }
            expect(newest).toMatchObject({ childSessionId: agentSession, spawnAttempts: 0, endChildStatus: "NotFound" });
            // Visit 1's host now creates the session; its after-send check finds the run ended and ends the session.
            release();
            expect(await agentSessionEndOrDiagnose(h, run, agentSession, [first.nodeExecutionId, secondVisit[0]])).toMatchObject({ type: "cmd", cmd: "cancel", id: `workflow-agent-session-end:${agentSession}` });
            await pause(1_000);
            expect(await commandsOf(h, agentSession)).toHaveLength(1);
            expect(h.spawns.map(request => request.nodeExecutionId)).toEqual([first.nodeExecutionId]);
        } finally {
            release?.();
            await h.stop();
        }
    });

    // Formal t3 (pse/wfv2/formal/agent-visible): a session the host created reads NotFound until its session's first turn has
    // run. While a continued session's end is owed, every looker keeps looking on its activity's retry schedule (the spawn's
    // after-send and decided paths, the run cleanup's detached retry), and the end is sent once, when the session is visible.
    // `looks` counts the looks that found no session (markContinuedSessionEnded with NotFound).
    const visibleLater = (extra = {}) => {
        const counter = { looks: 0 };
        const options = {
            deferVisible: true,
            storeHooks: {
                markContinuedSessionEnded(result, args) {
                    if (args[1] === "NotFound") counter.looks += 1;
                    return result;
                },
            },
            ...extra,
        };
        return { counter, options };
    };
    const status = async (h, instanceId) => (await h.client.getStatus(instanceId)).status;
    const endOnce = async (h, run, agentSession, nx, end) => {
        const command = await until(async () => (await commandsOf(h, agentSession))[0] ?? null, `the end of session ${agentSession}`, 90_000)
            .catch(async error => { throw new Error(`${error.message}; diagnosis: ${await agentSessionEndDiagnosis(h, run, agentSession, [nx])}`); });
        expect(command).toMatchObject({ type: "cmd", cmd: end, id: `workflow-agent-session-end:${agentSession}`, requestedBy: run.workflowSessionId });
        await until(async () => (await h.store.readAgentInvocationByChild(agentSession))?.endChildStatus === "AgentSessionEnded", "the owner session ended");
        await pause(3_000);
        expect(await commandsOf(h, agentSession)).toHaveLength(1);
        expect((await eventsOf(h, run.workflowSessionId, "workflow.agent_ended")).map(data => [data.sent, data.childStatus]))
            .toEqual([[false, "NotFound"], [true, expect.any(String)]]);
    };

    it("formal t3: a session that is NotFound for 3 looks after the run ended is ended once it is visible, by the spawn's after-send retries", { timeout: 180_000 }, async () => {
        let release;
        const held = new Promise(resolve => { release = resolve; });
        const { counter, options } = visibleLater({ beforeCreate: () => held });
        const h = await harness(getEnv(), options);
        try {
            const run = await started(h, SESSION_YAML());
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            const first = await visit(h, 1);
            await controlWorkflowRun(h.host, run.workflowSessionId, { operation: "cancel", runId: null, reason: "enough" }, { actor: ACTOR, operationId: "cancel-t3a" });
            expect(await ended(h, run.runId)).toMatchObject({ status: "cancelled" });
            await until(async () => (await h.store.readAgentInvocation(first.nodeExecutionId))?.endChildStatus === "NotFound", "the owed end");
            // The host creates the session; it is not visible yet. The looks go on, and the spawn keeps retrying.
            const before = counter.looks;
            release();
            await until(async () => (await h.store.readAgentInvocation(first.nodeExecutionId))?.spawnedAt ?? null, "the spawn recorded");
            await until(async () => counter.looks >= before + 3 || null, "3 more looks that found no session", 60_000);
            expect(await status(h, `session-${agentSession}`)).toBe("NotFound");
            expect(await status(h, `wfa-${first.nodeExecutionId}`)).toBe("Running");
            expect(await commandsOf(h, agentSession)).toEqual([]);
            await h.makeVisible(agentSession);
            await endOnce(h, run, agentSession, first.nodeExecutionId, "cancel");
            await until(async () => (await status(h, `wfa-${first.nodeExecutionId}`)) === "Completed" || null, "the spawn to end", 60_000);
            expect(h.spawns.map(request => request.nodeExecutionId)).toEqual([first.nodeExecutionId]);
        } finally {
            release?.();
            await h.stop();
        }
    });

    it("formal t3: a spawn that created the session and crashed before recording it keeps looking (spawnedAt empty) until the session is visible", { timeout: 180_000 }, async () => {
        let release;
        const held = new Promise(resolve => { release = resolve; });
        let crashed = 0;
        const { counter, options } = visibleLater({
            beforeCreate: () => held,
            // The attempt created the session, then stopped before it recorded the spawn (once).
            storeBefore: { async recordAgentSpawned() { if (crashed++ === 0) throw new Error("the worker stopped here"); } },
        });
        const h = await harness(getEnv(), options);
        try {
            const run = await started(h, SESSION_YAML());
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            const first = await visit(h, 1);
            await controlWorkflowRun(h.host, run.workflowSessionId, { operation: "cancel", runId: null, reason: "enough" }, { actor: ACTOR, operationId: "cancel-t3b" });
            expect(await ended(h, run.runId)).toMatchObject({ status: "cancelled" });
            await until(async () => (await h.store.readAgentInvocation(first.nodeExecutionId))?.endChildStatus === "NotFound", "the owed end");
            release();
            await until(async () => crashed > 0 || null, "the crash");
            const before = counter.looks;
            await until(async () => counter.looks >= before + 3 || null, "3 more looks that found no session", 60_000);
            // The retried spawn found the visit decided, with an attempt and no spawnedAt: it is still looking, not done.
            expect(await h.store.readAgentInvocation(first.nodeExecutionId)).toMatchObject({ spawnAttempts: 1, spawnedAt: null, endChildStatus: "NotFound" });
            expect(await status(h, `wfa-${first.nodeExecutionId}`)).toBe("Running");
            await h.makeVisible(agentSession);
            await endOnce(h, run, agentSession, first.nodeExecutionId, "cancel");
            await until(async () => (await status(h, `wfa-${first.nodeExecutionId}`)) === "Completed" || null, "the spawn to end", 60_000);
            // No second session and no prompt sent again.
            expect(h.spawns.map(request => request.nodeExecutionId)).toEqual([first.nodeExecutionId]);
        } finally {
            release?.();
            await h.stop();
        }
    });

    it("formal t3: a session created while the run was live and not visible when the run ended is ended by the cleanup's detached retry", { timeout: 180_000 }, async () => {
        const { counter, options } = visibleLater();
        const h = await harness(getEnv(), options);
        try {
            const run = await started(h, SESSION_YAML());
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            const first = await spawnedVisit(h, 1);
            // The send finished while the run was live (nothing owed then): the spawn is done.
            await until(async () => (await status(h, `wfa-${first.nodeExecutionId}`)) === "Completed" || null, "the spawn to end");
            await controlWorkflowRun(h.host, run.workflowSessionId, { operation: "cancel", runId: null, reason: "enough" }, { actor: ACTOR, operationId: "cancel-t3c" });
            expect(await ended(h, run.runId)).toMatchObject({ status: "cancelled" });
            // The cleanup looked once and started its detached retry; the run's end did not wait for it.
            await until(async () => (await status(h, `wfc-${agentSession}`)) === "Running" || null, "the detached end retry");
            await until(async () => counter.looks >= 3 || null, "3 looks that found no session", 60_000);
            expect(await status(h, `wfc-${agentSession}`)).toBe("Running");
            expect(await commandsOf(h, agentSession)).toEqual([]);
            await h.makeVisible(agentSession);
            await endOnce(h, run, agentSession, first.nodeExecutionId, "cancel");
            await until(async () => (await status(h, `wfc-${agentSession}`)) === "Completed" || null, "the detached retry to end", 60_000);
        } finally {
            await h.stop();
        }
    });

    it("formal review: a retried spawn of a visit whose result arrived creates no replacement session and logs no new session", { timeout: TIMEOUT }, async () => {
        let h = null;
        let watched = null;
        const decided = [];
        h = await harness(getEnv(), { storeHooks: {
            // The spawn of visit 2 reads the visits before it (its cycle); its result arrives right then, before the send.
            async readAgentVisitsBefore(found, [runId, , before]) {
                if (watched && runId === watched && before !== null && found.count === 1 && decided.length === 0) {
                    const second = await h.store.readAgentInvocation(before);
                    decided.push(second.nodeExecutionId);
                    expect(await completeAs(h, second.childSessionId, { outcome: "finish", output: { fact: "two" }, operation_id: "early",
                        node_execution_id: second.nodeExecutionId })).toMatchObject({ ok: true });
                }
                return found;
            },
        } });
        try {
            const run = await started(h, SESSION_YAML({ wait: 1 }));
            watched = run.runId;
            const agentSession = workflowAgentSessionId(run.runId, "talk");
            const first = await spawnedVisit(h, 1);
            // The owner session ended on its own, so visit 2 is admitted to a replacement session; its result arrives before its spawn sends.
            await h.catalog.softDeleteSession(agentSession);
            expect(await completeAs(h, agentSession, { outcome: "again", output: { fact: "one" }, operation_id: "op-1", node_execution_id: first.nodeExecutionId }))
                .toMatchObject({ ok: true });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
            const replacement = workflowAgentSessionId(run.runId, "talk", 2);
            expect(decided).toHaveLength(1);
            expect((await h.store.readAgentInvocation(decided[0])).childSessionId).toBe(replacement);
            expect(h.spawns).toHaveLength(1);
            expect((await h.client.getStatus(`session-${replacement}`)).status).toBe("NotFound");
            expect(await eventsOf(h, run.workflowSessionId, "workflow.agent_session_restarted")).toEqual([]);
            expect((await eventsOf(h, run.workflowSessionId, "workflow.agent_spawned")).map(data => data.nodeExecutionId)).toEqual([first.nodeExecutionId]);
        } finally {
            await h.stop();
        }
    });
});
