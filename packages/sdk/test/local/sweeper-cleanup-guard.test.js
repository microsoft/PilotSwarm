/**
 * Sweeper cleanup guardrail tests.
 *
 * Regression coverage for the 2026-06-28 incident where the Sweeper Agent
 * deleted LIVE root sessions after `scan_completed_sessions` returned stale
 * CHILD sessions grouped under those roots. The model collapsed the children
 * to their shared parent root and called `cleanup_session(root)`; the tool
 * accepted it because it only checked exists + not-system, so the live root
 * and its whole subtree were soft-deleted.
 *
 * These tests lock the TOOL boundary (not the model). They drive the sweeper
 * tool handlers directly against a real CMS catalog with a controlled
 * orchestration-status source (a stub duroxide client), so the live/terminal
 * state of each session is deterministic — no LLM, no real orchestration.
 *
 *   - cleanup_session REFUSES a live root inferred from stale children
 *   - cleanup_session still cleans a genuinely terminal target
 *   - cleanup_session cleans terminal children individually (by their own
 *     sessionId), refuses live/idle children, and preserves the live parent
 *   - cleanup_session batch (sessionIds[]) gates each target independently:
 *     cleans eligible ones, refuses live roots, de-dupes
 *   - a Workflow session is read by its latest run's controller (session-<id>
 *     for its live run, wft-<run> for a test bench's): a live Workflow and a
 *     running test stay; a finished Workflow and an ended test are cleaned; one
 *     with no run yet (a draft) is never a candidate; a failed read of its runs
 *     deletes nothing; its finished owner session's cleanup removes it
 *   - a status read that fails deletes nothing: scan, cleanup_session and
 *     prune_orchestrations skip such a session; prune soft-deletes a stale row
 *     only when its status is NotFound, and keeps one whose orchestration lives
 *
 * Run: npx vitest run test/local/sweeper-cleanup-guard.test.js
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, it, beforeAll } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { createSweeperTools } from "../../src/sweeper-tools.ts";
import { assertEqual, assertNotNull } from "../helpers/assertions.js";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);

function findTool(tools, name) {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    return tool;
}

/**
 * Stub duroxide client whose getStatus is driven by a status map keyed by
 * instance id (`session-<id>`). Anything not in the map is `fallback` (NotFound
 * unless given). An Error in the map is thrown, as duroxide's getStatus throws
 * on a failed read. This puts a session into a precise live/terminal
 * orchestration state without spinning up a real orchestration — the
 * orchestration status is an external input to the eligibility guard, so
 * controlling it is the point of the test.
 */
function makeStubDuroxide(statusByInstance, fallback = { status: "NotFound" }) {
    const enqueuedEvents = [];
    return {
        enqueuedEvents,
        async getStatus(instanceId) {
            const status = statusByInstance.get(instanceId) ?? fallback;
            if (status instanceof Error) throw status;
            return status;
        },
        async deleteInstanceBulk() { return { instancesDeleted: 0, executionsDeleted: 0, eventsDeleted: 0 }; },
        async pruneExecutionsBulk() { return { instancesProcessed: 0, executionsDeleted: 0, eventsDeleted: 0 }; },
        async enqueueEvent(orchestrationId, eventName, payload) {
            enqueuedEvents.push({ orchestrationId, eventName, payload });
        },
        // CMS soft-delete is what we assert against; the duroxide instance
        // delete is best-effort in the tool and irrelevant to the guard.
        async deleteInstance() {},
    };
}

async function isLive(catalog, sessionId) {
    const row = await catalog.getSession(sessionId);
    return !!row && row.deletedAt == null;
}

async function testRefusesLiveRoot(env) {
    const catalog = await createCatalog(env);
    try {
        const rootId = randomUUID();
        const childA = randomUUID();
        const childB = randomUUID();

        // The incident shape: a live root (recurring crawler) with two stale,
        // completed children hanging off it.
        await catalog.createSession(rootId, { agentId: "generic-crawler" });
        await catalog.createSession(childA, { parentSessionId: rootId });
        await catalog.createSession(childB, { parentSessionId: rootId });

        const status = new Map([
            // Root orchestration is alive (idle between cron wake-ups) — NOT terminal.
            [`session-${rootId}`, { status: "Running", customStatus: JSON.stringify({ status: "idle", cronActive: true }) }],
            // Children finished their tasks.
            [`session-${childA}`, { status: "Completed" }],
            [`session-${childB}`, { status: "Completed" }],
        ]);
        const tools = createSweeperTools({ catalog, duroxideClient: makeStubDuroxide(status), factStore: null });
        const cleanup = findTool(tools, "cleanup_session");

        // The bad call the model used to make: clean the inferred parent root.
        const res = await cleanup.handler({ sessionId: rootId, graceMinutes: 0 });
        console.log(`  cleanup_session(root) -> ok=${res.ok} refused=${res.refused} status=${res.status}`);
        assertEqual(res.ok, false, "cleanup_session must refuse a live root");
        assertEqual(res.refused, true, "refusal should be explicit");

        // Root and BOTH children must still be live — nothing was deleted.
        assertEqual(await isLive(catalog, rootId), true, "live root must survive");
        assertEqual(await isLive(catalog, childA), true, "child A must survive a refused root cleanup");
        assertEqual(await isLive(catalog, childB), true, "child B must survive a refused root cleanup");
        console.log("  ✓ live root and its children preserved");
    } finally {
        await catalog.close();
    }
}

async function testCleansTerminalTarget(env) {
    const catalog = await createCatalog(env);
    try {
        // A genuinely completed root is still cleanable — the guard must not
        // over-block legitimate cleanup.
        const rootId = randomUUID();
        await catalog.createSession(rootId);

        const status = new Map([[`session-${rootId}`, { status: "Completed" }]]);
        const tools = createSweeperTools({ catalog, duroxideClient: makeStubDuroxide(status), factStore: null });
        const cleanup = findTool(tools, "cleanup_session");

        const res = await cleanup.handler({ sessionId: rootId, graceMinutes: 0 });
        console.log(`  cleanup_session(terminal root) -> ok=${res.ok} deletedCount=${res.deletedCount}`);
        assertEqual(res.ok, true, "a genuinely terminal root is still cleanable");
        assertEqual(await isLive(catalog, rootId), false, "terminal root should be soft-deleted");
        console.log("  ✓ terminal root cleaned");
    } finally {
        await catalog.close();
    }
}

async function testCleanupOnlyCleansTerminalChildren(env) {
    const catalog = await createCatalog(env);
    try {
        const rootId = randomUUID();
        const childA = randomUUID();
        const childB = randomUUID();
        await catalog.createSession(rootId, { agentId: "generic-crawler" });
        await catalog.createSession(childA, { parentSessionId: rootId });
        await catalog.createSession(childB, { parentSessionId: rootId });

        const status = new Map([
            // Live root, idle between cron wake-ups.
            [`session-${rootId}`, { status: "Running", customStatus: JSON.stringify({ status: "idle", cronActive: true }) }],
            // childA finished (terminal); childB is an idle live sub-agent.
            [`session-${childA}`, { status: "Completed" }],
            [`session-${childB}`, { status: "Running", customStatus: JSON.stringify({ status: "idle" }) }],
        ]);
        const duroxide = makeStubDuroxide(status);
        const tools = createSweeperTools({ catalog, duroxideClient: duroxide, factStore: null });
        const cleanup = findTool(tools, "cleanup_session");

        // Terminal children still clean directly by their own sessionId.
        const a = await cleanup.handler({ sessionId: childA, graceMinutes: 0 });
        // Idle children are live sessions and are no longer cleanup targets.
        const refusedB = await cleanup.handler({ sessionId: childB, graceMinutes: 0 });
        console.log(`  cleanup_session(childA)=${a.ok} cleanup_session(idle childB)=${refusedB.ok}`);
        assertEqual(a.ok, true, "terminal child should be cleaned via cleanup_session");
        assertEqual(refusedB.ok, false, "idle child should be refused even when stale");
        assertEqual(refusedB.refused, true, "idle child refusal should be explicit");
        assertEqual(duroxide.enqueuedEvents.length, 0, "cleanup should not ask parents about idle children");

        assertEqual(await isLive(catalog, childA), false, "child A should be deleted");
        assertEqual(await isLive(catalog, childB), true, "child B should survive because it is live/idle");
        assertEqual(await isLive(catalog, rootId), true, "live parent root must remain after cleaning its children");
        console.log("  ✓ cleanup_session cleans only terminal children; live parent and idle child preserved");
    } finally {
        await catalog.close();
    }
}

async function testBatchGatesEachTarget(env) {
    const catalog = await createCatalog(env);
    try {
        const rootId = randomUUID();
        const childA = randomUUID();
        const childB = randomUUID();
        await catalog.createSession(rootId, { agentId: "generic-crawler" });
        await catalog.createSession(childA, { parentSessionId: rootId });
        await catalog.createSession(childB, { parentSessionId: rootId });

        const status = new Map([
            [`session-${rootId}`, { status: "Running", customStatus: JSON.stringify({ status: "idle", cronActive: true }) }],
            [`session-${childA}`, { status: "Completed" }],
            [`session-${childB}`, { status: "Running", customStatus: JSON.stringify({ status: "idle" }) }],
        ]);
        const tools = createSweeperTools({ catalog, duroxideClient: makeStubDuroxide(status), factStore: null });
        const cleanup = findTool(tools, "cleanup_session");

        // One batch call that (wrongly) includes the live parent root alongside
        // its two stale children. Each id is gated independently: the terminal
        // child is cleaned, the idle child is refused because it is live,
        // and the live root is refused — not deleted.
        const res = await cleanup.handler({ sessionIds: [childA, childB, rootId], graceMinutes: 0 });
        console.log(`  batch -> ok=${res.ok} cleaned=${res.cleanedCount} refused=${res.refusedCount} totalDeleted=${res.totalDeleted}`);
        assertEqual(res.ok, true, "batch call returns ok");
        assertEqual(res.batch, true, "batch flag set");
        assertEqual(res.cleanedCount, 1, "terminal child cleaned");
        assertEqual(res.refusedCount, 2, "the idle child and live root are refused");
        assertEqual(res.totalDeleted, 1, "exactly one session deleted");

        assertEqual(await isLive(catalog, childA), false, "child A deleted");
        assertEqual(await isLive(catalog, childB), true, "child B survives because it is live/idle");
        assertEqual(await isLive(catalog, rootId), true, "live root survives batch (refused)");

        const rootResult = res.results.find(r => r.sessionId === rootId);
        assertNotNull(rootResult, "root has a per-id result");
        assertEqual(rootResult.refused, true, "root result marked refused");
        const idleChildResult = res.results.find(r => r.sessionId === childB);
        assertNotNull(idleChildResult, "idle child has a per-id result");
        assertEqual(idleChildResult.refused, true, "idle child result marked refused");
        console.log("  ✓ batch gates each target independently");
    } finally {
        await catalog.close();
    }
}

async function testBatchCleansAllEligibleAndDedupes(env) {
    const catalog = await createCatalog(env);
    try {
        const ids = [randomUUID(), randomUUID(), randomUUID()];
        for (const id of ids) await catalog.createSession(id); // standalone terminal roots
        const status = new Map(ids.map(id => [`session-${id}`, { status: "Completed" }]));
        const tools = createSweeperTools({ catalog, duroxideClient: makeStubDuroxide(status), factStore: null });
        const cleanup = findTool(tools, "cleanup_session");

        // Pass a duplicate id to exercise de-duplication.
        const res = await cleanup.handler({ sessionIds: [...ids, ids[0]], graceMinutes: 0 });
        console.log(`  batch all-eligible -> requested=${res.requested} cleaned=${res.cleanedCount}`);
        assertEqual(res.requested, 3, "duplicate id is de-duplicated");
        assertEqual(res.cleanedCount, 3, "all three terminal sessions cleaned");
        assertEqual(res.refusedCount, 0, "nothing refused");
        for (const id of ids) assertEqual(await isLive(catalog, id), false, `session ${id.slice(0, 8)} deleted`);
        console.log("  ✓ batch cleans all eligible and de-dupes");
    } finally {
        await catalog.close();
    }
}

/**
 * A Workflow session with its definition and, for each run given, a run row whose controller is `controller` (as the
 * store records it: `session-<id>` for its live run, `wft-<run>` for a test run). `status` is the store's run status.
 */
async function makeWorkflow(catalog, db, schema, { parent, bench = false, runs = [] }) {
    const id = randomUUID();
    const claim = await catalog.createWorkflowSession(id, {
        parentSessionId: parent, owner: null,
        creationConfig: bench ? { agentTest: { definitionId: "def-1", revision: 1 } } : {},
        ...(bench ? { service: { kind: "workflow-test", of: null } } : {}),
    });
    assertEqual(claim.created, true, "the Workflow session is claimed");
    await db.query(`INSERT INTO ${schema}.workflow_definitions (workflow_session_id, parent_session_id, api_version, state, current_revision)
        VALUES ($1, $2, 'pilotswarm.dev/v1', 'draft', 1)`, [id, parent]);
    await db.query(`INSERT INTO ${schema}.workflow_revisions (workflow_session_id, revision, yaml, yaml_sha256, valid, diagnostics, ir, ir_sha256, actor)
        VALUES ($1, 1, 'y', 'ys', TRUE, '[]', '{}', 'is', '{"kind":"system","name":"sweeper-test"}')`, [id]);
    const runIds = [];
    for (const [index, run] of runs.entries()) {
        const runId = randomUUID();
        const test = run.mode === "test";
        const controller = test ? `wft-${runId}` : `session-${id}`;
        const ended = ["completed", "failed", "cancelled", "stopped"].includes(run.status);
        await db.query(`INSERT INTO ${schema}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs,
                controller_instance_id, status, test_agent_mode, start_operation_id, finished_at, created_at)
            VALUES ($1, $2, $3, 1, 'ys', 'is', '{}', $4, $5, $6, $7, CASE WHEN $8 THEN now() END, now() - make_interval(secs => $9))`,
        [runId, id, test ? "test" : "live", controller, run.status, test ? "mocked" : null, `op-${runId}`, ended, 100 - index]);
        runIds.push({ runId, controller });
    }
    return { id, runs: runIds };
}

const runStatus = async (db, schema, runId) => (await db.query(`SELECT status FROM ${schema}.workflow_runs WHERE run_id = $1`, [runId])).rows[0]?.status;
const definitionState = async (db, schema, id) => (await db.query(`SELECT state FROM ${schema}.workflow_definitions WHERE workflow_session_id = $1`,
    [id])).rows[0]?.state;

async function testWorkflowSessionsByTheirControllers(env) {
    const catalog = await createCatalog(env);
    const db = new pg.Pool({ connectionString: env.store, max: 1 });
    const schema = `"${env.cmsSchema}"`;
    try {
        const owner = randomUUID();
        await catalog.createSession(owner);
        // A live Workflow (its controller session-<id> runs), a finished one (its controller is gone), a running test bench
        // (wft-<run> runs), an ended bench (its wft-<run> is gone), and a Workflow with no run yet (a draft).
        const live = await makeWorkflow(catalog, db, schema, { parent: owner, runs: [{ mode: "live", status: "running" }] });
        const finished = await makeWorkflow(catalog, db, schema, { parent: owner, runs: [{ mode: "live", status: "completed" }] });
        const benchRunning = await makeWorkflow(catalog, db, schema, { parent: owner, bench: true, runs: [{ mode: "test", status: "running" }] });
        const benchEnded = await makeWorkflow(catalog, db, schema, { parent: owner, bench: true, runs: [{ mode: "test", status: "completed" }] });
        const draft = await makeWorkflow(catalog, db, schema, { parent: owner });
        // A Workflow whose latest run ended while an earlier test run still runs: the running one keeps it live.
        const mixed = await makeWorkflow(catalog, db, schema, { parent: owner, runs: [{ mode: "test", status: "running" }, { mode: "live", status: "completed" }] });
        const all = [live, finished, benchRunning, benchEnded, draft, mixed];
        await ageSessions(env, all.map(w => w.id), 60);

        // A status read of session-<id> would say NotFound for every bench and draft: only the controllers below exist.
        const status = new Map([
            [`session-${owner}`, { status: "Running" }],
            [live.runs[0].controller, { status: "Running" }],
            [benchRunning.runs[0].controller, { status: "Running" }],
            [mixed.runs[0].controller, { status: "Running" }],
        ]);
        const duroxide = makeStubDuroxide(status, { status: "NotFound" });
        const read = [];
        const getStatus = duroxide.getStatus;
        duroxide.getStatus = async id => { read.push(id); return getStatus(id); };
        const tools = createSweeperTools({ catalog, duroxideClient: duroxide, factStore: null });

        // scan lists exactly the two whose controllers are gone, and reads each Workflow's own controller.
        const scanned = await findTool(tools, "scan_completed_sessions").handler({ graceMinutes: 5 });
        const listed = new Set(scanned.sessions.map(s => s.sessionId));
        for (const w of all) assertEqual(listed.has(w.id), w === finished || w === benchEnded, `scan lists ${w.id.slice(0, 8)} only when its controller is gone`);
        assertEqual(read.includes(benchRunning.runs[0].controller), true, "the bench is read by its wft-<run> controller");
        assertEqual(read.includes(`session-${benchRunning.id}`), false, "the bench's session-<id> is not read");

        // cleanup_session refuses the live ones and the one with no run.
        for (const w of [live, benchRunning, draft, mixed]) {
            const refused = await findTool(tools, "cleanup_session").handler({ sessionId: w.id, graceMinutes: 0 });
            assertEqual(refused.ok, false, `cleanup refuses ${w.id.slice(0, 8)}`);
            assertEqual(await isLive(catalog, w.id), true, `${w.id.slice(0, 8)} stays`);
        }
        assertEqual((await findTool(tools, "cleanup_session").handler({ sessionId: draft.id, graceMinutes: 0 })).status, "NoRun", "a draft is refused for having no run");

        // cleanup_session cleans the finished Workflow through the normal path: soft-deleted, its definition a tombstone,
        // its ended run unchanged; nothing live is touched.
        const cleaned = await findTool(tools, "cleanup_session").handler({ sessionId: finished.id, graceMinutes: 0 });
        assertEqual(cleaned.ok, true, "the finished Workflow is cleaned");
        assertEqual(await isLive(catalog, finished.id), false, "the finished Workflow is soft-deleted");
        assertEqual(await definitionState(db, schema, finished.id), "deleted", "its definition is a tombstone");
        assertEqual(await runStatus(db, schema, finished.runs[0].runId), "completed", "its ended run is unchanged");

        // prune soft-deletes the ended bench (its wft-<run> is NotFound) and keeps every live one and the draft.
        const pruned = await findTool(tools, "prune_orchestrations").handler({ deleteTerminalOlderThanMinutes: 5 });
        assertEqual(pruned.ok, true, "prune ran");
        assertEqual(await isLive(catalog, benchEnded.id), false, "the ended bench is soft-deleted");
        assertEqual(await runStatus(db, schema, benchEnded.runs[0].runId), "completed", "the ended test run is unchanged");
        for (const w of [live, benchRunning, draft, mixed]) assertEqual(await isLive(catalog, w.id), true, `prune keeps ${w.id.slice(0, 8)}`);
        assertEqual(await runStatus(db, schema, live.runs[0].runId), "running", "the live run still runs");
        assertEqual(await runStatus(db, schema, benchRunning.runs[0].runId), "running", "the running test still runs");
        assertEqual(await definitionState(db, schema, draft.id), "draft", "the draft's definition is untouched");
        console.log("  ✓ Workflow sessions are read by their controllers: live and running tests stay, ended ones are cleaned, a draft stays");
    } finally {
        await db.end();
        await catalog.close();
    }
}

async function testWorkflowStoreReadFailureDeletesNothing(env) {
    const catalog = await createCatalog(env);
    const db = new pg.Pool({ connectionString: env.store, max: 1 });
    const schema = `"${env.cmsSchema}"`;
    try {
        const owner = randomUUID();
        await catalog.createSession(owner);
        const finished = await makeWorkflow(catalog, db, schema, { parent: owner, runs: [{ mode: "live", status: "completed" }] });
        await ageSessions(env, [finished.id], 60);
        // The catalog answers, but its Workflow store's read of the runs fails.
        const failing = Object.create(catalog);
        failing.workflowStore = () => ({ listRuns: async () => { throw new Error("connection terminated unexpectedly"); } });
        const tools = createSweeperTools({ catalog: failing,
            duroxideClient: makeStubDuroxide(new Map([[`session-${owner}`, { status: "Running" }]]), { status: "NotFound" }), factStore: null });
        const scanned = await findTool(tools, "scan_completed_sessions").handler({ graceMinutes: 5 });
        assertEqual(scanned.sessions.some(s => s.sessionId === finished.id), false, "a failed store read is not a candidate");
        assertEqual(scanned.unreadable?.includes(finished.id), true, "the failed store read is reported");
        const refused = await findTool(tools, "cleanup_session").handler({ sessionId: finished.id, graceMinutes: 0 });
        assertEqual(refused.status, "Unreadable", "cleanup refuses on a failed store read");
        const pruned = await findTool(tools, "prune_orchestrations").handler({ deleteTerminalOlderThanMinutes: 5 });
        assertEqual(pruned.cmsUnreadable >= 1, true, "prune counts the failed store read");
        assertEqual(await isLive(catalog, finished.id), true, "nothing is deleted on a failed store read");
        console.log("  ✓ a failed read of a Workflow's runs deletes nothing");
    } finally {
        await db.end();
        await catalog.close();
    }
}

async function testWorkflowWithOwnerCleanup(env) {
    const catalog = await createCatalog(env);
    const db = new pg.Pool({ connectionString: env.store, max: 1 });
    const schema = `"${env.cmsSchema}"`;
    try {
        // A finished owner session removes its Workflow sessions with it, as any descendant.
        const owner = randomUUID();
        await catalog.createSession(owner);
        const bench = await makeWorkflow(catalog, db, schema, { parent: owner, bench: true, runs: [{ mode: "test", status: "completed" }] });
        const tools = createSweeperTools({ catalog, duroxideClient: makeStubDuroxide(new Map([[`session-${owner}`, { status: "Completed" }]])), factStore: null });
        const cleaned = await findTool(tools, "cleanup_session").handler({ sessionId: owner, graceMinutes: 0 });
        assertEqual(cleaned.ok, true, "the finished owner session is cleaned");
        assertEqual(await isLive(catalog, bench.id), false, "its bench is deleted with it");
        assertEqual(await definitionState(db, schema, bench.id), "deleted", "the bench's definition is a tombstone");
        console.log("  ✓ a finished owner session's cleanup removes its Workflow sessions");
    } finally {
        await db.end();
        await catalog.close();
    }
}

async function ageSessions(env, ids, minutes) {
    const db = new pg.Pool({ connectionString: env.store, max: 1 });
    try {
        await db.query(`UPDATE "${env.cmsSchema}".sessions SET updated_at = now() - make_interval(mins => $2) WHERE session_id = ANY($1::text[])`,
            [ids, minutes]);
    } finally {
        await db.end();
    }
}

async function testFailedReadDeletesNothing(env) {
    const catalog = await createCatalog(env);
    try {
        // Three stale roots: one whose status read fails, one NotFound, one live.
        const unreadable = randomUUID();
        const gone = randomUUID();
        const live = randomUUID();
        for (const id of [unreadable, gone, live]) await catalog.createSession(id);
        await ageSessions(env, [unreadable, gone, live], 60);
        const status = new Map([
            [`session-${unreadable}`, new Error("connection terminated unexpectedly")],
            [`session-${gone}`, { status: "NotFound" }],
            [`session-${live}`, { status: "Running" }],
        ]);
        // Anything else in the schema reads as live, so prune touches only these three.
        const tools = createSweeperTools({ catalog, duroxideClient: makeStubDuroxide(status, { status: "Running" }), factStore: null });

        // scan: the failed read is not a candidate, and is counted; NotFound is.
        const scanned = await findTool(tools, "scan_completed_sessions").handler({ graceMinutes: 5 });
        const listed = scanned.sessions.map(s => s.sessionId);
        assertEqual(listed.includes(unreadable), false, "a failed read is not a scan candidate");
        assertEqual(listed.includes(gone), true, "a NotFound session is a scan candidate");
        assertEqual(listed.includes(live), false, "a live session is not a scan candidate");
        assertEqual(scanned.unreadable?.includes(unreadable), true, "the failed read is reported");

        // cleanup_session: a failed read is refused; the row stays.
        const refused = await findTool(tools, "cleanup_session").handler({ sessionId: unreadable, graceMinutes: 0 });
        assertEqual(refused.ok, false, "cleanup_session refuses a session whose status cannot be read");
        assertEqual(refused.refused, true, "the refusal is explicit");
        assertEqual(refused.status, "Unreadable", "the refusal names the failed read");
        assertEqual(await isLive(catalog, unreadable), true, "the row stays after a refused cleanup");

        // prune_orchestrations: soft-deletes only NotFound; a failed read is skipped and counted; a live row stays.
        const pruned = await findTool(tools, "prune_orchestrations").handler({ deleteTerminalOlderThanMinutes: 5 });
        assertEqual(pruned.ok, true, "prune ran");
        assertEqual(pruned.cmsCleanedUp, 1, "prune soft-deleted exactly the NotFound row");
        assertEqual(pruned.cmsUnreadable, 1, "prune counted the failed read");
        assertEqual(await isLive(catalog, gone), false, "the NotFound row is soft-deleted");
        assertEqual(await isLive(catalog, unreadable), true, "the row whose read failed is not deleted");
        assertEqual(await isLive(catalog, live), true, "the live row is kept");
        console.log("  ✓ a failed status read deletes nothing; NotFound is deleted; a live session stays");
    } finally {
        await catalog.close();
    }
}

async function testPruneKeepsRecentNotFound(env) {
    const catalog = await createCatalog(env);
    try {
        // A session created a moment ago has no orchestration until its first turn: NotFound, but not older than the cutoff.
        const fresh = randomUUID();
        await catalog.createSession(fresh);
        const tools = createSweeperTools({ catalog, duroxideClient: makeStubDuroxide(new Map([[`session-${fresh}`, { status: "NotFound" }]]),
            { status: "Running" }), factStore: null });
        const pruned = await findTool(tools, "prune_orchestrations").handler({ deleteTerminalOlderThanMinutes: 5 });
        assertEqual(pruned.cmsCleanedUp, 0, "a recent NotFound row is not deleted");
        assertEqual(await isLive(catalog, fresh), true, "the new session stays");
        console.log("  ✓ prune keeps a NotFound row younger than its cutoff");
    } finally {
        await catalog.close();
    }
}

describe("Sweeper cleanup guardrails", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("cleanup_session refuses a live root inferred from stale children", { timeout: TIMEOUT }, async () => {
        await testRefusesLiveRoot(getEnv());
    });

    it("cleanup_session still cleans a genuinely terminal target", { timeout: TIMEOUT }, async () => {
        await testCleansTerminalTarget(getEnv());
    });

    it("cleanup_session cleans only terminal children while preserving live children", { timeout: TIMEOUT }, async () => {
        await testCleanupOnlyCleansTerminalChildren(getEnv());
    });

    it("cleanup_session batch gates each target (cleans children, refuses live root)", { timeout: TIMEOUT }, async () => {
        await testBatchGatesEachTarget(getEnv());
    });

    it("cleanup_session batch cleans all eligible targets and de-dupes", { timeout: TIMEOUT }, async () => {
        await testBatchCleansAllEligibleAndDedupes(getEnv());
    });

    it("a Workflow session's status is its controller's: live Workflows and running tests stay, ended ones are cleaned, a draft stays", { timeout: TIMEOUT }, async () => {
        await testWorkflowSessionsByTheirControllers(getEnv());
    });

    it("a failed read of a Workflow session's runs deletes nothing", { timeout: TIMEOUT }, async () => {
        await testWorkflowStoreReadFailureDeletesNothing(getEnv());
    });

    it("a finished owner session's cleanup removes its Workflow sessions with it", { timeout: TIMEOUT }, async () => {
        await testWorkflowWithOwnerCleanup(getEnv());
    });

    it("a failed status read deletes nothing in scan, cleanup or prune; prune deletes NotFound and keeps a live session", { timeout: TIMEOUT }, async () => {
        await testFailedReadDeletesNothing(getEnv());
    });

    it("prune keeps a NotFound row younger than its cutoff", { timeout: TIMEOUT }, async () => {
        await testPruneKeepsRecentNotFound(getEnv());
    });
});
