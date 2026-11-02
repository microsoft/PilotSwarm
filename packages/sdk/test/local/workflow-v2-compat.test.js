/**
 * Workflow v2 data written by an earlier build stays usable after an upgrade,
 * on real PostgreSQL and the real durable runtime:
 *
 * - A schema migrated only up to 0085 (as an earlier build recorded it) gets
 *   the exclusive-creation function and the deletion trigger from 0086, and
 *   the open KV and pause columns from 0087, when the current catalog
 *   initializes; its rows are kept (an earlier run gets an empty KV at
 *   revision 1) and the trigger acts on them.
 * - An immutable revision compiled to IR version 1 (no root outputSchema;
 *   each succeeded terminal carries the contract it was compiled with) or
 *   version 2 (no catchAll) is read and run as stored: its text and hash are
 *   not rewritten and its YAML is not recompiled.
 * - A creation claim or receipt written with an earlier create fingerprint
 *   (3a7ca2dd..547d1bf5: digest with owner and grant, version not stated;
 *   159bdce5: digest with the owner, no grant; c218d1bc..87549e10: no digest
 *   on the claim) is continued or replayed for the same request, without
 *   rewriting it, and refused for a request with another grant or owner.
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
import { canonicalJson, jsonSha256, sha256Hex } from "../../src/workflow/v2/json.ts";
import { createWorkflowV2, dispatchWorkflowV2Run } from "../../src/workflow/v2/service.ts";
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
            expect(after).toEqual([...before, "0086", "0087", "0088", "0089", "0090", "0091", "0092", "0093", "0094", "0095"]);
            expect(await has()).toEqual({ fn: 1, trigger: 1 });
            const store = catalog.workflowStore();
            expect((await store.readDefinition(id)).state).toBe("published");
            // 0087: the earlier run gets an empty open KV at revision 1 (kept as an immutable revision);
            // its earlier node execution pinned no revision.
            expect(await store.readRun(runId)).toMatchObject({ status: "running", kv: {}, kvRevision: 1, pausedFrom: null });
            expect(await store.readKv(runId, 1)).toEqual({});
            expect((await store.readNodeExecution("nx-earlier")).kvRevision).toBeNull();
            // 0089: an earlier node execution accepts no typed input, and the inbox starts empty.
            expect((await store.readNodeExecution("nx-earlier")).receive).toBeNull();
            expect((await q("SELECT count(*)::int AS n FROM SCHEMA.workflow_inbox")).rows[0].n).toBe(0);
            // 0091, 0092: the outbox starts empty; an earlier node execution sends nothing.
            expect((await q("SELECT count(*)::int AS n FROM SCHEMA.workflow_outbox")).rows[0].n).toBe(0);
            // 0093: the request tables start empty; an earlier node execution requests nothing.
            for (const table of ["workflow_requests", "workflow_request_responses", "workflow_request_operations", "workflow_response_wakes"]) {
                expect((await q(`SELECT count(*)::int AS n FROM SCHEMA.${table}`)).rows[0].n, table).toBe(0);
            }
            // 0094, 0095: the intake tables and the exposure record start empty.
            for (const table of ["workflow_intake", "workflow_intake_invocations", "workflow_intake_exposures"]) {
                expect((await q(`SELECT count(*)::int AS n FROM SCHEMA.${table}`)).rows[0].n, table).toBe(0);
            }

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
                start: { runId: randomUUID(), mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(id), inputsText: "{}", kvText: "{}", testAgentMode: null },
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

    it("continues and replays creation records of earlier fingerprints without rewriting them, and refuses another grant or owner", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const store = catalog.workflowStore();
        const OWNER = { provider: "test", subject: "compat-owner" };
        const OTHER = { provider: "test", subject: "someone-else" };
        const grant = (tools) => ({
            policy: "node-parent-tools-v1", parentSessionId: "", owner: OWNER, config: {}, capabilities: { selections: [] },
            tools: tools.map(name => ({ name, schemaHash: `${name}-schema` })), sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "fp",
        });
        const DRAFT = CONTRACT.replace("old-contract", "compat-draft");
        const compiled = compileWorkflowV2(DRAFT);
        // The create digests exactly as those builds computed them (a draft: no publish, no start, notify on).
        const content = (parentSessionId) => ({ kind: "create", yamlSha256: compiled.yamlSha256, publish: false, start: null, parentSessionId, notifyParent: true });
        const v1 = (parentSessionId) => jsonSha256(content(parentSessionId));
        const v2 = (parentSessionId, owner) => jsonSha256({ ...content(parentSessionId), owner: { provider: owner.provider, subject: owner.subject } });
        // 3a7ca2dd..547d1bf5 (service.ts, createWorkflowV2): owner and grant digest, marker without a version.
        const v3 = (parentSessionId, owner, binding) => jsonSha256({ ...content(parentSessionId), owner: { provider: owner.provider, subject: owner.subject },
            binding: binding ? jsonSha256(JSON.parse(JSON.stringify(binding))) : null });
        const host = { catalog, store, duroxideClient: { startOrchestrationVersioned: async () => { throw new Error("A draft is never dispatched."); } } };
        const create = (id, parentSessionId, owner, binding) => createWorkflowV2(host, {
            workflowSessionId: id, parentSessionId, owner, yaml: DRAFT, actor: ACTOR, operationId: "create", ...(binding ? { binding } : {}),
        });
        const receiptRow = async (id) => (await pool.query(
            `SELECT request_sha256, receipt FROM "${env.cmsSchema}".workflow_operations WHERE workflow_session_id = $1 AND operation_id = 'create'`, [id])).rows[0] ?? null;
        try {
            const parentId = randomUUID();
            await catalog.createSession(parentId, { owner: OWNER });
            const g1 = { ...grant(["read_facts"]), parentSessionId: parentId };
            const g2 = { ...grant(["read_facts", "store_fact"]), parentSessionId: parentId };

            // 159bdce5: a claim with the version 2 digest and a first grant, interrupted before its definition.
            const interrupted = randomUUID();
            const marker159 = { apiVersion: WORKFLOW_V2_API_VERSION, requestSha256: v2(parentId, OWNER), operationId: "create" };
            expect(await catalog.createWorkflowSessionV2(interrupted, { parentSessionId: parentId, owner: OWNER,
                creationConfig: { workflowV2: marker159, workflowToolBinding: g1 } })).toEqual({ created: true });
            await expect(create(interrupted, parentId, OWNER, g2)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await store.readDefinition(interrupted)).toBeNull();
            const continued = await create(interrupted, parentId, OWNER, g1);
            expect(continued.replayed).toBe(false);
            expect(continued.receipt).toMatchObject({ state: "draft", revision: 1 });
            const replayed = await create(interrupted, parentId, OWNER, g1);
            expect(replayed).toEqual({ receipt: continued.receipt, replayed: true });
            const kept = await catalog.getSessionCreationConfig(interrupted);
            expect(kept.workflowV2).toEqual(marker159);
            expect(kept.workflowToolBinding).toEqual(g1);

            // 159bdce5: a draft whose receipt carries the version 2 digest.
            const draft159 = randomUUID();
            await catalog.createWorkflowSessionV2(draft159, { parentSessionId: parentId, owner: OWNER, creationConfig: { workflowV2: marker159 } });
            const stored159 = await store.createDefinition({ workflowSessionId: draft159, parentSessionId: parentId, notifyParent: true, yaml: DRAFT,
                compiled, actor: ACTOR, operationId: "create", requestSha256: v2(parentId, OWNER), publish: false, start: null, title: "Workflow: compat-draft" });
            const before159 = await receiptRow(draft159);
            expect(before159.request_sha256).toBe(v2(parentId, OWNER));
            expect(await create(draft159, parentId, OWNER, null)).toEqual({ receipt: stored159.receipt, replayed: true });
            await expect(create(draft159, parentId, OWNER, g1)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await receiptRow(draft159)).toEqual(before159);
            expect((await catalog.getSessionCreationConfig(draft159)).workflowV2).toEqual(marker159);

            // c218d1bc..87549e10: a claim with no digest (catalog creation) and a receipt with the version 1 digest.
            const draft875 = randomUUID();
            await catalog.createSession(draft875, { sessionKind: "workflow", parentSessionId: parentId, owner: OWNER,
                creationConfig: { workflowV2: { apiVersion: WORKFLOW_V2_API_VERSION } } });
            const stored875 = await store.createDefinition({ workflowSessionId: draft875, parentSessionId: parentId, notifyParent: true, yaml: DRAFT,
                compiled, actor: ACTOR, operationId: "create", requestSha256: v1(parentId), publish: false, start: null, title: "Workflow: compat-draft" });
            const before875 = await receiptRow(draft875);
            expect(await create(draft875, parentId, OWNER, null)).toEqual({ receipt: stored875.receipt, replayed: true });
            await expect(create(draft875, parentId, OTHER, null)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            await expect(create(draft875, parentId, OWNER, g1)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await receiptRow(draft875)).toEqual(before875);

            // 3a7ca2dd..547d1bf5: an interrupted claim and a complete draft whose marker holds the
            // version 3 digest without stating it.
            const interrupted547 = randomUUID();
            const marker547 = { apiVersion: WORKFLOW_V2_API_VERSION, requestSha256: v3(parentId, OWNER, g1), operationId: "create" };
            expect(await catalog.createWorkflowSessionV2(interrupted547, { parentSessionId: parentId, owner: OWNER,
                creationConfig: { workflowV2: marker547, workflowToolBinding: g1 } })).toEqual({ created: true });
            await expect(create(interrupted547, parentId, OWNER, g2)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            await expect(create(interrupted547, parentId, OTHER, g1)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await store.readDefinition(interrupted547)).toBeNull();
            const continued547 = await create(interrupted547, parentId, OWNER, g1);
            expect(continued547.replayed).toBe(false);
            expect(await create(interrupted547, parentId, OWNER, g1)).toEqual({ receipt: continued547.receipt, replayed: true });
            expect((await catalog.getSessionCreationConfig(interrupted547)).workflowV2).toEqual(marker547);

            const draft547 = randomUUID();
            await catalog.createWorkflowSessionV2(draft547, { parentSessionId: parentId, owner: OWNER,
                creationConfig: { workflowV2: { ...marker547 }, workflowToolBinding: g1 } });
            const stored547 = await store.createDefinition({ workflowSessionId: draft547, parentSessionId: parentId, notifyParent: true, yaml: DRAFT,
                compiled, actor: ACTOR, operationId: "create", requestSha256: v3(parentId, OWNER, g1), publish: false, start: null, title: "Workflow: compat-draft" });
            const before547 = await receiptRow(draft547);
            expect(before547.request_sha256).toBe(v3(parentId, OWNER, g1));
            expect(await create(draft547, parentId, OWNER, g1)).toEqual({ receipt: stored547.receipt, replayed: true });
            await expect(create(draft547, parentId, OWNER, g2)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            await expect(create(draft547, parentId, OWNER, null)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect(await receiptRow(draft547)).toEqual(before547);
            expect((await catalog.getSessionCreationConfig(draft547)).workflowV2).toEqual(marker547);

            // The current fingerprint: the marker states its version, and a changed grant is another request.
            const current = randomUUID();
            await create(current, parentId, OWNER, g1);
            expect((await catalog.getSessionCreationConfig(current)).workflowV2).toMatchObject({ fingerprint: 3, operationId: "create" });
            await expect(create(current, parentId, OWNER, g2)).rejects.toMatchObject({ code: "WORKFLOW_EXISTS" });
            expect((await create(current, parentId, OWNER, g1)).replayed).toBe(true);
        } finally { await catalog.close(); }
    });
});
