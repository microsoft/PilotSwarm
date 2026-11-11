/**
 * The Sweeper's final check and delete under concurrency, on real PostgreSQL with real connections (reviews AS-02 and
 * AR-01..AR-03 of 4fa702dc). Each case holds a real transaction at a named statement and proves the order from the
 * database's lock graph (pg_blocking_pids), not from a sleep.
 *
 * - T4, both orders, through cleanup_session and prune_orchestrations: a test admission (store.startTest) that holds its
 *   transaction first makes the Sweeper wait, then refuse (ActiveRun); a Sweeper that holds its final transaction first
 *   makes the admission wait, then refuse (WORKFLOW_DELETED), with no run and no receipt.
 * - AR-02: the final check compares the row's exact version (xmin), read before the Sweeper judges the session: an update
 *   after that read refuses (Changed), whether it moves updated_at forward, backward or not at all; an unchanged row is
 *   deleted.
 * - AR-03: a session the delete would change that another transaction holds makes the Sweeper refuse at once (Busy),
 *   deleting nothing, never waiting while it holds its own lock: no deadlock with a transaction that locks the held
 *   session first and the target second; the cleanup succeeds once the other transaction ends. Prune counts it.
 * - DR-02 (review of d5118761): a new ordinary or Workflow grandchild created between the Sweeper's read of the subtree
 *   and its locks makes the cleanup refuse (Changed) with nothing deleted; a creator that the Sweeper's lock on the parent
 *   blocks refuses after the delete commits (PARENT_DELETED), so no child is left under a deleted parent.
 * - DR-01 (review of d5118761): a session whose first message was accepted and whose start is still queued (it reads
 *   NotFound) is never taken as ended, at any age and any grace (StartUnresolved), by scan, cleanup, prune and the final
 *   check; one whose state shows it ended, or that never had a first message, is cleaned.
 *
 * Run: npx vitest run test/local/sweeper-final-check.test.js
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import pg from "pg";
import { describe, it, beforeAll, beforeEach, afterEach, expect } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { createSweeperTools } from "../../src/sweeper-tools.ts";
import { WorkflowStore } from "../../src/workflow/store.ts";
import { PilotSwarmClient } from "../../src/index.ts";

const { Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

function findTool(tools, name) {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    return tool;
}

/** A stub duroxide client: statuses by instance id (an Error is thrown), `fallback` for any other. */
function stubDuroxide(statusByInstance, fallback = { status: "Running" }) {
    const deletedInstances = [];
    return {
        deletedInstances,
        async getStatus(instanceId) {
            const status = statusByInstance.get(instanceId) ?? fallback;
            if (status instanceof Error) throw status;
            return status;
        },
        async deleteInstanceBulk() { return { instancesDeleted: 0, executionsDeleted: 0, eventsDeleted: 0 }; },
        async pruneExecutionsBulk() { return { instancesProcessed: 0, executionsDeleted: 0, eventsDeleted: 0 }; },
        async deleteInstance(instanceId) { deletedInstances.push(instanceId); },
    };
}

/** A gate the test opens; `reached` resolves when the gated code arrives at it. */
function gate() {
    let arrive, open;
    const reached = new Promise(resolve => { arrive = resolve; });
    const opened = new Promise(resolve => { open = resolve; });
    return { reached, arrive: value => arrive(value), wait: () => opened, open: () => open() };
}

/**
 * A pool whose transaction connections stop at the first statement `matches(sql, params)` selects, until `held` is opened: it records
 * that connection's backend pid first (held.reached resolves with it). `observe` only records the pid of the connection
 * that runs a matching statement (observe.reached), without stopping it. Other statements and pool.query pass through.
 */
function gatedPool(connectionString, { matches, held = null, observe = null }) {
    const pool = new pg.Pool({ connectionString, max: 4 });
    let used = false;
    return {
        pool,
        query: (...args) => pool.query(...args),
        async connect() {
            const client = await pool.connect();
            const query = client.query.bind(client);
            client.query = async (text, ...rest) => {
                const sql = typeof text === "string" ? text : text?.text ?? "";
                if (!used && matches(sql, rest[0] ?? [])) {
                    used = true;
                    const pid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
                    if (observe) observe.arrive(pid);
                    if (held) {
                        held.arrive(pid);
                        await held.wait();
                    }
                }
                return query(text, ...rest);
            };
            return client;
        },
        end: () => pool.end(),
    };
}

/** Wait until a backend is blocked by `pid` (`blocker`), or `pid` is blocked (`blocked`); false if `settled` wins first. */
async function untilLockWait(db, mode, pid, settled, timeoutMs = 20_000) {
    let done = false;
    settled.then(() => { done = true; }, () => { done = true; });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (done) return false;
        const sql = mode === "blocker"
            ? "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))"
            : "SELECT cardinality(pg_blocking_pids($1))::int AS n";
        if ((await db.query(sql, [pid])).rows[0].n > 0) return true;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`no lock wait on backend ${pid} within ${timeoutMs} ms`);
}

/** The catalog, with its Workflow store replaced (the Sweeper calls catalog.workflowStore()). */
function withStore(catalog, store) {
    const proxy = Object.create(catalog);
    proxy.workflowStore = () => store;
    return proxy;
}

async function ageSessions(db, schema, ids, minutes) {
    await db.query(`UPDATE ${schema}.sessions SET updated_at = now() - make_interval(mins => $2) WHERE session_id = ANY($1::text[])`, [ids, minutes]);
}

const isLive = async (db, schema, id) => (await db.query(`SELECT deleted_at FROM ${schema}.sessions WHERE session_id = $1`, [id])).rows[0]?.deleted_at === null;
/** Exactly how the row stands: it exists, and whether it is soft-deleted (a missing row is neither kept nor cleaned). */
const rowState = async (db, schema, id) => {
    const { rows } = await db.query(`SELECT deleted_at FROM ${schema}.sessions WHERE session_id = $1`, [id]);
    return rows[0] ? (rows[0].deleted_at === null ? "kept" : "soft-deleted") : "missing";
};

/** A draft test bench with one ended (completed) test run; its controller wft-<run>. */
async function makeBench(catalog, db, schema, owner) {
    const id = randomUUID();
    const claim = await catalog.createWorkflowSession(id, { parentSessionId: owner, owner: null,
        creationConfig: { agentTest: { definitionId: "def-1", revision: 1 } }, service: { kind: "workflow-test", of: null } });
    expect(claim.created).toBe(true);
    await db.query(`INSERT INTO ${schema}.workflow_definitions (workflow_session_id, parent_session_id, api_version, state, current_revision)
        VALUES ($1, $2, 'pilotswarm.dev/v1', 'draft', 1)`, [id, owner]);
    await db.query(`INSERT INTO ${schema}.workflow_revisions (workflow_session_id, revision, yaml, yaml_sha256, valid, diagnostics, ir, ir_sha256, actor)
        VALUES ($1, 1, 'y', 'ys', TRUE, '[]', '{}', 'is', '{"kind":"system","name":"sweeper-test"}')`, [id]);
    const runId = randomUUID();
    await db.query(`INSERT INTO ${schema}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs,
            controller_instance_id, status, test_agent_mode, start_operation_id, finished_at, created_at)
        VALUES ($1, $2, 'test', 1, 'ys', 'is', '{}', $3, 'completed', 'mocked', $4, now(), now() - interval '1 hour')`,
    [runId, id, `wft-${runId}`, `op-${runId}`]);
    return { id, controller: `wft-${runId}` };
}

/** A test admission of the bench's draft (production store.startTest); its run id and operation id. */
function admission(store, benchId) {
    const runId = randomUUID();
    const operationId = `race-${runId}`;
    const promise = store.startTest({ workflowSessionId: benchId, expectedRevision: 1, definitionHash: "ys", operationId,
        requestSha256: operationId, start: { runId, mode: "test", controllerInstanceId: `wft-${runId}`, inputsText: "{}", kvText: "{}",
            testAgentMode: "mocked", fixturesText: "[]" } });
    return { runId, operationId, promise };
}

const runRow = async (db, schema, runId) => (await db.query(`SELECT status FROM ${schema}.workflow_runs WHERE run_id = $1`, [runId])).rows[0] ?? null;
const receiptRow = async (db, schema, benchId, operationId) => (await db.query(
    `SELECT 1 FROM ${schema}.workflow_operations WHERE workflow_session_id = $1 AND operation_id = $2`, [benchId, operationId])).rows[0] ?? null;

/** Run a Sweeper entry point on one target: cleanup_session (default grace) or prune_orchestrations (default cutoff). */
async function sweep(tools, entry, sessionId) {
    if (entry === "cleanup") return findTool(tools, "cleanup_session").handler({ sessionId });
    return findTool(tools, "prune_orchestrations").handler({ deleteTerminalOlderThanMinutes: 5 });
}

describe("the Sweeper's final check and delete under concurrency", () => {
    let env;
    let catalog;
    let db;
    let schema;
    beforeAll(async () => { await preflightChecks(); });
    // The suite's schemas are reset after each test: each test opens its catalog and pool on them, and closes them.
    beforeEach(async () => {
        env = getEnv();
        catalog = await createCatalog(env);
        db = new pg.Pool({ connectionString: env.store, max: 4 });
        schema = `"${env.cmsSchema}"`;
    });
    afterEach(async () => {
        await db?.end();
        await catalog?.close();
        db = null;
        catalog = null;
    });

    for (const entry of ["cleanup", "prune"]) {
        it(`T4 (${entry}): an admission that holds its transaction first makes the Sweeper wait, then refuse; the run stays admitted`, { timeout: TIMEOUT }, async () => {
            const owner = randomUUID();
            await catalog.createSession(owner);
            const bench = await makeBench(catalog, db, schema, owner);
            await ageSessions(db, schema, [bench.id], 60);
            // The admission stops with its run inserted, before its receipt and commit, holding the bench's session lock.
            const held = gate();
            const admitting = gatedPool(env.store, { matches: (sql, params) => sql.includes("workflow_operations") && sql.startsWith("INSERT") && params[0] === bench.id, held });
            try {
                const admit = admission(new WorkflowStore(admitting, env.cmsSchema), bench.id);
                const admissionPid = await held.reached;
                const status = new Map([[bench.controller, { status: entry === "cleanup" ? "Completed" : "NotFound" }]]);
                const tools = createSweeperTools({ catalog, duroxideClient: stubDuroxide(status), factStore: null });
                const sweeping = sweep(tools, entry, bench.id);
                expect(await untilLockWait(db, "blocker", admissionPid, sweeping), "the Sweeper waits for the admission's lock").toBe(true);
                held.open();
                await admit.promise;
                const result = await sweeping;
                if (entry === "cleanup") expect(result, JSON.stringify(result)).toMatchObject({ ok: false, refused: true, status: "ActiveRun" });
                else expect(result.cmsRefused, JSON.stringify(result)).toBeGreaterThanOrEqual(1);
                expect(await isLive(db, schema, bench.id)).toBe(true);
                expect(await runRow(db, schema, admit.runId)).toEqual({ status: "admitted" });
                expect(await receiptRow(db, schema, bench.id, admit.operationId)).not.toBeNull();
            } finally {
                held.open();
                await admitting.end();
            }
        });

        it(`T4 (${entry}): a Sweeper that holds its final transaction first makes the admission wait, then refuse on the deleted session`, { timeout: TIMEOUT }, async () => {
            const owner = randomUUID();
            await catalog.createSession(owner);
            const bench = await makeBench(catalog, db, schema, owner);
            await ageSessions(db, schema, [bench.id], 60);
            // The Sweeper stops after its checks, at the soft delete, holding the bench's session lock.
            const held = gate();
            const sweeperPool = gatedPool(env.store, { matches: (sql, params) => sql.includes("cms_soft_delete_session") && params[0] === bench.id, held });
            try {
                const status = new Map([[bench.controller, { status: entry === "cleanup" ? "Completed" : "NotFound" }]]);
                const tools = createSweeperTools({ catalog: withStore(catalog, new WorkflowStore(sweeperPool, env.cmsSchema)),
                    duroxideClient: stubDuroxide(status), factStore: null });
                const sweeping = sweep(tools, entry, bench.id);
                const sweeperPid = await held.reached;
                const admit = admission(catalog.workflowStore(), bench.id);
                const settled = admit.promise.then(() => null, error => error);
                expect(await untilLockWait(db, "blocker", sweeperPid, settled), "the admission waits for the Sweeper's lock").toBe(true);
                held.open();
                const result = await sweeping;
                if (entry === "cleanup") expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
                else expect(result.cmsCleanedUp, JSON.stringify(result)).toBeGreaterThanOrEqual(1);
                const error = await settled;
                expect(error?.code, String(error?.message ?? error)).toBe("WORKFLOW_DELETED");
                expect(await isLive(db, schema, bench.id)).toBe(false);
                expect(await runRow(db, schema, admit.runId)).toBeNull();
                expect(await receiptRow(db, schema, bench.id, admit.operationId)).toBeNull();
            } finally {
                held.open();
                await sweeperPool.end();
            }
        });
    }

    // AR-02: the final check compares the row's exact version, read before the Sweeper judged it. Each change is made while
    // the Sweeper reads the session's status, after its read of the row.
    const AR02_CHANGES = {
        "no change (cleaned)": null,
        "updated_at moved forward": schema => `UPDATE ${schema}.sessions SET updated_at = updated_at + interval '1 second' WHERE session_id = $1`,
        "updated_at moved backward": schema => `UPDATE ${schema}.sessions SET updated_at = updated_at - interval '1 second' WHERE session_id = $1`,
        "updated_at unchanged (same instant)": schema => `UPDATE ${schema}.sessions SET title = 'changed', updated_at = updated_at WHERE session_id = $1`,
    };
    for (const entry of ["cleanup", "prune"]) {
        for (const [kind, change] of Object.entries(AR02_CHANGES)) {
            it(`AR-02 (${entry}): ${kind}${change ? " refuses (Changed)" : ""}`, { timeout: TIMEOUT }, async () => {
                const id = randomUUID();
                await catalog.createSession(id);
                await ageSessions(db, schema, [id], 60);
                const status = new Map([[`session-${id}`, { status: entry === "cleanup" ? "Completed" : "NotFound" }]]);
                const duroxide = stubDuroxide(status);
                const getStatus = duroxide.getStatus;
                duroxide.getStatus = async instanceId => {
                    if (instanceId === `session-${id}` && change) await db.query(change(schema), [id]);
                    return getStatus(instanceId);
                };
                const tools = createSweeperTools({ catalog, duroxideClient: duroxide, factStore: null });
                const result = await sweep(tools, entry, id);
                if (!change) {
                    if (entry === "cleanup") expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
                    expect(await isLive(db, schema, id)).toBe(false);
                    return;
                }
                if (entry === "cleanup") expect(result, JSON.stringify(result)).toMatchObject({ ok: false, refused: true, status: "Changed" });
                else expect(result.cmsRefused, JSON.stringify(result)).toBeGreaterThanOrEqual(1);
                expect(await isLive(db, schema, id)).toBe(true);
            });
        }
    }

    it("AR-03 (cleanup): a held descendant refuses at once (Busy), with no deadlock against a transaction that locks it then the target", { timeout: TIMEOUT }, async () => {
        const parent = randomUUID();
        const child = randomUUID();
        await catalog.createSession(parent);
        await catalog.createSession(child, { parentSessionId: parent });
        await ageSessions(db, schema, [parent, child], 60);
        const tools = createSweeperTools({ catalog, duroxideClient: stubDuroxide(new Map([[`session-${parent}`, { status: "Completed" }]])), factStore: null });
        const other = await db.connect();
        try {
            // Another transaction holds the descendant (as a pair lock does, child first) and will want the target next.
            await other.query("BEGIN");
            await other.query(`SELECT 1 FROM ${schema}.sessions WHERE session_id = $1 FOR SHARE`, [child]);
            const otherPid = (await other.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            const cleaning = findTool(tools, "cleanup_session").handler({ sessionId: parent });
            const waited = await untilLockWait(db, "blocker", otherPid, cleaning, 5_000).catch(() => false);
            // Then it locks the target. Had the Sweeper waited for the descendant while it held the target, this would be a
            // lock cycle that PostgreSQL ends by aborting one of them.
            const targetLock = await other.query(`SELECT 1 FROM ${schema}.sessions WHERE session_id = $1 FOR SHARE`, [parent]).then(() => null, error => error);
            if (waited) await other.query("ROLLBACK").catch(() => {});
            const result = await cleaning;
            expect(waited, "the Sweeper never waits for the held descendant").toBe(false);
            expect(result, JSON.stringify(result)).toMatchObject({ ok: false, refused: true, status: "Busy" });
            expect(targetLock, "the other transaction takes the target without a deadlock").toBeNull();
            expect(await isLive(db, schema, parent)).toBe(true);
            expect(await isLive(db, schema, child)).toBe(true);
            await other.query("COMMIT");
        } finally {
            await other.query("ROLLBACK").catch(() => {});
            other.release();
        }
        // Once the other transaction ended, the cleanup succeeds, with its descendant.
        const again = await findTool(tools, "cleanup_session").handler({ sessionId: parent });
        expect(again, JSON.stringify(again)).toMatchObject({ ok: true, descendants: 1 });
        expect(await isLive(db, schema, parent)).toBe(false);
        expect(await isLive(db, schema, child)).toBe(false);
    });

    it("AR-03 (prune): a held Workflow child of the owner keeps the owner (cmsRefused), without waiting", { timeout: TIMEOUT }, async () => {
        const owner = randomUUID();
        await catalog.createSession(owner);
        const bench = await makeBench(catalog, db, schema, owner);
        await ageSessions(db, schema, [owner], 60);
        // The owner reads NotFound; its bench is the Workflow child the owner-session trigger would delete with it.
        const tools = createSweeperTools({ catalog, duroxideClient: stubDuroxide(new Map([[`session-${owner}`, { status: "NotFound" }]])), factStore: null });
        const other = await db.connect();
        try {
            await other.query("BEGIN");
            await other.query(`SELECT 1 FROM ${schema}.sessions WHERE session_id = $1 FOR SHARE`, [bench.id]);
            const otherPid = (await other.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            const pruning = findTool(tools, "prune_orchestrations").handler({ deleteTerminalOlderThanMinutes: 5 });
            const waited = await untilLockWait(db, "blocker", otherPid, pruning, 5_000).catch(() => false);
            if (waited) await other.query("ROLLBACK").catch(() => {});
            const result = await pruning;
            expect(waited, "prune never waits for the held Workflow child").toBe(false);
            expect(result.cmsRefused, JSON.stringify(result)).toBeGreaterThanOrEqual(1);
            expect(await isLive(db, schema, owner)).toBe(true);
            expect(await isLive(db, schema, bench.id)).toBe(true);
            await other.query("COMMIT");
        } finally {
            await other.query("ROLLBACK").catch(() => {});
            other.release();
        }
    });

    // DR-02 (review of d5118761): the subtree is read again under the Sweeper's locks, and a child is created only after
    // its parent's lock (refused when the parent is deleted), so no session escapes a cleanup.
    for (const kind of ["ordinary", "Workflow"]) {
        it(`DR-02: a new ${kind} grandchild created between the subtree's read and its locks makes the cleanup refuse (Changed); nothing is deleted`, { timeout: TIMEOUT }, async () => {
            const root = randomUUID();
            const child = randomUUID();
            const grandchild = randomUUID();
            await catalog.createSession(root);
            await catalog.createSession(child, { parentSessionId: root });
            await ageSessions(db, schema, [root, child], 60);
            // The Sweeper stops just before it locks the descendants it read ([child]); the grandchild is created then.
            const held = gate();
            const sweeperPool = gatedPool(env.store, { matches: (sql, params) => sql.includes("FOR NO KEY UPDATE NOWAIT")
                && Array.isArray(params[0]) && params[0].includes(child), held });
            try {
                const tools = createSweeperTools({ catalog: withStore(catalog, new WorkflowStore(sweeperPool, env.cmsSchema)),
                    duroxideClient: stubDuroxide(new Map([[`session-${root}`, { status: "Completed" }]])), factStore: null });
                const cleaning = findTool(tools, "cleanup_session").handler({ sessionId: root });
                await held.reached;
                if (kind === "ordinary") await catalog.createSession(grandchild, { parentSessionId: child });
                else expect((await catalog.createWorkflowSession(grandchild, { parentSessionId: child, owner: null, creationConfig: {} })).created).toBe(true);
                held.open();
                const result = await cleaning;
                expect(result, JSON.stringify(result)).toMatchObject({ ok: false, refused: true, status: "Changed" });
                for (const id of [root, child, grandchild]) expect(await isLive(db, schema, id), id.slice(0, 8)).toBe(true);
            } finally {
                held.open();
                await sweeperPool.end();
            }
        });
    }

    it("DR-02: a creator blocked by the Sweeper's lock on the parent waits, then refuses (PARENT_DELETED); no child is created", { timeout: TIMEOUT }, async () => {
        const root = randomUUID();
        const child = randomUUID();
        await catalog.createSession(root);
        await catalog.createSession(child, { parentSessionId: root });
        await ageSessions(db, schema, [root, child], 60);
        // The Sweeper stops at its first soft delete (the child's), holding the root's and the child's locks.
        const held = gate();
        const sweeperPool = gatedPool(env.store, { matches: (sql, params) => sql.includes("cms_soft_delete_session") && params[0] === child, held });
        try {
            const tools = createSweeperTools({ catalog: withStore(catalog, new WorkflowStore(sweeperPool, env.cmsSchema)),
                duroxideClient: stubDuroxide(new Map([[`session-${root}`, { status: "Completed" }]])), factStore: null });
            const cleaning = findTool(tools, "cleanup_session").handler({ sessionId: root });
            const sweeperPid = await held.reached;
            const ordinary = randomUUID();
            const workflow = randomUUID();
            const creating = [
                catalog.createSession(ordinary, { parentSessionId: child }).then(() => null, error => error),
                catalog.createWorkflowSession(workflow, { parentSessionId: child, owner: null, creationConfig: {} }).then(() => null, error => error),
            ];
            const waited = await untilLockWait(db, "blocker", sweeperPid, Promise.race(creating));
            held.open();
            const result = await cleaning;
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, descendants: 1 });
            const [ordinaryError, workflowError] = await Promise.all(creating);
            expect(waited, "a creator waited for the Sweeper's lock on the parent").toBe(true);
            expect(ordinaryError?.code, String(ordinaryError?.message ?? ordinaryError)).toBe("PARENT_DELETED");
            expect(workflowError?.code, String(workflowError?.message ?? workflowError)).toBe("PARENT_DELETED");
            const rows = (await db.query(`SELECT session_id FROM ${schema}.sessions WHERE session_id = ANY($1::text[])`, [[ordinary, workflow]])).rows;
            expect(rows).toEqual([]);
            expect(await isLive(db, schema, root)).toBe(false);
            expect(await isLive(db, schema, child)).toBe(false);
        } finally {
            held.open();
            await sweeperPool.end();
        }
    });

    describe("AR-01: an ordinary session's first message and the Sweeper", () => {
        /**
         * A client with no worker: its start is queued (the orchestration reads NotFound) and gated by `startGate`. Its
         * sessions are API-created rows with no first message yet (made through the catalog: no model is needed).
         */
        async function startedClient(startGate) {
            const client = new PilotSwarmClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
            await client.start();
            const duroxide = client._getDuroxideClient();
            const start = duroxide.startOrchestrationVersioned.bind(duroxide);
            const starts = [];
            duroxide.startOrchestrationVersioned = async (...args) => {
                starts.push(args[0]);
                if (startGate) {
                    startGate.arrive();
                    await startGate.wait();
                }
                return start(...args);
            };
            return { client, starts };
        }

        async function sweeperClient() {
            const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
            return new Client(provider);
        }

        it("DR-01: a session whose first message was accepted and whose start is still queued is kept at any age (StartUnresolved); one shown to have ended is cleaned", { timeout: TIMEOUT }, async () => {
            const { client, starts } = await startedClient(null);
            try {
                const fresh = randomUUID();
                const stale = randomUUID();
                const ended = randomUUID();
                const neverStarted = randomUUID();
                for (const id of [fresh, stale, ended, neverStarted]) await catalog.createSession(id);
                // Three first messages commit their start; with no worker, each orchestration stays queued and reads NotFound.
                for (const id of [fresh, stale, ended]) await client._startTurn(id, "hello");
                expect(starts).toEqual([`session-${fresh}`, `session-${stale}`, `session-${ended}`]);
                await ageSessions(db, schema, [stale, neverStarted], 600);
                // Positive evidence of an end: the session's state says it ended.
                await db.query(`UPDATE ${schema}.sessions SET state = 'completed', updated_at = now() - interval '600 minutes' WHERE session_id = $1`, [ended]);
                const duroxide = await sweeperClient();
                for (const id of [fresh, stale, ended]) expect((await duroxide.getStatus(`session-${id}`)).status).toBe("NotFound");
                const tools = createSweeperTools({ catalog, duroxideClient: duroxide, factStore: null });

                const scanned = await findTool(tools, "scan_completed_sessions").handler({ graceMinutes: 5 });
                const listed = scanned.sessions.map(item => item.sessionId);
                expect(listed).not.toContain(stale);
                expect(listed).not.toContain(fresh);
                expect(listed).toEqual(expect.arrayContaining([ended, neverStarted]));
                for (const id of [fresh, stale]) {
                    for (const grace of [undefined, 0]) {
                        const refused = await findTool(tools, "cleanup_session").handler({ sessionId: id, ...(grace === undefined ? {} : { graceMinutes: grace }) });
                        expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, refused: true, status: "StartUnresolved" });
                    }
                }
                const pruned = await findTool(tools, "prune_orchestrations").handler({ deleteTerminalOlderThanMinutes: 0 });
                expect(pruned.ok, JSON.stringify(pruned)).toBe(true);
                expect(await rowState(db, schema, fresh)).toBe("kept");
                expect(await rowState(db, schema, stale)).toBe("kept");
                // The final check under the lock refuses it too (when a caller judged it NotFound on its own).
                const store = catalog.workflowStore();
                const version = await store.sweeperRowVersion(stale);
                expect(await store.sweeperSoftDelete({ sessionId: stale, version: version.version, cascade: true, orchestrationNotFound: true }))
                    .toMatchObject({ refused: { status: "StartUnresolved" } });
                expect(await rowState(db, schema, stale)).toBe("kept");
                // Shown to have ended, or never started: cleaned (prune took them above), as a soft delete.
                expect(await rowState(db, schema, ended)).toBe("soft-deleted");
                expect(await rowState(db, schema, neverStarted)).toBe("soft-deleted");
            } finally {
                await client.stop();
            }
        });
    });
});
