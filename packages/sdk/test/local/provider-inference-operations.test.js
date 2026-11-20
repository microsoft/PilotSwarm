/**
 * provider_inference_operations: the small generic token ledger beside the chat ledger (Workflow decision node design
 * v11, "Budget and generic inference accounting").
 *
 * - The migration is registered once, after 0095 (the latest migration at the pinned base).
 * - An upgrade leaves the chat ledger (provider_usage_ledger: columns, key, indexes and rows) unchanged, a rerun changes
 *   nothing, and a fresh install has the same catalog as the upgraded database.
 * - The table has exactly the v11 columns and the key (operation_id, attempt): no hashes, raw usage, HTTP or error
 *   fields, non-token units or capability JSON.
 * - ProviderStore claims a row before a provider call and settles its usage once after it. tokens_total is
 *   input + output (the cache counts are not added) and NULL when the usage is unknown. Each attempt is its own row.
 * - The usage totals add settled inference tokens; turn and session counts stay the chat ledger's.
 *
 * Run: npx vitest run test/local/provider-inference-operations.test.js
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { schemaSnapshot, snapshotDifferences } from "../helpers/schema-snapshot.js";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runCmsMigrations } from "../../src/cms-migrator.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { ProviderStore } from "../../src/provider-store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const CMS_LOCK_SEED = 0x63_6d_73;
const TABLE = "provider_inference_operations";
const CHAT_LEDGER = "provider_usage_ledger";
const WORKFLOW_INDEX = "provider_inference_operations_by_workflow_node_attempt";
const SETTLED_INDEX = "provider_inference_operations_settled";
const LATEST_AT_PIN = "0095";
const PROVIDER = "pio-provider";
const MODEL = "pio-provider:decision-1";
const tag = () => randomUUID().replaceAll("-", "").slice(0, 12);
const registered = (schema) => CMS_MIGRATIONS(schema).find((entry) => entry.name === TABLE);

/** Apply one migration entry again, the way the migrator applies it. */
async function rerun(query, entry) {
    if (entry.steps) {
        for (const step of entry.steps) await query(step);
    } else {
        await query(`BEGIN; ${entry.sql} COMMIT;`);
    }
}

/** The snapshot entries of the chat ledger table: its relation, columns, constraints, indexes and rows. */
const chatLedger = (snapshot) => Object.fromEntries(Object.entries(snapshot).map(([key, items]) => [key,
    items.filter((item) => [item.relname, item.owner, item.table, item.owned_by_table, item.object].includes(CHAT_LEDGER))]));

describe("provider_inference_operations migration", () => {
    it("is registered once, after the latest migration at the pinned base", () => {
        const migrations = CMS_MIGRATIONS("registry_check");
        const versions = migrations.map((entry) => entry.version);
        const entries = migrations.filter((entry) => entry.name === TABLE);
        expect(entries).toHaveLength(1);
        expect(versions).toContain(LATEST_AT_PIN);
        expect(entries[0].version > LATEST_AT_PIN, `${entries[0].version} sorts after ${LATEST_AT_PIN}`).toBe(true);
        expect(migrations.indexOf(entries[0])).toBeGreaterThan(versions.indexOf(LATEST_AT_PIN));
    });

    it("upgrades without touching the chat ledger, reruns as a no-op and matches a fresh install", { timeout: TIMEOUT }, async () => {
        const entry = registered("registry_check");
        expect(entry, `${TABLE} is a registered migration`).toBeDefined();
        const pool = new pg.Pool({ connectionString: getEnv().store, max: 1 });
        const id = tag();
        const upgraded = `pio_${id}_u`, fresh = `pio_${id}_f`;
        const query = (sql, params) => pool.query(sql, params);
        const through = (schema) => CMS_MIGRATIONS(schema).filter((item) => item.version <= entry.version);
        try {
            await runMigrations(pool, upgraded, CMS_MIGRATIONS(upgraded).filter((item) => item.version < entry.version), CMS_LOCK_SEED);
            await query(`SELECT "${upgraded}".cms_provider_settle_turn('chat-before', 0, 'team', 'team:gpt', NULL, 'user', NULL, 100, 20, 30, 0)`);
            const before = await schemaSnapshot(query, upgraded);
            expect(chatLedger(before).constraints.map((item) => item.definition)).toContain("PRIMARY KEY (session_id, turn_index)");
            expect(chatLedger(before).data).toEqual([{ table: CHAT_LEDGER, rows: 1, digest: expect.any(String) }]);

            await runMigrations(pool, upgraded, through(upgraded), CMS_LOCK_SEED);
            const after = await schemaSnapshot(query, upgraded);
            expect(after.relations.filter((item) => item.relname === TABLE).map((item) => item.relkind)).toEqual(["r"]);
            expect(chatLedger(after)).toEqual(chatLedger(before));
            await rerun(query, registered(upgraded));
            expect(snapshotDifferences(after, await schemaSnapshot(query, upgraded))).toEqual({});

            await runMigrations(pool, fresh, through(fresh), CMS_LOCK_SEED);
            const installed = await schemaSnapshot(query, fresh);
            await rerun(query, registered(fresh));
            expect(snapshotDifferences(installed, await schemaSnapshot(query, fresh))).toEqual({});
            const catalog = ({ data, ...rest }) => rest;
            expect(snapshotDifferences(catalog(after), catalog(installed))).toEqual({});
        } finally {
            await query("ROLLBACK").catch(() => {});
            await query(`DROP SCHEMA IF EXISTS "${upgraded}" CASCADE`);
            await query(`DROP SCHEMA IF EXISTS "${fresh}" CASCADE`);
            await pool.end();
        }
    });
});

describe("provider_inference_operations ledger", () => {
    let pool;
    let schema;
    let store;

    beforeAll(async () => {
        pool = new pg.Pool({ connectionString: getEnv().store, max: 2 });
        schema = `pio_${tag()}_l`;
        await runCmsMigrations(pool, schema);
        store = new ProviderStore(pool, schema);
    }, TIMEOUT);

    afterAll(async () => {
        if (!pool) return;
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
    });

    const operation = (fields) => ({
        capability: "generic", purpose: "generic-inference", providerName: PROVIDER, modelQualified: MODEL,
        chargeClass: "user", ...fields,
    });
    const decisionOperation = (fields) => operation({ ...fields, capability: "decision", purpose: "workflow-decision" });
    const read = async (operationId, attempt) => (await pool.query(
        `SELECT * FROM "${schema}".${TABLE} WHERE operation_id = $1 AND attempt = $2`, [operationId, attempt])).rows[0];

    it("has the identity-extended columns and the (operation_id, attempt) key", async () => {
        const { rows } = await pool.query(
            `SELECT column_name, data_type, is_nullable FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = $2`, [schema, TABLE]);
        expect(Object.fromEntries(rows.map((row) => [row.column_name, row.data_type]))).toEqual({
            operation_id: "text", attempt: "integer",
            capability: "text", purpose: "text",
            session_id: "text", workflow_run_id: "text", node_execution_id: "text",
            provider_name: "text", model_qualified: "text",
            provider_instance_id: "uuid", provider_type_id: "text", provider_class: "text",
            provider_owner_user_id: "bigint",
            owner_user_id: "bigint", charge_class: "text", agent_id: "text",
            tokens_input: "bigint", tokens_output: "bigint", tokens_cache_read: "bigint", tokens_cache_write: "bigint",
            tokens_total: "bigint",
            created_at: "timestamp with time zone", settled_at: "timestamp with time zone",
        });
        // Still excluded: request/response hashes, raw provider usage, HTTP and error fields, non-token units, capability JSON.
        expect(rows.filter((row) => /hash|sha|raw|http|status|error|unit|json|request|response/
            .test(`${row.column_name} ${row.data_type}`))).toEqual([]);
        expect(rows.filter((row) => row.is_nullable === "YES").map((row) => row.column_name))
            .toEqual(expect.arrayContaining(["session_id", "workflow_run_id", "node_execution_id", "tokens_total", "settled_at"]));
        const key = await pool.query(
            `SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
              WHERE c.conrelid = format('%I.%I', $1::text, $2::text)::regclass AND c.contype = 'p'`, [schema, TABLE]);
        expect(key.rows.map((row) => row.definition)).toEqual(["PRIMARY KEY (operation_id, attempt)"]);
    });

    it("has planner-ready indexes for Workflow lookups and settled reporting", async () => {
        const { rows } = await pool.query(
            `SELECT idx.relname AS index_name, i.indisvalid AS valid, i.indisready AS ready,
                    i.indnkeyatts::INTEGER AS key_count,
                    pg_get_expr(i.indpred, i.indrelid) AS predicate,
                    array_agg(a.attname ORDER BY keys.ordinality)::TEXT[] AS key_columns
               FROM pg_index i
               JOIN pg_class idx ON idx.oid = i.indexrelid
               JOIN pg_class tbl ON tbl.oid = i.indrelid
               JOIN pg_namespace n ON n.oid = tbl.relnamespace
               CROSS JOIN LATERAL unnest(i.indkey::SMALLINT[]) WITH ORDINALITY AS keys(attnum, ordinality)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = keys.attnum
              WHERE n.nspname = $1 AND tbl.relname = $2
                AND idx.relname = ANY($3::TEXT[]) AND keys.ordinality <= i.indnkeyatts
              GROUP BY idx.relname, i.indisvalid, i.indisready, i.indnkeyatts,
                       pg_get_expr(i.indpred, i.indrelid)
              ORDER BY idx.relname`, [schema, TABLE, [WORKFLOW_INDEX, SETTLED_INDEX]]);
        expect(rows).toEqual([
            {
                index_name: WORKFLOW_INDEX, valid: true, ready: true, key_count: 3, predicate: null,
                key_columns: ["workflow_run_id", "node_execution_id", "attempt"],
            },
            {
                index_name: SETTLED_INDEX, valid: true, ready: true, key_count: 1,
                predicate: "(settled_at IS NOT NULL)", key_columns: ["settled_at"],
            },
        ]);
    });

    it("a duplicate claim leaves one row, the first claim's", async () => {
        const subject = `pio-owner-${tag()}`;
        const owner = Number((await pool.query(
            `INSERT INTO "${schema}".users (provider, subject, email, display_name)
             VALUES ('test-idp', $1, $1 || '@example.test', $1) RETURNING user_id`, [subject])).rows[0].user_id);
        const operationId = `op-${tag()}`;
        const first = operation({
            operationId, attempt: 1, sessionId: "session-1", workflowRunId: "run-1", nodeExecutionId: "node-1",
            ownerUserId: owner, agentId: "agent-1",
        });
        expect(await store.claimInferenceOperation(first)).toBe(true);
        expect(await store.claimInferenceOperation({ ...first, purpose: "replayed", agentId: "agent-2" })).toBe(false);
        const { rows } = await pool.query(`SELECT * FROM "${schema}".${TABLE} WHERE operation_id = $1`, [operationId]);
        expect(rows).toHaveLength(1);
        expect({ ...rows[0], owner_user_id: Number(rows[0].owner_user_id) }).toMatchObject({
            attempt: 1, capability: "generic", purpose: "generic-inference",
            session_id: "session-1", workflow_run_id: "run-1", node_execution_id: "node-1",
            provider_name: PROVIDER, model_qualified: MODEL,
            owner_user_id: owner, charge_class: "user", agent_id: "agent-1",
            tokens_total: null, settled_at: null,
        });
    });

    it("settles once; a second settle changes nothing", async () => {
        const operationId = `op-${tag()}`;
        await store.claimInferenceOperation(operation({ operationId, attempt: 1 }));
        expect(await store.settleInferenceOperation({ operationId, attempt: 1, tokensInput: 10, tokensOutput: 5 })).toBe(true);
        const settled = await read(operationId, 1);
        expect(settled.settled_at).toBeInstanceOf(Date);
        expect(await store.settleInferenceOperation({
            operationId, attempt: 1, tokensInput: 99, tokensOutput: 99, tokensCacheRead: 9, tokensCacheWrite: 9,
        })).toBe(false);
        expect(await read(operationId, 1)).toEqual(settled);
    });

    it("tokens_total is input + output; the cache counts are kept but not added", async () => {
        const operationId = `op-${tag()}`;
        await store.claimInferenceOperation(operation({ operationId, attempt: 1 }));
        await store.settleInferenceOperation({
            operationId, attempt: 1, tokensInput: 10, tokensOutput: 5, tokensCacheRead: 4, tokensCacheWrite: 2,
        });
        const settled = await read(operationId, 1);
        expect([settled.tokens_input, settled.tokens_output, settled.tokens_cache_read, settled.tokens_cache_write,
            settled.tokens_total].map(Number)).toEqual([10, 5, 4, 2, 15]);
    });

    it("unknown usage settles with tokens_total NULL", async () => {
        const operationId = `op-${tag()}`;
        await store.claimInferenceOperation(operation({ operationId, attempt: 1 }));
        expect(await store.settleInferenceOperation({ operationId, attempt: 1 })).toBe(true);
        const settled = await read(operationId, 1);
        expect(settled.tokens_total).toBeNull();
        expect(settled.settled_at).toBeInstanceOf(Date);
    });

    it("the first settlement moves all current provider and owner meters and the next checkTurn sees a low model rule", async () => {
        const providerName = `pio-meter-${tag()}`;
        const modelQualified = `${providerName}:decision-1`;
        const sessionId = `pio-session-${tag()}`;
        const operationId = `op-${tag()}`;
        const subject = `pio-meter-owner-${tag()}`;
        const owner = Number((await pool.query(
            `INSERT INTO "${schema}".users (provider, subject, email, display_name)
             VALUES ('test-idp', $1, $1 || '@example.test', $1) RETURNING user_id`, [subject])).rows[0].user_id);
        await pool.query(
            `SELECT * FROM "${schema}".cms_provider_create($1,$2,'shared',NULL,$3,NULL,NULL,TRUE)`,
            [providerName, "azure", JSON.stringify({ apiKey: "k" })]);
        await pool.query(
            `INSERT INTO "${schema}".sessions (session_id, model, is_system, state) VALUES ($1,$2,FALSE,'idle')`,
            [sessionId, modelQualified]);
        await pool.query(`INSERT INTO "${schema}".session_owners (session_id, user_id) VALUES ($1,$2)`, [sessionId, owner]);

        expect(await store.claimInferenceOperation(operation({
            operationId, attempt: 1, sessionId, providerName, modelQualified, ownerUserId: owner,
        }))).toBe(true);
        expect(await store.settleInferenceOperation({ operationId, attempt: 1, tokensInput: 10, tokensOutput: 5 })).toBe(true);

        const providerMeters = async () => (await pool.query(
            `SELECT period, scope, used_tokens FROM "${schema}".provider_meters
              WHERE provider_name = $1 ORDER BY period, scope`, [providerName])).rows
            .map(row => [row.period, row.scope, Number(row.used_tokens)]);
        const ownerMeters = async () => (await pool.query(
            `SELECT period, scope, user_id, used_tokens FROM "${schema}".provider_meters_user
              WHERE provider_name = $1 AND user_id = $2 ORDER BY period, scope`, [providerName, owner])).rows
            .map(row => [row.period, row.scope, Number(row.user_id), Number(row.used_tokens)]);
        const expectedMeters = ["day", "month", "week"].flatMap(period => [
            [period, "*", 15], [period, modelQualified, 15],
        ]);
        expect(await providerMeters()).toEqual(expectedMeters);
        expect(await ownerMeters()).toEqual(expectedMeters.map(([period, scope, tokens]) => [period, scope, owner, tokens]));

        const providerBeforeReplay = await providerMeters();
        const ownerBeforeReplay = await ownerMeters();
        expect(await store.settleInferenceOperation({ operationId, attempt: 1, tokensInput: 90, tokensOutput: 9 })).toBe(false);
        expect(await providerMeters()).toEqual(providerBeforeReplay);
        expect(await ownerMeters()).toEqual(ownerBeforeReplay);

        await pool.query(
            `SELECT * FROM "${schema}".cms_provider_set_limit($1,'day',$2,10,$3,NULL,TRUE)`,
            [providerName, modelQualified, `rule-${tag()}`]);
        const admission = (await pool.query(
            `SELECT * FROM "${schema}".cms_provider_check_turn($1,$2)`, [sessionId, modelQualified])).rows[0];
        expect(admission).toMatchObject({
            verdict: "paused", provider_name: providerName, model_qualified: modelQualified,
            pause: expect.objectContaining({ kind: "limit", modelQualified }),
        });
    });

    it("Decision admission uses the pinned shared incarnation without mutating chat session state", async () => {
        const providerName = `pio-decision-gate-${tag()}`;
        const modelQualified = `${providerName}:decision-1`;
        const sessionId = `decision-gate-${tag()}`;
        const owner = Number((await pool.query(
            `INSERT INTO "${schema}".users (provider, subject, email, display_name)
             VALUES ('test-idp', $1, $1 || '@example.test', $1) RETURNING user_id`, [`pio-gate-${tag()}`])).rows[0].user_id);
        await pool.query(`SELECT * FROM "${schema}".cms_provider_create($1,'azure','shared',NULL,$2,NULL,NULL,TRUE)`,
            [providerName, JSON.stringify({ apiKey: "shared-key" })]);
        const sharedId = (await pool.query(
            `SELECT provider_instance_id::text AS id FROM "${schema}".provider_instances WHERE name = $1`, [providerName])).rows[0].id;
        const pause = { kind: "hold", provider: "chat-provider" };
        await pool.query(
            `INSERT INTO "${schema}".sessions (session_id, model, is_system, state, pause_state)
             VALUES ($1,'chat-provider:chat-model',FALSE,'idle',$2::jsonb)`, [sessionId, JSON.stringify(pause)]);
        await pool.query(`INSERT INTO "${schema}".session_owners (session_id, user_id) VALUES ($1,$2)`, [sessionId, owner]);

        const admitted = await store.checkDecision(sessionId, modelQualified, sharedId);
        expect(admitted).toMatchObject({
            verdict: "clear", providerName, providerInstanceId: sharedId,
            providerClass: "shared", ownerUserId: owner, modelQualified,
        });
        expect(admitted.providerUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        const projected = (await pool.query(`SELECT model, pause_state FROM "${schema}".sessions WHERE session_id = $1`,
            [sessionId])).rows[0];
        expect(projected).toMatchObject({ model: "chat-provider:chat-model", pause_state: pause });
        const unbound = await store.checkDecision(sessionId, modelQualified, null);
        expect(unbound).toMatchObject({ verdict: "no_provider", providerInstanceId: null });

        await pool.query(`DELETE FROM "${schema}".provider_instances WHERE name = $1`, [providerName]);
        await pool.query(`SELECT * FROM "${schema}".cms_provider_create($1,'azure','personal',$2,$3,NULL,$2,TRUE)`,
            [providerName, owner, JSON.stringify({ apiKey: "personal-key" })]);
        const rejected = await store.checkDecision(sessionId, modelQualified, sharedId);
        expect(rejected.verdict).toBe("no_provider");
        expect(rejected.providerInstanceId).toBeNull();
        const after = (await pool.query(`SELECT model, pause_state FROM "${schema}".sessions WHERE session_id = $1`,
            [sessionId])).rows[0];
        expect(after).toMatchObject({ model: "chat-provider:chat-model", pause_state: pause });
    });

    it("both claim signatures refuse unbound Decision; the 12-argument generic claim still works", async () => {
        const providerName = `pio-unbound-${tag()}`;
        const modelQualified = `${providerName}:decision-1`;
        await pool.query(`SELECT * FROM "${schema}".cms_provider_create($1,'azure','shared',NULL,$2,NULL,NULL,TRUE)`,
            [providerName, JSON.stringify({ apiKey: "shared-key" })]);
        const operationId = `op-legacy-${tag()}`;
        const args = [operationId, 1, "decision", "workflow-decision", "session-legacy", "run-legacy",
            "node-legacy", providerName, modelQualified, null, "user", null];
        const placeholders = args.map((_, index) => `$${index + 1}`).join(",");
        const legacy = await pool.query(
            `SELECT "${schema}".cms_provider_claim_inference_operation(${placeholders}) AS claimed`, args);
        expect(legacy.rows[0].claimed).toBe(false);
        expect(await read(operationId, 1)).toBeUndefined();

        const unboundId = `op-unbound-${tag()}`;
        expect(await store.claimInferenceOperation(decisionOperation({
            operationId: unboundId, attempt: 1, providerName, modelQualified, providerInstanceId: null,
        }))).toBe(false);
        expect(await read(unboundId, 1)).toBeUndefined();

        const genericId = `op-generic-legacy-${tag()}`;
        const generic = [genericId, 1, "generic", "generic-inference", null, null, null,
            "missing-generic-provider", "missing-generic-provider:model", null, "user", null];
        const genericPlaceholders = generic.map((_, index) => `$${index + 1}`).join(",");
        const kept = await pool.query(
            `SELECT "${schema}".cms_provider_claim_inference_operation(${genericPlaceholders}) AS claimed`, generic);
        expect(kept.rows[0].claimed).toBe(true);
        expect(await read(genericId, 1)).toBeDefined();
    });

    it("a pinned Decision claim refuses a rotated credential version and accepts the current one", async () => {
        const providerName = `pio-rotate-${tag()}`;
        const modelQualified = `${providerName}:decision-1`;
        await pool.query(`SELECT * FROM "${schema}".cms_provider_create($1,'azure','shared',NULL,$2,NULL,NULL,TRUE)`,
            [providerName, JSON.stringify({ apiKey: "old-key" })]);
        const current = (await pool.query(
            `SELECT provider_instance_id::text AS id, to_jsonb(provider_instances)->>'updated_at' AS updated_at
               FROM "${schema}".provider_instances WHERE name = $1`, [providerName])).rows[0];
        const operationId = `op-rotate-${tag()}`;
        const rotated = (await pool.query(
            `UPDATE "${schema}".provider_instances SET secret_ref = $2::jsonb, updated_at = updated_at + interval '1 second'
              WHERE name = $1 RETURNING to_jsonb(provider_instances)->>'updated_at' AS updated_at`,
            [providerName, JSON.stringify({ apiKey: "new-key" })])).rows[0].updated_at;
        expect(rotated).not.toEqual(current.updated_at);
        expect(await store.claimInferenceOperation(decisionOperation({
            operationId, attempt: 1, providerName, modelQualified,
            providerInstanceId: current.id, providerUpdatedAt: current.updated_at,
        }))).toBe(false);
        expect(await read(operationId, 1)).toBeUndefined();
        expect(await store.claimInferenceOperation(decisionOperation({
            operationId, attempt: 1, providerName, modelQualified,
            providerInstanceId: current.id, providerUpdatedAt: rotated,
        }))).toBe(true);
        expect(await read(operationId, 1)).toMatchObject({ capability: "decision", provider_instance_id: current.id });
    });

    it("Decision settlement never charges a same-name provider that replaced the claimed incarnation", async () => {
        const providerName = `pio-replace-${tag()}`;
        const modelQualified = `${providerName}:decision-1`;
        const owner = Number((await pool.query(
            `INSERT INTO "${schema}".users (provider, subject, email, display_name)
             VALUES ('test-idp', $1, $1 || '@example.test', $1) RETURNING user_id`, [`pio-replace-${tag()}`])).rows[0].user_id);
        await pool.query(`SELECT * FROM "${schema}".cms_provider_create($1,'azure','shared',NULL,$2,NULL,NULL,TRUE)`,
            [providerName, JSON.stringify({ apiKey: "old-key" })]);
        const old = (await pool.query(
            `SELECT provider_instance_id::text AS id, to_jsonb(provider_instances)->>'updated_at' AS updated_at
               FROM "${schema}".provider_instances WHERE name = $1`, [providerName])).rows[0];
        const operationId = `op-replaced-${tag()}`;
        expect(await store.claimInferenceOperation(decisionOperation({
            operationId, attempt: 1, providerName, modelQualified, providerInstanceId: old.id,
            providerUpdatedAt: old.updated_at, ownerUserId: owner,
        }))).toBe(true);
        const claimed = await read(operationId, 1);
        expect(claimed).toMatchObject({ capability: "decision", provider_instance_id: old.id });
        await pool.query(`DELETE FROM "${schema}".provider_instances WHERE name = $1`, [providerName]);
        await pool.query(`SELECT * FROM "${schema}".cms_provider_create($1,'azure','shared',NULL,$2,NULL,NULL,TRUE)`,
            [providerName, JSON.stringify({ apiKey: "new-key" })]);
        const newId = (await pool.query(
            `SELECT provider_instance_id::text AS id FROM "${schema}".provider_instances WHERE name = $1`, [providerName])).rows[0].id;
        expect(newId).not.toBe(old.id);

        expect(await store.settleInferenceOperation({ operationId, attempt: 1, tokensInput: 20, tokensOutput: 4 })).toBe(true);
        expect(await read(operationId, 1)).toMatchObject({
            provider_instance_id: old.id, tokens_input: "20", tokens_output: "4", tokens_total: "24",
        });
        expect(Number((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".provider_meters WHERE provider_name = $1`,
            [providerName])).rows[0].count)).toBe(0);
        expect(Number((await pool.query(`SELECT count(*)::int AS count FROM "${schema}".provider_meters_user WHERE provider_name = $1`,
            [providerName])).rows[0].count)).toBe(0);
    });

    it("unknown, system, unattributed, missing-provider and zero-total settlements never move meters", async () => {
        const providerName = `pio-skip-${tag()}`;
        const modelQualified = `${providerName}:decision-1`;
        const subject = `pio-skip-owner-${tag()}`;
        const owner = Number((await pool.query(
            `INSERT INTO "${schema}".users (provider, subject, email, display_name)
             VALUES ('test-idp', $1, $1 || '@example.test', $1) RETURNING user_id`, [subject])).rows[0].user_id);
        await pool.query(
            `SELECT * FROM "${schema}".cms_provider_create($1,$2,'shared',NULL,$3,NULL,NULL,TRUE)`,
            [providerName, "azure", JSON.stringify({ apiKey: "k" })]);
        const missingProvider = `pio-missing-${tag()}`;
        const cases = [
            ["unknown", { providerName, modelQualified, ownerUserId: owner, chargeClass: "user" }, {}, null],
            ["system", { providerName, modelQualified, ownerUserId: owner, chargeClass: "system" }, { tokensInput: 4, tokensOutput: 6 }, 10],
            ["unattributed", { providerName, modelQualified, ownerUserId: owner, chargeClass: "unattributed" }, { tokensInput: 3, tokensOutput: 7 }, 10],
            ["missing-provider", { providerName: missingProvider, modelQualified: `${missingProvider}:decision-1`, ownerUserId: owner, chargeClass: "user" }, { tokensInput: 2, tokensOutput: 8 }, 10],
            ["zero", { providerName, modelQualified, ownerUserId: owner, chargeClass: "user" }, { tokensInput: 0, tokensOutput: 0 }, 0],
        ];
        for (const [name, fields, usage, total] of cases) {
            const operationId = `op-${name}-${tag()}`;
            expect(await store.claimInferenceOperation(operation({ operationId, attempt: 1, ...fields }))).toBe(true);
            expect(await store.settleInferenceOperation({ operationId, attempt: 1, ...usage })).toBe(true);
            const settled = await read(operationId, 1);
            expect(settled.tokens_total === null ? null : Number(settled.tokens_total)).toBe(total);
            expect(settled.settled_at).toBeInstanceOf(Date);
        }
        expect((await pool.query(
            `SELECT count(*) AS n FROM "${schema}".provider_meters WHERE provider_name = ANY($1::text[])`,
            [[providerName, missingProvider]])).rows[0].n).toBe("0");
        expect((await pool.query(
            `SELECT count(*) AS n FROM "${schema}".provider_meters_user
              WHERE provider_name = ANY($1::text[]) AND user_id = $2`,
            [[providerName, missingProvider], owner])).rows[0].n).toBe("0");
    });

    it("each attempt is its own row with its own usage", async () => {
        const operationId = `op-${tag()}`;
        expect(await store.claimInferenceOperation(operation({ operationId, attempt: 1 }))).toBe(true);
        expect(await store.claimInferenceOperation(operation({ operationId, attempt: 2 }))).toBe(true);
        await store.settleInferenceOperation({ operationId, attempt: 1, tokensInput: 10, tokensOutput: 5 });
        await store.settleInferenceOperation({ operationId, attempt: 2, tokensInput: 20, tokensOutput: 7 });
        const { rows } = await pool.query(
            `SELECT attempt, tokens_total FROM "${schema}".${TABLE} WHERE operation_id = $1 ORDER BY attempt`, [operationId]);
        expect(rows.map((row) => [row.attempt, Number(row.tokens_total)])).toEqual([[1, 15], [2, 27]]);
    });

    it("usage totals, daily usage and model breakdown add settled inference tokens without extra turns", async () => {
        const providerName = `pio-${tag()}`;
        const modelQualified = `${providerName}:decision-1`;
        const filters = { provider: providerName, model: modelQualified };
        const totals = () => store.usageTotals(null, true, filters);
        const daily = () => store.usageDaily(null, true, filters);
        const breakdown = () => store.usageBreakdown(null, true, "model", filters);
        await store.settleTurn({
            sessionId: `chat-${providerName}`, turnIndex: 0, providerName, modelQualified, ownerUserId: null,
            chargeClass: "user", tokensInput: 100, tokensOutput: 20, tokensCacheRead: 30,
        });
        const before = await totals();
        expect(before).toMatchObject({ tokensTotal: 120, turns: 1, sessions: 1 });
        const beforeDaily = await daily();
        expect(beforeDaily).toHaveLength(1);
        const beforeModel = await breakdown();
        expect(beforeModel).toEqual([expect.objectContaining({ key: modelQualified, tokensTotal: 120, turns: 1 })]);

        const [settled, unknown, otherModel] = [`op-${tag()}`, `op-${tag()}`, `op-${tag()}`];
        const attributed = { providerName, modelQualified, sessionId: `decision-${providerName}`, attempt: 1 };
        await store.claimInferenceOperation(operation({ ...attributed, operationId: settled }));
        await store.settleInferenceOperation({ operationId: settled, attempt: 1, tokensInput: 10, tokensOutput: 5, tokensCacheRead: 4 });
        await store.claimInferenceOperation(operation({ ...attributed, operationId: unknown }));
        await store.settleInferenceOperation({ operationId: unknown, attempt: 1, tokensInput: 999, tokensCacheRead: 123 });
        // Another model is outside the model-specific detail filter, but remains visible to a provider summary.
        await store.claimInferenceOperation(operation({
            providerName, modelQualified: `${providerName}:other`, operationId: otherModel, attempt: 1,
        }));
        await store.settleInferenceOperation({ operationId: otherModel, attempt: 1, tokensInput: 1000, tokensOutput: 1000 });

        const after = await totals();
        expect(after.tokensTotal).toBe(before.tokensTotal + 15);
        expect(after.turns).toBe(before.turns);
        expect(after.sessions).toBe(before.sessions);
        const afterDaily = await daily();
        expect(afterDaily).toHaveLength(1);
        expect(afterDaily[0]).toMatchObject({
            dayUtc: beforeDaily[0].dayUtc,
            tokensTotal: beforeDaily[0].tokensTotal + 15,
            turns: beforeDaily[0].turns,
            tokensInput: beforeDaily[0].tokensInput + 10,
            tokensOutput: beforeDaily[0].tokensOutput + 5,
            tokensCacheRead: beforeDaily[0].tokensCacheRead + 4,
            tokensCacheWrite: beforeDaily[0].tokensCacheWrite,
        });
        expect(await breakdown()).toEqual([expect.objectContaining({
            key: modelQualified, tokensTotal: beforeModel[0].tokensTotal + 15, turns: beforeModel[0].turns,
            operations: 2, unknownUsageOperations: 1,
        })]);

        // Every accounting surface uses the same settled-operation union. Unknown usage is a visible operation,
        // never a zero-token success, and chat turns/sessions retain their existing meaning.
        const withUnknownCounts = [await totals(), ...(await daily()), ...(await breakdown())];
        expect(withUnknownCounts.map(row => [row.operations, row.unknownUsageOperations])).toEqual([[2, 1], [2, 1], [2, 1]]);
        const summary = await store.usageSummary(null, true, 14, [providerName]);
        expect(summary.windows.month).toMatchObject({
            total: before.tokensTotal + 2015, turnTokens: before.tokensTotal,
            turns: before.turns, sessions: before.sessions,
            operations: 3, unknownUsageOperations: 1,
        });
        expect(summary.daily).toEqual([expect.objectContaining({
            total: before.tokensTotal + 2015, turnTokens: before.tokensTotal, turns: before.turns,
            operations: 3, unknownUsageOperations: 1,
        })]);
        expect(summary.models).toEqual(expect.arrayContaining([
            expect.objectContaining({
                model: modelQualified.slice(providerName.length + 1), total: before.tokensTotal + 15, turnTokens: before.tokensTotal,
                turns: before.turns, operations: 2, unknownUsageOperations: 1,
            }),
            expect.objectContaining({ model: "other", total: 2000, turnTokens: 0, turns: 0, operations: 1, unknownUsageOperations: 0 }),
        ]));
        const agents = await store.usageAgents(null, true, 14, [providerName]);
        expect(agents.agents.reduce((sum, row) => sum + row.total, 0)).toBe(before.tokensTotal + 2015);
        expect(agents.agents.reduce((sum, row) => sum + row.turnTokens, 0)).toBe(before.tokensTotal);
        expect(agents.agents.reduce((sum, row) => sum + row.operations, 0)).toBe(3);
        expect(agents.agents.reduce((sum, row) => sum + row.unknownUsageOperations, 0)).toBe(1);
        expect(agents.daily.reduce((sum, row) => sum + row.total, 0)).toBe(before.tokensTotal + 2015);
    });

    it("daily usage and model breakdown keep privacy and the provider recycle boundary", async () => {
        const providerName = `pio-recycle-${tag()}`;
        const modelQualified = `${providerName}:decision-1`;
        const makeUser = async subject => Number((await pool.query(
            `INSERT INTO "${schema}".users (provider, subject, email, display_name)
             VALUES ('test-idp', $1, $1 || '@example.test', $1) RETURNING user_id`,
            [`${subject}-${tag()}`])).rows[0].user_id);
        const owner = await makeUser("pio-recycle-owner");
        const other = await makeUser("pio-recycle-other");
        const filters = { provider: providerName, model: modelQualified };

        const oldOperation = `op-${tag()}`;
        await store.claimInferenceOperation(operation({
            operationId: oldOperation, attempt: 1, providerName, modelQualified, ownerUserId: owner,
        }));
        await store.settleInferenceOperation({ operationId: oldOperation, attempt: 1, tokensInput: 10, tokensOutput: 1 });
        await pool.query(
            `SELECT * FROM "${schema}".cms_provider_create($1,'github','personal',$2,$3,NULL,$2,FALSE)`,
            [providerName, owner, JSON.stringify({ token: "t" })]);
        const currentOperation = `op-${tag()}`;
        await store.claimInferenceOperation(operation({
            operationId: currentOperation, attempt: 1, providerName, modelQualified, ownerUserId: owner,
        }));
        await store.settleInferenceOperation({ operationId: currentOperation, attempt: 1, tokensInput: 5, tokensOutput: 2 });

        expect(await store.usageTotals(owner, false, filters)).toMatchObject({ tokensTotal: 7, turns: 0, sessions: 0 });
        expect(await store.usageDaily(owner, false, filters)).toEqual([expect.objectContaining({
            tokensTotal: 7, turns: 0, tokensInput: 5, tokensOutput: 2,
        })]);
        expect(await store.usageBreakdown(owner, false, "model", filters)).toEqual([expect.objectContaining({
            key: modelQualified, tokensTotal: 7, turns: 0,
        })]);
        expect(await store.usageTotals(other, false, filters)).toMatchObject({ tokensTotal: 0, turns: 0, sessions: 0 });
        expect(await store.usageDaily(other, false, filters)).toEqual([]);
        expect(await store.usageBreakdown(other, false, "model", filters)).toEqual([]);
    });
});
