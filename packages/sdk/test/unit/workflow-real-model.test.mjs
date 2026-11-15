// The workflow real-model test's plan and records (test/helpers/workflow-real-model.mjs), without a model, a
// credential or a database: when it runs, skips or is blocked, what it records of a child's events, the review
// contract it checks independently of the runtime, and the migration guard of the deployed target.
//
// Run: node --test packages/sdk/test/unit/workflow-real-model.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    REAL_MODEL_ENV,
    REAL_MODEL_MAX_SAMPLES,
    childRecord,
    missingMigrations,
    realModelPlan,
    reviewResultProblems,
    servesModel,
} from "../helpers/workflow-real-model.mjs";

const SECRET_URL = "postgresql://user:not-for-print@db.example.invalid/pilotswarm";

/** A model catalog shaped as loadModelProviders() answers, with one GitHub and one key-based provider. */
function catalog({ githubToken = "", apiKey = "" } = {}) {
    const models = {
        "github-copilot:gpt-5.6-sol": { type: "github", providerId: "github-copilot", modelName: "gpt-5.6-sol", efforts: ["medium", "xhigh"] },
        "azure-openai:gpt-5.6-terra": { type: "openai", providerId: "azure-openai", modelName: "gpt-5.6-terra", efforts: ["none"] },
    };
    return {
        normalize(ref) {
            if (!ref) return "github-copilot:gpt-5.6-sol";
            if (models[ref]) return ref;
            return Object.keys(models).find(key => models[key].modelName === ref);
        },
        resolve(ref) {
            const model = models[ref];
            if (!model) return undefined;
            return model.type === "github"
                ? { providerId: model.providerId, type: "github", modelName: model.modelName, githubToken }
                : { providerId: model.providerId, type: model.type, modelName: model.modelName, sdkProvider: { type: "openai", apiKey } };
        },
        getDescriptor(ref) { return models[ref] ? { supportedReasoningEfforts: models[ref].efforts } : undefined; },
    };
}

const RUN = { [REAL_MODEL_ENV.run]: "run" };

test("it runs only when asked by the exact value: it spends model tokens", () => {
    for (const value of [undefined, "", "1", "true", "RUN", " run"]) {
        const plan = realModelPlan(value === undefined ? {} : { [REAL_MODEL_ENV.run]: value }, { registry: catalog({ githubToken: "t" }) });
        assert.equal(plan.state, "skip", String(value));
        assert.match(plan.reason, /PS_WORKFLOW_REAL_MODEL/);
    }
});

test("asked to run locally: the catalog's model with its credential, the effort it takes and the declared budget", () => {
    const plan = realModelPlan({ ...RUN }, { registry: catalog({ githubToken: "t" }) });
    assert.deepEqual(plan, { state: "run", target: "local", samples: 1, effort: null, receiptPath: null,
        model: { ref: "github-copilot:gpt-5.6-sol", provider: "github-copilot", name: "gpt-5.6-sol", type: "github" }, deployed: null });
    // A named model (or PS_TEST_FORCE_MODEL), its effort, three samples and a receipt path.
    const named = realModelPlan({ ...RUN, [REAL_MODEL_ENV.model]: "gpt-5.6-terra", [REAL_MODEL_ENV.effort]: "none",
        [REAL_MODEL_ENV.samples]: "3", [REAL_MODEL_ENV.receipt]: "/tmp/receipt.json" }, { registry: catalog({ apiKey: "k" }) });
    assert.equal(named.state, "run");
    assert.deepEqual(named.model, { ref: "azure-openai:gpt-5.6-terra", provider: "azure-openai", name: "gpt-5.6-terra", type: "openai" });
    assert.equal(named.samples, 3);
    assert.equal(named.effort, "none");
    assert.equal(named.receiptPath, "/tmp/receipt.json");
    assert.equal(realModelPlan({ ...RUN, PS_TEST_FORCE_MODEL: "azure-openai:gpt-5.6-terra" }, { registry: catalog({ apiKey: "k" }) }).model.ref,
        "azure-openai:gpt-5.6-terra");
    // GitHub's credential may come from GITHUB_TOKEN instead of the catalog.
    assert.equal(realModelPlan({ ...RUN }, { registry: catalog(), githubToken: "t" }).state, "run");
});

test("asked to run but unable to: blocked (a failure, never a skip), naming the setting and never its value", () => {
    const cases = [
        [{ ...RUN }, { registry: catalog() }, /credential of provider github-copilot/],
        [{ ...RUN, [REAL_MODEL_ENV.model]: "azure-openai:gpt-5.6-terra" }, { registry: catalog() }, /credential of provider azure-openai/],
        [{ ...RUN, [REAL_MODEL_ENV.model]: "nope" }, { registry: catalog({ githubToken: "t" }) }, /does not have/],
        [{ ...RUN }, {}, /No model catalog/],
        [{ ...RUN, [REAL_MODEL_ENV.effort]: "xhigh", [REAL_MODEL_ENV.model]: "azure-openai:gpt-5.6-terra" }, { registry: catalog({ apiKey: "k" }) }, /does not take reasoning effort xhigh/],
        [{ ...RUN, [REAL_MODEL_ENV.effort]: "huge" }, { registry: catalog({ githubToken: "t" }) }, /PS_WORKFLOW_REAL_MODEL_EFFORT/],
        [{ ...RUN, [REAL_MODEL_ENV.samples]: "0" }, { registry: catalog({ githubToken: "t" }) }, /from 1 to 5/],
        [{ ...RUN, [REAL_MODEL_ENV.samples]: String(REAL_MODEL_MAX_SAMPLES + 1) }, { registry: catalog({ githubToken: "t" }) }, /from 1 to 5/],
        [{ ...RUN, [REAL_MODEL_ENV.samples]: "2.5" }, { registry: catalog({ githubToken: "t" }) }, /from 1 to 5/],
        [{ ...RUN, [REAL_MODEL_ENV.target]: "staging" }, { registry: catalog({ githubToken: "t" }) }, /"local" or "deployed"/],
    ];
    for (const [env, options, reason] of cases) {
        const plan = realModelPlan(env, options);
        assert.equal(plan.state, "blocked", JSON.stringify(env));
        assert.match(plan.reason, reason);
    }
});

test("the deployed target: every setting named, the model exact, nothing about its values in the reasons; its own owner", () => {
    const deployed = {
        ...RUN, [REAL_MODEL_ENV.target]: "deployed", [REAL_MODEL_ENV.model]: "azure-openai:gpt-5.6-terra",
        [REAL_MODEL_ENV.targetStore]: SECRET_URL, [REAL_MODEL_ENV.targetDuroxideSchema]: "duroxide",
        [REAL_MODEL_ENV.targetCmsSchema]: "copilot_sessions", [REAL_MODEL_ENV.targetFactsSchema]: "pilotswarm_facts",
        [REAL_MODEL_ENV.targetReviewer]: "review-kit/code-reviewer",
    };
    const plan = realModelPlan(deployed);
    assert.equal(plan.state, "run");
    assert.deepEqual(plan.model, { ref: "azure-openai:gpt-5.6-terra", provider: "azure-openai", name: "gpt-5.6-terra", type: null });
    assert.deepEqual(plan.deployed, { store: SECRET_URL, duroxideSchema: "duroxide", cmsSchema: "copilot_sessions",
        factsSchema: "pilotswarm_facts", reviewer: { package: "review-kit", name: "code-reviewer" }, owner: null });
    assert.deepEqual(realModelPlan({ ...deployed, [REAL_MODEL_ENV.targetOwner]: "entra/0000-1111" }).deployed.owner,
        { provider: "entra", subject: "0000-1111" });

    const missing = realModelPlan({ ...RUN, [REAL_MODEL_ENV.target]: "deployed" });
    assert.equal(missing.state, "blocked");
    for (const name of [REAL_MODEL_ENV.model, REAL_MODEL_ENV.targetStore, REAL_MODEL_ENV.targetDuroxideSchema, REAL_MODEL_ENV.targetCmsSchema,
        REAL_MODEL_ENV.targetFactsSchema, REAL_MODEL_ENV.targetReviewer]) assert.ok(missing.reason.includes(name), name);
    for (const [change, reason] of [
        [{ [REAL_MODEL_ENV.model]: "gpt-5.6-terra" }, /provider:model/],
        [{ [REAL_MODEL_ENV.targetCmsSchema]: "cms; drop" }, /schema name/],
        [{ [REAL_MODEL_ENV.targetReviewer]: "code-reviewer" }, /<package>\/<agent>/],
        [{ [REAL_MODEL_ENV.targetOwner]: "entra/" }, /<provider>\/<subject>/],
    ]) {
        const blocked = realModelPlan({ ...deployed, ...change });
        assert.equal(blocked.state, "blocked", JSON.stringify(change));
        assert.match(blocked.reason, reason);
    }
    for (const plan of [missing, realModelPlan({ ...deployed, [REAL_MODEL_ENV.targetReviewer]: "x" })]) {
        assert.ok(!plan.reason.includes("not-for-print"), "a reason never carries the connection string");
    }
});

test("a child's record: its configured and observed model, calls, tokens, turns, tools, completions and errors", () => {
    const events = [
        { eventType: "assistant.turn_start", data: {} },
        { eventType: "assistant.usage", data: { model: "gpt-5.6-terra", inputTokens: 1200, outputTokens: 80 } },
        { eventType: "tool.execution_start", data: { toolName: "complete_workflow_node" } },
        { eventType: "tool.execution_complete", data: { toolName: "complete_workflow_node", success: true,
            result: JSON.stringify({ ok: false, error: { code: "OUTPUT_INVALID", attemptsLeft: 2 } }) } },
        { eventType: "assistant.usage", data: { model: "gpt-5.6-terra", inputTokens: 1300, outputTokens: 60, isByok: true } },
        { eventType: "tool.execution_start", data: { toolName: "complete_workflow_node" } },
        { eventType: "tool.execution_complete", data: { toolName: "complete_workflow_node", success: true,
            result: { content: JSON.stringify({ ok: true, outcome: "request_changes", replayed: false }) } } },
        { eventType: "tool.execution_start", data: { toolName: "read_facts" } },
        { eventType: "tool.execution_complete", data: { toolName: "read_facts", success: true, result: "{}" } },
        { eventType: "session.error", data: { message: "x".repeat(400) } },
        { eventType: "assistant.message", data: { content: "done" } },
    ];
    const record = childRecord({ sessionId: "c1", model: "azure-openai:gpt-5.6-terra", reasoningEffort: "none" }, events);
    assert.deepEqual({ ...record, errors: record.errors.map(error => error.length) }, {
        sessionId: "c1", model: "azure-openai:gpt-5.6-terra", reasoningEffort: "none", observedModels: ["gpt-5.6-terra"],
        requests: 2, inputTokens: 2500, outputTokens: 140, byok: true, turns: 1,
        tools: { complete_workflow_node: 2, read_facts: 1 },
        completions: [{ accepted: false, code: "OUTPUT_INVALID", attemptsLeft: 2 }, { accepted: true, outcome: "request_changes", replayed: false }],
        refusedCompletions: 1, errors: [300],
    });
    // A failed tool call without a readable answer, and no events at all.
    assert.deepEqual(childRecord(null, [{ eventType: "tool.execution_complete", data: { toolName: "complete_workflow_node", success: false, result: "boom" } }]).completions,
        [{ accepted: false, code: "TOOL_FAILED", attemptsLeft: null }]);
    assert.deepEqual(childRecord(null, null), { sessionId: null, model: null, reasoningEffort: null, observedModels: [], requests: 0,
        inputTokens: 0, outputTokens: 0, byok: false, turns: 0, tools: {}, completions: [], refusedCompletions: 0, errors: [] });
    const model = { ref: "azure-openai:gpt-5.6-terra", name: "gpt-5.6-terra" };
    assert.deepEqual(["gpt-5.6-terra", "azure-openai:gpt-5.6-terra", "gpt-5.6-sol", null].map(observed => servesModel(observed, model)),
        [true, true, false, false]);
});

test("the review contract, checked independently of the runtime", () => {
    assert.deepEqual(reviewResultProblems({ verdict: "approve", summary: "Fine.", risks: [] }), []);
    assert.deepEqual(reviewResultProblems({ verdict: "request_changes", summary: "SQL is built from input.", risks: ["SQL injection"] }), []);
    for (const [output, problem] of [
        [null, /not an object/],
        [[], /not an object/],
        [{ verdict: "maybe", summary: "s", risks: [] }, /verdict/],
        [{ verdict: "approve", summary: "", risks: [] }, /summary/],
        [{ verdict: "approve", summary: "s".repeat(601), risks: [] }, /summary/],
        [{ verdict: "approve", summary: "s", risks: ["a", "b", "c", "d", "e", "f"] }, /risks/],
        [{ verdict: "approve", summary: "s", risks: [""] }, /risks/],
        [{ verdict: "approve", summary: "s" }, /risks/],
        [{ verdict: "approve", summary: "s", risks: [], score: 3 }, /unexpected fields: score/],
    ]) {
        const problems = reviewResultProblems(output);
        assert.ok(problems.some(text => problem.test(text)), `${JSON.stringify(output)}: ${problems.join("; ")}`);
    }
});

test("the deployed target's migration guard: what a client's start would apply there", () => {
    assert.deepEqual(missingMigrations(["0001", "0002", "0003"], ["0001", "0002", "0003", "0004"]), []);
    assert.deepEqual(missingMigrations(["0001", "0002", "0003"], ["0001"]), ["0002", "0003"]);
    assert.deepEqual(missingMigrations(["0001"], []), ["0001"]);
});
