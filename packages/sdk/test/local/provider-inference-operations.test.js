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
        capability: "decision", purpose: "workflow-decision", providerName: PROVIDER, modelQualified: MODEL,
        chargeClass: "user", ...fields,
    });
    const read = async (operationId, attempt) => (await pool.query(
        `SELECT * FROM "${schema}".${TABLE} WHERE operation_id = $1 AND attempt = $2`, [operationId, attempt])).rows[0];

    it("has exactly the v11 columns and the (operation_id, attempt) key", async () => {
        const { rows } = await pool.query(
            `SELECT column_name, data_type, is_nullable FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = $2`, [schema, TABLE]);
        expect(Object.fromEntries(rows.map((row) => [row.column_name, row.data_type]))).toEqual({
            operation_id: "text", attempt: "integer",
            capability: "text", purpose: "text",
            session_id: "text", workflow_run_id: "text", node_execution_id: "text",
            provider_name: "text", model_qualified: "text",
            owner_user_id: "bigint", charge_class: "text", agent_id: "text",
            tokens_input: "bigint", tokens_output: "bigint", tokens_cache_read: "bigint", tokens_cache_write: "bigint",
            tokens_total: "bigint",
            created_at: "timestamp with time zone", settled_at: "timestamp with time zone",
        });
        // Deferred by v11: request/response hashes, raw provider usage, HTTP and error fields, non-token units, capability JSON.
        expect(rows.filter((row) => /hash|sha|raw|http|status|error|unit|json|request|response/
            .test(`${row.column_name} ${row.data_type}`))).toEqual([]);
        expect(rows.filter((row) => row.is_nullable === "YES").map((row) => row.column_name))
            .toEqual(expect.arrayContaining(["session_id", "workflow_run_id", "node_execution_id", "tokens_total", "settled_at"]));
        const key = await pool.query(
            `SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
              WHERE c.conrelid = format('%I.%I', $1::text, $2::text)::regclass AND c.contype = 'p'`, [schema, TABLE]);
        expect(key.rows.map((row) => row.definition)).toEqual(["PRIMARY KEY (operation_id, attempt)"]);
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
            attempt: 1, capability: "decision", purpose: "workflow-decision",
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

    it("usage totals add settled inference tokens; turn and session counts stay the chat ledger's", async () => {
        const providerName = `pio-${tag()}`;
        const modelQualified = `${providerName}:decision-1`;
        const totals = () => store.usageTotals(null, true, { provider: providerName, model: modelQualified });
        await store.settleTurn({
            sessionId: `chat-${providerName}`, turnIndex: 0, providerName, modelQualified, ownerUserId: null,
            chargeClass: "user", tokensInput: 100, tokensOutput: 20, tokensCacheRead: 30,
        });
        const before = await totals();
        expect(before).toMatchObject({ tokensTotal: 120, turns: 1, sessions: 1 });

        const [settled, unknown, otherModel] = [`op-${tag()}`, `op-${tag()}`, `op-${tag()}`];
        const attributed = { providerName, modelQualified, sessionId: `decision-${providerName}`, attempt: 1 };
        await store.claimInferenceOperation(operation({ ...attributed, operationId: settled }));
        await store.settleInferenceOperation({ operationId: settled, attempt: 1, tokensInput: 10, tokensOutput: 5, tokensCacheRead: 4 });
        await store.claimInferenceOperation(operation({ ...attributed, operationId: unknown }));
        await store.settleInferenceOperation({ operationId: unknown, attempt: 1 });
        // Another model, with no session, Workflow run or node attribution: outside the filter.
        await store.claimInferenceOperation(operation({
            providerName, modelQualified: `${providerName}:other`, operationId: otherModel, attempt: 1,
        }));
        await store.settleInferenceOperation({ operationId: otherModel, attempt: 1, tokensInput: 1000, tokensOutput: 1000 });

        const after = await totals();
        expect(after.tokensTotal).toBe(before.tokensTotal + 15);
        expect(after.turns).toBe(before.turns);
        expect(after.sessions).toBe(before.sessions);
    });
});
