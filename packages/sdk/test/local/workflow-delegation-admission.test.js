import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv, testTime } from "../helpers/local-env.js";
import { checkpoint, reachedDuring, observeBlocked } from "../helpers/workflow-request-fixture.js";
import { startSessionWorkflowDefinition, workflowStartSessionId } from "../../src/workflow/session-definitions.ts";
import {
    CASCADE_OWNER, CASCADE_ACTOR, CASCADE_TIMEOUT, openOwnerCascadeRuntime, saveCascadeDefinition, cascadeControllerEnded,
} from "./workflow-owner-cascade-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const isDelegation = (sql, params) => sql.includes("cms_record_events")
    && params.some(value => typeof value === "string" && value.includes('"workflow.tools_delegated"'));
const transactionId = async query => (await query("SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS xid")).rows[0];

function observeStarts(h, gate) {
    const client = Object.create(h.client);
    for (const name of ["startOrchestration", "startOrchestrationVersioned"]) {
        if (typeof h.client[name] !== "function") continue;
        client[name] = async (...args) => {
            const result = await h.client[name](...args);
            gate.enter(args[0]);
            return result;
        };
    }
    return { ...h.host, duroxideClient: client };
}

describe("delegation audit is part of Workflow admission", () => {
    it("owner completion at the former audit gap cannot strand a cancelled run with a NotFound controller",
        { timeout: CASCADE_TIMEOUT }, async () => {
            const env = getEnv();
            const h = await openOwnerCascadeRuntime(env);
            const ending = new pg.Client({ connectionString: env.store, statement_timeout: testTime.ms(20_000) });
            const admission = checkpoint(), audit = checkpoint(), dispatched = checkpoint();
            let startWork, endWork, transactionOpen = false;
            let admittedTransaction, auditTransaction, workflowId;
            const transactions = new Map();
            try {
                await ending.connect();
                const owner = randomUUID();
                await h.catalog.createSession(owner, { owner: CASCADE_OWNER });
                const definition = await saveCascadeDefinition(h.host, owner, "delegation-gap");
                h.control.hook = async ({ sql, params, query, client }) => {
                    if (/^BEGIN/.test(sql)) transactions.set(client.processID, Symbol("transaction"));
                    if (admittedTransaction && !auditTransaction && sql.includes("sessions") && sql.includes("FOR NO KEY UPDATE")
                        && params?.[0] === workflowId && transactions.get(client.processID) !== admittedTransaction.token) {
                        audit.enter("audit");
                        await audit.released;
                    }
                    const result = await query(sql, params);
                    if (!admittedTransaction && /^INSERT INTO/.test(sql) && sql.includes("workflow_runs")) {
                        workflowId = params[1];
                        admittedTransaction = { ...await transactionId(query), token: transactions.get(client.processID) };
                        admission.enter(client.processID);
                        await admission.released;
                    }
                    if (isDelegation(sql, params ?? [])) auditTransaction = await transactionId(query);
                    return result;
                };
                await ending.query("BEGIN");
                transactionOpen = true;
                startWork = startSessionWorkflowDefinition(observeStarts(h, dispatched), {
                    ownerSessionId: owner, definition: { definitionId: definition.definitionId }, inputs: {},
                    actor: CASCADE_ACTOR, operationId: randomUUID(), notifyParent: false,
                }).then(value => ({ value }), error => ({ error }));
                const pid = await reachedDuring(admission, startWork, "admission before commit");
                endWork = ending.query(`UPDATE "${env.cmsSchema}".sessions SET state = 'completed' WHERE session_id = $1`, [owner]);
                expect((await observeBlocked(h, ending.processID, pid)).blocked).toBe(true);
                admission.release();
                await endWork;
                const first = await reachedDuring({ reached: Promise.race([audit.reached, dispatched.reached]) }, startWork,
                    "the former audit lock or actual controller dispatch");
                await ending.query("COMMIT");
                transactionOpen = false;
                audit.release();
                const started = await startWork;
                expect(started.error).toBeUndefined();
                const run = await h.store.readRun(started.value.runId);
                // Native dispatch enqueues creation; the controller row appears when a dispatcher consumes it.
                if (first !== "audit") await expect.poll(async () => (await h.client.getStatus(run.controllerInstanceId)).status,
                    { timeout: testTime.ms(30_000) }).not.toBe("NotFound");
                const status = await h.client.getStatus(run.controllerInstanceId);
                const evidence = { first, status: run.status, controller: status.status, createdAt: run.createdAt, finishedAt: run.finishedAt,
                    admission: { pid: admittedTransaction.pid, xid: admittedTransaction.xid }, audit: auditTransaction };
                console.log("delegation admission race", JSON.stringify(evidence));
                expect(run.status).toBe("cancelled");
                expect(status.status, JSON.stringify(evidence)).not.toBe("NotFound");
                expect(auditTransaction).toEqual({ pid: admittedTransaction.pid, xid: admittedTransaction.xid });
                await cascadeControllerEnded(h.client, run);
            } finally {
                admission.release();
                audit.release();
                h.control.hook = null;
                if (transactionOpen) await ending.query("ROLLBACK");
                await Promise.allSettled([startWork, endWork].filter(Boolean));
                try { await ending.end(); } finally { await h.stop(); }
            }
        });

    it("an audit failure rolls admission back; a resumed claim and its replay write one empty delegation event",
        { timeout: CASCADE_TIMEOUT }, async () => {
            const h = await openOwnerCascadeRuntime(getEnv());
            const dispatched = checkpoint();
            try {
                const owner = randomUUID();
                await h.catalog.createSession(owner, { owner: CASCADE_OWNER });
                const definition = await saveCascadeDefinition(h.host, owner, "delegation-rollback");
                const key = randomUUID();
                const workflowId = workflowStartSessionId(owner, definition.definitionId, key);
                const request = { ownerSessionId: owner, definition: { definitionId: definition.definitionId }, inputs: {},
                    vars: { probe: "rolled back" }, actor: CASCADE_ACTOR, operationId: randomUUID(), key, notifyParent: false };
                let inject = true;
                h.control.hook = async ({ sql, params, query }) => {
                    const result = await query(sql, params);
                    if (inject && isDelegation(sql, params ?? [])) {
                        inject = false;
                        await query("SELECT 1 / 0");
                    }
                    return result;
                };
                const host = observeStarts(h, dispatched);
                await expect(startSessionWorkflowDefinition(host, request)).rejects.toThrow(/division by zero/);
                const [counts] = await h.q(`SELECT
                    (SELECT count(*)::int FROM SCHEMA.workflow_definitions WHERE workflow_session_id = $1) AS definitions,
                    (SELECT count(*)::int FROM SCHEMA.workflow_revisions WHERE workflow_session_id = $1) AS revisions,
                    (SELECT count(*)::int FROM SCHEMA.workflow_runs WHERE workflow_session_id = $1) AS runs,
                    (SELECT count(*)::int FROM SCHEMA.workflow_operations WHERE workflow_session_id = $1) AS receipts,
                    (SELECT count(*)::int FROM SCHEMA.session_events WHERE session_id = $1 AND event_type = 'workflow.tools_delegated') AS events`,
                [workflowId]);
                expect(inject).toBe(false);
                expect(counts).toEqual({ definitions: 0, revisions: 0, runs: 0, receipts: 0, events: 0 });
                expect(await h.catalog.getSession(workflowId)).not.toBeNull();
                h.control.hook = null;
                const resumed = await startSessionWorkflowDefinition(host, request);
                const replay = await startSessionWorkflowDefinition(host, request);
                expect(resumed.replayed).toBe(false);
                expect(replay).toMatchObject({ replayed: true, workflowId, runId: resumed.runId });
                expect(await h.q(`SELECT data FROM SCHEMA.session_events
                    WHERE session_id = $1 AND event_type = 'workflow.tools_delegated'`, [workflowId])).toEqual([{ data: { delegated: [] } }]);
                await h.q("UPDATE SCHEMA.sessions SET state = 'completed' WHERE session_id = $1", [owner]);
                await cascadeControllerEnded(h.client, await h.store.readRun(resumed.runId));
            } finally { await h.stop(); }
        });
});
