import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { schemaSnapshot, snapshotDifferences } from "../helpers/schema-snapshot.js";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { workflowRerunMigration } from "../../src/migrations/workflow-rerun-0104.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";
import { createWorkflow, dispatchWorkflowRun } from "../../src/workflow/service.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const SEED = 0x63_6d_73;
const ACTOR = { kind: "system", name: "workflow-rerun-migration-test" };

function pgPoolConfig(connectionString) {
    return {
        connectionString,
        max: 2,
        ...(connectionString.includes("sslmode=") ? { ssl: { rejectUnauthorized: false } } : {}),
    };
}

async function expectSqlState(promise, sqlState) {
    let caught = null;
    try { await promise; } catch (error) { caught = error; }
    expect(caught, `expected SQLSTATE ${sqlState}`).not.toBeNull();
    expect(caught.code, caught.message).toBe(sqlState);
    return caught;
}

const PASSOVER_LOOP = (reusedCount) => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: rerun-passover-spike-${reusedCount}, version: "1.0.0" }
limits:
  maxNodeExecutions: ${reusedCount + 50}
initialInput: { n: 0 }
initial: step
states:
  step:
    type: script
    source: |
      const n = context.input.n + 1;
      await setResult(n <= ${reusedCount} ? "again" : "done", { n, executedId: context.nodeExecutionId });
    transition: { next: { again: step, done: finished } }
  finished: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

function host(client) {
    return { catalog: client._catalog, store: client._catalog.workflowStore(), duroxideClient: client.duroxideClient };
}

async function waitForRunEnd(h, runId, timeoutMs = 180_000) {
    const deadline = Date.now() + testTime.ms(timeoutMs);
    let last = null;
    while (Date.now() < deadline) {
        last = await h.store.readRun(runId);
        if (last && ["completed", "failed", "cancelled", "stopped"].includes(last.status)) return last;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for run ${runId} to finish: ${JSON.stringify(last)}`);
}

async function seedCopiedLoopVisits(pool, schema, sourceWorkflowId, sourceRunId, targetRunId, count) {
    const s = `"${schema.replace(/"/g, '""')}"`;
    const now = new Date();
    const ids = [];
    const preds = [];
    const ords = [];
    const routes = [];
    const inputs = [];
    const inputHashes = [];
    const outputs = [];
    const srcIds = [];
    let prevId = null;
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
        const id = nodeExecutionIdFor(targetRunId, "root", "step", ordinal);
        const inputText = canonicalJson({ n: ordinal - 1 });
        const outputText = canonicalJson({ n: ordinal });
        ids.push(id);
        preds.push(prevId);
        ords.push(ordinal);
        routes.push(ordinal === 1 ? null : "again");
        inputs.push(inputText);
        inputHashes.push(sha256Hex(inputText));
        outputs.push(outputText);
        srcIds.push(nodeExecutionIdFor(sourceRunId, "root", "step", ordinal));
        prevId = id;
    }

    await pool.query(
        `INSERT INTO ${s}.workflow_node_executions (
            node_execution_id, run_id, scope_id, predecessor_id, node_id, ordinal, node_type, arrival_route,
            input, input_sha256, state, outcome, result_kind, output, error, winner,
            effect_attempts, entered_at, completed_at, kv_revision, deadline_at,
            reused_from_execution_id, reused_from_run_id, reused_from_workflow_session_id, reused_at
         )
         SELECT t.id, $1, 'root', t.pred, 'step', t.ord, 'script', t.route,
                t.inp, t.inp_hash, 'completed', 'again', 'business', t.outp, NULL, 'effect',
                0, $2::timestamptz, $2::timestamptz, 1, NULL,
                t.src_id, $3, $4, $2::timestamptz
         FROM unnest($5::text[], $6::text[], $7::int[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[])
              AS t(id, pred, ord, route, inp, inp_hash, outp, src_id)
         ORDER BY t.ord ASC`,
        [targetRunId, now.toISOString(), sourceRunId, sourceWorkflowId, ids, preds, ords, routes, inputs, inputHashes, outputs, srcIds],
    );

    const resume = canonicalJson({
        v: 1,
        mode: "run_again",
        stateId: "step",
        ordinal: count + 1,
        scopeId: "root",
        arrivalRoute: "again",
        predecessorId: prevId,
        cutKvRevision: 1,
        sameIr: true,
        expectedInputSha256: null,
        expectedCarrySha256: null,
        recordedInputSha256: null,
        fromStateId: "step",
        fromVisit: count + 1,
        sourceRevision: 1,
    });
    await pool.query(
        `UPDATE ${s}.workflow_runs
            SET rerun_of_workflow_session_id = $2,
                rerun_of_run_id = $3,
                rerun_from_execution_id = $4,
                rerun_mode = 'run_again',
                rerun_resume = $5,
                rerun_reused = $6,
                rerun_unwalked = 0,
                rerun_actor = $7
          WHERE run_id = $1`,
        [targetRunId, sourceWorkflowId, sourceRunId, nodeExecutionIdFor(sourceRunId, "root", "step", count + 1), resume, count, canonicalJson(ACTOR)],
    );
}

describe("migration 0104: workflow_rerun", () => {
    it("applies cleanly on a quote-escaped schema, upgrades idempotently, enforces CHECK constraints, and keeps #3 rows when #2 is deleted", { timeout: testTime.ms(240_000) }, async () => {
        const pool = new pg.Pool(pgPoolConfig(getEnv().store));
        const tag = randomUUID().replace(/-/g, "").slice(0, 10);
        const upgraded = `wf0104_${tag}_u`;
        const fresh = `wf0104_${tag}_f`;
        const quotedSchema = `pilot"swarm_${tag}`;
        const qIdent = (name) => `"${name.replace(/"/g, '""')}"`;
        const query = (sql, params) => pool.query(sql, params);
        try {
            // 1. Upgrade from <= 0103 to <= 0104, verify idempotent re-apply (all 5 steps), and match fresh install.
            await runMigrations(pool, upgraded, CMS_MIGRATIONS(upgraded).filter(m => m.version < "0104"), SEED);
            await runMigrations(pool, upgraded, CMS_MIGRATIONS(upgraded).filter(m => m.version <= "0104"), SEED);
            const afterUpgrade = await schemaSnapshot(query, upgraded);
            for (const stepSql of workflowRerunMigration(upgraded)) {
                await query(stepSql);
            }
            expect(snapshotDifferences(afterUpgrade, await schemaSnapshot(query, upgraded))).toEqual({});

            await runMigrations(pool, fresh, CMS_MIGRATIONS(fresh).filter(m => m.version <= "0104"), SEED);
            const catalog = ({ data, ...rest }) => rest;
            expect(snapshotDifferences(catalog(afterUpgrade), catalog(await schemaSnapshot(query, fresh)))).toEqual({});

            // 2. Apply 0104 steps on schemas whose names contain a double quote and a single quote.
            const singleQuotedSchema = `pilot'swarm_${tag}`;
            for (const special of [quotedSchema, singleQuotedSchema]) {
                await query(`CREATE SCHEMA ${qIdent(special)}`);
                await query(`CREATE TABLE ${qIdent(special)}.workflow_runs (run_id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
                await query(`CREATE TABLE ${qIdent(special)}.workflow_node_executions (node_execution_id TEXT PRIMARY KEY, state TEXT NOT NULL, deadline_at TIMESTAMPTZ)`);
                for (const stepSql of workflowRerunMigration(special)) await query(stepSql);
                for (const stepSql of workflowRerunMigration(special)) await query(stepSql);
            }

            // 3. Seed #2 and #3 in upgraded schema and test CHECK constraints + survival on #2 deletion.
            const s = qIdent(upgraded);
            const wf2 = `wf2-${tag}`;
            const wf3 = `wf3-${tag}`;
            const run2 = `run2-${tag}`;
            const run3 = `run3-${tag}`;
            const nx2 = `nx-2-${tag}`;
            const nx3 = `nx-3-${tag}`;
            for (const wf of [wf2, wf3]) {
                await query(`INSERT INTO ${s}.workflow_definitions (workflow_session_id, api_version, state, current_revision, published_revision, published_yaml_sha256, published_ir_sha256) VALUES ($1, 'pilotswarm.dev/v1', 'published', 1, 1, 'yh', 'ih')`, [wf]);
                await query(`INSERT INTO ${s}.workflow_revisions (workflow_session_id, revision, yaml, yaml_sha256, valid, diagnostics, ir, ir_sha256, actor) VALUES ($1, 1, 'y', 'yh', true, '[]', '{}', 'ih', '{}')`, [wf]);
            }
            await query(
                `INSERT INTO ${s}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, start_operation_id, finished_at)
                 VALUES ($1, $2, 'live', 1, 'yh', 'ih', '{}', $3, 'failed', 'op2', now())`,
                [run2, wf2, `session-${wf2}`],
            );
            await query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, completed_at)
                 VALUES ($1, $2, 'root', 'step', 1, 'script', '{}', 'h', 'completed', 'ok', 'business', '{}', 'effect', now())`,
                [nx2, run2],
            );

            // Partial rerun_* rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, start_operation_id, rerun_of_workflow_session_id)
                 VALUES ($1, $2, 'live', 1, 'yh', 'ih', '{}', $3, 'admitted', 'op3-bad', $4)`,
                [`${run3}-partial`, wf3, `session-${wf3}-partial`, wf2],
            ), "23514");

            // rerun_unwalked >= rerun_reused rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, start_operation_id,
                    rerun_of_workflow_session_id, rerun_of_run_id, rerun_from_execution_id, rerun_mode, rerun_resume, rerun_reused, rerun_unwalked, rerun_actor)
                 VALUES ($1, $2, 'live', 1, 'yh', 'ih', '{}', $3, 'admitted', 'op3-unwalked', $4, $5, $6, 'run_again', '{}', 2, 2, '{}')`,
                [`${run3}-unwalked`, wf3, `session-${wf3}-unwalked`, wf2, run2, nx2],
            ), "23514");

            // Invalid rerun_mode rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, start_operation_id,
                    rerun_of_workflow_session_id, rerun_of_run_id, rerun_from_execution_id, rerun_mode, rerun_resume, rerun_reused, rerun_unwalked, rerun_actor)
                 VALUES ($1, $2, 'live', 1, 'yh', 'ih', '{}', $3, 'admitted', 'op3-badmode', $4, $5, $6, 'bogus', '{}', 1, 0, '{}')`,
                [`${run3}-badmode`, wf3, `session-${wf3}-badmode`, wf2, run2, nx2],
            ), "23514");

            // rerun_reused = 0 rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, start_operation_id,
                    rerun_of_workflow_session_id, rerun_of_run_id, rerun_from_execution_id, rerun_mode, rerun_resume, rerun_reused, rerun_unwalked, rerun_actor)
                 VALUES ($1, $2, 'live', 1, 'yh', 'ih', '{}', $3, 'admitted', 'op3-zero', $4, $5, $6, 'run_again', '{}', 0, 0, '{}')`,
                [`${run3}-zero`, wf3, `session-${wf3}-zero`, wf2, run2, nx2],
            ), "23514");

            // Valid #3 re-run row succeeds
            await query(
                `INSERT INTO ${s}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, start_operation_id,
                    rerun_of_workflow_session_id, rerun_of_run_id, rerun_from_execution_id, rerun_mode, rerun_resume, rerun_reused, rerun_unwalked, rerun_actor)
                 VALUES ($1, $2, 'live', 1, 'yh', 'ih', '{}', $3, 'admitted', 'op3', $4, $5, $6, 'run_again', '{}', 1, 0, '{}')`,
                [run3, wf3, `session-${wf3}`, wf2, run2, nx2],
            );

            // Partial reused_* rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, completed_at, reused_from_execution_id)
                 VALUES ($1, $2, 'root', 'step', 1, 'script', '{}', 'h', 'completed', 'ok', 'business', '{}', 'effect', now(), $3)`,
                [`${nx3}-partial`, run3, nx2],
            ), "23514");

            // Reused row with state = 'pending' rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, reused_from_execution_id, reused_from_run_id, reused_from_workflow_session_id, reused_at)
                 VALUES ($1, $2, 'root', 'step', 1, 'script', '{}', 'h', 'pending', $3, $4, $5, now())`,
                [`${nx3}-pending`, run3, nx2, run2, wf2],
            ), "23514");

            // Reused row with non-null deadline_at rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, completed_at, deadline_at, reused_from_execution_id, reused_from_run_id, reused_from_workflow_session_id, reused_at)
                 VALUES ($1, $2, 'root', 'step', 1, 'script', '{}', 'h', 'completed', 'ok', 'business', '{}', 'effect', now(), now(), $3, $4, $5, now())`,
                [`${nx3}-deadline`, run3, nx2, run2, wf2],
            ), "23514");

            // Valid reused row succeeds
            await query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, completed_at, deadline_at, reused_from_execution_id, reused_from_run_id, reused_from_workflow_session_id, reused_at)
                 VALUES ($1, $2, 'root', 'step', 1, 'script', '{}', 'h', 'completed', 'ok', 'business', '{}', 'effect', now(), NULL, $3, $4, $5, now())`,
                [nx3, run3, nx2, run2, wf2],
            );

            // Deleting #2's rows does NOT block or cascade onto #3
            await query(`DELETE FROM ${s}.workflow_node_executions WHERE run_id = $1`, [run2]);
            await query(`DELETE FROM ${s}.workflow_runs WHERE run_id = $1`, [run2]);
            await query(`DELETE FROM ${s}.workflow_revisions WHERE workflow_session_id = $1`, [wf2]);
            await query(`DELETE FROM ${s}.workflow_definitions WHERE workflow_session_id = $1`, [wf2]);

            const keptRun = await query(`SELECT rerun_of_workflow_session_id, rerun_of_run_id, rerun_reused FROM ${s}.workflow_runs WHERE run_id = $1`, [run3]);
            expect(keptRun.rows).toEqual([{ rerun_of_workflow_session_id: wf2, rerun_of_run_id: run2, rerun_reused: 1 }]);
            const keptNode = await query(`SELECT reused_from_execution_id, reused_from_run_id, reused_from_workflow_session_id FROM ${s}.workflow_node_executions WHERE node_execution_id = $1`, [nx3]);
            expect(keptNode.rows).toEqual([{ reused_from_execution_id: nx2, reused_from_run_id: run2, reused_from_workflow_session_id: wf2 }]);
        } finally {
            await pool.query(`DROP SCHEMA IF EXISTS ${qIdent(upgraded)} CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS ${qIdent(fresh)} CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS ${qIdent(quotedSchema)} CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS ${qIdent(`pilot'swarm_${tag}`)} CASCADE`);
            await pool.end();
        }
    });

    it("passes over 0 (baseline), 100, and 1,000 SQL-seeded reused visits on the unchanged 1.3.0 controller and records RERUN_PASSOVER_MS", { timeout: testTime.ms(300_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            // Admit without dispatching so copied visits are seeded deterministically BEFORE the controller starts.
            const deferDispatchHost = {
                ...h,
                duroxideClient: {
                    ...h.duroxideClient,
                    startOrchestrationVersioned: async () => {},
                },
            };
            const pool = new pg.Pool(pgPoolConfig(getEnv().store));
            const schema = getEnv().cmsSchema;
            try {
                const timings = {};
                for (const count of [0, 100, 1000]) {
                    const wfId = randomUUID();
                    const created = await createWorkflow(deferDispatchHost, {
                        workflowSessionId: wfId,
                        parentSessionId: null,
                        yaml: PASSOVER_LOOP(count),
                        actor: ACTOR,
                        operationId: `spike-create-${count}`,
                        start: { inputs: {}, actor: ACTOR, operationId: `spike-start-${count}` },
                    });
                    expect(created.receipt.run, `run for ${count}`).not.toBeNull();
                    const runId = created.receipt.run.runId;
                    if (count > 0) {
                        const srcWfId = randomUUID();
                        const srcRunId = randomUUID();
                        await seedCopiedLoopVisits(pool, schema, srcWfId, srcRunId, runId, count);
                    }

                    const t0 = Date.now();
                    await dispatchWorkflowRun(h, created.receipt);
                    const finished = await waitForRunEnd(h, runId, 240_000);
                    const elapsedMs = Date.now() - t0;
                    timings[count] = elapsedMs;

                    expect(finished.status, `count=${count}`).toBe("completed");
                    expect(finished.terminalOutcome).toBe("succeeded");
                    expect(finished.terminalOutput).toMatchObject({ n: count + 1 });

                    const s = `"${schema.replace(/"/g, '""')}"`;
                    const stats = await pool.query(
                        `SELECT
                            COUNT(*) FILTER (WHERE node_id = 'step' AND reused_from_execution_id IS NOT NULL)::int AS reused_steps,
                            COUNT(*) FILTER (WHERE node_id = 'step' AND reused_from_execution_id IS NULL)::int AS live_steps,
                            COALESCE(SUM(effect_attempts) FILTER (WHERE node_id = 'step' AND reused_from_execution_id IS NOT NULL), 0)::int AS reused_attempts,
                            COALESCE(SUM(effect_attempts) FILTER (WHERE node_id = 'step' AND reused_from_execution_id IS NULL), 0)::int AS live_attempts
                         FROM ${s}.workflow_node_executions WHERE run_id = $1`,
                        [runId],
                    );
                    expect(stats.rows[0]).toEqual({
                        reused_steps: count,
                        live_steps: 1,
                        reused_attempts: 0,
                        live_attempts: 1,
                    });
                }
                console.info("RERUN_PASSOVER_MS", JSON.stringify({ baseline0Ms: timings[0], visits100Ms: timings[100], visits1000Ms: timings[1000] }));
            } finally {
                await pool.end();
            }
        });
    });
});
