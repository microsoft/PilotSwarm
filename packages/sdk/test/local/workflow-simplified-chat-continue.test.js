/**
 * Workflow Simplified: an agent node that continues its chat (owner decision agent-node-continue-20261106; the
 * parent's design verdict: YAML key `chat: new | continue`, migration 0106, and the formal answers Q1 to Q5).
 *
 * - The store: migration 0106 applies on a 0105 database (the UNIQUE on a child session is dropped, an index added);
 *   two visits share one chat; a completion of a continued chat binds ONLY by the node execution id it gives (none, or
 *   one that is not the chat's, is refused in words; a late one binds to its own decided visit and is refused there,
 *   the open visit unaffected); a reminder binds to the open visit and names it.
 * - Controller 1.9.0 with a test-double host (as workflow-v2-agent-node.test.js): two visits go to ONE chat; the
 *   second prompt says cycle 2 with the variables now, which changed and the previous result; a visit's time limit stops
 *   its turn (a turn control Stop, never the chat) and the next visit runs; the chat is ended once, when the Workflow
 *   ends; a cancel ends it; a graceful stop ends an idle chat at once; a chat that ended on its own between visits is
 *   replaced by a new chat whose first prompt and the Workflow's log say so.
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
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { controlWorkflowV2Run, createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { completeWorkflowNodeFromTool } from "../../src/workflow/v2/agent-node-service.ts";
import { readWorkflowV2View } from "../../src/workflow/v2/tools.ts";
import {
    registerWorkflowV2, sessionQueueTransport, WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, workflowAgentChatSessionId, workflowLiveControllerInstanceId,
} from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";
import { spawnNesting, WORKFLOW_V2_MAX_DESCENDANT_LEVEL } from "../../src/workflow/v2/input-policy.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-simplified-chat-continue-test" };
const TASK = "Tell one new fact about PostgreSQL.";
const CMS_LOCK_SEED = 0x63_6D_73;
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

/** One agent node that continues its chat, visited again after a wait until it says finish. */
const CHAT_YAML = ({ limit = "3600", wait = 1 } = {}) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: chatter, version: "1.0.0" }
initialInput: { round: 1 }
initial: talk
states:
  talk:
    type: agent
    invoke: { prompt: "${TASK}" }
    chat: continue
    timeoutSeconds: ${limit}
    transition: { next: { again: pause, finish: done, timed_out: pause, failure: failed } }
  pause: { type: wait, seconds: ${wait}, transition: { next: { elapsed: talk } } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed }
`;

// ─── The store ────────────────────────────────────────────────

describe("chat: continue in the store (migration 0106)", () => {
    it("0106 applies on a 0105 database; a completion binds only by its node execution id; a reminder binds to the open visit", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const direct = new pg.Pool({ connectionString: env.store, max: 2 });
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        try {
            await runMigrations(direct, env.cmsSchema, CMS_MIGRATIONS(env.cmsSchema).filter(m => m.version <= "0105"), CMS_LOCK_SEED);
            const uniques = async () => (await direct.query(
                `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = $1 AND t.relname = 'workflow_agent_invocations' AND c.contype = 'u'`, [env.cmsSchema])).rows[0].n;
            expect(await uniques()).toBe(1);
            await catalog.initialize();
            expect(await uniques()).toBe(0);
            expect((await direct.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = 'workflow_agent_invocations_by_child'`,
                [env.cmsSchema])).rows).toHaveLength(1);
            const versions = (await direct.query(`SELECT version FROM "${env.cmsSchema}".schema_migrations ORDER BY version`)).rows.map(row => row.version);
            expect(versions.at(-1)).toBe("0106");

            const store = catalog.workflowStore();
            const yaml = CHAT_YAML();
            const compiled = compileWorkflowV2(yaml, { enableRequests: true, enableAgents: true });
            expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
            expect(compiled.ir.nodes.talk.chat).toBe("continue");
            const parent = randomUUID();
            await catalog.createSession(parent, {});
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            expect(await catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner: null,
                creationConfig: { workflowV2: { requestSha256: "chat" } } })).toEqual({ created: true });
            await store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: ACTOR,
                operationId: "create", requestSha256: "chat", publish: true, title: "Workflow: chatter",
                start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION },
            });
            const chat = workflowAgentChatSessionId(runId, "talk");
            const admit = async (ordinal, predecessorId) => {
                const nodeExecutionId = nodeExecutionIdFor(runId, "root", "talk", ordinal);
                const admitted = await store.enterNode({
                    runId, nodeExecutionId, scopeId: "root", nodeId: "talk", ordinal, nodeType: "agent",
                    predecessorId, arrivalRoute: predecessorId ? "elapsed" : null, inputText: canonicalJson({ round: ordinal }), kvRevision: 1,
                    waitSeconds: null, immediate: null,
                    agent: { childSessionId: chat, controllingSessionId: parent, task: { source: "prompt", prompt: TASK },
                        outcomes: ["again", "finish"], outputSchema: null, timeoutSeconds: 3600 },
                });
                expect(admitted).toMatchObject({ admitted: true, node: { state: "pending", nodeType: "agent" } });
                return nodeExecutionId;
            };
            const first = await admit(1, null);
            const refusal = call => store.completeAgentNode({ childSessionId: chat, operationId: randomUUID(), ...call });
            // Q1: a continued chat's completion must name its cycle; one that is not this chat's is refused in words.
            await expect(refusal({ call: { outcome: "again", output: { fact: "one" } } }))
                .rejects.toMatchObject({ code: "AGENT_NODE_NOT_FOUND", message: expect.stringContaining("give node_execution_id") });
            await expect(refusal({ call: { outcome: "again", output: null }, nodeExecutionId: "nx-not-mine" }))
                .rejects.toMatchObject({ code: "AGENT_NODE_NOT_FOUND", message: expect.stringContaining("is not a cycle of this chat") });
            expect(await store.completeAgentNode({ childSessionId: chat, operationId: "op-1", call: { outcome: "again", output: { fact: "one" } },
                nodeExecutionId: first })).toMatchObject({ kind: "accepted", receipt: { nodeExecutionId: first, outcome: "again" } });

            // The second visit is admitted to the same chat: both invocations name it (the UNIQUE is gone).
            const second = await admit(2, first);
            expect((await store.listAgentInvocationsOfState(runId, "talk")).map(item => [item.nodeExecutionId, item.childSessionId]))
                .toEqual([[first, chat], [second, chat]]);
            expect((await store.readAgentInvocationByChild(chat)).nodeExecutionId).toBe(second);
            // RT-4: a chat with two visits is one lineage row, not a cycle: level 2 (its sub-agent level 3, the workflow
            // nesting maximum), its agent root the open visit.
            await catalog.createSession(chat, { parentSessionId: workflowSessionId });
            const mini = randomUUID();
            await catalog.createSession(mini, { parentSessionId: chat });
            const root = { childSessionId: chat, nodeExecutionId: second, workflowSessionId, controllingSessionId: parent };
            expect(await store.readWorkflowLineage(chat)).toEqual({ sessionId: chat, level: 2, agentRoot: { ...root, distance: 0 } });
            expect(await store.readWorkflowLineage(mini)).toEqual({ sessionId: mini, level: 3, agentRoot: { ...root, distance: 1 } });
            expect(spawnNesting(1, 2, await store.readWorkflowLineage(chat)))
                .toEqual({ childNestingLevel: 3, maxNestingLevel: WORKFLOW_V2_MAX_DESCENDANT_LEVEL });
            // A real-agent test's scope (workflowTestAgentScope) is the agent root's visit: the open one, not the first.

            // RT-5: the visits are counted in the store, with no cap. 1,001 older decided visits (copies of the first,
            // admitted earlier) make the second visit cycle 1,003 of the state; its previous visit is still the first.
            const copies = 1_001;
            const copy = (table, extra) => `INSERT INTO "${env.cmsSchema}".${table}
                SELECT (jsonb_populate_record(NULL::"${env.cmsSchema}".${table}, to_jsonb(t) || ${extra})).*
                  FROM "${env.cmsSchema}".${table} t, generate_series(1, ${copies}) g WHERE t.node_execution_id = $1`;
            await direct.query(copy("workflow_node_executions",
                "jsonb_build_object('node_execution_id', 'rt5-' || g, 'ordinal', 100000 + g)"), [first]);
            await direct.query(copy("workflow_agent_invocations",
                "jsonb_build_object('node_execution_id', 'rt5-' || g, 'created_at', t.created_at - make_interval(secs => g))"), [first]);
            const before = await store.readAgentVisitsBefore(runId, "talk", second);
            expect([before.count, before.previous.nodeExecutionId]).toEqual([copies + 1, first]);
            const all = await store.readAgentVisitsBefore(runId, "talk", null);
            expect([all.count, all.previous.nodeExecutionId]).toEqual([copies + 2, second]);
            expect(await store.readAgentVisitsBefore(runId, "talk", "rt5-1001")).toEqual({ count: 0, previous: null });

            // RT-2/RT-3, the turn-to-visit fence: a turn's visit is the open one its prompt names, else the newest it names;
            // a prompt that names none inherits the chat's newest recorded visit prompt; a session that does not continue a
            // chat has none.
            const pid = nx => `workflow:${workflowSessionId}:${runId}:agent:${nx}`;
            expect(await store.readTurnVisit(chat, [pid(second)])).toEqual({ nodeExecutionId: second, open: true, inherited: false });
            expect(await store.readTurnVisit(chat, [pid(first)])).toEqual({ nodeExecutionId: first, open: false, inherited: false });
            expect(await store.readTurnVisit(chat, [pid(first), pid(second)])).toEqual({ nodeExecutionId: second, open: true, inherited: false });
            expect(await store.readTurnVisit(chat, [])).toEqual({ nodeExecutionId: null, open: false, inherited: true });
            await catalog.recordEvents(chat, [{ eventType: "user.message", data: { content: "cycle 2", clientMessageIds: [pid(second)] } }]);
            await catalog.recordEvents(chat, [{ eventType: "user.message", data: { content: "a sub-agent's update" } }]);
            expect(await store.readTurnVisit(chat, ["some-other-id"])).toEqual({ nodeExecutionId: second, open: true, inherited: true });
            expect(await store.readTurnVisit(mini, [pid(second)])).toBeNull();
            // A Stop's request id names its visit; the worker reads it by the Stop's position.
            const { rows: [stopRow] } = await direct.query(
                `INSERT INTO "${env.cmsSchema}".session_events (session_id, event_type, data) VALUES ($1, 'user.stop', $2) RETURNING seq`,
                [chat, JSON.stringify({ turn: 3, text: "cycle ended", requestId: `workflow-cycle-stop:${first}:sent` })]);
            expect(await store.readControlRequestIds(chat, [Number(stopRow.seq), 999_999_999]))
                .toEqual(new Map([[Number(stopRow.seq), `workflow-cycle-stop:${first}:sent`]]));
            // RT-1: whether any visit of the chat began a spawn attempt.
            expect(await store.chatHasSpawnAttempt(chat)).toBe(false);
            expect((await store.beginAgentSpawn(second)).action).toBe("spawn");
            expect(await store.chatHasSpawnAttempt(chat)).toBe(true);
            // A late answer of the first visit binds to it, never to the open one, and is refused there.
            expect(await store.completeAgentNode({ childSessionId: chat, operationId: "late-1", call: { outcome: "finish", output: { fact: "late" } },
                nodeExecutionId: first })).toMatchObject({ kind: "refused", code: "COMPLETION_CONFLICT" });
            expect(await store.readNodeExecution(second)).toMatchObject({ state: "pending" });
            // A reminder binds to the reminded turn's own visit and names it (RT-3); a turn with no visit, or with a decided
            // one, is not reminded, whatever visit is open.
            expect(await store.recordAgentReminder({ childSessionId: chat, turn: 7 })).toEqual({ recorded: false, reason: "no_visit" });
            expect(await store.recordAgentReminder({ childSessionId: chat, turn: 7, visit: first })).toEqual({ recorded: false, reason: "decided" });
            expect(await store.recordAgentReminder({ childSessionId: chat, turn: 7, visit: second }))
                .toMatchObject({ recorded: true, nodeExecutionId: second, cycle: second, stateId: "talk", n: 1 });
            // A turn completes only its own visit (RT-3).
            await expect(store.completeAgentNode({ childSessionId: chat, operationId: "op-other-turn", call: { outcome: "finish", output: { fact: "x" } },
                nodeExecutionId: second, turnVisit: first }))
                .rejects.toMatchObject({ code: "AGENT_NODE_NOT_FOUND", message: expect.stringContaining(`This turn works on cycle ${first}`) });
            expect(await store.completeAgentNode({ childSessionId: chat, operationId: "op-2", call: { outcome: "finish", output: { fact: "two" } },
                nodeExecutionId: second })).toMatchObject({ kind: "accepted", receipt: { nodeExecutionId: second, outcome: "finish" } });
            expect(await store.recordAgentReminder({ childSessionId: chat, turn: 8, visit: second })).toMatchObject({ recorded: false, reason: "decided" });
            // With no visit open, the lineage's agent root is the newest visit, still one row.
            expect(await store.readWorkflowLineage(mini)).toEqual({ sessionId: mini, level: 3, agentRoot: { ...root, nodeExecutionId: second, distance: 1 } });
        } finally {
            await catalog.close();
            await direct.end();
        }
    });
});

describe("migration 0106 finds the child session's uniqueness by what it is (review RT-6)", () => {
    const uniqueness = async (direct, schema) => (await direct.query(
        `SELECT x.relname FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = i.indkey[0]
          WHERE n.nspname = $1 AND t.relname = 'workflow_agent_invocations' AND i.indisunique AND NOT i.indisprimary
            AND i.indnkeyatts = 1 AND a.attname = 'child_session_id'`, [schema])).rows.map(row => row.relname);
    for (const [label, drift] of [
        ["a renamed UNIQUE constraint", schema => `ALTER TABLE "${schema}".workflow_agent_invocations
            RENAME CONSTRAINT workflow_agent_invocations_child_session_id_key TO legacy_child_unique`],
        ["a unique index that no constraint owns", schema => `ALTER TABLE "${schema}".workflow_agent_invocations
            DROP CONSTRAINT workflow_agent_invocations_child_session_id_key;
            CREATE UNIQUE INDEX legacy_child_index ON "${schema}".workflow_agent_invocations (child_session_id)`],
    ]) {
        it(`drops ${label} on a 0105 database, then records 0106`, { timeout: TIMEOUT }, async () => {
            const env = getEnv();
            const direct = new pg.Pool({ connectionString: env.store, max: 2 });
            const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
            try {
                await runMigrations(direct, env.cmsSchema, CMS_MIGRATIONS(env.cmsSchema).filter(m => m.version <= "0105"), CMS_LOCK_SEED);
                await direct.query(drift(env.cmsSchema));
                expect(await uniqueness(direct, env.cmsSchema)).toHaveLength(1);
                await catalog.initialize();
                expect(await uniqueness(direct, env.cmsSchema)).toEqual([]);
                const versions = (await direct.query(`SELECT version FROM "${env.cmsSchema}".schema_migrations ORDER BY version`)).rows.map(row => row.version);
                expect(versions.at(-1)).toBe("0106");
            } finally {
                await catalog.close();
                await direct.end();
            }
        });
    }
});

// ─── Controller 1.9.0 ─────────────────────────────────────────

const CHILD = "test-chat-child";
function* chatChild(ctx) {
    const received = [];
    for (;;) {
        const raw = yield ctx.dequeueEvent("messages");
        received.push(typeof raw === "string" ? JSON.parse(raw) : raw);
        ctx.setCustomStatus(JSON.stringify(received));
    }
}

/**
 * A worker-equivalent registration (as workflow-v2-agent-node.test.js's harness). The host double creates a chat once
 * (its catalog row and its orchestration) and gives it each visit's prompt; the catalog's turn control is a spy that
 * records each Stop (the double runs no turns, so it answers no_turn).
 */
async function harness(env, { storeHooks = null, storeBefore = null, beforeCreate = null } = {}) {
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
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    runtime.registerOrchestrationVersioned(CHILD, "1.0.0", chatChild);
    const spawns = [];
    const stops = [];
    const agentNodes = {
        async spawn(request) {
            spawns.push(request);
            // A spawn that passed its open check and has not created the chat yet (a test holds it here).
            if (beforeCreate) await beforeCreate(request);
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
                    stops.push({ sessionId, kind, text, requestId });
                    return { refused: "no_turn" };
                };
            }
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store: controllerStore, catalog: spied, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        workflowRequests: true,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
        agentNodes,
    });
    await runtime.start();
    return {
        catalog, store, client, spawns, stops, host: { catalog, store, duroxideClient: client, requests: true },
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
    const created = await createWorkflowV2(h.host, {
        workflowSessionId, parentSessionId: parent, yaml, actor: ACTOR, operationId: "start", start: { inputs: {}, ...(vars ? { vars } : {}) },
    });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    return { parent, workflowSessionId, runId: created.receipt.run.runId };
}

const ended = (h, runId) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && ["completed", "failed", "cancelled", "stopped"].includes(run.status) ? run : null;
}, `run ${runId} to end`);

async function chatMessages(h, chat) {
    const status = await h.client.getStatus(`session-${chat}`);
    return typeof status.customStatus === "string" && status.customStatus ? JSON.parse(status.customStatus) : [];
}
const commandsOf = async (h, chat) => (await chatMessages(h, chat)).filter(message => message?.type === "cmd");
const chatEnd = (h, chat) => until(async () => (await commandsOf(h, chat))[0] ?? null, `the end of chat ${chat}`, 30_000);
const visit = (h, n) => until(async () => (h.spawns.length >= n ? h.spawns[n - 1] : null), `visit ${n}`);
const spawnedVisit = async (h, n) => {
    const request = await visit(h, n);
    await until(async () => (await h.store.readAgentInvocation(request.nodeExecutionId))?.spawnedAt ?? null, `the spawn of visit ${n}`);
    return request;
};
const completeAs = (h, chat, args) => completeWorkflowNodeFromTool(args, { callerSessionId: chat, store: h.store, client: h.client })
    .then(text => JSON.parse(text));
const eventsOf = async (h, workflowSessionId, type) => (await h.catalog.getSessionEvents(workflowSessionId, 0, 500))
    .filter(event => event.eventType === type).map(event => event.data);

describe("chat: continue on controller 1.9.0 (test-only registration)", () => {
    it("two visits share one chat; the second is cycle 2 with the variables now; a time limit stops the turn, not the chat; the chat ends once with the Workflow", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const run = await started(h, CHAT_YAML({ limit: `"\${kv.limit}"` }), { limit: 3 });
            const chat = workflowAgentChatSessionId(run.runId, "talk");
            const first = await spawnedVisit(h, 1);
            expect(first.childSessionId).toBe(chat);
            const [system1, json1] = first.prompt.split("\n");
            expect(system1).toContain("This chat continues");
            expect(system1).toContain(`(this one's is ${first.nodeExecutionId})`);
            expect(JSON.parse(json1)).not.toHaveProperty("cycle");
            // Q1: without node_execution_id, the completion is refused in words and decides nothing.
            expect(await completeAs(h, chat, { outcome: "again", output: { fact: "one" }, operation_id: "op-0" }))
                .toMatchObject({ ok: false, error: { code: "AGENT_NODE_NOT_FOUND", message: expect.stringContaining("give node_execution_id") } });
            // The variables change before the first visit's 3-second time limit passes: the next visit reads them.
            await controlWorkflowV2Run(h.host, run.workflowSessionId,
                { operation: "set_vars", runId: null, set: { limit: 3600, topic: "postgres" }, delete: [], expectedKvRevision: 1 },
                { actor: ACTOR, operationId: "vars-1" });

            const second = await spawnedVisit(h, 2);
            expect(second.childSessionId).toBe(chat);
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
            // Q2: the first visit's time limit stopped its turn (a Stop), never the chat; both prompts reached the one chat.
            expect(h.stops).toContainEqual(expect.objectContaining({ sessionId: chat, kind: "stop", requestId: `workflow-cycle-stop:${first.nodeExecutionId}` }));
            const prompts = await until(async () => {
                const messages = await chatMessages(h, chat);
                return messages.length >= 2 ? messages : null;
            }, "both prompts in the chat");
            expect(prompts.map(message => message.prompt)).toEqual([first.prompt, second.prompt]);
            expect(await commandsOf(h, chat)).toEqual([]);

            // A late answer of the first visit is refused; the second visit is unaffected.
            expect(await completeAs(h, chat, { outcome: "finish", output: { fact: "late" }, operation_id: "late-1", node_execution_id: first.nodeExecutionId }))
                .toMatchObject({ ok: false, error: { code: "NODE_CLOSED" } });
            expect(await h.store.readNodeExecution(second.nodeExecutionId)).toMatchObject({ state: "pending" });
            expect(await completeAs(h, chat, { outcome: "finish", output: { fact: "two" }, operation_id: "op-2", node_execution_id: second.nodeExecutionId }))
                .toMatchObject({ ok: true, nodeExecutionId: second.nodeExecutionId, outcome: "finish" });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });

            // The chat is ended once, when the Workflow ends: done, by its last visit's own result.
            expect(await chatEnd(h, chat)).toMatchObject({ type: "cmd", cmd: "done", id: `workflow-agent-chat-end:${chat}`, requestedBy: run.workflowSessionId });
            await pause(1_000);
            expect(await commandsOf(h, chat)).toHaveLength(1);
            expect(h.spawns).toHaveLength(2);
            expect((await eventsOf(h, run.workflowSessionId, "workflow.agent_cycle_ended")).map(data => data.nodeExecutionId))
                .toEqual([first.nodeExecutionId, second.nodeExecutionId]);
            expect(await eventsOf(h, run.workflowSessionId, "workflow.agent_ended"))
                .toEqual([expect.objectContaining({ childSessionId: chat, end: "done", sent: true, chat: "continue" })]);
            expect((await eventsOf(h, run.workflowSessionId, "workflow.agent_spawned")).map(data => [data.childSessionId, data.chat, data.cycle]))
                .toEqual([[chat, "continue", 1], [chat, "continue", 2]]);

            // Finding 7: the read view says what the agent is told and when each visit started and ended (the Node panel's lines).
            const view = await readWorkflowV2View(h.store, run.workflowSessionId);
            expect(view.graph.states.find(state => state.id === "talk")).toMatchObject({ type: "agent", chat: "continue", about: { prompt: TASK } });
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
            const run = await started(h, CHAT_YAML({ limit: `"\${kv.limit}"` }), { limit: 3, keep: "x" });
            await spawnedVisit(h, 1);
            await controlWorkflowV2Run(h.host, run.workflowSessionId,
                { operation: "set_vars", runId: null, set: { limit: 3600, topic: "postgres" }, delete: [], expectedKvRevision: 1 },
                { actor: ACTOR, operationId: "vars-1" });
            armed = true;
            const second = await spawnedVisit(h, 2);
            expect(failures).toBe(1);
            expect(JSON.parse(second.prompt.split("\n")[1])).toMatchObject({
                cycle: 2, variables: { limit: 3600, topic: "postgres", keep: "x" }, changedVariables: ["limit", "topic"],
            });
            expect(h.spawns).toHaveLength(2);
            await controlWorkflowV2Run(h.host, run.workflowSessionId, { operation: "cancel", runId: null, reason: "done" }, { actor: ACTOR, operationId: "cancel-rt7" });
            expect(await ended(h, run.runId)).toMatchObject({ status: "cancelled" });
        } finally {
            await h.stop();
        }
    });

    it("a cancel ends the chat; a graceful stop ends an idle chat at once", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            // A cancel while the chat is idle between visits: the chat ends with its last visit's result (done).
            const idle = await started(h, CHAT_YAML({ wait: 600 }));
            const idleChat = workflowAgentChatSessionId(idle.runId, "talk");
            const first = await spawnedVisit(h, 1);
            expect(await completeAs(h, idleChat, { outcome: "again", output: { fact: "one" }, operation_id: "op-1", node_execution_id: first.nodeExecutionId }))
                .toMatchObject({ ok: true });
            await until(async () => (await h.store.listNodeExecutions(idle.runId)).some(node => node.nodeId === "pause"), "the wait between visits");
            await controlWorkflowV2Run(h.host, idle.workflowSessionId, { operation: "cancel", runId: null, reason: "enough" }, { actor: ACTOR, operationId: "cancel-1" });
            expect(await ended(h, idle.runId)).toMatchObject({ status: "cancelled" });
            expect(await chatEnd(h, idleChat)).toMatchObject({ cmd: "done", id: `workflow-agent-chat-end:${idleChat}` });

            // A cancel while a visit runs: the visit loses to the cancel, and the chat is cancelled.
            const busy = await started(h, CHAT_YAML());
            const busyChat = workflowAgentChatSessionId(busy.runId, "talk");
            const running = await spawnedVisit(h, 2);
            expect(running.childSessionId).toBe(busyChat);
            await controlWorkflowV2Run(h.host, busy.workflowSessionId, { operation: "cancel", runId: null, reason: "enough" }, { actor: ACTOR, operationId: "cancel-2" });
            expect(await ended(h, busy.runId)).toMatchObject({ status: "cancelled" });
            expect(await chatEnd(h, busyChat)).toMatchObject({ cmd: "cancel", id: `workflow-agent-chat-end:${busyChat}` });

            // Q5: a graceful stop with a long grace: the idle chat is not started work and is ended at once.
            const stopping = await started(h, CHAT_YAML({ wait: 600 }));
            const stoppingChat = workflowAgentChatSessionId(stopping.runId, "talk");
            const third = await spawnedVisit(h, 3);
            expect(third.childSessionId).toBe(stoppingChat);
            expect(await completeAs(h, stoppingChat, { outcome: "again", output: { fact: "x" }, operation_id: "op-3", node_execution_id: third.nodeExecutionId }))
                .toMatchObject({ ok: true });
            await until(async () => (await h.store.listNodeExecutions(stopping.runId)).some(node => node.nodeId === "pause"), "the wait between visits");
            const asked = Date.now();
            await controlWorkflowV2Run(h.host, stopping.workflowSessionId, { operation: "stop", runId: null, reason: "enough", graceSeconds: 300 },
                { actor: ACTOR, operationId: "stop-1" });
            expect(await chatEnd(h, stoppingChat)).toMatchObject({ cmd: "done", id: `workflow-agent-chat-end:${stoppingChat}` });
            expect(Date.now() - asked).toBeLessThan(60_000);
            await controlWorkflowV2Run(h.host, stopping.workflowSessionId, { operation: "cancel", runId: null, reason: "done" }, { actor: ACTOR, operationId: "cancel-3" })
                .catch(() => {});
            await ended(h, stopping.runId);
            await pause(1_000);
            expect(await commandsOf(h, stoppingChat)).toHaveLength(1);
        } finally {
            await h.stop();
        }
    });

    it("Q4: a chat that ended on its own between visits is replaced by a new chat; its first prompt and the log say so", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const run = await started(h, CHAT_YAML({ wait: 2 }));
            const chat = workflowAgentChatSessionId(run.runId, "talk");
            const first = await spawnedVisit(h, 1);
            // A person deletes the chat; then the visit's result arrives.
            await h.catalog.softDeleteSession(chat);
            expect(await completeAs(h, chat, { outcome: "again", output: { fact: "one" }, operation_id: "op-1", node_execution_id: first.nodeExecutionId }))
                .toMatchObject({ ok: true });
            const second = await spawnedVisit(h, 2);
            const replacement = workflowAgentChatSessionId(run.runId, "talk", 2);
            expect(second.childSessionId).toBe(replacement);
            expect(replacement).not.toBe(chat);
            const [system2, json2] = second.prompt.split("\n");
            expect(system2).toContain("This chat continues");
            expect(system2).toContain(`The chat of its earlier cycles ended (session ${chat})`);
            expect(JSON.parse(json2)).toMatchObject({ cycle: 2, nodeExecutionId: second.nodeExecutionId, previousResult: { outcome: "again", output: { fact: "one" } } });
            expect(await eventsOf(h, run.workflowSessionId, "workflow.agent_chat_restarted"))
                .toEqual([expect.objectContaining({ endedChatSessionId: chat, childSessionId: replacement, cycle: 2, stateId: "talk" })]);
            expect(await completeAs(h, replacement, { outcome: "finish", output: { fact: "two" }, operation_id: "op-2", node_execution_id: second.nodeExecutionId }))
                .toMatchObject({ ok: true });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed" });
            expect(await chatEnd(h, replacement)).toMatchObject({ cmd: "done", id: `workflow-agent-chat-end:${replacement}` });
        } finally {
            await h.stop();
        }
    });
    for (const [label, finish] of [
        ["the run completes", async (h, run, chat, nx) => {
            expect(await completeAs(h, chat, { outcome: "finish", output: { fact: "one" }, operation_id: "op-1", node_execution_id: nx }))
                .toMatchObject({ ok: true });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed" });
            return "done";
        }],
        ["the run is canceled", async (h, run) => {
            await controlWorkflowV2Run(h.host, run.workflowSessionId, { operation: "cancel", runId: null, reason: "enough" }, { actor: ACTOR, operationId: "cancel-rt1" });
            expect(await ended(h, run.runId)).toMatchObject({ status: "cancelled" });
            return "cancel";
        }],
    ]) {
        it(`RT-1: ${label} while a spawn that passed its check has not created the chat: the end stays owed, and the after-send check ends the chat once`, { timeout: TIMEOUT }, async () => {
            let release;
            const held = new Promise(resolve => { release = resolve; });
            const h = await harness(getEnv(), { beforeCreate: () => held });
            try {
                const run = await started(h, CHAT_YAML());
                const chat = workflowAgentChatSessionId(run.runId, "talk");
                const first = await visit(h, 1);
                const end = await finish(h, run, chat, first.nodeExecutionId);
                // The run's cleanup found no chat, and an attempt that may still create it: the end is owed, not ChatEnded.
                await until(async () => (await h.store.readAgentInvocation(first.nodeExecutionId))?.endChildStatus === "NotFound", "the owed end");
                expect((await h.client.getStatus(`session-${chat}`)).status).toBe("NotFound");
                release();
                expect(await chatEnd(h, chat)).toMatchObject({ type: "cmd", cmd: end, id: `workflow-agent-chat-end:${chat}`, requestedBy: run.workflowSessionId });
                await until(async () => (await h.store.readAgentInvocation(first.nodeExecutionId))?.endChildStatus === "ChatEnded", "the chat ended");
                await pause(1_000);
                expect(await commandsOf(h, chat)).toHaveLength(1);
                expect((await eventsOf(h, run.workflowSessionId, "workflow.agent_ended")).map(data => [data.sent, data.childStatus]))
                    .toEqual([[false, "NotFound"], [true, expect.any(String)]]);
            } finally {
                release?.();
                await h.stop();
            }
        });
    }

    it("RT-1 (formal t2): an older visit's late send creates the chat after the run ended while the newest visit had no attempt: the chat is ended", { timeout: TIMEOUT }, async () => {
        let release;
        const held = new Promise(resolve => { release = resolve; });
        let h = null;
        let firstVisit = null;
        const secondVisit = [];
        h = await harness(getEnv(), {
            // Visit 1's spawn passed its check and holds before it creates the chat.
            beforeCreate: request => {
                firstVisit ??= request.nodeExecutionId;
                return request.nodeExecutionId === firstVisit ? held : undefined;
            },
            storeBefore: {
                // Visit 2 is admitted; before its spawn attempt begins, the run is canceled and its cleanup runs.
                async beginAgentSpawn([nodeExecutionId]) {
                    if (firstVisit === null || nodeExecutionId === firstVisit || secondVisit.length > 0) return;
                    secondVisit.push(nodeExecutionId);
                    const { workflowSessionId } = await h.store.readAgentInvocation(nodeExecutionId);
                    await controlWorkflowV2Run(h.host, workflowSessionId, { operation: "cancel", runId: null, reason: "enough" },
                        { actor: ACTOR, operationId: "cancel-t2" });
                    await until(async () => (await h.store.readAgentInvocation(nodeExecutionId))?.endChildStatus === "NotFound",
                        "the owed end on the newest visit");
                },
            },
        });
        try {
            const run = await started(h, CHAT_YAML({ limit: "1", wait: 1 }));
            const chat = workflowAgentChatSessionId(run.runId, "talk");
            const first = await visit(h, 1);
            // Visit 1 times out while its send is held; visit 2 is admitted to the same chat (never created yet).
            await until(async () => (secondVisit.length > 0 ? secondVisit : null), "visit 2's spawn");
            expect(await ended(h, run.runId)).toMatchObject({ status: "cancelled" });
            const newest = await h.store.readAgentInvocation(secondVisit[0]);
            expect(newest).toMatchObject({ childSessionId: chat, spawnAttempts: 0, endChildStatus: "NotFound" });
            // Visit 1's host now creates the chat; its after-send check finds the run ended and ends the chat.
            release();
            expect(await chatEnd(h, chat)).toMatchObject({ type: "cmd", cmd: "cancel", id: `workflow-agent-chat-end:${chat}` });
            await pause(1_000);
            expect(await commandsOf(h, chat)).toHaveLength(1);
            expect(h.spawns.map(request => request.nodeExecutionId)).toEqual([first.nodeExecutionId]);
        } finally {
            release?.();
            await h.stop();
        }
    });

    it("formal review: a retried spawn of a visit whose result arrived creates no replacement chat and logs no new chat", { timeout: TIMEOUT }, async () => {
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
            const run = await started(h, CHAT_YAML({ wait: 1 }));
            watched = run.runId;
            const chat = workflowAgentChatSessionId(run.runId, "talk");
            const first = await spawnedVisit(h, 1);
            // The chat ended on its own, so visit 2 is admitted to a replacement chat; its result arrives before its spawn sends.
            await h.catalog.softDeleteSession(chat);
            expect(await completeAs(h, chat, { outcome: "again", output: { fact: "one" }, operation_id: "op-1", node_execution_id: first.nodeExecutionId }))
                .toMatchObject({ ok: true });
            expect(await ended(h, run.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
            const replacement = workflowAgentChatSessionId(run.runId, "talk", 2);
            expect(decided).toHaveLength(1);
            expect((await h.store.readAgentInvocation(decided[0])).childSessionId).toBe(replacement);
            expect(h.spawns).toHaveLength(1);
            expect((await h.client.getStatus(`session-${replacement}`)).status).toBe("NotFound");
            expect(await eventsOf(h, run.workflowSessionId, "workflow.agent_chat_restarted")).toEqual([]);
            expect((await eventsOf(h, run.workflowSessionId, "workflow.agent_spawned")).map(data => data.nodeExecutionId)).toEqual([first.nodeExecutionId]);
        } finally {
            await h.stop();
        }
    });
});
