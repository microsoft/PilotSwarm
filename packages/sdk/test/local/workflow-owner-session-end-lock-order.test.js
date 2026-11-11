/**
 * Stage 2 review S2RT-F2, on PostgreSQL: the owner-session-ended trigger (migration 0088) takes its locks in the runtime's order.
 * A runtime transaction (a person's pause of a Workflow's run: its session row, then its definition, then its run) is held
 * at a barrier right after it locked the Workflow's session row. The session is canceled from another connection meanwhile:
 * its trigger now waits for the Workflow's session row before it touches the run, so the pause goes on, both commit, and
 * nothing deadlocks. A trigger that locked the run first and then waited for the session row would make a cycle, which
 * PostgreSQL breaks by aborting one of them. After the accepted end, nothing of the run is admitted: it is canceled.
 *
 * Run: npx vitest run test/local/workflow-owner-session-end-lock-order.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { controlWorkflowRun } from "../../src/workflow/service.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "owner-session-end-lock-order" };
const ENGINE = { kind: "system", name: "owner-session-end-lock-order-test" };
const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: waiter, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 3600, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

describe("the owner-session-ended trigger and the runtime take their locks in one order (0088)", () => {
    it("S2RT-F2: a session canceled while a run's pause holds its Workflow's session row: both commit, no deadlock, the run ends canceled", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await openWorkflowStore(env);
        const direct = new pg.Pool({ connectionString: env.store, max: 2 });
        try {
            const host = { catalog: h.catalog, store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} } };
            const ownerSession = randomUUID();
            await h.catalog.createSession(ownerSession, { owner: OWNER });
            const saved = (await saveSessionWorkflowDefinition(host, { ownerSessionId: ownerSession, name: "waiter", yaml: YAML, expected: null,
                actor: { kind: "session", sessionId: ownerSession }, operationId: "save-1", by: "session" })).receipt;
            const started = await startSessionWorkflowDefinition(host, { ownerSessionId: ownerSession, definition: { definitionId: saved.definitionId }, inputs: {},
                actor: ENGINE, operationId: "start-1" });
            // The barrier: right after the pause's transaction locked the Workflow's session row.
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            let reached;
            const atBarrier = new Promise(resolve => { reached = resolve; });
            let held = false;
            h.control.hook = async ({ sql, params, query }) => {
                const result = await query(sql, params);
                if (!held && /FOR NO KEY UPDATE/.test(sql) && Array.isArray(params) && params[0] === started.workflowId) {
                    held = true;
                    reached();
                    await gate;
                }
                return result;
            };
            const pause = controlWorkflowRun(host, started.workflowId, { operation: "pause", runId: null, reason: "barrier" },
                { actor: ENGINE, operationId: "pause-1" });
            await atBarrier;
            const cancel = direct.query(`UPDATE "${env.cmsSchema}".sessions SET state = 'cancelled' WHERE session_id = $1`, [ownerSession]);
            // Long enough for the old trigger to have locked the run and be waiting for the session row (deadlock_timeout is 1 s).
            await new Promise(resolve => setTimeout(resolve, 1_500));
            release();
            const [paused, canceled] = await Promise.allSettled([pause, cancel]);
            expect(paused.status, String(paused.reason?.message ?? "")).toBe("fulfilled");
            expect(canceled.status, String(canceled.reason?.message ?? "")).toBe("fulfilled");
            h.control.hook = null;
            const { rows } = await direct.query(`SELECT status, mode FROM "${env.cmsSchema}".workflow_runs WHERE workflow_session_id = $1`, [started.workflowId]);
            expect(rows).toEqual([{ status: "cancelled", mode: "live" }]);
            const session = await h.catalog.getSession(started.workflowId);
            expect(session.state).toBe("cancelled");
            // After the accepted end, nothing of it is admitted: a resume is refused, and the run stays canceled.
            await expect(controlWorkflowRun(host, started.workflowId, { operation: "resume", runId: started.runId, reason: "after" },
                { actor: ENGINE, operationId: "resume-1" })).rejects.toThrow();
            const after = await direct.query(`SELECT status FROM "${env.cmsSchema}".workflow_runs WHERE workflow_session_id = $1`, [started.workflowId]);
            expect(after.rows).toEqual([{ status: "cancelled" }]);
        } finally {
            h.control.hook = null;
            await direct.end();
            await h.stop();
        }
    });
    // The executor's run at ea596f23: an owner session that ends while its Workflow's run is paused. A trigger that cancels the run but
    // leaves paused_from is refused by the runs' paused check, and the session's own update fails.
    it("an owner session that ends while its Workflow's run is paused: the owner session ends, the run is canceled with no paused_from", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await openWorkflowStore(env);
        try {
            const host = { catalog: h.catalog, store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} } };
            for (const end of ["cancelled", "completed", "failed"]) {
                const ownerSession = randomUUID();
                await h.catalog.createSession(ownerSession, { owner: OWNER });
                const saved = (await saveSessionWorkflowDefinition(host, { ownerSessionId: ownerSession, name: "waiter", yaml: YAML, expected: null,
                    actor: { kind: "session", sessionId: ownerSession }, operationId: "save-1", by: "session" })).receipt;
                const started = await startSessionWorkflowDefinition(host, { ownerSessionId: ownerSession, definition: { definitionId: saved.definitionId }, inputs: {},
                    actor: ENGINE, operationId: "start-1" });
                await controlWorkflowRun(host, started.workflowId, { operation: "pause", runId: null, reason: "paused" }, { actor: ENGINE, operationId: "pause-1" });
                expect((await h.store.readRun(started.runId)).status).toBe("paused");
                await h.catalog.updateSession(ownerSession, { state: end });
                expect((await h.catalog.getSession(ownerSession)).state, end).toBe(end);
                const { rows } = await h.pool.query(`SELECT status, paused_from FROM "${env.cmsSchema}".workflow_runs WHERE run_id = $1`, [started.runId]);
                expect(rows, end).toEqual([{ status: "cancelled", paused_from: null }]);
            }
        } finally {
            await h.stop();
        }
    });
});
