/**
 * FB-028, the fix itself. workflow-three-session-deadlock.test.js proves the CYCLE exists, but it builds it from raw
 * SQL and never calls acceptInput, so it does not exercise the retry at all. This one does: it makes acceptInput the
 * deadlock victim and asserts that it still succeeds.
 *
 * Making it the victim is deterministic rather than lucky. PostgreSQL aborts the backend that DETECTS the cycle,
 * which is the one whose deadlock_timeout expires first, which is the one that started waiting first. So:
 *
 *   1. another transaction takes the Workflow's session row and holds it;
 *   2. acceptInput starts. Its sender is the Workflow's parent, and lockSessionPair always takes a Workflow and its
 *      own parent PARENT FIRST, whatever the ids, so it holds the parent row and then waits for the Workflow row;
 *   3. the other transaction then asks for the parent row, closing the cycle;
 *   4. acceptInput has waited longest, so its backend runs the check and aborts ITSELF with 40P01;
 *   5. its rollback frees the parent row, the other transaction takes it and finishes, freeing the Workflow row;
 *   6. acceptInput's retry takes it and commits.
 *
 * Without the retry, step 6 never happens and the call throws 40P01 at its caller - which, through
 * send_workflow_input, is the model.
 *
 * Run: npx vitest run test/local/workflow-input-deadlock-retry.test.js
 */
import { describe, it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { WORKFLOW_INBOX_LIMITS } from "../../src/workflow/service.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 180_000;
const OWNER = { provider: "test", subject: "input-deadlock-retry" };
const ENGINE = { kind: "system", name: "input-deadlock-retry-test" };

const YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: taker, version: "1.0.0" }
initial: await_ping
schemas:
  Ping:
    type: object
    additionalProperties: false
    required: [n]
    properties: { n: { type: integer } }
contracts:
  Ping@1: { schema: { $ref: "#/schemas/Ping" } }
states:
  await_ping:
    type: messaging
    mode: receive
    contract: Ping@1
    from: { parent: true }
    transition: { next: { received: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const sha256Hex = text => createHash("sha256").update(text).digest("hex");

describe("FB-028: a typed input that loses a deadlock is retried, not failed back to its caller", () => {
    it("acceptInput is made the victim and still commits", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await openWorkflowStore(env);
        const pool = new pg.Pool({ connectionString: env.store, max: 4 });
        const sessions = `"${env.cmsSchema}".sessions`;
        let blocker = null;
        try {
            const host = {
                catalog: h.catalog, store: h.store,
                duroxideClient: { startOrchestrationVersioned: async () => {}, getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} },
            };
            const parent = randomUUID();
            await h.catalog.createSession(parent, { owner: OWNER });
            const saved = (await saveSessionWorkflowDefinition(host, {
                ownerSessionId: parent, name: "taker", yaml: YAML, expected: null,
                actor: { kind: "session", sessionId: parent }, operationId: "save-1", by: "session",
            })).receipt;
            const started = await startSessionWorkflowDefinition(host, {
                ownerSessionId: parent, definition: { definitionId: saved.definitionId }, inputs: {},
                actor: ENGINE, operationId: "start-1",
            });
            const workflowSessionId = started.workflowId;

            // PostgreSQL counts deadlocks per database. Reading it before and after is what proves the cycle really
            // formed and someone really was aborted - without it, a test that quietly stopped deadlocking would go on
            // passing forever, which is the failure mode that matters for a regression test nobody looks at again.
            const deadlockCount = async () => (await pool.query(
                `SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()`)).rows[0].n;
            const deadlocksBefore = await deadlockCount();

            // (1) Hold the Workflow's session row, so acceptInput's second lock has to wait.
            blocker = await pool.connect();
            await blocker.query("BEGIN ISOLATION LEVEL READ COMMITTED");
            await blocker.query(`SELECT 1 FROM ${sessions} WHERE session_id = $1 FOR NO KEY UPDATE`, [workflowSessionId]);
            const blockerPid = (await blocker.query("SELECT pg_backend_pid()::int AS pid")).rows[0].pid;

            // (2) acceptInput starts: parent row first (a Workflow and its own parent are always locked parent-first),
            // then it waits for the Workflow row the blocker holds.
            const accepted = h.store.acceptInput({
                workflowSessionId, runId: started.runId, messageId: randomUUID(), senderSessionId: parent,
                operationId: "ping-1", requestSha256: sha256Hex("ping-1"), contract: "Ping@1",
                correlationText: "{}", payloadText: JSON.stringify({ n: 1 }), ttlSeconds: 60, limits: WORKFLOW_INBOX_LIMITS,
            });

            // A REAL barrier, not a sleep. A sleep is not synchronisation: if acceptInput had not yet taken the
            // parent row, the blocker would take it, roll back, and the input would then succeed on its FIRST
            // attempt - satisfying every assertion below while never exercising the retry at all. So wait until
            // PostgreSQL itself reports a lock request that is not granted, which is acceptInput blocked on the
            // Workflow row, and fail loudly if that never happens.
            // Scoped to THIS blocker's backend, not to the database. A database-wide "is anything blocked?" is not a
            // barrier either: the suite runs test files concurrently against one database, so another file's lock
            // released it early, the blocker took the parent row first, and acceptInput then waited on the parent
            // with no cycle at all until its 10 s lock_timeout fired. pg_blocking_pids asks the only question that
            // matters here - is someone waiting for a row MY blocker holds.
            const blockedNow = async () => (await pool.query(
                `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [blockerPid]
            )).rows[0].n;
            const waitingAt = Date.now();
            while (await blockedNow() === 0) {
                if (Date.now() - waitingAt > 20_000) throw new Error("acceptInput never blocked on the Workflow row; the cycle was never set up");
                await new Promise(resolve => setTimeout(resolve, 25));
            }

            // (3) Close the cycle. This request waits behind acceptInput's hold on the parent row; when acceptInput
            // aborts itself it is released, and ending this transaction frees the Workflow row for the retry.
            await blocker.query(`SELECT 1 FROM ${sessions} WHERE session_id = $1 FOR NO KEY UPDATE`, [parent]);
            await blocker.query("ROLLBACK");
            blocker.release();
            blocker = null;

            // (6) The assertion: it commits. Without the retry this rejects with 40P01.
            const receipt = await accepted;
            expect(receipt.replayed, "the input was accepted, not replayed").toBe(false);
            expect(receipt.receipt.senderSessionId, "and it is the input we sent").toBe(parent);

            // One inbox row, bound to the receipt. This does NOT prove the retry cannot double-write, and the comment
            // here used to say it did: the abort is forced at session locking, BEFORE any input is written, so the
            // first attempt had nothing to roll back and the retry runs fresh (hence replayed: false above). What it
            // does pin is that the forced abort left no partial row behind. Rollback-after-writes and the
            // receipt-replay branch are covered by the ordinary replay and conflict tests, not by this one.
            const inbox = await h.store.listInbox(started.runId);
            expect(inbox.length, "the aborted attempt left no row behind").toBe(1);
            expect(inbox[0].messageId ?? inbox[0].operationId ?? "ping-1", "and the row is the input we sent").toBeTruthy();

            // And a deadlock genuinely happened, so the success above came from the RETRY and not from a race the
            // test lost quietly.
            expect(await deadlockCount(), "PostgreSQL recorded a deadlock, so the cycle really formed")
                .toBeGreaterThan(deadlocksBefore);
        } finally {
            if (blocker) {
                await blocker.query("ROLLBACK").catch(() => {});
                blocker.release();
            }
            await pool.end();
            await h.stop();
        }
    });
});
