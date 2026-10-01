/**
 * WorkflowRun wait-boundary resume integration tests (black-box).
 *
 * Regression coverage for the started-boundary strand bug: a workflowRun that parks on
 * an external-operation wait must eventually deliver its RESUME SIGNAL so the
 * worker can wake the workflowRun back up. Delivery is gated on the wait's
 * `wait_started_at` boundary being recorded; when the boundary was missed the
 * workflowRun stranded forever.
 *
 * Rather than reading internal columns, these tests drive the SAME public
 * catalog API a worker uses and observe the ONE externally meaningful outcome:
 * whether `claimWorkflowRunExternalOperationSignals` hands back the operation's resume
 * signal. That is the observable that decides "does the parked workflowRun wake up?",
 * so it validates the fix behaviourally instead of trusting our internal
 * bookkeeping — a hacked implementation that stamps the wrong row would still
 * fail to make the signal claimable and would be caught here.
 *
 * End-to-end resume path exercised:
 *   startWorkflowRunExternalOperation   (producer registers the wait, workflowRun parks)
 *     -> setWorkflowRunSessionExecutionStatus('waiting')   (authoritative wait_started_at stamp)
 *     -> claimDueWorkflowRunExternalOperations             (poller leases the operation)
 *     -> completeWorkflowRunExternalOperation('succeeded') (external result satisfies the wait)
 *     -> claimWorkflowRunExternalOperationSignals          (OBSERVABLE: resume signal delivered)
 *
 * The suite asserts:
 *   1. Happy path: a parked wait that is satisfied yields a claimable resume
 *      signal — the parked workflowRun wakes up.
 *   2. Negative control: an unparked wait (its `wait_started_at` never stamped)
 *      yields NO resume signal even after it is satisfied — this reproduces the
 *      strand and proves the happy-path assertion has teeth.
 *   3. Alternate stamp source: recording the best-effort started boundary EVENT
 *      also unblocks resume, so either stamp path independently wakes the workflowRun.
 *   4. No-throw contract: an unmatched started boundary returns false instead of
 *      throwing — a throw would fail the whole recordSessionEvent activity under
 *      cmsRetryCritical and strand the workflowRun anyway.
 */

import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assertEqual } from "../helpers/assertions.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function directQuery(env, sql, params = []) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: env.store });
    try {
        await client.connect();
        return await client.query(sql, params);
    } finally {
        try { await client.end(); } catch {}
    }
}

/**
 * Seed the minimal FK chain for an active, current workflowRun state run so that
 * catalog.startWorkflowRunExternalOperation() can attach an observed-condition wait to
 * it exactly as production does. There is no public API to stand up a whole workflowRun
 * pipeline, so this fixture is unavoidable scaffolding; the ASSERTIONS below
 * stay black-box (public API only).
 *
 * @returns the ids of the seeded rows.
 */
async function seedActiveStateRun(env, {
    sessionId,
    stateName = "FixProposed",
    stateRevision = 2,
}) {
    const suffix = sessionId.replace(/[^a-z0-9]/gi, "").slice(0, 12);
    const ids = {
        workflowGeneratorId: `gen-${suffix}`,
        workflowDefinitionId: `def-${suffix}`,
        cycleId: `cyc-${suffix}`,
        workflowRunId: `workflowRun-${suffix}`,
        stateRunId: `run-${suffix}`,
        associationId: `assoc-${suffix}`,
    };
    const s = env.cmsSchema;

    await directQuery(
        env,
        `INSERT INTO "${s}".workflow_generators (
             workflow_generator_id, name, owner_provider, owner_subject, cadence_seconds,
             source_type
         )
         VALUES ($1, 'wait-boundary-test', 'test', 'owner', 60, 'test-source')`,
        [ids.workflowGeneratorId],
    );
    await directQuery(
        env,
        `INSERT INTO "${s}".workflow_definitions (
             workflow_definition_id, workflow_type, name,
             owner_provider, owner_subject, version, definition_hash
         )
         VALUES ($1, $2, 'wait-boundary-test', 'test', 'owner', 1, $3)`,
        [ids.workflowDefinitionId, `wait-boundary-${suffix}`, `hash-${suffix}`],
    );
    await directQuery(
        env,
        `INSERT INTO "${s}".workflow_generator_cycles (cycle_id, workflow_generator_id, workflow_definition_id, claimed_by)
         VALUES ($1, $2, $3, 'worker-test')`,
        [ids.cycleId, ids.workflowGeneratorId, ids.workflowDefinitionId],
    );
    await directQuery(
        env,
        `INSERT INTO "${s}".workflow_runs (
             workflow_run_id, workflow_generator_id, workflow_definition_id, workflow_type,
             owner_provider, owner_subject, effective_config, workflow_run_key, input,
             first_seen_cycle_id, last_seen_cycle_id,
             lifecycle_state, current_state, state_revision
         )
         VALUES ($1, $2, $3, $4, 'system', 'system', '{}'::jsonb, $5, '{}'::jsonb,
                 $6, $6, 'active', $7, $8)`,
        [
            ids.workflowRunId,
            ids.workflowGeneratorId,
            ids.workflowDefinitionId,
            `wait-boundary-${suffix}`,
            `key-${suffix}`,
            ids.cycleId,
            stateName,
            stateRevision,
        ],
    );
    await directQuery(
        env,
        `INSERT INTO "${s}".workflow_run_state_runs (
             state_run_id, workflow_run_id, workflow_definition_id, state_name, state_revision, status, session_id
         )
         VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
        [ids.stateRunId, ids.workflowRunId, ids.workflowDefinitionId, stateName, stateRevision, sessionId],
    );
    await directQuery(
        env,
        `INSERT INTO "${s}".workflow_run_sessions (
             association_id, workflow_run_id, session_id, ordinal, is_current, status, state_run_id
         )
         VALUES ($1, $2, $3, 1, TRUE, 'active', $4)`,
        [ids.associationId, ids.workflowRunId, sessionId, ids.stateRunId],
    );

    return ids;
}

/**
 * Drive the poll-and-complete leg a worker performs against an external
 * operation: acquire the poll lease, then report the external result that
 * satisfies the wait. Public API only.
 */
async function pollAndComplete(catalog, workerId, operationId) {
    const leased = await catalog.claimDueWorkflowRunExternalOperations("ado", workerId, 25, 60);
    assertEqual(
        leased.some((row) => row.operationId === operationId),
        true,
        "the freshly started operation must be immediately poll-claimable",
    );
    await catalog.completeWorkflowRunExternalOperation({
        operationId,
        workerId,
        status: "succeeded",
        result: { buildId: "12345", outcome: "succeeded" },
        evidence: { url: "https://example.test/build/12345" },
    });
}

/** True iff the operation's resume signal is deliverable (the workflowRun would wake). */
async function resumeSignalClaimable(catalog, workerId, operationId) {
    const signals = await catalog.claimWorkflowRunExternalOperationSignals(workerId, 25, 30);
    return signals.some((row) => row.operationId === operationId);
}

describe("WorkflowRun wait boundary resume", () => {
    it("delivers a resume signal for a parked wait once it is satisfied", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        const sessionId = "sess-resume-happy";

        try {
            await catalog.initialize();
            await seedActiveStateRun(env, { sessionId, stateName: "FixProposed", stateRevision: 2 });

            const op = await catalog.startWorkflowRunExternalOperation({
                sessionId,
                provider: "ado",
                kind: "build",
                operationKey: "default",
                detectionMode: "poll",
            });

            // The session durably parks: this is the authoritative wait_started_at
            // stamp that makes the eventual resume signal deliverable.
            await catalog.setWorkflowRunSessionExecutionStatus(sessionId, "waiting");

            // A poller observes the external result and satisfies the wait.
            await pollAndComplete(catalog, "worker-poll", op.operationId);

            const claimable = await resumeSignalClaimable(catalog, "worker-signal", op.operationId);
            assertEqual(claimable, true, "a parked, satisfied wait must yield a claimable resume signal");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("never delivers a resume signal for a wait that never recorded its start (strand)", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        const sessionId = "sess-resume-strand";

        try {
            await catalog.initialize();
            await seedActiveStateRun(env, { sessionId, stateName: "FixProposed", stateRevision: 2 });

            const op = await catalog.startWorkflowRunExternalOperation({
                sessionId,
                provider: "ado",
                kind: "build",
                operationKey: "default",
                detectionMode: "poll",
            });

            // Reproduce the strand: the session never records its wait start
            // (no park, no boundary event), so wait_started_at stays NULL. The
            // wait is still satisfied by the poller...
            await pollAndComplete(catalog, "worker-poll", op.operationId);

            // ...but the resume signal must NOT be claimable — the workflowRun would
            // strand. This is the negative control: it proves the happy-path
            // assertion is not trivially always true.
            const claimable = await resumeSignalClaimable(catalog, "worker-signal", op.operationId);
            assertEqual(claimable, false, "an unstarted wait must never yield a resume signal");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("delivers a resume signal when only the best-effort started boundary was recorded", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        const sessionId = "sess-resume-event";

        try {
            await catalog.initialize();
            await seedActiveStateRun(env, { sessionId, stateName: "FixProposed", stateRevision: 2 });

            const op = await catalog.startWorkflowRunExternalOperation({
                sessionId,
                provider: "ado",
                kind: "build",
                operationKey: "default",
                detectionMode: "poll",
            });

            // Do NOT park. Instead record the best-effort started boundary event
            // (the session.system_wait_started path). It must independently
            // unblock resume, so either stamp source wakes the workflowRun.
            const matched = await catalog.recordWorkflowRunWaitBoundary(sessionId, op.signalKey, "started");
            assertEqual(matched, true, "the started boundary should match its own wait by identity");

            await pollAndComplete(catalog, "worker-poll", op.operationId);

            const claimable = await resumeSignalClaimable(catalog, "worker-signal", op.operationId);
            assertEqual(claimable, true, "a recorded started boundary must also yield a claimable resume signal");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("returns false without throwing for a started boundary that can never match", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        const sessionId = "sess-started-nomatch";

        try {
            await catalog.initialize();
            await seedActiveStateRun(env, { sessionId, stateName: "FixProposed", stateRevision: 2 });
            await catalog.startWorkflowRunExternalOperation({
                sessionId,
                provider: "ado",
                kind: "build",
                operationKey: "default",
                detectionMode: "poll",
            });

            // A signal key that matches no wait row simulates the boundary event
            // racing ahead of (or diverging from) the wait row. It must return
            // false — NOT throw — because recordWorkflowRunExternalOperationWait runs
            // under cmsRetryCritical (no retry on non-transient errors); a throw
            // would fail the whole recordSessionEvent activity and drop the batch.
            const matched = await catalog.recordWorkflowRunWaitBoundary(
                sessionId,
                "signal-that-never-appears",
                "started",
            );
            assertEqual(matched, false, "unmatched started boundary must return false, not throw");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);
});
