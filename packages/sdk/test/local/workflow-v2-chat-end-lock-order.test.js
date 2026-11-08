/**
 * Stage 2 review S2RT-F2, on PostgreSQL: the chat-ended trigger (migration 0109) takes its locks in the runtime's order.
 * A runtime transaction (a person's pause of a Workflow's run: its session row, then its definition, then its run) is held
 * at a barrier right after it locked the Workflow's session row. The chat is canceled from another connection meanwhile:
 * its trigger now waits for the Workflow's session row before it touches the run, so the pause goes on, both commit, and
 * nothing deadlocks. 0107's trigger locked the run first and waited for the session row, a cycle PostgreSQL broke by
 * aborting one of them. After the accepted end, nothing of the run is admitted: it is canceled.
 *
 * Run: npx vitest run test/local/workflow-v2-chat-end-lock-order.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";
import { controlWorkflowV2Run } from "../../src/workflow/v2/service.ts";
import { saveChatWorkflowDefinition, startChatWorkflowDefinition } from "../../src/workflow/v2/chat-definitions.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "chat-end-lock-order" };
const ENGINE = { kind: "system", name: "chat-end-lock-order-test" };
const YAML = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: waiter, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 3600, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

describe("the chat-ended trigger and the runtime take their locks in one order (0109)", () => {
    it("S2RT-F2: a chat canceled while a run's pause holds its Workflow's session row: both commit, no deadlock, the run ends canceled", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await openWorkflowStore(env);
        const direct = new pg.Pool({ connectionString: env.store, max: 2 });
        try {
            const host = { catalog: h.catalog, store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} } };
            const chat = randomUUID();
            await h.catalog.createSession(chat, { owner: OWNER });
            const saved = (await saveChatWorkflowDefinition(host, { ownerSessionId: chat, name: "waiter", yaml: YAML, expected: null,
                actor: { kind: "chat", sessionId: chat }, operationId: "save-1", by: "chat" })).receipt;
            const started = await startChatWorkflowDefinition(host, { ownerSessionId: chat, definition: { definitionId: saved.definitionId }, inputs: {},
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
            const pause = controlWorkflowV2Run(host, started.workflowId, { operation: "pause", runId: null, reason: "barrier" },
                { actor: ENGINE, operationId: "pause-1" });
            await atBarrier;
            const cancel = direct.query(`UPDATE "${env.cmsSchema}".sessions SET state = 'cancelled' WHERE session_id = $1`, [chat]);
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
            await expect(controlWorkflowV2Run(host, started.workflowId, { operation: "resume", runId: started.runId, reason: "after" },
                { actor: ENGINE, operationId: "resume-1" })).rejects.toThrow();
            const after = await direct.query(`SELECT status FROM "${env.cmsSchema}".workflow_runs WHERE workflow_session_id = $1`, [started.workflowId]);
            expect(after.rows).toEqual([{ status: "cancelled" }]);
        } finally {
            h.control.hook = null;
            await direct.end();
            await h.stop();
        }
    });
    // The executor's run at ea596f23: a chat that ends while its Workflow's run is paused. 0107's function, and 0109 as first
    // written, cancelled the run but left paused_from, which the 0091 check refuses: the chat's own update failed.
    it("a chat that ends while its Workflow's run is paused: the chat ends, the run is canceled with no paused_from", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await openWorkflowStore(env);
        try {
            const host = { catalog: h.catalog, store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} } };
            for (const end of ["cancelled", "completed", "failed"]) {
                const chat = randomUUID();
                await h.catalog.createSession(chat, { owner: OWNER });
                const saved = (await saveChatWorkflowDefinition(host, { ownerSessionId: chat, name: "waiter", yaml: YAML, expected: null,
                    actor: { kind: "chat", sessionId: chat }, operationId: "save-1", by: "chat" })).receipt;
                const started = await startChatWorkflowDefinition(host, { ownerSessionId: chat, definition: { definitionId: saved.definitionId }, inputs: {},
                    actor: ENGINE, operationId: "start-1" });
                await controlWorkflowV2Run(host, started.workflowId, { operation: "pause", runId: null, reason: "paused" }, { actor: ENGINE, operationId: "pause-1" });
                expect((await h.store.readRun(started.runId)).status).toBe("paused");
                await h.catalog.updateSession(chat, { state: end });
                expect((await h.catalog.getSession(chat)).state, end).toBe(end);
                const { rows } = await h.pool.query(`SELECT status, paused_from FROM "${env.cmsSchema}".workflow_runs WHERE run_id = $1`, [started.runId]);
                expect(rows, end).toEqual([{ status: "cancelled", paused_from: null }]);
            }
        } finally {
            await h.stop();
        }
    });
});
