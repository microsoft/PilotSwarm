/**
 * RED contract for the Workflow Decision provider boundary (design v11: "Provider adapter and execution boundary",
 * "Confidence and result policy", "Semantic-only node output", "Runtime errors").
 *
 * Production code lives in packages/sdk/src/decision-provider.ts. It may keep the Foundry HTTP adapter in its own
 * module, but it re-exports everything below. This file loads dist/decision-provider.js dynamically, so a missing
 * module fails each test with one clear message instead of crashing the file.
 *
 *   qualifyDecisionProvider(resolved)          -> { qualified: true, endpoint, auth: "api-key" | "workload-identity" }
 *                                                 | { qualified: false, reason: "unsupported_base_url" | "unsupported_auth" }
 *   createDecisionProvider(resolved, { fetch?, getAccessToken? }) -> DecisionProvider; an unqualified provider throws
 *                                                 DecisionProviderError { code: "unavailable", reason } before any call
 *   provider.decide({ model, state, question, timeoutMs, signal })
 *                                              -> { answer, usage: { inputTokens, outputTokens } | null }
 *   applyDecisionPolicy({ question, confidence?, answer, model }) -> the semantic node output
 *   DecisionProviderError                      -> error with a Workflow runtime error code
 *
 * Official Microsoft-Decision-1.1 contract pinned by the parent task:
 *   POST <resource-root>/providers/microsoft/v1/systemone
 *   request  { model: <deployment>, state: <Json>, questions: { decision: <question> } }
 *   response { answers: { decision: { type, choice|noul|score, probabilities, legend? } }, model,
 *              usage: { input_tokens, output_tokens } }
 *
 * Details the public documentation does not show are pinned here as test expectations and must be confirmed by the
 * separate live qualification probe: noul probabilities use the keys "true" and "false"; score probabilities use the
 * level indexes "0".."n-1"; a score legend is an index-keyed object or an array of labels.
 *
 * Every provider call goes through an injected fetch fixture. No test reaches a network.
 *
 * Run from the repository root after npm run build --workspace=packages/sdk:
 *   node --test packages/sdk/test/unit/workflow-decision-provider.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { loadProviderTypes, resolveDecisionProviderCredential } from "../../dist/provider-catalog.js";
import { FOUNDRY_AAD_SCOPE, _setFoundryAadCredentialForTests } from "../../dist/foundry-credentials.js";

const DECISION_PROVIDER_MODULE = new URL("../../dist/decision-provider.js", import.meta.url);
const EXPORTS = ["qualifyDecisionProvider", "createDecisionProvider", "applyDecisionPolicy", "DecisionProviderError"];
let loading;

async function decisionApi() {
    loading ??= import(DECISION_PROVIDER_MODULE.href).then(module => ({ module }), error => ({ error }));
    const { module, error } = await loading;
    if (error) assert.fail(`dist/decision-provider.js must exist and load: ${error.message}`);
    for (const name of EXPORTS) assert.equal(typeof module[name], "function", `decision-provider must export ${name}`);
    return module;
}

const ROOT = "https://foundry-decision.example.invalid";
const BASE_URL = `${ROOT}/openai/v1`;
const ENDPOINT = `${ROOT}/providers/microsoft/v1/systemone`;
const DEPLOYMENT = "ps-decision-1-1";
const QUALIFIED = "azure-foundry:ps-decision-1-1";
const TYPE_KEY = "type-test-key";
const INSTANCE_KEY = "instance-test-key";
const INJECTED_TOKEN = "wif-injected-test-token";
const HELPER_TOKEN = "wif-helper-test-token";
const REQUEST_ID = "req-sentinel-0c7e";
const SERVED_MODEL = "microsoft-decision-1.1";
const SECRETS = [TYPE_KEY, INSTANCE_KEY, INJECTED_TOKEN, HELPER_TOKEN];

// Question shapes are the compiled WorkflowIRDecisionQuestion shapes (workflow-decision-compile.test.mjs).
const CHOICE = {
    type: "choice",
    instructions: "Which team should handle this ticket?",
    criteria: {
        engineering: "Bugs, errors, and outages",
        billing: "Charges, invoices, and refunds",
        support: "How-to and account questions",
    },
};
const NOUL = {
    type: "noul",
    instructions: "Does this reply promise the customer a refund?",
    criteria: { true: "Commits to returning money", false: "Makes no commitment about money" },
};
const NOUL_PLAIN = { type: "noul", instructions: "Has the customer contacted support before?" };
const SCORE = {
    type: "score",
    instructions: "How severe is this incident?",
    criteria: ["Cosmetic", "Minor", "Major", "Critical"],
};

// Billing is selected although support has the largest probability.
const CHOICE_ANSWER = { type: "choice", choice: "billing", probabilities: { engineering: 0.3, billing: 0.25, support: 0.45 } };
const NOUL_ANSWER = { type: "noul", noul: 0.83, probabilities: { true: 0.83, false: 0.17 } };
// The probability-weighted level index is 2.41; the provider's own score (2.37) must survive unchanged.
const SCORE_ANSWER = { type: "score", score: 2.37, probabilities: { 0: 0.01, 1: 0.07, 2: 0.42, 3: 0.5 } };
const SCORE_LEVELS = [
    { label: "Cosmetic", probability: 0.01 },
    { label: "Minor", probability: 0.07 },
    { label: "Major", probability: 0.42 },
    { label: "Critical", probability: 0.5 },
];

const INFINITY = "__INFINITY__";
/** JSON text where a sentinel string becomes 1e999, which JSON.parse reads as Infinity. */
const withInfinity = body => JSON.stringify(body).replace(`"${INFINITY}"`, "1e999");

function omit(object, key) {
    const copy = { ...object };
    delete copy[key];
    return copy;
}

function spy(impl) {
    const fn = async (...args) => {
        fn.calls += 1;
        return impl(...args);
    };
    fn.calls = 0;
    return fn;
}

function allKeys(value, into = new Set()) {
    if (Array.isArray(value)) for (const item of value) allKeys(item, into);
    else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
            into.add(key);
            allKeys(child, into);
        }
    }
    return into;
}

function providerBody(answer, extra = {}) {
    return {
        id: REQUEST_ID,
        model: SERVED_MODEL,
        answers: { decision: answer },
        usage: { input_tokens: 412, output_tokens: 1 },
        ...extra,
    };
}

/** A reply factory: every call gets a fresh Response carrying request-id headers that must never leak. */
function reply(status, body, headers = {}) {
    return () => new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "x-request-id": REQUEST_ID, "apim-request-id": REQUEST_ID, ...headers },
    });
}
const ok = body => reply(200, body);

/** A fetch double that records the parsed request and answers from the reply list (the last reply repeats). */
function fetchFixture(...replies) {
    const calls = [];
    async function fetch(input, init) {
        let request;
        try {
            request = new Request(input, init);
        } catch (error) {
            throw new Error(`fixture: the adapter built an invalid request: ${error.message}`);
        }
        calls.push({
            url: request.url,
            method: request.method,
            headers: request.headers,
            bodyText: await request.text(),
            signal: request.signal,
        });
        return replies[Math.min(calls.length - 1, replies.length - 1)](request);
    }
    return { fetch, calls };
}

/** Never answers; rejects as real fetch does once the request's signal aborts. */
function waitForAbort(request) {
    return new Promise((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error("fixture: the adapter never aborted the request")), 3_000);
        const abort = () => {
            clearTimeout(guard);
            reject(request.signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
        };
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
    });
}

const networkFailure = code => () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code} 10.0.0.4:443`), { code }) });
};

/** A shared runtime instance with its own key, resolved by the real Decision credential path. */
function keyProvider() {
    const types = loadProviderTypes({ providers: [{
        id: "foundry-type", type: "openai", baseUrl: BASE_URL, apiKey: TYPE_KEY, decisionModels: [{ name: DEPLOYMENT }],
    }] });
    const resolved = resolveDecisionProviderCredential(types, {
        name: "azure-foundry", typeId: "foundry-type", class: "shared", ownerUserId: null, baseUrl: null,
        secretRef: { kind: "apiKey", value: INSTANCE_KEY },
    }, DEPLOYMENT);
    assert.ok(resolved, "fixture: the keyed instance must resolve");
    assert.equal(resolved.sdkProvider.apiKey, INSTANCE_KEY, "fixture: the instance key wins over the type key");
    return resolved;
}

/** A foundry-wif type with a trailing slash on its base, resolved with workload identity and no key. */
function wifProvider() {
    const registry = new ModelProviderRegistry({ providers: [{
        id: "azure-foundry", type: "foundry-wif", baseUrl: `${BASE_URL}/`, decisionModels: [{ name: DEPLOYMENT }],
    }] });
    const resolved = registry.resolveDecision(QUALIFIED);
    assert.equal(resolved?.usesWorkloadIdentity, true, "fixture: foundry-wif resolves with workload identity");
    assert.equal(Object.hasOwn(resolved.sdkProvider, "apiKey"), false, "fixture: workload identity carries no key");
    return resolved;
}

function azureDeploymentsProvider() {
    const registry = new ModelProviderRegistry({ providers: [{
        id: "azure-openai", type: "azure", baseUrl: `${ROOT}/openai`, apiKey: TYPE_KEY, decisionModels: [{ name: DEPLOYMENT }],
    }] });
    return registry.resolveDecision(`azure-openai:${DEPLOYMENT}`);
}

function anthropicWifProvider() {
    const registry = new ModelProviderRegistry({ providers: [{
        id: "anthropic-wif", type: "anthropic-wif", baseUrl: BASE_URL, decisionModels: [{ name: DEPLOYMENT }],
    }] });
    return registry.resolveDecision(`anthropic-wif:${DEPLOYMENT}`);
}

const withBaseUrl = (resolved, baseUrl) => ({ ...resolved, sdkProvider: { ...resolved.sdkProvider, baseUrl } });

function decideWith(provider, question, over = {}) {
    return provider.decide({
        model: DEPLOYMENT,
        state: { message: "Checkout is down again. This is my third request.", customer_contact_count: 3 },
        question,
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        ...over,
    });
}

async function rejectsWithCode(run, code, label) {
    const { DecisionProviderError } = await decisionApi();
    await assert.rejects(run, error => {
        assert.ok(error instanceof DecisionProviderError,
            `${label}: expected a DecisionProviderError, got ${error?.name}: ${error?.message}`);
        assert.equal(error.code, code, `${label}: ${error.message}`);
        for (const secret of SECRETS) {
            assert.equal(String(error.message).includes(secret), false, `${label}: the error message must not carry a credential`);
        }
        return true;
    });
}

async function answerFor(question, body) {
    const { createDecisionProvider } = await decisionApi();
    const fixture = fetchFixture(ok(body));
    const result = await decideWith(createDecisionProvider(keyProvider(), { fetch: fixture.fetch }), question);
    assert.equal(fixture.calls.length, 1);
    return result;
}

test("the Foundry adapter posts one exact systemone request to the root derived from /openai/v1", async () => {
    const { createDecisionProvider, qualifyDecisionProvider } = await decisionApi();
    const resolved = keyProvider();
    assert.deepEqual(qualifyDecisionProvider(resolved), { qualified: true, endpoint: ENDPOINT, auth: "api-key" });

    const fixture = fetchFixture(ok(providerBody(CHOICE_ANSWER)));
    const provider = createDecisionProvider(resolved, { fetch: fixture.fetch });
    const state = { message: "The API returns 500 on every call.", customer: { tier: "gold", contacts: 3 }, note: "naïve ✓" };
    await decideWith(provider, CHOICE, { state });

    assert.equal(fixture.calls.length, 1);
    const [call] = fixture.calls;
    assert.equal(call.method, "POST");
    assert.equal(call.url, ENDPOINT);
    assert.match(call.headers.get("content-type") ?? "", /^application\/json\b/i);
    assert.deepEqual(JSON.parse(call.bodyText), { model: DEPLOYMENT, state, questions: { decision: CHOICE } });
});

test("every question type is sent unchanged under questions.decision with text or JSON state", async () => {
    const { createDecisionProvider } = await decisionApi();
    const pairs = [[CHOICE, CHOICE_ANSWER], [NOUL, NOUL_ANSWER], [NOUL_PLAIN, NOUL_ANSWER], [SCORE, SCORE_ANSWER]];
    const states = ["The API returns 500 on every call.", { message: "Checkout is down", contacts: 3 }, ["a", 1, null, true]];
    for (const [question, answer] of pairs) {
        for (const state of states) {
            const fixture = fetchFixture(ok(providerBody(answer)));
            await decideWith(createDecisionProvider(keyProvider(), { fetch: fixture.fetch }), question, { state });
            assert.equal(fixture.calls.length, 1);
            assert.deepEqual(JSON.parse(fixture.calls[0].bodyText),
                { model: DEPLOYMENT, state, questions: { decision: question } },
                `${question.type} with ${JSON.stringify(state)}`);
        }
    }
});

test("the root requires a base ending in /openai/v1 and strips exactly one trailing slash", async () => {
    const { qualifyDecisionProvider } = await decisionApi();
    const key = keyProvider();
    for (const [baseUrl, endpoint] of [
        [BASE_URL, ENDPOINT],
        [`${BASE_URL}/`, ENDPOINT],
        ["https://gateway.example.invalid/tenant-a/openai/v1", "https://gateway.example.invalid/tenant-a/providers/microsoft/v1/systemone"],
    ]) {
        assert.deepEqual(qualifyDecisionProvider(withBaseUrl(key, baseUrl)),
            { qualified: true, endpoint, auth: "api-key" }, baseUrl);
    }
    assert.deepEqual(qualifyDecisionProvider(wifProvider()),
        { qualified: true, endpoint: ENDPOINT, auth: "workload-identity" }, "a foundry-wif base with one trailing slash");

    for (const baseUrl of [
        `${BASE_URL}//`,
        `${ROOT}/openai`,
        `${ROOT}/openai/v2`,
        `${ROOT}/openai/v1/chat/completions`,
        `${ROOT}/openai/v1?api-version=2024-10-21`,
        `${ROOT}/openai/deployments/${DEPLOYMENT}`,
        `${ROOT}/v1`,
        ROOT,
        "",
    ]) {
        assert.deepEqual(qualifyDecisionProvider(withBaseUrl(key, baseUrl)),
            { qualified: false, reason: "unsupported_base_url" }, JSON.stringify(baseUrl));
    }
});

test("choice keeps the selected label and every probability unsorted, even when another label is larger", async () => {
    const result = await answerFor(CHOICE, providerBody(CHOICE_ANSWER));
    assert.deepEqual(result.answer, {
        questionType: "choice",
        selection: "billing",
        probabilities: { engineering: 0.3, billing: 0.25, support: 0.45 },
    });
    assert.deepEqual(Object.keys(result.answer.probabilities), ["engineering", "billing", "support"],
        "the distribution is not re-sorted by probability");

    for (const probabilities of [
        { engineering: 0.333, billing: 0.333, support: 0.333 },
        { engineering: 1, billing: 0, support: 0 },
    ]) {
        const selection = Object.keys(probabilities).at(-1);
        const rounded = await answerFor(CHOICE, providerBody({ type: "choice", choice: selection, probabilities }));
        assert.deepEqual(rounded.answer, { questionType: "choice", selection, probabilities }, JSON.stringify(probabilities));
    }
});

test("noul exposes p from 0 to 1 and the provider's yes and no probabilities", async () => {
    for (const [answer, expected] of [
        [NOUL_ANSWER, { questionType: "noul", probability: 0.83, probabilities: { yes: 0.83, no: 0.17 } }],
        [{ type: "noul", noul: 0, probabilities: { true: 0, false: 1 } },
            { questionType: "noul", probability: 0, probabilities: { yes: 0, no: 1 } }],
        [{ type: "noul", noul: 1, probabilities: { true: 1, false: 0 } },
            { questionType: "noul", probability: 1, probabilities: { yes: 1, no: 0 } }],
    ]) {
        for (const question of [NOUL, NOUL_PLAIN]) {
            const result = await answerFor(question, providerBody(answer));
            assert.deepEqual(result.answer, expected, JSON.stringify(answer));
        }
    }
});

test("score keeps the provider score and orders level probabilities by criteria or a matching legend", async () => {
    for (const legend of [
        undefined,
        { 0: "Cosmetic", 1: "Minor", 2: "Major", 3: "Critical" },
        ["Cosmetic", "Minor", "Major", "Critical"],
    ]) {
        const answer = legend === undefined ? SCORE_ANSWER : { ...SCORE_ANSWER, legend };
        const result = await answerFor(SCORE, providerBody(answer));
        assert.deepEqual(result.answer, { questionType: "score", score: 2.37, levels: SCORE_LEVELS },
            `legend ${JSON.stringify(legend)}: the score is not re-derived`);
    }
    for (const score of [0, 3]) {
        const result = await answerFor(SCORE, providerBody({ ...SCORE_ANSWER, score }));
        assert.equal(result.answer.score, score, `score ${score} is inside the level-index range`);
    }
});

test("a malformed, missing, extra, or out-of-range response shape is invalid_output after one call", async () => {
    const { createDecisionProvider } = await decisionApi();
    const choice = over => providerBody({ ...CHOICE_ANSWER, ...over });
    const noul = over => providerBody({ ...NOUL_ANSWER, ...over });
    const score = over => providerBody({ ...SCORE_ANSWER, ...over });
    const cases = [
        ["a non-JSON body", CHOICE, "<html>upstream gateway</html>"],
        ["a truncated JSON body", CHOICE, "{\"answers\":"],
        ["JSON null", CHOICE, "null"],
        ["a JSON array", CHOICE, "[]"],
        ["no answers", CHOICE, { model: SERVED_MODEL, usage: { input_tokens: 4, output_tokens: 1 } }],
        ["answers as an array", CHOICE, { answers: [CHOICE_ANSWER], model: SERVED_MODEL }],
        ["no decision answer", CHOICE, { answers: {}, model: SERVED_MODEL }],
        ["an extra answer", CHOICE, { answers: { decision: CHOICE_ANSWER, other: CHOICE_ANSWER }, model: SERVED_MODEL }],
        ["a null decision answer", CHOICE, { answers: { decision: null }, model: SERVED_MODEL }],
        ["an answer type unlike the question", CHOICE, providerBody(NOUL_ANSWER)],
        ["a missing answer type", CHOICE, providerBody(omit(CHOICE_ANSWER, "type"))],
        ["no selected choice", CHOICE, providerBody(omit(CHOICE_ANSWER, "choice"))],
        ["an undeclared choice", CHOICE, choice({ choice: "legal" })],
        ["a non-string choice", CHOICE, choice({ choice: 1 })],
        ["no choice probabilities", CHOICE, providerBody(omit(CHOICE_ANSWER, "probabilities"))],
        ["choice probabilities as an array", CHOICE, choice({ probabilities: [0.3, 0.25, 0.45] })],
        ["a declared option without a probability", CHOICE, choice({ probabilities: { engineering: 0.55, billing: 0.45 } })],
        ["an extra option", CHOICE, choice({ probabilities: { ...CHOICE_ANSWER.probabilities, legal: 0 } })],
        ["a choice probability above 1", CHOICE, choice({ probabilities: { engineering: 1.2, billing: 0.25, support: 0.45 } })],
        ["a negative choice probability", CHOICE, choice({ probabilities: { engineering: -0.1, billing: 0.25, support: 0.45 } })],
        ["a string choice probability", CHOICE, choice({ probabilities: { engineering: "0.3", billing: 0.25, support: 0.45 } })],
        ["a null choice probability", CHOICE, choice({ probabilities: { engineering: null, billing: 0.25, support: 0.45 } })],
        ["an infinite choice probability", CHOICE,
            withInfinity(choice({ probabilities: { engineering: INFINITY, billing: 0.25, support: 0.45 } }))],
        ["no noul p", NOUL, providerBody(omit(NOUL_ANSWER, "noul"))],
        ["a noul p above 1", NOUL, noul({ noul: 1.01 })],
        ["a negative noul p", NOUL, noul({ noul: -0.01 })],
        ["a string noul p", NOUL, noul({ noul: "0.83" })],
        ["an infinite noul p", NOUL, withInfinity(noul({ noul: INFINITY }))],
        ["no noul probabilities", NOUL, providerBody(omit(NOUL_ANSWER, "probabilities"))],
        ["a noul distribution without false", NOUL, noul({ probabilities: { true: 0.83 } })],
        ["a noul distribution with an extra key", NOUL, noul({ probabilities: { true: 0.83, false: 0.17, maybe: 0 } })],
        ["a noul probability above 1", NOUL, noul({ probabilities: { true: 0.83, false: 1.17 } })],
        ["no score", SCORE, providerBody(omit(SCORE_ANSWER, "score"))],
        ["a string score", SCORE, score({ score: "2.37" })],
        ["an infinite score", SCORE, withInfinity(score({ score: INFINITY }))],
        ["a score below the first level index", SCORE, score({ score: -0.01 })],
        ["a score above the last level index", SCORE, score({ score: 3.01 })],
        ["no score probabilities", SCORE, providerBody(omit(SCORE_ANSWER, "probabilities"))],
        ["a level without a probability", SCORE, score({ probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } })],
        ["an extra level", SCORE, score({ probabilities: { ...SCORE_ANSWER.probabilities, 4: 0 } })],
        ["levels keyed by label instead of index", SCORE,
            score({ probabilities: { Cosmetic: 0.01, Minor: 0.07, Major: 0.42, Critical: 0.5 } })],
        ["a level probability above 1", SCORE, score({ probabilities: { 0: 0.01, 1: 0.07, 2: 0.42, 3: 1.5 } })],
        ["a legend naming other levels", SCORE, score({ legend: { 0: "Low", 1: "Minor", 2: "Major", 3: "Critical" } })],
        ["a legend in another order", SCORE, score({ legend: ["Critical", "Major", "Minor", "Cosmetic"] })],
    ];
    for (const [label, question, body] of cases) {
        const fixture = fetchFixture(ok(body));
        const provider = createDecisionProvider(keyProvider(), { fetch: fixture.fetch });
        await rejectsWithCode(() => decideWith(provider, question), "invalid_output", label);
        assert.equal(fixture.calls.length, 1, `${label}: no retry`);
    }
});

test("decide returns semantic answer and usage plus only an internal HTTP status-class hint", async () => {
    const result = await answerFor(CHOICE, providerBody(CHOICE_ANSWER, { usage: { input_tokens: 412, output_tokens: 0 } }));
    assert.deepEqual(result.answer, {
        questionType: "choice", selection: "billing", probabilities: { engineering: 0.3, billing: 0.25, support: 0.45 },
    });
    assert.deepEqual(result.usage, { inputTokens: 412, outputTokens: 0 }, "zero output tokens is a settled count");
    assert.deepEqual(result.telemetry, { httpStatusClass: "2xx" });
    const keys = allKeys(result);
    for (const forbidden of [
        "id", "requestId", "request_id", "status", "statusCode", "httpStatus", "headers", "answers", "input_tokens", "output_tokens",
    ]) {
        assert.equal(keys.has(forbidden), false, `${forbidden} must not leave the adapter`);
    }
    const text = JSON.stringify(result);
    for (const leaked of [REQUEST_ID, ...SECRETS]) assert.equal(text.includes(leaked), false, `${leaked} must not leave the adapter`);
    assert.equal(JSON.stringify(result.answer).includes(SERVED_MODEL), false, "the served model is not part of the answer");

    for (const [label, extra, usage] of [
        ["a normal count", { usage: { input_tokens: 412, output_tokens: 1 } }, { inputTokens: 412, outputTokens: 1 }],
        ["no output tokens", { usage: { input_tokens: 37, output_tokens: 0 } }, { inputTokens: 37, outputTokens: 0 }],
        ["no usage", { usage: undefined }, null],
        ["null usage", { usage: null }, null],
        ["a negative count", { usage: { input_tokens: -1, output_tokens: 1 } }, null],
        ["a fractional count", { usage: { input_tokens: 1.5, output_tokens: 1 } }, null],
        ["a string count", { usage: { input_tokens: "12", output_tokens: 1 } }, null],
        ["a missing output count", { usage: { input_tokens: 12 } }, null],
    ]) {
        const each = await answerFor(NOUL, providerBody(NOUL_ANSWER, extra));
        assert.deepEqual(each.usage, usage, `${label}: usage is normalized, and unknown usage is null`);
        assert.equal(each.answer.questionType, "noul", `${label}: usage never invalidates a valid answer`);
    }
});

test("HTTP and transport failures map to runtime codes after exactly one call", async () => {
    const { createDecisionProvider } = await decisionApi();
    const failure = (status, code) => ({ error: { code, message: `fixture ${status}` } });
    const cases = [
        ["401", reply(401, failure(401, "Unauthorized")), "forbidden"],
        ["403", reply(403, failure(403, "PermissionDenied")), "forbidden"],
        ["404", reply(404, failure(404, "NotFound")), "unavailable"],
        ["422", reply(422, failure(422, "UnsupportedModel")), "unavailable"],
        ["429", reply(429, failure(429, "TooManyRequests"), { "retry-after": "1" }), "unavailable"],
        ["500", reply(500, failure(500, "InternalServerError")), "unavailable"],
        ["502", reply(502, failure(502, "BadGateway")), "unavailable"],
        ["503 with an HTML body", reply(503, "<html>Service Unavailable</html>", { "content-type": "text/html" }), "unavailable"],
        ["504", reply(504, failure(504, "GatewayTimeout")), "unavailable"],
        ["400, outside the mapping", reply(400, failure(400, "BadRequest")), "execution_failed"],
        ["connection refused", networkFailure("ECONNREFUSED"), "unavailable"],
        ["connection reset", networkFailure("ECONNRESET"), "unavailable"],
        ["a malformed 200", reply(200, "{\"answers\":"), "invalid_output"],
        ["an unexpected error", () => { throw new Error("fixture: unexpected failure"); }, "execution_failed"],
    ];
    for (const [label, answer, code] of cases) {
        const fixture = fetchFixture(answer);
        const provider = createDecisionProvider(keyProvider(), { fetch: fixture.fetch });
        await rejectsWithCode(() => decideWith(provider, CHOICE), code, label);
        assert.equal(fixture.calls.length, 1, `${label}: no retry`);
    }
});

test("the adapter exposes only the HTTP status class for provider-call telemetry", async () => {
    const { createDecisionProvider, DecisionProviderError } = await decisionApi();
    for (const [answer, code, statusClass] of [
        [reply(401, { error: { requestId: REQUEST_ID } }), "forbidden", "4xx"],
        [reply(503, "PRIVATE_PROVIDER_BODY"), "unavailable", "5xx"],
        [reply(200, "{\"answers\":"), "invalid_output", "2xx"],
    ]) {
        const fixture = fetchFixture(answer);
        const provider = createDecisionProvider(keyProvider(), { fetch: fixture.fetch });
        let rejected;
        await assert.rejects(() => decideWith(provider, CHOICE), error => {
            assert.ok(error instanceof DecisionProviderError);
            assert.equal(error.code, code);
            rejected = error;
            return true;
        });
        assert.deepEqual(rejected.telemetry, { httpStatusClass: statusClass });
        assert.doesNotMatch(JSON.stringify(rejected.telemetry), /REQUEST|PRIVATE|headers|endpoint|token/i);
        assert.equal(fixture.calls.length, 1);
    }
});

test("the adapter's own timeout aborts the call as timed_out with no retry", { timeout: 10_000 }, async () => {
    const { createDecisionProvider } = await decisionApi();
    const fixture = fetchFixture(waitForAbort);
    const provider = createDecisionProvider(keyProvider(), { fetch: fixture.fetch });
    await rejectsWithCode(() => decideWith(provider, CHOICE, { timeoutMs: 25 }), "timed_out", "timeoutMs elapsed");
    assert.equal(fixture.calls.length, 1, "no retry after a timeout");
    assert.equal(fixture.calls[0].signal.aborted, true, "the request itself was aborted");
});

test("a caller deadline reaches the call through its signal and maps to timed_out", { timeout: 10_000 }, async () => {
    const { createDecisionProvider } = await decisionApi();
    const controller = new AbortController();
    const fixture = fetchFixture(request => {
        setTimeout(() => controller.abort(new DOMException("The node deadline passed", "TimeoutError")), 0);
        return waitForAbort(request);
    });
    const provider = createDecisionProvider(keyProvider(), { fetch: fixture.fetch });
    await rejectsWithCode(() => decideWith(provider, CHOICE, { signal: controller.signal }), "timed_out", "caller deadline");
    assert.equal(fixture.calls.length, 1, "no retry after a deadline");
    assert.equal(fixture.calls[0].signal.aborted, true, "the caller's signal reached the request");
});

test("a provider-instance key is sent as api-key, never as a bearer token or a workload identity", async () => {
    const { createDecisionProvider } = await decisionApi();
    const fixture = fetchFixture(ok(providerBody(CHOICE_ANSWER)));
    const getAccessToken = spy(async () => INJECTED_TOKEN);
    await decideWith(createDecisionProvider(keyProvider(), { fetch: fixture.fetch, getAccessToken }), CHOICE);
    const [call] = fixture.calls;
    assert.equal(call.headers.get("api-key"), INSTANCE_KEY);
    assert.equal(call.headers.has("authorization"), false);
    assert.equal(getAccessToken.calls, 0, "a key provider never falls back to workload identity");
});

test("workload identity sends a bearer token from injected getAccessToken for each call and never an api-key", async () => {
    const { createDecisionProvider } = await decisionApi();
    const fixture = fetchFixture(ok(providerBody(NOUL_ANSWER)));
    const getAccessToken = spy(async () => INJECTED_TOKEN);
    const provider = createDecisionProvider(wifProvider(), { fetch: fixture.fetch, getAccessToken });
    await decideWith(provider, NOUL);
    await decideWith(provider, NOUL);
    assert.equal(fixture.calls.length, 2);
    assert.equal(getAccessToken.calls, 2, "one token request per provider call");
    for (const call of fixture.calls) {
        assert.equal(call.url, ENDPOINT);
        assert.equal(call.headers.get("authorization"), `Bearer ${INJECTED_TOKEN}`);
        assert.equal(call.headers.has("api-key"), false);
    }
});

test("workload identity without an injected token source uses the Foundry credential helper", async t => {
    const { createDecisionProvider } = await decisionApi();
    const scopes = [];
    _setFoundryAadCredentialForTests({
        async getToken(scope) {
            scopes.push(scope);
            return { token: HELPER_TOKEN, expiresOnTimestamp: Date.now() + 3_600_000 };
        },
    });
    t.after(() => _setFoundryAadCredentialForTests(null));
    const fixture = fetchFixture(ok(providerBody(SCORE_ANSWER)));
    await decideWith(createDecisionProvider(wifProvider(), { fetch: fixture.fetch }), SCORE);
    assert.deepEqual(scopes, [FOUNDRY_AAD_SCOPE]);
    assert.equal(fixture.calls[0].headers.get("authorization"), `Bearer ${HELPER_TOKEN}`);
    assert.equal(fixture.calls[0].headers.has("api-key"), false);
});

test("a workload-identity token failure makes no call and falls back to nothing", async () => {
    const { createDecisionProvider } = await decisionApi();
    const fixture = fetchFixture(ok(providerBody(CHOICE_ANSWER)));
    const provider = createDecisionProvider(wifProvider(), {
        fetch: fixture.fetch,
        getAccessToken: async () => { throw new Error("fixture: no federated token"); },
    });
    await rejectsWithCode(() => decideWith(provider, CHOICE), "execution_failed", "token failure");
    assert.equal(fixture.calls.length, 0);
});

test("an unsupported base or credential fails qualification and creation with no fallback", async () => {
    const { qualifyDecisionProvider, createDecisionProvider, DecisionProviderError } = await decisionApi();
    const key = keyProvider();
    const cases = [
        ["a non-Foundry OpenAI base", withBaseUrl(key, "https://api.openai.example.invalid/v1"), "unsupported_base_url"],
        ["two trailing slashes", withBaseUrl(key, `${BASE_URL}//`), "unsupported_base_url"],
        ["no credential", { ...key, sdkProvider: omit(key.sdkProvider, "apiKey") }, "unsupported_auth"],
        ["an empty key", { ...key, sdkProvider: { ...key.sdkProvider, apiKey: "" } }, "unsupported_auth"],
        ["an Azure deployments base", azureDeploymentsProvider(), undefined],
        ["a non-Foundry workload identity", anthropicWifProvider(), undefined],
        ["a GitHub provider", { providerId: "github-copilot", type: "github", modelName: DEPLOYMENT, githubToken: "gho-test" }, undefined],
    ];
    for (const [label, resolved, reason] of cases) {
        assert.ok(resolved, `${label}: fixture must resolve`);
        const verdict = qualifyDecisionProvider(resolved);
        if (reason) assert.deepEqual(verdict, { qualified: false, reason }, label);
        else {
            assert.equal(verdict.qualified, false, label);
            assert.ok(["unsupported_base_url", "unsupported_auth"].includes(verdict.reason), `${label}: ${verdict.reason}`);
        }
        const fetch = spy(async () => { throw new Error("fixture: no call expected"); });
        const getAccessToken = spy(async () => INJECTED_TOKEN);
        assert.throws(() => createDecisionProvider(resolved, { fetch, getAccessToken }), error => {
            assert.ok(error instanceof DecisionProviderError, `${label}: ${error?.name}: ${error?.message}`);
            assert.equal(error.code, "unavailable", label);
            assert.equal(error.reason, verdict.reason, label);
            return true;
        });
        assert.equal(fetch.calls, 0, `${label}: no provider call`);
        assert.equal(getAccessToken.calls, 0, `${label}: no token request`);
    }
});

test("choice policy: confidence is the selected probability; below the threshold is uncertain; equality is not", async () => {
    const { applyDecisionPolicy } = await decisionApi();
    const policy = (answer, confidence) => {
        const before = structuredClone(answer);
        const output = applyDecisionPolicy({ question: CHOICE, confidence, answer, model: QUALIFIED });
        assert.deepEqual(answer, before, "the policy does not mutate the answer");
        return output;
    };
    const designExample = { questionType: "choice", selection: "engineering", probabilities: { engineering: 0.93, billing: 0.04, support: 0.03 } };
    assert.deepEqual(policy(designExample, { minimumProbability: 0.8 }), {
        questionType: "choice",
        outcome: "engineering",
        selection: "engineering",
        confidence: 0.93,
        probabilities: { engineering: 0.93, billing: 0.04, support: 0.03 },
        policy: { minimumProbability: 0.8, uncertain: false },
        model: { qualified: QUALIFIED },
    });

    const notLargest = { questionType: "choice", selection: "billing", probabilities: { engineering: 0.3, billing: 0.25, support: 0.45 } };
    const envelope = (outcome, minimumProbability, uncertain, answer = notLargest) => ({
        questionType: "choice",
        outcome,
        selection: answer.selection,
        confidence: answer.probabilities[answer.selection],
        probabilities: answer.probabilities,
        policy: { minimumProbability, uncertain },
        model: { qualified: QUALIFIED },
    });
    assert.deepEqual(policy(notLargest, { minimumProbability: 0.3 }), envelope("uncertain", 0.3, true));
    assert.deepEqual(policy(notLargest, { minimumProbability: 0.2 }), envelope("billing", 0.2, false),
        "the selected label routes even though support is larger");
    assert.deepEqual(policy(notLargest, { minimumProbability: 0.25 }), envelope("billing", 0.25, false), "equality is not uncertain");
    assert.deepEqual(policy(notLargest, undefined), envelope("billing", null, false), "no threshold never routes uncertain");

    const certain = { questionType: "choice", selection: "support", probabilities: { engineering: 0, billing: 0, support: 1 } };
    assert.deepEqual(policy(certain, { minimumProbability: 1 }), envelope("support", 1, false, certain));
    const impossible = { questionType: "choice", selection: "engineering", probabilities: { engineering: 0, billing: 0.5, support: 0.5 } };
    assert.deepEqual(policy(impossible, { minimumProbability: 0 }), envelope("engineering", 0, false, impossible));
});

test("noul policy: yes at p >= 0.5, confidence max(p, 1-p), threshold equality is not uncertain", async () => {
    const { applyDecisionPolicy } = await decisionApi();
    const answer = p => ({ questionType: "noul", probability: p, probabilities: { yes: p, no: 1 - p } });
    const expected = (p, selection, confidence, outcome, minimumProbability, uncertain) => ({
        questionType: "noul",
        outcome,
        selection,
        confidence,
        probability: p,
        probabilities: { yes: p, no: 1 - p },
        policy: { minimumProbability, uncertain },
        model: { qualified: QUALIFIED },
    });
    for (const [p, confidence, selection, outcome, minimumProbability, uncertain] of [
        [0.75, 0.75, "yes", "yes", 0.75, false],
        [0.5, 0.5, "yes", "uncertain", 0.75, true],
        [0.25, 0.75, "no", "no", 0.75, false],
        [0.125, 0.875, "no", "uncertain", 0.9, true],
        [0.5, 0.5, "yes", "yes", null, false],
        [0, 1, "no", "no", 1, false],
    ]) {
        const input = answer(p);
        const before = structuredClone(input);
        const output = applyDecisionPolicy({
            question: NOUL,
            confidence: minimumProbability === null ? undefined : { minimumProbability },
            answer: input,
            model: QUALIFIED,
        });
        assert.deepEqual(output, expected(p, selection, confidence, outcome, minimumProbability, uncertain),
            `p=${p} threshold=${minimumProbability}`);
        assert.deepEqual(input, before, "the policy does not mutate the answer");
    }
});

test("score policy always routes scored and keeps the semantic score and levels unchanged", async () => {
    const { applyDecisionPolicy } = await decisionApi();
    const flat = SCORE_LEVELS.map(level => ({ ...level, probability: 0.25 }));
    for (const [score, levels] of [[2.37, SCORE_LEVELS], [1.5, flat], [0, SCORE_LEVELS]]) {
        const input = { questionType: "score", score, levels };
        const before = structuredClone(input);
        assert.deepEqual(applyDecisionPolicy({ question: SCORE, answer: input, model: QUALIFIED }), {
            questionType: "score",
            outcome: "scored",
            score,
            levels: before.levels,
            model: { qualified: QUALIFIED },
        }, `score ${score}`);
        assert.deepEqual(input, before, "the policy does not mutate the answer");
    }
});

test("a Microsoft-shaped systemone response becomes the exact semantic node output", async () => {
    const { createDecisionProvider, applyDecisionPolicy } = await decisionApi();
    const question = {
        type: "choice",
        instructions: "Which team should handle this ticket?",
        criteria: {
            billing: "Charges, invoices, and refunds",
            engineering: "Bugs, errors, and outages",
            support: "How-to and account questions",
        },
    };
    const fixture = fetchFixture(ok({
        id: REQUEST_ID,
        model: SERVED_MODEL,
        answers: { decision: { type: "choice", choice: "engineering", probabilities: { billing: 0.04, engineering: 0.93, support: 0.03 } } },
        usage: { input_tokens: 96, output_tokens: 1 },
    }));
    const provider = createDecisionProvider(wifProvider(), { fetch: fixture.fetch, getAccessToken: async () => INJECTED_TOKEN });
    const result = await decideWith(provider, question, { state: "The API returns 500 on every call." });
    assert.deepEqual(JSON.parse(fixture.calls[0].bodyText), {
        model: DEPLOYMENT, state: "The API returns 500 on every call.", questions: { decision: question },
    });
    assert.deepEqual(result.usage, { inputTokens: 96, outputTokens: 1 });
    assert.deepEqual(applyDecisionPolicy({ question, confidence: { minimumProbability: 0.8 }, answer: result.answer, model: QUALIFIED }), {
        questionType: "choice",
        outcome: "engineering",
        selection: "engineering",
        confidence: 0.93,
        probabilities: { billing: 0.04, engineering: 0.93, support: 0.03 },
        policy: { minimumProbability: 0.8, uncertain: false },
        model: { qualified: QUALIFIED },
    });
});

test("Workflow core names no provider type, credential mode, or Foundry protocol", () => {
    const root = fileURLToPath(new URL("../../src/workflow/", import.meta.url));
    const files = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".ts")) files.push(full);
        }
    };
    walk(root);
    assert.ok(files.length > 0, "Workflow core sources must be present");
    const offenders = [];
    for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        for (const pattern of [/systemone/i, /foundry/i, /usesWorkloadIdentity/, /anthropic-wif|openai-proxy/]) {
            if (pattern.test(text)) offenders.push(`${path.relative(root, file)} ${pattern}`);
        }
    }
    assert.deepEqual(offenders, [], "Workflow core reaches providers only through the provider-neutral Decision contract");
});
