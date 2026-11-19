/** Decision binding uses the existing run map; availability is not a structural compiler input. */
import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow } from "../../dist/workflow/compiler.js";
import { agentModelsDigestPart, mergeWorkflowAgentModels, parseWorkflowAgentModels, parseWorkflowDecisionModels, readStoredAgentModels, requireAgentModelsForRevision,
    workflowAgentModelsText, workflowDecisionModelRequestDigest, workflowSaveCompilation } from "../../dist/workflow/agent-models.js";
import { startAgentModelsOf } from "../../dist/workflow/session-definitions.js";
import { applyWorkflowUpdate, dispatchWorkflowRun, readWorkflowCreateReceipt, workflowCreateRequestSha256 } from "../../dist/workflow/service.js";
import { jsonSha256 } from "../../dist/workflow/json.js";
import { workflowCommandStatus } from "../../dist/workflow/human-commands.js";
import { workflowDefinitionFromTool, WORKFLOW_DEFINITION_TOOL_SPEC } from "../../dist/workflow/definition-tool.js";
import { AGENT_OVERRIDE, DECISION_DEFAULT, DECISION_OVERRIDE, UNSET_DECISION, agentWorkflowYaml, decisionWorkflowYaml,
    effectiveDecisionModels } from "../helpers/workflow-decision-models.js";

test("Decision compilation remains host-independent and produces no availability diagnostic", () => {
    const result = compileWorkflow(decisionWorkflowYaml("decision-models", { full: true }));
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(Object.values(result.ir.nodes).filter(node => node.type === "decision").map(node => node.id).sort(),
        ["nested", "route", "score"]);
    assert.equal(result.diagnostics.some(item => item.code === "WORKFLOW_DECISION_MODEL_UNAVAILABLE"), false);
});

test("Decision modelRequest binds explicit Run again intent without changing no-Run-again surfaces", () => {
    const ir = compileWorkflow(decisionWorkflowYaml()).ir;
    for (const [request, sha256] of [
        [{ explicit: false }, "6ac78893c47bb5f8857c59df23fb931ed414ecb09a05c1f64edb9ec19be01fc0"],
        [{ explicit: false, runAgainOf: "prior-run" }, "142056367824601702f46da10df426a85d63633d36ae5a9cb369852c955212f5"],
        [{ explicit: true, models: {}, runAgainOf: "prior-run" }, "c660fc263493334ddf29f856d025b8b909f705028000ff6b35ec88691606461c"],
        [{ explicit: true, models: {}, runAgainOf: null }, "7eb599a33c287e06279822262a047d28458b5f33d5f7aeb69651a542654b3180"],
        [{ explicit: true, models: {}, runAgainOf: "another-run" }, "0027dd950b50dcd82476da2ff3b98fee8cad44ac385b96de00e51dd2c8a02e78"],
        [{ explicit: true, models: { route: { model: DECISION_DEFAULT } } },
            "dc855bbb6f097df2ee59ac1868046b1743b57b5b731e74e9b9764b2539b002fb"],
    ]) {
        assert.equal(workflowDecisionModelRequestDigest(ir, request), sha256);
    }
    const agents = compileWorkflow(agentWorkflowYaml()).ir;
    assert.equal(workflowDecisionModelRequestDigest(agents, { explicit: false }), undefined);
    assert.equal(workflowDecisionModelRequestDigest(agents, { explicit: true, models: {}, runAgainOf: "prior-run" }), undefined);
});

test("Decision create hashes the caller grant, while Agent-only keeps the previous snapshot-inclusive digest", () => {
    const owner = { provider: "test", subject: "caller" };
    const binding = { policy: "node-parent-tools-v1", parentSessionId: "parent", owner, config: {},
        capabilities: { revision: 1, selections: [] }, tools: [], sourceRevisions: {}, excludedTools: [],
        boundAgentFingerprint: "fixture", agentStepTools: "selections" };
    const stored = { ...binding, agentStepBindings: { ask: { capabilities: binding.capabilities, tools: [], sourceRevisions: {} } } };
    const base = { parentSessionId: "parent", owner, binding, start: { inputs: {} } };
    const modelRequest = workflowDecisionModelRequestDigest(compileWorkflow(decisionWorkflowYaml()).ir, { explicit: false });
    const decision = { ...base, start: { ...base.start, modelRequest } };
    const digest = request => workflowCreateRequestSha256(request, "yaml-hash", true, {});
    assert.equal(digest(decision), digest({ ...decision, binding: stored }));
    assert.notEqual(digest(decision), digest({ ...decision, binding: { ...stored, boundAgentFingerprint: "changed" } }));
    assert.equal(digest({ ...base, binding: stored }), jsonSha256({
        kind: "create", yamlSha256: "yaml-hash", publish: true, start: { inputs: {} },
        parentSessionId: "parent", notifyParent: true, owner, binding: jsonSha256(stored),
    }));
    assert.notEqual(digest(base), digest({ ...base, binding: stored }));
});

test("save-time validation invalidates Decision IR without mutating structural compilation or reading non-Decision capability", async () => {
    const compiled = compileWorkflow(decisionWorkflowYaml());
    const saved = await workflowSaveCompilation(compiled, async () => UNSET_DECISION);
    assert.equal(saved.valid, false);
    assert.equal(saved.ir, null);
    assert.equal(saved.irSha256, null);
    assert.deepEqual(saved.diagnostics.map(item => [item.code, item.path]), [["WORKFLOW_DECISION_MODEL_UNAVAILABLE", "states.route.type"]]);
    assert.equal(compiled.valid, true);
    assert.notEqual(compiled.ir, null);

    const agent = compileWorkflow(agentWorkflowYaml());
    const plain = await workflowSaveCompilation(agent, async () => { throw new Error("non-Decision save read capability"); });
    assert.equal(plain.valid, true);
    assert.equal(plain.ir, agent.ir);
});

test("Decision entries are accepted in the same canonical agentModels map as Agent entries", () => {
    const compiled = compileWorkflow(decisionWorkflowYaml("decision-models", { full: true }));
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    const models = parseWorkflowAgentModels({ ...effectiveDecisionModels(), ask: {
        model: AGENT_OVERRIDE, reasoning_effort: "high", context_tier: "long_context",
    } });
    assert.doesNotThrow(() => requireAgentModelsForRevision(models, compiled.ir, "revision 1 of decision-models"));
    assert.equal(workflowAgentModelsText(models), '{"ask":{"contextTier":"long_context","model":"chat:chosen","reasoningEffort":"high"},"route":{"model":"team:decision-main"}}');
    assert.deepEqual(readStoredAgentModels(workflowAgentModelsText(models)), { models });
});

test("the legacy Agent map and absent or empty map keep their exact stored and digest shapes", () => {
    const models = parseWorkflowAgentModels({ ask: { model: AGENT_OVERRIDE, reasoning_effort: "high", context_tier: "long_context" } });
    const compiled = compileWorkflow(agentWorkflowYaml());
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    requireAgentModelsForRevision(models, compiled.ir, "revision 1 of agent-models-regression");
    const text = '{"ask":{"contextTier":"long_context","model":"chat:chosen","reasoningEffort":"high"}}';
    assert.equal(workflowAgentModelsText(models), text);
    assert.deepEqual(agentModelsDigestPart(models), { agentModels: text });
    for (const given of [undefined, null, {}]) {
        assert.equal(workflowAgentModelsText(parseWorkflowAgentModels(given)), null);
        assert.deepEqual(agentModelsDigestPart(parseWorkflowAgentModels(given)), {});
    }
});

test("unknown ids and non-model-bearing node types are refused rather than silently dropped", () => {
    const compiled = compileWorkflow(decisionWorkflowYaml("decision-models", { full: true }));
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    for (const id of ["missing", "fan", "done", "item_done"]) {
        assert.throws(() => requireAgentModelsForRevision({ [id]: { model: DECISION_DEFAULT } }, compiled.ir, "revision 1"),
            error => error.code === "AGENT_MODELS_INVALID" && error.message.includes(id));
    }
});

test("Run again reads Decision choices from the existing live agentModels column, and an explicit empty map clears choices", async () => {
    const models = effectiveDecisionModels(DECISION_DEFAULT, { full: true });
    const reads = [];
    const host = { store: { listRuns: async id => { reads.push(id); return [
        { mode: "test", agentModels: '{"route":{"model":"test:not-live"}}' },
        { mode: "live", agentModels: workflowAgentModelsText(models) },
    ]; } } };
    assert.deepEqual(await startAgentModelsOf(host, { runAgainOf: "prior" }), models);
    assert.equal(await startAgentModelsOf(host, { runAgainOf: "prior", agentModels: {} }), null);
    assert.deepEqual(reads, ["prior"], "clearing choices must not read or inherit the prior map");
});

test("Run again inherits Agent and Decision maps independently and clears only a supplied alias", async () => {
    const compiled = compileWorkflow(decisionWorkflowYaml("decision-models-independent", { full: true, namedAgent: true }));
    const prior = { ...effectiveDecisionModels(DECISION_DEFAULT, { full: true }), ask: { model: AGENT_OVERRIDE } };
    const host = { store: { listRuns: async () => [{ mode: "live", agentModels: workflowAgentModelsText(prior) }] } };
    const runAgainOf = "prior-mixed";
    assert.deepEqual(await startAgentModelsOf(host, { runAgainOf }, compiled.ir), prior);
    assert.deepEqual(await startAgentModelsOf(host, { runAgainOf, agentModels: { ask: { model: "chat:other" } } }, compiled.ir),
        { ...effectiveDecisionModels(DECISION_DEFAULT, { full: true }), ask: { model: "chat:other" } });
    assert.deepEqual(await startAgentModelsOf(host, { runAgainOf, decisionModels: { route: { model: DECISION_OVERRIDE } } }, compiled.ir),
        { ask: { model: AGENT_OVERRIDE }, route: { model: DECISION_OVERRIDE } });
    assert.deepEqual(await startAgentModelsOf(host, { runAgainOf, agentModels: {} }, compiled.ir),
        effectiveDecisionModels(DECISION_DEFAULT, { full: true }));
    assert.deepEqual(await startAgentModelsOf(host, { runAgainOf, decisionModels: {} }, compiled.ir),
        { ask: { model: AGENT_OVERRIDE } });
});

test("workflow_definition declares the additive decision_models alias without requiring it", () => {
    const spec = WORKFLOW_DEFINITION_TOOL_SPEC.parameters;
    assert.equal(spec.properties.decision_models?.type, "object");
    assert.equal(spec.required.includes("decision_models"), false);
    assert.equal(spec.properties.agent_models.type, "object");
});

const untouched = new Proxy({}, { get: (_target, name) => { throw new Error(`store.${String(name)} must not be read`); } });
const call = async args => JSON.parse(await workflowDefinitionFromTool({ operation: "start", name: "decision-models", ...args }, {
    callerSessionId: "chat", host: { store: untouched, catalog: untouched }, owner: null, toolCallId: "start-1", binding: async () => null,
}));

test("a malformed decision_models alias is refused before any store or catalog read", async () => {
    for (const value of ["model", [], { route: DECISION_DEFAULT }, { route: { model: "unqualified" } }]) {
        const result = await call({ decision_models: value });
        assert.equal(result.ok, false);
        assert.equal(result.error.code, "AGENT_MODELS_INVALID", result.error.message);
    }
});

test("overlapping agent_models and decision_models refuse the same node even when the models agree", async () => {
    const result = await call({ agent_models: { route: { model: DECISION_DEFAULT } }, decision_models: { route: { model: DECISION_DEFAULT } } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "AGENT_MODELS_INVALID", result.error.message);
    assert.match(result.error.message, /route/);
});

test("Decision alias entries take only model, including when reasoning or context is explicitly null", async () => {
    for (const field of ["reasoningEffort", "reasoning_effort", "contextTier", "context_tier"]) {
        for (const value of [null, field.startsWith("reasoning") ? "high" : "long_context"]) {
            const result = await call({ decision_models: { route: { model: DECISION_DEFAULT, [field]: value } } });
            assert.equal(result.ok, false);
            assert.equal(result.error.code, "AGENT_MODELS_INVALID", `${field}: ${result.error.message}`);
        }
    }
});


test("stored model maps do not depend on object identity to retain the full workflow node limit", () => {
    const models = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`node${index}`, { model: DECISION_DEFAULT }]));
    assert.throws(() => parseWorkflowAgentModels(models), error => error.code === "AGENT_MODELS_INVALID");
    const stored = readStoredAgentModels(JSON.stringify(models));
    assert.equal("models" in stored, true);
    const cloned = JSON.parse(JSON.stringify(stored.models));
    const inherited = parseWorkflowAgentModels(cloned, { stored: true });
    assert.equal(Object.keys(inherited).length, 65);
});

test("Decision model field provenance survives JSON clone and reparse", () => {
    const compiled = compileWorkflow(decisionWorkflowYaml("decision-models", { full: true }));
    assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
    const ir = compiled.ir;
    const clones = [
        value => JSON.parse(JSON.stringify(value)),
        value => structuredClone(value),
    ];
    for (const clone of clones) {
        const alias = mergeWorkflowAgentModels(null, parseWorkflowDecisionModels({ ask: { model: DECISION_DEFAULT } }));
        const aliasAgain = parseWorkflowAgentModels(clone(alias));
        assert.throws(() => requireAgentModelsForRevision(aliasAgain, ir, "revision 1"),
            error => error.code === "AGENT_MODELS_INVALID" && /decision_models names ask/.test(error.message));

        for (const field of ["reasoningEffort", "reasoning_effort", "contextTier", "context_tier"]) {
            const explicitNull = parseWorkflowAgentModels({ route: { model: DECISION_DEFAULT, [field]: null } });
            const explicitNullAgain = parseWorkflowAgentModels(clone(explicitNull));
            assert.throws(() => requireAgentModelsForRevision(explicitNullAgain, ir, "revision 1"),
                error => error.code === "AGENT_MODELS_INVALID" && /Decision models take only model/.test(error.message), field);
        }
    }
});

test("a failed Decision capability reader is not a configured ineligible default", async () => {
    const compiled = compileWorkflow(decisionWorkflowYaml());
    await assert.rejects(workflowSaveCompilation(compiled, async () => { throw new Error("provider catalog unavailable"); }),
        error => error.code === "WORKFLOW_DECISION_CAPABILITY_UNREADABLE"
            && error.details?.retryable === true && /could not be read/i.test(error.message));
    assert.equal(compiled.valid, true);
    assert.notEqual(compiled.ir, null);
    assert.equal(workflowCommandStatus("WORKFLOW_DECISION_CAPABILITY_UNREADABLE"), 503);
});

test("save and publish capability read failures occur before any draft or revision write", async () => {
    const yaml = decisionWorkflowYaml("read-failure");
    const compiled = compileWorkflow(yaml);
    const writes = [];
    const reader = async () => { throw new Error("catalog unavailable"); };
    const store = {
        replaceDraft: async () => { writes.push("replaceDraft"); },
        readRevision: async () => ({ revision: 1, valid: true, diagnostics: [], yaml, yamlSha256: compiled.yamlSha256,
            irSha256: compiled.irSha256, name: compiled.name, semver: compiled.version }),
        readRevisionIr: async () => compiled.ir,
        readDefinition: async () => ({ state: "draft" }),
        readOperationReceipt: async () => null,
        invalidateDraftRevision: async () => { writes.push("invalidateDraftRevision"); },
        publish: async () => { writes.push("publish"); },
    };
    const host = { store, decisionCapability: reader };
    const actor = { kind: "system", name: "read-failure" };
    await assert.rejects(applyWorkflowUpdate(host, "workflow-read-failure",
        { operation: "replace_definition", expectedRevision: 1, yaml },
        { actor, operationId: "save" }), error => error.code === "WORKFLOW_DECISION_CAPABILITY_UNREADABLE");
    await assert.rejects(applyWorkflowUpdate(host, "workflow-read-failure",
        { operation: "publish", expectedRevision: 1, definitionHash: compiled.yamlSha256 },
        { actor, operationId: "publish" }), error => error.code === "WORKFLOW_DECISION_CAPABILITY_UNREADABLE");
    assert.deepEqual(writes, []);
});

test("legacy create receipt lookup accepts no mutable reconstruction callback", async () => {
    const calls = [];
    const request = { workflowSessionId: "workflow", operationId: "operation" };
    const host = { store: { readOperationReceipt: async (...args) => { calls.push(args); return null; },
        readRun: async () => { throw new Error("mutable run must not be read"); } } };
    assert.equal(await readWorkflowCreateReceipt(host, request, "yaml-hash", "request-hash"), null);
    assert.deepEqual(calls, [["workflow", "operation", "create", "request-hash"]]);
});

test("a lost Decision controller start retries its immutable controller id", async () => {
    const starts = [];
    const receipt = { operation: "create", workflowSessionId: "workflow", state: "published", revision: 1,
        yamlSha256: "yaml", irSha256: "ir", run: { runId: "run", mode: "live", controllerInstanceId: "stable-controller",
            revision: 1, irSha256: "ir" } };
    const host = { store: { readRun: async () => ({ runId: "run", workflowSessionId: "workflow", status: "admitted",
        controllerInstanceId: "stable-controller", controllerVersion: "1.1.0" }) }, duroxideClient: {
        startOrchestrationVersioned: async (...args) => { starts.push(args); },
    } };
    await dispatchWorkflowRun(host, receipt);
    await dispatchWorkflowRun(host, receipt);
    assert.deepEqual(starts.map(item => item[0]), ["stable-controller", "stable-controller"]);
    assert.deepEqual(starts.map(item => item[2]), [{ v: 1, workflowSessionId: "workflow", runId: "run" },
        { v: 1, workflowSessionId: "workflow", runId: "run" }]);
});
