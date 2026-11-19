/**
 * Cluster Decision Default: real migration/store/management reads and MCP model advertisement, no model calls.
 * Run from packages/sdk: node --env-file-if-exists=../../.env ../../node_modules/vitest/vitest.mjs run test/local/provider-decision-default.test.js
 */
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerModelTools } from "../../../app/mcp/src/tools/models.ts";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { ProviderStore } from "../../src/provider-store.ts";
import { loadProviderTypes } from "../../src/provider-catalog.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { schemaSnapshot, snapshotDifferences } from "../helpers/schema-snapshot.js";
import { useSuiteEnv } from "../helpers/local-env.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 240_000;
const CMS_LOCK_SEED = 0x63_6d_73;
const MIGRATION = "cluster_decision_default";
const LAST_AT_PIN = "0097";
const NONE = { provider: null, model: null, reasoning: null, context: null };
const DEFAULT = { provider: "team", model: "team:decision-model", reasoning: null, context: null };
const UNSET = { available: false, defaultModel: null, models: [], reason: "no_cluster_decision_default" };
const STALE = { ...UNSET, reason: "cluster_decision_default_ineligible" };
const COLUMNS = ["decision_default_provider", "decision_default_model", "decision_default_reasoning", "decision_default_context"];
const alice = { provider: "test-idp", subject: "alice", email: "alice@example.test", displayName: "Alice" };
const admin = { principal: alice, isAdmin: true };
const user = { principal: alice, isAdmin: false };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-decision-default-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const CONFIG = { providers: [
    { id: "mixed-type", type: "openai", baseUrl: "https://models.example.invalid/openai/v1",
        models: [{ name: "chat-model", description: "For chat" }],
        decisionModels: [{ name: "decision-model", description: "For decisions" }] },
    { id: "chat-only-type", type: "openai", baseUrl: "https://chat.example.invalid/v1", models: ["chat-model"] },
    { id: "decision-only-type", type: "openai", baseUrl: "https://decisions.example.invalid/openai/v1",
        models: [], decisionModels: [{ name: "decision-model", description: "For decisions" }] },
    { id: "endpointless-type", type: "openai", models: [], decisionModels: [{ name: "decision-model" }] },
] };

const decisionInput = (fields = {}) => ({ scope: "cluster_decision", provider: DEFAULT.provider, model: DEFAULT.model, ...fields });
const chatDefaults = ({ cluster, mine, system }) => ({ cluster, mine, system });
const registered = (schema) => CMS_MIGRATIONS(schema).find(entry => entry.name === MIGRATION);
const selectedCatalog = (snapshot, table) => Object.fromEntries(Object.entries(snapshot).map(([key, items]) => [key,
    items.filter(item => [item.relname, item.owner, item.table, item.owned_by_table, item.object].includes(table))]));

async function rerun(pool, entry) {
    if (entry.steps) {
        for (const step of entry.steps) await pool.query(step);
    } else {
        await pool.query(`BEGIN; ${entry.sql} COMMIT;`);
    }
}

async function withManagement(fn, config = CONFIG) {
    const env = getEnv();
    const modelProvidersPath = path.join(root, `${randomUUID()}.json`);
    fs.writeFileSync(modelProvidersPath, JSON.stringify(config));
    const mgmt = new PilotSwarmManagementClient({ store: env.store, cmsSchema: env.cmsSchema,
        duroxideSchema: env.duroxideSchema, factsSchema: env.factsSchema,
        modelProvidersPath, disableManagementAgents: true,
        systemAgents: [{ name: "root-system", id: "root-system", system: true, prompt: "root" }] });
    await mgmt.start();
    try {
        await mgmt.setUserProfileSettings(alice, {});
        await fn(mgmt, env);
    } finally {
        await mgmt.stop();
    }
}

async function shared(mgmt, name = "team", type = "mixed-type") {
    await mgmt.createProvider(admin, { name, type, credentials: { apiKey: "shared-test-key" } });
}

async function seed(mgmt) {
    await shared(mgmt);
    await shared(mgmt, "spare");
    await shared(mgmt, "chat-only", "chat-only-type");
    await mgmt.createMyProvider(user, { name: "personal", type: "mixed-type", credentials: { apiKey: "personal-test-key" } });
}

async function withMcp(mgmt, fn) {
    const server = new McpServer({ name: "decision-default-test", version: "1.0.0" });
    registerModelTools(server, { mgmt, admin: false, webMode: false });
    const client = new Client({ name: "decision-default-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
        await fn(client);
    } finally {
        await client.close();
        await server.close();
    }
}

async function list(client, grouped = false) {
    const response = await client.callTool({ name: "list_models", arguments: { group_by_provider: grouped } });
    expect(response.isError, response.content?.[0]?.text).not.toBe(true);
    return JSON.parse(response.content[0].text);
}

describe("Cluster Decision Default migration", () => {
    it("registers one separate default migration after 0097, without changing the previous migrations", () => {
        const migrations = CMS_MIGRATIONS("decision_registry_check");
        const entries = migrations.filter(entry => entry.name === MIGRATION);
        expect(entries).toHaveLength(1);
        expect(entries[0].version > LAST_AT_PIN).toBe(true);
        expect(migrations.indexOf(entries[0])).toBeGreaterThan(migrations.findIndex(entry => entry.version === LAST_AT_PIN));
        expect(migrations.filter(entry => ["0061", "0095", "0096", "0097"].includes(entry.version)).map(entry => entry.name))
            .toEqual(["provider_correctness_fixes", "canvas_ten_slots", "workflow_outcome_retention", "provider_inference_operations"]);
    });

    it("upgrades existing chat defaults unchanged, adds an unset nullable tuple, reruns safely and matches a fresh catalog", { timeout: TIMEOUT }, async () => {
        const entry = registered("decision_registry_check");
        expect(entry, "the Cluster Decision Default migration must exist").toBeDefined();
        const tag = randomUUID().replaceAll("-", "").slice(0, 12);
        const upgraded = `decision_${tag}_u`, fresh = `decision_${tag}_f`;
        const pool = new pg.Pool({ connectionString: getEnv().store, max: 1 });
        const query = (sql, params) => pool.query(sql, params);
        const through = schema => CMS_MIGRATIONS(schema).filter(item => item.version <= entry.version);
        try {
            await runMigrations(pool, upgraded, CMS_MIGRATIONS(upgraded).filter(item => item.version <= LAST_AT_PIN), CMS_LOCK_SEED);
            const store = new ProviderStore(pool, upgraded);
            const owner = Number((await pool.query(`INSERT INTO "${upgraded}".users (provider, subject, email)
                VALUES ('test-idp', 'migration-admin', 'admin@example.test') RETURNING user_id`)).rows[0].user_id);
            await pool.query(`INSERT INTO "${upgraded}".provider_instances (name, type_id, class, secret_ref)
                VALUES ('team', 'mixed-type', 'shared', '{"kind":"apiKey","value":"test-key"}'::jsonb)`);
            const chat = { provider: "team", model: "team:chat-model", reasoning: "medium", context: "default" };
            await store.setClusterDefault(chat, true);
            await store.setUserDefault(owner, chat);
            await store.setSystemDefault(owner, true, chat);
            const beforeDefaults = await store.getDefaults(owner);
            const before = await schemaSnapshot(query, upgraded);
            const singletonBefore = (await pool.query(`SELECT * FROM "${upgraded}".provider_cluster_settings WHERE singleton`)).rows[0];

            await runMigrations(pool, upgraded, through(upgraded), CMS_LOCK_SEED);
            const after = await schemaSnapshot(query, upgraded);
            const defaults = await store.getDefaults(owner);
            expect(chatDefaults(defaults)).toEqual(chatDefaults(beforeDefaults));
            expect(defaults.clusterDecision).toEqual(NONE);
            const singletonAfter = (await pool.query(`SELECT * FROM "${upgraded}".provider_cluster_settings WHERE singleton`)).rows[0];
            for (const [column, value] of Object.entries(singletonBefore)) expect(singletonAfter[column], column).toEqual(value);
            expect(COLUMNS.map(column => singletonAfter[column])).toEqual([null, null, null, null]);
            expect(after.columns.filter(column => column.relname === "provider_cluster_settings" && COLUMNS.includes(column.attname))
                .map(column => ({ name: column.attname, type: column.type, notNull: column.attnotnull })))
                .toEqual(COLUMNS.map(name => ({ name, type: "text", notNull: false })));
            expect((await pool.query(`SELECT count(*)::int AS count FROM "${upgraded}".provider_cluster_settings`)).rows[0].count).toBe(1);
            for (const table of ["provider_usage_ledger", "provider_inference_operations", "workflow_runs"]) {
                expect(selectedCatalog(after, table), `${table} is unchanged; there is no second run-model column`)
                    .toEqual(selectedCatalog(before, table));
            }
            await rerun(pool, registered(upgraded));
            expect(snapshotDifferences(after, await schemaSnapshot(query, upgraded))).toEqual({});
            await runMigrations(pool, fresh, through(fresh), CMS_LOCK_SEED);
            const installed = await schemaSnapshot(query, fresh);
            await rerun(pool, registered(fresh));
            expect(snapshotDifferences(installed, await schemaSnapshot(query, fresh))).toEqual({});
            const catalogOnly = ({ data, ...catalog }) => catalog;
            expect(snapshotDifferences(catalogOnly(after), catalogOnly(installed))).toEqual({});
        } finally {
            await pool.query(`DROP SCHEMA IF EXISTS "${upgraded}" CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS "${fresh}" CASCADE`);
            await pool.end();
        }
    });
});

describe("Cluster Decision Default store and management", () => {
    it("the real store enforces admin/shared/qualified/credentialed tuples, and permits clearing only as admin", async () => {
        await withManagement(async (mgmt) => {
            await seed(mgmt);
            const store = mgmt._catalog.providers;
            expect(typeof store.setClusterDecisionDefault).toBe("function");
            await expect(store.setClusterDecisionDefault(DEFAULT, false)).rejects.toMatchObject({ code: "PROVIDER_FORBIDDEN" });
            await expect(store.setClusterDecisionDefault({ ...DEFAULT, provider: "personal", model: "personal:decision-model" }, true))
                .rejects.toMatchObject({ code: "PROVIDER_INVALID" });
            await expect(store.setClusterDecisionDefault({ ...DEFAULT, model: "spare:decision-model" }, true))
                .rejects.toMatchObject({ code: "PROVIDER_INVALID" });
            await expect(store.setClusterDecisionDefault({ ...DEFAULT, provider: "missing", model: "missing:decision-model" }, true))
                .rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
            await expect(store.setClusterDecisionDefault({ ...NONE, provider: "team" }, true))
                .rejects.toMatchObject({ code: "PROVIDER_INVALID" });
            await store.setClusterDecisionDefault(DEFAULT, true);
            expect((await store.getDefaults(null)).clusterDecision).toEqual(DEFAULT);
            await expect(store.setClusterDecisionDefault(NONE, false)).rejects.toMatchObject({ code: "PROVIDER_FORBIDDEN" });
            await store.setClusterDecisionDefault(NONE, true);
            expect((await store.getDefaults(null)).clusterDecision).toEqual(NONE);
        });
    });

    it("an admin stores and reads the Decision default separately and clearing it preserves all chat defaults", async () => {
        await withManagement(async (mgmt) => {
            await seed(mgmt);
            await mgmt.setModelDefault(admin, { scope: "cluster", provider: "team", model: "chat-model" });
            await mgmt.setModelDefault(user, { scope: "user", provider: "personal", model: "chat-model" });
            await mgmt.setSystemModelDefault(admin, { provider: "team", model: "chat-model" });
            const before = chatDefaults(await mgmt.getDefaults(admin));
            await expect(mgmt.setModelDefault(admin, decisionInput())).resolves.toEqual(DEFAULT);
            expect(chatDefaults(await mgmt.getDefaults(admin))).toEqual(before);
            expect((await mgmt.getDefaults(user)).clusterDecision).toEqual(DEFAULT);
            const defaults = await mgmt.getModelDefaults(user);
            expect(defaults.clusterDecision).toMatchObject({ configured: DEFAULT,
                effective: { provider: "team", model: DEFAULT.model, source: "cluster_decision_default" }, error: null });
            expect(defaults.clusterSession.effective.model).toBe("team:chat-model");
            expect(defaults.userSession.effective.model).toBe("personal:chat-model");
            expect((await mgmt.getModelDefaults(admin)).system.effective.model).toBe("team:chat-model");
            await expect(mgmt.setModelDefault(admin, decisionInput({ provider: null, model: null }))).resolves.toEqual(NONE);
            expect((await mgmt.getDefaults(admin)).clusterDecision).toEqual(NONE);
            expect((await mgmt.getModelDefaults(user)).clusterDecision.effective).toBeNull();
            expect(chatDefaults(await mgmt.getDefaults(admin))).toEqual(before);
            expect((await mgmt.getWorkflowCapabilities()).decision).toEqual(UNSET);
        });
    });

    it("a non-admin cannot set or clear the Decision default, including their own system-enabled personal provider", async () => {
        await withManagement(async (mgmt) => {
            await seed(mgmt);
            await mgmt.setProviderSystemUse(admin, { provider: "personal", enabled: true });
            await expect(mgmt.setModelDefault(user, decisionInput())).rejects.toMatchObject({ code: "PROVIDER_FORBIDDEN" });
            await expect(mgmt.setModelDefault(user, decisionInput({ provider: null, model: null })))
                .rejects.toMatchObject({ code: "PROVIDER_FORBIDDEN" });
            await expect(mgmt.setModelDefault(admin, decisionInput({ provider: "personal", model: "personal:decision-model" })))
                .rejects.toMatchObject({ code: "PROVIDER_INVALID" });
        });
    });

    for (const [name, fields, code] of [
        ["chat model", { model: "team:chat-model" }, "PROVIDER_INVALID"],
        ["chat-only provider", { provider: "chat-only", model: "chat-only:chat-model" }, "PROVIDER_INVALID"],
        ["missing provider", { provider: "missing", model: "missing:decision-model" }, "PROVIDER_NOT_FOUND"],
        ["type id instead of an instance", { provider: "mixed-type", model: "mixed-type:decision-model" }, "PROVIDER_NOT_FOUND"],
        ["missing model", { model: "team:missing" }, "PROVIDER_INVALID"],
        ["bare model", { model: "decision-model" }, "PROVIDER_INVALID"],
        ["mismatched instance prefix", { model: "spare:decision-model" }, "PROVIDER_INVALID"],
        ["incomplete tuple", { model: null }, "PROVIDER_INVALID"],
    ]) {
        it(`the management setter refuses ${name} without altering the stored default`, async () => {
            await withManagement(async (mgmt) => {
                await seed(mgmt);
                await mgmt.setModelDefault(admin, decisionInput());
                await expect(mgmt.setModelDefault(admin, decisionInput(fields))).rejects.toMatchObject({ code });
                expect((await mgmt.getDefaults(admin)).clusterDecision).toEqual(DEFAULT);
            });
        });
    }

    for (const [name, secretRef] of [
        ["missing credential", {}],
        ["unqualified credential marker", { kind: "workloadIdentity" }],
        ["unresolvable configuration reference", { kind: "apiKey", source: "config-file", ref: "env:PS_TEST_DECISION_MISSING_KEY_71C0" }],
    ]) {
        it(`the management setter refuses a shared instance with ${name}`, async () => {
            await withManagement(async (mgmt, env) => {
                await shared(mgmt);
                await mgmt._catalog.providers.pool.query(`UPDATE "${env.cmsSchema}".provider_instances SET secret_ref = $1::jsonb WHERE name = 'team'`,
                    [JSON.stringify(secretRef)]);
                await expect(mgmt.setModelDefault(admin, decisionInput())).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
                expect((await mgmt.getDefaults(admin)).clusterDecision).toEqual(NONE);
            });
        });
    }

    it("a shared instance without a usable endpoint cannot become the Decision default", async () => {
        await withManagement(async (mgmt) => {
            await shared(mgmt, "no-endpoint", "endpointless-type");
            await expect(mgmt.setModelDefault(admin, decisionInput({ provider: "no-endpoint", model: "no-endpoint:decision-model" })))
                .rejects.toMatchObject({ code: "PROVIDER_INVALID" });
        });
    });

    it("management admission rejects unsupported Decision endpoints and workload-identity auth without hiding chat", async () => {
        const config = { providers: [
            { id: "plain-v1", type: "openai", baseUrl: "https://plain.example.invalid/v1", models: ["chat-model"],
                decisionModels: [{ name: "decision-model" }] },
            { id: "azure-sdk", type: "azure", baseUrl: "https://azure.example.invalid/openai", models: ["chat-model"],
                decisionModels: [{ name: "decision-model" }] },
            { id: "other-wif", type: "anthropic-wif", baseUrl: "https://plain.example.invalid/openai/v1",
                models: ["chat-model"], decisionModels: [{ name: "decision-model" }] },
        ] };
        await withManagement(async (mgmt) => {
            for (const [name, type] of [["plain", "plain-v1"], ["azure", "azure-sdk"], ["wif", "other-wif"]]) {
                await mgmt.createProvider(admin, { name, type,
                    credentials: type === "other-wif" ? undefined : { apiKey: `${name}-test-key` } });
                await expect(mgmt.setModelDefault(admin, decisionInput({ provider: name, model: `${name}:decision-model` })))
                    .rejects.toMatchObject({ code: "PROVIDER_INVALID" });
            }
            expect((await mgmt.listRuntimeDecisionModels(admin))).toEqual([]);
            expect((await mgmt.listRuntimeModels(admin)).map(model => model.providerId).sort())
                .toEqual(["azure", "other-wif", "plain", "wif"]);
            expect((await mgmt.getWorkflowCapabilities()).decision).toEqual(UNSET);
        }, config);
    });

    it("management admission preserves supported Foundry workload identity", async () => {
        const config = { providers: [{ id: "foundry-wif", type: "foundry-wif",
            baseUrl: "https://foundry.example.invalid/openai/v1", models: [],
            decisionModels: [{ name: "decision-model" }] }] };
        await withManagement(async (mgmt) => {
            await mgmt.createProvider(admin, { name: "foundry", type: "foundry-wif" });
            const tuple = { provider: "foundry", model: "foundry:decision-model", reasoning: null, context: null };
            await expect(mgmt.setModelDefault(admin, decisionInput(tuple))).resolves.toEqual(tuple);
            expect((await mgmt.listRuntimeDecisionModels(admin)).map(model => model.qualifiedName))
                .toEqual(["foundry-wif:decision-model", "foundry:decision-model"]);
            expect((await mgmt.getWorkflowCapabilities()).decision).toEqual({ available: true,
                defaultModel: tuple.model, models: [tuple.model, "foundry-wif:decision-model"], reason: null });
            expect((await mgmt.listRuntimeModels(admin))).toEqual([]);
        }, config);
    });

    it("personal, cluster-chat, system-chat and system-agent defaults all refuse Decision models", async () => {
        await withManagement(async (mgmt) => {
            await seed(mgmt);
            await expect(mgmt.setModelDefault(user, { scope: "user", provider: "personal", model: "personal:decision-model" }))
                .rejects.toMatchObject({ code: "PROVIDER_INVALID" });
            await expect(mgmt.setModelDefault(admin, { scope: "cluster", provider: "team", model: DEFAULT.model }))
                .rejects.toMatchObject({ code: "PROVIDER_INVALID" });
            await expect(mgmt.setSystemModelDefault(admin, { provider: "team", model: DEFAULT.model }))
                .rejects.toMatchObject({ code: "PROVIDER_INVALID" });
            await expect(mgmt.setSystemSessionModel(admin, { agentId: "root-system", provider: "team", model: DEFAULT.model }))
                .rejects.toMatchObject({ code: "PROVIDER_INVALID" });
            expect(mgmt.listModels().every(model => model.modelName === "chat-model")).toBe(true);
            expect((await mgmt.listRuntimeModels(user)).every(model => model.modelName === "chat-model")).toBe(true);
            expect(mgmt.normalizeModel("mixed-type:decision-model")).toBeUndefined();
        });
    });

    it("Decision-only providers cannot satisfy implicit chat defaults, and catalog presence alone does not enable the node", async () => {
        await withManagement(async (mgmt) => {
            await shared(mgmt, "decisions", "decision-only-type");
            const defaults = await mgmt.getModelDefaults(admin);
            expect(defaults.clusterDecision).toMatchObject({ configured: NONE, effective: null, error: null });
            for (const scope of ["userSession", "clusterSession", "system"]) expect(defaults[scope].effective).toBeNull();
            expect(await mgmt.listRuntimeModels(user)).toEqual([]);
            expect((await mgmt.getWorkflowCapabilities()).decision).toEqual(UNSET);
        });
    });

    it("runtime model reads enumerate eligible shared Decision instances separately from chat and personal providers", async () => {
        await withManagement(async (mgmt, env) => {
            await seed(mgmt);
            await shared(mgmt, "bad-key");
            await mgmt._catalog.providers.pool.query(`UPDATE "${env.cmsSchema}".provider_instances SET secret_ref = '{}'::jsonb WHERE name = 'bad-key'`);
            expect(typeof mgmt.listRuntimeDecisionModels).toBe("function");
            for (const viewer of [admin, user, { principal: null, isAdmin: false }]) {
                const models = await mgmt.listRuntimeDecisionModels(viewer);
                expect(models.map(model => model.qualifiedName).sort()).toEqual(["spare:decision-model", "team:decision-model"]);
                expect(models.every(model => model.catalogKind === "runtime_provider" && model.credentialAvailable)).toBe(true);
                expect(models.every(model => model.providerId !== "mixed-type" && model.modelName === "decision-model")).toBe(true);
            }
        });
    });

    it("management availability is default-gated and becomes stale when that credential or model is removed", async () => {
        await withManagement(async (mgmt, env) => {
            await seed(mgmt);
            expect((await mgmt.getWorkflowCapabilities()).decision).toEqual(UNSET);
            await mgmt.setModelDefault(admin, decisionInput());
            expect((await mgmt.getWorkflowCapabilities()).decision).toEqual({ available: true, defaultModel: DEFAULT.model,
                models: ["team:decision-model", "spare:decision-model"], reason: null });
            await mgmt._catalog.providers.pool.query(`UPDATE "${env.cmsSchema}".provider_instances SET secret_ref = '{}'::jsonb WHERE name = 'team'`);
            expect((await mgmt.getWorkflowCapabilities()).decision).toEqual(STALE);
            expect((await mgmt.getModelDefaults(user)).clusterDecision.effective).toBeNull();
            await mgmt._catalog.providers.pool.query(`UPDATE "${env.cmsSchema}".provider_instances
                SET secret_ref = '{"kind":"apiKey","value":"restored-test-key"}'::jsonb WHERE name = 'team'`);
            mgmt._modelProviders = loadProviderTypes({ providers: CONFIG.providers.map(provider => ({ ...provider, decisionModels: [] })) });
            expect((await mgmt.getWorkflowCapabilities()).decision).toEqual(STALE);
            expect((await mgmt.getModelDefaults(user)).clusterDecision.effective).toBeNull();
        });
    });

    it("deleting the configured provider revokes availability rather than selecting a spare Decision model", async () => {
        await withManagement(async (mgmt) => {
            await seed(mgmt);
            await mgmt.setModelDefault(admin, decisionInput());
            await mgmt.deleteProvider(admin, { name: "team" });
            const decision = (await mgmt.getWorkflowCapabilities()).decision;
            expect(decision.available).toBe(false);
            expect(decision.defaultModel).toBeNull();
            expect(decision.models).toEqual([]);
            expect(["no_cluster_decision_default", "cluster_decision_default_ineligible"]).toContain(decision.reason);
        });
    });
});

describe("MCP list_models Decision advertisement", () => {
    it("flat and grouped responses keep chat models separate and advertise the qualified Decision default", async () => {
        await withManagement(async (mgmt) => {
            await shared(mgmt);
            await mgmt.setModelDefault(admin, { scope: "cluster", provider: "team", model: "chat-model" });
            await mgmt.setModelDefault(admin, decisionInput());
            await withMcp(mgmt, async client => {
                for (const grouped of [false, true]) {
                    const body = await list(client, grouped);
                    expect(body.decision_models.map(model => model.qualified_name)).toEqual([DEFAULT.model]);
                    expect(body.decision_models[0]).toMatchObject({ provider: "team", model_name: "decision-model" });
                    expect(body.decision_default_model).toBe(DEFAULT.model);
                    const chat = grouped ? body.providers.flatMap(provider => provider.models) : body.models;
                    expect(chat.map(model => model.qualified_name)).toEqual(["team:chat-model"]);
                    if (!grouped) expect({ model: body.default_model, count: body.count }).toEqual({ model: "team:chat-model", count: 1 });
                }
            });
        });
    });

    it("an unset or stale Decision default is null, never a chat default or first eligible Decision model", async () => {
        await withManagement(async (mgmt, env) => {
            await shared(mgmt);
            await shared(mgmt, "spare");
            await withMcp(mgmt, async client => {
                expect((await list(client)).decision_default_model).toBeNull();
                await mgmt.setModelDefault(admin, decisionInput());
                await mgmt._catalog.providers.pool.query(`UPDATE "${env.cmsSchema}".provider_instances SET secret_ref = '{}'::jsonb WHERE name = 'team'`);
                const body = await list(client);
                expect(body.decision_default_model).toBeNull();
                expect(body.decision_models.map(model => model.qualified_name)).toEqual(["spare:decision-model"]);
            });
        });
    });

    it("a Decision-only runtime still lists its Decision model with no chat default", async () => {
        await withManagement(async (mgmt) => {
            await shared(mgmt, "decisions", "decision-only-type");
            await mgmt.setModelDefault(admin, decisionInput({ provider: "decisions", model: "decisions:decision-model" }));
            await withMcp(mgmt, async client => {
                const body = await list(client);
                expect(body.models).toEqual([]);
                expect(body.default_model).toBeNull();
                expect(body.count).toBe(0);
                expect(body.decision_models.map(model => model.qualified_name)).toEqual(["decisions:decision-model"]);
                expect(body.decision_default_model).toBe("decisions:decision-model");
            });
        }, { providers: [CONFIG.providers.find(provider => provider.id === "decision-only-type")] });
    });

    it("a config with no Decision models keeps the exact existing flat and grouped chat response", async () => {
        const { decisionModels, ...chatType } = CONFIG.providers[0];
        await withManagement(async (mgmt) => {
            await shared(mgmt);
            await mgmt.setModelDefault(admin, { scope: "cluster", provider: "team", model: "chat-model" });
            await withMcp(mgmt, async client => {
                const model = { qualified_name: "team:chat-model", model_name: "chat-model", description: "For chat" };
                expect(await list(client)).toEqual({ models: [{ ...model, provider: "team" }], default_model: "team:chat-model", count: 1 });
                expect(await list(client, true)).toEqual({ providers: [{ provider_id: "team", type: "openai", models: [model] }] });
            });
        }, { providers: [chatType] });
    });
});
