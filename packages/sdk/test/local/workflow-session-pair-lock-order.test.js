/**
 * Review ER-03 (Astra code review of 8951bc61): a session's creation and a Workflow's typed input lock the same two rows in
 * one order, parent first, so they never deadlock.
 *
 * Creating (or re-creating with refuseDeleted) an agent session A under its Workflow W locks W (FOR SHARE, review DR-02: the
 * parent first) and then A (FOR UPDATE). A typed input to W from A locks the pair through WorkflowStore.lockSessionPair. Before
 * the fix that pair was locked in ascending id order, so when A's id sorts before W's the input locked A first and then
 * waited for W, while the creation held W and waited for A: PostgreSQL ended one of them with a deadlock (40P01). Now a
 * Workflow and its own child are locked Workflow first, so the input waits for W, the creation takes A and commits, and the
 * input goes on. Two real connections; the order is proven from the lock graph (pg_blocking_pids), not from a sleep.
 *
 * Each side's exact result is asserted (Astra test review of 069eca30), not only the absence of a deadlock: the creation
 * succeeds, first, and leaves the child under the Workflow, live; the input, after it, gets this fixture's own refusal (a
 * Workflow with no execution definition): FORBIDDEN, "The sending session or the workflow session is not available."
 * (TYPED_INPUT_REFUSALS.unavailable). At the pre-09c4e404 lock order (ids ascending) one side is ended with 40P01 instead.
 *
 * Run: npx vitest run test/local/workflow-session-pair-lock-order.test.js
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, it, beforeAll, expect } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { WorkflowStore, WorkflowStoreError } from "../../src/workflow/store.ts";
import { TYPED_INPUT_REFUSALS } from "../../src/workflow/authority.ts";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

function gate() {
    let arrive, open;
    const reached = new Promise(resolve => { arrive = resolve; });
    const opened = new Promise(resolve => { open = resolve; });
    return { reached, arrive: value => arrive(value), wait: () => opened, open: () => open() };
}

describe("a session's creation and a Workflow's typed input lock parent first (review ER-03)", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("re-creating a Workflow's agent session while a typed input from it locks the pair: the creation succeeds first, the input gets its exact refusal, no deadlock", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const db = new pg.Pool({ connectionString: env.store, max: 4 });
        const storePool = new pg.Pool({ connectionString: env.store, max: 4 });
        try {
            const owner = randomUUID();
            await catalog.createSession(owner);
            // The child's id sorts before the Workflow's, so an id-ordered pair lock takes the child first.
            const workflow = `ff${randomUUID().slice(2)}`;
            const child = `00${randomUUID().slice(2)}`;
            expect((await catalog.createWorkflowSession(workflow, { parentSessionId: owner, owner: null, creationConfig: {} })).created).toBe(true);
            await catalog.createSession(child, { parentSessionId: workflow });

            // The creation stops after locking the Workflow (its parent), before it locks the child's row.
            const held = gate();
            const connect = catalog.pool.connect.bind(catalog.pool);
            let creatorPid = null;
            // Only a transaction's checkout (promise form); pool.query checks out with a callback and passes through.
            catalog.pool.connect = (...args) => {
                if (typeof args[0] === "function") return connect(...args);
                return gatedConnect();
            };
            const gatedConnect = async () => {
                const client = await connect();
                const query = client.query.bind(client);
                client.query = async (text, ...rest) => {
                    const sql = typeof text === "string" ? text : text?.text ?? "";
                    if (creatorPid === null && /FOR UPDATE\s*$/.test(sql.trim()) && rest[0]?.[0] === child) {
                        creatorPid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
                        held.arrive(creatorPid);
                        await held.wait();
                    }
                    return query(text, ...rest);
                };
                return client;
            };
            const settled = [];
            const creating = catalog.createSession(child, { parentSessionId: workflow, refuseDeleted: true })
                .then(() => { settled.push("creation"); return null; }, error => { settled.push("creation"); return error; });
            const pid = await held.reached;

            // A typed input to the Workflow from its child: the pair lock, on its own connection.
            const store = new WorkflowStore(storePool, env.cmsSchema);
            const accepting = store.acceptInput({
                workflowSessionId: workflow, runId: randomUUID(), messageId: randomUUID(), senderSessionId: child,
                operationId: `input-${randomUUID()}`, requestSha256: "x", contract: "Note@1", correlationText: "{}", payloadText: "{}",
                ttlSeconds: 60, limits: { maxUnconsumed: 10, maxUnconsumedPerSender: 10, windowSeconds: 60, maxPerWindow: 10 },
            }).then(() => { settled.push("input"); return null; }, error => { settled.push("input"); return error; });
            // The input waits for the creation (it locks the Workflow, which the creation holds).
            let waited = false;
            const deadline = Date.now() + 20_000;
            while (!waited && Date.now() < deadline) {
                waited = (await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid])).rows[0].n > 0;
                if (!waited) await new Promise(resolve => setTimeout(resolve, 25));
            }
            expect(waited, "the typed input waits for the creation's lock").toBe(true);
            held.open();
            const [createError, acceptError] = await Promise.all([creating, accepting]);
            const why = JSON.stringify({ settled, createError: createError && { code: createError.code, message: createError.message },
                acceptError: acceptError && { code: acceptError.code, message: acceptError.message } });
            // The creation succeeds, and before the input ends (the input waited for its lock).
            expect(createError, why).toBeNull();
            expect(settled, why).toEqual(["creation", "input"]);
            const row = await catalog.getSession(child);
            expect(row, why).not.toBeNull();
            expect(row.parentSessionId, why).toBe(workflow);
            expect(row.deletedAt, why).toBeNull();
            // The input goes on to this fixture's exact refusal (its Workflow has no execution definition), never a deadlock.
            expect(acceptError, why).toBeInstanceOf(WorkflowStoreError);
            expect(acceptError.code, why).toBe("FORBIDDEN");
            expect(acceptError.message, why).toBe(TYPED_INPUT_REFUSALS.unavailable);
            expect(acceptError.message, why).toBe("The sending session or the workflow session is not available.");
        } finally {
            await storePool.end();
            await db.end();
            await catalog.close();
        }
    });
});
