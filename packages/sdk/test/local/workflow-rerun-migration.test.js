import { describe, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { schemaSnapshot, snapshotDifferences } from "../helpers/schema-snapshot.js";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { workflowRerunMigration } from "../../src/migrations/workflow-rerun-0104.ts";
import { PostgresProvider, Runtime, Client } from "duroxide";
import { PgSessionCatalog } from "../../src/cms.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";
import { registerWorkflow, sessionQueueTransport, WORKFLOW_ACTIVITIES } from "../../src/workflow/runtime.ts";
import { createWorkflow, dispatchWorkflowRun } from "../../src/workflow/service.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const SEED = 0x63_6d_73;
const ACTOR = { kind: "system", name: "workflow-rerun-migration-test" };

function pgPoolConfig(connectionString) {
    const parsed = new URL(connectionString);
    const sslMode = (parsed.searchParams.get("sslmode") ?? "").toLowerCase();
    // Preserve strict verify-ca / verify-full semantics; only relax require / prefer for preview HorizonDB certs (M13d).
    const relaxSsl = sslMode === "require" || sslMode === "prefer";
    if (relaxSsl) parsed.searchParams.delete("sslmode");
    return {
        connectionString: parsed.toString(),
        max: 2,
        ...(relaxSsl ? { ssl: { rejectUnauthorized: false } } : {}),
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
        const selfUpgraded = `wf0104_${tag}_s`;
        const fresh = `wf0104_${tag}_f`;
        const quotedSchema = `pilot"swarm_${tag}`;
        const qIdent = (name) => `"${name.replace(/"/g, '""')}"`;
        const query = (sql, params) => pool.query(sql, params);
        try {
            // 1. Upgrade from <= 0103 to <= 0104, verify idempotent re-apply (all 7 steps), and match fresh install.
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

            // 1b. 0104's steps are idempotent: run directly over the DDL of the pre-supply cf0e203cb 2-mode 0104 (S5), not recorded
            // here, they replace its constraints and add the missing columns. This is DDL re-application, not startup: the migrator
            // skips a recorded 0104, so a dev/test schema that recorded an earlier, unreleased 0104 is dropped and recreated.
            await runMigrations(pool, selfUpgraded, CMS_MIGRATIONS(selfUpgraded).filter(m => m.version < "0104"), SEED);
            const su = qIdent(selfUpgraded);
            await query(`
                ALTER TABLE ${su}.workflow_runs
                    ADD COLUMN IF NOT EXISTS rerun_of_workflow_session_id TEXT,
                    ADD COLUMN IF NOT EXISTS rerun_of_run_id TEXT,
                    ADD COLUMN IF NOT EXISTS rerun_from_execution_id TEXT,
                    ADD COLUMN IF NOT EXISTS rerun_mode TEXT,
                    ADD COLUMN IF NOT EXISTS rerun_resume TEXT,
                    ADD COLUMN IF NOT EXISTS rerun_resumed_at TIMESTAMPTZ,
                    ADD COLUMN IF NOT EXISTS rerun_reused INTEGER,
                    ADD COLUMN IF NOT EXISTS rerun_unwalked INTEGER,
                    ADD COLUMN IF NOT EXISTS rerun_actor TEXT;
                ALTER TABLE ${su}.workflow_runs ADD CONSTRAINT workflow_runs_rerun_check CHECK (
                    (rerun_of_workflow_session_id IS NULL AND rerun_of_run_id IS NULL AND rerun_from_execution_id IS NULL
                     AND rerun_mode IS NULL AND rerun_resume IS NULL AND rerun_resumed_at IS NULL
                     AND rerun_reused IS NULL AND rerun_unwalked IS NULL AND rerun_actor IS NULL)
                    OR
                    (rerun_of_workflow_session_id IS NOT NULL AND rerun_of_run_id IS NOT NULL AND rerun_from_execution_id IS NOT NULL
                     AND rerun_mode IN ('run_again', 'continue') AND rerun_resume IS NOT NULL
                     AND rerun_reused IS NOT NULL AND rerun_reused >= 1
                     AND rerun_unwalked IS NOT NULL AND rerun_unwalked >= 0 AND rerun_unwalked < rerun_reused
                     AND rerun_actor IS NOT NULL)
                );
                ALTER TABLE ${su}.workflow_node_executions
                    ADD COLUMN IF NOT EXISTS reused_from_execution_id TEXT,
                    ADD COLUMN IF NOT EXISTS reused_from_run_id TEXT,
                    ADD COLUMN IF NOT EXISTS reused_from_workflow_session_id TEXT,
                    ADD COLUMN IF NOT EXISTS reused_at TIMESTAMPTZ;
                ALTER TABLE ${su}.workflow_node_executions ADD CONSTRAINT workflow_node_executions_reused_check CHECK (
                    (reused_from_execution_id IS NULL AND reused_from_run_id IS NULL
                     AND reused_from_workflow_session_id IS NULL AND reused_at IS NULL)
                    OR
                    (reused_from_execution_id IS NOT NULL AND reused_from_run_id IS NOT NULL
                     AND reused_from_workflow_session_id IS NOT NULL AND reused_at IS NOT NULL
                     AND state = 'completed' AND deadline_at IS NULL)
                );
            `);
            // Seed existing pre-supply 3A rerun + reused rows BEFORE re-applying 0104 to prove VALIDATE CONSTRAINT passes over live 3A data (M13c).
            const preWf2 = `pre-wf2-${tag}`;
            const preWf3 = `pre-wf3-${tag}`;
            const preRun2 = `pre-run2-${tag}`;
            const preRun3 = `pre-run3-${tag}`;
            for (const wf of [preWf2, preWf3]) {
                await query(`INSERT INTO ${su}.workflow_definitions (workflow_session_id, api_version, state, current_revision, published_revision, published_yaml_sha256, published_ir_sha256) VALUES ($1, 'pilotswarm.dev/v1', 'published', 1, 1, 'yh', 'ih')`, [wf]);
                await query(`INSERT INTO ${su}.workflow_revisions (workflow_session_id, revision, yaml, yaml_sha256, valid, diagnostics, ir, ir_sha256, actor) VALUES ($1, 1, 'y', 'yh', true, '[]', '{}', 'ih', '{}')`, [wf]);
            }
            await query(
                `INSERT INTO ${su}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, start_operation_id, finished_at)
                 VALUES ($1, $2, 'live', 1, 'yh', 'ih', '{}', $3, 'failed', 'op-pre2', now())`,
                [preRun2, preWf2, `session-${preWf2}`],
            );
            await query(
                `INSERT INTO ${su}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, start_operation_id,
                    rerun_of_workflow_session_id, rerun_of_run_id, rerun_from_execution_id, rerun_mode, rerun_resume, rerun_reused, rerun_unwalked, rerun_actor)
                 VALUES ($1, $2, 'live', 1, 'yh', 'ih', '{}', $3, 'admitted', 'op-pre3', $4, $5, 'nx-pre2', 'run_again', '{}', 1, 0, '{}')`,
                [preRun3, preWf3, `session-${preWf3}`, preWf2, preRun2],
            );
            await query(
                `INSERT INTO ${su}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, completed_at, deadline_at,
                    reused_from_execution_id, reused_from_run_id, reused_from_workflow_session_id, reused_at)
                 VALUES ('nx-pre3', $1, 'root', 'step', 1, 'script', '{}', 'h', 'completed', 'ok', 'business', '{}', 'effect', now(), NULL, 'nx-pre2', $2, $3, now())`,
                [preRun3, preRun2, preWf2],
            );
            for (const stepSql of workflowRerunMigration(selfUpgraded)) {
                await query(stepSql);
            }
            for (const targetSchema of [fresh, upgraded, selfUpgraded]) {
                const defs = await query(
                    `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
                       FROM pg_constraint c
                       JOIN pg_class t ON t.oid = c.conrelid
                       JOIN pg_namespace n ON n.oid = t.relnamespace
                      WHERE n.nspname = $1
                        AND c.conname IN ('workflow_runs_rerun_check', 'workflow_node_executions_reused_check')`,
                    [targetSchema],
                );
                const byName = Object.fromEntries(defs.rows.map(r => [r.conname, r.def]));
                expect(byName.workflow_runs_rerun_check, `${targetSchema} runs check`).toContain("supply");
                expect(byName.workflow_node_executions_reused_check, `${targetSchema} nodes check`).toContain("supplied_from_execution_id");

                const cols = await query(
                    `SELECT column_name
                       FROM information_schema.columns
                      WHERE table_schema = $1 AND table_name = 'workflow_node_executions'
                        AND column_name LIKE 'supplied_%'
                      ORDER BY column_name`,
                    [targetSchema],
                );
                expect(cols.rows.map(r => r.column_name), `${targetSchema} supplied columns`).toEqual([
                    "supplied_actor",
                    "supplied_at",
                    "supplied_from_execution_id",
                    "supplied_from_run_id",
                    "supplied_from_workflow_session_id",
                    "supplied_note",
                ]);
                // Review RR-1: a carried inbox row keeps its first acceptance time.
                const inboxCols = await query(
                    `SELECT data_type, is_nullable FROM information_schema.columns
                      WHERE table_schema = $1 AND table_name = 'workflow_inbox' AND column_name = 'origin_accepted_at'`,
                    [targetSchema],
                );
                expect(inboxCols.rows, `${targetSchema} workflow_inbox.origin_accepted_at`).toEqual([
                    { data_type: "timestamp with time zone", is_nullable: "YES" },
                ]);
            }
            // The re-applied schema matches the fresh schema catalog (tables, columns, constraints, indexes).
            expect(snapshotDifferences(catalog(await schemaSnapshot(query, selfUpgraded)), catalog(await schemaSnapshot(query, fresh)))).toEqual({});

            // 2. Apply 0104 steps on schemas whose names contain a double quote and a single quote.
            const singleQuotedSchema = `pilot'swarm_${tag}`;
            for (const special of [quotedSchema, singleQuotedSchema]) {
                await query(`CREATE SCHEMA ${qIdent(special)}`);
                await query(`CREATE TABLE ${qIdent(special)}.workflow_runs (run_id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
                await query(`CREATE TABLE ${qIdent(special)}.workflow_node_executions (node_execution_id TEXT PRIMARY KEY, state TEXT NOT NULL, deadline_at TIMESTAMPTZ, winner TEXT, result_kind TEXT, effect_attempts INTEGER NOT NULL DEFAULT 0)`);
                await query(`CREATE TABLE ${qIdent(special)}.workflow_inbox (message_id TEXT PRIMARY KEY)`);
                for (const stepSql of workflowRerunMigration(special)) await query(stepSql);
                for (const stepSql of workflowRerunMigration(special)) await query(stepSql);
            }

            // 3. Seed #2 and #3 in upgraded schema and test CHECK constraints + survival on #2 deletion.
            const s = qIdent(upgraded);
            const wf2 = `wf2-${tag}`;
            const wf3 = `wf3-${tag}`;
            const wf3s0 = `wf3s0-${tag}`;
            const wf3s2 = `wf3s2-${tag}`;
            const run2 = `run2-${tag}`;
            const run3 = `run3-${tag}`;
            const nx2 = `nx-2-${tag}`;
            const nx3 = `nx-3-${tag}`;
            for (const wf of [wf2, wf3, wf3s0, wf3s2]) {
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

            // rerun_reused = 0 rejected for run_again and continue (23514)
            for (const m of ["run_again", "continue"]) {
                await expectSqlState(query(
                    `INSERT INTO ${s}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, start_operation_id,
                        rerun_of_workflow_session_id, rerun_of_run_id, rerun_from_execution_id, rerun_mode, rerun_resume, rerun_reused, rerun_unwalked, rerun_actor)
                     VALUES ($1, $2, 'live', 1, 'yh', 'ih', '{}', $3, 'admitted', $4, $5, $6, $7, $8, '{}', 0, 0, '{}')`,
                    [`${run3}-zero-${m}`, wf3, `session-${wf3}-zero-${m}`, `op3-zero-${m}`, wf2, run2, nx2, m],
                ), "23514");
            }

            // rerun_mode = 'supply' with rerun_reused = 0 AND rerun_unwalked > 0 rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, start_operation_id,
                    rerun_of_workflow_session_id, rerun_of_run_id, rerun_from_execution_id, rerun_mode, rerun_resume, rerun_reused, rerun_unwalked, rerun_actor)
                 VALUES ($1, $2, 'live', 1, 'yh', 'ih', '{}', $3, 'admitted', 'op3-sup-bad-unwalked', $4, $5, $6, 'supply', '{}', 0, 1, '{}')`,
                [`${run3}-sup-bad-unwalked`, wf3, `session-${wf3}-sup-bad-unwalked`, wf2, run2, nx2],
            ), "23514");

            // rerun_mode = 'supply' with rerun_reused >= 1 AND rerun_unwalked >= rerun_reused rejected (23514, M13c)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, start_operation_id,
                    rerun_of_workflow_session_id, rerun_of_run_id, rerun_from_execution_id, rerun_mode, rerun_resume, rerun_reused, rerun_unwalked, rerun_actor)
                 VALUES ($1, $2, 'live', 1, 'yh', 'ih', '{}', $3, 'admitted', 'op3-sup-bad-ge', $4, $5, $6, 'supply', '{}', 2, 2, '{}')`,
                [`${run3}-sup-bad-ge`, wf3, `session-${wf3}-sup-bad-ge`, wf2, run2, nx2],
            ), "23514");

            // rerun_mode = 'supply' with rerun_reused = 0, rerun_unwalked = 0 (visit 1) succeeds
            await query(
                `INSERT INTO ${s}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, start_operation_id,
                    rerun_of_workflow_session_id, rerun_of_run_id, rerun_from_execution_id, rerun_mode, rerun_resume, rerun_reused, rerun_unwalked, rerun_actor)
                 VALUES ($1, $2, 'live', 1, 'yh', 'ih', '{}', $3, 'admitted', 'op3-sup-zero', $4, $5, $6, 'supply', '{}', 0, 0, '{}')`,
                [`${run3}-sup-zero`, wf3s0, `session-${wf3s0}`, wf2, run2, nx2],
            );

            // rerun_mode = 'supply' with rerun_reused = 2, rerun_unwalked = 1 succeeds
            await query(
                `INSERT INTO ${s}.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, start_operation_id,
                    rerun_of_workflow_session_id, rerun_of_run_id, rerun_from_execution_id, rerun_mode, rerun_resume, rerun_reused, rerun_unwalked, rerun_actor)
                 VALUES ($1, $2, 'live', 1, 'yh', 'ih', '{}', $3, 'admitted', 'op3-sup-two', $4, $5, $6, 'supply', '{}', 2, 1, '{}')`,
                [`${run3}-sup-two`, wf3s2, `session-${wf3s2}`, wf2, run2, nx2],
            );

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

            // Partial supplied_* rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, effect_attempts, completed_at, supplied_from_execution_id)
                 VALUES ($1, $2, 'root', 'step', 2, 'script', '{}', 'h', 'completed', 'ok', 'business', 'null', 'supplied', 0, now(), $3)`,
                [`${nx3}-sup-partial`, run3, nx2],
            ), "23514");

            // winner = 'supplied' without supplied_* rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, effect_attempts, completed_at)
                 VALUES ($1, $2, 'root', 'step', 2, 'script', '{}', 'h', 'completed', 'ok', 'business', 'null', 'supplied', 0, now())`,
                [`${nx3}-sup-no-cols`, run3],
            ), "23514");

            // supplied_* with winner <> 'supplied' rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, effect_attempts, completed_at,
                    supplied_from_execution_id, supplied_from_run_id, supplied_from_workflow_session_id, supplied_actor, supplied_note, supplied_at)
                 VALUES ($1, $2, 'root', 'step', 2, 'script', '{}', 'h', 'completed', 'ok', 'business', 'null', 'effect', 0, now(), $3, $4, $5, '{}', 'verified', now())`,
                [`${nx3}-sup-bad-winner`, run3, nx2, run2, wf2],
            ), "23514");

            // supplied_* with result_kind = 'runtime_error' rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, error, winner, effect_attempts, completed_at,
                    supplied_from_execution_id, supplied_from_run_id, supplied_from_workflow_session_id, supplied_actor, supplied_note, supplied_at)
                 VALUES ($1, $2, 'root', 'step', 2, 'script', '{}', 'h', 'completed', 'execution_failed', 'runtime_error', '{}', 'supplied', 0, now(), $3, $4, $5, '{}', 'verified', now())`,
                [`${nx3}-sup-bad-kind`, run3, nx2, run2, wf2],
            ), "23514");

            // supplied_* with effect_attempts > 0 rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, effect_attempts, completed_at,
                    supplied_from_execution_id, supplied_from_run_id, supplied_from_workflow_session_id, supplied_actor, supplied_note, supplied_at)
                 VALUES ($1, $2, 'root', 'step', 2, 'script', '{}', 'h', 'completed', 'ok', 'business', 'null', 'supplied', 1, now(), $3, $4, $5, '{}', 'verified', now())`,
                [`${nx3}-sup-attempts`, run3, nx2, run2, wf2],
            ), "23514");

            // supplied_* with blank / ASCII-space-only supplied_note rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, effect_attempts, completed_at,
                    supplied_from_execution_id, supplied_from_run_id, supplied_from_workflow_session_id, supplied_actor, supplied_note, supplied_at)
                 VALUES ($1, $2, 'root', 'step', 2, 'script', '{}', 'h', 'completed', 'ok', 'business', 'null', 'supplied', 0, now(), $3, $4, $5, '{}', '   ', now())`,
                [`${nx3}-sup-blank-note`, run3, nx2, run2, wf2],
            ), "23514");

            // supplied_* with 2,001-char supplied_note rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, effect_attempts, completed_at,
                    supplied_from_execution_id, supplied_from_run_id, supplied_from_workflow_session_id, supplied_actor, supplied_note, supplied_at)
                 VALUES ($1, $2, 'root', 'step', 2, 'script', '{}', 'h', 'completed', 'ok', 'business', 'null', 'supplied', 0, now(), $3, $4, $5, '{}', $6, now())`,
                [`${nx3}-sup-long-note`, run3, nx2, run2, wf2, "a".repeat(2001)],
            ), "23514");

            // supplied_* with non-null deadline_at rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, effect_attempts, completed_at, deadline_at,
                    supplied_from_execution_id, supplied_from_run_id, supplied_from_workflow_session_id, supplied_actor, supplied_note, supplied_at)
                 VALUES ($1, $2, 'root', 'step', 2, 'script', '{}', 'h', 'completed', 'ok', 'business', 'null', 'supplied', 0, now(), now(), $3, $4, $5, '{}', 'verified', now())`,
                [`${nx3}-sup-deadline`, run3, nx2, run2, wf2],
            ), "23514");

            // supplied_* with state = 'pending' rejected (23514)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, winner, effect_attempts,
                    supplied_from_execution_id, supplied_from_run_id, supplied_from_workflow_session_id, supplied_actor, supplied_note, supplied_at)
                 VALUES ($1, $2, 'root', 'step', 2, 'script', '{}', 'h', 'pending', 'supplied', 0, $3, $4, $5, '{}', 'verified', now())`,
                [`${nx3}-sup-pending`, run3, nx2, run2, wf2],
            ), "23514");

            // supplied_* with SQL NULL output rejected (23514 by workflow_node_executions_result; N4 requires 'null' JSON text)
            await expectSqlState(query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, effect_attempts, completed_at, deadline_at,
                    supplied_from_execution_id, supplied_from_run_id, supplied_from_workflow_session_id, supplied_actor, supplied_note, supplied_at)
                 VALUES ($1, $2, 'root', 'step', 2, 'script', '{}', 'h', 'completed', 'ok', 'business', NULL, 'supplied', 0, now(), NULL, $3, $4, $5, '{}', 'verified', now())`,
                [`${nx3}-sup-sql-null-out`, run3, nx2, run2, wf2],
            ), "23514");

            // Valid supplied row with output = 'null' JSON text (N4) and 2,000-char note succeeds
            await query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, effect_attempts, completed_at, deadline_at,
                    supplied_from_execution_id, supplied_from_run_id, supplied_from_workflow_session_id, supplied_actor, supplied_note, supplied_at)
                 VALUES ($1, $2, 'root', 'step', 2, 'script', '{}', 'h', 'completed', 'ok', 'business', 'null', 'supplied', 0, now(), NULL, $3, $4, $5, '{}', $6, now())`,
                [`${nx3}-sup-ok`, `${run3}-sup-zero`, nx2, run2, wf2, "x".repeat(2000)],
            );

            // Valid multi-generation #3 -> #4 row with BOTH reused_from_* AND supplied_* succeeds
            await query(
                `INSERT INTO ${s}.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state, outcome, result_kind, output, winner, effect_attempts, completed_at, deadline_at,
                    reused_from_execution_id, reused_from_run_id, reused_from_workflow_session_id, reused_at,
                    supplied_from_execution_id, supplied_from_run_id, supplied_from_workflow_session_id, supplied_actor, supplied_note, supplied_at)
                 VALUES ($1, $2, 'root', 'step', 3, 'script', '{}', 'h', 'completed', 'ok', 'business', '{"ok":true}', 'supplied', 0, now(), NULL,
                    $3, $4, $5, now(), $6, $7, $8, '{}', 'verified via az cli', now())`,
                [`${nx3}-gen4-both`, `${run3}-sup-two`, `${nx3}-sup-ok`, `${run3}-sup-zero`, wf3s0, nx2, run2, wf2],
            );

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
            await pool.query(`DROP SCHEMA IF EXISTS ${qIdent(selfUpgraded)} CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS ${qIdent(fresh)} CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS ${qIdent(quotedSchema)} CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS ${qIdent(`pilot'swarm_${tag}`)} CASCADE`);
            await pool.end();
        }
    });

    it("upgrades one schema while another schema with the same 0104 constraints is dropped concurrently", { timeout: testTime.ms(120_000) }, async () => {
        const pool = new pg.Pool(pgPoolConfig(getEnv().store));
        const tag = randomUUID().replace(/-/g, "").slice(0, 10);
        const target = `wf0104_${tag}_t`;
        const dropped = `wf0104_${tag}_d`;
        const qIdent = (name) => `"${name.replace(/"/g, '""')}"`;
        const minimalTables = async (schema) => {
            await pool.query(`CREATE SCHEMA ${qIdent(schema)}`);
            await pool.query(`CREATE TABLE ${qIdent(schema)}.workflow_runs (run_id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
            await pool.query(`CREATE TABLE ${qIdent(schema)}.workflow_node_executions (node_execution_id TEXT PRIMARY KEY, state TEXT NOT NULL, deadline_at TIMESTAMPTZ, winner TEXT, result_kind TEXT, effect_attempts INTEGER NOT NULL DEFAULT 0)`);
            await pool.query(`CREATE TABLE ${qIdent(schema)}.workflow_inbox (message_id TEXT PRIMARY KEY)`);
        };
        const upgrader = new pg.Client(pgPoolConfig(getEnv().store));
        await upgrader.connect();
        try {
            await minimalTables(dropped);
            for (const stepSql of workflowRerunMigration(dropped)) await pool.query(stepSql);
            await minimalTables(target);
            // The upgrader's snapshot still sees the dropped schema's constraints after the DROP commits: the constraint lookup
            // must stay on the target schema's own tables, or its definition read opens a relation that no longer exists.
            await upgrader.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
            await upgrader.query("SELECT 1");
            await pool.query(`DROP SCHEMA ${qIdent(dropped)} CASCADE`);
            const [first, ...rest] = workflowRerunMigration(target);
            try {
                await upgrader.query(first);
            } catch (error) {
                await upgrader.query("ROLLBACK").catch(() => {});
                throw error;
            }
            for (const stepSql of rest) await upgrader.query(stepSql);
            const { rows } = await pool.query(
                `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
                   FROM pg_constraint c
                  WHERE c.conrelid IN (to_regclass(format('%I.%I', $1::text, 'workflow_runs')), to_regclass(format('%I.%I', $1::text, 'workflow_node_executions')))
                    AND c.conname IN ('workflow_runs_rerun_check', 'workflow_node_executions_reused_check')
                  ORDER BY c.conname`,
                [target],
            );
            expect(rows.map(r => r.conname)).toEqual(["workflow_node_executions_reused_check", "workflow_runs_rerun_check"]);
            expect(rows[0].def).toContain("supplied_from_execution_id");
            expect(rows[1].def).toContain("supply");
        } finally {
            await upgrader.end().catch(() => {});
            await pool.query(`DROP SCHEMA IF EXISTS ${qIdent(target)} CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS ${qIdent(dropped)} CASCADE`);
            await pool.end();
        }
    });

    it("passes over 0 (baseline), 100, and 1,000 SQL-seeded reused visits on the unchanged 1.3.0 controller and records RERUN_PASSOVER_MS", { timeout: testTime.ms(300_000) }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = host(client);
            // Admit without dispatching so copied visits are seeded deterministically BEFORE the controller starts.
            const deferDispatchHost = {
                ...h,
                duroxideClient: Object.assign(Object.create(h.duroxideClient), {
                    startOrchestrationVersioned: async () => {},
                }),
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
                    // The pass-over boundary, in the database's clock: from the run's begin (workflow.started) to its first live
                    // admission (the first row that is neither reused nor supplied).
                    const s = `"${schema.replace(/"/g, '""')}"`;
                    const boundary = await pool.query(
                        `SELECT round(EXTRACT(EPOCH FROM (
                                (SELECT min(n.entered_at) FROM ${s}.workflow_node_executions n
                                  WHERE n.run_id = $1 AND n.reused_from_execution_id IS NULL AND n.supplied_from_execution_id IS NULL)
                                - (SELECT min(e.created_at) FROM ${s}.session_events e WHERE e.session_id = $2 AND e.event_type = 'workflow.started')
                            )) * 1000)::int AS ms`,
                        [runId, wfId],
                    );
                    timings[count] = { dispatchToEndMs: elapsedMs, startedToFirstLiveMs: boundary.rows[0].ms };

                    expect(finished.status, `count=${count}`).toBe("completed");
                    expect(finished.terminalOutcome).toBe("succeeded");
                    expect(finished.terminalOutput).toMatchObject({ n: count + 1 });

                    expect(timings[count].startedToFirstLiveMs, `count=${count}`).toBeGreaterThanOrEqual(0);
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
                console.info("RERUN_PASSOVER_MS", JSON.stringify({ baseline0: timings[0], visits100: timings[100], visits1000: timings[1000] }));
            } finally {
                await pool.end();
            }
        });
    });

    it("Spec §11.2 #19: a worker shut down mid-way through a 60-visit pass-over resumes from persisted history, continues as new and completes with 0 re-executions", { timeout: testTime.ms(300_000) }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const store = catalog.workflowStore();
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const pool = new pg.Pool(pgPoolConfig(env.store));
        const count = 60;
        const stopAfter = 30;
        const enters = [];
        let scriptRuns = 0;
        let reached;
        const reachedStop = new Promise(resolve => { reached = resolve; });
        // A worker runtime with the Workflow activities. Worker A counts the pass-over admissions, signals after `stopAfter` of
        // them and then slows each further one, so it is shut down mid-way; worker B is a fresh runtime with no hooks.
        const startWorker = async (label) => {
            const runtime = new Runtime(provider, {
                dispatcherPollIntervalMs: 10, logLevel: "error", workerConcurrency: 8, workerLockTimeoutMs: 5_000,
                workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
            });
            registerWorkflow({
                registerActivity: (name, activity) => runtime.registerActivity(name, async (actx, input) => {
                    if (name === WORKFLOW_ACTIVITIES.runScript) scriptRuns += 1;
                    if (name === WORKFLOW_ACTIVITIES.enter && input?.nodeId === "step") {
                        enters.push({ worker: label, ordinal: input.ordinal });
                        if (label === "A" && input.ordinal >= stopAfter) {
                            if (input.ordinal === stopAfter) reached();
                            await new Promise(resolve => setTimeout(resolve, 300));
                        }
                    }
                    return activity(actx, input);
                }),
                registerOrchestrationVersioned: (name, version, handler) => runtime.registerOrchestrationVersioned(name, version, handler),
            }, {
                store,
                catalog,
                enabled: () => true,
                resolveToolBinding: async () => null,
                openToolExecutor: async () => { throw new Error("No tools"); },
                authorizeParentNotification: async () => false,
                notifyParent: async () => {},
                deleteSession: async id => catalog.softDeleteSession(id),
                wakeBackstopMs: 500,
                sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
            });
            await runtime.start();
            return runtime;
        };
        let worker = null;
        try {
            const h = { catalog, store, duroxideClient: client };
            const deferDispatchHost = { ...h, duroxideClient: Object.assign(Object.create(client), { startOrchestrationVersioned: async () => {} }) };
            const wfId = randomUUID();
            const created = await createWorkflow(deferDispatchHost, {
                workflowSessionId: wfId,
                parentSessionId: null,
                yaml: PASSOVER_LOOP(count),
                actor: ACTOR,
                operationId: `crash-create-${wfId}`,
                start: { inputs: {}, actor: ACTOR, operationId: `crash-start-${wfId}` },
            });
            const runId = created.receipt.run.runId;
            const instanceId = created.receipt.run.controllerInstanceId;
            await seedCopiedLoopVisits(pool, env.cmsSchema, randomUUID(), randomUUID(), runId, count);

            worker = await startWorker("A");
            await dispatchWorkflowRun(h, created.receipt);
            await Promise.race([
                reachedStop,
                new Promise((_, reject) => setTimeout(() => reject(new Error(`worker A did not reach pass-over visit ${stopAfter}`)), testTime.ms(120_000))),
            ]);
            await worker.shutdown(10_000);
            worker = null;

            // Worker A stopped mid-way: the run is still running, it already continued as new (25 admissions per execution),
            // and it walked some but not all copied visits.
            const mid = await store.readRun(runId);
            expect(mid.finishedAt).toBeNull();
            expect(["running", "admitted"]).toContain(mid.status);
            const byA = enters.filter(e => e.worker === "A").map(e => e.ordinal);
            expect(Math.max(...byA)).toBeGreaterThanOrEqual(stopAfter);
            expect(Math.max(...byA)).toBeLessThan(count);
            expect((await client.listExecutions(instanceId)).length).toBeGreaterThanOrEqual(2);
            expect(scriptRuns).toBe(0);

            worker = await startWorker("B");
            const finished = await waitForRunEnd({ store }, runId, 240_000);
            expect(finished.status).toBe("completed");
            expect(finished.terminalOutcome).toBe("succeeded");
            expect(finished.terminalOutput).toMatchObject({ n: count + 1 });

            // Worker B resumed from the persisted history (it never walked the run from its first visit again) and finished
            // the pass-over; only the one live visit ran a script.
            const byB = enters.filter(e => e.worker === "B").map(e => e.ordinal);
            expect(byB.length).toBeGreaterThan(0);
            expect(Math.min(...byB)).toBeGreaterThanOrEqual(Math.max(...byA));
            expect(new Set([...byA, ...byB])).toEqual(new Set(Array.from({ length: count + 1 }, (_, i) => i + 1)));
            expect(scriptRuns).toBe(1);
            expect((await client.listExecutions(instanceId)).length).toBeGreaterThanOrEqual(3);
            const s = `"${env.cmsSchema.replace(/"/g, '""')}"`;
            const stats = await pool.query(
                `SELECT
                    COUNT(*) FILTER (WHERE reused_from_execution_id IS NOT NULL)::int AS reused_steps,
                    COUNT(*) FILTER (WHERE reused_from_execution_id IS NOT NULL AND (state <> 'completed' OR effect_attempts <> 0 OR outcome <> 'again'))::int AS reused_changed,
                    COUNT(*) FILTER (WHERE node_id = 'step' AND reused_from_execution_id IS NULL)::int AS live_steps,
                    COALESCE(SUM(effect_attempts) FILTER (WHERE node_id = 'step' AND reused_from_execution_id IS NULL), 0)::int AS live_attempts
                 FROM ${s}.workflow_node_executions WHERE run_id = $1`,
                [runId],
            );
            expect(stats.rows[0]).toEqual({ reused_steps: count, reused_changed: 0, live_steps: 1, live_attempts: 1 });
        } finally {
            if (worker) await worker.shutdown(10_000).catch(() => {});
            await pool.end();
            await catalog.close();
        }
    });
});
