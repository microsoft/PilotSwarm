/**
 * Stage 2 review fixes, on PostgreSQL, for a session definition's Start (session-definitions.ts) and the shared budget of running
 * children (child-budget.ts):
 * - S2RT-F5: a Start is receipt-first. The same operation after a save of changed YAML, and after a save of identical
 *   YAML, answers its original Workflow, revision and run; a request that names another revision is refused; a Start
 *   interrupted between its claim and its admission goes on with the revision its claim recorded;
 * - S2RT-F3: Start and spawn_agent share one atomic budget: two Starts at 49 at the same moment admit one; a Start racing a
 *   sub-agent's creation at 49 admits one; 50 admitted or paused Workflows refuse a sub-agent's creation;
 * - S2RT-F7: the definition tool's first save, repeated with the same tool call id, answers its receipt (one revision);
 * - S2RT-F4: a person's Start (the management client, no depth given) on a session at nesting level 2 is refused, and claims
 *   nothing.
 * No controller runs: a started run stays admitted (a recording duroxide client stands in for the dispatch).
 *
 * Run: npx vitest run test/local/workflow-start-review.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient } from "../helpers/local-workers.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { workflowDefinitionFromTool } from "../../src/workflow/definition-tool.ts";
import { WORKFLOW_CHILD_BUDGET_MAX } from "../../src/child-budget.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;
const OWNER = { provider: "test", subject: "start-review" };
const ENGINE = { kind: "system", name: "start-review-test" };

const YAML = (seconds, name = "waiter") => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ${name}, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: ${seconds}, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

async function refused(promise, code) {
    let caught = null;
    try { await promise; } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(code);
    return caught;
}

async function harness() {
    const h = await openWorkflowStore(getEnv());
    const host = {
        catalog: h.catalog, store: h.store,
        duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} },
    };
    const session = randomUUID();
    await h.catalog.createSession(session, { owner: OWNER });
    return { h, host, session };
}

const save = (host, session, yaml, expected) => saveSessionWorkflowDefinition(host, { ownerSessionId: session, name: "waiter", yaml, expected,
    actor: { kind: "session", sessionId: session }, operationId: `save-${randomUUID()}`, by: "session" });
const start = (host, session, definitionId, extra = {}) => startSessionWorkflowDefinition(host, { ownerSessionId: session, definition: { definitionId },
    revision: extra.revision ?? null, inputs: {}, actor: ENGINE, operationId: extra.operationId ?? `start-${randomUUID()}` });

/** `count` children that each hold one slot: admitted Workflows of the session (each its own Start). */
async function fillWorkflows(host, session, definitionId, count) {
    for (let index = 0; index < count; index += 1) await start(host, session, definitionId);
}

describe("stage 2 review: a Start is receipt-first, and the budget of running children is one atomic rule", () => {
    it("S2RT-F5: the same Start after a changed-YAML save and after an identical-YAML save answers its revision-1 Workflow; another revision is refused", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        try {
            const first = (await save(host, session, YAML(30), null)).receipt;
            const op = `start-${randomUUID()}`;
            const once = await start(host, session, first.definitionId, { operationId: op });
            expect(once).toMatchObject({ revision: 1, replayed: false });
            // A changed YAML is revision 2: the same Start still answers revision 1's Workflow.
            await save(host, session, YAML(45), { definitionId: first.definitionId, revision: 1 });
            const afterChanged = await start(host, session, first.definitionId, { operationId: op });
            expect(afterChanged).toMatchObject({ workflowId: once.workflowId, runId: once.runId, revision: 1, replayed: true });
            // The same YAML as revision 1, saved as revision 3: still revision 1 (the pin, not the YAML, answers).
            await save(host, session, YAML(30), { definitionId: first.definitionId, revision: 2 });
            const afterSame = await start(host, session, first.definitionId, { operationId: op });
            expect(afterSame).toMatchObject({ workflowId: once.workflowId, runId: once.runId, revision: 1, replayed: true });
            expect((await h.store.sessionDefinitions.listWorkflows({ definitionId: first.definitionId })).map(item => item.workflowSessionId)).toEqual([once.workflowId]);
            // The same operation naming revision 2 is another request.
            const other = await refused(start(host, session, first.definitionId, { operationId: op, revision: 2 }), "OPERATION_CONFLICT");
            expect(other.message).toMatch(/started waiter revision 1, not revision 2; use another operation id\.$/);
        } finally {
            await h.stop();
        }
    });

    it("S2RT-F5: a Start interrupted between its claim and its admission goes on with the revision its claim recorded", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        try {
            const first = (await save(host, session, YAML(30), null)).receipt;
            // The first attempt claims the Workflow, then fails before its definition is stored and its run admitted.
            let fail = true;
            const interrupted = { ...host, store: new Proxy(h.store, { get: (target, name) => (name === "createDefinition" && fail
                ? async () => { fail = false; throw new Error("worker stopped"); } : typeof target[name] === "function" ? target[name].bind(target) : target[name]) }) };
            const op = `start-${randomUUID()}`;
            await expect(start(interrupted, session, first.definitionId, { operationId: op })).rejects.toThrow(/worker stopped/);
            await save(host, session, YAML(45), { definitionId: first.definitionId, revision: 1 });
            const resumed = await start(host, session, first.definitionId, { operationId: op });
            expect(resumed).toMatchObject({ revision: 1 });
            expect((await h.store.readRevision(resumed.workflowId, 1)).yaml).toBe(YAML(30));
        } finally {
            await h.stop();
        }
    });

    it("S2RT-F3: two Starts at 49 at the same moment admit one; a Start racing a sub-agent at 49 admits one; 50 Workflows refuse a sub-agent", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        try {
            const first = (await save(host, session, YAML(3600), null)).receipt;
            await fillWorkflows(host, session, first.definitionId, WORKFLOW_CHILD_BUDGET_MAX - 1);
            expect(await h.store.sessionDefinitions.runningChildren(session)).toBe(WORKFLOW_CHILD_BUDGET_MAX - 1);
            const pair = await Promise.allSettled([start(host, session, first.definitionId), start(host, session, first.definitionId)]);
            expect(pair.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
            expect(pair.find(result => result.status === "rejected").reason.code).toBe("CHILD_LIMIT");
            expect(await h.store.sessionDefinitions.runningChildren(session)).toBe(WORKFLOW_CHILD_BUDGET_MAX);
            // A sub-agent's creation is refused at 50 counted Workflows (admitted), with nothing made.
            const child = randomUUID();
            await expect(h.catalog.createSession(child, { parentSessionId: session, childBudget: { max: WORKFLOW_CHILD_BUDGET_MAX } }))
                .rejects.toMatchObject({ code: "CHILD_LIMIT" });
            expect(await h.catalog.getSession(child)).toBeNull();
            // A paused one still counts: pause one run and try again.
            const [one] = await h.store.sessionDefinitions.listWorkflows({ definitionId: first.definitionId });
            await h.pool.query(`UPDATE "${getEnv().cmsSchema}".workflow_runs SET status = 'paused', paused_from = 'admitted' WHERE workflow_session_id = $1`, [one.workflowSessionId]);
            await expect(h.catalog.createSession(randomUUID(), { parentSessionId: session, childBudget: { max: WORKFLOW_CHILD_BUDGET_MAX } }))
                .rejects.toMatchObject({ code: "CHILD_LIMIT" });
            // End one run: 49. A Start and a sub-agent at the same moment: one of them.
            await h.pool.query(`UPDATE "${getEnv().cmsSchema}".workflow_runs SET status = 'completed', paused_from = NULL, finished_at = now() WHERE workflow_session_id = $1`, [one.workflowSessionId]);
            expect(await h.store.sessionDefinitions.runningChildren(session)).toBe(WORKFLOW_CHILD_BUDGET_MAX - 1);
            const agent = randomUUID();
            const race = await Promise.allSettled([start(host, session, first.definitionId),
                h.catalog.createSession(agent, { parentSessionId: session, childBudget: { max: WORKFLOW_CHILD_BUDGET_MAX } })]);
            expect(race.filter(result => result.status === "fulfilled").length, JSON.stringify(race.map(result => result.reason?.message ?? null))).toBe(1);
            expect(race.find(result => result.status === "rejected").reason.code).toBe("CHILD_LIMIT");
            expect(await h.store.sessionDefinitions.runningChildren(session)).toBe(WORKFLOW_CHILD_BUDGET_MAX);
            // A retry of an existing sub-agent's creation is not counted again.
            if (race[1].status === "fulfilled") {
                await h.catalog.createSession(agent, { parentSessionId: session, childBudget: { max: WORKFLOW_CHILD_BUDGET_MAX } });
            }
        } finally {
            await h.stop();
        }
    });

    it("S2RT-F7: the definition tool's first save repeated with the same tool call id answers its receipt; one revision is saved", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        try {
            const call = () => workflowDefinitionFromTool({ operation: "save", name: "waiter", yaml: YAML(30) },
                { callerSessionId: session, host, toolCallId: "call-first-save", owner: OWNER, binding: async () => null }).then(text => JSON.parse(text));
            const once = await call();
            expect(once).toMatchObject({ ok: true, revision: 1, replayed: false });
            const twice = await call();
            expect(twice).toMatchObject({ ok: true, definitionId: once.definitionId, revision: 1, replayed: true });
            expect((await h.store.sessionDefinitions.listRevisions(once.definitionId)).length).toBe(1);
        } finally {
            await h.stop();
        }
    });

    // Lock-order check O1: a Start's claim inserts its Workflow, then waits for the session's row (the budget lock) behind the
    // session's deletion or end. Under that lock the session is no longer live: the claim is refused and rolled back, so no
    // Workflow session is left under the session.
    it("O1: a Start that waits on the budget lock behind the session's deletion, or its end, leaves no Workflow session", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const direct = new pg.Pool({ connectionString: env.store, max: 2 });
        const { h, host } = await harness();
        try {
            for (const [change, code] of [["SET deleted_at = now()", "SESSION_NOT_FOUND"], ["SET state = 'cancelled'", "SESSION_NOT_LIVE"]]) {
                const session = randomUUID();
                await h.catalog.createSession(session, { owner: OWNER });
                const first = (await save(host, session, YAML(3600), null)).receipt;
                // The session's deletion (or end) holds the session's row; the Start's claim waits for it at the budget lock.
                const holder = await direct.connect();
                try {
                    await holder.query("BEGIN");
                    await holder.query(`SELECT 1 FROM "${env.cmsSchema}".sessions WHERE session_id = $1 FOR NO KEY UPDATE`, [session]);
                    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
                    const starting = start(host, session, first.definitionId);
                    starting.catch(() => {});
                    const deadline = Date.now() + 30_000;
                    for (;;) {
                        const { rows } = await direct.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
                        if (rows[0].n > 0) break;
                        if (Date.now() > deadline) throw new Error("the Start never waited for the session's row");
                        await new Promise(resolve => setTimeout(resolve, 50));
                    }
                    await holder.query(`UPDATE "${env.cmsSchema}".sessions ${change} WHERE session_id = $1`, [session]);
                    await holder.query("COMMIT");
                    await refused(starting, code);
                } finally {
                    holder.release();
                }
                const { rows } = await direct.query(`SELECT session_id FROM "${env.cmsSchema}".sessions WHERE parent_session_id = $1 AND session_kind = 'workflow'`, [session]);
                expect(rows, change).toEqual([]);
            }
        } finally {
            await direct.end();
            await h.stop();
        }
    });

    it("S2RT-F4: a person's Start on a session at nesting level 2 is refused with no claim, whatever depth it gives", { timeout: TIMEOUT }, async () => {
        const { h, host, session } = await harness();
        const env = getEnv();
        const mgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema, workflowCommands: {} });
        await mgmt.start();
        try {
            const child = randomUUID();
            const grandchild = randomUUID();
            await h.catalog.createSession(child, { parentSessionId: session, owner: OWNER });
            await h.catalog.createSession(grandchild, { parentSessionId: child, owner: OWNER });
            expect(await h.store.sessionDefinitions.nestingLevel(grandchild)).toBe(2);
            expect(await h.store.sessionDefinitions.nestingLevel(child)).toBe(1);
            const saved = (await save(host, grandchild, YAML(30), null)).receipt;
            const operationId = `start-${randomUUID()}`;
            const refusal = await refused(mgmt.startSessionWorkflowDefinition(grandchild, { definitionId: saved.definitionId, operationId }, { principal: OWNER }),
                "WORKFLOW_NESTING_LIMIT");
            expect(refusal.message).toMatch(/^This session is at nesting level 2 \(max 2\)/);
            await refused(startSessionWorkflowDefinition(host, { ownerSessionId: grandchild, definition: { definitionId: saved.definitionId }, inputs: {},
                actor: ENGINE, operationId: `start-${randomUUID()}`, nestingLevel: 0 }), "WORKFLOW_NESTING_LIMIT");
            expect(await h.store.sessionDefinitions.listWorkflows({ definitionId: saved.definitionId })).toEqual([]);
            const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM "${env.cmsSchema}".sessions WHERE parent_session_id = $1`, [grandchild]);
            expect(rows[0].n).toBe(0);
            // A level-1 session starts one.
            const one = (await save(host, child, YAML(30), null)).receipt;
            expect((await mgmt.startSessionWorkflowDefinition(child, { definitionId: one.definitionId, operationId: `start-${randomUUID()}` }, { principal: OWNER }))
                .revision).toBe(1);
        } finally {
            await mgmt.stop();
            await h.stop();
        }
    });
});
