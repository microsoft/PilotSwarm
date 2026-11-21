import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { workflowCarryMigration } from "../../src/migrations/workflow-carry-0090.ts";
import { runMigrations } from "../../src/pg-migrator.ts";

const getEnv = useSuiteEnv(import.meta.url);

it("0090 upgrades without changing existing input, preserves snapshots on rerun, and agrees with fresh install", { timeout: 240_000 }, async () => {
    const pool = new pg.Pool({ connectionString: getEnv().store, max: 1 });
    const tag = randomUUID().replaceAll("-", "").slice(0, 12);
    const upgraded = `carry_${tag}_u`;
    const fresh = `carry_${tag}_f`;
    const versions = schema => CMS_MIGRATIONS(schema).filter(item => item.version <= "0090");
    const column = async schema => (await pool.query(`SELECT data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'workflow_node_executions'
        AND column_name = 'carry_snapshot'`, [schema])).rows;
    try {
        await runMigrations(pool, upgraded, versions(upgraded).filter(item => item.version < "0090"), 0x636d73);
        await pool.query(`
            INSERT INTO "${upgraded}".sessions (session_id, state) VALUES ('owner', 'running');
            SELECT "${upgraded}".cms_create_workflow_session('wf', 'owner', '{}'::jsonb);
            INSERT INTO "${upgraded}".workflow_definitions (workflow_session_id, parent_session_id, api_version, state, current_revision)
                VALUES ('wf', 'owner', 'pilotswarm.dev/v1', 'draft', 1);
            INSERT INTO "${upgraded}".workflow_revisions (workflow_session_id, revision, yaml, yaml_sha256, valid, diagnostics, ir, ir_sha256, actor)
                VALUES ('wf', 1, 'y', 'ys', TRUE, '[]', '{}', 'is', '{"kind":"system","name":"carry-test"}');
            INSERT INTO "${upgraded}".workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs,
                controller_instance_id, status, start_operation_id) VALUES ('run', 'wf', 'live', 1, 'ys', 'is', '{}', 'controller', 'running', 'op');
            INSERT INTO "${upgraded}".workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state)
                VALUES ('node', 'run', 'root', 'work', 1, 'script', '{"unchanged":true}', 'hash', 'pending');
        `);
        expect(await column(upgraded)).toEqual([]);
        await runMigrations(pool, upgraded, versions(upgraded), 0x636d73);
        expect(await column(upgraded)).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
        expect((await pool.query(`SELECT input, carry_snapshot FROM "${upgraded}".workflow_node_executions`)).rows)
            .toEqual([{ input: '{"unchanged":true}', carry_snapshot: null }]);
        const snapshot = '{"text":"\\u0000\\ud800"}';
        await pool.query(`UPDATE "${upgraded}".workflow_node_executions SET carry_snapshot = $1 WHERE node_execution_id = 'node'`, [snapshot]);
        await pool.query(`BEGIN; ${workflowCarryMigration(upgraded)} COMMIT;`);
        expect((await pool.query(`SELECT carry_snapshot FROM "${upgraded}".workflow_node_executions`)).rows).toEqual([{ carry_snapshot: snapshot }]);
        await runMigrations(pool, fresh, versions(fresh), 0x636d73);
        expect(await column(fresh)).toEqual(await column(upgraded));
        expect(versions(fresh).filter(item => item.version === "0090")).toHaveLength(1);
    } finally {
        try { await pool.query(`DROP SCHEMA IF EXISTS "${upgraded}" CASCADE; DROP SCHEMA IF EXISTS "${fresh}" CASCADE;`); }
        finally { await pool.end(); }
    }
});
