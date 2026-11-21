/**
 * Live qualification of the agent `decide` tool against a real Microsoft Decision deployment (Foundry systemone):
 * `choice`, `noul` and `score` through the tool's own handler, the real adapter and real HTTP. With
 * PS_DECISION_LIVE_RECORD=1 the raw provider bodies are written to test/fixtures/decision-live/ (no key, no headers), and
 * the unit tests replay them. Not part of any default suite: it calls a paid model.
 *
 * Configure (all required; nothing here is skipped):
 *   PS_DECISION_LIVE_BASE_URL    the Foundry resource's OpenAI v1 base, https://<resource>.cognitiveservices.azure.com/openai/v1
 *   PS_DECISION_LIVE_API_KEY     a key of that resource
 *   PS_DECISION_LIVE_DEPLOYMENT  the Decision deployment name (for example ps-decision-1-1)
 *
 * Run after the SDK build: npm run test:live:decide --workspace=packages/sdk
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createDecisionProvider } from "../../dist/decision-provider.js";
import { createDecisionCatalogReader, runDecide } from "../../dist/decision-tools.js";
import { loadProviderTypes, resolveRuntimeDecisionProvider } from "../../dist/provider-catalog.js";

const REQUIRED = ["PS_DECISION_LIVE_BASE_URL", "PS_DECISION_LIVE_API_KEY", "PS_DECISION_LIVE_DEPLOYMENT"];
const FIXTURES = new URL("../fixtures/decision-live/", import.meta.url);

function liveConfig() {
    const missing = REQUIRED.filter(name => !process.env[name]?.trim());
    assert.deepEqual(missing, [], `Live Decision qualification is not configured: set ${missing.join(", ")}. `
        + "PS_DECISION_LIVE_BASE_URL is the Foundry resource's https://<resource>.cognitiveservices.azure.com/openai/v1 base, "
        + "PS_DECISION_LIVE_API_KEY a key of that resource, and PS_DECISION_LIVE_DEPLOYMENT its Microsoft Decision deployment.");
    return {
        baseUrl: process.env.PS_DECISION_LIVE_BASE_URL.trim(),
        apiKey: process.env.PS_DECISION_LIVE_API_KEY.trim(),
        deployment: process.env.PS_DECISION_LIVE_DEPLOYMENT.trim(),
        record: process.env.PS_DECISION_LIVE_RECORD === "1",
    };
}

/** A one-provider host over the live endpoint; the ledger is in memory (its PostgreSQL path is test/local/decide-tool.test.js). */
function liveHost(config) {
    const types = loadProviderTypes({ providers: [{ id: "live-foundry", type: "openai", baseUrl: config.baseUrl,
        models: [], decisionModels: [{ name: config.deployment }] }] });
    const instanceId = "00000000-0000-4000-8000-0000000000aa";
    const updatedAt = "2026-11-21T00:00:00.000Z";
    const row = { name: "live", instanceId, updatedAt, typeId: "live-foundry", class: "shared", ownerUserId: null, baseUrl: null,
        secretRef: { kind: "apiKey", value: config.apiKey } };
    const exchanges = [];
    const fetchAndKeep = async (url, init) => {
        const response = await fetch(url, init);
        const text = await response.text();
        exchanges.push({ status: response.status, request: JSON.parse(init.body), responseText: text });
        return new Response(text, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
    };
    const claims = new Map();
    const settlements = [];
    const providerStore = {
        allCredentials: async () => [row],
        getClusterDecisionDefault: async () => ({ provider: "live", model: `live:${config.deployment}`, reasoning: null, context: null }),
        checkDecision: async (_sessionId, model, providerInstanceId) => ({
            verdict: "clear", providerName: "live", providerInstanceId, providerTypeId: "live-foundry", providerClass: "shared",
            providerOwnerUserId: null, providerUpdatedAt: updatedAt, ownerUserId: 1, modelQualified: model, exempt: false, pause: null, rules: [],
        }),
        claimInferenceOperation: async claim => {
            const key = `${claim.operationId}/${claim.attempt}`;
            if (claims.has(key)) return false;
            claims.set(key, claim);
            return true;
        },
        settleInferenceOperation: async usage => { settlements.push(usage); return true; },
    };
    const host = {
        providerStore,
        providerTypes: () => types,
        providerFor: async (qualified, id, at) => {
            const resolved = resolveRuntimeDecisionProvider(types, row, qualified, id, at);
            return resolved ? createDecisionProvider(resolved, { fetch: fetchAndKeep }) : null;
        },
    };
    return { host, exchanges, claims, settlements };
}

const CASES = [
    {
        name: "choice",
        arguments: {
            question: { type: "choice", instructions: "Which team should handle this support ticket?",
                criteria: { engineering: "Bugs, outages, errors and integrations", billing: "Charges, invoices, refunds and payments",
                    support: "Sign-in, account access and how-to questions" } },
            context: { ticket: "I was charged twice for order 1042 this morning. Please refund the duplicate charge." },
            minimum_probability: 0.8,
        },
        check: decision => {
            assert.equal(decision.questionType, "choice");
            assert.ok(["engineering", "billing", "support", "uncertain"].includes(decision.outcome));
            const sum = Object.values(decision.probabilities).reduce((total, value) => total + value, 0);
            assert.ok(Math.abs(sum - 1) < 0.05, `choice probabilities sum to ${sum}`);
            assert.equal(decision.selection, "billing", "a duplicate charge is a billing ticket");
        },
    },
    {
        name: "noul",
        arguments: {
            question: { type: "noul", instructions: "Does this reply promise the customer a refund?" },
            context: { reply: "Thanks for writing in. I have issued a full refund of $49.99 to your card; it will arrive within five business days." },
        },
        check: decision => {
            assert.equal(decision.questionType, "noul");
            assert.ok(decision.probability >= 0 && decision.probability <= 1);
            assert.ok(Math.abs(decision.probabilities.yes + decision.probabilities.no - 1) < 1e-9);
            assert.equal(decision.selection, "yes", "the reply promises a refund");
        },
    },
    {
        name: "score",
        arguments: {
            question: { type: "score", instructions: "How complete is this answer to the question 'What does photosynthesis produce?'",
                criteria: ["poor", "fair", "good", "excellent"] },
            context: { answer: "Photosynthesis uses light, water and carbon dioxide to produce glucose and release oxygen." },
        },
        check: decision => {
            assert.equal(decision.questionType, "score");
            assert.equal(decision.outcome, "scored");
            assert.ok(decision.score >= 0 && decision.score <= 3, `score ${decision.score}`);
            assert.deepEqual(decision.levels.map(level => level.label), ["poor", "fair", "good", "excellent"]);
        },
    },
];

test("decide answers choice, noul and score from the live Decision deployment, through the tool's own handler", async (t) => {
    const config = liveConfig();
    const live = liveHost(config);
    let calls = 0;
    const options = { sessionId: "live-decide", agentId: "live-qualification", host: live.host,
        readCatalog: createDecisionCatalogReader(live.host), countCall: () => ++calls };
    if (config.record) fs.mkdirSync(FIXTURES, { recursive: true });
    for (const item of CASES) {
        await t.test(item.name, async () => {
            const before = live.exchanges.length;
            const result = await runDecide(options, item.arguments, { toolCallId: `live-${item.name}-${Date.now()}` });
            assert.equal(live.exchanges.length, before + 1, "exactly one provider call");
            const exchange = live.exchanges.at(-1);
            assert.equal(result.ok, true, `${item.name}: ${JSON.stringify(result)} (HTTP ${exchange.status})`);
            assert.equal(result.model_source, "cluster_decision_default");
            assert.ok(result.usage === null || (result.usage.inputTokens > 0 && result.usage.outputTokens >= 0), JSON.stringify(result.usage));
            item.check(result.decision);
            // Nothing secret is logged or recorded: check the raw response before either.
            assert.ok(!exchange.responseText.includes(config.apiKey), "the response carries no key");
            const response = JSON.parse(exchange.responseText);
            assert.deepEqual(Object.keys(response).filter(key => !["model", "answers", "usage"].includes(key)), [],
                "the recorded response holds only model, answers and usage");
            console.info(`LIVE_DECIDE ${item.name} ${JSON.stringify({ status: exchange.status, latencyMs: result.latency_ms, usage: result.usage,
                answer: response.answers?.decision, outcome: result.decision.outcome })}`);
            if (config.record) {
                const fixture = {
                    note: "Recorded live from Microsoft Decision 1.1 by test/live/decide-tool.live.test.mjs; replayed by test/unit/decide-tool.test.mjs.",
                    recordedAt: new Date().toISOString(),
                    deployment: config.deployment,
                    arguments: item.arguments,
                    request: { ...exchange.request, model: config.deployment },
                    status: exchange.status,
                    response,
                };
                fs.writeFileSync(new URL(`${item.name}.json`, FIXTURES), `${JSON.stringify(fixture, null, 2)}\n`);
            }
        });
    }
    assert.equal(live.claims.size, CASES.length);
    assert.equal(live.settlements.length, CASES.length);
});
