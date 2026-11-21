/**
 * Worker-backed live qualification of the agent `decide` tool: a real worker and client, a real chat model, a shared
 * Decision provider and the Cluster Decision Default set through the management client, and a real Microsoft Decision
 * deployment. The model calls the DECLARED tool in a real turn; the
 * test checks the ledger row the call made and the answer the model gives.
 *
 * Configure (all required; nothing here is skipped):
 *   the chat model of the local suite (.env: DATABASE_URL, PS_MODEL_PROVIDERS_PATH and its key, as for test/local)
 *   PS_DECISION_LIVE_BASE_URL, PS_DECISION_LIVE_API_KEY, PS_DECISION_LIVE_DEPLOYMENT (see decide-tool.live.test.mjs)
 *
 * Run: npm run test:live:decide:agent --workspace=packages/sdk
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { PilotSwarmManagementClient } from "../../src/index.ts";

const REQUIRED = ["PS_DECISION_LIVE_BASE_URL", "PS_DECISION_LIVE_API_KEY", "PS_DECISION_LIVE_DEPLOYMENT", "PS_MODEL_PROVIDERS_PATH"];
const getEnv = useSuiteEnv(import.meta.url, "decide-agent-live");
const owner = { provider: "test-idp", subject: "decide-live-owner", email: "decide-live@example.test", displayName: "Decide Live" };
const admin = { principal: owner, isAdmin: true };
const PROVIDER = "decision-live";

function liveConfig() {
    const missing = REQUIRED.filter(name => !process.env[name]?.trim());
    expect(missing, `Worker-backed decide qualification is not configured: set ${missing.join(", ")}. The Decision variables name a `
        + "Foundry resource's https://<resource>.cognitiveservices.azure.com/openai/v1 base, a key and its Microsoft Decision deployment; "
        + "PS_MODEL_PROVIDERS_PATH is the chat model catalog the local suite uses.").toEqual([]);
    return {
        baseUrl: process.env.PS_DECISION_LIVE_BASE_URL.trim(),
        deployment: process.env.PS_DECISION_LIVE_DEPLOYMENT.trim(),
        chatCatalog: process.env.PS_MODEL_PROVIDERS_PATH.trim(),
    };
}

describe("agent decide tool, worker-backed live qualification", () => {
    it("a real turn calls the declared decide tool; the live answer comes back and the call is ledgered once", { timeout: 300_000 }, async () => {
        const config = liveConfig();
        await preflightChecks();
        const env = getEnv();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-decide-live-"));
        const catalog = JSON.parse(fs.readFileSync(config.chatCatalog, "utf8"));
        catalog.providers = [...catalog.providers, { id: PROVIDER, type: "openai", baseUrl: config.baseUrl,
            apiKey: "env:PS_DECISION_LIVE_API_KEY", models: [], decisionModels: [{ name: config.deployment, description: "Microsoft Decision (live qualification)" }] }];
        const modelProvidersPath = path.join(dir, "model_providers.json");
        fs.writeFileSync(modelProvidersPath, JSON.stringify(catalog));
        const mgmt = new PilotSwarmManagementClient({ store: env.store, cmsSchema: env.cmsSchema, duroxideSchema: env.duroxideSchema,
            factsSchema: env.factsSchema, modelProvidersPath, disableManagementAgents: true });
        const db = new pg.Pool({ connectionString: env.store, max: 1 });
        try {
            await mgmt.start();
            await mgmt.setUserProfileSettings(owner, {});
            if (!(await mgmt.listProviders(admin)).providers.some(row => row.name === PROVIDER)) {
                await mgmt.createProvider(admin, { name: PROVIDER, type: PROVIDER, credentials: { apiKey: process.env.PS_DECISION_LIVE_API_KEY } });
            }
            await mgmt.setModelDefault(admin, { scope: "cluster_decision", provider: PROVIDER, model: `${PROVIDER}:${config.deployment}` });

            await withClient(env, { worker: { modelProvidersPath }, client: { modelProvidersPath } }, async (client) => {
                const session = await client.createSession({ owner });
                const answer = await session.sendAndWait("Use the decide tool exactly once. Ask a choice question with instructions "
                    + "\"Which team should handle this support ticket?\" and criteria engineering: \"Bugs, outages and integrations\", "
                    + "billing: \"Charges, invoices and refunds\", support: \"Sign-in and how-to questions\". Pass context "
                    + "{\"ticket\": \"I was charged twice for order 1042; please refund the duplicate charge.\"}. "
                    + "Then reply with only the outcome label the tool returned.", 240_000, undefined, { requiredTool: "decide" });
                const rows = (await db.query(`SELECT operation_id, capability, purpose, provider_name, model_qualified, charge_class,
                        tokens_input, tokens_output, settled_at IS NOT NULL AS settled
                    FROM "${env.cmsSchema}".provider_inference_operations WHERE session_id = $1`, [session.sessionId])).rows;
                console.info(`LIVE_DECIDE_AGENT ${JSON.stringify({ rows: rows.map(row => ({ ...row, operation_id: row.operation_id.replace(session.sessionId, "<session>") })), answer })}`);
                expect(rows).toHaveLength(1);
                expect(rows[0]).toMatchObject({ capability: "decision", purpose: "Agent decide tool", provider_name: PROVIDER,
                    model_qualified: `${PROVIDER}:${config.deployment}`, charge_class: "user", settled: true });
                expect(rows[0].operation_id.startsWith(`decide:${session.sessionId}:`)).toBe(true);
                expect(Number(rows[0].tokens_input)).toBeGreaterThan(0);
                expect(String(answer ?? "").toLowerCase()).toContain("billing");
            });
        } finally {
            await db.end();
            await mgmt.stop();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
