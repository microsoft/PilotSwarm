/**
 * FB-028. Three ordinary Workflow transactions can deadlock on main today. No hand-over and no new feature is
 * involved; this is the shape the lock order has always permitted, and PostgreSQL resolves it by aborting one
 * participant with 40P01 after deadlock_timeout.
 *
 * Session A owns Workflow W1. X is another Workflow of the same user whose parent is not A. The session ids are
 * chosen so that W1 < X < A, because the pair rule orders unrelated sessions by ascending id.
 *
 *   T1  A ends.            The UPDATE of A's state holds A's row; the owner-session-ended trigger then waits for
 *                          W1 FOR NO KEY UPDATE.
 *   T2  W1 sends to X.     enterNode locks the pair in ascending id order: W1 FOR NO KEY UPDATE, then X FOR SHARE.
 *   T3  A sends input to X. acceptInput locks X FOR NO KEY UPDATE, then A FOR SHARE.
 *
 * The cycle is A -> W1 -> X -> A.
 *
 * WHY THIS IS A BUG RATHER THAN A CURIOSITY: the three participants did not recover equally. The enter path is a
 * tagged store activity and storeTagged retries it four times on durable timers, so T2 survived. T1's session-state
 * update is retried by cmsRetryCritical, which already lists 40P01 as transient. acceptInput was retried by nothing,
 * so T3 failed back to its caller - and whether a cycle was invisible or reached the user depended only on which
 * transaction PostgreSQL happened to choose as its victim. That asymmetry is what the fix removes.
 *
 * This test FORCES the cycle with real transactions and barriers rather than waiting for it to occur, and asserts
 * what the system does with it. It is written before the fix, so it documents the defect first.
 *
 * Run: npx vitest run test/local/workflow-three-session-deadlock.test.js
 */
import { describe, it, expect } from "vitest";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;

/** Ids chosen so that ascending order is W1 < X < A, which is what puts the three locks in a cycle. */
const W1 = "11111111-0000-4000-8000-000000000001";
const X = "55555555-0000-4000-8000-000000000002";
const A = "99999999-0000-4000-8000-000000000003";

/** Open a connection, begin, and keep it; the test drives each transaction statement by statement. */
async function begin(pool) {
    const client = await pool.connect();
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    return client;
}

describe("FB-028: three ordinary sessions can form a lock cycle with no hand-over involved", () => {
    it("forces A -> W1 -> X -> A and records which participant PostgreSQL aborts", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await openWorkflowStore(env);
        const pool = new pg.Pool({ connectionString: env.store, max: 6 });
        const schema = env.cmsSchema;
        const sessions = `"${schema}".sessions`;
        const clients = [];
        try {
            expect(W1 < X && X < A, "the ids must sort W1 < X < A for the cycle to form").toBe(true);

            // Three ordinary rows are enough: the cycle is about row locks and their order, not Workflow state.
            for (const id of [W1, X, A]) {
                await pool.query(
                    `INSERT INTO ${sessions} (session_id, state) VALUES ($1, 'running') ON CONFLICT (session_id) DO NOTHING`, [id]);
            }
            const present = await pool.query(`SELECT count(*)::int AS n FROM ${sessions} WHERE session_id = ANY($1::text[])`, [[W1, X, A]]);
            expect(present.rows[0].n, "all three rows exist, so every lock below really takes one").toBe(3);

            for (let i = 0; i < 3; i += 1) {
                const client = await pool.connect();
                clients.push(client);
                await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
                // A bound on every wait, so a test that FORCES a deadlock can never hang the suite. It is well above
                // the 1 s deadlock_timeout, so the detector always wins the race when a cycle really forms; 55P03
                // here means no cycle formed, which is a failure worth reading rather than a hang worth guessing at.
                await client.query("SET LOCAL lock_timeout = '10s'");
            }
            const [t1, t2, t3] = clients;

            // Each takes its FIRST lock, in the order the production code takes it.
            await t1.query(`SELECT 1 FROM ${sessions} WHERE session_id = $1 FOR NO KEY UPDATE`, [A]);   // A's own state update
            await t2.query(`SELECT 1 FROM ${sessions} WHERE session_id = $1 FOR NO KEY UPDATE`, [W1]);  // pair rule: lower id
            await t3.query(`SELECT 1 FROM ${sessions} WHERE session_id = $1 FOR NO KEY UPDATE`, [X]);   // acceptInput

            // Then each waits for the lock the next one holds. The cycle is A -> W1 -> X -> A.
            const settle = (promise, who) => promise.then(() => ({ who, code: null }), error => ({ who, code: error.code }));
            const w1 = settle(t1.query(`SELECT 1 FROM ${sessions} WHERE session_id = $1 FOR NO KEY UPDATE`, [W1]), "T1-owner-end");
            const w2 = settle(t2.query(`SELECT 1 FROM ${sessions} WHERE session_id = $1 FOR SHARE`, [X]), "T2-enter");
            const w3 = settle(t3.query(`SELECT 1 FROM ${sessions} WHERE session_id = $1 FOR SHARE`, [A]), "T3-acceptInput");

            const first = await Promise.race([w1, w2, w3]);
            expect(first.code, `the cycle is broken by a deadlock abort, not by a lock timeout or by waiting (${JSON.stringify(first)})`)
                .toBe("40P01");

            // The victim's transaction is dead. Release its locks so the other two can finish, then read all three.
            await Promise.all(clients.map(client => client.query("ROLLBACK").catch(() => {})));
            const all = await Promise.all([w1, w2, w3]);
            const aborted = all.filter(item => item.code === "40P01").map(item => item.who);
            expect(aborted.length, `exactly one participant is aborted (${JSON.stringify(all)})`).toBe(1);

            // The victim is whichever transaction the detector picks. This assertion only records WHICH one was
            // chosen on this run; it does not prove all three are reachable, and it is not trying to. The point it
            // pins is that the cycle is real and costs exactly one transaction.
            //
            // Recovery is what differs, and that is now established rather than guessed: T2 (enter) is retried by
            // storeTagged; T1 (the session-ending update) is retried by cmsRetryCritical, which already lists 40P01;
            // T3 (acceptInput) was retried by nothing, which is what this change fixes.
            expect(["T1-owner-end", "T2-enter", "T3-acceptInput"]).toContain(aborted[0]);
        } finally {
            // Cleanup BEFORE pool.end(): a client still blocked on a lock would make pool.end() hang forever, and an
            // assertion that throws above must not be able to wedge the whole suite.
            await Promise.all(clients.map(client => client.query("ROLLBACK").catch(() => {})));
            for (const client of clients) client.release();
            await pool.end();
            await h.stop();
        }
    });
});
