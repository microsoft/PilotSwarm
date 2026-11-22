/**
 * The agent `decide` tool on PostgreSQL (docs/proposals/agent-decide-tool.md, phase 1): budget admission, the
 * inference-ledger claim and its settlement are the real CMS procedures; the provider is the real systemone adapter
 * over an injected fetch (no network). Live model calls are in test/live/.
 *
 * Run from packages/sdk: node --env-file-if-exists=../../.env ../../node_modules/vitest/vitest.mjs run test/local/decide-tool.test.js
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { createDecisionCatalogReader, runDecide, DECIDE_LEDGER_PURPOSE } from "../../src/decision-tools.ts";
import { createDecisionProvider } from "../../src/decision-provider.ts";
import { resolveRuntimeDecisionProvider } from "../../src/provider-catalog.ts";
import { useSuiteEnv } from "../helpers/local-env.js";

const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const DEPLOYMENT = "ps-decision-1-1";
const alice = { provider: "test-idp", subject: "alice-decide", email: "alice-decide@example.test", displayName: "Alice" };
const admin = { principal: alice, isAdmin: true };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-decide-tool-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const CONFIG = { providers: [
    { id: "foundry-type", type: "openai", baseUrl: "https://foundry-decision.example.invalid/openai/v1",
        models: [{ name: "chat-model" }], decisionModels: [{ name: DEPLOYMENT, description: "Microsoft Decision 1.1" }] },
] };
const CHOICE = { type: "choice", instructions: "Which team should handle this ticket?",
    criteria: { engineering: "Bugs and outages", billing: "Charges and refunds", support: "How-to questions" } };
const BODY = { answers: { decision: { type: "choice", choice: "billing", probabilities: { engineering: 0.03, billing: 0.93, support: 0.04 } } },
    usage: { input_tokens: 412, output_tokens: 6 } };

async function withDecide(fn, { body = BODY } = {}) {
    const env = getEnv();
    const modelProvidersPath = path.join(root, `${randomUUID()}.json`);
    fs.writeFileSync(modelProvidersPath, JSON.stringify(CONFIG));
    const mgmt = new PilotSwarmManagementClient({ store: env.store, cmsSchema: env.cmsSchema, duroxideSchema: env.duroxideSchema,
        factsSchema: env.factsSchema, modelProvidersPath, disableManagementAgents: true,
        systemAgents: [{ name: "root-system", id: "root-system", system: true, prompt: "root" }] });
    await mgmt.start();
    const db = new pg.Pool({ connectionString: env.store, max: 2 });
    try {
        await mgmt.setUserProfileSettings(alice, {});
        const provider = `decide-${randomUUID().slice(0, 8)}`;
        await mgmt.createProvider(admin, { name: provider, type: "foundry-type", credentials: { apiKey: "decide-test-key" } });
        await mgmt.setModelDefault(admin, { scope: "cluster_decision", provider, model: `${provider}:${DEPLOYMENT}` });
        const store = mgmt._catalog.providers;
        const requests = [];
        const state = { body, usage: true };
        const fetch = async (_url, init) => {
            requests.push(JSON.parse(init.body));
            const answer = state.usage ? state.body : { answers: state.body.answers };
            return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
        };
        const host = {
            providerStore: store,
            providerTypes: () => mgmt._modelProviders,
            providerFor: async (qualified, instanceId, updatedAt) => {
                const credential = await store.getCredentialByInstanceId(instanceId);
                const resolved = resolveRuntimeDecisionProvider(mgmt._modelProviders, credential, qualified, instanceId, updatedAt);
                return resolved ? createDecisionProvider(resolved, { fetch }) : null;
            },
        };
        const sessionId = `decide-${randomUUID()}`;
        await mgmt._catalog.createSession(sessionId, { owner: alice, model: "unused:chat", agentId: "triage-agent" });
        const options = { sessionId, agentId: "triage-agent", host, readCatalog: createDecisionCatalogReader(host, { ttlMs: 0 }) };
        const ledger = async () => (await db.query(
            `SELECT operation_id, attempt, capability, purpose, session_id, workflow_run_id, agent_id, provider_name, model_qualified,
                    owner_user_id, charge_class, tokens_input, tokens_output, tokens_total, settled_at IS NOT NULL AS settled, latency_ms
               FROM "${env.cmsSchema}".provider_inference_operations WHERE session_id = $1 ORDER BY created_at`, [sessionId])).rows;
        await fn({ mgmt, env, db, store, host, options, sessionId, provider, requests, state, ledger });
    } finally {
        await db.end();
        await mgmt.stop();
    }
}

describe("agent decide tool on PostgreSQL", () => {
    it("one call: admitted, claimed and settled once, with the agent, purpose, owner and tokens", { timeout: TIMEOUT }, async () => {
        await withDecide(async ({ options, ledger, provider, requests, sessionId }) => {
            const result = await runDecide(options, { question: CHOICE, context: { ticket: "Charged twice" } }, { toolCallId: "call_pg_1" });
            expect(result.ok, JSON.stringify(result)).toBe(true);
            expect(result.model_source).toBe("cluster_decision_default");
            expect(result.decision.outcome).toBe("billing");
            expect(requests).toHaveLength(1);
            const rows = await ledger();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                operation_id: `decide:${sessionId}:call_pg_1`, attempt: 1, capability: "decision", purpose: DECIDE_LEDGER_PURPOSE,
                session_id: sessionId, workflow_run_id: null, agent_id: "triage-agent", provider_name: provider,
                model_qualified: `${provider}:${DEPLOYMENT}`, charge_class: "user", settled: true,
            });
            expect(Number(rows[0].owner_user_id)).toBeGreaterThan(0);
            expect([Number(rows[0].tokens_input), Number(rows[0].tokens_output), Number(rows[0].tokens_total)]).toEqual([412, 6, 418]);
            expect(rows[0].latency_ms).not.toBeNull();
        });
    });

    it("the same tool call id claims once: no second provider call and no second row", { timeout: TIMEOUT }, async () => {
        await withDecide(async ({ options, ledger, requests }) => {
            expect((await runDecide(options, { question: CHOICE }, { toolCallId: "call_pg_once" })).ok).toBe(true);
            const again = await runDecide(options, { question: CHOICE }, { toolCallId: "call_pg_once" });
            expect(again.error).toMatchObject({ code: "execution_failed", reason: "already_claimed", retryable: false });
            expect(requests).toHaveLength(1);
            expect(await ledger()).toHaveLength(1);
        });
    });

    it("unknown usage is stored as unknown, never as zero", { timeout: TIMEOUT }, async () => {
        await withDecide(async ({ options, ledger, state }) => {
            state.usage = false;
            const result = await runDecide(options, { question: CHOICE }, { toolCallId: "call_pg_unknown" });
            expect(result.ok, JSON.stringify(result)).toBe(true);
            expect(result.usage).toBeNull();
            const [row] = await ledger();
            expect([row.tokens_input, row.tokens_output, row.tokens_total, row.settled]).toEqual([null, null, null, true]);
        });
    });

    it("a held provider is budget_exceeded: no claim, no call, and the session itself is not paused", { timeout: TIMEOUT }, async () => {
        await withDecide(async ({ options, ledger, requests, store, provider, db, env, sessionId }) => {
            await store.setHold(provider, { indefinite: true }, null, true);
            const sessionRow = async () => (await db.query(`SELECT to_jsonb(s) AS row FROM "${env.cmsSchema}".sessions s WHERE session_id = $1`,
                [sessionId])).rows[0].row;
            const before = await sessionRow();
            const result = await runDecide(options, { question: CHOICE }, { toolCallId: "call_pg_held" });
            expect(result.error).toMatchObject({ code: "budget_exceeded", reason: "budget_paused", retryable: false });
            expect(requests).toHaveLength(0);
            expect(await ledger()).toHaveLength(0);
            expect(await sessionRow()).toEqual(before);
        });
    });

    it("a system session is charged as system and still ledgered", { timeout: TIMEOUT }, async () => {
        await withDecide(async ({ options, mgmt, db, env }) => {
            const systemId = `decide-system-${randomUUID()}`;
            await mgmt._catalog.createSession(systemId, { isSystem: true, agentId: "sweeper" });
            const result = await runDecide({ ...options, sessionId: systemId, agentId: "sweeper" }, { question: CHOICE }, { toolCallId: "call_pg_sys" });
            expect(result.ok, JSON.stringify(result)).toBe(true);
            const rows = (await db.query(`SELECT charge_class, agent_id FROM "${env.cmsSchema}".provider_inference_operations WHERE session_id = $1`,
                [systemId])).rows;
            expect(rows).toEqual([{ charge_class: "system", agent_id: "sweeper" }]);
        });
    });

    it("the default is read live: cleared, the next call is decision_model_unavailable without rebuilding the tool", { timeout: TIMEOUT }, async () => {
        await withDecide(async ({ options, mgmt }) => {
            expect((await runDecide(options, { question: CHOICE }, { toolCallId: "call_pg_live_1" })).ok).toBe(true);
            await mgmt.setModelDefault(admin, { scope: "cluster_decision", provider: null, model: null });
            const cleared = await runDecide(options, { question: CHOICE }, { toolCallId: "call_pg_live_2" });
            expect(cleared.error).toMatchObject({ code: "decision_model_unavailable", reason: "no_cluster_decision_default" });
        });
    });
});
