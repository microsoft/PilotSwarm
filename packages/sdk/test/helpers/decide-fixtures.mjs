/**
 * Shared fixtures for the agent `decide` tool tests: a provider-type catalog with a Decision model, shared and personal
 * provider rows, a fake Decision host whose provider is the REAL adapter (createDecisionProvider) over an injected fetch,
 * and an in-memory ledger with the database's claim semantics (one claim per (operationId, attempt)).
 *
 * Provider bodies are either synthetic (shaped like the documented systemone protocol) or the recorded live bodies in
 * test/fixtures/decision-live/ (captured by test/live/decide-tool.live.test.mjs against Microsoft Decision 1.1).
 */
import { createDecisionProvider } from "../../dist/decision-provider.js";
import { loadProviderTypes, resolveRuntimeDecisionProvider } from "../../dist/provider-catalog.js";

export const BASE_URL = "https://foundry-decision.example.invalid/openai/v1";
export const DEPLOYMENT = "ps-decision-1-1";
export const QUALIFIED = `azure-openai:${DEPLOYMENT}`;
export const SPARE = "spare:ps-decision-1-1";
export const INSTANCE = "00000000-0000-4000-8000-000000000001";
export const SPARE_INSTANCE = "00000000-0000-4000-8000-000000000002";
export const PERSONAL_INSTANCE = "00000000-0000-4000-8000-000000000003";
export const UPDATED_AT = "2026-11-21T00:00:00.000Z";

export const TYPES = loadProviderTypes({ providers: [
    { id: "foundry-type", type: "openai", baseUrl: BASE_URL, apiKey: "type-test-key",
        models: ["chat-model"], decisionModels: [{ name: DEPLOYMENT }] },
], defaultModel: "foundry-type:chat-model" });

const row = (name, instanceId, over = {}) => ({
    name, instanceId, updatedAt: UPDATED_AT, typeId: "foundry-type", class: "shared", ownerUserId: null, baseUrl: null,
    secretRef: { kind: "apiKey", value: "instance-test-key" }, ...over,
});
export const ROWS = [
    row("azure-openai", INSTANCE),
    row("spare", SPARE_INSTANCE),
    row("mine", PERSONAL_INSTANCE, { class: "personal", ownerUserId: 7 }),
];
export const DEFAULT = { provider: "azure-openai", model: QUALIFIED, reasoning: null, context: null };
export const UNSET = { provider: null, model: null, reasoning: null, context: null };

export const CHOICE = {
    type: "choice",
    instructions: "Which team should handle this ticket?",
    criteria: { engineering: "Bugs, outages and integrations", billing: "Charges, invoices and refunds", support: "Sign-in and how-to questions" },
};
export const NOUL = { type: "noul", instructions: "Does this reply promise the customer a refund?" };
export const SCORE = { type: "score", instructions: "How complete is this answer?", criteria: ["poor", "fair", "good", "excellent"] };

/** Synthetic systemone bodies shaped like the documented protocol (not live captures). */
export const SYNTHETIC = {
    choice: { answers: { decision: { type: "choice", choice: "billing", probabilities: { engineering: 0.03, billing: 0.93, support: 0.04 } } },
        usage: { input_tokens: 412, output_tokens: 6 } },
    noul: { answers: { decision: { type: "noul", noul: 1.774475133117886e-6 } }, usage: { input_tokens: 233, output_tokens: 1 } },
    score: { answers: { decision: { type: "score", score: 2.37, probabilities: { 0: 0.01, 1: 0.07, 2: 0.42, 3: 0.5 } } },
        usage: { input_tokens: 120, output_tokens: 1 } },
};

/**
 * A Decision host for the tool and for runDecision: `state` is read on every call; `log` records each store call; `claims`
 * and `settlements` are the ledger; `requests` are the HTTP requests the real adapter made.
 */
export function fakeDecideHost(options = {}) {
    const state = {
        verdict: "clear", exempt: false, ownerUserId: 4101, decisionDefault: DEFAULT, rows: ROWS, body: SYNTHETIC.choice,
        status: 200, typesLoaded: true, admissionError: null, readError: null, providerTypeId: "foundry-type", delayMs: 0,
        ...options,
    };
    const log = [];
    const claims = new Map();
    const settlements = [];
    const requests = [];
    const providerStore = {
        async allCredentials() {
            log.push(["allCredentials"]);
            if (state.readError) throw state.readError;
            return state.rows;
        },
        async getClusterDecisionDefault() {
            log.push(["getClusterDecisionDefault"]);
            if (state.readError) throw state.readError;
            return state.decisionDefault;
        },
        async checkDecision(sessionId, model, providerInstanceId) {
            log.push(["checkDecision", sessionId, model, providerInstanceId]);
            if (state.admissionError) throw state.admissionError;
            const paying = state.verdict !== "no_provider";
            const instance = state.rows.find(candidate => candidate.instanceId === providerInstanceId);
            return {
                verdict: state.verdict,
                providerName: paying ? model.slice(0, model.indexOf(":")) : null,
                providerInstanceId: paying ? providerInstanceId : null,
                providerTypeId: paying ? state.providerTypeId : null,
                providerClass: paying ? "shared" : null,
                providerOwnerUserId: null,
                providerUpdatedAt: instance?.updatedAt ?? UPDATED_AT,
                ownerUserId: state.ownerUserId,
                modelQualified: paying ? model : null,
                exempt: state.exempt,
                pause: state.verdict === "paused" ? { kind: "limit" } : null,
                rules: [],
            };
        },
        async claimInferenceOperation(claim) {
            const key = `${claim.operationId}/${claim.attempt}`;
            log.push(["claim", key]);
            if (claims.has(key)) return false;
            claims.set(key, claim);
            return true;
        },
        async settleInferenceOperation(usage) {
            log.push(["settle", `${usage.operationId}/${usage.attempt}`]);
            settlements.push(usage);
            return true;
        },
    };
    const fetch = async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
        if (state.delayMs) {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, state.delayMs);
                init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
            });
        }
        return new Response(JSON.stringify(state.body), { status: state.status, headers: { "content-type": "application/json" } });
    };
    const providerFor = async (qualifiedModel, providerInstanceId, providerUpdatedAt) => {
        log.push(["providerFor", qualifiedModel, providerInstanceId]);
        const credential = state.rows.find(candidate => candidate.instanceId === providerInstanceId);
        const resolved = resolveRuntimeDecisionProvider(TYPES, credential, qualifiedModel, providerInstanceId, providerUpdatedAt);
        return resolved ? createDecisionProvider(resolved, { fetch }) : null;
    };
    return {
        state, log, claims, settlements, requests,
        host: { providerStore, providerFor, providerTypes: () => (state.typesLoaded ? TYPES : null) },
    };
}
