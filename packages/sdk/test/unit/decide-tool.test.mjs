/**
 * The agent `decide` tool (docs/proposals/agent-decide-tool.md, phase 1): arguments as the Decision node takes them, live
 * model resolution, budget admission and the ledger, every error code, limits, and byte-equal parity with the Workflow
 * Decision node for the same provider response. The provider is the real systemone adapter over an injected fetch.
 *
 * Run after the SDK build: node --test test/unit/decide-tool.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
    checkDecideArguments, createDecideTool, createDecisionCatalogReader, runDecide, DECIDE_LEDGER_PURPOSE, DECIDE_MAX_CALLS_PER_TURN,
    DECIDE_MAX_CONTEXT_BYTES, DECIDE_TOOL_DESCRIPTION, DECIDE_TOOL_NAME, DECIDE_TOOL_PARAMETERS,
} from "../../dist/decision-tools.js";
import { applyDecisionPolicy, normalizeDecisionResponse } from "../../dist/decision-provider.js";
import { executeDecisionCall } from "../../dist/decision-call.js";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
import { canonicalJson } from "../../dist/workflow/json.js";
import { registerWorkflow, WORKFLOW_ACTIVITIES } from "../../dist/workflow/runtime.js";
import {
    CHOICE, DEFAULT, DEPLOYMENT, fakeDecideHost, INSTANCE, NOUL, QUALIFIED, SCORE, SPARE, SYNTHETIC, UNSET,
} from "../helpers/decide-fixtures.mjs";

const SESSION = "session-decide-1";
const LIVE_DIR = new URL("../fixtures/decision-live/", import.meta.url);

/** The tool's options over a fake host; `calls` counts this turn's calls. */
function toolOptions(fake, over = {}) {
    let calls = 0;
    return {
        sessionId: SESSION, agentId: "triage-agent", host: fake.host,
        readCatalog: createDecisionCatalogReader(fake.host, { ttlMs: 0 }),
        countCall: () => ++calls, ...over,
    };
}
let callSeq = 0;
const call = (options, args, invocation = {}) => runDecide(options, args, { toolCallId: `call_${++callSeq}`, ...invocation });

// ─── Footprint ──────────────────────────────────────────────────

test("the tool's declaration fits its footprint: description at most 700 characters, with its schema at most 1,600", () => {
    assert.equal(DECIDE_TOOL_NAME, "decide");
    assert.ok(DECIDE_TOOL_DESCRIPTION.length <= 700, `description: ${DECIDE_TOOL_DESCRIPTION.length}`);
    const total = DECIDE_TOOL_DESCRIPTION.length + JSON.stringify(DECIDE_TOOL_PARAMETERS).length;
    assert.ok(total <= 1_600, `description + schema: ${total}`);
    assert.match(DECIDE_TOOL_DESCRIPTION, /advice/);
    assert.match(DECIDE_TOOL_DESCRIPTION, /never approves an action or grants a permission/);
    assert.doesNotMatch(DECIDE_TOOL_DESCRIPTION, /ps-decision|available with default|unavailable/i, "the declaration never states availability or a model");
    const tool = createDecideTool(toolOptions(fakeDecideHost()));
    assert.equal(tool.name, "decide");
    assert.equal(tool.description, DECIDE_TOOL_DESCRIPTION);
    assert.equal(typeof tool.handler, "function", "the declaration and its handler are one object");
});

// ─── Arguments: the Decision node's own rules ───────────────────

const QUESTIONS = {
    valid: [
        CHOICE, NOUL, SCORE,
        { type: "noul", instructions: "Is it urgent?", criteria: { true: "It blocks work now", false: "It can wait" } },
        { type: "choice", instructions: "Pick", criteria: { a_1: "first", "b-2": "second" } },
    ],
    invalid: [
        { type: "choice", instructions: "Pick", criteria: { only: "one option" } },
        { type: "choice", instructions: "Pick", criteria: { uncertain: "reserved", other: "x" } },
        { type: "choice", instructions: "Pick", criteria: { scored: "reserved", other: "x" } },
        { type: "choice", instructions: "Pick", criteria: { failure: "reserved", other: "x" } },
        { type: "choice", instructions: "Pick", criteria: { timed_out: "reserved", other: "x" } },
        { type: "choice", instructions: "Pick", criteria: { "two words": "bad label", other: "x" } },
        { type: "choice", instructions: "", criteria: { a: "x", b: "y" } },
        { type: "choice", instructions: "Pick ${input.x}", criteria: { a: "x", b: "y" } },
        { type: "noul", instructions: "Yes?", criteria: { true: "y" } },
        { type: "score", instructions: "Grade", criteria: ["only"] },
        { type: "score", instructions: "Grade", criteria: ["low", "low"] },
        { type: "rank", instructions: "Rank", criteria: ["a", "b"] },
        { type: "choice", instructions: "Pick", criteria: { a: "x", b: "y" }, extra: true },
        "choose", null,
    ],
};

/** The compiler's verdict on the same question inside a Decision state: any error under the question's path. */
function compilerRefuses(question) {
    const yaml = `apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: q, version: "1.0.0" }\ninitial: d\nstates:\n`
        + `  d: { type: decision, question: ${JSON.stringify(question)}, transition: { next: { failure: done } } }\n`
        + "  done: { type: terminal, outcome: succeeded }\n";
    return compileWorkflow(yaml).diagnostics.some(item => item.severity === "error" && item.path.startsWith("states.d.question"));
}

test("a question is valid for decide exactly when the Decision node's compiler accepts it", () => {
    for (const question of QUESTIONS.valid) {
        assert.equal(compilerRefuses(question), false, `compiler: ${JSON.stringify(question)}`);
        const checked = checkDecideArguments({ question });
        assert.ok(!("error" in checked), `decide refused ${JSON.stringify(question)}: ${checked.error}`);
    }
    for (const question of QUESTIONS.invalid) {
        assert.equal(compilerRefuses(question), true, `compiler accepted ${JSON.stringify(question)}`);
        const checked = checkDecideArguments({ question });
        assert.ok("error" in checked, `decide accepted ${JSON.stringify(question)}`);
    }
});

test("the other arguments: minimum_probability, timeout_seconds, context size and JSON, model, unknown fields", () => {
    const ok = args => !("error" in checkDecideArguments({ question: CHOICE, ...args }));
    for (const value of [0, 0.5, 1]) assert.ok(ok({ minimum_probability: value }), String(value));
    for (const value of [-0.1, 1.1, "0.5", Number.NaN]) assert.ok(!ok({ minimum_probability: value }), String(value));
    assert.match(checkDecideArguments({ question: SCORE, minimum_probability: 0.5 }).error, /score question does not take minimum_probability/);
    for (const value of [1, 30, 120]) assert.ok(ok({ timeout_seconds: value }), String(value));
    for (const value of [0, 121, 1.5, "30"]) assert.ok(!ok({ timeout_seconds: value }), String(value));
    assert.equal(checkDecideArguments({ question: CHOICE }).timeoutSeconds, 30);
    assert.deepEqual(checkDecideArguments({ question: CHOICE }).state, {}, "no context sends an empty object");
    const big = "x".repeat(DECIDE_MAX_CONTEXT_BYTES);
    assert.match(checkDecideArguments({ question: CHOICE, context: { big } }).error, /the limit is 65,536/);
    assert.ok(ok({ context: { ticket: "x".repeat(DECIDE_MAX_CONTEXT_BYTES - 20) } }));
    assert.ok(!ok({ context: { bad: Number.POSITIVE_INFINITY } }));
    assert.ok(ok({ context: ["a", 1, null, true] }));
    assert.ok(!ok({ model: "" }));
    assert.match(checkDecideArguments({ question: CHOICE, approve: true }).error, /Unknown argument 'approve'/);
    assert.match(checkDecideArguments(null).error, /takes an object/);
});

// ─── Live resolution ────────────────────────────────────────────

test("no Cluster Decision Default: decision_model_unavailable, with the reason and the admin action; nothing admitted", async () => {
    const fake = fakeDecideHost({ decisionDefault: UNSET });
    const result = await call(toolOptions(fake), { question: CHOICE });
    assert.equal(result.ok, false);
    assert.deepEqual({ ...result.error, message: undefined, action: undefined },
        { code: "decision_model_unavailable", reason: "no_cluster_decision_default", message: undefined, retryable: false, action: undefined });
    assert.match(result.error.action, /set_model_default with scope cluster and purpose decision/);
    assert.ok(!fake.log.some(([kind]) => kind === "checkDecision" || kind === "claim"));
    assert.equal(fake.requests.length, 0);
});

test("an ineligible default and a model that is not a live shared Decision model are refused with their reasons", async () => {
    const ineligible = await call(toolOptions(fakeDecideHost({ decisionDefault: { ...DEFAULT, model: "azure-openai:retired" } })), { question: CHOICE });
    assert.equal(ineligible.error.code, "decision_model_unavailable");
    assert.equal(ineligible.error.reason, "cluster_decision_default_ineligible");
    for (const model of ["azure-openai:chat-model", "mine:ps-decision-1-1", "ps-decision-1-1", "gone:ps-decision-1-1"]) {
        const fake = fakeDecideHost();
        const result = await call(toolOptions(fake), { question: CHOICE, model });
        assert.equal(result.error?.code, "decision_model_unavailable", model);
        assert.equal(result.error.reason, "model_not_eligible", model);
        assert.match(result.error.action, new RegExp(`${QUALIFIED}.*${SPARE}|${SPARE}.*${QUALIFIED}`), "the action names the eligible models");
        assert.equal(fake.requests.length, 0, model);
    }
});

test("the model argument wins over the default (model_source explicit); otherwise the Cluster Decision Default", async () => {
    const fake = fakeDecideHost();
    const byDefault = await call(toolOptions(fake), { question: CHOICE });
    assert.equal(byDefault.ok, true, JSON.stringify(byDefault));
    assert.equal(byDefault.model_source, "cluster_decision_default");
    assert.equal(byDefault.decision.model.qualified, QUALIFIED);
    const explicit = await call(toolOptions(fake), { question: CHOICE, model: SPARE });
    assert.equal(explicit.ok, true, JSON.stringify(explicit));
    assert.equal(explicit.model_source, "explicit");
    assert.equal(explicit.decision.model.qualified, SPARE);
    assert.deepEqual(fake.requests.map(request => request.body.model), [DEPLOYMENT, DEPLOYMENT]);
});

test("availability is read when the tool is called: a tool built with no default answers once the default is set", async () => {
    let now = 0;
    const fake = fakeDecideHost({ decisionDefault: UNSET, body: SYNTHETIC.noul });
    const options = toolOptions(fake, { readCatalog: createDecisionCatalogReader(fake.host, { now: () => now }) });
    const tool = createDecideTool(options);
    const before = await tool.handler({ question: NOUL }, { toolCallId: "stale-1" });
    assert.equal(before.error.reason, "no_cluster_decision_default");
    fake.state.decisionDefault = DEFAULT;
    // Within the cache window the same read is reused (at most 5 s), then the new default applies, same tool object.
    now = 4_999;
    assert.equal((await tool.handler({ question: NOUL }, { toolCallId: "stale-2" })).error.reason, "no_cluster_decision_default");
    now = 5_000;
    const after = await tool.handler({ question: NOUL }, { toolCallId: "stale-3" });
    assert.equal(after.ok, true, JSON.stringify(after));
});

test("the catalog cache never holds a read longer than 5 s, and never keeps a failed read", async () => {
    let now = 0;
    const fake = fakeDecideHost();
    const read = createDecisionCatalogReader(fake.host, { ttlMs: 60_000, now: () => now });
    await read();
    now = 4_999;
    await read();
    assert.equal(fake.log.filter(([kind]) => kind === "allCredentials").length, 1, "reused inside 5 s");
    now = 5_000;
    await read();
    assert.equal(fake.log.filter(([kind]) => kind === "allCredentials").length, 2, "a 60 s request is capped at 5 s");
    fake.state.readError = new Error("transient");
    now = 10_000;
    await assert.rejects(read(), /transient/);
    fake.state.readError = null;
    await read();
    assert.equal(fake.log.filter(([kind]) => kind === "allCredentials").length, 4, "a failed read is read again at once");
});

test("a catalog that cannot be read, or a worker without a type catalog, is unavailable (retryable)", async () => {
    const unread = await call(toolOptions(fakeDecideHost({ readError: new Error("connection reset") })), { question: CHOICE });
    assert.deepEqual([unread.error.code, unread.error.reason, unread.error.retryable], ["unavailable", "catalog_unavailable", true]);
    const unloaded = await call(toolOptions(fakeDecideHost({ typesLoaded: false })), { question: CHOICE });
    assert.deepEqual([unloaded.error.code, unloaded.error.retryable], ["unavailable", true]);
});

// ─── Admission and the ledger ───────────────────────────────────

test("one call: admission, one claim keyed by session and tool call, one provider call, one settlement with usage", async () => {
    const fake = fakeDecideHost();
    const result = await runDecide(toolOptions(fake), { question: CHOICE, context: { ticket: "Charged twice" }, minimum_probability: 0.8 },
        { toolCallId: "call_ledger" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(fake.log.map(entry => entry[0]),
        ["allCredentials", "getClusterDecisionDefault", "checkDecision", "providerFor", "claim", "settle"]);
    assert.deepEqual(fake.log.find(entry => entry[0] === "checkDecision"), ["checkDecision", SESSION, QUALIFIED, INSTANCE]);
    const claim = fake.claims.get(`decide:${SESSION}:call_ledger/1`);
    assert.ok(claim, "the claim is keyed decide:<session>:<tool call id>, attempt 1");
    assert.equal(claim.capability, "decision");
    assert.equal(claim.purpose, DECIDE_LEDGER_PURPOSE);
    assert.equal(claim.agentId, "triage-agent");
    assert.equal(claim.sessionId, SESSION);
    assert.equal(claim.chargeClass, "user");
    assert.equal(claim.ownerUserId, 4101);
    assert.equal(claim.providerInstanceId, INSTANCE);
    assert.equal(claim.workflowRunId, null);
    assert.equal(fake.requests.length, 1);
    assert.deepEqual(fake.requests[0].body, { model: DEPLOYMENT, state: { ticket: "Charged twice" }, questions: { decision: CHOICE } });
    assert.equal(fake.settlements.length, 1);
    assert.deepEqual([fake.settlements[0].tokensInput, fake.settlements[0].tokensOutput], [412, 6]);
    assert.deepEqual(result.usage, { inputTokens: 412, outputTokens: 6 });
    assert.equal(typeof result.latency_ms, "number");
    assert.equal(result.decision.outcome, "billing");
    assert.equal(result.decision.policy.minimumProbability, 0.8);
});

test("the same tool call id is claimed once: a second call with it makes no provider call", async () => {
    const fake = fakeDecideHost();
    const options = toolOptions(fake);
    assert.equal((await runDecide(options, { question: CHOICE }, { toolCallId: "call_once" })).ok, true);
    const again = await runDecide(options, { question: CHOICE }, { toolCallId: "call_once" });
    assert.deepEqual([again.error.code, again.error.reason, again.error.retryable], ["execution_failed", "already_claimed", false]);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.settlements.length, 1);
    const none = await runDecide(options, { question: CHOICE }, {});
    assert.deepEqual([none.error.code, none.error.reason], ["execution_failed", "no_tool_call_id"]);
});

test("a system session is charged as system; a paused budget is budget_exceeded with no claim and no call", async () => {
    const system = fakeDecideHost({ exempt: true, body: SYNTHETIC.noul });
    assert.equal((await call(toolOptions(system), { question: NOUL })).ok, true);
    assert.equal([...system.claims.values()][0].chargeClass, "system");
    const paused = fakeDecideHost({ verdict: "paused" });
    const result = await call(toolOptions(paused), { question: NOUL });
    assert.deepEqual([result.error.code, result.error.reason, result.error.retryable], ["budget_exceeded", "budget_paused", false]);
    assert.ok(!paused.log.some(([kind]) => kind === "claim"));
    assert.equal(paused.requests.length, 0);
    const noProvider = await call(toolOptions(fakeDecideHost({ verdict: "no_provider" })), { question: NOUL });
    assert.deepEqual([noProvider.error.code, noProvider.error.retryable], ["unavailable", true]);
    const replaced = await call(toolOptions(fakeDecideHost({ providerTypeId: "another-type" })), { question: NOUL });
    assert.deepEqual([replaced.error.code, replaced.error.reason], ["unavailable", "provider_replaced"]);
    const failing = await call(toolOptions(fakeDecideHost({ admissionError: new Error("db down") })), { question: NOUL });
    assert.deepEqual([failing.error.code, failing.error.reason], ["execution_failed", "admission_failed"]);
});

test("provider failures keep their codes, say whether a retry can help, and never carry a key, status or body", async () => {
    const cases = [
        [{ status: 401, body: { error: "secret-body" } }, "forbidden", false],
        [{ status: 429, body: { error: "secret-body" } }, "unavailable", true],
        [{ status: 503, body: { error: "secret-body" } }, "unavailable", true],
        [{ body: { answers: { decision: { type: "choice", choice: "legal", probabilities: {} } } } }, "invalid_output", true],
    ];
    for (const [state, code, retryable] of cases) {
        const fake = fakeDecideHost(state);
        const result = await call(toolOptions(fake), { question: CHOICE });
        assert.deepEqual([result.error?.code, result.error?.retryable], [code, retryable], JSON.stringify(state));
        const text = JSON.stringify(result);
        for (const secret of ["instance-test-key", "type-test-key", "secret-body", "401", "429", "503"]) {
            assert.ok(!text.includes(secret), `${code} leaks ${secret}: ${text}`);
        }
        assert.equal(fake.settlements.length, 1, "a claimed call is settled whatever happens");
    }
});

test("timed_out at timeout_seconds; cancelled when the turn is stopped; a stopped turn before the call makes none", async () => {
    const slow = fakeDecideHost({ delayMs: 5_000 });
    const timed = await call(toolOptions(slow), { question: CHOICE, timeout_seconds: 1 });
    assert.deepEqual([timed.error.code, timed.error.retryable], ["timed_out", true]);
    const stop = new AbortController();
    const stopping = fakeDecideHost({ delayMs: 5_000 });
    const pending = call(toolOptions(stopping), { question: CHOICE }, { signal: stop.signal });
    setTimeout(() => stop.abort(new DOMException("stopped", "AbortError")), 50);
    const cancelled = await pending;
    assert.deepEqual([cancelled.error.code, cancelled.error.retryable], ["cancelled", false]);
    const early = fakeDecideHost();
    const before = await call(toolOptions(early), { question: CHOICE }, { signal: AbortSignal.abort() });
    assert.equal(before.error.code, "cancelled");
    assert.equal(early.requests.length, 0);
});

test("at most 20 calls in one turn: the 21st is budget_exceeded before any read; a new turn starts again", async () => {
    let calls = 0;
    const fake = fakeDecideHost({ body: SYNTHETIC.noul });
    const options = toolOptions(fake, { countCall: () => ++calls });
    for (let index = 0; index < DECIDE_MAX_CALLS_PER_TURN; index += 1) {
        assert.equal((await call(options, { question: NOUL })).ok, true, `call ${index + 1}`);
    }
    const reads = fake.log.length;
    const over = await call(options, { question: NOUL });
    assert.deepEqual([over.error.code, over.error.reason, over.error.retryable], ["budget_exceeded", "per_turn_limit", false]);
    assert.equal(fake.log.length, reads, "no read, admission, claim or call after the cap");
    calls = 0;
    assert.equal((await call(options, { question: NOUL })).ok, true, "the next turn's counter starts at zero");
});

// ─── Shapes: the node's output, and the live noul shape ─────────

test("choice, noul (answered with only {type, noul}) and score return the Decision node's output object", async () => {
    for (const [question, body, minimum] of [[CHOICE, SYNTHETIC.choice, 0.95], [NOUL, SYNTHETIC.noul, 0.9], [SCORE, SYNTHETIC.score, undefined]]) {
        const fake = fakeDecideHost({ body });
        const result = await call(toolOptions(fake), { question, ...(minimum === undefined ? {} : { minimum_probability: minimum }) });
        assert.equal(result.ok, true, JSON.stringify(result));
        const expected = applyDecisionPolicy({ question, confidence: minimum === undefined ? undefined : { minimumProbability: minimum },
            answer: normalizeDecisionResponse(question, body).answer, model: QUALIFIED });
        assert.equal(canonicalJson(result.decision), canonicalJson(expected));
    }
    const noul = await call(toolOptions(fakeDecideHost({ body: SYNTHETIC.noul })), { question: NOUL });
    assert.equal(noul.decision.outcome, "no");
    assert.deepEqual(noul.decision.probabilities, { yes: 1.774475133117886e-6, no: 1 - 1.774475133117886e-6 });
    const uncertain = await call(toolOptions(fakeDecideHost()), { question: CHOICE, minimum_probability: 0.95 });
    assert.equal(uncertain.decision.outcome, "uncertain");
});

test("recorded live Microsoft Decision 1.1 bodies (test/fixtures/decision-live) parse through the tool", async (t) => {
    const files = ["choice.json", "noul.json", "score.json"];
    const missing = files.filter(name => !fs.existsSync(new URL(name, LIVE_DIR)));
    assert.deepEqual(missing, [], "test/fixtures/decision-live must hold the recorded choice, noul and score bodies: run "
        + "`npm run test:live:decide --workspace=packages/sdk` with PS_DECISION_LIVE_BASE_URL, PS_DECISION_LIVE_API_KEY and "
        + "PS_DECISION_LIVE_DEPLOYMENT and PS_DECISION_LIVE_RECORD=1 (see test/live/decide-tool.live.test.mjs)");
    for (const name of files) {
        const recorded = JSON.parse(fs.readFileSync(new URL(name, LIVE_DIR), "utf8"));
        const fake = fakeDecideHost({ body: recorded.response });
        const result = await call(toolOptions(fake), recorded.arguments);
        await t.test(name, () => {
            assert.equal(recorded.arguments.question.type, name.replace(/\.json$/, ""), `${name} records its own question type`);
            assert.equal(recorded.status, 200);
            assert.equal(recorded.response.answers.decision.type, recorded.arguments.question.type);
            assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
            assert.equal(result.decision.questionType, recorded.arguments.question.type);
            assert.deepEqual(fake.requests[0].body.questions.decision, recorded.request.questions.decision);
            if (recorded.arguments.question.type === "noul") assert.equal(Object.hasOwn(recorded.response.answers.decision, "probabilities"), false,
                "Microsoft Decision 1.1 answers noul with only {type, noul}");
        });
    }
});

// ─── Parity with the Workflow Decision node ─────────────────────

/** runDecision as a worker registers it, over an in-memory store and the same fake host. */
function workflowDecisionNode(fake, { question, minimum }) {
    const activities = new Map();
    const runtime = { registerOrchestrationVersioned() {}, registerActivity: (name, fn) => activities.set(name, fn) };
    const confidence = minimum === undefined ? "" : `, confidence: { minimumProbability: ${minimum} }`;
    const routes = question.type === "choice" ? Object.keys(question.criteria) : question.type === "noul" ? ["yes", "no"] : ["scored"];
    const next = [...routes, ...(minimum === undefined ? [] : ["uncertain"]), "failure"].map(label => `${label}: done`).join(", ");
    const compiled = compileWorkflow(`apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: p, version: "1.0.0" }\ninitial: d\nstates:\n`
        + `  d: { type: decision, input: "\${input}", question: ${JSON.stringify(question)}${confidence}, transition: { next: { ${next} } } }\n`
        + "  done: { type: terminal, outcome: succeeded }\n");
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    const run = {
        runId: "run-1", workflowSessionId: SESSION, revision: 1, irSha256: compiled.irSha256, mode: "live",
        agentModels: { d: { model: QUALIFIED } },
        decisionProviderBindings: { d: { providerInstanceId: INSTANCE, providerName: "azure-openai", providerTypeId: "foundry-type", modelQualified: QUALIFIED } },
    };
    const store = {
        readNodeExecution: async () => ({ runId: "run-1", nodeExecutionId: "nx-1", nodeId: "d", state: "pending", input: { ticket: "Charged twice" } }),
        readRun: async () => run,
        readRevisionIr: async () => compiled.ir,
        enterScript: async (_id, admitted) => { admitted(1); return { entered: true }; },
        isNodePending: async () => true,
    };
    registerWorkflow(runtime, { store, decisionNodes: fake.host, livenessIntervalMs: 60_000 });
    const actx = { isCancelled: () => false, traceWarn: () => {}, traceInfo: () => {}, traceError: () => {}, traceDebug: () => {} };
    return () => activities.get(WORKFLOW_ACTIVITIES.runDecision)(actx, { runId: "run-1", nodeExecutionId: "nx-1", controllerInstanceId: "c-1" });
}

test("parity: the tool's decision is byte-equal to the Decision node's output for the same provider body", async () => {
    const recorded = fs.existsSync(LIVE_DIR) ? fs.readdirSync(LIVE_DIR).filter(name => name.endsWith(".json"))
        .map(name => JSON.parse(fs.readFileSync(new URL(name, LIVE_DIR), "utf8"))) : [];
    const cases = [
        { question: CHOICE, body: SYNTHETIC.choice, minimum: 0.8 },
        { question: CHOICE, body: SYNTHETIC.choice, minimum: 0.95 },
        { question: NOUL, body: SYNTHETIC.noul },
        { question: NOUL, body: SYNTHETIC.noul, minimum: 0.99 },
        { question: SCORE, body: SYNTHETIC.score },
        ...recorded.map(item => ({ question: item.arguments.question, body: item.response, minimum: item.arguments.minimum_probability })),
    ];
    for (const { question, body, minimum } of cases) {
        const nodeHost = fakeDecideHost({ body });
        const node = await workflowDecisionNode(nodeHost, { question, minimum })();
        assert.equal(node.kind, "result", JSON.stringify(node));
        assert.equal(node.result.resultKind, "business", JSON.stringify(node));
        const toolHost = fakeDecideHost({ body });
        const tool = await runDecide(toolOptions(toolHost), { question, context: { ticket: "Charged twice" },
            ...(minimum === undefined ? {} : { minimum_probability: minimum }) }, { toolCallId: "parity" });
        assert.equal(tool.ok, true, JSON.stringify(tool));
        assert.equal(canonicalJson(tool.decision), node.result.valueText, `${question.type} ${minimum ?? ""}`);
        assert.equal(tool.decision.outcome, node.result.outcome);
        // The same request reached the provider, and both were ledgered once.
        assert.deepEqual(toolHost.requests[0].body, nodeHost.requests[0].body);
        assert.equal(nodeHost.claims.size, 1);
        assert.equal(toolHost.claims.size, 1);
        assert.equal([...nodeHost.claims.values()][0].purpose, "Workflow Decision state d");
    }
});

test("parity: the node keeps its own refusal words; the tool reports the same codes", async () => {
    for (const [state, code] of [[{ verdict: "paused" }, "budget_exceeded"], [{ verdict: "no_provider" }, "unavailable"], [{ status: 401 }, "forbidden"]]) {
        const node = await workflowDecisionNode(fakeDecideHost(state), { question: NOUL })();
        assert.equal(node.result.outcome, code, JSON.stringify(state));
        const tool = await call(toolOptions(fakeDecideHost(state)), { question: NOUL });
        assert.equal(tool.error.code, code, JSON.stringify(state));
    }
    const paused = await workflowDecisionNode(fakeDecideHost({ verdict: "paused" }), { question: NOUL })();
    assert.match(paused.result.valueText, /The provider budget is paused for this Workflow session\./);
});

// ─── Review fixes: lifecycle, stop, deadline, words, failed-call usage ──

test("the shared core runs the caller's lifecycle hooks around the call: ready after the provider, end before settlement", async () => {
    const fake = fakeDecideHost();
    const order = [];
    const store = fake.host.providerStore;
    const host = {
        providerStore: {
            checkDecision: async (...args) => { order.push("admission"); return store.checkDecision(...args); },
            claimInferenceOperation: async claim => { order.push("claim"); return store.claimInferenceOperation(claim); },
            settleInferenceOperation: async usage => { order.push("settle"); return store.settleInferenceOperation(usage); },
        },
        providerFor: async (...args) => { order.push("providerFor"); return fake.host.providerFor(...args); },
    };
    const result = await executeDecisionCall(host, {
        sessionId: SESSION, operationId: "op-hooks", attempt: 1, purpose: "p", telemetryPurpose: "t",
        qualified: QUALIFIED, deployment: DEPLOYMENT, providerInstanceId: INSTANCE, providerTypeId: "foundry-type",
        question: CHOICE, state: {}, timeoutMs: 30_000, signal: new AbortController().signal,
        messages: { paused: "p", noPayingProvider: "n", replaced: "r", alreadyClaimed: "a" }, settleLabel: "s",
        onProviderReady: () => order.push("ready"), onCallEnd: () => order.push("end"),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(order, ["admission", "providerFor", "ready", "claim", "end", "settle"]);
    assert.equal(Object.hasOwn([...fake.claims.values()][0], "agentId"), false, "the node's claim carries no agent id, as before");
});

test("a turn stop or the deadline during the catalog read ends the call with no claim and no provider call", async () => {
    const fake = fakeDecideHost();
    const slowRead = createDecisionCatalogReader({ providerStore: { ...fake.host.providerStore,
        allCredentials: () => new Promise(resolve => setTimeout(() => resolve(fake.state.rows), 3_000)) } }, { ttlMs: 0 });
    const stop = new AbortController();
    const pending = runDecide(toolOptions(fake, { readCatalog: slowRead }), { question: CHOICE }, { toolCallId: "stop-read", turnSignal: stop.signal });
    setTimeout(() => stop.abort(new DOMException("Stop", "AbortError")), 50);
    const stopped = await pending;
    assert.deepEqual([stopped.error.code, stopped.error.reason], ["cancelled", "stopped_before_call"]);
    const late = await runDecide(toolOptions(fake, { readCatalog: slowRead }), { question: CHOICE, timeout_seconds: 1 }, { toolCallId: "late-read" });
    assert.deepEqual([late.error.code, late.error.reason, late.error.retryable], ["timed_out", "deadline_before_call", true]);
    assert.equal(fake.claims.size, 0);
    assert.equal(fake.requests.length, 0);
});

test("the turn's stop signal cancels a provider call in flight, and the claimed call is settled", async () => {
    const fake = fakeDecideHost({ delayMs: 5_000 });
    const turn = new AbortController();
    const pending = runDecide(toolOptions(fake), { question: CHOICE }, { toolCallId: "turn-stop", turnSignal: turn.signal });
    setTimeout(() => turn.abort(new DOMException("Stop", "AbortError")), 100);
    const result = await pending;
    assert.deepEqual([result.error.code, result.error.retryable], ["cancelled", false]);
    assert.equal(fake.claims.size, 1);
    assert.equal(fake.settlements.length, 1);
});

test("store, factory and unexpected failures get fixed words: no exception text reaches the agent", async () => {
    const secret = "postgres://admin:hunter2@db.internal/cms";
    const admission = await call(toolOptions(fakeDecideHost({ admissionError: new Error(`connect failed ${secret}`) })), { question: CHOICE });
    assert.deepEqual([admission.error.code, admission.error.reason], ["execution_failed", "admission_failed"]);
    const broken = fakeDecideHost();
    broken.host.providerFor = async () => { throw new Error(`factory ${secret}`); };
    const factory = await call(toolOptions(broken), { question: CHOICE });
    assert.deepEqual([factory.error.code, factory.error.reason], ["execution_failed", "provider_unresolved"]);
    const throwing = await call(toolOptions(fakeDecideHost(), { readCatalog: () => ({ then: () => { throw new Error(secret); } }) }), { question: CHOICE });
    assert.equal(throwing.ok, false);
    const unexpected = await call(toolOptions(fakeDecideHost(), { countCall: () => { throw new Error(secret); } }), { question: CHOICE });
    assert.deepEqual([unexpected.error.code, unexpected.error.reason], ["execution_failed", "unexpected"]);
    for (const result of [admission, factory, throwing, unexpected]) assert.ok(!JSON.stringify(result).includes("hunter2"), JSON.stringify(result));
});

test("a failed provider call keeps its usage in the ledger, not in the agent's error", async () => {
    const fake = fakeDecideHost({ body: { answers: { decision: { type: "choice", choice: "legal", probabilities: {} } }, usage: { input_tokens: 77, output_tokens: 2 } } });
    const result = await call(toolOptions(fake), { question: CHOICE });
    assert.equal(result.error.code, "invalid_output");
    assert.equal(Object.hasOwn(result, "usage"), false);
    assert.deepEqual([fake.settlements[0].tokensInput, fake.settlements[0].tokensOutput], [77, 2]);
    assert.equal(typeof fake.settlements[0].latencyMs, "number");
});

test("the Workflow node keeps its exact refusal words for every refusal the shared core makes", async () => {
    const cases = [
        [{ verdict: "paused" }, "budget_exceeded", "The provider budget is paused for this Workflow session."],
        [{ verdict: "no_provider" }, "unavailable", "No paying shared provider serves this Workflow Decision model."],
        [{ providerTypeId: "another-type" }, "unavailable", "The admitted Decision provider was replaced after this Workflow started."],
        [{ rows: [] }, "unavailable", "No Decision provider serves this model."],
        [{ admissionError: new Error("db down") }, "execution_failed", "The Decision provider admission failed: db down"],
    ];
    for (const [state, code, words] of cases) {
        const node = await workflowDecisionNode(fakeDecideHost(state), { question: NOUL })();
        assert.equal(node.result.outcome, code, JSON.stringify(state));
        assert.equal(JSON.parse(node.result.valueText).message, words, JSON.stringify(state));
    }
    const claimed = fakeDecideHost({ body: SYNTHETIC.noul });
    claimed.claims.set("nx-1/1", {});
    const again = await workflowDecisionNode(claimed, { question: NOUL })();
    assert.equal(JSON.parse(again.result.valueText).message,
        "The Decision inference attempt was already claimed, or its provider changed after the run started.");
    assert.equal(claimed.requests.length, 0);
});

test("a stop while the claim is written: the claimed call is settled and nothing is sent", async () => {
    const fake = fakeDecideHost();
    const turn = new AbortController();
    const claim = fake.host.providerStore.claimInferenceOperation;
    fake.host.providerStore.claimInferenceOperation = async (input) => {
        const first = await claim(input);
        turn.abort(new DOMException("Stop", "AbortError"));
        return first;
    };
    const result = await runDecide(toolOptions(fake), { question: CHOICE }, { toolCallId: "stop-at-claim", turnSignal: turn.signal });
    assert.deepEqual([result.error.code, result.error.reason], ["cancelled", "stopped_before_call"]);
    assert.equal(fake.requests.length, 0, "no provider request after a stop");
    assert.equal(fake.claims.size, 1);
    assert.equal(fake.settlements.length, 1, "the claimed call is settled");
    assert.equal(fake.settlements[0].tokensInput, null);
});

test("an SDK signal aborted with a timeout reason before the call is timed_out, not cancelled", async () => {
    const fake = fakeDecideHost();
    const result = await runDecide(toolOptions(fake), { question: CHOICE },
        { toolCallId: "sdk-timeout", signal: AbortSignal.abort(new DOMException("deadline", "TimeoutError")) });
    assert.deepEqual([result.error.code, result.error.retryable], ["timed_out", true]);
    assert.equal(fake.requests.length, 0);
});
