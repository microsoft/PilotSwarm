/**
 * Workflow v2 data written by an earlier build stays usable after an upgrade,
 * on real PostgreSQL and the real durable runtime:
 *
 * - A schema migrated only up to 0085 (as an earlier build recorded it) gets
 *   the exclusive-creation function and the deletion trigger from 0086 when
 *   the current catalog initializes; its rows are kept and the trigger acts on
 *   them.
 * - An immutable revision compiled to IR version 1 (no root outputSchema;
 *   each succeeded terminal carries the contract it was compiled with) or
 *   version 2 (no catchAll) is read and run as stored: its text and hash are
 *   not rewritten and its YAML is not recompiled.
 */
import { describe, it, expect, afterAll } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE_URL, TEST_SCHEMA_PREFIX, useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { compileWorkflowV2, parseWorkflowIr, WORKFLOW_V2_API_VERSION } from "../../src/workflow/v2/compiler.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/v2/json.ts";
import { dispatchWorkflowV2Run } from "../../src/workflow/v2/service.ts";
import { registerWorkflowV2, workflowLiveControllerInstanceId } from "../../src/workflow/v2/runtime.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const CMS_LOCK_SEED = 0x63_6D_73;
const ACTOR = { kind: "system", name: "workflow-v2-compat-test" };

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const schemas = [];
afterAll(async () => {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
});

const CONTRACT = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: old-contract, version: "1.0.0" }
outputSchema: { type: object, required: [n], properties: { n: { type: integer } } }
initial: step
states:
  step:
    type: script
    source: |
      await setResult("ok", { n: 3 });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** The IR an earlier build (IR version 1) compiled from the same YAML: the root contract merged into succeeded terminals. */
function versionOneIr(ir) {
    const { outputSchema, catchAll: _catchAll, ...rest } = ir;
    const nodes = Object.fromEntries(Object.entries(ir.nodes).map(([id, node]) => [id,
        node.type === "terminal" && node.outcome === "succeeded" ? { ...node, outputSchema: node.outputSchema ?? outputSchema } : node]));
    return { ...rest, irVersion: 1, nodes };
}

describe("workflow v2 data from an earlier build", () => {
    it("adds the 0086 creation function and deletion trigger to a schema recorded at 0085 and keeps its rows", { timeout: TIMEOUT }, async () => {
        const schema = `${TEST_SCHEMA_PREFIX}_wfv2_up_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        schemas.push(schema);
        await runMigrations(pool, schema, CMS_MIGRATIONS(schema).filter(m => m.version <= "0085"), CMS_LOCK_SEED);
        const q = (text, values) => pool.query(text.replaceAll("SCHEMA", `"${schema}"`), values);
        const has = async () => {
            const [fn, trigger] = await Promise.all([
                q("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = 'cms_create_workflow_session_v2'", [schema]),
                q("SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND t.tgname = 'workflow_v2_session_deleted'", [schema]),
            ]);
            return { fn: fn.rows[0].n, trigger: trigger.rows[0].n };
        };
        // Control: the recorded schema really lacks both objects.
        expect(await has()).toEqual({ fn: 0, trigger: 0 });

        // Rows an earlier build wrote: a workflow session, its published definition, an active run and a pending node.
        const id = randomUUID();
        const runId = randomUUID();
        const compiled = compileWorkflowV2(CONTRACT);
        expect(compiled.valid).toBe(true);
        await q("SELECT SCHEMA.cms_create_session($1, 'm', NULL, NULL, false, NULL, NULL, NULL, NULL, 'private')", [id]);
        await q(`UPDATE SCHEMA.sessions SET session_kind = 'workflow', creation_config = $2::jsonb WHERE session_id = $1`,
            [id, JSON.stringify({ workflowV2: { apiVersion: WORKFLOW_V2_API_VERSION, requestSha256: "earlier", operationId: "create" } })]);
        await q(`INSERT INTO SCHEMA.workflow_definitions (workflow_session_id, api_version, semver, state, current_revision, published_revision,
                    published_yaml_sha256, published_ir_sha256) VALUES ($1, $2, '1.0.0', 'published', 1, 1, $3, $4)`,
            [id, WORKFLOW_V2_API_VERSION, compiled.yamlSha256, compiled.irSha256]);
        await q(`INSERT INTO SCHEMA.workflow_revisions (workflow_session_id, revision, yaml, yaml_sha256, valid, diagnostics, name, semver, ir, ir_sha256, actor)
                 VALUES ($1, 1, $2, $3, true, '[]', 'old-contract', '1.0.0', $4, $5, $6)`,
            [id, CONTRACT, compiled.yamlSha256, canonicalJson(compiled.ir), compiled.irSha256, canonicalJson(ACTOR)]);
        await q(`INSERT INTO SCHEMA.workflow_runs (run_id, workflow_session_id, mode, revision, yaml_sha256, ir_sha256, inputs, controller_instance_id, status, start_operation_id)
                 VALUES ($1, $2, 'live', 1, $3, $4, '{}', $5, 'running', 'create')`,
            [runId, id, compiled.yamlSha256, compiled.irSha256, workflowLiveControllerInstanceId(id)]);
        await q(`INSERT INTO SCHEMA.workflow_node_executions (node_execution_id, run_id, scope_id, node_id, ordinal, node_type, input, input_sha256, state)
                 VALUES ($1, $2, 'root', 'step', 1, 'script', 'null', $3, 'pending')`,
            ["nx-earlier", runId, sha256Hex("null")]);
        const before = (await q("SELECT version FROM SCHEMA.schema_migrations ORDER BY version")).rows.map(row => row.version);
        expect(before.at(-1)).toBe("0085");

        // The current build initializes the same schema.
        const catalog = await PgSessionCatalog.create(DATABASE_URL, schema);
        try {
            await catalog.initialize();
            const after = (await q("SELECT version FROM SCHEMA.schema_migrations ORDER BY version")).rows.map(row => row.version);
            expect(after).toEqual([...before, "0086"]);
            expect(await has()).toEqual({ fn: 1, trigger: 1 });
            const store = catalog.workflowStore();
            expect((await store.readDefinition(id)).state).toBe("published");
            expect((await store.readRun(runId)).status).toBe("running");

            // Exclusive creation now works on this schema, and never takes an existing row.
            const fresh = randomUUID();
            expect(await catalog.createWorkflowSessionV2(fresh, { parentSessionId: null, owner: null, creationConfig: { workflowV2: { requestSha256: "x" } } }))
                .toEqual({ created: true });
            expect(await catalog.createWorkflowSessionV2(id, { parentSessionId: null, owner: null, creationConfig: { workflowV2: { requestSha256: "y" } } }))
                .toEqual({ created: false });

            // Deleting the earlier session ends its earlier run through the new trigger.
            await catalog.softDeleteSession(id);
            expect((await store.readDefinition(id)).state).toBe("deleted");
            expect(await store.readRun(runId)).toMatchObject({ status: "cancelled", terminalError: { code: "cancelled" } });
            expect(await store.readNodeExecution("nx-earlier")).toMatchObject({ state: "completed", outcome: "cancelled", winner: "delete" });
        } finally { await catalog.close(); }
    });

    it("reads and runs an IR version 1 revision as stored, with the contract it was compiled with", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const store = catalog.workflowStore();
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
        registerWorkflowV2(runtime, {
            store, catalog, enabled: () => true,
            resolveToolBinding: async () => null,
            openToolExecutor: async () => { throw new Error("This workflow calls no tools."); },
            authorizeParentNotification: async () => false,
            notifyParent: async () => { throw new Error("This workflow has no parent to notify."); },
            deleteSession: async (sessionId) => catalog.softDeleteSession(sessionId),
            wakeBackstopMs: 500,
        });
        await runtime.start();
        try {
            const compiled = compileWorkflowV2(CONTRACT);
            expect(compiled.ir.irVersion).toBe(3);
            expect(compiled.ir.outputSchema).toBe("workflow.output");
            expect(compiled.ir.catchAll).toBeNull();
            const old = versionOneIr(compiled.ir);
            expect(old.outputSchema).toBeUndefined();
            expect(old.nodes.done.outputSchema).toBe("workflow.output");
            const oldIrText = canonicalJson(old);
            const oldIrSha256 = sha256Hex(oldIrText);

            // Decoding: version 1 has no root contract and no catch-all; version 2 states the contract
            // but no catch-all; version 3 must state both.
            expect(parseWorkflowIr(JSON.parse(oldIrText))).toMatchObject({ irVersion: 1, outputSchema: null, catchAll: null });
            const { catchAll: _noCatchAll, ...versionTwo } = { ...compiled.ir, irVersion: 2 };
            expect(parseWorkflowIr(versionTwo)).toMatchObject({ irVersion: 2, outputSchema: "workflow.output", catchAll: null });
            const { outputSchema: _dropped, ...withoutRoot } = compiled.ir;
            expect(() => parseWorkflowIr(withoutRoot)).toThrow("stored IR header is invalid");
            const { catchAll: _droppedCatchAll, ...withoutCatchAll } = compiled.ir;
            expect(() => parseWorkflowIr(withoutCatchAll)).toThrow("stored IR header is invalid");

            const id = randomUUID();
            const claimed = await catalog.createWorkflowSessionV2(id, { parentSessionId: null, owner: null,
                creationConfig: { workflowV2: { apiVersion: WORKFLOW_V2_API_VERSION, requestSha256: "earlier", operationId: "create" } } });
            expect(claimed.created).toBe(true);
            const stored = await store.createDefinition({
                workflowSessionId: id, parentSessionId: null, notifyParent: false, yaml: CONTRACT,
                compiled: { ...compiled, ir: old, irSha256: oldIrSha256 },
                actor: ACTOR, operationId: "create", requestSha256: "earlier", publish: true,
                start: { runId: randomUUID(), mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(id), inputsText: "{}", testAgentMode: null },
                title: "Workflow: old-contract",
            });
            await dispatchWorkflowV2Run({ catalog, store, duroxideClient: client }, stored.receipt);
            const run = await until(async () => {
                const current = await store.readRun(stored.receipt.run.runId);
                return current && current.status !== "admitted" && current.status !== "running" ? current : null;
            }, "the run to finish");
            expect(run, JSON.stringify(run)).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: { n: 3 }, irSha256: oldIrSha256 });

            // The revision is unchanged: same IR text and hash, YAML not recompiled into it.
            const { rows } = await pool.query(`SELECT ir, ir_sha256 FROM "${env.cmsSchema}".workflow_revisions WHERE workflow_session_id = $1 AND revision = 1`, [id]);
            expect(rows[0]).toEqual({ ir: oldIrText, ir_sha256: oldIrSha256 });
        } finally {
            await runtime.shutdown(100);
            await catalog.close();
        }
    });
});
