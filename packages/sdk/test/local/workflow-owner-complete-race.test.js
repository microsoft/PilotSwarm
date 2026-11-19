/**
 * Gap 5: completion and admission serialize on real owner-session locks, in both orders and for live/test runs.
 * Expected GREEN at 4fa702dc8: direct DB completion retains the existing owner trigger, with no cascade or refusal.
 * Admission first cancels the accepted run; completion first refuses the admission. Workflow sessions stay cancelled.
 * Option A changes neither the trigger nor these admission safeguards.
 *
 * Negative control: the same no-active-run oracle must fail before completion, when the control run really is running.
 * A missing owner lock, a dropped owner trigger or an admission left running after completion breaks this test.
 * No sleeps: checkpoint/reachedDuring and observeBlocked use the real pg_blocking_pids lock graph.
 * Run: npx vitest run test/local/workflow-owner-complete-race.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv, testTime } from "../helpers/local-env.js";
import { checkpoint, reachedDuring, observeBlocked } from "../helpers/workflow-request-fixture.js";
import { startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { startSessionWorkflowTest } from "../../src/workflow/definition-test.ts";
import {
    CASCADE_OWNER, CASCADE_ACTOR, CASCADE_TIMEOUT, WORKFLOW_SESSION_END_STATE, openOwnerCascadeRuntime, saveCascadeDefinition, startCascadeLive,
    pendingCascadeNode, cascadeControllerEnded, assertNoActiveCascadeRuns, assertActiveCascadeRuns,
} from "./workflow-owner-cascade-fixture.js";

const OWNER_ENDED_REASON = "The session that owns this Workflow ended, so the Workflow was canceled.";
const REFUSED_AFTER_END = "SESSION_NOT_LIVE";
const getEnv = useSuiteEnv(import.meta.url);

/** The backend that `holderPid` blocks while `work` runs (read from pg_blocking_pids); fails if `work` ends first. */
async function blockedBy(h, holderPid, work, label) {
    let done = false;
    work.then(() => { done = true; });
    const deadline = Date.now() + testTime.ms(20_000);
    while (Date.now() < deadline) {
        if (done) throw new Error(`The operation never reached ${label}: it ended without waiting for the completion's lock.`);
        const rows = await h.q("SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [holderPid]);
        if (rows[0]) return rows[0].pid;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`The operation never waited at ${label}.`);
}

describe("a run starting concurrently with its owner's completion never survives that completion", () => {
    for (const mode of ["live", "test"]) {
        for (const first of ["admission", "completion"]) {
            it(`gap 5 [GREEN]: ${mode}, ${first} holds the owner's lock first`, { timeout: CASCADE_TIMEOUT }, async () => {
                const env = getEnv();
                const h = await openOwnerCascadeRuntime(env);
                const ending = new pg.Client({
                    connectionString: env.store, connectionTimeoutMillis: testTime.ms(10_000),
                    statement_timeout: testTime.ms(20_000), lock_timeout: testTime.ms(15_000),
                });
                const gate = checkpoint();
                let transactionOpen = false;
                let startWork;
                let endWork;
                try {
                    await ending.connect();
                    const owner = randomUUID();
                    await h.catalog.createSession(owner, { owner: CASCADE_OWNER });
                    // A real running negative control, and an independent definition for the racing admission.
                    const control = await startCascadeLive(h.host, owner, "race-control");
                    await pendingCascadeNode(h.store, control);
                    await assertActiveCascadeRuns(h.q, [control.workflowId], [control.runId]);
                    const saved = await saveCascadeDefinition(h.host, owner, "racing-start");
                    let hooked = false;
                    h.control.hook = async ({ sql, params, query, client }) => {
                        const result = await query(sql, params);
                        if (first === "admission" && !hooked && /^INSERT INTO/.test(sql) && sql.includes("workflow_runs")) {
                            hooked = true;
                            gate.enter(client.processID);
                            // The run has been inserted, but its transaction has not committed or released the owner lock.
                            await gate.released;
                        }
                        return result;
                    };
                    const admit = () => mode === "live"
                        ? startSessionWorkflowDefinition(h.host, {
                            ownerSessionId: owner, definition: { definitionId: saved.definitionId }, inputs: {},
                            actor: CASCADE_ACTOR, operationId: `race-live-${randomUUID()}`, notifyParent: false,
                        })
                        : startSessionWorkflowTest(h.host, {
                            ownerSessionId: owner, definition: { definitionId: saved.definitionId }, inputs: {}, fixtures: [],
                            actor: CASCADE_ACTOR, operationId: `race-test-${randomUUID()}`,
                            owner: async () => CASCADE_OWNER, binding: async () => null,
                        });
                    await ending.query("BEGIN ISOLATION LEVEL READ COMMITTED");
                    transactionOpen = true;
                    if (first === "completion") {
                        await ending.query(`UPDATE "${env.cmsSchema}".sessions SET state = 'completed' WHERE session_id = $1`, [owner]);
                    }
                    startWork = admit().then(value => ({ ok: true, value }), error => ({ ok: false, error }));
                    // Admission first: its run is inserted through the store, before its commit (the hook above). Completion
                    // first: the admission's first owner lock is taken by the session's creation, on the catalog's own
                    // connection (it locks the owner before the Workflow session is made), so the waiter is found in the
                    // lock graph: the backend that the completion's transaction blocks.
                    const admissionPid = first === "admission"
                        ? await reachedDuring(gate, startWork, `${mode} admission's run insert`)
                        : await blockedBy(h, ending.processID, startWork, `${mode} admission's owner lock`);
                    expect(admissionPid).not.toBe(ending.processID);
                    if (first === "admission") {
                        endWork = ending.query(`UPDATE "${env.cmsSchema}".sessions SET state = 'completed' WHERE session_id = $1`, [owner]);
                        const observed = await observeBlocked(h, ending.processID, admissionPid);
                        expect(observed.blocked).toBe(true);
                        gate.release();
                        await endWork;
                    } else {
                        const observed = await observeBlocked(h, admissionPid, ending.processID);
                        expect(observed.blocked).toBe(true);
                    }
                    await ending.query("COMMIT");
                    transactionOpen = false;
                    const started = await startWork;
                    h.control.hook = null;
                    expect(await h.catalog.getSession(owner)).toMatchObject({ state: "completed" });
                    const children = await h.q("SELECT session_id FROM SCHEMA.sessions WHERE parent_session_id = $1 AND session_kind = 'workflow'", [owner]);
                    const childIds = children.map(row => row.session_id);
                    await assertNoActiveCascadeRuns(h.q, childIds);
                    if (first === "admission") {
                        expect(started.ok, started.error?.message).toBe(true);
                        const run = await h.store.readRun(started.value.runId);
                        expect(run).toMatchObject({
                            status: "cancelled", finishedAt: expect.any(Date),
                            terminalError: { code: "cancelled", message: OWNER_ENDED_REASON },
                        });
                        expect(run.terminalError).toEqual({ code: "cancelled", message: OWNER_ENDED_REASON });
                        await cascadeControllerEnded(h.client, run);
                        expect(await h.catalog.getSession(run.workflowSessionId)).toMatchObject({ state: WORKFLOW_SESSION_END_STATE });
                    } else {
                        expect(started.ok).toBe(false);
                        expect(started.error.code, started.error.message).toBe(REFUSED_AFTER_END);
                        // The racing definition made no run; a failed start cannot hide behind a cancelled control run.
                        expect(await h.q(`SELECT run.run_id FROM SCHEMA.workflow_runs run
                            JOIN SCHEMA.sessions child ON child.session_id = run.workflow_session_id
                            WHERE child.parent_session_id = $1 AND (
                                child.creation_config -> 'agentTest' ->> 'definitionId' = $2
                                OR EXISTS (SELECT 1 FROM SCHEMA.workflow_definitions definition
                                    WHERE definition.workflow_session_id = child.session_id AND definition.session_definition_id = $2))`,
                        [owner, saved.definitionId])).toEqual([]);
                    }
                    await cascadeControllerEnded(h.client, control);
                    expect(await h.catalog.getSession(control.workflowId)).toMatchObject({ state: WORKFLOW_SESSION_END_STATE });
                    expect((await h.store.readRun(control.runId)).terminalError).toEqual({ code: "cancelled", message: OWNER_ENDED_REASON });
                    await assertNoActiveCascadeRuns(h.q, childIds);
                } finally {
                    gate.release();
                    h.control.hook = null;
                    if (transactionOpen) await ending.query("ROLLBACK");
                    await Promise.allSettled([startWork, endWork].filter(Boolean));
                    try { await ending.end(); } finally { await h.stop(); }
                }
            });
        }
    }
});
